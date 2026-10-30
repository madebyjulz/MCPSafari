// The one failure type the background deals in, and how it crosses the wire.

import { Predicate, Schema } from "effect";
import { RECOVERY_ACTIONS, TOOL_ERROR_CODES, type ContentResponse } from "../shared/protocol.ts";

export const ToolErrorCode = Schema.Literals(TOOL_ERROR_CODES);

export const RecoveryAction = Schema.Literals(RECOVERY_ACTIONS);

/**
 * A failure the agent is told about: what went wrong, whether trying again can
 * help, and what to do instead. Everything that can fail in the background ends
 * up as one of these before it reaches the server.
 */
export class ToolError extends Schema.TaggedError<ToolError>()("ToolError", {
  message: Schema.String,
  code: ToolErrorCode,
  retryable: Schema.Boolean,
  recoveryAction: RecoveryAction,
  /**
   * Set on `permission_required` only. Carried rather than sniffed back out of
   * the message: the popup needs to tell "Safari is asking right now" from
   * "Safari has been told no".
   */
  permissionPending: Schema.optionalKey(Schema.Boolean),
}) {}

/** A failure with no more specific code: a browser API that threw, a bug, anything unexpected. */
export const extensionError = (message: string): ToolError =>
  new ToolError({ message, code: "extension_error", retryable: false, recoveryAction: "inspect_error" });

export const invalidInput = (message: string): ToolError =>
  new ToolError({ message, code: "invalid_input", retryable: false, recoveryAction: "fix_input" });

/**
 * Whatever was thrown or rejected, described the way the hand-written
 * background always did: its `message` if it has one, else its string form.
 */
export const fromUnknown = (cause: unknown): ToolError => {
  if (cause instanceof ToolError) return cause;

  const message = Predicate.hasProperty(cause, "message") && cause.message ? cause.message : cause;

  return extensionError(String(message));
};

/**
 * Two different situations, and the difference is the whole point: a dialog the
 * user has not seen yet, versus access they have already been refused. Both are
 * retryable, because in both cases a grant makes the same call work.
 */
export const permissionRequired = (origin: string | null, pending: boolean): ToolError => {
  const site = origin ? `this tab (${origin})` : "this tab";

  return new ToolError({
    message: pending
      ? `MCPSafari needs the user to allow access to ${site}. Safari is showing a ` +
        `permission dialog that blocks every call for this tab until it is answered, and ` +
        `it can sit behind another window. Ask the user to find it and choose "Always ` +
        `Allow on This Website", then retry.`
      : `MCPSafari is not allowed on ${site}. Ask the user to grant it from the MCPSafari ` +
        `button in Safari's toolbar, or in Safari Settings > Extensions > MCPSafari ` +
        `Extension, where "Always Allow on Every Website" also stops the per-site ` +
        `asking. Then retry.`,
    code: "permission_required",
    retryable: true,
    recoveryAction: "ask_user",
    permissionPending: pending,
  });
};

/**
 * The tab `select_tab` pinned is gone. Not retryable as it stands: repeating the
 * call finds the same absence, and the caller has to choose a tab again.
 */
export const tabClosed = (tabId: number): ToolError =>
  new ToolError({
    message:
      `The tab pinned with select_tab (id ${tabId}) no longer exists, so this call was not run. ` +
      `Call tabs_context to list the open tabs, then select_tab again.`,
    code: "tab_closed",
    retryable: false,
    recoveryAction: "call_tabs_context",
  });

/**
 * The tab was activated, but another one is showing in its window now, so what
 * was about to be captured or typed would have reached the wrong page.
 */
export const tabNotShowing = (purpose: string): ToolError =>
  new ToolError({
    message:
      `The tab is no longer the one showing in its window (another tab was activated), so ${purpose} ` +
      "would have reached the wrong page. Retry the call.",
    code: "tab_not_showing",
    retryable: true,
    recoveryAction: "retry",
  });

/** A failure the content script reported, with its code and recovery intact. */
export const fromContentFailure = (response: Extract<ContentResponse, { readonly data: null }>): ToolError => {
  const code = Schema.is(ToolErrorCode)(response.errorCode) ? response.errorCode : "extension_error";
  const recoveryAction = Schema.is(RecoveryAction)(response.recoveryAction) ? response.recoveryAction : "inspect_error";

  return new ToolError({
    message: response.error,
    code,
    retryable: response.retryable === true,
    recoveryAction,
  });
};

/** The reply to one bridge request, as the Swift server's `BridgeResponse` decodes it. */
export interface BridgeResponse {
  readonly id: string;
  readonly success: boolean;
  readonly data: string | null;
  readonly error: string | null;
  readonly errorCode?: string;
  readonly retryable?: boolean;
  readonly recoveryAction?: string;
  /**
   * The tab this request acted on, or null for a tool that acts on none. Handed
   * back so a caller sequencing several untabbed calls can pin the rest of the
   * sequence to the first one's tab.
   */
  readonly resolvedTabId: number | null;
}

export const failureResponse = (id: string, error: ToolError, resolvedTabId: number | null = null): BridgeResponse => ({
  id,
  success: false,
  data: null,
  error: error.message,
  errorCode: error.code,
  retryable: error.retryable,
  recoveryAction: error.recoveryAction,
  resolvedTabId,
});
