import assert from "node:assert/strict";
import vm from "node:vm";
import { test } from "vitest";
import { builtAppScript } from "./helpers/sources.ts";

const appHarness = () => {
  const classes = new Set<string>();
  const messages: Array<string> = [];
  const listeners = new Map<string, () => void>();
  const window: Record<string, unknown> = {};

  const context = vm.createContext({
    window,
    document: {
      body: {
        classList: {
          toggle: (name: string, enabled: boolean) => (enabled ? classes.add(name) : classes.delete(name)),
        },
      },
      querySelector: (selector: string) => ({
        addEventListener: (event: string, listener: () => void) => listeners.set(`${selector}:${event}`, listener),
      }),
    },
    webkit: {
      messageHandlers: {
        controller: {
          postMessage: (message: string) => messages.push(message),
        },
      },
    },
  });

  vm.runInContext(builtAppScript("Script.js"), context);

  return { classes, listeners, messages, window };
};

test("Accessibility button opens settings guidance", () => {
  const { listeners, messages } = appHarness();

  listeners.get("button.enable-native-input:click")?.();

  assert.deepEqual(messages, ["enable-native-input"]);
});

test("the preferences button asks the app to open Safari's settings", () => {
  const { listeners, messages } = appHarness();

  listeners.get("button.open-preferences:click")?.();

  assert.deepEqual(messages, ["open-preferences"]);
});

test("Swift can still call show by name, and an unknown state is not shown as off", () => {
  const { classes, window } = appHarness();
  const show = window["show"];

  assert.equal(typeof show, "function");

  // SAFETY: just checked to be a function; this is the global ViewController.swift calls.
  (show as (enabled: boolean | null) => void)(null);

  assert.deepEqual([...classes], ["state-error"]);
});
