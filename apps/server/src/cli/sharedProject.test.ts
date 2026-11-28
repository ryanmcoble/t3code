import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { vi } from "vite-plus/test";
import type { LocalMcpTools } from "./localMcpTools.ts";
import { sharedProjectCommand } from "./sharedProject.ts";

const observed = vi.hoisted(() => ({
  calls: [] as Array<{ tool: string; args: Readonly<Record<string, unknown>> }>,
  homes: [] as Array<string | undefined>,
}));
vi.mock("./localMcpTools.ts", () => ({
  reportLocalMcpErrors: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
  withLocalMcpTools: <A, E, R>(
    flags: { baseDir: Option.Option<string> },
    run: (tools: LocalMcpTools) => Effect.Effect<A, E, R>,
  ) => {
    observed.homes.push(Option.getOrUndefined(flags.baseDir));
    const call: LocalMcpTools["call"] = (tool, args) => {
      observed.calls.push({ tool, args });
      return Effect.succeed({ roots: [] }) as ReturnType<LocalMcpTools["call"]>;
    };
    return run({ call });
  },
}));
const run = (args: ReadonlyArray<string>) =>
  Command.runWith(Command.make("t3").pipe(Command.withSubcommands([sharedProjectCommand])), {
    version: "0",
  })(args).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer)),
  );

it.effect(
  "routes status and paged conflict reads to the selected server and linked environment",
  () =>
    Effect.gen(function* () {
      observed.calls.length = 0;
      observed.homes.length = 0;
      yield* run([
        "shared-project",
        "files",
        "status",
        "sample",
        "--base-dir",
        "/home/user/t3-fixture",
      ]);
      yield* run([
        "shared-project",
        "files",
        "conflicts",
        "sample",
        "docs",
        "--cursor",
        "64",
        "--environment",
        "peer",
      ]);
      expect(observed.calls).toEqual([
        {
          tool: "t3_shared_project_files",
          args: { query: { operation: "state", sharedProjectId: "sample" } },
        },
        {
          tool: "t3_shared_project_files",
          args: {
            environmentId: "peer",
            query: {
              operation: "conflicts",
              sharedProjectId: "sample",
              rootId: "docs",
              cursor: 64,
            },
          },
        },
      ]);
      expect(observed.homes).toEqual(["/home/user/t3-fixture", undefined]);
    }),
);

it.effect("requires an explicit recovery choice and generation before sending any command", () =>
  Effect.gen(function* () {
    observed.calls.length = 0;
    for (const extra of [
      [],
      ["--choice", "owner"],
      ["--generation", "4"],
      ["--choice", "remote", "--generation", "4"],
      ["--choice", "owner", "--generation", "0"],
    ]) {
      expect(
        (yield* run(["shared-project", "files", "resolve", "sample", "docs", ...extra]).pipe(
          Effect.result,
        ))._tag,
      ).toBe("Failure");
      expect(observed.calls).toHaveLength(0);
    }
    yield* run([
      "shared-project",
      "files",
      "resolve",
      "sample",
      "docs",
      "--choice",
      "owner",
      "--generation",
      "4",
    ]);
    yield* run(["shared-project", "files", "refresh", "sample", "docs"]);
    expect(observed.calls).toEqual([
      {
        tool: "t3_shared_project_files_prepare",
        args: {
          command: {
            operation: "resolve",
            sharedProjectId: "sample",
            rootId: "docs",
            expectedGeneration: 4,
            choice: "owner",
          },
        },
      },
      {
        tool: "t3_shared_project_files_prepare",
        args: { command: { operation: "refresh", sharedProjectId: "sample", rootId: "docs" } },
      },
    ]);
  }),
);
