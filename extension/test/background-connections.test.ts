// How the background manages its server connections and answers the popup
// about them. The popup's own rendering is tested in popup.test.ts.

import assert from "node:assert/strict";
import { Duration } from "effect";
import { afterEach, test, vi } from "vitest";

import { Connections } from "../src/background/Connections.ts";
import type { BackgroundTiming } from "../src/background/config.ts";
import type { StatusReply } from "../src/shared/popup.ts";
import {
  challengeFor,
  deliver,
  deliverChallenge,
  expectedClientProof,
  helloOn,
  newNonce,
  PROTOCOL_VERSION,
  serverHandshake,
  serverProof,
  type Hello,
} from "./helpers/bridge-handshake.ts";
import { askPopup, fakeBrowser, launch, settle, stopAll, type NativeTokensReply } from "./helpers/fake-browser.ts";

afterEach(async () => {
  vi.restoreAllMocks();
  await stopAll();
});

async function backgroundHarness(
  initialTokens: Readonly<Record<string, string>>,
  {
    profile,
    timing,
    nativeResponse,
  }: {
    readonly profile?: string;
    readonly timing?: Partial<BackgroundTiming>;
    readonly nativeResponse?: NativeTokensReply;
  } = {},
) {
  const tokenMap = new Map(Object.entries(initialTokens));
  const api = fakeBrowser();
  let nativeMessageCount = 0;
  // What the background logged, which is where a refused handshake says why.
  const logged: Array<string> = [];

  vi.spyOn(console, "log").mockImplementation((...args: Array<unknown>) => void logged.push(args.join(" ")));

  api.runtime.sendNativeMessage = async () => {
    nativeMessageCount++;

    if (nativeResponse) return nativeResponse;

    const response: NativeTokensReply = { tokens: Object.fromEntries(tokenMap) };

    // The appex omits this for extension builds without profile support.
    return profile === undefined ? response : { ...response, profile };
  };

  api.tabs.get = async () => {
    throw new Error("not found");
  };

  const { harness } = launch(api, timing ? { timing } : {});

  await harness.start();

  const inspect = () => harness.run(Connections.use((connections) => connections.inspect));

  return {
    api,
    logged,
    sockets: harness.sockets,
    tokenMap,
    nativeMessageCount: () => nativeMessageCount,
    loadAuthTokens: () => harness.run(Connections.use((connections) => connections.loadAuthTokens)),
    tracked: async (port: number) => (await inspect()).connections.has(port),
    staleToken: async (port: number) => (await inspect()).staleTokens.get(port),
    stateOf: async (port: number) => (await inspect()).connections.get(port)?.state,
    /** Opens the newest socket and returns the hello the extension sent on it. */
    openLatestSocket(): Hello {
      const socket = harness.sockets.at(-1);

      assert.ok(socket, "a port should have been dialled");
      socket.open();

      return helloOn(socket);
    },
    /** The newest socket failing, and the reconnect it schedules, if any, landing. */
    async failLatestSocket({ expectReconnect }: { readonly expectReconnect: boolean }) {
      const before = harness.sockets.length;

      harness.sockets.at(-1)?.close();

      if (expectReconnect) await vi.waitFor(() => assert.equal(harness.sockets.length, before + 1));
    },
  };
}

test("unchanged stale tokens stop reconnecting until their value changes", async () => {
  const harness = await backgroundHarness({ 8091: "stale-token" });

  assert.equal(harness.sockets.length, 1);

  // Three reconnects, and the fourth failure of a port that never answered
  // gives up on it and remembers its token as stale.
  for (let attempt = 0; attempt < 3; attempt++) await harness.failLatestSocket({ expectReconnect: true });
  await harness.failLatestSocket({ expectReconnect: false });

  assert.equal(await harness.tracked(8091), false);
  assert.equal(await harness.staleToken(8091), "stale-token");

  await harness.loadAuthTokens();
  assert.equal(harness.sockets.length, 4);
  assert.equal(await harness.tracked(8091), false);

  harness.tokenMap.set("8091", "replacement-token");
  await harness.loadAuthTokens();
  assert.equal(await harness.tracked(8091), true);
  assert.equal(harness.sockets.length, 5);
});

