import type {
  AgentRuntimeSession,
  CommandExecutionRecord,
  PatchProposal,
  ProjectMap
} from "@hivo/protocol";
import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { LlmProvider } from "../llm/LlmProvider.js";
import type { ProviderTelemetryRecorder } from "../llm/ProviderTelemetry.js";
import {
  bridgeEditIntents,
  collectIntentsFromTree,
  extractPatchArtifactTargetPath,
  isActionableImplementationProposal,
  type BridgeEditIntent,
  type BridgeGeneratedArtifact,
  type BridgeResult
} from "../orchestration/RecursiveEditIntentBridge.js";
import type {
  BaselineCommandEvidence,
  ContextSnippet,
  MemoryEvidencePack,
  RecursiveContextSource,
  RecursiveSwarmNode,
  RecursiveSwarmRunState
} from "../orchestration/RecursiveSwarmModels.js";
import { RecursiveSwarmOrchestrator } from "../orchestration/RecursiveSwarmOrchestrator.js";
import { isSecretCandidate, shouldIgnore } from "../tools/security.js";
import { PatchTools } from "../tools/PatchTools.js";
import { WorkspaceTools } from "../tools/WorkspaceTools.js";
import { selectBaselineTestCommand } from "./RuntimePlanningTurnService.js";
import type { RuntimeDirectTurnService } from "./RuntimeDirectTurnService.js";
import { RuntimeSessionOutcomeService } from "./RuntimeSessionOutcomeService.js";
import { SessionManager } from "./SessionManager.js";

export type RuntimeRecursiveSwarmInput = {
  sessionId: string;
  message: string;
  provider: LlmProvider;
  providerTelemetry: ProviderTelemetryRecorder;
  projectMap: ProjectMap;
  thinkFirst?: boolean;
};

type RecursiveSwarmTerminalStatus = "completed" | "blocked" | "failed";

