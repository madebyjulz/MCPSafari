import assert from "node:assert/strict";
import vm from "node:vm";
import { test } from "vitest";

import { builtScript } from "./helpers/sources.ts";

const source = builtScript("console-interceptor.js");

type ConsoleApi = Required<Pick<Window, "__mcpGetConsoleMessages">>;

type StubLog = (...data: ReadonlyArray<unknown>) => void;

interface StubConsole {
  log: StubLog;
  warn: StubLog;
  error: StubLog;
  info: StubLog;
  debug: StubLog;
}

/** The one event a test fires at the interceptor's unhandledrejection listener. */
type RejectionListener = (event: { readonly reason: Error }) => void;

interface StubWindow extends Partial<ConsoleApi> {
  addEventListener(type: string, listener: RejectionListener): void;
  postMessage(): void;
  window?: StubWindow;
}

interface Context {
  readonly console: StubConsole;
  readonly window: StubWindow & ConsoleApi;
  /** Fires the page's unhandledrejection event. */
  readonly reject: (reason: Error) => void;
}

function loadInterceptor(): Context {
  const listeners = new Map<string, RejectionListener>();

  const window: StubWindow = {
    addEventListener: (type, listener) => listeners.set(type, listener),
    postMessage() {},
  };

  const context = {
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    window,
    reject: (reason: Error) => listeners.get("unhandledrejection")?.({ reason }),
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

test("undefined, functions and symbols are captured as readable text", () => {
  const { console: patched, window } = loadInterceptor();

  function onReady(): void {}

  patched.log(undefined);
  patched.log("value:", undefined);
  patched.log(onReady);
  patched.log(() => {});
  patched.log(Symbol("tag"));

  assert.deepEqual(
    Array.from(window.__mcpGetConsoleMessages({}), (m) => m.text),
    ["undefined", "value: undefined", "[Function: onReady]", "[Function (anonymous)]", "Symbol(tag)"],
  );
});

// ─── Errors and values JSON cannot carry ─────────────────────────────

/** Runs `code` in the interceptor's realm, so its Errors are the page's own. */
function inPage<Value>(context: Context, code: string): Value {
  return vm.runInContext(code, context);
}

/** The text of every captured message, in order. */
function texts(window: ConsoleApi): Array<string> {
  return Array.from(window.__mcpGetConsoleMessages({}), (message) => message.text);
}

test("an Error is captured with its name, message and stack, not as {}", () => {
  const context = loadInterceptor();

  const error = inPage(
    context,
    `(() => {
      const e = new TypeError("cannot read x");
      e.stack = "TypeError: cannot read x\\n    at render (app.js:10:5)";
      return e;
    })()`,
  );

  context.console.error("failed:", error);

  assert.deepEqual(texts(context.window), ["failed: TypeError: cannot read x\n    at render (app.js:10:5)"]);
});

test("a stack with no header, as Safari writes it, gets one", () => {
  const context = loadInterceptor();

  const error = inPage(
    context,
    `(() => {
      const e = new RangeError("too deep");
      e.stack = "render@app.js:10:5\\nmain@app.js:2:1";
      return e;
    })()`,
  );

  context.console.error(error);

  assert.deepEqual(texts(context.window), ["RangeError: too deep\nrender@app.js:10:5\nmain@app.js:2:1"]);
});

test("an Error's stack is bounded and the entry says so", () => {
  const context = loadInterceptor();

  const error = inPage(
    context,
    `(() => {
      const e = new Error("deep");
      e.stack = "Error: deep\\n" + "    at frame (app.js:1:1)\\n".repeat(5000);
      return e;
    })()`,
  );

  context.console.error(error);
  const [entry] = context.window.__mcpGetConsoleMessages({});

  assert.ok((entry?.text.length ?? Infinity) < 2048 + 64, `${entry?.text.length} characters`);
  assert.equal(entry?.truncated, true);
});

test("an Error without a stack or a message still reads as an error", () => {
  const context = loadInterceptor();

  context.console.warn(inPage(context, `(() => { const e = new Error(""); e.stack = undefined; return e; })()`));

  assert.deepEqual(texts(context.window), ["Error"]);
});

test("an Error from another realm, such as a frame's, is still read as one", () => {
  const context = loadInterceptor();
  const error = new Error("from a frame");
  error.stack = "";

  context.console.error(error);

  assert.deepEqual(texts(context.window), ["Error: from a frame"]);
});

test("an unhandled rejection with an Error reports the Error", () => {
  const context = loadInterceptor();

  context.reject(inPage(context, `(() => { const e = new Error("nope"); e.stack = ""; return e; })()`));

  assert.deepEqual(texts(context.window), ["Unhandled Promise Rejection: Error: nope"]);
});

test("values JSON cannot carry are named, at the top and nested", () => {
  const context = loadInterceptor();
  const nested = inPage(context, `(() => { const e = new Error("inner"); e.stack = ""; return e; })()`);

  context.console.log(10n);
  context.console.log({ nested, run() {}, id: 7n, tag: Symbol("t") });

  assert.deepEqual(texts(context.window), [
    "10n",
    '{"nested":"Error: inner","run":"[Function: run]","id":"7n","tag":"Symbol(t)"}',
  ]);
});