test("the handshake carries the Safari profile the appex reported", async () => {
  // Safari runs one instance of the extension per profile, all reading the same
  // token. Without this the server cannot tell them apart and evicts one for the
  // other, which is what made a two-profile setup flap.
  const harness = await backgroundHarness({ 8091: "current-token" }, { profile: "WORK-UUID" });

  const hello = harness.openLatestSocket();

  assert.equal(hello.profileId, "WORK-UUID");
  assert.equal(hello.protocolVersion, PROTOCOL_VERSION);
});

test("an appex that reports no profile leaves the handshake on the default", async () => {
  const harness = await backgroundHarness({ 8091: "current-token" });

  assert.equal(harness.openLatestSocket().profileId, "default");
});

test("the extension dials the IPv4 loopback address, never the name localhost", async () => {
  // The server binds 127.0.0.1 only. `localhost` can resolve to ::1 first, where
  // a different local user could be listening and would be the one answering.
  const harness = await backgroundHarness({ 8091: "current-token" });

  assert.equal(harness.sockets.at(-1)?.url, "ws://127.0.0.1:8091");
});

test("a token_mismatch reply makes the redial read the token again", async () => {
  // A restarted server writes a new token. The extension kept redialling with the
  // one it had cached and stayed locked out until the keepalive (#156).
  const harness = await backgroundHarness({ 8091: "old-token" });

  harness.openLatestSocket();

  const reads = harness.nativeMessageCount();

  harness.tokenMap.set("8091", "new-token");
  // The server closes after saying so, which the refusal does from this side.
  deliver(harness.sockets.at(-1)!, { auth: "error", error: "token_mismatch" });
  await vi.waitFor(() => assert.equal(harness.sockets.length, 2));

  assert.equal(harness.nativeMessageCount(), reads + 1, "tokens are read once for the attempt");
  // The token no longer appears in any frame, so which one the redial used is
  // told by whose proof it accepts: only a server holding the new one gets through.
  harness.openLatestSocket();
  await serverHandshake(harness.sockets.at(-1)!, { token: "new-token", port: 8091 });
  await vi.waitFor(async () => assert.equal(await harness.stateOf(8091), "connected"));
});

test("a socket that closes before authenticating also reads the token again", async () => {
  // The server may simply be gone or restarting, with nothing said at all.
  const harness = await backgroundHarness({ 8091: "old-token" });

  harness.openLatestSocket();
  harness.tokenMap.set("8091", "new-token");
  await harness.failLatestSocket({ expectReconnect: true });

  harness.openLatestSocket();
  await serverHandshake(harness.sockets.at(-1)!, { token: "new-token", port: 8091 });
  await vi.waitFor(async () => assert.equal(await harness.stateOf(8091), "connected"));
});

test("a connection that was authenticated redials without a token read", async () => {
  // Its token was good a moment ago, and the keepalive reloads tokens anyway.
  const harness = await backgroundHarness({ 8091: "current-token" });

  harness.openLatestSocket();
  await serverHandshake(harness.sockets.at(-1)!, { token: "current-token", port: 8091 });
  await vi.waitFor(async () => assert.equal(await harness.stateOf(8091), "connected"));

  const reads = harness.nativeMessageCount();

  await harness.failLatestSocket({ expectReconnect: true });

  assert.equal(harness.nativeMessageCount(), reads);
});

test("a single shared token from the host app is not dialled with", async () => {
  // Only the per-port map is read. A host app that answers with the old single
  // token has nothing the extension will use, so it dials nothing rather than
  // trying one secret against every port.
  const harness = await backgroundHarness({}, { nativeResponse: { token: "shared-token" } });

  // A port the user adds by hand is dialled once tokens are read, with whatever
  // token there is for it.
  const { reply } = askPopup(harness.api.runtime.onMessage, { type: "addPort", port: 8091 });

  await reply;
  await settle();

  assert.equal(harness.sockets.length, 0);
  assert.equal(await harness.stateOf(8091), "disconnected");
});

