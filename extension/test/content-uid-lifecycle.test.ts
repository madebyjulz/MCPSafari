import assert from "node:assert/strict";
import vm from "node:vm";
import { test } from "vitest";

import { browserStub, callThrough, contentSource, type RuntimeListener } from "./helpers/content.ts";

const source = contentSource();

const ELEMENT_NODE = 1;

interface FakeElement {
  readonly nodeType: number;
  readonly tagName: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly hidden: boolean;
  readonly id: string;
  childNodes: ReadonlyArray<FakeElement>;
  readonly children: ReadonlyArray<FakeElement>;
  readonly textContent: string;
  getAttribute(): null;
  getBoundingClientRect(): { x: number; y: number; width: number; height: number };
  scrollIntoView(): void;
  focus(): void;
  dispatchEvent(): boolean;
}

function el(tag: string, id?: string): FakeElement {
  return {
    nodeType: ELEMENT_NODE,
    tagName: tag.toUpperCase(),
    attributes: {},
    hidden: false,
    id: id || "",
    childNodes: [],
    textContent: "",
    getAttribute: () => null,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 10, height: 10 }),
    scrollIntoView() {},
    focus() {},
    dispatchEvent() {
      return true;
    },
    get children(): ReadonlyArray<FakeElement> {
      return this.childNodes.filter((c) => c.nodeType === ELEMENT_NODE);
    },
  };
}

/** One FinalizationRegistry.register call: the element and its uid. */
interface Registration {
  readonly target: FakeElement;
  readonly token: string;
}

// Drives collection by hand: nothing here is left to a real GC.
function loadContent(body: FakeElement) {
  let listener: RuntimeListener | undefined;
  const registrations: Array<Registration> = [];
  let finalizerCallback: ((token: string) => void) | undefined;
  const collected = new Set<FakeElement>();

  class ControlledWeakRef {
    readonly target: FakeElement;

    constructor(target: FakeElement) {
      this.target = target;
    }

    deref() {
      return collected.has(this.target) ? undefined : this.target;
    }
  }

  class ControlledFinalizationRegistry {
    constructor(callback: (token: string) => void) {
      finalizerCallback = callback;
    }

    register(target: FakeElement, token: string) {
      registrations.push({ target, token });
    }
  }

  vm.runInNewContext(source, {
    browser: browserStub((fn) => {
      listener = fn;
    }),
    document: {
      body,
      documentElement: body,
      activeElement: null,
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createTreeWalker(root: FakeElement, _show: number, filter: { acceptNode(node: FakeElement): number }) {
        const queue = [...root.childNodes];

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
    },
    Node: { ELEMENT_NODE, TEXT_NODE: 3 },
    NodeFilter: { SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_SKIP: 3 },
    WeakRef: ControlledWeakRef,
    FinalizationRegistry: ControlledFinalizationRegistry,
    setTimeout,
    clearTimeout,
    window: {
      addEventListener: () => {},
      removeEventListener: () => {},
      postMessage: () => {},
      innerHeight: 800,
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    },
  });

  return {
    call: callThrough(() => listener),
    registrations,
    collect: (node: FakeElement) => collected.add(node),
    runFinalizer: (token: string) => finalizerCallback?.(token),
  };
}

const uidFor = (registrations: ReadonlyArray<Registration>, node: FakeElement) =>
  registrations.find((r) => r.target === node)?.token;

test("every minted uid is registered for cleanup", async () => {
  const first = el("button");
  const second = el("button");
  const body = el("body");
  body.childNodes = [first, second];
  const { call, registrations } = loadContent(body);

  await call("snapshot", {});

  // Registered against the element, so the token is dropped when it goes.
  assert.equal(registrations.length, 3, "body and both buttons");

  for (const node of [body, first, second]) {
    // Frame-qualified: the prefix names the frame that minted the uid.
    assert.match(uidFor(registrations, node) ?? "", /^f\d+e\d+$/);
  }
});

test("a uid whose element was collected stops resolving", async () => {
  const button = el("button");
  const body = el("body");
  body.childNodes = [button];
  const { call, registrations, collect, runFinalizer } = loadContent(body);

  await call("snapshot", {});
  const uid = uidFor(registrations, button);

  collect(button);
  runFinalizer(uid ?? "");

  const response = await call("click", { uid });
  assert.equal(response.errorCode, "stale_uid");
});

test("a collected element is swept on read even before the finalizer runs", async () => {
  // Finalization is not prompt, so the read path cannot assume it has happened.
  const button = el("button");
  const body = el("body");
  body.childNodes = [button];
  const { call, registrations, collect } = loadContent(body);

  await call("snapshot", {});
  const uid = uidFor(registrations, button);

  collect(button);

  const response = await call("click", { uid });
  assert.equal(response.errorCode, "stale_uid");
});
