import assert from "node:assert/strict";
import vm from "node:vm";
import { test } from "vitest";

import type { NetworkParams } from "../src/page/window.ts";
import { builtScript } from "./helpers/sources.ts";

const source = builtScript("network-interceptor.js");

/** The PerformanceResourceTiming fields the interceptor reads. */
interface ResourceTimingStub {
  readonly name: string;
  readonly initiatorType: string;
  readonly transferSize: number;
  readonly encodedBodySize: number;
  readonly decodedBodySize: number;
  readonly startTime: number;
  readonly duration: number;
}

interface ObserverState {
  options: PerformanceObserverInit | null;
  readonly records: Array<ResourceTimingStub>;
}

interface StubResponse {
  readonly status: number;
  readonly statusText: string;
}

type NetworkApi = Required<Pick<Window, "__mcpGetNetworkRequests">>;

interface StubWindow extends Partial<NetworkApi> {
  addEventListener(): void;
  fetch: (input: string) => Promise<StubResponse>;
  postMessage(): void;
  window?: StubWindow;
}

/** A captured record after a JSON round trip, with the fields these tests read. */
interface NetworkReadout {
  readonly url: string;
  readonly duration?: number;
  readonly timingRestricted?: boolean;
  readonly truncated?: boolean;
}

interface LoadOptions {
  readonly observerThrows?: boolean;
}

interface Loaded {
  readonly observer: ObserverState;
  readonly window: StubWindow & NetworkApi;
}

function loadInterceptor({ observerThrows = false }: LoadOptions = {}): Loaded {
  let observer: ObserverState | undefined;

  class XMLHttpRequest {
    open() {}
    send() {}
  }

  class PerformanceObserver {
    constructor() {
      observer = { options: null, records: [] };

      if (observerThrows) throw new TypeError("PerformanceObserver unavailable");
    }

    observe(options: PerformanceObserverInit) {
      // SAFETY: the constructor has just set the observer state.
      (observer as ObserverState).options = options;
    }

    takeRecords() {
      // SAFETY: the constructor has just set the observer state.
      return (observer as ObserverState).records.splice(0);
    }
  }

  const window: StubWindow = {
    addEventListener() {},
    fetch: async (input) => ({
      status: String(input).includes("feed") ? 200 : 404,
      statusText: "OK",
    }),
    postMessage() {},
  };

  window.window = window;

  vm.runInNewContext(source, {
    PerformanceObserver,
    URL,
    XMLHttpRequest,
    location: { origin: "https://example.test" },
    performance: { timeOrigin: 1_700_000_000_000 },
    window,
  });

  // SAFETY: the script constructs its PerformanceObserver while loading, which
  // sets the observer state, and installs __mcpGetNetworkRequests on the stub.
  return { observer: observer as ObserverState, window: window as StubWindow & NetworkApi };
}

test("resource reads expose buffered subresource timings without changing the default feed", () => {
  const { observer, window } = loadInterceptor();

  assert.deepEqual(JSON.parse(JSON.stringify(observer.options)), { type: "resource", buffered: true });
  observer.records.push({
    name: "https://example.test/image.png",
    initiatorType: "img",
    transferSize: 1234,
    encodedBodySize: 934,
    decodedBodySize: 2048,
    startTime: 25,
    duration: 7,
  });

  assert.deepEqual(JSON.parse(JSON.stringify(window.__mcpGetNetworkRequests({ type: "resource" }))), [
    {
      type: "resource",
      url: "https://example.test/image.png",
      initiatorType: "img",
      transferSize: 1234,
      encodedBodySize: 934,
      decodedBodySize: 2048,
      startTime: 25,
      duration: 7,
      timestamp: 1_700_000_000_025,
    },
  ]);
  assert.deepEqual(Array.from(window.__mcpGetNetworkRequests({ type: "all" })), []);
  window.__mcpGetNetworkRequests({ type: "resource", clear: true });
  assert.deepEqual(Array.from(window.__mcpGetNetworkRequests({ type: "resource" })), []);
});

function pushResources(observer: ObserverState, urls: ReadonlyArray<string>): void {
  for (const [i, url] of urls.entries()) {
    observer.records.push({
      name: url,
      initiatorType: "img",
      transferSize: 0,
      encodedBodySize: 0,
      decodedBodySize: 0,
      startTime: i,
      duration: 1,
    });
  }
}

/** The entry at `index`; a missing one throws, as reading a field off it would. */
function entryAt(entries: ReadonlyArray<NetworkReadout>, index: number): NetworkReadout {
  const entry = entries[index];

  if (entry === undefined) throw new TypeError(`no entry at index ${index}`);

  return entry;
}

// Cross-realm results fail deepStrictEqual prototype checks; round-trip through JSON.
function readNetwork(window: NetworkApi, params: NetworkParams): Array<NetworkReadout> {
  return JSON.parse(JSON.stringify(window.__mcpGetNetworkRequests(params)));
}

