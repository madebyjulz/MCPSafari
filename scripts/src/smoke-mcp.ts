// Exercise stdio initialization, discovery and bridge status without Safari.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

import {
  AssertionError,
  IndexError,
  type Json,
  type JsonObject,
  PythonTypeError,
  RuntimeError,
  equal,
  exceptionLine,
  get,
  isJsonArray,
  isJsonObject,
  item,
  osError,
  parseJson,
  repr,
  str,
  truthy,
} from "./python.ts";

const REQUEST_TIMEOUT_MS = 15_000;

const SHUTDOWN_TIMEOUT_MS = 5_000;

const TIMED_OUT = Symbol("timed out");

/** `assert condition, detail`. */
function check(condition: boolean, detail?: Json): asserts condition {
  if (!condition) throw new AssertionError(detail === undefined ? "" : str(detail));
}

/** Resolves "timeout" after `ms`, without keeping the process alive on its own. */
function delay(ms: number): Promise<"timeout"> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms, "timeout").unref();
  });
}

export async function smoke(binary: string): Promise<void> {
  const server = spawn(binary, ["--port", "0"], { stdio: ["pipe", "pipe", "pipe"] });
  // Settles on exit only; `once` would also reject on a spawn error, which is reported below.
  const exited = new Promise<void>((resolve) => server.once("exit", () => resolve()));

  try {
    await once(server, "spawn");
  } catch (cause) {
    throw osError(cause, binary);
  }

  // Drained as it arrives so a chatty server never blocks on a full pipe.
  let errors = "";
  const errorsEnded = once(server.stderr, "end");

  server.stderr.setEncoding("utf8");
  server.stderr.on("data", (chunk: string) => {
    errors += chunk;
  });
  // A write after the server died fails here; the read side reports the exit.
  server.stdin.on("error", () => undefined);

  const lines = createInterface({ input: server.stdout, crlfDelay: Number.POSITIVE_INFINITY });
  const queue: string[] = [];
  let ended = false;
  let wake: (() => void) | undefined;

  lines.on("line", (line) => {
    queue.push(line);
    wake?.();
  });
  lines.on("close", () => {
    ended = true;
    wake?.();
  });

  /** The next stdout line, null once stdout has closed, or TIMED_OUT past the deadline. */
  const nextLine = async (deadline: number): Promise<string | null | typeof TIMED_OUT> => {
    while (queue.length === 0 && !ended) {
      const remaining = deadline - performance.now();

      if (remaining <= 0) return TIMED_OUT;

      let timer: NodeJS.Timeout | undefined;

      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, remaining);
      });
      clearTimeout(timer);
      wake = undefined;
    }

    return queue.shift() ?? null;
  };

  const send = (message: JsonObject) => {
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };

  const request = async (identifier: number, method: string, params: JsonObject): Promise<Json> => {
    send({ id: identifier, method, params });

    const deadline = performance.now() + REQUEST_TIMEOUT_MS;

    for (;;) {
      const line = await nextLine(deadline);

      if (line === TIMED_OUT) throw new RuntimeError(`Timed out awaiting ${method}`);

      if (line === null) {
        await Promise.race([errorsEnded, delay(1_000)]);

        throw new RuntimeError(`Server exited during ${method}: ${errors}`);
      }

      const reply = parseJson(line);

      if (equal(get(reply, "id"), identifier)) {
        if (isJsonObject(reply) && Object.hasOwn(reply, "error")) {
          throw new RuntimeError(`${method}: ${str(item(reply, "error"))}`);
        }

        return item(reply, "result");
      }
    }
  };

  try {
    const initialized = await request(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "mcpsafari-smoke", version: "1.0" },
    });

    check(equal(item(item(initialized, "serverInfo"), "name"), "mcp-safari"));
    send({ method: "notifications/initialized" });

    const listing = await request(2, "tools/list", {});
    const tools = item(listing, "tools");

    if (!isJsonArray(tools)) throw new PythonTypeError(`tools must be a list, not ${repr(tools)}`);

    const names = new Set(tools.map((tool) => item(tool, "name")));

    check(["status", "snapshot", "tabs_context"].every((name) => names.has(name)));

    const result = await request(3, "tools/call", { name: "status", arguments: {} });

    check(!truthy(get(result, "isError")));

    const text = item(item(item(result, "content"), 0), "text");

    if (typeof text !== "string") throw new PythonTypeError("the JSON object must be str, bytes or bytearray");

    const status = parseJson(text);

    check(equal(item(status, "listener"), "listening"), status);

    const port = equal(item(status, "requestedPort"), 0) ? item(status, "port") : null;

    check(typeof port === "number" && port > 0, status);
    check(item(status, "tokenFileSecure") === true, status);
    process.stdout.write(`MCP initialize, tools/list, status passed; loopback port ${str(port)}\n`);
  } finally {
    lines.close();
    server.stdin.end();

    if ((await Promise.race([exited, delay(SHUTDOWN_TIMEOUT_MS)])) === "timeout") {
      server.kill("SIGTERM");

      if ((await Promise.race([exited, delay(SHUTDOWN_TIMEOUT_MS)])) === "timeout") {
        server.kill("SIGKILL");
        await exited;
      }
    }

    server.stdout.destroy();
    server.stderr.destroy();
  }
}

if (import.meta.main) {
  const binary = process.argv[2];

  try {
    // sys.argv[1], as the Python original read it.
    if (binary === undefined) throw new IndexError("list index out of range");

    await smoke(binary);
  } catch (cause) {
    process.stderr.write(`${exceptionLine(cause)}\n`);
    process.exitCode = 1;
  }
}
