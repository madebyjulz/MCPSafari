// Actual stdio MCP server + authenticated loopback extension fixture; no Safari UI.
// Needs the built server, so it runs as `pnpm test:mcp`, not with the unit tests.
import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

import { onTestFinished, test } from "vitest";

import { ROUTABLE_ACTIONS } from "../../extension/src/background/actions.ts";
import { type Json, type JsonObject, isJsonArray, isJsonObject } from "../src/python.ts";

const binary =
  process.env["MCPSAFARI_TEST_BINARY"] ??
  fileURLToPath(new URL("../../MCPServer/.build/debug/MCPSafari", import.meta.url));

/**
 * The bridge protocol both sides speak. `Diagnostics.swift` and the extension's
 * `config.ts` declare it too; the handshake below only works if all three agree.
 */
const BRIDGE_PROTOCOL_VERSION = 2;

/** Where the server publishes each port's token, and its owner record beside it. */
const TOKEN_DIRECTORY = join(homedir(), "Library/Application Support/MCPSafari/tokens");

/** The background bundle Safari loads, built by `pnpm test:mcp` before it runs. */
const BACKGROUND_BUNDLE = fileURLToPath(new URL("../../extension/dist/extension/background.js", import.meta.url));

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1XkAAAAASUVORK5CYII=";

/** Every action the server asked the extension to perform during this run. */
const sentActions = new Set<string>();

/**
 * The actions the real extension router can serve, read from the list its
 * dispatch tables are checked against (extension/test/background-load-order.test.ts).
 * `actions.ts` imports nothing, so it loads without standing up the whole background.
 */
const routableActions: ReadonlySet<string> = new Set(ROUTABLE_ACTIONS);

/** The value at `path` inside a JSON document, or undefined where the path runs out. */
function at(value: Json | undefined, ...path: readonly (string | number)[]): Json | undefined {
  let current = value;

  for (const key of path) {
    if (typeof key === "number" && current !== undefined && isJsonArray(current)) current = current[key];
    else if (typeof key === "string" && current !== undefined && isJsonObject(current)) current = current[key];
    else return undefined;
  }

  return current;
}

/** The length of the array at `path`, or undefined where there is none. */
function lengthAt(value: Json | undefined, ...path: readonly (string | number)[]): number | undefined {
  const found = at(value, ...path);

  return found !== undefined && isJsonArray(found) ? found.length : undefined;
}

