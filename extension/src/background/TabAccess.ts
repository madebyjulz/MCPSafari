// Whether the extension can reach a tab right now, and the deadlines that turn
// Safari's website-access dialog into a named refusal instead of a timeout.

import { Cache, Context, Duration, Effect, Layer } from "effect";
import { Browser, callBrowser } from "./Browser.ts";
import { BackgroundTiming } from "./config.ts";
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
  }
>()("mcpsafari/background/TabAccess") {
  static readonly layer = Layer.effect(
    TabAccess,
    Effect.gen(function* () {
      const browserApi = yield* Browser;
      const timing = yield* BackgroundTiming;
      const provideBrowser = Effect.provideService(Browser, browserApi);

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

      return TabAccess.of({ ensure, originOfTab, withPermissionDeadline, forget });
    }),
  );
}
