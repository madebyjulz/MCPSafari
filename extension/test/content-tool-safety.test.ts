import assert from "node:assert/strict";
import vm from "node:vm";
import { test } from "vitest";

import type { ContentParams } from "../src/shared/protocol.ts";
import {
  browserStub,
  callThrough,
  contentSource,
  FakeEvent,
  type CallContent,
  type RuntimeListener,
} from "./helpers/content.ts";

const source = contentSource();

const ELEMENT_NODE = 1;

const TEXT_NODE = 3;

interface FakeText {
  readonly nodeType: number;
  readonly textContent: string;
}

interface SelectOption {
  readonly value: string;
  readonly textContent: string;
}

interface FakeElement {
  readonly nodeType: number;
  readonly tagName: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly hidden: boolean;
  readonly id: string;
  readonly childNodes: ReadonlyArray<FakeNode>;
  readonly children: ReadonlyArray<FakeElement>;
  textContent: string;
  type?: string;
  value?: string;
  options?: ReadonlyArray<SelectOption>;
  isContentEditable?: boolean;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { x: number; y: number; width: number; height: number };
  scrollIntoView(): void;
  focus(): void;
  contains?(): boolean;
  dispatchEvent(event: FakeEvent): boolean;
}

type FakeNode = FakeText | FakeElement;

interface ElementOptions {
  readonly attributes?: Readonly<Record<string, string>>;
  readonly id?: string;
  readonly extra?: Partial<FakeElement>;
}

const isElement = (node: FakeNode): node is FakeElement => node.nodeType === ELEMENT_NODE;

// Minimal DOM stand-ins: enough for snapshot, find, and the interaction
// handlers, which need node types, children, text, attributes, and visibility.
function el(tag: string, options: ElementOptions = {}, children: ReadonlyArray<FakeNode> = []): FakeElement {
  return {
    nodeType: ELEMENT_NODE,
    tagName: tag.toUpperCase(),
    attributes: options.attributes || {},
    hidden: false,
    id: options.id || "",
    childNodes: children,
    get children(): ReadonlyArray<FakeElement> {
      return this.childNodes.filter(isElement);
    },
    get textContent(): string {
      return this.childNodes.map((c) => c.textContent).join("");
    },
    getAttribute(name) {
      return name in this.attributes ? (this.attributes[name] ?? null) : null;
    },
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 10, height: 10 }),
    scrollIntoView() {},
    focus() {},
    dispatchEvent() {
      return true;
    },
    ...options.extra,
  };
}

interface FakeDocument {
  readonly body: FakeElement;
  readonly documentElement: FakeElement;
  readonly activeElement: FakeElement | null;
  getElementById(id: string): { textContent: string } | null;
  querySelector(selector: string): FakeElement | null;
  querySelectorAll(): ReadonlyArray<FakeElement>;
  execCommand(command: string, ui: boolean, value?: string): boolean;
  createRange(): { selectNodeContents(): void; collapse(): void };
  createTreeWalker(
    root: FakeElement,
    show: number,
    filter: { acceptNode(node: FakeElement): number },
  ): { nextNode(): FakeElement | null };
}

interface SafetyCall extends CallContent {
  scrolls: Array<ScrollToOptions>;
}

function loadContent(body: FakeElement, documentOverrides: Partial<FakeDocument> = {}): SafetyCall {
  let listener: RuntimeListener | undefined;

  const document: FakeDocument = {
    body,
    documentElement: body,
    activeElement: null,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    execCommand: () => false,
    createRange: () => ({ selectNodeContents() {}, collapse() {} }),
    createTreeWalker(root, _show, filter) {
      const queue: Array<FakeElement> = [];

      const collect = (n: FakeElement) => {
        for (const c of n.children) {
          queue.push(c);
          collect(c);
        }
      };

      collect(root);

      return {
        nextNode() {
          while (queue.length) {
            const n = queue.shift()!;

            if (filter.acceptNode(n) === 1) return n;
          }

          return null;
        },
      };
    },
    ...documentOverrides,
  };

  const scrolls: Array<ScrollToOptions> = [];

  vm.runInNewContext(source, {
    browser: browserStub((fn) => {
      listener = fn;
    }),
    document,
    Node: { ELEMENT_NODE, TEXT_NODE },
    NodeFilter: { SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_SKIP: 3 },
    WeakRef,
    setTimeout,
    clearTimeout,
    Event: FakeEvent,
    KeyboardEvent: FakeEvent,
    MouseEvent: FakeEvent,
    InputEvent: FakeEvent,
    // No native `value` descriptor, so setInputValue takes its direct-assign path.
    HTMLInputElement: class {},
    HTMLTextAreaElement: class {},
    window: {
      addEventListener: () => {},
      removeEventListener: () => {},
      postMessage: () => {},
      innerHeight: 800,
      scrollBy: (options: ScrollToOptions) => scrolls.push(options),
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      getSelection: () => ({
        rangeCount: 0,
        removeAllRanges() {},
        addRange() {},
        getRangeAt() {
          return null;
        },
      }),
    },
  });

  return Object.assign(
    callThrough(() => listener),
    { scrolls },
  );
}

