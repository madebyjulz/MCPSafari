// Bundles every script the extension and host app load. Each output is a
// classic IIFE script, because that is how Safari loads all of them: the
// background is not a module, content and page-world scripts are injected by
// file name, and the host app's page includes Script.js with a plain tag.
//
// Output lands in dist/, outside the Xcode project. Xcode copies everything in
// its synchronized folders into the bundle flat, so generated files kept there
// would collide with the sources' names; the "Bundle extension scripts" build
// phase copies dist/ into the bundle instead.
//
// One config per script, because an IIFE cannot share chunks: each output has
// to stand alone. Rebuild a single one with `pnpm exec tsdown -F content.js`.

import { defineConfig, type UserConfig } from "tsdown";

/**
 * Scripts that run on the extension's own pages (the background and the
 * popup). Only these may bundle Effect.
 */
const EXTENSION_PAGE_SCRIPTS: ReadonlySet<string> = new Set(["background.js", "popup.js"]);

/** Output file name -> entry point. The names are the contract with manifest.json. */
export const EXTENSION_ENTRIES = {
  "background.js": "src/background/main.ts",
  "content.js": "src/content/main.ts",
  "trace-interceptor.js": "src/page/trace-interceptor.ts",
  "dialog-interceptor.js": "src/page/dialog-interceptor.ts",
  "console-interceptor.js": "src/page/console-interceptor.ts",
  "network-interceptor.js": "src/page/network-interceptor.ts",
  "file-drop.js": "src/page/file-drop.ts",
  "popup.js": "src/popup/main.ts",
} as const;

export const APP_ENTRIES = {
  "Script.js": "src/app/main.ts",
} as const;

const script = (output: string, entry: string, outDir: string): UserConfig => ({
  name: output,
  entry: { [output.replace(/\.js$/, "")]: entry },
  outDir,
  format: "iife",
  platform: "browser",
  // Safari 17 is the oldest supported release. Matching it keeps the bundler
  // from down-levelling async functions and arrows, which matters for the
  // functions the background serialises into pages with
  // scripting.executeScript: a helper reference in their source would not
  // exist on the other side.
  target: "safari17",
  // Plain names, not `.iife.js`: the manifest and re-injection name these files.
  outputOptions: { entryFileNames: "[name].js" },
  hash: false,
  dts: false,
  // Readable output, as the hand-written scripts were: these are debugged in
  // Safari's Web Inspector, and the page-world scripts are small anyway.
  minify: false,
  sourcemap: false,
  // Every config writes into a shared directory, so none of them may clean it;
  // `pnpm build` empties dist/ once before building them all.
  clean: false,
  logLevel: "warn",
  deps: EXTENSION_PAGE_SCRIPTS.has(output)
    ? // Bundled whole: an IIFE cannot import anything at run time.
      { alwaysBundle: ["effect"], onlyBundle: ["effect"] }
    : // Content and page-world scripts are injected into every page and frame,
      // so they carry no dependencies at all. The build fails if one creeps in.
      { onlyBundle: [] },
});

export default defineConfig([
  ...Object.entries(EXTENSION_ENTRIES).map(([output, entry]) => script(output, entry, "dist/extension")),
  ...Object.entries(APP_ENTRIES).map(([output, entry]) => script(output, entry, "dist/app")),
]);
