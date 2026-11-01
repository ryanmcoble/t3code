import { ComputerUseError } from "@t3tools/contracts";
import { readImageDimensions } from "@t3tools/shared/imageDimensions";
import * as Effect from "effect/Effect";
import * as ComputerUse from "../../../computer/ComputerUse.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller, assertFullAccess, assertLiveCaller } from "../../threadAccess.ts";
import { ComputerStandardToolkit, ComputerObserveToolkit } from "./tools.ts";

const actor = Effect.gen(function* () {
  const caller = yield* loadCaller();
  yield* assertLiveCaller(caller);
  yield* assertFullAccess(caller, "Computer use requires a full-access/default thread.");
  const scope = yield* McpInvocationContext.requireThreadScope(caller.scope, "Computer use");
  return {
    id: scope.thread.threadId,
    label: caller.caller!.title,
    providerInstanceId: scope.thread.providerInstanceId,
  };
});
export const layerStandard = McpToolAccess.toLayer(ComputerStandardToolkit, {
  t3_computer_apps: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      return yield* (yield* ComputerUse.ComputerUse).apps(yield* actor);
    }),
  ),
  t3_computer_control: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      const computer = yield* ComputerUse.ComputerUse;
      const caller = yield* actor;
      const command = input.command;
      switch (command.operation) {
        case "acquire":
          return yield* computer.acquire(caller, command.pid, command.bundleId, command.windowId);
        case "act":
          yield* computer.act(caller, command.leaseId, command.action);
          return null;
        case "release":
          yield* computer.release(caller, command.leaseId);
          return null;
      }
    }),
  ),
});
export const layerObserve = McpToolAccess.toLayer(ComputerObserveToolkit, {
  t3_computer_observe: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const result = yield* (yield* ComputerUse.ComputerUse).observe(
        yield* actor,
        input.leaseId,
        input.windowId,
      );
      const image = result.content.find((item) => item.type === "image");
      if (!image || image.type !== "image")
        return yield* new ComputerUseError({ reason: "driver" });
      const dimensions = readImageDimensions(Buffer.from(image.data, "base64"));
      if (!dimensions) return yield* new ComputerUseError({ reason: "driver" });
      return {
        text: result.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n"),
        screenshot: { data: image.data, mimeType: image.mimeType, ...dimensions },
      };
    }),
  ),
});
