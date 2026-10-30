// Whether the extension can reach a tab right now, and the deadlines that turn
// Safari's website-access dialog into a named refusal instead of a timeout.

import { Cache, Context, Duration, Effect, Fiber, FiberSet, Layer, Option, Predicate } from "effect";
import { Browser, callBrowser } from "./Browser.ts";
import { BackgroundTiming, MAX_GRANTED_ORIGINS } from "./config.ts";
import { permissionRequired, type ToolError } from "./errors.ts";
import { probeTabAccess } from "./injected.ts";

/**
 * The origin is what Safari grants by, so it is the unit anything asking the
 * user to grant something has to speak in. Also the part of a URL with no
 * secrets in it, which is why unreachable frames are named this way.
 */
export const originOfUrl = (url: string | undefined): string | null => {
  try {
    if (!url) return null;
    // An opaque origin (about:, data:, file:, a sandboxed frame) serialises
    // to the string "null", which would reach the user looking like a
    // hostname they could go and grant. There is nothing to grant.
    const origin = new URL(url).origin;

    return origin && origin !== "null" ? origin : null;
  } catch {
    return null;
  }
};

export class TabAccess extends Context.Service<
  TabAccess,
  {
    /**
     * Cheapest call that proves the extension can actually reach this tab. It also
     * raises Safari's dialog when there is no decision yet, which is wanted: the
     * user cannot answer a question nobody asked.
     */
    ensure(tabId: number): Effect.Effect<void, ToolError>;
    /**
     * Best effort, and deliberately not fatal: the origin only sharpens the message,
     * and reading it goes through the same APIs that may already be blocked.
     */
    originOfTab(tabId: number): Effect.Effect<string | null>;
    /**
     * For a call that is already permission-gated and already expected to be quick.
     * Cheaper than a probe, since it adds no round trip, but only safe where the
     * operation has no legitimate reason to run long.
     */
    withPermissionDeadline<A, R>(
      call: Effect.Effect<A, ToolError, R>,
      tabId: number,
      deadline?: Duration.Duration,
    ): Effect.Effect<A, ToolError, R>;
    /** Drops what is remembered about a tab, so the next call probes it again. */
    forget(tabId: number): Effect.Effect<void>;
    /**
     * Whether a URL's site is known to be granted, without asking Safari. A tab
     * listing describes many tabs at once and probing each would raise a dialog
     * per undecided site, so this only answers from what probes have learned.
     */
    isSiteGranted(url: string | undefined): Effect.Effect<boolean>;
    /** Records what a probe found out about an origin. */
    rememberOrigin(origin: string | null, granted: boolean): Effect.Effect<void>;
    /** Loads the origins found reachable on earlier runs. */
    readonly restoreGrantedOrigins: Effect.Effect<void>;
    /** For tests: the origins known to be granted, oldest confirmation first. */
    readonly grantedOrigins: Effect.Effect<ReadonlyArray<string>>;
  }
