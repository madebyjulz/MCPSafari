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

interface StubWindow {
  alert: StubDialog;
  confirm: StubDialog;
  prompt: StubDialog;
  addEventListener(): void;
  postMessage(): void;
}

interface InstalledWindow extends StubWindow {
  __mcpHandleDialog(params?: DialogParams): DialogReadout;
}

interface Harness {
  readonly window: InstalledWindow;
  readonly native: Readonly<Record<"alert" | "confirm" | "prompt", StubDialog>>;
  readonly expire: () => void;
}

function harness(): Harness {
  const native = { alert: () => undefined, confirm: () => "native", prompt: () => "native" };
  const window: StubWindow = { ...native, addEventListener() {}, postMessage() {} };
  let expire: (() => void) | undefined;
  vm.runInNewContext(source, {
    window,
    Date,
    setTimeout: (fn: () => void) => {
      expire = fn;
    },
    clearTimeout() {},
  });

  // SAFETY: running the script installed __mcpHandleDialog on the stub window.
  return { window: window as InstalledWindow, native, expire: () => expire!() };
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
