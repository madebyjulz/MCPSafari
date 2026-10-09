/**
 * Files, measurement and waiting, plus the thin delegates to the
 * MAIN-world interceptors for dialogs, console and network.
 */

import type { ContentParams, JsonValue } from "../shared/protocol.ts";
import { isBridgeTimeout, nextRequestId, requestMainWorld, toolError, type PageElement } from "./core.ts";
import { deepQueryFirst } from "./snapshot.ts";
import { resolveElement } from "./target.ts";

/** One file as the server sends it: base64 contents plus metadata. */
export type FileSpec = {
  readonly name: string;
  readonly type: string;
  readonly data: string;
};

/** Targets an element by uid or selector only; text is not accepted here. */
export interface ElementParams extends ContentParams {
  readonly uid?: string;
  readonly selector?: string;
}

export interface FileParams extends ElementParams {
  readonly files?: ReadonlyArray<FileSpec>;
}

export interface WaitParams extends ContentParams {
  readonly timeout?: number;
  readonly seconds?: number;
  readonly selector?: string;
  readonly text?: string;
}

export interface HandleDialogParams extends ContentParams {
  readonly action?: string;
}

/** An element's rect in viewport coordinates. */
export type ElementRect = { x: number; y: number; width: number; height: number };

/** What dialog-interceptor.js answers to handle_dialog. */
type DialogReply = {
  readonly handled?: boolean;
  readonly alreadyHandled?: boolean;
  readonly type?: string;
  readonly message?: string;
  readonly armed?: boolean;
  readonly expiresInMs?: number;
};

/** What trace-interceptor.js answers to start_trace. */
type TraceStarted = {
  readonly id: string;
};

// ─── File Attachment ─────────────────────────────────────────────

function buildFiles(params: FileParams): Array<File> {
  const specs = params.files || [];

  if (specs.length === 0) throw new Error("No files provided");

  return specs.map((spec) => {
    const binary = atob(spec.data);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }

    return new File([bytes], spec.name, { type: spec.type });
  });
}

function transferFor(files: ReadonlyArray<File>): DataTransfer {
  const dataTransfer = new DataTransfer();

  for (const file of files) dataTransfer.items.add(file);

  return dataTransfer;
}

function describeFiles(files: ReadonlyArray<File>): string {
  return files.map((file) => file.name).join(", ");
}

// Accepts the input itself, a wrapper element around it, or its <label>.
function resolveFileInput(element: PageElement): PageElement {
  if (element.tagName && element.tagName.toLowerCase() === "input" && element.type === "file") {
    return element;
  }

  if (element.control && element.control.type === "file") {
    return element.control;
  }

  const nested = element.querySelector && element.querySelector<PageElement>('input[type="file"]');

  if (nested) return nested;

  throw new Error(
    `<${element.tagName ? element.tagName.toLowerCase() : "element"}> is not a file input and contains none. Target the <input type="file"> directly, or use drop_file for a drop zone.`,
  );
}

// These actions take no text or point, so a call naming neither uid nor
// selector has no target at all; say so instead of dereferencing null.
function requireTarget(action: string, params: ElementParams): PageElement {
  const target = resolveElement({ uid: params.uid, selector: params.selector });

  if (!target) throw toolError("invalid_input", `${action} requires uid or selector`, false, "fix_input");

  return target;
}

export function uploadFile(params: FileParams): string {
  const target = requireTarget("upload_file", params);
  const input = resolveFileInput(target);
  const files = buildFiles(params);

  if (files.length > 1 && !input.multiple) {
    throw new Error(`Input accepts one file but ${files.length} were provided`);
  }

  if (input.disabled) throw new Error("File input is disabled");

  input.files = transferFor(files).files;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));

  return `Attached ${describeFiles(files)} to file input`;
}

let dropQueue: Promise<string | void> = Promise.resolve();

// Drops share one target marker, so they run one at a time.
export function dropFile(params: FileParams): Promise<string> {
  const run = dropQueue.then(() => dropFileNow(params));
  dropQueue = run.catch(() => {});

  return run;
}

async function dropFileNow(params: FileParams): Promise<string> {
  const target = requireTarget("drop_file", params);
  const files = buildFiles(params);
  const dropped = `Dropped ${describeFiles(files)} on <${target.tagName.toLowerCase()}>`;

  // Page listeners only see item overrides made in their own world, so
  // file-drop.js dispatches; without it the entry API stays broken.
  const marker = nextRequestId("mcp-drop");
  target.setAttribute("data-mcp-drop-target", marker);

  try {
    await requestMainWorld("drop_files", { marker, files });

    return dropped;
  } catch (err) {
    if (!isBridgeTimeout(err)) throw err;
    dispatchDrop(target, transferFor(files));

    return `${dropped} (page bridge unavailable; entry API not patched)`;
  } finally {
    target.removeAttribute("data-mcp-drop-target");
  }
}

