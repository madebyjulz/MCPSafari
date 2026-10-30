// The tab a call lands on is decided in one place, and a wrong answer there is
// the worst kind of failure: the call succeeds, on a page nobody meant.

import assert from "node:assert/strict";
import { Effect, Result } from "effect";
import { afterEach, test } from "vitest";

import { SelectedTab } from "../src/background/SelectedTab.ts";
import { fakeBrowser, launch, stopAll, type FakeFrame, type FakeTab } from "./helpers/fake-browser.ts";

afterEach(stopAll);

interface Tab {
  readonly id: number;
  active: boolean;
  readonly windowId: number;
}

function loadBackground({
  tabs = [{ id: 1, active: true, windowId: 1 }],
  getTab,
  frames = [{ frameId: 0, parentFrameId: -1, url: "" }],
  // Runs after each message reaches a page, which is where a user clicking
  // into another tab mid-request is simulated.
  afterSend = () => {},
}: {
  readonly tabs?: Array<Tab>;
  readonly getTab?: (id: number) => Promise<FakeTab>;
  readonly frames?: ReadonlyArray<FakeFrame>;
  readonly afterSend?: (tabs: Array<Tab>) => void;
} = {}) {
  const sent: Array<{ readonly tabId: number; readonly frameId: number }> = [];
  const removed: Array<number> = [];
  const api = fakeBrowser();

  api.tabs.get =
    getTab ??
    (async (id) => {
      const tab = tabs.find((candidate) => candidate.id === id);

      if (!tab) throw new Error(`No tab with id: ${id}`);

      return { url: "https://ok.example/", title: "T", ...tab };
    });
  // SAFETY: the background only ever filters on `active`.
  api.tabs.query = (async (filter: { readonly active?: boolean } = {}) =>
    filter.active ? tabs.filter((tab) => tab.active) : tabs) as typeof api.tabs.query;
  api.tabs.sendMessage = async (tabId, _message, options) => {
    sent.push({ tabId, frameId: options?.frameId ?? 0 });
    afterSend(tabs);

    return { data: [], error: null };
  };

  api.tabs.remove = async (id) => void removed.push(id);
  api.webNavigation.getAllFrames = async () => frames;

  const { harness, request } = launch(api);

  return {
    api,
    sent,
    removed,
    request,
    pin: (tabId: number) => harness.run(SelectedTab.use((selected) => selected.set(tabId))),
    pinned: () => harness.run(SelectedTab.use((selected) => selected.get)),
    activeTabId: () => harness.run(SelectedTab.use((selected) => Effect.result(selected.activeTabId))),
  };
}

test("a pinned tab that was closed is an error, not a quiet switch to the active tab", async () => {
  // The user is looking at tab 1. The agent pinned tab 7, which has since closed.
  const harness = loadBackground();

  await harness.pin(7);

  const outcome = await harness.activeTabId();

  assert.ok(Result.isFailure(outcome));
  assert.equal(outcome.failure.code, "tab_closed");
  assert.equal(outcome.failure.retryable, false);
  assert.equal(outcome.failure.recoveryAction, "call_tabs_context");
  assert.match(outcome.failure.message, /select_tab/);
  assert.equal(await harness.pinned(), null, "the dead pin is cleared so the next call is not stuck");
});

test("an untabbed type_text after the pinned tab closed does not land on the user's tab", async () => {
  const harness = loadBackground();

  await harness.pin(7);

  const response = await harness.request("type_text", { text: "hunter2" });

  assert.equal(response.success, false);
  assert.equal(response.errorCode, "tab_closed");
  assert.equal(harness.sent.length, 0, "nothing may reach the page the user is looking at");
});

test("the call after a tab_closed refusal resolves normally again", async () => {
  const harness = loadBackground();

  await harness.pin(7);
  await harness.activeTabId();

  const outcome = await harness.activeTabId();

  assert.ok(Result.isSuccess(outcome));
  assert.equal(outcome.success, 1);
});

test("a pinned tab whose lookup fails for another reason keeps its pin", async () => {
  // The tab is in the listing, so it exists; `tabs.get` failing is something else.
  const harness = loadBackground({
    tabs: [
      { id: 1, active: true, windowId: 1 },
      { id: 7, active: false, windowId: 1 },
    ],
    getTab: async () => {
      throw new Error("transient failure");
    },
  });

  await harness.pin(7);

  const outcome = await harness.activeTabId();

  assert.ok(Result.isFailure(outcome));
  assert.match(outcome.failure.message, /transient failure/);
  assert.notEqual(outcome.failure.code, "tab_closed");
  assert.equal(await harness.pinned(), 7);
});

test("a pinned tab is kept when the listing that would confirm its absence fails too", async () => {
  const harness = loadBackground({
    getTab: async () => {
      throw new Error("transient failure");
    },
  });

  harness.api.tabs.query = async () => {
    throw new Error("listing failed");
  };

  await harness.pin(7);

  const outcome = await harness.activeTabId();

  assert.ok(Result.isFailure(outcome));
  assert.match(outcome.failure.message, /transient failure/);
  assert.equal(await harness.pinned(), 7);
});

// An untabbed call used to look the active tab up again at every step, once per
// frame for a search, so a user switching tabs partway through split one request
// across two pages.
test("an untabbed request acts on one tab even if the user switches mid-request", async () => {
  const harness = loadBackground({
    tabs: [
      { id: 1, active: true, windowId: 1 },
      { id: 2, active: false, windowId: 1 },
    ],
    frames: [
      { frameId: 0, parentFrameId: -1, url: "https://ok.example/" },
      { frameId: 3, parentFrameId: 0, url: "https://ok.example/frame" },
    ],
    afterSend: (tabs) => {
      for (const tab of tabs) tab.active = tab.id === 2;
    },
  });

  const response = await harness.request("find", { text: "Pay" });

  assert.equal(response.success, true, response.error ?? "");
  assert.deepEqual(
    harness.sent.map((sent) => [sent.tabId, sent.frameId]),
    [
      [1, 0],
      [1, 3],
    ],
  );
  assert.equal(response.resolvedTabId, 1);
});

test("the resolved tab is reported on the response so a caller can reuse it", async () => {
  const harness = loadBackground({ tabs: [{ id: 4, active: true, windowId: 1 }] });

  // `scroll` rather than `click`, which would also watch for a load it starts.
  const untabbed = await harness.request("scroll", { direction: "down" });

  assert.equal(untabbed.resolvedTabId, 4);

  const tabbed = await harness.request("scroll", { tabId: 9, direction: "down" });

  assert.equal(tabbed.resolvedTabId, 9);
  assert.equal(harness.sent.at(-1)?.tabId, 9, "an explicit tab is never overridden");
});

test("a failed request still reports the tab it resolved", async () => {
  const harness = loadBackground({ tabs: [{ id: 4, active: true, windowId: 1 }] });

  harness.api.tabs.sendMessage = async () => ({ data: null, error: "nope", errorCode: "target_not_found" });

  const response = await harness.request("click", { selector: "#go" });

  assert.equal(response.success, false);
  assert.equal(response.resolvedTabId, 4);
});

test("tools that act on no tab report none and never default to the active one", async () => {
  const harness = loadBackground({ tabs: [{ id: 4, active: true, windowId: 1 }] });

  const listing = await harness.request("tabs_query");

  assert.equal(listing.resolvedTabId, null);

  // `tabs_close` with no tab must not close whatever is in front.
  const close = await harness.request("tabs_close");

  assert.equal(close.resolvedTabId, null);
  assert.deepEqual(harness.removed, []);
});