export class RuntimeRecursiveSwarmService {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly directTurnService: RuntimeDirectTurnService,
    private readonly sessionOutcomeService?: RuntimeSessionOutcomeService
  ) {}

  async run(input: RuntimeRecursiveSwarmInput): Promise<AgentRuntimeSession> {
    const { sessionId, message, provider, providerTelemetry, projectMap, thinkFirst } = input;
    const session = this.requireSession(sessionId);

    if (
      session.recursiveSwarmRunState?.planState === "ready_to_implement" &&
      session.recursiveSwarmRunState.tree.rawNodes &&
      !thinkFirst
    ) {
      const lastMessage = session.messages.at(-1);
      if (lastMessage?.role !== "user" || lastMessage.content !== message) {
        await this.sessionManager.addMessage(sessionId, { role: "user", content: message });
      }

      await this.directTurnService.addProviderProgressEvent(sessionId, {
        stage: "planning",
        status: "running",
        title: "Implementing recursive plan",
        summary: "Resuming from existing recursive plan without regenerating tree."
      });

      const rawNodes = session.recursiveSwarmRunState.tree.rawNodes as Record<
        string,
        Pick<RecursiveSwarmNode, "id" | "structuredOutput">
      >;
      const { intents, generatedArtifacts, validationPlans } = collectIntentsFromTree(rawNodes);
      const fileContents = gatherCurrentFileContents(session.workspacePath, intents, generatedArtifacts);
      const isImplementation = isImplementationIntent(session);
      const bridgeResult = validateRecursivePatchCandidates(bridgeEditIntents({
        sessionId,
        workspacePath: session.workspacePath,
        intents,
        generatedArtifacts,
        validationPlans,
        allowedPaths: [],
        forbiddenPaths: [],
        fileContents,
        originalGoal: session.recursiveSwarmRunState?.goalEnvelope?.originalGoal ?? session.userPrompt,
        deliverableContract: session.recursiveSwarmRunState?.expandedGoalSpec?.deliverableContract,
        isImplementation
      }), session.workspacePath, sessionId);

      const completedAt = new Date().toISOString();

      if (bridgeResult.auxiliaryArtifacts) {
        for (const item of bridgeResult.auxiliaryArtifacts) {
          await this.sessionManager.addArtifact(sessionId, {
            id: `rs_aux_${randomUUID().slice(0, 8)}`,
            sessionId,
            type: "summary",
            title: item.artifact.path,
            summary: item.artifact.description || `Diagnostic output from recursive swarm node ${item.nodeId}`,
            payload: {
              path: item.artifact.path,
              content: item.artifact.content,
              nodeId: item.nodeId,
              artifactType: item.artifact.artifact_type
            },
            createdAt: completedAt
          });
        }
      }

      const actionableProposals = bridgeResult.patchCandidates.filter((p) =>
        isActionableImplementationProposal(p, {
          isImplementation,
          originalGoal: session.recursiveSwarmRunState?.goalEnvelope?.originalGoal ?? session.userPrompt,
          deliverableContract: session.recursiveSwarmRunState?.expandedGoalSpec?.deliverableContract
        })
      );

      for (const proposal of (isImplementation ? actionableProposals : bridgeResult.patchCandidates)) {
        await this.sessionManager.addPatchProposal(sessionId, proposal);
      }

      const hasRealPatches = (isImplementation ? actionableProposals : bridgeResult.patchCandidates).length > 0;
      if (!hasRealPatches) {
        for (const cmd of bridgeResult.validationCommandRequests) {
          await this.sessionManager.addCommandRequest(sessionId, cmd);
        }
      }

      const sc = bridgeResult.summaryCounts;
      const bridgeNotes = buildRecursiveBridgeNotes(bridgeResult);
      const terminalStatus = mapRecursiveSwarmStatus(session.recursiveSwarmRunState.tree.status);

      await this.sessionManager.updateSession(sessionId, (draft) => {
        if (draft.recursiveSwarmRunState) {
          draft.recursiveSwarmRunState.stagedValidationCommands = bridgeResult.validationCommandRequests;
          draft.recursiveSwarmRunState.updatedAt = completedAt;
        }

        const isImplementation = isImplementationIntent(draft);
        if (hasRealPatches) {
          const isAutoApproved = draft.accessProfile === "full_access" || draft.accessProfile === "auto_review";
          draft.status = "needs_approval";
          draft.lifecycleStage = isAutoApproved ? "APPLY" : "APPROVAL";
          draft.nextAction = undefined;
        } else if (isImplementation) {
          draft.status = "blocked";
          draft.lifecycleStage = "BLOCKED";
          draft.nextAction = undefined;
        } else {
          draft.status = terminalStatus;
          draft.lifecycleStage =
            terminalStatus === "completed"
              ? "DONE"
              : terminalStatus === "blocked"
                ? "BLOCKED"
                : "FAILED";
          draft.nextAction = undefined;
        }

        draft.runSummary = {
          status: hasRealPatches ? "pending" : (isImplementation && !hasRealPatches ? "blocked" : terminalStatus),
          summary: isImplementation && !hasRealPatches
            ? "Recursive execution completed without producing an actionable patch."
            : `Recursive plan implementation: ${session.recursiveSwarmRunState?.tree.nodeCount ?? 0} node(s). ${sc.realDiff} real diff(s), ${sc.needsGeneration} need(s) generation, ${sc.blocked} blocked.`,
          filesChanged: [],
          appliedPatchIds: [],
          proposedPatchIds: (isImplementation ? actionableProposals : bridgeResult.patchCandidates).map((p) => p.id),
          commandResults: [],
          gates: [
            {
              name: "Recursive plan implementation",
              status:
                hasRealPatches
                  ? (terminalStatus === "completed" ? "passed" : terminalStatus === "blocked" ? "blocked" : "failed")
                  : (isImplementation ? "blocked" : (terminalStatus === "completed" ? "passed" : "blocked")),
              notes: [
                `nodeCount=${session.recursiveSwarmRunState?.tree.nodeCount}`,
                ...(isImplementation && !hasRealPatches ? ["Recursive execution completed without producing an actionable patch."] : []),
                ...bridgeNotes
              ]
            }
          ],
          nextAction:
            sc.realDiff > 0
              ? `Recursive swarm plan produced ${sc.realDiff} real patch proposal(s). Awaiting ${draft.accessProfile === "full_access" || draft.accessProfile === "auto_review" ? "Rust apply" : "operator approval"}.`
              : isImplementation && !hasRealPatches
                ? "Recursive execution completed without producing an actionable patch."
                : "Recursive plan implementation completed.",
          createdAt: completedAt
        };
      });

      await this.sessionManager.addMessage(sessionId, {
        role: "system",
        content: `Plan confirmed. Created ${bridgeResult.patchCandidates.length} patch proposal(s)${bridgeResult.validationCommandRequests.length ? ` and staged ${bridgeResult.validationCommandRequests.length} post-apply validation command(s)` : ""}.`
      });

      await this.directTurnService.addProviderProgressEvent(sessionId, {
        stage: "planning",
        status: hasRealPatches ? "running" : terminalStatus,
        title: "Recursive swarm plan implementation",
        summary: `Created ${bridgeResult.patchCandidates.length} patch proposal(s)${bridgeResult.validationCommandRequests.length ? ` and staged ${bridgeResult.validationCommandRequests.length} post-apply validation command(s)` : ""}.`
      });

      await (this.sessionOutcomeService ?? new RuntimeSessionOutcomeService(this.sessionManager)).sync(sessionId);
      return this.sessionManager.getSession(sessionId) ?? session;
    }

    const buildPack = (taskPrompt: string, nodeId: string) =>
      buildMemoryEvidencePack(taskPrompt, nodeId, session, projectMap);

    const lastMessage = session.messages.at(-1);
    if (lastMessage?.role !== "user" || lastMessage.content !== message) {
      await this.sessionManager.addMessage(sessionId, { role: "user", content: message });
    }

    await this.directTurnService.addProviderProgressEvent(sessionId, {
      stage: "planning",
      status: "running",
      title: "Recursive swarm started",
      summary: "Starting recursive tree decomposition and execution."
    });

    let liveProjectionQueue = Promise.resolve();
    let projectionQueuedAt = 0;
    let quietStatusChanges = 0;
    let orchestrator: RecursiveSwarmOrchestrator;
    const queueLiveProjection = (reason: string) => {
      const now = Date.now();
      if (now - projectionQueuedAt < 350 && reason === "node_status_changed") {
        quietStatusChanges++;
        if (quietStatusChanges < 20) return;
      }
      quietStatusChanges = 0;
      projectionQueuedAt = now;
      liveProjectionQueue = liveProjectionQueue
        .catch(() => {})
        .then(() => this.projectLiveRecursiveTree(sessionId, orchestrator, reason));
    };

    const addDurableProgress = (title: string, summary: string, status: "running" | "completed" | "blocked" | "failed" = "running") => {
      this.directTurnService.addProviderProgressEvent(sessionId, {
        stage: "planning",
        status,
        title,
        summary
      }).catch(() => {});
    };

    orchestrator = new RecursiveSwarmOrchestrator({
      buildPack,
      provider,
      workspacePath: session.workspacePath,
      options: {
        maxDepth: 10,
        maxAgents: 300,
        maxWriteExecutors: 6,
        enableGoalKeeper: true,
        enableParallelExecution: true,
        enableErrorRecovery: true
      },
      onNodeCreated: (node) => {
        queueLiveProjection("node_created");
      },
      onNodeStatusChanged: (node) => {
        queueLiveProjection("node_status_changed");
      },
      onDurableEvent: (event) => {
        queueLiveProjection(event.type);
        if (event.type === "intent_expanded") {
          addDurableProgress("Expanded recursive goal", `Preserved original prompt and extracted ${event.data.requirementCount ?? 0} requirement(s).`);
        } else if (event.type === "budget_planned") {
          addDurableProgress("Planned recursive staffing", `Soft budget ${event.data.softMaxAgents ?? "?"}/${event.data.hardMaxAgents ?? "?"}; max children ${event.data.maxChildrenPerParent ?? "?"}.`);
        } else if (event.type === "task_split") {
          addDurableProgress("Recursive split", `Parent created ${event.data.subTaskCount ?? 0} child task(s).`);
        } else if (event.type === "budget_gate") {
          addDurableProgress("Recursive budget gate", String(event.data.reason ?? "Budget gate applied."));
        } else if (event.type === "provider_backoff") {
          addDurableProgress("Provider backoff", String(event.data.reason ?? "Provider is rate limited or unreachable."), "blocked");
        } else if (event.type === "error") {
          addDurableProgress("Recursive node error", String(event.data.reason ?? "Recursive swarm error."), "failed");
        } else if (event.type === "collect_completed") {
          addDurableProgress("Collected recursive child results", `${event.data.childCount ?? 0} child result(s), ${event.data.errors ?? 0} unresolved error(s).`);
        } else if (event.type === "semantic_recovery_attempt") {
          addDurableProgress("Semantic implementation recovery", "Recovering required implementation deliverable from worker output.");
        } else if (event.type === "semantic_recovery_succeeded") {
          addDurableProgress("Semantic implementation recovery succeeded", "Worker produced required implementation deliverable.");
        } else if (event.type === "semantic_recovery_failed") {
          addDurableProgress("Semantic implementation recovery failed", "Worker failed to produce required implementation deliverable.", "blocked");
        }
      }
    });

    const result = await orchestrator.run(message, sessionId);
    await liveProjectionQueue.catch(() => {});
    const swarmState = orchestrator.toSwarmState();
    const state = result.runState;
    state.activityProjection = swarmState.activityProjection;
    const completedAt = new Date().toISOString();
    const terminalStatus = mapRecursiveSwarmStatus(state.tree.status);
    const failedNodes = swarmState.statusCounts.failed;
    const blockedNodes = swarmState.statusCounts.blocked;
    const { intents, generatedArtifacts, validationPlans } = collectIntentsFromTree(state.tree.nodes);
    const fileContents = gatherCurrentFileContents(session.workspacePath, intents, generatedArtifacts);
    const isImplementation = isImplementationIntent(session);
    const bridgeResult = validateRecursivePatchCandidates(bridgeEditIntents({
      sessionId,
      workspacePath: session.workspacePath,
      intents,
      generatedArtifacts,
      validationPlans,
      allowedPaths: [],
      forbiddenPaths: [],
      fileContents,
      originalGoal: state.goalEnvelope?.originalGoal ?? session.userPrompt,
      deliverableContract: state.expandedGoalSpec?.deliverableContract,
      isImplementation
    }), session.workspacePath, sessionId);

    const sc = bridgeResult.summaryCounts;
    const qm = bridgeResult.qualityMetrics;
    const bridgeNotes = buildRecursiveBridgeNotes(bridgeResult);

    if (thinkFirst) {
      const planReady = terminalStatus === "completed" && result.unresolvedErrors.length === 0;
      const planFailureStatus = terminalStatus === "blocked" ? "blocked" : "failed";
      const planModeMessage = formatRecursiveSwarmPlanModeMessage({
        message,
        finalOutput: result.finalOutput,
        tree: state.tree,
        bridgeResult,
        readyToImplement: planReady
      });

      await this.sessionManager.updateSession(sessionId, (draft) => {
        draft.recursiveSwarmRunState = buildRecursiveSwarmRunSnapshot(
          state,
          swarmState.nodes,
          planReady ? "ready_to_implement" : undefined
        );
        draft.swarmState = {
          ...swarmState,
          activityProjection: state.activityProjection ?? swarmState.activityProjection
        };
        draft.status = planReady ? "needs_approval" : planFailureStatus;
        draft.lifecycleStage = planReady
          ? "PLAN"
          : planFailureStatus === "blocked"
            ? "BLOCKED"
            : "FAILED";
        draft.nextAction = planReady
          ? {
              kind: "confirm_plan",
              message: "Plan is ready. Want me to proceed with implementation?"
            }
          : undefined;
        draft.agentName = "Recursive Swarm";
        draft.runSummary = {
          status: planReady ? "pending" : planFailureStatus,
          summary: planReady
            ? `Recursive swarm plan ready: ${state.tree.totalNodes} nodes across ${state.tree.maxDepth + 1} depth levels, ${result.totalSplits} splits, ${result.totalExecutions} executions. Plan is waiting for operator confirmation before implementation.`
            : `Recursive swarm planning did not pass verification (${terminalStatus}): ${result.unresolvedErrors.join("; ") || `${failedNodes} failed and ${blockedNodes} blocked node(s)`}`,
          filesChanged: [],
          appliedPatchIds: [],
          proposedPatchIds: [],
          commandResults: [],
          gates: [{
            name: "Recursive swarm planning",
            status: planReady ? "passed" : planFailureStatus,
            notes: [
              `totalNodes=${state.tree.totalNodes}`,
              `maxDepth=${state.tree.maxDepth}`,
              `totalSplits=${result.totalSplits}`,
              `totalExecutions=${result.totalExecutions}`,
              `failedNodes=${failedNodes}`,
              `blockedNodes=${blockedNodes}`,
              `unresolvedErrors=${result.unresolvedErrors.length}`,
              `planMode=true`,
              ...(planReady ? [] : ["Implementation is blocked because recursive planning did not pass verification."]),
              ...bridgeNotes
            ]
          }],
          nextAction: planReady
            ? "Plan is ready. Want me to proceed with implementation?"
            : "Review the failed or blocked recursive nodes; implementation cannot proceed.",
          createdAt: completedAt
        };
      });

      const telemetrySnapshot = providerTelemetry.snapshot();
      await this.sessionManager.addMessage(sessionId, {
        role: "assistant",
        content: planModeMessage,
        providerRequestRefs: telemetrySnapshot.providerRequestRefs
      });
      await this.directTurnService.addProviderProgressEvent(sessionId, {
        stage: "planning",
        status: planReady ? "completed" : planFailureStatus,
        title: planReady ? "Recursive swarm plan ready" : "Recursive swarm planning blocked",
        summary: planReady
          ? `Plan is waiting for operator confirmation before implementation (${bridgeResult.patchCandidates.length} patch(es) planned).`
          : `Planning did not pass verification: ${result.unresolvedErrors.length} unresolved error(s).`
      });
      return this.sessionManager.getSession(sessionId) ?? session;
    }

    if (bridgeResult.auxiliaryArtifacts) {
      for (const item of bridgeResult.auxiliaryArtifacts) {
        await this.sessionManager.addArtifact(sessionId, {
          id: `rs_aux_${randomUUID().slice(0, 8)}`,
          sessionId,
          type: "summary",
          title: item.artifact.path,
          summary: item.artifact.description || `Diagnostic output from recursive swarm node ${item.nodeId}`,
          payload: {
            path: item.artifact.path,
            content: item.artifact.content,
            nodeId: item.nodeId,
            artifactType: item.artifact.artifact_type
          },
          createdAt: completedAt
        });
      }
    }

    const actionableProposals = bridgeResult.patchCandidates.filter((p) =>
      isActionableImplementationProposal(p, {
        isImplementation,
        originalGoal: state.goalEnvelope?.originalGoal ?? session.userPrompt,
        deliverableContract: state.expandedGoalSpec?.deliverableContract
      })
    );

    for (const proposal of (isImplementation ? actionableProposals : bridgeResult.patchCandidates)) {
      await this.sessionManager.addPatchProposal(sessionId, proposal);
    }

    const hasRealPatches = (isImplementation ? actionableProposals : bridgeResult.patchCandidates).length > 0;
    if (!hasRealPatches) {
      for (const cmd of bridgeResult.validationCommandRequests) {
        await this.sessionManager.addCommandRequest(sessionId, cmd);
      }
    }

    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.recursiveSwarmRunState = {
        ...buildRecursiveSwarmRunSnapshot(state, swarmState.nodes, "ready_to_implement"),
        stagedValidationCommands: bridgeResult.validationCommandRequests
      };
      draft.swarmState = {
        ...swarmState,
        activityProjection: state.activityProjection ?? swarmState.activityProjection
      };

      const isImplementation = isImplementationIntent(draft);
      if (hasRealPatches) {
        const isAutoApproved = draft.accessProfile === "full_access" || draft.accessProfile === "auto_review";
        draft.status = "needs_approval";
        draft.lifecycleStage = isAutoApproved ? "APPLY" : "APPROVAL";
        draft.nextAction = undefined;
      } else if (isImplementation) {
        draft.status = "blocked";
        draft.lifecycleStage = "BLOCKED";
        draft.nextAction = undefined;
      } else {
        draft.status = terminalStatus;
        draft.lifecycleStage = terminalStatus === "completed"
          ? "DONE"
          : terminalStatus === "blocked"
            ? "BLOCKED"
            : "FAILED";
        draft.nextAction = undefined;
      }
      draft.agentName = "Recursive Swarm";
      draft.runSummary = {
        status: hasRealPatches ? "pending" : (isImplementation && !hasRealPatches ? "blocked" : terminalStatus),
        summary: isImplementation && !hasRealPatches
          ? "Recursive execution produced structured output but no actionable implementation patch."
          : `Recursive swarm completed: ${state.tree.totalNodes} nodes across ${state.tree.maxDepth + 1} depth levels, ${result.totalSplits} splits, ${result.totalExecutions} executions.${result.unresolvedErrors.length ? ` ${result.unresolvedErrors.length} unresolved error(s).` : ""} | ${sc.realDiff} real diff(s), ${sc.needsGeneration} need(s) generation, ${sc.blocked} blocked.`,
        filesChanged: [],
        appliedPatchIds: [],
        proposedPatchIds: (isImplementation ? actionableProposals : bridgeResult.patchCandidates).map((p) => p.id),
        commandResults: [],
        gates: [{
          name: "Recursive swarm execution",
          status: hasRealPatches
            ? (terminalStatus === "completed" ? "passed" : terminalStatus === "blocked" ? "blocked" : "failed")
            : (isImplementation ? "blocked" : (terminalStatus === "completed" ? "passed" : "blocked")),
          notes: [
            `totalNodes=${state.tree.totalNodes}`,
            `maxDepth=${state.tree.maxDepth}`,
            `totalSplits=${result.totalSplits}`,
            `totalExecutions=${result.totalExecutions}`,
            `failedNodes=${failedNodes}`,
            `blockedNodes=${blockedNodes}`,
            `unresolvedErrors=${result.unresolvedErrors.length}`,
            `finalOutputSource=${result.finalOutput.slice(0, 80)}`,
            ...(isImplementation && !hasRealPatches ? ["Recursive execution completed without producing an actionable patch."] : []),
            ...bridgeNotes
          ]
        }],
        nextAction: hasRealPatches
          ? `Recursive swarm produced ${sc.realDiff} real patch proposal(s). Awaiting ${draft.accessProfile === "full_access" || draft.accessProfile === "auto_review" ? "Rust apply" : "operator approval"}.${sc.needsGeneration > 0 ? ` ${sc.needsGeneration} intent(s) need patch generation.` : ""}${sc.blocked > 0 ? ` ${sc.blocked} intent(s) blocked.` : ""}`
          : isImplementation && !hasRealPatches
            ? "Recursive execution completed without producing an actionable patch."
            : sc.needsGeneration > 0
              ? `Recursive swarm completed with no real patches; ${sc.needsGeneration} intent(s) need patch generation.`
              : terminalStatus === "completed"
                ? "Recursive swarm completed."
                : `Recursive swarm ${terminalStatus}. Review failed/blocked nodes.`,
        createdAt: completedAt
      };
    });

    await (this.sessionOutcomeService ?? new RuntimeSessionOutcomeService(this.sessionManager)).sync(sessionId);

    const telemetrySnapshot = providerTelemetry.snapshot();
    await this.sessionManager.addMessage(sessionId, {
      role: "assistant",
      content: result.finalOutput,
      providerRequestRefs: telemetrySnapshot.providerRequestRefs
    });
    await this.directTurnService.addProviderProgressEvent(sessionId, {
      stage: "planning",
      status: terminalStatus,
      title: `Recursive swarm ${terminalStatus}`,
      summary: `Recursive swarm ${terminalStatus}: ${state.tree.totalNodes} nodes, ${result.totalSplits} splits, ${result.totalExecutions} executions.${result.unresolvedErrors.length ? ` ${result.unresolvedErrors.length} errors.` : ""}`
    });
    return this.sessionManager.getSession(sessionId) ?? session;
  }

  private async projectLiveRecursiveTree(
    sessionId: string,
    orchestrator: RecursiveSwarmOrchestrator,
    reason: string
  ): Promise<void> {
    const state = orchestrator.getRunState();
    const swarmState = orchestrator.toSwarmState();
    state.activityProjection = swarmState.activityProjection;
    await this.sessionManager.updateSession(sessionId, (draft) => {
      if (draft.status === "completed" || draft.status === "failed" || draft.status === "blocked") return;
      draft.recursiveSwarmRunState = buildRecursiveSwarmRunSnapshot(state, swarmState.nodes);
      draft.swarmState = {
        ...swarmState,
        activityProjection: state.activityProjection ?? swarmState.activityProjection
      };
      draft.agentName = "Recursive Swarm";
      draft.status = "running";
      draft.lifecycleStage = "PLAN";
      draft.runSummary = {
        status: "pending",
        summary: `Recursive swarm running: ${state.tree.totalNodes} node(s), depth ${state.tree.maxDepth + 1}. Latest update: ${reason.replaceAll("_", " ")}.`,
        filesChanged: [],
        appliedPatchIds: [],
        proposedPatchIds: [],
        commandResults: [],
        gates: [],
        nextAction: "Recursive parent agents are still deciding child tasks, prompts, and execution order.",
        createdAt: new Date().toISOString()
      };
    });
  }

  private requireSession(sessionId: string) {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session;
  }
}

