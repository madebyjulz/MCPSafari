// An interaction used to answer the moment its event was dispatched. When the
// event started a page load, the next read saw the page being left, and a
// `wait` sent straight after was polling inside a document that was about to be
// replaced: nothing ever answered it, so it ended at the server's 30-second
// bridge timeout although the new page had loaded.
//
// Time here is real but shrunk: the test timing gives the watch window 40 ms
// and a page load 400 ms, so the assertions are about order and lower bounds
// rather than exact instants.

import assert from "node:assert/strict";
import { Duration } from "effect";
import { afterEach, test, vi } from "vitest";

import type { BridgeResponse } from "../src/background/errors.ts";
import type { BackgroundTiming } from "../src/background/config.ts";
import type { ContentParams, ContentRequest } from "../src/shared/protocol.ts";
import { TEST_TIMING } from "./helpers/background.ts";
import {
  fakeBrowser,
  launch,
  stopAll,
  type FakeContentReply,
  type FakeTab,
  type TabChange,
} from "./helpers/fake-browser.ts";

afterEach(stopAll);

const WINDOW_MS = Duration.toMillis(TEST_TIMING.navigationStartWindow);

const OLD_URL = "https://ok.example/results";

const NEW_URL = "https://ok.example/article/7";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Tab = { -readonly [K in keyof FakeTab]: FakeTab[K] };

interface Harness {
  readonly tabs: Map<number, Tab>;
  readonly sent: Array<{ readonly message: ContentRequest; readonly loading: boolean }>;
  /** What Safari reports to `tabs.onUpdated`: the change, then the tab. */
  emit(changeInfo: TabChange, patch?: Partial<Tab>, tabId?: number): void;
  /** Runs `fn` after `ms`, which is how a page is made to finish loading mid-request. */
  later(ms: number, fn: () => void): void;
  listenerCount(): number;
  request(action: string, params?: ContentParams): Outcome;
}

interface Outcome {
  readonly response: Promise<BridgeResponse>;
  readonly started: number;
  /** When the answer arrived, and the tab's load state at that moment. */
  answeredAt?: number;
  statusAtAnswer?: string | undefined;
  readonly done: () => boolean;
}

type OnMessage = (message: ContentRequest, harness: Harness) => FakeContentReply | Promise<FakeContentReply>;

function loadBackground({
  onMessage,
  timing,
}: { readonly onMessage?: OnMessage; readonly timing?: Partial<BackgroundTiming> } = {}): Harness {
  const tabs = new Map<number, Tab>([
    [1, { id: 1, active: true, windowId: 1, url: OLD_URL, title: "Results", status: "complete" }],
    [2, { id: 2, active: false, windowId: 1, url: "https://other.example/", title: "Other", status: "complete" }],
  ]);

  const sent: Harness["sent"] = [];
  const api = fakeBrowser();

  api.tabs.get = async (id) => {
    const tab = tabs.get(id);

    if (!tab) throw new Error(`No tab with id: ${id}`);

    return { ...tab };
  };

  api.tabs.query = async () => [...tabs.values()].map((tab) => ({ ...tab }));
  api.tabs.sendMessage = async (tabId, message) => {
    sent.push({ message, loading: tabs.get(tabId)?.status === "loading" });

    return onMessage ? onMessage(message, harness) : { data: "Clicked <a>", error: null };
  };

  api.webNavigation.getAllFrames = async () => [{ frameId: 0, parentFrameId: -1, url: OLD_URL }];

  const { request } = launch(api, timing ? { timing } : {});
  // The background registers a listener of its own at load; only the ones a
  // request adds and fails to remove are of interest.
  const loadedListeners = api.tabs.onUpdated.listeners.length;

  const harness: Harness = {
    tabs,
    sent,
    emit(changeInfo, patch = {}, tabId = 1) {
      const tab = tabs.get(tabId);

      if (!tab) return;

      Object.assign(tab, patch);
      api.tabs.onUpdated.fire(tabId, changeInfo, { ...tab });
    },
    later(ms, fn) {
      setTimeout(fn, ms);
    },
    listenerCount: () => api.tabs.onUpdated.listeners.length - loadedListeners,
    request(action, params = {}) {
      const outcome: Outcome = {
        started: Date.now(),
        done: () => outcome.answeredAt !== undefined,
        response: request(action, { tabId: 1, ...params }).then((response) => {
          outcome.answeredAt = Date.now();
          outcome.statusAtAnswer = tabs.get(1)?.status;

          return response;
        }),
      };

      return outcome;
    },
  };

  return harness;
}

