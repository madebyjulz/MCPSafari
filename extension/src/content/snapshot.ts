/**
 * Reading the page: text extraction, shadow-DOM traversal, and the
 * accessibility snapshot with its roles, names and redaction.
 */

import type { ContentParams } from "../shared/protocol.ts";
import { isSensitiveField } from "../shared/sensitive-field.ts";
import { asPageElement, escapeCssString, getUid, type PageElement } from "./core.ts";

export interface SnapshotParams extends ContentParams {
  readonly maxNodes?: number;
}

export interface ReadPageParams extends SnapshotParams {
  readonly format?: string;
  readonly maxChars?: number;
}

/** One element in the accessibility snapshot. */
export type SnapshotNode = {
  uid: string;
  tag: string;
  role: string | null;
  name?: string;
  value?: string;
  checked?: true;
  disabled?: true;
  selected?: true;
  expanded?: boolean;
  href?: string;
  frameSrc?: string;
  childrenTruncated?: true;
  shadowClosed?: true;
  text?: string;
  children?: Array<SnapshotNode>;
  truncated?: true;
};

/** A document or an open shadow root: a tree querySelector can see into. */
export type QueryRoot = Document | ShadowRoot;

// ─── Page Reading ────────────────────────────────────────────────

// A big application page runs to hundreds of kilobytes, which either
// overruns the client's output limit or spends the model's context on one
// call. Cut it and say so, rather than returning a clipped page that reads
// like the whole thing.
const MAX_PAGE_CHARS = 100000;

function clampText(value: string, limit: number): string {
  const max = limit > 0 ? limit : MAX_PAGE_CHARS;

  if (value.length <= max) return value;

  return (
    `${value.slice(0, max)}\n\n[truncated: ${value.length} characters total, ` +
    `${max} returned. Raise maxChars, or use find or snapshot to target a region.]`
  );
}

export function readPage(params: ReadPageParams): string | SnapshotNode | null {
  const format = params.format || "text";
  const maxChars = Number(params.maxChars) > 0 ? Number(params.maxChars) : 0;

  switch (format) {
    case "html":
      return clampText(document.documentElement.outerHTML, maxChars);
    case "text":
      return clampText(document.body ? document.body.innerText : "", maxChars);
    case "snapshot":
      return takeSnapshot(params);
    default:
      throw new Error(`Unknown format: ${format}. Use 'text', 'html', or 'snapshot'.`);
  }
}

export function getPageText(): string {
  return document.body ? document.body.innerText : "";
}

// ─── Shadow DOM Traversal ────────────────────────────────────────

// querySelector and TreeWalker each see a single tree, so anything inside
// a shadow root is invisible to them and a page built on web components
// returns results that look complete and are not. Every lookup below
// repeats itself against each open root instead. Closed roots stay
// unreachable: the page chose that, and no API reaches in.
export function* allRoots(root: QueryRoot = document): Generator<QueryRoot, void, undefined> {
  yield root;

  for (const element of root.querySelectorAll("*")) {
    if (element.shadowRoot) yield* allRoots(element.shadowRoot);
  }
}

export function deepQueryFirst(selector: string): PageElement | null {
  for (const root of allRoots()) {
    const found = root.querySelector<PageElement>(selector);

    if (found) return found;
  }

  return null;
}

export function deepQueryAll(selector: string, limit = Infinity): Array<PageElement> {
  const found: Array<PageElement> = [];

  for (const root of allRoots()) {
    for (const element of root.querySelectorAll<PageElement>(selector)) {
      found.push(element);

      if (found.length >= limit) return found;
    }
  }

  return found;
}

// A walker rooted at the document would offer <html> and <body> themselves
// as matches, which the leaf-ish filters downstream exist to exclude. A
// shadow root has no such wrapper, so it is walked as-is.
export function walkRootFor(root: QueryRoot): HTMLElement | QueryRoot | null {
  return root === document ? document.body : root;
}

// A shadow host renders its shadow root, and the host's own children only
// appear where a <slot> puts them, so walking both would report slotted
// content twice. This follows the flattened tree the user actually sees.
function renderedChildren(element: PageElement): Array<Element> {
  if (element.shadowRoot) return Array.from(element.shadowRoot.children);

  if (typeof element.assignedElements === "function") {
    // flatten resolves nested slots and falls back to the slot's own
    // children when nothing is assigned.
    return element.assignedElements({ flatten: true });
  }

  return Array.from(element.children);
}

