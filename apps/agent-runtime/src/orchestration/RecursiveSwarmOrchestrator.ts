import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { LlmProvider } from "../llm/LlmProvider.js";
import { invokeReasoningProviderStructured } from "../runtime/ReasoningKernel.js";
import { WorkspaceTools } from "../tools/WorkspaceTools.js";
import { isSecretCandidate, resolveInsideWorkspace } from "../tools/security.js";
import { GoalKeeperAgent } from "./GoalKeeperAgent.js";
import { HierarchicalCollector } from "./HierarchicalCollector.js";
import { RecursiveTaskSplitter } from "./RecursiveTaskSplitter.js";
import { SqliteTaskQueueBackend } from "./AgentTaskQueue.js";
import type {
  RecursiveSwarmNode,
  RecursiveSwarmTree,
  RecursiveSwarmRunOptions,
  RecursiveSwarmRunState,
  MemoryEvidencePack,
  RecursiveContextSource,
  DurableSwarmEvent,
  GoalEnvelope,
  GoalCheckResult,
  AtomicTaskAssessment,
  SteeringMessage,
  RecursiveNodeOutput,
  ExpandedGoalSpec,
  RecursiveRunBudget,
  RunActivityProjection,
  RecursiveRunCheckpoint,
  DurableActivityRow,
  SplitResult,
  SplitSubTask,
  WorkerExecutionContract,
  WorkerResponsibility
} from "./RecursiveSwarmModels.js";
import {
  RECURSIVE_SWARM_SCHEMA_VERSION,
  DEFAULT_RECURSIVE_SWARM_OPTIONS,
  createGoalEnvelope,
  normalizeRecursiveNodeOutput,
  wrapTextFallback,
  RECURSIVE_OUTPUT_KINDS,
  isStructuredNodeOutputValid,
  EDIT_INTENT_OPERATIONS,
  RISK_LEVELS,
  REVIEW_DECISIONS,
  isImplementationGoal,
  createWorkerExecutionContract,
  extractLocalTaskObjective,
  classifyWorkerResponsibility
} from "./RecursiveSwarmModels.js";
import {
  isActionableImplementationOutput,
  isPatchReadyImplementationOutput,
  assessImplementationPatchReadiness
} from "./RecursiveEditIntentBridge.js";
import type {
  AgentRuntimeSwarmNode,
  AgentRuntimeSwarmNodeKind,
  AgentRuntimeSwarmState
} from "@hivo/protocol";

export type RecursiveSwarmOrchestratorOptions = {
  provider?: LlmProvider;
  workspacePath?: string;
  options?: Partial<RecursiveSwarmRunOptions>;
  onNodeCreated?: (node: RecursiveSwarmNode) => void;
  onNodeStatusChanged?: (node: RecursiveSwarmNode) => void;
  onTreeUpdated?: (tree: RecursiveSwarmTree) => void;
  onDurableEvent?: (event: DurableSwarmEvent) => void;
  /** Build a per-node MemoryEvidencePack from the node's task prompt */
  buildPack?: (taskPrompt: string, nodeId: string) => MemoryEvidencePack;
};

export type RecursiveSwarmResult = {
  tree: RecursiveSwarmTree;
  runState: RecursiveSwarmRunState;
  finalOutput: string;
  goalCheckHistory: GoalCheckResult[];
  totalSplits: number;
  totalExecutions: number;
  unresolvedErrors: string[];
  contextSourceCounts: Record<RecursiveContextSource, number>;
};

function isPlaceholderPath(rawPath: string): boolean {
  const trimmed = rawPath.trim();
  if (!trimmed) return true;
  if (/^<.*>$/.test(trimmed)) return true;
  if (/\b(?:to be filled|placeholder|runtime will fill|sourceLocation\.txt)\b/i.test(trimmed)) return true;
  return false;
}

