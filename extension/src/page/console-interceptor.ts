/**
 * MCPSafari Console Interceptor
 *
 * Patches console methods to capture messages for the read_console tool.
 * Injected at document_start before page scripts run.
 */

import { errorText, onContentMessage, postReply } from "./channel.ts";
import { compileRestrictedFilter, removeReturned } from "./filters.ts";
import type { ConsoleLevel, ConsoleMessage, ConsoleParams } from "./window.ts";

interface CapturedText {
  readonly text: string;
  readonly truncated: boolean;
}

const LEVELS: ReadonlyArray<ConsoleLevel> = ["log", "warn", "error", "info", "debug"];

function installConsoleInterceptor(): void {
  const MAX_MESSAGES = 1000;
  const messages: Array<ConsoleMessage> = [];
  const MAX_TEXT = 8192;

  const MAX_ERROR_STACK = 2048;

  // JSON.stringify has nothing to say about an Error (its fields are not
  // enumerable, so it writes `{}`), which turned `console.error(err)` and every
  // unhandled rejection into an empty message. The tag test rather than
  // `instanceof` because the error may come from another realm, a frame's own.
  function isError(value: unknown): value is Error {
    if (value instanceof Error) return true;

    const tag = Object.prototype.toString.call(value);

    return tag === "[object Error]" || tag === "[object DOMException]";
  }

  // Safari's `stack` is frames only, Chrome's opens with the message, so the
  // header is added when it is missing and not repeated when it is there.
  function describeError(error: Error, markCut: () => void): string {
    const name = String(error.name || "Error");
    const message = String(error.message ?? "");
    const header = (message ? `${name}: ${message}` : name).slice(0, 1024);
    const stack = typeof error.stack === "string" ? error.stack : "";
    const frames = (stack.startsWith(header) ? stack.slice(header.length) : stack).replace(/^\n/, "");

    if (frames.length > MAX_ERROR_STACK) markCut();

    return frames ? `${header}\n${frames.slice(0, MAX_ERROR_STACK)}` : header;
  }

  // What JSON would drop or throw on, written as a console would show it so a
  // reader sees that something was there: a function, a symbol, a BigInt, an
  // Error, at the top or nested in an object.
  function describeNonJson(item: unknown, markCut: () => void) {
    if (typeof item === "function") return item.name ? `[Function: ${item.name}]` : "[Function (anonymous)]";

    if (typeof item === "symbol") return item.toString();

    if (typeof item === "bigint") return `${item}n`;

    if (isError(item)) return describeError(item, markCut);

    return item;
  }

  function captureText(args: ReadonlyArray<unknown>): CapturedText {
    let truncated = args.length > 16;
    let visits = 0;

    const markCut = (): void => {
      truncated = true;
    };

    const parts = args.slice(0, 16).map((value) => {
      try {
        if (typeof value === "string") {
          if (value.length > MAX_TEXT) truncated = true;

          return value.slice(0, MAX_TEXT);
        }

        // JSON.stringify(undefined) is undefined, which join() would render as
        // nothing at all.
        if (value === undefined) return "undefined";

        const plain = describeNonJson(value, markCut);

        if (typeof plain === "string") return plain;

        // What is left is an object, a number, a boolean or null, which JSON
        // always writes; the replacer names what it cannot inside them.
        return JSON.stringify(plain, (_key, item: unknown) => {
          if (++visits > 128) throw new Error("capture budget");

          if (typeof item === "string" && item.length > 512) {
            truncated = true;

            return item.slice(0, 512);
          }

          return describeNonJson(item, markCut);
        });
      } catch {
        truncated = true;

        return "[unserializable or oversized value]";
      }
    });

    const text = parts.join(" ");

    return { text: text.slice(0, MAX_TEXT), truncated: truncated || text.length > MAX_TEXT };
  }

  function recordTraceEvent(level: ConsoleLevel, text: string, timestamp: number): void {
    try {
      if (typeof window.__mcpRecordTraceEvent === "function") {
        window.__mcpRecordTraceEvent(
          `console.${level}`,
          {
            level,
            message: text,
          },
          timestamp,
        );
      }
    } catch {
      /* trace capture must not affect console behavior */
    }
  }

  for (const level of LEVELS) {
    const original = console[level].bind(console);
    console[level] = (...args: ReadonlyArray<unknown>) => {
      // Call the original
      original(...args);

      // Capture the message
      if (messages.length >= MAX_MESSAGES) {
        messages.shift();
      }

      const message: ConsoleMessage = {
        level,
        timestamp: Date.now(),
        ...captureText(args),
      };

      messages.push(message);
      recordTraceEvent(level, message.text, message.timestamp);
    };
  }

  // Capture unhandled errors
  window.addEventListener("error", (event) => {
    if (messages.length >= MAX_MESSAGES) messages.shift();

    const message: ConsoleMessage = {
      level: "error",
      timestamp: Date.now(),
      ...captureText([`Uncaught ${event.error ? event.error.stack || event.error.message : event.message}`]),
    };

    messages.push(message);
    recordTraceEvent("error", message.text, message.timestamp);
  });

  // Capture unhandled promise rejections
  window.addEventListener("unhandledrejection", (event) => {
    if (messages.length >= MAX_MESSAGES) messages.shift();

    const message: ConsoleMessage = {
      level: "error",
      timestamp: Date.now(),
      ...captureText(["Unhandled Promise Rejection:", event.reason]),
    };

    messages.push(message);
    recordTraceEvent("error", message.text, message.timestamp);
  });

  // API for content script to read messages
  window.__mcpGetConsoleMessages = (params: ConsoleParams = {}) => {
    let filtered = [...messages];

    if (params.level && params.level !== "all") {
      filtered = filtered.filter((m) => m.level === params.level);
    }

    if (params.pattern) {
      const regex = compileRestrictedFilter(params.pattern);
      filtered = filtered.filter((entry) => regex.test(entry.text));
    }

    if (params.clear) {
      // Clear exactly what this call returned, so a level- or pattern-filtered
      // read never discards messages the caller never saw.
      removeReturned(messages, filtered);
    }

    return filtered;
  };

  onContentMessage<ConsoleParams>((message) => {
    if (message.type !== "get_console_messages") return;

    try {
      postReply(message.id, { data: window.__mcpGetConsoleMessages(message.params || {}) });
    } catch (error) {
      postReply(message.id, { error: errorText(error) });
    }
  });
}

if (!window.__mcpConsoleInterceptorLoaded) {
  window.__mcpConsoleInterceptorLoaded = true;
  installConsoleInterceptor();
}
