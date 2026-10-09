// Content-script behaviour that hand-written stand-ins cannot vouch for: what
// an <li>'s `value` is, which prototype setter a <select> accepts, how text
// inside a shadow root reads. The bundle runs inside a happy-dom window, which
// implements those parts of the DOM for real.

import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { test } from "vitest";

import type { ContentParams } from "../src/shared/protocol.ts";
import {
  browserStub,
  callThrough,
  contentSource,
  type CallContent,
  type ContentReply,
  type RuntimeListener,
} from "./helpers/content.ts";

const source = contentSource();

interface Page {
  readonly window: Window;
  readonly document: Window["document"];
  readonly call: CallContent;
}

/** A fresh window with `markup` as its body and the content script loaded into it. */
function loadPage(markup: string): Page {
  const window = new Window({ url: "https://example.com/app/" });
  let listener: RuntimeListener | undefined;

  // The content script reads `browser` as a global, and the window is the
  // global object of the context it runs in.
  Object.assign(window, { browser: browserStub((fn) => (listener = fn)) });
  window.document.body.innerHTML = markup;
  window.eval(source);

  return { window, document: window.document, call: callThrough(() => listener) };
}

/** A snapshot node as these tests read it. */
interface TreeNode {
  readonly tag: string;
  readonly role: string | null;
  readonly name?: string;
  readonly value?: unknown;
  readonly href?: unknown;
  readonly text?: string;
  readonly children?: ReadonlyArray<TreeNode>;
}

function flatten(node: TreeNode | null, out: Array<TreeNode> = []): Array<TreeNode> {
  if (!node) return out;
  out.push(node);

  for (const child of node.children || []) flatten(child, out);

  return out;
}

/** The <input> with `id`, failing the test if there is none. */
function inputById(page: Page, id: string) {
  const element = page.document.getElementById(id);

  assert.ok(element instanceof page.window.HTMLInputElement, `#${id} is an <input>`);

  return element;
}

async function snapshotNodes(page: Page): Promise<Array<TreeNode>> {
  const { data, error } = await page.call("snapshot", {});

  assert.equal(error, null);

  return flatten(data);
}

// ─── Snapshot values ─────────────────────────────────────────────────

test("snapshot reports a value only for controls that hold one", async () => {
  const page = loadPage(`
    <ol><li>First</li></ol>
    <progress></progress>
    <meter></meter>
    <progress id="upload" max="100" value="40"></progress>
    <input id="name" value="Jane">
    <input type="password" value="hunter2">
    <textarea>notes</textarea>
    <select><option value="us">United States</option></select>
  `);

  const nodes = await snapshotNodes(page);
  const valueOf = (tag: string, index = 0) => nodes.filter((node) => node.tag === tag)[index]?.value;

  // HTMLLIElement.value is the list ordinal and an indeterminate bar reads 0;
  // neither is anything a user typed or chose.
  assert.equal(valueOf("li"), undefined);
  assert.equal(valueOf("progress"), undefined);
  assert.equal(valueOf("meter"), undefined);
  assert.equal(valueOf("progress", 1), "40");
  assert.equal(valueOf("input"), "Jane");
  assert.equal(valueOf("input", 1), "[redacted]");
  assert.equal(valueOf("textarea"), "notes");
  assert.equal(valueOf("select"), "us");
  // select_option takes an option's value, so the snapshot keeps naming it.
  assert.equal(valueOf("option"), "us");
});

// ─── Snapshot text ───────────────────────────────────────────────────

test("a leaf's text leaves out style and script contents", async () => {
  const page = loadPage(`<x-icon></x-icon><p>Hi<script>track()</script><style>p{}</style></p>`);
  const host = page.document.querySelector("x-icon")!;
  host.attachShadow({ mode: "open" }).innerHTML = `<style>:host{color:red}</style>`;

  const nodes = await snapshotNodes(page);

  assert.equal(nodes.find((node) => node.tag === "x-icon")?.text, undefined);
  assert.equal(nodes.find((node) => node.tag === "p")?.text, "Hi");
});

// ─── Accessible names ────────────────────────────────────────────────

test("aria-labelledby resolves ids inside the element's own shadow root", async () => {
  const page = loadPage(`<x-dialog></x-dialog>`);
  const shadow = page.document.querySelector("x-dialog")!.attachShadow({ mode: "open" });
  shadow.innerHTML = `<h2 id="title">Delete file</h2><div role="dialog" aria-labelledby="title"><b>?</b></div>`;

  const nodes = await snapshotNodes(page);

  assert.equal(nodes.find((node) => node.role === "dialog")?.name, "Delete file");
});

// ─── Prototype-named lookups ─────────────────────────────────────────

