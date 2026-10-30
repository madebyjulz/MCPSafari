// Safari returns a URL and title for every tab, granted site or not. These pin
// down what the extension says about a tab, given what it has learned about the
// site: reached (granted), refused, or never touched (unknown).

import assert from "node:assert/strict";
import { Effect, Result } from "effect";
import { afterEach, test, vi } from "vitest";

import { TabAccess } from "../src/background/TabAccess.ts";
import type { JsonValue } from "../src/shared/protocol.ts";
import { dataOf, fakeBrowser, launch, stopAll, type FakeTab } from "./helpers/fake-browser.ts";

afterEach(stopAll);

const TABS: ReadonlyArray<FakeTab & { readonly index: number; readonly pinned?: boolean }> = [
  {
    id: 1,
    windowId: 1,
    index: 0,
    active: true,
    pinned: true,
    url: "https://granted.example/inbox?token=abc123",
    title: "Inbox (3)",
  },
  { id: 2, windowId: 1, index: 1, active: false, url: "https://untouched.example/account", title: "Your account" },
  { id: 3, windowId: 2, index: 0, active: true, url: "https://refused.example/", title: "Refused site" },
  { id: 4, windowId: 2, index: 1, active: false, url: "about:blank", title: "" },
  { id: 5, windowId: 2, index: 2, active: false, title: "Restored, not loaded" },
  { id: 6, windowId: 2, index: 3, active: false, url: "file:///Users/someone/secret.txt", title: "secret.txt" },
];

type Stored = Record<string, JsonValue>;

// `stored` is the browser's local storage, which outlives the harness: hand one
// harness's to the next to simulate a restart. `slowStorage` makes the read of
// the granted origins hang until `releaseStorage()`.
function loadBackground({ stored = {}, slowStorage = false }: { stored?: Stored; slowStorage?: boolean } = {}) {
  const calls = { scripting: 0, permissionsContains: 0 };
  let releaseStorage = () => {};

  const storageGate = slowStorage
    ? new Promise<void>((resolve) => {
        releaseStorage = resolve;
      })
    : null;

  const api = {
    ...fakeBrowser(),
    permissions: {
      // Answers yes for everything, as Safari does for an origin the manifest
      // asks for: it says nothing about a grant.
      contains: async () => {
        calls.permissionsContains += 1;

        return true;
      },
    },
  };

  api.scripting.executeScript = async ({ target }) => {
    calls.scripting += 1;

    const tab = TABS.find((candidate) => candidate.id === target.tabId);

    if (tab?.url && new URL(tab.url).origin === "https://refused.example") {
      throw new Error("This extension does not have access to this tab");
    }

    return [{ result: true }];
  };
  // SAFETY: the background reads one key at a time.

  api.storage.local.get = (async (key: string) => {
    if (storageGate && key === "grantedOrigins") await storageGate;

    const value = stored[key];

    return value === undefined ? {} : { [key]: value };
  }) as typeof api.storage.local.get;
  api.storage.local.set = async (values: Readonly<Record<string, JsonValue>>) =>
    void Object.assign(stored, structuredClone(values));
  api.tabs.query = async () => TABS;
  api.tabs.get = async (id) => TABS.find((tab) => tab.id === id) ?? {};
  api.tabs.create = async ({ url }) => ({ id: 9, url, title: "Opened page" });

  const { harness, request } = launch(api);

  const tabAccess = <A>(use: (access: TabAccess["Service"]) => Effect.Effect<A>) => harness.run(TabAccess.use(use));

  return {
    calls,
    stored,
    request,
    releaseStorage: () => releaseStorage(),
    reach: (tabId: number) => tabAccess((access) => access.ensure(tabId).pipe(Effect.result)),
    remember: (origin: string) => tabAccess((access) => access.rememberOrigin(origin, true)),
    forget: (tabId: number) => tabAccess((access) => access.forget(tabId)),
    granted: () => tabAccess((access) => access.grantedOrigins),
    restore: () => tabAccess((access) => access.restoreGrantedOrigins),
    async listing() {
      const tabs: ReadonlyArray<Record<string, JsonValue>> = dataOf(await request("tabs_query"));

      return new Map(tabs.map((tab) => [tab["id"], tab]));
    },
  };
}

