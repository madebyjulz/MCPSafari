// Runs the real background services against a fake `browser`, with every wait
// shrunk so a call parked on Safari's permission dialog times out in
// milliseconds instead of seconds.

import { Duration, Effect, Layer, ManagedRuntime } from "effect";
import type BrowserApi from "webextension-polyfill";
import {
  BackgroundLayer,
  registerListeners,
  startup,
  type BackgroundServices,
} from "../../src/background/background.ts";
import { Browser } from "../../src/background/Browser.ts";
import { BackgroundTiming } from "../../src/background/config.ts";
import { WebSocketConstructor } from "../../src/background/Connections.ts";
import type { BridgeResponse } from "../../src/background/errors.ts";
import { Router } from "../../src/background/Router.ts";
import type { ContentParams } from "../../src/shared/protocol.ts";

/** Timing for tests: deadlines short enough to wait out, settling delays gone. */
export const TEST_TIMING: BackgroundTiming = {
  reconnectBase: Duration.millis(5),
  reconnectMax: Duration.millis(20),
  autoCleanup: Duration.minutes(2),
  autoGiveUpAttempts: 3,
  permissionProbe: Duration.millis(30),
  permissionDeadline: Duration.millis(60),
  tabListing: Duration.millis(60),
  permissionCache: Duration.seconds(2),
  navigationTimeout: Duration.millis(400),
  noNavigationTimeout: Duration.millis(40),
  sameDocumentSettle: Duration.millis(20),
  nativeFocusSettle: Duration.zero,
  screenshotActivateSettle: Duration.zero,
  injectionSettle: Duration.zero,
};

/** A promise that never settles, the way a call parked on Safari's dialog behaves. */
export const parked = <A>(): Promise<A> => new Promise<A>(() => {});

/** A listener registry standing in for a WebExtension event. */
export class FakeEvent<L extends (...args: never[]) => unknown> {
  readonly listeners: Array<L> = [];

  addListener(listener: L): void {
    this.listeners.push(listener);
  }

  removeListener(listener: L): void {
    const index = this.listeners.indexOf(listener);

    if (index !== -1) this.listeners.splice(index, 1);
  }

  hasListener(listener: L): boolean {
    return this.listeners.includes(listener);
  }

  /** Calls every listener, returning what each returned. */
  fire(...args: Parameters<L>): Array<ReturnType<L>> {
    // SAFETY: each listener was registered with type L, so its return is ReturnType<L>.
    return [...this.listeners].map((listener) => listener(...args) as ReturnType<L>);
  }
}

/**
 * A fake WebSocket class. Every instance is recorded so a test can open it,
 * feed it frames and read what the extension sent.
 */
export const makeFakeWebSocket = () => {
  const sockets: Array<FakeSocket> = [];

  class FakeSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readonly sent: Array<string> = [];
    readyState = FakeSocket.CONNECTING;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(readonly url: string) {
      sockets.push(this);
    }

    send(data: string): void {
      this.sent.push(data);
    }

    close(): void {
      if (this.readyState === FakeSocket.CLOSED) return;

      this.readyState = FakeSocket.CLOSED;
      this.onclose?.();
    }

    /** The server accepting the connection. */
    open(): void {
      this.readyState = FakeSocket.OPEN;
      this.onopen?.();
    }

    /** A frame from the server. */
    receive(data: string): void {
      this.onmessage?.({ data });
    }
  }

  return { FakeSocket, sockets };
};

export type FakeSocket = InstanceType<ReturnType<typeof makeFakeWebSocket>["FakeSocket"]>;

/** Loose, partial `browser` objects: each test fakes only what it touches. */
export type FakeBrowser = Record<string, unknown>;

// BackgroundTiming is a reference, so the runtime carries the test timing without it appearing here.
type HarnessServices = BackgroundServices;

export interface BackgroundHarness {
  readonly runtime: ManagedRuntime.ManagedRuntime<HarnessServices, never>;
  readonly sockets: Array<FakeSocket>;
  /** Sends one bridge request through the router, as the server would. */
  request(action: string, params?: ContentParams): Promise<BridgeResponse>;
  /** Runs any effect against the background's services. */
  run<A, E>(effect: Effect.Effect<A, E, HarnessServices>): Promise<A>;
  /** Runs startup: loads tokens, restores state, connects. */
  start(): Promise<void>;
  dispose(): Promise<void>;
}

export const startBackground = (
  api: FakeBrowser,
  options: { readonly timing?: Partial<BackgroundTiming>; readonly listen?: boolean } = {},
): BackgroundHarness => {
  const { FakeSocket, sockets } = makeFakeWebSocket();
  // SAFETY: tests fake only the parts of the API the code under test touches;
  // reaching anything else fails the test loudly with a TypeError.
  const browserApi = api as unknown as BrowserApi.Browser;

  const runtime = ManagedRuntime.make(
    BackgroundLayer.pipe(
      Layer.provideMerge(Layer.succeed(Browser, browserApi)),
      Layer.provideMerge(Layer.succeed(BackgroundTiming, Object.assign({}, TEST_TIMING, options.timing))),
      // SAFETY: FakeSocket implements the slice of WebSocket the extension uses.
      Layer.provide(Layer.succeed(WebSocketConstructor, FakeSocket as unknown as typeof WebSocket)),
    ),
  );

  if (options.listen !== false) registerListeners(browserApi, runtime);

  return {
    runtime,
    sockets,
    request: (action, params = {}) =>
      runtime.runPromise(Router.use((router) => router.handle({ id: "r1", action, params }))),
    run: (effect) => runtime.runPromise(effect),
    start: () => runtime.runPromise(startup),
    dispose: () => runtime.dispose(),
  };
};
