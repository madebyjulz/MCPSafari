import assert from "node:assert/strict";
import vm from "node:vm";
import { test } from "vitest";

import type { JsonValue } from "../src/shared/protocol.ts";
import { browserStub, callThrough, contentSource, type RuntimeListener } from "./helpers/content.ts";

const source = contentSource();

/** A start_trace request as the content script posts it to the page world. */
interface PostedRequest {
  readonly id: string;
  readonly params: { readonly id: string };
}

/** What the trace interceptor would post back. */
interface PageReply {
  readonly data?: JsonValue;
  readonly error?: string;
}

type MessageListener = (event: { readonly source: object; readonly data: object }) => void;

// Loads content.js with a controllable clock and a fake MAIN-world bridge so
// tests can decide which start_trace requests the interceptor answers.
function loadContent() {
  let runtimeListener: RuntimeListener | undefined;
  const messageListeners = new Set<MessageListener>();
  const posted: Array<PostedRequest> = [];
  const timers: Array<{ fn: (() => void) | null }> = [];

  const window = {
    addEventListener: (type: string, fn: MessageListener) => {
      if (type === "message") messageListeners.add(fn);
    },
    removeEventListener: (type: string, fn: MessageListener) => {
      if (type === "message") messageListeners.delete(fn);
    },
    postMessage: (message: PostedRequest) => posted.push(message),
  };

  vm.runInNewContext(source, {
    browser: browserStub((fn) => {
      runtimeListener = fn;
    }),
    document: {},
    setTimeout: (fn: () => void) => timers.push({ fn }) - 1,
    clearTimeout: (id: number) => {
      const timer = timers[id];

      if (timer) timer.fn = null;
    },
    window,
  });

  return {
    call: callThrough(() => runtimeListener),
    posted,
    fireNextTimer: () => {
      const timer = timers.shift();

      if (timer?.fn) timer.fn();
    },
    respond: (id: string, payload: PageReply) => {
      for (const listener of messageListeners) {
        listener({ source: window, data: { source: "MCPSafariPage", id, ...payload } });
      }
    },
    flush: () => new Promise((resolve) => setImmediate(resolve)),
  };
}

test("start_trace retries once after an interceptor startup timeout", async () => {
  const page = loadContent();
  const result = page.call("start_trace", {});

  await page.flush();
  assert.equal(page.posted.length, 1);

  page.fireNextTimer(); // first request's 3s timeout fires unanswered
  await page.flush();
  page.fireNextTimer(); // 250ms retry delay
  await page.flush();

  assert.equal(page.posted.length, 2);
  assert.equal(page.posted[0]?.params.id, page.posted[1]?.params.id);
  page.respond(page.posted[1]!.id, { data: { id: page.posted[1]!.params.id } });

  const response = await result;
  assert.equal(response.data, page.posted[1]?.params.id);
  assert.equal(response.error, null);
});

test("start_trace does not retry interceptor-reported errors", async () => {
  const page = loadContent();
  const result = page.call("start_trace", {});

  await page.flush();
  assert.equal(page.posted.length, 1);
  page.respond(page.posted[0]!.id, { error: "Trace already running" });

  const response = await result;
  assert.equal(response.data, null);
  assert.equal(response.error, "Trace already running");
  assert.equal(page.posted.length, 1);
});

test("start_trace fails after the retry also times out", async () => {
  const page = loadContent();
  const result = page.call("start_trace", {});

  await page.flush();
  page.fireNextTimer(); // first timeout
  await page.flush();
  page.fireNextTimer(); // retry delay
  await page.flush();
  page.fireNextTimer(); // retry timeout
  await page.flush();

  const response = await result;
  assert.equal(response.data, null);
  assert.equal(response.error, "start_trace interceptor did not respond");
  assert.equal(page.posted.length, 2);
});
