// The WebSocket clients: one per server port, each authenticating, answering
// bridge requests, and reconnecting when its server goes away.
//
// Ports are discovered from the token files the servers write, one per port they
// bound, so there is no range to scan and none to keep in step with the server's
// `--port-range`. A port that has a token gets a connection; one whose token is
// gone loses it, and one that never answers is given up on after
// `autoGiveUpAttempts` or `autoCleanup`. Manually added ports are persisted in
// storage.local across restarts.

import { Clock, Context, Duration, Effect, FiberSet, Layer, Option, Predicate, Schema } from "effect";
import { Browser, callBrowser } from "./Browser.ts";
import {
  BackgroundTiming,
  BRIDGE_PROTOCOL_VERSION,
  DEFAULT_PROFILE_ID,
  MAX_DISCOVERED_PORTS,
  MAX_PORT,
  MIN_PORT,
  NATIVE_HOST_ID,
} from "./config.ts";
import { failureResponse, fromUnknown } from "./errors.ts";
import { BridgeRequest, Router } from "./Router.ts";

export type ConnectionState = "disconnected" | "connecting" | "connected";

interface Connection {
  ws: WebSocket | null;
  state: ConnectionState;
  attempts: number;
  manual: boolean;
  lastConnected: number;
  /**
   * When the socket last went away, which is a different question from when it
   * last authenticated. The cleanup wants "how long has this server been gone",
   * and `lastConnected` cannot answer it.
   */
  disconnectedAt: number;
}

/** One port as the popup shows it. */
export interface PortStatus {
  readonly port: number;
  readonly state: ConnectionState;
  readonly manual: boolean;
}

/** The constructor sockets are made with. A reference so tests can supply their own. */
export const WebSocketConstructor = Context.Reference<typeof WebSocket>("mcpsafari/background/WebSocketConstructor", {
  defaultValue: () => WebSocket,
});

/** What the appex answers `getTokens` with. */
const NativeTokens = Schema.Struct({
  profile: Schema.optionalKey(Schema.String),
  tokens: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  error: Schema.optionalKey(Schema.String),
});

/**
 * A server frame before the socket is ready. Every field is read loosely: what
 * an unauthenticated peer sends is judged here, field by field, and anything out
 * of shape closes the socket rather than failing to decode somewhere else.
 */
const HandshakeFrame = Schema.fromJsonString(
  Schema.Struct({
    auth: Schema.optionalKey(Schema.Unknown),
    error: Schema.optionalKey(Schema.Unknown),
    protocolVersion: Schema.optionalKey(Schema.Unknown),
    serverProtocolVersion: Schema.optionalKey(Schema.Unknown),
    challenge: Schema.optionalKey(Schema.Unknown),
  }),
);

const decodeHandshakeFrame = Schema.decodeUnknownOption(HandshakeFrame);

/** The server's answer to the hello: its nonce, and its proof that it holds the token. */
const Challenge = Schema.Struct({ serverNonce: Schema.String, serverProof: Schema.String });

const isChallenge = Schema.is(Challenge);

/** Any later frame: a request, which is only answerable if it carries an id. */
const IncomingRequest = Schema.fromJsonString(BridgeRequest);

const isUserPort = (port: number) => port >= MIN_PORT && port <= MAX_PORT;

// ─── Handshake primitives ────────────────────────────────────────────
//
// The token proves itself without being sent. Each side returns an HMAC of both
// sides' fresh nonces under it, and the extension checks the server's proof
// before it sends its own, so a listener that merely accepted the connection gets
// nothing it could replay, and this socket acts on none of its frames. The two
// proofs carry different labels and take the nonces in different orders, so
// neither can be turned around and offered as the other. `BridgeHandshake.swift`
// is the other half.

const base64UrlEncode = (bytes: Uint8Array): string => {
  let binary = "";

  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** The bytes of unpadded base64url text, or null for anything else. */
const base64UrlDecode = (text: string): Uint8Array<ArrayBuffer> | null => {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;

  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);

  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
};

