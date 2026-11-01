import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const ComputerUseConfig = Schema.Struct({
  enabled: Schema.Boolean,
  command: TrimmedNonEmptyString,
  providerInstanceIds: Schema.Array(ProviderInstanceId),
  allowedApps: Schema.Array(TrimmedNonEmptyString),
});
export type ComputerUseConfig = typeof ComputerUseConfig.Type;
export const ComputerUseProfilePolicy = Schema.Struct({
  enabled: Schema.Boolean,
  allowedApps: Schema.Array(TrimmedNonEmptyString),
  drivers: Schema.Array(TrimmedNonEmptyString),
});
export const ComputerLease = Schema.Struct({
  id: Schema.String,
  owner: Schema.String,
  label: Schema.String,
  expiresAt: Schema.Number,
  appPid: Schema.Int,
  windowId: Schema.Int,
  bundleId: Schema.String,
});
export type ComputerLease = typeof ComputerLease.Type;
export const ComputerUseState = Schema.Struct({
  config: ComputerUseConfig,
  lease: Schema.NullOr(ComputerLease),
  readiness: Schema.Literals([
    "disabled",
    "needs-install",
    "needs-permission",
    "ready",
    "unavailable",
  ]),
  message: Schema.String,
});
export const ComputerAction = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("click"), x: Schema.Number, y: Schema.Number }),
  Schema.Struct({
    kind: Schema.Literal("type"),
    text: Schema.String.check(Schema.isMaxLength(8000)),
  }),
  Schema.Struct({
    kind: Schema.Literal("key"),
    key: Schema.String.check(Schema.isMaxLength(128)),
    modifiers: Schema.optionalKey(
      Schema.Array(Schema.Literals(["cmd", "ctrl", "alt", "shift", "fn"])),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("scroll"),
    x: Schema.Number,
    y: Schema.Number,
    direction: Schema.Literals(["up", "down", "left", "right"]),
    amount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
  }),
]);
export const ComputerDriverResult = Schema.Struct({
  content: Schema.Array(
    Schema.Union([
      Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
      Schema.Struct({
        type: Schema.Literal("image"),
        data: Schema.String,
        mimeType: Schema.String,
      }),
    ]),
  ),
  isError: Schema.optionalKey(Schema.Boolean),
});
export const ComputerUseCommand = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("configure"), config: ComputerUseConfig }),
  Schema.Struct({ operation: Schema.Literal("release") }),
  Schema.Struct({ operation: Schema.Literal("inherit") }),
]);
export class ComputerUseError extends Schema.TaggedError<ComputerUseError>()("ComputerUseError", {
  reason: Schema.Literals([
    "disabled",
    "denied",
    "busy",
    "expired",
    "unavailable",
    "driver",
    "storage",
    "unsupported-version",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "disabled":
        return "Computer use is disabled on this environment.";
      case "denied":
        return "This caller or app is not allowed to use this desktop.";
      case "busy":
        return "Another thread currently controls this desktop. Wait or release it in Settings.";
      case "expired":
        return "This desktop lease expired or was released. Acquire a new lease.";
      case "unavailable":
        return "Cua Driver or its desktop session is unavailable. Check installation and OS permissions.";
      case "driver":
        return "Cua Driver could not complete the operation.";
      case "storage":
        return "Desktop settings could not be saved or read.";
      case "unsupported-version":
        return "This computer-use integration requires Cua Driver 0.38 or newer.";
    }
  }
}
