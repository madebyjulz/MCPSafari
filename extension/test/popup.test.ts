// @vitest-environment happy-dom
import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { connectionsMarkup, siteAccessMarkup } from "../src/popup/render.ts";
import type { PopupRequest } from "../src/shared/popup.ts";
import { extensionResource } from "./helpers/sources.ts";

// ─── What the user reads ─────────────────────────────────────────────

test("the popup names the host and its state", () => {
  const allowed = siteAccessMarkup({ origin: "https://example.com", allowed: true, pending: false });

  assert.match(allowed, /example\.com/);
  assert.match(allowed, /Allowed/);
  // Nothing to do, so nothing is asked of the reader.
  assert.doesNotMatch(allowed, /site-hint/);

  const asking = siteAccessMarkup({ origin: "https://example.com", allowed: false, pending: true });

  assert.match(asking, /Asking/);
  assert.match(asking, /behind another window/);

  const blocked = siteAccessMarkup({ origin: "https://example.com", allowed: false, pending: false });

  assert.match(blocked, /No access/);
  assert.match(blocked, /Safari Settings/);
  // Granting access can disclose page contents to the connected client.
  assert.match(blocked, /shared with your MCP client/i);
});

test("a host with no origin renders nothing at all", () => {
  assert.equal(siteAccessMarkup({ origin: null, allowed: false, pending: false }), "");
  assert.equal(siteAccessMarkup(undefined), "");
});

test("a hostile host string cannot inject markup", () => {
  const markup = siteAccessMarkup({
    origin: 'https://evil"><img src=x onerror=alert(1)>',
    allowed: true,
    pending: false,
  });

  assert.doesNotMatch(markup, /<img/);
  assert.match(markup, /&lt;img/);
});

test("ports are listed in port order, with auto-scanned ones badged", () => {
  const markup = connectionsMarkup([
    { port: 8091, state: "connected", manual: true },
    { port: 8089, state: "disconnected", manual: false },
    { port: 8090, state: "connecting", manual: false },
  ]);

  const ports = [...markup.matchAll(/conn-port">(\d+)/g)].map((match) => Number(match[1]));

  assert.deepEqual(ports, [8089, 8090, 8091]);
  assert.equal(markup.match(/auto-badge/g)?.length, 2);
});

test("no ports yet reads as scanning, not as an empty list", () => {
  assert.match(connectionsMarkup([]), /Scanning for servers/);
});

// ─── The running popup ───────────────────────────────────────────────

// SAFETY: the test installs and removes its own `browser` global on the real global object.
const globals = globalThis as unknown as Record<string, unknown>;

afterEach(() => {
  delete globals["browser"];
});

test("popup version comes from the extension manifest, and ports paint straight away", async () => {
  const html = extensionResource("popup.html");

  assert.match(html, /id="version"/);
  assert.doesNotMatch(html, /v0\.2\.8/);

  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)?.[1] ?? "";

  const asked: Array<PopupRequest["type"]> = [];

  globals["browser"] = {
    runtime: {
      getManifest: () => ({ version: "9.9.9" }),
      sendMessage: async (request: PopupRequest) => {
        asked.push(request.type);

        if (request.type === "tabAccess") return { origin: "https://example.com", allowed: true, pending: false };

        return { ports: [{ port: 8090, state: "connected", manual: false }] };
      },
    },
  };

  await import("../src/popup/main.ts");
  document.dispatchEvent(new Event("DOMContentLoaded"));
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(document.getElementById("version")?.textContent, "v9.9.9");
  assert.match(document.getElementById("connections")?.innerHTML ?? "", /conn-port">8090/);
  assert.match(document.getElementById("site")?.innerHTML ?? "", /example\.com/);
  assert.ok(asked.includes("refreshConnections"));

  window.dispatchEvent(new Event("unload"));
});
