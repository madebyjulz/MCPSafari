// Text for the host app's page. Pure functions of what Swift reported, so they
// can be checked without a web view.

import { Option } from "effect";
import type { ExtensionState } from "./contract.ts";

/** The body classes that pick which status label Main.html shows. */
export const stateClasses = (enabled: ExtensionState) => ({
  "state-on": enabled === true,
  "state-off": enabled === false,
  "state-error": enabled === null,
});

// Safari can refuse to open its own settings pane, in which case nothing
// happens on screen and the button reads as broken. Say so instead, with
// Safari's reason when there is one.
export const preferencesErrorText = (reason: Option.Option<string>): string =>
  Option.match(reason, {
    onNone: () => "Safari would not open its settings. Open Safari > Settings > Extensions yourself.",
    onSome: (message) => `Safari would not open its settings: ${message} Open Safari > Settings > Extensions yourself.`,
  });
