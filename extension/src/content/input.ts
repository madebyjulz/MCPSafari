/**
 * Clicking and entering values: clicks, React-compatible value setting,
 * typing, form fills and select options.
 */

import type { ContentParams } from "../shared/protocol.ts";
import { asPageElement, firesKeypress, pointerEvent, toolError, type PageElement, type ThrownError } from "./core.ts";
import { deepQueryFirst } from "./snapshot.ts";
import { assertReachable, resolveElement, scrollToTarget, type TargetParams } from "./target.ts";

export interface ClickParams extends TargetParams {
  readonly x?: number;
  readonly y?: number;
  readonly doubleClick?: boolean;
  readonly force?: boolean;
}

export interface TypeTextParams extends TargetParams {
  readonly clearFirst?: boolean;
  readonly submitKey?: string;
}

export interface FormInputParams extends ContentParams {
  /** CSS selector -> value. */
  readonly fields?: Readonly<Record<string, string>>;
}

export interface SelectOptionParams extends TargetParams {
  readonly value?: string;
  readonly label?: string;
}

/** A point in viewport coordinates. */
interface ViewportPoint {
  readonly x: number;
  readonly y: number;
}

// ─── Click ───────────────────────────────────────────────────────

export function clickElement(params: ClickParams): string {
  // Click by coordinates
  if (params.x !== undefined && params.y !== undefined) {
    const hit = document.elementFromPoint(params.x, params.y);

    if (!hit)
      throw toolError(
        "target_not_found",
        `No element at coordinates (${params.x}, ${params.y})`,
        false,
        "take_snapshot",
      );

    const el = asPageElement(hit);
    simulateClick(el, params.doubleClick, { x: params.x, y: params.y });

    return `Clicked element at (${params.x}, ${params.y}): <${el.tagName.toLowerCase()}>`;
  }

  // Click by selector or text
  const el = resolveElement(params);

  if (!el) {
    throw toolError("invalid_input", "click requires uid, selector, text, or x and y", false, "fix_input");
  }

  const point = scrollToTarget(el);

  if (!params.force) assertReachable(el, point);
  simulateClick(el, params.doubleClick, point);

  const desc = el.tagName.toLowerCase();

  return `Clicked <${desc}>${el.textContent ? ': "' + el.textContent.trim().substring(0, 50) + '"' : ""}`;
}

function simulateClick(element: PageElement, doubleClick: boolean | undefined, point: ViewportPoint): void {
  const { x, y } = point;

  const eventOpts = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: 0,
  };

  const pointerOpts = { ...eventOpts, pointerId: 1, pointerType: "mouse", isPrimary: true };

  // Real pointer order: pointer family first. Cancelling pointerdown
  // suppresses the compatibility mouse events and the focus change, which
  // is how pointer-driven toggles (Radix, Headless UI) keep a click from
  // re-toggling what pointerdown just opened.
  const press = () => {
    const pressed = element.dispatchEvent(pointerEvent("pointerdown", { ...pointerOpts, buttons: 1 }));

    if (pressed && element.dispatchEvent(new MouseEvent("mousedown", { ...eventOpts, buttons: 1 }))) {
      element.focus();
    }

    element.dispatchEvent(pointerEvent("pointerup", pointerOpts));

    if (pressed) element.dispatchEvent(new MouseEvent("mouseup", eventOpts));
    element.dispatchEvent(new MouseEvent("click", eventOpts));
  };

  element.dispatchEvent(pointerEvent("pointerover", pointerOpts));
  element.dispatchEvent(new MouseEvent("mouseover", eventOpts));
  press();

  if (doubleClick) {
    press();
    element.dispatchEvent(new MouseEvent("dblclick", eventOpts));
  }
}

// ─── React-Compatible Value Setting ─────────────────────────────

/** How a value reaches an element, by the kind of control it is. */
type ValueKind = "editable" | "select" | "checkable" | "text";

// Single-line text fields: where typing goes, and where Enter submits the form.
const TEXT_INPUT_TYPES = new Set<string | undefined>(["text", "search", "url", "tel", "email", "password", "number"]);

