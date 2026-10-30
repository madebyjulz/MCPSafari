// Tab and window tools, plus the native-input handlers that foreground a tab.

import { Effect, Option, Schema } from "effect";
import type { Tabs } from "webextension-polyfill";
import type { ContentParams } from "../../shared/protocol.ts";
import { callBrowser } from "../Browser.ts";
import { BackgroundTiming } from "../config.ts";
import { ContentScripts, frameOfTarget } from "../ContentScripts.ts";
import { extensionError, invalidInput, permissionRequired, tabNotShowing } from "../errors.ts";
import { SelectedTab } from "../SelectedTab.ts";
import { TabAccess } from "../TabAccess.ts";
import { decodeParams, TabTarget } from "./params.ts";
import { redactUrlSecrets } from "./redaction.ts";

/** The window a tab sits in. Safari always reports one; the type merely allows it not to. */
export const windowOf = (tab: Tabs.Tab) =>
  tab.windowId === undefined ? Effect.fail(extensionError("The tab is not in a window")) : Effect.succeed(tab.windowId);

// ─── What a tab may say about itself ─────────────────────────────────
//
// Safari hands the tabs API a URL and title for every tab, including those on
// sites the user never granted, which reads as browsing history. A tab whose
// site is not known to be granted still appears, so its id stays usable, but
// without the URL and title, and says why.
//
// "Known" is deliberately narrow, because the alternative to knowing is probing
// and a probe on an undecided site raises Safari's dialog: see `isSiteGranted`.
// A site nothing has touched yet is therefore reported as not granted even if
// the user granted it, and becomes readable once any call has reached it.
const NOT_GRANTED_HINT =
  "URL and title withheld: MCPSafari has not been granted access to this site. " +
  "The user can grant it from the MCPSafari button in Safari's toolbar, then list tabs again.";

type AccessFields = { readonly access: "granted" } | { readonly access: "not_granted"; readonly accessHint: string };

const accessFields = (granted: boolean): AccessFields =>
  granted ? { access: "granted" } : { access: "not_granted", accessHint: NOT_GRANTED_HINT };

/** The URL and title of a tab, for a site that has been granted, and nothing otherwise. */
const describedPage = (granted: boolean, tab: Tabs.Tab | null) =>
  granted && tab ? { url: redactUrlSecrets(tab.url), title: tab.title || "" } : {};

export const handleTabsQuery = Effect.fn("tabs_query")(function* () {
  const timing = yield* BackgroundTiming;
  const tabAccess = yield* TabAccess;

  // One tab awaiting a permission decision is enough to hold up the whole
  // listing, and there is no probe that helps because the block belongs to no
  // single tab here. Failing with the reason beats the bridge timing out with
  // none, and this is the call every session starts with.
  const tabs = yield* callBrowser((api) => api.tabs.query({})).pipe(
    Effect.timeoutOrElse({ duration: timing.tabListing, orElse: () => Effect.fail(permissionRequired(null, true)) }),
  );

  return yield* Effect.forEach(tabs, (tab) =>
    Effect.map(tabAccess.isSiteGranted(tab.url), (granted) => ({
      id: tab.id,
      ...describedPage(granted, tab),
      active: tab.active,
      pinned: tab.pinned || false,
      audible: tab.audible || false,
      muted: tab.mutedInfo ? tab.mutedInfo.muted : false,
      status: tab.status || "complete",
      windowId: tab.windowId,
      index: tab.index,
      ...accessFields(granted),
    })),
  );
});

export const handleTabsCreate = Effect.fn("tabs_create")(function* (params: ContentParams) {
  const { url } = yield* decodeParams(Schema.Struct({ url: Schema.optionalKey(Schema.String) }))(params);
  const tab = yield* callBrowser((api) => api.tabs.create(url ? { url } : {}));
  const landed = tab.url || url;
  const granted = yield* (yield* TabAccess).isSiteGranted(landed);

  // The URL is the one the caller asked for. The title is the page's own.
  const created = { id: tab.id, url: redactUrlSecrets(landed), ...accessFields(granted) };

  return granted ? { ...created, title: tab.title || "" } : created;
});

export const handleTabsClose = Effect.fn("tabs_close")(function* (params: ContentParams) {
  const { tabId } = yield* decodeParams(Schema.Struct({ tabId: Schema.Int }))(params);
  const selectedTab = yield* SelectedTab;

  yield* callBrowser((api) => api.tabs.remove(tabId));

  // Clear selected tab if it was closed
  if ((yield* selectedTab.get) === tabId) yield* selectedTab.set(null);

  return `Closed tab ${tabId}`;
});

// Selecting a tab is bookkeeping: it remembers which tab later calls mean, and
// optionally brings it forward. Neither reads the page, so neither needs access
// to it, and requiring it made the pin impossible on exactly the tab a caller
// most needs to pin, the one the user has yet to grant. The first call that does
// touch the page is gated as usual and reports `permission_required`.
//
// Nothing here probes, so nothing here raises Safari's dialog. The tab is looked
// up under a deadline for its window and to confirm it exists; a lookup that is
// parked on a dialog for some other tab does not stop the pin, which is only an
// id, but then there is no window to bring forward and no URL to describe.
export const handleSelectTab = Effect.fn("select_tab")(function* (params: ContentParams) {
  const { tabId, bringToFront } = yield* decodeParams(
    Schema.Struct({ tabId: Schema.Int, bringToFront: Schema.optionalKey(Schema.Boolean) }),
  )(params);

  const timing = yield* BackgroundTiming;
  const tabAccess = yield* TabAccess;
  const selectedTab = yield* SelectedTab;

  // A tab that does not exist is the caller's mistake and must not be pinned,
  // so only the deadline is forgiven.
  const tab = yield* callBrowser((api) => api.tabs.get(tabId)).pipe(
    Effect.timeoutOption(timing.permissionDeadline),
    Effect.map(Option.getOrNull),
  );

  if (tab && bringToFront !== false) {
    const windowId = yield* windowOf(tab);

    // Browser chrome, like `navigate`'s goto, and no more able to hang the call
    // than the lookup above: a deadline here skips the focus and no more.
    yield* Effect.gen(function* () {
      yield* callBrowser((api) => api.tabs.update(tabId, { active: true }));
      yield* callBrowser((api) => api.windows.update(windowId, { focused: true }));
    }).pipe(Effect.timeoutOption(timing.permissionDeadline));
  }

  // Pinned only once the call has gone through. Pinned first, a select_tab
  // that failed still redirected every later call that names no tab.
  yield* selectedTab.set(tabId);

  const granted = tab !== null && (yield* tabAccess.isSiteGranted(tab.url));

  return {
    id: tabId,
    ...describedPage(granted, tab),
    selected: true,
    ...accessFields(granted),
  };
});

/**
 * Activating a tab does not mean it is still the one showing a moment later:
 * the user can click another, and a capture or a native keystroke then reaches
 * the wrong page. So the claim is checked against the window, which is the only
 * thing that knows, right where the result is about to be relied on.
 */
export const assertTabShowing = Effect.fn("assertTabShowing")(function* (
  tabId: number,
  windowId: number,
  purpose: string,
) {
  const showing = yield* (yield* TabAccess).withPermissionDeadline(
    callBrowser((api) => api.tabs.query({ active: true, windowId })),
    tabId,
  );

  if (showing[0]?.id !== tabId) return yield* tabNotShowing(purpose);
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
  yield* assertTabShowing(tabId, windowId, "native input");

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
