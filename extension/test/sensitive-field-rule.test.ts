// The rule for which form fields hold secrets. The snapshot applies it in the
// content script's isolated world and the trace interceptor in the page's own
// world; both bundle the one module, so it is tested once, here, on the plain
// descriptions both of them build.

import assert from "node:assert/strict";
import { test } from "vitest";

import { isSensitiveField, type FieldDescription } from "../src/shared/sensitive-field.ts";
import { builtScript } from "./helpers/sources.ts";

const CASES: ReadonlyArray<readonly [FieldDescription, boolean]> = [
  [{ tag: "input", type: "password", autocomplete: null, hints: [] }, true],
  [{ tag: "input", type: "PASSWORD", autocomplete: null, hints: [] }, true],
  [{ tag: "input", type: "text", autocomplete: "section-x cc-csc", hints: [] }, true],
  [{ tag: "input", type: "text", autocomplete: "one-time-code", hints: [] }, true],
  [{ tag: "textarea", type: undefined, autocomplete: null, hints: ["recovery_secret"] }, true],
  [{ tag: "input", type: "text", autocomplete: null, hints: ["confirmPassword"] }, true],
  [{ tag: "input", type: "tel", autocomplete: null, hints: [null, "", "Enter your PIN"] }, true],
  [{ tag: "input", type: "text", autocomplete: null, hints: ["OTPCode"] }, true],
  [{ tag: "input", type: "text", autocomplete: null, hints: ["shipping"] }, false],
  [{ tag: "input", type: "text", autocomplete: null, hints: ["passenger", "compass", "bypass"] }, false],
  [{ tag: "input", type: "checkbox", autocomplete: null, hints: ["remember_token"] }, false],
  [{ tag: "input", type: "submit", autocomplete: null, hints: ["token"] }, false],
  [{ tag: "div", type: "password", autocomplete: null, hints: ["token"] }, false],
  [{ tag: "select", type: "text", autocomplete: "cc-number", hints: [] }, false],
];

test("fields are classified by type, autocomplete and the words their hints contain", () => {
  for (const [field, expected] of CASES) {
    assert.equal(
      isSensitiveField(field),
      expected,
      `${JSON.stringify(field)} should be ${expected ? "sensitive" : "readable"}`,
    );
  }
});

// The point of one module: both worlds carry the rule, so neither can drift.
test("the content script and the trace interceptor both bundle the rule", () => {
  for (const file of ["content.js", "trace-interceptor.js"]) {
    assert.match(builtScript(file), /function isSensitiveField\(/, `${file} carries the rule`);
  }
});
