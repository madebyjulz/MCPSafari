import assert from "node:assert/strict";
import { afterEach, test } from "vitest";

import type { ContentRequest, ContentScriptAction, ContentParams } from "../src/shared/protocol.ts";
import { parked } from "./helpers/background.ts";
import { dataOf, fakeBrowser, launch, stopAll, type FakeContentReply, type FakeFrame } from "./helpers/fake-browser.ts";

const TOP: FakeFrame = { frameId: 0, parentFrameId: -1, url: "https://top.example/" };

const EMBED: FakeFrame = { frameId: 3, parentFrameId: 0, url: "https://embed.example/form" };

interface Sent {
  readonly tabId: number;
  readonly frameId: number;
  readonly action: ContentScriptAction;
  readonly params: ContentParams;
}

type Respond = (frameId: number, message: ContentRequest) => FakeContentReply | Promise<FakeContentReply>;

afterEach(stopAll);

// Every message the router sends is recorded with the frame it was aimed at,
// so the assertions can check routing and not just the returned value.
function loadBackground(respond: Respond, frames: ReadonlyArray<FakeFrame> = [TOP, EMBED]) {
  const sent: Array<Sent> = [];
  const api = fakeBrowser();

  api.tabs.get = async (id) => ({ id, active: true, url: TOP.url, title: "Top", windowId: 1 });

  api.tabs.sendMessage = async (tabId, message, options) => {
    const frameId = options?.frameId ?? 0;

    sent.push({ tabId, frameId, action: message.action, params: message.params });

    return respond(frameId, message);
  };

  // Safari rejects a lookup that names no tab rather than picking one.
  api.webNavigation.getAllFrames = async ({ tabId }) => {
    if (!Number.isInteger(tabId)) throw new Error("Invalid tabId");

    return frames;
  };

  return { api, sent, request: launch(api).request };
}

const ok = (data: FakeContentReply["data"]): FakeContentReply => ({ data, error: null });

const unreachable = (): never => {
  throw new Error("Could not establish connection");
};

const topTree = () => ({
  uid: "f0e1",
  tag: "body",
  children: [
    { uid: "f0e6", tag: "h1", text: "Checkout" },
    { uid: "f0e7", tag: "iframe", frameSrc: EMBED.url ?? "" },
  ],
});

const embedTree = () => ({
  uid: "f3e1",
  tag: "body",
  children: [{ uid: "f3e2", tag: "input", role: "textbox" }],
});

interface TreeNode {
  readonly uid?: string;
  readonly tag?: string;
  readonly children?: ReadonlyArray<TreeNode>;
  readonly unmatchedFrames?: number;
  readonly unreachableFrames?: ReadonlyArray<{ readonly frameId: number; readonly origin: string | null }>;
}

const iframeOf = (tree: TreeNode): TreeNode | undefined => tree.children?.find((child) => child.tag === "iframe");

test("a uid routes to the frame that minted it", async () => {
  const { request, sent } = loadBackground(() => ok("Clicked <input>"));

  await request("click", { tabId: 1, uid: "f3e2" });

  assert.equal(sent.length, 1, "a uid should not need a search");
  assert.equal(sent[0]?.frameId, 3);
  assert.equal(sent[0]?.action, "click");
});

test("a top-frame uid still goes to frame 0", async () => {
  const { request, sent } = loadBackground(() => ok("Clicked <button>"));

  await request("click", { tabId: 1, uid: "f0e7" });

  assert.equal(sent[0]?.frameId, 0);
});

test("snapshot hangs each frame's tree on the iframe that hosts it", async () => {
  const { request } = loadBackground((frameId) => ok(frameId === 0 ? topTree() : embedTree()));

  const tree: TreeNode = dataOf(await request("snapshot", { tabId: 1 }));
  const iframe = iframeOf(tree);

  assert.ok(iframe, "the iframe node should survive splicing");
  assert.equal(iframe.children?.length, 1);
  assert.equal(iframe.children[0]?.children?.[0]?.uid, "f3e2");
  // The marker exists to match frames, so it does not reach the caller.
  assert.equal("frameSrc" in iframe, false);
  assert.equal(tree.unmatchedFrames, undefined);
});

test("a frame whose host cannot be identified is attached, not dropped", async () => {
  const orphan: FakeFrame = { frameId: 4, parentFrameId: 0, url: "https://other.example/widget" };
  const { request } = loadBackground((frameId) => ok(frameId === 0 ? topTree() : embedTree()), [TOP, orphan]);

  const tree: TreeNode = dataOf(await request("snapshot", { tabId: 1 }));

  assert.equal(tree.unmatchedFrames, 1);
  assert.ok(
    tree.children?.some((child) => child.children?.[0]?.uid === "f3e2"),
    "the unmatched frame's content should still be reachable",
  );
});