// Text belongs to whichever tree renders it, so a shadow host reports its
// shadow content instead of light children a slot placed somewhere else.
function renderedTextRoot(element: PageElement): PageElement | ShadowRoot {
  return element.shadowRoot || element;
}

// `shadowRoot` is null both for "no shadow root" and for a closed one, so a
// closed root can only be inferred: a custom element that occupies space
// while reporting no content of its own is rendering something we cannot
// see. Marking it beats reporting an empty element that looks absent.
function hasClosedShadowRoot(element: PageElement): boolean {
  if (element.shadowRoot) return false;

  if (!element.tagName || !element.tagName.includes("-")) return false;

  if (element.children.length > 0) return false;

  if (element.textContent && element.textContent.trim()) return false;

  const rect = element.getBoundingClientRect();

  return rect.width > 0 && rect.height > 0;
}

// ─── Accessibility Snapshot ──────────────────────────────────────

const MAX_TREE_DEPTH = 30;

const MAX_SNAPSHOT_NODES = 2000;

// One cap for the strings a node carries, its text and its name alike.
const MAX_TEXT_CHARS = 500;

function truncateText(text: string): string {
  return text.length <= MAX_TEXT_CHARS ? text : `${text.substring(0, MAX_TEXT_CHARS - 3)}...`;
}

/** How many more nodes a snapshot may report, and whether it ran out. */
interface SnapshotBudget {
  remaining: number;
  cut: boolean;
}

export function takeSnapshot(params: SnapshotParams = {}): SnapshotNode | null {
  const root = document.body || document.documentElement;

  for (const queryRoot of allRoots()) watchForPasswordFields(queryRoot);

  const requested = Number(params.maxNodes);
  const budget = { remaining: requested > 0 ? requested : MAX_SNAPSHOT_NODES, cut: false };
  const tree = buildTree(root, 0, budget);

  // Marked on the root as well, so a caller reading the top of a large
  // tree can tell a cut snapshot from a complete one without scanning it.
  if (tree && budget.cut) tree.truncated = true;

  return tree;
}

function buildTree(element: PageElement, depth: number, budget: SnapshotBudget): SnapshotNode | null {
  if (depth > MAX_TREE_DEPTH) return null;

  if (!isVisible(element)) return null;

  if (budget.remaining <= 0) {
    budget.cut = true;

    return null;
  }

  budget.remaining -= 1;

  const role = getRole(element);
  const name = getAccessibleName(element);
  const uid = getUid(element);
  const tag = element.tagName ? element.tagName.toLowerCase() : "";

  const node: SnapshotNode = { uid, tag, role };

  // Value for inputs. Secrets report their presence, not their contents,
  // so a snapshot of a filled login or payment form is safe to hand to a model.
  if (reportsValue(element, tag) && element.value !== undefined && element.value !== "") {
    node.value = isSensitiveInput(element) ? REDACTED : String(element.value);
  }

  // States
  if (element.checked) node.checked = true;

  if (element.disabled) node.disabled = true;

  if (element.selected) node.selected = true;

  if (element.getAttribute("aria-expanded") !== null) {
    node.expanded = element.getAttribute("aria-expanded") === "true";
  }

  // Href for links
  const href = tag === "a" ? linkHref(element) : "";

  if (href) node.href = href;

  // A frame's document belongs to a different content script, so the
  // background splices it in here. It matches on the resolved src and
  // drops this marker afterwards.
  if (tag === "iframe" || tag === "frame") {
    node.frameSrc = element.src || "";
  }

  // Children
  const children: Array<SnapshotNode> = [];
  let droppedChildren = false;

  for (const child of renderedChildren(element)) {
    const childNode = buildTree(asPageElement(child), depth + 1, budget);

    if (childNode) children.push(childNode);
    else if (budget.remaining <= 0) droppedChildren = true;
  }

  if (droppedChildren) node.childrenTruncated = true;

  if (children.length === 0 && hasClosedShadowRoot(element)) node.shadowClosed = true;

  // Leaf nodes report their whole text content. Nodes that also have
  // element children report their own direct text nodes, so mixed
  // content such as <button><span>9</span>All</button> keeps "All". That is
  // only the element's own words: the children carry the rest, and for a
  // link, button or heading the whole label in reading order is `name`.
  const rawText = children.length === 0 ? renderedText(renderedTextRoot(element)) : ownTextContent(element);

  // A textarea's text content is its default value, so a sensitive one would
  // otherwise leak here what the `value` redaction above withheld.
  let text = "";

  if (rawText && !(tag === "textarea" && isSensitiveInput(element))) {
    text = rawText.trim();

    if (text) node.text = truncateText(text);
  }

  // A name that only repeats the node's text adds nothing, and content
  // fallback gives one to every link, button and heading. Keep it when it says
  // something the text does not: inline markup, an aria-label, an alt, a label
  // from elsewhere. find and click read the name from the page, not from the
  // tree, so omitting it here loses no way to match.
  if (name && name !== truncateText(text.replace(/\s+/g, " "))) node.name = name;

  if (children.length > 0) node.children = children;

  return node;
}