function buildRecursiveSwarmRunSnapshot(
  state: RecursiveSwarmRunState,
  nodes: NonNullable<AgentRuntimeSession["recursiveSwarmRunState"]>["tree"]["nodes"],
  planState?: "ready_to_implement" | "implemented"
): NonNullable<AgentRuntimeSession["recursiveSwarmRunState"]> {
  return {
    schemaVersion: state.schema_version,
    runId: state.runId,
    sessionId: state.sessionId,
    planState,
    goalEnvelope: state.goalEnvelope,
    expandedGoalSpec: state.expandedGoalSpec,
    budget: state.budget,
    activityProjection: state.activityProjection,
    checkpoint: state.checkpoint,
    tree: {
      schemaVersion: state.tree.schema_version,
      runId: state.tree.runId,
      rootGoal: state.tree.rootGoal,
      rootId: state.tree.rootId,
      nodeCount: state.tree.totalNodes,
      depth: state.tree.maxDepth,
      status: state.tree.status,
      createdAt: state.tree.createdAt,
      updatedAt: state.tree.updatedAt,
      nodes,
      rawNodes: state.tree.nodes
    },
    createdAt: state.createdAt,
    updatedAt: state.updatedAt
  };
}

export function formatRecursiveSwarmPlanModeMessage(input: {
  message: string;
  finalOutput: string;
  tree: { totalNodes: number; maxDepth: number };
  bridgeResult: BridgeResult;
  readyToImplement?: boolean;
}): string {
  const arabic = /[\u0600-\u06FF]/.test(input.message);
  const intro = arabic
    ? "اشتغلت في Plan mode فقط: قمت بالتحليل والتفكيك الهرمي ووقفت قبل أي تعديل أو تشغيل."
    : "I stayed in plan mode only: I performed recursive decomposition and reasoning, and stopped before any code patch application or mutating execution.";

  const filesPlanned = [...new Set(input.bridgeResult.patchCandidates.flatMap((p) => p.filesChanged.map((f) => f.path)))];
  const commandsPlanned = [...new Set(input.bridgeResult.validationCommandRequests.map((c) => c.command))];

  const sections: string[] = [
    intro,
    "",
    input.finalOutput,
    ""
  ];

  if (filesPlanned.length > 0) {
    sections.push(arabic ? "## الملفات المخطط تعديلها" : "## Planned File Modifications");
    for (const file of filesPlanned) {
      sections.push(`- \`${file}\``);
    }
    sections.push("");
  }

  if (commandsPlanned.length > 0) {
    sections.push(arabic ? "## أوامر التحقق المخططة" : "## Planned Validation Commands");
    for (const cmd of commandsPlanned) {
      sections.push(`- \`${cmd}\``);
    }
    sections.push("");
  }

  if (input.readyToImplement !== false) {
    sections.push(
      arabic
        ? "لو الخطة مناسبة، اضغط Implement plan للبدء بالتنفيذ والتحقق."
        : "If the plan looks right, choose Implement plan to proceed with patch application and validation."
    );
  } else {
    sections.push(
      arabic
        ? "لم يجتز التخطيط التحقق؛ التنفيذ محظور حتى مراجعة العقد المتعثرة."
        : "Recursive planning did not pass verification; implementation is blocked until the failed or blocked nodes are reviewed."
    );
  }

  return sections.join("\n");
}

