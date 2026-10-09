// The content-script half of ExtensionToolErrorTests: the error codes and
// recovery hints the content script attaches to its failures.

import assert from "node:assert/strict";
import vm from "node:vm";
import { test } from "vitest";

import { browserStub, callThrough, contentSource, type CallContent, type RuntimeListener } from "./helpers/content.ts";

const source = contentSource();

/** The document most cases run against: empty, so every lookup misses. */
interface EmptyDocument {
  readonly activeElement: null;
  readonly body: { readonly innerText: string };
  createTreeWalker(): { nextNode(): null };
  elementFromPoint(): null;
  querySelector(): null;
  querySelectorAll(): ReadonlyArray<never>;
}

/** An editable target for prepare_native_input, or a plain one it must refuse. */
interface NativeTarget {
  readonly disabled: boolean;
  readonly isContentEditable: boolean;
  readonly readOnly: boolean;
  readonly tagName: string;
  contains?(element: NativeTarget | null): boolean;
  focus?(): void;
  scrollIntoView?(): void;
}

interface FocusDocument {
  activeElement: NativeTarget | null;
  querySelector?: () => NativeTarget;
}

function contentHarness(
  document: EmptyDocument | FocusDocument = {
    activeElement: null,
    body: { innerText: "" },
    createTreeWalker: () => ({ nextNode: () => null }),
    elementFromPoint: () => null,
    querySelector: () => null,
    // Shadow-root discovery asks every root for its elements.
    querySelectorAll: () => [],
  },
): CallContent {
  let listener: RuntimeListener | undefined;

  const context = vm.createContext({
    browser: browserStub((value) => {
      listener = value;
    }),
    document,
    setTimeout,
    clearTimeout,
    window: {},
  });

  vm.runInContext(source, context);

  return callThrough(() => listener);
}

test("content errors identify stale UIDs and missing targets", async () => {
  const call = contentHarness();

  const stale = await call("click", { uid: "e999" });
  assert.equal(stale.errorCode, "stale_uid");
  assert.equal(stale.retryable, false);
  assert.equal(stale.recoveryAction, "take_snapshot");

  const missing = await call("click", { selector: "#missing" });
  assert.equal(missing.errorCode, "target_not_found");
  assert.equal(missing.retryable, false);
  assert.equal(missing.recoveryAction, "take_snapshot");
});

test("wait timeouts are retryable", async () => {
  const response = await contentHarness()("wait", {
    selector: "#later",
    timeout: 0.001,
  });

  assert.equal(response.errorCode, "wait_timeout");
  assert.equal(response.retryable, true);
  assert.equal(response.recoveryAction, "retry");
});

test("native input preparation focuses only editable text targets", async () => {
  const document: FocusDocument = { activeElement: null };

  const editor: NativeTarget = {
    contains: (element) => element === editor,
    disabled: false,
    focus: () => {
      document.activeElement = editor;
    },
    isContentEditable: true,
    readOnly: false,
    scrollIntoView() {},
    tagName: "DIV",
  };

  document.querySelector = () => editor;
  const call = contentHarness(document);

  const focused = await call("prepare_native_input", { selector: "#editor" });
  assert.equal(focused.error, null);
  assert.equal(focused.data, "Focused <div> for native typing");

  document.querySelector = () => ({
    disabled: false,
    isContentEditable: false,
    readOnly: false,
    tagName: "BUTTON",
  });
  const unsupported = await call("prepare_native_input", { selector: "button" });
  assert.equal(unsupported.errorCode, "unsupported_native_target");
  assert.equal(unsupported.recoveryAction, "use_synthetic_input");
});