// A navigation the way Safari reports it: loading first, the URL once the new
// document commits, and complete when it has loaded.
function navigateLater(
  harness: Harness,
  { commitAfter = 10, completeAfter = 60, url = NEW_URL, title = "Article" } = {},
) {
  harness.emit({ status: "loading" }, { status: "loading" });
  harness.later(commitAfter, () => harness.emit({ url }, { url }));
  harness.later(completeAfter, () => harness.emit({ status: "complete" }, { status: "complete", title }));
}

const navigating: OnMessage = async (_message, harness) => {
  navigateLater(harness);

  return { data: "done", error: null };
};

test("a click that starts a navigation answers once the new page has loaded, and says where it went", async () => {
  const harness = loadBackground({
    onMessage: async (_message, current) => {
      navigateLater(current);

      return { data: "Clicked <a>", error: null };
    },
  });

  const click = harness.request("click", { selector: "a" });
  const response = await click.response;

  assert.equal(response.success, true, response.error ?? "");
  assert.equal(click.statusAtAnswer, "complete", "answered while the page was still loading");
  assert.equal(response.data, `Clicked <a>\nPage navigated to ${NEW_URL} (Article)`);
  assert.equal(harness.listenerCount(), 0, "the load watcher must not outlive the request");
});

test("a click that navigates nowhere answers when the watch window closes, with no note", async () => {
  const harness = loadBackground();
  const click = harness.request("click", { selector: "button" });
  const response = await click.response;

  assert.ok((click.answeredAt ?? 0) - click.started >= WINDOW_MS - 5, "answered before the watch window closed");
  assert.equal(response.data, "Clicked <a>");
  assert.equal(harness.listenerCount(), 0);
});

test("a slow dispatch does not use up the watch window", async () => {
  // The content script answers after several windows' worth of time, and the
  // navigation begins just after the reply, as it does for a handler that
  // yields before assigning location.
  const harness = loadBackground({
    onMessage: async (_message, current) => {
      await delay(WINDOW_MS * 3);
      current.later(10, () => navigateLater(current));

      return { data: "Clicked <a>", error: null };
    },
  });

  const response = await harness.request("click", { selector: "a" }).response;

  assert.match(response.data ?? "", /Page navigated to https:\/\/ok\.example\/article\/7/);
});

test("a wait sent after a navigating click reaches the new document, not the one being left", async () => {
  // The page the content script is in is gone while the tab is loading, so a
  // message sent then is never answered.
  const harness = loadBackground({
    onMessage: async (message, current) => {
      if (message.action === "click") {
        navigateLater(current);

        return { data: "Clicked <a>", error: null };
      }

      return { data: "Element found: #abstract", error: null };
    },
  });

  await harness.request("click", { selector: "a" }).response;

  const wait = await harness.request("wait", { selector: "#abstract" }).response;

  assert.equal(wait.success, true, wait.error ?? "");
  assert.equal(wait.data, "Element found: #abstract");
  assert.equal(
    harness.sent.find((entry) => entry.message.action === "wait")?.loading,
    false,
    "the wait was sent into a document that was being replaced",
  );
});

test("a click that changes the URL without a load is a same-document navigation and settles on it", async () => {
  const harness = loadBackground({
    onMessage: async (_message, current) => {
      current.emit({ url: "https://ok.example/results?page=2" }, { url: "https://ok.example/results?page=2" });

      return { data: "Clicked <a>", error: null };
    },
  });

  const response = await harness.request("click", { selector: "a.next" }).response;

  assert.equal(response.data, "Clicked <a>\nPage navigated to https://ok.example/results?page=2 (Results)");
});

test("a click that opens a new tab leaves this one alone and is not held for the new one", async () => {
  const harness = loadBackground({
    onMessage: async (_message, current) => {
      // The other tab loads; this one never does.
      current.emit({ status: "loading" }, { status: "loading" }, 2);
      current.later(10_000, () => current.emit({ status: "complete" }, { status: "complete" }, 2));

      return { data: "Clicked <a target=_blank>", error: null };
    },
  });

  const click = harness.request("click", { selector: "a[target=_blank]" });
  const response = await click.response;

  assert.ok((click.answeredAt ?? 0) - click.started < 1000);
  assert.equal(response.data, "Clicked <a target=_blank>");
});

