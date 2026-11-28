import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { useProject } from "~/state/entities";
import { ContainerDisclosure } from "../containers/ContainerPanel";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

export function ThreadContainersPanel({
  environmentId,
  projectId,
  folder,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly folder: string | null;
  readonly threadId: ThreadId;
}) {
  const project = useProject({ environmentId, projectId });
  const folders = [
    ...new Set([folder, project?.workspaceRoot].filter((value): value is string => Boolean(value))),
  ];
  return (
    <ThreadDetailsSection
      headingId="thread-details-containers"
      title="Containers"
      showHeading={false}
    >
      {folder ? (
        <ContainerDisclosure
          environmentId={environmentId}
          label="Containers"
          folders={folders}
          threadId={threadId}
        />
      ) : (
        <p className="px-3 text-xs text-muted-foreground">
          Select a folder to view related containers.
        </p>
      )}
    </ThreadDetailsSection>
  );
}
