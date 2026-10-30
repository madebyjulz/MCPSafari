import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  type Fetcher,
  type Output,
  type Query,
  HttpError,
  OSV_MAX_PAGES,
  OSV_QUERY_BATCH_URL,
  OSV_RETRY_BACKOFF_SECONDS,
  Pin,
  buildQueries,
  collectVulnerabilities,
  loadPins,
  main,
  queryOsv,
} from "../src/audit-swiftpm-osv.ts";
import { type Json, RuntimeError, get, isJsonArray, parseJson } from "../src/python.ts";

describe("AuditSwiftPMOSVTests", () => {
  test("load_pins reads Swift Package.resolved", () => {
    const packageResolved = {
      pins: [
        {
          identity: "swift-nio",
          location: "https://github.com/apple/swift-nio.git",
          state: { revision: "abc123", version: "2.97.0" },
        },
      ],
    };

    const directory = mkdtempSync(join(tmpdir(), "audit-osv-"));
    let pins: Pin[];

    try {
      const lockfile = join(directory, "Package.resolved");

      writeFileSync(lockfile, JSON.stringify(packageResolved), "utf8");
      pins = loadPins([lockfile]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }

    expect(pins).toHaveLength(1);
    expect(pins[0]?.identity).toBe("swift-nio");
    expect(pins[0]?.version).toBe("2.97.0");
    expect(pins[0]?.repositoryName).toBe("github.com/apple/swift-nio");
  });

  test("build_queries checks identity, repository and commit", () => {
    const pin = new Pin({
      identity: "swift-nio",
      location: "https://github.com/apple/swift-nio.git",
      version: "2.97.0",
      revision: "abc123",
      source: "MCPServer/Package.resolved",
    });

    const payloads = buildQueries([pin]).map((query) => query.payload);

    expect(payloads).toContainEqual({ package: { ecosystem: "SwiftURL", name: "swift-nio" }, version: "2.97.0" });
    expect(payloads).toContainEqual({
      package: { ecosystem: "SwiftURL", name: "github.com/apple/swift-nio" },
      version: "2.97.0",
    });
    expect(payloads).toContainEqual({ package: { purl: "pkg:swift/github.com/apple/swift-nio@2.97.0" } });
    expect(payloads).toContainEqual({ commit: "abc123" });
  });

  test("collect_vulnerabilities deduplicates results", () => {
    const pin = new Pin({
      identity: "swift-crypto",
      location: "https://github.com/apple/swift-crypto.git",
      version: "4.0.0",
      revision: "abc123",
      source: "Package.resolved",
    });

    const queries = [
      { pin, payload: { package: { name: "swift-crypto" } } },
      { pin, payload: { commit: "abc123" } },
    ];

    const results = [{ vulns: [{ id: "GHSA-9m44-rr2w-ppp7" }] }, { vulns: [{ id: "GHSA-9m44-rr2w-ppp7" }] }];

    const vulnerabilities = collectVulnerabilities(queries, results);

    expect(vulnerabilities).toHaveLength(1);
    expect(vulnerabilities[0]?.id).toBe("GHSA-9m44-rr2w-ppp7");
  });
});

function batchResponse(...results: Json[]): Response {
  return Response.json({ results });
}

function makeQueries(count: number): Query[] {
  const pin = new Pin({
    identity: "swift-nio",
    location: "https://github.com/apple/swift-nio.git",
    version: "2.97.0",
    revision: "abc123",
    source: "Package.resolved",
  });

  return Array.from({ length: count }, (_, n) => ({ pin, payload: { commit: `rev${n}` } }));
}

describe("QueryOSVTests", () => {
  /** Runs queryOsv against scripted fetch outcomes (a Response, or an Error to throw)
      and returns what it sent, so a test can read the request bodies as well as the
      result. The backoffs it would have slept are recorded instead. */
  function runQuery(responses: (Response | Error)[], count = 2) {
    const sent: Json[] = [];
    const sleeps: number[] = [];

    const fetcher: Fetcher = async (_url, init) => {
      sent.push(get(parseJson(typeof init.body === "string" ? init.body : ""), "queries"));

      const outcome = responses.shift();

      if (outcome === undefined) throw new Error("no scripted response left");

      if (outcome instanceof Error) throw outcome;

      return outcome;
    };

    const result = queryOsv(makeQueries(count), fetcher, async (seconds) => {
      sleeps.push(seconds);
    });

    return { result, sent, sleeps };
  }

  const httpError = (status: number) => new Response("", { status, statusText: "error" });

  test("follows next_page_token and merges pages", async () => {
    const run = runQuery([
      batchResponse({ vulns: [{ id: "OSV-1" }], next_page_token: "tok" }, {}),
      batchResponse({ vulns: [{ id: "OSV-2" }] }),
    ]);

    const results = await run.result;

    expect(results[0]?.vulns?.map((vulnerability) => vulnerability.id)).toEqual(["OSV-1", "OSV-2"]);
    expect(results[1]?.vulns).toEqual([]);
    // Only the query that still had pages is asked again, with its token.
    expect(run.sent[1]).toEqual([{ commit: "rev0", page_token: "tok" }]);
  });

  test("gives up when pagination never ends", async () => {
    const endless = Array.from({ length: OSV_MAX_PAGES }, () => batchResponse({ vulns: [], next_page_token: "again" }));
    const run = runQuery(endless, 1);

    await expect(run.result).rejects.toBeInstanceOf(RuntimeError);
  });

  test("retries once after a network error", async () => {
    const run = runQuery([
      new TypeError("fetch failed", { cause: new Error("connection reset") }),
      batchResponse({ vulns: [{ id: "OSV-1" }] }, {}),
    ]);

    const results = await run.result;

    expect(run.sent).toHaveLength(2);
    expect(run.sleeps).toEqual([OSV_RETRY_BACKOFF_SECONDS]);
    expect(results[0]?.vulns).toEqual([{ id: "OSV-1" }]);
  });

  test("retries a server error but only once", async () => {
    const run = runQuery([httpError(503), httpError(503)]);

    await expect(run.result).rejects.toBeInstanceOf(HttpError);
    expect(run.sleeps).toHaveLength(1);
  });

  test("does not retry a client error", async () => {
    const run = runQuery([httpError(400)]);

    await expect(run.result).rejects.toBeInstanceOf(HttpError);
    expect(run.sleeps).toEqual([]);
  });
});

// The CLI end to end, with OSV answered in-process so the suite stays offline.
describe("main", () => {
  const lockfile = {
    pins: [
      {
        identity: "swift-nio",
        location: "https://github.com/apple/swift-nio.git",
        state: { revision: "abc123", version: "2.97.0" },
      },
    ],
  };

  async function audit(respond: (queries: number) => Response) {
    const directory = mkdtempSync(join(tmpdir(), "audit-osv-"));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const requests: string[] = [];
    const output: Output = { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) };

    const fetcher: Fetcher = async (url, init) => {
      requests.push(url);

      const queries = get(parseJson(typeof init.body === "string" ? init.body : ""), "queries");

      return respond(isJsonArray(queries) ? queries.length : 0);
    };

    try {
      const path = join(directory, "Package.resolved");

      writeFileSync(path, JSON.stringify(lockfile));

      const code = await main([path], fetcher, output, async () => {});

      return { code, stdout, stderr, requests, path };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  test("a clean result exits 0", async () => {
    const run = await audit((queries) => Response.json({ results: Array.from({ length: queries }, () => ({})) }));

    expect(run.code).toBe(0);
    expect(run.requests).toEqual([OSV_QUERY_BATCH_URL]);
    expect(run.stdout).toEqual(["No OSV vulnerabilities found for 1 SwiftPM pins."]);
  });

  test("a vulnerability exits 1 with one annotation per advisory", async () => {
    const run = await audit((queries) =>
      Response.json({ results: Array.from({ length: queries }, () => ({ vulns: [{ id: "GHSA-test" }] })) }),
    );

    expect(run.code).toBe(1);
    expect(run.stderr).toEqual([`::error file=${run.path}::GHSA-test affects swift-nio 2.97.0`]);
  });

  test("a short or failed response exits 2", async () => {
    const short = await audit(() => Response.json({ results: [] }));

    expect(short.code).toBe(2);
    expect(short.stderr).toEqual(["::error::SwiftPM OSV audit failed: OSV returned 0 results for 4 queries"]);

    const failed = await audit(() => new Response("", { status: 503, statusText: "Service Unavailable" }));

    // A server error is retried once before it counts.
    expect(failed.requests).toHaveLength(2);
    expect(failed.code).toBe(2);
    expect(failed.stderr).toEqual(["::error::SwiftPM OSV audit failed: HTTP Error 503: Service Unavailable"]);
  });
});
