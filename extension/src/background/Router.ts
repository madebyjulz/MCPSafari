// One bridge request in, one response out.

import { Cause, Context, Effect, Layer, Predicate, Schema } from "effect";
import type { ContentParams } from "../shared/protocol.ts";
import { CONTENT_ACTIONS, type BackgroundAction, type ContentAction, type ContentProxyAction } from "./actions.ts";
import { Browser } from "./Browser.ts";
import { ContentScripts, type ContentMessage } from "./ContentScripts.ts";
import { extensionError, failureResponse, fromUnknown, type BridgeResponse, type ToolError } from "./errors.ts";
import { SelectedTab } from "./SelectedTab.ts";
import { TabAccess } from "./TabAccess.ts";
import { dispatchAndSettle, handleNavigate, waitAcrossNavigations } from "./tools/navigation.ts";
import { redactResult } from "./tools/redaction.ts";
import { handleJavaScript, handleResizeWindow, handleScreenshot } from "./tools/page.ts";
import {
  handleNativePointer,
  handleNativePressKey,
  handleNativeTypeText,
  handleSelectTab,
  handleTabsClose,
  handleTabsCreate,
  handleTabsQuery,
} from "./tools/tabs.ts";

/** What a background handler may need. */
type HandlerServices = Browser | TabAccess | SelectedTab | ContentScripts;

type Handler = (params: ContentParams) => Effect.Effect<unknown, ToolError, HandlerServices>;

// An action is served one of three ways, and each is a lookup rather than a
// switch arm. Nineteen of them differed only in their `case` label, which hid
// the one fact worth seeing: almost every tool is just handed to the content
// script.
//
// Page data is redacted on the way out (`redactResult`): the scripts that
// capture URLs run in the page's world, where a page could tamper with any copy
// of the redaction, so this is the last stop before they leave the extension.
//
// Maps and sets rather than object literals, because the action name arrives
// off the wire. A plain object resolves `constructor` and `toString` through its
// prototype, so those names would have found an inherited function and been
// called as handlers instead of refused.

/** Exported for the test that checks every table covers its list in actions.ts. */
export const BACKGROUND_HANDLERS: ReadonlyMap<string, Handler> = new Map<BackgroundAction, Handler>([
  ["tabs_query", () => handleTabsQuery()],
  ["tabs_create", handleTabsCreate],
  ["tabs_close", handleTabsClose],
  ["select_tab", handleSelectTab],
  ["navigate", handleNavigate],
  ["native_type_text", handleNativeTypeText],
  ["native_press_key", handleNativePressKey],
  ["native_pointer", handleNativePointer],
  ["screenshot", handleScreenshot],
  ["javascript_tool", handleJavaScript],
  ["resize_window", handleResizeWindow],
]);

const CONTENT_ACTION_NAMES: ReadonlySet<string> = new Set<ContentAction>(CONTENT_ACTIONS);

export const CONTENT_PROXIES: ReadonlyMap<string, (params: ContentParams) => ContentMessage> = new Map<
  ContentProxyAction,
  (params: ContentParams) => ContentMessage
>([
  [
    "read_console",
    (params) => ({
      action: "get_console_messages",
      params: {
        level: params["level"] || "all",
        pattern: params["pattern"] || null,
        clear: params["clear"] || false,
      },
    }),
  ],
  [
    "read_network",
    (params) => ({
      action: "get_network_requests",
      params: {
        type: params["type"] || "all",
        urlPattern: params["urlPattern"] || null,
        status: params["status"] ?? null,
        maxResults: params["maxResults"] || 0,
        clear: params["clear"] || false,
      },
    }),
  ],
  ["handle_dialog", (params) => ({ action: "handle_dialog", params })],
]);

/**
 * Interactions that can start a page load, each with the test for whether this
 * call can. They answer only once a load they start has finished
 * (`dispatchAndSettle`). They are the ones that dispatch the events a page
 * navigates on: a click follows a link or submits a form, a key press can
 * activate a control or submit one, and changing a field or select commonly
 * submits or routes straight away (`onchange`). Typing navigates only when it
 * ends in a key, so a plain `type_text` does not pay the wait.
 *
 * Not here: `hover`, `scroll` and `drag` do not follow links, and `upload_file`
 * and `drop_file` start no load of their own. A navigation any of those cause
 * anyway is still survived by a `wait` sent afterwards (`waitAcrossNavigations`).
 * A click that opens a new tab, `target="_blank"`, does not navigate this one,
 * so it answers at the end of the watch window with the new tab left to
 * `tabs_context`.
 */
