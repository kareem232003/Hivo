import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { resolveMemoryPaths } from "../memory/ProjectMemory.js";
import { rebuildRepoIndex } from "../memory/RepoIndexer.js";
import type { CommandInventory, RepoIndex } from "../memory/types.js";
import { assessIndexFreshness } from "../memory/IndexFreshness.js";
import { OrchestrationArtifactStore } from "./ArtifactStore.js";
import { AgentTeamManager } from "./AgentTeamManager.js";
import type { AgentTeamHierarchy } from "./AgentTeamModels.js";
import { TeamSubPlanner } from "./TeamSubPlanner.js";
import { TeamSubPlanAggregator } from "./TeamSubPlanAggregator.js";
import { TeamTaskAdoptionGate } from "./TeamTaskAdoptionGate.js";
import { ProposedTaskGraphManager } from "./ProposedTaskGraphManager.js";
import { ExecutionReadinessGate } from "./ExecutionReadinessGate.js";
import { ContextPackBuilder } from "./ContextPackBuilder.js";
import { FactoryMetadataStore, resolveFactoryMetadataDatabasePath } from "./FactoryMetadataStore.js";
import { FactoryTraceWriter } from "./FactoryTraceWriter.js";
import { DurableLockManager } from "./DurableLockManager.js";
import { IntegrationManager } from "./IntegrationManager.js";
import { IntentLedgerService } from "./IntentLedgerService.js";
import type { IntentReviewResult, IntentRewriteTarget } from "./IntentLedgerModels.js";
import {
  createAlignmentFromFrame,
  IntentHandoffGate
} from "./IntentHandoffGate.js";
import { UserIntentCompiler, type UserIntentCompilationResult } from "./UserIntentCompiler.js";
import { ProjectGoalSpecStore } from "./GoalSteward.js";
import type { IntegrationResult as FactoryIntegrationResult } from "./IntegrationModels.js";
import { MultiPlanFactory, shouldUseMultiPlanFactory } from "./MultiPlanFactory.js";
import { ProviderPlanningEvidenceBootstrapper } from "./ProviderPlanningEvidenceBootstrapper.js";
import type { MergedPlan, MultiPlanFactoryResult, MultiPlanInput, MultiPlanSummary } from "./MultiPlanModels.js";
import {
  ORCHESTRATION_SCHEMA_VERSION,
  type AgentInvocation,
  type ContextPack,
  type FinalRunReport,
  type OrchestratorEvent,
  type ParsedAgentOutput,
  type Run,
  type RunMetrics,
  type RunStatus,
  type Task
} from "./OrchestrationModels.js";
import {
  loadOrchestrationConfig,
  type OrchestrationSafetyConfig,
  type PartialOrchestrationSafetyConfig
} from "./OrchestrationConfig.js";
import {
  evaluatePromptQuality,
  isPromptQualityBlocking,
  promptQualityStatusToRunImpact,
  summarizePromptQuality
} from "./PromptQualityGate.js";
import { renderRolePrompt, rolePromptInputFromTask } from "./PromptSystem.js";
import { PromptWriterService } from "./PromptWriterService.js";
import { PatchFingerprintTracker } from "./RepairLoop.js";
import { getAgentRole } from "./RoleRegistry.js";
import { TaskGraphManager } from "./TaskGraphManager.js";
import { chooseHighSignalFiles, CoreTaskGraphCreationService } from "./CoreTaskGraphCreationService.js";
import { CoreTaskGraphExecutionService } from "./CoreTaskGraphExecutionService.js";
import { CoreSafetyVerificationGateService } from "./CoreSafetyVerificationGateService.js";
import { CoreStructuredOutputValidationService } from "./CoreStructuredOutputValidationService.js";
import { CoreExecutorInvocationService } from "./CoreExecutorInvocationService.js";
import { CoreFinalReportAssemblyService } from "./CoreFinalReportAssemblyService.js";
import { CoreFinalReportArtifactSummaryService } from "./CoreFinalReportArtifactSummaryService.js";
import { CoreFinalReportMetadataSummaryService } from "./CoreFinalReportMetadataSummaryService.js";
import {
  finalRunStatus,
  integrationLimitations,
  multiPlanLimitations,
  summarizeValidationStatus
} from "./CoreFinalReportPolicy.js";
import { CoreMemoryUpdateService } from "./CoreMemoryUpdateService.js";
import { CoreOptionalExecutionPipelineService } from "./CoreOptionalExecutionPipelineService.js";
import { teamHierarchySummary } from "./CoreReportArtifactHelpers.js";
import { CoreReadOnlyRoleInvocationService } from "./CoreReadOnlyRoleInvocationService.js";
import { CoreRunLifecycleService, type CoreRunTransitionOptions } from "./CoreRunLifecycleService.js";
import { type OverallValidationStatus } from "./ValidationSemantics.js";
import { SwarmStaffingPlanner } from "./SwarmStaffingPlanner.js";
import { InvalidRunTransitionError } from "./RunStateMachine.js";
import {
  assertValid,
  validateAgentInvocation,
  validateRun
} from "./Validation.js";

export type AgenticRunOptions = {
  workspacePath: string;
  memoryDir?: string;
  maxContextFiles?: number;
  maxContextChars?: number;
  maxTaskAttempts?: number;
  config?: PartialOrchestrationSafetyConfig;
  onEvent?: (event: import("./OrchestrationModels.js").OrchestratorEvent) => void;
  providerFactory?: (role: string) => import("../llm/LlmProvider.js").LlmProvider | undefined;
};

export type AgenticRunResult = {
  run: Run;
  tasks: Task[];
  report: FinalRunReport;
};

export class CoreOrchestrator {
  private readonly workspacePath: string;
  private readonly memoryDir: string;
  private readonly maxContextFiles: number;
  private readonly maxContextChars: number;
  private readonly maxTaskAttempts: number;
  private readonly config: OrchestrationSafetyConfig;
  private readonly artifactStore: OrchestrationArtifactStore;
  private readonly traceWriter: FactoryTraceWriter;
  private readonly lifecycle: CoreRunLifecycleService;
  private readonly memoryUpdate: CoreMemoryUpdateService;
  private readonly finalReportArtifacts: CoreFinalReportArtifactSummaryService;
  private readonly finalReportMetadata: CoreFinalReportMetadataSummaryService;
  private readonly finalReportAssembly: CoreFinalReportAssemblyService;
  private readonly taskGraphCreation: CoreTaskGraphCreationService;
  private readonly taskGraphExecution: CoreTaskGraphExecutionService;
  private readonly optionalExecutionPipeline: CoreOptionalExecutionPipelineService;
  private readonly structuredOutputs: CoreStructuredOutputValidationService;
  private readonly safetyVerification: CoreSafetyVerificationGateService;
  private readonly onEvent?: (event: import("./OrchestrationModels.js").OrchestratorEvent) => void;
  private readonly providerFactory?: (role: string) => import("../llm/LlmProvider.js").LlmProvider | undefined;

