import assert from "node:assert/strict";
import vm from "node:vm";
import { test } from "vitest";

import type { DialogParams, DialogResult } from "../src/page/window.ts";
import { builtScript } from "./helpers/sources.ts";

const source = builtScript("dialog-interceptor.js");

type StubDialog = (message?: string, defaultValue?: string) => DialogResult;

/** Either answer __mcpHandleDialog gives, flattened so a test can read any field. */
interface DialogReadout {
  readonly handled?: boolean;
  readonly armed?: boolean;
  readonly message?: string;
  readonly defaultValue?: string | null;
  readonly truncated?: boolean;
}

/** What the page posts back to the content script. */
interface PageReply {
  readonly id: string;
  readonly data?: DialogReadout;
  readonly error?: string;
}

interface StubMessageEvent {
  readonly source: StubWindow;
  readonly data: { readonly source: string; readonly id: string; readonly type: string; readonly params: DialogParams };
}

interface StubWindow {
  alert: StubDialog;
  confirm: StubDialog;
  prompt: StubDialog;
  addEventListener(type: string, listener: (event: StubMessageEvent) => void): void;
  postMessage(reply: PageReply): void;
}

interface InstalledWindow extends StubWindow {
  __mcpHandleDialog(params?: DialogParams): DialogReadout;
}

interface Harness {
  readonly window: InstalledWindow;
  readonly native: Readonly<Record<"alert" | "confirm" | "prompt", StubDialog>>;
  readonly expire: () => void;
  /** Posts a handle_dialog request as the content script does and returns the page's reply. */
  readonly request: (params: DialogParams) => PageReply;
}

function harness(): Harness {
  const native = { alert: () => undefined, confirm: () => "native", prompt: () => "native" };
  const replies: Array<PageReply> = [];
  let onMessage: ((event: StubMessageEvent) => void) | undefined;

  const window: StubWindow = {
    ...native,
    addEventListener(type, listener) {
      if (type === "message") onMessage = listener;
    },
    postMessage: (reply) => replies.push(reply),
  };

  let expire: (() => void) | undefined;
  vm.runInNewContext(source, {
    window,
    Date,
    setTimeout: (fn: () => void) => {
      expire = fn;
    },
    clearTimeout() {},
  });

  const request = (params: DialogParams): PageReply => {
    onMessage?.({ source: window, data: { source: "MCPSafariContent", id: "req", type: "handle_dialog", params } });
    const reply = replies.pop();

    if (reply === undefined) throw new TypeError("the page posted no reply");

    return reply;
  };

  // SAFETY: running the script installed __mcpHandleDialog on the stub window.
  return { window: window as InstalledWindow, native, expire: () => expire!(), request };
}

test("ordinary browsing keeps native dialogs and one armed dialog restores them", () => {
  const { window, native } = harness();
  assert.equal(window.confirm, native.confirm);
  assert.equal(window.confirm("normal"), "native");
  assert.equal(window.__mcpHandleDialog({ action: "accept" }).armed, true);
  assert.equal(window.confirm("automated"), true);
  assert.equal(window.confirm, native.confirm);
  const result = window.__mcpHandleDialog({ action: "dismiss" });
  assert.equal(result.handled, true);
  assert.equal(result.message, "automated");
  assert.equal(window.confirm, native.confirm, "reading a result must not arm another policy");
});

test("expiry restores native APIs without overwriting subsequent page patches", () => {
  const h = harness();
  h.window.__mcpHandleDialog({ action: "dismiss" });
  const pagePatch = () => "page";
  h.window.confirm = pagePatch;
  h.expire();
  assert.equal(h.window.confirm, pagePatch);
  assert.equal(h.window.prompt, h.native.prompt);
});

test("captured dialog text is bounded and reports truncation", () => {
  const { window } = harness();
  window.__mcpHandleDialog({ action: "accept", promptText: "answer" });
  assert.equal(window.prompt("x".repeat(100_000), "y".repeat(100_000)), "answer");
  const result = window.__mcpHandleDialog({ action: "dismiss" });
  assert.equal(result.message?.length, 4096);
  assert.equal(result.defaultValue?.length, 4096);
  assert.equal(result.truncated, true);
});

test("a handler that throws still answers the content script with an error", () => {
  const { window, request } = harness();

  window.__mcpHandleDialog = () => {
    throw new Error("replaced by the page");
  };

  assert.equal(request({ action: "accept" }).error, "replaced by the page");

  window.__mcpHandleDialog = () => {
    throw null;
  };

  const reply = request({ action: "accept" });
  assert.equal(typeof reply.error, "string");
  assert.notEqual(reply.error, "");
});
