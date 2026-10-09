// Talking to content scripts, and routing across a page's frames.

import { Context, Effect, Layer, Predicate, Result } from "effect";
import {
  CONTENT_SCRIPT_FILES,
  PAGE_WORLD_SCRIPT_FILES,
  type ContentParams,
  type ContentRequest,
  type ContentResponse,
  type ContentScriptAction,
  type JsonValue,
  type ToolErrorCode,
} from "../shared/protocol.ts";
import { Browser, callBrowser } from "./Browser.ts";
import { BackgroundTiming } from "./config.ts";
import { extensionError, fromContentFailure, type ToolError } from "./errors.ts";
import { SelectedTab } from "./SelectedTab.ts";
import { originOfUrl, TabAccess } from "./TabAccess.ts";

// ─── Frame Routing ───────────────────────────────────────────────────

// The content script runs in every frame, each with its own uid counter, so a uid
// names the frame that minted it. That keeps frames out of the tool contract:
// nothing takes a frameId, the uid carries it.
const UID_PATTERN = /^f(\d+)e\d+$/;

export const frameOfUid = (value: JsonValue | undefined): number | null => {
  const match = Predicate.isString(value) ? UID_PATTERN.exec(value) : null;

  return match ? Number(match[1]) : null;
};

/** The frame a request's `uid`, else its `fromUid`, was minted in. */
export const frameOfTarget = (params: ContentParams): number | null =>
  frameOfUid(params["uid"]) ?? frameOfUid(params["fromUid"]);

/** One frame of a tab, as `webNavigation.getAllFrames` reports it. */
interface FrameInfo {
  readonly frameId: number;
  readonly parentFrameId: number;
  readonly url: string;
}

/**
 * A node of the snapshot tree a frame returns. Only the fields cross-frame
 * splicing reads or writes are named; the rest pass through untouched.
 */
interface SnapshotNode {
  [field: string]: JsonValue | undefined;
  children?: Array<JsonValue>;
  frameSrc?: string;
  unmatchedFrames?: number;
  unreachableFrames?: Array<{ readonly frameId: number; readonly origin: string | null }>;
}

const isSnapshotNode = (value: unknown): value is SnapshotNode => Predicate.isObject(value) && !Array.isArray(value);

/**
 * The only failures that mean "the target is not in this frame". Anything else
 * means the frame resolved the target and the action did not go through, which
 * is already the caller's answer.
 *
 * `permission_required` is in here because that frame could not be asked at
 * all, so another one is still worth trying. `wait_timeout` is in here for the
 * same reason, which is why `wait` does not use the sequential path below.
 */
const FRAME_MISS_CODES: ReadonlySet<ToolErrorCode> = new Set([
  "target_not_found",
  "wait_timeout",
  "permission_required",
]);

/**
 * Acting on an element the caller named by selector or text: the element can
 * live in any frame, so the search has to cross them.
 */
const FRAME_SEARCHING_ACTIONS: ReadonlySet<ContentScriptAction> = new Set([
  "click",
  "type_text",
  "form_input",
  "select_option",
  "hover",
  "drag",
  "upload_file",
  "drop_file",
  "scroll",
  "wait",
]);

/** Asking a content script for something, by tab and frame. */
export interface ContentMessage {
  readonly action: ContentScriptAction;
  readonly params: ContentParams;
}

export class ContentScripts extends Context.Service<
  ContentScripts,
  {
    /**
     * Asks one frame's content script, injecting the content scripts first if
     * the tab has none yet. With no `tabId` it asks the tab a call that names
     * none acts on.
     */
    send(
      tabId: number | undefined,
      message: ContentMessage,
      frameId?: number,
    ): Effect.Effect<JsonValue | undefined, ToolError>;
    /**
     * Routes one content action. Frames are an implementation detail here: a uid
     * says which frame owns the element, a search spans them all, and everything
     * else stays on the top frame where it always ran.
     */
    dispatch(action: ContentScriptAction, params: ContentParams): Effect.Effect<JsonValue | undefined, ToolError>;
  }
