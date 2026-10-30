// `navigate`, waiting for the load it starts, and the interactions that can
// start one of their own.

import { Clock, Deferred, Duration, Effect, Option, Predicate, Queue, Result, Schema } from "effect";
import type { Tabs } from "webextension-polyfill";
import type { ContentParams, JsonValue } from "../../shared/protocol.ts";
import type { ContentAction } from "../actions.ts";
import { Browser, callBrowser } from "../Browser.ts";
import { BackgroundTiming } from "../config.ts";
import { ContentScripts } from "../ContentScripts.ts";
import { extensionError, ToolError } from "../errors.ts";
import { SelectedTab } from "../SelectedTab.ts";
import { TabAccess } from "../TabAccess.ts";
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
        const loaded = yield* watchTabLoad(tabId, beforeTab, timing.noNavigationTimeout);

        yield* start;

        return yield* loaded;
      }),
    );

  let message: string;
  let tab: Tabs.Tab;

  // `goto` and `reload` go through the tabs API and need no access to the page.
  // Going back or forward is a script run inside it, so it parks on Safari's
  // dialog like any other page-touching call and is gated like one. Before the
  // load wait is armed, so a refusal leaves no listener.
  if (action === "back" || action === "forward") yield* (yield* TabAccess).ensure(tabId);

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
  return `${message} ${yield* describeLanding(tab)}`;
});

/**
 * Where a tab ended up, as the tools say it: the URL with its secrets redacted,
 * and the title unless the site has not been granted, because the page's own
 * title is not for a site that has not been granted.
 */
const describeLanding = Effect.fn("describeLanding")(function* (tab: Tabs.Tab) {
  const granted = yield* (yield* TabAccess).isSiteGranted(tab.url);

  const title = granted
    ? `(${tab.title || ""})`
    : "(title withheld: MCPSafari has not been granted access to this site)";

  return `${redactUrlSecrets(tab.url)} ${title}`;
});

interface TabUpdate {
  readonly changeInfo: Tabs.OnUpdatedChangeInfoType;
  readonly tab: Tabs.Tab;
}

/**
 * Starts watching a tab for the navigation about to happen, and returns the
 * wait for it to finish: a full load completing, a same-document URL change
 * going quiet, or nothing happening at all within `noNavigation` of the wait
 * being awaited. The wait never fails on time; at the overall timeout, counted
 * from now, it settles on wherever the tab is.
 *
 * The no-navigation countdown starts when the wait is awaited rather than when
 * the watch is armed, so whatever runs in between (an interaction's frame
 * search, a permission probe) does not use up the window. Nothing is missed
 * meanwhile: the events queue up from the moment the watch is armed.
 */