>()("mcpsafari/background/TabAccess") {
  static readonly layer = Layer.effect(
    TabAccess,
    Effect.gen(function* () {
      const browserApi = yield* Browser;
      const timing = yield* BackgroundTiming;
      const provideBrowser = Effect.provideService(Browser, browserApi);
      const fibers = yield* FiberSet.make();

      /**
       * Origins a probe has found reachable. This is the only thing that can say a
       * tab's site is granted without raising Safari's dialog, which is what a tab
       * listing needs. Anything not in here is treated as not granted.
       *
       * `permissions.contains` is no help (see `permissionProbe` in config.ts), and
       * the tabs API returns a URL and title for every tab whether or not its site
       * was granted, so neither of those can tell the two apart.
       *
       * Learned by `ensure` and dropped the moment it is refused. Kept in local
       * storage, so it survives a suspended background page and a Safari restart,
       * and bounded: insertion order is recency of confirmation, oldest first, and
       * the oldest is evicted past MAX_GRANTED_ORIGINS. A site the user revokes in
       * Safari Settings stays in here until a call to it is refused.
       */
      const origins = new Set<string>();
      // True only while a read that outran its deadline is still in flight.
      // Writing then would replace the stored set with the part loaded so far.
      let originsReadPending = false;

      const persistOrigins = () => {
        if (originsReadPending) return;

        try {
          if (browserApi.storage && browserApi.storage.local) {
            browserApi.storage.local.set({ grantedOrigins: [...origins] }).catch(() => {});
          }
        } catch {
          /* storage may not be available */
        }
      };

      const rememberOriginSync = (origin: string | null, granted: boolean) => {
        if (!origin) return;

        if (!granted) {
          if (origins.delete(origin)) persistOrigins();

          return;
        }

        // Re-adding moves it to the recent end. Only a change in what is stored
        // is written: a probe lands on most calls, and its order alone is not
        // worth a storage write.
        const known = origins.delete(origin);
        let evicted = false;

        origins.add(origin);

        for (const oldest of origins) {
          if (origins.size <= MAX_GRANTED_ORIGINS) break;

          origins.delete(oldest);
          evicted = true;
        }

        if (!known || evicted) persistOrigins();
      };

      // The stored ones go first in the merge: they are older than anything
      // learned while the read was in flight.
      const readStoredOrigins = Effect.gen(function* () {
        if (!browserApi.storage || !browserApi.storage.local) return;

        const data = yield* callBrowser((api) => api.storage.local.get("grantedOrigins"));
        const stored = data["grantedOrigins"];

        if (!Array.isArray(stored)) return;

        const merged = [...new Set([...stored.filter(Predicate.isString), ...origins])];

        origins.clear();

        for (const origin of merged.slice(-MAX_GRANTED_ORIGINS)) origins.add(origin);
      }).pipe(Effect.ignore, provideBrowser);

      // Runs before the bridge connects, so it is ahead of the first `tabs_query`
      // unless storage is slow. Storage gets the same short deadline as a probe;
      // past it startup goes on with what is loaded, the rest of the stored
      // origins read as not granted, and the read is merged in whenever it does
      // arrive, with what was learned in the meantime written back then.
      const restoreGrantedOrigins = Effect.gen(function* () {
        const read = yield* FiberSet.run(fibers, readStoredOrigins);
        const done = yield* Fiber.join(read).pipe(Effect.timeoutOption(timing.permissionProbe));

        if (Option.isSome(done)) return;

        originsReadPending = true;
        yield* FiberSet.run(
          fibers,
          Effect.andThen(
            Fiber.join(read),
            Effect.sync(() => {
              originsReadPending = false;
              persistOrigins();
            }),
          ),
        );
      }).pipe(Effect.withSpan("TabAccess.restoreGrantedOrigins"));

      const isSiteGranted = (url: string | undefined) =>
        Effect.sync(() => {
          // Nothing behind an about: page can be granted, and nothing in one is private.
          if (url !== undefined && /^about:/i.test(url)) return true;

          const origin = originOfUrl(url);

          return origin !== null && origins.has(origin);
        });

      const originOfTab = Effect.fn("TabAccess.originOfTab")(function* (tabId: number) {
        return yield* callBrowser((api) => api.tabs.get(tabId)).pipe(
          Effect.timeout(timing.permissionProbe),
          Effect.map((tab) => originOfUrl(tab.url)),
          Effect.orElseSucceed(() => null),
          provideBrowser,
        );
      });

      const probe = Effect.fn("TabAccess.probe")(function* (tabId: number) {
        // Read the origin first. The probe below is what raises Safari's dialog, and
        // once that dialog is up `tabs.get` blocks on it as well, so asking
        // afterwards returns nothing and the refusal cannot name the site it is
        // about. Measured against real Safari, which is the only place this shows.
        const origin = yield* originOfTab(tabId);

        yield* callBrowser((api) => api.scripting.executeScript({ target: { tabId }, func: probeTabAccess })).pipe(
          Effect.timeout(timing.permissionProbe),
          Effect.catchTags({
            TimeoutError: () => Effect.fail(permissionRequired(origin, true)),
            ToolError: () => Effect.fail(permissionRequired(origin, false)),
          }),
          Effect.tap(() => Effect.sync(() => rememberOriginSync(origin, true))),
          Effect.tapError(() => Effect.sync(() => rememberOriginSync(origin, false))),
          provideBrowser,
        );
      });

      /**
       * tabId to its last probe, or the one still running.
       *
       * Failures are remembered too. Only successes were, so the blocked case, which
       * is the one this cache exists for, probed again on every call: a frame search
       * over eight frames paid a probe each and ran past the server's 30-second
       * timeout, reporting the generic failure the gating was written to replace.
       *
       * A probe still running is shared as well. The result used to be written
       * only once a probe landed, so calls arriving together, which is what `wait`
       * racing every frame does, each started their own and each put the question
       * to Safari again. The cache also keeps a probe running while anyone still
       * waits on it, so one caller giving up does not fail the rest.
       */
      const probes = yield* Cache.make({
        lookup: probe,
        capacity: Number.POSITIVE_INFINITY,
        timeToLive: timing.permissionCache,
      });

      const ensure = Effect.fn("TabAccess.ensure")(function* (tabId: number) {
        yield* Cache.get(probes, tabId);
      });

      const withPermissionDeadline = <A, R>(
        call: Effect.Effect<A, ToolError, R>,
        tabId: number,
        deadline?: Duration.Duration,
      ): Effect.Effect<A, ToolError, R> =>
        call.pipe(
          Effect.timeoutOrElse({
            duration: deadline ?? timing.permissionDeadline,
            orElse: () => Effect.flatMap(originOfTab(tabId), (origin) => Effect.fail(permissionRequired(origin, true))),
          }),
        );

      const forget = (tabId: number) => Cache.invalidate(probes, tabId);

      return TabAccess.of({
        ensure,
        originOfTab,
        withPermissionDeadline,
        forget,
        isSiteGranted,
        rememberOrigin: (origin, granted) => Effect.sync(() => rememberOriginSync(origin, granted)),
        restoreGrantedOrigins,
        grantedOrigins: Effect.sync(() => [...origins]),
      });
    }),
  );
}
