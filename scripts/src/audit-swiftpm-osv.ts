// Audit SwiftPM Package.resolved dependencies with OSV.dev.
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

import { parseArguments } from "./argparse.ts";
import {
  type Json,
  type JsonObject,
  JsonDecodeError,
  OsError,
  PythonTypeError,
  RuntimeError,
  ValueError,
  get,
  isJsonArray,
  item,
  parseJson,
  pyPath,
  pyStrip,
  readText,
  truthy,
} from "./python.ts";

export const OSV_QUERY_BATCH_URL = "https://api.osv.dev/v1/querybatch";

const DESCRIPTION = "Audit SwiftPM Package.resolved dependencies with OSV.dev.";

/** Python's urllib request timeout. */
const TIMEOUT_MS = 30_000;

/** The HTTP client, injectable so tests stay offline. */
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** Where main() prints; a test can collect the lines instead. */
export interface Output {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

const PROCESS_OUTPUT: Output = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
};

interface PinFields {
  readonly identity: string;
  readonly location: string;
  readonly version: string | null;
  readonly revision: string | null;
  readonly source: string;
}

export class Pin {
  readonly identity: string;
  readonly location: string;
  readonly version: string | null;
  readonly revision: string | null;
  readonly source: string;

  constructor(fields: PinFields) {
    this.identity = fields.identity;
    this.location = fields.location;
    this.version = fields.version;
    this.revision = fields.revision;
    this.source = fields.source;
  }

  get repositoryName(): string {
    return normalizeRepositoryName(this.location);
  }
}

export interface Query {
  readonly pin: Pin;
  readonly payload: JsonObject;
}

export interface Vulnerability {
  readonly id: string;
  readonly pin: Pin;
}

/** One OSV batch result: the advisories matching the query at the same position. */
export interface OsvResult {
  readonly vulns?: readonly { readonly id: string }[];
}

/** urllib.error.URLError and HTTPError: a request that did not produce a 2xx response. */
export class UrlError extends Error {
  static {
    this.prototype.name = "urllib.error.URLError";
  }
}

export function normalizeRepositoryName(location: string): string {
  let repository = pyStrip(location);

  if (repository.startsWith("git@github.com:")) {
    repository = `github.com/${repository.slice("git@github.com:".length)}`;
  }

  for (const prefix of ["https://", "http://", "ssh://git@"]) {
    if (repository.startsWith(prefix)) repository = repository.slice(prefix.length);
  }

  repository = repository.replace(/\/+$/, "");

  if (repository.endsWith(".git")) repository = repository.slice(0, -4);

  return repository.toLowerCase();
}

/** A field Python would have carried as a str; anything else crashes it, uncaught. */
function text(value: Json, field: string): string {
  if (typeof value !== "string") throw new PythonTypeError(`${field} must be a str, not ${JSON.stringify(value)}`);

  return value;
}

function optionalText(value: Json, field: string): string | null {
  return value === null ? null : text(value, field);
}

export function loadPins(lockfiles: readonly string[]): Pin[] {
  const pins: Pin[] = [];

  for (const lockfile of lockfiles) {
    const source = pyPath(lockfile);
    const data = parseJson(readText(source));
    const entries = get(data, "pins", []);

    if (!isJsonArray(entries)) throw new PythonTypeError("pins must be a list");

    for (const pin of entries) {
      const state = get(pin, "state", {});

      pins.push(
        new Pin({
          identity: text(item(pin, "identity"), "identity"),
          location: text(item(pin, "location"), "location"),
          version: optionalText(get(state, "version"), "version"),
          revision: optionalText(get(state, "revision"), "revision"),
          source,
        }),
      );
    }
  }

  return pins;
}

/** `json.dumps(payload, sort_keys=True)`: equal payloads give equal keys. */
function canonical(value: Json): string {
  if (isJsonArray(value)) return `[${value.map(canonical).join(",")}]`;

  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();

    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key] ?? null)}`).join(",")}}`;
  }

  return JSON.stringify(value);
}

