import type {
  AgentRuntimeSession,
  RunPhase,
  RunSummary
} from "@hivo/protocol";
import { randomUUID } from "node:crypto";
import {
  buildAttributedReviewGate,
  buildDiffAwareRunSummary
} from "./AgentTelemetry.js";
import { summarizeModuleExecution } from "./ModuleExecutionPlanning.js";
import { SessionManager } from "./SessionManager.js";

type RuntimeVerification = NonNullable<AgentRuntimeSession["verificationResult"]>;

export class RuntimeSessionOutcomeService {
  constructor(private readonly sessionManager: SessionManager) {}

  async sync(sessionId: string) {
    const before = this.requireSession(sessionId);
    const { activeBaselineAction, isValidBaseline } = getValidBaselineDetails(before);

    const hasUnappliedPatch = before.patchProposals.some(
      (proposal) => proposal.status === "proposed" || proposal.status === "approved" || proposal.status === "apply_started"
    );
    const hasPendingCommands = before.commandRequests.some(
      (request) => request.status === "requested" || request.status === "approved" || request.status === "executing" || request.status === "running"
    );
    const hasApplyFailure = before.patchProposals.some((proposal) => proposal.status === "apply_failed");
    const hasAppliedPatch = before.patchProposals.some((proposal) => proposal.status === "applied");
    const hasFailedNonBaselineCommands = before.commandRequests.some((request) => {
      if (isBaselineCommand(before, request.id, request.command, request.reason, request.provenance)) {
        return false;
      }
      return (
        request.status === "failed" ||
        request.status === "blocked" ||
        request.status === "rejected" ||
        request.status === "denied" ||
        request.status === "orphaned" ||
        request.status === "terminated"
      );
    });

    if (before.status === "blocked" || before.lifecycleStage === "BLOCKED" || before.status === "failed" || before.lifecycleStage === "FAILED") {
      return;
    }

    if (before.accessProfile === "full_access" || before.accessProfile === "auto_review") {
      if (activeBaselineAction && isValidBaseline) {
        return;
      }
      if (hasUnappliedPatch || hasPendingCommands || hasApplyFailure || hasFailedNonBaselineCommands) {
        // Do NOT short-circuit to completed/DONE when patches or commands are in flight or failed.
        // Let the state machine below determine the authoritative lifecycle stage (APPLY, POST_VERIFY, FAILED).
      } else {
        await this.sessionManager.updateSession(sessionId, (draft) => {
          draft.status = "completed";
          draft.lifecycleStage = "DONE";
          setRunPhaseState(draft, "integrate_changes", "completed", "Full Access mode: patch auto-approved.");
          setRunPhaseState(draft, "run_verification", "completed", "Full Access mode: verification auto-approved.");
          setRunPhaseState(draft, "review_final_diff", "completed", "Full Access mode: no approval needed.");
          setRunPhaseState(draft, "final_report", "completed", "Full Access mode: run completed.");
        });
        return;
      }
    }

    const verification = buildRuntimeVerification(before);
    const reviewGate = buildReviewGateSummary(before, verification);
    await this.sessionManager.setVerificationResult(sessionId, verification);
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.reviewGate = reviewGate;
      if (draft.moduleExecutionPlan) {
        draft.moduleExecutionPlan.updatedAt = new Date().toISOString();
      }
      const hasApplyFailure = draft.patchProposals.some((proposal) => proposal.status === "apply_failed");
      const hasPendingPatchReview = draft.patchProposals.some((proposal) => proposal.status === "proposed");
      const hasPendingPatchApply = draft.patchProposals.some((proposal) => proposal.status === "approved");
      const hasAppliedPatch = draft.patchProposals.some((proposal) => proposal.status === "applied");
      const hasPendingCommands = draft.commandRequests.some(
        (request) => request.status === "requested" || request.status === "approved" || request.status === "executing" || request.status === "running"
      );
      const hasFailedCommands = draft.commandRequests.some((request) => {
        if (isBaselineCommand(before, request.id, request.command, request.reason, request.provenance)) {
          return false;
        }
        return (
          request.status === "failed" ||
          request.status === "blocked" ||
          request.status === "rejected" ||
          request.status === "denied" ||
          request.status === "orphaned" ||
          request.status === "terminated"
        );
      });
      const reconciliationStatus = draft.reconciliationReport?.status;
      const scopeVerdict = draft.latestScopeValidation?.verdict;
      const runToGreenStatus = draft.runToGreen?.status;
      const runToGreenActive = runToGreenStatus === "running";

      if (runToGreenStatus === "passed") {
        draft.status = "completed";
        draft.lifecycleStage = "DONE";
        draft.nextAction = draft.previewRecommendation
          ? {
              kind: "preview_ready",
              message: "Run-to-green command passed. The preview can be opened now.",
              preview: draft.previewRecommendation
            }
          : undefined;
        if (draft.moduleExecutionPlan) {
          draft.moduleExecutionPlan.status = "completed";
        }
        setRunPhaseState(draft, "run_verification", "completed", verification.summary, verification.checks.length);
        setRunPhaseState(draft, "review_final_diff", "completed", "Run-to-green completed successfully.");
        setRunPhaseState(draft, "final_report", "completed", "Final run-to-green report is ready.");
        return;
      }

      const noRunnableCommandOnly =
        runToGreenStatus === "blocked"
        && (draft.runToGreen?.currentAttempt ?? 0) === 0
        && !draft.commandExecutions.length
        && !draft.patchProposals.length;

      if (noRunnableCommandOnly) {
        draft.status = "completed";
        draft.lifecycleStage = "DONE";
        if (draft.moduleExecutionPlan) {
          draft.moduleExecutionPlan.status = "completed";
        }
        setRunPhaseState(draft, "run_verification", "completed", verification.summary, verification.checks.length);
        setRunPhaseState(
          draft,
          "review_final_diff",
          "completed",
          draft.previewRecommendation
            ? "Preview is available even though no grounded run command was found."
            : "No grounded run command was found for this workspace."
        );
        setRunPhaseState(
          draft,
          "final_report",
          "completed",
          draft.previewRecommendation
            ? "The run finished with a preview recommendation."
            : "The run finished without a runnable command."
        );
        return;
      }

      if (runToGreenStatus === "blocked" || runToGreenStatus === "failed" || runToGreenStatus === "max_attempts_reached" || runToGreenStatus === "cancelled") {
        draft.status = runToGreenStatus === "blocked" ? "blocked" : "failed";
        draft.lifecycleStage = runToGreenStatus === "blocked" ? "BLOCKED" : "FAILED";
        draft.nextAction = undefined;
        if (draft.moduleExecutionPlan) {
          draft.moduleExecutionPlan.status = runToGreenStatus === "blocked" ? "blocked" : "failed";
        }
        setRunPhaseState(draft, "run_verification", runToGreenStatus === "blocked" ? "blocked" : "failed", verification.summary, verification.checks.length);
        setRunPhaseState(draft, "review_final_diff", runToGreenStatus === "blocked" ? "blocked" : "completed", draft.runToGreen?.blockerReason ?? "Run-to-green stopped.");
        setRunPhaseState(draft, "final_report", runToGreenStatus === "blocked" ? "blocked" : "completed", draft.runToGreen?.blockerReason ?? "Run-to-green stopped without success.");
        return;
      }

      if (scopeVerdict === "blocked") {
        draft.status = "needs_approval";
        draft.lifecycleStage = "BLOCKED";
        draft.nextAction = undefined;
        if (draft.moduleExecutionPlan) {
          draft.moduleExecutionPlan.status = "blocked";
        }
        setRunPhaseState(draft, "review_final_diff", "blocked", "Module scope validation blocked the proposed change set.", 0);
        setRunPhaseState(draft, "final_report", "blocked", "Run is blocked until the patch returns inside the scoped module boundary.");
        return;
      }

      if (hasApplyFailure || (!runToGreenActive && hasFailedCommands) || verification.status === "failed") {
        draft.status = "failed";
        draft.lifecycleStage = "FAILED";
        draft.nextAction = undefined;
        if (draft.moduleExecutionPlan) {
          draft.moduleExecutionPlan.status = "failed";
        }
        setRunPhaseState(draft, "run_verification", "failed", verification.summary, verification.checks.length);
        setRunPhaseState(draft, "final_report", "completed", "Run failed after verification or authority errors.");
        return;
      }

      const { activeBaselineAction, isValidBaseline, isInfraFailure } = getValidBaselineDetails(before);

      if (activeBaselineAction && isInfraFailure) {
        draft.status = "failed";
        draft.lifecycleStage = "FAILED";
        draft.nextAction = undefined;
        if (draft.moduleExecutionPlan) {
          draft.moduleExecutionPlan.status = "failed";
        }
        setRunPhaseState(draft, "run_verification", "failed", "Baseline test execution encountered an infrastructure failure.", 1);
        setRunPhaseState(draft, "final_report", "completed", "Run failed due to baseline command infrastructure failure.");
        return;
      }

      if (activeBaselineAction && isValidBaseline) {
        draft.nextAction = activeBaselineAction;
        draft.status = "needs_approval";
        draft.lifecycleStage = "INTAKE";
        return;
      }

      if (hasPendingPatchReview) {
        draft.status = "needs_approval";
        draft.lifecycleStage = "APPROVAL";
        draft.nextAction = undefined;
        if (draft.moduleExecutionPlan) {
          draft.moduleExecutionPlan.status = draft.latestScopeValidation?.verdict === "needs_review" ? "blocked" : "running";
        }
        setRunPhaseState(draft, "review_final_diff", "active", "Patch review is waiting for operator approval.");
        return;
      }

      if (hasPendingPatchApply) {
        draft.status = "needs_approval";
        draft.lifecycleStage = "APPLY";
        draft.nextAction = undefined;
        if (draft.moduleExecutionPlan) {
          draft.moduleExecutionPlan.status = "running";
        }
        setRunPhaseState(draft, "integrate_changes", "completed", "Patch proposal is approved and waiting for Rust apply.");
        setRunPhaseState(draft, "review_final_diff", "active", "Approved changes are waiting for Rust apply.");
        return;
      }

      if (hasAppliedPatch && hasPendingCommands) {
        draft.status = "needs_approval";
        draft.lifecycleStage = "POST_VERIFY";
        if (draft.moduleExecutionPlan) {
          draft.moduleExecutionPlan.status = "running";
        }
        draft.nextAction = {
          kind: "approve_commands",
          message: "Patch applied. Run the requested verification commands through Rust."
        };
        setRunPhaseState(draft, "run_verification", "active", "Patch applied. Verification commands are still pending.", verification.checks.length);
        setRunPhaseState(draft, "review_final_diff", "active", "Verification commands are waiting for operator execution.");
        return;
      }

      if (
        hasAppliedPatch &&
        draft.accessProfile !== "full_access" &&
        draft.accessProfile !== "auto_review" &&
        verification.status !== "passed" &&
        (reconciliationStatus === "pending" || reconciliationStatus === "not_run")
      ) {
        draft.status = "needs_approval";
        draft.lifecycleStage = "POST_VERIFY";
        draft.nextAction = undefined;
        if (draft.moduleExecutionPlan) {
          draft.moduleExecutionPlan.status = "running";
        }
        setRunPhaseState(draft, "run_verification", "active", "Patch applied. Reconciliation is still pending.", verification.checks.length);
        setRunPhaseState(draft, "review_final_diff", "active", "Post-apply reconciliation is still pending.");
        return;
      }

      if (hasAppliedPatch && (reconciliationStatus === "diverged" || reconciliationStatus === "failed")) {
        draft.status = "failed";
        draft.lifecycleStage = "FAILED";
        draft.nextAction = undefined;
        if (draft.moduleExecutionPlan) {
          draft.moduleExecutionPlan.status = "failed";
        }
        setRunPhaseState(draft, "run_verification", "failed", verification.summary, verification.checks.length);
        setRunPhaseState(draft, "review_final_diff", "blocked", "Post-apply reconciliation diverged from the proposed patch.");
        setRunPhaseState(draft, "final_report", "completed", "Manual inspection is required because post-apply reconciliation diverged.");
        return;
      }

      if (
        hasAppliedPatch &&
        reconciliationStatus === "unavailable" &&
        verification?.status !== "passed"
      ) {
        draft.status = "needs_approval";
        draft.lifecycleStage = "POST_VERIFY";
        draft.nextAction = undefined;
        if (draft.moduleExecutionPlan) {
          draft.moduleExecutionPlan.status = "blocked";
        }
        setRunPhaseState(draft, "run_verification", "blocked", "Patch applied, but reconciliation data is unavailable.", verification.checks.length);
        setRunPhaseState(draft, "review_final_diff", "active", "Manual inspection is required because reconciliation data is unavailable.");
        return;
      }

      if (hasAppliedPatch) {
        draft.status = "completed";
        draft.lifecycleStage = "DONE";
        if (draft.moduleExecutionPlan) {
          draft.moduleExecutionPlan.status = "completed";
        }
        draft.nextAction = draft.previewRecommendation
          ? {
              kind: "preview_ready",
              message: "Verification is complete. The preview can be opened now.",
              preview: draft.previewRecommendation
            }
          : undefined;
        setRunPhaseState(draft, "run_verification", "completed", verification.summary, verification.checks.length);
        setRunPhaseState(draft, "review_final_diff", "completed", "Review gate is satisfied.");
        setRunPhaseState(draft, "final_report", "completed", "Final report is ready.");
      }
    });

    await this.sessionManager.updateSession(sessionId, (draft) => {
      const agent = draft.orchestration?.agentRuns.find((candidate) => candidate.id === "agent_local_codex");
      if (!agent) return;
      agent.status =
        draft.status === "completed"
          ? "completed"
          : draft.status === "failed" || draft.status === "failed_provider"
            ? "failed"
            : draft.status === "blocked"
              ? "blocked"
              : draft.status === "needs_approval"
                ? "running"
                : agent.status;
      agent.lifecycleStage = draft.lifecycleStage;
      agent.currentAction = draft.runSummary?.summary ?? draft.runToGreen?.blockerReason ?? agent.currentAction;
      agent.lastEvent = `sync:${draft.status}`;
      if ((agent.status === "completed" || agent.status === "failed" || agent.status === "blocked") && !agent.completedAt) {
        agent.completedAt = new Date().toISOString();
      }
    });

    const after = this.requireSession(sessionId);
    const moduleSummary = summarizeModuleExecution(after, verification);
    if (moduleSummary) {
      const previous = after.moduleExecutionSummaries?.find((entry) => entry.id === moduleSummary.id);
      await this.sessionManager.updateSession(sessionId, (draft) => {
        const existingIndex = draft.moduleExecutionSummaries?.findIndex((entry) => entry.id === moduleSummary.id) ?? -1;
        draft.moduleExecutionSummaries ??= [];
        if (existingIndex >= 0) {
          draft.moduleExecutionSummaries[existingIndex] = moduleSummary;
        } else {
          draft.moduleExecutionSummaries.push(moduleSummary);
        }
      });
      if (!previous || previous.status !== moduleSummary.status || previous.updatedAt !== moduleSummary.updatedAt) {
        await this.sessionManager.addArtifact(sessionId, {
          id: `artifact_${randomUUID()}`,
          sessionId,
          type: "module_execution_summary",
          title: moduleSummary.title,
          summary: moduleSummary.summary,
          payload: { moduleSummary },
          createdAt: new Date().toISOString()
        });
      }
    }
    const summary = buildRuntimeRunSummary(after, verification);
    await this.sessionManager.setRunSummary(sessionId, summary);
  }

  private requireSession(sessionId: string) {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session;
  }
}

