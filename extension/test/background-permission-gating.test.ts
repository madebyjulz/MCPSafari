import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

import { probeTabAccess } from "../src/background/injected.ts";
import { SelectedTab } from "../src/background/SelectedTab.ts";
import { parked } from "./helpers/background.ts";
import { fakeBrowser, launch, settle, stopAll, type InjectionResult } from "./helpers/fake-browser.ts";

afterEach(stopAll);

// Safari asks for website access with a modal dialog and blocks every extension
// API for the tab until it is answered, and that dialog can open behind another
// window. These drive the blocked case directly, because the difference between
// a 2-second named refusal and a 30-second `bridge_timeout` is the whole point.
//
// A call parked on the dialog is a promise that never settles. The harness
// shrinks every deadline to tens of milliseconds, so the refusal arrives in
// real time without anything having to fire it.
interface Scenario {
  readonly probe?: () => Promise<ReadonlyArray<InjectionResult>>;
  readonly captureVisibleTab?: () => Promise<string>;
  readonly pageContext?: () => Promise<ReadonlyArray<InjectionResult>>;
  /** The tab's URL; `null` for a tab whose URL Safari does not report. */
  readonly tabUrl?: string | null;
  // Safari parks `tabs.get` and `tabs.query` on the same dialog as everything
  // else. Modelling that is what the first version of these tests missed, and
  // it hid three separate failures that only real Safari showed.
  readonly tabsBlocked?: boolean;
  readonly blockTabsAfterProbe?: boolean;
}

function loadBackground({
  probe = async () => [{ result: true }],
  captureVisibleTab = async () => "data:image/png;base64,AAAB",
  pageContext = async () => [{ result: { visible: true, hasFocus: true } }],
  tabUrl: reportedUrl = "https://blocked.example/some/page?q=1",
  tabsBlocked = false,
  blockTabsAfterProbe = false,
}: Scenario = {}) {
  const tabUrl = reportedUrl ?? undefined;
  let probeStarted = false;
  const api = fakeBrowser();

  api.scripting.executeScript = async (options) => {
    if (options.func === probeTabAccess) {
      probeStarted = true;

      return probe();
    }

    return pageContext();
  };

  api.tabs.query = async () => (tabsBlocked ? parked() : [{ id: 1, active: true, windowId: 1 }]);
  api.tabs.get = async (id) =>
    tabsBlocked || (blockTabsAfterProbe && probeStarted)
      ? parked()
      : { id, active: true, windowId: 1, url: tabUrl, title: "T" };
  api.tabs.captureVisibleTab = captureVisibleTab;
  api.webNavigation.getAllFrames = async () => [{ frameId: 0, parentFrameId: -1, url: tabUrl }];

  const { harness, request } = launch(api);

  return {
    api,
    harness,
    request,
    /** A content read on tab 1, which is gated on the probe before it reaches the page. */
    readPage: () => request("read_page", { tabId: 1 }),
    /** Drives `tabs.onUpdated`, which clears a tab's cached grant when it navigates. */
    async navigateTab(tabId: number, url: string) {
      api.tabs.onUpdated.fire(tabId, { url }, { id: tabId, url });
      await settle();
    },
  };
}

const refused = async () => {
  throw new Error("This extension does not have access to this tab");
};

test("a probe parked on the permission dialog becomes a named refusal", async () => {
  const harness = loadBackground({ probe: parked });

  const response = await harness.readPage();

  assert.equal(response.errorCode, "permission_required");
  assert.equal(response.recoveryAction, "ask_user");
  // Retryable on purpose: granting access makes the identical call work.
  assert.equal(response.retryable, true);
  // The message has to carry the origin and the fact that the dialog hides,
  // because that is the part nobody works out on their own.
  assert.match(response.error ?? "", /https:\/\/blocked\.example/);
  assert.match(response.error ?? "", /behind another window/);
  assert.match(response.error ?? "", /Always Allow on This Website/);
  // The origin belongs in the message, not just the page path, so the user is
  // told which site they are being asked about.
  assert.doesNotMatch(response.error ?? "", /some\/page/);
});

test("a probe refused outright says access is missing, not that a dialog is open", async () => {
  const harness = loadBackground({ probe: refused });

  const response = await harness.readPage();

  assert.equal(response.errorCode, "permission_required");
  assert.match(response.error ?? "", /is not allowed on/);
  // No dialog is open in this case, so pointing at one would send the user
  // hunting for a window that is not there.
  assert.doesNotMatch(response.error ?? "", /behind another window/);
  // The one click that stops being asked per site belongs in the refusal that
  // sends someone to settings anyway.
  assert.match(response.error ?? "", /Always Allow on Every Website/);
});

