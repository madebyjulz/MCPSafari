// What the popup asks the background, and what it hears back. Shared by both
// sides; the background decodes every message with these schemas.

import { Schema } from "effect";

// A port as the popup's input or a row's data attribute yields it. Range is
// checked by the background, which ignores ports out of range but still answers.
const Port = Schema.Finite;

export const PopupRequest = Schema.Union([
  Schema.Struct({ type: Schema.Literal("getStatus") }),
  Schema.Struct({ type: Schema.Literal("refreshConnections") }),
  Schema.Struct({ type: Schema.Literal("tabAccess") }),
  Schema.Struct({ type: Schema.Literal("addPort"), port: Port }),
  Schema.Struct({ type: Schema.Literal("removePort"), port: Port }),
  /** Reconnects one port, or with no port every port that is not connected. */
  Schema.Struct({ type: Schema.Literal("reconnect"), port: Schema.optionalKey(Port) }),
]);

export type PopupRequest = typeof PopupRequest.Type;

export const ConnectionState = Schema.Literals(["disconnected", "connecting", "connected"]);

export const PortStatus = Schema.Struct({
  port: Schema.Int,
  state: ConnectionState,
  manual: Schema.Boolean,
});

export type PortStatus = typeof PortStatus.Type;

export const StatusReply = Schema.Struct({ ports: Schema.Array(PortStatus) });

export type StatusReply = typeof StatusReply.Type;

/** Whether MCPSafari can reach whatever the user is looking at. */
export const SiteAccess = Schema.Struct({
  origin: Schema.NullOr(Schema.String),
  allowed: Schema.Boolean,
  /** Safari is showing its permission dialog for this site right now. */
  pending: Schema.Boolean,
});

export type SiteAccess = typeof SiteAccess.Type;

export const OkReply = Schema.Struct({ ok: Schema.Literal(true) });
