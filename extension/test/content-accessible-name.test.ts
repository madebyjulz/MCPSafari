// How a snapshot names links, buttons, headings and the other roles that take
// their name from their content, and how click and hover by text find them.
// The bundle runs in a happy-dom window, so inline and block layout, hidden
// content, shadow roots and slots behave as a browser's do.

import assert from "node:assert/strict";
import { test } from "vitest";

import { loadPage as loadBarePage, type Page } from "./helpers/content.ts";

// happy-dom's default stylesheet sets `display` for block elements only and
// leaves inline ones computing to "", which no browser reports. This states the
// browser default for the inline tags these pages use, which is what separates
// `<div>A</div><div>B</div>` into two words and keeps `<b>Fo</b>o` one.
const INLINE_DEFAULTS = "a, b, strong, em, i, span, svg, img, code, my-label { display: inline }";

function loadPage(markup: string): Page {
  const page = loadBarePage(markup);
  const style = page.document.createElement("style");

  style.textContent = INLINE_DEFAULTS;
  page.document.head.append(style);

  return page;
}

/** A snapshot node as these tests read it. */
interface TreeNode {
  readonly uid: string;
  readonly tag: string;
  readonly role: string | null;
  readonly name?: string;
  readonly text?: string;
  readonly children?: ReadonlyArray<TreeNode>;
}

/** A find result as these tests read it. */
interface Found {
  readonly tag: string;
  readonly name?: string;
}

function flatten(node: TreeNode | null, out: Array<TreeNode> = []): Array<TreeNode> {
  if (!node) return out;
  out.push(node);

  for (const child of node.children || []) flatten(child, out);

  return out;
}

/** The nth child of `node`, failing the test if there is none. */
function child(node: TreeNode, index: number): TreeNode {
  const found = node.children?.[index];

  assert.ok(found, `child ${index} of <${node.tag}>`);

  return found;
}

async function snapshot(page: Page): Promise<TreeNode> {
  const { data, error } = await page.call("snapshot", {});

  assert.equal(error, null);

  return data;
}

async function snapshotOf(markup: string): Promise<TreeNode> {
  return snapshot(loadPage(markup));
}

async function find(page: Page, params: { readonly selector?: string; readonly text?: string }): Promise<Array<Found>> {
  const { data, error } = await page.call("find", params);

  assert.equal(error, null);

  return data;
}

/**
 * happy-dom does no layout, so every element is given the same box, and the
 * hit test answers with the page's link, as it would with the link on top.
 * Enough for click and hover to reach it.
 */
function layOut(page: Page): Array<string> {
  const { window, document } = page;
  const events: Array<string> = [];
  const box = { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 };

  Object.assign(window.Element.prototype, {
    getBoundingClientRect: () => box,
    getClientRects: () => [box],
    scrollIntoView() {},
  });
  Object.assign(document, { elementFromPoint: () => document.querySelector("a") });

  for (const type of ["click", "mouseover", "mousemove"]) {
    document.addEventListener(
      type,
      (event) => {
        if (event.target instanceof window.Element) events.push(`${type}:${event.target.tagName}`);
      },
      true,
    );
  }

  return events;
}

const TITLE_MARKUP =
  '<a href="/34337898/">Modeling Sporadic Alzheimer\'s Disease in Human <b>Brain</b> Organoids under <b>Serum</b> Exposure.</a>';

const TITLE = "Modeling Sporadic Alzheimer's Disease in Human Brain Organoids under Serum Exposure.";

// ─── Name from content ───────────────────────────────────────────────

test("a link with inline markup is named by its whole text in reading order", async () => {
  const link = child(await snapshotOf(TITLE_MARKUP), 0);

  assert.equal(link.role, "link");
  assert.equal(link.name, TITLE);
});

test("the markup's words stay reachable as children while text stays the element's own", async () => {
  const link = child(await snapshotOf(TITLE_MARKUP), 0);

  // text is documented as the element's own text nodes; name carries the label.
  assert.equal(link.text, "Modeling Sporadic Alzheimer's Disease in Human  Organoids under  Exposure.");
  assert.equal(link.children?.map((node) => node.text).join("|"), "Brain|Serum");
  assert.ok(link.children?.every((node) => /^f0e\d+$/.test(node.uid)));
});

