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
        // SAFETY: the timestamp is passed through unchanged; it is null only
        // for an XHR re-opened before loadend, which the recorder has always
        // received as-is.
        window.__mcpRecordTraceEvent(
          `network.${type}`,
          {
            type,
            method: request.method,
            url: request.url,
            status: request.status,
            statusText: request.statusText,
            duration: request.duration,
            error: request.error,
          },
          request.timestamp as number,
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

  XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...args: OpenRest
  ) {
    this.__mcpMeta = {
      method: method.toUpperCase(),
      url: String(url).slice(0, 2048),
      truncated: String(url).length > 2048,
      type: "xhr",
      startTime: null,
    };

    return XHROpen.call(this, method, url, ...args);
  };

  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    if (this.__mcpMeta) {
      this.__mcpMeta.startTime = Date.now();

      this.addEventListener("loadend", () => {
        if (requests.length >= MAX_REQUESTS) requests.shift();

        // SAFETY: send() only listens for loadend on a request open() has
        // tagged, and open() always replaces the tag rather than removing it.
        const meta = this.__mcpMeta as XhrMeta;

        const request: RequestRecord = {
          type: "xhr",
          method: meta.method,
          url: meta.url,
          truncated: meta.truncated,
          status: this.status,
          statusText: this.statusText,
          // SAFETY: send() stamped startTime just before listening; a request
          // re-opened since then has null here, which subtracts as 0 exactly as
          // it did in the hand-written script.
          duration: Date.now() - (meta.startTime as number),
          responseSize:
            this.responseType === "" || this.responseType === "text" || this.responseType == null
              ? (this.responseText?.length ?? 0)
              : null,
          timestamp: meta.startTime,
        };

        requests.push(boundRecord(request));
        recordTraceEvent("xhr", request);
      });
    }

    return XHRSend.call(this, body);
  };

  // ─── Fetch Interception ──────────────────────────────────────────

  const originalFetch = window.fetch;

  window.fetch = async function (this: Window, input: RequestInfo | URL, init: RequestInit = {}) {
    const method = (init.method || "GET").toUpperCase();
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    const startTime = Date.now();

    try {
      const response = await originalFetch.call(this, input, init);

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
