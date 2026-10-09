// The content-script half of the screenshot-region tests: element_rect, which
// the background asks for before capturing a uid- or selector-targeted region.

import assert from "node:assert/strict";
import vm from "node:vm";
import { test } from "vitest";

import { browserStub, callThrough, contentSource, type CallContent, type RuntimeListener } from "./helpers/content.ts";

const content = contentSource();

interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface RectCall extends CallContent {
  scrolls: Array<ScrollIntoViewOptions>;
}

// Content harness: one element, resolvable by selector, with a controllable rect.
// `settled`, when given, is the rect a scroll handler produces after the
// scroll; the frame callback stands in for that handler having run.
function loadContent(rect: Rect, settled?: Rect | null, { paints = true } = {}): RectCall {
  let listener: RuntimeListener | undefined;
  const scrolls: Array<ScrollIntoViewOptions> = [];
  let current = rect;

  const element = {
    nodeType: 1,
    tagName: "DIV",
    getAttribute: () => null,
    getBoundingClientRect: () => current,
    scrollIntoView: (options: ScrollIntoViewOptions) => scrolls.push(options),
  };

  vm.runInNewContext(content, {
    browser: browserStub((fn) => {
      listener = fn;
    }),
    document: {
      body: element,
      querySelector: (selector: string) => (selector === "#row" ? element : null),
      querySelectorAll: () => [],
    },
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    WeakRef,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (callback: () => void) => {
      if (!paints) return 0;

      return setTimeout(() => {
        if (settled) current = settled;
        callback();
      }, 0);
    },
    window: { addEventListener() {}, removeEventListener() {}, postMessage() {} },
  });

  return Object.assign(
    callThrough(() => listener),
    { scrolls },
  );
}

test("element_rect scrolls the target into view and returns its rect", async () => {
  const call = loadContent({ left: 12.5, top: 300, width: 200, height: 40 });

  const { data, error } = await call("element_rect", { selector: "#row" });

  assert.equal(error, null);
  // Plain-object copies: the VM realm's objects carry a different prototype.
  assert.deepEqual({ ...data }, { x: 12.5, y: 300, width: 200, height: 40 });
  assert.deepEqual(
    call.scrolls.map((s) => ({ ...s })),
    [{ behavior: "instant", block: "center", inline: "center" }],
  );
});

test("element_rect measures after the frame in which scroll handlers run", async () => {
  const call = loadContent(
    { left: 0, top: 300, width: 200, height: 40 },
    { left: 0, top: 240, width: 200, height: 40 },
  );

  const { data } = await call("element_rect", { selector: "#row" });

  // A collapsing header moved the target 60px up after the scroll.
  assert.equal(data.y, 240);
});

test("element_rect still returns when the page never paints", async () => {
  // A hidden page runs no animation frames; only the timeout fallback fires.
  const call = loadContent({ left: 0, top: 0, width: 5, height: 5 }, null, { paints: false });
  const started = Date.now();
  const { data } = await call("element_rect", { selector: "#row" });
  assert.equal(data.width, 5);
  assert.ok(Date.now() - started < 1000);
});

test("element_rect refuses an element with no rendered size", async () => {
  const call = loadContent({ left: 0, top: 0, width: 0, height: 0 });

  const { data, error, errorCode } = await call("element_rect", { selector: "#row" });

  assert.equal(data, null);
  assert.match(error ?? "", /no rendered size/);
  assert.equal(errorCode, "target_not_found");
});

test("element_rect reports a missing target", async () => {
  const call = loadContent({ left: 0, top: 0, width: 5, height: 5 });

  const { errorCode } = await call("element_rect", { selector: "#missing" });

  assert.equal(errorCode, "target_not_found");
});