>()("mcpsafari/background/ContentScripts") {
  static readonly layer = Layer.effect(
    ContentScripts,
    Effect.gen(function* () {
      const browserApi = yield* Browser;
      const timing = yield* BackgroundTiming;
      const tabAccess = yield* TabAccess;
      const selectedTab = yield* SelectedTab;
      const provideBrowser = Effect.provideService(Browser, browserApi);

      // A missing (or 0) `tabId` means the tab a call that names none acts on.
      const resolveTab = (tabId: number | undefined) => (tabId ? Effect.succeed(tabId) : selectedTab.activeTabId);

      const listFrames = Effect.fn("ContentScripts.listFrames")(function* (tabId: number) {
        const frames = yield* callBrowser((api) => api.webNavigation.getAllFrames({ tabId })).pipe(
          Effect.tapError((error) => Effect.logWarning("[MCPSafari] Frame enumeration failed:", error.message)),
          Effect.orElseSucceed(() => null),
          provideBrowser,
        );

        if (frames && frames.length > 0) {
          return frames.map((frame): FrameInfo => ({
            frameId: frame.frameId,
            parentFrameId: frame.parentFrameId,
            url: frame.url,
          }));
        }

        return [{ frameId: 0, parentFrameId: -1, url: "" }];
      });

      const injectContentScripts = Effect.fn("ContentScripts.inject")(function* (tabId: number) {
        yield* Effect.gen(function* () {
          yield* callBrowser((api) =>
            api.scripting.executeScript({ target: { tabId }, files: [...PAGE_WORLD_SCRIPT_FILES], world: "MAIN" }),
          );
          // The content script is declared for all frames, so a re-injection has
          // to cover them too or the frames stay unreachable until the next
          // navigation.
          yield* callBrowser((api) =>
            api.scripting.executeScript({ target: { tabId, allFrames: true }, files: [...CONTENT_SCRIPT_FILES] }),
          );
          yield* Effect.sleep(timing.injectionSettle);
        }).pipe(
          Effect.tapError((error) => Effect.logWarning("[MCPSafari] Failed to inject content scripts:", error.message)),
          Effect.mapError((error) => extensionError(`Cannot inject content scripts into this tab: ${error.message}`)),
          provideBrowser,
        );
      });

      const ask = (tabId: number, message: ContentRequest, frameId: number, missing: string) =>
        callBrowser(
          // SAFETY: the content script answers every message with a ContentResponse
          // (content/main.ts), or not at all, which is the `undefined` handled below.
          (api) => api.tabs.sendMessage(tabId, message, { frameId }) as Promise<ContentResponse | undefined>,
        ).pipe(
          Effect.flatMap((response) => {
            if (!response) return Effect.fail(extensionError(missing));

            if (response.error !== null) return Effect.fail(fromContentFailure(response));

            return Effect.succeed(response.data);
          }),
          provideBrowser,
        );

      const send = Effect.fn("ContentScripts.send")(function* (
        tabId: number | undefined,
        message: ContentMessage,
        frameId: number = 0,
      ) {
        const resolvedTabId = yield* resolveTab(tabId);

        // Before anything that can block on Safari's permission dialog. `wait` and
        // other long actions are unaffected: the probe is separate and short, and
        // the action keeps its own timing once access is established.
        yield* tabAccess.ensure(resolvedTabId);

        // The frame learns its own id from the request it is answering.
        const request: ContentRequest = { ...message, frameId };

        return yield* ask(resolvedTabId, request, frameId, "Receiving end does not exist").pipe(
          Effect.catchIf(
            // Content script might not be injected yet
            (error) =>
              error.message.includes("Could not establish connection") ||
              error.message.includes("Receiving end does not exist"),
            () =>
              Effect.andThen(
                injectContentScripts(resolvedTabId),
                ask(resolvedTabId, request, frameId, "Content script did not respond after injection"),
              ),
          ),
        );
      });

      // A frame whose document refuses the content script (a sandboxed or already
      // unloaded one) must not fail the whole call, so misses are dropped.
      const collectFromFrames = Effect.fn("ContentScripts.collectFromFrames")(function* (
        tabId: number,
        message: ContentMessage,
      ) {
        const frames = yield* listFrames(tabId);
        const collected: Array<{ readonly frameId: number; readonly data: JsonValue | undefined }> = [];

        for (const frame of frames) {
          const result = yield* send(tabId, message, frame.frameId).pipe(
            Effect.map((data) => ({ frameId: frame.frameId, data })),
            Effect.catchIf(
              () => frame.frameId !== 0,
              () => Effect.succeed(null),
            ),
          );

          if (result) collected.push(result);
        }

        return collected;
      });

      const waitInAnyFrame = Effect.fn("ContentScripts.waitInAnyFrame")(function* (
        tabId: number,
        message: ContentMessage,
        frames: ReadonlyArray<FrameInfo>,
      ) {
        const failures: Array<ToolError | undefined> = frames.map(() => undefined);

        return yield* Effect.raceAll(
          frames.map((frame, index) =>
            send(tabId, message, frame.frameId).pipe(
              Effect.tapError((error) => Effect.sync(() => void (failures[index] = error))),
            ),
          ),
        ).pipe(
          // Every frame failed. Report one of the real failures, preferring one
          // that says more than "something went wrong", so `wait_timeout` and its
          // recovery action stay intact.
          Effect.catch(() => {
            const reasons = failures.filter(Predicate.isNotUndefined);
            const reason = reasons.find((error) => error.code !== "extension_error") ?? reasons[0];

            return Effect.fail(reason ?? extensionError("No frame handled the request"));
          }),
        );
      });

      // Targeting by selector or text has no frame in it, so the frames are tried in
      // order and the first that resolves the target wins. The top frame is tried
      // first, which keeps single-frame pages behaving exactly as before.
      const sendToFirstMatchingFrame = Effect.fn("ContentScripts.sendToFirstMatchingFrame")(function* (
        tabId: number,
        message: ContentMessage,
      ) {
        const frames = yield* listFrames(tabId);

        // Asked of every frame at once rather than in turn. A `wait` whose selector
        // never appears costs its entire timeout in each frame otherwise, so a page
        // with a few iframes runs past the server's bridge timeout and the agent
        // gets a generic failure in place of the `wait_timeout` the content script
        // built for it. Racing is also what the caller meant: wait until this shows
        // up anywhere. Nothing is mutated, so there is no double-action risk here.
        if (message.action === "wait") return yield* waitInAnyFrame(tabId, message, frames);

        let firstMiss: ToolError | undefined;

        for (const frame of frames) {
          const outcome = yield* Effect.result(send(tabId, message, frame.frameId));

          if (Result.isSuccess(outcome)) return outcome.success;

          // Carrying on past a frame that found the target would act in a
          // frame the caller never meant, and for a `click` that already
          // fired before throwing it would fire a second time.
          if (!FRAME_MISS_CODES.has(outcome.failure.code)) return yield* outcome.failure;

          firstMiss ??= outcome.failure;
        }

        return yield* firstMiss ?? extensionError("No frame handled the request");
      });

      // Reads the whole tab as one tree by asking each frame for its own and hanging
      // each result on the <iframe> that hosts it, so an agent sees the page the way
      // a person does instead of a top frame with holes in it.
      const snapshotAcrossFrames = Effect.fn("ContentScripts.snapshotAcrossFrames")(function* (
        tabId: number,
        params: ContentParams,
      ) {
        const frames = yield* listFrames(tabId);
        const trees = new Map<number, SnapshotNode>();
        const unreachable: Array<{ readonly frameId: number; readonly origin: string | null }> = [];

        for (const frame of frames) {
          const outcome = yield* Effect.result(send(tabId, { action: "snapshot", params }, frame.frameId));

          if (Result.isSuccess(outcome)) {
            if (isSnapshotNode(outcome.success)) trees.set(frame.frameId, outcome.success);
            continue;
          }

          if (frame.frameId === 0) return yield* outcome.failure;

          // A subframe that will not answer leaves a hole, and a tree with a
          // silent hole in it is the exact thing cross-frame snapshots were
          // built to avoid. Safari grants "Always Allow on This Website" for
          // the top level only, so this is the ordinary case on a page with
          // third-party frames, not an exotic one.
          unreachable.push({ frameId: frame.frameId, origin: originOfUrl(frame.url) });
        }

        const childFrames = new Map<number, Array<FrameInfo>>();

        for (const frame of frames) {
          if (frame.frameId === 0) continue;

          const siblings = childFrames.get(frame.parentFrameId) ?? [];

          siblings.push(frame);
          childFrames.set(frame.parentFrameId, siblings);
        }

        const root = trees.get(0);

        if (root) {
          spliceFrames(root, 0, childFrames, trees);

          if (unreachable.length > 0) root.unreachableFrames = unreachable;
        }

        // SAFETY: a SnapshotNode is a JSON object; the interface only names the
        // fields splicing touches.
        return root as JsonValue | undefined;
      });

      const dispatch = Effect.fn("ContentScripts.dispatch")(function* (
        action: ContentScriptAction,
        params: ContentParams,
      ) {
        const message: ContentMessage = { action, params };
        // Resolved once, here. Passed on unresolved, the frame lookup was handed
        // no tab, Safari refused it and only the top frame was ever asked; and
        // each frame's send looked up the active tab again, so a user switching
        // tabs mid-call split one snapshot or search across two pages.
        const tabId = yield* resolveTab(Predicate.isNumber(params["tabId"]) ? params["tabId"] : undefined);
        const targetFrame = frameOfTarget(params);

        if (targetFrame !== null) return yield* send(tabId, message, targetFrame);

        if (action === "snapshot") return yield* snapshotAcrossFrames(tabId, params);

        if (action === "read_page" && params["format"] === "snapshot") {
          return yield* snapshotAcrossFrames(tabId, params);
        }

        if (action === "find") {
          const collected = yield* collectFromFrames(tabId, message);

          return collected.flatMap((entry) => (Array.isArray(entry.data) ? entry.data : []));
        }

        if (FRAME_SEARCHING_ACTIONS.has(action) && (params["selector"] || params["text"])) {
          return yield* sendToFirstMatchingFrame(tabId, message);
        }

        return yield* send(tabId, message, 0);
      });

      return ContentScripts.of({ send, dispatch });
    }),
  );
}

