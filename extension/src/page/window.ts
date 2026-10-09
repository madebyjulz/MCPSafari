// What the page-world scripts install on `window`, and the records they keep.
//
// Types only: the page-world scripts are injected before any page script and
// must not carry runtime code they do not use, so nothing here emits code.

// ─── Trace interceptor ─────────────────────────────────────────────────

/** A value a trace event may carry. Events are posted back to the content script, so they stay cloneable. */
export type TraceValue = string | number | boolean | null | undefined;

/** Extra fields recorded with a trace event. */
export interface TraceDetail {
  readonly [field: string]: TraceValue;
}

/** One recorded event: its type, when it happened, and its detail fields. */
export type TraceEvent = TraceDetail;

/** Records an event into every running trace. Console and network capture call this when trace is loaded. */
export type RecordTraceEvent = (type: string, detail?: TraceDetail, at?: number) => void;

export interface TraceParams {
  readonly id?: string;
  readonly eventTypes?: ReadonlyArray<string>;
}

export interface TraceStart {
  readonly id: string;
  readonly startTime: number;
  readonly url: string;
}

export interface TraceStop {
  readonly id: string | undefined;
  readonly startTime: number | null;
  readonly endTime: number;
  readonly durationMs: number;
  readonly startUrl: string | null;
  readonly endUrl: string;
  readonly truncated: boolean;
  readonly events: ReadonlyArray<TraceEvent>;
  readonly error?: string;
}

// ─── Dialog interceptor ────────────────────────────────────────────────

export type DialogType = "alert" | "confirm" | "prompt";

/** What a dialog returned: nothing for alert, a choice for confirm, text or null for prompt. */
export type DialogResult = string | boolean | null | undefined;

export interface DialogParams {
  readonly action?: string;
  readonly promptText?: string | null;
}

export interface CapturedDialog {
  readonly type: DialogType;
  readonly message: string;
  readonly defaultValue: string | null;
  readonly result: DialogResult;
  readonly truncated: boolean;
}

export type HandleDialogResult =
  | ({
      readonly handled: true;
      readonly alreadyHandled: true;
      readonly droppedDialogs: number;
    } & Partial<CapturedDialog>)
  | {
      readonly handled: false;
      readonly armed: true;
      readonly expiresInMs: number;
      readonly dialogsRemaining: number;
    };

// ─── Console interceptor ───────────────────────────────────────────────

export type ConsoleLevel = "log" | "warn" | "error" | "info" | "debug";

export interface ConsoleMessage {
  readonly level: ConsoleLevel;
  readonly timestamp: number;
  readonly text: string;
  readonly truncated: boolean;
}

export interface ConsoleParams {
  readonly level?: string;
  readonly pattern?: string;
  readonly clear?: boolean;
}

// ─── Network interceptor ───────────────────────────────────────────────

/** A field of a captured network record. */
export type NetworkValue = string | number | boolean | null | undefined;

/** Any captured network record: every string field is capped, and `truncated` marks a capped one. */
export interface NetworkRecord {
  [field: string]: NetworkValue;
  truncated?: boolean;
}

/** An XMLHttpRequest or fetch call. */
export interface RequestRecord extends NetworkRecord {
  readonly type: "xhr" | "fetch";
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly statusText: string;
  readonly duration: number;
  readonly responseSize?: number | null;
  readonly timestamp: number;
  readonly error?: string;
}

/** A subresource load reported by resource timing. */
export interface ResourceRecord extends NetworkRecord {
  readonly type: "resource";
  readonly url: string;
  readonly initiatorType: string;
  readonly transferSize: number;
  readonly encodedBodySize: number;
  readonly decodedBodySize: number;
  readonly startTime: number;
  readonly duration: number;
  readonly timestamp: number;
  timingRestricted?: boolean;
}

export type NetworkEntry = RequestRecord | ResourceRecord;

export interface NetworkParams {
  readonly type?: string;
  readonly urlPattern?: string;
  readonly status?: number | null;
  readonly maxResults?: number;
  readonly clear?: boolean;
}

/** What the XMLHttpRequest patch remembers from open() for the next send(). */
export interface XhrMeta {
  readonly method: string;
  readonly url: string;
  readonly truncated: boolean;
  readonly type: "xhr";
}

// ─── File drop ─────────────────────────────────────────────────────────

export interface DropParams {
  readonly marker: string;
  readonly files: ReadonlyArray<File>;
}

export interface DropResult {
  readonly dropped: number;
}

declare global {
  interface Window {
    __mcpTraceInterceptorLoaded?: boolean;
    __mcpDialogInterceptorLoaded?: boolean;
    __mcpConsoleInterceptorLoaded?: boolean;
    __mcpNetworkInterceptorLoaded?: boolean;
    __mcpFileDropLoaded?: boolean;

    /** Present once the trace interceptor has loaded; the page can replace it. */
    __mcpRecordTraceEvent?: RecordTraceEvent;
    __mcpStartTrace: (params?: TraceParams) => TraceStart;
    __mcpStopTrace: (params?: TraceParams) => TraceStop;
    __mcpHandleDialog: (params?: DialogParams) => HandleDialogResult;
    __mcpGetPendingDialogs: () => ReadonlyArray<CapturedDialog>;
    __mcpGetConsoleMessages: (params?: ConsoleParams) => ReadonlyArray<ConsoleMessage>;
    __mcpGetNetworkRequests: (params?: NetworkParams) => ReadonlyArray<NetworkEntry>;
  }

  interface XMLHttpRequest {
    /** Set by the network interceptor's open() patch; visible to the page as an expando. */
    __mcpMeta?: XhrMeta;
  }
}