/** 32 random bytes, which is always 43 characters of base64url. */
const randomNonce = () => base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));

const isWellFormedNonce = (nonce: string) => nonce.length === 43 && base64UrlDecode(nonce)?.length === 32;

/** What each side authenticates. */
const handshakeMessage = (role: "server" | "client", port: number, first: string, second: string) =>
  new TextEncoder().encode(`mcpsafari-v${BRIDGE_PROTOCOL_VERSION}-${role}|${port}|${first}|${second}`);

/**
 * Checks the server's proof and, only if it holds, makes this side's. Null when
 * the server did not prove it knows the token.
 */
const proveHandshake = (token: string, port: number, clientNonce: string, serverNonce: string, serverProof: string) =>
  Effect.tryPromise({
    try: async () => {
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(token),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      );

      const proof = base64UrlDecode(serverProof);

      const genuine =
        proof !== null &&
        (await crypto.subtle.verify("HMAC", key, proof, handshakeMessage("server", port, clientNonce, serverNonce)));

      if (!genuine) return null;

      const clientProof = await crypto.subtle.sign(
        "HMAC",
        key,
        handshakeMessage("client", port, serverNonce, clientNonce),
      );

      return base64UrlEncode(new Uint8Array(clientProof));
    },
    catch: fromUnknown,
  });

/** Where a socket is in the handshake. Nothing is dispatched as a request until `ready`. */
type HandshakeStage = "awaitingChallenge" | "verifying" | "awaitingOk" | "ready" | "refused";

export class Connections extends Context.Service<
  Connections,
  {
    /** Makes sure a port is tracked, marking it manual (and remembering it) when asked. */
    ensurePort(port: number, manual?: boolean): Effect.Effect<void>;
    connectToPort(port: number): Effect.Effect<void>;
    readonly connectAll: Effect.Effect<void>;
    /** Reconnects every port that is not open, resetting backoff for ones worth it. */
    readonly reconnectKnownPorts: Effect.Effect<void>;
    /** Closes and forgets a port, and forgets that its token was stale. */
    disconnectPort(port: number): Effect.Effect<void>;
    /** Closes a socket and reconnects it straight away, as the popup's reconnect button does. */
    reconnectPort(port: number): Effect.Effect<void>;
    /** Stops tracking a manually added port. */
    removeManualPort(port: number): Effect.Effect<void>;
    readonly statuses: Effect.Effect<ReadonlyArray<PortStatus>>;
    /**
     * Asks the appex for the current tokens and profile, connects any newly
     * known port, and drops discovered ports whose token is gone.
     */
    readonly loadAuthTokens: Effect.Effect<void>;
    /** Restores manual ports from storage. Every other port comes from a token. */
    readonly restore: Effect.Effect<void>;
    /** The keepalive: reload tokens, reconnect, and drop discovered ports that are gone. */
    readonly keepalive: Effect.Effect<void>;
    /** For tests: the tracked state, read-only. */
    readonly inspect: Effect.Effect<{
      readonly connections: ReadonlyMap<number, Readonly<Connection>>;
      readonly staleTokens: ReadonlyMap<number, string>;
      readonly profileId: string;
    }>;
  }