const collectFrameHosts = (node: SnapshotNode, hosts: Array<SnapshotNode> = []): Array<SnapshotNode> => {
  if (Predicate.isString(node.frameSrc)) hosts.push(node);

  for (const child of node.children ?? []) {
    if (isSnapshotNode(child)) collectFrameHosts(child, hosts);
  }

  return hosts;
};

/**
 * The trees of the frames below `frameId`, which has none of its own, each
 * spliced in turn. Their hosts are in the document nobody could read, so they
 * can only be attached higher up.
 */
const treesBelow = (
  frameId: number,
  childFrames: ReadonlyMap<number, ReadonlyArray<FrameInfo>>,
  trees: ReadonlyMap<number, SnapshotNode>,
): Array<SnapshotNode> =>
  (childFrames.get(frameId) ?? []).flatMap((frame) => {
    const subtree = trees.get(frame.frameId);

    if (!subtree) return treesBelow(frame.frameId, childFrames, trees);

    spliceFrames(subtree, frame.frameId, childFrames, trees);

    return [subtree];
  });

/**
 * getAllFrames reports each frame's URL but not which element hosts it, so the
 * two are matched on the resolved src. Identical srcs are matched in document
 * order, and a frame whose host cannot be identified is attached to the parent
 * tree rather than dropped.
 */
