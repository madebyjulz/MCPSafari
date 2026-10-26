// What the host app's page and ViewController.swift say to each other. The
// other side is Swift, so nothing here is checked against it at compile time:
// the page decodes every value Swift hands it, and Swift matches these names by
// hand.

import { Schema } from "effect";

/** Posted to `webkit.messageHandlers.controller`; ViewController.swift switches on these. */
export const ControllerMessage = Schema.Literals(["open-preferences", "enable-native-input"]);

export type ControllerMessage = typeof ControllerMessage.Type;

/**
 * `show(...)`: whether Safari reports the extension enabled. Null means Safari
 * would not give an answer, which is not the same as "not enabled".
 */
export const ExtensionState = Schema.NullOr(Schema.Boolean);

export type ExtensionState = typeof ExtensionState.Type;

/** `showPreferencesError(...)`: Safari's own description of why it refused. */
export const PreferencesError = Schema.String;
