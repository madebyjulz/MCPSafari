/**
 * MCPSafari File Drop
 *
 * Dispatches drop_file drag events from the page's world. Page listeners see
 * their own wrappers for a DataTransfer built in the content script's
 * isolated world, so item fixes made there never reach them. Safari mints a
 * FileSystemFileEntry for an in-memory File whose file() rejects with
 * NotFoundError, so each item's webkitGetAsEntry is replaced with an entry
 * that resolves the File from getAsFile().
 *
 * Injected at document_start before page scripts run.
 */

import { errorText, onContentMessage, postReply, type PageReply } from "./channel.ts";
import type { DropParams, DropResult } from "./window.ts";

/** A file entry whose file() answers with the item's own File instead of rejecting. */
interface ReadableFileEntry {
  readonly isFile: true;
  readonly isDirectory: false;
  readonly name: string;
  readonly fullPath: string;
  readonly filesystem: FileSystem;
  file(onSuccess: (file: File | null) => void): void;
  getParent(onSuccess: (entry: FileSystemDirectoryEntry) => void): void;
}

function installFileDrop(): void {
  function readableEntry(item: DataTransferItem): FileSystemEntry | ReadableFileEntry | null {
    if (typeof item.webkitGetAsEntry !== "function") return null;

    const entry = item.webkitGetAsEntry();

    if (!entry || !entry.isFile) return entry;

    const file = item.getAsFile();

    return {
      isFile: true,
      isDirectory: false,
      name: entry.name,
      fullPath: entry.fullPath,
      filesystem: entry.filesystem,
      file(onSuccess: (file: File | null) => void) {
        onSuccess(file);
      },
      getParent(onSuccess: (entry: FileSystemDirectoryEntry) => void) {
        onSuccess(entry.filesystem.root);
      },
    };
  }

  // document.querySelector sees a single tree, so a drop zone inside a web
  // component's shadow root would be missed; every open root is searched
  // instead. Closed roots stay unreachable, as they are to the content script.
  // The marker is compared as text, never spliced into a selector.
  function markedTarget(marker: string): Element | null {
    const roots: Array<Document | ShadowRoot> = [document];

    // Roots found along the way are appended, and the loop reaches them too.
    for (const root of roots) {
      for (const element of root.querySelectorAll("*")) {
        if (element.getAttribute("data-mcp-drop-target") === marker) return element;

        if (element.shadowRoot) roots.push(element.shadowRoot);
      }
    }

    return null;
  }

  function dropFiles(params: DropParams): DropResult {
    const target = markedTarget(params.marker);

    if (!target) throw new Error("Drop target not found in page");

    const dataTransfer = new DataTransfer();

    for (const file of params.files) dataTransfer.items.add(file);

    for (const item of dataTransfer.items) {
      try {
        const entry = readableEntry(item);
        Object.defineProperty(item, "webkitGetAsEntry", { configurable: true, value: () => entry });
      } catch {
        // Leave the native entry in place; the drop still carries the files.
      }
    }

    target.scrollIntoView({ behavior: "instant", block: "center" });
    const rect = target.getBoundingClientRect();

    const baseOpts: DragEventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      dataTransfer,
    };

    for (const type of ["dragenter", "dragover", "drop"]) {
      target.dispatchEvent(new DragEvent(type, baseOpts));
    }

    return { dropped: params.files.length };
  }

  onContentMessage<DropParams>((message) => {
    if (message.type !== "drop_files") return;

    let reply: PageReply<DropResult>;

    try {
      // SAFETY: a request without params reaches dropFiles as `{}`, whose
      // missing fields fail inside the try and are reported as the error.
      reply = { data: dropFiles(message.params || ({} as DropParams)) };
    } catch (error) {
      reply = { error: errorText(error) };
    }

    postReply(message.id, reply);
  });
}

if (!window.__mcpFileDropLoaded) {
  window.__mcpFileDropLoaded = true;
  installFileDrop();
}
