// How many ports the server tries is a setting (#155), and the extension has no
// matching one. It dials whichever ports have a token file, because a server
// writes a token for the port it actually bound and nothing else could be
// authenticated anyway. These pin that: any port with a token is dialled, with
// no range in the way, and the only bound is on how many connections a
// directory full of files can create.

import assert from "node:assert/strict";
import { Duration } from "effect";
import { afterEach, test, vi } from "vitest";

import { Connections } from "../src/background/Connections.ts";
import { serverHandshake } from "./helpers/bridge-handshake.ts";
import { askPopup, fakeBrowser, launch, settle, stopAll } from "./helpers/fake-browser.ts";

afterEach(async () => {
  vi.restoreAllMocks();
  await stopAll();
});

async function loadBackground(
  initialTokens: Readonly<Record<string, string>> = {},
  { manualPorts = [] }: { readonly manualPorts?: ReadonlyArray<number> } = {},
) {
  const tokenMap = new Map(Object.entries(initialTokens));
  const warnings: Array<string> = [];
  const api = fakeBrowser();

  vi.spyOn(console, "log").mockImplementation((...args: Array<unknown>) => void warnings.push(args.join(" ")));

  // What the native handler does: the map when there is any token file, and
  // `no_token_files` when there is none.
  api.runtime.sendNativeMessage = async () =>
    tokenMap.size === 0 ? { error: "no_token_files" } : { tokens: Object.fromEntries(tokenMap) };
  api.storage.local.get = async () => ({ manualPorts: [...manualPorts] });
  api.tabs.get = async () => {
    throw new Error("not found");
  };

  // A backoff reconnect is not what is under test, so it never lands.
  const { harness } = launch(api, {
    timing: { reconnectBase: Duration.minutes(10), reconnectMax: Duration.minutes(10) },
  });

  await harness.start();

  const inspect = () => harness.run(Connections.use((connections) => connections.inspect));

  return {
    api,
    tokenMap,
    warnings,
    sockets: harness.sockets,
    connections: async () => (await inspect()).connections,
    /** The ports the popup would list. */
    visiblePorts: async () =>
      (await harness.run(Connections.use((connections) => connections.statuses))).map(({ port }) => port),
    dialledPorts: () => harness.sockets.map((socket) => Number(new URL(socket.url).port)),
    keepalive: () => harness.run(Connections.use((connections) => connections.keepalive)),
    async addPort(port: number) {
      await askPopup(api.runtime.onMessage, { type: "addPort", port }).reply;
      await settle();
    },
    async authenticate(port: number, token: string) {
      const socket = harness.sockets.findLast((candidate) => candidate.url.endsWith(`:${port}`));

      assert.ok(socket, `port ${port} should have been dialled`);
      socket.open();
      await serverHandshake(socket, { token, port });
      await vi.waitFor(async () => assert.equal((await inspect()).connections.get(port)?.state, "connected"));

      return socket;
    },
  };
}

const sorted = (ports: ReadonlyArray<number>) => [...ports].sort((a, b) => a - b);

const tokensFor = (count: number, from = 9000) =>
  Object.fromEntries(Array.from({ length: count }, (_, offset) => [from + offset, `token-${offset}`]));

test("a port nowhere near the default is dialled without being configured", async () => {
  // A server started with --port 9000, and one that fell back past the old
  // tenth-port window, both write a token for the port they bound.
  const harness = await loadBackground({ 8089: "token-a", 8104: "token-b", 9000: "token-c" });

  assert.deepEqual(sorted(harness.dialledPorts()), [8089, 8104, 9000]);
  assert.deepEqual(sorted(await harness.visiblePorts()), [8089, 8104, 9000]);
});

test("a server that comes up later is found on the next keepalive", async () => {
  const harness = await loadBackground();

  assert.equal(harness.sockets.length, 0);

  harness.tokenMap.set("9003", "token");
  await harness.keepalive();

  assert.deepEqual(harness.dialledPorts(), [9003]);
});