const spliceFrames = (
  tree: SnapshotNode,
  frameId: number,
  childFrames: ReadonlyMap<number, ReadonlyArray<FrameInfo>>,
  trees: ReadonlyMap<number, SnapshotNode>,
): void => {
  const children = childFrames.get(frameId) ?? [];
  const hosts = collectFrameHosts(tree);
  const claimed = new Set<SnapshotNode>();
  const orphans: Array<SnapshotNode> = [];

  for (const frame of children) {
    const subtree = trees.get(frame.frameId);

    // An unreachable frame is reported on its own, but whatever it hosts may
    // have answered. Skipping the whole branch dropped those trees without a
    // trace: not spliced, not counted, not listed.
    if (!subtree) {
      orphans.push(...treesBelow(frame.frameId, childFrames, trees));
      continue;
    }

    spliceFrames(subtree, frame.frameId, childFrames, trees);

    const host = hosts.find((candidate) => !claimed.has(candidate) && candidate.frameSrc === frame.url);

    if (host) {
      claimed.add(host);
      // SAFETY: as above.
      host.children = [subtree as JsonValue];
    } else {
      orphans.push(subtree);
    }
  }

  if (orphans.length > 0) {
    // SAFETY: as above.
    tree.children = (tree.children ?? []).concat(orphans as Array<JsonValue>);
    tree.unmatchedFrames = orphans.length;
  }

  for (const host of hosts) delete host.frameSrc;
};
