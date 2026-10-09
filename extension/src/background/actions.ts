// Every action the extension serves, by name. Kept free of imports so the MCP
// contract test (scripts/test/mcp-results.test.ts) can read it with plain
// Node and check the server asks for nothing the extension cannot answer.

/** Served in the background itself. */
export const BACKGROUND_ACTIONS = [
  "tabs_query",
  "tabs_create",
  "tabs_close",
  "select_tab",
  "navigate",
  "native_type_text",
  "native_press_key",
  "native_pointer",
  "screenshot",
  "javascript_tool",
  "resize_window",
] as const;

/** Answered by the content script under the same name. The router decides which frame to ask. */
export const CONTENT_ACTIONS = [
  "read_page",
  "get_page_text",
  "snapshot",
  "find",
  "click",
  "type_text",
  "form_input",
  "select_option",
  "scroll",
  "press_key",
  "hover",
  "drag",
  "upload_file",
  "drop_file",
  "wait",
  "start_trace",
  "stop_trace",
  "get_console_messages",
  "get_network_requests",
] as const;

/**
 * Answered by the content script, but under a different name or with arguments
 * defaulted here so the content script does not have to.
 */
export const CONTENT_PROXY_ACTIONS = ["read_console", "read_network", "handle_dialog"] as const;

export type BackgroundAction = (typeof BACKGROUND_ACTIONS)[number];

export type ContentAction = (typeof CONTENT_ACTIONS)[number];

export type ContentProxyAction = (typeof CONTENT_PROXY_ACTIONS)[number];

export const ROUTABLE_ACTIONS: ReadonlyArray<string> = [
  ...BACKGROUND_ACTIONS,
  ...CONTENT_ACTIONS,
  ...CONTENT_PROXY_ACTIONS,
];
