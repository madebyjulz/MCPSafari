// The tab in these tests sits on a site the user has not granted: the access
// probe is refused. Selecting it only records which tab later calls mean, so it
// must work anyway, and the first call that reads the page must still refuse.

import assert from "node:assert/strict";
import { afterEach, test } from "vitest";

import { probeTabAccess } from "../src/background/injected.ts";
import { SelectedTab } from "../src/background/SelectedTab.ts";
import { TabAccess } from "../src/background/TabAccess.ts";
import type { JsonValue } from "../src/shared/protocol.ts";
import { parked } from "./helpers/background.ts";
import { dataOf, fakeBrowser, launch, stopAll, type FakeTab } from "./helpers/fake-browser.ts";

afterEach(stopAll);

const TAB: FakeTab = {
  id: 7,
  windowId: 3,
  active: false,
  url: "https://ungranted.example/account?token=abc",
  title: "Your account",
};

function loadBackground({
  granted = false,
  getTab,
}: { readonly granted?: boolean; readonly getTab?: (id: number) => Promise<FakeTab> } = {}) {
  const stored: Record<string, JsonValue> = {};
  const focusCalls: Array<readonly [string, number, Readonly<Record<string, unknown>>]> = [];
  const api = fakeBrowser();

  api.scripting.executeScript = async (options) => {
    if (options.func === probeTabAccess && !granted) {
      throw new Error("This extension does not have access to this tab");
    }

    return [{ result: true }];
  };

  api.storage.session.set = async (values: Readonly<Record<string, JsonValue>>) => void Object.assign(stored, values);
  api.tabs.get =
    getTab ??
    (async (id) => {
      if (id !== TAB.id) throw new Error(`No tab with id: ${id}`);

      return TAB;
    });
  api.tabs.query = async () => [TAB];
  api.tabs.update = async (id, info) => void focusCalls.push(["tabs.update", id, { ...info }]);
  api.windows.update = async (id, info) => void focusCalls.push(["windows.update", id, { ...info }]);
  api.webNavigation.getAllFrames = async () => [{ frameId: 0, parentFrameId: -1, url: TAB.url }];

  const { harness, request } = launch(api);

  return {
    stored,
    focusCalls,
    request,
    pinned: () => harness.run(SelectedTab.use((selected) => selected.get)),
    reach: (tabId: number) => harness.run(TabAccess.use((access) => access.ensure(tabId))),
  };
}

test("selecting a tab on an ungranted site pins it and reports success with the access state", async () => {
  const harness = loadBackground();

  const response = await harness.request("select_tab", { tabId: 7 });

  // `success: true` is what lets the server pin the profile too.
  assert.equal(response.success, true, response.error ?? "");

  const tab = dataOf(response);

  assert.equal(tab.id, 7);
  assert.equal(tab.selected, true);
  assert.equal(tab.access, "not_granted");
  assert.match(tab.accessHint, /MCPSafari button in Safari's toolbar/);
  // Nothing about the page it was never given access to.
  assert.equal("url" in tab, false);
  assert.equal("title" in tab, false);
  assert.doesNotMatch(response.data ?? "", /ungranted\.example|Your account|abc/);
  assert.equal(await harness.pinned(), 7);
  assert.equal(harness.stored["selectedTabId"], 7, "and it survives the background page being suspended");
});

test("the pinned ungranted tab still refuses the first call that reads the page", async () => {
  const harness = loadBackground();

  await harness.request("select_tab", { tabId: 7 });

  // No tab named: the pin supplies it.
  const response = await harness.request("snapshot");

  assert.equal(response.success, false);
  assert.equal(response.errorCode, "permission_required");
  assert.equal(response.resolvedTabId, 7);
});

test("selecting a tab on a reached site still describes it", async () => {
  const harness = loadBackground({ granted: true });

  await harness.reach(7);

  const tab = dataOf(await harness.request("select_tab", { tabId: 7 }));

  assert.equal(tab.access, "granted");
  assert.equal(tab.title, "Your account");
  assert.equal(tab.url, "https://ungranted.example/account?token=[redacted]");
  assert.equal("accessHint" in tab, false);
});

test("selecting brings the tab forward without needing access to its page", async () => {
  const harness = loadBackground();

  await harness.request("select_tab", { tabId: 7 });

  assert.deepEqual(harness.focusCalls, [
    ["tabs.update", 7, { active: true }],
    ["windows.update", 3, { focused: true }],
  ]);
});

test("bringToFront: false pins without moving anything", async () => {
  const harness = loadBackground();

  const response = await harness.request("select_tab", { tabId: 7, bringToFront: false });

  assert.equal(response.success, true);
  assert.deepEqual(harness.focusCalls, []);
  assert.equal(await harness.pinned(), 7);
});

test("a tab that does not exist is refused and not pinned", async () => {
  const harness = loadBackground();

  const response = await harness.request("select_tab", { tabId: 99 });

  assert.equal(response.success, false);
  assert.match(response.error ?? "", /No tab with id/);
  assert.equal(await harness.pinned(), null);
});

test("a lookup parked behind a dialog does not stop the pin", async () => {
  // The deadline is the test timing's, tens of milliseconds.
  const harness = loadBackground({ getTab: parked });

  const response = await harness.request("select_tab", { tabId: 7 });

  assert.equal(response.success, true, response.error ?? "");
  assert.equal(dataOf(response).access, "not_granted");
  assert.equal(await harness.pinned(), 7);
  assert.deepEqual(harness.focusCalls, [], "with no tab read there is no window to bring forward");
});