function setRunPhaseState(
  session: AgentRuntimeSession,
  phaseId: RunPhase["id"],
  status: RunPhase["status"],
  summary: string,
  evidenceCount?: number
) {
  const now = new Date().toISOString();
  session.runPhases = (session.runPhases ?? []).map((phase) =>
    phase.id === phaseId
      ? {
          ...phase,
          status,
          summary,
          evidenceCount,
          startedAt: phase.startedAt ?? now,
          completedAt: status === "completed" || status === "failed" || status === "blocked" ? now : undefined
        }
      : phase
  );
}

export function buildRuntimeVerification(session: AgentRuntimeSession) {
  const { activeBaselineAction, isValidBaseline, isInfraFailure } = getValidBaselineDetails(session);
  const patchProposalCount = session.patchProposals.length;
  const appliedPatchCount = session.patchProposals.filter((proposal) => proposal.status === "applied").length;
  const applyFailed = session.patchProposals.some((proposal) => proposal.status === "apply_failed");
  const pendingPatchApply = session.patchProposals.some((proposal) => proposal.status === "approved");
  const patchApplyStarted = session.patchProposals.some((proposal) => proposal.status === "apply_started");
  const pendingPatchReview = session.patchProposals.some((proposal) => proposal.status === "proposed");
  const reconciliation = session.reconciliationReport;
  const commandStatuses = session.commandRequests.map((request) => ({
    id: request.id,
    command: request.command,
    status: request.status
  }));
  const commandFailed = commandStatuses.some(
    (command) =>
      !isBaselineCommand(session, command.id, command.command) &&
      (command.status === "failed" || command.status === "blocked" || command.status === "denied" || command.status === "orphaned" || command.status === "terminated")
  );
  const commandPending = commandStatuses.some(
    (command) => command.status === "requested" || command.status === "approved" || command.status === "executing" || command.status === "running"
  );
  const commandExecuted = commandStatuses.filter((command) => command.status === "executed");
  const successfulExecutions = session.commandExecutions.filter((execution) =>
    (execution.status === "executed" || execution.status === "completed") && (execution.exitCode === undefined || execution.exitCode === 0)
  );
  const failedExecutions = session.commandExecutions.filter((execution) => {
    if (isBaselineExecution(session, execution)) {
      return false;
    }
    return (
      execution.status === "failed" ||
      ((execution.status === "executed" || execution.status === "completed") &&
        typeof execution.exitCode === "number" &&
        execution.exitCode !== 0)
    );
  });
  const blockedExecutions = session.commandExecutions.filter((execution) => execution.status === "blocked");
  const approvalRequiredExecutions = session.commandExecutions.filter((execution) => execution.status === "approval_required");
  const runtimeErrorExecutions = session.commandExecutions.filter((execution) =>
    execution.status === "orphaned" || execution.status === "terminated" || execution.status === "unknown"
  );
  const backgroundRunning = (session.backgroundJobs ?? []).some((job) => job.status === "running");
  const validationTruthStatus =
    failedExecutions.length
      ? "verified_failed"
      : blockedExecutions.length || session.commandRequests.some((request) => request.status === "blocked" || request.status === "denied")
        ? "not_run_blocked_by_policy"
        : approvalRequiredExecutions.length
          ? "not_run_needs_approval"
          : runtimeErrorExecutions.length
            ? "not_run_runtime_error"
            : commandPending || backgroundRunning || pendingPatchReview || pendingPatchApply || patchApplyStarted
              ? "unverified"
            : successfulExecutions.length
              ? "verified_passed"
              : session.commandRequests.length
                ? "unverified"
                : "not_run_missing_command";
  const runToGreen = session.runToGreen;
  const runToGreenActive = runToGreen?.status === "running";
  const runToGreenBlockedBeforeExecution =
    runToGreen?.status === "blocked"
    && session.commandRequests.length === 0
    && session.commandExecutions.length === 0
    && patchProposalCount === 0;
  const runToGreenTerminalFailure =
    (runToGreen?.status === "blocked" && !runToGreenBlockedBeforeExecution) ||
    runToGreen?.status === "failed" ||
    runToGreen?.status === "max_attempts_reached" ||
    runToGreen?.status === "cancelled";

  return {
    id: `verification_${randomUUID()}`,
    sessionId: session.id,
    truthStatus: validationTruthStatus,
    status:
      validationTruthStatus === "verified_passed"
        ? "passed"
        : validationTruthStatus === "verified_failed"
          ? "failed"
      : runToGreenBlockedBeforeExecution
        ? "unavailable"
        : runToGreenTerminalFailure || applyFailed || (!runToGreenActive && commandFailed) || reconciliation?.status === "diverged" || reconciliation?.status === "failed" || isInfraFailure
        ? "failed"
        : runToGreen?.status === "running" || pendingPatchReview || pendingPatchApply || patchApplyStarted || commandPending || backgroundRunning || reconciliation?.status === "pending"
          ? "pending"
        : reconciliation?.status === "unavailable"
            ? "unavailable"
          : runToGreen?.status === "blocked"
            ? "unavailable"
            : runToGreen && !commandPending && !commandExecuted.length && !patchProposalCount
              ? "skipped"
          : "unavailable",
    summary:
      runToGreenBlockedBeforeExecution
        ? (runToGreen?.blockerReason ?? "Run-to-green was blocked before command execution.")
        : runToGreenTerminalFailure
        ? runToGreen?.blockerReason ?? "Run-to-green stopped without reaching a passing command result."
        : applyFailed
        ? "Patch apply failed."
        : !runToGreenActive && commandFailed
          ? "At least one requested command failed."
          : reconciliation?.status === "diverged"
            ? "Post-apply reconciliation diverged from the proposed patch."
            : reconciliation?.status === "failed"
              ? "Post-apply reconciliation failed."
          : pendingPatchReview
            ? "Patch review is still pending."
            : pendingPatchApply
              ? "Patch was approved and is waiting for Rust apply."
              : reconciliation?.status === "pending"
                ? "Patch applied. Reconciliation is still pending."
          : reconciliation?.status === "unavailable"
                  ? "Patch applied, but reconciliation data is unavailable."
          : runToGreen?.status === "running"
            ? "Run-to-green is still waiting on a terminal command or repair result."
          : backgroundRunning
            ? "A background command is still running with limited tracking."
          : commandPending
                ? "Patch applied. Verification commands are still pending."
                : "Patch and command verification are complete.",
    checks: [
      {
        id: "run_to_green",
        label: "Run-to-green",
        name: "Run-to-green",
        status:
          runToGreen?.status === "passed"
            ? "passed"
            : runToGreenBlockedBeforeExecution
              ? "unavailable"
            : runToGreenTerminalFailure
              ? "failed"
              : runToGreen?.status === "running"
                ? "running"
                : runToGreen
                  ? "pending"
                  : "skipped",
        detail:
          runToGreen?.status === "passed"
            ? `Selected command passed on attempt ${runToGreen.currentAttempt}.`
            : runToGreenBlockedBeforeExecution
              ? (runToGreen?.blockerReason ?? "Run-to-green was blocked before command execution.")
            : runToGreenTerminalFailure
              ? (runToGreen?.blockerReason ?? "Run-to-green stopped without reaching green.")
              : runToGreen?.status === "running"
                ? `Attempt ${runToGreen.currentAttempt}/${runToGreen.maxAttempts} is still in progress.`
                : "Run-to-green was not active for this session.",
        command: runToGreen?.attempts.at(-1)?.command,
        summary: runToGreen?.blockerReason
      },
      {
        id: "patch_proposal",
        label: "Patch proposal",
        name: "Patch proposal",
        status: patchProposalCount ? "passed" : runToGreen ? "skipped" : "pending",
        detail: patchProposalCount
          ? `${patchProposalCount} patch proposal(s) recorded.`
          : runToGreen
            ? "No patch proposal was needed before command selection."
            : "No patch proposal recorded.",
        startedAt: session.createdAt,
        completedAt: patchProposalCount ? session.updatedAt : undefined,
        summary: patchProposalCount ? "Patch proposal captured." : runToGreen ? "Patch proposal was not required." : "Patch proposal is missing."
      },
      {
        id: "rust_apply",
        label: "Rust apply",
        name: "Rust apply",
        status: applyFailed ? "failed" : appliedPatchCount ? "passed" : pendingPatchApply || pendingPatchReview ? "pending" : runToGreen ? "skipped" : "passed",
        detail: applyFailed
          ? "Rust reported a patch apply failure."
          : appliedPatchCount
            ? `${appliedPatchCount} patch(es) applied through Rust.`
            : pendingPatchApply
              ? "Waiting for Rust to apply the approved patch."
              : pendingPatchReview
                ? "Patch is waiting for approval before Rust apply."
                : runToGreen
                  ? "Rust patch apply was not started because no repair patch was proposed."
                  : "No patch apply was required.",
        linkedPatchId: session.patchProposals.at(-1)?.id,
        startedAt: session.patchProposals.at(-1)?.createdAt,
        completedAt: appliedPatchCount || applyFailed ? session.updatedAt : undefined
      },
      {
        id: "reconciliation",
        label: "Reconciliation",
        name: "Reconciliation",
        status:
          reconciliation?.status === "matched"
            ? "passed"
            : reconciliation?.status === "diverged" || reconciliation?.status === "failed"
              ? "failed"
              : reconciliation?.status === "pending"
                ? "running"
                : reconciliation?.status === "unavailable"
                  ? "unavailable"
                  : appliedPatchCount
                    ? "not_run"
                    : "skipped",
        detail: reconciliation?.reason ?? (appliedPatchCount ? "Patch applied, but reconciliation has not been recorded yet." : "Reconciliation is skipped until a patch is applied."),
        linkedPatchId: reconciliation?.patchId ?? session.patchProposals.at(-1)?.id,
        startedAt: reconciliation?.checkedAt,
        completedAt: reconciliation && reconciliation.status !== "pending" ? reconciliation.checkedAt : undefined,
        summary: reconciliation?.reason
      },
      {
        id: "command_execution",
        label: "Rust command execution",
        name: "Rust command execution",
        status: runToGreenBlockedBeforeExecution ? "not_run" : !runToGreenActive && commandFailed ? "failed" : commandPending || backgroundRunning || runToGreenActive ? "pending" : commandExecuted.length ? "passed" : runToGreen ? "skipped" : "passed",
        detail: runToGreenBlockedBeforeExecution
          ? "No grounded command was selected, so Rust command execution was not started."
          : !runToGreenActive && commandFailed
          ? "At least one verification command failed or was blocked."
          : backgroundRunning
            ? "A background verification command is still running with limited tracking."
          : runToGreenActive
            ? "Run-to-green is still diagnosing, repairing, or waiting for a rerun."
          : commandPending
            ? "Waiting for verification commands to run."
            : commandExecuted.length
              ? `Executed ${commandExecuted.length} verification command(s).`
              : runToGreen
                ? "No command was executed for this run-to-green attempt."
                : "No verification command was required.",
        command: commandExecuted[0]?.command,
        startedAt: commandPending || commandExecuted.length ? session.updatedAt : undefined,
        completedAt: commandExecuted.length || commandFailed ? session.updatedAt : undefined,
        exitCode: session.commandExecutions.at(-1)?.exitCode,
        summary: commandExecuted.length ? "Verification commands completed." : runToGreenBlockedBeforeExecution ? "Rust command execution did not start." : "Verification commands are pending or not required."
      }
    ],
    createdAt: new Date().toISOString()
  } satisfies RuntimeVerification;
}

