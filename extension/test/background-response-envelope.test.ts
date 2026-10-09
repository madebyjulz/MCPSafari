import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

import { Connections } from "../src/background/Connections.ts";
import { fakeBrowser, launch, settle, stopAll } from "./helpers/fake-browser.ts";

afterEach(stopAll);

// The server holds a pending entry for every request it sends and waits thirty
// seconds for an answer, so a reply it cannot read costs exactly as much as a
// reply that never arrives. Both were reachable from the request path.
async function loadBackground() {
  const api = fakeBrowser();

  api.runtime.sendNativeMessage = async () => ({ tokens: { 8089: "token" } });

  const { harness } = launch(api);

  await harness.start();

  return {
    api,
    /**
     * Drives one socket past the handshake so later frames take the request
     * path, and clears the auth frame so assertions see only new sends.
     */
    async openAuthenticated() {
      const socket = harness.sockets.at(-1);

      assert.ok(socket, "the port should have been dialled once its token loaded");
      socket.open();
      socket.receive(JSON.stringify({ auth: "ok" }));
      await vi.waitFor(async () => {
        const { connections } = await harness.run(Connections.use((tracked) => tracked.inspect));

        assert.equal(connections.get(8089)?.state, "connected");
      });
      socket.sent.length = 0;

      return socket;
    },
  };
}

test("a successful reply carries a data key even when the handler returns nothing", async () => {
  const harness = await loadBackground();

  // A snapshot whose top frame answers with nothing is a real way in: there is
  // no tree to splice, so the handler has nothing to return.
  harness.api.tabs.sendMessage = async () => ({ data: null, error: null });

  const socket = await harness.openAuthenticated();

  socket.receive(JSON.stringify({ id: "r1", action: "snapshot", params: { tabId: 1 } }));
  await vi.waitFor(() => assert.equal(socket.sent.length, 1));

  // The defect was one level further out. `JSON.stringify(undefined)` is the
  // value undefined rather than a string, so the key vanished from the frame
  // and `response.data?.stringValue` on the server turned a successful call
  // into a failure with no reason attached.
  const frame = JSON.parse(socket.sent[0] ?? "{}");

  assert.equal(frame.id, "r1");
  assert.equal(frame.success, true);
  assert.ok("data" in frame, "the server reads response.data and fails the call without it");
  assert.equal(frame.data, "null");
});

test("a frame carrying no request id is dropped rather than throwing twice", async () => {
  const harness = await loadBackground();
  const socket = await harness.openAuthenticated();

  // `JSON.parse` accepts every one of these and none has an id to answer.
  // Destructuring one threw out of the request handler, and the catch around
  // it then threw again reading `request.id`, so no reply was sent at all.
  for (const frame of ["null", "5", '"x"', "[]"]) socket.receive(frame);

  // A real request afterwards shows the socket is still being served, and
  // gives the ones above time to have answered if they were going to.
  socket.receive(JSON.stringify({ id: "after", action: "tabs_query", params: {} }));
  await vi.waitFor(() => assert.equal(socket.sent.length, 1));
  await settle();

  assert.equal(socket.sent.length, 1);
  assert.equal(JSON.parse(socket.sent[0] ?? "{}").id, "after");
});