const CHECKABLE_TYPES = new Set<string | undefined>(["checkbox", "radio"]);

function valueKind(el: PageElement): ValueKind | null {
  if (el.isContentEditable) return "editable";

  const tag = el.tagName.toLowerCase();

  if (tag === "select") return "select";

  if (tag === "textarea") return "text";

  if (tag === "input") return CHECKABLE_TYPES.has(el.type) ? "checkable" : "text";

  return null;
}

function setInputValue(el: PageElement, value: string, append = false): void {
  const kind = valueKind(el);

  switch (kind) {
    case "editable":
      setEditableText(el, value, append);

      return;
    case "select":
      // A choice replaces the selection; there is nothing to append to.
      setSelectValue(el, value);

      return;
    case "checkable":
      setChecked(el, value);

      return;
    case "text":
      setTextValue(el, append ? el.value + value : value);

      return;
    case null:
      throw toolError(
        "target_not_found",
        `<${el.tagName.toLowerCase()}> does not take a value; target an input, textarea, select, or contenteditable element`,
        false,
        "take_snapshot",
      );
  }
}

/** A control prototype carrying the native accessors React shadows on its instances. */
type ControlPrototype = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

// React overrides the `value` property on each control it renders, so
// assigning `el.value` updates its tracker and onChange never fires. The
// setter from the control's own prototype bypasses that. It has to be that
// prototype: another element type's setter throws "Illegal invocation".
function nativeSetter(
  proto: ControlPrototype,
  property: "value" | "checked",
): ((this: PageElement, value: string | boolean) => void) | undefined {
  // oxlint-disable-next-line typescript/unbound-method -- the setter is invoked with .call(el) by the callers
  return Object.getOwnPropertyDescriptor(proto, property)?.set;
}