test("only interactions that can start a load pay the watch window", async () => {
  // A window far longer than the test: anything that waits for it never answers in time.
  const timing = { navigationStartWindow: Duration.seconds(30) };

  for (const [action, params] of [
    ["hover", { selector: "a" }],
    ["scroll", { direction: "down" }],
    ["type_text", { selector: "input", text: "hello" }],
  ] as const) {
    const harness = loadBackground({ onMessage: async () => ({ data: "done", error: null }), timing });
    const outcome = harness.request(action, params);

    await Promise.race([outcome.response, delay(1000)]);
    assert.equal(outcome.done(), true, `${action} waited for a navigation it cannot start`);
  }
});

for (const [action, params] of [
  ["click", { selector: "a" }],
  ["press_key", { key: "Enter" }],
  ["type_text", { selector: "input", text: "query", submitKey: "Enter" }],
  ["form_input", { selector: "input", value: "x" }],
  ["select_option", { selector: "select", value: "2" }],
] as const) {
  test(`${action} waits for the load it starts`, async () => {
    const harness = loadBackground({ onMessage: navigating });
    const outcome = harness.request(action, params);
    const response = await outcome.response;

    assert.equal(outcome.statusAtAnswer, "complete");
    assert.match(response.data ?? "", /Page navigated to /);
  });
}

test("an interaction that fails is reported at once, not after a load it did not start", async () => {
  const harness = loadBackground({
    onMessage: async () => ({
      data: null,
      error: "No element matches a.missing",
      errorCode: "target_not_found",
      retryable: false,
      recoveryAction: "take_snapshot",
    }),
    timing: { navigationStartWindow: Duration.seconds(30) },
  });

  const click = harness.request("click", { selector: "a.missing" });
  const response = await Promise.race([click.response, delay(1000).then(() => null)]);

  assert.ok(response, "the failure waited on a load");
  assert.equal(response.success, false);
  assert.equal(response.errorCode, "target_not_found");
  assert.equal(harness.listenerCount(), 0, "the watcher outlived a failed action");
});

test("a click that closes its own tab still succeeds", async () => {
  const harness = loadBackground({
    onMessage: async (_message, current) => {
      current.emit({ status: "loading" }, { status: "loading" });
      current.later(10, () => current.tabs.delete(1));

      return { data: "Clicked <a>", error: null };
    },
  });

  // The load watch ends at its own timeout, and then finds the tab gone.
  const response = await harness.request("click", { selector: "a.close" }).response;

  assert.equal(response.success, true, response.error ?? "");
  assert.equal(response.data, "Clicked <a>");
});

test("a load that never finishes is given its time and then reported as unfinished", async () => {
  const harness = loadBackground({
    onMessage: async (_message, current) => {
      current.emit({ status: "loading" }, { status: "loading" });
      current.later(10, () => current.emit({ url: NEW_URL }, { url: NEW_URL }));

      return { data: "Clicked <a>", error: null };
    },
  });

  const click = harness.request("click", { selector: "a" });
  const response = await click.response;

  assert.ok((click.answeredAt ?? 0) - click.started >= Duration.toMillis(TEST_TIMING.navigationTimeout) - 5);
  assert.equal(response.data, `Clicked <a>\nPage navigated to ${NEW_URL} (Results); it was still loading`);
});

test("the reported URL is redacted and a site that was not granted gets no title", async () => {
  const harness = loadBackground({
    onMessage: async (_message, current) => {
      navigateLater(current, { url: "https://elsewhere.example/cb?token=hunter2&page=1", title: "Private inbox" });

      return { data: "Clicked <a>", error: null };
    },
  });

  const data = (await harness.request("click", { selector: "a" }).response).data ?? "";

  assert.doesNotMatch(data, /hunter2/);
  assert.match(data, /Page navigated to https:\/\/elsewhere\.example\/cb\?/);
  assert.doesNotMatch(data, /Private inbox/);
  assert.match(data, /title withheld/);
});