  constructor(options: AgenticRunOptions) {
    this.workspacePath = path.resolve(options.workspacePath);
    this.config = loadOrchestrationConfig({
      ...options.config,
      memory_path: options.memoryDir ?? options.config?.memory_path
    });
    this.memoryDir = options.memoryDir ?? this.config.memory_path;
    this.maxContextFiles = options.maxContextFiles ?? 6;
    this.maxContextChars = options.maxContextChars ?? this.config.max_context_size;
    this.maxTaskAttempts = options.maxTaskAttempts ?? this.config.max_attempts_per_task;
    this.artifactStore = new OrchestrationArtifactStore(this.workspacePath, this.memoryDir);
    this.traceWriter = new FactoryTraceWriter({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, sourceComponent: "CoreOrchestrator" });
    this.lifecycle = new CoreRunLifecycleService(this.artifactStore, this.traceWriter, "CoreOrchestrator");
    this.memoryUpdate = new CoreMemoryUpdateService(this.traceWriter);
    this.finalReportArtifacts = new CoreFinalReportArtifactSummaryService(this.workspacePath, this.memoryDir);
    this.finalReportMetadata = new CoreFinalReportMetadataSummaryService(this.workspacePath, this.memoryDir);
    this.finalReportAssembly = new CoreFinalReportAssemblyService({
      config: this.config,
      artifactStore: this.artifactStore,
      artifactSummaries: this.finalReportArtifacts,
      metadataSummaries: this.finalReportMetadata,
      reviewFinalIntent: (run, candidate, refs) => this.reviewIntentReportOnly(run, "final", candidate, refs),
      eventFactory: (runId, type, message, payload, taskId) => this.event(runId, type, message, payload, taskId)
    });
    this.taskGraphCreation = new CoreTaskGraphCreationService(this.workspacePath, this.artifactStore, this.memoryDir);
    this.taskGraphExecution = new CoreTaskGraphExecutionService(this.artifactStore);
    this.optionalExecutionPipeline = new CoreOptionalExecutionPipelineService({
      workspacePath: this.workspacePath,
      memoryDir: this.memoryDir,
      config: this.config,
      artifactStore: this.artifactStore,
      traceWriter: this.traceWriter
    });
    this.structuredOutputs = new CoreStructuredOutputValidationService(this.artifactStore);
    this.safetyVerification = new CoreSafetyVerificationGateService({
      workspacePath: this.workspacePath,
      memoryDir: this.memoryDir,
      config: this.config,
      artifactStore: this.artifactStore,
      structuredOutputs: this.structuredOutputs,
      providerFactory: options.providerFactory,
      eventFactory: (runId, type, message, payload, taskId) => this.event(runId, type, message, payload, taskId)
    });
    this.onEvent = options.onEvent;
    this.providerFactory = options.providerFactory;
  }

  async planOnly(userRequest: string): Promise<AgenticRunResult> {
    const run = await this.lifecycle.createRun({
      userRequest,
      workspacePath: this.workspacePath,
      memoryDir: this.memoryDir,
      config: this.config,
      maxContextFiles: this.maxContextFiles,
      maxContextChars: this.maxContextChars,
      maxTaskAttempts: this.maxTaskAttempts
    });
    await this.writeCheckpoint(run, [], "created", ["Plan-only run created."]);
    await this.transitionRun(run, "intake", "Plan-only intake started.", { mode: "plan_only" });
    const intentCompilation = await this.compileIntentContract(run);
    await this.transitionRun(run, "prompt_rewrite", `Intent contract compiled with status ${intentCompilation.contract.status}.`, {
      mode: "plan_only",
      artifactRefs: [intentCompilation.contract.artifact_ref, intentCompilation.contract.summary_ref].filter((ref): ref is string => Boolean(ref))
    });
    if (!intentCompilation.ready) return this.blockBeforePlanning(run, intentCompilation, true);
    const planningRequest = intentCompilation.contract.precise_rewrite;
    await this.transitionRun(run, "clarification_check", "Ready intent contract is available for plan-only orchestration.", { mode: "plan_only" });
    await this.transitionRun(run, "repo_mapping", "Loading repository memory for planning.", { mode: "plan_only" });
    const memory = await this.loadOrRebuildIndex(run);
    await this.writeCheckpoint(run, [], "indexed", ["Repository memory loaded for plan-only mode."]);
    await this.transitionRun(run, "complexity_estimation", "Estimated complexity from repository memory and command inventory.", { mode: "plan_only" });
    await this.transitionRun(run, "planning", "Creating deterministic task graph.");
    const multiPlan = await this.createMultiPlanIfNeeded(run, memory.repoIndex, memory.commandInventory, true, planningRequest);
    const manager = await this.taskGraphCreation.create({
      run,
      repoIndex: memory.repoIndex,
      commandInventory: memory.commandInventory,
      mergedPlan: multiPlan.merged_plan,
      planningRequest,
      maxTaskAttempts: this.maxTaskAttempts
    });
    run.root_task_ids = manager.listTasks().filter((task) => !task.parent_id).map((task) => task.id);
    run.summary = `Planned ${manager.listTasks().length} task(s) for: ${userRequest}`;
    await this.artifactStore.saveRun(assertValid("Run", run, validateRun));
    const teamHierarchy = await this.createAgentTeamsIfNeeded(run, multiPlan, manager.listTasks(), true);
    await this.recordInitialIntentReview(run, manager.listTasks(), multiPlan.summary, teamHierarchy, true);
    await this.transitionRun(run, "task_graph_ready", "Plan-only task graph is ready.", { mode: "plan_only" });
    const integration = await this.integrationManager().integrate({
      run,
      tasks: manager.listTasks(),
      parsedOutputs: [],
      mode: "plan_only",
      commandInventory: memory.commandInventory
    });
    await this.transitionRun(run, "reporting", "Writing plan-only final report.", { mode: "plan_only" });
    await this.transitionRun(run, "succeeded", "Plan-only run completed after task graph creation.", { mode: "plan_only" });
    await this.traceWriter.write({
      run_id: run.id,
      event_type: "report_started",
      lifecycle_stage: "reporting",
      summary: "Plan-only final report creation started.",
      metadata_json: { mode: "plan_only" }
    });
    const report = await this.createFinalReport(run, manager.listTasks(), [], [
      "Plan-only mode did not invoke agents.",
      "Validation commands were selected but not run.",
      ...multiPlanLimitations(multiPlan)
    ], multiPlan.summary, integration, teamHierarchy);
    await this.writeCheckpoint(run, manager.listTasks(), "planned", ["Task graph persisted in plan-only mode."]);
    await this.writeRunMetrics(run, manager.listTasks(), report);
    return { run, tasks: manager.listTasks(), report };
  }

