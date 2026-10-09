// The toolbar popup: which servers are connected, and whether the site in
// front of the user can be reached.

import { Duration, Effect, Fiber, FiberSet, Schedule, Schema } from "effect";
import { OkReply, SiteAccess, StatusReply, type PopupRequest } from "../shared/popup.ts";
import { connectionsMarkup, siteAccessMarkup } from "./render.ts";

const POLL_INTERVAL = Duration.seconds(1);

class PopupError extends Schema.TaggedError<PopupError>()("PopupError", { cause: Schema.Defect() }) {}

/** Asks the background something and decodes its answer. */
const ask = <S extends Schema.ConstraintDecoder<unknown>>(request: PopupRequest, reply: S) =>
  Effect.tryPromise({
    try: () => browser.runtime.sendMessage(request).then(Schema.decodeUnknownPromise(reply)),
    catch: (cause) => new PopupError({ cause }),
  });

const element = (id: string): HTMLElement => {
  const found = document.getElementById(id);

  if (!found) throw new Error(`popup.html has no #${id}`);

  return found;
};

/** Starts an effect from a DOM event handler, tied to the popup's lifetime. */
type Run = (effect: Effect.Effect<void>) => void;

const renderConnections = (status: StatusReply, run: Run) =>
  Effect.sync(() => {
    const container = element("connections");

    container.innerHTML = connectionsMarkup(status.ports);

    for (const button of container.querySelectorAll<HTMLButtonElement>(".btn-reconnect")) {
      button.addEventListener("click", () => {
        run(
          ask({ type: "reconnect", port: parseInt(button.dataset["port"] ?? "", 10) }, OkReply).pipe(
            Effect.andThen(Effect.sleep(Duration.seconds(1))),
            Effect.andThen(refresh(run)),
            Effect.ignore,
          ),
        );
      });
    }

    for (const button of container.querySelectorAll<HTMLButtonElement>(".btn-remove")) {
      button.addEventListener("click", () => {
        run(
          ask({ type: "removePort", port: parseInt(button.dataset["port"] ?? "", 10) }, OkReply).pipe(
            Effect.andThen(refresh(run)),
            Effect.ignore,
          ),
        );
      });
    }
  });

const refresh = (run: Run): Effect.Effect<void> =>
  ask({ type: "getStatus" }, StatusReply).pipe(
    Effect.flatMap((status) => renderConnections(status, run)),
    Effect.catch(() =>
      Effect.sync(() => {
        element("connections").textContent = "Could not reach the extension. Reopen the popup to try again.";
      }),
    ),
  );

const refreshSite = ask({ type: "tabAccess" }, SiteAccess).pipe(
  Effect.flatMap((access) =>
    Effect.sync(() => {
      element("site").innerHTML = siteAccessMarkup(access);
    }),
  ),
  Effect.catch(() =>
    Effect.sync(() => {
      element("site").textContent = "Could not check website access. Reopen the popup to try again.";
    }),
  ),
);

// The extension may not be ready yet; the poll that follows catches up.
const refreshConnections = (run: Run) =>
  ask({ type: "refreshConnections" }, StatusReply).pipe(
    Effect.flatMap((status) => renderConnections(status, run)),
    Effect.ignore,
  );

const addPort = Effect.fn("addPort")(function* (run: Run) {
  const input = element("port-input");

  if (!(input instanceof HTMLInputElement)) return;

  const port = parseInt(input.value, 10);

  if (port >= 1024 && port <= 65535) {
    yield* ask({ type: "addPort", port }, OkReply).pipe(Effect.ignore);
    input.value = "";
    yield* Effect.sleep(Duration.millis(500));
    yield* refresh(run);
  }
});

/** Everything the popup does while it is open. */
const popup = Effect.gen(function* () {
  const run: Run = yield* FiberSet.makeRuntime();

  element("version").textContent = `v${browser.runtime.getManifest().version}`;

  // Not awaited alongside the connection refresh: this one can sit for a
  // couple of seconds behind Safari's dialog, and the ports should paint
  // straight away rather than waiting on it. Each poll runs on its own, so a
  // site check stuck behind the dialog never holds up the connection list.
  yield* Effect.forkChild(refreshSite.pipe(Effect.repeat(Schedule.spaced(POLL_INTERVAL))));
  yield* refreshConnections(run);
  yield* Effect.forkChild(refresh(run).pipe(Effect.repeat(Schedule.spaced(POLL_INTERVAL))));

  element("add-btn").addEventListener("click", () => run(addPort(run)));

  return yield* Effect.never;
}).pipe(Effect.scoped);

document.addEventListener("DOMContentLoaded", () => {
  const fiber = Effect.runFork(popup);

  window.addEventListener("unload", () => {
    Effect.runFork(Fiber.interrupt(fiber));
  });
});
