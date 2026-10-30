// Plays the server's half of the bridge handshake against a fake socket.

import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { vi } from "vitest";

import type { JsonValue } from "../../src/shared/protocol.ts";
import type { FakeSocket } from "./background.ts";

/** What a server sends: a handshake frame or a request, or raw text that need not parse. */
export type ServerFrame = string | { readonly [field: string]: JsonValue };

export const PROTOCOL_VERSION = 2;

export const base64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

export const newNonce = (): string => base64Url(randomBytes(32));

// Node's own HMAC rather than WebCrypto, so the extension's proofs are checked by
// an implementation that shares no code with the one that made them.
const mac = (token: string, message: string) => createHmac("sha256", token).update(message).digest();

/** What a genuine server sends to show it holds `token`. */
export const serverProof = (token: string, port: number, clientNonce: string, serverNonce: string): string =>
  base64Url(mac(token, `mcpsafari-v${PROTOCOL_VERSION}-server|${port}|${clientNonce}|${serverNonce}`));

/** What the extension is expected to answer with. */
export const expectedClientProof = (token: string, port: number, clientNonce: string, serverNonce: string): string =>
  base64Url(mac(token, `mcpsafari-v${PROTOCOL_VERSION}-client|${port}|${serverNonce}|${clientNonce}`));

export interface Hello {
  readonly clientNonce: string;
  readonly extensionVersion: string;
  readonly protocolVersion: number;
  readonly profileId: string;
}

/** The hello the extension sent on `socket`, which is always its first frame. */
export const helloOn = (socket: FakeSocket): Hello => JSON.parse(socket.sent[0] ?? "{}").hello;

/** A challenge frame as a server holding `token` would send it for `hello`. */
export const challengeFor = (
  hello: Hello,
  {
    token = "",
    port = 0,
    serverNonce = newNonce(),
    proof,
  }: { readonly token?: string; readonly port?: number; readonly serverNonce?: string; readonly proof?: string },
) => ({
  challenge: {
    serverNonce,
    serverProof: proof ?? serverProof(token, port, hello.clientNonce, serverNonce),
    protocolVersion: PROTOCOL_VERSION,
    serverVersion: "9.9.9",
  },
});

/** Delivers one frame from the server to `socket`. */
export const deliver = (socket: FakeSocket, frame: ServerFrame): void =>
  socket.receive(typeof frame === "string" ? frame : JSON.stringify(frame));

/**
 * Delivers a challenge and waits for the extension to have dealt with it: sent
 * its proof, or closed the socket. The proof is computed with WebCrypto, which
 * answers asynchronously.
 */
export const deliverChallenge = async (socket: FakeSocket, frame: ServerFrame): Promise<void> => {
  const before = socket.sent.length;

  deliver(socket, frame);
  await vi.waitFor(() =>
    assert.ok(socket.sent.length > before || socket.readyState === 3, "no answer to the challenge"),
  );
};

/**
 * Plays a genuine server through the whole exchange on an open socket: reads the
 * hello, sends a correct challenge, checks the extension's proof, and says ok.
 * Returns the frames the extension sent, so a test can look at all of them.
 */
export async function serverHandshake(
  socket: FakeSocket,
  { token, port }: { readonly token: string; readonly port: number },
): Promise<Array<unknown>> {
  const hello = helloOn(socket);
  const serverNonce = newNonce();

  await deliverChallenge(socket, challengeFor(hello, { token, port, serverNonce }));

  const proofFrame = JSON.parse(socket.sent[1] ?? "{}");

  if (proofFrame.auth?.clientProof !== expectedClientProof(token, port, hello.clientNonce, serverNonce)) {
    throw new Error(`the extension's proof was wrong: ${socket.sent[1]}`);
  }

  deliver(socket, { auth: "ok", protocolVersion: PROTOCOL_VERSION });

  return socket.sent.map((frame) => JSON.parse(frame));
}
