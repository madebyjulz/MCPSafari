import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ARTIFACTS, prepareArtifacts, qualification, releaseNotes } from "../src/prepare-release.ts";
import { ValueError } from "../src/python.ts";

/** `assertRaises(ValueError)` / `assertRaisesRegex(ValueError, pattern)`. */
function expectValueError(run: () => void, pattern?: RegExp): void {
  let raised: Error | undefined;

  try {
    run();
  } catch (cause) {
    if (!(cause instanceof ValueError)) throw cause;

    raised = cause;
  }

  expect(raised, "expected a ValueError").toBeInstanceOf(ValueError);

  if (pattern !== undefined) expect(raised?.message).toMatch(pattern);
}

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "prepare-release-"));
}

describe("ReleasePreparationTests", () => {
  let root: string;

  beforeEach(() => {
    root = temporaryDirectory();

    const fixtures = {
      "MCPSafari/MCPSafari Extension/Resources/manifest.json": '{"version":"0.3.2"}',
      "MCPServer/Sources/mcp-safari/Diagnostics.swift": 'static let version = "0.3.2"',
      "MCPSafari/MCPSafari.xcodeproj/project.pbxproj": "MARKETING_VERSION = 0.3.2;",
    };

    for (const [name, contents] of Object.entries(fixtures)) {
      const destination = join(root, name);

      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, contents);
    }

    writeFileSync(
      join(root, "CHANGELOG.md"),
      "## [Unreleased]\nNot shipped\n\n## [0.3.2] - 2026-09-14\n" +
        "### Fixed\nA useful explanation.\n\n## [0.3.1]\nOld notes\n",
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("notes use only the matching entry", () => {
    const notes = releaseNotes("v0.3.2", root);

    expect(notes).toContain("A useful explanation.");
    expect(notes).toContain("brew trust");
    expect(notes).not.toContain("Old notes");
    expect(notes).not.toContain("Not shipped");
  });

  test("tag and product versions must match", () => {
    for (const tag of ["v0.4.0", "v0.3.2-rc1", "v0.3.2\n", "$(command)"]) {
      expectValueError(() => releaseNotes(tag, root));
    }
  });

  test("missing, empty or duplicate notes fail", () => {
    for (const changelog of ["## [Unreleased]\nChanges", "## [0.3.2]\n", "## [0.3.2]\nA\n## [0.3.2]\nB"]) {
      writeFileSync(join(root, "CHANGELOG.md"), changelog);
      expectValueError(() => releaseNotes("v0.3.2", root));
    }
  });

  test("unknown or repeated sections fail", () => {
    const entry = (sections: string) =>
      `## [Unreleased]\n\n## [0.3.2] - 2026-09-14\n${sections}\n\n## [0.3.1]\nOld notes\n`;

    for (const [sections, expected] of [
      ["### Bug Fixes\nA.", /Unknown/],
      ["### Fixed\nA.\n\n### Fixed\nB.", /Repeated/],
      ["### Changed\nA.\n\n### Added\nB.\n\n### Changed\nC.", /Repeated/],
    ] as const) {
      writeFileSync(join(root, "CHANGELOG.md"), entry(sections));
      expectValueError(() => releaseNotes("v0.3.2", root), expected);
    }
  });

  test("every Keep a Changelog section is accepted", () => {
    const body = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"]
      .map((name) => `### ${name}\nA.`)
      .join("\n\n");

    writeFileSync(
      join(root, "CHANGELOG.md"),
      `## [Unreleased]\n\n## [0.3.2] - 2026-09-14\n${body}\n\n## [0.3.1]\nOld notes\n`,
    );
    expect(releaseNotes("v0.3.2", root)).toContain("### Security");
  });

  test("an individual component version mismatch fails", () => {
    writeFileSync(join(root, "MCPSafari/MCPSafari Extension/Resources/manifest.json"), '{"version":"0.3.1"}');
    expectValueError(() => releaseNotes("v0.3.2", root));
  });

  test("checksums are complete, relative and repeatable", () => {
    for (const name of ARTIFACTS) writeFileSync(join(root, name), "artifact");

    prepareArtifacts(root);

    const sums = readFileSync(join(root, "SHA256SUMS"), "utf8");
    const digest = createHash("sha256").update("artifact").digest("hex");

    expect(sums).toBe(ARTIFACTS.map((name) => `${digest}  ${name}\n`).join(""));
    prepareArtifacts(root);
    expect(readFileSync(join(root, "SHA256SUMS"), "utf8")).toBe(sums);

    for (const name of ARTIFACTS) {
      expect(readFileSync(join(root, `${name}.sha256`), "utf8")).toBe(`${digest}  ${name}\n`);
    }
  });

  test("a missing or empty artifact prevents checksums", () => {
    const last = ARTIFACTS[ARTIFACTS.length - 1] ?? "";

    for (const name of ARTIFACTS.slice(0, -1)) writeFileSync(join(root, name), "artifact");

    for (const empty of [false, true]) {
      if (empty) writeFileSync(join(root, last), "");

      expectValueError(() => prepareArtifacts(root));
      expect(existsSync(join(root, "SHA256SUMS"))).toBe(false);
    }
  });
});

describe("QualificationTests", () => {
  test("evidence and source changes are enforced", () => {
    const root = temporaryDirectory();

    try {
      const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

      git("init", "-q");
      git("config", "user.email", "test@example.invalid");
      git("config", "user.name", "Qualification Test");
      mkdirSync(join(root, "MCPServer"));
      writeFileSync(join(root, "MCPServer/source.swift"), "original");
      git("add", ".");
      git("commit", "-qm", "candidate");

      const permissions = { status: "passed", evidence: "test evidence" };

      const evidence = {
        version: "0.4.0",
        sourceCommit: git("rev-parse", "HEAD"),
        macOS: "test-os",
        safari: "test-browser",
        testedBy: "test",
        testedAt: "2026-09-23",
        checks: {
          profileRouting: { status: "passed", evidence: "test evidence" },
          profileReconnect: { status: "passed", evidence: "test evidence" },
          permissions,
          privateByDefault: { status: "passed", evidence: "test evidence" },
        },
      };

      mkdirSync(join(root, ".github"));

      const path = join(root, ".github/release-qualification.json");

      writeFileSync(path, JSON.stringify(evidence));
      git("add", ".");
      git("commit", "-qm", "evidence");
      qualification("v0.4.0", root);
      expectValueError(() => qualification("v0.4.1", root));
      permissions.status = "pending";
      writeFileSync(path, JSON.stringify(evidence));
      expectValueError(() => qualification("v0.4.0", root), /permissions/);
      permissions.status = "passed";
      writeFileSync(path, JSON.stringify(evidence));
      writeFileSync(join(root, "MCPServer/source.swift"), "changed");
      git("add", ".");
      git("commit", "-qm", "changed source");
      expectValueError(() => qualification("v0.4.0", root), /differs/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