function mapRecursiveSwarmStatus(status: string): RecursiveSwarmTerminalStatus {
  if (status === "succeeded") return "completed";
  if (status === "blocked") return "blocked";
  return "failed";
}

/**
 * Safely reads authoritative workspace file contents for edit intents and generated artifacts
 * targeting existing files, using the existing confined WorkspaceTools reader.
 *
 * Safety properties:
 * - Confinement: WorkspaceTools.readWholeFile resolves inside session.workspacePath, throwing on traversal
 * - Secret blocking: WorkspaceTools blocks secret-like files (.env, .pem, credentials, etc.)
 * - Text-file validation: Binary and image files are blocked
 * - Safe missing-file handling: Does NOT substitute "" on read failures; unreadable files remain absent from map
 * - Read-only: Zero writes occur; WorkspaceTools write/delete are disabled
 * - No child filesystem access: Gathered exclusively at parent/orchestrator level
 */
export function gatherCurrentFileContents(
  workspacePath: string | undefined,
  intents: BridgeEditIntent[],
  generatedArtifacts?: BridgeGeneratedArtifact[]
): Record<string, string> {
  const fileContents: Record<string, string> = {};
  if (!workspacePath) {
    return fileContents;
  }

  // 1. Identify target paths that operate on existing files
  const existingFileTargets = new Set<string>();

  for (const item of intents) {
    // Genuine create operations do not require existing file content.
    // Operations on existing files (modify, delete, refactor) require current content.
    const op = item.intent?.operation;
    if (op && op !== "create" && item.intent.target_file) {
      const trimmed = item.intent.target_file.trim();
      if (trimmed) {
        existingFileTargets.add(trimmed);
      }
    }
  }

  // For generated artifacts, if they target a file that already exists in the workspace,
  // gather its content so the bridge can normalize existing-file patches.
  if (generatedArtifacts) {
    for (const item of generatedArtifacts) {
      if (item.artifact?.path) {
        const trimmed = item.artifact.path.trim();
        if (trimmed) {
          existingFileTargets.add(trimmed);
        }
      }
      const innerTarget = extractPatchArtifactTargetPath(item.artifact);
      if (innerTarget) {
        existingFileTargets.add(innerTarget);
      }
    }
  }

  if (existingFileTargets.size === 0) {
    return fileContents;
  }

  let workspaceTools: WorkspaceTools;
  try {
    workspaceTools = new WorkspaceTools(workspacePath);
  } catch {
    return fileContents;
  }

  for (const relativePath of existingFileTargets) {
    try {
      // WorkspaceTools.readWholeFile enforces:
      // - workspace-root confinement (throws if path is outside active workspace)
      // - secret blocking (throws if secret candidate)
      // - text-file validation (throws if binary file)
      // - existence check (throws if does not exist)
      // - file check (throws if not a regular file)
      // - read-only (no writes)
      const content = workspaceTools.readWholeFile(relativePath);
      fileContents[relativePath] = content;
      const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
      if (normalized && normalized !== relativePath) {
        fileContents[normalized] = content;
      }
    } catch {
      // If a required existing file cannot be safely read:
      // do NOT substitute "" and pretend it was read;
      // preserve absence so downstream SurgicalPatchBuilder / bridge blocks with explicit diagnostic.
    }
  }

  return fileContents;
}