export function buildQueries(pins: readonly Pin[]): Query[] {
  const queries: Query[] = [];
  const seen = new Set<string>();

  const add = (pin: Pin, payload: JsonObject) => {
    const key = canonical(payload);

    if (!seen.has(key)) {
      queries.push({ pin, payload });
      seen.add(key);
    }
  };

  for (const pin of pins) {
    if (truthy(pin.version)) {
      for (const name of [pin.identity, pin.repositoryName]) {
        add(pin, { package: { ecosystem: "SwiftURL", name }, version: pin.version });
      }

      add(pin, { package: { purl: `pkg:swift/${pin.repositoryName}@${pin.version}` } });
    }

    if (truthy(pin.revision)) add(pin, { commit: pin.revision });
  }

  return queries;
}

/** urllib's wording for a request that failed before a response arrived. */
function requestFailure(cause: unknown): Error {
  if (cause instanceof Error && cause.name === "TimeoutError") return new UrlError("<urlopen error timed out>");

  const reason = cause instanceof Error && cause.cause instanceof Error ? cause.cause : cause;

  return new UrlError(`<urlopen error ${reason instanceof Error ? reason.message : String(reason)}>`);
}

function parseResult(result: Json): OsvResult {
  const vulns = get(result, "vulns", []);

  if (!isJsonArray(vulns)) throw new PythonTypeError("vulns must be a list");

  return { vulns: vulns.map((vulnerability) => ({ id: text(item(vulnerability, "id"), "id") })) };
}

export async function queryOsv(queries: readonly Query[], fetcher: Fetcher = fetch): Promise<OsvResult[]> {
  let body: string;

  try {
    const response = await fetcher(OSV_QUERY_BATCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ queries: queries.map((query) => query.payload) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) throw new UrlError(`HTTP Error ${response.status}: ${response.statusText}`);

    body = await response.text();
  } catch (cause) {
    throw cause instanceof UrlError ? cause : requestFailure(cause);
  }

  const results = get(parseJson(body), "results", []);

  if (!isJsonArray(results)) throw new PythonTypeError("results must be a list");

  if (results.length !== queries.length) {
    throw new RuntimeError(`OSV returned ${results.length} results for ${queries.length} queries`);
  }

  return results.map(parseResult);
}

export function collectVulnerabilities(queries: readonly Query[], results: readonly OsvResult[]): Vulnerability[] {
  if (queries.length !== results.length) throw new ValueError("zip() arguments have different lengths");

  const vulnerabilities: Vulnerability[] = [];
  const seen = new Set<string>();

  queries.forEach((query, index) => {
    for (const vulnerability of results[index]?.vulns ?? []) {
      const key = JSON.stringify([query.pin.identity, vulnerability.id, query.pin.version]);

      if (seen.has(key)) continue;

      vulnerabilities.push({ id: vulnerability.id, pin: query.pin });
      seen.add(key);
    }
  });

  return vulnerabilities;
}

export function describePin(pin: Pin): string {
  if (truthy(pin.version)) return `${pin.identity} ${pin.version}`;

  return `${pin.identity} ${pin.revision ?? "None"}`;
}

export async function main(
  argv: readonly string[],
  fetcher: Fetcher = fetch,
  output: Output = PROCESS_OUTPUT,
): Promise<number> {
  const parsed = parseArguments(
    {
      prog: basename(fileURLToPath(import.meta.url)),
      description: DESCRIPTION,
      positionals: [{ name: "lockfiles", variadic: true }],
    },
    argv,
  );

  if (parsed.kind === "exit") return parsed.code;

  let pins: Pin[];
  let queries: Query[];
  let results: OsvResult[];

  try {
    pins = loadPins(parsed.values.get("lockfiles") ?? []);
    queries = buildQueries(pins);

    if (queries.length === 0) {
      output.stdout("No SwiftPM pins with versions or revisions found.");

      return 0;
    }

    results = await queryOsv(queries, fetcher);
  } catch (cause) {
    const reported =
      cause instanceof OsError ||
      cause instanceof JsonDecodeError ||
      cause instanceof UrlError ||
      cause instanceof RuntimeError;

    if (!reported) throw cause;

    output.stderr(`::error::SwiftPM OSV audit failed: ${cause.message}`);

    return 2;
  }

  const vulnerabilities = collectVulnerabilities(queries, results);

  if (vulnerabilities.length > 0) {
    for (const vulnerability of vulnerabilities) {
      output.stderr(
        `::error file=${vulnerability.pin.source}::${vulnerability.id} affects ${describePin(vulnerability.pin)}`,
      );
    }

    return 1;
  }

  output.stdout(`No OSV vulnerabilities found for ${pins.length} SwiftPM pins.`);

  return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
