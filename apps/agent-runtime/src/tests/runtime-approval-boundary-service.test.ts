import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { accessProfileDefaults, type PatchProposal } from "@hivo/protocol";
import { EventBus } from "../runtime/EventBus.js";
import { RuntimeApprovalBoundaryService } from "../runtime/RuntimeApprovalBoundaryService.js";
import { SessionManager } from "../runtime/SessionManager.js";

test("RuntimeApprovalBoundaryService approves patches and records Rust apply acknowledgement", async () => {
  const fixture = await approvalFixture();
  try {
    const service = new RuntimeApprovalBoundaryService(fixture.manager);
    const approved = await service.approvePatch(fixture.sessionId, fixture.patchId);
    assert.equal(approved.applied, false);
    assert.match(approved.message, /Rust patch authority/);

    let session = fixture.manager.getSession(fixture.sessionId)!;
    assert.equal(session.patchProposals[0]?.status, "approved");
    assert.equal(session.lifecycleStage, "APPLY");
    assert.equal(session.orchestration?.approvalDecisions[0]?.decision, "approved");

    const started = await service.recordPatchApplyResult(fixture.sessionId, fixture.patchId, {
      status: "apply_started",
      message: "Rust apply started."
    });
    assert.equal(started.terminal, false);
    assert.equal(started.patchStatus, "apply_started");

    const applied = await service.recordPatchApplyResult(fixture.sessionId, fixture.patchId, {
      status: "applied",
      message: "Rust applied the patch.",
      reconciliationSnapshot: {
        after: {
          available: true,
          isGitRepo: false,
          changedFiles: ["src/a.ts"],
          diffText: fixture.patchDiff,
          dirty: true,
          checkedAt: "2026-06-29T00:00:00.000Z"
        }
      }
    });
    session = applied.session;

    assert.equal(applied.terminal, true);
    assert.equal(applied.patchStatus, "applied");
    assert.equal(session.patchProposals[0]?.status, "applied");
    assert.equal(session.reconciliationReport?.patchId, fixture.patchId);
    assert.equal(session.artifacts.some((artifact) => artifact.type === "summary" && /Patch applied/.test(artifact.title)), true);
    assert.match(session.messages.at(-1)?.content ?? "", /Rust applied the patch/);
    assert.equal(session.orchestration?.agentRuns[0]?.workJournal?.some((entry) => entry.title === "Patch apply acknowledged"), true);
  } finally {
    await fixture.cleanup();
  }
});

test("RuntimeApprovalBoundaryService records rejection without applying the proposal", async () => {
  const fixture = await approvalFixture();
  try {
    const service = new RuntimeApprovalBoundaryService(fixture.manager);
    const rejected = await service.rejectPatch(fixture.sessionId, fixture.patchId);

    assert.equal(rejected.applied, false);
    assert.equal(rejected.proposal.status, "rejected");
    const session = fixture.manager.getSession(fixture.sessionId)!;
    assert.equal(session.patchProposals[0]?.status, "rejected");
    assert.equal(session.lifecycleStage, "BLOCKED");
    assert.equal(session.orchestration?.approvalDecisions[0]?.decision, "rejected");
    assert.equal(await readFile(path.join(fixture.workspace, "src", "a.ts"), "utf8"), "old\n");
  } finally {
    await fixture.cleanup();
  }
});

test("RuntimeApprovalBoundaryService records Rust command result provenance and agent evidence", async () => {
  const fixture = await approvalFixture();
  try {
    const service = new RuntimeApprovalBoundaryService(fixture.manager);
    const recorded = await service.recordCommandResult(fixture.sessionId, fixture.commandRequestId, {
      command: "npm test",
      cwd: fixture.workspace,
      risk: "safe",
      status: "executed",
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      message: "Rust command completed.",
      autoRun: false
    });
    const session = recorded.session;

    assert.equal(recorded.record.provenance?.executionAuthority, "rust");
    assert.equal(recorded.record.provenance?.requestId, fixture.commandRequestId);
    assert.equal(session.commandExecutions.length, 1);
    assert.equal(session.artifacts.some((artifact) => artifact.type === "command_result"), true);
    assert.match(session.messages.at(-1)?.content ?? "", /Command finished: `npm test`/);
    assert.equal(session.orchestration?.agentRuns[0]?.testsRun?.includes("npm test"), true);
    assert.equal(session.orchestration?.agentRuns[0]?.evidenceRefs?.some((ref) => ref.type === "command"), true);
  } finally {
    await fixture.cleanup();
  }
});

async function approvalFixture() {
  const workspace = path.join(os.tmpdir(), `hivo-runtime-approval-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const storageDir = path.join(os.tmpdir(), `hivo-runtime-approval-storage-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "src", "a.ts"), "old\n", "utf8");

  const manager = new SessionManager(storageDir, new EventBus(), {
    runtimeEventLoader: async () => []
  });
  await manager.load();
  const session = await manager.createSession({
    workspacePath: workspace,
    mode: "real_provider",
    userPrompt: "Update src/a.ts"
  });
  const patchDiff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new"
  ].join("\n");
  const patchId = "patch_boundary_test";
  const commandRequestId = "cmd_boundary_test";
  await manager.updateSession(session.id, (draft) => {
    draft.orchestration = {
      agentRuns: [{
        id: "agent_boundary_test",
        sessionId: draft.id,
        agentName: "Runtime",
        displayName: "Runtime",
        role: "Senior Coding Agent",
        changedFiles: ["src/a.ts"],
        commandsRun: ["npm test"],
        status: "running",
        startedAt: draft.createdAt,
        workJournal: []
      }],
      workerOutputs: [],
      securityReviews: [],
      reviewerSummaries: [],
      orchestrationEvents: [],
      approvalDecisions: [],
      safetySettings: accessProfileDefaults("default_permissions"),
      lockedFiles: {},
      selectedWorkerAgents: [],
      mandatoryGateAgents: [],
      workOrders: [],
      qualityGateResults: [],
      retryCount: 0
    };
  });
  const proposal: PatchProposal = {
    id: patchId,
    sessionId: session.id,
    title: "Boundary patch",
    summary: "Update src/a.ts",
    riskLevel: "low",
    filesChanged: [{ path: "src/a.ts", changeType: "modify", explanation: "Fixture edit" }],
    unifiedDiff: patchDiff,
    requiresApproval: true,
    status: "proposed",
    createdAt: "2026-06-29T00:00:00.000Z"
  };
  await manager.addPatchProposal(session.id, proposal);
  await manager.addCommandRequest(session.id, {
    id: commandRequestId,
    sessionId: session.id,
    command: "npm test",
    cwd: workspace,
    risk: "safe",
    reason: "Fixture validation.",
    status: "requested",
    createdAt: "2026-06-29T00:00:00.000Z"
  });

  return {
    workspace,
    storageDir,
    manager,
    sessionId: session.id,
    patchId,
    patchDiff,
    commandRequestId,
    cleanup: async () => {
      await rm(workspace, { recursive: true, force: true });
      await rm(storageDir, { recursive: true, force: true });
    }
  };
}
