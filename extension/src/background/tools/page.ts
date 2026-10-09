// Screenshots, page JavaScript execution and window resizing.

import { Effect, Predicate, Schema } from "effect";
import type { Windows } from "webextension-polyfill";
import type { ContentParams, JsonValue } from "../../shared/protocol.ts";
import { callBrowser } from "../Browser.ts";
import { BackgroundTiming } from "../config.ts";
import { ContentScripts } from "../ContentScripts.ts";
import { extensionError } from "../errors.ts";
import { SelectedTab } from "../SelectedTab.ts";
import { TabAccess } from "../TabAccess.ts";
import { decodeParams } from "./params.ts";
import { evaluateUserCode, readPageContext, type Evaluation, type PageContext } from "../injected.ts";
import { requireTopFrameTarget, SCREENSHOT_TOP_FRAME_ONLY, windowOf } from "./tabs.ts";

// ─── Screenshot Handler ─────────────────────────────────────────────

const ScreenshotParams = Schema.Struct({
  tabId: Schema.optionalKey(Schema.Int),
  uid: Schema.optionalKey(Schema.String),
  selector: Schema.optionalKey(Schema.String),
});

interface ScreenshotResult extends PageContext {
  readonly image: string;
  /** Where the requested element sits in the image, when one was named. */
  target?: JsonValue;
}

export const handleScreenshot = Effect.fn("screenshot")(function* (params: ContentParams) {
  yield* requireTopFrameTarget(params, SCREENSHOT_TOP_FRAME_ONLY);

  const timing = yield* BackgroundTiming;
  const tabAccess = yield* TabAccess;
  const { tabId: tabIdParam, uid, selector } = yield* decodeParams(ScreenshotParams)(params);
  const tabId = tabIdParam || (yield* (yield* SelectedTab).activeTabId);

  // Before the `tabs.get` below, which blocks on Safari's dialog just like the
  // capture does. Deadlining only the capture left this line to absorb the
  // whole wait, so a blocked screenshot still took the full bridge timeout and
  // still reported the wrong reason.
  yield* tabAccess.ensure(tabId);

  const tab = yield* callBrowser((api) => api.tabs.get(tabId));

  // captureVisibleTab captures the active tab in a window
  if (!tab.active) {
    yield* callBrowser((api) => api.tabs.update(tabId, { active: true }));
    yield* Effect.sleep(timing.screenshotActivateSettle);
  }

  // Context before the frame: a page that loses focus between the two reads
  // then produces a warning about a good frame rather than an all-clear on a
  // stale one.
  // The target is scrolled into view before the context read so the
  // reported viewport matches the frame.
  const target =
    uid || selector
      ? yield* (yield* ContentScripts).send(tabId, {
          action: "element_rect",
          params: { uid, selector },
        })
      : null;

  const context = yield* capturePageContext(tabId);
  const windowId = yield* windowOf(tab);

  // Deliberately not `ensure`: the context read above is allowed to fail and
  // still produce a picture, and a probe would turn that graceful degradation
  // into a refusal. A capture is sub-second when it is permitted at all, so a
  // deadline here separates "blocked on the dialog" from "slow".
  const dataUrl = yield* tabAccess.withPermissionDeadline(
    callBrowser((api) => api.tabs.captureVisibleTab(windowId, { format: "png" })),
    tabId,
  );

  const result: ScreenshotResult = {
    // Raw base64, data URI prefix stripped
    image: dataUrl.replace(/^data:image\/\w+;base64,/, ""),
    ...context,
  };

  if (target) result.target = target;

  return result;
});

// Viewport, scale, visibility, and focus at capture time. Safari does not
// repaint an occluded page, so a capture of a hidden page can predate the last
// action, and it does not match :focus while its window is not key.
const capturePageContext = (tabId: number) =>
  callBrowser((api) => api.scripting.executeScript({ target: { tabId }, func: readPageContext })).pipe(
    // SAFETY: the injected function above returns a PageContext.
    Effect.map((results): PageContext => (results[0]?.result as PageContext | undefined) || {}),
    Effect.catch((error) =>
      Effect.as(Effect.logWarning("[MCPSafari] Screenshot context unavailable:", error.message), {}),
    ),
  );