test("a granted tab is not probed again for every frame in one request", async () => {
  let probes = 0;

  const harness = loadBackground({
    probe: async () => {
      probes += 1;

      return [{ result: true }];
    },
  });

  await harness.readPage();
  await harness.readPage();
  await harness.readPage();

  assert.equal(probes, 1, "the probe should be cached for the life of a request");
});

test("a capture parked on the dialog fails fast instead of riding the bridge timeout", async () => {
  const harness = loadBackground({ captureVisibleTab: parked });

  const response = await harness.request("screenshot", { tabId: 1 });

  assert.equal(response.errorCode, "permission_required");
  assert.match(response.error ?? "", /behind another window/);
});

test("a screenshot still works when the page context read fails", async () => {
  // Access is fine, the context read is not. That read is allowed to fail and
  // still produce a picture, so the probe must not be what decides it.
  const harness = loadBackground({
    pageContext: async () => {
      throw new Error("cannot read page context");
    },
  });

  const response = await harness.request("screenshot", { tabId: 1 });

  assert.equal(response.success, true, response.error ?? "");
  assert.equal(JSON.parse(response.data ?? "null").image, "AAAB");
});

test("a screenshot on a blocked tab refuses before it waits on tabs.get", async () => {
  // Real Safari blocks `tabs.get` on the same dialog as the capture, so
  // deadlining only the capture left this call absorbing the whole wait and
  // reporting a bridge timeout. Every tab API is parked here to model that.
  const harness = loadBackground({ probe: parked, tabsBlocked: true });

  const response = await harness.request("screenshot", { tabId: 1 });

  assert.equal(response.errorCode, "permission_required");
});

test("the refusal names the origin even though tabs.get is blocked too", async () => {
  // The probe raises the dialog, and from that moment `tabs.get` blocks on it
  // as well. Reading the origin afterwards returns nothing, which left the
  // message unable to say which site it was about.
  const harness = loadBackground({ probe: parked, blockTabsAfterProbe: true });

  const response = await harness.readPage();

  assert.equal(response.errorCode, "permission_required");
  assert.match(response.error ?? "", /https:\/\/blocked\.example/);
});

test("tab listing parked on the dialog reports why instead of timing out", async () => {
  const harness = loadBackground();

  harness.api.tabs.query = parked;

  const response = await harness.request("tabs_query");

  assert.equal(response.errorCode, "permission_required");
  assert.equal(response.recoveryAction, "ask_user");
  // No single tab owns this block, so no origin is claimed.
  assert.doesNotMatch(response.error ?? "", /https:/);
});

test("an unreadable tab url still produces a usable refusal", async () => {
  const harness = loadBackground({ probe: parked, tabUrl: null });

  const response = await harness.readPage();

  assert.equal(response.errorCode, "permission_required");
  assert.match(response.error ?? "", /this tab/);
});

// `tabs_query` above is deadlined because `tabs.query` parks on the dialog.
// Resolving the active tab makes the same two calls, and it resolves the target
// for every request that names no tab, which is most of them. One unbounded
// line there puts the whole tool surface back on the 30-second bridge timeout
// the deadlines exist to stay under.
test("resolving the active tab reports why instead of riding the bridge timeout", async () => {
  const harness = loadBackground();

  harness.api.tabs.query = parked;

  // No tabId, so the target is the active tab.
  const response = await harness.request("read_page");

  assert.equal(response.errorCode, "permission_required");
  assert.equal(response.recoveryAction, "ask_user");
  assert.match(response.error ?? "", /behind another window/);
});

test("a pinned tab parked on the dialog is not mistaken for a closed one", async () => {
  const harness = loadBackground();

  await harness.harness.run(SelectedTab.use((selected) => selected.set(7)));
  harness.api.tabs.get = parked;

  const response = await harness.request("read_page");

  assert.equal(response.errorCode, "permission_required");
  // The old catch-all treated any failure here as "the tab went away" and
  // cleared the pin, losing the caller's chosen tab over a question the user
  // simply had not answered yet.
  assert.equal(await harness.harness.run(SelectedTab.use((selected) => selected.get)), 7);
});

test("select_tab parked on the dialog names the reason", async () => {
  const harness = loadBackground({ probe: parked });

  const response = await harness.request("select_tab", { tabId: 1 });

  assert.equal(response.errorCode, "permission_required");
  assert.match(response.error ?? "", /https:\/\/blocked\.example/);
});

