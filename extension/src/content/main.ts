/**
 * MCPSafari Content Script
 *
 * The entry point of the bundle injected into the isolated world of every
 * frame. Routes one bridge action to the handler that owns it and answers the
 * background script.
 */

import type { Runtime } from "webextension-polyfill";

import type { ContentParams, ContentResponse, JsonValue } from "../shared/protocol.ts";
import { setFrameId, type ThrownError } from "./core.ts";
import {
  dragElement,
  hoverElement,
  nativePointerPoints,
  prepareNativeKey,
  pressKey,
  scrollPage,
  type DragParams,
  type HoverParams,
  type NativePointerParams,
  type PressKeyParams,
  type ScrollParams,
} from "./gesture.ts";
import {
  clickElement,
  formInput,
  prepareNativeInput,
  selectOption,
  typeText,
  type ClickParams,
  type FormInputParams,
  type SelectOptionParams,
  type TypeTextParams,
} from "./input.ts";
import {
  dropFile,
  elementRect,
  getConsoleMessages,
  getNetworkRequests,
  handleDialog,
  startTrace,
  stopTrace,
  uploadFile,
  waitFor,
  type ElementParams,
  type FileParams,
  type HandleDialogParams,
  type WaitParams,
} from "./io.ts";
import { getPageText, readPage, takeSnapshot, type ReadPageParams, type SnapshotParams } from "./snapshot.ts";
import { findElements, type FindParams, type TargetParams } from "./target.ts";

declare global {
  interface Window {
    /** Set once this frame's content script is answering requests. See the guard below. */
    __mcpSafari?: true;
  }
}

/** A runtime message as it reaches this frame; only requests with an action are ours. */
interface IncomingMessage {
  readonly action?: string;
  readonly params?: ContentParams | null;
  readonly frameId?: number;
}

// ─── Re-injection guard ──────────────────────────────────────────

// The background re-injects content.js into every frame when one does not
// answer, and that re-runs this whole bundle in an isolated world where the
// previous run may still be live. A second message listener would answer
// every tool call twice, and a second copy of the uid counter, uid maps,
// frame id, bridge request counter or drop queue would mint colliding uids
// and lose the ones the agent already holds. So only the first evaluation
// registers; a later one allocates its own module state, which nothing ever
// reaches, and stops here. That is safe because no module in src/content
// does anything at its top level beyond allocating that state.
//
// The marker is published only after the listener is registered, so a first
// load that throws partway (before or inside addListener) leaves no marker,
// and the next re-injection gets a clean attempt instead of finding a frame
// that claims to be loaded and never answers.
if (!window.__mcpSafari) {
  // SAFETY: Safari reads a `false` return as "no response coming", which the
  // polyfill's listener types (that admit only `true`) cannot express; the
  // message is whatever a sender posted and is checked before use below.
  browser.runtime.onMessage.addListener(onMessage as Runtime.OnMessageListener);
  window.__mcpSafari = true;
}

// ─── Message Handler ─────────────────────────────────────────────

function onMessage(
  message: IncomingMessage | null | undefined,
  _sender: Runtime.MessageSender,
  sendResponse: (response: ContentResponse) => void,
): boolean {
  // Only handle messages meant for content scripts
  if (!message || !message.action) return false;

  if (typeof message.frameId === "number") setFrameId(message.frameId);

  handleAction(message.action, message.params || {})
    .then((data) => sendResponse({ data, error: null }))
    .catch((err: ThrownError) =>
      sendResponse({
        data: null,
        // oxlint-disable-next-line typescript/no-base-to-string -- a rejection that is not an Error is reported as its own string form, as it always was
        error: String(err.message || err),
        errorCode: typeof err.code === "string" ? err.code : "extension_error",
        retryable: err.retryable === true,
        recoveryAction: typeof err.recoveryAction === "string" ? err.recoveryAction : "inspect_error",
      }),
    );

  return true; // async response
}

/**
 * The background sends each action the params its tool schema declares, and
 * the server validated them against that schema, so each handler receives
 * them under the interface it reads them through.
 */
function paramsFor<Params extends ContentParams>(params: ContentParams): Params {
  // SAFETY: see above; the handlers keep the defensive reads the untyped
  // script had for fields a sender left out.
  return params as Params;
}

// Each case hands back the handler's own result. An async function's body
// runs synchronously up to its first await, so a handler whose DOM work is
// synchronous (click, typing, hover, snapshot) still does all of it inside
// the onMessage callback, with no framework render able to interleave.
async function handleAction(action: string, params: ContentParams): Promise<JsonValue | undefined> {
  switch (action) {
    case "read_page":
      return readPage(paramsFor<ReadPageParams>(params));
    case "get_page_text":
      return getPageText();
    case "snapshot":
      return takeSnapshot(paramsFor<SnapshotParams>(params));
    case "find":
      return findElements(paramsFor<FindParams>(params));
    case "click":
      return clickElement(paramsFor<ClickParams>(params));
    case "type_text":
      return typeText(paramsFor<TypeTextParams>(params));
    case "prepare_native_input":
      return prepareNativeInput(paramsFor<TargetParams>(params));
    case "form_input":
      return formInput(paramsFor<FormInputParams>(params));
    case "select_option":
      return selectOption(paramsFor<SelectOptionParams>(params));
    case "scroll":
      return scrollPage(paramsFor<ScrollParams>(params));
    case "press_key":
      return pressKey(paramsFor<PressKeyParams>(params));
    case "hover":
      return hoverElement(paramsFor<HoverParams>(params));
    case "drag":
      return dragElement(paramsFor<DragParams>(params));
    case "native_pointer_points":
      return nativePointerPoints(paramsFor<NativePointerParams>(params));
    case "prepare_native_key":
      return prepareNativeKey();
    case "upload_file":
      return uploadFile(paramsFor<FileParams>(params));
    case "drop_file":
      return dropFile(paramsFor<FileParams>(params));
    case "element_rect":
      return elementRect(paramsFor<ElementParams>(params));
    case "wait":
      return waitFor(paramsFor<WaitParams>(params));
    case "start_trace":
      return startTrace(params);
    case "stop_trace":
      return stopTrace(params);
    case "handle_dialog":
      return handleDialog(paramsFor<HandleDialogParams>(params));
    case "get_console_messages":
      return getConsoleMessages(params);
    case "get_network_requests":
      return getNetworkRequests(params);
    default:
      throw new Error(`Unknown content action: ${action}`);
  }
}