  async runAgenticTask(userRequest: string): Promise<AgenticRunResult> {
    const run = await this.lifecycle.createRun({
      userRequest,
      workspacePath: this.workspacePath,
      memoryDir: this.memoryDir,
      config: this.config,
      maxContextFiles: this.maxContextFiles,
      maxContextChars: this.maxContextChars,
      maxTaskAttempts: this.maxTaskAttempts
    });
    let manager: TaskGraphManager | undefined;
    const parsedOutputs: ParsedAgentOutput[] = [];
    const fingerprintTracker = new PatchFingerprintTracker();
    const lockManager = new DurableLockManager({
      workspacePath: this.workspacePath,
      memoryDir: this.memoryDir,
      ttlMs: this.config.lock_ttl_ms,
      ownerComponent: "CoreOrchestrator"
    });
    try {
      await this.writeCheckpoint(run, [], "created", ["Run created."]);
      await this.transitionRun(run, "intake", "Run intake started.");
      const intentCompilation = await this.compileIntentContract(run);
      await this.transitionRun(run, "prompt_rewrite", `Intent contract compiled with status ${intentCompilation.contract.status}.`, {
        artifactRefs: [intentCompilation.contract.artifact_ref, intentCompilation.contract.summary_ref].filter((ref): ref is string => Boolean(ref))
      });
      if (!intentCompilation.ready) return this.blockBeforePlanning(run, intentCompilation, false);
      const planningRequest = intentCompilation.contract.precise_rewrite;
      await this.transitionRun(run, "clarification_check", "Ready intent contract is available for orchestration.");
      await this.transitionRun(run, "repo_mapping", "Loading or rebuilding repository index.");
      const memory = await this.loadOrRebuildIndex(run);
      await this.writeCheckpoint(run, [], "indexed", ["Repository memory loaded."]);
      await this.transitionRun(run, "complexity_estimation", "Estimated run complexity from repository memory and command inventory.");
      await this.transitionRun(run, "planning", "Creating orchestration task graph.");
      const multiPlan = await this.createMultiPlanIfNeeded(run, memory.repoIndex, memory.commandInventory, false, planningRequest);
      manager = await this.taskGraphCreation.create({
        run,
        repoIndex: memory.repoIndex,
        commandInventory: memory.commandInventory,
        mergedPlan: multiPlan.merged_plan,
        planningRequest,
        maxTaskAttempts: this.maxTaskAttempts
      });
      run.root_task_ids = manager.listTasks().filter((task) => !task.parent_id).map((task) => task.id);
      await this.artifactStore.saveRun(assertValid("Run", run, validateRun));
      const teamHierarchy = await this.createAgentTeamsIfNeeded(run, multiPlan, manager.listTasks(), false);
      await this.recordInitialIntentReview(run, manager.listTasks(), multiPlan.summary, teamHierarchy, false);
      await this.transitionRun(run, "task_graph_ready", "Task graph created and persisted.");
      await this.writeCheckpoint(run, manager.listTasks(), "planned", ["Task graph created."]);

      await this.transitionRun(run, "executing", "Executing ready tasks through canonical TaskGraphManager adapter.");
      const taskManager = manager;
      const execution = await this.taskGraphExecution.execute({
        run,
        manager: taskManager,
        lockManager,
        config: this.config,
        executeTask: async (task) => {
          const rawOutput = await this.invokeRole(run, task);
          return this.applySafetyAndVerificationGates({
            run,
            task,
            output: rawOutput,
            commandInventory: memory.commandInventory,
            manager: taskManager,
            fingerprintTracker
          });
        },
        writeCheckpoint: async (label, notes) => {
          await this.writeCheckpoint(run, taskManager.listTasks(), label, notes);
        },
        createEvent: (runId, type, message, payload, taskId) => this.event(runId, type, message, payload, taskId)
      });
      parsedOutputs.push(...execution.outputs);
      if (execution.canonical.blockingReasons.length) {
        await this.traceWriter.write({
          run_id: run.id,
          event_type: "task_blocked",
          lifecycle_stage: "executing",
          summary: "Canonical task graph execution reported blocking reasons.",
          metadata_json: { blocking_reasons: execution.canonical.blockingReasons }
        });
      }

      await this.transitionRun(run, "reviewing", "Review gates completed for executor outputs.");
      const validationStatus = summarizeValidationStatus(parsedOutputs);
      await this.transitionRun(run, "validating", "Validation runner completed safe command execution where available.", { validationStatus });
      await this.transitionRun(run, "integrating", "Integrating completed task artifacts into final report.");
      const integration = await this.integrationManager(lockManager).integrate({
        run,
        tasks: manager.listTasks(),
        parsedOutputs,
        mode: "normal",
        commandInventory: memory.commandInventory
      });
      const failedTasks = manager.listTasks().filter((task) => task.status === "failed" || task.status === "blocked");
      const finalStatus = finalRunStatus(manager.listTasks(), parsedOutputs, integration);
      await this.transitionRun(run, "memory_update", "Recording durable memory handoff for completed run artifacts.");
      await this.transitionRun(run, "reporting", "Writing final run report.");
      await this.transitionRun(run, finalStatus, finalStatus === "failed"
        ? "One or more tasks failed."
        : finalStatus === "blocked"
          ? "One or more required tasks or validations are blocked."
          : "Orchestration run succeeded.");
      await this.traceWriter.write({
        run_id: run.id,
        event_type: "report_started",
        lifecycle_stage: "reporting",
        summary: "Final run report creation started."
      });
      const report = await this.createFinalReport(run, manager.listTasks(), parsedOutputs, [
        ...(failedTasks.length ? ["Some tasks did not complete successfully."] : []),
        ...integrationLimitations(integration),
        ...multiPlanLimitations(multiPlan)
      ], multiPlan.summary, integration, teamHierarchy);
      run.summary = report.next_recommendations[0] ?? "Run completed.";
      await this.artifactStore.saveRun(assertValid("Run", run, validateRun));
      await this.writeCheckpoint(run, manager.listTasks(), "final", [`Run completed with status ${run.status}.`]);
      const metrics = await this.writeRunMetrics(run, manager.listTasks(), report);
      await this.memoryUpdate.appendRunHandoff({
        workspacePath: this.workspacePath,
        memoryDir: this.memoryDir,
        executionMode: this.config.execution_mode,
        run,
        report
      });
      await this.artifactStore.appendEvent(this.event(run.id, "run.completed", `Run completed with integration status ${integration.status}.`, {
        integration,
        metrics
      }));
      return { run, tasks: manager.listTasks(), report };
    } catch (error) {
      run.summary = error instanceof Error ? error.message : String(error);
      await this.transitionRun(run, error instanceof InvalidRunTransitionError ? "blocked" : "failed", run.summary, {
        trigger: "failure_handling"
      });
      await this.artifactStore.appendEvent(this.event(run.id, "run.failed", run.summary));
      const report = await this.createFinalReport(run, manager?.listTasks() ?? [], parsedOutputs, [run.summary]);
      await this.writeCheckpoint(run, manager?.listTasks() ?? [], "failed", [run.summary ?? "Run failed."]);
      await this.writeRunMetrics(run, manager?.listTasks() ?? [], report);
      return { run, tasks: manager?.listTasks() ?? [], report };
    }
  }

