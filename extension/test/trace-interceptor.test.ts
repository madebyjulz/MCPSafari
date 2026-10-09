import assert from "node:assert/strict";
import vm from "node:vm";
import { test } from "vitest";

import { builtScript } from "./helpers/sources.ts";

const source = builtScript("trace-interceptor.js");

type TraceApi = Required<Pick<Window, "__mcpStartTrace" | "__mcpStopTrace" | "__mcpRecordTraceEvent">>;

interface StubWindow extends Partial<TraceApi> {
  readonly CSS: { readonly escape: (value: string) => string };
  addEventListener(): void;
  postMessage(): void;
}

interface Page {
  readonly window: TraceApi;
  /** Moves the page's clock forward. */
  readonly advance: (ms: number) => void;
  /** Runs the URL poll once, as its interval would; does nothing while no poll is installed. */
  readonly poll: () => void;
  /** Whether the URL poll is installed. */
  readonly polling: () => boolean;
  /** Whether the DOM observer is connected. */
  readonly observing: () => boolean;
}

function loadInterceptor(): Page {
  const location = { href: "https://example.test/" };
  let clock = 1_700_000_000_000;
  let interval: (() => void) | null = null;
  let observing = false;

  const window: StubWindow = {
    CSS: { escape: String },
    addEventListener() {},
    postMessage() {},
  };

  class MutationObserver {
    observe() {
      observing = true;
    }

    disconnect() {
      observing = false;
    }
  }

  vm.runInNewContext(source, {
    window,
    location,
    history: { pushState() {}, replaceState() {} },
    document: { documentElement: {} },
    Date: { now: () => clock },
    MutationObserver,
    Node: { ELEMENT_NODE: 1 },
    setInterval: (callback: () => void) => {
      interval = callback;

      return 1;
    },
    clearInterval() {
      interval = null;
    },
  });

  return {
    // SAFETY: running the script installed the trace API on the stub window.
    window: window as StubWindow & TraceApi,
    advance: (ms) => {
      clock += ms;
    },
    poll: () => interval?.(),
    polling: () => interval !== null,
    observing: () => observing,
  };
}

test("eventTypes filters before the trace event cap", () => {
  const { window } = loadInterceptor();
  const { id } = window.__mcpStartTrace({ eventTypes: ["network.fetch"] });

  for (let index = 0; index <= 1000; index += 1) {
    window.__mcpRecordTraceEvent("dom.mutation", { index });
  }

  window.__mcpRecordTraceEvent("network.fetch", { url: "https://example.test/data" });

  const trace = window.__mcpStopTrace({ id });
  assert.equal(trace.truncated, false);
  assert.deepEqual(
    Array.from(trace.events, ({ type }) => type),
    ["network.fetch"],
  );
});

test("an event's detail cannot overwrite its type or timing", () => {
  const { window } = loadInterceptor();
  const { id, startTime } = window.__mcpStartTrace({});

  window.__mcpRecordTraceEvent("network.fetch", { type: "fetch", at: 1, offset: -1, url: "u" }, startTime + 25);

  const event = window.__mcpStopTrace({ id }).events.find(({ url }) => url === "u");
  assert.equal(event?.type, "network.fetch");
  assert.equal(event?.at, startTime + 25);
  assert.equal(event?.offset, 25);
});

test("an abandoned trace expires and stops the URL poll and DOM observer", () => {
  const page = loadInterceptor();
  const { id } = page.window.__mcpStartTrace({});

  // Ten minutes is the limit; a trace younger than that keeps capturing.
  page.advance(10 * 60_000 - 1);
  page.poll();
  assert.equal(page.polling(), true);
  assert.equal(page.observing(), true);

  page.advance(1);
  page.poll();
  assert.equal(page.polling(), false);
  assert.equal(page.observing(), false);
  assert.match(page.window.__mcpStopTrace({ id }).error ?? "", /expired/);

  // A later trace starts capture again and stops as before.
  const next = page.window.__mcpStartTrace({});
  assert.equal(page.polling(), true);
  assert.equal(page.observing(), true);
  page.advance(5000);
  page.poll();
  const stopped = page.window.__mcpStopTrace({ id: next.id });
  assert.equal(stopped.error, undefined);
  assert.equal(stopped.durationMs, 5000);
  assert.equal(page.polling(), false);
  assert.equal(page.observing(), false);
});
