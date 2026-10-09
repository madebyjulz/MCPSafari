/**
 * MCPSafari Trace Interceptor
 *
 * Captures a short window of page activity for action debugging.
 * Injected in the page's main world so history and network/console patches
 * observe the same JavaScript objects as page code.
 */

import { errorText, onContentMessage, postReply } from "./channel.ts";
import type { TraceDetail, TraceEvent, TraceParams, TraceStop, TraceValue } from "./window.ts";

interface Trace {
  readonly id: string;
  readonly startTime: number;
  readonly startUrl: string;
  readonly events: Array<TraceEvent>;
  readonly eventTypes: ReadonlySet<string> | null;
  truncated: boolean;
}

type MutationDetail = {
  readonly mutationType: MutationRecordType;
  readonly selector: string | null;
  attribute?: string | null;
  oldValue?: string;
  value?: TraceValue;
  added?: number;
  removed?: number;
};

function installTraceInterceptor(): void {
  const MAX_EVENTS = 1000;
  const URL_POLL_MS = 100;
  const traces = new Map<string, Trace>();
  let traceCounter = 0;
  let urlTimer: ReturnType<typeof setInterval> | null = null;
  let lastUrl = location.href;
  let domObserver: MutationObserver | null = null;

  function now(): number {
    return Date.now();
  }

  function escapeCss(value: string): string {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(value);
    }

    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function isElement(node: Node): node is Element {
    return node.nodeType === Node.ELEMENT_NODE;
  }

  function selectorFor(node: Node | null): string | null {
    if (!node || !isElement(node)) return null;

    if (node.id) return `#${escapeCss(node.id)}`;

    const parts: Array<string> = [];
    let current: Element | null = node;

    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 5) {
      const element: Element = current;
      let part = element.tagName.toLowerCase();
      const classes = Array.from(element.classList || []).slice(0, 2);

      if (classes.length > 0) {
        part += classes.map((name) => `.${escapeCss(name)}`).join("");
      }

      const parent = element.parentElement;

      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.tagName === element.tagName);

        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(element) + 1})`;
        }
      }

      parts.unshift(part);
      current = parent;
    }

    return parts.join(" > ");
  }

  function pushEvent(trace: Trace, type: string, detail: TraceDetail = {}, at: number = now()): void {
    if (trace.eventTypes && !trace.eventTypes.has(type)) return;

    if (trace.events.length >= MAX_EVENTS) {
      if (!trace.truncated) {
        trace.truncated = true;
        trace.events.push({
          type: "trace.truncated",
          at,
          offset: at - trace.startTime,
          limit: MAX_EVENTS,
        });
      }

      return;
    }

    trace.events.push({
      type,
      at,
      offset: at - trace.startTime,
      ...detail,
    });
  }

  function recordTraceEvent(type: string, detail: TraceDetail = {}, at: number = now()): void {
    if (traces.size === 0) return;

    for (const trace of traces.values()) {
      pushEvent(trace, type, detail, at);
    }
  }

  window.__mcpRecordTraceEvent = recordTraceEvent;

  function recordUrlChange(type: string, from: string, to: string, detail: TraceDetail = {}): void {
    if (!from || !to || from === to) return;

    const at = now();
    recordTraceEvent("url", { from, to, reason: type }, at);
    recordTraceEvent(type, { from, to, url: to, ...detail }, at);
    lastUrl = to;
  }

  function ensureUrlMonitor(): void {
    if (urlTimer !== null) return;

    urlTimer = setInterval(() => {
      if (traces.size === 0) {
        // SAFETY: this callback only runs while its own interval is installed,
        // and urlTimer holds that interval until it is cleared.
        clearInterval(urlTimer as ReturnType<typeof setInterval>);
        urlTimer = null;

        return;
      }

      const currentUrl = location.href;
      recordUrlChange("url.poll", lastUrl, currentUrl);
    }, URL_POLL_MS);
  }

  function ensureDomObserver(): void {
    if (domObserver || !document.documentElement) return;

    domObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        const detail: MutationDetail = {
          mutationType: mutation.type,
          selector: selectorFor(mutation.target),
        };

        if (mutation.type === "attributes") {
          detail.attribute = mutation.attributeName;

          if (mutation.oldValue !== null) detail.oldValue = mutation.oldValue;
          // SAFETY: an "attributes" record always targets an Element and names the attribute.
          detail.value = (mutation.target as Element).getAttribute(mutation.attributeName as string);
        } else if (mutation.type === "childList") {
          detail.added = mutation.addedNodes.length;
          detail.removed = mutation.removedNodes.length;
        }

        recordTraceEvent("dom.mutation", detail);
      }
    });

    domObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeOldValue: true,
    });
  }

  function cleanupIfIdle(): void {
    if (traces.size > 0) return;

    if (urlTimer !== null) {
      clearInterval(urlTimer);
      urlTimer = null;
    }

    if (domObserver) {
      domObserver.disconnect();
      domObserver = null;
    }
  }

  // oxlint-disable-next-line typescript/unbound-method -- kept to be called later with the patched call's own `this`.
  const originalPushState = history.pushState;
  // oxlint-disable-next-line typescript/unbound-method -- kept to be called later with the patched call's own `this`.
  const originalReplaceState = history.replaceState;

  history.pushState = function (this: History, ...args: Parameters<History["pushState"]>) {
    const from = location.href;
    const result = originalPushState.apply(this, args);
    recordUrlChange("history.pushState", from, location.href);

    return result;
  };

  history.replaceState = function (this: History, ...args: Parameters<History["replaceState"]>) {
    const from = location.href;
    const result = originalReplaceState.apply(this, args);
    recordUrlChange("history.replaceState", from, location.href);

    return result;
  };

  window.addEventListener("popstate", () => {
    recordUrlChange("popstate", lastUrl, location.href);
  });

  window.addEventListener("hashchange", (event) => {
    recordUrlChange("hashchange", event.oldURL || lastUrl, event.newURL || location.href);
  });

  window.__mcpStartTrace = (params: TraceParams = {}) => {
    const startTime = now();
    const id = params.id || `trace-${startTime}-${++traceCounter}`;

    const trace: Trace = {
      id,
      startTime,
      startUrl: location.href,
      events: [],
      eventTypes: Array.isArray(params.eventTypes) ? new Set(params.eventTypes) : null,
      truncated: false,
    };

    traces.set(id, trace);
    lastUrl = location.href;
    ensureUrlMonitor();
    ensureDomObserver();
    pushEvent(trace, "trace.start", { url: trace.startUrl }, startTime);

    return { id, startTime, url: trace.startUrl };
  };

  window.__mcpStopTrace = (params: TraceParams = {}): TraceStop => {
    const id = params.id;
    // SAFETY: a request without an id looks up `undefined`, which finds no
    // trace and takes the "not found" branch below.
    const trace = traces.get(id as string);

    if (!trace) {
      return {
        id,
        startTime: null,
        endTime: now(),
        durationMs: 0,
        startUrl: null,
        endUrl: location.href,
        truncated: false,
        events: [],
        error: "Trace not found. The page may have navigated or reloaded.",
      };
    }

    const endTime = now();
    pushEvent(trace, "trace.stop", { url: location.href }, endTime);
    // SAFETY: a trace was found under this id, so it is the string it was stored under.
    traces.delete(id as string);
    cleanupIfIdle();

    return {
      id: trace.id,
      startTime: trace.startTime,
      endTime,
      durationMs: endTime - trace.startTime,
      startUrl: trace.startUrl,
      endUrl: location.href,
      truncated: trace.truncated,
      events: trace.events,
    };
  };

  onContentMessage<TraceParams>((message) => {
    if (message.type !== "start_trace" && message.type !== "stop_trace") return;

    try {
      const data =
        message.type === "start_trace"
          ? window.__mcpStartTrace(message.params || {})
          : window.__mcpStopTrace(message.params || {});

      postReply(message.id, { data });
    } catch (err) {
      postReply(message.id, { error: errorText(err) });
    }
  });
}

if (!window.__mcpTraceInterceptorLoaded) {
  window.__mcpTraceInterceptorLoaded = true;
  installTraceInterceptor();
}
