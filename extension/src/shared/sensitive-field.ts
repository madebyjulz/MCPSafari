// Which form fields hold secrets. The snapshot applies this in the content
// script's isolated world, to withhold a field's value, and the trace
// interceptor in the page's own world, to withhold its attribute values. Each
// bundle carries its own copy of this module, so the two always agree.
//
// A pure function of what a field says about itself, with no DOM access, so it
// runs the same in either world and is tested on plain descriptions. Imported
// by page-injected code, so it may not pull in a runtime dependency.

/** The autocomplete tokens browsers use for secrets. */
const SENSITIVE_AUTOCOMPLETE: ReadonlySet<string> = new Set([
  "current-password",
  "new-password",
  "one-time-code",
  "cc-number",
  "cc-csc",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year",
]);

// A name or label is only a hint, so short words must match whole (`pin` is a
// secret, `shipping` is not) and long ones may sit inside a longer run
// (`newpassword`, `confirmPassword`).
const SECRET_HINT_WORDS: ReadonlySet<string> = new Set([
  "pass",
  "pwd",
  "pin",
  "otp",
  "cvv",
  "cvc",
  "cvn",
  "ssn",
  "secret",
  "token",
  "2fa",
]);

const SECRET_HINT_FRAGMENTS: ReadonlyArray<string> = [
  "password",
  "passwd",
  "passcode",
  "passphrase",
  "pincode",
  "secret",
  "token",
  "onetime",
];

/** Input types that carry a label or a fixed value rather than something typed. */
const NON_SECRET_TYPES: ReadonlySet<string> = new Set([
  "button",
  "submit",
  "reset",
  "image",
  "checkbox",
  "radio",
  "file",
  "range",
  "color",
]);

/** A form field as the rule reads it: its tag, type and autocomplete, and the attributes that hint at its purpose. */
export interface FieldDescription {
  /** Lower-case tag name. */
  readonly tag: string;
  readonly type: string | null | undefined;
  readonly autocomplete: string | null | undefined;
  /** Name, id, aria-label, inputmode and the like; absent ones may be null or empty. */
  readonly hints: ReadonlyArray<string | null | undefined>;
}

// Splits camelCase and acronyms (`OTPCode` -> `otp code`) as well as
// punctuation, so a hint reads as the words a person would see in it.
function hintLooksSecret(hint: string): boolean {
  const words = hint
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  const joined = words.join("");

  return (
    words.some((word) => SECRET_HINT_WORDS.has(word)) ||
    SECRET_HINT_FRAGMENTS.some((fragment) => joined.includes(fragment))
  );
}

/** Whether a field's contents must never leave the page. Only inputs and textareas hold typed secrets. */
export function isSensitiveField({ tag, type, autocomplete, hints }: FieldDescription): boolean {
  if (tag !== "input" && tag !== "textarea") return false;

  const kind = String(type || "").toLowerCase();

  if (kind === "password") return true;

  const tokens = String(autocomplete || "")
    .toLowerCase()
    .split(/\s+/);

  if (tokens.some((token) => SENSITIVE_AUTOCOMPLETE.has(token))) return true;

  if (tag === "input" && NON_SECRET_TYPES.has(kind)) return false;

  return hints.some((hint) => Boolean(hint) && hintLooksSecret(String(hint)));
}