function buildRuntimeRunSummary(session: AgentRuntimeSession, verification: RuntimeVerification): RunSummary {
  const status = (
    session.status === "failed" || session.status === "failed_provider"
      ? "failed"
      : session.status === "blocked" || session.lifecycleStage === "BLOCKED"
        ? "blocked"
      : session.status === "completed"
        ? "completed"
        : "pending"
  ) as RunSummary["status"];
  const nextAction =
    session.runToGreen?.status === "passed"
      ? "Selected run-to-green command passed."
      : session.runToGreen?.blockerReason
        ? session.runToGreen.blockerReason
        : session.status === "needs_approval"
          ? session.nextAction?.message ?? "Review the pending runtime action."
          : session.status === "failed" || session.status === "failed_provider"
            ? "Inspect the recorded patch or command failure."
            : "Review the active run state and latest verification evidence.";
  return buildDiffAwareRunSummary(
    session,
    verification,
    status,
    nextAction
  );
}

function buildReviewGateSummary(
  session: AgentRuntimeSession,
  verification: RuntimeVerification
): NonNullable<AgentRuntimeSession["reviewGate"]> {
  const gate = buildAttributedReviewGate(session, verification);
  const scopeValidation = session.latestScopeValidation;
  const runToGreen = session.runToGreen
    ? {
        status: session.runToGreen.status,
        currentAttempt: session.runToGreen.currentAttempt,
        maxAttempts: session.runToGreen.maxAttempts,
        lastCommand: session.runToGreen.attempts.at(-1)?.command,
        lastDiagnosis: session.runToGreen.attempts.at(-1)?.diagnosis,
        blockerReason: session.runToGreen.blockerReason,
        finalStatus: session.runToGreen.finalStatus
      }
    : undefined;
  const withRunToGreen = {
    ...gate,
    runToGreen,
    unresolvedBlockers: uniqueRuntimeStrings([
      ...gate.unresolvedBlockers,
      ...(session.runToGreen?.status === "blocked" || session.runToGreen?.status === "max_attempts_reached"
        ? [session.runToGreen.blockerReason ?? "Run-to-green stopped without reaching green."]
        : [])
    ])
  };
  if (!scopeValidation) {
    if (session.runToGreen?.status === "blocked") {
      return {
        ...withRunToGreen,
        recommendation: "do_not_apply",
        summary: session.runToGreen.blockerReason ?? "Run-to-green was blocked before command execution.",
        unresolvedBlockers: uniqueRuntimeStrings([
          ...withRunToGreen.unresolvedBlockers,
          session.runToGreen.blockerReason ?? "Run-to-green was blocked before command execution."
        ])
      };
    }
    return withRunToGreen;
  }
  return {
    ...withRunToGreen,
    scopeValidation,
    recommendation:
      scopeValidation.verdict === "blocked"
        ? "do_not_apply"
        : scopeValidation.verdict === "needs_review"
          ? "caution"
          : gate.recommendation,
    unresolvedBlockers: uniqueRuntimeStrings([
      ...withRunToGreen.unresolvedBlockers,
      ...(scopeValidation.verdict === "blocked" ? ["Module scope validation blocked apply until the patch is narrowed."] : [])
    ]),
    summary:
      scopeValidation.verdict === "blocked"
        ? "Patch review is blocked because proposed changes exceed the scoped module plan."
        : scopeValidation.verdict === "needs_review"
          ? "Patch review needs extra attention because it touches cautionary or approval-sensitive scope."
          : withRunToGreen.summary
  };
}

function uniqueRuntimeStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function getValidBaselineDetails(session: AgentRuntimeSession) {
  const activeBaselineAction = session.nextAction?.kind === "await_baseline_command" ? session.nextAction : undefined;
  if (!activeBaselineAction) return { activeBaselineAction: undefined, isValidBaseline: false, isInfraFailure: false };
  const baselineExecution = (session.commandExecutions ?? []).find((execution) =>
    execution.requestId === activeBaselineAction.commandRequestId ||
    execution.command.trim() === activeBaselineAction.command.trim()
  );
  const isInfraFailure = Boolean(
    baselineExecution &&
    (baselineExecution.status === "blocked" ||
      typeof baselineExecution.exitCode !== "number" ||
      baselineExecution.diagnosis?.category === "command_not_found")
  );
  const isValidBaseline = Boolean(
    baselineExecution &&
    typeof baselineExecution.exitCode === "number" &&
    ((baselineExecution.stdout?.length ?? 0) > 0 || (baselineExecution.stderr?.length ?? 0) > 0) &&
    !isInfraFailure
  );
  return { activeBaselineAction, isValidBaseline, isInfraFailure };
}

function isCorrelatedValidBaseline(
  session: AgentRuntimeSession,
  activeBaselineAction: Extract<AgentRuntimeSession["nextAction"], { kind: "await_baseline_command" }> | undefined,
  isValidBaseline: boolean,
  requestId?: string,
  command?: string
) {
  if (!activeBaselineAction || !isValidBaseline) return false;
  return (requestId !== undefined && requestId === activeBaselineAction.commandRequestId) ||
    (command !== undefined && command.trim() === activeBaselineAction.command.trim());
}