// ─── The challenge-response handshake ────────────────────────────────

const TOKEN = "B9F4C2A1-7E3D-4F10-9A6B-0C5D8E2F1A34";

/** A harness with one dialled, opened socket. */
async function openedHarness() {
  const harness = await backgroundHarness({ 8091: TOKEN });

  harness.openLatestSocket();

  const socket = harness.sockets.at(-1)!;

  return { harness, socket };
}

/** A request frame, and whether the extension answered it. */
const REQUEST = { id: "r1", action: "tabs_query", params: {} };

const answered = (sent: ReadonlyArray<string>) => sent.some((frame) => JSON.parse(frame).id === "r1");

test("the token is never sent, in the hello or in any frame after it", async () => {
  // The token is the key to both proofs. A listener that is not the real server
  // is handed whatever the extension sends on connecting, so none of it may be
  // the token.
  const { harness, socket } = await openedHarness();

  const frames = await serverHandshake(socket, { token: TOKEN, port: 8091 });

  assert.equal(frames.length, 2, "a hello and a proof");

  for (const frame of socket.sent) assert.ok(!frame.includes(TOKEN), frame);
  await vi.waitFor(async () => assert.equal(await harness.stateOf(8091), "connected"));
});

test("the proof it sends is the HMAC the server expects, in both directions", async () => {
  // Fixed bytes in place of the random ones, so the extension's WebCrypto output
  // can be held against a vector computed by another implementation. The Swift
  // side asserts the same two values.
  vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
    if (array instanceof Uint8Array) array.fill(0);

    return array;
  });

  const harness = await backgroundHarness({ 8089: TOKEN });
  const socket = harness.sockets.at(-1)!;

  harness.openLatestSocket();

  const clientNonce = "A".repeat(43);
  const serverNonce = "B".repeat(43);

  assert.equal(helloOn(socket).clientNonce, clientNonce);
  assert.equal(serverProof(TOKEN, 8089, clientNonce, serverNonce), "Vu6_f6XKAvJZ-jhqHWGJdqiV7Fg2ZfpPoM9koUiT22U");

  await deliverChallenge(socket, challengeFor(helloOn(socket), { token: TOKEN, port: 8089, serverNonce }));

  assert.equal(JSON.parse(socket.sent[1] ?? "{}").auth.clientProof, "Pd_tPFSAAAEYm9VKBPq4lTqgdoj3DS1i-FN1nh6B-1E");
  assert.equal(
    expectedClientProof(TOKEN, 8089, clientNonce, serverNonce),
    "Pd_tPFSAAAEYm9VKBPq4lTqgdoj3DS1i-FN1nh6B-1E",
  );
});

test("an ok with no proof behind it does not authenticate the server", async () => {
  // Any listener on the port can send {"auth":"ok"}. Before the challenge it was
  // all the extension asked for, so it began answering requests from whoever
  // was there.
  const { harness, socket } = await openedHarness();

  deliver(socket, { auth: "ok", protocolVersion: PROTOCOL_VERSION });

  assert.equal(socket.readyState, 3, "the socket is closed");
  assert.notEqual(await harness.stateOf(8091), "connected");
  assert.equal(socket.sent.length, 1, "nothing but the hello was sent");
});

test("a server that cannot prove it holds the token gets no proof back and is never served", async () => {
  const { harness, socket } = await openedHarness();

  // Right shape, wrong key: what a listener that merely accepted the dial can do.
  await deliverChallenge(socket, challengeFor(helloOn(socket), { token: "some-other-token", port: 8091 }));

  assert.equal(socket.readyState, 3);
  assert.equal(socket.sent.length, 1, "no clientProof was sent");
  assert.notEqual(await harness.stateOf(8091), "connected");
  await vi.waitFor(() => assert.ok(harness.logged.some((line) => line.includes("did not prove it knows the token"))));

  // And what it sends next is not read as a request.
  deliver(socket, REQUEST);
  await settle();
  assert.equal(answered(socket.sent), false);
});

