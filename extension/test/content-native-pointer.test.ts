import assert from "node:assert/strict";
import vm from "node:vm";
import { test } from "vitest";

import { browserStub, callThrough, contentSource, type CallContent, type RuntimeListener } from "./helpers/content.ts";

const source = contentSource();

const ELEMENT_NODE = 1;

interface WindowGeometry {
  readonly screenX: number;
  readonly screenY: number;
  readonly outerWidth: number;
  readonly innerWidth: number;
  readonly outerHeight: number;
  readonly innerHeight: number;
}

// Geometry: window at screen (100, 125), 100 px of top chrome, no side
// borders. Element rect center (60, 65) must land at screen (160, 290).
const WINDOW: WindowGeometry = {
  screenX: 100,
  screenY: 125,
  outerWidth: 1000,
  innerWidth: 1000,
  outerHeight: 900,
  innerHeight: 800,
};

interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly x?: number;
  readonly y?: number;
}

interface FakeElement {
  readonly nodeType: number;
  readonly tagName: string;
  readonly hidden: boolean;
  scrollIntoView(): void;
  getBoundingClientRect(): Rect;
}

function el(rect: Rect): FakeElement {
  return {
    nodeType: ELEMENT_NODE,
    tagName: "DIV",
    hidden: false,
    scrollIntoView() {},
    getBoundingClientRect: () => rect,
  };
}

interface LoadOptions {
  readonly target?: FakeElement;
  readonly toTarget?: FakeElement;
  readonly window?: Partial<WindowGeometry>;
}

function loadContent({ target, toTarget, window: windowValues }: LoadOptions = {}): CallContent {
  let listener: RuntimeListener | undefined;

  vm.runInNewContext(source, {
    browser: browserStub((fn) => {
      listener = fn;
    }),
    document: {
      body: null,
      documentElement: null,
      activeElement: null,
      querySelector: (selector: string) => {
        if (selector === "#to") return toTarget || null;

        return target || null;
      },
    },
    Node: { ELEMENT_NODE, TEXT_NODE: 3 },
    NodeFilter: { SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_SKIP: 3 },
    WeakRef,
    setTimeout,
    clearTimeout,
    window: {
      addEventListener: () => {},
      removeEventListener: () => {},
      ...WINDOW,
      ...windowValues,
    },
  });

  return callThrough(() => listener);
}

test("native_pointer_points converts an element center to screen points", async () => {
  const target = el({ left: 50, top: 60, width: 20, height: 10 });
  const call = loadContent({ target });

  const { data, error } = await call("native_pointer_points", { selector: "#target" });

  assert.equal(error, null);
  assert.deepEqual(JSON.parse(JSON.stringify(data)), { from: { x: 160, y: 290 } });
});

test("native_pointer_points passes x/y through the same conversion", async () => {
  const call = loadContent();

  const { data } = await call("native_pointer_points", { x: 10, y: 20 });

  assert.deepEqual(JSON.parse(JSON.stringify(data)), { from: { x: 110, y: 245 } });
});

test("native_pointer_points resolves drag endpoints", async () => {
  const target = el({ left: 0, top: 0, width: 10, height: 10 });
  const toTarget = el({ left: 200, top: 300, width: 40, height: 20 });
  const call = loadContent({ target, toTarget });

  const { data } = await call("native_pointer_points", {
    fromSelector: "#from",
    toSelector: "#to",
  });

  assert.deepEqual(JSON.parse(JSON.stringify(data)), { from: { x: 105, y: 230 }, to: { x: 320, y: 535 } });
});

test("native_pointer_points rejects calls without a target", async () => {
  const call = loadContent();

  const response = await call("native_pointer_points", {});

  assert.equal(response.data, null);
  assert.equal(response.errorCode, "invalid_input");
});

test("native_pointer_points measures both drag endpoints after all scrolling", async () => {
  // A distant drag target scrolls the source off-screen; the source point
  // must be measured after all scrolling (and here fails the bounds check
  // rather than dragging whatever sits at the stale point).
  let scrollOffset = 0;

  const scrollingEl = (baseTop: number): FakeElement => ({
    nodeType: ELEMENT_NODE,
    tagName: "DIV",
    hidden: false,
    scrollIntoView() {
      scrollOffset = baseTop;
    },
    getBoundingClientRect: () => ({
      left: 0,
      top: baseTop - scrollOffset,
      width: 10,
      height: 10,
    }),
  });

  const target = scrollingEl(100);
  const toTarget = scrollingEl(2000);
  const call = loadContent({ target, toTarget });

  const response = await call("native_pointer_points", {
    fromSelector: "#from",
    toSelector: "#to",
  });

  assert.equal(response.data, null);
  assert.equal(response.errorCode, "invalid_input");
  assert.equal(scrollOffset, 2000);
});

test("native_pointer_points puts the full side-chrome width on the left", async () => {
  // Safari's sidebar shrinks innerWidth from the left only.
  const target = el({ left: 50, top: 60, width: 20, height: 10 });

  const call = loadContent({
    target,
    window: { outerWidth: 1320, innerWidth: 1000 },
  });

  const { data } = await call("native_pointer_points", { selector: "#target" });

  assert.deepEqual(JSON.parse(JSON.stringify(data)), {
    from: { x: 100 + 320 + 60, y: 290 },
  });
});

test("native_pointer_points rejects points outside the viewport", async () => {
  const call = loadContent();

  const response = await call("native_pointer_points", { x: 5000, y: -50 });

  assert.equal(response.data, null);
  assert.equal(response.errorCode, "invalid_input");
});

test("x/y overrides a resolvable selector, matching the synthetic path", async () => {
  // The schema states x/y takes precedence over uid/selector/text. Synthetic
  // hover honours that; the native path must land on the same point rather
  // than the element's centre.
  const target = el({ left: 10, top: 10, x: 10, y: 10, width: 100, height: 100 });
  const call = loadContent({ target });

  const { data } = await call("native_pointer_points", { selector: "#target", x: 400, y: 300 });

  assert.deepEqual(JSON.parse(JSON.stringify(data)), {
    from: { x: 100 + 400, y: 125 + 100 + 300 },
  });
});