  async resumeRun(runId: string): Promise<AgenticRunResult> {
    const run = await this.artifactStore.loadRun(runId);
    const tasks = await this.artifactStore.loadTasks(runId);
    const reconciliation = await this.lifecycle.reconcileRunForResume({
      run,
      workspacePath: this.workspacePath,
      memoryDir: this.memoryDir
    });
    const freshness = await assessIndexFreshness(this.workspacePath, this.memoryDir);
    await this.artifactStore.appendEvent(this.event(run.id, "run.resumed", `Resume requested for run ${run.id}.`, {
      index_freshness: freshness.status,
      reconciliation
    }));
    if (!reconciliation.ok) {
      await this.traceWriter.write({
        run_id: run.id,
        event_type: "run_resume_mismatch_detected",
        lifecycle_stage: "blocked",
        source_component: "CoreOrchestrator",
        severity: reconciliation.severity === "failed" ? "error" : "warning",
        reason: reconciliation.reason,
        summary: reconciliation.reason,
        artifact_refs: [run.artifacts_path],
        metadata_json: {
          severity: reconciliation.severity ?? "blocked"
        }
      });
      run.summary = reconciliation.reason;
      await this.transitionRun(run, reconciliation.severity === "failed" ? "failed" : "blocked", reconciliation.reason, {
        trigger: "resume"
      });
    }
    if (freshness.status !== "fresh") {
      await this.artifactStore.appendEvent(this.event(run.id, "index.stale", "Repository changed since the saved run checkpoint.", {
        changed_files: freshness.changedFiles,
        new_files: freshness.newFiles,
        deleted_files: freshness.deletedFiles
      }));
    }
    await this.writeCheckpoint(run, tasks, "resume_requested", [
      reconciliation.ok
        ? "SQLite run state and factory metadata agree for resume inspection."
        : reconciliation.reason,
      ["succeeded", "failed", "cancelled"].includes(run.status)
        ? "Run is terminal; resume is a safe no-op."
        : "Run is non-terminal; Phase 4 requires operator reconciliation before continuing in-flight work."
    ], freshness);
    let report: FinalRunReport;
    try {
      report = await this.artifactStore.loadFinalReport(run.id);
    } catch {
      report = await this.createFinalReport(run, tasks, [], [
        "Resume inspection could not find a prior final report.",
        freshness.status !== "fresh" ? "Repository index is stale relative to saved run state." : ""
      ].filter(Boolean));
    }
    await this.writeRunMetrics(run, tasks, report);
    return { run, tasks, report };
  }

  private intentLedger(sourceComponent = "CoreOrchestrator") {
    return new IntentLedgerService({
      workspacePath: this.workspacePath,
      memoryDir: this.memoryDir,
      sourceComponent
    });
  }

  private async compileIntentContract(run: Run): Promise<UserIntentCompilationResult> {
    const result = await new UserIntentCompiler().compile({
      workspacePath: this.workspacePath,
      memoryDir: this.memoryDir,
      runId: run.id,
      runKind: "core",
      artifactsPath: run.artifacts_path,
      originalRequest: run.user_request,
      provider: this.providerFactory?.("UserIntentCompiler"),
      parentContext: {
        parent_orchestrator: "CoreOrchestrator",
        run_id: run.id,
        memory_snapshot_ref: run.memory_snapshot_ref,
        original_request_ref: run.original_request_ref,
        intent_ledger_ref: run.intent_ledger_ref
      },
      sourceComponent: "CoreOrchestrator"
    });
    run.intent_contract_ref = result.contract.artifact_ref;
    run.intent_contract_status = result.contract.status;
    await this.artifactStore.saveRun(assertValid("Run", run, validateRun));
    await this.artifactStore.appendEvent(this.event(run.id, "intent_contract.compiled", `Intent contract compiled with status ${result.contract.status}.`, {
      intent_contract_ref: result.contract.artifact_ref,
      intent_contract_status: result.contract.status,
      blocking_questions: result.blockingQuestions
    }));
    return result;
  }

  private async blockBeforePlanning(
    run: Run,
    intentCompilation: UserIntentCompilationResult,
    planOnly: boolean
  ): Promise<AgenticRunResult> {
    await this.transitionRun(run, "clarification_check", "Intent contract gate checked before planning.", { mode: planOnly ? "plan_only" : "normal" });
    await this.transitionRun(run, "blocked", `Planning blocked by intent contract status ${intentCompilation.contract.status}.`, {
      mode: planOnly ? "plan_only" : "normal",
      artifactRefs: [intentCompilation.contract.artifact_ref, intentCompilation.contract.summary_ref].filter((ref): ref is string => Boolean(ref))
    });
    await this.writeCheckpoint(run, [], "intent_contract_blocked", [
      `Intent contract status: ${intentCompilation.contract.status}.`,
      ...intentCompilation.blockingQuestions.map((question) => `Blocking question: ${question}`)
    ]);
    const report = await this.createFinalReport(run, [], [], [
      `Planning did not start because intent_contract.json status is ${intentCompilation.contract.status}.`,
      ...intentCompilation.blockingQuestions.map((question) => `Blocking missing question: ${question}`),
      ...intentCompilation.errors
    ]);
    await this.writeRunMetrics(run, [], report);
    return { run, tasks: [], report };
  }

  private async recordInitialIntentReview(
    run: Run,
    tasks: Task[],
    multiPlanSummary: MultiPlanSummary | undefined,
    teamHierarchy: AgentTeamHierarchy | undefined,
    planOnly: boolean
  ) {
    await this.reviewIntentReportOnly(run, "initial", {
      mode: planOnly ? "plan_only" : "normal",
      user_request: run.user_request,
      intent_contract_ref: run.intent_contract_ref,
      intent_contract_status: run.intent_contract_status,
      root_task_ids: run.root_task_ids,
      task_graph: tasks.map((task) => ({
        task_id: task.id,
        title: task.title,
        objective: task.objective,
        role_required: task.role_required,
        dependencies: task.dependencies,
        relevant_files: task.relevant_files,
        allowed_files_to_edit: task.allowed_files_to_edit,
        forbidden_files: task.forbidden_files,
        validation_commands: task.validation_commands
      })),
      multi_plan_summary: multiPlanSummary,
      team_hierarchy: teamHierarchy ? {
        root_team_id: teamHierarchy.root_team_id,
        team_count: teamHierarchy.teams.length,
        max_depth: teamHierarchy.max_depth,
        teams: teamHierarchy.teams.map((team) => ({
          team_id: team.team_id,
          team_type: team.team_type,
          domain: team.domain,
          objective: team.objective,
          status: team.status
        }))
      } : undefined
    }, [
      run.original_request_ref,
      run.intent_contract_ref,
      run.intent_ledger_ref,
      multiPlanSummary?.merged_plan_ref,
      teamHierarchy?.artifact_ref
    ]);
  }

  private async reviewIntentReportOnly(
    run: Run,
    stage: "initial" | "final",
    candidate: unknown,
    reviewedArtifactRefs: Array<string | undefined>,
    target: IntentRewriteTarget = stage === "initial" ? "plan" : "final_report"
  ): Promise<IntentReviewResult | undefined> {
    try {
      const parentContext = await this.intentParentContext(run);
      return await this.intentLedger().reviewIntent({
        runId: run.id,
        runKind: "core",
        artifactsPath: run.artifacts_path,
        stage,
        target,
        reviewedArtifactRefs: uniqueStrings(reviewedArtifactRefs.filter((ref): ref is string => Boolean(ref))),
        parentContextRefs: uniqueStrings([
          run.memory_snapshot_ref,
          run.intent_ledger_ref ?? "",
          parentContext.project_goal_spec_ref ?? ""
        ]),
        parentContext,
        candidate,
        provider: this.providerFactory?.("IntentReviewer")
      });
    } catch (error) {
      await this.artifactStore.appendEvent(this.event(run.id, "review.completed", "Intent reviewer did not complete; run continues in report-only mode.", {
        stage,
        review_type: "intent",
        status: "not_recorded",
        error: error instanceof Error ? error.message : String(error)
      }));
      return undefined;
    }
  }