function dispatchInputAndChange(el: PageElement): void {
  // Dispatch events that React and other frameworks listen for
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function setTextValue(el: PageElement, value: string): void {
  const proto = el.tagName.toLowerCase() === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = nativeSetter(proto, "value");

  if (setter) {
    setter.call(el, value);
  } else {
    el.value = value;
  }

  dispatchInputAndChange(el);
}

// Assigning a value no option has clears the selection instead of throwing,
// so the result is checked and the previous selection put back on a miss.
function setSelectValue(el: PageElement, value: string): void {
  const setter = nativeSetter(HTMLSelectElement.prototype, "value");
  const previous = el.value;

  const assign = (next: string | undefined) => {
    if (setter) setter.call(el, next ?? "");
    else el.value = next;
  };

  assign(value);

  if (el.value !== value) {
    assign(previous);

    throw toolError("target_not_found", `No option with value "${value}" in <select>`, false, "take_snapshot");
  }

  dispatchInputAndChange(el);
}

// Words that mean "unchecked"; any other value checks the box.
const UNCHECKED_VALUES = new Set(["", "false", "0", "off", "no", "unchecked"]);

// A checkbox's `value` is what the form submits, not whether it is ticked.
// React reads a checkbox or radio change from its click event, so a state
// change goes through click(), which toggles, fires input and change, and
// leaves the page free to refuse it. A radio cannot be unticked by a click,
// so that one case sets `checked` through the native setter instead.
function setChecked(el: PageElement, value: string): void {
  const wanted = !UNCHECKED_VALUES.has(value.trim().toLowerCase());

  if (el.checked === wanted) return;

  if (wanted || el.type !== "radio") {
    el.click();
  } else {
    const setter = nativeSetter(HTMLInputElement.prototype, "checked");

    if (setter) setter.call(el, false);
    else el.checked = false;
    dispatchInputAndChange(el);
  }

  if (el.checked !== wanted) {
    throw toolError(
      "input_not_applied",
      `<input type="${el.type}"> stayed ${el.checked ? "checked" : "unchecked"}; the page blocked the change`,
      false,
      "take_snapshot",
    );
  }
}

// Model-backed editors (ProseMirror, Lexical, Slate) apply edits from the
// inputType/data on beforeinput/input and re-render from their own
// document, discarding direct DOM mutation. execCommand("insertText")
// produces those events, so the edit survives; a bare `input` carrying
// neither field does not.
function setEditableText(el: PageElement, value: string, append: boolean): void {
  if (append && value === "") return;

  // A frame's window always has a selection; null is only for a window
  // without a browsing context, which no content script runs in.
  const selection = window.getSelection()!;
  const caretInside = selection.rangeCount > 0 && el.contains(selection.getRangeAt(0).startContainer);

  if (!append || !caretInside) {
    const range = document.createRange();
    range.selectNodeContents(el);

    if (append) range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  const applied =
    value === "" ? document.execCommand("delete", false) : document.execCommand("insertText", false, value);

  if (applied) return;

  // execCommand returns false when the edit is refused (e.g. a canceled
  // beforeinput); synthesize the same edit shape ourselves.
  const detail = {
    bubbles: true,
    inputType: value === "" ? "deleteContentBackward" : "insertText",
    data: value || null,
  };

  const before = new InputEvent("beforeinput", { ...detail, cancelable: true });

  if (el.dispatchEvent(before)) {
    el.textContent = append ? el.textContent + value : value;
  }

  el.dispatchEvent(new InputEvent("input", detail));
}

// ─── Type Text ───────────────────────────────────────────────────

export function prepareNativeInput(params: TargetParams): string {
  const target = params.uid || params.selector ? resolveElement(params) : document.activeElement;

  if (!target) {
    throw toolError("target_not_found", "No element to type into", false, "take_snapshot");
  }

  const el = asPageElement(target);
  const tag = el.tagName.toLowerCase();
  const isTextInput = tag === "textarea" || (tag === "input" && TEXT_INPUT_TYPES.has(el.type));

  if ((!isTextInput && !el.isContentEditable) || el.disabled || el.readOnly) {
    throw toolError(
      "unsupported_native_target",
      `Native typing requires an editable text control; received <${tag}>`,
      false,
      "use_synthetic_input",
    );
  }

  el.scrollIntoView({ block: "center", inline: "center" });
  el.focus({ preventScroll: true });

  if (document.activeElement !== el && !el.contains(document.activeElement)) {
    throw toolError("native_input_focus_failed", `Could not focus <${tag}> for native typing`, true, "retry");
  }

  return `Focused <${tag}> for native typing`;
}

export function typeText(params: TypeTextParams): string {
  const target = params.uid || params.selector ? resolveElement(params) : document.activeElement;

  if (!target) {
    throw toolError("target_not_found", "No element to type into", false, "take_snapshot");
  }

  const el = asPageElement(target);
  el.focus();

  const kind = valueKind(el);
  const readBack = () => (el.isContentEditable ? el.textContent : el.value);
  const before = readBack();

  if (params.clearFirst) {
    setInputValue(el, "", false);
  }

  const text = params.text || "";
  setInputValue(el, text, !params.clearFirst);

  // An editor that re-renders from its own model can discard the edit
  // after reporting nothing; success must mean the content changed.
  // A detached element cannot be re-read meaningfully, and clearFirst
  // with identical text legitimately produces no difference. A select or
  // checkbox has already verified its own result, and choosing what is
  // already chosen changes nothing.
  const unchanged =
    (kind === "editable" || kind === "text") &&
    text !== "" &&
    el.isConnected !== false &&
    readBack() === before &&
    !(params.clearFirst && text === before);

  if (unchanged) {
    throw toolError(
      "input_not_applied",
      `Typing did not change <${el.tagName.toLowerCase()}>; the page discarded or blocked the input`,
      false,
      "use_native_input",
    );
  }

  // Press a key after typing (e.g., Enter, Tab)
  if (params.submitKey) {
    const keyOpts = {
      key: params.submitKey,
      code: params.submitKey,
      bubbles: true,
      cancelable: true,
    };

    let proceed = el.dispatchEvent(new KeyboardEvent("keydown", keyOpts));

    if (firesKeypress(params.submitKey, keyOpts)) {
      proceed = el.dispatchEvent(new KeyboardEvent("keypress", keyOpts)) && proceed;
    }

    el.dispatchEvent(new KeyboardEvent("keyup", keyOpts));

    // Enter submits the form only where a browser would: from a single-line
    // field, and only if the page let the key through. In a textarea Enter
    // is a newline, and a page that cancels it is handling Enter itself.
    const singleLine = el.tagName.toLowerCase() === "input" && TEXT_INPUT_TYPES.has(el.type);

    if (params.submitKey === "Enter" && proceed && singleLine && el.form) {
      el.form.requestSubmit();
    }
  }

  return `Typed "${text}" into <${el.tagName.toLowerCase()}>${params.submitKey ? ` then pressed ${params.submitKey}` : ""}`;
}

// ─── Form Input ──────────────────────────────────────────────────

export function formInput(params: FormInputParams): string {
  const entries = Object.entries(params.fields || {});

  if (entries.length === 0) {
    throw toolError("invalid_input", "form_input requires at least one CSS selector and value", false, "fix_input");
  }

  const results: Array<string> = [];
  const missing: Array<string> = [];
  const failures: Array<ThrownError> = [];

  for (const [selector, value] of entries) {
    const el = deepQueryFirst(selector);

    if (!el) {
      missing.push(selector);
      results.push(`${selector}: not found`);
      continue;
    }

    // One field the page refuses must not abandon the rest halfway: each
    // field reports its own outcome, and the ones before it stay filled.
    try {
      el.focus();
      setInputValue(el, value, false);
      results.push(`${selector}: filled`);
    } catch (cause) {
      // SAFETY: a field fails with a ToolError raised above or a DOM exception; both are Errors.
      const failure = cause as ThrownError;
      failures.push(failure);
      // oxlint-disable-next-line typescript/no-base-to-string -- a rejection that is not an Error is reported as its own string form, as the dispatcher does
      results.push(`${selector}: failed (${String(failure.message || failure)})`);
    }
  }

  // A partial fill still reports per-field results, but filling nothing is a
  // failure rather than a success whose body happens to say "not found".
  if (missing.length === entries.length) {
    throw toolError("target_not_found", `No form fields matched: ${missing.join(", ")}`, false, "take_snapshot");
  }

  if (missing.length + failures.length === entries.length) {
    // The first failure's code, when it has one of ours: a DOMException's
    // `code` is a legacy number, not a ToolErrorCode.
    const first = failures[0];
    const code = typeof first?.code === "string" ? first.code : "input_not_applied";
    const recovery = typeof first?.recoveryAction === "string" ? first.recoveryAction : "take_snapshot";

    throw toolError(code, `No form fields were filled:\n${results.join("\n")}`, false, recovery);
  }

  return results.join("\n");
}

// ─── Select Option ───────────────────────────────────────────────

export function selectOption(params: SelectOptionParams): string {
  const el = resolveElement(params);

  if (!el) {
    throw toolError("invalid_input", "select_option requires uid or selector", false, "fix_input");
  }

  if (el.tagName.toLowerCase() !== "select") {
    throw toolError(
      "target_not_found",
      `Element is not a <select>: <${el.tagName.toLowerCase()}>`,
      false,
      "take_snapshot",
    );
  }

  if (params.value === undefined && !params.label) {
    throw toolError("invalid_input", "select_option requires value or label", false, "fix_input");
  }

  if (params.value !== undefined) {
    // Assigning an unmatched value clears the selection instead of
    // throwing, so verify it took rather than reporting a silent no-op.
    const previous = el.value;
    el.value = params.value;

    if (el.value !== String(params.value)) {
      el.value = previous;

      throw toolError("target_not_found", `No option with value "${params.value}" in <select>`, false, "take_snapshot");
    }
  } else {
    // A <select> always has an options collection; the tag check above
    // established that this is one.
    const option = Array.from(el.options!).find((o) => o.textContent.trim() === params.label);

    if (!option) {
      throw toolError("target_not_found", `Option with label "${params.label}" not found`, false, "take_snapshot");
    }

    el.value = option.value;
  }

  el.dispatchEvent(new Event("change", { bubbles: true }));
  const target = params.uid || params.selector || params.label || "select";

  return `Selected option in ${target}`;
}