function dispatchDrop(target: PageElement, dataTransfer: DataTransfer): void {
  target.scrollIntoView({ behavior: "instant", block: "center" });
  const rect = target.getBoundingClientRect();

  const baseOpts = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
    dataTransfer,
  };

  for (const type of ["dragenter", "dragover", "drop"]) {
    target.dispatchEvent(new DragEvent(type, baseOpts));
  }
}

// ─── Element rect (screenshot region) ────────────────────────────

// captureVisibleTab only sees the viewport, so the target is scrolled
// into view first. Scroll handlers (collapsing headers, virtualized
// lists) run at the next rendering opportunity, so the rect is measured
// after one frame; the timeout covers a hidden page, which never paints.
export async function elementRect(params: ElementParams): Promise<ElementRect> {
  const el = requireTarget("element_rect", params);
  el.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });

  await new Promise<void>((resolve) => {
    const fallback = setTimeout(resolve, 100);
    requestAnimationFrame(() => {
      clearTimeout(fallback);
      resolve();
    });
  });

  const rect = el.getBoundingClientRect();

  if (!(rect.width > 0) || !(rect.height > 0)) {
    throw toolError(
      "target_not_found",
      `<${el.tagName.toLowerCase()}> has no rendered size, so there is nothing to capture`,
      false,
      "take_snapshot",
    );
  }

  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

// ─── Wait ────────────────────────────────────────────────────────

// Zero is a real answer for both durations: `seconds: 0` waits not at all,
// and `timeout: 0` checks once without waiting. Only an absent one is unset.
export async function waitFor(params: WaitParams): Promise<string> {
  const timeout = (params.timeout ?? 10) * 1000;
  const start = Date.now();

  if (params.seconds != null) {
    const seconds = params.seconds;
    await new Promise((r) => setTimeout(r, seconds * 1000));

    return `Waited ${seconds} seconds`;
  }

  // Checks before measuring the clock, so even a zero timeout looks once.
  const poll = async (found: () => boolean): Promise<boolean> => {
    for (;;) {
      if (found()) return true;

      if (Date.now() - start >= timeout) return false;
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  if (params.selector) {
    const selector = params.selector;

    if (await poll(() => deepQueryFirst(selector) !== null)) return `Element found: ${selector}`;

    throw toolError("wait_timeout", `Timeout waiting for selector: ${selector}`, true, "retry");
  }

  if (params.text) {
    const text = params.text;

    if (await poll(() => Boolean(document.body && document.body.innerText.includes(text)))) {
      return `Text found: "${text}"`;
    }

    throw toolError("wait_timeout", `Timeout waiting for text: "${text}"`, true, "retry");
  }

  return "Nothing to wait for";
}

// ─── Dialog Handling (delegate to interceptor) ────────────────────

export async function handleDialog(params: HandleDialogParams): Promise<string> {
  const result = await requestMainWorld<DialogReply>("handle_dialog", params);

  if (result.handled) {
    const action = params.action === "accept" ? "Accepted" : "Dismissed";
    const suffix = result.alreadyHandled ? " (dialog was already auto-handled)" : "";

    return `${action} ${result.type} dialog: "${result.message}"${suffix}`;
  }

  // Nothing was captured yet, so the interceptor armed itself for the next
  // dialog instead. Saying only "none found" would hide that the next
  // alert, confirm or prompt is now answered automatically.
  if (result.armed) {
    const action = params.action === "accept" ? "accept" : "dismiss";
    const seconds = Math.round((result.expiresInMs ?? 0) / 1000);

    return `Armed to ${action} the next dialog within ${seconds} seconds (none was pending). Trigger it, then call handle_dialog again to read the result.`;
  }

  return "No pending dialog found";
}

// --- Page Trace (delegate to interceptor) ------------------------

export async function startTrace(params: ContentParams): Promise<string> {
  // Fixed trace id across attempts: if the interceptor processes the
  // first request late, the retry overwrites the same trace instead of
  // double-starting one.
  const request = { ...params, id: nextRequestId("trace") };

  try {
    const trace = await requestMainWorld<TraceStarted>("start_trace", request);

    return trace.id;
  } catch (err) {
    // The MAIN-world interceptor can miss a request sent right after
    // navigation, before its listener is ready. Retry once so a
    // transient startup timeout does not abort the traced action.
    if (!isBridgeTimeout(err)) throw err;
    await new Promise((resolve) => setTimeout(resolve, 250));
    const trace = await requestMainWorld<TraceStarted>("start_trace", request);

    return trace.id;
  }
}

export async function stopTrace(params: ContentParams): Promise<JsonValue | undefined> {
  return await requestMainWorld<JsonValue | undefined>("stop_trace", params, 5000);
}

// ─── Console Messages (delegate to interceptor) ──────────────────

export async function getConsoleMessages(params: ContentParams): Promise<JsonValue | undefined> {
  return await requestMainWorld<JsonValue | undefined>("get_console_messages", params);
}

// ─── Network Requests (delegate to interceptor) ──────────────────

export async function getNetworkRequests(params: ContentParams): Promise<JsonValue | undefined> {
  return await requestMainWorld<JsonValue | undefined>("get_network_requests", params);
}
