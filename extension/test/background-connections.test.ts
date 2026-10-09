// How the background manages its server connections and answers the popup
// about them. The popup's own rendering is tested in popup.test.ts.

import assert from "node:assert/strict";
import { Duration } from "effect";
import { afterEach, test, vi } from "vitest";

import { Connections } from "../src/background/Connections.ts";
import type { BackgroundTiming } from "../src/background/config.ts";
import type { StatusReply } from "../src/shared/popup.ts";
import { askPopup, fakeBrowser, launch, settle, stopAll, type NativeTokensReply } from "./helpers/fake-browser.ts";

afterEach(stopAll);

async function backgroundHarness(
  initialTokens: Readonly<Record<string, string>>,
  { profile, timing }: { readonly profile?: string; readonly timing?: Partial<BackgroundTiming> } = {},
) {
  const tokenMap = new Map(Object.entries(initialTokens));
  const api = fakeBrowser();
  let nativeMessageCount = 0;

  api.runtime.sendNativeMessage = async () => {
    nativeMessageCount++;

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
    sockets: harness.sockets,
    tokenMap,
    nativeMessageCount: () => nativeMessageCount,
    loadAuthTokens: () => harness.run(Connections.use((connections) => connections.loadAuthTokens)),
    tracked: async (port: number) => (await inspect()).connections.has(port),
    staleToken: async (port: number) => (await inspect()).staleTokens.get(port),
    /** Opens the newest socket and returns the handshake frame the extension sent on it. */
    openLatestSocket() {
      const socket = harness.sockets.at(-1);

      assert.ok(socket, "a port should have been dialled");
      socket.open();

      return JSON.parse(socket.sent.at(-1) ?? "{}");
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

  const handshake = harness.openLatestSocket();

  assert.equal(handshake.profileId, "WORK-UUID");
  assert.equal(handshake.auth, "current-token");
});

test("an appex that reports no profile leaves the handshake on the default", async () => {
  const harness = await backgroundHarness({ 8091: "current-token" });

  assert.equal(harness.openLatestSocket().profileId, "default");
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