// Only form controls hold a value a user typed or chose. Elsewhere `value`
// means something else: an <li>'s ordinal, which reads 0 on every list item.
// Options stay because select_option takes an option's value. A progress bar
// or meter reads 0 when it has no value at all, so it reports one only when
// the page set it.
const VALUE_TAGS = new Set(["input", "textarea", "select", "option"]);

function reportsValue(element: PageElement, tag: string): boolean {
  if (VALUE_TAGS.has(tag)) return true;

  return (tag === "progress" || tag === "meter") && element.getAttribute("value") !== null;
}

// An SVG <a> answers `href` with an SVGAnimatedString, not a URL. Its
// baseVal is the attribute as written, so it is resolved the way an HTML
// link's href already is.
function linkHref(element: PageElement): string {
  const href = element.href;

  if (typeof href === "string") return href;

  const raw = href?.baseVal;

  if (!raw) return "";

  try {
    return new URL(raw, document.baseURI).href;
  } catch {
    return raw;
  }
}

// Elements whose text is never drawn. textContent includes it anyway, so a
// component whose shadow root holds only a <style> would report its CSS.
const UNRENDERED_TAGS = new Set(["STYLE", "SCRIPT", "NOSCRIPT", "TEMPLATE"]);

// textContent of a leaf, minus whatever unrendered elements contain. A root
// with no element children cannot hold one, so it keeps the native read.
function renderedText(root: PageElement | ShadowRoot): string {
  if (root.children.length === 0) return root.textContent ?? "";

  let text = "";

  for (const child of root.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      text += child.textContent;
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const element = asPageElement(child);

      if (!UNRENDERED_TAGS.has(element.tagName.toUpperCase())) text += renderedText(element);
    }
  }

  return text;
}

// Text of an element's direct text-node children only, in document order.
function ownTextContent(element: PageElement): string {
  let text = "";

  for (const child of renderedTextRoot(element).childNodes) {
    if (child.nodeType === Node.TEXT_NODE) text += child.textContent;
  }

  return text;
}

export function isVisible(element: PageElement | null | undefined): boolean {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;

  if (element.getAttribute("aria-hidden") === "true") return false;

  if (element.hidden) return false;

  const style = window.getComputedStyle(element);

  if (style.display === "none") return false;

  if (style.visibility === "hidden") return false;

  if (parseFloat(style.opacity) === 0) return false;

  return true;
}

export function getRole(element: PageElement): string | null {
  // Explicit ARIA role
  const ariaRole = element.getAttribute("role");

  if (ariaRole) return ariaRole;

  // Implicit roles by tag
  const tag = element.tagName ? element.tagName.toLowerCase() : "";

  if (tag === "input") return getInputRole(element);

  return IMPLICIT_ROLES.get(tag) ?? null;
}

// Maps, not object literals: a tag or type named after an Object.prototype
// member (<constructor>) would otherwise read back a function as its role.
const IMPLICIT_ROLES: ReadonlyMap<string, string> = new Map([
  ["a", "link"],
  ["button", "button"],
  ["select", "combobox"],
  ["textarea", "textbox"],
  ["img", "img"],
  ["h1", "heading"],
  ["h2", "heading"],
  ["h3", "heading"],
  ["h4", "heading"],
  ["h5", "heading"],
  ["h6", "heading"],
  ["nav", "navigation"],
  ["main", "main"],
  ["aside", "complementary"],
  ["footer", "contentinfo"],
  ["header", "banner"],
  ["form", "form"],
  ["table", "table"],
  ["ul", "list"],
  ["ol", "list"],
  ["li", "listitem"],
  ["dialog", "dialog"],
  ["details", "group"],
  ["summary", "button"],
]);

const INPUT_ROLES: ReadonlyMap<string, string> = new Map([
  ["text", "textbox"],
  ["email", "textbox"],
  ["password", "textbox"],
  ["search", "searchbox"],
  ["tel", "textbox"],
  ["url", "textbox"],
  ["number", "spinbutton"],
  ["range", "slider"],
  ["checkbox", "checkbox"],
  ["radio", "radio"],
  ["button", "button"],
  ["submit", "button"],
  ["reset", "button"],
]);

