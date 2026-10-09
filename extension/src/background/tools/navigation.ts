// `navigate`, and waiting for the load it starts.

import { Clock, Duration, Effect, Option, Queue, Schema } from "effect";
import type { Tabs } from "webextension-polyfill";
import type { ContentParams } from "../../shared/protocol.ts";
import { Browser, callBrowser } from "../Browser.ts";
import { BackgroundTiming } from "../config.ts";
import { extensionError } from "../errors.ts";
import { SelectedTab } from "../SelectedTab.ts";
import { decodeParams } from "./params.ts";
import { redactUrlSecrets } from "./redaction.ts";
import { goBack, goForward } from "../injected.ts";

const NavigateParams = Schema.Struct({
  tabId: Schema.optionalKey(Schema.Int),
  action: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
});

export const handleNavigate = Effect.fn("navigate")(function* (params: ContentParams) {
  const timing = yield* BackgroundTiming;
  const decoded = yield* decodeParams(NavigateParams)(params);
  const tabId = decoded.tabId || (yield* (yield* SelectedTab).activeTabId);
  const action = decoded.action || "goto";

  // Best effort, and deliberately not gated on access to the page being left.
  // This only tells a real navigation from a same-document one, and
  // `waitForTabLoad` already reads it as `beforeTab?.url || ""`. Requiring a
  // grant here would take away the one move that gets a caller off a page
  // they cannot use, and leaving it unbounded spent the bridge timeout on it.
  const beforeTab = yield* callBrowser((api) => api.tabs.get(tabId)).pipe(
    Effect.timeout(timing.permissionDeadline),
    Effect.orElseSucceed(() => null),
  );

  // The watch is armed before the navigation starts, so its first events
  // cannot be missed, and it is scoped to this call, so a navigation that
  // fails to start does not leave its listener behind.
  const navigateAndWait = <E, R>(start: Effect.Effect<unknown, E, R>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const loaded = yield* watchTabLoad(tabId, beforeTab);

        yield* start;

        return yield* loaded;
      }),
    );

  let message: string;
  let tab: Tabs.Tab;

  switch (action) {
    case "goto": {
      const url = decoded.url;

      if (!url) return yield* extensionError("URL required for 'goto' action");

      tab = yield* navigateAndWait(callBrowser((api) => api.tabs.update(tabId, { url })));
      message = "Navigated to";
      break;
    }

    case "back": {
      tab = yield* navigateAndWait(
        callBrowser((api) => api.scripting.executeScript({ target: { tabId }, func: goBack })),
      );
      message = "Navigated back to";
      break;
    }

    case "forward": {
      tab = yield* navigateAndWait(
        callBrowser((api) => api.scripting.executeScript({ target: { tabId }, func: goForward })),
      );
      message = "Navigated forward to";
      break;
    }

    case "reload": {
      tab = yield* navigateAndWait(callBrowser((api) => api.tabs.reload(tabId)));
      message = "Reloaded";
      break;
    }

    default:
      return yield* extensionError(`Unknown navigation action: ${action}`);
  }

  // Return tab info so the caller knows where they landed
  return `${message} ${redactUrlSecrets(tab.url)} (${tab.title || ""})`;
});

interface TabUpdate {
  readonly changeInfo: Tabs.OnUpdatedChangeInfoType;
  readonly tab: Tabs.Tab;
}

/**
 * Starts watching a tab for the navigation about to happen, and returns the
 * wait for it to finish: a full load completing, a same-document URL change
 * going quiet, or nothing happening at all within `noNavigationTimeout`. The
 * wait never fails on time; at the overall timeout it settles on wherever the
 * tab is.
 */
export const watchTabLoad = Effect.fn("watchTabLoad")(function* (tabId: number, beforeTab: Tabs.Tab | null) {
  const timing = yield* BackgroundTiming;
  const api = yield* Browser;
  const beforeUrl = beforeTab?.url || "";
  const updates = yield* Queue.unbounded<TabUpdate>();

  const onUpdated = (updatedTabId: number, changeInfo: Tabs.OnUpdatedChangeInfoType, tab: Tabs.Tab) => {
    if (updatedTabId === tabId) Queue.offerUnsafe(updates, { changeInfo, tab });
  };

  yield* Effect.acquireRelease(
    Effect.sync(() => api.tabs.onUpdated.addListener(onUpdated)),
    () => Effect.sync(() => api.tabs.onUpdated.removeListener(onUpdated)),
  );

  const armedAt = yield* Clock.currentTimeMillis;
  const timeoutAt = armedAt + Duration.toMillis(timing.navigationTimeout);
  const noNavigationAt = armedAt + Duration.toMillis(timing.noNavigationTimeout);

  // The wait itself, handed back un-run: the caller starts the navigation
  // between arming the watch and awaiting it.
  // @effect-diagnostics-next-line returnEffectInGen:off
  return Effect.gen(function* () {
    let sawNavigation = false;
    let loadStarted = false;
    let sameDocumentAt: number | null = null;

    while (true) {
      // Whichever wait is due first: the overall timeout, the "nothing is
      // happening" check while no navigation has been seen, and the quiet
      // period after a same-document URL change.
      const due = Math.min(timeoutAt, sawNavigation ? Infinity : noNavigationAt, sameDocumentAt ?? Infinity);
      const now = yield* Clock.currentTimeMillis;

      if (now >= due) break;

      const update = yield* Queue.take(updates).pipe(Effect.timeoutOption(Duration.millis(due - now)));

      if (Option.isNone(update)) continue;

      const { changeInfo, tab } = update.value;

      if (changeInfo.status === "loading") {
        sawNavigation = true;
        loadStarted = true;
        sameDocumentAt = null;
      }

      if (changeInfo.url && changeInfo.url !== beforeUrl) {
        sawNavigation = true;

        if (!loadStarted)
          sameDocumentAt = (yield* Clock.currentTimeMillis) + Duration.toMillis(timing.sameDocumentSettle);
      }

      if (changeInfo.status === "complete" && (sawNavigation || (tab.url || "") !== beforeUrl)) break;
    }

    return yield* callBrowser((browserApi) => browserApi.tabs.get(tabId)).pipe(Effect.provideService(Browser, api));
  });
});
