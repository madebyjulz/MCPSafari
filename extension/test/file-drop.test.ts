import assert from "node:assert/strict";
import vm from "node:vm";
import { type Document, type Element, type ShadowRoot, Window as HappyWindow } from "happy-dom";
import { test } from "vitest";

import type { DropParams } from "../src/page/window.ts";
import { builtScript } from "./helpers/sources.ts";

const source = builtScript("file-drop.js");

interface FakeDirectory {
  readonly isDirectory: true;
  readonly fullPath: string;
}

interface FakeEntry {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly name: string;
  readonly fullPath: string;
  readonly filesystem: { readonly root: FakeDirectory };
  file(onSuccess: (file: File) => void, onError: (error: Error) => void): void;
  getParent(onSuccess: (entry: FakeDirectory) => void, onError: (error: Error) => void): void;
}

type EntryFor = (file: File) => FakeEntry | null;

interface FakeItem {
  readonly kind: "file";
  getAsFile(): File;
  webkitGetAsEntry(): FakeEntry | null;
}

interface FakeItemList extends Array<FakeItem> {
  add?: (file: File) => void;
}

// Safari mints an entry for an in-memory File whose file() rejects, which is
// the behavior the script papers over.
function brokenEntry(file: File): FakeEntry {
  return {
    isFile: true,
    isDirectory: false,
    name: file.name,
    fullPath: `/${file.name}`,
    filesystem: { root: { isDirectory: true, fullPath: "/" } },
    file(_onSuccess, onError) {
      onError(new Error("NotFoundError: Path does not exist"));
    },
    getParent(_onSuccess, onError) {
      onError(new Error("NotFoundError: Path does not exist"));
    },
  };
}

class FakeDataTransfer {
  readonly items: FakeItemList;

  constructor(entryFor: EntryFor = brokenEntry) {
    this.items = [];
    this.items.add = (file) => {
      this.items.push({
        kind: "file",
        getAsFile: () => file,
        webkitGetAsEntry: () => entryFor(file),
      });
    };
  }

  get files(): Array<File> {
    return this.items.map((item) => item.getAsFile());
  }
}

interface FakeEventInit {
  readonly bubbles?: boolean;
  readonly cancelable?: boolean;
  readonly clientX?: number;
  readonly clientY?: number;
  readonly dataTransfer?: FakeDataTransfer;
}

class FakeEvent {
  readonly type: string;
  declare readonly clientX?: number;
  declare readonly clientY?: number;
  declare readonly dataTransfer?: FakeDataTransfer;

  constructor(type: string, options: FakeEventInit = {}) {
    this.type = type;
    Object.assign(this, options);
  }
}

interface FakeTarget {
  readonly events: Array<FakeEvent>;
}

/** A fresh page for the drop to search. */
function newPage(): Document {
  return new HappyWindow().document;
}

/**
 * Adds a drop zone marked with `marker` under `parent`, as the content script
 * marks one, that records the events dispatched on it.
 */
function placeTarget(parent: Element | ShadowRoot, marker = "marker-1"): FakeTarget {
  const element = parent.ownerDocument.createElement("div");
  element.setAttribute("data-mcp-drop-target", marker);
  parent.appendChild(element);

  const events: Array<FakeEvent> = [];

  Object.assign(element, {
    scrollIntoView() {},
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 50 }),
    dispatchEvent(event: FakeEvent) {
      events.push(event);

      return true;
    },
  });

  return { events };
}

/** The `index`th event the target received; a missing one throws, as reading a field off it would. */
function eventAt(target: FakeTarget, index: number): FakeEvent {
  const event = target.events[index];

  if (event === undefined) throw new TypeError(`no event at index ${index}`);

  return event;
}

/** The `index`th item of a dropped DataTransfer; a missing one throws, as calling a method on it would. */
function itemAt(dataTransfer: FakeDataTransfer | undefined, index: number): FakeItem {
  const item = dataTransfer?.items[index];

  if (item === undefined) throw new TypeError(`no item at index ${index}`);

  return item;
}

interface PageReply {
  readonly source: string;
  readonly id: string;
  readonly data?: { readonly dropped: number };
  readonly error?: string;
}

interface StubMessageEvent {
  readonly source: StubWindow;
  readonly data: {
    readonly source: string;
    readonly id: string;
    readonly type: string;
    readonly params: Partial<DropParams>;
  };
}

interface StubWindow {
  addEventListener(type: string, listener: (event: StubMessageEvent) => void): void;
  postMessage(message: PageReply): void;
}

interface LoadOptions {
  readonly document: Document;
  readonly DataTransfer?: new () => FakeDataTransfer;
}

// Loads file-drop.js into `document` and returns a function that posts a
// bridge request and resolves with the page's reply.
function loadFileDrop({
  document,
  DataTransfer = FakeDataTransfer,
}: LoadOptions): (params: Partial<DropParams>) => PageReply {
  let onMessage: ((event: StubMessageEvent) => void) | undefined;
  const replies: Array<PageReply> = [];

  const window: StubWindow = {
    addEventListener: (_type, fn) => {
      onMessage = fn;
    },
    postMessage: (message) => replies.push(message),
  };

  vm.runInNewContext(source, {
    window,
    document,
    DataTransfer,
    DragEvent: FakeEvent,
  });

  return (params) => {
    onMessage?.({ source: window, data: { source: "MCPSafariContent", id: "req", type: "drop_files", params } });
    const reply = replies.pop();

    if (reply === undefined) throw new TypeError("the page posted no reply");

    return reply;
  };
}

