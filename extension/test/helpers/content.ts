// Shared plumbing for the content-script tests: the bundle as Safari loads it,
// and the types of what crosses its runtime.onMessage boundary.

import type { Runtime } from "webextension-polyfill";

import type { ContentParams } from "../../src/shared/protocol.ts";
import { builtScript } from "./sources.ts";

/** The content-script bundle exactly as the manifest injects it. */
export const contentSource = (): string => builtScript("content.js");

/**
 * A content-script reply as the tests read it. `data` stays loose on purpose:
 * each test reaches into whatever its action returned, and the assertions are
 * what check it.
 */
export interface ContentReply {
  // oxlint-disable-next-line typescript/no-explicit-any -- tests reach into each action's own result
  readonly data: any;
  readonly error: string | null;
  readonly errorCode?: string;
  readonly retryable?: boolean;
  readonly recoveryAction?: string;
}

/** A request as the background sends it. */
export interface ContentMessage {
  readonly action: string;
  readonly params: ContentParams;
  readonly frameId?: number;
}

/** The listener the bundle registers with browser.runtime.onMessage. */
export type RuntimeListener = (
  message: ContentMessage,
  sender: Runtime.MessageSender,
  sendResponse: (reply: ContentReply) => void,
) => boolean;

/** Sends one action to a registered listener and resolves with its reply. */
export type CallContent = (action: string, params: ContentParams) => Promise<ContentReply>;

/** A `browser` stub that hands the registered listener to `onListener`. */
export function browserStub(onListener: (listener: RuntimeListener) => void) {
  return { runtime: { onMessage: { addListener: onListener } } };
}

/** A `call` that routes through whichever listener `current` returns. */
export function callThrough(current: () => RuntimeListener | undefined): CallContent {
  return (action, params) =>
    new Promise((resolve) => {
      const listener = current();

      if (!listener) throw new Error("the content script registered no listener");
      listener({ action, params }, {}, resolve);
    });
}

/** Every event-init field the content script passes that some test reads back. */
export interface FakeEventInit {
  readonly bubbles?: boolean;
  readonly cancelable?: boolean;
  readonly clientX?: number;
  readonly clientY?: number;
  readonly button?: number;
  readonly buttons?: number;
  readonly pointerType?: string;
  readonly key?: string;
  readonly code?: string;
  readonly inputType?: string;
  readonly data?: string | null;
  readonly dataTransfer?: FakeDataTransferLike;
}

/** What the drop tests read off an event's dataTransfer. */
export interface FakeDataTransferLike {
  readonly files: ReadonlyArray<File>;
}

/**
 * Stands in for every DOM event constructor the content script uses: the
 * type plus whatever options it was built with, nothing else.
 */
export class FakeEvent {
  declare readonly bubbles?: boolean;
  declare readonly cancelable?: boolean;
  declare readonly clientX?: number;
  declare readonly clientY?: number;
  declare readonly button?: number;
  declare readonly buttons?: number;
  declare readonly pointerType?: string;
  declare readonly key?: string;
  declare readonly code?: string;
  declare readonly inputType?: string;
  declare readonly data?: string | null;
  declare readonly dataTransfer?: FakeDataTransferLike;
  readonly type: string;

  constructor(type: string, options: FakeEventInit = {}) {
    this.type = type;
    Object.assign(this, options);
  }
}
