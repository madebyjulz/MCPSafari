// @vitest-environment happy-dom
import assert from "node:assert/strict";
import { Option } from "effect";
import { afterEach, beforeEach, test } from "vitest";
import type { ControllerMessage } from "../src/app/contract.ts";
import { preferencesErrorText } from "../src/app/render.ts";
import { appResource, builtAppScript } from "./helpers/sources.ts";

// ─── What the user reads ─────────────────────────────────────────────

test("a refusal names Safari's reason and the way round it", () => {
  const text = preferencesErrorText(Option.some("The extension could not be found."));

  assert.match(text, /The extension could not be found\./);
  assert.match(text, /Safari > Settings > Extensions/);
});

test("a refusal with no reason still says what to do", () => {
  assert.match(preferencesErrorText(Option.none()), /Open Safari > Settings > Extensions yourself/);
});

// ─── The running page ────────────────────────────────────────────────

// SAFETY: the test installs and removes its own `webkit` global on the real global object.
const globals = globalThis as unknown as Record<string, unknown>;

let messages: Array<ControllerMessage> = [];

beforeEach(() => {
  messages = [];
  globals["webkit"] = {
    messageHandlers: { controller: { postMessage: (message: ControllerMessage) => messages.push(message) } },
  };
  document.body.className = "";
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(appResource("Base.lproj/Main.html"))?.[1] ?? "";
  // The bundle exactly as the app's page loads it, against the app's own markup.
  new Function(builtAppScript("Script.js"))();
});

afterEach(() => {
  delete globals["webkit"];
});

const note = () => document.querySelector<HTMLElement>(".preferences-note");

test("Accessibility button opens settings guidance", () => {
  document.querySelector<HTMLButtonElement>("button.enable-native-input")?.click();

  assert.deepEqual(messages, ["enable-native-input"]);
});

test("the preferences button asks the app to open Safari's settings", () => {
  document.querySelector<HTMLButtonElement>("button.open-preferences")?.click();

  assert.deepEqual(messages, ["open-preferences"]);
});

test("Swift can still call show by name, and an unknown state is not shown as off", () => {
  window.show(true);

  assert.deepEqual([...document.body.classList], ["state-on"]);

  window.show(null);

  assert.deepEqual([...document.body.classList], ["state-error"]);
});

test("a state Swift was never meant to send shows as can't tell", () => {
  // SAFETY: Swift writes this call as script text; nothing types what it sends.
  window.show("yes" as unknown as boolean);

  assert.deepEqual([...document.body.classList], ["state-error"]);
});

test("Swift can report that Safari refused to open its settings", () => {
  assert.equal(note()?.hidden, true);

  window.showPreferencesError("The extension could not be found.");

  assert.equal(note()?.hidden, false);
  assert.match(note()?.textContent ?? "", /The extension could not be found\./);
});

test("Safari's reason is shown as text, never as markup", () => {
  window.showPreferencesError('<img src=x onerror="alert(1)">');

  assert.equal(note()?.querySelector("img"), null);
  assert.match(note()?.textContent ?? "", /<img/);
});

test("a reason that is not text still tells the user what to do", () => {
  // SAFETY: Swift writes this call as script text; nothing types what it sends.
  window.showPreferencesError(42 as unknown as string);

  assert.equal(note()?.hidden, false);
  assert.doesNotMatch(note()?.textContent ?? "", /42/);
  assert.match(note()?.textContent ?? "", /Safari > Settings > Extensions/);
});
