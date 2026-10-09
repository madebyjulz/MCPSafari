// The background used to be nine classic scripts sharing one global, and a
// test made sure each could load in manifest order. It is now one bundle built
// from modules, so load order is the bundler's problem; what is left to check
// is that the router serves exactly the actions the extension advertises, and
// that the bundle Safari loads starts up in a page that has only what a Safari
// background page has.
//
// Run `pnpm exec tsdown -F background.js` first; `pnpm test` does.

import assert from "node:assert/strict";
import vm from "node:vm";
import { afterEach, test, vi } from "vitest";

import {
  BACKGROUND_ACTIONS,
  CONTENT_ACTIONS,
  CONTENT_PROXY_ACTIONS,
  ROUTABLE_ACTIONS,
} from "../src/background/actions.ts";
import { BACKGROUND_HANDLERS, CONTENT_PROXIES } from "../src/background/Router.ts";
import type { ContentRequest } from "../src/shared/protocol.ts";
import { makeFakeWebSocket } from "./helpers/background.ts";
import { fakeBrowser, launch, stopAll } from "./helpers/fake-browser.ts";
import { builtScript } from "./helpers/sources.ts";

afterEach(stopAll);

test("the background handler table covers exactly the background actions", () => {
  assert.deepEqual([...BACKGROUND_HANDLERS.keys()].toSorted(), [...BACKGROUND_ACTIONS].toSorted());
});

test("the content proxy table covers exactly the proxied actions", () => {
  assert.deepEqual([...CONTENT_PROXIES.keys()].toSorted(), [...CONTENT_PROXY_ACTIONS].toSorted());
});

test("no action is served two ways", () => {
  assert.equal(new Set(ROUTABLE_ACTIONS).size, ROUTABLE_ACTIONS.length);
});

test("every content action reaches the content script under its own name", async () => {
  const sent: Array<ContentRequest> = [];
  const api = fakeBrowser();

  api.tabs.sendMessage = async (_tabId, message) => {
    sent.push(message);

    return { data: [], error: null };
  };

  const { request } = launch(api);

  for (const action of CONTENT_ACTIONS) {
    sent.length = 0;

    const response = await request(action, { tabId: 1 });

    assert.equal(response.success, true, `${action}: ${response.error}`);
    assert.ok(sent.length > 0, `${action} should have reached the page`);
    assert.ok(
      sent.every((message) => message.action === action),
      `${action} should not be renamed`,
    );
  }
});

test("the built background starts up in a page with only Safari's globals", async () => {
  const { FakeSocket, sockets } = makeFakeWebSocket();
  const logged: Array<string> = [];
  const record = (...args: ReadonlyArray<string>) => void logged.push(args.join(" "));
  const api = fakeBrowser();

  api.runtime.sendNativeMessage = async () => ({ tokens: { 8089: "token" } });

  // What a Safari background page has, and nothing Node adds: no `process`,
  // no `setImmediate`, no `require`.
  const page = vm.createContext({
    browser: api,
    WebSocket: FakeSocket,
    console: {
      log: record,
      info: record,
      warn: record,
      error: record,
      debug: record,
      trace: record,
      group: record,
      groupEnd: record,
    },
    setTimeout,
    clearTimeout,
    queueMicrotask,
    performance,
    URL,
    TextEncoder,
    TextDecoder,
  });

  assert.doesNotThrow(() => vm.runInContext(builtScript("background.js"), page, { filename: "background.js" }));

  // Registered while the script loads, as Safari requires of the events that
  // wake a suspended background page.
  assert.deepEqual(
    [api.runtime.onMessage, api.tabs.onUpdated, api.tabs.onRemoved, api.alarms.onAlarm].map(
      (event) => event.listeners.length,
    ),
    [1, 1, 1, 1],
  );

  // And startup ran: the token it loaded has its port dialled.
  await vi.waitFor(() =>
    assert.deepEqual(
      sockets.map((socket) => socket.url),
      ["ws://localhost:8089"],
    ),
  );
  await vi.waitFor(() =>
    assert.ok(
      logged.some((line) => line.includes("Background script initialized")),
      logged.join("\n"),
    ),
  );
});