>()("mcpsafari/background/Connections") {
  static readonly layer = Layer.effect(
    Connections,
    Effect.gen(function* () {
      const browserApi = yield* Browser;
      const router = yield* Router;
      const timing = yield* BackgroundTiming;
      const SocketImpl = yield* WebSocketConstructor;
      const clock = yield* Clock.Clock;
      const fibers = yield* FiberSet.make();
      const run = yield* FiberSet.runtime(fibers)<never>();

      const connections = new Map<number, Connection>();
      /** Manually added ports (persisted across restarts). */
      const manualPorts = new Set<number>();
      const authTokensByPort = new Map<number, string>();
      const staleTokensByPort = new Map<number, string>();
      // Safari runs a separate instance of this extension per profile, each with its own
      // background page reading the same tokens. Without an identity in the handshake every
      // instance looks like the same client, and the server evicts whichever one connected
      // first. The appex reads it from SFExtensionProfileKey; "default" means Safari sent none.
      let profileId = DEFAULT_PROFILE_ID;

      const now = () => clock.currentTimeMillisUnsafe();

      const ensurePortSync = (port: number, manual = false): Connection => {
        let conn = connections.get(port);

        if (!conn) {
          conn = { ws: null, state: "disconnected", attempts: 0, manual, lastConnected: 0, disconnectedAt: 0 };
          connections.set(port, conn);
        }

        if (manual) {
          conn.manual = true;
          manualPorts.add(port);
        }

        return conn;
      };

      const persistManualPorts = () => {
        try {
          if (browserApi.storage && browserApi.storage.local) {
            browserApi.storage.local.set({ manualPorts: [...manualPorts] }).catch(() => {});
          }
        } catch {
          /* ignore */
        }
      };

      const closeSocket = (conn: Connection | undefined) => {
        if (conn && conn.ws) conn.ws.close();
      };

      const suppressStaleTokenPort = (port: number) => {
        const token = authTokensByPort.get(port);

        if (token) staleTokensByPort.set(port, token);

        // Close it as `disconnectPort` does. Dropping the record while a socket was
        // still opening left one nothing managed: it would finish its handshake,
        // answer requests, and have no entry in `connections`, so the popup showed
        // nothing and its eventual close found no connection to reconnect.
        closeSocket(connections.get(port));
        connections.delete(port);
      };

      // `reloadTokens` is for a dial that never got authenticated. A server that
      // restarted writes a new token, and the one cached here is for the old run,
      // so redialling with it only locks the extension out until the next
      // keepalive (#156). It is one native read per attempt, and attempts are
      // already spaced by the backoff below, so a server that keeps refusing
      // cannot make this a tight loop.
      const disconnectPortSync = (port: number) => {
        closeSocket(connections.get(port));
        connections.delete(port);
        staleTokensByPort.delete(port);
      };

      const scheduleReconnect = (port: number, reloadTokens: boolean) => {
        const conn = connections.get(port);

        if (!conn) return;

        if (!conn.manual && conn.lastConnected === 0 && conn.attempts >= timing.autoGiveUpAttempts) {
          suppressStaleTokenPort(port);

          return;
        }

        const delay = Math.min(
          Duration.toMillis(timing.reconnectBase) * Math.pow(2, conn.attempts),
          Duration.toMillis(timing.reconnectMax),
        );

        conn.attempts++;
        run(
          Effect.sleep(Duration.millis(delay)).pipe(
            Effect.andThen(reloadTokens ? loadAuthTokens : Effect.void),
            Effect.andThen(Effect.sync(() => connectToPort(port))),
          ),
        );
      };

      const answer = (socket: WebSocket, port: number, data: string) =>
        Effect.gen(function* () {
          const request = yield* Schema.decodeEffect(IncomingRequest)(data).pipe(Effect.option);

          // `JSON.parse` is happy with `null`, `5`, or a bare string, and none of
          // those has an id to answer. Dropping it here is loud and cannot cascade.
          if (Option.isNone(request)) {
            return yield* Effect.logError(`[MCPSafari:${port}] Ignoring a frame that carries no request id`);
          }

          const response = yield* router.handle(request.value);

          yield* Effect.try({
            try: () => socket.send(JSON.stringify(response)),
            catch: fromUnknown,
          }).pipe(
            Effect.catch((error) =>
              Effect.andThen(
                Effect.logError(`[MCPSafari:${port}] Error:`, error.message),
                Effect.sync(() => socket.send(JSON.stringify(failureResponse(request.value.id, error)))),
              ),
            ),
          );
        });

      function connectToPort(port: number): void {
        const conn = connections.get(port);

        if (!conn) return;

        if (conn.ws && (conn.ws.readyState === SocketImpl.OPEN || conn.ws.readyState === SocketImpl.CONNECTING)) return;

        // Security: every server instance requires its per-port auth token.
        const authToken = authTokensByPort.get(port);

        if (!authToken) {
          conn.state = "disconnected";

          return; // Skip — can't verify server identity without auth
        }

        conn.state = "connecting";

        // The literal address the server binds, not the name `localhost`. The
        // name can resolve to ::1 first, where another local user could be
        // listening and would receive the handshake.
        const socket = new SocketImpl(`ws://127.0.0.1:${port}`);

        conn.ws = socket;

        //   awaitingChallenge -> verifying -> awaitingOk -> ready
        let stage: HandshakeStage = "awaitingChallenge";
        let clientNonce = "";
        // Whether the server ever accepted this socket. A close before that means
        // the token this dial used may be out of date, which the reconnect acts on.
        let authenticated = false;

        // Closing here, not just ignoring the frame: a peer that sent something
        // out of turn is not one to keep talking to.
        const refuse = (reason: string) => {
          stage = "refused";
          run(Effect.logError(`[MCPSafari:${port}] ${reason}`));
          socket.close();
        };

        const answerChallenge = (serverNonce: string, serverProof: string) =>
          proveHandshake(authToken, port, clientNonce, serverNonce, serverProof).pipe(
            Effect.match({
              onFailure: (error) => refuse(`Handshake failed: ${error.message}`),
              onSuccess: (clientProof) => {
                if (clientProof === null) {
                  return refuse("The server did not prove it knows the token; not authenticating");
                }

                // Refused or closed while the proofs were being computed.
                if (stage !== "verifying" || socket.readyState !== SocketImpl.OPEN) return;

                stage = "awaitingOk";
                socket.send(JSON.stringify({ auth: { clientProof } }));
              },
            }),
          );

        // Judged synchronously as each frame arrives, so a second frame landing
        // while the first is being verified finds a stage that accepts nothing.
        const continueHandshake = (data: string) => {
          const frame = decodeHandshakeFrame(data);

          if (Option.isNone(frame)) return refuse("Invalid handshake frame");

          const message = frame.value;

          if (message.auth === "error") {
            if (message.error === "protocol_version_mismatch") {
              return refuse(
                `Protocol mismatch: extension=${BRIDGE_PROTOCOL_VERSION}, server=${JSON.stringify(message.serverProtocolVersion)}. ` +
                  "Install matching MCPSafari app and mcp-safari server versions.",
              );
            }

            return refuse(`Auth rejected: ${Predicate.isString(message.error) ? message.error : "unknown error"}`);
          }

          if (stage === "awaitingChallenge") {
            const challenge = message.challenge;

            if (!isChallenge(challenge) || !isWellFormedNonce(challenge.serverNonce)) {
              return refuse("Expected a challenge from the server");
            }

            stage = "verifying";
            run(answerChallenge(challenge.serverNonce, challenge.serverProof));

            return;
          }

          if (stage === "awaitingOk" && message.auth === "ok") {
            if (message.protocolVersion !== undefined && message.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
              return refuse(
                `Protocol mismatch: extension=${BRIDGE_PROTOCOL_VERSION}, server=${JSON.stringify(message.protocolVersion)}`,
              );
            }

            stage = "ready";
            authenticated = true;
            conn.lastConnected = now();
            conn.state = "connected";
            conn.attempts = 0;
            conn.disconnectedAt = 0;
            run(Effect.log(`[MCPSafari:${port}] Authenticated`));

            return;
          }

          refuse("Unexpected frame during the handshake");
        };

        socket.onopen = () => {
          clientNonce = randomNonce();
          // No token in this frame, or in any other this socket sends. It is the
          // key to the two proofs, and a listener that is not the real server
          // must not be handed it just for being dialled.
          socket.send(
            JSON.stringify({
              hello: {
                clientNonce,
                extensionVersion: browserApi.runtime.getManifest().version,
                protocolVersion: BRIDGE_PROTOCOL_VERSION,
                profileId,
              },
            }),
          );
          run(Effect.log(`[MCPSafari:${port}] Sent hello`));
        };

        socket.onmessage = (event: MessageEvent<string>) => {
          if (stage !== "ready") return continueHandshake(event.data);

          run(answer(socket, port, event.data));
        };

        socket.onclose = () => {
          conn.state = "disconnected";
          conn.ws = null;

          if (conn.disconnectedAt === 0) conn.disconnectedAt = now();
          scheduleReconnect(port, !authenticated);
        };

        socket.onerror = () => {
          /* logged by onclose */
        };
      }

      const reconnectKnownPortsSync = () => {
        for (const [port, conn] of connections) {
          if (conn.ws && conn.ws.readyState === SocketImpl.OPEN) continue;

          if (conn.lastConnected > 0 || conn.manual) conn.attempts = 0;

          connectToPort(port);
        }
      };

      /** How many connections exist only because a token file named their port. */
      const discoveredPortCount = () => {
        let count = 0;

        for (const conn of connections.values()) if (!conn.manual) count++;

        return count;
      };

      // Every port with a token gets a connection, whichever port it is. A server
      // writes a token for the port it actually bound, so this finds one that fell
      // back past the default, one started on another `--port`, and one given a
      // wider `--port-range`, with nothing here to set. Lowest port first so that,
      // past the cap, which ports are left out does not change from one read to
      // the next.
      const ensurePortsForKnownTokens = Effect.gen(function* () {
        let skipped = 0;

        for (const port of [...authTokensByPort.keys()].sort((a, b) => a - b)) {
          const token = authTokensByPort.get(port);

          if (staleTokensByPort.get(port) === token) continue;

          staleTokensByPort.delete(port);

          if (connections.has(port)) continue;

          const manual = manualPorts.has(port);

          if (!manual && discoveredPortCount() >= MAX_DISCOVERED_PORTS) {
            skipped++;
            continue;
          }

          ensurePortSync(port, manual);
          connectToPort(port);
        }

        if (skipped > 0) {
          yield* Effect.logWarning(
            `[MCPSafari] ${skipped} token file(s) left unused: the limit is ${MAX_DISCOVERED_PORTS} discovered ports`,
          );
        }
      });

      // A server removes its token file when it stops, so a port without one has
      // nothing left to dial. Ports added by hand stay. So does a socket that is
      // still authenticated: it needs no token to keep working, and it is pruned
      // on the next read once its server closes it.
      const pruneRemovedTokenPorts = () => {
        for (const [port, conn] of connections) {
          if (conn.manual || conn.state === "connected" || authTokensByPort.has(port)) continue;

          disconnectPortSync(port);
        }
      };

      const loadAuthTokens: Effect.Effect<void> = Effect.gen(function* () {
        const response = yield* callBrowser((api) =>
          api.runtime.sendNativeMessage(NATIVE_HOST_ID, { type: "getTokens" }),
        ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(NativeTokens)), Effect.mapError(fromUnknown));

        if (response.profile) profileId = response.profile;

        // The handler answers `no_token_files` when the directory holds no valid
        // token, which is every server having stopped. That is an answer, not a
        // failure: ignoring it left the last servers' ports in the map for good.
        const tokens = response.tokens ?? (response.error === "no_token_files" ? {} : null);

        if (!tokens) {
          return yield* Effect.logWarning("[MCPSafari] Failed to load auth tokens:", response.error || "unknown");
        }

        authTokensByPort.clear();

        for (const [port, token] of Object.entries(tokens)) {
          const parsedPort = parseInt(port, 10);

          if (isUserPort(parsedPort) && token) authTokensByPort.set(parsedPort, token);
        }

        for (const port of staleTokensByPort.keys()) {
          if (!authTokensByPort.has(port)) staleTokensByPort.delete(port);
        }

        pruneRemovedTokenPorts();
        yield* ensurePortsForKnownTokens;
        yield* Effect.log(`[MCPSafari] Loaded ${authTokensByPort.size} auth token(s)`);
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("[MCPSafari] Native messaging unavailable for tokens:", error.message),
        ),
        Effect.provideService(Browser, browserApi),
      );

      const restore = Effect.gen(function* () {
        // Restore manually added ports (persists across Safari restarts)
        if (browserApi.storage && browserApi.storage.local) {
          const data = yield* callBrowser((api) => api.storage.local.get("manualPorts"));
          const stored = data["manualPorts"];

          if (Array.isArray(stored)) {
            for (const port of stored) {
              if (Predicate.isNumber(port)) ensurePortSync(port, true);
            }
          }
        }
        // No ports are created here beyond the ones added by hand. The others
        // come from `ensurePortsForKnownTokens`, one for each token a server has
        // written.
      }).pipe(Effect.ignore, Effect.provideService(Browser, browserApi));

      const keepalive = Effect.gen(function* () {
        yield* loadAuthTokens;
        reconnectKnownPortsSync();

        // Clean up discovered ports that have never connected or have been
        // disconnected for longer than `autoCleanup`.
        const at = now();

        for (const [port, conn] of connections) {
          if (conn.manual || conn.state === "connected") continue;

          if (conn.lastConnected === 0 && conn.attempts >= timing.autoGiveUpAttempts) {
            // Never connected — remove after a few failed attempts
            suppressStaleTokenPort(port);
          } else if (conn.disconnectedAt > 0 && at - conn.disconnectedAt > Duration.toMillis(timing.autoCleanup)) {
            // Gone for the grace period. Measured from when the socket went
            // away, not from when it authenticated: `lastConnected` is never
            // refreshed, so reading it here suppressed any server that had
            // simply been up longer than the grace period, the first time
            // Safari suspended this page. The suppression then records the live
            // token as stale and the server only mints a new one on restart, so
            // the bridge went quiet until something was restarted.
            suppressStaleTokenPort(port);
          }
        }
      });

      const statuses = Effect.sync(() => {
        const ports: Array<PortStatus> = [];

        for (const [port, conn] of connections) {
          // Only surface connections worth showing:
          // - Currently connected or attempting an authenticated connection
          // - Manually added by the user
          // - Discovered through a token that is still there. One whose token is
          //   gone is a server that stopped, and showing it would only be a row
          //   that cannot be reconnected.
          const isVisible =
            conn.state === "connected" || conn.state === "connecting" || conn.manual || authTokensByPort.has(port);

          if (isVisible) ports.push({ port, state: conn.state, manual: conn.manual });
        }

        return ports;
      });

      return Connections.of({
        ensurePort: (port, manual = false) =>
          Effect.sync(() => {
            ensurePortSync(port, manual);

            if (manual) persistManualPorts();
          }),
        connectToPort: (port) => Effect.sync(() => connectToPort(port)),
        connectAll: Effect.sync(() => {
          for (const port of connections.keys()) connectToPort(port);
        }),
        reconnectKnownPorts: Effect.sync(reconnectKnownPortsSync),
        disconnectPort: (port) => Effect.sync(() => disconnectPortSync(port)),
        reconnectPort: (port) =>
          Effect.sync(() => {
            staleTokensByPort.delete(port);

            const conn = ensurePortSync(port, manualPorts.has(port));

            closeSocket(conn);
            conn.attempts = 0;
          }),
        removeManualPort: (port) =>
          Effect.sync(() => {
            manualPorts.delete(port);
            persistManualPorts();
          }),
        statuses,
        loadAuthTokens,
        restore,
        keepalive,
        inspect: Effect.sync(() => ({ connections, staleTokens: staleTokensByPort, profileId })),
      });
    }),
  );
}