// SAFETY: only the background writes this key, and always as a list of origins.
const storedOrigins = (stored: Stored) => stored["grantedOrigins"] as ReadonlyArray<string> | undefined;

test("a tab on a reached site is described in full, with its secrets still redacted", async () => {
  const harness = loadBackground();

  await harness.reach(1);

  assert.deepEqual((await harness.listing()).get(1), {
    id: 1,
    url: "https://granted.example/inbox?token=[redacted]",
    title: "Inbox (3)",
    active: true,
    pinned: true,
    audible: false,
    muted: false,
    status: "complete",
    windowId: 1,
    index: 0,
    access: "granted",
  });
});

test("a tab on a site nothing has reached keeps its entry but loses its URL and title", async () => {
  const harness = loadBackground();

  await harness.reach(1);

  const tab = (await harness.listing()).get(2)!;

  // The handle, window, position and state stay, so the tab is still usable.
  assert.equal(tab["id"], 2);
  assert.equal(tab["windowId"], 1);
  assert.equal(tab["index"], 1);
  assert.equal(tab["active"], false);
  assert.equal(tab["status"], "complete");
  assert.equal("url" in tab, false);
  assert.equal("title" in tab, false);
  assert.equal(tab["access"], "not_granted");
  assert.match(typeof tab["accessHint"] === "string" ? tab["accessHint"] : "", /MCPSafari button in Safari's toolbar/);
  assert.doesNotMatch(JSON.stringify(tab), /untouched\.example|Your account/);
});

test("a site that refused access is not described either, and a refusal revokes what was learned", async () => {
  const harness = loadBackground();
  const refusal = await harness.reach(3);

  assert.ok(Result.isFailure(refusal));
  assert.equal(refusal.failure.code, "permission_required");

  const tab = (await harness.listing()).get(3)!;

  assert.equal(tab["access"], "not_granted");
  assert.equal("url" in tab || "title" in tab, false);

  // Reached once, then no longer: the earlier answer must not outlive it.
  const revoked = loadBackground();

  await revoked.remember("https://refused.example");
  assert.equal((await revoked.listing()).get(3)?.["access"], "granted");
  await revoked.forget(3);
  assert.ok(Result.isFailure(await revoked.reach(3)));
  assert.equal((await revoked.listing()).get(3)?.["access"], "not_granted");
});

test("tabs with no origin to grant are not mistaken for granted ones", async () => {
  const tabs = await loadBackground().listing();

  // A blank page has nothing to protect and nothing to grant.
  assert.equal(tabs.get(4)?.["url"], "about:blank");
  assert.equal(tabs.get(4)?.["access"], "granted");
  // A file URL names the user's filesystem, and an unloaded tab has no URL.
  assert.equal(tabs.get(5)?.["access"], "not_granted");
  assert.equal(tabs.get(6)?.["access"], "not_granted");
  assert.equal("url" in tabs.get(6)!, false);
});

test("listing tabs never probes a site, so it cannot raise a dialog", async () => {
  const harness = loadBackground();

  await harness.listing();

  assert.equal(harness.calls.scripting, 0);
});

test("permissions.contains is not taken as a grant", async () => {
  const harness = loadBackground();

  const tabs = await harness.listing();

  // It answers true for every site here, as it does on Safari for an origin the
  // manifest merely requests. Believing it would withhold nothing.
  assert.equal(tabs.get(2)?.["access"], "not_granted");
  assert.equal(harness.calls.permissionsContains, 0);
});

test("what was learned survives a restart", async () => {
  const first = loadBackground();

  await first.reach(1);
  assert.deepEqual(storedOrigins(first.stored), ["https://granted.example"]);

  // A new background page over the same local storage, which is what a Safari
  // restart is. Nothing has touched the site in this run.
  const restarted = loadBackground({ stored: first.stored });

  assert.equal((await restarted.listing()).get(1)?.["access"], "not_granted", "before startup has loaded it");
  await restarted.restore();

  const tabs = await restarted.listing();

  assert.equal(tabs.get(1)?.["access"], "granted");
  assert.equal(tabs.get(1)?.["title"], "Inbox (3)");
  assert.equal(restarted.calls.scripting, 0, "and nothing was probed to find out");
});

test("a refusal removes the origin from storage as well as from memory", async () => {
  const first = loadBackground();

  await first.remember("https://refused.example");
  await first.remember("https://granted.example");
  await first.reach(1);
  await first.reach(3);

  assert.deepEqual(storedOrigins(first.stored), ["https://granted.example"]);

  const restarted = loadBackground({ stored: first.stored });

  await restarted.restore();
  assert.equal((await restarted.listing()).get(3)?.["access"], "not_granted");
});

test("the remembered set is capped and evicts the origin confirmed longest ago", async () => {
  const harness = loadBackground();
  const cap = 500;

  for (let i = 0; i < cap; i += 1) await harness.remember(`https://site${i}.example`);
  assert.equal((await harness.granted()).length, cap);

  // Confirming site0 again makes it the most recent, so site1 is now the oldest.
  await harness.remember("https://site0.example");
  await harness.remember("https://one-more.example");

  const granted = await harness.granted();

  assert.equal(granted.length, cap);
  assert.equal(granted.includes("https://site1.example"), false);
  assert.equal(granted.includes("https://site0.example"), true);
  assert.equal(granted.includes("https://one-more.example"), true);
  assert.equal(storedOrigins(harness.stored)?.length, cap);
  assert.equal(storedOrigins(harness.stored)?.includes("https://site1.example"), false);
});

test("a stored set larger than the cap is trimmed on load, keeping the most recent", async () => {
  const stored = { grantedOrigins: Array.from({ length: 700 }, (_, i) => `https://site${i}.example`) };
  const harness = loadBackground({ stored });

  await harness.restore();

  const granted = await harness.granted();

  assert.equal(granted.length, 500);
  assert.equal(granted.includes("https://site699.example"), true);
  assert.equal(granted.includes("https://site199.example"), false);
});

test("slow storage does not hold startup: tabs read as not granted until it lands, then nothing is lost", async () => {
  const first = loadBackground();

  await first.reach(1);

  const harness = loadBackground({ stored: first.stored, slowStorage: true });

  // Past the deadline, startup carries on with nothing loaded.
  await harness.restore();
  assert.equal((await harness.listing()).get(1)?.["access"], "not_granted");

  // Learned while the read is outstanding, and not written over what is stored.
  await harness.reach(3);
  await harness.remember("https://learned.example");
  assert.deepEqual(storedOrigins(harness.stored), ["https://granted.example"]);

  harness.releaseStorage();
  await vi.waitFor(async () => assert.equal((await harness.listing()).get(1)?.["access"], "granted"));
  await vi.waitFor(() =>
    assert.deepEqual([...(storedOrigins(harness.stored) ?? [])].sort(), [
      "https://granted.example",
      "https://learned.example",
    ]),
  );
});

test("tabs_create reports the URL it was given but withholds the title of an unreached site", async () => {
  const harness = loadBackground();

  const unreached = dataOf(await harness.request("tabs_create", { url: "https://untouched.example/new" }));

  assert.equal(unreached.url, "https://untouched.example/new");
  assert.equal("title" in unreached, false);
  assert.equal(unreached.access, "not_granted");

  await harness.reach(1);

  const reached = dataOf(await harness.request("tabs_create", { url: "https://granted.example/new" }));

  assert.equal(reached.title, "Opened page");
  assert.equal(reached.access, "granted");
});

test("navigate reports a title only for a site that has been reached", async () => {
  const harness = loadBackground();

  // `reload` with no `tabs.onUpdated` traffic settles on the current tab once
  // the no-navigation wait runs out, which the test timing keeps short.
  const unreached = await harness.request("navigate", { tabId: 2, action: "reload" });

  assert.match(unreached.data ?? "", /^Reloaded https:\/\/untouched\.example\/account \(title withheld/);
  assert.doesNotMatch(unreached.data ?? "", /Your account/);

  await harness.reach(1);

  const reached = await harness.request("navigate", { tabId: 1, action: "reload" });

  assert.equal(reached.data, "Reloaded https://granted.example/inbox?token=[redacted] (Inbox (3))");
});
