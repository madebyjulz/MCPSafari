import assert from "node:assert/strict";
import vm from "node:vm";
import { test } from "vitest";

import { browserStub, callThrough, contentSource, FakeEvent, type RuntimeListener } from "./helpers/content.ts";

const source = contentSource();

const ELEMENT_NODE = 1;

const TEXT_NODE = 3;

interface FakeText {
  readonly nodeType: number;
  readonly textContent: string;
}

/** Anything that answers queries about its own tree: an element, a shadow root, the document. */
interface Queryable {
  readonly children: ReadonlyArray<FakeElement>;
  querySelectorAll(selector: string): ReadonlyArray<FakeElement>;
  querySelector(selector: string): FakeElement | null;
}

interface FakeShadowRoot extends Queryable {
  readonly nodeType: number;
  readonly childNodes: ReadonlyArray<FakeNode>;
  readonly textContent: string;
  elementFromPoint(): FakeElement | null;
}

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface FakeElement extends Queryable {
  readonly nodeType: number;
  readonly tagName: string;
  readonly hidden: boolean;
  readonly id: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly childNodes: ReadonlyArray<FakeNode>;
  readonly textContent: string;
  shadowRoot: FakeShadowRoot | null;
  ownerRoot?: FakeShadowRoot;
  clicked: number;
  assignedElements?: (options?: { flatten?: boolean }) => ReadonlyArray<FakeElement>;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): Rect;
  scrollIntoView(): void;
  closest(): null;
  contains(other: FakeElement): boolean;
  focus(): void;
  dispatchEvent(): boolean;
  getRootNode(): FakeShadowRoot | FakeDocument | undefined;
}

type FakeNode = FakeText | FakeElement;

interface FakeDocument extends Queryable {
  readonly body: FakeElement;
  readonly documentElement: FakeElement;
  readonly activeElement: null;
  elementFromPoint(): FakeElement | null;
  getElementById(): null;
  createTreeWalker(
    root: Queryable,
    show: number,
    filter: { acceptNode(node: FakeElement): number },
  ): { nextNode(): FakeElement | null };
}

interface ElementOptions {
  readonly id?: string;
  readonly attributes?: Readonly<Record<string, string>>;
  readonly rect?: Rect;
  readonly slot?: boolean;
  readonly assigned?: ReadonlyArray<FakeElement>;
}

const isElement = (node: FakeNode): node is FakeElement => node.nodeType === ELEMENT_NODE;

function textNode(value: string): FakeText {
  return { nodeType: TEXT_NODE, textContent: value };
}

// Enough of a selector engine for the fixtures below: tag, #id, and .class.
function matchesSelector(node: FakeElement, selector: string): boolean {
  if (selector === "*") return true;

  if (selector.startsWith("#")) return node.id === selector.slice(1);

  if (selector.startsWith(".")) {
    return String(node.attributes.class || "")
      .split(/\s+/)
      .includes(selector.slice(1));
  }

  return node.tagName.toLowerCase() === selector.toLowerCase();
}

function descendants(root: { readonly children: ReadonlyArray<FakeElement> }): Array<FakeElement> {
  const found: Array<FakeElement> = [];

  const collect = (node: { readonly children: ReadonlyArray<FakeElement> }) => {
    for (const child of node.children) {
      found.push(child);
      collect(child);
    }
  };

  collect(root);

  return found;
}

// querySelectorAll stops at the shadow boundary in a real browser, and so does
// this: descendants() never crosses into a host's shadowRoot. That boundary is
// the whole point of the fixtures.
function queriesOver(node: { readonly children: ReadonlyArray<FakeElement> }) {
  const querySelectorAll = (selector: string) => descendants(node).filter((el) => matchesSelector(el, selector));

  return {
    querySelectorAll,
    querySelector: (selector: string) => querySelectorAll(selector)[0] || null,
  };
}

