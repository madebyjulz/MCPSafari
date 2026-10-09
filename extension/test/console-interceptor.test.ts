import assert from "node:assert/strict";
import vm from "node:vm";
import { test } from "vitest";

import { builtScript } from "./helpers/sources.ts";

const source = builtScript("console-interceptor.js");

type ConsoleApi = Required<Pick<Window, "__mcpGetConsoleMessages">>;

type StubLog = (...data: ReadonlyArray<string>) => void;

interface StubConsole {
  log: StubLog;
  warn: StubLog;
  error: StubLog;
  info: StubLog;
  debug: StubLog;
}

interface StubWindow extends Partial<ConsoleApi> {
  addEventListener(): void;
  postMessage(): void;
  window?: StubWindow;
}

interface Context {
  readonly console: StubConsole;
  readonly window: StubWindow & ConsoleApi;
}

function stubWindow(): StubWindow {
  return { addEventListener() {}, postMessage() {} };
}

function loadInterceptor(): Context {
  const context = {
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    window: stubWindow(),
    Date,
    JSON,
    RegExp,
    String,
    Set,
  };

  context.window.window = context.window;
  vm.runInNewContext(source, context);

  // SAFETY: running the script patched the console and installed __mcpGetConsoleMessages on the stub window.
  return context as typeof context & Context;
}

test("clearing a pattern-filtered read keeps messages the caller never saw", () => {
  const { console: patched, window } = loadInterceptor();

  patched.log("alpha keep-me");
  patched.log("beta match-me");

  const matched = window.__mcpGetConsoleMessages({ pattern: "match-me", clear: true });
  const remaining = window.__mcpGetConsoleMessages({});

  assert.deepEqual(
    Array.from(matched, (m) => m.text),
    ["beta match-me"],
  );
  assert.deepEqual(
    Array.from(remaining, (m) => m.text),
    ["alpha keep-me"],
  );
});

test("clearing a level-filtered read leaves the other levels intact", () => {
  const { console: patched, window } = loadInterceptor();

  patched.log("a log line");
  patched.error("an error line");

  window.__mcpGetConsoleMessages({ level: "error", clear: true });
  const remaining = window.__mcpGetConsoleMessages({});

  assert.deepEqual(
    Array.from(remaining, (m) => m.text),
    ["a log line"],
  );
});

test("clearing an unfiltered read empties the buffer", () => {
  const { console: patched, window } = loadInterceptor();

  patched.log("one");
  patched.warn("two");

  window.__mcpGetConsoleMessages({ clear: true });

  assert.deepEqual(Array.from(window.__mcpGetConsoleMessages({})), []);
});

test("level and pattern filters compose when clearing", () => {
  const { console: patched, window } = loadInterceptor();

  patched.error("fetch failed for /a");
  patched.error("render failed");
  patched.log("fetch started for /a");

  const matched = window.__mcpGetConsoleMessages({ level: "error", pattern: "^fetch", clear: true });
  const remaining = window.__mcpGetConsoleMessages({});

  assert.deepEqual(
    Array.from(matched, (m) => m.text),
    ["fetch failed for /a"],
  );
  assert.deepEqual(
    Array.from(remaining, (m) => m.text),
    ["render failed", "fetch started for /a"],
  );
});

test("capture bounds large arguments and rejects pathological filters", () => {
  const { console: patched, window } = loadInterceptor();
  patched.log("a".repeat(100_000));
  const entries = window.__mcpGetConsoleMessages({});
  assert.equal(entries[0]?.text.length, 8192);
  assert.equal(entries[0]?.truncated, true);
  assert.throws(() => window.__mcpGetConsoleMessages({ pattern: "(a+)+$" }), /Unsupported filter/);
  assert.throws(() => window.__mcpGetConsoleMessages({ pattern: "a*a*Z" }), /Unsupported filter/);
  assert.throws(() => window.__mcpGetConsoleMessages({ pattern: "[" }));
});
