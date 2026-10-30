/**
 * Shared foundation for the content script: element uid bookkeeping, tool
 * errors, event primitives, and the bridge to the MAIN-world interceptors.
 *
 * The bundle is evaluated again whenever the background re-injects it, so
 * nothing at the top level of this module (or any other in src/content) may
 * have a side effect beyond allocating its own state. A second evaluation
 * allocates a second copy that nothing ever reaches; see main.ts.
 */

import {
  CONTENT_MESSAGE_SOURCE,
  PAGE_MESSAGE_SOURCE,
  type ContentParams,
  type JsonValue,
  type PageRequestType,
  type RecoveryAction,
  type ToolErrorCode,
} from "../shared/protocol.ts";

/**
 * An element as the handlers read it. The DOM only defines most of these on
 * some element types (inputs, labels, anchors, frames, slots); everywhere else
 * they read undefined, which is exactly how the handlers test for them.
 */
export interface PageElement extends HTMLElement {
  value?: string | undefined;
  checked?: boolean;
  disabled?: boolean;
  readonly selected?: boolean;
  readonly readOnly?: boolean;
  readonly type?: string;
  readonly multiple?: boolean;
  files?: FileList | null;
  /** A URL on an HTML anchor; an SVGAnimatedString on an SVG one. */
  readonly href?: string | SVGAnimatedString;
  readonly src?: string;
  readonly alt?: string;
  readonly placeholder?: string;
  readonly labels?: NodeListOf<HTMLLabelElement> | null;
  readonly control?: PageElement | null;
  readonly form?: HTMLFormElement | null;
  readonly options?: HTMLOptionsCollection;
  readonly assignedElements?: HTMLSlotElement["assignedElements"];
  readonly assignedNodes?: HTMLSlotElement["assignedNodes"];
}

/** Views a node the DOM handed back as a PageElement. */
export function asPageElement(node: Node): PageElement {
  // SAFETY: callers pass element nodes only (query results, hit tests, focus,
  // walkers filtered to SHOW_ELEMENT). Every member PageElement adds to
  // HTMLElement is optional, and an SVG element answers the HTMLElement members
  // the handlers use the same way the untyped scripts always relied on.
  return node as PageElement;
}

/** A failure a handler raises on purpose, carrying the fields of a ToolFailure. */
export interface ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly retryable: boolean;
  readonly recoveryAction: RecoveryAction;
}

/** Whatever a handler rejected with, read the way the dispatcher reads it. */
export interface ThrownError {
  readonly message?: string;
  readonly code?: ToolErrorCode;
  readonly retryable?: boolean;
  readonly recoveryAction?: RecoveryAction;
}

// UID counter for element references
let uidCounter = 0;

const uidMap = new WeakMap<Element, string>();

const reverseUidMap = new Map<string, WeakRef<PageElement>>();

