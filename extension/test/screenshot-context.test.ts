import assert from "node:assert/strict";
import vm from "node:vm";
import { afterEach, test } from "vitest";

import { probeTabAccess } from "../src/background/injected.ts";
import {
  DATA_URL,
  dataOf,
  fakeBrowser,
  launch,
  runInjected,
  stopAll,
  type InjectionOptions,
  type InjectionResult,
} from "./helpers/fake-browser.ts";

afterEach(stopAll);

type ExecuteScript = (options: InjectionOptions) => Promise<ReadonlyArray<InjectionResult>>;

// Background harness with just enough browser API for a screenshot. The
// website-permission probe lands on `executeScript` too; these tests are about
// the page-context read, so the probe is answered separately and each case
// keeps control of the call it actually cares about.
function loadBackground(executeScript: ExecuteScript, captureVisibleTab = async () => DATA_URL) {
  const api = fakeBrowser();

  api.scripting.executeScript = async (options) =>
    options.func === probeTabAccess ? [{ result: true }] : executeScript(options);
  api.tabs.get = async (id) => ({ id, active: true, windowId: 1 });
  api.tabs.captureVisibleTab = captureVisibleTab;

  const { request } = launch(api);

  return async () => dataOf(await request("screenshot", { tabId: 1 }));
}

test("screenshot reports viewport, scale, visibility, and focus with the image", async () => {
  const capture = await loadBackground(async () => [
    {
      result: {
        visible: false,
        hasFocus: false,
        viewport: { width: 1200, height: 828 },
        devicePixelRatio: 2,
      },
    },
  ])();

  assert.equal(capture.image, "AAAB");
  assert.equal(capture.visible, false);
  assert.equal(capture.hasFocus, false);
  assert.deepEqual(capture.viewport, { width: 1200, height: 828 });
  assert.equal(capture.devicePixelRatio, 2);
});

test("the injected context function reads visibility, focus, and viewport from the page", async () => {
  // Run the real injected function, serialised into a page that has only the
  // globals it reads, instead of stubbing its result.
  const page = vm.createContext({
    document: { visibilityState: "hidden", hasFocus: () => false },
    window: { innerWidth: 900, innerHeight: 600, devicePixelRatio: 1 },
  });

  const capture = await loadBackground(async ({ func }) => {
    assert.ok(func, "the context read is a function injection");

    return [{ result: runInjected(func, [], page) }];
  })();

  assert.equal(capture.visible, false);
  assert.equal(capture.hasFocus, false);
  assert.deepEqual(capture.viewport, { width: 900, height: 600 });
  assert.equal(capture.devicePixelRatio, 1);
});

test("page context is read before the frame, not after it", async () => {
  const order: Array<string> = [];

  await loadBackground(
    async () => {
      order.push("context");

      return [{ result: { visible: true, hasFocus: true } }];
    },
    async () => {
      order.push("capture");

      return DATA_URL;
    },
  )();

  // Reading state after the frame can report a page as focused when it lost
  // focus during the capture, which is a false all-clear.
  assert.deepEqual(order, ["context", "capture"]);
});

test("screenshot still returns the image when page context is unavailable", async () => {
  const capture = await loadBackground(async () => {
    throw new Error("cannot access page");
  })();

  assert.equal(capture.image, "AAAB");
  assert.deepEqual(Object.keys(capture), ["image"]);
});