// ─── Snapshot redaction ──────────────────────────────────────────────

test("snapshot redacts password field values but keeps ordinary ones", async () => {
  const password = el("input", { id: "pw", extra: { type: "password", value: "hunter2" } });
  const email = el("input", { id: "email", extra: { type: "email", value: "a@b.com" } });
  const call = loadContent(el("body", {}, [password, email]));

  const { data } = await call("snapshot", {});

  assert.equal(data.children[0].value, "[redacted]");
  assert.equal(data.children[1].value, "a@b.com");
});

test("snapshot redacts inputs marked sensitive by autocomplete", async () => {
  const otp = el("input", {
    attributes: { autocomplete: "one-time-code" },
    extra: { type: "text", value: "123456" },
  });

  const card = el("input", {
    attributes: { autocomplete: "section-payment cc-number" },
    extra: { type: "text", value: "4111111111111111" },
  });

  const name = el("input", {
    attributes: { autocomplete: "name" },
    extra: { type: "text", value: "Jane" },
  });

  const call = loadContent(el("body", {}, [otp, card, name]));

  const { data } = await call("snapshot", {});

  assert.equal(data.children[0].value, "[redacted]");
  assert.equal(data.children[1].value, "[redacted]");
  assert.equal(data.children[2].value, "Jane");
});

// ─── Accessible name resolution ──────────────────────────────────────

test("accessible name escapes ids that would build a malformed selector", async () => {
  const selectors: Array<string> = [];
  const target = el("div", { id: 'a"b' });

  const call = loadContent(el("body", {}, [target]), {
    querySelector: (selector) => {
      // A real DOM throws on an unescaped quote; fail loudly the same way.
      if (/[^\\]"[^\]]/.test(selector.slice('label[for="'.length))) {
        throw new Error(`invalid selector: ${selector}`);
      }

      selectors.push(selector);

      return null;
    },
  });

  const { data, error } = await call("snapshot", {});

  assert.equal(error, null);
  assert.equal(data.children.length, 1);
  assert.ok(selectors.length > 0, "the escaped selector was still queried");
});

test("aria-labelledby joins every referenced id", async () => {
  const call = loadContent(el("body", {}, [el("div", { attributes: { "aria-labelledby": "t1 t2" } })]), {
    getElementById: (id) => ({ textContent: id === "t1" ? "Delete" : "forever" }),
  });

  const { data } = await call("snapshot", {});

  assert.equal(data.children[0].name, "Delete forever");
});

// ─── find caps ───────────────────────────────────────────────────────

test("find by selector is capped like the other match strategies", async () => {
  const many = Array.from({ length: 500 }, (_, i) => el("div", { id: `d${i}` }));
  const call = loadContent(el("body", {}, many), { querySelectorAll: () => many });

  const { data } = await call("find", { selector: "div" });

  assert.equal(data.length, 50);
});

// ─── select_option ───────────────────────────────────────────────────

function selectHarness(optionValues: ReadonlyArray<string>) {
  const options = optionValues.map((value) => ({ value, textContent: value.toUpperCase() }));
  let stored = optionValues[0];
  const select = el("select", { id: "s" });
  select.options = options;
  // Mirrors the real setter: an unmatched value clears the selection.
  Object.defineProperty(select, "value", {
    get: () => stored,
    set: (v: string) => {
      stored = options.some((o) => o.value === v) ? v : "";
    },
  });

  return {
    select,
    current: () => stored,
    call: loadContent(el("body", {}, [select]), { querySelector: () => select }),
  };
}

test("select_option fails instead of silently selecting nothing", async () => {
  const { call, current } = selectHarness(["a", "b"]);

  const response = await call("select_option", { selector: "#s", value: "nope" });

  assert.equal(response.errorCode, "target_not_found");
  assert.match(response.error ?? "", /No option with value "nope"/);
  assert.equal(current(), "a", "the previous selection is restored");
});

test("select_option still selects a real value and label", async () => {
  const byValue = selectHarness(["a", "b"]);
  const valueResponse = await byValue.call("select_option", { selector: "#s", value: "b" });
  assert.equal(valueResponse.error, null);
  assert.equal(byValue.current(), "b");

  const byLabel = selectHarness(["a", "b"]);
  const labelResponse = await byLabel.call("select_option", { selector: "#s", label: "B" });
  assert.equal(labelResponse.error, null);
  assert.equal(byLabel.current(), "b");
});

test("select_option requires a value or label", async () => {
  const { call } = selectHarness(["a"]);

  const response = await call("select_option", { selector: "#s" });

  assert.equal(response.errorCode, "invalid_input");
  assert.equal(response.recoveryAction, "fix_input");
});

// ─── form_input ──────────────────────────────────────────────────────

