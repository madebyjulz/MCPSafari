import { defineConfig } from "oxlint";
import { recommended } from "@effect/tsgo/oxlint-presets";

export default defineConfig({
  extends: [recommended],
  ignorePatterns: ["**/node_modules/**", "**/dist/**", "tools/oxlint/anti-slop/**", "MCPServer/**", "MCPSafari/**"],
  jsPlugins: [
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
    { name: "anti-slop-effect", specifier: "./tools/oxlint/anti-slop/effect/index.ts" },
  ],
  rules: {
    "oxc/no-accumulating-spread": "error",
    "anti-slop/no-array-filter-map": "error",
    "anti-slop/no-reduce-accumulator-copy": "error",
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-readable-spacing": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
    "anti-slop-effect/no-manual-effect-error-tag": "error",
    "anti-slop-effect/no-manual-tag-comparison": "error",
    "anti-slop-effect/no-manual-tagged-construction": "error",
    "anti-slop-effect/no-service-constructor-imports": "error",
    "anti-slop-effect/prefer-effect-match": "error",
  },
  overrides: [
    {
      // Code that runs inside web pages: the page-world interceptors, the
      // content script, and the functions the background serialises into a
      // page. It carries no dependencies, so there is no Schema or Match to
      // decode page values with; plain runtime checks are the boundary.
      files: ["extension/src/page/**", "extension/src/content/**", "extension/src/background/injected.ts"],
      rules: {
        "anti-slop/no-runtime-typeof": "off",
        "anti-slop/no-unknown-parameters": "off",
        "anti-slop/no-unknown-returns": "off",
        "anti-slop-effect/prefer-effect-match": "off",
        "anti-slop-effect/no-manual-tag-comparison": "off",
        // The fix it suggests is iterator helpers, which need Safari 18.4;
        // these scripts target Safari 17.
        "anti-slop/no-array-filter-map": "off",
      },
    },
    {
      // Test doubles: partial fakes of Safari's APIs and the page's DOM, which
      // stand in for platform types they only implement a slice of.
      files: ["extension/test/**"],
      rules: {
        "anti-slop/no-chained-type-assertions": "off",
        "anti-slop/no-unsafe-dictionary-type": "off",
        "anti-slop/no-runtime-typeof": "off",
        "anti-slop/no-unknown-returns": "off",
      },
    },
    {
      // The release and CI scripts carry no runtime dependencies either: Node
      // runs them as they are, so there is no Schema or Match to decode the
      // JSON they read with, and plain runtime checks are the boundary.
      files: ["scripts/**"],
      rules: {
        "anti-slop/no-runtime-typeof": "off",
        "anti-slop/no-unknown-parameters": "off",
        "anti-slop/no-unknown-returns": "off",
        "anti-slop-effect/prefer-effect-match": "off",
        "anti-slop-effect/no-manual-tag-comparison": "off",
      },
    },
  ],
});