test("a link whose own text is empty is named by its child's text", async () => {
  const link = child(await snapshotOf("<a><span>Create RSS</span></a>"), 0);

  assert.equal(link.name, "Create RSS");
  assert.equal(link.text, undefined);
});

test("whitespace between and inside the pieces collapses to single spaces", async () => {
  const link = child(await snapshotOf("<a>\n   Human\n  <b>Brain</b>\t\n Organoids  \n</a>"), 0);

  assert.equal(link.name, "Human Brain Organoids");
});

test("an aria-hidden icon beside a label does not enter the name", async () => {
  const markup = '<button><svg aria-hidden="true"><title>floppy disk icon</title></svg> Save</button>';

  assert.equal(child(await snapshotOf(markup), 0).name, "Save");
});

test("text in a display:none child does not enter the name", async () => {
  const markup = '<button>Save<span style="display: none"> (opens a dialog)</span></button>';

  assert.equal(child(await snapshotOf(markup), 0).name, "Save");
});

test("aria-label wins over content", async () => {
  const markup = '<button aria-label="Open Trash">🗑<b>9</b></button>';

  assert.equal(child(await snapshotOf(markup), 0).name, "Open Trash");
});

test("block-level children are separate words and inline ones are not", async () => {
  const tree = await snapshotOf("<button><div>Title</div><div>Subtitle</div></button><a><b>Fo</b>o</a>");

  assert.equal(child(tree, 0).name, "Title Subtitle");
  assert.equal(child(tree, 1).name, "Foo");
});

test("an image or labelled icon inside a link contributes its alt or aria-label", async () => {
  const tree = await snapshotOf('<a><img alt="Acme home"></a><a><span aria-label="Cart">(3)</span> items</a>');

  assert.equal(child(tree, 0).name, "Acme home");
  assert.equal(child(tree, 1).name, "Cart items");
});

test("a field's value inside a link never reaches the name", async () => {
  const secret = "hunter2-sekret";

  const page = loadPage(
    `<a>Sign in as <input type="password" value="${secret}"><input type="text" name="otp" value="${secret}"><textarea>${secret}</textarea></a>`,
  );

  // find reports the name even when the tree omits one equal to the text.
  const [found] = await find(page, { selector: "a" });
  assert.equal(found?.name, "Sign in as");

  const tree = await snapshot(page);
  assert.ok(!JSON.stringify(flatten(tree).map((node) => node.name)).includes(secret));
});

test("a heading with inline markup is named by its whole text", async () => {
  const heading = child(await snapshotOf("<h2>Latest <em>news</em> today</h2>"), 0);

  assert.equal(heading.name, "Latest news today");
});

test("roles that are not named by content get no name from it", async () => {
  const paragraph = child(await snapshotOf("<p>Hello <b>world</b></p>"), 0);

  assert.equal(paragraph.name, undefined);
});

test("an explicit role opts a div into name from content", async () => {
  const tab = child(await snapshotOf('<div role="tab">Inbox <b>(4)</b></div>'), 0);

  assert.equal(tab.name, "Inbox (4)");
});

test("a long name is cut at the same cap the snapshot uses for text", async () => {
  const long = "word ".repeat(300).trim();
  const link = child(await snapshotOf(`<a><span>${long}</span></a>`), 0);

  assert.equal(link.name?.length, 500);
  assert.ok(link.name?.endsWith("..."));
  assert.equal(link.name?.length, child(link, 0).text?.length);
});

// ─── Shadow roots and slots ──────────────────────────────────────────

test("inside an open shadow root a link is named by its content", async () => {
  const page = loadPage("<my-card></my-card>");
  const host = page.document.querySelector("my-card");

  assert.ok(host);
  host.attachShadow({ mode: "open" }).innerHTML = "<a>Read <b>more</b></a>";

  const link = flatten(await snapshot(page)).find((node) => node.tag === "a");
  assert.equal(link?.name, "Read more");
});

test("a link's name follows its content into a shadow host and through a slot", async () => {
  const page = loadPage("<a><my-label>slotted <b>light</b></my-label></a>");
  const label = page.document.querySelector("my-label");

  assert.ok(label);
  // The host's light children appear only where the slot puts them.
  label.attachShadow({ mode: "open" }).innerHTML = "shadow <slot></slot>";

  assert.equal(child(await snapshot(page), 0).name, "shadow slotted light");
});