export const watchTabLoad = Effect.fn("watchTabLoad")(function* (
  tabId: number,
  beforeTab: Tabs.Tab | null,
  noNavigation: Duration.Duration,
) {
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

  const timeoutAt = (yield* Clock.currentTimeMillis) + Duration.toMillis(timing.navigationTimeout);

  // The wait itself, handed back un-run: the caller starts the navigation
  // between arming the watch and awaiting it.
  // @effect-diagnostics-next-line returnEffectInGen:off
  return Effect.gen(function* () {
    const noNavigationAt = (yield* Clock.currentTimeMillis) + Duration.toMillis(noNavigation);
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

// ─── Interactions that start a load ──────────────────────────────────

/** The tab a request acts on. The router has resolved it already; this is the floor under a direct call. */
const tabOf = Effect.fn("tabOf")(function* (params: ContentParams) {
  const tabId = params["tabId"];

  return Predicate.isNumber(tabId) && tabId ? tabId : yield* (yield* SelectedTab).activeTabId;
});

/**
 * Runs an interaction and, if it starts a navigation in this tab, answers only
 * once that navigation has finished. Without this the interaction answered the
 * moment its event was dispatched: the next read saw the page being left, and a
 * `wait` sent straight after was torn down with that page and could only end by
 * riding out the server's 30-second bridge timeout.
 *
 * The load watch is armed before the action runs, because a link can start
 * loading before the content script has finished replying and a missed event is
 * not replayed. Its no-navigation countdown starts when the action returns
 * instead, so a slow dispatch does not use up the window.
 */
export const dispatchAndSettle = Effect.fn("dispatchAndSettle")(function* (
  action: ContentAction,
  params: ContentParams,
) {
  const timing = yield* BackgroundTiming;
  const contentScripts = yield* ContentScripts;
  const tabId = yield* tabOf(params);

  // Before the tab is read, so a tab that has not been granted is refused as
  // `permission_required` here instead of spending the read's deadline first.
  yield* (yield* TabAccess).ensure(tabId);

  // Best effort, as in `navigate`: it only tells a navigation from none.
  const beforeTab = yield* callBrowser((api) => api.tabs.get(tabId)).pipe(
    Effect.timeout(timing.permissionDeadline),
    Effect.orElseSucceed(() => null),
  );

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const settled = yield* watchTabLoad(tabId, beforeTab, timing.navigationStartWindow);
      // The action's own failure is the answer, and closing the scope lets the
      // watch go with nothing left to read what it settles with.
      const result = yield* contentScripts.dispatch(action, params);

      // The click has happened by now, so nothing about waiting for its load may
      // turn it into a failure: a tab that closed itself, or a final read that
      // never returned, only costs the report of where the page went.
      const afterTab = yield* settled.pipe(
        Effect.timeout(Duration.sum(timing.navigationTimeout, timing.permissionProbe)),
        Effect.orElseSucceed(() => null),
      );

      return yield* withNavigationNote(result, beforeTab, afterTab);
    }),
  );
});

/**
 * A string result gets a trailing line, which is how the tools already add
 * asides, and reaches the client as text. An object result gets a field.
 */
const withNavigationNote = Effect.fn("withNavigationNote")(function* (
  result: JsonValue | undefined,
  beforeTab: Tabs.Tab | null,
  afterTab: Tabs.Tab | null,
) {
  if (!beforeTab || !afterTab || !afterTab.url || afterTab.url === beforeTab.url) return result;

  if (Predicate.isString(result)) {
    const unfinished = afterTab.status === "loading" ? "; it was still loading" : "";

    return `${result}\nPage navigated to ${yield* describeLanding(afterTab)}${unfinished}`;
  }

  if (Predicate.isObject(result) && !Array.isArray(result)) {
    return { ...result, navigatedTo: redactUrlSecrets(afterTab.url) };
  }

  return result;
});

// ─── Waiting through a navigation ────────────────────────────────────

/**
 * Listens for the tab to begin loading, which is the first thing a navigation
 * does and happens before the old document is torn down. Top frame only:
 * `tabs.onUpdated` reports the tab, and a subframe's load is not a replacement
 * of the document a `wait` is polling.
 */
const watchForLoadStart = Effect.fn("watchForLoadStart")(function* (tabId: number) {
  const api = yield* Browser;
  const started = yield* Deferred.make<void>();

  const onUpdated = (updatedTabId: number, changeInfo: Tabs.OnUpdatedChangeInfoType) => {
    if (updatedTabId === tabId && changeInfo.status === "loading") Deferred.doneUnsafe(started, Effect.void);
  };

  yield* Effect.acquireRelease(
    Effect.sync(() => api.tabs.onUpdated.addListener(onUpdated)),
    () => Effect.sync(() => api.tabs.onUpdated.removeListener(onUpdated)),
  );

  return started;
});

/**
 * Resolves once the tab's load is over, or at the timeout. The tab is read as
 * well as listened to, because the load can finish between the event that sent
 * us here and the listener going up.
 */
const waitForLoadComplete = (tabId: number, timeout: Duration.Duration) =>
  Effect.scoped(
    Effect.gen(function* () {
      const api = yield* Browser;
      const done = yield* Deferred.make<void>();

      const onUpdated = (updatedTabId: number, changeInfo: Tabs.OnUpdatedChangeInfoType) => {
        if (updatedTabId === tabId && changeInfo.status === "complete") Deferred.doneUnsafe(done, Effect.void);
      };

      yield* Effect.acquireRelease(
        Effect.sync(() => api.tabs.onUpdated.addListener(onUpdated)),
        () => Effect.sync(() => api.tabs.onUpdated.removeListener(onUpdated)),
      );

      const loading = yield* callBrowser((browserApi) => browserApi.tabs.get(tabId)).pipe(
        Effect.map((tab) => tab.status === "loading"),
        Effect.orElseSucceed(() => false),
      );

      if (loading) yield* Deferred.await(done);
    }),
  ).pipe(Effect.timeoutOption(timeout), Effect.asVoid);

const tabIsLoading = (tabId: number) =>
  callBrowser((api) => api.tabs.get(tabId)).pipe(
    Effect.map((tab) => tab.status === "loading"),
    Effect.orElseSucceed(() => false),
  );

/** What the content script would have said for the same wait, with why it ran out. */
const waitInterrupted = (params: ContentParams): ToolError => {
  const { selector, text, seconds } = params;

  const target =
    Predicate.isString(selector) && selector
      ? `selector: ${selector}`
      : Predicate.isString(text) && text
        ? `text: "${text}"`
        : `${Predicate.isNumber(seconds) ? seconds : 0} seconds`;

  return new ToolError({
    message: `Timeout waiting for ${target} (the page navigated while waiting and the time ran out on the new page)`,
    code: "wait_timeout",
    retryable: true,
    recoveryAction: "retry",
  });
};

/**
 * The content script's `wait` polls inside one document. When that document is
 * replaced, the poll and the reply to the request go with it, so nothing ever
 * answers and the call ends at the bridge timeout, reported as a bridge
 * failure for a page that loaded fine. This races the content script against
 * the tab starting a load. If the load wins, the abandoned poll is dropped, the
 * load is awaited, and the wait is sent again to whatever document it produced
 * with the time that is left, so a navigation started by the page's own script
 * is covered as well as one the agent started.
 */
export const waitAcrossNavigations = Effect.fn("waitAcrossNavigations")(function* (params: ContentParams) {
  const contentScripts = yield* ContentScripts;
  const tabId = yield* tabOf(params);
  const withTab = { ...params, tabId };
  // The same budget the content script reads: `seconds` is a sleep, anything
  // else a poll with a timeout. Zero is a real value for both.
  const seconds = Predicate.isNumber(params["seconds"]) ? params["seconds"] : null;
  const budget = seconds ?? (Predicate.isNumber(params["timeout"]) ? params["timeout"] : 10);
  const deadline = (yield* Clock.currentTimeMillis) + budget * 1000;
  let current: ContentParams = withTab;

  while (true) {
    const attempt = yield* Effect.scoped(
      Effect.gen(function* () {
        const started = yield* watchForLoadStart(tabId);

        return yield* Effect.raceFirst(
          Effect.map(Effect.result(contentScripts.dispatch("wait", current)), (outcome) => ({ outcome })),
          Effect.as(Deferred.await(started), { outcome: null }),
        ).pipe(Effect.map(({ outcome }) => ({ outcome, sawLoad: Deferred.isDoneUnsafe(started) })));
      }),
    );

    if (attempt.outcome !== null) {
      if (Result.isSuccess(attempt.outcome)) return attempt.outcome.success;

      const error = attempt.outcome.failure;

      // A coded failure is the content script's own answer, `wait_timeout`
      // included. What is left is the transport failing, and that only means
      // the document went away if a load explains it.
      if (error.code !== "extension_error") return yield* error;

      if (!attempt.sawLoad && !(yield* tabIsLoading(tabId))) return yield* error;
    }

    yield* waitForLoadComplete(tabId, Duration.millis(Math.max(0, deadline - (yield* Clock.currentTimeMillis))));

    const remaining = deadline - (yield* Clock.currentTimeMillis);

    if (remaining <= 0) return yield* waitInterrupted(params);

    current =
      seconds !== null
        ? { ...withTab, seconds: remaining / 1000, timeout: remaining / 1000 }
        : { ...withTab, timeout: remaining / 1000 };
  }
});
