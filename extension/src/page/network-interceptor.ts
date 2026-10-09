/**
 * MCPSafari Network Interceptor
 *
 * Captures XMLHttpRequest, fetch, and resource timings for the
 * read_network tool. Injected at document_start.
 */

import { errorText, onContentMessage, postReply } from "./channel.ts";
import { compileRestrictedFilter, removeReturned } from "./filters.ts";
import type { NetworkEntry, NetworkParams, NetworkRecord, RequestRecord, ResourceRecord, XhrMeta } from "./window.ts";

/** The optional arguments of XMLHttpRequest.open after the method and URL. */
type OpenRest = [async?: boolean, username?: string | null, password?: string | null];

type OpenFunction = (this: XMLHttpRequest, method: string, url: string | URL, ...rest: OpenRest) => void;

function installNetworkInterceptor(): void {
  const MAX_REQUESTS = 500;
  const requests: Array<RequestRecord> = [];
  const resources: Array<ResourceRecord> = [];

  function boundRecord<Entry extends NetworkRecord>(record: Entry): Entry {
    const fields: NetworkRecord = record;

    for (const key of Object.keys(fields)) {
      const value = fields[key];

      if (typeof value === "string" && value.length > 2048) {
        fields[key] = value.slice(0, 2048);
        fields.truncated = true;
      }
    }

    return record;
  }

  function recordTraceEvent(type: "xhr" | "fetch", request: RequestRecord): void {
    try {
      if (typeof window.__mcpRecordTraceEvent === "function") {
        window.__mcpRecordTraceEvent(
          `network.${type}`,
          {
            method: request.method,
            url: request.url,
            status: request.status,
            statusText: request.statusText,
            duration: request.duration,
            error: request.error,
          },
          request.timestamp,
        );
      }
    } catch {
      /* trace capture must not affect network behavior */
    }
  }

  // Cross-origin entries without Timing-Allow-Origin report zeroed byte counts;
  // mark them so zeros read as "not permitted", not "cache hit". `duration` is
  // deliberately not part of the test: the spec leaves startTime and responseEnd
  // readable for these entries, so a restricted resource still times normally.
  function isTimingRestricted(entry: PerformanceResourceTiming): boolean {
    try {
      if (new URL(entry.name).origin === location.origin) return false;
    } catch {
      return false;
    }

    return entry.transferSize === 0 && entry.encodedBodySize === 0 && entry.decodedBodySize === 0;
  }

  function recordResources(entries: PerformanceEntryList): void {
    for (const performanceEntry of entries) {
      // SAFETY: the only observer feeding this is registered for type
      // "resource", whose entries are all PerformanceResourceTiming.
      const entry = performanceEntry as PerformanceResourceTiming;

      if (resources.length >= MAX_REQUESTS) resources.shift();

      const record: ResourceRecord = {
        type: "resource",
        url: entry.name,
        initiatorType: entry.initiatorType,
        transferSize: entry.transferSize,
        encodedBodySize: entry.encodedBodySize,
        decodedBodySize: entry.decodedBodySize,
        startTime: entry.startTime,
        duration: entry.duration,
        timestamp: performance.timeOrigin + entry.startTime,
      };

      if (isTimingRestricted(entry)) record.timingRestricted = true;
      resources.push(boundRecord(record));
    }
  }

  // Resource timing is an opt-in extra, so it must not be able to take the
  // XHR and fetch patching below down with it if the observer is unavailable.
  let resourceObserver: PerformanceObserver | null = null;

  try {
    resourceObserver = new PerformanceObserver((list) => recordResources(list.getEntries()));
    resourceObserver.observe({ type: "resource", buffered: true });
  } catch {
    resourceObserver = null;
  }

  // ─── XMLHttpRequest Interception ─────────────────────────────────

  // oxlint-disable-next-line typescript/unbound-method -- kept to be called later with the patched call's own `this`.
  const XHROpen: OpenFunction = XMLHttpRequest.prototype.open;
  // oxlint-disable-next-line typescript/unbound-method -- kept to be called later with the patched call's own `this`.
  const XHRSend = XMLHttpRequest.prototype.send;

  /** One send() of a request: what open() set up for it, and when it began. */
  interface XhrCycle {
    readonly meta: XhrMeta;
    readonly startTime: number;
  }

  // Each request's sends still waiting for loadend, oldest first. A request
  // can be re-opened and sent again before the previous send's loadend has
  // fired, so each send keeps its own method, URL and start time rather than
  // reading whatever open() set last. Kept off the request, out of the page's
  // reach.
  const pendingCycles = new WeakMap<XMLHttpRequest, Array<XhrCycle>>();

  function recordXhr(xhr: XMLHttpRequest): void {
    const cycle = pendingCycles.get(xhr)?.shift();

    if (!cycle) return;

    if (requests.length >= MAX_REQUESTS) requests.shift();

    const request: RequestRecord = {
      type: "xhr",
      method: cycle.meta.method,
      url: cycle.meta.url,
      truncated: cycle.meta.truncated,
      status: xhr.status,
      statusText: xhr.statusText,
      duration: Date.now() - cycle.startTime,
      responseSize:
        xhr.responseType === "" || xhr.responseType === "text" || xhr.responseType == null
          ? (xhr.responseText?.length ?? 0)
          : null,
      timestamp: cycle.startTime,
    };

    requests.push(boundRecord(request));
    recordTraceEvent("xhr", request);
  }

  XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...args: OpenRest
  ) {
    // open() ends an unfinished request without firing loadend, so its send
    // will never complete. A finished one (readyState DONE: re-opened from a
    // load or readystatechange handler) still fires its loadend afterwards.
    const unfinished = this.readyState !== 4;
    const result = XHROpen.call(this, method, url, ...args);

    if (unfinished) pendingCycles.get(this)?.splice(0);

    this.__mcpMeta = {
      method: method.toUpperCase(),
      url: String(url).slice(0, 2048),
      truncated: String(url).length > 2048,
      type: "xhr",
    };

    return result;
  };

  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const meta = this.__mcpMeta;

    if (!meta) return XHRSend.call(this, body);

    let pending = pendingCycles.get(this);

    if (!pending) {
      pending = [];
      pendingCycles.set(this, pending);
      // One listener per request, however often it is reused: each loadend
      // completes the oldest send still pending.
      this.addEventListener("loadend", () => recordXhr(this));
    }

    const cycle: XhrCycle = { meta, startTime: Date.now() };
    pending.push(cycle);

    try {
      return XHRSend.call(this, body);
    } catch (error) {
      // A send() that throws (wrong state, or a failed synchronous request)
      // fires no loadend.
      const index = pending.indexOf(cycle);

      if (index !== -1) pending.splice(index, 1);

      throw error;
    }
  };

  // ─── Fetch Interception ──────────────────────────────────────────

  const originalFetch = window.fetch;

  window.fetch = async function (this: Window, input: RequestInfo | URL, init?: RequestInit | null) {
    let method = "GET";
    let url = "";

    // Native fetch accepts a null init, and takes the method from a Request
    // unless init names one. Describing the call must never break one the
    // native fetch accepts, so a failure here only costs the record its detail.
    try {
      const request = input instanceof Request ? input : null;
      method = (init?.method || request?.method || "GET").toUpperCase();
      url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    } catch {
      /* recorded with what is known */
    }

    const startTime = Date.now();

    try {
      // SAFETY: init is passed on exactly as the page gave it; native fetch
      // treats null as it does an omitted init.
      const response = await originalFetch.call(this, input, init as RequestInit | undefined);

      if (requests.length >= MAX_REQUESTS) requests.shift();

      const request: RequestRecord = {
        type: "fetch",
        method,
        url,
        status: response.status,
        statusText: response.statusText,
        duration: Date.now() - startTime,
        timestamp: startTime,
      };

      requests.push(boundRecord(request));
      recordTraceEvent("fetch", request);

      return response;
    } catch (err) {
      if (requests.length >= MAX_REQUESTS) requests.shift();

      const request: RequestRecord = {
        type: "fetch",
        method,
        url,
        status: 0,
        statusText: "Network Error",
        duration: Date.now() - startTime,
        timestamp: startTime,
        error: errorText(err),
      };

      requests.push(boundRecord(request));
      recordTraceEvent("fetch", request);
      throw err;
    }
  };

  // ─── API for content script ──────────────────────────────────────

  window.__mcpGetNetworkRequests = (params: NetworkParams = {}) => {
    if (resourceObserver) recordResources(resourceObserver.takeRecords());

    const selected: Array<NetworkEntry> = params.type === "resource" ? resources : requests;
    let filtered = [...selected];

    if (params.type && params.type !== "all") {
      filtered = filtered.filter((r) => r.type === params.type);
    }

    if (params.urlPattern) {
      const regex = compileRestrictedFilter(params.urlPattern);
      filtered = filtered.filter((entry) => regex.test(entry.url));
    }

    if (params.status != null) {
      filtered = filtered.filter((r) => r.status === params.status);
    }

    const maxResults = params.maxResults;

    if (maxResults !== undefined && maxResults > 0) {
      filtered = filtered.slice(-maxResults);
    }

    if (params.clear) {
      // Clear exactly what this call returned, so a filtered read
      // never discards entries the caller never saw.
      removeReturned(selected, filtered);
    }

    return filtered;
  };

  onContentMessage<NetworkParams>((message) => {
    if (message.type !== "get_network_requests") return;

    try {
      postReply(message.id, { data: window.__mcpGetNetworkRequests(message.params || {}) });
    } catch (error) {
      postReply(message.id, { error: errorText(error) });
    }
  });
}

if (!window.__mcpNetworkInterceptorLoaded) {
  window.__mcpNetworkInterceptorLoaded = true;
  installNetworkInterceptor();
}