export function isBaselineCommand(
  session: AgentRuntimeSession,
  requestId?: string,
  command?: string,
  reason?: string,
  provenance?: import("@hivo/protocol").CommandExecutionProvenance
): boolean {
  const matchingExecution = (session.commandExecutions ?? []).find((exec) =>
    (requestId !== undefined && exec.requestId === requestId) ||
    (command !== undefined && exec.command.trim() === command.trim())
  );
  if (
    matchingExecution &&
    (matchingExecution.status === "blocked" ||
      typeof matchingExecution.exitCode !== "number" ||
      matchingExecution.diagnosis?.category === "command_not_found")
  ) {
    return false;
  }
  if (reason?.toLowerCase().includes("baseline") || provenance?.reason?.toLowerCase().includes("baseline")) {
    return true;
  }
  const { activeBaselineAction, isValidBaseline } = getValidBaselineDetails(session);
  if (isCorrelatedValidBaseline(session, activeBaselineAction, isValidBaseline, requestId, command)) {
    return true;
  }
  if (requestId) {
    const matchingReq = session.commandRequests.find((r) => r.id === requestId);
    if (matchingReq && (matchingReq.reason?.toLowerCase().includes("baseline") || matchingReq.provenance?.reason?.toLowerCase().includes("baseline"))) {
      return true;
    }
  }
  return false;
}

export function isBaselineExecution(
  session: AgentRuntimeSession,
  execution: import("@hivo/protocol").CommandExecutionRecord
): boolean {
  if (
    execution.status === "blocked" ||
    typeof execution.exitCode !== "number" ||
    execution.diagnosis?.category === "command_not_found"
  ) {
    return false;
  }
  if (execution.provenance?.reason?.toLowerCase().includes("baseline")) {
    return true;
  }
  if (execution.requestId) {
    if (isBaselineCommand(session, execution.requestId, execution.command)) {
      return true;
    }
  }
  const { activeBaselineAction, isValidBaseline } = getValidBaselineDetails(session);
  return isCorrelatedValidBaseline(session, activeBaselineAction, isValidBaseline, execution.requestId, execution.command);
}
