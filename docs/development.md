# Development

[Back to README](../README.md) · [Setup](setup.md)

## Build and test

Source builds require macOS 14+, Safari 17+, Swift 6.3+, Xcode 26.6 (the version selected by CI), Node 24+, and pnpm.

Clone the repository, then build from its root. The parentheses keep each command group in its own directory.

```sh
git clone https://github.com/Epistates/MCPSafari.git
cd MCPSafari

(cd MCPServer && swift build && swift test)
pnpm install && pnpm check

(cd MCPSafari && xcodebuild -project MCPSafari.xcodeproj \
  -scheme MCPSafari -configuration Debug build \
  CODE_SIGN_IDENTITY="-" CODE_SIGNING_REQUIRED=NO)
```

The extension build above matches CI and checks compilation. Xcode builds the extension's TypeScript itself, through a "Bundle extension scripts" build phase in both targets, so pnpm must be installed where Xcode can find it (Homebrew's or pnpm's standard locations). To install a development build, open `MCPSafari/MCPSafari.xcodeproj` in Xcode, configure signing for your team, and build and run the app. Enable its extension in Safari settings.

Point your MCP client at `MCPServer/.build/debug/MCPSafari` using an absolute path. Add `--verbose` to its arguments for debug logs. For a release server binary:

```sh
(cd MCPServer && swift build -c release)
```

The binary is `MCPServer/.build/release/MCPSafari`.

## CI

[ci.yml](../.github/workflows/ci.yml) builds and tests the Swift server, checks the extension's TypeScript (`pnpm check`), checks the MCP handshake, and builds the Safari extension. Its path filters skip Markdown-only changes. Security scans have [separate workflows](../.github/workflows).

## Architecture

### MCP server (`MCPServer/`)

