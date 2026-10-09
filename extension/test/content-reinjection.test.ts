import assert from "node:assert/strict";
import vm from "node:vm";
import { test } from "vitest";

import { contentSource, type ContentMessage, type ContentReply, type RuntimeListener } from "./helpers/content.ts";

const source = contentSource();

// The background script re-injects the content script by name whenever a
// frame does not answer, and that re-runs the whole bundle in an isolated
// world where the previous run may still be live. The second pass must not
// register a second message listener, or every tool call is answered twice,
// and the state the first pass built (uids, their counter, the frame id) must
// stay the one requests are served from.
function loadInto(context: vm.Context): void {
  vm.runInContext(source, context);
}

interface FakeElement {
  readonly nodeType: number;
  readonly tagName: string;
  readonly attributes: Readonly<Record<string, string>>;
  childNodes: Array<FakeElement>;
  readonly children: ReadonlyArray<FakeElement>;
  readonly textContent: string;
  getAttribute(): null;
  getBoundingClientRect(): { x: number; y: number; left: number; top: number; width: number; height: number };
  querySelector(): null;
  querySelectorAll(): ReadonlyArray<FakeElement>;
}

function el(tag: string): FakeElement {
  return {
    nodeType: 1,
    tagName: tag,
    attributes: {},
    childNodes: [],
    get children(): ReadonlyArray<FakeElement> {
      return this.childNodes;
    },
    textContent: "",
    getAttribute: () => null,
    getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, width: 0, height: 0 }),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

function makeContext({ failFirstRegistration = false } = {}) {
  const listeners: Array<RuntimeListener> = [];
  let registrations = 0;
  const body = el("BODY");

  const windowStub = {
    addEventListener() {},
    removeEventListener() {},
    postMessage() {},
    innerWidth: 1200,
    innerHeight: 800,
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
  };

  const context = vm.createContext({
    browser: {
      runtime: {
        onMessage: {
          addListener: (fn: RuntimeListener) => {
            registrations += 1;

            // Stands in for a first load that dies partway through registering.
            if (failFirstRegistration && registrations === 1) throw new Error("extension context not ready");
            listeners.push(fn);
          },
        },
      },
    },
    console: { error() {}, log() {}, warn() {} },
    document: { body, documentElement: body, activeElement: null },
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    NodeFilter: { SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_SKIP: 3 },
    WeakRef,
    setTimeout,
    clearTimeout,
    window: windowStub,
  });

  // The bundle reads `window` for its marker, so the stub has to be the
  // same object the context hands it.
  vm.runInContext("window.self = window", context);

  const snapshot = (message: ContentMessage = { action: "snapshot", params: {} }) =>
    new Promise<ContentReply>((resolve) => {
      assert.equal(listeners.length, 1, "exactly one listener answers");
      listeners[0]!(message, {}, resolve);
    });

  return { context, listeners, body, snapshot };
}

test("re-injecting the content script does not throw or answer twice", () => {
  const { context, listeners } = makeContext();

  loadInto(context);
  assert.equal(listeners.length, 1, "the first load registers the message listener");

  // Exactly what the background does when a tab has lost its content script:
  // the same file, by name, into a frame that may still have it.
  loadInto(context);
  loadInto(context);

  assert.equal(listeners.length, 1, "a re-injection must not add another listener");
  assert.equal(vm.runInContext("window.__mcpSafari", context), true, "the marker stays set");
});

test("a re-injection keeps serving the first load's uids, counter, and frame id", async () => {
  const { context, body, snapshot } = makeContext();

  loadInto(context);
  const first = await snapshot({ action: "snapshot", params: {}, frameId: 2 });
  assert.equal(first.data.uid, "f2e1");

  loadInto(context);

  // The same element keeps the uid the agent already holds.
  const again = await snapshot();
  assert.equal(again.data.uid, "f2e1", "the uid map survived the re-injection");

  // A new element continues the first load's counter and frame id rather than
  // starting a fresh "f0e1" that would collide with the body's.
  body.childNodes.push(el("BUTTON"));
  const grown = await snapshot();
  assert.equal(grown.data.uid, "f2e1");
  assert.equal(grown.data.children[0].uid, "f2e2");
});

test("a first load that fails to register leaves the frame recoverable", () => {
  const { context, listeners } = makeContext({ failFirstRegistration: true });

  assert.throws(() => loadInto(context), /extension context not ready/);
  assert.equal(listeners.length, 0);
  assert.equal(vm.runInContext("window.__mcpSafari", context), undefined, "no marker without a listener");

  // The next re-injection is a clean attempt, not a frame that claims to be
  // loaded and never answers.
  loadInto(context);
  assert.equal(listeners.length, 1);
});