test("with no server running there is nothing to dial and nothing listed", async () => {
  // A fixed window used to create a connection for each of ten ports up front.
  const harness = await loadBackground();

  assert.equal((await harness.connections()).size, 0);
  assert.equal(harness.sockets.length, 0);
  assert.deepEqual(await harness.visiblePorts(), []);
});

test("a token directory full of files cannot create unbounded connections", async () => {
  const harness = await loadBackground(tokensFor(200));

  assert.equal((await harness.connections()).size, 64);
  assert.equal(harness.sockets.length, 64);

  // The same 64 each time, not whichever the directory listed first.
  const dialled = sorted(harness.dialledPorts());

  assert.equal(dialled[0], 9000);
  assert.equal(dialled.at(-1), 9063);
  assert.ok(
    harness.warnings.some((line) => line.includes("136")),
    "the ports left out are reported",
  );

  // Reading again changes nothing.
  await harness.keepalive();
  assert.equal((await harness.connections()).size, 64);
});

test("a port added by hand is not held to the cap", async () => {
  const harness = await loadBackground({ ...tokensFor(70), 9500: "manual-token" }, { manualPorts: [9500] });
  const connections = await harness.connections();

  assert.ok(connections.has(9500));
  assert.ok(harness.dialledPorts().includes(9500));
  assert.equal([...connections.values()].filter((conn) => !conn.manual).length, 64);
});

test("a port that loses its token loses its connection", async () => {
  const harness = await loadBackground({ 9000: "token-a", 9001: "token-b" });

  assert.deepEqual(sorted(await harness.visiblePorts()), [9000, 9001]);

  harness.tokenMap.delete("9000");
  await harness.keepalive();

  assert.ok(!(await harness.connections()).has(9000), "the dead port is dropped");
  assert.equal(harness.sockets.find((socket) => socket.url.endsWith(":9000"))?.readyState, 3, "and its socket closed");
  assert.deepEqual(await harness.visiblePorts(), [9001]);
});

test("the last server stopping is noticed, not mistaken for a failed read", async () => {
  // With no token file at all the handler sends no map, only an error, and
  // taking that for a failed read left the final server's port in place forever.
  const harness = await loadBackground({ 9000: "token" });

  harness.tokenMap.clear();
  await harness.keepalive();

  assert.equal((await harness.connections()).size, 0);
  assert.deepEqual(await harness.visiblePorts(), []);
});

test("a token that goes away frees its slot for another", async () => {
  const harness = await loadBackground(tokensFor(64));

  harness.tokenMap.delete("9000");
  harness.tokenMap.set("9100", "late");
  await harness.keepalive();

  const connections = await harness.connections();

  assert.ok(!connections.has(9000));
  assert.ok(connections.has(9100));
  assert.equal(connections.size, 64);
});

test("an authenticated socket outlives its token file until it closes", async () => {
  // The token is only needed to dial, and a read that finds none is a server
  // stopping or a directory changing under us; the socket says which, by closing.
  const harness = await loadBackground({ 9000: "token" });
  const socket = await harness.authenticate(9000, "token");

  harness.tokenMap.clear();
  await harness.keepalive();
  assert.ok((await harness.connections()).has(9000), "still connected, so still managed");
  assert.notEqual(socket.readyState, 3);

  socket.close();
  await harness.keepalive();
  assert.ok(!(await harness.connections()).has(9000), "gone once the socket is");
});

test("a port added by hand survives having no token", async () => {
  const harness = await loadBackground();

  await harness.addPort(9100);
  await harness.keepalive();

  const connections = await harness.connections();

  assert.ok(connections.has(9100));
  assert.ok(connections.get(9100)?.manual);
  assert.deepEqual(await harness.visiblePorts(), [9100]);
});

test("a port restored from storage survives having no token", async () => {
  const harness = await loadBackground({}, { manualPorts: [9200] });

  await harness.keepalive();

  assert.ok((await harness.connections()).has(9200));
  assert.deepEqual(await harness.visiblePorts(), [9200]);
});

test("a port that has a token and was added by hand stays when the token goes", async () => {
  const harness = await loadBackground({ 9300: "token" });

  await harness.addPort(9300);
  harness.tokenMap.clear();
  await harness.keepalive();

  assert.ok((await harness.connections()).has(9300));
});
