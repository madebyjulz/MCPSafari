// The background half of the targeted screenshot. The content half, how
// `element_rect` measures, is in content-element-rect.test.ts.

import assert from "node:assert/strict";
import { afterEach, test } from "vitest";

import { probeTabAccess } from "../src/background/injected.ts";
import type { ContentRequest } from "../src/shared/protocol.ts";
import { dataOf, fakeBrowser, launch, stopAll, type FakeContentReply } from "./helpers/fake-browser.ts";

afterEach(stopAll);

// Records what reaches the content script and in what order relative to the
// frame capture.
function loadBackground(contentReply: (message: ContentRequest) => FakeContentReply) {
  const log: Array<string> = [];
  const api = fakeBrowser();

  // The website-permission probe and the page-context read both land here.
  // Logging them apart keeps the ordering assertions about the capture rather
  // than about the probe.
  api.scripting.executeScript = async ({ func }) => {
    if (func === probeTabAccess) {
      log.push("probe");

      return [{ result: true }];
    }

    log.push("context");

    return [{ result: { visible: true, hasFocus: true } }];
  };

  api.tabs.get = async (id) => ({ id, active: true, windowId: 1 });
  api.tabs.captureVisibleTab = async () => {
    log.push("capture");

    return "data:image/png;base64,AAAB";
  };

  api.tabs.sendMessage = async (_tabId, message) => {
    log.push(`content:${message.action}`);

    return contentReply(message);
  };

  return { log, request: launch(api).request };
}

test("screenshot with uid asks the content script for the element rect before the frame", async () => {
  const { request, log } = loadBackground((message) => {
    assert.deepEqual({ ...message.params }, { uid: "e7", selector: undefined });

    return { data: { x: 10, y: 20, width: 30, height: 40 }, error: null };
  });

  const capture = dataOf(await request("screenshot", { tabId: 1, uid: "e7" }));

  // The probe precedes the first content call, because reaching the content
  // script is exactly what it establishes.
  assert.deepEqual(log, ["probe", "content:element_rect", "context", "capture"]);
  assert.equal(capture.image, "AAAB");
  assert.equal(capture.target.x, 10);
  assert.equal(capture.target.height, 40);
});

test("screenshot without a target never touches the content script", async () => {
  const { request, log } = loadBackground(() => {
    throw new Error("must not be called");
  });

  const capture = dataOf(await request("screenshot", { tabId: 1 }));

  // The probe is an injection, not the content script, and it guards the
  // `tabs.get` that would otherwise sit on Safari's permission dialog.
  assert.deepEqual(log, ["probe", "context", "capture"]);
  assert.equal("target" in capture, false);
});

test("a content-script rect error fails the screenshot with its code", async () => {
  const { request, log } = loadBackground(() => ({
    data: null,
    error: "No element found for uid: e9",
    errorCode: "stale_uid",
    retryable: false,
    recoveryAction: "take_snapshot",
  }));

  const response = await request("screenshot", { tabId: 1, uid: "e9" });

  assert.equal(response.success, false);
  assert.equal(response.errorCode, "stale_uid");
  // Nothing is captured after the content script refuses, and the probe is the
  // only thing that ran before it.
  assert.deepEqual(log, ["probe", "content:element_rect"]);
});
