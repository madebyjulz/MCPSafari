// A fake `browser` for the background tests: every part the background touches,
// answering the way a granted tab on an ordinary page does. Each test swaps out
// the calls its scenario is about.

import vm from "node:vm";

import type { BridgeResponse } from "../../src/background/errors.ts";
import type {
  evaluateUserCode,
  goBack,
  goForward,
  probeTabAccess,
  readPageContext,
} from "../../src/background/injected.ts";
import type { PopupRequest, SiteAccess, StatusReply } from "../../src/shared/popup.ts";
import type { ContentParams, ContentRequest, JsonValue } from "../../src/shared/protocol.ts";
import { FakeEvent, startBackground, type BackgroundHarness, type FakeBrowser } from "./background.ts";

/** A tab as the fake reports it. Safari leaves any of these out at times. */
export interface FakeTab {
  readonly id?: number | undefined;
  readonly url?: string | undefined;
  readonly title?: string | undefined;
  readonly active?: boolean | undefined;
  readonly windowId?: number | undefined;
  readonly status?: string | undefined;
}

/** One frame as `webNavigation.getAllFrames` reports it. */
export interface FakeFrame {
  readonly frameId: number;
  readonly parentFrameId: number;
  readonly url?: string | undefined;
}

/**
 * What a content script answers. Looser than the protocol type on purpose: the
 * background has to cope with a reply that leaves out fields or carries a code
 * it does not know.
 */
export interface FakeContentReply {
  readonly data: JsonValue | undefined;
  readonly error: string | null;
  readonly errorCode?: string;
  readonly retryable?: boolean;
  readonly recoveryAction?: string;
}

/** Every function the background hands to `scripting.executeScript`. */
export type InjectedFunction =
  | typeof probeTabAccess
  | typeof readPageContext
  | typeof goBack
  | typeof goForward
  | typeof evaluateUserCode;

export interface InjectionOptions {
  readonly target: { readonly tabId: number; readonly allFrames?: boolean };
  readonly func?: InjectedFunction;
  readonly args?: ReadonlyArray<string>;
  readonly files?: ReadonlyArray<string>;
  readonly world?: "MAIN" | "ISOLATED";
}

export interface InjectionResult {
  // oxlint-disable-next-line typescript/no-explicit-any -- whatever the injected function returned in the page
  readonly result?: any;
}

export interface TabChange {
  readonly url?: string;
  readonly status?: "loading" | "complete";
}

/** Anything the background may send the popup back. */
export type PopupReply = StatusReply | SiteAccess | { readonly ok: true } | undefined;

export type PopupListener = (
  message: PopupRequest,
  sender: Readonly<Record<string, never>>,
  sendResponse: (reply: PopupReply) => void,
) => boolean;

export interface NativeTokensReply {
  readonly tokens?: Readonly<Record<string, string>>;
  readonly token?: string;
  readonly profile?: string;
  readonly error?: string;
}

export const DATA_URL = "data:image/png;base64,AAAB";

export const TOP_URL = "https://ok.example/";

export const fakeBrowser = () => ({
  alarms: {
    create: async (): Promise<void> => {},
    onAlarm: new FakeEvent<(alarm: { readonly name: string }) => void>(),
  },
  runtime: {
    getManifest: () => ({ version: "9.9.9" }),
    onMessage: new FakeEvent<PopupListener>(),
    sendNativeMessage: async (): Promise<NativeTokensReply> => ({ tokens: {} }),
  },
  scripting: {
    executeScript: async (_options: InjectionOptions): Promise<ReadonlyArray<InjectionResult>> => [{ result: true }],
  },
  storage: {
    local: { get: async (): Promise<Readonly<Record<string, JsonValue>>> => ({}), set: async (): Promise<void> => {} },
    session: {
      get: async (): Promise<Readonly<Record<string, JsonValue>>> => ({}),
      set: async (): Promise<void> => {},
      remove: async (): Promise<void> => {},
    },
  },
  tabs: {
    get: async (tabId: number): Promise<FakeTab> => ({
      id: tabId,
      active: true,
      windowId: 1,
      url: TOP_URL,
      title: "T",
    }),
    query: async (): Promise<ReadonlyArray<FakeTab>> => [{ id: 1, active: true, windowId: 1 }],
    create: async (_properties: { readonly url?: string }): Promise<FakeTab> => ({ id: 2, url: "", title: "" }),
    update: async (
      _tabId: number,
      _properties: { readonly url?: string; readonly active?: boolean },
    ): Promise<void> => {},
    reload: async (_tabId: number): Promise<void> => {},
    remove: async (_tabId: number): Promise<void> => {},
    captureVisibleTab: async (): Promise<string> => DATA_URL,
    sendMessage: async (
      _tabId: number,
      _message: ContentRequest,
      _options?: { readonly frameId?: number },
    ): Promise<FakeContentReply | null | undefined> => ({ data: "ok", error: null }),
    onUpdated: new FakeEvent<(tabId: number, changeInfo: TabChange, tab: FakeTab) => void>(),
    onRemoved: new FakeEvent<(tabId: number) => void>(),
  },
  webNavigation: {
    getAllFrames: async (): Promise<ReadonlyArray<FakeFrame>> => [{ frameId: 0, parentFrameId: -1, url: TOP_URL }],
  },
  windows: {
    update: async (_windowId: number, _properties: { readonly focused?: boolean; readonly width?: number }) => {},
  },
});

export type FakeBrowserApi = ReturnType<typeof fakeBrowser>;

/** Lets every queued callback, and whatever it forked, run. */
export const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
};

/**
 * The `data` of a successful reply, decoded. Typed loosely on purpose, as the
 * content tests do: each test reaches into whatever its action returned.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- each test reaches into its own action's result
export const dataOf = (response: BridgeResponse): any => {
  if (!response.success || response.data === null) throw new Error(`Expected success, got ${response.error}`);

  return JSON.parse(response.data);
};

/**
 * Runs an injected function the way Safari does: serialised to source and
 * evaluated in the page's own realm (`page`, a vm context holding only the
 * page's globals). Proves the function closes over nothing in its module.
 */
export const runInjected = (
  func: InjectedFunction,
  args: ReadonlyArray<string>,
  page: vm.Context = vm.createContext({}),
  // oxlint-disable-next-line typescript/no-explicit-any -- whatever the injected function returned in the page
): any => {
  const compiled: (...values: ReadonlyArray<string>) => JsonValue = vm.runInContext(`(${func.toString()})`, page);

  return compiled(...args);
};

/** Sends the popup's message the way Safari delivers it, and waits for the answer. */
export const askPopup = (event: FakeEvent<PopupListener>, message: PopupRequest) => {
  let answer: (reply: PopupReply) => void = () => {};

  const reply = new Promise<PopupReply>((resolve) => {
    answer = resolve;
  });

  const [staysOpen] = event.fire(message, {}, answer);

  return { staysOpen, reply };
};

const running: Array<BackgroundHarness> = [];

/**
 * Starts the background against `api` and remembers it, so `stopAll` can
 * dispose of it after the test. `request` is bound so a test can pass it around.
 */
export const launch = (api: FakeBrowser, options?: Parameters<typeof startBackground>[1]) => {
  const harness = startBackground(api, options);

  running.push(harness);

  return {
    harness,
    request: (action: string, params?: ContentParams) => harness.request(action, params),
  };
};

/** Disposes of every background `launch` started. For `afterEach`. */
export const stopAll = async (): Promise<void> => {
  await Promise.all(running.splice(0).map((harness) => harness.dispose()));
};
