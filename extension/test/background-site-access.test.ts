// What the popup is told about the site the user is looking at. How the popup
// renders it is tested in popup.test.ts.

import assert from "node:assert/strict";
import { afterEach, test } from "vitest";

import { probeTabAccess } from "../src/background/injected.ts";
import type { SiteAccess } from "../src/shared/popup.ts";
import { parked } from "./helpers/background.ts";
import { askPopup, fakeBrowser, launch, stopAll, type InjectionResult } from "./helpers/fake-browser.ts";

afterEach(stopAll);

function loadBackground(probe: () => Promise<ReadonlyArray<InjectionResult>>) {
  const api = fakeBrowser();

  api.scripting.executeScript = async (options) => (options.func === probeTabAccess ? probe() : [{ result: true }]);
  api.tabs.get = async (id) => ({ id, active: true, windowId: 1, url: "https://example.com/a/page?q=1", title: "T" });

  launch(api);

  return {
    api,
    /** Asks as the popup does when it opens. */
    async describeActiveTabAccess() {
      const { staysOpen, reply } = askPopup(api.runtime.onMessage, { type: "tabAccess" });

      assert.equal(staysOpen, true, "the answer comes after a probe, so the channel is held open");

      // SAFETY: a tabAccess request is answered with a SiteAccess.
      return (await reply) as SiteAccess;
    },
  };
}

const granted = async (): Promise<ReadonlyArray<InjectionResult>> => [{ result: true }];

test("a reachable site reports the origin, without the path", async () => {
  const access = await loadBackground(granted).describeActiveTabAccess();

  assert.equal(access.origin, "https://example.com");
  assert.equal(access.allowed, true);
  assert.equal(access.pending, false);
});

test("a site awaiting Safari's dialog is reported as asking, not as refused", async () => {
  // The probe never settles; the harness's short probe deadline is what ends it.
  const access = await loadBackground(parked).describeActiveTabAccess();

  // The distinction is the whole point: "asking" resolves by itself once
  // someone finds the dialog, "refused" does not.
  assert.equal(access.allowed, false);
  assert.equal(access.pending, true);
  assert.equal(access.origin, "https://example.com");
});

test("a refused site is not reported as still asking", async () => {
  const access = await loadBackground(async () => {
    throw new Error("no access");
  }).describeActiveTabAccess();

  assert.equal(access.allowed, false);
  assert.equal(access.pending, false);
});

test("no active tab is survivable rather than an exception", async () => {
  const harness = loadBackground(granted);

  harness.api.tabs.query = async () => [];

  const access = await harness.describeActiveTabAccess();

  assert.equal(access.origin, null);
  assert.equal(access.allowed, false);
});