// Random rather than a clock and a counter, so a page cannot compute the id of
// a request it has not seen yet. That is only half the protection: the request
// itself is posted to the window, where the page can read the id and answer
// first, which is why requestMainWorld validates the reply as well.
export function nextRequestId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));

  return `${prefix}-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

// Every frame runs its own copy of this script with its own counter, so a
// bare "e1" is ambiguous across frames. The background knows which frame it
// is addressing and stamps each request, so the id arrives with the work
// rather than needing a handshake that a tool call could outrun.
let frameId = 0;

// Set from the stamp on each incoming request.
export function setFrameId(id: number): void {
  frameId = id;
}

export function toolError(
  code: ToolErrorCode,
  message: string,
  retryable: boolean,
  recoveryAction: RecoveryAction,
): ToolError {
  return Object.assign(new Error(message), { code, retryable, recoveryAction });
}

// A native event goes to whatever Safari has focused, not to the element that
// was asked for. `activeElement` alone cannot say: it still names the page's
// element while the address bar or find bar holds the keyboard, and typing then
// lands in the bar (with `clearFirst`, clearing it). Only the document knows
// whether it holds focus at all.
export function assertPageFocused(what: string): void {
  if (document.hasFocus()) return;

  throw toolError(
    "native_input_focus_failed",
    `The page does not have focus, so ${what} would go to whatever does: ` +
      "Safari's address bar or find bar, or another window. Click the page " +
      "or bring Safari to the front, then retry.",
    true,
    "retry",
  );
}

export function pointerEvent(type: string, opts: PointerEventInit): MouseEvent {
  const Ctor = typeof PointerEvent === "function" ? PointerEvent : MouseEvent;

  return new Ctor(type, opts);
}

// Escapes a value for use inside a quoted CSS attribute selector.
export function escapeCssString(value: string): string {
  if (window.CSS && typeof window.CSS.escape === "function") {
    return window.CSS.escape(value);
  }

  return String(value).replace(/["\\]/g, "\\$&");
}

// The WeakRef lets the element go, but its entry here would outlive it.
// A long agent session re-snapshotting a page that re-renders mints a fresh
// uid every time, so without this the map grows for the life of the page.
const uidFinalizer =
  typeof FinalizationRegistry === "function"
    ? new FinalizationRegistry<string>((uid) => {
        reverseUidMap.delete(uid);
      })
    : null;

export function getUid(element: PageElement): string {
  if (uidMap.has(element)) return uidMap.get(element) ?? "";

  const uid = `f${frameId}e${++uidCounter}`;
  uidMap.set(element, uid);
  reverseUidMap.set(uid, new WeakRef(element));

  if (uidFinalizer) uidFinalizer.register(element, uid);

  return uid;
}

export function getElementByUid(uid: string): PageElement | null | undefined {
  const ref = reverseUidMap.get(uid);
  const element = ref ? ref.deref() : null;

  // Collection may have happened without the finalizer having run yet.
  if (ref && !element) reverseUidMap.delete(uid);

  return element;
}

/** The files a drop hands to file-drop.js, with the marker naming its target. */
export interface DropFilesRequest {
  readonly marker: string;
  readonly files: ReadonlyArray<File>;
}

/** A reply the page world posts back, or anything else posted on the window. */
interface PageReply {
  readonly source?: unknown;
  readonly id?: unknown;
  readonly error?: unknown;
  readonly data?: unknown;
}

// ─── Page-world replies ──────────────────────────────────────────

/** How long a list and a string in one reply may be. */
interface ReplyLimits {
  readonly entries: number;
  readonly string: number;
}

// The MAIN-world scripts cap what they capture, but a reply arrives over
// window.postMessage, which the page can answer too, and it can replace
// `window.__mcpGetConsoleMessages` outright. So the caps are enforced again
// here, on what actually arrived. One reply that ignored them would carry past
// the bridge's 32 MiB frame limit, and an oversized frame drops the bridge for
// every Safari profile, not just this tab.
//
// These repeat the figures in console-interceptor.ts (1000 messages of 8192),
// network-interceptor.ts (500 records of 2048) and trace-interceptor.ts (1000
// events and its truncation marker). A trace event carries a console message
// whole, so its strings get the console's cap. No legitimate entry is cut by
// them; only MAX_REPLY_CHARS can cut a full buffer of long entries short, and
// the reply then says `truncated` where it was cut.
const MAIN_WORLD_LIMITS: ReadonlyMap<PageRequestType, ReplyLimits> = new Map([
  ["get_console_messages", { entries: 1000, string: 8192 }],
  ["get_network_requests", { entries: 500, string: 2048 }],
  ["stop_trace", { entries: 1001, string: 8192 }],
]);

const DEFAULT_MAIN_WORLD_LIMITS: ReplyLimits = { entries: 100, string: 4096 };

const MAX_REPLY_CHARS = 4 * 1024 * 1024;

const MAX_REPLY_NODES = 50000;

const MAX_REPLY_DEPTH = 5;

const MAX_REPLY_KEYS = 64;

const MAX_REPLY_ERROR_CHARS = 1024;

/** Shared across one whole reply, so many small values cannot add up to a large one. */
interface ReplyBudget {
  nodes: number;
  chars: number;
  exhausted: boolean;
}

/** An object being copied out of a reply, which a cut inside it marks. */
type ReplyRecord = { [key: string]: JsonValue };

// Reduces a reply to plain JSON data within the limits, or undefined for a
// value that is not plain data at all (a function, a Date, a Map, a BigInt).
// `owner` is the object the value sits in, if any, which a cut string or list
// marks `truncated`.
function clampReplyValue(
  value: unknown,
  limits: ReplyLimits,
  budget: ReplyBudget,
  depth: number,
  owner: ReplyRecord | null,
): JsonValue | undefined {
  if (++budget.nodes > MAX_REPLY_NODES) {
    budget.exhausted = true;

    return undefined;
  }

  if (value === null || typeof value === "boolean") return value;

  if (typeof value === "number") return Number.isFinite(value) ? value : null;

  if (typeof value === "string") {
    let text = value;

    if (text.length > limits.string) {
      text = text.slice(0, limits.string);

      if (owner) owner.truncated = true;
    }

    if (budget.chars + text.length > MAX_REPLY_CHARS) {
      budget.exhausted = true;

      return undefined;
    }

    budget.chars += text.length;

    return text;
  }

  if (depth >= MAX_REPLY_DEPTH || typeof value !== "object") return undefined;

  if (Array.isArray(value)) {
    const items: Array<JsonValue> = [];

    // Any list may hold up to `entries` items: the capture reads are lists at
    // the top, and a trace keeps its events one level down. The shared budget
    // is what stops a list of lists adding up.
    if (value.length > limits.entries && owner) owner.truncated = true;

    for (const item of value.slice(0, limits.entries)) {
      const clamped = clampReplyValue(item, limits, budget, depth + 1, null);

      // The item the budget ran out in is incomplete, so it goes too.
      if (budget.exhausted) {
        if (owner) owner.truncated = true;

        break;
      }

      if (clamped !== undefined) items.push(clamped);
    }

    return items;
  }

  // The tag and not a prototype comparison: a Date, Map or typed array is not
  // plain data, and the page's realm is not this one.
  if (Object.prototype.toString.call(value) !== "[object Object]") return undefined;

  const copy: ReplyRecord = {};

  for (const [key, field] of Object.entries(value).slice(0, MAX_REPLY_KEYS)) {
    if (key === "__proto__" || key.length > 128) continue;

    // The page's own `truncated: false` must not undo a cut made here.
    if (key === "truncated" && copy.truncated === true) continue;

    // Lists and strings mark `copy` as truncated when they are cut, so a trace
    // that lost events says so in the field it already has.
    const clamped = clampReplyValue(field, limits, budget, depth + 1, copy);

    if (budget.exhausted) {
      // A list is cut between whole items, so the ones that fit are kept: a
      // trace too large to send whole still sends the events it can. Anything
      // else the budget ran out in is incomplete.
      if (Array.isArray(clamped)) copy[key] = clamped;
      copy.truncated = true;

      break;
    }

    if (clamped !== undefined) copy[key] = clamped;
  }

  return copy;
}

// What each request type may answer with: a list of records for the capture
// reads, an object (or nothing) for the rest. Anything else is refused rather
// than passed on, since a caller indexing into the wrong shape would throw
// somewhere less informative.
const LIST_REPLIES: ReadonlySet<PageRequestType> = new Set(["get_console_messages", "get_network_requests"]);

function validateMainWorldReply(type: PageRequestType, data: unknown): JsonValue | undefined {
  const limits = MAIN_WORLD_LIMITS.get(type) ?? DEFAULT_MAIN_WORLD_LIMITS;
  const budget: ReplyBudget = { nodes: 0, chars: 0, exhausted: false };
  const unexpected = () => new Error(`${type} interceptor returned an unexpected result`);

  if (LIST_REPLIES.has(type)) {
    if (!Array.isArray(data)) throw unexpected();

    // An entry is a record, so anything else in the list is not one.
    const records: ReadonlyArray<unknown> = data.filter(
      (entry: unknown) => entry !== null && typeof entry === "object" && !Array.isArray(entry),
    );

    return clampReplyValue(records, limits, budget, 0, null);
  }

  if (data === null || data === undefined) return data;

  const reply = clampReplyValue(data, limits, budget, 0, null);

  if (reply === undefined || reply === null || typeof reply !== "object" || Array.isArray(reply)) throw unexpected();

  return reply;
}

/**
 * Asks the MAIN-world interceptors for something and waits for their answer.
 * `Reply` is what the interceptor for `type` posts back. The reply is checked
 * here to be plain data of the right outline within the capture caps, but its
 * fields are whatever the page world sent: only it can vouch for them.
 */
export function requestMainWorld<Reply>(
  type: PageRequestType,
  params: ContentParams | DropFilesRequest = {},
  timeoutMs = 3000,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const id = nextRequestId("mcp");

    const timer = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error(`${type} interceptor did not respond`));
    }, timeoutMs);

    function onMessage(event: MessageEvent): void {
      const message: PageReply | null | undefined = event.data;

      if (event.source !== window || message?.source !== PAGE_MESSAGE_SOURCE) return;

      if (message.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);

      if (message.error) {
        // oxlint-disable-next-line typescript/no-base-to-string -- the page world posts a string; anything else is reported as its own string form
        reject(new Error(String(message.error).slice(0, MAX_REPLY_ERROR_CHARS)));

        return;
      }

      try {
        // SAFETY: plain data within the caps, as validated; see the doc comment.
        resolve(validateMainWorldReply(type, message.data) as Reply);
      } catch (err) {
        reject(err);
      }
    }

    window.addEventListener("message", onMessage);
    window.postMessage(
      {
        source: CONTENT_MESSAGE_SOURCE,
        id,
        type,
        params,
      },
      "*",
    );
  });
}

/**
 * Whether a bridge failure is requestMainWorld's own timeout, as opposed to
 * an error the page world reported. Reads the failure the way the handlers
 * always have: its message, else the value itself.
 */
export function isBridgeTimeout(cause: unknown): boolean {
  // SAFETY: bridge failures are the Errors requestMainWorld rejects with; a
  // value without `message` falls back to its own string form below.
  const failure = cause as ThrownError;

  // oxlint-disable-next-line typescript/no-base-to-string -- a rejection that is not an Error is reported as its own string form, as it always was
  return String(failure.message || failure).endsWith("interceptor did not respond");
}

// UI Events: keypress fires only for character-producing keys (Enter maps
// to \r), and never for Ctrl/Meta combos.
export function firesKeypress(key: string, opts: KeyboardEventInit): boolean {
  return (key.length === 1 || key === "Enter") && !opts.ctrlKey && !opts.metaKey;
}

// KeyboardEvent.code is physical-key based: letters are KeyX, digits Digit0-9.
export function keyCode(key: string): string {
  if (key.length !== 1) return key;

  if (key >= "0" && key <= "9") return `Digit${key}`;

  if (/[a-z]/i.test(key)) return `Key${key.toUpperCase()}`;

  return key;
}
