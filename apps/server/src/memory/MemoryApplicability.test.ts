import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ProcessRunner from "../processRunner.ts";
import * as MemoryApplicability from "./MemoryApplicability.ts";

it.live(
  "matches repository worktrees and inherited company folders by canonical repository identity",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const runner = yield* ProcessRunner.ProcessRunner;
        const applicability = yield* MemoryApplicability.MemoryApplicability;
        const root = yield* fs.makeTempDirectoryScoped();
        const company = `${root}/company`;
        const repository = `${company}/app`;
        const worktree = `${root}/outside-worktree`;
        yield* fs.makeDirectory(repository, { recursive: true });
        for (const args of [
          ["init", repository],
          [
            "-C",
            repository,
            "-c",
            "user.name=Memory Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--allow-empty",
            "-m",
            "fixture",
          ],
          ["-C", repository, "worktree", "add", "-b", "fixture-worktree", worktree],
        ]) {
          const result = yield* runner.run({
            command: "git",
            args: ["-c", "core.hooksPath=/dev/null", ...args],
            timeout: "10 seconds",
          });
          assert.equal(result.code, 0);
        }
        const provider = ProviderInstanceId.make("fixture-provider");
        const actor = {
          kind: "agent" as const,
          threadId: ThreadId.make("fixture-thread"),
          projectId: ProjectId.make("fixture-project"),
          providerInstanceId: provider,
          cwd: worktree,
          projectRoot: repository,
        };
        const base = { projectIds: [], providerInstanceIds: [provider] };
        const targets = [
          {
            ...base,
            rules: [
              { kind: "repository" as const, path: repository, descendants: true, exclusions: [] },
            ],
          },
          {
            ...base,
            rules: [{ kind: "folder" as const, path: company, descendants: true, exclusions: [] }],
          },
        ];
        const result = yield* applicability.resolve(targets, actor);
        assert.include(result[0]!, "Repository:");
        assert.include(result[1]!, "Folder:");
        const unrelated = `${root}/unrelated`;
        yield* fs.makeDirectory(unrelated);
        assert.deepEqual(yield* applicability.resolve(targets, { ...actor, cwd: unrelated }), [
          null,
          null,
        ]);
        assert.isFalse(
          yield* applicability.validate({
            ...base,
            rules: [{ kind: "repository", path: unrelated, descendants: true, exclusions: [] }],
          }),
        );
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(MemoryApplicability.layer, ProcessRunner.layer).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);
