import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Plain paths rather than file URLs: under the happy-dom environment `URL` is
// the DOM's, which node:fs does not accept.
const DIST_EXTENSION = resolve(import.meta.dirname, "../../dist/extension");

const DIST_APP = resolve(import.meta.dirname, "../../dist/app");

const RESOURCES = resolve(import.meta.dirname, "../../../MCPSafari/MCPSafari Extension/Resources");

/** A bundled extension script exactly as Safari loads it. Run `pnpm exec tsdown` first; `pnpm test` does. */
export const builtScript = (file: string): string => readFileSync(resolve(DIST_EXTENSION, file), "utf8");

/** A bundled host-app script. */
export const builtAppScript = (file: string): string => readFileSync(resolve(DIST_APP, file), "utf8");

/** A static file shipped with the extension (manifest, popup markup). */
export const extensionResource = (file: string): string => readFileSync(resolve(RESOURCES, file), "utf8");
