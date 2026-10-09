// Wiring the background together: the service graph, the browser event
// listeners, and startup. main.ts runs it against Safari; tests run it against
// a fake browser.

import { Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
import type BrowserApi from "webextension-polyfill";
import type { Runtime } from "webextension-polyfill";
import { PopupRequest } from "../shared/popup.ts";
import { Browser } from "./Browser.ts";
import { Connections } from "./Connections.ts";
import { ContentScripts } from "./ContentScripts.ts";
import { answerPopup } from "./Popup.ts";
import { Router } from "./Router.ts";
import { SelectedTab } from "./SelectedTab.ts";
import { TabAccess } from "./TabAccess.ts";

/** Every background service, on top of whatever provides `Browser`. */
export const BackgroundLayer = Connections.layer.pipe(
  Layer.provideMerge(Router.layer),
  Layer.provideMerge(ContentScripts.layer),
  Layer.provideMerge(SelectedTab.layer),
  Layer.provideMerge(TabAccess.layer),
);

export type BackgroundServices = Layer.Success<typeof BackgroundLayer> | Browser;

export type BackgroundRuntime = ManagedRuntime.ManagedRuntime<BackgroundServices, never>;

const KEEPALIVE_ALARM = "mcp-keepalive";

const decodePopupRequest = Schema.decodeUnknownOption(PopupRequest);

/**
 * Registers every browser event listener. Done synchronously while the page
 * loads, because Safari only delivers the events that woke a suspended
 * background page to listeners that exist by the end of its first run.
 */
export const registerListeners = (api: BrowserApi.Browser, runtime: BackgroundRuntime): void => {
  // Entries expire on their own, but a long-lived background page would otherwise
  // accumulate one per tab ever touched.
  api.tabs.onRemoved.addListener((tabId) => {
    runtime.runFork(TabAccess.use((access) => access.forget(tabId)));
  });

  // Safari grants access per origin, so a pass stops meaning anything the moment
  // the tab goes somewhere else. Keyed by tab alone, a `navigate` followed
  // straight away by a read fitted inside the window and reused the old origin's
  // grant, which put the read back on an unbounded wait for the new origin's
  // dialog. Clearing here rather than reading the origin on every call keeps the
  // hot path free of an extra `tabs.get`.
  api.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url) runtime.runFork(TabAccess.use((access) => access.forget(tabId)));
  });

  // From the popup. Anything else gets no reply: returning false tells Safari
  // this listener will not answer, and returning true keeps the channel open
  // for the reply sent once the answer is ready.
  // SAFETY: the polyfill's types only allow a callback listener that always
  // returns true, but Safari, like Chrome, treats a false return as "no reply".
  api.runtime.onMessage.addListener(((message, _sender, sendResponse) => {
    const request = decodePopupRequest(message);

    if (Option.isNone(request)) return false;

    void runtime.runPromise(answerPopup(request.value)).then(sendResponse, () => sendResponse(undefined));

    return true;
  }) as Runtime.OnMessageListenerCallback);

  // ─── Keepalive ─────────────────────────────────────────────────────
  //
  // Safari suspends an idle background page. An alarm wakes it periodically to
  // keep the WebSockets connected, and resets backoff so the extension quickly
  // reconnects when a new server starts instead of waiting out a long backoff.
  if (api.alarms !== undefined) {
    void api.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 }); // ~24s
    api.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === KEEPALIVE_ALARM) runtime.runFork(Connections.use((connections) => connections.keepalive));
    });
  }
};

/** Loads tokens and restores state side by side, then connects everything known. */
export const startup = Effect.gen(function* () {
  const connections = yield* Connections;
  const selectedTab = yield* SelectedTab;

  yield* Effect.all([connections.loadAuthTokens, Effect.andThen(selectedTab.restore, connections.restore)], {
    concurrency: "unbounded",
    discard: true,
  });
  yield* connections.connectAll;
  yield* Effect.log("[MCPSafari] Background script initialized");
});