function extractCandidatePathsFromPrerequisite(
  prerequisite: RecursiveSwarmNode,
  workspaceRoot: string
): string[] {
  const candidates: string[] = [];
  const textCorpus: string[] = [];

  if (prerequisite.structuredOutput) {
    const out = prerequisite.structuredOutput;
    if (out.kind === "generated_artifact") {
      textCorpus.push(out.content);
    } else if (out.kind === "evidence_report") {
      for (const f of out.files) {
        textCorpus.push(f);
      }
      textCorpus.push(...out.findings);
    } else if (out.kind === "edit_intent") {
      textCorpus.push(out.target_file);
    }
  }
  if (prerequisite.outputSummary) {
    textCorpus.push(prerequisite.outputSummary);
  }

  const combined = textCorpus.join("\n");
  const fileMatches = combined.match(/[A-Za-z0-9_\-./\\]+\.[a-zA-Z0-9]+/g) ?? [];
  for (const match of fileMatches) {
    const cleaned = match.replace(/^[<"']+|[>"',;:)]+$/g, "").replace(/\\/g, "/");
    if (!cleaned || isPlaceholderPath(cleaned) || path.isAbsolute(cleaned)) continue;
    try {
      const lexical = resolveInsideWorkspace(workspaceRoot, cleaned);
      if (existsSync(lexical) && statSync(lexical).isFile()) {
        if (!candidates.includes(cleaned)) {
          candidates.push(cleaned);
        }
      }
    } catch {
      // Ignore invalid candidates
    }
  }

  return candidates;
}

export class RecursiveSwarmOrchestrator {
  private readonly provider?: LlmProvider;
  private readonly workspacePath: string;
  private readonly splitter: RecursiveTaskSplitter;
  private readonly collector: HierarchicalCollector;
  private readonly goalKeeper: GoalKeeperAgent;
  private readonly runOptions: RecursiveSwarmRunOptions;
  private readonly onNodeCreated?: (node: RecursiveSwarmNode) => void;
  private readonly onNodeStatusChanged?: (node: RecursiveSwarmNode) => void;
  private readonly onTreeUpdated?: (tree: RecursiveSwarmTree) => void;
  private readonly onDurableEvent?: (event: DurableSwarmEvent) => void;
  private readonly buildPack?: (taskPrompt: string, nodeId: string) => MemoryEvidencePack;

  private tree!: RecursiveSwarmTree;
  private runState!: RecursiveSwarmRunState;
  private totalSplits = 0;
  private totalExecutions = 0;
  private goalCheckHistory: GoalCheckResult[] = [];
  private durableEvents: DurableSwarmEvent[] = [];
  private sessionId: string = "";
  private expandedGoalSpec?: ExpandedGoalSpec;
  private budget?: RecursiveRunBudget;
  private semanticRecoveryAttemptsByNode = new Set<string>();
  private totalSemanticRecoveryAttempts = 0;
  private readonly maxRunSemanticRecoveries: number = 3;
  private contextSourceCounts: Record<RecursiveContextSource, number> = {
    memory_evidence: 0,
    partial_context: 0,
    prompt_only_fallback: 0
  };

  constructor(options: RecursiveSwarmOrchestratorOptions = {}) {
    this.provider = options.provider;
    this.workspacePath = options.workspacePath ?? "";
    this.runOptions = { ...DEFAULT_RECURSIVE_SWARM_OPTIONS, ...options.options };
    this.buildPack = options.buildPack;
    this.splitter = new RecursiveTaskSplitter({
      provider: this.provider,
      complexityThreshold: this.runOptions.complexityThreshold
    });
    this.collector = new HierarchicalCollector({
      provider: this.provider,
      enableErrorRecovery: this.runOptions.enableErrorRecovery
    });
    this.goalKeeper = new GoalKeeperAgent({
      provider: this.provider,
      checkIntervalMs: this.runOptions.goalCheckIntervalMs
    });
    this.onNodeCreated = options.onNodeCreated;
    this.onNodeStatusChanged = options.onNodeStatusChanged;
    this.onTreeUpdated = options.onTreeUpdated;
    this.onDurableEvent = options.onDurableEvent;
  }

  async createRootAndGoalKeeper(goal: string, sessionId: string): Promise<{ root: RecursiveSwarmNode; goalKeeperNode: RecursiveSwarmNode }> {
    this.sessionId = sessionId;
    const runId = `recursive_swarm_${randomUUID()}`;
    const expandedGoalSpec = await this.expandGoalSpec(goal);
    const budget = this.planRunBudget(expandedGoalSpec);
    this.expandedGoalSpec = expandedGoalSpec;
    this.budget = budget;
    const goalEnvelope = createGoalEnvelope({
      originalGoal: goal,
      expandedGoalSpec,
      workspaceIdentity: this.workspacePath,
      localTask: goal
    });
    const rootRequiresImpl = isImplementationGoal(goal);
    const rootContract = createWorkerExecutionContract({
      nodeId: "pending",
      localObjective: goal,
      originalGoal: goal,
      title: "Root",
      isRootGoalImplementation: rootRequiresImpl,
      explicitResponsibility: rootRequiresImpl ? "IMPLEMENT" : "INSPECT"
    });
    const rootNode = this.createNode({
      name: "Root",
      kind: "root",
      taskPrompt: goal,
      goalEnvelope,
      parentId: undefined,
      depth: 0,
      contract: rootContract
    });
    rootContract.nodeId = rootNode.id;

    const goalKeeperContract = createWorkerExecutionContract({
      nodeId: "pending",
      parentId: rootNode.id,
      localObjective: `Monitor alignment with original goal: ${goal}`,
      originalGoal: goal,
      title: "Goal Keeper",
      parentContract: rootContract,
      explicitResponsibility: "VERIFY"
    });
    const goalKeeperNode = this.createNode({
      name: `Goal Keeper`,
      kind: "goal_keeper",
      taskPrompt: `Monitor alignment with original goal: ${goal}`,
      goalEnvelope,
      parentId: rootNode.id,
      depth: 0,
      contract: goalKeeperContract
    });
    goalKeeperContract.nodeId = goalKeeperNode.id;
    rootNode.children.push(goalKeeperNode.id);
    this.tree = {
      schema_version: RECURSIVE_SWARM_SCHEMA_VERSION,
      runId,
      rootGoal: goal,
      rootId: rootNode.id,
      nodes: { [rootNode.id]: rootNode, [goalKeeperNode.id]: goalKeeperNode },
      maxDepth: 0,
      totalNodes: 2,
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.runState = {
      schema_version: RECURSIVE_SWARM_SCHEMA_VERSION,
      runId,
      sessionId,
      goalEnvelope,
      expandedGoalSpec,
      budget,
      tree: this.tree,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      durableEvents: [],
      activityProjection: undefined,
      checkpoint: undefined,
      contextSourceCounts: { memory_evidence: 0, partial_context: 0, prompt_only_fallback: 0 }
    };
    this.emitDurableEvent("run_created", undefined, { goal, rootId: rootNode.id });
    this.emitDurableEvent("intent_expanded", rootNode.id, {
      originalPromptHash: expandedGoalSpec.originalPromptHash,
      isAlreadyDetailed: expandedGoalSpec.isAlreadyDetailed,
      requirementCount: expandedGoalSpec.requirements.length,
      deliverableContract: expandedGoalSpec.deliverableContract,
      generatedBy: expandedGoalSpec.generatedBy,
      warnings: expandedGoalSpec.warnings
    });
    this.emitDurableEvent("budget_planned", rootNode.id, budget);
    this.writeCheckpoint("intent_expanded");
    this.emitNodeCreated(rootNode);
    this.emitNodeCreated(goalKeeperNode);
    this.emitTreeUpdated();
    return { root: rootNode, goalKeeperNode };
  }

  async run(goal: string, sessionId?: string): Promise<RecursiveSwarmResult> {
    if (!this.tree) {
      await this.createRootAndGoalKeeper(goal, sessionId ?? "");
    }
    const rootNode = this.tree.nodes[this.tree.rootId];
    await this.processNode(rootNode);

    // Build context-source summary
    const totalNodes = Object.values(this.tree.nodes).length;
    const evidenceCount = this.contextSourceCounts.memory_evidence;
    const partialCount = this.contextSourceCounts.partial_context;
    const fallbackCount = this.contextSourceCounts.prompt_only_fallback;
    const summaryLines: string[] = [];
    if (evidenceCount > 0) summaryLines.push(`${evidenceCount}/${totalNodes} nodes used memory evidence`);
    if (partialCount > 0) summaryLines.push(`${partialCount}/${totalNodes} nodes used partial context`);
    if (fallbackCount > 0) summaryLines.push(`${fallbackCount}/${totalNodes} nodes used prompt-only fallback`);
    const sourceSummary = summaryLines.length > 0 ? summaryLines.join("; ") : "No context-source data recorded";
    // Derive final output from structured artifacts
    const structured = rootNode.structuredOutput;
    const blockers = structured?.kind === "final_summary" ? structured.blockers
      : structured?.kind === "integration_summary" ? structured.unresolved_items
      : [];
    const structuredText = structured?.kind === "final_summary" ? structured.summary
      : structured?.kind === "integration_summary" ? structured.merged_findings.join("\n")
      : null;
    const rawOutput = structuredText ?? rootNode.collectResult?.mergedOutput
      ?? rootNode.outputSummary
      ?? "No output produced.";
    const generatedArtifactLines = collectGeneratedArtifactSummaries(this.tree.nodes);
    const artifactSuffix = generatedArtifactLines.length > 0
      ? `\n\nGenerated artifact(s):\n${generatedArtifactLines.map((line) => `- ${line}`).join("\n")}`
      : "";
    const blockerSuffix = blockers.length > 0 ? `\n\n[Blockers: ${blockers.join("; ")}]` : "";
    const finalOutput = `${rawOutput}${artifactSuffix}${blockerSuffix}\n\n[Context-source summary: ${sourceSummary}]`;
    this.runState.contextSourceCounts = { ...this.contextSourceCounts };
    this.tree.status = this.hasAnyFailed() ? "failed" : "succeeded";
    this.tree.updatedAt = new Date().toISOString();
    this.emitDurableEvent("run_completed", undefined, { status: this.tree.status });
    this.writeCheckpoint("run_completed", false);
    this.runState.activityProjection = this.getActivityProjection();
    this.emitTreeUpdated();
    return {
      tree: this.tree,
      runState: this.runState,
      finalOutput,
      goalCheckHistory: this.goalCheckHistory,
      totalSplits: this.totalSplits,
      totalExecutions: this.totalExecutions,
      unresolvedErrors: this.collectUnresolvedErrors(),
      contextSourceCounts: { ...this.contextSourceCounts }
    };
  }

  getRunState(): RecursiveSwarmRunState {
    return this.runState;
  }

  toSwarmState(): AgentRuntimeSwarmState {
    const nodeList = Object.values(this.tree.nodes);
    const rollup: Record<string, number> = {};
    const nodes: AgentRuntimeSwarmNode[] = nodeList.map((recursiveNode) => {
      const swarmNode = this.toSwarmNodeKind(recursiveNode.kind);
      const count = (rollup[recursiveNode.kind] ?? 0) + 1;
      rollup[recursiveNode.kind] = count;
      return {
        id: recursiveNode.id,
        parentId: recursiveNode.parentId,
        kind: swarmNode,
        nodeKind: recursiveNode.kind,
        name: recursiveNode.name,
        role: recursiveNode.role,
        status: this.toSwarmStatus(recursiveNode.status),
        objective: recursiveNode.taskPrompt.slice(0, 200),
        prompt: recursiveNode.taskPrompt,
        taskPrompt: recursiveNode.taskPrompt,
        originalGoal: recursiveNode.goalEnvelope.originalGoal,
        expandedGoal: recursiveNode.goalEnvelope.expandedGoal,
        depth: recursiveNode.depth,
        complexity: recursiveNode.complexity?.score,
        complexityRationale: recursiveNode.complexity?.rationale,
        goalAligned: this.getLatestAlignment(recursiveNode),
        currentAction: this.getCurrentAction(recursiveNode),
        summary: recursiveNode.collectResult?.mergedOutput ?? recursiveNode.outputSummary,
        output: recursiveNode.outputSummary,
        ownedPaths: [],
        targetFiles: [],
        changedFiles: [],
        artifactRefs: [],
        workItemRefs: [],
        evidenceRefs: [],
        riskRefs: [],
        updatedAt: recursiveNode.updatedAt
      };
    });
    return {
      schemaVersion: 1,
      rootId: this.tree.rootId,
      sessionId: this.tree.runId,
      swarmRunId: this.tree.runId,
      generatedAt: new Date().toISOString(),
      source: "recursive_factory",
      maxSupportedLogicalAgents: this.runOptions.maxAgents,
      effectiveTotalLogicalAgents: this.tree.totalNodes,
      activeAgentCount: nodeList.filter((n) =>
        n.status === "assessing" || n.status === "splitting" ||
        n.status === "executing" || n.status === "waiting_children" ||
        n.status === "verifying"
      ).length,
      statusCounts: {
        idle: nodeList.filter((n) => n.status === "created").length,
        queued: nodeList.filter((n) => n.status === "assessing" || n.status === "splitting" || n.status === "waiting_children" || n.status === "collecting" || n.status === "verifying").length,
        running: nodeList.filter((n) => n.status === "executing").length,
        completed: nodeList.filter((n) => n.status === "succeeded").length,
        blocked: nodeList.filter((n) => n.status === "blocked" || n.status === "escalated").length,
        failed: nodeList.filter((n) => n.status === "failed").length
      },
      staffingPlan: {
        summary: this.budget
          ? `Recursive tree: ${this.tree.totalNodes} nodes across ${this.tree.maxDepth + 1} depth levels with ${this.totalSplits} splits and ${this.totalExecutions} executions. Soft budget ${this.budget.softMaxAgents}/${this.budget.hardMaxAgents}; ${this.budget.reason}`
          : `Recursive tree: ${this.tree.totalNodes} nodes across ${this.tree.maxDepth + 1} depth levels with ${this.totalSplits} splits and ${this.totalExecutions} executions`,
        recommendedTotalLogicalAgents: this.budget?.softMaxAgents,
        maxParallelAgents: this.budget?.maxWriteExecutors ?? this.runOptions.maxWriteExecutors,
        writeAgentLimit: this.budget?.maxWriteExecutors ?? this.runOptions.maxWriteExecutors,
        validationLevel: this.budget?.taskClass === "audit" || this.budget?.taskClass === "campaign" ? "broad" : "focused",
        riskLevel: this.budget?.taskClass === "campaign" || this.budget?.taskClass === "audit" ? "high" : "medium",
        roleCounts: rollup as Record<string, number>,
        specialists: []
      },
      activityProjection: this.getActivityProjection(),
      metrics: this.budget ? {
        softMaxAgents: this.budget.softMaxAgents,
        hardMaxAgents: this.budget.hardMaxAgents,
        maxChildrenPerParent: this.budget.maxChildrenPerParent,
        budgetTaskClass: this.budget.taskClass
      } : undefined,
      nodes,
      messages: []
    };
  }

  addSteeringMessage(nodeId: string, text: string): SteeringMessage {
    const node = this.tree.nodes[nodeId];
    if (!node) throw new Error(`Node ${nodeId} not found`);
    const msg: SteeringMessage = {
      id: `steer_${randomUUID().slice(0, 8)}`,
      senderId: "user",
      text,
      checkpoint: node.status === "assessing" ? "pre_split" : node.status === "executing" ? "pre_execute" : "pre_accept",
      applied: false,
      createdAt: new Date().toISOString()
    };
    node.steeringQueue.push(msg);
    this.emitDurableEvent("steering_message", nodeId, { messageId: msg.id, text });
    return msg;
  }

  getActivityProjection(): RunActivityProjection {
    return buildActivityProjection(this.tree, this.durableEvents);
  }

  private async expandGoalSpec(goal: string): Promise<ExpandedGoalSpec> {
    const hash = hashPrompt(goal);
    if (!this.provider) {
      return unavailableGoalSpec(goal, hash, "Goal expansion requires a configured provider.");
    }
    try {
      const response = await invokeReasoningProviderStructured<Record<string, unknown>>(
        this.provider,
        {
          purpose: "reason",
          reasoningStage: "reason",
          responseFormat: "json",
          systemPrompt: `You are the Recursive Swarm Intent Expansion Gate.
Preserve the user's original prompt verbatim. If the prompt is short, expand it into a detailed implementation specification. If it is already detailed, do not summarize it destructively; extract requirements while keeping the expandedGoal close to the original.
Return structured JSON only. Never replace an artifact request with a small plan.`,
          userPrompt: `Original prompt:\n${goal}\n\nReturn a goal spec for recursive agents.`,
          maxOutputTokens: 4096
        },
        {
          name: "expanded_goal_spec",
          type: "object",
          additionalProperties: false,
          required: [
            "isAlreadyDetailed",
            "expandedGoal",
            "requirements",
            "acceptanceCriteria",
            "deliverableContract",
            "constraints",
            "nonGoals",
            "qualityBar"
          ],
          properties: {
            isAlreadyDetailed: { type: "boolean" },
            expandedGoal: { type: "string" },
            requirements: { type: "array", items: { type: "string" } },
            acceptanceCriteria: { type: "array", items: { type: "string" } },
            deliverableContract: { type: "string" },
            constraints: { type: "array", items: { type: "string" } },
            nonGoals: { type: "array", items: { type: "string" } },
            qualityBar: { type: "array", items: { type: "string" } }
          }
        }
      );
      return normalizeExpandedGoalSpec(goal, hash, response, "provider");
    } catch (error) {
      return unavailableGoalSpec(
        goal,
        hash,
        `Provider-backed goal expansion failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private planRunBudget(spec: ExpandedGoalSpec): RecursiveRunBudget {
    const text = `${spec.originalPrompt}\n${spec.expandedGoal}\n${spec.deliverableContract}`.toLowerCase();
    const explicitHuge = /\b(whole[-\s]?repo|entire repository|exhaustive|campaign|all files|large audit|security audit)\b/.test(text);
    const isAudit = /\b(audit|review all|security|performance audit)\b/.test(text);
    const isCreativeArtifact = /\b(3d|three\.js|game|single[-\s]?file|self[-\s]?contained|html|canvas|playable|polished)\b/.test(text);
    const isSmall = text.length < 700 && !isCreativeArtifact && !isAudit;
    const taskClass: RecursiveRunBudget["taskClass"] = explicitHuge
      ? "campaign"
      : isAudit
        ? "audit"
        : isCreativeArtifact
          ? "large"
          : isSmall
            ? "small"
            : "medium";
    const defaults: Record<RecursiveRunBudget["taskClass"], Pick<RecursiveRunBudget, "softMaxAgents" | "maxDepth" | "maxChildrenPerParent">> = {
      small: { softMaxAgents: 8, maxDepth: 3, maxChildrenPerParent: 4 },
      medium: { softMaxAgents: 24, maxDepth: 5, maxChildrenPerParent: 6 },
      large: { softMaxAgents: 48, maxDepth: 6, maxChildrenPerParent: 8 },
      audit: { softMaxAgents: 120, maxDepth: 7, maxChildrenPerParent: 10 },
      campaign: { softMaxAgents: 220, maxDepth: 10, maxChildrenPerParent: 12 }
    };
    const chosen = defaults[taskClass];
    const hardMaxAgents = Math.max(1, this.runOptions.maxAgents);
    const softMaxAgents = Math.min(this.runOptions.softMaxAgents ?? chosen.softMaxAgents, hardMaxAgents);
    const maxDepth = Math.min(this.runOptions.maxDepth, this.runOptions.taskClass ? this.runOptions.maxDepth : chosen.maxDepth);
    const maxChildrenPerParent = Math.max(1, Math.min(
      this.runOptions.maxChildrenPerParent ?? chosen.maxChildrenPerParent,
      hardMaxAgents
    ));
    return {
      hardMaxAgents,
      softMaxAgents,
      maxDepth,
      maxChildrenPerParent,
      maxWriteExecutors: this.runOptions.maxWriteExecutors,
      taskClass: this.runOptions.taskClass ?? taskClass,
      reason: `Task classified as ${this.runOptions.taskClass ?? taskClass}; soft budget prevents unbounded recursive splitting while preserving hard capacity.`
    };
  }

  private getBudget(): RecursiveRunBudget {
    if (this.budget) return this.budget;
    const goal = this.tree?.rootGoal ?? "";
    this.budget = this.planRunBudget(this.expandedGoalSpec ?? unavailableGoalSpec(goal, hashPrompt(goal), "Goal expansion has not run yet."));
    return this.budget;
  }

  private applySplitBudget(node: RecursiveSwarmNode, splitResult: SplitResult): SplitResult {
    const budget = this.getBudget();
    const usefulSubTasks = splitResult.subTasks.filter(isUsefulSplitSubTask);
    const requestedChildren = splitResult.subTasks.length;
    const remainingHardBudget = Math.max(0, budget.hardMaxAgents - this.tree.totalNodes - 1);
    const remainingSoftBudget = Math.max(0, budget.softMaxAgents - this.tree.totalNodes - 1);
    const acceptedChildren = Math.min(
      usefulSubTasks.length,
      budget.maxChildrenPerParent,
      remainingHardBudget,
      remainingSoftBudget
    );
    const accepted = usefulSubTasks.slice(0, acceptedChildren);
    const reasonParts: string[] = [];
    if (usefulSubTasks.length !== requestedChildren) reasonParts.push(`${requestedChildren - usefulSubTasks.length} low-value child task(s) removed`);
    if (accepted.length < usefulSubTasks.length) reasonParts.push(`clamped from ${usefulSubTasks.length} to ${accepted.length} by recursive run budget`);
    if (!reasonParts.length) reasonParts.push("accepted provider split within recursive run budget");
    if (accepted.length !== requestedChildren) {
      this.emitDurableEvent("budget_gate", node.id, {
        action: "clamp_split_children",
        requestedChildren,
        acceptedChildren: accepted.length,
        maxChildrenPerParent: budget.maxChildrenPerParent,
        remainingSoftBudget,
        remainingHardBudget,
        reason: reasonParts.join("; ")
      });
    }
    return {
      ...splitResult,
      subTasks: accepted,
      desiredChildCount: splitResult.desiredChildCount ?? requestedChildren,
      splitReason: splitResult.splitReason ?? splitResult.rationale,
      budgetDecision: {
        requestedChildren,
        acceptedChildren: accepted.length,
        remainingSoftBudget,
        remainingHardBudget,
        reason: reasonParts.join("; ")
      }
    };
  }

  private writeCheckpoint(lastStablePhase: string, resumable = true): void {
    if (!this.runState || !this.tree) return;
    const checkpoint = buildRecursiveRunCheckpoint({
      sessionId: this.sessionId,
      tree: this.tree,
      expandedGoalSpec: this.expandedGoalSpec,
      budget: this.budget,
      activityProjection: this.getActivityProjection(),
      lastStablePhase,
      resumable
    });
    this.runState.checkpoint = checkpoint;
    this.runState.activityProjection = this.getActivityProjection();
    this.runState.updatedAt = new Date().toISOString();
    this.emitDurableEvent("checkpoint_written", undefined, {
      lastStablePhase,
      resumable,
      pendingNodes: checkpoint.pendingQueue.length,
      completedNodes: checkpoint.completedNodeIds.length,
      failedNodes: checkpoint.failedNodeIds.length
    });
  }

  private async processNode(node: RecursiveSwarmNode): Promise<void> {
    await this.processSteeringQueue(node);
    await this.checkGoalAt(node, "pre_split");
    if (node.status === "blocked" || node.status === "failed" || node.status === "escalated") return;

    const budget = this.getBudget();
    if (node.depth >= budget.maxDepth) {
      this.emitDurableEvent("budget_gate", node.id, {
        action: "execute_at_depth_limit",
        depth: node.depth,
        maxDepth: budget.maxDepth,
        reason: "Depth budget reached; executing the current node instead of recursively splitting again."
      });
      await this.enqueueNodeExecution(node);
      return;
    }
    if (this.tree.totalNodes >= budget.hardMaxAgents) {
      node.status = "escalated";
      node.errorSummary = `Hard agent capacity (${budget.hardMaxAgents}) reached; cannot split further.`;
      this.emitNodeStatusChanged(node);
      return;
    }

    node.status = "assessing";
    this.emitNodeStatusChanged(node);

    const assessment = await this.assessAtomicity(node);
    node.complexity = assessment;
    this.emitDurableEvent("complexity_assessed", node.id, { score: assessment.score, recommendation: assessment.recommendation });
    this.emitNodeStatusChanged(node);

    if (assessment.recommendation === "escalate") {
      node.status = "escalated";
      node.errorSummary = assessment.rationale;
      this.emitNodeStatusChanged(node);
      return;
    }
    if (assessment.recommendation === "block") {
      node.status = "blocked";
      node.errorSummary = assessment.rationale;
      this.emitNodeStatusChanged(node);
      return;
    }

    if (assessment.recommendation === "split" && this.tree.totalNodes >= budget.softMaxAgents) {
      this.emitDurableEvent("budget_gate", node.id, {
        action: "execute_at_soft_budget",
        totalNodes: this.tree.totalNodes,
        softMaxAgents: budget.softMaxAgents,
        reason: "Soft agent budget reached; executing this node directly."
      });
      await this.enqueueNodeExecution(node);
      return;
    }

    const hasZeroFailures = (assessment.failures ?? []).length === 0;
    const isContradictorySplit = assessment.recommendation === "split" && hasZeroFailures && assessment.score >= 7;
    if (assessment.recommendation === "split" && !isContradictorySplit) {
      await this.splitAndProcess(node);
    } else {
      await this.enqueueNodeExecution(node);
    }
  }

  private async enqueueNodeExecution(node: RecursiveSwarmNode): Promise<void> {
    const queueDir = this.workspacePath
      ? path.join(this.workspacePath, ".agent_memory")
      : path.join(process.cwd(), ".agent_memory");
    if (!existsSync(queueDir)) {
      await mkdir(queueDir, { recursive: true });
    }
    const queue = new SqliteTaskQueueBackend(queueDir);

    const jobId = await queue.enqueue({
      queue_name: `recursive_swarm:${this.runState.sessionId}`,
      job_type: "recursive_node_execution",
      payload: { node_id: node.id, task_prompt: node.taskPrompt, goal: node.goalEnvelope.originalGoal },
      priority: 3,
      max_attempts: 3
    });

    node.status = "queued";
    this.emitNodeStatusChanged(node);

    const dequeued = await queue.dequeue(`recursive_swarm:${this.runState.sessionId}`, 120_000);
    if (!dequeued) {
      node.status = "failed";
      node.errorSummary = "Node execution dequeued timed out";
      this.emitNodeStatusChanged(node);
      queue.close();
      return;
    }

    try {
      await this.executeWithVerification(node);
      await queue.ack(dequeued.job.id, dequeued.lease_id);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await queue.nack(dequeued.job.id, dequeued.lease_id, msg);
      node.status = "failed";
      node.errorSummary = msg;
      this.emitNodeStatusChanged(node);
    }
    queue.close();
  }

  private async assessAtomicity(node: RecursiveSwarmNode): Promise<AtomicTaskAssessment> {
    if (!this.provider) {
      return {
        isAtomic: false,
        score: 10,
        rationale: "Recursive atomicity assessment requires a configured provider; deterministic local task assessment is not a runtime fallback.",
        failures: ["provider_unavailable"],
        recommendation: "block"
      };
    }
    return this.providerAssessAtomic(node);
  }

  private formatPackForPrompt(pack?: MemoryEvidencePack): string {
    if (!pack) return "";
    const lines: string[] = ["=== Memory Evidence Pack ==="];
    if (pack.intent_contract_ref) lines.push(`Intent contract: ${pack.intent_contract_ref}`);
    if (pack.relevant_files.length) lines.push(`Relevant files: ${pack.relevant_files.slice(0, 10).join(", ")}`);
    for (const [filePath, range] of Object.entries(pack.file_ranges).slice(0, 5)) {
      lines.push(`  ${filePath}: lines ${range}`);
    }
    if (pack.symbols.length) lines.push(`Symbols: ${pack.symbols.slice(0, 8).join(", ")}`);
    if (pack.commands.length) lines.push(`Known commands: ${pack.commands.slice(0, 6).join(", ")}`);
    if (pack.allowed_paths.length) lines.push(`Allowed paths: ${pack.allowed_paths.join(", ")}`);
    if (pack.forbidden_paths.length) lines.push(`Forbidden paths: ${pack.forbidden_paths.join(", ")}`);
    if (pack.unknowns.length) lines.push(`Unknowns: ${pack.unknowns.slice(0, 3).join("; ")}`);
    if (pack.warnings.length) lines.push(`Warnings: ${pack.warnings.slice(0, 3).join("; ")}`);
    lines.push(`Evidence confidence: ${pack.confidence.toFixed(2)}, freshness: ${pack.freshness_status}`);
    lines.push(`Context source: ${pack.context_source}`);
    if (pack.context_source !== "memory_evidence") {
      lines.push("WARNING: No sufficient memory evidence available — answer from task prompt and general knowledge. State clearly that this answer is prompt-only.");
    }
    if (pack.freshness_status === "stale") {
      lines.push("WARNING: Memory evidence may be stale. Verify file contents before relying on file paths or summaries.");
    }

    const snippets = pack.source_snippets ?? pack.snippets ?? [];
    if (snippets.length) {
      lines.push("");
      lines.push("=== Source Evidence ===");
      for (const snippet of snippets) {
        lines.push(`File: ${snippet.path}`);
        lines.push(`Lines: ${snippet.start_line}-${snippet.end_line}`);
        lines.push(snippet.content);
        if (snippet.truncated) {
          lines.push("[... truncated ...]");
        }
        lines.push("");
      }
    }

    const baselineCommand = pack.baseline_command ?? pack.baseline_command_result;
    if (baselineCommand) {
      lines.push("=== Baseline Command Evidence ===");
      lines.push(`Command: ${baselineCommand.command}`);
      if (typeof baselineCommand.exitCode === "number") {
        lines.push(`Exit code: ${baselineCommand.exitCode}`);
      }
      if (baselineCommand.stdout) {
        lines.push("STDOUT:");
        lines.push(baselineCommand.stdout);
      }
      if (baselineCommand.stderr) {
        lines.push("STDERR:");
        lines.push(baselineCommand.stderr);
      }
    }

    return lines.join("\n").trimEnd();
  }

  private async providerAssessAtomic(node: RecursiveSwarmNode): Promise<AtomicTaskAssessment> {
    if (!this.provider) {
      throw new Error("Recursive atomicity assessment provider is not configured.");
    }
    const contextBlock = this.formatPackForPrompt(node.evidencePack);
    try {
      const response = await invokeReasoningProviderStructured<{
        isAtomic: boolean; score: number; rationale: string; failures: string[];
      }>(
        this.provider,
        {
          purpose: "reason",
          reasoningStage: "reason",
          responseFormat: "json",
          systemPrompt: `You are a Task Atomicity Assessor.
Determine if a task is ATOMIC (can be executed directly) or needs splitting.
A task is atomic ONLY when ALL of these conditions are met:
1. SINGLE GOAL: The task has one clear, indivisible objective
2. CLEAR OUTPUTS: The expected output is well-defined and measurable
3. LIMITED SCOPE: The task touches at most one file/component/module
4. RESOLVED DEPS: All dependencies are satisfied or none needed
5. VERIFIABLE DOD: Definition of Done is concrete and testable
6. CONCRETE ARTIFACT: The node can produce one concrete artifact, patch intent, validation report, review decision, evidence report, or merge decision in one pass

Score 1-10. Score >= 5 or any condition failure means NOT atomic.
If score >= 8 AND depth >= 5, recommend "escalate".
If score >= 5 but not salvageable, recommend "block".${contextBlock ? `\n\n${contextBlock}` : ""}`,
          userPrompt: `Evaluate this task for atomicity:

TASK: ${node.taskPrompt}
ORIGINAL GOAL: ${node.goalEnvelope.originalGoal}
EXPANDED GOAL: ${node.goalEnvelope.expandedGoal ?? node.goalEnvelope.originalGoal}
DELIVERABLE CONTRACT: ${node.goalEnvelope.expandedGoalSpec?.deliverableContract ?? "Not specified"}
DEPTH: ${node.depth}
SOFT AGENT BUDGET: ${this.getBudget().softMaxAgents}
MAX CHILDREN PER PARENT: ${this.getBudget().maxChildrenPerParent}

Return { isAtomic, score, rationale, failures } where failures lists which atomicity conditions failed.`,
          maxOutputTokens: 512
        },
        {
          name: "atomicity_assessment",
          type: "object",
          properties: {
            isAtomic: { type: "boolean" },
            score: { type: "number", minimum: 1, maximum: 10 },
            rationale: { type: "string" },
            failures: { type: "array", items: { type: "string" } }
          },
          required: ["isAtomic", "score", "rationale", "failures"]
        }
      );
      const score = Math.max(1, Math.min(10, Math.round(response.score ?? 5))) as AtomicTaskAssessment["score"];
      const hasZeroFailures = (response.failures ?? []).length === 0;
      const isHighAtomicity = hasZeroFailures && score >= 7;
      const isAtomic = isHighAtomicity || (response.isAtomic === true && score < 5 && hasZeroFailures);
      let recommendation: AtomicTaskAssessment["recommendation"] = isAtomic ? "execute" : "split";
      if (!isAtomic && score >= 8 && node.depth >= 5) recommendation = "escalate";
      return { isAtomic, score, rationale: response.rationale ?? "Provider assessment", failures: response.failures ?? [], recommendation };
    } catch (error) {
      return {
        isAtomic: false,
        score: 10,
        rationale: `Provider-backed recursive atomicity assessment failed: ${error instanceof Error ? error.message : String(error)}`,
        failures: ["provider_failed"],
        recommendation: "block"
      };
    }
  }

  private async splitAndProcess(node: RecursiveSwarmNode): Promise<void> {
    this.totalSplits++;
    node.status = "splitting";
    this.emitNodeStatusChanged(node);
    let splitResult: Awaited<ReturnType<RecursiveTaskSplitter["splitTask"]>>;
    try {
      splitResult = await this.splitter.splitTask(node, this.runOptions, { pack: node.evidencePack });
    } catch (error) {
      node.status = "blocked";
      node.errorSummary = error instanceof Error ? error.message : String(error);
      this.emitDurableEvent(isProviderRateLimitError(node.errorSummary) ? "provider_backoff" : "error", node.id, { stage: "task_split", reason: node.errorSummary });
      this.emitNodeStatusChanged(node);
      this.writeCheckpoint(`split_failed:${node.id}`);
      this.emitTreeUpdated();
      return;
    }
    splitResult = this.applySplitBudget(node, splitResult);
    node.splitResult = splitResult;
    node.splitJustification = splitResult.budgetDecision;
    this.writeCheckpoint(`post_split:${node.id}`);

    // Bug 3 fix: detect self-similar split that would cause infinite recursion
    if (splitResult.subTasks.length === 0) {
      this.emitDurableEvent("task_split", node.id, { subTaskCount: 0, note: "cannot meaningfully split, executing directly" });
      await this.executeWithVerification(node);
      return;
    }
    if (splitResult.subTasks.length === 1 && isSelfSimilarSplit(node.taskPrompt, splitResult.subTasks[0].taskPrompt)) {
      this.emitDurableEvent("task_split", node.id, { subTaskCount: 1, note: "self-similar split detected, executing directly" });
      await this.executeWithVerification(node);
      return;
    }

    this.emitDurableEvent("task_split", node.id, {
      subTaskCount: splitResult.subTasks.length,
      desiredChildCount: splitResult.desiredChildCount ?? splitResult.subTasks.length,
      splitReason: splitResult.splitReason ?? splitResult.rationale,
      budgetDecision: splitResult.budgetDecision
    });
    this.emitNodeStatusChanged(node);

    const rootRequiresImplementation = isImplementationGoal(node.goalEnvelope.originalGoal);
    if (rootRequiresImplementation && splitResult.subTasks.length > 0 && (node.kind === "root" || node.contract?.responsibility === "IMPLEMENT")) {
      const hasImplementTask = splitResult.subTasks.some((st) => st.responsibility === "IMPLEMENT");
      if (!hasImplementTask) {
        let targetIdx = splitResult.subTasks.findIndex((st) =>
          /\b(fix|edit|modify|patch|repair|write|code|change|implement)\b/i.test(`${st.title} ${st.expectedOutput}`)
        );
        if (targetIdx === -1) {
          const nonVerifyIdx = splitResult.subTasks.map((st, i) => ({ st, i })).reverse().find(({ st }) => st.responsibility !== "VERIFY")?.i;
          targetIdx = nonVerifyIdx ?? splitResult.subTasks.length - 1;
        }
        if (targetIdx >= 0 && targetIdx < splitResult.subTasks.length) {
          splitResult.subTasks[targetIdx].responsibility = "IMPLEMENT";
          splitResult.subTasks[targetIdx].canWrite = true;
        }
      }
    }

    const childNodes: RecursiveSwarmNode[] = [];

    for (const subTask of splitResult.subTasks) {
      const parentContract = node.contract;
      const childContract = createWorkerExecutionContract({
        nodeId: "pending",
        parentId: node.id,
        localObjective: extractLocalTaskObjective(subTask.taskPrompt, subTask.title),
        originalGoal: node.goalEnvelope.originalGoal,
        title: subTask.title,
        expectedOutput: subTask.expectedOutput,
        canWrite: subTask.canWrite,
        parentContract,
        isRootGoalImplementation: rootRequiresImplementation,
        explicitResponsibility: subTask.responsibility
      });

      const childNode = this.createNode({
        name: subTask.title.slice(0, 40),
        kind: "task_agent",
        taskPrompt: subTask.taskPrompt,
        goalEnvelope: { ...node.goalEnvelope, localTask: subTask.taskPrompt },
        parentId: node.id,
        depth: node.depth + 1,
        contract: childContract
      });
      childContract.nodeId = childNode.id;
      childNodes.push(childNode);
      node.children.push(childNode.id);
      this.tree.nodes[childNode.id] = childNode;
      this.tree.totalNodes++;
      this.tree.maxDepth = Math.max(this.tree.maxDepth, childNode.depth);
      this.emitNodeCreated(childNode);
    }
    // Create visible collector for this parent
    const collectorContract = createWorkerExecutionContract({
      nodeId: "pending",
      parentId: node.id,
      localObjective: `Merge results from ${childNodes.length} child agent(s)`,
      originalGoal: node.goalEnvelope.originalGoal,
      title: `Collector (${node.name})`,
      explicitResponsibility: "INTEGRATE",
      parentContract: node.contract
    });
    const collectorNode = this.createNode({
      name: `Collector (${node.name})`,
      kind: "collector",
      taskPrompt: `Merge results from ${childNodes.length} child agent(s) for: ${node.goalEnvelope.localTask}`,
      goalEnvelope: node.goalEnvelope,
      parentId: node.id,
      depth: node.depth,
      contract: collectorContract
    });
    collectorContract.nodeId = collectorNode.id;
    node.children.push(collectorNode.id);
    this.tree.nodes[collectorNode.id] = collectorNode;
    this.tree.totalNodes++;
    this.emitNodeCreated(collectorNode);
    this.emitTreeUpdated();

    node.status = "waiting_children";
    this.emitNodeStatusChanged(node);

    // Execute children respecting dependencies and parallel cap
    await this.executeChildren(childNodes, splitResult);

    // Collect — Bug 1 fix: use stable parentId lookup, not object references
    node.status = "collecting";
    this.emitNodeStatusChanged(node);
    this.writeCheckpoint(`pre_collect:${node.id}`);

    const freshChildren = Object.values(this.tree.nodes).filter((n) => n.parentId === node.id && n.kind === "task_agent");
    const collectResult = await this.collector.collect(freshChildren, node.goalEnvelope.originalGoal, { pack: node.evidencePack });
    node.collectResult = collectResult;
    node.outputSummary = collectResult.mergedOutput;
    this.writeCheckpoint(`post_collect:${node.id}`);

    // Create repair agent if needed
    if (collectResult.unresolvedErrors.length > 0 && this.runOptions.enableErrorRecovery) {
      await this.createRepairAgent(node, collectorNode, collectResult);
    }

    // Verify
    node.status = "verifying";
    this.emitNodeStatusChanged(node);
    await this.checkGoalAt(node, "pre_accept");

    collectorNode.status = "succeeded";
    collectorNode.outputSummary = collectResult.mergedOutput;
    this.emitNodeStatusChanged(collectorNode);

    node.status = collectResult.unresolvedErrors.length > 0 ? "failed" : "succeeded";
    if (collectResult.unresolvedErrors.length > 0) {
      node.errorSummary = `Unresolved errors: ${collectResult.unresolvedErrors.join("; ")}`;
    }
    this.emitDurableEvent("collect_completed", node.id, { childCount: freshChildren.length, errors: collectResult.unresolvedErrors.length });
    this.emitNodeStatusChanged(node);
    this.emitTreeUpdated();
  }

  private async executeChildren(children: RecursiveSwarmNode[], parentSplitResult: import("./RecursiveSwarmModels.js").SplitResult): Promise<void> {
    // Build child ID by subtask index and subtask ID
    const indexToChildId: string[] = parentSplitResult.subTasks.map((st, i) => children[i]?.id ?? "");
    const subtaskIdToChildId = new Map<string, string>();
    const childIdToResolvedDeps = new Map<string, string[]>();
    const childIdToSubTask = new Map<string, SplitSubTask>();
    for (let i = 0; i < parentSplitResult.subTasks.length; i++) {
      const st = parentSplitResult.subTasks[i];
      const childId = children[i]?.id;
      if (!childId) continue;
      subtaskIdToChildId.set(st.id, childId);
      childIdToSubTask.set(childId, st);
    }
    // Resolve each child's dependencies to child node IDs
    for (let i = 0; i < parentSplitResult.subTasks.length; i++) {
      const st = parentSplitResult.subTasks[i];
      const childId = children[i]?.id;
      if (!childId) continue;
      const resolved = st.dependencies.map((dep) => {
        // Try as subtask ID first (e.g. "1", "task_inspect", etc.)
        const mapped = subtaskIdToChildId.get(dep);
        if (mapped && mapped !== childId) return mapped;
        // Try as numeric index
        if (/^\d+$/.test(dep)) {
          const idx = parseInt(dep, 10);
          // Try 0-based index
          if (idx >= 0 && idx < indexToChildId.length && idx !== i) return indexToChildId[idx];
          // Try 1-based index (e.g., dep "1" referencing index 0)
          const idx1 = idx - 1;
          if (idx1 >= 0 && idx1 < indexToChildId.length && idx1 !== i) return indexToChildId[idx1];
        }
        return "";
      }).filter(Boolean) as string[];
      childIdToResolvedDeps.set(childId, resolved);
    }

    const executed = new Set<string>();
    let remaining = children.map((c) => c.id);
    while (remaining.length > 0) {
      const ready = remaining.filter((childId) => {
        const deps = childIdToResolvedDeps.get(childId) ?? [];
        return deps.every((depId) => executed.has(depId));
      });
      if (ready.length === 0) {
        // Deadlock — mark remaining as blocked
        for (const id of remaining) {
          const node = this.tree.nodes[id];
          if (node) {
            node.status = "blocked";
            node.errorSummary = `Deadlock: dependencies cannot be satisfied (pending: ${remaining.join(", ")})`;
            this.emitNodeStatusChanged(node);
            executed.add(id);
          }
        }
        break;
      }
      // Execute ready batch respecting parallel cap
      const executeReadyChild = async (id: string) => {
        const node = this.tree.nodes[id];
        const subTask = childIdToSubTask.get(id);
        if (!node || !subTask) return;
        const readiness = this.prepareRequiredSourceEvidence(subTask, node, parentSplitResult, subtaskIdToChildId, childIdToResolvedDeps);
        if (!readiness.ready) {
          node.status = "blocked";
          node.errorSummary = readiness.reason;
          this.emitNodeStatusChanged(node);
          return;
        }

        // Pass upstream dependency deliverables to child context
        const depContexts: string[] = [];
        const resolvedDeps = childIdToResolvedDeps.get(id) ?? [];
        for (const depId of resolvedDeps) {
          const depNode = this.tree.nodes[depId];
          if (!depNode || depNode.status !== "succeeded") continue;
          if (depNode.structuredOutput?.kind === "generated_artifact") {
            const art = depNode.structuredOutput;
            const bounded = art.content.length <= 4000 ? art.content : `${art.content.slice(0, 4000)}\n...[truncated]`;
            depContexts.push(`=== Dependency Deliverable: ${art.path} (from ${depNode.name}) ===\n${bounded}`);
          }
        }
        if (depContexts.length > 0) {
          node.taskPrompt = `${node.taskPrompt}\n\n${depContexts.join("\n\n")}`;
        }

        if (readiness.context) {
          node.taskPrompt = `${node.taskPrompt}\n\n${readiness.context}`;
        }
        await this.processNode(node);
      };
      if (this.runOptions.enableParallelExecution) {
        const maxParallel = this.runOptions.maxWriteExecutors;
        for (let i = 0; i < ready.length; i += maxParallel) {
          const slice = ready.slice(i, i + maxParallel);
          await Promise.all(slice.map(executeReadyChild));
        }
      } else {
        for (const id of ready) {
          await executeReadyChild(id);
        }
      }
      for (const id of ready) {
        executed.add(id);
      }
      remaining = remaining.filter((id) => !executed.has(id));
    }
  }

  private prepareRequiredSourceEvidence(
    subTask: SplitSubTask,
    node: RecursiveSwarmNode,
    splitResult: SplitResult,
    subtaskIdToChildId: Map<string, string>,
    childIdToResolvedDeps: Map<string, string[]>
  ): { ready: true; context?: string } | { ready: false; reason: string } {
    const requirement = subTask.sourceEvidenceRequirement;
    if (!requirement) return { ready: true };

    const prerequisiteMatches = splitResult.subTasks.filter((candidate) => candidate.id === requirement.prerequisiteSubtaskId);
    const prerequisiteIndex = /^\d+$/.test(requirement.prerequisiteSubtaskId)
      ? Number(requirement.prerequisiteSubtaskId)
      : -1;
    const prerequisiteSubTask = prerequisiteMatches.length === 1
      ? prerequisiteMatches[0]
      : prerequisiteMatches.length === 0 && Number.isSafeInteger(prerequisiteIndex)
        ? splitResult.subTasks[prerequisiteIndex]
        : undefined;
    if (!prerequisiteSubTask) {
      return { ready: false, reason: `Blocked: source evidence prerequisite "${requirement.prerequisiteSubtaskId}" is unresolved or ambiguous.` };
    }
    const prerequisiteChildId = subtaskIdToChildId.get(prerequisiteSubTask.id);
    const prerequisiteDeclared = subTask.dependencies.some((dependency) => {
      if (dependency === prerequisiteSubTask.id) return true;
      if (/^\d+$/.test(dependency)) {
        const idx = Number(dependency);
        if (splitResult.subTasks[idx]?.id === prerequisiteSubTask.id) return true;
        if (splitResult.subTasks[idx - 1]?.id === prerequisiteSubTask.id) return true;
      }
      return false;
    });
    if (!prerequisiteChildId || !prerequisiteDeclared || !(childIdToResolvedDeps.get(node.id) ?? []).includes(prerequisiteChildId)) {
      return { ready: false, reason: `Blocked: source evidence prerequisite "${requirement.prerequisiteSubtaskId}" is not a declared dependency.` };
    }
    const prerequisite = this.tree.nodes[prerequisiteChildId];
    if (!prerequisite || prerequisite.status !== "succeeded") {
      return { ready: false, reason: `Blocked: prerequisite "${requirement.prerequisiteSubtaskId}" did not complete successfully; verified source evidence is unavailable.` };
    }
    if (!this.workspacePath) {
      return { ready: false, reason: `Blocked: verified workspace source "${requirement.sourcePath}" cannot be read because workspace path is not set.` };
    }

    const workspaceRoot = realpathSync(this.workspacePath);
    let effectiveSourcePath = requirement.sourcePath.trim();
    const isPlaceholder = isPlaceholderPath(effectiveSourcePath);

    let directExists = false;
    if (!isPlaceholder && !path.isAbsolute(effectiveSourcePath)) {
      try {
        const lexical = resolveInsideWorkspace(workspaceRoot, effectiveSourcePath);
        directExists = existsSync(lexical) && statSync(lexical).isFile();
      } catch {
        directExists = false;
      }
    }

    if (!directExists) {
      const candidates = extractCandidatePathsFromPrerequisite(prerequisite, workspaceRoot);
      if (candidates.length > 0) {
        effectiveSourcePath = candidates[0]!;
      } else if (isPlaceholder) {
        return {
          ready: false,
          reason: `Blocked: source path placeholder "${requirement.sourcePath}" could not be resolved to a verified workspace file from prerequisite "${prerequisiteSubTask.id}".`
        };
      }
    }

    if (isPlaceholderPath(effectiveSourcePath) || path.isAbsolute(effectiveSourcePath)) {
      return {
        ready: false,
        reason: `Blocked: verified workspace source "${requirement.sourcePath}" cannot be read from the active workspace.`
      };
    }

    try {
      const lexicalPath = resolveInsideWorkspace(workspaceRoot, effectiveSourcePath);
      const realPath = realpathSync(lexicalPath);
      const relativeRealPath = path.relative(workspaceRoot, realPath);
      if (relativeRealPath.startsWith("..") || path.isAbsolute(relativeRealPath) || isSecretCandidate(realPath)) {
        throw new Error("Source path resolves outside the workspace or to a protected file.");
      }
      const content = new WorkspaceTools(workspaceRoot).readFile(effectiveSourcePath);
      if (!content.trim()) throw new Error("Source file is empty.");
      const lines = content.split(/\r?\n/);
      const selectedLines = lines.slice(0, 100);
      let excerpt = selectedLines.join("\n");
      if (excerpt.length > 12_000) excerpt = excerpt.slice(0, 12_000);
      const endLine = Math.min(selectedLines.length, excerpt.split("\n").length);
      const digest = createHash("sha256").update(excerpt).digest("hex");
      requirement.sourcePath = effectiveSourcePath.replaceAll("\\", "/");
      return {
        ready: true,
        context: [
          "=== Independently Verified Workspace Source ===",
          `Prerequisite subtask: ${requirement.prerequisiteSubtaskId} (completed successfully)`,
          `Source: ${requirement.sourcePath} (workspace-relative, lines 1-${endLine})`,
          `Verification: read from the current workspace with path containment checks; SHA-256 of this bounded excerpt: ${digest}`,
          "Source excerpt:",
          excerpt
        ].join("\n")
      };
    } catch (error) {
      return {
        ready: false,
        reason: `Blocked: verified workspace source "${effectiveSourcePath}" is unavailable or unverifiable (${error instanceof Error ? error.message : String(error)}).`
      };
    }
  }

  private async executeWithVerification(node: RecursiveSwarmNode): Promise<void> {
    this.totalExecutions++;
    node.status = "executing";
    this.emitNodeStatusChanged(node);
    this.writeCheckpoint(`pre_execute:${node.id}`);

    const pack = node.evidencePack;
    const contextBlock = this.formatPackForPrompt(pack);
    const contextNote = pack?.context_source === "memory_evidence"
      ? "\nThe memory evidence pack above was built from project evidence. Reference relevant files and line ranges in your answer."
      : pack?.context_source === "partial_context"
        ? "\nWARNING: Only partial context was available. Answer from the task prompt and available evidence."
        : "\nWARNING: No evidence pack was available. Answer from the task prompt and general knowledge only. State clearly that this answer is prompt-only.";

    const structuredPrompt = `Produce a structured JSON output with exactly one of these kinds:
- "evidence_report": findings[], files[], symbols[], evidence_refs[], unknowns[], confidence (0-1)
- "task_plan": tasks[{name, description, dependencies[], risk(low|medium|high)}], validation_strategy, confidence
- "generated_artifact": path, content, artifact_type(html|javascript|css|json|markdown|text|other), description, validation_steps[], completeness_notes[], confidence
- "edit_intent": target_file, target_symbol_or_range, operation(create|modify|delete|refactor), reason, expected_behavior, risk(low|medium|high), evidence_refs[]
- "validation_plan": commands[], smoke_checks[], expected_results[], blockers[]
- "review_decision": decision(approve|block|needs_changes), findings[], required_changes[], risks[]
- "integration_summary": child_outputs_used, conflicts[], merged_findings[], unresolved_items[]
- "final_summary": summary, blockers[], edit_intents[], validation_plans[], confidence

For tasks modifying, fixing, editing, or updating existing workspace code, return "edit_intent" (target_file, target_symbol_or_range, operation="modify", reason, expected_behavior) or a patch "generated_artifact" containing a valid unified diff targeting the source file. Do not generate auxiliary diagnostic, explanation, or report files (such as root_cause.md, modification_applied.txt, or test_output.txt) to describe code modifications unless explicitly requested by the task.
If the task asks to create a complete self-contained new file, game, demo, page, or other final deliverable, use "generated_artifact" and put the complete file contents in "content". Do not summarize the deliverable instead of generating it.
The original user goal is authoritative. If the deliverable contract requires code, source, or an artifact, produce that artifact or return a blocked/review decision with explicit evidence. A short plan or summary is not a valid substitute for the requested deliverable.

CRITICAL PROTOCOL RULES:
- Single Object: Return exactly ONE top-level JSON object. Do not return an array of objects or multiple top-level JSON documents.
- No Direct Git Commands: You do not have workspace shell or Git authority. Never attempt, instruct, or pretend to run git apply or git commit. Propose code changes as a structured output for the runtime approval pipeline.
- Concrete Implementations: If your responsibility is IMPLEMENT, return a concrete unified diff or replacement text, not metadata-only intents.
Return valid JSON with a "kind" field matching one of the above.`;

    if (this.provider) {
      const executorSystemPrompt = `You are an executor agent.\nOriginal goal (full, authoritative): ${node.goalEnvelope.originalGoal}\nExpanded goal/spec: ${node.goalEnvelope.expandedGoal ?? node.goalEnvelope.originalGoal}\nDeliverable contract: ${node.goalEnvelope.expandedGoalSpec?.deliverableContract ?? "Not specified"}\nTheme: ${node.goalEnvelope.theme}\nConstraints: ${node.goalEnvelope.constraints.join(", ")}\nAcceptance criteria: ${node.goalEnvelope.acceptanceCriteria.join(" | ")}\nComplete the following task without replacing the required artifact with a summary.${contextBlock ? `\n\n${contextBlock}` : ""}${contextNote}\n\n${structuredPrompt}`;

      const structuredSchema = {
        name: "structured_node_output",
        type: "object",
        additionalProperties: true,
        required: ["kind"],
        properties: {
          kind: { type: "string", enum: RECURSIVE_OUTPUT_KINDS },
          findings: { type: "array", items: { type: "string" } },
          files: { type: "array", items: { type: "string" } },
          symbols: { type: "array", items: { type: "string" } },
          evidence_refs: { type: "array", items: { type: "string" } },
          unknowns: { type: "array", items: { type: "string" } },
          confidence: { type: "number" },
          summary: { type: "string" },
          blockers: { type: "array", items: { type: "string" } },
          edit_intents: { type: "array", items: { type: "object" } },
          validation_plans: { type: "array", items: { type: "object" } },
          tasks: { type: "array", items: { type: "object" } },
          validation_strategy: { type: "string" },
          path: { type: "string" },
          content: { type: "string" },
          artifact_type: { type: "string" },
          description: { type: "string" },
          validation_steps: { type: "array", items: { type: "string" } },
          completeness_notes: { type: "array", items: { type: "string" } },
          target_file: { type: "string" },
          target_symbol_or_range: { type: "string" },
          operation: { type: "string" },
          reason: { type: "string" },
          expected_behavior: { type: "string" },
          risk: { type: "string" },
          commands: { type: "array", items: { type: "string" } },
          smoke_checks: { type: "array", items: { type: "string" } },
          expected_results: { type: "array", items: { type: "string" } },
          decision: { type: "string" },
          required_changes: { type: "array", items: { type: "string" } },
          risks: { type: "array", items: { type: "string" } },
          child_outputs_used: { type: "number" },
          conflicts: { type: "array", items: { type: "string" } },
          merged_findings: { type: "array", items: { type: "string" } },
          unresolved_items: { type: "array", items: { type: "string" } }
        }
      };

      let structuredSuccess = false;
      let rawFirstOutput: unknown;

      try {
        const raw = await invokeReasoningProviderStructured<Record<string, unknown>>(
          this.provider,
          {
            systemPrompt: executorSystemPrompt,
            userPrompt: node.taskPrompt,
            maxOutputTokens: 16384
          },
          structuredSchema
        );
        let parsed: unknown;
        try {
          parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        } catch {
          parsed = raw;
        }
        if (isStructuredNodeOutputValid(parsed)) {
          const { output, summary } = normalizeRecursiveNodeOutput(parsed);
          node.structuredOutput = output;
          node.outputSummary = summary;
          structuredSuccess = true;
        } else {
          rawFirstOutput = parsed;
        }
      } catch (firstError) {
        rawFirstOutput = firstError instanceof Error ? firstError.message : String(firstError);
      }

      if (!structuredSuccess) {
        // 1. Preserve original raw response for diagnostics
        const rawDiagText = typeof rawFirstOutput === "string" ? rawFirstOutput : JSON.stringify(rawFirstOutput ?? "");
        this.emitDurableEvent("structured_output_recovery_attempt", node.id, {
          reason: "The previous response did not satisfy the required structured output schema. Attempting recovery.",
          rawSnippet: rawDiagText.slice(0, 300)
        });

        // 2. Exactly ONE bounded structured-output recovery attempt using the same schema and task context
        try {
          const recoveryUserPrompt = `${node.taskPrompt}\n\nThe previous response did not satisfy the required structured output schema. Return the same result using the required schema only. Do not add new claims or change the proposed solution.`;
          const recoveryRaw = await invokeReasoningProviderStructured<Record<string, unknown>>(
            this.provider,
            {
              systemPrompt: executorSystemPrompt,
              userPrompt: recoveryUserPrompt,
              maxOutputTokens: 16384
            },
            structuredSchema
          );
          let recoveryParsed: unknown;
          try {
            recoveryParsed = typeof recoveryRaw === "string" ? JSON.parse(recoveryRaw) : recoveryRaw;
          } catch {
            recoveryParsed = recoveryRaw;
          }
          if (isStructuredNodeOutputValid(recoveryParsed)) {
            const { output, summary } = normalizeRecursiveNodeOutput(recoveryParsed);
            node.structuredOutput = output;
            node.outputSummary = summary;
            structuredSuccess = true;
            this.emitDurableEvent("structured_output_recovery_succeeded", node.id, {
              kind: output.kind
            });
          } else {
            this.emitDurableEvent("structured_output_recovery_failed", node.id, {
              reason: "Recovery response did not satisfy the required structured output schema."
            });
          }
        } catch (retryError) {
          // Recovery failed; STOP recovery. Do not keep retrying.
          this.emitDurableEvent("structured_output_recovery_failed", node.id, {
            reason: retryError instanceof Error ? retryError.message : String(retryError)
          });
        }
      }

      if (!structuredSuccess) {
        // Recovery failed or was exhausted; retain preserved raw response as diagnostic/fallback text without making further provider calls
        const rawDiagText = typeof rawFirstOutput === "string" ? rawFirstOutput : JSON.stringify(rawFirstOutput ?? "");
        const { output, summary } = wrapTextFallback(rawDiagText);
        node.structuredOutput = output;
        node.outputSummary = summary;
      }

      // 3. Bounded semantic implementation recovery (at most 1 per eligible child, bounded run budget)
      const goalRequiresImplementation = isImplementationGoal(node.goalEnvelope.originalGoal);
      const nodeRequiresImplementation =
        node.contract?.responsibility === "IMPLEMENT" ||
        (node.kind === "root" && goalRequiresImplementation);

      const readiness = assessImplementationPatchReadiness(node.structuredOutput, {
        originalGoal: node.goalEnvelope.originalGoal,
        deliverableContract: node.goalEnvelope.expandedGoalSpec?.deliverableContract,
        workspacePath: this.workspacePath
      });

      const canAttemptSemanticRecovery =
        structuredSuccess &&
        nodeRequiresImplementation &&
        !readiness.isPatchReady &&
        !this.semanticRecoveryAttemptsByNode.has(node.id) &&
        this.totalSemanticRecoveryAttempts < this.maxRunSemanticRecoveries;

      if (canAttemptSemanticRecovery) {
        this.semanticRecoveryAttemptsByNode.add(node.id);
        this.totalSemanticRecoveryAttempts++;
        const missingReq = readiness.missingRequirement || "Your IMPLEMENT contract requires a concrete patch proposal with a valid unified diff or replacement text.";
        this.emitDurableEvent("semantic_recovery_attempt", node.id, {
          reason: readiness.reason || "The previous response was structurally valid but did not provide the implementation deliverable required by this task.",
          missingRequirement: missingReq,
          previousKind: node.structuredOutput?.kind
        });

        try {
          const recoveryUserPrompt = `${node.taskPrompt}\n\nThe previous response was structurally valid but did not provide the implementation deliverable required by this task.\n${missingReq}\nReturn the implementation as the required structured edit/patch output (e.g. kind: "generated_artifact" with path "code_patch.diff" and valid unified diff in content, or kind: "edit_intent" with target_file, exact_old_text, and replacement_text).\nDo not create diagnostic or report files unless explicitly requested.\nDo not change your diagnosis or introduce new claims.`;
          const recoveryRaw = await invokeReasoningProviderStructured<Record<string, unknown>>(
            this.provider,
            {
              systemPrompt: executorSystemPrompt,
              userPrompt: recoveryUserPrompt,
              maxOutputTokens: 16384
            },
            structuredSchema
          );
          let recoveryParsed: unknown;
          try {
            recoveryParsed = typeof recoveryRaw === "string" ? JSON.parse(recoveryRaw) : recoveryRaw;
          } catch {
            recoveryParsed = recoveryRaw;
          }
          if (isStructuredNodeOutputValid(recoveryParsed)) {
            const { output, summary } = normalizeRecursiveNodeOutput(recoveryParsed);
            const recoveryReadiness = assessImplementationPatchReadiness(output, {
              originalGoal: node.goalEnvelope.originalGoal,
              deliverableContract: node.goalEnvelope.expandedGoalSpec?.deliverableContract,
              workspacePath: this.workspacePath
            });
            if (recoveryReadiness.isPatchReady) {
              node.structuredOutput = output;
              node.outputSummary = summary;
              this.emitDurableEvent("semantic_recovery_succeeded", node.id, {
                kind: output.kind,
                targetFile: recoveryReadiness.targetFile
              });
            } else {
              this.emitDurableEvent("semantic_recovery_failed", node.id, {
                reason: recoveryReadiness.reason || "Recovery response was structurally valid but did not provide the required implementation deliverable."
              });
            }
          } else {
            this.emitDurableEvent("semantic_recovery_failed", node.id, {
              reason: "Recovery response did not satisfy the required structured output schema."
            });
          }
        } catch (retryError) {
          this.emitDurableEvent("semantic_recovery_failed", node.id, {
            reason: retryError instanceof Error ? retryError.message : String(retryError)
          });
        }
      }
    } else {
      node.status = "blocked";
      node.errorSummary = "Recursive node execution requires a configured provider; local prompt-only execution output is not a runtime fallback.";
      this.emitDurableEvent("error", node.id, { stage: "node_execution", reason: node.errorSummary });
      this.emitNodeStatusChanged(node);
      this.emitTreeUpdated();
      return;
    }

    // Verify after execution
    node.status = "verifying";
    this.emitNodeStatusChanged(node);
    await this.checkGoalAt(node, "pre_accept");

    node.status = "succeeded";
    this.emitDurableEvent("node_completed", node.id, { outputLength: node.outputSummary?.length ?? 0 });
    this.emitNodeStatusChanged(node);
    this.writeCheckpoint(`post_execute:${node.id}`);
    this.emitTreeUpdated();
  }

  private async createRepairAgent(parent: RecursiveSwarmNode, collectorNode: RecursiveSwarmNode, collectResult: { unresolvedErrors: string[]; mergedOutput: string }): Promise<void> {
    const repairContract = createWorkerExecutionContract({
      nodeId: "pending",
      parentId: collectorNode.id,
      localObjective: `Repair the following errors:\n${collectResult.unresolvedErrors.join("\n")}`,
      originalGoal: parent.goalEnvelope.originalGoal,
      title: `Repair Agent (${parent.name})`,
      parentContract: parent.contract,
      explicitResponsibility: parent.contract?.responsibility === "IMPLEMENT" ? "IMPLEMENT" : "INSPECT"
    });
    const repairNode = this.createNode({
      name: `Repair Agent (${parent.name})`,
      kind: "repair_agent",
      taskPrompt: `Repair the following errors:\n${collectResult.unresolvedErrors.join("\n")}\n\nCurrent merged output:\n${collectResult.mergedOutput}`,
      goalEnvelope: parent.goalEnvelope,
      parentId: collectorNode.id,
      depth: parent.depth + 1,
      contract: repairContract
    });
    repairContract.nodeId = repairNode.id;
    collectorNode.children.push(repairNode.id);
    this.tree.nodes[repairNode.id] = repairNode;
    this.tree.totalNodes++;
    this.emitDurableEvent("repair_agent_created", repairNode.id, { parentId: parent.id, errors: collectResult.unresolvedErrors });
    this.emitNodeCreated(repairNode);
    // Process repair agent
    await this.executeWithVerification(repairNode);
  }

  private async processSteeringQueue(node: RecursiveSwarmNode): Promise<void> {
    const pending = node.steeringQueue.filter((m) => !m.applied && !m.supersededAt);
    if (pending.length === 0) return;
    for (const msg of pending) {
      msg.checkpoint = node.status === "assessing" ? "pre_split" : node.status === "executing" ? "pre_execute" : "post_steer";
      if (this.provider) {
        try {
          const classification = await invokeReasoningProviderStructured<{ type: string }>(
            this.provider,
            {
              systemPrompt: `Classify this steering message for a task agent. Respond with one of: "question", "task_modification", "restart", "resplit".`,
              userPrompt: `Current task: ${node.taskPrompt}\nSteering: ${msg.text}`,
              maxOutputTokens: 64
            },
            {
              name: "steering_classification",
              type: "object",
              properties: { type: { type: "string", enum: ["question", "task_modification", "restart", "resplit"] } },
              required: ["type"]
            }
          );
          msg.classification = classification.type as SteeringMessage["classification"];
        } catch {
          msg.classification = "question";
        }
      } else {
        msg.classification = "question";
      }
      msg.applied = true;
      if (msg.classification === "restart") {
        node.revision++;
        node.taskPrompt = msg.text;
        node.status = "created";
        this.emitNodeStatusChanged(node);
      } else if (msg.classification === "resplit") {
        node.revision++;
        node.complexity = undefined;
        node.splitResult = undefined;
        node.children = [];
        node.status = "created";
        this.emitNodeStatusChanged(node);
      }
    }
  }

  private async checkGoalAt(node: RecursiveSwarmNode, checkpoint: GoalCheckResult["checkpoint"]): Promise<void> {
    if (!this.runOptions.enableGoalKeeper) return;
    const lastCheck = node.goalChecks[node.goalChecks.length - 1];
    if (lastCheck && !this.goalKeeper.shouldRecheck(lastCheck) && lastCheck.checkpoint !== checkpoint) return;
    const result = await this.goalKeeper.checkAlignment(node, { pack: node.evidencePack });
    result.checkpoint = checkpoint;
    node.goalChecks.push(result);
    this.goalCheckHistory.push(result);
    this.emitDurableEvent("goal_check", node.id, { checkpoint, aligned: result.aligned, status: result.status });
    if (!result.aligned && isGoalCheckOperationalFailure(result)) {
      node.status = "blocked";
      node.errorSummary = `Goal check unavailable at ${checkpoint}: ${[...result.findings, ...result.warnings].join("; ")}`;
      return;
    }
    if (!result.aligned && result.status === "unknown") {
      node.status = "blocked";
      node.errorSummary = `Goal alignment unknown at ${checkpoint}: ${result.findings.join("; ")}`;
      return;
    }
    if (!result.aligned && result.status === "major_drift") {
      node.status = "blocked";
      node.errorSummary = `Goal drift at ${checkpoint}: ${result.findings.join("; ")}`;
    }
  }

  private createNode(input: {
    name: string;
    kind: RecursiveSwarmNode["kind"];
    taskPrompt: string;
    goalEnvelope: GoalEnvelope;
    parentId?: string;
    depth: number;
    contract?: WorkerExecutionContract;
  }): RecursiveSwarmNode {
    const nodeId = `recursive_node_${randomUUID()}`;
    const pack = this.buildPack?.(input.taskPrompt, nodeId);
    if (pack) {
      this.contextSourceCounts[pack.context_source]++;
    }
    const contract = input.contract ?? createWorkerExecutionContract({
      nodeId,
      parentId: input.parentId,
      localObjective: extractLocalTaskObjective(input.taskPrompt, input.name),
      originalGoal: input.goalEnvelope.originalGoal,
      title: input.name,
      isRootGoalImplementation: isImplementationGoal(input.goalEnvelope.originalGoal)
    });
    return {
      schema_version: RECURSIVE_SWARM_SCHEMA_VERSION,
      id: nodeId,
      parentId: input.parentId,
      runId: this.tree?.runId ?? `run_${randomUUID()}`,
      kind: input.kind,
      status: "created",
      name: input.name,
      role: this.nodeKindToRole(input.kind),
      goalEnvelope: input.goalEnvelope,
      taskPrompt: input.taskPrompt,
      depth: input.depth,
      goalChecks: [],
      steeringQueue: [],
      children: [],
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      evidencePack: pack,
      contract
    };
  }

  private nodeKindToRole(kind: RecursiveSwarmNode["kind"]): string {
    switch (kind) {
      case "root": return "Root Orchestrator";
      case "task_agent": return "Task Agent";
      case "goal_keeper": return "Goal Keeper";
      case "collector": return "Collector";
      case "repair_agent": return "Repair Agent";
    }
  }

  private toSwarmNodeKind(kind: RecursiveSwarmNode["kind"]): AgentRuntimeSwarmNodeKind {
    switch (kind) {
      case "root": return "root";
      case "task_agent": return "worker";
      case "goal_keeper": return "gate";
      case "collector": return "aggregator";
      case "repair_agent": return "worker";
    }
  }

  private toSwarmStatus(status: RecursiveSwarmNode["status"]): AgentRuntimeSwarmNode["status"] {
    switch (status) {
      case "created": return "idle";
      case "assessing":
      case "splitting":
      case "waiting_children":
      case "collecting":
      case "verifying": return "queued";
      case "executing": return "running";
      case "succeeded": return "completed";
      case "blocked":
      case "escalated": return "blocked";
      case "failed": return "failed";
      case "superseded": return "completed";
      case "queued": return "queued";
    }
    return "idle";
  }

  private getCurrentAction(node: RecursiveSwarmNode): string | undefined {
    switch (node.status) {
      case "assessing": return "Assessing task atomicity...";
      case "splitting": return "Splitting task into sub-tasks...";
      case "waiting_children": return `Waiting for ${node.children.length} child agent(s)...`;
      case "executing": return "Executing task...";
      case "verifying": return "Verifying results...";
      case "collecting": return "Collecting results from children...";
      case "succeeded": return "Completed.";
      case "failed": return node.errorSummary ?? "Failed.";
      case "blocked": return node.errorSummary ?? "Blocked.";
      case "escalated": return node.errorSummary ?? "Escalated.";
      case "superseded": return "Superseded by newer revision.";
      default: return undefined;
    }
  }

  private getLatestAlignment(node: RecursiveSwarmNode): boolean {
    const last = node.goalChecks[node.goalChecks.length - 1];
    return last ? last.aligned : true;
  }

  private hasAnyFailed(): boolean {
    return Object.values(this.tree.nodes).some(
      (n) => n.status === "failed" || n.status === "blocked" || n.status === "escalated"
    );
  }

  private collectUnresolvedErrors(): string[] {
    const errors: string[] = [];
    for (const n of Object.values(this.tree.nodes)) {
      if (n.collectResult?.unresolvedErrors) errors.push(...n.collectResult.unresolvedErrors);
      if (n.errorSummary && (n.status === "failed" || n.status === "blocked")) {
        errors.push(`[${n.name}] ${n.errorSummary}`);
      }
    }
    return [...new Set(errors)];
  }

  private emitDurableEvent(type: DurableSwarmEvent["type"], nodeId?: string, data: Record<string, unknown> = {}): void {
    const event: DurableSwarmEvent = { id: `durable_${randomUUID().slice(0, 8)}`, type, nodeId, data, createdAt: new Date().toISOString() };
    this.durableEvents.push(event);
    this.runState.durableEvents.push(event);
    this.runState.updatedAt = new Date().toISOString();
    this.onDurableEvent?.(event);
  }

  private emitNodeCreated(node: RecursiveSwarmNode): void {
    this.emitDurableEvent("node_created", node.id, { kind: node.kind, name: node.name, depth: node.depth });
    this.onNodeCreated?.(node);
  }

  private emitNodeStatusChanged(node: RecursiveSwarmNode): void {
    this.tree.updatedAt = new Date().toISOString();
    this.tree.nodes[node.id] = { ...node };
    this.emitDurableEvent("node_status_changed", node.id, { status: node.status });
    this.onNodeStatusChanged?.(node);
    this.emitTreeUpdated();
  }

  private emitTreeUpdated(): void {
    this.onTreeUpdated?.(this.tree);
  }
}

function isGoalCheckOperationalFailure(result: GoalCheckResult): boolean {
  return result.status === "unknown"
    && result.findings.some((finding) => finding === "provider_failed" || finding === "provider_unavailable");
}

function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

function normalizeExpandedGoalSpec(
  originalPrompt: string,
  originalPromptHash: string,
  raw: Record<string, unknown>,
  generatedBy: ExpandedGoalSpec["generatedBy"]
): ExpandedGoalSpec {
  return {
    originalPrompt,
    originalPromptHash,
    isAlreadyDetailed: raw.isAlreadyDetailed === true,
    expandedGoal: stringValue(raw.expandedGoal, originalPrompt),
    requirements: stringArray(raw.requirements),
    acceptanceCriteria: stringArray(raw.acceptanceCriteria),
    deliverableContract: stringValue(raw.deliverableContract, "Complete the requested deliverable or report a blocker with evidence."),
    constraints: stringArray(raw.constraints),
    nonGoals: stringArray(raw.nonGoals),
    qualityBar: stringArray(raw.qualityBar),
    generatedBy,
    warnings: []
  };
}

function unavailableGoalSpec(originalPrompt: string, originalPromptHash: string, warning: string): ExpandedGoalSpec {
  return {
    originalPrompt,
    originalPromptHash,
    isAlreadyDetailed: false,
    expandedGoal: originalPrompt,
    requirements: [],
    acceptanceCriteria: [],
    deliverableContract: "Provider goal expansion unavailable; preserve the original prompt verbatim and do not summarize the deliverable.",
    constraints: [],
    nonGoals: [],
    qualityBar: [],
    generatedBy: "unavailable",
    warnings: [warning]
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function isUsefulSplitSubTask(subTask: SplitSubTask): boolean {
  const task = normalizeTaskText(subTask.taskPrompt);
  const output = normalizeTaskText(subTask.expectedOutput);
  if (task.length < 16 || output.length < 8) return false;
  const generic = /^(completed work|do the task|handle this|work on this|retrieve context|search files|check again)$/i;
  return !generic.test(subTask.expectedOutput.trim()) && !generic.test(subTask.taskPrompt.trim());
}

function isProviderRateLimitError(value: string | undefined): boolean {
  return /\b(429|rate limit|too many requests|provider.*unreachable|temporar(?:y|ily))\b/i.test(value ?? "");
}

function buildRecursiveRunCheckpoint(input: {
  sessionId: string;
  tree: RecursiveSwarmTree;
  expandedGoalSpec?: ExpandedGoalSpec;
  budget?: RecursiveRunBudget;
  activityProjection: RunActivityProjection;
  lastStablePhase: string;
  resumable: boolean;
}): RecursiveRunCheckpoint {
  const nodes = Object.values(input.tree.nodes);
  const pendingStatuses = new Set<RecursiveSwarmNode["status"]>([
    "created",
    "assessing",
    "splitting",
    "waiting_children",
    "executing",
    "verifying",
    "collecting",
    "queued"
  ]);
  return {
    sessionId: input.sessionId,
    runId: input.tree.runId,
    originalPrompt: input.tree.rootGoal,
    expandedGoalSpec: input.expandedGoalSpec,
    budget: input.budget,
    nodes: nodes.map((node) => ({
      id: node.id,
      parentId: node.parentId,
      status: node.status,
      name: node.name,
      kind: node.kind,
      taskPrompt: node.taskPrompt,
      depth: node.depth,
      childIds: [...node.children],
      updatedAt: node.updatedAt
    })),
    pendingQueue: nodes.filter((node) => pendingStatuses.has(node.status)).map((node) => node.id),
    completedNodeIds: nodes.filter((node) => node.status === "succeeded" || node.status === "superseded").map((node) => node.id),
    failedNodeIds: nodes.filter((node) => node.status === "failed" || node.status === "blocked" || node.status === "escalated").map((node) => node.id),
    generatedArtifacts: nodes
      .filter((node) => node.structuredOutput?.kind === "generated_artifact")
      .map((node) => node.structuredOutput),
    durableActivityRows: input.activityProjection.durableRows,
    lastStablePhase: input.lastStablePhase,
    resumable: input.resumable,
    createdAt: new Date().toISOString()
  };
}

function buildActivityProjection(tree: RecursiveSwarmTree, durableEvents: DurableSwarmEvent[]): RunActivityProjection {
  const rows: DurableActivityRow[] = durableEvents
    .filter((event) => isActivityEvent(event))
    .slice(-96)
    .map((event) => activityRowFromEvent(event));
  const nodes = Object.values(tree.nodes);
  const activeNode = nodes.find((node) => ["executing", "splitting", "collecting", "verifying", "assessing", "waiting_children", "queued"].includes(node.status));
  return {
    durableRows: rows,
    ephemeralStatus: activeNode ? {
      text: ephemeralTextForNode(activeNode),
      phase: ephemeralPhaseForNode(activeNode),
      nodeId: activeNode.id,
      updatedAt: activeNode.updatedAt
    } : tree.status === "running" ? {
      text: "Syncing recursive agents...",
      phase: "syncing",
      updatedAt: tree.updatedAt
    } : null,
    counters: {
      thoughts: Math.max(0, durableEvents.filter((event) => event.type === "complexity_assessed" || event.type === "goal_check").length),
      filesViewed: 0,
      commandsRun: 0,
      agentsActive: nodes.filter((node) => ["executing", "splitting", "collecting", "verifying", "assessing", "waiting_children", "queued"].includes(node.status)).length,
      agentsDone: nodes.filter((node) => node.status === "succeeded" || node.status === "superseded").length,
      agentsFailed: nodes.filter((node) => node.status === "failed" || node.status === "blocked" || node.status === "escalated").length
    }
  };
}

function isActivityEvent(event: DurableSwarmEvent): boolean {
  return [
    "intent_expanded",
    "budget_planned",
    "task_split",
    "budget_gate",
    "collect_completed",
    "node_completed",
    "run_completed",
    "checkpoint_written",
    "provider_backoff",
    "error"
  ].includes(event.type);
}

function activityRowFromEvent(event: DurableSwarmEvent): DurableActivityRow {
  switch (event.type) {
    case "intent_expanded":
      return {
        id: event.id,
        kind: "thought",
        title: "Expanded goal",
        summary: `Goal preserved with ${Number(event.data.requirementCount ?? 0)} extracted requirement(s).`,
        status: event.data.generatedBy === "unavailable" ? "blocked" : "completed",
        nodeId: event.nodeId,
        createdAt: event.createdAt
      };
    case "budget_planned":
      return {
        id: event.id,
        kind: "thought",
        title: "Planned staffing budget",
        summary: `Soft ${event.data.softMaxAgents ?? "?"}/${event.data.hardMaxAgents ?? "?"}; max children ${event.data.maxChildrenPerParent ?? "?"}.`,
        status: "completed",
        nodeId: event.nodeId,
        createdAt: event.createdAt
      };
    case "task_split":
      return {
        id: event.id,
        kind: "split",
        title: `Split into ${event.data.subTaskCount ?? 0} child task(s)`,
        summary: String(event.data.splitReason ?? event.data.note ?? "Recursive split recorded."),
        status: "completed",
        nodeId: event.nodeId,
        createdAt: event.createdAt
      };
    case "budget_gate":
      return {
        id: event.id,
        kind: "thought",
        title: "Budget gate",
        summary: String(event.data.reason ?? event.data.action ?? "Recursive budget gate applied."),
        status: "queued",
        nodeId: event.nodeId,
        createdAt: event.createdAt
      };
    case "collect_completed":
      return {
        id: event.id,
        kind: "merge",
        title: "Collected child results",
        summary: `${event.data.childCount ?? 0} child result(s), ${event.data.errors ?? 0} unresolved error(s).`,
        status: Number(event.data.errors ?? 0) > 0 ? "failed" : "completed",
        nodeId: event.nodeId,
        createdAt: event.createdAt
      };
    case "node_completed":
      return {
        id: event.id,
        kind: "thought",
        title: "Node completed",
        summary: `${event.data.outputLength ?? 0} output character(s).`,
        status: "completed",
        nodeId: event.nodeId,
        createdAt: event.createdAt
      };
    case "run_completed":
      return {
        id: event.id,
        kind: "merge",
        title: "Recursive swarm completed",
        summary: `Run status: ${String(event.data.status ?? "unknown")}.`,
        status: event.data.status === "succeeded" ? "completed" : "failed",
        nodeId: event.nodeId,
        createdAt: event.createdAt
      };
    case "checkpoint_written":
      return {
        id: event.id,
        kind: "checkpoint",
        title: "Checkpoint saved",
        summary: `${String(event.data.lastStablePhase ?? "runtime")} | ${event.data.pendingNodes ?? 0} pending node(s).`,
        status: "completed",
        nodeId: event.nodeId,
        createdAt: event.createdAt
      };
    case "provider_backoff":
      return {
        id: event.id,
        kind: "blocker",
        title: "Provider backoff",
        summary: String(event.data.reason ?? "Provider is rate limited or unreachable."),
        status: "blocked",
        nodeId: event.nodeId,
        createdAt: event.createdAt
      };
    default:
      return {
        id: event.id,
        kind: "error",
        title: "Recursive error",
        summary: String(event.data.reason ?? "Recursive swarm error."),
        status: "failed",
        nodeId: event.nodeId,
        createdAt: event.createdAt
      };
  }
}

function ephemeralTextForNode(node: RecursiveSwarmNode): string {
  switch (node.status) {
    case "assessing": return `Thinking about ${node.name}...`;
    case "splitting": return `Splitting ${node.name}...`;
    case "waiting_children": return `Syncing ${node.children.length} child agent(s)...`;
    case "executing": return `Working on ${node.name}...`;
    case "verifying": return `Verifying ${node.name}...`;
    case "collecting": return `Collecting ${node.name}...`;
    case "queued": return `Queued ${node.name}...`;
    default: return "Syncing recursive agents...";
  }
}

function ephemeralPhaseForNode(node: RecursiveSwarmNode): NonNullable<RunActivityProjection["ephemeralStatus"]>["phase"] {
  switch (node.status) {
    case "assessing": return "thinking";
    case "splitting": return "splitting";
    case "executing":
    case "queued": return "executing";
    case "collecting":
    case "verifying": return "collecting";
    case "waiting_children": return "syncing";
    default: return "syncing";
  }
}

function isSelfSimilarSplit(parentTask: string, childTask: string): boolean {
  const parent = normalizeTaskText(parentTask);
  const child = normalizeTaskText(childTask);
  return child === parent || child.includes(`child task: ${parent}`) || child.includes(`parent task: ${parent}`);
}

function normalizeTaskText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function collectGeneratedArtifactSummaries(nodes: Record<string, RecursiveSwarmNode>): string[] {
  const summaries: string[] = [];
  for (const node of Object.values(nodes)) {
    if (node.structuredOutput?.kind !== "generated_artifact") continue;
    const artifact = node.structuredOutput;
    summaries.push(`${artifact.path} (${artifact.content.length} character(s)) from ${node.name}: ${artifact.description.slice(0, 160)}`);
  }
  return summaries;
}