function buildRecursiveBridgeNotes(bridgeResult: ReturnType<typeof bridgeEditIntents>) {
  const sc = bridgeResult.summaryCounts;
  const qm = bridgeResult.qualityMetrics;
  const bridgeNotes: string[] = [];
  if (sc.realDiff > 0) bridgeNotes.push(`realDiffs=${sc.realDiff}`);
  if (sc.needsGeneration > 0) bridgeNotes.push(`needsGeneration=${sc.needsGeneration}`);
  if (sc.blocked > 0) bridgeNotes.push(`blockedIntents=${sc.blocked}`);
  if (bridgeResult.validationCommandRequests.length > 0) {
    bridgeNotes.push(`valCommands=${bridgeResult.validationCommandRequests.length}`);
  }
  if (qm.readyOnFirstPass > 0 || qm.expandedSuccessfully > 0 || qm.expansionFailed > 0) {
    bridgeNotes.push(`qualityReady=${qm.readyOnFirstPass},expanded=${qm.expandedSuccessfully},expansionFail=${qm.expansionFailed}`);
  }
  if (qm.topMissingFields.length > 0) {
    bridgeNotes.push(`topMissingFields=${qm.topMissingFields.slice(0, 3).join(",")}`);
  }
  bridgeNotes.push(...bridgeResult.diagnostics.filter((diagnostic) => diagnostic.startsWith("PatchTools rejected recursive proposal:")));
  return bridgeNotes;
}