// Fields whose contents must never reach a snapshot: the shared rule in
// shared/sensitive-field.ts, which the trace interceptor applies too, plus
// every field this page has shown as a password.
const REDACTED = "[redacted]";

// A show-password toggle flips the field to type=text, after which the type
// alone no longer says it was a password. The page's own scripts do the
// flipping, so the only way to know is to have been watching: every field seen
// as a password stays in this set for the life of the page.
//
// Limits, both on purpose. A toggle that happened inside a shadow root before
// the first snapshot was not watched, and the name and autocomplete hints are
// what catch that field. And the set belongs to this content script, so a
// fresh one (after the extension reloads) starts it empty.
const everPassword = new WeakSet<Element>();

const watchedRoots = new WeakSet<Node>();

let typeObserver: MutationObserver | null = null;

function isPasswordType(element: PageElement): boolean {
  return String(element.type || "").toLowerCase() === "password";
}

function rememberPasswords(records: ReadonlyArray<MutationRecord>): void {
  for (const record of records) {
    const target = asPageElement(record.target);

    if (String(record.oldValue || "").toLowerCase() === "password" || isPasswordType(target)) {
      everPassword.add(target);
    }
  }
}

/**
 * Starts remembering which fields in `root` are or become passwords. main.ts
 * covers the document as the script loads, and each snapshot covers every open
 * shadow root then on the page, since an observer on the document does not see
 * into those. Watching a root twice does nothing.
 */
export function watchForPasswordFields(root: QueryRoot): void {
  if (typeof MutationObserver !== "function" || watchedRoots.has(root)) return;

  typeObserver ??= new MutationObserver(rememberPasswords);
  watchedRoots.add(root);
  typeObserver.observe(root, { subtree: true, attributes: true, attributeFilter: ["type"], attributeOldValue: true });

  for (const field of root.querySelectorAll<PageElement>("input")) {
    if (isPasswordType(field)) everPassword.add(field);
  }
}

function isSensitiveInput(element: PageElement): boolean {
  const tag = element.tagName ? element.tagName.toLowerCase() : "";

  if (tag !== "input" && tag !== "textarea") return false;

  if (everPassword.has(element)) return true;

  return isSensitiveField({
    tag,
    type: element.type,
    autocomplete: element.getAttribute("autocomplete"),
    hints: [
      element.getAttribute("name"),
      element.id,
      element.getAttribute("aria-label"),
      element.getAttribute("inputmode"),
      element.getAttribute("autocomplete"),
    ],
  });
}

function getInputRole(element: PageElement): string {
  const type = (element.type || "text").toLowerCase();

  return INPUT_ROLES.get(type) ?? "textbox";
}

export function getAccessibleName(element: PageElement): string | null {
  // aria-label
  const ariaLabel = element.getAttribute("aria-label");

  if (ariaLabel) return ariaLabel;

  // aria-labelledby takes a space-separated list of ids, joined in order.
  const labelledBy = element.getAttribute("aria-labelledby");

  if (labelledBy) {
    const labelText = labelledBy
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => labelledByElement(element, id))
      .filter((labelEl): labelEl is HTMLElement => Boolean(labelEl))
      .map((labelEl) => labelEl.textContent.trim())
      .filter(Boolean)
      .join(" ");

    if (labelText) return labelText;
  }

  // Label element for inputs. `labels` covers labelable controls directly;
  // the selector fallback must escape the id, because a raw id containing
  // a quote builds a malformed selector that throws and fails the snapshot.
  if (element.labels && element.labels.length > 0) {
    const labelText = element.labels[0]!.textContent.trim();

    if (labelText) return labelText;
  }

  if (element.id) {
    // `for` resolves within the element's own tree, so a control inside
    // a shadow root is labelled from that root and not from the document.
    const scope = element.getRootNode ? element.getRootNode() : document;
    const label = asQueryRoot(scope).querySelector(`label[for="${escapeCssString(element.id)}"]`);

    if (label) return label.textContent.trim();
  }

  // Alt text for images
  if (element.alt) return element.alt;

  // Title attribute. A role named by its content only falls back to it below:
  // title is a tooltip, so `<a title="Read the full story">Read more</a>` is
  // "Read more", and the title is what is left when the content says nothing.
  const fromContent = NAME_FROM_CONTENT_ROLES.has(getRole(element) ?? "");

  if (element.title && !fromContent) return element.title;

  // Placeholder for inputs
  if (element.placeholder) return element.placeholder;

  // Name from content (WAI-ARIA). Without it a link such as
  // `Human <b>Brain</b> Organoids` has no name, and the tree shows only its own
  // text nodes ("Human  Organoids") with "Brain" as a separate child, so the
  // label reads out of order or, when every word sits in a child, not at all.
  if (fromContent) {
    const text = contentName(element);

    if (text) return text;

    if (element.title) return element.title;
  }

  return null;
}

