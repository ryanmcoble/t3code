import {
  SharedProjectContentState,
  SharedProjectContentConflictPage,
  SharedProjectContentConflictInput,
  SharedProjectContentCommand,
  SharedProjectContentStateInput,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";
import { projectLocationFlags } from "./config.ts";
import { withLocalMcpTools, reportLocalMcpErrors } from "./localMcpTools.ts";

const decodeStateInput = Schema.decodeEffect(SharedProjectContentStateInput);
const decodeConflictInput = Schema.decodeEffect(SharedProjectContentConflictInput);
const decodeCommand = Schema.decodeEffect(SharedProjectContentCommand);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const printJson = (value: unknown) => encodeJson(value).pipe(Effect.flatMap(Console.log));
const targetFlags = {
  ...projectLocationFlags,
  environmentId: Flag.String("environment").pipe(
    Flag.optional,
    Flag.withDescription("Linked environment ID; defaults to the local server."),
  ),
  sharedProjectId: Argument.String("shared-project-id"),
};
const rootFlags = { ...targetFlags, rootId: Argument.String("root-id") };
const target = (value: Option.Option<string>) =>
  Option.isSome(value) ? { environmentId: value.value } : {};

const status = Command.make("status", targetFlags).pipe(
  Command.withDescription(
    "Read saved file preparation status as JSON. This does not establish execution readiness.",
  ),
  Command.withHandler((flags) =>
    withLocalMcpTools(flags, (tools) =>
      Effect.gen(function* () {
        const query = yield* decodeStateInput({
          sharedProjectId: flags.sharedProjectId,
        });
        const result = yield* tools.call(
          "t3_shared_project_files",
          { ...target(flags.environmentId), query: { operation: "state", ...query } },
          SharedProjectContentState,
        );
        yield* printJson(result);
      }),
    ).pipe(reportLocalMcpErrors),
  ),
);
const conflicts = Command.make("conflicts", {
  ...rootFlags,
  cursor: Flag.Int("cursor").pipe(Flag.withDefault(0)),
}).pipe(
  Command.withDescription("Read up to 64 saved conflict paths and their generation as JSON."),
  Command.withHandler((flags) =>
    withLocalMcpTools(flags, (tools) =>
      Effect.gen(function* () {
        const query = yield* decodeConflictInput({
          sharedProjectId: flags.sharedProjectId,
          rootId: flags.rootId,
          cursor: flags.cursor,
        });
        const result = yield* tools.call(
          "t3_shared_project_files",
          { ...target(flags.environmentId), query: { operation: "conflicts", ...query } },
          SharedProjectContentConflictPage,
        );
        yield* printJson(result);
      }),
    ).pipe(reportLocalMcpErrors),
  ),
);
const refresh = Command.make("refresh", rootFlags).pipe(
  Command.withDescription(
    "Check and apply an enabled file-folder subscription, preserving local edits and conflicts.",
  ),
  Command.withHandler((flags) =>
    withLocalMcpTools(flags, (tools) =>
      Effect.gen(function* () {
        const command = yield* decodeCommand({
          operation: "refresh",
          sharedProjectId: flags.sharedProjectId,
          rootId: flags.rootId,
        });
        const result = yield* tools.call(
          "t3_shared_project_files_prepare",
          { ...target(flags.environmentId), command },
          SharedProjectContentState,
        );
        yield* printJson(result);
      }),
    ).pipe(reportLocalMcpErrors),
  ),
);
const resolve = Command.make("resolve", {
  ...rootFlags,
  generation: Flag.Int("generation").pipe(
    Flag.withDescription(
      "Exact generation returned by conflicts; required to protect later edits.",
    ),
  ),
  choice: Flag.Literals("choice", ["local", "owner"]).pipe(
    Flag.withDescription(
      "Choose saved versions for all conflicts in this folder. Both copies remain retained.",
    ),
  ),
}).pipe(
  Command.withDescription(
    "Resolve reviewed conflicts while preserving both saved copies. Later changes are refused.",
  ),
  Command.withHandler((flags) =>
    withLocalMcpTools(flags, (tools) =>
      Effect.gen(function* () {
        const command = yield* decodeCommand({
          operation: "resolve",
          sharedProjectId: flags.sharedProjectId,
          rootId: flags.rootId,
          expectedGeneration: flags.generation,
          choice: flags.choice,
        });
        const result = yield* tools.call(
          "t3_shared_project_files_prepare",
          { ...target(flags.environmentId), command },
          SharedProjectContentState,
        );
        yield* printJson(result);
      }),
    ).pipe(reportLocalMcpErrors),
  ),
);
export const sharedProjectCommand = Command.make("shared-project").pipe(
  Command.withDescription("Inspect and prepare shared projects through the running server."),
  Command.withSubcommands([
    Command.make("files").pipe(Command.withSubcommands([status, conflicts, refresh, resolve])),
  ]),
);