function validateRecursivePatchCandidates(
  bridgeResult: BridgeResult,
  workspacePath: string,
  sessionId: string
): BridgeResult {
  const patchTools = new PatchTools(workspacePath);
  const validatedProposals: PatchProposal[] = [];
  let rejectedCount = 0;

  for (const candidate of bridgeResult.patchCandidates) {
    const proposal = patchTools.propose({
      title: candidate.title,
      summary: candidate.summary,
      riskLevel: candidate.riskLevel,
      filesChanged: candidate.filesChanged,
      artifacts: candidate.artifacts,
      unifiedDiff: candidate.unifiedDiff,
      requiresApproval: true,
      status: "proposed"
    }, sessionId);
    const validation = patchTools.validate(proposal);
    if (!validation.valid) {
      rejectedCount += 1;
      bridgeResult.diagnostics.push(
        `PatchTools rejected recursive proposal: ${candidate.title}: ${validation.errors.join("; ")}`
      );
      continue;
    }
    validatedProposals.push(proposal);
  }

  bridgeResult.patchCandidates = validatedProposals;
  bridgeResult.summaryCounts.realDiff = validatedProposals.length;
  bridgeResult.summaryCounts.blocked += rejectedCount;
  return bridgeResult;
}

export function findCorrelatedBaselineExecution(session: AgentRuntimeSession): CommandExecutionRecord | undefined {
  const baselineCommand = selectBaselineTestCommand(session.projectIntake);
  const matchingRequest = (session.commandRequests ?? []).find((req) => {
    if (baselineCommand && req.command.trim() === baselineCommand.trim()) return true;
    return req.reason?.toLowerCase().includes("baseline");
  });

  const executions = (session.commandExecutions ?? []).filter((exec) => {
    if (matchingRequest && exec.requestId === matchingRequest.id) return true;
    if (baselineCommand && exec.command.trim() === baselineCommand.trim()) return true;
    return false;
  });

  for (let i = executions.length - 1; i >= 0; i--) {
    const exec = executions[i]!;
    if (
      typeof exec.exitCode === "number" &&
      ((exec.stdout?.length ?? 0) > 0 || (exec.stderr?.length ?? 0) > 0) &&
      exec.status !== "blocked" &&
      exec.diagnosis?.category !== "command_not_found"
    ) {
      return exec;
    }
  }

  return executions.at(-1);
}