// ─── JavaScript Execution Handler ────────────────────────────────────

// Safari hands back what the injected function returned, and nothing at all
// when the frame produced no result, which reads as the code returning nothing.
const isEvaluation = (value: unknown): value is Evaluation =>
  Predicate.hasProperty(value, "ok") && Predicate.isBoolean(value.ok);

const JavaScriptParams = Schema.Struct({ tabId: Schema.optionalKey(Schema.Int), code: Schema.String });

export const handleJavaScript = Effect.fn("javascript_tool")(function* (params: ContentParams) {
  const { tabId: tabIdParam, code } = yield* decodeParams(JavaScriptParams)(params);
  const tabId = tabIdParam || (yield* (yield* SelectedTab).activeTabId);

  yield* (yield* TabAccess).ensure(tabId);

  const runIn = (world: "MAIN" | "ISOLATED") =>
    callBrowser((api) =>
      api.scripting.executeScript({ target: { tabId }, func: evaluateUserCode, args: [code], world }),
    ).pipe(
      Effect.map((results): Evaluation => {
        const result: unknown = results && results.length > 0 ? results[0]?.result : undefined;

        return isEvaluation(result) ? result : { ok: true };
      }),
    );

  let result = yield* runIn("MAIN");
  let isolated = false;

  if (!result.ok && result.cspBlocked) {
    // The isolated world does not inherit the page's CSP and still shares
    // the DOM, so DOM-based code survives a strict script-src. Page
    // JavaScript globals do not exist there, which the caller is told.
    // Retrying is safe because a CSP refusal happens at compile time, so
    // nothing in the submitted code has run yet and side effects cannot double.
    const fallback = yield* runIn("ISOLATED");

    if (!fallback.ok && fallback.cspBlocked) {
      return yield* extensionError(
        "The page's Content Security Policy blocks evaluating code as a string, " +
          "in both the page world and the extension's isolated world. " +
          "Use snapshot, find, or read_page to inspect the page, and click or " +
          "type_text to drive it.",
      );
    }

    result = fallback;
    isolated = true;
  }

  // `throw ""` has an empty message and is a failure all the same.
  if (!result.ok) return yield* extensionError(result.error || "The code threw an empty value");

  const value = result.value !== undefined ? JSON.stringify(result.value) : "undefined";

  return isolated
    ? `${value}\n\n[Ran in the extension's isolated world: the page's CSP blocked evaluation in the page world. The DOM is shared, but page JavaScript globals such as window properties set by the site are not visible.]`
    : value;
});

// ─── Window Resize Handler ───────────────────────────────────────────

const ResizeParams = Schema.Struct({
  tabId: Schema.optionalKey(Schema.Int),
  width: Schema.optionalKey(Schema.Int),
  height: Schema.optionalKey(Schema.Int),
});

export const handleResizeWindow = Effect.fn("resize_window")(function* (params: ContentParams) {
  const { tabId: tabIdParam, width, height } = yield* decodeParams(ResizeParams)(params);
  // Routed like every other handler. Reading `currentWindow` directly ignored
  // both `tabId` and the pin `select_tab` sets, so with the agent's tab in one
  // window and the user clicked into another, the resize landed on the user's
  // and a screenshot afterwards did not match the viewport that was asked for.
  const tabId = tabIdParam || (yield* (yield* SelectedTab).activeTabId);
  const windowId = yield* windowOf(yield* callBrowser((api) => api.tabs.get(tabId)));

  const size: Windows.UpdateUpdateInfoType = {};

  if (width !== undefined) size.width = width;

  if (height !== undefined) size.height = height;

  yield* callBrowser((api) => api.windows.update(windowId, size));

  return `Resized window to ${width}x${height}`;
});