  private async intentParentContext(run: Run) {
    const activeGoalSpec = await new ProjectGoalSpecStore({
      workspacePath: this.workspacePath,
      memoryDir: this.memoryDir
    }).loadActiveProjectGoalSpec().catch(() => undefined);
    return {
      parent_orchestrator: "CoreOrchestrator",
      run_id: run.id,
      run_status: run.status,
      memory_snapshot_ref: run.memory_snapshot_ref,
      original_request_ref: run.original_request_ref,
      intent_ledger_ref: run.intent_ledger_ref,
      project_goal_spec_ref: activeGoalSpec?.artifact_ref,
      project_goal_spec: activeGoalSpec ? {
        spec_id: activeGoalSpec.spec_id,
        title: activeGoalSpec.title,
        primary_goal: activeGoalSpec.primary_goal,
        non_goals: activeGoalSpec.non_goals,
        constraints: activeGoalSpec.constraints,
        status: activeGoalSpec.status,
        version: activeGoalSpec.version
      } : undefined
    };
  }

  private async loadOrRebuildIndex(run: Run) {
    const freshness = await assessIndexFreshness(this.workspacePath, this.memoryDir);
    if (freshness.status !== "fresh") {
      await this.artifactStore.appendEvent(this.event(run.id, "index.stale", `Repository index freshness before rebuild: ${freshness.status}.`, {
        changed_files: freshness.changedFiles,
        new_files: freshness.newFiles,
        deleted_files: freshness.deletedFiles,
        warnings: freshness.warnings
      }));
    }
    const snapshot = await rebuildRepoIndex(this.workspacePath, { memoryDir: this.memoryDir });
    run.memory_snapshot_ref = "sqlite:factory_memory_snapshots/repo_index";
    await this.artifactStore.saveRun(assertValid("Run", run, validateRun));
    await this.artifactStore.appendEvent(this.event(run.id, "repo.indexed", `Indexed ${snapshot.repoIndex.totals.indexedFiles} file(s).`, {
      indexed_files: snapshot.repoIndex.totals.indexedFiles,
      commands: snapshot.commandInventory.commands.length
    }));
    return {
      repoIndex: snapshot.repoIndex,
      commandInventory: snapshot.commandInventory
    };
  }

  private async createMultiPlanIfNeeded(
    run: Run,
    repoIndex: RepoIndex,
    commandInventory: CommandInventory,
    planOnly: boolean,
    planningRequest = run.user_request
  ): Promise<MultiPlanFactoryResult> {
    const relevantFiles = chooseHighSignalFiles(planningRequest, repoIndex);
    const staffingPlan = new SwarmStaffingPlanner().createPlan({
      swarmRunId: `planning_${run.id}`,
      userGoal: planningRequest,
      mode: this.config.execution_mode === "exhaustive" ? "exhaustive" : this.config.execution_mode === "fast" ? "fast" : "deep",
      repoIndex,
      commandInventory,
      relevantFiles
    });

    const multiPlanInput: MultiPlanInput = {
      run,
      rawUserRequest: run.user_request,
      taskObjective: planningRequest,
      repoIndex,
      commandInventory,
      staffingPlan,
      config: this.config,
      planOnly
    };
    if (
      this.config.enable_multi_plan_factory &&
      this.config.use_planning_evidence &&
      this.config.planning_evidence_mode !== "off" &&
      shouldUseMultiPlanFactory(multiPlanInput).use_multi_plan
    ) {
      const planningProvider = this.providerFactory?.("PlannerAgent");
      if (planningProvider) {
        await new ProviderPlanningEvidenceBootstrapper({
          workspacePath: this.workspacePath,
          memoryDir: this.memoryDir
        }).ensurePlanningEvidence({
          run,
          planningRequest,
          repoIndex,
          commandInventory,
          provider: planningProvider,
          planOnly
        });
      }
    }

    return new MultiPlanFactory(this.workspacePath, this.memoryDir).create(multiPlanInput);
  }

