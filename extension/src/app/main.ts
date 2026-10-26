// The host app's page (MCPSafari/Resources/Base.lproj/Main.html). Swift calls
// `show(...)` and `showPreferencesError(...)` by name through
// `evaluateJavaScript`, so they have to stay globals.

import { Effect, Option, Schema } from "effect";
import { ExtensionState, PreferencesError, type ControllerMessage } from "./contract.ts";
import { preferencesErrorText, stateClasses } from "./render.ts";

declare global {
  interface Window {
    show: (enabled: ExtensionState) => void;
    showPreferencesError: (reason: string) => void;
  }
}

// Swift builds these calls as script text, so the types above are what it is
// meant to send, not what it is held to.
const decodeExtensionState = Schema.decodeUnknownOption(ExtensionState);

const decodePreferencesError = Schema.decodeUnknownOption(PreferencesError);

const element = (selector: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(selector);

  if (!found) throw new Error(`Main.html has no ${selector}`);

  return found;
};

const post = (message: ControllerMessage) => Effect.sync(() => webkit.messageHandlers.controller.postMessage(message));

const showState = (enabled: ExtensionState) =>
  Effect.sync(() => {
    for (const [name, on] of Object.entries(stateClasses(enabled))) document.body.classList.toggle(name, on);
  });

const showPreferencesError = (reason: Option.Option<string>) =>
  Effect.sync(() => {
    const note = element(".preferences-note");

    note.textContent = preferencesErrorText(reason);
    note.hidden = false;
  });

/** Wires the buttons, and the globals Swift calls. */
const page = Effect.sync(() => {
  // A value Swift was never meant to send is not an answer either, so it
  // shows as "can't tell" rather than as either state.
  window.show = (enabled) => Effect.runSync(showState(Option.getOrNull(decodeExtensionState(enabled))));

  window.showPreferencesError = (reason) => Effect.runSync(showPreferencesError(decodePreferencesError(reason)));

  element("button.open-preferences").addEventListener("click", () => Effect.runSync(post("open-preferences")));

  element("button.enable-native-input").addEventListener("click", () => Effect.runSync(post("enable-native-input")));
});

Effect.runSync(page);
