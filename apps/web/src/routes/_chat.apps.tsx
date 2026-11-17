import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId } from "@t3tools/contracts";
import { AppsPage } from "../components/apps/AppsPage";

export const Route = createFileRoute("/_chat/apps")({
  validateSearch: (raw: Record<string, unknown>) => ({
    ...(typeof raw.environmentId === "string" && raw.environmentId
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(typeof raw.appId === "string" && raw.appId ? { appId: raw.appId } : {}),
  }),
  component: AppsPage,
});
