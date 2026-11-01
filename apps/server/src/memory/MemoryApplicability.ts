import type { MemoryScope, MemoryRemoteBinding } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ProcessRunner from "../processRunner.ts";
import { isWithinRoot } from "../workspace/KnownWorkspaces.ts";
import type { MemoryActor } from "./SharedMemory.ts";

type Target = Pick<
  MemoryScope | MemoryRemoteBinding,
  "projectIds" | "providerInstanceIds" | "rules"
> & { readonly allProjects?: boolean };

export class MemoryApplicability extends Context.Service<
  MemoryApplicability,
  {
    readonly resolve: (
      targets: ReadonlyArray<Target>,
      actor: MemoryActor,
    ) => Effect.Effect<ReadonlyArray<string | null>>;
    readonly validate: (target: Target) => Effect.Effect<boolean>;
  }
>()("t3/memory/MemoryApplicability") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const process = yield* ProcessRunner.ProcessRunner;
  const canonical = (value: string) =>
    path.isAbsolute(value)
      ? fs.realPath(value).pipe(Effect.orElseSucceed(() => null))
      : Effect.succeed(null);
  const repository = Effect.fn("MemoryApplicability.repository")(function* (cwd: string) {
    const result = yield* process
      .run({
        command: "git",
        args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        cwd,
        timeout: "2 seconds",
        maxOutputBytes: 4096,
      })
      .pipe(Effect.orElseSucceed(() => null));
    return result?.code === 0 ? yield* canonical(result.stdout.trim()) : null;
  });
  return MemoryApplicability.of({
    validate: Effect.fn("MemoryApplicability.validate")(function* (target) {
      for (const rule of target.rules ?? []) {
        const root = yield* canonical(rule.path);
        if (root === null || root === path.parse(root).root) return false;
        if (rule.kind === "repository" && (yield* repository(root)) === null) return false;
        for (const excluded of rule.exclusions) {
          if (
            !path.isAbsolute(excluded) ||
            !isWithinRoot(path, path.resolve(excluded), path.resolve(rule.path))
          )
            return false;
        }
      }
      return true;
    }),
    resolve: Effect.fn("MemoryApplicability.resolve")(function* (targets, actor) {
      if (actor.kind === "user") return targets.map(() => "User access");
      const cwd = actor.cwd ? yield* canonical(actor.cwd) : null;
      const projectRoot = actor.projectRoot ? yield* canonical(actor.projectRoot) : null;
      const roots = cwd === null ? [] : [cwd];
      const repoCache = new Map<string, string | null>();
      const repo = Effect.fn("MemoryApplicability.cachedRepository")(function* (location: string) {
        if (repoCache.has(location)) return repoCache.get(location)!;
        const value = yield* repository(location);
        repoCache.set(location, value);
        return value;
      });
      if (
        cwd !== null &&
        projectRoot !== null &&
        cwd !== projectRoot &&
        !isWithinRoot(path, cwd, projectRoot)
      ) {
        const currentRepo = yield* repo(cwd);
        if (currentRepo !== null && currentRepo === (yield* repo(projectRoot)))
          roots.push(projectRoot);
      }
      const results: Array<string | null> = [];
      for (const target of targets) {
        if (!target.providerInstanceIds.includes(actor.providerInstanceId)) {
          results.push(null);
          continue;
        }
        let reason: string | null = target.projectIds.includes(actor.projectId)
          ? "Selected project"
          : target.allProjects
            ? "All projects"
            : null;
        let excluded = false;
        for (const rule of target.rules ?? []) {
          const root = yield* canonical(rule.path);
          if (root === null) continue;
          for (const exclusion of rule.exclusions) {
            const canonicalExclusion = yield* canonical(exclusion);
            if (
              roots.some((location) =>
                isWithinRoot(path, location, canonicalExclusion ?? path.resolve(exclusion)),
              )
            )
              excluded = true;
          }
          if (
            rule.kind === "folder" &&
            roots.some((location) =>
              rule.descendants ? isWithinRoot(path, location, root) : location === root,
            )
          )
            reason = `Folder: ${rule.path}`;
          if (rule.kind === "repository" && cwd !== null) {
            const currentRepo = yield* repo(cwd);
            if (currentRepo !== null && currentRepo === (yield* repo(root)))
              reason = `Repository: ${rule.path}`;
          }
        }
        results.push(excluded ? null : reason);
      }
      return results;
    }),
  });
});
export const layer = Layer.effect(MemoryApplicability, make).pipe(
  Layer.provide(ProcessRunner.layer),
);
