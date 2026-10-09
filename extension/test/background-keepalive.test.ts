import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

import { Connections } from "../src/background/Connections.ts";
import { fakeBrowser, launch, stopAll } from "./helpers/fake-browser.ts";

const PORT = 8089;

afterEach(async () => {
  vi.restoreAllMocks();
  await stopAll();
});

// The keepalive both reconnects and prunes, and the prune records the live token
// as stale, which the extension then refuses to dial again. The server only
// mints a new token when it restarts, so a wrong decision here is not something
// that recovers on its own.
async function loadBackground() {
  // The background reads the time through Effect's clock, which reads
  // `Date.now`; the tests have to be able to move it.
  const realNow = Date.now.bind(Date);
  let offset = 0;

  vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);

  const api = fakeBrowser();
  let tokenLoads = 0;

  api.runtime.sendNativeMessage = async () => {
    tokenLoads += 1;

    return { tokens: { [PORT]: "token-one" } };
  };

  const { harness } = launch(api);

  await harness.start();

  const port = () => harness.run(Connections.use((connections) => connections.inspect));

  return {
    sockets: harness.sockets,
    advance(ms: number) {
      offset += ms;
    },
    tracked: async () => (await port()).connections.has(PORT),
    stale: async () => (await port()).staleTokens.has(PORT),
    keepalive: () => harness.run(Connections.use((connections) => connections.keepalive)),
    fireAlarm: () => api.alarms.onAlarm.fire({ name: "mcp-keepalive" }),
    tokenLoads: () => tokenLoads,
    /** Takes the newest socket through the handshake, as a working server does. */
    async authenticate() {
      const socket = harness.sockets.at(-1);

      assert.ok(socket, "the port should have been dialled");
      socket.open();
      socket.receive(JSON.stringify({ auth: "ok" }));
      await vi.waitFor(async () => assert.equal((await port()).connections.get(PORT)?.state, "connected"));

      return socket;
    },
  };
}

test("the keepalive alarm runs the keepalive", async () => {
  const harness = await loadBackground();
  const before = harness.tokenLoads();

  harness.fireAlarm();

  // It reloads the tokens first, which is the visible half of it.
  await vi.waitFor(() => assert.equal(harness.tokenLoads(), before + 1));
});

test("a long-lived server is not suppressed the first time its socket drops", async () => {
  const harness = await loadBackground();
  const socket = await harness.authenticate();

  // Up for well past the two-minute grace, which is the ordinary case.
  harness.advance(5 * 60_000);
  // Safari suspending the background page is what closes this, and the
  // comment on the prune calls that the normal reason.
  socket.close();

  await harness.keepalive();

  // The prune used to read `lastConnected`, which is when the port
  // authenticated and is never refreshed, as though it were "last seen". Any
  // server up longer than the grace period was dropped on its first blip, its
  // live token recorded as stale, and never dialled again.
  assert.ok(await harness.tracked(), "the port is still managed");
  assert.ok(!(await harness.stale()), "its live token is not stale");
});

test("a server that really has been gone for the grace period is suppressed", async () => {
  const harness = await loadBackground();
  const socket = await harness.authenticate();

  socket.close();
  // Now the time passes, with nothing on the other end.
  harness.advance(5 * 60_000);

  await harness.keepalive();

  assert.ok(!(await harness.tracked()), "a gone server is given up on");
  assert.ok(await harness.stale());
});

test("suppressing a port closes its socket rather than orphaning it", async () => {
  const harness = await loadBackground();
  const socket = await harness.authenticate();

  socket.close();
  harness.advance(5 * 60_000);
  await harness.keepalive();

  // A reconnect opens a fresh socket before the prune runs. Dropping the
  // record without closing it left one authenticating and answering requests
  // with nothing tracking it.
  const orphan = harness.sockets.at(-1);

  assert.notEqual(orphan, socket, "the port was dialled again after the drop");
  assert.equal(orphan?.readyState, 3, "the socket the prune left behind is closed");
});