A Swift executable using the official [modelcontextprotocol/swift-sdk](https://github.com/modelcontextprotocol/swift-sdk). Communicates with MCP clients via **stdio** and with the Safari extension via a **WebSocket** bridge using `Network.framework`.

- `main.swift` — Entry point, parses CLI flags, starts the server
- `SafariMCPServer.swift` — The actor itself: tool dispatch, profile routing, and the tool handlers
- `WebSocketBridge.swift` — WebSocket server with request/response correlation (actor). Most of this actor is one state machine running from listener to connection to handshake to authenticated send, and it stays in one file for that reason: the steps share mutable bookkeeping and are far easier to follow together. What sits beside it is the part that holds no state: `BridgeHandshake.swift` (what the extension sends on connecting, and how a frame is judged a valid handshake), `BridgeStatus.swift` (the `Codable` shapes `status` and `doctor` report), and `BridgeError.swift` (every failure and the message it gives the MCP client)
- `BridgeMessage.swift` — Wire protocol types and `AnyCodable` serialization
- `Diagnostics.swift` — CLI flag parsing and the `doctor` checks
- `TabHandle.swift` / `FileAttachment.swift` — Profile-qualified tab handles, and loading local files for upload
- `ClientCapabilityTransport.swift` — Repairs the one `initialize` shape swift-sdk 0.12.1 cannot decode

Four `extension SafariMCPServer` files carry the parts that need no actor state, so the actor file stays about dispatch and handlers:

- `ToolCatalog.swift` — Every advertised `inputSchema` and the fragments they are built from
- `NativeInput.swift` — Real keyboard and mouse events for the `native: true` paths (Carbon, `CGEvent`)
- `ScreenshotCapture.swift` — Writing, clipping, scaling and describing a capture
- `ResultFormatting.swift` — Turning a bridge response or an error into a `CallTool.Result`
- `RunStepsPlan.swift` — Validates a whole `run_steps` batch before any of it runs

In those files, an `internal` member is one the handlers call; everything else is `private`. Swift scopes `private` to the file, so the access level marks the seam between a subsystem and the rest of the server.

### Safari extension (`extension/` and `MCPSafari/`)

A Manifest V3 Safari Web Extension. Its scripts are TypeScript in `extension/src/`, bundled by [tsdown](https://tsdown.dev) into one classic IIFE script per file Safari loads. The bundles are generated, not checked in: they land in `extension/dist/`, and the "Bundle extension scripts" build phase copies them into the app and extension bundles. Everything else Safari loads — `manifest.json`, `popup.html`, `popup.css`, icons, locales — stays in `MCPSafari/MCPSafari Extension/Resources/`.

The repository root is a pnpm workspace holding `extension/` and `scripts/`. They share one toolchain configured at the root: oxfmt, oxlint (with the `@effect/tsgo` preset and the vendored anti-slop rules in `tools/oxlint/`), TypeScript 7 (`tsconfig.base.json`), and Vitest. `pnpm check` at the root runs all of it.

The extension's code runs in three places, and what each may depend on differs:

- **The background page** (`src/background/`) is written with [Effect](https://effect.website) 4. Each concern is a service with a layer, composed in `background.ts` and run by one `ManagedRuntime` from `main.ts`:
  - `Browser.ts` — the WebExtension API as a service, so tests hand in a fake
  - `config.ts` — ports, and every timeout and delay as one `BackgroundTiming` reference tests can shrink
  - `errors.ts` — `ToolError`, the one failure type, and the bridge response it becomes
  - `TabAccess.ts` — probing whether a tab can be reached, and the deadlines that turn Safari's website-access dialog into a named `permission_required`
  - `SelectedTab.ts` — the tab `select_tab` pinned, and which tab a call with no `tabId` acts on
  - `ContentScripts.ts` — sending to a frame's content script, re-injecting it, and routing across a page's frames
  - `tools/` — the handlers the background serves itself: tabs, navigation, screenshots, page JavaScript, window size
  - `injected.ts` — functions serialised into pages with `scripting.executeScript`, which must close over nothing
  - `actions.ts` / `Router.ts` — which actions exist, and one bridge request in, one response out
  - `Connections.ts` — the WebSocket clients: tokens, handshake, reconnecting, the keepalive
  - `Popup.ts` — answering the popup
- **The popup** (`src/popup/`) also uses Effect, and shares its message schemas with the background through `src/shared/popup.ts`.
- **Page-injected code** carries no dependencies at all, Effect included: it is parsed into every page and frame Safari opens. The build fails if a dependency is bundled into it.
  - `src/content/` — the content script, one bundle injected into every frame's isolated world: `core.ts` (element uids, tool errors, the bridge to the page world), `snapshot.ts`, `target.ts`, `input.ts`, `gesture.ts`, `io.ts`, and `main.ts`, which routes each action and guards against a second injection
  - `src/page/` — five scripts in the page's own world, injected before page scripts run: the trace, dialog, console and network interceptors, and `file-drop.ts`
- `src/shared/protocol.ts` — the contracts all of them share: script file names, content actions, error codes, the page-world channel. Constants and types only, so page code can import it.

### macOS host app

A minimal macOS app (`AppDelegate.swift`, `ViewController.swift`) that registers the Safari extension and provides native messaging for auth token exchange.

### Repository scripts (`scripts/`)

The release, audit, and MCP contract tooling CI runs, in TypeScript that Node 24 runs directly (`node scripts/src/<name>.ts`): no build step and no runtime dependencies, so only erasable syntax and `.ts` import paths.

- `prepare-release.ts` — `qualify <tag>`, `notes <tag> <output>`, `artifacts <directory>`: the release gates and checksums
- `audit-swiftpm-osv.ts` — checks `Package.resolved` pins against OSV.dev
- `smoke-mcp.ts` — the stdio handshake against a built server binary
- `test/mcp-results.test.ts` — every tool's result contract against the real server and a fixture extension; `pnpm test:mcp`, after `swift build`

It uses the same pnpm, oxfmt, oxlint, TypeScript and Vitest setup as `extension/`; `pnpm check` runs everything but the MCP contract test.

## Release qualification

A green build proves compilation and automated behavior; it does not prove Safari's
permission dialogs or profile routing. Before tagging a release, record the exact
macOS and Safari versions, date, build commit, and result of each manual pass:

- Two real Safari profiles, each with the extension enabled; verify independent
  routing, selection, disconnect, and reconnect.
- A fresh, ungranted origin, a denied origin, and an allowed origin; verify the
  popup and tool errors, including a permission dialog behind another window.
- Any permission-manifest changes using a development build before changing the
  shipped defaults. Confirm what Safari returns for ungranted tabs and whether a
  popup permission request actually prompts.
- Native input with consent, focus loss, Accessibility refusal, and screenshot
  behavior while Safari is in the background.
- Both packaged architectures, matching app/server versions, clean installation,
  upgrade, signature verification, notarization, and Gatekeeper assessment.

Use a statement such as `Verified on macOS <exact version> / Safari <exact version>
— <date>, <commit>, <passes performed>` only for completed checks. An installed
Safari version or a simulated profile test is not evidence of a real Safari pass.

Tagged releases require matching versions in the CLI, extension manifest, Xcode
project, and a nonempty versioned changelog entry. The release workflow publishes
that entry, checks the complete artifact set, verifies signatures, notarizes the
app and standalone CLI binaries, and creates relative-path checksums. Manual
workflow dispatch builds artifacts for inspection and does not publish a release.
Actual Developer ID signing and Apple service acceptance must still be verified
in the release environment; local script tests cannot establish either.

For full distribution qualification before a tag, dispatch the Release workflow
with `validate_distribution: true` and the version recorded in the source and
changelog. This requires valid Developer ID credentials, notarizes the app and all
CLI binaries (including the universal binary), and uploads `validated-distribution`
artifacts. The publication step only runs on a tag push. The default manual run
remains a build-only dry run that permits missing signing credentials.

### Recording release qualification

Tagged publishing requires `.github/release-qualification.json` to name the release
version, tested source commit, exact macOS/Safari versions, tester, date, and passing
evidence for profile routing, reconnect isolation, permissions, and private-by-default
behavior. Pending entries deliberately prevent publishing. Never substitute mock
extension tests or a distribution dry run for browser evidence.

Commit evidence after testing the candidate. The release gate compares implementation,
tests, and workflow paths against `sourceCommit`; changes in these paths require a
new qualification. Documentation-only evidence commits are allowed. Check locally:

```sh
node scripts/src/prepare-release.ts qualify v0.4.0
```

Manual distribution validation remains available while browser qualification is
pending and cannot publish. This is workflow enforcement, not repository access
control: administrators able to change workflows can change this gate.