  private async invokeRole(run: Run, task: Task): Promise<ParsedAgentOutput> {
    const role = getAgentRole(task.role_required);
    const contextBuilder = new ContextPackBuilder(this.workspacePath, {
      memoryDir: this.memoryDir,
      maxFiles: this.maxContextFiles,
      maxChars: this.maxContextChars
    });
    const teamId = await this.teamIdForTask(run.id, task.id);
    const pack = await contextBuilder.build(run.id, task, teamId ? { team_id: teamId } : {});
    const packPath = await this.artifactStore.saveContextPack(pack);
    task.artifacts.push(packPath);
    await this.artifactStore.appendEvent(this.event(run.id, "context_pack.created", `Context pack created for ${task.id}.`, {
      context_pack: packPath,
      approximate_size: pack.approximate_size,
      relevant_files: pack.relevant_files
    }, task.id));
    const rolePromptInput = rolePromptInputFromTask({
      runId: run.id,
      task,
      pack,
      contextPackRef: packPath,
      sourceComponent: "CoreOrchestrator"
    });
    const intentFrame = pack.intent_frame;
    const promptResult = renderRolePrompt(rolePromptInput);
    if (!promptResult.ok) {
      await this.artifactStore.recordPromptRenderFailure(promptResult.error, {
        runId: run.id,
        taskId: task.id,
        contextPackRef: packPath
      });
      throw new Error(promptResult.error.message);
    }
    const promptMetadata = await this.artifactStore.savePromptArtifact(promptResult.rendered);
    const promptWriter = await new PromptWriterService({
      workspacePath: this.workspacePath,
      memoryDir: this.memoryDir,
      config: this.config,
      providerFactory: this.providerFactory
    }).run({
      runId: run.id,
      task,
      pack,
      contextPackRef: packPath,
      originalTemplateInput: rolePromptInput,
      targetPromptType: promptResult.template.prompt_type,
      templateId: promptResult.template.template_id,
      templateVersion: promptResult.template.version,
      originalPromptId: promptMetadata.prompt_id,
      originalPromptArtifactRef: promptMetadata.artifact_ref
    });
    const promptQuality = evaluatePromptQuality(promptResult.rendered, {
      task,
      contextPack: pack,
      contextPackRef: packPath,
      promptArtifactRef: promptMetadata.artifact_ref,
      promptMetadata,
      expectedOutputSchema: task.expected_output_schema,
      allowedFiles: task.allowed_files_to_edit,
      forbiddenFiles: task.forbidden_files,
      validationRequirements: pack.validation_requirements,
      successCriteria: [task.objective, task.expected_output_schema],
      stopConditions: ["Do not claim validation that was not run."],
      artifactRefs: task.artifacts
    });
    const promptQualityRef = await this.artifactStore.savePromptQualityResult(promptQuality);
    task.artifacts.push(promptMetadata.artifact_ref, promptQualityRef);
    if (promptWriter) {
      task.artifacts.push(...Object.values(promptWriter.artifact_refs).filter((ref): ref is string => typeof ref === "string"));
    }
    if (isPromptQualityBlocking(promptQuality)) {
      const impact = promptQualityStatusToRunImpact(promptQuality);
      return {
        summary: summarizePromptQuality(promptQuality),
        status: impact === "failed" ? "failed" : "blocked",
        files_changed: [],
        validation_results: [],
        artifacts: [promptMetadata.artifact_ref, promptQualityRef],
        limitations: promptQuality.findings
          .filter((finding) => finding.severity === "blocked" || finding.severity === "failed")
          .map((finding) => finding.message),
        next_recommendations: promptQuality.suggested_remediation.length
          ? promptQuality.suggested_remediation
          : ["Inspect the prompt quality artifact before retrying invocation."],
        intent_alignment: intentFrame ? createAlignmentFromFrame(intentFrame, {
          taskUnderstanding: `Prompt quality gate evaluated ${task.title}.`,
          originalGoalContribution: "The prompt was blocked before worker execution to preserve the canonical user intent and safety constraints.",
          evidenceRefs: [promptMetadata.artifact_ref, promptQualityRef]
        }) : undefined
      };
    }
    let activePromptMetadata = promptMetadata;
    let activePromptText = promptResult.rendered.text;
    if (promptWriter?.adoption_decision.adopted && promptWriter.candidate_rendered_prompt) {
      activePromptMetadata = await this.artifactStore.savePromptArtifact(promptWriter.candidate_rendered_prompt);
      activePromptText = promptWriter.candidate_rendered_prompt.text;
      task.artifacts.push(activePromptMetadata.artifact_ref);
    }
    const invocation: AgentInvocation = {
      schema_version: ORCHESTRATION_SCHEMA_VERSION,
      id: `invocation_${randomUUID()}`,
      run_id: run.id,
      task_id: task.id,
      role: role.name,
      prompt: activePromptText,
      context_pack_ref: packPath,
      started_at: new Date().toISOString(),
      status: "running",
      prompt_metadata: {
        prompt_id: activePromptMetadata.prompt_id,
        prompt_type: activePromptMetadata.prompt_type,
        template_id: activePromptMetadata.template_id,
        template_version: activePromptMetadata.template_version,
        renderer_version: activePromptMetadata.renderer_version,
        template_input_schema_version: activePromptMetadata.template_input_schema_version,
        input_hash: activePromptMetadata.input_hash,
        rendered_prompt_hash: activePromptMetadata.rendered_prompt_hash,
        context_pack_ref: activePromptMetadata.context_pack_ref,
        output_schema_name: activePromptMetadata.output_schema_name,
        prompt_artifact_ref: activePromptMetadata.artifact_ref,
        source_component: activePromptMetadata.source_component
      }
    };
    assertValid("AgentInvocation", invocation, validateAgentInvocation);
    await this.artifactStore.saveInvocation(invocation);
    await this.artifactStore.appendEvent(this.event(run.id, "agent.invocation_started", `${role.name} started ${task.id}.`, {
      invocation_id: invocation.id
    }, task.id));

    try {
      const output = role.name === "ExecutorAgent"
        ? await this.invokeExecutor(run, task, pack, invocation)
        : await this.invokeReadOnlyRole(role, run, task, pack, invocation);
      invocation.finished_at = new Date().toISOString();
      invocation.status = output.status === "succeeded" ? "succeeded" : "failed";
      invocation.parsed_output_ref = await this.artifactStore.saveParsedOutput(run.id, invocation.id, output);
      await this.artifactStore.saveInvocation(assertValid("AgentInvocation", invocation, validateAgentInvocation));
      await this.artifactStore.appendEvent(this.event(run.id, "agent.invocation_finished", `${role.name} finished ${task.id}: ${output.status}.`, {
        invocation_id: invocation.id,
        parsed_output_ref: invocation.parsed_output_ref
      }, task.id));
      return output;
    } catch (error) {
      invocation.finished_at = new Date().toISOString();
      invocation.status = "failed";
      invocation.error = error instanceof Error ? error.message : String(error);
      invocation.raw_output_ref = await this.artifactStore.saveRawOutput(run.id, invocation.id, { error: invocation.error });
      await this.artifactStore.saveInvocation(invocation);
      await this.artifactStore.appendEvent(this.event(run.id, "agent.invocation_finished", `${role.name} failed ${task.id}: ${invocation.error}`, {
        invocation_id: invocation.id
      }, task.id));
      return {
        summary: invocation.error,
        status: "failed",
        files_changed: [],
        validation_results: [],
        artifacts: [invocation.raw_output_ref],
        limitations: [invocation.error],
        next_recommendations: ["Inspect the failed invocation artifact."],
        intent_alignment: intentFrame ? createAlignmentFromFrame(intentFrame, {
          taskUnderstanding: `Invocation failed before ${task.role_required} could complete ${task.title}.`,
          originalGoalContribution: "The failed output is recorded only as a blocked/failed artifact and does not advance the original goal.",
          evidenceRefs: [invocation.raw_output_ref]
        }) : undefined
      };
    }
  }

  private async invokeExecutor(run: Run, task: Task, pack: ContextPack, invocation: AgentInvocation): Promise<ParsedAgentOutput> {
    return new CoreExecutorInvocationService(
      this.workspacePath,
      this.artifactStore,
      this.config,
      this.providerFactory
    ).invoke({ run, task, pack, invocation });
  }

  private async invokeReadOnlyRole(
    role: ReturnType<typeof getAgentRole>,
    run: Run,
    task: Task,
    pack: ContextPack,
    invocation: AgentInvocation
  ): Promise<ParsedAgentOutput> {
    if (role.can_edit_files || task.allowed_files_to_edit.length > 0) {
      throw new Error(`unsupported_write_role_requires_executor:${task.role_required}`);
    }
    return new CoreReadOnlyRoleInvocationService(this.artifactStore, this.providerFactory)
      .invoke({ run, task, pack, invocation });
  }

  private async applySafetyAndVerificationGates(input: {
    run: Run;
    task: Task;
    output: ParsedAgentOutput;
    commandInventory: CommandInventory;
    manager: TaskGraphManager;
    fingerprintTracker: PatchFingerprintTracker;
  }): Promise<ParsedAgentOutput> {
    return this.safetyVerification.apply(input);
  }

  private async writeCheckpoint(run: Run, tasks: Task[], label: string, notes: string[], indexFreshness?: unknown) {
    return this.lifecycle.writeCheckpoint(run, tasks, label, notes, indexFreshness);
  }

  private async writeRunMetrics(run: Run, tasks: Task[], report: FinalRunReport): Promise<RunMetrics> {
    return this.lifecycle.writeRunMetrics(run, tasks, report);
  }

  private integrationManager(lockManager?: DurableLockManager) {
    return new IntegrationManager({
      workspacePath: this.workspacePath,
      memoryDir: this.memoryDir,
      artifactStore: this.artifactStore,
      traceWriter: new FactoryTraceWriter({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, sourceComponent: "IntegrationManager" }),
      lockManager,
      applyMode: "prepare_only",
      providerFactory: this.providerFactory,
      config: this.config
    });
  }

