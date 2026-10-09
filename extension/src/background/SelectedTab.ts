// The tab `select_tab` pinned, and how a call that names no tab finds its target.

import { Context, Effect, Layer, Predicate, Ref } from "effect";
import { Browser, callBrowser } from "./Browser.ts";
import { BackgroundTiming } from "./config.ts";
import { extensionError, permissionRequired, type ToolError } from "./errors.ts";

export class SelectedTab extends Context.Service<
  SelectedTab,
  {
    readonly get: Effect.Effect<number | null>;
    /** Pins a tab, or clears the pin with `null`, and remembers it for this Safari session. */
    set(tabId: number | null): Effect.Effect<void>;
    /**
     * The tab a call that names none acts on: the pinned one while it exists,
     * else the active tab of the current window.
     */
    readonly activeTabId: Effect.Effect<number, ToolError>;
    /** Restores the pin from session storage, if its tab still exists. */
    readonly restore: Effect.Effect<void>;
  }
>()("mcpsafari/background/SelectedTab") {
  static readonly layer = Layer.effect(
    SelectedTab,
    Effect.gen(function* () {
      const browserApi = yield* Browser;
      const timing = yield* BackgroundTiming;
      const selected = yield* Ref.make<number | null>(null);

      // Fire and forget, as it always was: the pin is a convenience, and the
      // call that set it should not fail or wait over storage.
      const persist = (tabId: number | null) =>
        Effect.sync(() => {
          try {
            if (browserApi.storage && browserApi.storage.session) {
              browserApi.storage.session.set({ selectedTabId: tabId }).catch(() => {});
            }
          } catch {
            /* storage may not be available */
          }
        });

      const set = (tabId: number | null) => Effect.andThen(Ref.set(selected, tabId), persist(tabId));

      // Every call that names no tab resolves its target here, so an unbounded wait
      // on either line below puts the whole tool surface back on the 30-second bridge
      // timeout that `tabs_query` is deadlined to avoid. Neither call can be
      // probed first, because the tab they are looking up is the thing being decided.
      const activeTabId = Effect.gen(function* () {
        const pinned = yield* Ref.get(selected);

        // Use pinned tab if set via select_tab
        if (pinned !== null) {
          const tab = yield* callBrowser((api) => api.tabs.get(pinned)).pipe(
            Effect.map((found) => found.id ?? null),
            // Tab was closed, clear selection
            Effect.catchTag("ToolError", () => Effect.as(set(null), null)),
            // A tab parked on Safari's dialog is not a closed one. Falling
            // through here would drop the caller's pinned tab over a question
            // the user has not answered yet.
            Effect.timeoutOrElse({
              duration: timing.tabListing,
              orElse: () => Effect.fail(permissionRequired(null, true)),
            }),
          );

          if (tab !== null) return tab;
        }

        const tabs = yield* callBrowser((api) => api.tabs.query({ active: true, currentWindow: true })).pipe(
          // No origin to name: the block belongs to whichever tab Safari is
          // asking about, and that is the lookup that just failed.
          Effect.timeoutOrElse({
            duration: timing.tabListing,
            orElse: () => Effect.fail(permissionRequired(null, true)),
          }),
        );

        const first = tabs[0];

        if (first?.id === undefined) return yield* extensionError("No active tab found");

        return first.id;
      }).pipe(Effect.provideService(Browser, browserApi), Effect.withSpan("SelectedTab.activeTabId"));

      // Session-only: the pin is lost when Safari restarts.
      const restore = Effect.gen(function* () {
        if (!browserApi.storage || !browserApi.storage.session) return;

        const data = yield* callBrowser((api) => api.storage.session.get("selectedTabId"));
        const stored = data["selectedTabId"];

        if (!Predicate.isNumber(stored)) return;

        const exists = yield* callBrowser((api) => api.tabs.get(stored)).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );

        if (exists) yield* Ref.set(selected, stored);
        else yield* callBrowser((api) => api.storage.session.remove("selectedTabId"));
      }).pipe(Effect.ignore, Effect.provideService(Browser, browserApi));

      return SelectedTab.of({ get: Ref.get(selected), set, activeTabId, restore });
    }),
  );
}
