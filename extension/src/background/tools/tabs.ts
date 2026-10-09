// Tab and window tools, plus the native-input handlers that foreground a tab.

import { Effect, Schema } from "effect";
import type { Tabs } from "webextension-polyfill";
import type { ContentParams } from "../../shared/protocol.ts";
import { callBrowser } from "../Browser.ts";
import { BackgroundTiming } from "../config.ts";
import { ContentScripts, frameOfTarget } from "../ContentScripts.ts";
import { extensionError, invalidInput, permissionRequired } from "../errors.ts";
import { SelectedTab } from "../SelectedTab.ts";
import { TabAccess } from "../TabAccess.ts";
import { decodeParams, TabTarget } from "./params.ts";
import { redactUrlSecrets } from "./redaction.ts";

/** The window a tab sits in. Safari always reports one; the type merely allows it not to. */
export const windowOf = (tab: Tabs.Tab) =>
  tab.windowId === undefined ? Effect.fail(extensionError("The tab is not in a window")) : Effect.succeed(tab.windowId);

export const handleTabsQuery = Effect.fn("tabs_query")(function* () {
  const timing = yield* BackgroundTiming;

  // One tab awaiting a permission decision is enough to hold up the whole
  // listing, and there is no probe that helps because the block belongs to no
  // single tab here. Failing with the reason beats the bridge timing out with
  // none, and this is the call every session starts with.
  const tabs = yield* callBrowser((api) => api.tabs.query({})).pipe(
    Effect.timeoutOrElse({ duration: timing.tabListing, orElse: () => Effect.fail(permissionRequired(null, true)) }),
  );

  return tabs.map((tab) => ({
    id: tab.id,
    url: redactUrlSecrets(tab.url),
    title: tab.title || "",
    active: tab.active,
    pinned: tab.pinned || false,
    audible: tab.audible || false,
    muted: tab.mutedInfo ? tab.mutedInfo.muted : false,
    status: tab.status || "complete",
    windowId: tab.windowId,
    index: tab.index,
  }));
});

export const handleTabsCreate = Effect.fn("tabs_create")(function* (params: ContentParams) {
  const { url } = yield* decodeParams(Schema.Struct({ url: Schema.optionalKey(Schema.String) }))(params);
  const tab = yield* callBrowser((api) => api.tabs.create(url ? { url } : {}));

  return {
    id: tab.id,
    url: redactUrlSecrets(tab.url || url),
    title: tab.title || "",
  };
});

export const handleTabsClose = Effect.fn("tabs_close")(function* (params: ContentParams) {
  const { tabId } = yield* decodeParams(Schema.Struct({ tabId: Schema.Int }))(params);
  const selectedTab = yield* SelectedTab;

  yield* callBrowser((api) => api.tabs.remove(tabId));

  // Clear selected tab if it was closed
  if ((yield* selectedTab.get) === tabId) yield* selectedTab.set(null);

  return `Closed tab ${tabId}`;
});

export const handleSelectTab = Effect.fn("select_tab")(function* (params: ContentParams) {
  const { tabId, bringToFront } = yield* decodeParams(
    Schema.Struct({ tabId: Schema.Int, bringToFront: Schema.optionalKey(Schema.Boolean) }),
  )(params);

  const tabAccess = yield* TabAccess;
  const selectedTab = yield* SelectedTab;

  // Before the `tabs.get`, for the reason spelled out in `handleScreenshot`:
  // that call parks on Safari's dialog too, so leaving it ungated means a
  // blocked tab rides the bridge timeout and reports the wrong thing.
  yield* tabAccess.ensure(tabId);

  const tab = yield* callBrowser((api) => api.tabs.get(tabId));

  // Optionally bring to front
  if (bringToFront !== false) {
    const windowId = yield* windowOf(tab);

    yield* callBrowser((api) => api.tabs.update(tabId, { active: true }));
    yield* callBrowser((api) => api.windows.update(windowId, { focused: true }));
  }

  // Pinned only once the call has gone through. Pinned first, a select_tab
  // that failed still redirected every later call that names no tab.
  yield* selectedTab.set(tabId);

  return {
    id: tab.id,
    url: redactUrlSecrets(tab.url),
    title: tab.title || "",
    selected: true,
  };
});

export const focusTabForNativeInput = Effect.fn("focusTabForNativeInput")(function* (tabIdParam: number | undefined) {
  const timing = yield* BackgroundTiming;
  const tabAccess = yield* TabAccess;
  const tabId = tabIdParam || (yield* (yield* SelectedTab).activeTabId);

  // Native input needs the page anyway, and this ran before any gating, so a
  // blocked tab spent the whole bridge timeout here and then blamed the bridge.
  yield* tabAccess.ensure(tabId);

  const windowId = yield* windowOf(yield* callBrowser((api) => api.tabs.get(tabId)));

  yield* callBrowser((api) => api.tabs.update(tabId, { active: true }));
  yield* callBrowser((api) => api.windows.update(windowId, { focused: true }));
  yield* Effect.sleep(timing.nativeFocusSettle);

  return tabId;
});

// Native input works in screen coordinates, and captureVisibleTab captures the
// top-level viewport. A subframe measures elements in its own viewport and
// cannot reach a cross-origin parent's offset, so a subframe target would
// produce a confidently wrong click or crop. Refusing beats guessing.
export const NATIVE_INPUT_TOP_FRAME_ONLY =
  "Native input reaches the top frame only, and this element is inside an iframe. " +
  "Omit native to use the synthetic path, which works in every frame.";

export const SCREENSHOT_TOP_FRAME_ONLY =
  "Screenshot crops the top-level viewport, and this element is inside an iframe, " +
  "so its position does not map onto the captured image. Capture without uid or selector.";

export const requireTopFrameTarget = (params: ContentParams, reason: string = NATIVE_INPUT_TOP_FRAME_ONLY) =>
  frameOfTarget(params) ? Effect.fail(invalidInput(reason)) : Effect.void;

const prepareNativeInput = Effect.fn("prepareNativeInput")(function* (
  params: ContentParams,
  action: "prepare_native_input" | "prepare_native_key" | "native_pointer_points",
) {
  yield* requireTopFrameTarget(params);

  const { tabId } = yield* decodeParams(TabTarget)(params);
  const focused = yield* focusTabForNativeInput(tabId);

  return yield* (yield* ContentScripts).send(focused, { action, params });
});

export const handleNativeTypeText = (params: ContentParams) =>
  Effect.as(prepareNativeInput(params, "prepare_native_input"), "Safari is ready for native input");

export const handleNativePressKey = (params: ContentParams) =>
  Effect.as(prepareNativeInput(params, "prepare_native_key"), "Safari is ready for native input");

export const handleNativePointer = (params: ContentParams) => prepareNativeInput(params, "native_pointer_points");