const PNG = new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" });

const TXT = new File(["hi"], "note.txt", { type: "text/plain" });

test("drop dispatches dragenter, dragover, drop with entries that resolve the files", async () => {
  const page = newPage();
  const target = placeTarget(page.body);
  const request = loadFileDrop({ document: page });

  const reply = request({ marker: "marker-1", files: [PNG, TXT] });

  assert.equal(reply.source, "MCPSafariPage");
  assert.equal(reply.id, "req");
  assert.equal(reply.error, undefined);
  assert.equal(reply.data?.dropped, 2);
  assert.deepEqual(
    target.events.map((event) => event.type),
    ["dragenter", "dragover", "drop"],
  );
  const { dataTransfer } = eventAt(target, 2);
  assert.equal(eventAt(target, 2).clientX, 60);
  assert.equal(eventAt(target, 2).clientY, 45);
  assert.deepEqual(
    dataTransfer?.files.map((file) => file.name),
    ["shot.png", "note.txt"],
  );

  for (const [index, item] of (dataTransfer?.items ?? []).entries()) {
    const entry = item.webkitGetAsEntry();
    assert.equal(entry?.isFile, true);
    assert.equal(entry?.isDirectory, false);
    assert.equal(entry?.name, dataTransfer?.files[index]?.name);
    assert.equal(entry?.fullPath, `/${entry?.name}`);
    const file = await new Promise<File>((resolve, reject) => entry?.file(resolve, reject));
    assert.equal(file, dataTransfer?.files[index]);
    const parent = await new Promise<FakeDirectory>((resolve, reject) => entry?.getParent(resolve, reject));
    assert.equal(parent, entry?.filesystem.root);
  }
});

test("drop still dispatches when the native entry API throws", () => {
  const page = newPage();
  const target = placeTarget(page.body);

  class ThrowingDataTransfer extends FakeDataTransfer {
    constructor() {
      super(() => {
        throw new Error("entry unavailable");
      });
    }
  }

  const request = loadFileDrop({ document: page, DataTransfer: ThrowingDataTransfer });

  const reply = request({ marker: "marker-1", files: [PNG] });

  assert.equal(reply.data?.dropped, 1);
  assert.deepEqual(
    target.events.map((event) => event.type),
    ["dragenter", "dragover", "drop"],
  );
  assert.throws(() => itemAt(eventAt(target, 2).dataTransfer, 0).webkitGetAsEntry(), /entry unavailable/);
});

test("drop leaves a null entry alone", () => {
  const page = newPage();
  const target = placeTarget(page.body);

  class NullEntryDataTransfer extends FakeDataTransfer {
    constructor() {
      super(() => null);
    }
  }

  const request = loadFileDrop({ document: page, DataTransfer: NullEntryDataTransfer });

  request({ marker: "marker-1", files: [PNG] });

  assert.equal(itemAt(eventAt(target, 2).dataTransfer, 0).webkitGetAsEntry(), null);
});

test("drop reports a missing target instead of dispatching", () => {
  const page = newPage();
  const target = placeTarget(page.body);
  const request = loadFileDrop({ document: page });

  const reply = request({ marker: "other", files: [PNG] });

  assert.equal(reply.error, "Drop target not found in page");
  assert.equal(target.events.length, 0);
});

test("drop finds a target inside nested open shadow roots", () => {
  const page = newPage();
  const outerHost = page.createElement("div");
  page.body.appendChild(outerHost);
  const innerHost = page.createElement("div");
  outerHost.attachShadow({ mode: "open" }).appendChild(innerHost);
  const target = placeTarget(innerHost.attachShadow({ mode: "open" }));
  const request = loadFileDrop({ document: page });

  const reply = request({ marker: "marker-1", files: [PNG] });

  assert.equal(reply.error, undefined);
  assert.equal(reply.data?.dropped, 1);
  assert.deepEqual(
    target.events.map((event) => event.type),
    ["dragenter", "dragover", "drop"],
  );
});

test("a marker is matched as text, never parsed as a selector", () => {
  const page = newPage();
  const decoy = placeTarget(page.body, "decoy");
  const quoted = placeTarget(page.body, 'say "hi"');
  const request = loadFileDrop({ document: page });

  const injected = request({ marker: 'nope"],[data-mcp-drop-target="decoy', files: [PNG] });

  assert.equal(injected.error, "Drop target not found in page");
  assert.equal(decoy.events.length, 0);

  assert.equal(request({ marker: 'say "hi"', files: [PNG] }).data?.dropped, 1);
  assert.equal(quoted.events.length, 3);
});

test("a thrown non-Error is still reported as a string error", () => {
  const page = newPage();
  placeTarget(page.body);

  for (const thrown of ["transfer refused", undefined, null]) {
    class RefusingDataTransfer extends FakeDataTransfer {
      constructor() {
        super();
        throw thrown;
      }
    }

    const reply = loadFileDrop({ document: page, DataTransfer: RefusingDataTransfer })({
      marker: "marker-1",
      files: [PNG],
    });

    assert.equal(reply.data, undefined);
    assert.equal(typeof reply.error, "string");
    assert.notEqual(reply.error, "");
  }
});
