// Page data comes back from the content script verbatim, so this drives the
// router with a content script that reports URLs carrying credentials.

import assert from "node:assert/strict";
import { afterEach, test } from "vitest";

import type { ContentParams, ContentRequest, JsonValue } from "../src/shared/protocol.ts";
import { fakeBrowser, launch, stopAll } from "./helpers/fake-browser.ts";

afterEach(stopAll);

const SECRET_URL = "https://api.example/v1/items?access_token=LEAK1&page=2";

const REDACTED_URL = "https://api.example/v1/items?access_token=[redacted]&page=2";

function loadBackground(respond: (message: ContentRequest) => JsonValue) {
  const api = fakeBrowser();

  api.tabs.sendMessage = async (_tabId, message) => ({ data: respond(message), error: null });

  const { request } = launch(api);

  // oxlint-disable-next-line typescript/no-explicit-any -- each test reaches into its own action's result
  return async (action: string, params: ContentParams = {}): Promise<any> => {
    const response = await request(action, { tabId: 1, ...params });

    assert.equal(response.success, true, response.error ?? "");

    // A string result travels as itself rather than as JSON.
    try {
      return JSON.parse(response.data ?? "null");
    } catch {
      return response.data;
    }
  };
}

test("read_network reports request URLs without their credentials", async () => {
  const request = loadBackground(() => [
    { type: "fetch", method: "GET", url: SECRET_URL, status: 200 },
    { type: "resource", url: "https://cdn.example/a.js?X-Amz-Signature=LEAK2", initiatorType: "script" },
    { type: "xhr", method: "GET", url: "https://user:LEAK3@host.example/x", status: 200 },
  ]);

  const records = await request("read_network");

  assert.equal(records[0].url, REDACTED_URL);
  assert.equal(records[1].url, "https://cdn.example/a.js?X-Amz-Signature=[redacted]");
  assert.equal(records[2].url, "https://[redacted]@host.example/x");
  assert.doesNotMatch(JSON.stringify(records), /LEAK/);
  // Everything else about the record is as the page reported it.
  assert.equal(records[0].status, 200);
});

test("a stopped trace reports its URLs without their credentials", async () => {
  const request = loadBackground(() => ({
    id: "t1",
    startUrl: "https://app.example/cb?code=LEAK1&state=s",
    endUrl: "https://app.example/home#id_token=LEAK2",
    events: [
      {
        type: "url",
        from: "https://app.example/a?token=LEAK3",
        to: "https://app.example/b",
        reason: "history.pushState",
      },
      { type: "network.fetch", url: SECRET_URL, method: "GET" },
      { type: "console.log", message: "unrelated" },
    ],
  }));

  const trace = await request("stop_trace", { id: "t1" });

  assert.equal(trace.startUrl, "https://app.example/cb?code=[redacted]&state=s");
  assert.equal(trace.endUrl, "https://app.example/home#id_token=[redacted]");
  assert.equal(trace.events[0].from, "https://app.example/a?token=[redacted]");
  assert.equal(trace.events[1].url, REDACTED_URL);
  assert.doesNotMatch(JSON.stringify(trace), /LEAK/);
});

test("snapshot link hrefs are redacted at any depth, frames included", async () => {
  const request = loadBackground(() => ({
    uid: "f0e1",
    tag: "body",
    children: [
      { uid: "f0e2", tag: "a", role: "link", href: "https://app.example/reset?reset_token=LEAK1" },
      {
        uid: "f0e3",
        tag: "div",
        children: [{ uid: "f0e4", tag: "a", role: "link", href: SECRET_URL }],
      },
    ],
  }));

  for (const [action, params] of [
    ["snapshot", {}],
    ["read_page", { format: "snapshot" }],
  ] as const) {
    const result = await request(action, params);

    assert.equal(result.children[0].href, "https://app.example/reset?reset_token=[redacted]");
    assert.equal(result.children[1].children[0].href, REDACTED_URL);
    assert.doesNotMatch(JSON.stringify(result), /LEAK/);
  }
});

test("odd shapes from a hostile page are passed through rather than failing the call", async () => {
  for (const data of [null, "text", 5, [], { events: "nope" }, [null, 3, { url: 7 }]]) {
    const request = loadBackground(() => data);

    // Both the network and trace redactors, and a plain read.
    await request("read_network");
    await request("stop_trace", { id: "t" });
    await request("read_page", { format: "text" });
  }
});