  private async createAgentTeamsIfNeeded(run: Run, multiPlan: MultiPlanFactoryResult, tasks: Task[], planOnly: boolean): Promise<AgentTeamHierarchy | undefined> {
    const shouldCreate = multiPlan.used || this.config.execution_mode !== "fast" || run.user_request.length > 160;
    if (!shouldCreate) return undefined;
    const manager = new AgentTeamManager({
      workspacePath: this.workspacePath,
      memoryDir: this.memoryDir,
      artifactStore: this.artifactStore,
      traceWriter: new FactoryTraceWriter({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, sourceComponent: "AgentTeamManager" })
    });
    const teams = await manager.proposeTeamsFromMergedPlan(run, multiPlan.merged_plan);
    const root = teams.find((team) => team.team_type === "root");
    if (root) {
      for (const task of tasks) {
        await manager.assignTaskToTeam(task.id, root.team_id);
      }
    }
    const validation = await manager.validateTeamHierarchy(run.id);
    const hierarchy = await manager.summarizeTeamHierarchy(run.id, validation);
    const hierarchyRef = await this.artifactStore.saveAgentTeamHierarchy(run.id, hierarchy.hierarchy_id, hierarchy);
    hierarchy.artifact_ref = hierarchyRef;
    await this.artifactStore.saveAgentTeamSummary(run.id, hierarchy.hierarchy_id, teamHierarchySummary(hierarchy, validation), {
      root_team_id: hierarchy.root_team_id,
      team_count: hierarchy.teams.length,
      max_depth: hierarchy.max_depth,
      mode: planOnly ? "plan_only" : "normal"
    });
    await this.generateTeamSubPlansIfAllowed(run, hierarchy, multiPlan.used, planOnly, tasks);
    return hierarchy;
  }

  private async generateTeamSubPlansIfAllowed(run: Run, hierarchy: AgentTeamHierarchy, multiPlanUsed: boolean, planOnly: boolean, tasks: Task[]) {
    if (!this.config.enable_team_sub_planning || this.config.team_sub_planning_mode === "off") {
      await this.traceWriter.write({
        run_id: run.id,
        event_type: "team_sub_plan_skipped",
        lifecycle_stage: "planning",
        summary: "Team sub-planning skipped by configuration.",
        reason: "team_sub_planning_disabled",
        metadata_json: { run_id: run.id, mode: this.config.team_sub_planning_mode }
      });
      return;
    }
    const planner = new TeamSubPlanner({
      workspacePath: this.workspacePath,
      memoryDir: this.memoryDir,
      config: this.config,
      artifactStore: this.artifactStore,
      provider: this.config.allow_provider_team_sub_planning ? this.providerFactory?.("PlannerAgent") : undefined
    });
    const candidates = hierarchy.teams
      .filter((team) => planner.shouldSubPlanTeam(team, { teamCount: hierarchy.teams.length, multiPlanUsed }).should_plan)
      .slice(0, this.config.max_team_sub_plans_per_run);
    if (!candidates.length) {
      await this.traceWriter.write({
        run_id: run.id,
        event_type: "team_sub_plan_skipped",
        lifecycle_stage: "planning",
        summary: "No teams were eligible for read-only sub-planning.",
        reason: "no_eligible_teams",
        metadata_json: { run_id: run.id, team_count: hierarchy.teams.length, plan_only: planOnly }
      });
      await this.buildProposedTaskGraphIfAllowed(run, tasks, planOnly, []);
      return;
    }
    const plans = [];
    for (const team of candidates) {
      try {
        const input = await planner.buildTeamSubPlanInput(team.team_id);
        const generated = await planner.generateTeamSubPlan(input);
        const withArtifacts = await planner.writeTeamSubPlanArtifacts(generated);
        plans.push(await planner.persistTeamSubPlan(withArtifacts));
      } catch (error) {
        await this.traceWriter.write({
          run_id: run.id,
          team_id: team.team_id,
          event_type: "team_sub_plan_blocked",
          lifecycle_stage: "planning",
          severity: "warning",
          summary: `Team sub-planning blocked for ${team.team_id}.`,
          reason: error instanceof Error ? error.message : String(error),
          metadata_json: {
            run_id: run.id,
            team_id: team.team_id,
            parent_team_id: team.parent_team_id,
            generation_mode: this.config.team_sub_planning_mode
          }
        });
      }
    }
    if (plans.length) {
      const aggregator = new TeamSubPlanAggregator({
        workspacePath: this.workspacePath,
        memoryDir: this.memoryDir,
        artifactStore: this.artifactStore
      });
      await aggregator.aggregate(run.id, plans);
      await this.adoptTeamSubPlanTaskDraftsIfAllowed(run, plans, tasks, planOnly);
    }
  }

  private async adoptTeamSubPlanTaskDraftsIfAllowed(run: Run, plans: Awaited<ReturnType<TeamSubPlanner["persistTeamSubPlan"]>>[], tasks: Task[], planOnly: boolean) {
    if (!this.config.enable_team_task_adoption || this.config.team_task_adoption_mode === "off") {
      await this.traceWriter.write({
        run_id: run.id,
        event_type: "team_task_adoption_summary_created",
        lifecycle_stage: "planning",
        summary: "Team task adoption skipped by configuration.",
        reason: "team_task_adoption_disabled",
        metadata_json: { run_id: run.id, mode: this.config.team_task_adoption_mode, plan_only: planOnly }
      });
      await this.buildProposedTaskGraphIfAllowed(run, tasks, planOnly, []);
      return;
    }
    const gate = new TeamTaskAdoptionGate({
      workspacePath: this.workspacePath,
      memoryDir: this.memoryDir,
      config: this.config,
      artifactStore: this.artifactStore
    });
    const adoption = await gate.adoptTeamSubPlanTasks(plans, { existingTasks: tasks });
    await this.buildProposedTaskGraphIfAllowed(run, tasks, planOnly, adoption.proposals);
  }

  private async buildProposedTaskGraphIfAllowed(run: Run, tasks: Task[], planOnly: boolean, adoptedProposals?: Awaited<ReturnType<TeamTaskAdoptionGate["adoptTeamSubPlanTasks"]>>["proposals"]) {
    if (!this.config.enable_proposed_task_graph || this.config.proposed_task_graph_mode === "off") {
      await this.traceWriter.write({
        run_id: run.id,
        event_type: "proposed_task_graph_build_skipped",
        lifecycle_stage: "planning",
        summary: "Proposed task graph build skipped by configuration.",
        reason: "proposed_task_graph_disabled",
        metadata_json: { run_id: run.id, mode: this.config.proposed_task_graph_mode, plan_only: planOnly }
      });
      return;
    }
    const manager = new ProposedTaskGraphManager({
      workspacePath: this.workspacePath,
      memoryDir: this.memoryDir,
      config: this.config,
      artifactStore: this.artifactStore
    });
    const result = await manager.buildProposedGraphFromAdoptedTasks(run.id, { adoptedProposals, existingTasks: tasks });
    await this.evaluateExecutionReadinessIfAllowed(result.graph, planOnly);
  }

  private async evaluateExecutionReadinessIfAllowed(graph: Awaited<ReturnType<ProposedTaskGraphManager["buildProposedGraphFromAdoptedTasks"]>>["graph"], planOnly: boolean) {
    if (!this.config.execution_readiness_gate_enabled || this.config.execution_readiness_mode === "off") {
      await this.traceWriter.write({
        run_id: graph.run_id,
        event_type: "execution_readiness_batch_completed",
        lifecycle_stage: "planning",
        summary: "Execution readiness gate skipped by configuration.",
        reason: "execution_readiness_disabled",
        metadata_json: { run_id: graph.run_id, graph_id: graph.graph_id, mode: this.config.execution_readiness_mode, plan_only: planOnly }
      });
      return;
    }
    const gate = new ExecutionReadinessGate({
      workspacePath: this.workspacePath,
      memoryDir: this.memoryDir,
      config: this.config,
      artifactStore: this.artifactStore
    });
    await gate.evaluateProposedGraph(graph);
    await this.prepareExecutionIfAllowed(graph.run_id, planOnly);
  }

