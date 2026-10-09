import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "vitest";
import { BACKGROUND_SCRIPT_FILES, CONTENT_SCRIPT_FILES, PAGE_WORLD_SCRIPT_FILES } from "../src/shared/protocol.ts";
import { EXTENSION_ENTRIES } from "../tsdown.config.ts";
import { builtScript, extensionResource } from "./helpers/sources.ts";

interface ContentScriptEntry {
  readonly js: ReadonlyArray<string>;
  readonly world?: string;
}

interface Manifest {
  readonly background: { readonly scripts: ReadonlyArray<string>; readonly type?: string };
  readonly content_scripts: ReadonlyArray<ContentScriptEntry>;
}

// SAFETY: manifest.json is the extension's own, checked-in manifest.
const manifest = JSON.parse(extensionResource("manifest.json")) as Manifest;

const declared = (world: "MAIN" | "ISOLATED") =>
  manifest.content_scripts.find((entry) => (entry.world ?? "ISOLATED") === world)?.js;

// The same file names live in the manifest, in the background's re-injection
// lists (shared/protocol.ts), and in the build's outputs (tsdown.config.ts).
// Drift between them ships a file the browser never loads, or re-injects one
// that does not exist.
test("the manifest's background scripts are the ones the background declares", () => {
  assert.deepEqual(manifest.background.scripts, BACKGROUND_SCRIPT_FILES);
});

test("the manifest's content scripts are the ones the background re-injects", () => {
  assert.deepEqual(declared("ISOLATED"), CONTENT_SCRIPT_FILES);
});

test("the manifest's page-world scripts are the ones the background re-injects, in order", () => {
  assert.deepEqual(declared("MAIN"), PAGE_WORLD_SCRIPT_FILES);
});

test("every script the manifest names is a build output, and was built", () => {
  const outputs = new Set(Object.keys(EXTENSION_ENTRIES));

  for (const file of [...BACKGROUND_SCRIPT_FILES, ...CONTENT_SCRIPT_FILES, ...PAGE_WORLD_SCRIPT_FILES, "popup.js"]) {
    assert.ok(outputs.has(file), `${file} is not built by tsdown.config.ts`);
    assert.ok(existsSync(new URL(`../dist/extension/${file}`, import.meta.url)), `${file} was not built`);
  }
});

test("the background is not declared as a module", () => {
  // The background is one bundled classic script. `"type": "module"` would
  // make Safari load it as an ES module, which it is not built as.
  assert.equal(manifest.background.type, undefined);
});

test("scripts injected into pages bundle nothing from node_modules", () => {
  // They load into every page and frame, so they carry no runtime: the build
  // refuses dependencies for them, and this checks what actually shipped.
  for (const file of [...CONTENT_SCRIPT_FILES, ...PAGE_WORLD_SCRIPT_FILES]) {
    const source = builtScript(file);

    assert.doesNotMatch(source, /node_modules/, `${file} bundles a dependency`);
    assert.doesNotMatch(source, /\bimport\b\s*[({"']|\brequire\(/, `${file} imports at run time`);
  }
});
