// The background page's entry point.

import { Layer, ManagedRuntime } from "effect";
import { Browser } from "./Browser.ts";
import { BackgroundLayer, registerListeners, startup } from "./background.ts";

const runtime = ManagedRuntime.make(BackgroundLayer.pipe(Layer.provideMerge(Browser.layer)));

registerListeners(browser, runtime);

runtime.runFork(startup);