const LOAD_STARTING_ACTIONS: ReadonlyMap<string, (params: ContentParams) => boolean> = new Map<
  ContentAction,
  (params: ContentParams) => boolean
>([
  ["click", () => true],
  ["press_key", () => true],
  ["type_text", (params) => Boolean(params["submitKey"])],
  ["form_input", () => true],
  ["select_option", () => true],
]);

/**
 * The tab tools that never fall back to the active tab. `tabs_close` and
 * `select_tab` demand a tab by name: closing whatever happens to be in front
 * because the caller left it out would be the wrong default. The other two have
 * no target tab to resolve.
 */
const TAB_FREE_ACTIONS: ReadonlySet<string> = new Set<BackgroundAction>([
  "tabs_query",
  "tabs_create",
  "tabs_close",
  "select_tab",
]);

const actsOnATab = (name: string) =>
  !TAB_FREE_ACTIONS.has(name) &&
  (BACKGROUND_HANDLERS.has(name) || CONTENT_ACTION_NAMES.has(name) || CONTENT_PROXIES.has(name));

/** A request as the server sends it. Only `id` is required to answer at all. */
export const BridgeRequest = Schema.Struct({
  id: Schema.String,
  action: Schema.optionalKey(Schema.Unknown),
  params: Schema.optionalKey(Schema.Unknown),
});

export type BridgeRequest = typeof BridgeRequest.Type;

const isParams = (value: unknown): value is ContentParams => Predicate.isObject(value) && !Array.isArray(value);

const routeAction = (name: string, params: ContentParams) =>
  Effect.gen(function* () {
    const handler = BACKGROUND_HANDLERS.get(name);

    if (handler) return yield* handler(params);

    if (name === "wait") return yield* waitAcrossNavigations(params);

    if (CONTENT_ACTION_NAMES.has(name)) {
      // SAFETY: membership in CONTENT_ACTION_NAMES was just checked.
      const action = name as ContentAction;
      const startsLoad = LOAD_STARTING_ACTIONS.get(action);

      if (startsLoad?.(params)) return yield* dispatchAndSettle(action, params);

      return redactResult(action, yield* (yield* ContentScripts).dispatch(action, params));
    }

    const proxy = CONTENT_PROXIES.get(name);

    if (proxy) {
      const tabId = Predicate.isNumber(params["tabId"]) ? params["tabId"] : undefined;

      return redactResult(name, yield* (yield* ContentScripts).send(tabId, proxy(params)));
    }

    return yield* extensionError(`Unknown action: ${name}`);
  });

export class Router extends Context.Service<
  Router,
  {
    /** Answers one request. Never fails: a failure is itself the answer. */
    handle(request: BridgeRequest): Effect.Effect<BridgeResponse>;
  }
>()("mcpsafari/background/Router") {
  static readonly layer = Layer.effect(
    Router,
    Effect.gen(function* () {
      const services = yield* Effect.context<HandlerServices>();

      const handle = (request: BridgeRequest): Effect.Effect<BridgeResponse> => {
        const requested = request.params === undefined ? {} : request.params;
        const action = String(request.action);
        let resolvedTabId: number | null = null;

        return Effect.gen(function* () {
          if (!isParams(requested)) return yield* extensionError("Request params must be an object");

          // A call that names no tab used to look the active tab up again at
          // every step: once per frame, once per follow-up. The user can change
          // tabs between any two of those, so one request could act on two
          // pages. The target is decided here, once, and travels as
          // `params.tabId` from then on.
          const params =
            actsOnATab(action) && !requested["tabId"]
              ? { ...requested, tabId: yield* (yield* SelectedTab).activeTabId }
              : requested;

          resolvedTabId = Predicate.isNumber(params["tabId"]) ? params["tabId"] : null;

          const data = yield* routeAction(action, params);

          return {
            id: request.id,
            success: true,
            // `JSON.stringify(undefined)` is the value undefined rather than a
            // string, and the outer stringify then drops the key altogether, so
            // the server saw a successful reply with no data at all and reported
            // it as a failure with no reason. A snapshot whose top frame returns
            // nothing is one way in; the coalesce is a floor under every
            // handler rather than a fix for that one.
            data: Predicate.isString(data) ? data : JSON.stringify(data ?? null),
            error: null,
            resolvedTabId,
          } satisfies BridgeResponse;
        }).pipe(
          // Anything that escapes a handler, typed failure or defect alike, is
          // still an answer to this request.
          Effect.catchCause((cause) =>
            Effect.sync(() => failureResponse(request.id, fromUnknown(Cause.squash(cause)), resolvedTabId)),
          ),
          Effect.provideContext(services),
        );
      };

      return Router.of({ handle });
    }),
  );
}