// Roles whose name is the text they contain, per the ARIA name-from-content
// list, limited to the ones a page uses as controls and landmarks of text.
// Rows and cells are left out on purpose: a table row named by its whole row
// would repeat every cell's text on every row of the tree.
const NAME_FROM_CONTENT_ROLES: ReadonlySet<string> = new Set([
  "link",
  "button",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "treeitem",
  "heading",
  "switch",
  "checkbox",
  "radio",
  "tooltip",
]);

// ARIA lets an embedded control contribute its value to the name around it.
// Here it contributes nothing: the snapshot withholds the value of a password
// or card field, and a name is the one other place it could leak.
const NAME_SKIPPED_TAGS: ReadonlySet<string> = new Set(["input", "textarea", "select"]);

// The nodes a user sees under an element: its open shadow root in place of its
// light children, and a slot's assigned nodes (text included) in place of the
// slot's own. renderedChildren, but with the text nodes.
function renderedChildNodes(element: PageElement): Array<Node> {
  if (element.shadowRoot) return Array.from(element.shadowRoot.childNodes);

  if (typeof element.assignedNodes === "function") return element.assignedNodes({ flatten: true });

  return Array.from(element.childNodes);
}

// The ARIA text alternative of an element's content, in document order. This
// walks the nodes rather than reading innerText so that it follows the same
// rules as the rest of the snapshot: whatever isVisible drops (aria-hidden,
// display:none) contributes nothing, and form controls are skipped by tag. An
// icon `<svg aria-hidden>` beside a label therefore does not pollute the name.
// It stays cheap because it stops once it has more than a name can hold.
function contentName(element: PageElement): string {
  const parts: Array<string> = [];
  let length = 0;

  const add = (part: string): void => {
    parts.push(part);
    length += part.length;
  };

  const walk = (node: Node, depth: number): void => {
    // Padding spaces collapse when the parts are joined, so allow headroom
    // before declaring the name long enough.
    if (length > MAX_TEXT_CHARS * 2 || depth > MAX_TREE_DEPTH) return;

    if (node.nodeType === Node.TEXT_NODE) {
      add(node.textContent ?? "");

      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const child = asPageElement(node);

    if (!isVisible(child) || NAME_SKIPPED_TAGS.has(child.tagName.toLowerCase())) return;

    // A nested element that names itself (an icon with aria-label, an image
    // with alt) is read by that name rather than by its insides.
    const label = child.getAttribute("aria-label") || child.alt;
    // Block-level children are separate runs of text, so `<div>A</div>
    // <div>B</div>` reads "A B" and not "AB". Inline ones stay joined.
    const display = window.getComputedStyle(child).display;
    const separate = display !== "inline" && display !== "contents";

    if (separate) add(" ");

    if (label) add(label);
    else for (const grandchild of renderedChildNodes(child)) walk(grandchild, depth + 1);

    if (separate) add(" ");
  };

  for (const child of renderedChildNodes(element)) walk(child, 0);

  return truncateText(parts.join("").replace(/\s+/g, " ").trim());
}

/** A node an id can be looked up in: a document or a shadow root, not a detached element. */
type IdScope = Node & { readonly getElementById?: (id: string) => HTMLElement | null };

// The ids name elements in the element's own tree, so a control inside a
// shadow root is labelled from that root, as `label[for]` is. The document
// is still asked when the root has no such id, as it was before roots
// were consulted at all.
function labelledByElement(element: PageElement, id: string): HTMLElement | null {
  const scope: IdScope = element.getRootNode ? element.getRootNode() : document;

  return scope.getElementById?.(id) ?? document.getElementById(id);
}

/** The root an element lives in, as a tree that can be queried. */
function asQueryRoot(root: Node): QueryRoot {
  // SAFETY: getRootNode() on a rendered element is its document or the shadow
  // root it sits in; a detached subtree's root element answers querySelector too.
  return root as QueryRoot;
}