test("a frame that will not answer is named rather than left as a hole", async () => {
  const { request } = loadBackground((frameId) => (frameId === 0 ? ok(topTree()) : unreachable()));

  const tree: TreeNode = dataOf(await request("snapshot", { tabId: 1 }));

  // Safari's per-site grant covers the top level only, so this is what a page
  // with a third-party frame looks like until the broad grant is given. The
  // tree used to come back looking complete.
  assert.deepEqual(tree.unreachableFrames, [{ frameId: 3, origin: "https://embed.example" }]);
  // The iframe node is still there, it just has nothing hanging off it.
  assert.equal(iframeOf(tree)?.children, undefined);
});

test("a frame inside an unreachable one is still attached", async () => {
  // A reachable frame hosted by one that would not answer: its <iframe> lives in
  // the document nobody could read, so there is no host to hang it on.
  const nested: FakeFrame = { frameId: 5, parentFrameId: 3, url: "https://nested.example/" };

  const replies = new Map<number, FakeContentReply["data"]>([
    [0, topTree()],
    [5, { uid: "f5e1", tag: "body", children: [{ uid: "f5e2", tag: "button" }] }],
  ]);

  const { request } = loadBackground(
    (frameId) => {
      const tree = replies.get(frameId);

      return tree ? ok(tree) : unreachable();
    },
    [TOP, EMBED, nested],
  );

  const tree: TreeNode = dataOf(await request("snapshot", { tabId: 1 }));

  assert.deepEqual(tree.unreachableFrames, [{ frameId: 3, origin: "https://embed.example" }]);
  // It used to vanish: not spliced, not counted, not listed.
  assert.equal(tree.unmatchedFrames, 1);
  assert.ok(
    tree.children?.some((child) => child.uid === "f5e1"),
    "the nested frame's content should hang off the nearest tree that was read",
  );
});

test("a snapshot that reaches every frame says nothing about unreachable ones", async () => {
  const { request } = loadBackground((frameId) => ok(frameId === 0 ? topTree() : embedTree()));

  const tree: TreeNode = dataOf(await request("snapshot", { tabId: 1 }));

  // An empty list on every snapshot would be noise on the overwhelmingly
  // common case, so the key is absent when there is nothing to report.
  assert.equal("unreachableFrames" in tree, false);
});

test("a frame with an unreadable url is still reported", async () => {
  // about:blank and srcdoc frames have no origin to name, but the hole in the
  // tree is just as real, so the entry appears with a null origin.
  const blank: FakeFrame = { frameId: 7, parentFrameId: 0, url: "about:srcdoc" };
  const { request } = loadBackground((frameId) => (frameId === 0 ? ok(topTree()) : unreachable()), [TOP, blank]);

  const tree: TreeNode = dataOf(await request("snapshot", { tabId: 1 }));

  assert.equal(tree.unreachableFrames?.length, 1);
  assert.equal(tree.unreachableFrames[0]?.frameId, 7);
  assert.equal(tree.unreachableFrames[0]?.origin, null);
});

test("find fans out and returns matches from every frame", async () => {
  const { request, sent } = loadBackground((frameId) =>
    ok(frameId === 0 ? [{ uid: "f0e6", tag: "h1" }] : [{ uid: "f3e2", tag: "input" }]),
  );

  const results: ReadonlyArray<TreeNode> = dataOf(await request("find", { tabId: 1, text: "a" }));

  assert.deepEqual(
    results.map((result) => result.uid),
    ["f0e6", "f3e2"],
  );
  assert.deepEqual(
    sent.map((message) => message.frameId),
    [0, 3],
  );
});

test("a call that names no tab still reaches every frame", async () => {
  const { request, sent } = loadBackground((frameId) =>
    ok(frameId === 0 ? [{ uid: "f0e6", tag: "h1" }] : [{ uid: "f3e2", tag: "input" }]),
  );

  // Most calls name no tab. The frame lookup was handed that absence as is,
  // Safari refused it, and only the top frame was ever asked.
  const results: ReadonlyArray<TreeNode> = dataOf(await request("find", { text: "a" }));

  assert.deepEqual(
    results.map((result) => result.uid),
    ["f0e6", "f3e2"],
  );
  assert.deepEqual(
    sent.map((message) => [message.tabId, message.frameId]),
    [
      [1, 0],
      [1, 3],
    ],
  );
});

test("every frame of one call is asked in the same tab", async () => {
  const { api, request, sent } = loadBackground((frameId) => ok(frameId === 0 ? topTree() : embedTree()));
  let lookups = 0;

  // The user switching tabs while a snapshot walks the frames. Resolving the
  // active tab per frame would stitch two pages into one tree.
  api.tabs.query = async () => {
    lookups += 1;

    return [{ id: lookups, active: true, windowId: 1 }];
  };

  // Whatever tab is asked about, so this checks the sends on their own.
  api.webNavigation.getAllFrames = async () => [TOP, EMBED];

  await request("snapshot");

  assert.deepEqual(
    sent.map((message) => message.tabId),
    [1, 1],
  );
});

