// Reading a tool's parameters off a bridge request.

import { Effect, Schema } from "effect";
import type { ContentParams } from "../../shared/protocol.ts";
import { invalidInput, type ToolError } from "../errors.ts";

/**
 * Decodes the fields a background handler reads. The server has already
 * validated them against the tool's input schema, so a failure here means the
 * two sides disagree about the contract, and the agent is told what is wrong.
 */
export const decodeParams =
  <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  (params: ContentParams): Effect.Effect<S["Type"], ToolError> =>
    // The fields arrive untyped off the wire: the generic record type says
    // nothing about the shape each tool's schema checks for.
    // @effect-diagnostics-next-line preferTypedSchemaDecoder:off
    Schema.decodeUnknownEffect(schema)(params).pipe(Effect.mapError((error) => invalidInput(error.message)));

/** `tabId`, the target every tab-touching tool accepts. Absent means the active or pinned tab. */
export const TabTarget = Schema.Struct({ tabId: Schema.optionalKey(Schema.Int) });