function el(tag: string, options: ElementOptions = {}, children: ReadonlyArray<FakeNode> = []): FakeElement {
  const node: FakeElement = {
    nodeType: ELEMENT_NODE,
    tagName: tag.toUpperCase(),
    hidden: false,
    id: options.id || "",
    attributes: options.attributes || {},
    childNodes: children,
    shadowRoot: null,
    clicked: 0,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? (this.attributes[name] ?? null) : null;
    },
    getBoundingClientRect: () => options.rect || { x: 0, y: 0, left: 0, top: 0, width: 10, height: 10 },
    scrollIntoView() {
      lastScrolled = node;
    },
    closest: () => null,
    contains: (other) => other === node,
    focus() {},
    dispatchEvent() {
      node.clicked += 1;

      return true;
    },
    get children(): ReadonlyArray<FakeElement> {
      return this.childNodes.filter(isElement);
    },
    get textContent(): string {
      return this.childNodes.map((c) => c.textContent ?? "").join("");
    },
    getRootNode: () => node.ownerRoot || documentRef,
    querySelectorAll: (selector) => queries.querySelectorAll(selector),
    querySelector: (selector) => queries.querySelector(selector),
  };

  const queries = queriesOver(node);

  if (options.slot) {
    node.assignedElements = ({ flatten } = {}) =>
      options.assigned && options.assigned.length ? options.assigned : flatten ? node.children : [];
  }

  return node;
}

// An open shadow root: a container that answers queries about its own tree.
function shadowRoot(children: ReadonlyArray<FakeNode>): FakeShadowRoot {
  const root: FakeShadowRoot = {
    nodeType: 11,
    childNodes: children,
    get children(): ReadonlyArray<FakeElement> {
      return this.childNodes.filter(isElement);
    },
    get textContent(): string {
      return this.childNodes.map((c) => c.textContent ?? "").join("");
    },
    elementFromPoint: () => lastScrolled,
    querySelectorAll: (selector) => queries.querySelectorAll(selector),
    querySelector: (selector) => queries.querySelector(selector),
  };

  const queries = queriesOver(root);

  return root;
}

function attachShadow(host: FakeElement, children: ReadonlyArray<FakeElement>): FakeElement {
  host.shadowRoot = shadowRoot(children);

  for (const child of children) markRoot(child, host.shadowRoot);

  return host;
}

function markRoot(node: FakeElement, root: FakeShadowRoot): void {
  node.ownerRoot = root;

  for (const child of node.children) markRoot(child, root);
}

let documentRef: FakeDocument | undefined;

// Nothing covers anything in these fixtures: a hit lands on the scrolled-to element.
let lastScrolled: FakeElement | null = null;