test("role and direction lookups ignore names inherited from Object.prototype", async () => {
  // Tag names arrive lower-cased, so `constructor` is the one an HTML page can spell.
  const page = loadPage(`<constructor>x</constructor>`);

  const nodes = await snapshotNodes(page);

  assert.equal(nodes.find((node) => node.tag === "constructor")?.role, null);

  const scroll = await page.call("scroll", { direction: "toString" });

  assert.equal(scroll.errorCode, "invalid_input");
});

// ─── SVG links ───────────────────────────────────────────────────────

test("an SVG link reports its href as a resolved string", async () => {
  const page = loadPage(`<svg><a><text>Docs</text></a></svg>`);
  const link = page.document.querySelector("svg a")!;
  // SVGAElement.href is an SVGAnimatedString; happy-dom leaves it out.
  Object.defineProperty(link, "href", { value: { baseVal: "docs/intro", animVal: "docs/intro" } });

  const nodes = await snapshotNodes(page);

  assert.equal(nodes.find((node) => node.tag === "a")?.href, "https://example.com/app/docs/intro");
});

// ─── Locator-less file and rect actions ──────────────────────────────

test("upload_file, drop_file and element_rect without a target fail with invalid_input", async () => {
  const page = loadPage(`<input type="file">`);
  const files = [{ name: "a.txt", type: "text/plain", data: Buffer.from("a").toString("base64") }];

  const cases: ReadonlyArray<readonly [string, ContentParams]> = [
    ["upload_file", { files }],
    ["drop_file", { files }],
    ["element_rect", {}],
  ];

  for (const [action, params] of cases) {
    const response = await page.call(action, params);

    assert.equal(response.errorCode, "invalid_input", `${action}: ${response.error}`);
    assert.equal(response.recoveryAction, "fix_input");
    assert.match(response.error ?? "", /requires uid or selector/);
  }
});

// ─── Setting values ──────────────────────────────────────────────────

test("form_input sets a select through its own setter and verifies the option", async () => {
  const page = loadPage(`<select id="country"><option value="de">DE</option><option value="us">US</option></select>`);
  const select = page.document.querySelector("select")!;
  const events: Array<string> = [];
  select.addEventListener("change", () => events.push("change"));

  const filled = await page.call("form_input", { fields: { "#country": "us" } });

  assert.equal(filled.error, null);
  assert.equal(select.value, "us");
  assert.deepEqual(events, ["change"]);

  const missing = await page.call("form_input", { fields: { "#country": "fr" } });

  assert.equal(missing.errorCode, "target_not_found");
  assert.match(missing.error ?? "", /No option with value "fr"/);
  assert.equal(select.value, "us", "the previous selection is kept");
});

test("form_input checks and unchecks checkboxes and radios from the value's truthiness", async () => {
  const page = loadPage(`
    <input type="checkbox" id="terms">
    <input type="checkbox" id="news" checked>
    <input type="radio" name="plan" id="pro" value="pro">
  `);

  const changes: Array<string> = [];

  page.document.body.addEventListener("change", (event) => {
    if (event.target instanceof page.window.HTMLElement) changes.push(event.target.id);
  });

  const response = await page.call("form_input", { fields: { "#terms": "true", "#news": "false", "#pro": "on" } });

  assert.equal(response.error, null);
  const checked = (id: string) => inputById(page, id).checked;
  assert.equal(checked("terms"), true);
  assert.equal(checked("news"), false);
  assert.equal(checked("pro"), true);
  assert.equal(inputById(page, "terms").value, "on");
  assert.deepEqual(changes, ["terms", "news", "pro"]);
});