  private async prepareExecutionIfAllowed(runId: string, planOnly: boolean) {
    return this.optionalExecutionPipeline.prepareExecutionIfAllowed(runId, planOnly);
  }

  private async generateOneWriterDryRunIfAllowed(runId: string, planOnly: boolean) {
    return this.optionalExecutionPipeline.generateOneWriterDryRunIfAllowed(runId, planOnly);
  }

  private async reviewPatchProposalsIfAllowed(runId: string, planOnly: boolean) {
    return this.optionalExecutionPipeline.reviewPatchProposalsIfAllowed(runId, planOnly);
  }

  private async createValidationCandidatesIfAllowed(runId: string, planOnly: boolean) {
    return this.optionalExecutionPipeline.createValidationCandidatesIfAllowed(runId, planOnly);
  }

  private async createPatchApplySandboxIfAllowed(runId: string, planOnly: boolean) {
    return this.optionalExecutionPipeline.createPatchApplySandboxIfAllowed(runId, planOnly);
  }

  private async runSandboxValidationIfAllowed(runId: string, planOnly: boolean) {
    return this.optionalExecutionPipeline.runSandboxValidationIfAllowed(runId, planOnly);
  }

  private async createSandboxIntegrationCandidatesIfAllowed(runId: string, planOnly: boolean) {
    return this.optionalExecutionPipeline.createSandboxIntegrationCandidatesIfAllowed(runId, planOnly);
  }

  private async createIntegrationApplyApprovalsIfAllowed(runId: string, planOnly: boolean) {
    return this.optionalExecutionPipeline.createIntegrationApplyApprovalsIfAllowed(runId, planOnly);
  }

  private async applyControlledIntegrationIfAllowed(runId: string, planOnly: boolean) {
    return this.optionalExecutionPipeline.applyControlledIntegrationIfAllowed(runId, planOnly);
  }

  private async finalizeIntegrationIfAllowed(runId: string, planOnly: boolean) {
    return this.optionalExecutionPipeline.finalizeIntegrationIfAllowed(runId, planOnly);
  }

  private async integrationFinalizationReportSummary(runId: string) {
    return this.finalReportMetadata.integrationFinalizationReportSummary(runId);
  }

  private async createFinalReport(
    run: Run,
    tasks: Task[],
    outputs: ParsedAgentOutput[],
    extraLimitations: string[],
    multiPlanSummary?: MultiPlanSummary,
    integration?: FactoryIntegrationResult,
    teamHierarchy?: AgentTeamHierarchy
  ): Promise<FinalRunReport> {
    return this.finalReportAssembly.create({
      run,
      tasks,
      outputs,
      extraLimitations,
      multiPlanSummary,
      integration,
      teamHierarchy
    });
  }

  private async teamIdForTask(runId: string, taskId: string) {
    try {
      if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return undefined;
      const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
      try {
        const row = store.get<{ team_id: string }>(
          "SELECT team_id FROM factory_agent_team_assignments WHERE run_id = ? AND target_id = ? AND assignment_type = 'task' ORDER BY created_at DESC LIMIT 1",
          runId,
          taskId
        );
        return row?.team_id;
      } finally {
        store.close();
      }
    } catch {
      return undefined;
    }
  }

  private async transitionRun(run: Run, status: RunStatus, message: string, options: CoreRunTransitionOptions = {}) {
    return this.lifecycle.transitionRun(run, status, message, options);
  }

  private event(runId: string, type: OrchestratorEvent["type"], message: string, payload?: Record<string, unknown>, taskId?: string): OrchestratorEvent {
    return {
      id: `event_${randomUUID()}`,
      run_id: runId,
      task_id: taskId,
      type,
      message,
      created_at: new Date().toISOString(),
      payload
    };
  }
}

export async function loadRunDetails(workspacePath: string, runId: string, memoryDir?: string) {
  const store = new OrchestrationArtifactStore(path.resolve(workspacePath), memoryDir);
  const run = await store.loadRun(runId);
  const tasks = await store.loadTasks(runId);
  return { run, tasks };
}

export async function loadTaskDetails(workspacePath: string, runId: string, taskId: string, memoryDir?: string) {
  const store = new OrchestrationArtifactStore(path.resolve(workspacePath), memoryDir);
  const tasks = await store.loadTasks(runId);
  const task = tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  return { task };
}

export async function listOrchestrationRuns(workspacePath: string, memoryDir?: string) {
  const store = new OrchestrationArtifactStore(path.resolve(workspacePath), memoryDir);
  return store.listRuns();
}

export async function loadContextPackForTask(workspacePath: string, runId: string, taskId: string, memoryDir?: string) {
  const store = new OrchestrationArtifactStore(path.resolve(workspacePath), memoryDir);
  return store.loadContextPack(runId, taskId);
}

export async function loadRunEvents(workspacePath: string, runId: string, memoryDir?: string) {
  const store = new OrchestrationArtifactStore(path.resolve(workspacePath), memoryDir);
  return store.listRunEvents(runId);
}

export async function loadTaskArtifacts(workspacePath: string, runId: string, taskId: string, memoryDir?: string) {
  const store = new OrchestrationArtifactStore(path.resolve(workspacePath), memoryDir);
  return store.listTaskArtifacts(runId, taskId);
}

export async function loadValidationLogs(workspacePath: string, runId: string, memoryDir?: string) {
  const store = new OrchestrationArtifactStore(path.resolve(workspacePath), memoryDir);
  return store.listValidationLogs(runId);
}

export async function loadPatchHistory(workspacePath: string, runId: string, memoryDir?: string) {
  const store = new OrchestrationArtifactStore(path.resolve(workspacePath), memoryDir);
  return store.listPatchHistory(runId);
}

export async function resumeOrchestrationRun(workspacePath: string, runId: string, memoryDir?: string) {
  return new CoreOrchestrator({ workspacePath, memoryDir }).resumeRun(runId);
}

export async function loadFinalRunReport(workspacePath: string, runId: string, memoryDir?: string) {
  const store = new OrchestrationArtifactStore(path.resolve(workspacePath), memoryDir);
  return store.loadFinalReport(runId);
}

export async function loadRunMetrics(workspacePath: string, runId: string, memoryDir?: string) {
  const store = new OrchestrationArtifactStore(path.resolve(workspacePath), memoryDir);
  return store.loadRunMetrics(runId);
}

export async function loadRunArtifactTree(workspacePath: string, runId: string, memoryDir?: string) {
  const store = new OrchestrationArtifactStore(path.resolve(workspacePath), memoryDir);
  return store.artifactTree(runId);
}

export async function readRunArtifact(workspacePath: string, runId: string, artifactPath: string, memoryDir?: string) {
  const store = new OrchestrationArtifactStore(path.resolve(workspacePath), memoryDir);
  return store.readArtifactText(runId, artifactPath);
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
