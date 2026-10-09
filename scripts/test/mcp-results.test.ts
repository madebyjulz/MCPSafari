// Actual stdio MCP server + authenticated loopback extension fixture; no Safari UI.
// Needs the built server, so it runs as `pnpm test:mcp`, not with the unit tests.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { onTestFinished, test } from "vitest";

import { ROUTABLE_ACTIONS } from "../../extension/src/background/actions.ts";
import { type Json, type JsonObject, isJsonArray, isJsonObject } from "../src/python.ts";

const binary =
  process.env["MCPSAFARI_TEST_BINARY"] ??
  fileURLToPath(new URL("../../MCPServer/.build/debug/MCPSafari", import.meta.url));

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

/** The string at `path`, or "" where there is none. */
function stringAt(value: Json | undefined, ...path: readonly (string | number)[]): string {
  const found = at(value, ...path);

  return typeof found === "string" ? found : "";
}

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

type BridgeReply =
  | { readonly success: true; readonly data: string }
  | {
      readonly success: false;
      readonly error: string;
      readonly errorCode?: string;
      readonly retryable?: boolean;
      readonly recoveryAction?: string;
    };

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
      for (const root of ["Library/Application Support/MCPSafari", ".config/mcp-safari"]) {
        const path = join(homedir(), root, "tokens", String(port));

        // Never delete another process's replacement token.
        if ((await readFile(path, "utf8").catch(() => null)) === token) await rm(path);
      }
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

  const statusResult = await tool("status");
  const status = at(statusResult, "structuredContent", "status");

  const statusText = at(statusResult, "content", 0, "text");

  assert.ok(typeof statusText === "string");
  assert.deepEqual(status, JSON.parse(statusText));
  assert.equal(at(status, "listener"), "listening");

  const listeningPort = at(status, "port");

  assert.ok(typeof listeningPort === "number" && listeningPort > 0);
  port = listeningPort;
  token = await readFile(join(homedir(), "Library/Application Support/MCPSafari/tokens", String(port)), "utf8");

  let pageText = "Example Domain";
  let jsText = "42";
  let failAction: string | undefined;
  const tab = { id: 7, url: "https://example.com/", title: "Example" };
  const snapshot = { uid: "f0e1", tag: "body", children: [] };
  const trace = { events: [{ type: "click", timestamp: 1 }] };

  const responseData = (action: string, params: Json): Json => {
    switch (action) {
      case "tabs_query":
        return [tab];
      case "tabs_create":
        return tab;
      case "select_tab":
        return { ...tab, selected: true };
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

  const connect = async (profileId: string, respond: (request: BridgeRequest) => BridgeReply) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);

    sockets.push(socket);

    const authenticated = new Promise<void>((resolve, reject) => {
      socket.addEventListener("error", () => reject(new Error("WebSocket failed")));
      socket.addEventListener("open", () =>
        socket.send(JSON.stringify({ auth: token, protocolVersion: 1, profileId })),
      );
      socket.addEventListener("message", ({ data }) => {
        const message: Json = JSON.parse(String(data));
        const auth = at(message, "auth");

        if (auth !== undefined) {
          if (auth === "ok") resolve();
          else reject(new Error("Authentication failed"));

          return;
        }

        const request = {
          id: at(message, "id") ?? null,
          action: stringAt(message, "action"),
          params: at(message, "params") ?? null,
        };

        socket.send(JSON.stringify({ id: request.id, ...respond(request) }));
      });
    });

    await bounded(authenticated, "extension authentication");
  };

  await connect("default", ({ action, params }) => {
    sentActions.add(action);

    if (action === failAction) {
      return {
        success: false,
        error: "Fixture refusal",
        errorCode: "permission_required",
        retryable: true,
        recoveryAction: "ask_user",
      };
    }

    const data = responseData(action, params);

    return { success: true, data: typeof data === "string" ? data : JSON.stringify(data) };
  });

  const tools = at(await call("tools/list"), "tools");

  assert.ok(tools !== undefined && isJsonArray(tools));

  const tabs = await tool("tabs_context");

  assert.equal(at(tabs, "structuredContent", "tabs", 0, "id"), "p0t7");
  assert.deepEqual(at(tabs, "structuredContent", "profileFailures"), []);

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