test("a proof made for another port, or in the client's direction, is refused", async () => {
  const forgeries: ReadonlyArray<(hello: Hello, serverNonce: string) => string> = [
    // The right token, for a different listener.
    (hello, serverNonce) => serverProof(TOKEN, 8092, hello.clientNonce, serverNonce),
    // The client's proof offered as the server's: reflection.
    (hello, serverNonce) => expectedClientProof(TOKEN, 8091, hello.clientNonce, serverNonce),
    // The server's nonces in the wrong order.
    (hello, serverNonce) => serverProof(TOKEN, 8091, serverNonce, hello.clientNonce),
  ];

  for (const forge of forgeries) {
    const { harness, socket } = await openedHarness();
    const serverNonce = newNonce();

    await deliverChallenge(
      socket,
      challengeFor(helloOn(socket), { serverNonce, proof: forge(helloOn(socket), serverNonce) }),
    );

    assert.equal(socket.readyState, 3);
    assert.equal(socket.sent.length, 1);
    assert.notEqual(await harness.stateOf(8091), "connected");
  }
});

test("a request that arrives before the handshake is finished is never dispatched", async () => {
  const { socket } = await openedHarness();

  // Before any challenge.
  deliver(socket, REQUEST);
  await settle();

  assert.equal(answered(socket.sent), false);
  assert.equal(socket.readyState, 3, "a peer that skips the handshake is dropped");
  assert.equal(socket.sent.length, 1);
});

test("a request between the server's proof and its ok is not dispatched", async () => {
  const { harness, socket } = await openedHarness();

  await deliverChallenge(socket, challengeFor(helloOn(socket), { token: TOKEN, port: 8091 }));
  assert.equal(socket.sent.length, 2, "the extension answered the genuine challenge");

  deliver(socket, REQUEST);
  await settle();

  assert.equal(answered(socket.sent), false);
  assert.equal(socket.readyState, 3);
  assert.notEqual(await harness.stateOf(8091), "connected");
});

test("a frame arriving while the challenge is still being verified is refused", async () => {
  const { harness, socket } = await openedHarness();

  // Both before the proof has been computed: the second one finds a stage that
  // accepts nothing, rather than being read as the ok.
  deliver(socket, challengeFor(helloOn(socket), { token: TOKEN, port: 8091 }));
  deliver(socket, { auth: "ok", protocolVersion: PROTOCOL_VERSION });
  await settle();

  assert.equal(socket.readyState, 3);
  assert.equal(socket.sent.length, 1, "no proof is sent on a socket that was refused");
  assert.notEqual(await harness.stateOf(8091), "connected");
});

test("a second challenge on a finished handshake is not answered", async () => {
  const { harness, socket } = await openedHarness();

  await serverHandshake(socket, { token: TOKEN, port: 8091 });
  await vi.waitFor(async () => assert.equal(await harness.stateOf(8091), "connected"));

  const sent = socket.sent.length;

  // A genuine challenge again would be a request with no id, which is dropped
  // rather than answered, and in particular is not a second proof.
  deliver(socket, challengeFor(helloOn(socket), { token: TOKEN, port: 8091 }));
  await settle();

  assert.equal(socket.sent.length, sent);
});

test("a challenge whose nonce is malformed is refused", async () => {
  const { harness, socket } = await openedHarness();

  deliver(socket, { challenge: { serverNonce: "short", serverProof: "x" } });

  assert.equal(socket.readyState, 3);
  assert.equal(socket.sent.length, 1);
  assert.notEqual(await harness.stateOf(8091), "connected");
});