test("a selector target searches frames until one resolves it", async () => {
  // The top frame does not have the element; the router must keep going.
  const { request, sent } = loadBackground((frameId) =>
    frameId === 0 ? { data: null, error: "No element found", errorCode: "target_not_found" } : ok("Clicked <input>"),
  );

  const response = await request("click", { tabId: 1, selector: "#card" });

  assert.equal(response.data, "Clicked <input>");
  assert.deepEqual(
    sent.map((message) => message.frameId),
    [0, 3],
  );
});

test("a subframe that refuses the content script does not fail the whole read", async () => {
  const { request } = loadBackground((frameId) => (frameId === 0 ? ok([{ uid: "f0e6", tag: "h1" }]) : unreachable()));

  const results: ReadonlyArray<TreeNode> = dataOf(await request("find", { tabId: 1, text: "a" }));

  assert.deepEqual(
    results.map((result) => result.uid),
    ["f0e6"],
  );
});

test("the content script is told which frame it is answering for", async () => {
  const requests: Array<ContentRequest> = [];

  const { request } = loadBackground((_frameId, message) => {
    requests.push(message);

    return ok(null);
  });

  await request("click", { tabId: 1, uid: "f3e2" });

  // The uid counter in that frame depends on this arriving with the request.
  assert.equal(requests[0]?.frameId, 3);
});

test("native input refuses a subframe target instead of clicking the wrong point", async () => {
  const { request } = loadBackground(() => ok(null));

  const refused = await request("native_pointer", { tabId: 1, uid: "f3e2" });

  assert.equal(refused.success, false);
  assert.match(refused.error ?? "", /top frame only/i);

  // A top-frame uid is still allowed through.
  const allowed = await request("native_pointer", { tabId: 1, uid: "f0e7" });

  assert.equal(allowed.success, true);
});

test("a targeted screenshot refuses a subframe target instead of cropping the wrong region", async () => {
  // captureVisibleTab returns the top-level viewport, and a subframe measures
  // its element against its own. Cropping on that would silently produce a
  // picture of somewhere else, and the element_rect request would go to the
  // top frame, which does not know the uid.
  const { request, sent } = loadBackground(() => ok(null));

  const response = await request("screenshot", { tabId: 1, uid: "f3e2" });

  assert.equal(response.success, false);
  assert.match(response.error ?? "", /top frame only|iframe/i);
  assert.equal(sent.length, 0, "it should refuse before scrolling the page");
});

test("a frame that resolved the target but failed does not hand the action on", async () => {
  const { request, sent } = loadBackground((frameId) =>
    // Resolved here and did not go through. A covered target is this
    // shape, and so is a click that fired before something after it
    // threw.
    frameId === 0
      ? { data: null, error: "covered by f0e9 <div>#modal", errorCode: "target_covered" }
      : ok("Clicked <input>"),
  );

  const response = await request("click", { tabId: 1, selector: "#buy" });

  assert.equal(response.success, false);
  assert.match(response.error ?? "", /covered/);
  // Frame 3 matches `#buy` as well. Clicking it would be a second click, on a
  // page the caller never named, after the first one may already have fired.
  assert.deepEqual(
    sent.map((message) => message.frameId),
    [0],
  );
});

test("a frame that simply does not have the target is still skipped", async () => {
  // The counterpart to the test above: stopping on every failure would undo
  // the frame search entirely.
  const { request, sent } = loadBackground((frameId) =>
    frameId === 0 ? { data: null, error: "no element", errorCode: "target_not_found" } : ok("Clicked <input>"),
  );

  const response = await request("click", { tabId: 1, selector: "#card" });

  assert.equal(response.data, "Clicked <input>");
  assert.deepEqual(
    sent.map((message) => message.frameId),
    [0, 3],
  );
});

test("wait is put to every frame at once rather than one timeout at a time", async () => {
  const asked: Array<number> = [];

  const { request } = loadBackground((frameId) => {
    asked.push(frameId);

    if (frameId === 3) return ok("appeared");

    // Never settles, which is how a selector that is not coming behaves
    // until its own timeout runs out. Asked in turn, frame 3 is never
    // reached and the whole call rides the bridge timeout instead.
    return parked();
  });

  const response = await request("wait", { tabId: 1, selector: ".late" });

  assert.equal(response.data, "appeared");
  assert.deepEqual(asked, [0, 3]);
});

test("a wait no frame satisfies still reports wait_timeout", async () => {
  const { request } = loadBackground(() => ({ data: null, error: "no match in 10s", errorCode: "wait_timeout" }));

  // Racing the frames fails with every frame's failure at once, which carries
  // no tool error code, so reporting that directly would lose the recovery
  // action the content script attached.
  const response = await request("wait", { tabId: 1, selector: ".never" });

  assert.equal(response.errorCode, "wait_timeout");
});
