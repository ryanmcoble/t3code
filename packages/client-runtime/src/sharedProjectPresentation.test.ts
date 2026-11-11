import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  type SharedProjectBinding,
  type SharedProjectManifest,
} from "@t3tools/contracts";
import {
  sharedProjectMappingStatus,
  sharedProjectMemberLabel,
} from "./sharedProjectPresentation.ts";

const owner = EnvironmentId.make("owner");
const peer = EnvironmentId.make("peer");
const project: SharedProjectManifest = {
  id: "shared",
  ownerEnvironmentId: owner,
  revision: 2,
  name: "Shared sample",
  roots: [
    {
      id: "docs",
      name: "Docs",
      kind: "files",
      contentPolicy: { mode: "project-content", excludePaths: [] },
    },
  ],
  members: [owner, peer],
  setupProfileId: null,
  archived: false,
};
const binding: SharedProjectBinding = {
  sharedProjectId: project.id,
  environmentId: peer,
  manifestRevision: 2,
  revision: 3,
  detached: false,
  roots: [],
  paused: false,
};

describe("shared project mapping status", () => {
  it("never calls mappings synchronized or ready for execution", () => {
    const status = sharedProjectMappingStatus(project, binding, peer);
    expect(status.title).toBe("Folders mapped");
    expect(status.detail).toContain("have not been verified");
  });
  it("gives removed membership and stale revisions precedence over mapped state", () => {
    expect(sharedProjectMappingStatus({ ...project, members: [owner] }, binding, peer).title).toBe(
      "Not a member",
    );
    expect(
      sharedProjectMappingStatus(project, { ...binding, manifestRevision: 1, paused: true }, peer)
        .title,
    ).toBe("Mappings need review");
    expect(sharedProjectMappingStatus({ ...project, archived: true }, binding, peer).title).toBe(
      "Archived",
    );
  });
  it("keeps detach reversible and paused mappings visible", () => {
    expect(sharedProjectMappingStatus(project, { ...binding, detached: true }, peer).title).toBe(
      "Choose local folders",
    );
    expect(sharedProjectMappingStatus(project, undefined, peer).title).toBe("Choose local folders");
    expect(
      sharedProjectMappingStatus(project, { ...binding, environmentId: owner }, peer).title,
    ).toBe("Choose local folders");
    expect(sharedProjectMappingStatus(project, { ...binding, paused: true }, peer).title).toBe(
      "Paused",
    );
  });
  it("uses machine names with an honest unavailable fallback", () => {
    expect(sharedProjectMemberLabel(peer, [{ environmentId: peer, label: "Work Mac" }])).toBe(
      "Work Mac",
    );
    expect(sharedProjectMemberLabel(peer, [])).toBe("Unavailable machine");
  });
});
