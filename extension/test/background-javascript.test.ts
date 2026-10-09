import assert from "node:assert/strict";
import vm from "node:vm";
import { afterEach, test } from "vitest";

import { probeTabAccess } from "../src/background/injected.ts";
import { fakeBrowser, launch, runInjected, stopAll } from "./helpers/fake-browser.ts";

afterEach(stopAll);

// What Safari reports when a page's script-src leaves out 'unsafe-eval'.
const CSP_REFUSAL =
  "Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script " +
  "in the following Content Security Policy directive: \"script-src 'self'\".";

/**
 * A page realm. One whose CSP forbids 'unsafe-eval' refuses to compile a
 * string, which is what `new Function` does inside the injected code; the
 * refusal is built inside the realm so its EvalError belongs there, the way a
 * real page's does, and a cross-realm one would defeat `instanceof`.
 */
function pageRealm(blocked: boolean): vm.Context {
  const page = vm.createContext({});

  if (blocked) {
    vm.runInContext(
      `globalThis.Function = function () { throw new EvalError(${JSON.stringify(CSP_REFUSAL)}); };`,
      page,
    );
  }

  return page;
}

function backgroundHarness(cspBlockedWorlds: ReadonlyArray<"MAIN" | "ISOLATED"> = []) {
  const api = fakeBrowser();

  api.tabs.get = async () => {
    throw new Error("not found");
  };

  // The injected function runs as Safari runs it: serialised, in the target
  // world's realm. `args` is optional in the real API and the permission
  // probe omits it.
  api.scripting.executeScript = async ({ func, args = [], world }) => {
    if (func === probeTabAccess || func === undefined) return [{ result: true }];

    const blocked = world !== undefined && cspBlockedWorlds.includes(world);

    return [{ result: await runInjected(func, args, pageRealm(blocked)) }];
  };

  const { request } = launch(api);

  return (code: string) => request("javascript_tool", { tabId: 1, code });
}

/** The value a successful run returned, as the server receives it. */
const valueOf = async (pending: ReturnType<ReturnType<typeof backgroundHarness>>) => {
  const response = await pending;

  assert.equal(response.success, true, response.error ?? "");

  return response.data;
};

/** The message a failed run reported. */
const errorOf = async (pending: ReturnType<ReturnType<typeof backgroundHarness>>) => {
  const response = await pending;

  assert.equal(response.success, false, "the run should have failed");

  return response.error ?? "";
};

test("plain expression returns its value", async () => {
  const run = backgroundHarness();

  assert.equal(await valueOf(run("1 + 1")), "2");
});

test("statement body with explicit return returns its value", async () => {
  const run = backgroundHarness();
  const code = "const a = await Promise.resolve(41); const b = a + 1; return JSON.stringify({ b })";

  assert.equal(await valueOf(run(code)), '"{\\"b\\":42}"');
});

test("statement body without return yields no value", async () => {
  const run = backgroundHarness();
  const code = "const x = 1; const y = 2; JSON.stringify({ sum: x + y })";

  assert.equal(await valueOf(run(code)), "undefined");
});

test("sync throw in a statement body surfaces as an error", async () => {
  const run = backgroundHarness();

  assert.match(await errorOf(run('throw new Error("boom-sync")')), /boom-sync/);
});

test("awaited rejection surfaces as an error", async () => {
  const run = backgroundHarness();
  const code = "const p = Promise.reject(new Error('boom-async')); return await p";

  assert.match(await errorOf(run(code)), /boom-async/);
});

test("non-Error rejection surfaces its string form", async () => {
  const run = backgroundHarness();

  assert.match(await errorOf(run("return Promise.reject('boom-string')")), /boom-string/);
});

test("parse errors still surface", async () => {
  const run = backgroundHarness();

  assert.match(await errorOf(run("const a = 1; this is not valid js; return a")), /Unexpected identifier/);
});

test("async IIFE expression keeps working", async () => {
  const run = backgroundHarness();
  const code = "(async () => { const a = await Promise.resolve(41); return JSON.stringify({ b: a + 1 }) })()";

  assert.equal(await valueOf(run(code)), '"{\\"b\\":42}"');
});

test("a page CSP that blocks eval falls back to the isolated world", async () => {
  const run = backgroundHarness(["MAIN"]);

  const output = await valueOf(run("1 + 1"));

  assert.match(output ?? "", /^2\n/, "the value still comes back");
  assert.match(output ?? "", /isolated world/i, "and the caller is told where it ran");
  assert.match(output ?? "", /globals/i, "including what is not visible there");
});

test("CSP in both worlds reports what to use instead", async () => {
  const run = backgroundHarness(["MAIN", "ISOLATED"]);

  const message = await errorOf(run("1 + 1"));

  assert.match(message, /Content Security Policy/);
  assert.match(message, /snapshot|find|read_page/);
  assert.doesNotMatch(message, /unsafe-eval/, "the raw browser text is replaced with guidance");
});

test("an ordinary page still runs in the page world with no note", async () => {
  const run = backgroundHarness();

  assert.equal(await valueOf(run("1 + 1")), "2");
});