test("form_input fails when no field matched, but reports a partial fill", async () => {
  const field = el("input", { id: "a", extra: { value: "" } });
  const allMissing = loadContent(el("body", {}, []), { querySelector: () => null });

  const failed = await allMissing("form_input", { fields: { "#a": "1", "#b": "2" } });
  assert.equal(failed.errorCode, "target_not_found");
  assert.match(failed.error ?? "", /#a, #b/);

  const partial = loadContent(el("body", {}, [field]), {
    querySelector: (selector) => (selector === "#a" ? field : null),
  });

  const mixed = await partial("form_input", { fields: { "#a": "1", "#b": "2" } });
  assert.equal(mixed.error, null);
  assert.match(mixed.data, /#a: filled/);
  assert.match(mixed.data, /#b: not found/);
});

test("form_input requires at least one field", async () => {
  const response = await loadContent(el("body", {}, []))("form_input", { fields: {} });

  assert.equal(response.errorCode, "invalid_input");
  assert.equal(response.recoveryAction, "fix_input");
});

// ─── Required arguments ──────────────────────────────────────────────

test("missing required arguments return invalid_input, not a raw TypeError", async () => {
  const call = loadContent(el("body", {}, []));

  const cases: ReadonlyArray<readonly [string, ContentParams]> = [
    ["press_key", {}],
    ["click", {}],
    ["hover", {}],
    ["scroll", {}],
    ["drag", {}],
  ];

  for (const [action, params] of cases) {
    const response = await call(action, params);
    assert.equal(response.errorCode, "invalid_input", `${action} should reject cleanly`);
    assert.equal(response.recoveryAction, "fix_input", `${action} should say how to recover`);
    assert.equal(response.data, null);
  }
});

test("press_key reports physical key codes for digits and letters", async () => {
  const events: Array<FakeEvent> = [];

  const body = el("body", {
    extra: {
      dispatchEvent: (event) => {
        events.push(event);

        return true;
      },
    },
  });

  const call = loadContent(body, { activeElement: null, body });

  await call("press_key", { key: "1" });
  await call("press_key", { key: "a" });
  await call("press_key", { key: "Enter" });

  assert.equal(events[0]?.code, "Digit1");
  assert.equal(events[3]?.code, "KeyA");
  assert.equal(events[6]?.code, "Enter");
});

// ─── type_text ───────────────────────────────────────────────────────

interface EditableOptions {
  readonly execCommand?: (target: FakeElement, command: string, value?: string) => boolean;
}

function editableHarness({ execCommand }: EditableOptions = {}) {
  const events: Array<FakeEvent> = [];

  const target = el("div", {
    id: "ce",
    extra: {
      isContentEditable: true,
      textContent: "",
      contains: () => false,
      dispatchEvent(event) {
        events.push(event);

        return true;
      },
    },
  });

  const commands: Array<{ command: string; value: string | undefined }> = [];

  const call = loadContent(el("body", {}, [target]), {
    querySelector: () => target,
    execCommand: (command, _ui, value) => {
      commands.push({ command, value });

      return execCommand ? execCommand(target, command, value) : false;
    },
  });

  return { target, events, commands, call };
}

test("type_text drives contenteditable through execCommand insertText", async () => {
  const { target, commands, call } = editableHarness({
    execCommand: (el2, command, value) => {
      if (command === "insertText") el2.textContent += value;

      return true;
    },
  });

  const response = await call("type_text", { selector: "#ce", text: "hello" });

  assert.equal(response.error, null);
  assert.deepEqual(commands, [{ command: "insertText", value: "hello" }]);
  assert.equal(target.textContent, "hello");
});

test("type_text falls back to beforeinput/input carrying inputType and data", async () => {
  const { target, events, call } = editableHarness();

  const response = await call("type_text", { selector: "#ce", text: "abc" });

  assert.equal(response.error, null);
  assert.equal(target.textContent, "abc");
  const [beforeInput, input] = events;
  assert.equal(beforeInput?.type, "beforeinput");
  assert.equal(beforeInput?.inputType, "insertText");
  assert.equal(beforeInput?.data, "abc");
  assert.equal(beforeInput?.cancelable, true);
  assert.equal(input?.type, "input");
  assert.equal(input?.inputType, "insertText");
  assert.equal(input?.data, "abc");
});

test("type_text fails when the editor discards the input", async () => {
  // execCommand claims success but the content never changes — the
  // model-backed-editor case that used to report a false success.
  const { call } = editableHarness({ execCommand: () => true });

  const response = await call("type_text", { selector: "#ce", text: "hello" });

  assert.equal(response.errorCode, "input_not_applied");
  assert.equal(response.recoveryAction, "use_native_input");
});

test("type_text accepts clearFirst retyping the identical value", async () => {
  const field = el("input", { id: "a", extra: { type: "text", value: "abc" } });
  const call = loadContent(el("body", {}, [field]), { querySelector: () => field });

  const response = await call("type_text", { selector: "#a", text: "abc", clearFirst: true });

  assert.equal(response.error, null);
  assert.equal(field.value, "abc");
});

test("scroll treats amount 0 as an explicit no-op distance", async () => {
  const call = loadContent(el("body", {}, []));

  const response = await call("scroll", { direction: "down", amount: 0 });

  assert.equal(response.error, null);
  assert.match(response.data, /Scrolled down by 0px/);
  assert.equal(call.scrolls[0]?.top, 0);
  assert.equal(call.scrolls[0]?.left, 0);
});