/** The string at `path`, or "" where there is none. */
function stringAt(value: Json | undefined, ...path: readonly (string | number)[]): string {
  const found = at(value, ...path);

  return typeof found === "string" ? found : "";
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function bounded<T>(promise: Promise<T>, label: string, ms = 10_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

interface Pending {
  readonly resolve: (result: Json) => void;
  readonly reject: (cause: Error) => void;
}

interface BridgeRequest {
  readonly id: Json;
  readonly action: string;
  readonly params: Json;
}

type BridgeReply = (
  | { readonly success: true; readonly data: string }
  | {
      readonly success: false;
      readonly error: string;
      readonly errorCode?: string;
      readonly retryable?: boolean;
      readonly recoveryAction?: string;
    }
) & { readonly resolvedTabId?: Json };

test("every advertised tool returns object structuredContent over MCP", { timeout: 45_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcpsafari-results-"));
  const server = spawn(binary, ["--port", "0"], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(server, "exit");
  const lines = createInterface({ input: server.stdout });
  let stderr = "";

  server.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });

  const pending = new Map<number, Pending>();
  let nextId = 1;
  let port: number | undefined;
  let token: string | undefined;
  const sockets: WebSocket[] = [];

  onTestFinished(async () => {
    for (const socket of sockets) socket.close();

    server.stdin.end();

    try {
      await bounded(exited, "server shutdown", 2000);
    } catch {
      server.kill("SIGKILL");
      await bounded(exited, "kill server");
    }

    lines.close();

    if (port !== undefined && token !== undefined) {
      const path = join(TOKEN_DIRECTORY, String(port));

      // Never delete another process's replacement token.
      if ((await readFile(path, "utf8").catch(() => null)) === token) await rm(path);
    }

    await rm(directory, { recursive: true, force: true });
  });

  lines.on("line", (line) => {
    const message: Json = JSON.parse(line);
    const id = at(message, "id");
    const callbacks = typeof id === "number" ? pending.get(id) : undefined;

    if (callbacks === undefined || typeof id !== "number") return;

    pending.delete(id);

    const error = at(message, "error");

    if (error !== undefined) callbacks.reject(new Error(JSON.stringify(error)));
    else callbacks.resolve(at(message, "result") ?? null);
  });
  server.on("error", (error) => {
    for (const request of pending.values()) request.reject(error);
  });
  server.on("exit", () => {
    for (const request of pending.values()) request.reject(new Error(`Server exited: ${stderr}`));

    pending.clear();
  });

  const send = (message: JsonObject) => server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

  const call = (method: string, params: JsonObject = {}) => {
    const id = nextId++;

    const response = new Promise<Json>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });

    return bounded(response, method).finally(() => pending.delete(id));
  };

  const exercised = new Set<string>();

  const tool = async (name: string, args: JsonObject = {}, success = true) => {
    const result = await call("tools/call", { name, arguments: args });
    const structured = at(result, "structuredContent");

    assert.equal(at(result, "isError") === true, !success, `${name}: ${JSON.stringify(result)}`);
    assert.ok(structured !== undefined && isJsonObject(structured), `${name} has no structured object`);
    exercised.add(name);

    return result;
  };

  const initialize = await call("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "result-contract-test", version: "1.0" },
  });

  assert.equal(at(initialize, "serverInfo", "name"), "mcp-safari");
  send({ method: "notifications/initialized" });

  // The server answers `initialize` without waiting for its bridge to bind, so the
  // listener may still be coming up on the first look.
  let statusResult: Json = null;
  let status: Json | undefined;

  for (let attempt = 0; attempt < 50; attempt++) {
    statusResult = await tool("status");
    status = at(statusResult, "structuredContent", "status");

    if (at(status, "listener") === "listening") break;

    await delay(100);
  }

  const statusText = at(statusResult, "content", 0, "text");

  assert.ok(typeof statusText === "string");
  assert.deepEqual(status, JSON.parse(statusText));
  assert.equal(at(status, "listener"), "listening");

  const listeningPort = at(status, "port");

  assert.ok(typeof listeningPort === "number" && listeningPort > 0);
  port = listeningPort;
  token = await readFile(join(TOKEN_DIRECTORY, String(port)), "utf8");

  let pageText = "Example Domain";
  let jsText = "42";
  let failAction: string | undefined;

  // The shape the extension sends: tabs_query entries carry the browser's tab
  // fields plus `access`, and url and title only for a granted site. An
  // ungranted tab also carries `accessHint`.
  const tab = {
    id: 7,
    active: true,
    pinned: false,
    audible: false,
    muted: false,
    status: "complete",
    windowId: 1,
    index: 0,
    access: "granted",
    url: "https://example.com/",
    title: "Example",
  };

  const ungrantedTab = (id: number) => ({
    id,
    active: false,
    pinned: false,
    audible: false,
    muted: false,
    status: "complete",
    windowId: 1,
    index: id,
    access: "not_granted",
    accessHint: "Grant access from the MCPSafari button in Safari's toolbar.",
  });

  let queryTabs: Json[] = [tab];
  const snapshot = { uid: "f0e1", tag: "body", children: [] };
  const trace = { events: [{ type: "click", timestamp: 1 }] };

  const responseData = (action: string, params: Json): Json => {
    switch (action) {
      case "tabs_query":
        return queryTabs;
      case "tabs_create":
        return { id: tab.id, access: "granted", url: tab.url, title: tab.title };
      case "select_tab":
        return { id: tab.id, selected: true, access: "granted", url: tab.url, title: tab.title };
      case "read_page":
        return at(params, "format") === "snapshot" ? snapshot : pageText;
      case "snapshot":
        return snapshot;
      case "find":
        return [{ uid: "f0e1", tag: "body" }];
      case "read_console":
        return [{ level: "log", message: "hello" }];
      case "read_network":
        return [{ url: "https://example.com/", status: 200 }];
      case "start_trace":
        return "trace-1";
      case "stop_trace":
        return trace;
      case "javascript_tool":
        return jsText;
      case "screenshot":
        return { image: png, viewport: { width: 1, height: 1 }, devicePixelRatio: 1, visible: true, hasFocus: true };
      case "wait":
        return { matched: true };
      default:
        return `Completed ${action}`;
    }
  };

  const connect = async (
    profileId: string,
    respond: (request: BridgeRequest) => BridgeReply | Promise<BridgeReply>,
  ) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);

    sockets.push(socket);

    // The extension's half of the challenge-response handshake. The token is the
    // key to both proofs and is never sent; the fixture checks the server's proof
    // before it sends its own, as the extension does.
    const clientNonce = randomBytes(32).toString("base64url");

    const proof = (role: "server" | "client", first: string, second: string) =>
      createHmac("sha256", token ?? "")
        .update(`mcpsafari-v${BRIDGE_PROTOCOL_VERSION}-${role}|${port}|${first}|${second}`)
        .digest("base64url");

    const authenticated = new Promise<void>((resolve, reject) => {
      socket.addEventListener("error", () => reject(new Error("WebSocket failed")));
      socket.addEventListener("open", () =>
        socket.send(
          JSON.stringify({
            hello: { clientNonce, extensionVersion: "9.9.9", protocolVersion: BRIDGE_PROTOCOL_VERSION, profileId },
          }),
        ),
      );
      socket.addEventListener("message", async ({ data }) => {
        const message: Json = JSON.parse(String(data));
        const challenge = at(message, "challenge");

        if (challenge !== undefined) {
          const serverNonce = stringAt(challenge, "serverNonce");

          if (at(challenge, "serverProof") !== proof("server", clientNonce, serverNonce)) {
            reject(new Error("The server's proof was wrong"));

            return;
          }

          socket.send(JSON.stringify({ auth: { clientProof: proof("client", serverNonce, clientNonce) } }));

          return;
        }

        const auth = at(message, "auth");

        if (auth !== undefined) {
          if (auth === "ok") resolve();
          else reject(new Error(`Authentication failed: ${stringAt(message, "error")}`));

          return;
        }

        const request = {
          id: at(message, "id") ?? null,
          action: stringAt(message, "action"),
          params: at(message, "params") ?? null,
        };

        socket.send(JSON.stringify({ id: request.id, ...(await respond(request)) }));
      });
    });

    await bounded(authenticated, "extension authentication");
  };

  // How many requests for each action the extension holds at once, and for how
  // long it takes to answer one. The delay is what lets overlap happen at all.
  const inFlight = new Map<string, number>();
  const peakInFlight = new Map<string, number>();
  let answerDelayMs = 0;
  // Every request the extension received, in order, so a test can show that a
  // refused call never reached it.
  const received: string[] = [];
  // The tab the user has selected, which a request that names none acts on.
  // `moveSelectionAfter` makes the user switch tabs once that action has been
  // answered, the way they can while a multi-request call is still running.
  let selectedTab = 7;
  let moveSelectionAfter: string | undefined;
  const requests: { readonly action: string; readonly tabId: Json | undefined }[] = [];
  const untargeted = new Set(["tabs_query", "tabs_create", "tabs_close", "select_tab"]);

  await connect("default", async ({ action, params }) => {
    sentActions.add(action);
    received.push(action);
    requests.push({ action, tabId: at(params, "tabId") });

    const holding = (inFlight.get(action) ?? 0) + 1;

    inFlight.set(action, holding);
    peakInFlight.set(action, Math.max(peakInFlight.get(action) ?? 0, holding));

    if (answerDelayMs > 0) await delay(answerDelayMs);

    inFlight.set(action, (inFlight.get(action) ?? 1) - 1);

    // Reported on success and failure alike, null where no tab is involved.
    const resolvedTabId = untargeted.has(action) ? null : (at(params, "tabId") ?? selectedTab);

    if (action === moveSelectionAfter) selectedTab = 9;

    if (action === failAction) {
      return {
        success: false,
        error: "Fixture refusal",
        errorCode: "permission_required",
        retryable: true,
        recoveryAction: "ask_user",
        resolvedTabId,
      };
    }

    const data = responseData(action, params);

    return { success: true, data: typeof data === "string" ? data : JSON.stringify(data), resolvedTabId };
  });

  const tools = at(await call("tools/list"), "tools");

  assert.ok(tools !== undefined && isJsonArray(tools));

  const tabs = await tool("tabs_context");

  assert.equal(at(tabs, "structuredContent", "tabs", 0, "id"), "p0t7");
  assert.deepEqual(at(tabs, "structuredContent", "profileFailures"), []);
  // A granted listing has nothing to add. An ungranted one says so once for
  // the whole listing, with the extension's hint said once rather than per tab.
  assert.equal(lengthAt(tabs, "content"), 1);
  queryTabs = [tab, ungrantedTab(11), ungrantedTab(12)];

  const mixed = await tool("tabs_context");

  queryTabs = [tab];
  assert.equal(lengthAt(mixed, "structuredContent", "tabs"), 3);
  assert.equal(at(mixed, "structuredContent", "tabs", 1, "access"), "not_granted");
  assert.equal(lengthAt(mixed, "content"), 2);
  assert.match(stringAt(mixed, "content", 1, "text"), /Access to 2 tabs' sites is not granted/);
  assert.equal(stringAt(mixed, "content", 1, "text").split("Grant access from the MCPSafari button").length - 1, 1);

  for (const name of ["tabs_create", "select_tab"]) {
    const result = await tool(name, name === "select_tab" ? { tabId: "p0t7" } : {});

    assert.equal(at(result, "structuredContent", "tab", "id"), "p0t7");
  }

  assert.deepEqual(at(await tool("close_tab", { tabId: "p0t7" }), "structuredContent", "tab"), {
    id: "p0t7",
    closed: true,
  });

  for (const text of ["42", "true", "null", '"quoted"', "{}", "[]", '{"nested":[1,true]}', "<p>hello</p>"]) {
    pageText = text;

    for (const format of [undefined, "text", "html"]) {
      const result = await tool("read_page", format === undefined ? {} : { format });

      assert.equal(at(result, "structuredContent", "page"), text);
      assert.equal(at(result, "content", 0, "text"), text);
    }
  }

  assert.deepEqual(at(await tool("read_page", { format: "snapshot" }), "structuredContent", "page"), snapshot);
  assert.deepEqual(at(await tool("snapshot"), "structuredContent", "snapshot"), snapshot);
  assert.ok(Array.isArray(at(await tool("find", { selector: "body" }), "structuredContent", "matches")));
  assert.ok(Array.isArray(at(await tool("read_console"), "structuredContent", "messages")));
  assert.ok(Array.isArray(at(await tool("read_network"), "structuredContent", "requests")));

  for (const value of [42, true, null, "text", [1, 2], { a: true }]) {
    jsText = JSON.stringify(value);
    assert.deepEqual(at(await tool("javascript_tool", { code: "fixture" }), "structuredContent", "result"), value);
  }

  jsText = "42\n\n[Ran in the extension's isolated world]";
  assert.equal(at(await tool("javascript_tool", { code: "fixture" }), "structuredContent", "result"), jsText);

  const input = join(directory, "input.txt");

  await writeFile(input, "attached file");

  const actions = {
    navigate: { url: "https://example.com/" },
    click: { selector: "body" },
    type_text: { selector: "input", text: "hello" },
    form_input: { fields: { name: "Ada" } },
    select_option: { selector: "select", value: "a" },
    scroll: { direction: "down" },
    press_key: { key: "Enter" },
    hover: { selector: "body" },
    drag: { fromSelector: "#source", toSelector: "#target" },
    upload_file: { selector: "input", filePath: input },
    drop_file: { selector: "body", filePath: input },
    handle_dialog: { action: "dismiss" },
  } satisfies Readonly<Record<string, JsonObject>>;

  for (const [name, args] of Object.entries(actions)) {
    const properties = at(
      tools.find((candidate) => at(candidate, "name") === name),
      "inputSchema",
      "properties",
    );

    const options: Record<string, Json> = {};

    if (at(properties, "includeSnapshot") !== undefined) options["includeSnapshot"] = true;

    if (at(properties, "trace") !== undefined) Object.assign(options, { trace: true, traceDuration: 0 });

    if (at(properties, "waitForSelector") !== undefined) options["waitForSelector"] = "body";

    const result = await tool(name, { ...args, ...options });

    assert.equal(typeof at(result, "structuredContent", "result"), "string", name);

    if (options["includeSnapshot"] !== undefined) {
      assert.deepEqual(at(result, "structuredContent", "snapshot"), snapshot, name);
    }

    if (options["trace"] !== undefined) assert.deepEqual(at(result, "structuredContent", "trace"), trace, name);

    if (options["waitForSelector"] !== undefined) {
      assert.deepEqual(at(result, "structuredContent", "wait"), { matched: true }, name);
    }
  }

  await tool("resize_window", { width: 800, height: 600 });
  assert.deepEqual(at(await tool("wait", { seconds: 0 }), "structuredContent", "wait"), { seconds: 0 });
  assert.deepEqual(at(await tool("wait", { selector: "body" }), "structuredContent", "wait"), { matched: true });

  const inline = await tool("screenshot");

  assert.equal(at(inline, "content", 0, "type"), "image");
  assert.equal(at(inline, "content", 0, "data"), png);
  assert.equal(at(inline, "structuredContent", "screenshot", "image"), undefined);

  const filePath = join(directory, "capture.png");
  const saved = await tool("screenshot", { filePath });

  assert.equal(at(saved, "structuredContent", "screenshot", "filePath"), filePath);
  assert.equal(at(saved, "structuredContent", "screenshot", "byteCount"), Buffer.from(png, "base64").length);
  assert.deepEqual(await readFile(filePath), Buffer.from(png, "base64"));

  const batch = await tool("run_steps", {
    steps: [
      { tool: "click", arguments: { selector: "body" } },
      { tool: "wait", arguments: { seconds: 0 } },
    ],
    includeSnapshot: true,
    trace: true,
    traceDuration: 0,
  });

  assert.equal(at(batch, "structuredContent", "completedSteps"), 2);

  const results = at(batch, "structuredContent", "results");

  assert.ok(results !== undefined && isJsonArray(results));

  for (const entry of results) assert.ok(at(entry, "result", "structuredContent"));

  assert.deepEqual(at(batch, "structuredContent", "snapshot"), snapshot);
  assert.deepEqual(at(batch, "structuredContent", "trace"), trace);
  assert.deepEqual([...exercised].sort(), tools.map((entry) => stringAt(entry, "name")).sort());

  // A screenshot may activate its tab, and the extension's prepare step and the
  // capture must not be pulled apart by a parallel call that focuses something
  // else. The server serialises such calls end to end; an ordinary read is
  // free to overlap, which is what shows the fixture could have caught it.
  answerDelayMs = 40;
  await Promise.all([0, 1, 2, 3].map(() => tool("screenshot")));
  assert.equal(peakInFlight.get("screenshot"), 1, "screenshots overlapped at the extension");
  await Promise.all([0, 1, 2, 3].map(() => tool("snapshot")));
  assert.ok((peakInFlight.get("snapshot") ?? 0) > 1, "the fixture never overlapped two plain reads");
  answerDelayMs = 0;

  // A call that names no tab acts on the selected one, and its own follow-ups
  // are separate requests. The extension reports the tab it resolved, and the
  // follow-ups go to that tab even if the user switches while the call runs.
  const sentSince = (start: number) =>
    requests.slice(start).map(({ action, tabId }) => `${action}:${tabId === undefined ? "-" : JSON.stringify(tabId)}`);

  selectedTab = 7;
  moveSelectionAfter = "click";

  let start = requests.length;

  await tool("click", { selector: "body", waitForText: "Done", includeSnapshot: true });
  moveSelectionAfter = undefined;
  assert.deepEqual(sentSince(start), ["click:-", "wait:7", "snapshot:7"]);

  selectedTab = 7;
  moveSelectionAfter = "click";
  start = requests.length;
  await tool("click", { selector: "body", trace: true, traceDuration: 0 });
  moveSelectionAfter = undefined;
  assert.deepEqual(sentSince(start), ["start_trace:-", "click:-", "stop_trace:7"]);

  // An explicit tab is left alone.
  selectedTab = 9;
  start = requests.length;
  await tool("click", { selector: "body", tabId: "p0t3", includeSnapshot: true });
  assert.deepEqual(sentSince(start), ["click:3", "snapshot:3"]);

  // A batch with no tab pins the first step's tab for every later step, and
  // for its final snapshot and trace.
  selectedTab = 7;
  moveSelectionAfter = "click";
  start = requests.length;

  const pinnedBatch = await tool("run_steps", {
    steps: [
      { tool: "click", arguments: { selector: "body" } },
      { tool: "hover", arguments: { selector: "body" } },
      { tool: "wait", arguments: { text: "Done" } },
      { tool: "click", arguments: { selector: "body", tabId: "p0t3" } },
    ],
    includeSnapshot: true,
    trace: true,
    traceDuration: 0,
  });

  moveSelectionAfter = undefined;
  assert.equal(at(pinnedBatch, "structuredContent", "completedSteps"), 4);
  assert.deepEqual(sentSince(start), [
    "start_trace:-",
    "click:-",
    "hover:7",
    "wait:7",
    "click:3",
    "stop_trace:7",
    "snapshot:7",
  ]);
  selectedTab = 7;

  // A batch that names a tab uses it throughout.
  start = requests.length;
  await tool("run_steps", {
    tabId: "p0t5",
    steps: [
      { tool: "click", arguments: { selector: "body" } },
      { tool: "wait", arguments: { seconds: 0 } },
    ],
  });
  assert.deepEqual(sentSince(start), ["click:5"]);

  // A wrong-typed argument is refused before the extension hears of the call.
  // Reading it as absent would have run the call with a default the caller
  // never asked for: bringToFront "false" activates the tab, and a status
  // filter given as "500" returns every request.
  const refuse = async (name: string, args: JsonObject, expected: RegExp) => {
    const before = received.length;
    const refused = await tool(name, args, false);

    assert.equal(at(refused, "structuredContent", "code"), "invalid_input", `${name}: ${JSON.stringify(refused)}`);
    assert.equal(at(refused, "structuredContent", "recoveryAction"), "fix_input", name);
    assert.match(stringAt(refused, "structuredContent", "message"), expected, name);
    assert.equal(received.length, before, `${name} reached the extension`);
  };

  await refuse("select_tab", { tabId: "p0t7", bringToFront: "false" }, /bringToFront must be a boolean/);
  await refuse("read_network", { status: "500" }, /status must be an integer/);
  await refuse("read_console", { pattern: 5, clear: true }, /pattern must be a string/);
  await refuse("resize_window", { width: 800 }, /height is required/);
  await refuse("navigate", { url: "javascript:alert(1)" }, /disallowed scheme/);
  // The wait and trace options are read before the action is sent. Checking
  // them afterwards meant a caller who corrected the argument and retried
  // submitted the form twice, or left a trace running that nothing stopped.
  await refuse("click", { selector: "#submit", waitForSelector: "" }, /waitForSelector must not be empty/);
  await refuse("click", { selector: "#submit", waitForText: 5 }, /waitForText must be a string/);
  await refuse("click", { selector: "#submit", waitForText: "Done", waitTimeout: "5" }, /waitTimeout must be a number/);
  await refuse(
    "navigate",
    { url: "https://example.com/", trace: true, traceDuration: "long" },
    /traceDuration must be a number/,
  );
  await refuse(
    "type_text",
    { selector: "input", text: "x", trace: true, eventTypes: [""] },
    /eventTypes must be an array/,
  );
  // The bridge token is a file the same account can read, so a file tool that
  // took any caller-named path would hand it to a page. It is refused as a
  // file to attach and as a file: URL to open, before the extension is asked.
  const tokenPath = join(TOKEN_DIRECTORY, String(port));

  await refuse("upload_file", { selector: "input", filePath: tokenPath }, /bridge token/);
  await refuse("drop_file", { selector: "body", filePaths: [tokenPath] }, /bridge token/);
  await refuse("navigate", { url: `file://${tokenPath}` }, /bridge token/);
  await refuse("tabs_create", { url: `file://${tokenPath}` }, /bridge token/);

  // A screenshot save may only create a .png or replace a PNG: it used to
  // overwrite any file the account could write.
  const notes = join(directory, "notes.png");

  await writeFile(notes, "not an image");
  await refuse("screenshot", { filePath: join(directory, "profile.sh") }, /must end in \.png/);
  await refuse("screenshot", { filePath: notes }, /not a PNG image/);
  assert.equal(await readFile(notes, "utf8"), "not an image");
  await refuse("screenshot", { filePath: `${tokenPath}.png` }, /bridge token/);
  // A batch is validated as a whole before its first step runs: a bad URL in
  // step 3 must not leave steps 1 and 2 already performed.
  await refuse(
    "run_steps",
    {
      steps: [
        { tool: "click", arguments: { selector: "body" } },
        { tool: "wait", arguments: { seconds: 0 } },
        { tool: "navigate", arguments: { url: "jav\tascript:alert(1)" } },
      ],
    },
    /steps\[2\] \(navigate\): Invalid URL or disallowed scheme/,
  );
  await refuse(
    "run_steps",
    {
      steps: [
        { tool: "click", arguments: { selector: "body" } },
        { tool: "navigate", arguments: { action: "sideways" } },
      ],
    },
    /steps\[1\] \(navigate\): Invalid navigation action/,
  );

  failAction = "click";

  const failed = await tool("click", { selector: "body" }, false);

  assert.equal(at(failed, "structuredContent", "code"), "permission_required");
  assert.equal(at(failed, "structuredContent", "recoveryAction"), "ask_user");
  await connect("work", () => ({ success: false, error: "Profile unavailable" }));

  const partial = await tool("tabs_context");
  const partialTabs = at(partial, "structuredContent", "tabs");
  const profileFailures = at(partial, "structuredContent", "profileFailures");

  assert.ok(partialTabs !== undefined && isJsonArray(partialTabs));
  assert.equal(partialTabs.length, 1);
  assert.ok(profileFailures !== undefined && isJsonArray(profileFailures));
  assert.equal(profileFailures.length, 1);
  assert.match(stringAt(profileFailures, 0), /Profile unavailable/);

  // Selecting a tab on a site Safari has not granted succeeds and says so. It
  // still pins the tab's profile, and the result tells the model in prose that
  // the next read will be refused rather than leaving it to find out.
  await connect("third", ({ action }) =>
    action === "select_tab"
      ? {
          success: true,
          data: JSON.stringify({
            id: 9,
            selected: true,
            access: "not_granted",
            accessHint: "Grant example.org from the MCPSafari toolbar button.",
          }),
        }
      : { success: false, error: "Not used" },
  );

  const ungranted = await tool("select_tab", { tabId: "p2t9" });

  assert.equal(at(ungranted, "structuredContent", "tab", "id"), "p2t9");
  assert.equal(at(ungranted, "structuredContent", "tab", "access"), "not_granted");
  assert.match(stringAt(ungranted, "content", 0, "text"), /not_granted/);

  const ungrantedContent = at(ungranted, "content");

  const ungrantedText = (ungrantedContent !== undefined && isJsonArray(ungrantedContent) ? ungrantedContent : [])
    .map((entry) => stringAt(entry, "text"))
    .join("\n");

  assert.match(ungrantedText, /Access to one tab's site is not granted/);
  assert.match(ungrantedText, /Grant example\.org from the MCPSafari toolbar button\./);

  const profiles = at(await tool("status"), "structuredContent", "status", "profiles");

  const pinned = (profiles !== undefined && isJsonArray(profiles) ? profiles : []).find(
    (profile) => at(profile, "selected") === true,
  );

  assert.equal(at(pinned, "handle"), "p2");

  // The one boundary that spans both languages. This fixture answers any
  // action it is sent, including `default: Completed ${action}`, so every
  // tool above passes whether or not the real extension knows the action the
  // server used. A renamed or mistyped action would reach a user as
  // "Unknown action" having passed CI.
  //
  // The action names come from the server actually sending them rather than
  // from reading the Swift source, so there is no pattern here to drift.
  const unroutable = [...sentActions].filter((action) => !routableActions.has(action)).sort();

  assert.deepEqual(unroutable, [], `the extension has no handler for: ${unroutable.join(", ")}`);
  assert.ok(sentActions.size >= 15, `expected the tools above to exercise the bridge, saw ${sentActions.size} actions`);
});

