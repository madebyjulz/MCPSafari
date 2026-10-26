// Builds the server and installs MCPSafari.app in /Applications as the only
// copy of the Safari extension the system knows about.
//
// Every app Xcode builds is registered with LaunchServices on the spot, and
// `xcodebuild install` registers its staging copy too. Safari lists every
// registered copy of the extension in its settings and runs each one that is
// enabled, so a build anywhere but /Applications puts a second extension on
// the server's port under the same bundle identifier. That is why the build is in
// a throwaway directory that is unregistered and deleted once the app is
// copied out, any other copy is unregistered too, and the install fails if
// more than the one in /Applications is left. (Installing straight into
// /Applications with DSTROOT=/ is not an option: Xcode's build system rejects
// it as a dependency cycle on "/".)
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");

export const INSTALLED_APP = "/Applications/MCPSafari.app";

const APP_ID = "app.eventra.MCPSafari";

const EXTENSION_ID = "app.eventra.MCPSafari.Extension";

const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

/**
 * Every path in `pluginkit -m -D -v` output. The path is the tail of the line
 * and contains a space ("MCPSafari Extension.appex"), so it is taken from the
 * first path separator rather than by splitting on whitespace.
 */
export function registeredCopies(output: string): string[] {
  return output.split("\n").flatMap((line) => {
    const start = line.indexOf("/");

    return line.includes(EXTENSION_ID) && start !== -1 ? [line.slice(start).trim()] : [];
  });
}

/** Copies other than the one inside the installed app. */
export function strayCopies(copies: readonly string[]): string[] {
  return copies.filter((path) => !path.startsWith(`${INSTALLED_APP}/`));
}

/** The app bundle a registered extension lives in, which LaunchServices knows it by. */
export function containingApp(extensionPath: string): string {
  const end = extensionPath.indexOf(".app/Contents/PlugIns/");

  return end === -1 ? extensionPath : extensionPath.slice(0, end + ".app".length);
}

function listCopies(): string[] {
  return registeredCopies(
    execFileSync("/usr/bin/pluginkit", ["-m", "-D", "-v", "-i", EXTENSION_ID], { encoding: "utf8" }),
  );
}

function build(command: string, args: readonly string[]): void {
  execFileSync(command, args, { cwd: ROOT, stdio: "inherit" });
}

function unregister(appPath: string): void {
  execFileSync("/usr/bin/pluginkit", ["-r", join(appPath, "Contents/PlugIns/MCPSafari Extension.appex")]);
  execFileSync(LSREGISTER, ["-u", appPath]);
}

export function main(): number {
  // So the bundle is not replaced under a running app. Asked only if it is
  // running: telling an app that is not running to quit launches it first.
  execFileSync("/usr/bin/osascript", [
    "-e",
    `if application id "${APP_ID}" is running then tell application id "${APP_ID}" to quit`,
  ]);

  build("swift", ["build", "-c", "release", "--package-path", "MCPServer"]);

  const derivedData = mkdtempSync(join(tmpdir(), "mcpsafari-install-"));

  const builtApp = join(derivedData, "Build/Products/Release/MCPSafari.app");

  try {
    build("xcodebuild", [
      "-project",
      "MCPSafari/MCPSafari.xcodeproj",
      "-scheme",
      "MCPSafari",
      "-configuration",
      "Release",
      "-derivedDataPath",
      derivedData,
      "-allowProvisioningUpdates",
      "build",
    ]);
    rmSync(INSTALLED_APP, { recursive: true, force: true });
    execFileSync("/usr/bin/ditto", [builtApp, INSTALLED_APP]);
  } finally {
    // Xcode registered the build the moment it finished; left on disk, it
    // would be a second extension in Safari's settings from then on.
    try {
      unregister(builtApp);
    } catch {
      // Nothing was built, so nothing was registered.
    }

    rmSync(derivedData, { recursive: true, force: true });
  }

  // Copies left by earlier builds, Xcode's own Run included. Unregistered, not
  // deleted: they may be someone's DerivedData, and the next build there
  // registers it again anyway.
  for (const path of strayCopies(listCopies())) {
    unregister(containingApp(path));
    process.stderr.write(`Unregistered a second copy of the extension at ${path}\n`);
  }

  execFileSync(LSREGISTER, ["-f", INSTALLED_APP]);
  execFileSync("/usr/bin/pluginkit", ["-a", join(INSTALLED_APP, "Contents/PlugIns/MCPSafari Extension.appex")]);
  execFileSync("/usr/bin/open", [INSTALLED_APP]);

  const copies = listCopies();

  if (copies.length !== 1 || strayCopies(copies).length > 0) {
    process.stderr.write(
      `Safari has ${copies.length} copies of the extension registered, not one inside ${INSTALLED_APP}:\n` +
        copies.map((path) => `  ${path}\n`).join(""),
    );

    return 1;
  }

  process.stdout.write(
    `Installed ${INSTALLED_APP}, the only registered copy of the extension. ` +
      "Reconnect MCP clients so they start the new server.\n",
  );

  return 0;
}

if (import.meta.main) process.exitCode = main();
