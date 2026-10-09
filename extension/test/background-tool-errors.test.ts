// The background half of tool errors: what it does with the content script's
// failures and how it foregrounds a tab. The content half is in
// content-tool-errors.test.ts.

import assert from "node:assert/strict";
import { afterEach, test } from "vitest";

import { fakeBrowser, launch, stopAll, type FakeContentReply } from "./helpers/fake-browser.ts";

afterEach(stopAll);

function backgroundHarness(...contentResponses: Array<FakeContentReply | null>) {
  const tabUpdates: Array<readonly [number, { readonly active?: boolean }]> = [];
  const windowUpdates: Array<readonly [number, { readonly focused?: boolean; readonly width?: number }]> = [];
  const api = fakeBrowser();

  api.tabs.get = async () => ({ id: 1, windowId: 7 });
  api.tabs.sendMessage = async () => contentResponses.shift();
  api.tabs.update = async (...args) => {
    tabUpdates.push(args);
  };

  api.windows.update = async (...args) => {
    windowUpdates.push(args);
  };

  api.scripting.executeScript = async () => [];

  return { request: launch(api).request, tabUpdates, windowUpdates };
}

const STALE_UID: FakeContentReply = {
  data: null,
  error: "UID expired",
  errorCode: "stale_uid",
  retryable: false,
  recoveryAction: "take_snapshot",
};

test("background preserves content error metadata in bridge responses", async () => {
  const { request } = backgroundHarness(STALE_UID);

  const response = await request("click", { tabId: 1, uid: "e999" });

  assert.equal(response.success, false);
  assert.equal(response.errorCode, "stale_uid");
  assert.equal(response.retryable, false);
  assert.equal(response.recoveryAction, "take_snapshot");
});

test("background reinjects when Safari returns no content response", async () => {
  const { request } = backgroundHarness(null, STALE_UID);

  const response = await request("click", { tabId: 1, uid: "e999" });

  assert.equal(response.errorCode, "stale_uid");
  assert.equal(response.recoveryAction, "take_snapshot");
});

test("native input preparation foregrounds the target Safari tab", async () => {
  const { request, tabUpdates, windowUpdates } = backgroundHarness({ data: "Focused", error: null });

  const response = await request("native_type_text", { tabId: 1, selector: "#editor", text: "/hello" });

  assert.equal(response.success, true);
  assert.equal(response.data, "Safari is ready for native input");
  assert.equal(tabUpdates.length, 1);
  assert.equal(tabUpdates[0]?.[0], 1);
  assert.equal(tabUpdates[0]?.[1].active, true);
  assert.equal(windowUpdates.length, 1);
  assert.equal(windowUpdates[0]?.[0], 7);
  assert.equal(windowUpdates[0]?.[1].focused, true);
});

test("resize_window uses the tab it was given rather than the current window", async () => {
  const { request, windowUpdates } = backgroundHarness({ data: null, error: null });

  const response = await request("resize_window", { tabId: 1, width: 900, height: 700 });

  assert.equal(response.success, true);
  // windowId 7 is the one `tabs.get` reports for the named tab. Reading
  // `tabs.query({ currentWindow: true })` instead resizes whichever window
  // the user happens to be looking at, which on a two-window setup is not
  // the one the agent is driving.
  assert.deepEqual(windowUpdates[0], [7, { width: 900, height: 700 }]);
});
