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

  function captureText(args: ReadonlyArray<unknown>): CapturedText {
    let truncated = args.length > 16;
    let visits = 0;

    const parts = args.slice(0, 16).map((value) => {
      try {
        if (typeof value === "string") {
          if (value.length > MAX_TEXT) truncated = true;

          return value.slice(0, MAX_TEXT);
        }

        return JSON.stringify(value, (_key, item) => {
          if (++visits > 128) throw new Error("capture budget");

          if (typeof item === "string" && item.length > 512) {
            truncated = true;

            return item.slice(0, 512);
          }

          return item;
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
