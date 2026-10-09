/** Dialog automation is opt-in: handle_dialog arms one dialog for 30 seconds. */

import { errorText, onContentMessage, postReply } from "./channel.ts";
import type { CapturedDialog, DialogParams, DialogResult, DialogType } from "./window.ts";

/**
 * Any one of window.alert, confirm and prompt. The interceptor only stores,
 * compares and swaps them, so each must fit every one of the three slots.
 */
type DialogFunction = Window["alert"] & Window["confirm"] & Window["prompt"];

/** What page code passes a dialog: the message, and for prompt the default answer. */
type DialogArguments = [message?: string, defaultValue?: string];

interface DialogPolicy {
  readonly action: "accept" | "dismiss";
  readonly promptText: string | null;
  readonly expiresAt: number;
}

const DIALOG_TYPES: ReadonlyArray<DialogType> = ["alert", "confirm", "prompt"];

/** What an intercepted dialog returns when it is not an accepted prompt. */
function fixedResult(type: DialogType, action: DialogPolicy["action"]): boolean | null | undefined {
  if (type === "alert") return undefined;

  if (type === "confirm") return action === "accept";

  return null;
}

function installDialogInterceptor(): void {
  const MAX_DIALOGS = 100;
  const MAX_TEXT = 4096;
  const capturedDialogs: Array<CapturedDialog> = [];
  let droppedDialogs = 0;
  let policy: DialogPolicy | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // SAFETY: wrappers only call into originals after __mcpHandleDialog has
  // filled it, because they are only reachable once it has armed them.
  let originals = {} as Record<DialogType, DialogFunction>;
  // SAFETY: the loop below fills every dialog type before anything reads it.
  const wrappers = {} as Record<DialogType, DialogFunction>;
  const bounded = (value: string | null | undefined) => String(value ?? "").slice(0, MAX_TEXT);

  function restore(): void {
    clearTimeout(timer);
    policy = null;

    for (const type of DIALOG_TYPES) {
      // Do not overwrite a patch installed by the page after ours.
      if (window[type] === wrappers[type]) window[type] = originals[type];
    }
  }

  for (const type of DIALOG_TYPES) {
    // SAFETY: page code may call the wrapper in place of any of the three
    // dialogs, and it answers in kind: nothing for alert, a choice for
    // confirm, text or null for prompt.
    wrappers[type] = function (this: Window, ...args: DialogArguments): DialogResult {
      const current = policy;

      if (!current || Date.now() >= current.expiresAt) {
        restore();

        return originals[type].apply(this, args);
      }

      // Consume before calling anything page-controlled or re-entrant.
      restore();

      // An accepted prompt answers with text; every other dialog answers with a fixed value.
      const answer =
        type === "prompt" && current.action === "accept" ? (current.promptText ?? String(args[1] ?? "")) : null;

      const result = answer ?? fixedResult(type, current.action);
      const message = String(args[0] ?? "");
      const defaultValue = type === "prompt" ? String(args[1] ?? "") : null;

      if (capturedDialogs.length >= MAX_DIALOGS) {
        capturedDialogs.shift();
        droppedDialogs++;
      }

      capturedDialogs.push({
        type,
        message: bounded(message),
        defaultValue: defaultValue === null ? null : bounded(defaultValue),
        result: answer === null ? result : bounded(answer),
        truncated:
          message.length > MAX_TEXT ||
          (defaultValue?.length ?? 0) > MAX_TEXT ||
          (answer !== null && answer.length > MAX_TEXT),
      });

      return result;
    } as DialogFunction;
  }

  window.__mcpHandleDialog = (params: DialogParams = {}) => {
    // Reading a captured result must not silently arm another interception.
    if (capturedDialogs.length) {
      const dialog = capturedDialogs.shift();
      const dropped = droppedDialogs;
      droppedDialogs = 0;

      return { handled: true, ...dialog, alreadyHandled: true, droppedDialogs: dropped };
    }

    restore();
    // SAFETY: the entries cover exactly the three dialog types, each paired with its own window function.
    originals = Object.fromEntries(DIALOG_TYPES.map((type) => [type, window[type]])) as Record<
      DialogType,
      DialogFunction
    >;
    policy = {
      action: params.action === "accept" ? "accept" : "dismiss",
      promptText: params.promptText == null ? null : bounded(params.promptText),
      expiresAt: Date.now() + 30_000,
    };

    for (const type of DIALOG_TYPES) window[type] = wrappers[type];
    timer = setTimeout(restore, 30_000);

    return { handled: false, armed: true, expiresInMs: 30_000, dialogsRemaining: 1 };
  };

  window.__mcpGetPendingDialogs = () => capturedDialogs.map((dialog) => ({ ...dialog }));
  window.addEventListener("pagehide", restore);

  onContentMessage<DialogParams>((message) => {
    if (message.type !== "handle_dialog") return;

    // The page can replace __mcpHandleDialog; a failure is still an answer,
    // so the content script is not left waiting out its timeout.
    try {
      postReply(message.id, { data: window.__mcpHandleDialog(message.params || {}) });
    } catch (error) {
      postReply(message.id, { error: errorText(error) });
    }
  });
}

if (!window.__mcpDialogInterceptorLoaded) {
  window.__mcpDialogInterceptorLoaded = true;
  installDialogInterceptor();
}
