import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  type Fetcher,
  type Output,
  OSV_QUERY_BATCH_URL,
  Pin,
  buildQueries,
  collectVulnerabilities,
  loadPins,
  main,
} from "../src/audit-swiftpm-osv.ts";
import { get, isJsonArray, parseJson } from "../src/python.ts";

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

      const code = await main([path], fetcher, output);

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

    expect(failed.code).toBe(2);
    expect(failed.stderr).toEqual(["::error::SwiftPM OSV audit failed: HTTP Error 503: Service Unavailable"]);
  });
});
