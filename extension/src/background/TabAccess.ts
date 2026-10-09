// Whether the extension can reach a tab right now, and the deadlines that turn
// Safari's website-access dialog into a named refusal instead of a timeout.

import { Clock, Context, Duration, Effect, Layer } from "effect";
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

/** A tab's last probe: when it landed, and what it threw if it failed. */
interface ProbeResult {
  readonly at: number;
  readonly error: ToolError | null;
}

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

      /**
       * tabId to its last probe.
       *
       * Failures are remembered too. Only successes were, so the blocked case, which
       * is the one this cache exists for, probed again on every call: a frame search
       * over eight frames paid a probe each and ran past the server's 30-second
       * timeout, reporting the generic failure the gating was written to replace.
       */
      const probes = new Map<number, ProbeResult>();

      const originOfTab = Effect.fn("TabAccess.originOfTab")(function* (tabId: number) {
        return yield* callBrowser((api) => api.tabs.get(tabId)).pipe(
          Effect.timeout(timing.permissionProbe),
          Effect.map((tab) => originOfUrl(tab.url)),
          Effect.orElseSucceed(() => null),
          provideBrowser,
        );
      });

      const ensure = Effect.fn("TabAccess.ensure")(function* (tabId: number) {
        const cached = probes.get(tabId);

        if (cached && (yield* Clock.currentTimeMillis) - cached.at < Duration.toMillis(timing.permissionCache)) {
          if (cached.error) return yield* cached.error;

          return;
        }

        // Read the origin first. The probe below is what raises Safari's dialog, and
        // once that dialog is up `tabs.get` blocks on it as well, so asking
        // afterwards returns nothing and the refusal cannot name the site it is
        // about. Measured against real Safari, which is the only place this shows.
        const origin = yield* originOfTab(tabId);

        const probe = yield* callBrowser((api) =>
          api.scripting.executeScript({ target: { tabId }, func: probeTabAccess }),
        ).pipe(
          Effect.timeout(timing.permissionProbe),
          Effect.map(() => null),
          Effect.catchTags({
            TimeoutError: () => Effect.succeed(permissionRequired(origin, true)),
            ToolError: () => Effect.succeed(permissionRequired(origin, false)),
          }),
          provideBrowser,
        );

        probes.set(tabId, { at: yield* Clock.currentTimeMillis, error: probe });

        if (probe) return yield* probe;
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

      const forget = (tabId: number) => Effect.sync(() => void probes.delete(tabId));

      return TabAccess.of({ ensure, originOfTab, withPermissionDeadline, forget });
    }),
  );
}
