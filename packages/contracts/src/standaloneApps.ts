import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const AppId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9.-]{0,99}$/));
export const StandaloneAppDefinition = Schema.Struct({
  id: AppId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  keywords: Schema.Array(Schema.String.check(Schema.isMaxLength(100))).check(
    Schema.isMaxLength(20),
  ),
  command: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  args: Schema.Array(Schema.String.check(Schema.isMaxLength(4096))).check(Schema.isMaxLength(32)),
  resourceUri: Schema.String.check(Schema.isPattern(/^ui:\/\//)),
  readTools: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(200))).check(
    Schema.isMaxLength(100),
  ),
  writeTools: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(200))).check(
    Schema.isMaxLength(100),
  ),
});
export type StandaloneAppDefinition = typeof StandaloneAppDefinition.Type;
export const StandaloneAppSummary = Schema.Struct({
  id: AppId,
  title: Schema.String,
  keywords: Schema.Array(Schema.String.check(Schema.isMaxLength(100))).check(
    Schema.isMaxLength(20),
  ),
});
export const StandaloneAppTarget = Schema.Struct({ appId: AppId });
export const StandaloneAppToolInput = Schema.Struct({
  appId: AppId,
  name: TrimmedNonEmptyString,
  arguments: Schema.Record(Schema.String, Schema.Unknown),
});
export const StandaloneAppOpenResult = Schema.Struct({
  writeTools: Schema.Array(Schema.String),
  readTools: Schema.Array(Schema.String),
  html: Schema.String,
  resourceUri: Schema.String,
});
export class StandaloneAppError extends Schema.TaggedError<StandaloneAppError>()(
  "StandaloneAppError",
  {
    message: Schema.String,
  },
) {}

export type StandaloneAppOpenResult = typeof StandaloneAppOpenResult.Type;