// ─── Title ───────────────────────────────────────────────────────────

test("a title does not replace the content of a link", async () => {
  const page = loadPage('<a title="Read the full story">Read more</a>');

  const [found] = await find(page, { selector: "a" });

  assert.equal(found?.name, "Read more");
});

test("a link with no content is named by its title", async () => {
  const page = loadPage('<a title="Home"><svg aria-hidden="true"></svg></a>');

  const [found] = await find(page, { selector: "a" });

  assert.equal(found?.name, "Home");
});

test("the inline-markup link keeps its content name when it also has a title", async () => {
  const page = loadPage(TITLE_MARKUP);
  page.document.querySelector("a")?.setAttribute("title", "Open abstract");

  assert.equal(child(await snapshot(page), 0).name, TITLE);
});

test("a title still names an element that is not named by its content", async () => {
  const page = loadPage('<p title="Tooltip">Body</p>');

  const [found] = await find(page, { selector: "p" });

  assert.equal(found?.name, "Tooltip");
});

// ─── Names that repeat the text ──────────────────────────────────────

test("a name that only repeats the node's text is left out of the tree", async () => {
  const tree = await snapshotOf("<a>Home</a><button>  Save\n   draft </button><h1>Welcome</h1>");

  for (const node of tree.children ?? []) {
    assert.equal(node.name, undefined, `${node.tag} repeated its text as a name`);
  }

  assert.equal(child(tree, 0).text, "Home");
  assert.equal(child(tree, 1).text, "Save\n   draft");
});

test("a name that differs from the node's text stays in the tree", async () => {
  const tree = await snapshotOf(
    `<button aria-label="Open Trash">Trash</button><a><img alt="Acme home"></a>${TITLE_MARKUP}`,
  );

  assert.equal(child(tree, 0).name, "Open Trash");
  assert.equal(child(tree, 1).name, "Acme home");
  assert.equal(child(tree, 2).name, TITLE);
});

test("find still reports the name of a node whose tree entry omits it", async () => {
  const page = loadPage("<a>Home</a>");

  const tree = await snapshot(page);
  const [found] = await find(page, { selector: "a" });

  assert.equal(child(tree, 0).name, undefined);
  assert.equal(found?.name, "Home");
});

// ─── Targeting by text ───────────────────────────────────────────────

test("find matches a link by its full visible title", async () => {
  const page = loadPage(TITLE_MARKUP);

  const found = await find(page, { text: "Brain Organoids under Serum" });

  assert.equal(found.length, 1);
  assert.equal(found[0]?.tag, "a");
  assert.equal(found[0]?.name, TITLE);
});

test("click by the full visible title acts on the link", async () => {
  const page = loadPage(`<ul><li>${TITLE_MARKUP}</li></ul>`);
  const events = layOut(page);

  const response = await page.call("click", { text: TITLE });

  assert.equal(response.error, null);
  assert.ok(events.includes("click:A"), events.join());
});

test("click by the title as snapshots report it matches markup that wraps across lines", async () => {
  // Source formatting puts newlines and runs of spaces between the pieces,
  // and the name an agent copies from a snapshot has them collapsed.
  const page = loadPage("<a>Human\n        <b>Brain</b>\n        Organoids</a>");
  const events = layOut(page);

  const response = await page.call("click", { text: "Human Brain Organoids" });

  assert.equal(response.error, null);
  assert.ok(events.includes("click:A"), events.join());
});

test("hover by the full visible title acts on the link", async () => {
  const page = loadPage(TITLE_MARKUP);
  const events = layOut(page);

  const response = await page.call("hover", { text: TITLE });

  assert.equal(response.error, null);
  assert.ok(events.includes("mouseover:A"), events.join());
});

test("click and hover by a name the tree omits still act on the element", async () => {
  const page = loadPage("<a>Home</a>");
  const events = layOut(page);

  assert.equal((await page.call("click", { text: "Home" })).error, null);
  assert.equal((await page.call("hover", { text: "Home" })).error, null);
  assert.ok(events.includes("click:A"), events.join());
});