test("urlPattern filters resources and rejects invalid or expensive patterns", () => {
  const { observer, window } = loadInterceptor();
  pushResources(observer, [
    "https://example.test/variant-a.webp",
    "https://example.test/original.png",
    "https://example.test/variant-b.webp",
  ]);

  const matched = readNetwork(window, { type: "resource", urlPattern: "variant" });
  assert.deepEqual(
    matched.map((r) => r.url),
    ["https://example.test/variant-a.webp", "https://example.test/variant-b.webp"],
  );

  assert.throws(() => readNetwork(window, { type: "resource", urlPattern: "([" }));
  assert.throws(() => readNetwork(window, { type: "resource", urlPattern: "(a+)+$" }), /Unsupported filter/);
});

test("maxResults returns the most recent entries", () => {
  const { observer, window } = loadInterceptor();
  pushResources(observer, ["https://example.test/1.png", "https://example.test/2.png", "https://example.test/3.png"]);

  const limited = readNetwork(window, { type: "resource", maxResults: 2 });
  assert.deepEqual(
    limited.map((r) => r.url),
    ["https://example.test/2.png", "https://example.test/3.png"],
  );
});

test("clear with a filter removes only the returned entries", () => {
  const { observer, window } = loadInterceptor();
  pushResources(observer, ["https://example.test/variant-a.webp", "https://example.test/original.png"]);

  const cleared = readNetwork(window, { type: "resource", urlPattern: "variant", clear: true });
  assert.equal(cleared.length, 1);

  const remaining = readNetwork(window, { type: "resource" });
  assert.deepEqual(
    remaining.map((r) => r.url),
    ["https://example.test/original.png"],
  );
});

test("urlPattern also filters the fetch feed", async () => {
  const { window } = loadInterceptor();
  await window.fetch("https://example.test/api/feed");
  await window.fetch("https://example.test/api/health");

  const matched = readNetwork(window, { type: "fetch", urlPattern: "feed" });
  assert.deepEqual(
    matched.map((r) => r.url),
    ["https://example.test/api/feed"],
  );

  const limited = readNetwork(window, { maxResults: 1 });
  assert.deepEqual(
    limited.map((r) => r.url),
    ["https://example.test/api/health"],
  );
});

test("status filters the fetch feed by HTTP status", async () => {
  const { window } = loadInterceptor();
  await window.fetch("https://example.test/api/feed");
  await window.fetch("https://example.test/api/missing");

  assert.deepEqual(
    readNetwork(window, { status: 200 }).map((r) => r.url),
    ["https://example.test/api/feed"],
  );
  assert.deepEqual(
    readNetwork(window, { status: 404 }).map((r) => r.url),
    ["https://example.test/api/missing"],
  );
});

test("cross-origin entries with zeroed fields are marked timingRestricted", () => {
  const { observer, window } = loadInterceptor();
  observer.records.push(
    // Cross-origin, all fields zeroed: Timing-Allow-Origin withheld.
    {
      name: "https://cdn.other.test/a.png",
      initiatorType: "img",
      transferSize: 0,
      encodedBodySize: 0,
      decodedBodySize: 0,
      startTime: 1,
      duration: 0,
    },
    // Cross-origin with real timing: TAO granted, no marker.
    {
      name: "https://cdn.other.test/b.png",
      initiatorType: "img",
      transferSize: 0,
      encodedBodySize: 0,
      decodedBodySize: 500,
      startTime: 2,
      duration: 3,
    },
    // Same-origin cache hit: legitimately zero, no marker.
    {
      name: "https://example.test/cached.png",
      initiatorType: "img",
      transferSize: 0,
      encodedBodySize: 0,
      decodedBodySize: 0,
      startTime: 3,
      duration: 0,
    },
  );

  const entries = readNetwork(window, { type: "resource" });
  assert.equal(entryAt(entries, 0).timingRestricted, true);
  assert.equal(entryAt(entries, 1).timingRestricted, undefined);
  assert.equal(entryAt(entries, 2).timingRestricted, undefined);
});

test("a restricted entry is marked even though its duration is real", () => {
  const { observer, window } = loadInterceptor();
  // The timing allow check zeroes the byte counts and the connection-phase
  // fields, but leaves startTime and responseEnd readable — so the ordinary
  // uncached restricted resource has a real duration. Requiring duration === 0
  // would mark only the cached ones and let this case read as a cache hit.
  observer.records.push({
    name: "https://cdn.other.test/uncached.png",
    initiatorType: "img",
    transferSize: 0,
    encodedBodySize: 0,
    decodedBodySize: 0,
    startTime: 10,
    duration: 143,
  });

  const entry = entryAt(readNetwork(window, { type: "resource" }), 0);
  assert.equal(entry.timingRestricted, true);
  assert.equal(entry.duration, 143);
});

test("XHR and fetch capture still install when PerformanceObserver is unavailable", async () => {
  const { window } = loadInterceptor({ observerThrows: true });

  await window.fetch("https://example.test/api/feed");

  assert.deepEqual(
    readNetwork(window, { type: "fetch" }).map((r) => r.url),
    ["https://example.test/api/feed"],
  );
  assert.deepEqual(readNetwork(window, { type: "resource" }), []);
});

test("resource URLs have a per-entry cap with a truncation marker", () => {
  const { observer, window } = loadInterceptor();
  pushResources(observer, ["https://example.test/" + "x".repeat(100_000)]);
  const result = readNetwork(window, { type: "resource" });
  assert.equal(entryAt(result, 0).url.length, 2048);
  assert.equal(entryAt(result, 0).truncated, true);
});
