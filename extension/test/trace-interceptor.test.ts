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
  /** Hands the DOM observer a batch of records, as a page change would. */
  readonly mutate: (records: ReadonlyArray<FakeMutation>) => void;
}

/** The parts of an attribute MutationRecord the interceptor reads. */
interface FakeMutation {
  readonly type: "attributes";
  readonly target: FakeNode;
  readonly attributeName: string;
  readonly oldValue: string | null;
}

interface FakeNode {
  readonly nodeType: number;
  readonly tagName: string;
  readonly id: string;
  readonly classList: ReadonlyArray<string>;
  readonly parentElement: null;
  getAttribute(name: string): string | null;
}

function loadInterceptor(): Page {
  const location = { href: "https://example.test/" };
  let clock = 1_700_000_000_000;
  let interval: (() => void) | null = null;
  let observing = false;
  let observed: ((records: ReadonlyArray<FakeMutation>) => void) | null = null;

  const window: StubWindow = {
    CSS: { escape: String },
    addEventListener() {},
    postMessage() {},
  };

  class MutationObserver {
    constructor(callback: (records: ReadonlyArray<FakeMutation>) => void) {
      observed = callback;
    }

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
    mutate: (records) => observed?.(records),
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

// ─── Attribute mutations ─────────────────────────────────────────────

function fakeNode(tag: string, attributes: Readonly<Record<string, string>> = {}, id = ""): FakeNode {
  return {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    id,
    classList: [],
    parentElement: null,
    getAttribute: (name) => (Object.hasOwn(attributes, name) ? attributes[name]! : null),
  };
}

function attributeMutation(target: FakeNode, attributeName: string, oldValue: string | null): FakeMutation {
  return { type: "attributes", target, attributeName, oldValue };
}

/** The dom.mutation events a trace records for `records`. */
function traceMutations(records: ReadonlyArray<FakeMutation>) {
  const page = loadInterceptor();
  const { id } = page.window.__mcpStartTrace({});

  page.mutate(records);

  return page.window.__mcpStopTrace({ id }).events.filter((event) => event.type === "dom.mutation");
}

test("a typed password mirrored into the value attribute is not recorded", () => {
  // Frameworks sync what a user types into `value`, so both the old and the
  // new value are the secret.
  const input = fakeNode("input", { type: "text", value: "hunter2" });

  const [event] = traceMutations([attributeMutation(input, "value", "hunter")]);

  assert.equal(event?.attribute, "value");
  assert.equal(event?.valueOmitted, true);
  assert.equal(event && "value" in event, false);
  assert.equal(event && "oldValue" in event, false);
  assert.doesNotMatch(JSON.stringify(event), /hunter/);
});

test("checked is never recorded either", () => {
  const box = fakeNode("input", { type: "checkbox", checked: "" });

  const [event] = traceMutations([attributeMutation(box, "checked", null)]);

  assert.equal(event?.valueOmitted, true);
  assert.equal(event && "value" in event, false);
});

test("no attribute of a sensitive input is recorded", () => {
  const password = fakeNode("input", { type: "password", title: "my secret phrase", "data-x": "y" });
  const otp = fakeNode("input", { type: "text", autocomplete: "one-time-code", title: "123456" });
  const named = fakeNode("input", { type: "text", name: "cardCvv", title: "737" });

  const events = traceMutations([
    attributeMutation(password, "title", "old secret phrase"),
    attributeMutation(otp, "title", "12345"),
    attributeMutation(named, "title", "73"),
  ]);

  assert.equal(events.length, 3);

  for (const event of events) {
    assert.equal(event.valueOmitted, true);
    assert.equal("value" in event, false);
    assert.equal("oldValue" in event, false);
  }
});

test("ordinary attributes on ordinary elements are still recorded", () => {
  const button = fakeNode("button", { class: "primary active" });

  const [event] = traceMutations([attributeMutation(button, "class", "primary")]);

  assert.equal(event?.oldValue, "primary");
  assert.equal(event?.value, "primary active");
  assert.equal(event && "valueOmitted" in event, false);
});

test("a removed attribute is recorded with a null value", () => {
  const button = fakeNode("button");

  const [event] = traceMutations([attributeMutation(button, "disabled", "")]);

  assert.equal(event?.oldValue, "");
  assert.equal(event?.value, null);
});

test("a recorded attribute value is bounded and says so", () => {
  const long = "x".repeat(5000);
  const div = fakeNode("div", { style: long });

  const [event] = traceMutations([attributeMutation(div, "style", long)]);

  assert.equal(String(event?.value).length, 512);
  assert.equal(String(event?.oldValue).length, 512);
  assert.equal(event?.truncated, true);
});
