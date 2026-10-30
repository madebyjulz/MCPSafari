// Which form values a snapshot withholds. The rule itself is tested on plain
// descriptions in sensitive-field-rule.test.ts; these check that the snapshot
// reads it off real fields, and what it adds: remembering a field that was ever
// a password, and keeping a textarea's default text out of `text`.

import assert from "node:assert/strict";
import { test } from "vitest";

import { loadPage, type Page } from "./helpers/content.ts";

const REDACTED = "[redacted]";

/** A snapshot node as these tests read it. */
interface TreeNode {
  readonly tag: string;
  readonly value?: string;
  readonly text?: string;
  readonly children?: ReadonlyArray<TreeNode>;
}

async function snapshot(page: Page): Promise<TreeNode> {
  const { data, error } = await page.call("snapshot", {});

  assert.equal(error, null);

  return data;
}

/** The value each field in `markup` reports, in order. */
async function snapshotValues(markup: string): Promise<Array<string | undefined>> {
  const tree = await snapshot(loadPage(markup));

  // Array.from, because the tree's arrays belong to the page's realm.
  return Array.from(tree.children ?? [], (node) => node.value);
}

/** Gives `page`'s <login-form> an open shadow root holding `markup`. */
function shadowForm(page: Page, markup: string): void {
  const host = page.document.querySelector("login-form");

  assert.ok(host);
  host.attachShadow({ mode: "open" }).innerHTML = markup;
}

/** The first node under `tree` with `tag`, searching depth first. */
function nodeByTag(tree: TreeNode, tag: string): TreeNode | undefined {
  if (tree.tag === tag) return tree;

  for (const child of tree.children ?? []) {
    const found = nodeByTag(child, tag);

    if (found) return found;
  }

  return undefined;
}

// MutationObserver callbacks run as a microtask after the change.
const observed = () => new Promise((resolve) => setTimeout(resolve, 0));

// Every token the browser vocabulary uses for a secret. Pinning all eight
// matters because a typo in one is invisible until that field type is filled.
for (const token of [
  "current-password",
  "new-password",
  "one-time-code",
  "cc-number",
  "cc-csc",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year",
]) {
  test(`autocomplete="${token}" is redacted`, async () => {
    assert.deepEqual(await snapshotValues(`<input autocomplete="${token}" value="s3cret">`), [REDACTED]);
  });
}

test("a sensitive token among section and hint tokens is still found", async () => {
  assert.deepEqual(await snapshotValues('<input autocomplete="section-x cc-csc" value="s3cret">'), [REDACTED]);
});

test("an upper-case type=PASSWORD is redacted", async () => {
  assert.deepEqual(await snapshotValues('<input type="PASSWORD" value="s3cret">'), [REDACTED]);
});

test("a password input inside a shadow root is redacted", async () => {
  const page = loadPage("<login-form></login-form>");
  shadowForm(page, '<input type="password" value="s3cret">');

  assert.equal(nodeByTag(await snapshot(page), "input")?.value, REDACTED);
});

test("a textarea marked sensitive is redacted and does not leak through its default text", async () => {
  const tree = await snapshot(loadPage('<textarea name="recovery_secret">recovery words</textarea>'));
  const node = tree.children?.[0];

  assert.equal(node?.value, REDACTED);
  assert.equal(node?.text, undefined);
});

test("an ordinary textarea keeps its value", async () => {
  assert.deepEqual(await snapshotValues('<textarea name="message">Dear team</textarea>'), ["Dear team"]);
});

// The name, id, label and input mode are only hints, so the table is as much
// about what must stay readable as about what must not.
const SECRET_HINTS = [
  'name="password_confirm"',
  'name="userPwd"',
  'name="newPassword"',
  'id="otpCode"',
  'id="login-pin"',
  'aria-label="Enter your PIN"',
  'name="CVV"',
  'name="card_cvc"',
  'name="ssn"',
  'name="api_secret"',
  'name="authToken"',
  'name="2fa_code"',
  'name="one-time-passcode"',
  'name="OTPCode"',
  'inputmode="one-time-code"',
  'autocomplete="off" name="pass"',
];

for (const hint of SECRET_HINTS) {
  test(`a field hinted ${hint} is redacted`, async () => {
    assert.deepEqual(await snapshotValues(`<input type="text" ${hint} value="s3cret">`), [REDACTED]);
  });
}

test("names that merely resemble a secret stay readable", async () => {
  const values = await snapshotValues(
    [
      '<input name="shipping_address" value="a">',
      '<input name="passenger" value="b">',
      '<input name="compass" value="c">',
      '<input name="username" value="d">',
      '<input name="email" value="e">',
      '<input aria-label="Search" value="f">',
      '<input name="bypass_cache" value="g">',
    ].join(""),
  );

  assert.deepEqual(values, ["a", "b", "c", "d", "e", "f", "g"]);
});

test("a checkbox or button named like a secret keeps its fixed value", async () => {
  const values = await snapshotValues(
    '<input type="checkbox" name="remember_token" value="on"><input type="submit" name="token" value="Save">',
  );

  assert.deepEqual(values, ["on", "Save"]);
});

// ─── Fields that were passwords ──────────────────────────────────────

// A show-password toggle flips the field to type=text, after which nothing on
// the element says it was ever a password.
test("a field that was a password stays redacted after a show-password toggle", async () => {
  const page = loadPage("");
  // Added after the content script loaded, so only the observer can know.
  page.document.body.innerHTML = '<input type="password" name="field1" value="s3cret">';
  const field = page.document.querySelector("input");

  assert.ok(field);
  field.type = "text";
  await observed();

  assert.equal((await snapshot(page)).children?.[0]?.value, REDACTED);
});

test("the same field is not redacted if it never was a password", async () => {
  const page = loadPage('<input type="search" name="field1" value="s3cret">');
  const field = page.document.querySelector("input");

  assert.ok(field);
  field.type = "text";
  await observed();

  assert.equal((await snapshot(page)).children?.[0]?.value, "s3cret");
});

test("password fields already on the page when the content script loads are remembered", async () => {
  const page = loadPage('<input type="password" name="field1" value="s3cret">');
  const field = page.document.querySelector("input");

  assert.ok(field);
  // Flipped and observed nowhere: only the scan at load saw it as a password.
  field.setAttribute("type", "text");

  assert.equal((await snapshot(page)).children?.[0]?.value, REDACTED);
});

test("password fields in a shadow root are remembered from the first snapshot that reaches them", async () => {
  const page = loadPage("<login-form></login-form>");
  shadowForm(page, '<input type="password" name="field1" value="s3cret">');

  await snapshot(page);
  // The shadow root was first reached by that snapshot, which is when it began
  // being watched and scanned.
  const field = page.document.querySelector("login-form")?.shadowRoot?.querySelector("input");

  assert.ok(field);
  field.type = "text";

  assert.equal(nodeByTag(await snapshot(page), "input")?.value, REDACTED);
});
