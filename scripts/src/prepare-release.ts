// Fail-closed release metadata and artifact preparation; no network access.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseArguments } from "./argparse.ts";
import {
  CalledProcessError,
  KeyError,
  OsError,
  PythonTypeError,
  ValueError,
  type Json,
  get,
  item,
  osError,
  parseJson,
  pyPath,
  pyStrip,
  readText,
  repr,
  sortedUnique,
  typeName,
  writeText,
} from "./python.ts";

const DESCRIPTION = "Fail-closed release metadata and artifact preparation; no network access.";

export const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export const ARTIFACTS = [
  "MCPSafari-Server-arm64-apple-darwin",
  "MCPSafari-Server-x86_64-apple-darwin",
  "MCPSafari-Server-universal-apple-darwin",
  "MCPSafari-Extension-arm64.tar.gz",
  "MCPSafari-Extension-x86_64.tar.gz",
] as const;

// The release body is the changelog entry verbatim, so a stray section name or a
// second "Changed" ships to the release page as-is. Keep a Changelog's set.
export const CHANGELOG_SECTIONS = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"] as const;

const CHANGELOG_SECTION_NAMES: ReadonlySet<string> = new Set(CHANGELOG_SECTIONS);

// Python's re.MULTILINE anchors only at "\n"; JavaScript's `m` flag also anchors
// at "\r" and U+2028/9, so the line boundaries are spelled out instead.
const CHANGELOG_ENTRY = /(?<![^\n])## \[([^\]]+)\][^\n]*(?![^\n])/g;

const CHANGELOG_SECTION = /(?<![^\n])### +([^\n]*?) *(?![^\n])/g;

const RELEASE_TAG = /^v\p{Nd}+\.\p{Nd}+\.\p{Nd}+$/u;

function join(root: string, relative: string): string {
  return pyPath(`${root}/${relative}`);
}

export function releaseNotes(tag: string, root: string = ROOT): string {
  if (!RELEASE_TAG.test(tag)) throw new ValueError("Release tags must be vMAJOR.MINOR.PATCH");

  const version = tag.slice(1);
  const manifest = parseJson(readText(join(root, "MCPSafari/MCPSafari Extension/Resources/manifest.json")));
  const swift = readText(join(root, "MCPServer/Sources/mcp-safari/Diagnostics.swift"));
  const project = readText(join(root, "MCPSafari/MCPSafari.xcodeproj/project.pbxproj"));
  const manifestVersion = item(manifest, "version");
  const cliVersions = Array.from(swift.matchAll(/static let version = "([^"]+)"/g), (match) => match[1] ?? "");
  const appVersions = Array.from(project.matchAll(/MARKETING_VERSION = ([^;]+);/g), (match) => match[1] ?? "");

  if (cliVersions.length === 0 || appVersions.length === 0) {
    throw new ValueError("Could not locate CLI or app versions");
  }

  // A non-string version never equals the tag, and Python's sorted() of mixed
  // types then raises a TypeError that nothing catches.
  if (typeof manifestVersion !== "string") {
    throw new PythonTypeError(
      manifestVersion !== null && typeof manifestVersion === "object"
        ? `unhashable type: '${typeName(manifestVersion)}'`
        : `'<' not supported between instances of 'str' and '${typeName(manifestVersion)}'`,
    );
  }

  const versions = [manifestVersion, ...cliVersions, ...appVersions];

  if (versions.some((value) => value !== version)) {
    throw new ValueError(`Tag ${tag} does not match all product versions: ${repr(sortedUnique(versions))}`);
  }

  const changelog = readText(join(root, "CHANGELOG.md"));
  const entries = Array.from(changelog.matchAll(CHANGELOG_ENTRY));
  const matching = entries.flatMap((entry, index) => (entry[1] === version ? [index] : []));

  if (matching.length !== 1) throw new ValueError(`Expected one CHANGELOG.md entry for ${version}`);

  const index = matching[0] ?? 0;
  const entry = entries[index];
  const following = entries[index + 1];
  const start = (entry?.index ?? 0) + (entry?.[0].length ?? 0);
  const end = following?.index ?? changelog.length;
  const notes = pyStrip(changelog.slice(start, end));

  if (notes === "") throw new ValueError("Release changelog entry is empty");

  const sections = Array.from(notes.matchAll(CHANGELOG_SECTION), (match) => match[1] ?? "");
  const unknown = sortedUnique(sections.filter((name) => !CHANGELOG_SECTION_NAMES.has(name)));

  if (unknown.length > 0) {
    throw new ValueError(
      `Unknown CHANGELOG.md sections for ${version}: ${repr(unknown)}. ` +
        `Use one of: ${CHANGELOG_SECTIONS.join(", ")}`,
    );
  }

  const repeated = sortedUnique(sections.filter((name, position) => sections.indexOf(name) !== position));

  if (repeated.length > 0) {
    throw new ValueError(`Repeated CHANGELOG.md sections for ${version}: ${repr(repeated)}`);
  }

  return (
    `# MCPSafari ${tag}\n\n${notes}\n\n## Installation\n\n` +
    "```sh\nbrew trust epistates/tap\nbrew install --cask epistates/tap/mcp-safari\n```\n\n" +
    `See [setup instructions](https://github.com/Epistates/MCPSafari/blob/${tag}/docs/setup.md) ` +
    "for manual installation and client configuration.\n"
  );
}

