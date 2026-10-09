// The contracts every part of the extension shares: which files Safari loads,
// what the content script answers to, how a failure is described, and the
// message channel between the content script and the page world.
//
// Plain constants and types only. The page-world and content scripts import
// from here, and they are injected into every page, so nothing in this module
// may pull in a runtime dependency.

/** The background page, as listed under `background.scripts` in manifest.json. */
export const BACKGROUND_SCRIPT_FILES = ["background.js"] as const;

/**
 * Injected into the page's own world before page scripts run, top frame only.
 *
 * Order matters: the console and network interceptors report into the trace
 * interceptor's recorder when it exists, so trace has to load first.
 */
export const PAGE_WORLD_SCRIPT_FILES = [
  "trace-interceptor.js",
  "dialog-interceptor.js",
  "console-interceptor.js",
  "network-interceptor.js",
  "file-drop.js",
] as const;

/** Injected into the isolated world of every frame. */
export const CONTENT_SCRIPT_FILES = ["content.js"] as const;

/** Every failure code the extension reports. The server passes them to the agent unchanged. */
export const TOOL_ERROR_CODES = [
  "extension_error",
  "invalid_input",
  "permission_required",
  "stale_uid",
  "target_not_found",
  "ambiguous_target",
  "target_not_visible",
  "target_covered",
  "unsupported_native_target",
  "native_input_focus_failed",
  "input_not_applied",
  "wait_timeout",
] as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

/** What the agent should do about a failure. */
export const RECOVERY_ACTIONS = [
  "inspect_error",
  "fix_input",
  "ask_user",
  "take_snapshot",
  "use_synthetic_input",
  "retry",
  "use_native_input",
] as const;

export type RecoveryAction = (typeof RECOVERY_ACTIONS)[number];

/** A failure as it crosses any boundary: content to background, background to server. */
export interface ToolFailure {
  readonly error: string;
  readonly errorCode: ToolErrorCode;
  readonly retryable: boolean;
  readonly recoveryAction: RecoveryAction;
}

/** Actions the content script serves, under the name the background sends. */
export const CONTENT_SCRIPT_ACTIONS = [
  "read_page",
  "get_page_text",
  "snapshot",
  "find",
  "click",
  "type_text",
  "prepare_native_input",
  "form_input",
  "select_option",
  "scroll",
  "press_key",
  "hover",
  "drag",
  "native_pointer_points",
  "prepare_native_key",
  "upload_file",
  "drop_file",
  "element_rect",
  "wait",
  "start_trace",
  "stop_trace",
  "handle_dialog",
  "get_console_messages",
  "get_network_requests",
] as const;

export type ContentScriptAction = (typeof CONTENT_SCRIPT_ACTIONS)[number];

/** One request from the background to a frame's content script. */
export interface ContentRequest {
  readonly action: ContentScriptAction;
  readonly params: ContentParams;
  /** The frame learns its own id from the request it is answering. */
  readonly frameId?: number;
}

/**
 * Tool parameters as the server sends them. Each content handler reads the
 * fields it owns; the server has already validated them against the tool's
 * input schema.
 */
export type ContentParams = Readonly<Record<string, JsonValue | undefined>>;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue };

/** What the content script sends back for one request. */
export type ContentResponse =
  | { readonly data: JsonValue | undefined; readonly error: null }
  | (ToolFailure & { readonly data: null });

// ─── Content script ↔ page world channel ───────────────────────────────

/** `source` on a request the content script posts to the page world. */
export const CONTENT_MESSAGE_SOURCE = "MCPSafariContent";

/** `source` on a reply the page world posts back. */
export const PAGE_MESSAGE_SOURCE = "MCPSafariPage";

/** Requests the page-world scripts answer. */
export type PageRequestType =
  | "get_console_messages"
  | "get_network_requests"
  | "start_trace"
  | "stop_trace"
  | "handle_dialog"
  | "drop_files";
