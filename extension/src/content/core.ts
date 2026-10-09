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

let bridgeRequestCounter = 0;

export function nextRequestId(prefix: string): string {
  return `${prefix}-${Date.now()}-${++bridgeRequestCounter}`;
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

/** A reply the page world posts back. */
interface PageReply<Data> {
  readonly source?: string;
  readonly id?: string;
  readonly error?: string;
  readonly data: Data;
}

/**
 * Asks the MAIN-world interceptors for something and waits for their answer.
 * `Reply` is what the interceptor for `type` posts back; the page world is
 * the only party that can vouch for it.
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
      const message: PageReply<Reply> | null | undefined = event.data;

      if (event.source !== window || message?.source !== PAGE_MESSAGE_SOURCE) return;

      if (message.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);

      if (message.error) {
        reject(new Error(message.error));
      } else {
        resolve(message.data);
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