test("once authenticated, requests are dispatched as before", async () => {
  const { harness, socket } = await openedHarness();

  await serverHandshake(socket, { token: TOKEN, port: 8091 });
  await vi.waitFor(async () => assert.equal(await harness.stateOf(8091), "connected"));

  deliver(socket, REQUEST);

  await vi.waitFor(() => assert.equal(JSON.parse(socket.sent.at(-1) ?? "{}").id, "r1"));
});

test("a server proof that fails reads the token again before the next dial", async () => {
  // The usual reason a genuine server fails the check is that it restarted and
  // wrote a new token, the same situation #156 covers.
  const { harness, socket } = await openedHarness();

  harness.tokenMap.set("8091", "the-new-token");

  const reads = harness.nativeMessageCount();

  await deliverChallenge(socket, challengeFor(helloOn(socket), { token: "the-new-token", port: 8091 }));
  await vi.waitFor(() => assert.equal(harness.sockets.length, 2));

  assert.equal(harness.nativeMessageCount(), reads + 1);
  harness.openLatestSocket();
  await serverHandshake(harness.sockets.at(-1)!, { token: "the-new-token", port: 8091 });
  await vi.waitFor(async () => assert.equal(await harness.stateOf(8091), "connected"));
});

test("a protocol mismatch is reported with both versions and what to do", async () => {
  const { harness, socket } = await openedHarness();

  deliver(socket, {
    auth: "error",
    error: "protocol_version_mismatch",
    extensionProtocolVersion: PROTOCOL_VERSION,
    serverProtocolVersion: 1,
  });

  await vi.waitFor(() => assert.ok(harness.logged.some((entry) => entry.includes("Protocol mismatch"))));

  const line = harness.logged.find((entry) => entry.includes("Protocol mismatch")) ?? "";

  assert.match(line, new RegExp(`extension=${PROTOCOL_VERSION}`));
  assert.match(line, /server=1/);
  assert.match(line, /Install matching/);
});

test("popup status polling does not restart disconnected ports", async () => {
  // A reconnect far enough out that it cannot land during the test, so the
  // port stays disconnected for the popup to see.
  const harness = await backgroundHarness(
    { 8091: "current-token" },
    { timing: { reconnectBase: Duration.minutes(10), reconnectMax: Duration.minutes(10) } },
  );

  harness.sockets.at(-1)?.close();

  const socketCount = harness.sockets.length;
  const initialNativeMessageCount = harness.nativeMessageCount();

  // The old listener answered this one synchronously and returned false; every
  // popup message is now answered once its effect has run, so the channel is
  // held open for it. What the popup receives is the same.
  const { staysOpen, reply } = askPopup(harness.api.runtime.onMessage, { type: "getStatus" });

  assert.equal(staysOpen, true);

  // SAFETY: a getStatus request is answered with a StatusReply.
  const response = (await reply) as StatusReply;

  await settle();

  assert.equal(harness.nativeMessageCount(), initialNativeMessageCount);
  assert.equal(harness.sockets.length, socketCount);
  assert.equal(response.ports[0]?.port, 8091);
  assert.equal(response.ports[0]?.state, "disconnected");
});

test("explicit connection refresh reloads tokens once", async () => {
  const harness = await backgroundHarness({ 8091: "current-token" });
  const initialNativeMessageCount = harness.nativeMessageCount();

  const { staysOpen, reply } = askPopup(harness.api.runtime.onMessage, { type: "refreshConnections" });

  assert.equal(staysOpen, true);

  // SAFETY: a refreshConnections request is answered with a StatusReply.
  const response = (await reply) as StatusReply;

  assert.equal(harness.nativeMessageCount(), initialNativeMessageCount + 1);
  assert.equal(response.ports[0]?.port, 8091);
});

test("a message that is not the popup's gets no reply", async () => {
  const harness = await backgroundHarness({});

  // SAFETY: deliberately not a popup request; the listener has to decode it.
  const { staysOpen } = askPopup(harness.api.runtime.onMessage, { type: "somethingElse" } as never);

  // False tells Safari this listener will not answer, so another one may.
  assert.equal(staysOpen, false);
});