interface StartedServer {
  readonly server: ChildProcessWithoutNullStreams;
  readonly exited: Promise<{ readonly code: number | null; readonly by: NodeJS.Signals | null }>;
  readonly ask: (method: string, params?: JsonObject) => Promise<Json | undefined>;
  readonly port: number;
  readonly tokenFile: string;
  readonly ownerFile: string;
}

/**
 * Starts the real server on any free port and waits until its bridge is listening.
 * The port it bound is how the token file is found.
 */
async function startServer(name: string): Promise<StartedServer> {
  const server = spawn(binary, ["--port", "0"], { stdio: ["pipe", "pipe", "pipe"] });

  const exited = new Promise<{ code: number | null; by: NodeJS.Signals | null }>((resolve) =>
    server.once("exit", (code, by) => resolve({ code, by })),
  );

  const lines = createInterface({ input: server.stdout });
  let stderr = "";

  server.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  // SIGTERM rather than SIGKILL, so the server removes its own token files. A test
  // that already stopped it leaves nothing for this to do.
  onTestFinished(async () => {
    lines.close();

    if (server.exitCode !== null || server.signalCode !== null) return;

    server.kill("SIGTERM");

    try {
      await bounded(exited, "server shutdown", 2000);
    } catch {
      server.kill("SIGKILL");
      await bounded(exited, "kill server");
    }
  });

  const answers = new Map<Json | undefined, Json>();

  lines.on("line", (line) => {
    const message: Json = JSON.parse(line);

    answers.set(at(message, "id"), message);
  });

  let nextId = 1;

  const ask = async (method: string, params: JsonObject = {}) => {
    const id = nextId++;

    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);

    for (let attempt = 0; attempt < 100 && !answers.has(id); attempt++) await delay(50);

    assert.ok(answers.has(id), `no answer to ${method}: ${stderr}`);

    return at(answers.get(id), "result");
  };

  await ask("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name, version: "1.0" } });

  // Status is how the port is learned, and asking also proves it came up.
  let status: Json | undefined;

  for (let attempt = 0; attempt < 50; attempt++) {
    status = at(await ask("tools/call", { name: "status", arguments: {} }), "structuredContent", "status");

    if (at(status, "listener") === "listening") break;

    await delay(100);
  }

  assert.equal(at(status, "listener"), "listening", `the bridge never came up: ${stderr}`);

  const port = at(status, "port");

  assert.ok(typeof port === "number");

  return {
    server,
    exited,
    ask,
    port,
    tokenFile: join(TOKEN_DIRECTORY, String(port)),
    ownerFile: join(TOKEN_DIRECTORY, `${port}.pid`),
  };
}