export function buildMemoryEvidencePack(
  taskPrompt: string,
  nodeId: string,
  session: AgentRuntimeSession,
  projectMap: ProjectMap
): MemoryEvidencePack {
  const intake = session.projectIntake;
  const taskLower = taskPrompt.toLowerCase();
  const taskKeywords = taskLower.split(/[^a-z0-9_.-]+/).filter((word) => word.length > 2);

  // 1. Correlated Baseline Command Evidence
  const correlatedExecution = findCorrelatedBaselineExecution(session);
  const baselineArtifact = correlatedExecution
    ? (session.artifacts ?? []).find((art) => {
        const payload = art.payload as Record<string, any> | undefined;
        return (
          payload?.requestId === correlatedExecution.requestId ||
          payload?.result?.id === correlatedExecution.id ||
          art.title === correlatedExecution.command
        );
      })
    : undefined;

  const baselineEvidence: BaselineCommandEvidence | undefined = correlatedExecution
    ? {
        command: correlatedExecution.command,
        requestId: correlatedExecution.requestId,
        exitCode: correlatedExecution.exitCode,
        stdout: correlatedExecution.stdout ?? "",
        stderr: correlatedExecution.stderr ?? "",
        status: correlatedExecution.status,
        provenance: correlatedExecution.provenance,
        artifactRef: baselineArtifact?.id ?? (correlatedExecution.id ? `artifact:command:${correlatedExecution.id}` : undefined)
      }
    : undefined;

  // 2. Select Relevant Files
  const allKnownFiles = intake
    ? [
        ...new Set([
          ...intake.importantFiles,
          ...intake.knownEntryPoints,
          ...(intake.contextPack?.relevantFiles ?? []),
          ...(intake.contextPack?.relatedTests ?? []),
          ...(intake.contextPack?.safeToEdit ?? []),
          ...(intake.contextPack?.confirmedRelevantFiles ?? [])
        ])
      ]
    : [...(projectMap.importantFiles ?? [])];

  const explicitWorkspaceFiles: string[] = [];
  if (session.workspacePath) {
    try {
      const workspaceRoot = realpathSync(session.workspacePath);
      const explicitPathPattern = /(?:^|[\s"'`(])((?:\.{1,2}[\\/])?(?:[A-Za-z0-9_.@-]+[\\/])+[A-Za-z0-9_.@-]+\.[A-Za-z0-9]+)(?=$|[\s"'`,;:!?)}\]])/g;
      for (const match of taskPrompt.matchAll(explicitPathPattern)) {
        const relativePath = match[1]!.replaceAll("\\", "/").replace(/^\.\//, "");
        if (!relativePath || path.isAbsolute(relativePath) || relativePath.split("/").includes("..")) {
          continue;
        }
        try {
          const resolvedPath = realpathSync(path.resolve(workspaceRoot, relativePath));
          const pathFromWorkspace = path.relative(workspaceRoot, resolvedPath);
          if (
            !pathFromWorkspace ||
            pathFromWorkspace === ".." ||
            pathFromWorkspace.startsWith(`..${path.sep}`) ||
            path.isAbsolute(pathFromWorkspace) ||
            !statSync(resolvedPath).isFile()
          ) {
            continue;
          }
          explicitWorkspaceFiles.push(pathFromWorkspace.replaceAll("\\", "/"));
        } catch {
          // Unresolvable paths cannot be used as source evidence.
        }
      }
    } catch {
      // An unresolvable workspace cannot contribute explicitly named source files.
    }
  }

  const testOutput = `${baselineEvidence?.stdout ?? ""}\n${baselineEvidence?.stderr ?? ""}`.toLowerCase();

  const fileMatchesKeyword = (filePath: string) => {
    const fileLower = filePath.toLowerCase();
    const base = path.basename(fileLower);
    const stem = base.replace(path.extname(base), "");
    return taskKeywords.some((kw) => fileLower.includes(kw) || kw.includes(base) || (stem.length > 2 && kw.includes(stem)));
  };

  const fileMatchesOutput = (filePath: string) => {
    if (!testOutput) return false;
    const fileLower = filePath.toLowerCase();
    const base = path.basename(fileLower);
    return testOutput.includes(fileLower) || testOutput.includes(base);
  };

  const keywordMatches = allKnownFiles.filter(fileMatchesKeyword);
  const outputMatches = allKnownFiles.filter(fileMatchesOutput);
  const fallbackMatches = (intake?.importantFiles ?? projectMap.importantFiles ?? []).slice(0, 5);

  const taskIdentifiers = [...taskPrompt.matchAll(/\b[A-Za-z_$][A-Za-z0-9_$]*\b/g)]
    .map(([identifier]) => identifier)
    .filter((identifier) => identifier.length > 3 && (/[a-z][A-Z]/.test(identifier) || identifier.includes("_")))
    .map((identifier) => identifier.toLowerCase());
  const protectedPaths = [
    ...(intake?.riskyFiles ?? []),
    ...(intake?.doNotTouchCandidates ?? [])
  ];
  const contentMatches = session.workspacePath
    ? findContentRelevantSources(session.workspacePath, taskIdentifiers, protectedPaths)
    : [];
  const contentMatchByPath = new Map(contentMatches.map((match) => [match.path, match]));
  const explicitFileSet = new Set(explicitWorkspaceFiles);
  const relevantFiles = [...new Set([
    ...explicitWorkspaceFiles,
    ...contentMatches.map((match) => match.path),
    ...keywordMatches,
    ...outputMatches,
    ...fallbackMatches
  ])].slice(0, 6);

  // 3. Read Bounded Source Snippets
  const snippets: ContextSnippet[] = [];
  const file_ranges: Record<string, string> = {};
  const maxSnippetChars = 2000;
  const maxTotalChars = 8000;
  let usedChars = 0;

  if (session.workspacePath) {
    try {
      const workspaceTools = new WorkspaceTools(session.workspacePath);
      for (const filePath of relevantFiles) {
        if (usedChars >= maxTotalChars) break;
        try {
          if (!workspaceTools.fileExists(filePath)) continue;
          const contentMatch = contentMatchByPath.get(filePath);
          const fullText = contentMatch?.content ?? workspaceTools.readFile(filePath);
          if (!fullText) continue;
          const remaining = Math.max(0, maxTotalChars - usedChars);
          const sliceLen = Math.min(maxSnippetChars, remaining);
          const excerpt = contentMatch && !explicitFileSet.has(filePath)
            ? selectRelevantSourceExcerpt(fullText, contentMatch.terms, sliceLen)
            : undefined;
          const content = excerpt?.content ?? fullText.slice(0, sliceLen);
          if (!content) continue;
          const startLine = excerpt?.startLine ?? 1;
          const lineCount = content.split(/\r?\n/).length;
          const endLine = startLine + lineCount - 1;
          const snippet: ContextSnippet = {
            path: filePath,
            start_line: startLine,
            end_line: endLine,
            content,
            truncated: excerpt?.truncated ?? fullText.length > content.length
          };
          snippets.push(snippet);
          file_ranges[filePath] = `${startLine}-${endLine}`;
          usedChars += content.length;
        } catch {
          // Ignore unreadable/secret files
        }
      }
    } catch {
      // WorkspaceTools initialization failure fallback
    }
  }

  // 4. Evidence References
  const evidence_refs: string[] = [];
  if (baselineEvidence) {
    evidence_refs.push(`command:${baselineEvidence.command}`);
    if (baselineEvidence.requestId && baselineEvidence.requestId !== baselineEvidence.command) {
      evidence_refs.push(`command:${baselineEvidence.requestId}`);
    }
    if (baselineEvidence.artifactRef) {
      evidence_refs.push(baselineEvidence.artifactRef);
    }
  }
  for (const snippet of snippets) {
    evidence_refs.push(`file:${snippet.path}#${snippet.start_line}-${snippet.end_line}`);
  }

  // 5. Confidence, Freshness & Grounding Semantics
  const hasSourceContent = snippets.length > 0 && snippets.some((s) => s.content.trim().length > 0);
  const hasCommandEvidence = Boolean(
    baselineEvidence &&
    (typeof baselineEvidence.exitCode === "number" ||
     baselineEvidence.stdout.length > 0 ||
     baselineEvidence.stderr.length > 0)
  );
  const hasEmpiricalEvidence = hasSourceContent || hasCommandEvidence;

  if (intake && (intake.intakeStatus === "completed" || intake.intakeStatus === "partial")) {
    const missingKeywords = taskKeywords.filter((keyword) =>
      !intake.importantFiles.some((filePath) => filePath.toLowerCase().includes(keyword))
    );

    let confidence: number;
    let freshnessStatus: "fresh" | "stale" | "unknown";
    let contextSource: RecursiveContextSource;

    if (hasEmpiricalEvidence) {
      const isPartial = intake.intakeStatus === "partial" || relevantFiles.length === 0;
      contextSource = isPartial ? "partial_context" : "memory_evidence";
      confidence = intake.confidence === "high"
        ? 0.9
        : intake.confidence === "medium"
          ? 0.65
          : intake.confidence === "low"
            ? 0.35
            : 0.2;
      freshnessStatus = confidence >= 0.65 ? "fresh" : confidence >= 0.35 ? "stale" : "unknown";
    } else {
      // Path-only evidence without source snippets or command execution
      contextSource = relevantFiles.length > 0 ? "partial_context" : "prompt_only_fallback";
      confidence = 0.25;
      freshnessStatus = "unknown";
    }

    const unknowns = intake.unknowns
      .filter((unknown) => taskKeywords.some((keyword) => unknown.toLowerCase().includes(keyword)))
      .slice(0, 5);

    const warnings = [
      ...(hasEmpiricalEvidence ? [] : ["Only path-level metadata available; no actual source snippets or baseline command results attached."]),
      ...(missingKeywords.length > 0 ? [`No intake file matched keywords: ${missingKeywords.slice(0, 5).join(", ")}`] : []),
      ...intake.warnings.slice(0, 3)
    ];

    return {
      pack_id: `pack_${nodeId.slice(0, 8)}`,
      node_id: nodeId,
      task_slice: taskPrompt.slice(0, 200),
      context_source: contextSource,
      intent_contract_ref: session.intentContract?.contract_id,
      relevant_files: relevantFiles,
      file_ranges,
      source_snippets: snippets,
      snippets,
      baseline_command: baselineEvidence,
      baseline_command_result: baselineEvidence,
      baseline_commands: baselineEvidence ? [baselineEvidence] : [],
      symbols: intake.moduleSummary,
      commands: [...new Set([...intake.knownCommands, ...intake.testCommands])].slice(0, 10),
      allowed_paths: [],
      forbidden_paths: [],
      evidence_refs,
      unknowns,
      warnings,
      confidence,
      freshness_status: freshnessStatus
    };
  }

  // Fallback when no intake exists
  return {
    pack_id: `pack_${nodeId.slice(0, 8)}`,
    node_id: nodeId,
    task_slice: taskPrompt.slice(0, 200),
    context_source: hasEmpiricalEvidence ? "partial_context" : "prompt_only_fallback",
    relevant_files: relevantFiles.slice(0, 10),
    file_ranges,
    source_snippets: snippets,
    snippets,
    baseline_command: baselineEvidence,
    baseline_command_result: baselineEvidence,
    baseline_commands: baselineEvidence ? [baselineEvidence] : [],
    symbols: [],
    commands: (projectMap.testCommands ?? []).slice(0, 6),
    allowed_paths: [],
    forbidden_paths: [],
    evidence_refs,
    unknowns: [],
    warnings: ["No project intake available; answer from task prompt and general knowledge only."],
    confidence: hasEmpiricalEvidence ? 0.3 : 0.1,
    freshness_status: "unknown"
  };
}

type ContentSourceMatch = {
  path: string;
  content: string;
  terms: string[];
  score: number;
};

const MAX_SOURCE_SCAN_ENTRIES = 500;
const MAX_SOURCE_SCAN_FILES = 160;
const MAX_SOURCE_SCAN_FILE_BYTES = 64 * 1024;
const MAX_SOURCE_SCAN_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_SCAN_MILLISECONDS = 1000;

function findContentRelevantSources(
  workspacePath: string,
  identifiers: string[],
  protectedPaths: string[]
): ContentSourceMatch[] {
  if (!identifiers.length) return [];
  let workspaceRoot: string;
  try {
    workspaceRoot = realpathSync(workspacePath);
  } catch {
    return [];
  }
  const workspaceTools = new WorkspaceTools(workspaceRoot);
  const protectedPrefixes = protectedPaths
    .map((protectedPath) => protectedPath.replaceAll("\\", "/").replace(/\/+$/, ""))
    .filter(Boolean);
  const isProtected = (filePath: string) =>
    protectedPrefixes.some((prefix) => filePath === prefix || filePath.startsWith(`${prefix}/`));
  const isGenerated = (filePath: string) =>
    /(^|\/)(generated|vendor|third_party|third-party)(\/|$)/i.test(filePath) ||
    /(?:^|[._-])(?:generated|min)\.(?:ts|tsx|js|jsx|css)$/i.test(filePath);
  let sourceEntries: ReturnType<WorkspaceTools["listFiles"]>;
  try {
    sourceEntries = workspaceTools.listFiles(MAX_SOURCE_SCAN_ENTRIES)
      .filter((entry) =>
        !entry.isDir &&
        !entry.isSecretCandidate &&
        /\.(ts|tsx|js|jsx|rs|py|go|java|cs|css|html)$/i.test(entry.path) &&
        !isGenerated(entry.path) &&
        !isProtected(entry.path)
      )
      .sort((left, right) => {
        const priority = (filePath: string) =>
          /(^|\/)(index|main|app)\.[^.]+$/i.test(filePath) ? 1 : 0;
        return priority(left.path) - priority(right.path) || left.path.localeCompare(right.path);
      })
      .slice(0, MAX_SOURCE_SCAN_FILES);
  } catch {
    return [];
  }
  const matches: ContentSourceMatch[] = [];
  const scanStartedAt = Date.now();
  let scannedBytes = 0;

  for (const entry of sourceEntries) {
    if (
      matches.length >= MAX_SOURCE_SCAN_FILES ||
      scannedBytes >= MAX_SOURCE_SCAN_TOTAL_BYTES ||
      Date.now() - scanStartedAt >= MAX_SOURCE_SCAN_MILLISECONDS
    ) {
      break;
    }
    try {
      const resolvedPath = realpathSync(path.resolve(workspaceRoot, entry.path));
      const pathFromWorkspace = path.relative(workspaceRoot, resolvedPath);
      if (
        !pathFromWorkspace ||
        pathFromWorkspace === ".." ||
        pathFromWorkspace.startsWith(`..${path.sep}`) ||
        path.isAbsolute(pathFromWorkspace) ||
        shouldIgnore(pathFromWorkspace) ||
        isSecretCandidate(resolvedPath) ||
        isGenerated(pathFromWorkspace.replaceAll("\\", "/")) ||
        isProtected(pathFromWorkspace.replaceAll("\\", "/"))
      ) {
        continue;
      }
      const fileStats = statSync(resolvedPath);
      if (!fileStats.isFile() || fileStats.size > MAX_SOURCE_SCAN_FILE_BYTES) continue;
      if (scannedBytes + fileStats.size > MAX_SOURCE_SCAN_TOTAL_BYTES) continue;
      scannedBytes += fileStats.size;
      const content = workspaceTools.readFile(entry.path);
      const lowerContent = content.toLowerCase();
      const terms = identifiers.filter((identifier) => lowerContent.includes(identifier));
      if (terms.length) {
        matches.push({ path: entry.path, content, terms, score: terms.length });
      }
    } catch {
      // Unreadable, changed, or out-of-workspace paths cannot be source evidence.
    }
  }

  return matches.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
}

function selectRelevantSourceExcerpt(content: string, terms: string[], maxChars: number) {
  const lines = content.split(/\r?\n/);
  const lowerTerms = terms.map((term) => term.toLowerCase());
  const relevantLine = lines.findIndex((line) => {
    const lowerLine = line.toLowerCase();
    return lowerTerms.some((term) => lowerLine.includes(term));
  });
  if (relevantLine < 0) {
    return { content: content.slice(0, maxChars), startLine: 1, truncated: content.length > maxChars };
  }

  let startIndex = Math.max(0, relevantLine - 3);
  const contextChars = lines
    .slice(startIndex, relevantLine)
    .reduce((total, line) => total + line.length + 1, 0);
  if (contextChars >= Math.floor(maxChars / 2)) startIndex = relevantLine;
  const excerptLines: string[] = [];
  let usedChars = 0;
  let endIndex = startIndex;
  let truncated = startIndex > 0;
  for (let index = startIndex; index < lines.length; index++) {
    const line = lines[index]!;
    const separatorChars = excerptLines.length ? 1 : 0;
    const remaining = maxChars - usedChars - separatorChars;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    if (line.length > remaining) {
      if (index === relevantLine) {
        const lowerLine = line.toLowerCase();
        const matchOffset = lowerTerms
          .map((term) => lowerLine.indexOf(term))
          .filter((offset) => offset >= 0)
          .sort((left, right) => left - right)[0] ?? 0;
        const offset = Math.max(0, Math.min(matchOffset - Math.floor(remaining / 4), line.length - remaining));
        excerptLines.push(line.slice(offset, offset + remaining));
        endIndex = index;
      }
      truncated = true;
      break;
    }
    excerptLines.push(line);
    usedChars += separatorChars + line.length;
    endIndex = index;
  }
  if (endIndex < lines.length - 1) truncated = true;
  return {
    content: excerptLines.join("\n"),
    startLine: startIndex + 1,
    truncated
  };
}

export function isImplementationIntent(session: AgentRuntimeSession): boolean {
  if (session.latestDecisionPipeline?.query.route === "swarm_readonly") {
    return false;
  }
  if (session.latestDecisionPipeline?.query.intentKind === "workspace_question") {
    return false;
  }
  if (session.latestDecisionPipeline?.query.intentKind === "workspace_action") {
    return true;
  }
  if (session.runIntent === "implement_module" || session.runIntent === "run_to_green") {
    return true;
  }
  const goal = session.recursiveSwarmRunState?.goalEnvelope?.originalGoal ?? session.userPrompt ?? "";
  const isExplicitReadOnly =
    /\b(read-?only|inspect-?only|explain|understand)\b/i.test(goal) &&
    !/\b(fix|edit|modify|change|patch|implement|update|repair|create)\b/i.test(goal);
  if (isExplicitReadOnly) {
    return false;
  }
  return /\b(fix|edit|modify|change|patch|implement|update|repair|make .* change|create)\b/i.test(goal);
}