test("native input focus parked on the dialog names the reason", async () => {
  const harness = loadBackground({ probe: parked });

  const response = await harness.request("native_type_text", { tabId: 1, selector: "#editor" });

  assert.equal(response.errorCode, "permission_required");
  assert.match(response.error ?? "", /https:\/\/blocked\.example/);
});

test("navigating away from a blocked tab is not stopped by reading it first", async () => {
  // Leaving is the one move that gets a caller off a page they cannot use, so
  // reading the page being left is best effort rather than a precondition.
  const harness = loadBackground();
  const navigated: Array<string | undefined> = [];

  harness.api.tabs.get = parked;
  harness.api.tabs.update = async (_id, info) => {
    navigated.push(info.url);
  };

  // Deliberately not awaiting the request: with `tabs.get` parked forever the
  // load wait it arms afterwards cannot finish either. What this pins down is
  // the step before that, which used to park and spend the bridge timeout
  // without the navigation ever being attempted. Disposing of the background
  // after the test interrupts it, which is the only way it ends.
  harness.request("navigate", { tabId: 1, url: "https://ok.example/" }).catch(() => {});

  await vi.waitFor(() => assert.deepEqual(navigated, ["https://ok.example/"]));
});

test("a refused tab is not probed again for every frame in one request", async () => {
  // The counterpart to the granted case above. Only successes were cached, so
  // the blocked case, which is the one the cache exists for, probed again on
  // every call and a frame search paid one per frame.
  let probes = 0;

  const harness = loadBackground({
    probe: async () => {
      probes += 1;

      return refused();
    },
  });

  await harness.readPage();
  await harness.readPage();

  assert.equal(probes, 1);
});

test("calls that arrive while a probe is running share it", async () => {
  // `wait` asks every frame at once, and each frame's send ensures access. The
  // result was only remembered once a probe finished, so every one of them
  // started its own and each put the same question to Safari.
  let probes = 0;
  let answer: () => void = () => {};

  const answered = new Promise<void>((resolve) => {
    answer = resolve;
  });

  const harness = loadBackground({
    probe: async () => {
      probes += 1;
      await answered;

      return [{ result: true }];
    },
  });

  const pending = Promise.all([harness.readPage(), harness.readPage(), harness.readPage()]);

  // Polled tightly: the probe's deadline is 30 ms in these tests.
  await vi.waitFor(() => assert.ok(probes > 0), { interval: 1 });
  await settle();
  answer();

  for (const response of await pending) assert.equal(response.success, true, response.error ?? "");

  assert.equal(probes, 1);
});

test("a refusal reached by a shared probe reaches every caller", async () => {
  let probes = 0;

  const harness = loadBackground({
    probe: async () => {
      probes += 1;

      return refused();
    },
  });

  const responses = await Promise.all([harness.readPage(), harness.readPage()]);

  assert.deepEqual(
    responses.map((response) => response.errorCode),
    ["permission_required", "permission_required"],
  );
  assert.equal(probes, 1);
});

test("a cached refusal still names the origin and the recovery", async () => {
  const harness = loadBackground({ probe: refused });

  await harness.readPage();

  const response = await harness.readPage();

  // The second caller gets the same refusal, not a bare cache miss.
  assert.equal(response.errorCode, "permission_required");
  assert.equal(response.recoveryAction, "ask_user");
  assert.match(response.error ?? "", /https:\/\/blocked\.example/);
});

test("a tab that navigates loses its cached grant", async () => {
  let probes = 0;

  const harness = loadBackground({
    probe: async () => {
      probes += 1;

      return [{ result: true }];
    },
  });

  await harness.readPage();
  assert.equal(probes, 1);

  // Safari grants per origin, so a pass stops meaning anything once the tab
  // goes elsewhere. Keyed by tab alone, a navigate followed straight away by
  // a read reused the previous origin's grant and went back to waiting on the
  // new origin's dialog with nothing bounding it.
  await harness.navigateTab(1, "https://elsewhere.example/");
  await harness.readPage();

  assert.equal(probes, 2);
});

test("a tab that closes loses its cached grant", async () => {
  // The same cache, cleared on the other event it listens to: a long-lived
  // background page would otherwise keep one entry per tab ever touched.
  let probes = 0;

  const harness = loadBackground({
    probe: async () => {
      probes += 1;

      return [{ result: true }];
    },
  });

  await harness.readPage();
  harness.api.tabs.onRemoved.fire(1);
  await settle();
  await harness.readPage();

  assert.equal(probes, 2);
});
