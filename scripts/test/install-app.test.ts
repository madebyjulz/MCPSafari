import { expect, test } from "vitest";

import { INSTALLED_APP, containingApp, registeredCopies, strayCopies } from "../src/install-app.ts";

const INSTALLED = `${INSTALLED_APP}/Contents/PlugIns/MCPSafari Extension.appex`;

const STRAY = "/tmp/dd/Build/Products/Release/MCPSafari.app/Contents/PlugIns/MCPSafari Extension.appex";

// What `pluginkit -m -D -v` printed with a scratch Release build registered
// beside the installed app: two copies, neither marked as the one in use.
const DUPLICATES =
  `     app.eventra.MCPSafari.Extension(0.4.1)\t174B95E9\t2026-10-26 10:14:11 +0000\t${INSTALLED}\n` +
  `     app.eventra.MCPSafari.Extension(0.4.1)\tC982AF9B\t2026-10-26 10:13:58 +0000\t${STRAY}\n` +
  " (2 plug-ins)\n";

test("every registered copy is read, with the space in its name intact", () => {
  expect(registeredCopies(DUPLICATES)).toEqual([INSTALLED, STRAY]);
  expect(registeredCopies(" (0 plug-ins)\n")).toEqual([]);
});

test("only copies outside the installed app are stray", () => {
  expect(strayCopies([INSTALLED, STRAY])).toEqual([STRAY]);
  expect(strayCopies([INSTALLED])).toEqual([]);
  // A neighbour whose name starts the same is not the installed app.
  expect(strayCopies(["/Applications/MCPSafari.app.old/Contents/PlugIns/MCPSafari Extension.appex"])).toHaveLength(1);
});

test("a copy is unregistered from LaunchServices by the app it lives in", () => {
  expect(containingApp(STRAY)).toBe("/tmp/dd/Build/Products/Release/MCPSafari.app");
});
