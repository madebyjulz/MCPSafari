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

function loadInterceptor(): TraceApi {
  const location = { href: "https://example.test/" };

  const window: StubWindow = {
    CSS: { escape: String },
    addEventListener() {},
    postMessage() {},
  };

  class MutationObserver {
    observe() {}
    disconnect() {}
  }

  vm.runInNewContext(source, {
    window,
    location,
    history: { pushState() {}, replaceState() {} },
    document: { documentElement: {} },
    MutationObserver,
    Node: { ELEMENT_NODE: 1 },
    setInterval: () => 1,
    clearInterval() {},
  });

  // SAFETY: running the script installed the trace API on the stub window.
  return window as StubWindow & TraceApi;
}

test("eventTypes filters before the trace event cap", () => {
  const window = loadInterceptor();
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
