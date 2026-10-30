// `captureVisibleTab` takes a window and returns whichever tab is showing, so a
// user clicking another tab between the activation and the capture gets the
// wrong page's pixels labelled as the right one. `showing` is that tab.

import assert from "node:assert/strict";
import { Effect, Result } from "effect";
import { afterEach, test } from "vitest";

import { focusTabForNativeInput } from "../src/background/tools/tabs.ts";
import { fakeBrowser, launch, stopAll } from "./helpers/fake-browser.ts";

afterEach(stopAll);

interface WindowState {
  showing: number;
  captures: number;
  readonly queries: Array<{ readonly active?: boolean; readonly windowId?: number }>;
}

function loadBackground({
  showing = 1,
  afterActivate = () => {},
  afterCapture = () => {},
}: {
  readonly showing?: number;
  readonly afterActivate?: (state: WindowState) => void;
  readonly afterCapture?: (state: WindowState) => void;
} = {}) {
  const state: WindowState = { showing, captures: 0, queries: [] };
  const api = fakeBrowser();

  api.scripting.executeScript = async () => [{ result: { visible: true, hasFocus: true } }];
  api.tabs.get = async (id) => ({ id, active: id === state.showing, windowId: 9, url: "https://ok.example/" });
  // SAFETY: the background only ever filters on `active` and `windowId` here.
  api.tabs.query = (async (filter: { readonly active?: boolean; readonly windowId?: number } = {}) => {
    state.queries.push({ ...filter });

    return [{ id: state.showing, active: true, windowId: filter.windowId }];
  }) as typeof api.tabs.query;
  api.tabs.update = async (id) => {
    state.showing = id;
    afterActivate(state);
  };

  api.tabs.captureVisibleTab = async () => {
    state.captures += 1;
    afterCapture(state);

    return "data:image/png;base64,AAAB";
  };

  const { harness, request } = launch(api);

  return {
    state,
    request,
    focusForNativeInput: (tabId: number) => harness.run(Effect.result(focusTabForNativeInput(tabId))),
  };
}

test("a screenshot of the tab showing in its window is captured", async () => {
  const { state, request } = loadBackground({ showing: 1 });

  const response = await request("screenshot", { tabId: 1 });

  assert.equal(JSON.parse(response.data ?? "{}").image, "AAAB");
  assert.equal(state.captures, 1);
  // The window's own answer is what is asked for, not the tab's claim.
  assert.ok(state.queries.length > 0);
  assert.ok(state.queries.every((query) => query.active === true && query.windowId === 9));
});

test("a screenshot is not taken if the user switched tabs after the activation", async () => {
  // Tab 1 is activated, then the user clicks tab 2 during the settle wait.
  const { state, request } = loadBackground({
    showing: 2,
    afterActivate: (current) => {
      current.showing = 2;
    },
  });

  const response = await request("screenshot", { tabId: 1 });

  assert.equal(response.errorCode, "tab_not_showing");
  assert.equal(response.retryable, true);
  assert.equal(response.recoveryAction, "retry");
  assert.equal(state.captures, 0, "no pixels may be captured from the wrong tab");
});

test("a screenshot is discarded if the tab changed while it was captured", async () => {
  const { state, request } = loadBackground({
    showing: 1,
    afterCapture: (current) => {
      current.showing = 2;
    },
  });

  const response = await request("screenshot", { tabId: 1 });

  assert.equal(response.errorCode, "tab_not_showing");
  assert.equal(state.captures, 1);
});

test("native input preparation fails if another tab took over the window", async () => {
  const { focusForNativeInput } = loadBackground({
    showing: 1,
    afterActivate: (current) => {
      current.showing = 2;
    },
  });

  const outcome = await focusForNativeInput(1);

  assert.ok(Result.isFailure(outcome));
  assert.equal(outcome.failure.code, "tab_not_showing");
  assert.match(outcome.failure.message, /native input/);
});

test("native input preparation returns the tab once it is confirmed showing", async () => {
  const { focusForNativeInput } = loadBackground({ showing: 1 });

  const outcome = await focusForNativeInput(1);

  assert.ok(Result.isSuccess(outcome));
  assert.equal(outcome.success, 1);
});
