// The WebExtension API, as a service so tests can hand in their own.

import { Context, Effect, Layer } from "effect";
import type BrowserApi from "webextension-polyfill";
import { fromUnknown, type ToolError } from "./errors.ts";

export class Browser extends Context.Service<Browser, BrowserApi.Browser>()("mcpsafari/background/Browser") {
  /** Safari's own `browser` global. */
  static readonly layer = Layer.sync(Browser, () => browser);
}

/**
 * One call into the browser. A rejection becomes a `ToolError` carrying the
 * browser's own message, which is what the agent has always been shown.
 */
export const callBrowser = <A>(call: (api: BrowserApi.Browser) => Promise<A>): Effect.Effect<A, ToolError, Browser> =>
  Browser.use((api) => Effect.tryPromise({ try: () => call(api), catch: fromUnknown }));