test("an object result gets the new URL as a field instead of a trailing line", async () => {
  const harness = loadBackground({
    onMessage: async (_message, current) => {
      navigateLater(current, { url: "https://elsewhere.example/?session=abc123" });

      return { data: { clicked: true }, error: null };
    },
  });

  const data = JSON.parse((await harness.request("click", { selector: "a" }).response).data ?? "{}");

  assert.equal(data.clicked, true);
  assert.match(data.navigatedTo, /^https:\/\/elsewhere\.example\//);
  assert.doesNotMatch(data.navigatedTo, /abc123/);
});

// ─── wait ────────────────────────────────────────────────────────────

const waitsSent = (harness: Harness) => harness.sent.filter((entry) => entry.message.action === "wait");

// A wait whose document is replaced gets no answer, ever. This is that
// document: the first message is swallowed, the way the old page takes it down
// with it, and later ones are answered by the new one.
const swallowFirstWait = (): OnMessage => {
  let waits = 0;

  return async (message) => {
    waits += 1;

    if (waits === 1) return new Promise<never>(() => {});

    const selector = message.params["selector"];

    return { data: `Element found: ${typeof selector === "string" ? selector : ""}`, error: null };
  };
};

test("a wait pending when the page navigates is sent again to the new document", async () => {
  const harness = loadBackground({ onMessage: swallowFirstWait() });
  const wait = harness.request("wait", { selector: "#abstract", timeout: 2 });

  await delay(100);
  assert.equal(wait.done(), false);
  // The page the user script started navigating away from.
  harness.emit({ status: "loading" }, { status: "loading" });
  await delay(100);
  assert.equal(wait.done(), false, "answered before the new page had loaded");
  harness.emit({ url: NEW_URL }, { url: NEW_URL });
  harness.emit({ status: "complete" }, { status: "complete" });

  const response = await wait.response;

  assert.equal(response.success, true, response.error ?? "");
  assert.equal(response.data, "Element found: #abstract");

  const waits = waitsSent(harness);

  assert.equal(waits.length, 2);
  assert.equal(waits[1]?.loading, false, "re-sent into a document that was still loading");

  // Two seconds, less the time spent: the budget is the caller's, not a fresh one.
  const remaining = Number(waits[1]?.message.params["timeout"]);

  assert.ok(remaining < 1.85 && remaining > 1, `timeout ${remaining}`);
  assert.equal(harness.listenerCount(), 0);
});

test("a wait whose request fails because the document went away is sent again", async () => {
  let waits = 0;

  const harness = loadBackground({
    onMessage: async (_message, current) => {
      waits += 1;

      if (waits > 1) return { data: 'Text found: "Done"', error: null };

      current.emit({ status: "loading" }, { status: "loading" });
      current.later(30, () => current.emit({ status: "complete" }, { status: "complete" }));
      throw new Error("The message channel closed before a response was received");
    },
  });

  const response = await harness.request("wait", { text: "Done", timeout: 2 }).response;

  assert.equal(response.success, true, response.error ?? "");
  assert.equal(response.data, 'Text found: "Done"');
  assert.equal(waits, 2);
});

test("a wait that times out on its own page is not sent again", async () => {
  const harness = loadBackground({
    onMessage: async () => ({
      data: null,
      error: "Timeout waiting for selector: #nope",
      errorCode: "wait_timeout",
      retryable: true,
      recoveryAction: "retry",
    }),
  });

  const response = await harness.request("wait", { selector: "#nope", timeout: 1 }).response;

  assert.equal(response.success, false);
  assert.equal(response.errorCode, "wait_timeout");
  assert.equal(waitsSent(harness).length, 1);
});

test("a wait that is still pending when the navigation uses up its time fails as a retryable wait_timeout", async () => {
  const harness = loadBackground({ onMessage: async () => new Promise<never>(() => {}) });
  const wait = harness.request("wait", { selector: "#abstract", timeout: 0.3 });

  await delay(50);
  harness.emit({ status: "loading" }, { status: "loading" });

  // Well inside the bridge timeout, with a reason, instead of the generic one.
  const response = await wait.response;

  assert.equal(response.success, false);
  assert.equal(response.errorCode, "wait_timeout");
  assert.equal(response.retryable, true);
  assert.match(response.error ?? "", /navigated while waiting/);
});

test("a wait that finishes before any navigation is untouched", async () => {
  const harness = loadBackground({ onMessage: async () => ({ data: "Element found: #x", error: null }) });

  const response = await harness.request("wait", { selector: "#x" }).response;

  assert.equal(response.data, "Element found: #x");
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.listenerCount(), 0);
});

test("a timed wait that a navigation interrupts is sent again for the time that is left", async () => {
  let waits = 0;

  const harness = loadBackground({
    onMessage: async (message) => {
      waits += 1;

      if (waits === 1) return new Promise<never>(() => {});

      return { data: `Waited ${Number(message.params["seconds"])} seconds`, error: null };
    },
  });

  const wait = harness.request("wait", { seconds: 2 });

  await delay(100);
  harness.emit({ status: "loading" }, { status: "loading" });
  harness.emit({ status: "complete" }, { status: "complete" });

  const response = await wait.response;

  assert.equal(response.success, true, response.error ?? "");
  await vi.waitFor(() => assert.equal(waitsSent(harness).length, 2));

  const remaining = Number(waitsSent(harness)[1]?.message.params["seconds"]);

  assert.ok(remaining < 1.95 && remaining > 1, `seconds ${remaining}`);
});
