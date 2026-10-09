// Answering the popup: connection status, port management, and whether the
// site the user is looking at can be reached.

import { Effect, Option } from "effect";
import type { PopupRequest, SiteAccess } from "../shared/popup.ts";
import { MAX_PORT, MIN_PORT } from "./config.ts";
import { Connections } from "./Connections.ts";
import { SelectedTab } from "./SelectedTab.ts";
import { TabAccess } from "./TabAccess.ts";

/**
 * Whether MCPSafari can reach whatever the user is looking at.
 *
 * Opening the popup is the right moment to find this out, and the right moment
 * for Safari to ask if it has not already: the user is looking straight at
 * MCPSafari, so a dialog about MCPSafari makes sense. The alternative is what
 * happens otherwise, which is the question surfacing mid-task, in a dialog that
 * can be behind another window, while an agent waits on it.
 */
export const describeActiveTabAccess = Effect.fn("describeActiveTabAccess")(function* () {
  const tabAccess = yield* TabAccess;
  const tabId = yield* (yield* SelectedTab).activeTabId.pipe(Effect.option);

  if (Option.isNone(tabId)) return { origin: null, allowed: false, pending: false } satisfies SiteAccess;

  const origin = yield* tabAccess.originOfTab(tabId.value);

  return yield* tabAccess.ensure(tabId.value).pipe(
    Effect.as<SiteAccess>({ origin, allowed: true, pending: false }),
    Effect.catch((error) =>
      Effect.succeed<SiteAccess>({ origin, allowed: false, pending: error.permissionPending === true }),
    ),
  );
});

/**
 * The reply to one popup request. Work the popup does not wait for (loading
 * tokens before connecting a port) runs on after the reply.
 */
export const answerPopup = Effect.fn("answerPopup")(function* (request: PopupRequest) {
  const connections = yield* Connections;

  switch (request.type) {
    case "getStatus":
      return { ports: yield* connections.statuses };

    case "refreshConnections":
      yield* connections.loadAuthTokens;
      yield* connections.reconnectKnownPorts;

      return { ports: yield* connections.statuses };

    case "tabAccess":
      return yield* describeActiveTabAccess();

    case "addPort": {
      const port = Math.trunc(request.port);

      if (port >= MIN_PORT && port <= MAX_PORT) {
        yield* connections.ensurePort(port, true);
        yield* Effect.forkDetach(Effect.andThen(connections.loadAuthTokens, connections.connectToPort(port)));
      }

      return { ok: true } as const;
    }

    case "removePort": {
      const port = Math.trunc(request.port);

      yield* connections.disconnectPort(port);
      yield* connections.removeManualPort(port);

      return { ok: true } as const;
    }

    case "reconnect": {
      // Reconnect a specific port, or only disconnected ports if no port specified
      if (request.port) {
        const port = Math.trunc(request.port);

        yield* connections.reconnectPort(port);
        yield* Effect.forkDetach(Effect.andThen(connections.loadAuthTokens, connections.connectToPort(port)));
      } else {
        yield* Effect.forkDetach(Effect.andThen(connections.loadAuthTokens, connections.reconnectKnownPorts));
      }

      return { ok: true } as const;
    }
  }
});
