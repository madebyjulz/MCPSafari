// Functions the background hands to `scripting.executeScript`. Safari
// serialises each one with `Function.prototype.toString` and runs it in the
// page, so none of them may close over anything in this module, call a helper,
// or rely on a bundler-provided runtime. They run with nothing but the
// language and the DOM, which is also why they inspect values directly.

/**
 * Injected into the tab to prove it can be reached at all. Named rather than
 * inline so a caller reading a trace can tell a probe from real work.
 */
export function probeTabAccess(): boolean {
  return true;
}

/** What the page reported about itself at capture time. */
export interface PageContext {
  readonly visible?: boolean;
  readonly hasFocus?: boolean;
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly devicePixelRatio?: number;
}

/**
 * Injected into the page, so it must not close over anything here.
 */
export function readPageContext(): PageContext {
  return {
    visible: document.visibilityState === "visible",
    hasFocus: document.hasFocus(),
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
    },
    devicePixelRatio: window.devicePixelRatio,
  };
}

/** Navigates the page's session history from inside it. */
export function goBack(): void {
  history.back();
}

export function goForward(): void {
  history.forward();
}

/**
 * What `evaluateUserCode` hands back: always this envelope, never the caller's
 * value on its own. Read off the value itself, an object the code returned
 * with an `__error` key was taken for a failure and one with `__cspBlocked`
 * was run a second time.
 */
export type Evaluation =
  | { readonly ok: true; readonly value?: unknown }
  | {
      readonly ok: false;
      readonly error: string;
      /** The code was refused before any of it ran, so another world may run it. */
      readonly cspBlocked?: true;
    };

// Injected into the target world, so it must not close over anything here.
export function evaluateUserCode(code: string): Promise<Evaluation> | Evaluation {
  // Whatever was thrown, as text: its message when it has one.
  const describe = (e: unknown): string =>
    // oxlint-disable-next-line typescript/no-base-to-string -- a thrown value can be anything the page threw
    e && typeof e === "object" && "message" in e && e.message ? String(e.message) : String(e);

  let fn: () => Promise<unknown>;

  // Compiling only. A page whose script-src omits 'unsafe-eval' refuses to
  // compile a string in its own realm, which is what new Function does here,
  // and a refusal at this stage means none of the code has run.
  try {
    const expressionCode = String(code).trim().replace(/;+$/, "");

    try {
      // SAFETY: the source compiled is an async arrow called at once, so the
      // function returns a promise.
      // oxlint-disable-next-line typescript/no-implied-eval -- evaluating the caller's code is this tool's purpose
      fn = new Function(`return (async () => (${expressionCode}))()`) as () => Promise<unknown>;
    } catch (e) {
      // A syntax error means it is not a bare expression; a CSP refusal
      // means neither form will compile, so do not retry it as one.
      if (typeof EvalError !== "undefined" && e instanceof EvalError) {
        return { ok: false, error: describe(e), cspBlocked: true };
      }

      // SAFETY: as above.
      // oxlint-disable-next-line typescript/no-implied-eval -- as above
      fn = new Function(`return (async () => { ${code} })()`) as () => Promise<unknown>;
    }
  } catch (e) {
    const message = describe(e);

    const blocked =
      (typeof EvalError !== "undefined" && e instanceof EvalError) ||
      /unsafe-eval|trusted-types-eval|Content Security Policy/i.test(message);

    return blocked ? { ok: false, error: message, cspBlocked: true } : { ok: false, error: message };
  }

  // Running. The code may have had effects by the time anything is thrown, so
  // nothing from here on is a CSP refusal, whatever its message says: one would
  // send the code to the isolated world to run a second time.
  try {
    return fn().then(
      (value): Evaluation => ({ ok: true, value }),
      (e: unknown): Evaluation => ({ ok: false, error: describe(e) }),
    );
  } catch (e) {
    return { ok: false, error: describe(e) };
  }
}
