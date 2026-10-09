import type Browser from "webextension-polyfill";

declare global {
  /** Safari exposes the promise-based WebExtension API as `browser`. */
  const browser: Browser.Browser;

  /** The host app's WKWebView bridge (MCPSafari/ViewController.swift). */
  const webkit: {
    readonly messageHandlers: {
      readonly controller: { postMessage(message: string): void };
    };
  };
}

export {};
