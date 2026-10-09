import assert from "node:assert/strict";
import vm from "node:vm";
import { test } from "vitest";

import { browserStub, callThrough, contentSource, type RuntimeListener } from "./helpers/content.ts";

const source = contentSource();

const ELEMENT_NODE = 1;

const TEXT_NODE = 3;

interface FakeText {
  readonly nodeType: number;
  readonly textContent: string;
}

interface FakeElement extends FakeText {
  readonly tagName: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly hidden: boolean;
  readonly id: string;
  readonly childNodes: ReadonlyArray<FakeNode>;
  readonly children: ReadonlyArray<FakeElement>;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { x: number; y: number; width: number; height: number };
}

type FakeNode = FakeText | FakeElement;

interface ElementOptions {
  readonly attributes?: Readonly<Record<string, string>>;
  readonly id?: string;
}

const isElement = (node: FakeNode): node is FakeElement => node.nodeType === ELEMENT_NODE;

// Minimal DOM stand-ins: enough for snapshot tree building and find(), which
// only need node types, children, text, attributes, and visibility.
function text(value: string): FakeText {
  return { nodeType: TEXT_NODE, textContent: value };
}

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
    getAttribute(name: string) {
      return name in this.attributes ? (this.attributes[name] ?? null) : null;
    },
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 10, height: 10 }),
  };
}

function loadContent(body: FakeElement) {
  let runtimeListener: RuntimeListener | undefined;

  const document = {
    body,
    documentElement: body,
    getElementById: () => null,
    querySelector: () => null,
    // Shadow-root discovery asks each root for its elements so it can spot
    // hosts. These fixtures are light DOM only, so every descendant counts.
    querySelectorAll: () => {
      const all: Array<FakeElement> = [];

      const collect = (node: FakeElement) => {
        for (const child of node.children) {
          all.push(child);
          collect(child);
        }
      };

      collect(body);

      return all;
    },
    createTreeWalker(root: FakeElement, _whatToShow: number, filter: { acceptNode(node: FakeElement): number }) {
      const queue: Array<FakeElement> = [];

      const collect = (node: FakeElement) => {
        for (const child of node.children) {
          queue.push(child);
          collect(child);
        }
      };

      collect(root);

      return {
        nextNode() {
          while (queue.length) {
            const node = queue.shift()!;

            if (filter.acceptNode(node) === 1) return node;
          }

          return null;
        },
      };
    },
  };

  vm.runInNewContext(source, {
    browser: browserStub((fn) => {
      runtimeListener = fn;
    }),
    document,
    Node: { ELEMENT_NODE, TEXT_NODE },
    NodeFilter: { SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_SKIP: 3 },
    WeakRef,
    setTimeout,
    clearTimeout,
    window: {
      addEventListener: () => {},
      removeEventListener: () => {},
      postMessage: () => {},
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    },
  });

  return callThrough(() => runtimeListener);
}

test("snapshot keeps an element's own text when it also has element children", async () => {
  const call = loadContent(
    el("body", {}, [
      el("h2", {}, [text("Trash"), el("span", {}, [text(".")])]),
      el("button", {}, [el("span", {}, [text("9")]), text("All")]),
    ]),
  );

  const { data } = await call("snapshot", {});
  const [heading, button] = data.children;

  assert.equal(heading.text, "Trash");
  assert.equal(heading.children[0].text, ".");
  assert.equal(button.text, "All");
  assert.equal(button.children[0].text, "9");
});

test("snapshot still reports full text for leaf elements", async () => {
  const call = loadContent(el("body", {}, [el("p", {}, [text("only text")])]));

  const { data } = await call("snapshot", {});

  assert.equal(data.children[0].text, "only text");
});

test("find matches an accessible name that is not visible text", async () => {
  const call = loadContent(
    el("body", {}, [el("button", { attributes: { "aria-label": "Open Trash" }, id: "icon" }, [text("🗑")])]),
  );

  const { data } = await call("find", { text: "Open Trash" });

  assert.equal(data.length, 1);
  assert.equal(data[0].id, "icon");
  assert.equal(data[0].name, "Open Trash");
});

test("find still matches visible text", async () => {
  const call = loadContent(el("body", {}, [el("button", { id: "restore" }, [text("Restore")])]));

  const { data } = await call("find", { text: "restore" });

  assert.equal(data.length, 1);
  assert.equal(data[0].id, "restore");
});

test("find rejects a call with no target argument", async () => {
  const call = loadContent(el("body", {}, []));

  const response = await call("find", { query: "Restore" });

  assert.equal(response.data, null);
  assert.equal(response.errorCode, "invalid_input");
  assert.equal(response.recoveryAction, "fix_input");
  assert.match(response.error ?? "", /selector, text, or role/);
});