test("form_input reports each field's own outcome instead of aborting at the first failure", async () => {
  const page = loadPage(`
    <select id="size"><option value="s">S</option></select>
    <div id="card">not a field</div>
    <input id="name">
  `);

  const response = await page.call("form_input", {
    fields: { "#size": "xl", "#card": "x", "#name": "Jane", "#gone": "y" },
  });

  assert.equal(response.error, null);
  const lines: Array<string> = response.data.split("\n");
  assert.match(lines[0] ?? "", /^#size: failed \(No option with value "xl"/);
  assert.match(lines[1] ?? "", /^#card: failed \(<div> does not take a value/);
  assert.equal(lines[2], "#name: filled");
  assert.equal(lines[3], "#gone: not found");
  assert.equal(inputById(page, "name").value, "Jane");
});

test("type_text with nothing focused fails with a tool error, not a DOM exception", async () => {
  const page = loadPage(`<p>static page</p>`);

  const response = await page.call("type_text", { text: "hello" });

  assert.equal(response.errorCode, "target_not_found");
  assert.match(response.error ?? "", /<body> does not take a value/);
});

// ─── type_text submitKey ─────────────────────────────────────────────

test("type_text Enter submits only from a single-line input whose keydown went through", async () => {
  const page = loadPage(`<form><input id="q"><textarea id="notes"></textarea><input id="guarded"></form>`);
  const form = page.document.querySelector("form")!;
  let submits = 0;
  form.requestSubmit = () => void (submits += 1);
  page.document.getElementById("guarded")!.addEventListener("keydown", (event) => event.preventDefault());

  await page.call("type_text", { selector: "#notes", text: "line", submitKey: "Enter" });
  assert.equal(submits, 0, "Enter in a textarea is a newline, not a submission");

  await page.call("type_text", { selector: "#guarded", text: "x", submitKey: "Enter" });
  assert.equal(submits, 0, "the page cancelled the keydown");

  await page.call("type_text", { selector: "#q", text: "x", submitKey: "Enter" });
  assert.equal(submits, 1);
});

// ─── press_key ───────────────────────────────────────────────────────

test("press_key treats a trailing + as the key", async () => {
  const page = loadPage(``);
  const seen: Array<{ key: string; shift: boolean }> = [];

  page.document.body.addEventListener("keydown", (event) => {
    if (event instanceof page.window.KeyboardEvent) seen.push({ key: event.key, shift: event.shiftKey });
  });

  assert.equal((await page.call("press_key", { key: "+" })).error, null);
  assert.equal((await page.call("press_key", { key: "Shift++" })).error, null);
  assert.equal((await page.call("press_key", { key: "Meta+a" })).error, null);

  assert.deepEqual(seen, [
    { key: "+", shift: false },
    { key: "+", shift: true },
    { key: "a", shift: false },
  ]);
});

// ─── prepare_native_key ──────────────────────────────────────────────

test("prepare_native_key focuses the page without leaving a tabindex behind", async () => {
  const page = loadPage(``);
  const { body } = page.document;
  page.document.hasFocus = () => false;
  // The attribute has to be there while focus() runs, or <body> cannot take focus.
  const tabindexAtFocus: Array<string | null> = [];
  const focus = body.focus.bind(body);
  body.focus = () => {
    tabindexAtFocus.push(body.getAttribute("tabindex"));
    focus();
  };

  assert.equal((await page.call("prepare_native_key", {})).error, null);
  assert.equal(body.getAttribute("tabindex"), null);

  body.setAttribute("tabindex", "0");
  assert.equal((await page.call("prepare_native_key", {})).error, null);
  assert.equal(body.getAttribute("tabindex"), "0", "a page's own tabindex is put back");
  assert.deepEqual(tabindexAtFocus, ["-1", "-1"]);
});

// ─── handle_dialog ───────────────────────────────────────────────────

test("handle_dialog says when interception is armed for the next dialog", async () => {
  const page = loadPage(``);
  const { window } = page;
  // The content script compares a reply's source with its own global, which in
  // a vm context is not the sandbox object itself.
  const global: Window = window.eval("window");

  // The page world answers the way dialog-interceptor.js does when nothing
  // was captured yet: it arms the wrappers and says for how long.
  window.postMessage = (request: { readonly id: string }) => {
    const data = {
      source: "MCPSafariPage",
      id: request.id,
      data: { handled: false, armed: true, expiresInMs: 30_000, dialogsRemaining: 1 },
    };

    window.dispatchEvent(new window.MessageEvent("message", { data, source: global }));
  };

  const response = await page.call("handle_dialog", { action: "accept" });

  assert.equal(response.error, null);
  assert.match(response.data, /armed/i);
  assert.match(response.data, /accept/);
  assert.match(response.data, /30 seconds/);
  assert.doesNotMatch(response.data, /No pending dialog/);
});

// ─── wait ────────────────────────────────────────────────────────────

/** The action's reply, or a failure if it is still waiting after `ms`. */
function within(ms: number, pending: Promise<ContentReply>): Promise<ContentReply> {
  const late = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`still waiting after ${ms}ms`)), ms),
  );

  return Promise.race([pending, late]);
}

test("wait treats a zero timeout as check once, and zero seconds as no wait", async () => {
  const page = loadPage(`<p id="here">ready</p>`);

  const found = await within(1000, page.call("wait", { selector: "#here", timeout: 0 }));
  assert.equal(found.data, "Element found: #here");

  const absent = await within(1000, page.call("wait", { selector: "#later", timeout: 0 }));
  assert.equal(absent.errorCode, "wait_timeout");

  const text = await within(1000, page.call("wait", { text: "nowhere", timeout: 0 }));
  assert.equal(text.errorCode, "wait_timeout");

  const slept = await within(1000, page.call("wait", { seconds: 0 }));
  assert.equal(slept.data, "Waited 0 seconds");
});
