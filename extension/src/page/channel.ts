// The page-world end of the channel to the content script. The content script
// posts a request on this window; each page-world script answers the request
// types it owns with a reply carrying the same id.
//
// Bundled into each page-world script on its own, so it installs nothing when
// imported: a script calls onContentMessage itself, at the point in its setup
// where the original listener was added.

import { CONTENT_MESSAGE_SOURCE, PAGE_MESSAGE_SOURCE, type PageRequestType } from "../shared/protocol.ts";

/** A request from the content script, as it arrives in the page world. */
export interface ContentMessage<Params> {
  readonly source: typeof CONTENT_MESSAGE_SOURCE;
  readonly id: string;
  readonly type: PageRequestType;
  readonly params?: Params | null;
}

/** A page-world answer: the result, or why there is none. */
export type PageReply<Data> = { readonly data: Data } | { readonly error: string };

/** Calls `handle` for every message the content script posts to this window, whatever its type. */
export function onContentMessage<Params>(handle: (message: ContentMessage<Params>) => void): void {
  window.addEventListener("message", (event) => {
    const message: ContentMessage<Params> | null | undefined = event.data;

    if (event.source !== window || message?.source !== CONTENT_MESSAGE_SOURCE) return;

    handle(message);
  });
}

/** Answers the request `id`. */
export function postReply<Data>(id: string, reply: PageReply<Data>): void {
  window.postMessage({ source: PAGE_MESSAGE_SOURCE, id, ...reply }, "*");
}

/**
 * The error text a failed request reports: the error's message, or the thrown
 * value itself. Never empty and never throws, whatever page code threw: the
 * content script reads a missing or empty `error` as success.
 */
export function errorText(cause: unknown): string {
  try {
    // SAFETY: only `.message` is read, through optional chaining, so null and
    // undefined fall through to their own string form.
    const text = String((cause as { readonly message?: unknown } | null | undefined)?.message || cause);

    if (text) return text;
  } catch {
    // A message getter or toString that throws leaves only the fallback.
  }

  return "Page script failed without an error message";
}
