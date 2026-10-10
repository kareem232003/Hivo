import type { AgentRuntimeSession } from "@hivo/protocol";
import { randomUUID } from "node:crypto";
import { IntentLedgerService } from "../orchestration/IntentLedgerService.js";
import { RuntimePlanPendingActionService } from "./RuntimePlanPendingActionService.js";
import { SessionManager } from "./SessionManager.js";

export type RuntimePendingActionResult = {
  handled: boolean;
  resumePrompt?: string;
};

export class RuntimePendingActionService {
  constructor(private readonly sessionManager: SessionManager) {}

  async handle(session: AgentRuntimeSession, message: string): Promise<RuntimePendingActionResult> {
    const normalized = message.trim().toLowerCase();
    if (normalized === "resume_baseline_planning") {
      if (session.nextAction?.kind === "await_baseline_command") {
        const action = session.nextAction;
        const matchingExecution = (session.commandExecutions ?? []).find((execution) =>
          execution.requestId === action.commandRequestId ||
          execution.command.trim() === action.command.trim()
        );
        const isValidExecution = Boolean(
          matchingExecution &&
          typeof matchingExecution.exitCode === "number" &&
          ((matchingExecution.stdout?.length ?? 0) > 0 || (matchingExecution.stderr?.length ?? 0) > 0) &&
          matchingExecution.status !== "blocked" &&
          matchingExecution.diagnosis?.category !== "command_not_found"
        );

        if (isValidExecution) {
          await this.sessionManager.updateSession(session.id, (draft) => {
            draft.nextAction = undefined;
            draft.status = "running";
            draft.lifecycleStage = "PLAN";
          });
          return {
            handled: false,
            resumePrompt: action.originalPrompt
          };
        }
      }
      return { handled: true };
    }

    if (!session.nextAction) {
      const resumePrompt = buildRecursiveCheckpointResumePrompt(session, message, normalized);
      if (resumePrompt) {
        await this.sessionManager.updateSession(session.id, (draft) => {
          draft.reasoningSummaries.push("Continuation request resolved to the latest recursive swarm checkpoint.");
          draft.status = "running";
          draft.lifecycleStage = "PLAN";
        });
        return { handled: false, resumePrompt };
      }
      return { handled: false };
    }
    if (session.nextAction.kind === "clarify_request") {
      const isDismissive = /^(no\s+)?just\s+(start|do\s+it|go|proceed)\b/i.test(normalized)
        || /\b(defaults?|whatever|i don'?t care|fine|anyway)\b/i.test(normalized);
      if (isDismissive) {
        await this.recordLockedClarification(session, "request_clarification", `${message.trim()} (proceed with defaults)`, "user_clarification");
        await this.sessionManager.updateSession(session.id, (draft) => {
          if (draft.intentContract?.status === "needs_clarification") {
            draft.intentContract.status = "ready";
            draft.intentContract.missing_questions = [];
          }
          draft.intent_contract_status = "ready";
          draft.nextAction = undefined;
          draft.status = "running";
          draft.lifecycleStage = "INTAKE";
        });
        return { handled: false, resumePrompt: `${session.nextAction.originalRequest}\n\n[User declined to clarify. Proceed with sensible defaults.]` };
      }
      const resumePrompt = `${session.nextAction.originalRequest}\n\nClarification: ${message.trim()}`;
      await this.recordLockedClarification(session, "request_clarification", message.trim(), "user_clarification");
      await this.sessionManager.updateSession(session.id, (draft) => {
        draft.userPrompt = resumePrompt;
        draft.nextAction = undefined;
      });
      return { handled: false, resumePrompt };
    }

    if (session.nextAction.kind === "clarify_product_spec") {
      const resumePrompt = `${session.userPrompt}\n\nProduct clarification: ${message.trim()}`;
      await this.recordLockedClarification(session, "product_spec_clarification", message.trim(), "user_clarification");
      await this.sessionManager.updateSession(session.id, (draft) => {
        draft.userPrompt = resumePrompt;
        draft.nextAction = undefined;
      });
      return { handled: false, resumePrompt };
    }

    const planAction = await new RuntimePlanPendingActionService(
      this.sessionManager,
      (targetSession, term, definition, source) => this.recordLockedClarification(targetSession, term, definition, source)
    ).handle(session, message);
    if (planAction.matched) return { handled: planAction.handled, resumePrompt: planAction.resumePrompt };

    if (session.nextAction.kind === "resolve_semantic_conflict") {
      const action = session.nextAction;
      const resolution = message.trim();
      await this.sessionManager.updateSession(session.id, (draft) => {
        const decision = draft.recursiveFactory?.semanticConflictDecisions?.find((candidate) => candidate.decision_id === action.decisionId);
        if (decision) {
          decision.decision = resolution;
          decision.reason = `User resolved semantic conflict: ${resolution}`;
          decision.requires_user_approval = false;
          decision.status = "resolved";
          decision.severity = "warning";
          decision.resolved_at = new Date().toISOString();
          decision.metadata_json = { ...decision.metadata_json, user_resolution: resolution };
        }
        for (const batch of draft.recursiveFactory?.semanticConflictBatches ?? []) {
          batch.decisions = batch.decisions.map((item) => item.decision_id === decision?.decision_id ? decision : item);
          batch.unresolved_decision_ids = batch.decisions
            .filter((item) => item.requires_user_approval || item.status === "requires_user_approval" || item.status === "blocked")
            .map((item) => item.decision_id);
          batch.status = batch.unresolved_decision_ids.length ? "requires_user_approval" : "resolved";
        }
        draft.status = "needs_approval";
        draft.lifecycleStage = "APPROVAL";
        draft.nextAction = undefined;
        draft.reasoningSummaries.push(`Semantic conflict resolved by user: ${resolution}`);
      });
      await this.sessionManager.addMessage(session.id, {
        role: "system",
        content: "Semantic conflict resolution recorded. You can retry the blocked action."
      });
      return { handled: true };
    }

    if (session.nextAction.kind === "confirm_preview") {
      if (/\b(run|open|yes|launch)\b/.test(normalized)) {
        const preview = session.nextAction.preview;
        const executionMessage = "Preview command approval is ready.";
        if (preview.command) {
          await this.sessionManager.addCommandRequest(session.id, {
            id: `cmd_${randomUUID()}`,
            sessionId: session.id,
            command: preview.command,
            cwd: session.workspacePath,
            risk: "safe",
            reason: "User requested preview launch; Rust terminal authority must execute it.",
            provenance: {
              source: "user",
              trigger: "manual",
              requestedBy: "user",
              reason: "Preview launch confirmation from the user."
            },
            status: "requested",
            createdAt: new Date().toISOString()
          });
        }
        await this.sessionManager.updateSession(session.id, (draft) => {
          draft.nextAction = {
            kind: "preview_ready",
            message: executionMessage,
            preview
          };
        });
        await this.sessionManager.addMessage(session.id, {
          role: "system",
          content: `Preview is ready. Use the open button to launch ${preview.description.toLowerCase()}.`
        });
        return { handled: true };
      }

      await this.sessionManager.updateSession(session.id, (draft) => {
        draft.nextAction = undefined;
      });
      await this.sessionManager.addMessage(session.id, {
        role: "system",
        content: "Okay. I left the result in review mode without running the preview."
      });
      return { handled: true };
    }

    return { handled: false };
  }

  private async recordLockedClarification(
    session: AgentRuntimeSession,
    term: string,
    definition: string,
    source: "user_clarification" | "plan_clarification"
  ) {
    if (!definition.trim()) return;
    await new IntentLedgerService({
      workspacePath: session.workspacePath,
      sourceComponent: "RuntimePendingActionService"
    }).saveRuntimeLockedDefinition({
      sessionId: session.id,
      workspacePath: session.workspacePath,
      term,
      definition,
      source,
      approvalRef: `session:${session.id}:${term}`
    }).catch(() => undefined);
  }
}

export function buildRecursiveCheckpointResumePrompt(session: AgentRuntimeSession, message: string, normalized = message.trim().toLowerCase()): string | undefined {
  if (!isContinuationRequest(message, normalized)) return undefined;
  const checkpoint = session.recursiveSwarmRunState?.checkpoint;
  if (!checkpoint?.resumable) return undefined;
  const pending = checkpoint.pendingQueue.slice(0, 30);
  const failed = checkpoint.failedNodeIds.slice(0, 20);
  const artifactCount = checkpoint.generatedArtifacts.length;
  const activity = checkpoint.durableActivityRows.slice(-8).map((row) => `- ${row.title}: ${row.summary}`).join("\n");
  const userAddition = stripContinuationWords(message).trim();
  return [
    "Resume the previous recursive swarm run from its latest checkpoint.",
    "Do not reinterpret this as a brand-new unrelated request unless the user explicitly changed the goal.",
    "",
    "ORIGINAL GOAL (authoritative):",
    checkpoint.originalPrompt || session.userPrompt,
    "",
    "EXPANDED GOAL / SPEC:",
    checkpoint.expandedGoalSpec?.expandedGoal ?? session.recursiveSwarmRunState?.expandedGoalSpec?.expandedGoal ?? checkpoint.originalPrompt,
    "",
    "LAST STABLE PHASE:",
    checkpoint.lastStablePhase,
    "",
    "RUN BUDGET:",
    checkpoint.budget
      ? `taskClass=${checkpoint.budget.taskClass}; soft=${checkpoint.budget.softMaxAgents}; hard=${checkpoint.budget.hardMaxAgents}; maxChildren=${checkpoint.budget.maxChildrenPerParent}; maxDepth=${checkpoint.budget.maxDepth}`
      : "No budget snapshot recorded.",
    "",
    "CHECKPOINT SUMMARY:",
    `pending=${pending.length ? pending.join(", ") : "none"}`,
    `completed=${checkpoint.completedNodeIds.length}`,
    `failedOrBlocked=${failed.length ? failed.join(", ") : "none"}`,
    `generatedArtifacts=${artifactCount}`,
    "",
    "RECENT DURABLE ACTIVITY:",
    activity || "No durable activity rows recorded.",
    "",
    userAddition ? `USER CONTINUATION NOTE:\n${userAddition}` : "USER CONTINUATION NOTE:\nContinue from the saved checkpoint."
  ].join("\n");
}

function isContinuationRequest(message: string, normalized: string): boolean {
  const compact = normalized.replace(/[.!؟?،,\s]+/g, " ").trim();
  if (/^(continue|resume|go on|keep going|carry on|continue from here|resume from here)$/i.test(compact)) return true;
  return /^(كمل|كمّل|كمل من هنا|كمّل من هنا|كمل اللي كنت بتعمله|كمّل اللي كنت بتعمله)$/i.test(message.trim());
}

function stripContinuationWords(message: string): string {
  return message
    .replace(/^\s*(continue|resume|go on|keep going|carry on|continue from here|resume from here)\b[:\s-]*/i, "")
    .replace(/^\s*(كمل|كمّل)(\s+من\s+هنا|\s+اللي\s+كنت\s+بتعمله)?[:\s-]*/i, "");
}