// The click path constructs real event objects; only the type and the options
// matter to these fixtures.
function loadContent(body: FakeElement) {
  let listener: RuntimeListener | undefined;

  // Queries on the document run against the light tree rooted at body.
  const querySelectorAll = (selector: string) =>
    descendants(body)
      .concat(matchesSelector(body, selector) ? [body] : [])
      .filter((element) => matchesSelector(element, selector));

  const document: FakeDocument = {
    body,
    documentElement: body,
    activeElement: null,
    getElementById: () => null,
    get children() {
      return body.children;
    },
    createTreeWalker(root, _show, filter) {
      const queue = descendants(root);

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
    querySelectorAll,
    querySelector: (selector) => querySelectorAll(selector)[0] || null,
    elementFromPoint: () => lastScrolled,
  };

  documentRef = document;

  vm.runInNewContext(source, {
    browser: browserStub((fn) => {
      listener = fn;
    }),
    document,
    Node: { ELEMENT_NODE, TEXT_NODE },
    NodeFilter: { SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_SKIP: 3 },
    Event: FakeEvent,
    MouseEvent: FakeEvent,
    PointerEvent: FakeEvent,
    KeyboardEvent: FakeEvent,
    WeakRef,
    setTimeout,
    clearTimeout,
    window: {
      addEventListener: () => {},
      removeEventListener: () => {},
      postMessage: () => {},
      innerWidth: 1200,
      innerHeight: 800,
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    },
  });

  return callThrough(() => listener);
}

// <my-card> hides a button behind an open shadow root, which is exactly what a
// Lit or Stencil component looks like from the outside.
function cardFixture() {
  const shadowButton = el("button", { id: "inner" }, [textNode("Submit order")]);
  const host = attachShadow(el("my-card"), [shadowButton]);
  const body = el("body", {}, [el("h1", {}, [textNode("Checkout")]), host]);

  return { body, shadowButton, host };
}

/** A snapshot node as these tests read it. */
interface TreeNode {
  readonly tag: string;
  readonly uid: string;
  readonly text?: string;
  readonly shadowClosed?: boolean;
  readonly children?: ReadonlyArray<TreeNode>;
}

function flatten(node: TreeNode | null, out: Array<TreeNode> = []): Array<TreeNode> {
  if (!node) return out;
  out.push(node);

  for (const child of node.children || []) flatten(child, out);

  return out;
}

test("snapshot descends an open shadow root", async () => {
  const { body, shadowButton } = cardFixture();
  const call = loadContent(body);

  const { data: tree } = await call("snapshot", {});
  const nodes = flatten(tree);

  const button = nodes.find((n) => n.tag === "button");
  assert.ok(button, "the shadow button is missing from the snapshot");
  assert.equal(button.text, "Submit order");
  assert.equal(shadowButton.clicked, 0);
});

test("find reaches a shadow element by selector, text, and role", async () => {
  const { body } = cardFixture();
  const call = loadContent(body);

  const { data: bySelector } = await call("find", { selector: "button" });
  assert.equal(bySelector.length, 1);
  assert.equal(bySelector[0].tag, "button");

  const { data: byText } = await call("find", { text: "Submit order" });
  assert.ok(
    byText.some((r: TreeNode) => r.tag === "button"),
    "text search missed the shadow button",
  );

  const { data: byRole } = await call("find", { role: "button" });
  assert.ok(
    byRole.some((r: TreeNode) => r.tag === "button"),
    "role search missed the shadow button",
  );
});

test("a uid minted inside a shadow root still resolves for a click", async () => {
  const { body, shadowButton } = cardFixture();
  const call = loadContent(body);

  const { data: tree } = await call("snapshot", {});
  const button = flatten(tree).find((n) => n.tag === "button");

  const response = await call("click", { uid: button?.uid });

  assert.equal(response.errorCode, undefined);
  assert.ok(shadowButton.clicked > 0, "click never reached the shadow element");
});

test("click and form_input resolve a selector across the shadow boundary", async () => {
  const { body, shadowButton } = cardFixture();
  const call = loadContent(body);

  const response = await call("click", { selector: "#inner" });

  assert.equal(response.errorCode, undefined);
  assert.ok(shadowButton.clicked > 0, "selector click never reached the shadow element");
});

test("slotted light content is reported once, not twice", async () => {
  // The host slots its light child, so the flattened tree shows the label
  // exactly where the slot puts it and nowhere else.
  const lightLabel = el("span", { id: "label" }, [textNode("Buy now")]);
  const slot = el("slot", { slot: true, assigned: [lightLabel] });
  const host = attachShadow(el("my-button", {}, [lightLabel]), [slot]);
  const body = el("body", {}, [host]);
  const call = loadContent(body);

  const { data: tree } = await call("snapshot", {});
  const spans = flatten(tree).filter((n) => n.tag === "span");

  assert.equal(spans.length, 1, "slotted content was reported twice");
  assert.equal(spans[0]?.text, "Buy now");
});

test("a closed shadow root is marked instead of reading as an empty element", async () => {
  // A custom element that occupies space while reporting no content of its
  // own is rendering something behind a closed root.
  const closed = el("x-secret", { rect: { x: 0, y: 0, left: 0, top: 0, width: 40, height: 20 } });
  const body = el("body", {}, [closed]);
  const call = loadContent(body);

  const { data: tree } = await call("snapshot", {});
  const node = flatten(tree).find((n) => n.tag === "x-secret");

  assert.ok(node, "the host itself should still be reported");
  assert.equal(node.shadowClosed, true);
});

test("an ordinary element with no shadow root is not marked closed", async () => {
  const body = el("body", {}, [el("div", {}, [textNode("plain")]), el("span")]);
  const call = loadContent(body);

  const { data: tree } = await call("snapshot", {});

  for (const node of flatten(tree)) {
    assert.equal(node.shadowClosed, undefined, `${node.tag} was wrongly marked closed`);
  }
});
