// The WebSocket clients: one per server port, each authenticating, answering
// bridge requests, and reconnecting when its server goes away.
//
// All ports in the scan range (8089-8098) are initialised at startup. The
// extension tries to connect to each: servers that exist get connected, absent
// ports stay disconnected and are cleaned up after `autoCleanup`. Manually
// added ports are persisted in storage.local across restarts.

import { Clock, Context, Duration, Effect, FiberSet, Layer, Option, Predicate, Schema } from "effect";
import { Browser, callBrowser } from "./Browser.ts";
import {
  AUTO_SCAN_RANGE,
  BackgroundTiming,
  BRIDGE_PROTOCOL_VERSION,
  DEFAULT_PORT,
  DEFAULT_PROFILE_ID,
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
  token: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
});

/** The server's first frame on a new socket. */
const HandshakeReply = Schema.fromJsonString(
  Schema.Struct({
    auth: Schema.optionalKey(Schema.String),
    protocolVersion: Schema.optionalKey(Schema.Finite),
    error: Schema.optionalKey(Schema.String),
  }),
);

/** Any later frame: a request, which is only answerable if it carries an id. */
const IncomingRequest = Schema.fromJsonString(BridgeRequest);

const isUserPort = (port: number) => port >= MIN_PORT && port <= MAX_PORT;

export const isAutoScanPort = (port: number) => port >= DEFAULT_PORT && port < DEFAULT_PORT + AUTO_SCAN_RANGE;

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
    /** Asks the appex for the current tokens and profile, and connects any newly known port. */
    readonly loadAuthTokens: Effect.Effect<void>;
    /** Restores manual ports from storage and starts tracking the auto-scan range. */
    readonly restore: Effect.Effect<void>;
    /** The keepalive: reload tokens, reconnect, and drop auto ports that are gone. */
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
      let legacyAuthToken: string | null = null;
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

      const scheduleReconnect = (port: number) => {
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
          Effect.andThen(
            Effect.sleep(Duration.millis(delay)),
            Effect.sync(() => connectToPort(port)),
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

      const handshake = (socket: WebSocket, conn: Connection, port: number, data: string) =>
        Effect.gen(function* () {
          const reply = yield* Schema.decodeEffect(HandshakeReply)(data).pipe(Effect.option);

          if (Option.isNone(reply)) {
            yield* Effect.logError(`[MCPSafari:${port}] Invalid auth response`);

            return socket.close();
          }

          const message = reply.value;

          if (message.auth !== "ok") {
            yield* Effect.logError(`[MCPSafari:${port}] Auth rejected: ${message.error || "unknown error"}`);

            return socket.close();
          }

          if (message.protocolVersion !== undefined && message.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
            yield* Effect.logError(
              `[MCPSafari:${port}] Protocol mismatch: extension=${BRIDGE_PROTOCOL_VERSION}, server=${message.protocolVersion}`,
            );

            return socket.close();
          }

          conn.lastConnected = now();
          conn.state = "connected";
          conn.attempts = 0;
          conn.disconnectedAt = 0;
          yield* Effect.log(`[MCPSafari:${port}] Authenticated`);
        });

      function connectToPort(port: number): void {
        const conn = connections.get(port);

        if (!conn) return;

        if (conn.ws && (conn.ws.readyState === SocketImpl.OPEN || conn.ws.readyState === SocketImpl.CONNECTING)) return;

        // Security: every server instance requires its per-port auth token.
        const authToken = authTokensByPort.get(port) || legacyAuthToken;

        if (!authToken) {
          conn.state = "disconnected";

          return; // Skip — can't verify server identity without auth
        }

        conn.state = "connecting";

        const socket = new SocketImpl(`ws://localhost:${port}`);

        conn.ws = socket;

        let pendingAuth = true;

        socket.onopen = () => {
          socket.send(
            JSON.stringify({
              auth: authToken,
              extensionVersion: browserApi.runtime.getManifest().version,
              protocolVersion: BRIDGE_PROTOCOL_VERSION,
              profileId,
            }),
          );
          run(Effect.log(`[MCPSafari:${port}] Sent auth token`));
        };

        socket.onmessage = (event: MessageEvent<string>) => {
          if (pendingAuth) {
            pendingAuth = false;
            run(handshake(socket, conn, port, event.data));

            return;
          }

          run(answer(socket, port, event.data));
        };

        socket.onclose = () => {
          conn.state = "disconnected";
          conn.ws = null;

          if (conn.disconnectedAt === 0) conn.disconnectedAt = now();
          scheduleReconnect(port);
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

      const ensurePortsForKnownTokens = () => {
        for (const [port, token] of authTokensByPort) {
          if (staleTokensByPort.get(port) === token) continue;

          staleTokensByPort.delete(port);

          if ((isAutoScanPort(port) || manualPorts.has(port)) && !connections.has(port)) {
            ensurePortSync(port, manualPorts.has(port));
            connectToPort(port);
          }
        }
      };

      const loadAuthTokens = Effect.gen(function* () {
        const response = yield* callBrowser((api) =>
          api.runtime.sendNativeMessage(NATIVE_HOST_ID, { type: "getTokens" }),
        ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(NativeTokens)), Effect.mapError(fromUnknown));

        if (response.profile) profileId = response.profile;

        if (response.tokens) {
          authTokensByPort.clear();
          legacyAuthToken = null;

          for (const [port, token] of Object.entries(response.tokens)) {
            const parsedPort = parseInt(port, 10);

            if (isUserPort(parsedPort) && token) authTokensByPort.set(parsedPort, token);
          }

          for (const port of staleTokensByPort.keys()) {
            if (!authTokensByPort.has(port)) staleTokensByPort.delete(port);
          }

          ensurePortsForKnownTokens();
          yield* Effect.log(`[MCPSafari] Loaded ${authTokensByPort.size} auth token(s)`);
        } else if (response.token) {
          authTokensByPort.clear();
          legacyAuthToken = response.token;
          yield* Effect.log("[MCPSafari] Legacy auth token loaded");
        } else {
          yield* Effect.logWarning("[MCPSafari] Failed to load auth tokens:", response.error || "unknown");
        }
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
      }).pipe(
        Effect.ignore,
        // Initialize all ports in the auto-scan range. connectAll will attempt
        // each: servers that exist get connected, absent ports fail silently and
        // are cleaned up by the keepalive.
        Effect.andThen(
          Effect.sync(() => {
            for (let offset = 0; offset < AUTO_SCAN_RANGE; offset++) ensurePortSync(DEFAULT_PORT + offset);
          }),
        ),
        Effect.provideService(Browser, browserApi),
      );

      const keepalive = Effect.gen(function* () {
        yield* loadAuthTokens;
        reconnectKnownPortsSync();

        // Clean up auto-scan ports that have never connected or have been
        // disconnected for longer than `autoCleanup`.
        const at = now();

        for (const [port, conn] of connections) {
          if (conn.manual || !isAutoScanPort(port) || conn.state === "connected") continue;

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
          // - Auto-scan ports with a known token or previous connection
          const isVisible =
            conn.state === "connected" ||
            conn.state === "connecting" ||
            conn.manual ||
            (isAutoScanPort(port) && (authTokensByPort.has(port) || conn.lastConnected > 0));

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
        disconnectPort: (port) =>
          Effect.sync(() => {
            closeSocket(connections.get(port));
            connections.delete(port);
            staleTokensByPort.delete(port);
          }),
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