export const SOURCE_PATHS = ["MCPServer", "MCPSafari", "extension", ".github/workflows", "scripts"] as const;

function nonBlankString(value: Json): boolean {
  return typeof value === "string" && pyStrip(value) !== "";
}

export function qualification(tag: string, root: string = ROOT): void {
  const evidence = parseJson(readText(join(root, ".github/release-qualification.json")));

  if (get(evidence, "version") !== (tag.startsWith("v") ? tag.slice(1) : tag)) {
    throw new ValueError("No Safari qualification for this release version");
  }

  const commit = get(evidence, "sourceCommit", "");

  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new ValueError("Qualification must identify the tested source commit");
  }

  for (const field of ["macOS", "safari", "testedBy", "testedAt"]) {
    if (!nonBlankString(get(evidence, field))) throw new ValueError(`Qualification is missing ${field}`);
  }

  for (const check of ["profileRouting", "profileReconnect", "permissions", "privateByDefault"]) {
    const result = get(get(evidence, "checks", {}), check, {});

    if (get(result, "status") !== "passed" || !nonBlankString(get(result, "evidence"))) {
      throw new ValueError(`Safari qualification incomplete: ${check}`);
    }
  }

  // The evidence is committed after testing. Permit documentation/evidence-only
  // commits, but reject any change to the tested implementation or packaging.
  const exists = run(["git", "cat-file", "-e", `${commit}^{commit}`], root);

  if (!succeeded(exists)) throw new CalledProcessError(exists.argv, exists.status, exists.signal);

  if (!succeeded(run(["git", "diff", "--quiet", commit, "HEAD", "--", ...SOURCE_PATHS], root))) {
    throw new ValueError("Release source differs from the Safari-qualified commit; rerun qualification");
  }
}

interface Completed {
  readonly argv: readonly string[];
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** `subprocess.run(argv, cwd=root)`: output passes straight through. */
function run(argv: readonly string[], cwd: string): Completed {
  const [command = "", ...args] = argv;
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });

  if (result.error !== undefined) throw osError(result.error, command);

  return { argv, status: result.status, signal: result.signal };
}

function succeeded(completed: Completed): boolean {
  return completed.signal === null && completed.status === 0;
}

function isNonEmptyFile(path: string): boolean {
  try {
    const stats = statSync(path);

    return stats.isFile() && stats.size !== 0;
  } catch {
    return false;
  }
}

export function prepareArtifacts(directory: string): void {
  const folder = pyPath(directory);

  // Validate the complete set before writing any checksums.
  for (const name of ARTIFACTS) {
    if (!isNonEmptyFile(join(folder, name))) throw new ValueError(`Missing or empty release artifact: ${name}`);
  }

  const lines: string[] = [];

  for (const name of ARTIFACTS) {
    const path = join(folder, name);
    let contents: Buffer;

    try {
      contents = readFileSync(path);
    } catch (cause) {
      throw osError(cause, path);
    }

    const line = `${createHash("sha256").update(contents).digest("hex")}  ${name}\n`;

    writeText(join(folder, `${name}.sha256`), line);
    lines.push(line);
  }

  writeText(join(folder, "SHA256SUMS"), lines.join(""));
}

/** The failures Python's main() reported as one line rather than a traceback. */
function isReported(cause: unknown): cause is Error {
  return (
    cause instanceof ValueError ||
    cause instanceof OsError ||
    cause instanceof KeyError ||
    cause instanceof CalledProcessError
  );
}

export function main(argv: readonly string[]): number {
  const parsed = parseArguments(
    {
      prog: basename(fileURLToPath(import.meta.url)),
      description: DESCRIPTION,
      subcommands: [
        { name: "notes", positionals: [{ name: "tag" }, { name: "output" }] },
        { name: "qualify", positionals: [{ name: "tag" }] },
        { name: "artifacts", positionals: [{ name: "directory" }] },
      ],
    },
    argv,
  );

  if (parsed.kind === "exit") return parsed.code;

  const value = (name: string) => parsed.values.get(name)?.[0] ?? "";

  try {
    if (parsed.command === "notes") {
      const notes = releaseNotes(value("tag"));

      writeText(pyPath(value("output")), notes);
    } else if (parsed.command === "qualify") {
      qualification(value("tag"));
    } else {
      prepareArtifacts(value("directory"));
    }
  } catch (cause) {
    if (!isReported(cause)) throw cause;

    process.stderr.write(`Release preparation failed: ${cause.message}\n`);

    return 1;
  }

  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
