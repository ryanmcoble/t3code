import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  type SharedProjectBinding,
  type SharedProjectManifest,
  type SharedProjectSubscription,
  type SharedProjectContentReceipt,
} from "@t3tools/contracts";
import {
  sharedProjectMappingStatus,
  sharedProjectMemberLabel,
  sharedProjectFileStatus,
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

describe("shared project file status", () => {
  const subscription: SharedProjectSubscription = {
    sharedProjectId: project.id,
    ownerEnvironmentId: owner,
    sourceUrl: "https://owner.example",
    paused: false,
    receiveFiles: true,
    observedRevision: 2,
    lastCheckedAt: null,
    error: null,
  };
  const receipt: typeof SharedProjectContentReceipt.Type = {
    sharedProjectId: project.id,
    rootId: "docs",
    generation: 1,
    manifestRevision: 2,
    bindingRevision: 3,
    phase: "current",
    sourceHash: null,
    conflictCount: 0,
    error: null,
  };
  const input = { project, binding, subscription, receipt, environmentId: peer };
  it("shows mapping and connection blockers before the last successful receipt", () => {
    expect(sharedProjectFileStatus({ ...input, binding: undefined }).title).toBe(
      "Choose local folders",
    );
    expect(sharedProjectFileStatus({ ...input, binding: { ...binding, paused: true } }).title).toBe(
      "Paused",
    );
    expect(
      sharedProjectFileStatus({ ...input, subscription: { ...subscription, receiveFiles: false } })
        .title,
    ).toBe("File receiving off");
    expect(
      sharedProjectFileStatus({ ...input, subscription: { ...subscription, paused: true } }).title,
    ).toBe("Owner connection paused");
    expect(
      sharedProjectFileStatus({
        ...input,
        subscription: { ...subscription, error: "Owner unreachable" },
      }).detail,
    ).toBe("Owner unreachable");
  });
  it("does not turn a saved snapshot or stale mapping receipt into execution readiness", () => {
    expect(sharedProjectFileStatus(input)).toEqual({
      title: "Saved snapshot applied",
      detail: "The last received snapshot is applied. Execution readiness is checked separately.",
    });
    expect(sharedProjectFileStatus({ ...input, receipt: undefined }).title).toBe(
      "Waiting for first check",
    );
    expect(
      sharedProjectFileStatus({ ...input, receipt: { ...receipt, bindingRevision: 2 } }).title,
    ).toBe("Preparation needs refresh");
    expect(
      sharedProjectFileStatus({ ...input, receipt: { ...receipt, manifestRevision: 1 } }).title,
    ).toBe("Preparation needs refresh");
  });
  it("distinguishes unpublished local edits, retained conflicts and wait failures", () => {
    expect(
      sharedProjectFileStatus({ ...input, receipt: { ...receipt, phase: "local-changes" } }).detail,
    ).toContain("have not been published");
    expect(
      sharedProjectFileStatus({
        ...input,
        receipt: { ...receipt, phase: "conflict", conflictCount: 1 },
      }).title,
    ).toBe("1 conflict to review");
    expect(
      sharedProjectFileStatus({
        ...input,
        receipt: { ...receipt, phase: "conflict", conflictCount: 3 },
      }).title,
    ).toBe("3 conflicts to review");
    expect(
      sharedProjectFileStatus({
        ...input,
        receipt: { ...receipt, phase: "waiting", error: "Project owner: Active work" },
      }).detail,
    ).toBe("Project owner: Active work");
    expect(
      sharedProjectFileStatus({
        ...input,
        receipt: { ...receipt, phase: "error", error: "Cache full" },
      }).detail,
    ).toBe("Cache full");
  });
});
