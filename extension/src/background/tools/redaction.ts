// Keeping credentials in URLs out of what the agent is shown.

import { Predicate } from "effect";
import type { JsonValue } from "../../shared/protocol.ts";

// Credentials are redacted from a URL before it leaves the extension, wherever
// the URL turns up: tab listings, captured requests, trace events, link hrefs.
// A presigned download or an OAuth callback carries its credential in the query
// or fragment, and userinfo (`https://user:pw@host`) carries one in the
// authority.
//
// A parameter name is judged by its words, not by an exact list. Spelled out as
// a list it missed `auth_token`, `csrf_token`, `oauth_verifier` and anything
// else nobody had thought of; matched as a bare substring it would take
// `design` for `sig`. The name is percent-decoded first (`%74oken` is `token`),
// split on separators and camelCase (`X-Goog-Signature`, `accessToken`), and
// redacted when any word is one of SECRET_NAME_WORDS.
//
// Names that describe a secret rather than carrying one stay readable, which is
// what the last word is for: `token_type=bearer` and `password_hint=cat` are
// the token's type and a hint, and an agent shown `[redacted]` for either
// learns nothing. `code` is only treated as an OAuth code next to `state`;
// alone it is usually a SKU or coupon.
const SECRET_NAME_WORDS: ReadonlySet<string> = new Set([
  "token",
  "secret",
  "key",
  "sig",
  "signature",
  "password",
  "passwd",
  "pwd",
  "passcode",
  "auth",
  "authorization",
  "session",
  "sid",
  "jwt",
  "otp",
  "ticket",
  "verifier",
  "credential",
  "credentials",
]);

// Joined words ending in one of these are caught too, for names run together
// (`accesstoken`, `clientsecret`). Short words are left out on purpose: `key`
// would take `monkey`.
const SECRET_NAME_SUFFIXES = [
  "token",
  "secret",
  "password",
  "passwd",
  "signature",
  "apikey",
  "sessionid",
  "credential",
  "credentials",
];

const DESCRIPTIVE_LAST_WORDS: ReadonlySet<string> = new Set([
  "type",
  "hint",
  "length",
  "expires",
  "expiry",
  "ttl",
  "algorithm",
  "alg",
  "format",
  "endpoint",
  "url",
  "uri",
  "count",
  "name",
  "method",
]);

const USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i;

const urlNameWords = (name: string): Array<string> => {
  let decoded = name;

  try {
    decoded = decodeURIComponent(name.replace(/\+/g, " "));
  } catch {
    /* a malformed escape is matched as written */
  }

  return decoded
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
};

const isSecretUrlName = (words: ReadonlyArray<string>): boolean => {
  const last = words.at(-1);

  if (last === undefined) return false;

  if (words.length > 1 && DESCRIPTIVE_LAST_WORDS.has(last)) return false;

  const joined = words.join("");

  return (
    words.some((word) => SECRET_NAME_WORDS.has(word)) || SECRET_NAME_SUFFIXES.some((suffix) => joined.endsWith(suffix))
  );
};

const isOnly = (words: ReadonlyArray<string>, word: string) => words.length === 1 && words[0] === word;

export const redactUrlSecrets = (url: string | undefined): string => {
  if (!url) return "";

  const noUserinfo = url.replace(USERINFO, "$1[redacted]@");
  // Only the query and fragment carry parameters; `&` is legal in a path.
  const start = noUserinfo.search(/[?#]/);

  if (start === -1) return noUserinfo;

  const tail = noUserinfo.slice(start);

  // A name follows `?`, `&` or `#`, so a hash-routed callback (`#/cb?code=x`)
  // is read the same as a plain query.
  const parameter = /([?&#])([^=&#?]*)=/g;

  const hasState =
    [...tail.matchAll(parameter)].some((match) => isOnly(urlNameWords(match[2] ?? ""), "state")) ||
    // `state` with no value (`&state`) is still the OAuth state.
    /[?&#]state(?=[&#]|$)/i.test(tail);

  let redacted = "";
  let copied = 0;

  for (let match = parameter.exec(tail); match !== null; match = parameter.exec(tail)) {
    const words = urlNameWords(match[2] ?? "");
    const isCode = hasState && isOnly(words, "code");

    if (!isSecretUrlName(words) && !isCode) continue;

    // The value ends at the next separator. Scanning on from there, rather
    // than from the end of the name, keeps a `?token=` nested inside an
    // earlier parameter's value (`?next=/cb?token=x`) in view.
    const valueStart = parameter.lastIndex;
    const rest = tail.slice(valueStart).search(/[&#]/);
    const valueEnd = rest === -1 ? tail.length : valueStart + rest;

    redacted += `${tail.slice(copied, valueStart)}[redacted]`;
    copied = valueEnd;
    parameter.lastIndex = valueEnd;
  }

  return noUserinfo.slice(0, start) + redacted + tail.slice(copied);
};

// ─── URLs inside page data ───────────────────────────────────────────
//
// Redacted here, on the way out, with the one implementation tab listings use.
// The scripts that capture them run in the page's world, where a page could
// tamper with any copy of this, so the capture reports URLs as they were and
// this is the last stop before they leave the extension.
//
// Every result is a fresh structured clone that nothing else holds, so these
// edit in place. A value of an unexpected shape is returned untouched: the page
// can send anything, and refusing to answer would be a worse outcome than an
// unredacted field the content script already bounded.

type PageData = JsonValue | undefined;

type PageRecord = { readonly [field: string]: JsonValue };

const isPageRecord = (value: PageData): value is PageRecord => Predicate.isObject(value) && !Array.isArray(value);

/** A record of page data is a fresh clone nothing else holds, so it may be edited in place. */
const editable = (record: PageRecord): { [field: string]: JsonValue } => record;

const redactFields = (entry: PageData, fields: ReadonlyArray<string>) => {
  if (!isPageRecord(entry)) return;

  const record = editable(entry);

  for (const field of fields) {
    const value = record[field];

    if (Predicate.isString(value)) record[field] = redactUrlSecrets(value);
  }
};

const redactEachUrl = (entries: PageData, fields: ReadonlyArray<string>) => {
  if (!Array.isArray(entries)) return;

  for (const entry of entries) redactFields(entry, fields);
};

const redactSnapshotLinks = (node: PageData) => {
  const pending: Array<PageData> = [node];

  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (!isPageRecord(current)) continue;

    redactFields(current, ["href"]);

    const children = current["children"];

    if (Array.isArray(children)) pending.push(...children);
  }
};

const redactTrace = (trace: PageData) => {
  redactFields(trace, ["startUrl", "endUrl"]);

  // `url` on network and history events, `from` and `to` on URL changes.
  if (isPageRecord(trace)) redactEachUrl(trace["events"], ["url", "from", "to"]);
};

const redactRequestUrls = (requests: PageData) => redactEachUrl(requests, ["url"]);

const RESULT_REDACTORS: ReadonlyMap<string, (data: PageData) => void> = new Map([
  ["read_network", redactRequestUrls],
  ["get_network_requests", redactRequestUrls],
  ["stop_trace", redactTrace],
  ["snapshot", redactSnapshotLinks],
  ["read_page", redactSnapshotLinks],
]);

/** Page data with the URLs it carries redacted, for the actions whose results carry any. */
export const redactResult = (action: string, data: PageData): PageData => {
  RESULT_REDACTORS.get(action)?.(data);

  return data;
};