const SIGNAL_NUMBERS: readonly (readonly [NodeJS.Signals, number])[] = [
  ["SIGTERM", 15],
  ["SIGINT", 2],
  ["SIGHUP", 1],
];

for (const [signal, number] of SIGNAL_NUMBERS) {
  test(`${signal} removes the server's token files before it exits`, { timeout: 30_000 }, async () => {
    const { server, exited, tokenFile, ownerFile } = await startServer("signal-test");

    assert.ok(await readFile(tokenFile, "utf8").catch(() => null), "the token is published while it runs");
    assert.equal(await readFile(ownerFile, "utf8"), String(server.pid), "and records which process owns it");

    server.kill(signal);

    const { code, by } = await bounded(exited, `exit on ${signal}`, 5000);

    // A handled signal is a normal exit with the conventional status. Dying of the
    // signal itself would mean nothing handled it, and no cleanup ran.
    assert.equal(by, null, `killed by ${by} instead of exiting`);
    assert.equal(code, 128 + number);
    assert.equal(await readFile(tokenFile, "utf8").catch(() => null), null, "the token file is gone");
    assert.equal(await readFile(ownerFile, "utf8").catch(() => null), null, "and so is its owner record");
  });
}

// The two halves of the handshake are written in different languages, so each side's
// own tests can only show it agrees with its own reading of the protocol. This runs
// the background bundle Safari loads, with its WebCrypto, against the real server.
test("the extension's own handshake code authenticates against the server", { timeout: 30_000 }, async () => {
  const { ask, port, tokenFile } = await startServer("interop-test");
  const token = await readFile(tokenFile, "utf8");
  const bundle = await readFile(BACKGROUND_BUNDLE, "utf8");

  // Once the test is over the bundle's sockets are closed and its timers cleared,
  // or a close schedules a reconnect and the timer keeps this process alive.
  const sockets: WebSocket[] = [];
  const timers = new Set<NodeJS.Timeout>();
  let stopped = false;

  class TrackedWebSocket extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      sockets.push(this);
    }
  }

  onTestFinished(() => {
    stopped = true;

    for (const timer of timers) clearTimeout(timer);

    for (const socket of sockets) socket.close();
  });

  const noop = () => {};

  // What the bundle logged, for the failure message: it says why a handshake failed.
  const logged: string[] = [];
  const record = (...args: readonly unknown[]) => void logged.push(args.map(String).join(" "));
  const event = { addListener: noop, removeListener: noop, hasListener: () => false };
  const popupListeners: ((message: JsonObject, sender: JsonObject, sendResponse: () => void) => void)[] = [];

  // What a Safari background page has, and only the parts of `browser` this
  // path reaches. The one tab is on a granted site, so the access probe passes.
  const page = createContext({
    atob,
    btoa,
    crypto: globalThis.crypto,
    TextEncoder,
    TextDecoder,
    URL,
    queueMicrotask,
    performance,
    clearTimeout,
    setTimeout: (callback: () => void, ms?: number) => {
      if (stopped) return undefined;

      const timer = setTimeout(() => {
        timers.delete(timer);
        callback();
      }, ms);

      timers.add(timer);

      return timer;
    },
    console: {
      log: record,
      info: record,
      warn: record,
      error: record,
      debug: record,
      trace: record,
      group: record,
      groupEnd: record,
    },
    WebSocket: TrackedWebSocket,
    browser: {
      alarms: { create: async () => {}, onAlarm: event },
      runtime: {
        getManifest: () => ({ version: "9.9.9" }),
        onMessage: {
          ...event,
          addListener: (listener: (typeof popupListeners)[number]) => popupListeners.push(listener),
        },
        sendNativeMessage: async () => ({ tokens: { [port]: token } }),
      },
      scripting: { executeScript: async () => [{ result: true }] },
      storage: {
        local: { get: async () => ({}), set: async () => {} },
        session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      },
      tabs: {
        get: async () => ({ id: 7, active: true, windowId: 1, url: "https://example.com/", title: "T" }),
        query: async () => [{ id: 7, active: true, windowId: 1, index: 0, url: "https://example.com/", title: "T" }],
        onUpdated: event,
        onRemoved: event,
      },
    },
  });

  runInContext(bundle, page, { filename: "background.js" });
  // The server's port is not in the extension's scan range, so add it the way the popup does.
  popupListeners[0]?.({ type: "addPort", port }, {}, noop);

  let profiles: Json | undefined;
  let status: Json | undefined;

  for (let attempt = 0; attempt < 100; attempt++) {
    status = at(await ask("tools/call", { name: "status", arguments: {} }), "structuredContent", "status");
    profiles = at(status, "profiles");

    if (lengthAt(profiles) === 1) break;

    await delay(50);
  }

  assert.deepEqual(
    (profiles !== undefined && isJsonArray(profiles) ? profiles : []).map((profile) => at(profile, "id")),
    ["default"],
    `the extension never authenticated: ${JSON.stringify(status)}\n${logged.join("\n")}`,
  );
  assert.equal(at(status, "extensionVersion"), "9.9.9");
  assert.equal(at(status, "extensionProtocolVersion"), BRIDGE_PROTOCOL_VERSION);

  const tabs = at(await ask("tools/call", { name: "tabs_context", arguments: {} }), "structuredContent");

  assert.equal(at(tabs, "tabs", 0, "id"), "p0t7", "a request made it to the extension and back");
});
