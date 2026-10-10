import { randomUUID } from "node:crypto";
import type { AgentIntentAlignment } from "@hivo/protocol";
import type { LlmProvider } from "../llm/LlmProvider.js";
import type { CommandInventory, RepoIndex } from "../memory/types.js";
import { invokeReasoningProviderStructured } from "../runtime/ReasoningKernel.js";
import { OrchestrationArtifactStore } from "./ArtifactStore.js";
import { FactoryMetadataAdapter } from "./FactoryMetadataStore.js";
import { FactoryTraceWriter } from "./FactoryTraceWriter.js";
import { createCoreIntentFrame, IntentHandoffGate } from "./IntentHandoffGate.js";
import { IntentLedgerService } from "./IntentLedgerService.js";
import { ORCHESTRATION_SCHEMA_VERSION, type Run, type Task } from "./OrchestrationModels.js";
import { normalizeReadOnlySwarmOutput, swarmPlannerOutputSchema } from "./ReadOnlySwarmWorkerSchemas.js";

export type ProviderPlanningEvidenceBootstrapperOptions = {
  workspacePath: string;
  memoryDir?: string;
  providerName?: string;
  modelName?: string;
  responseLanguage?: "ar" | "en";
};

export type EnsurePlanningEvidenceInput = {
  run: Run;
  planningRequest: string;
  repoIndex: RepoIndex;
  commandInventory: CommandInventory;
  provider: LlmProvider;
  planOnly?: boolean;
};

export type PlanningEvidenceBootstrapResult = {
  ok: boolean;
  workerInvocationId?: string;
  parsedOutputRef?: string;
  rawOutputRef?: string;
  error?: string;
};

export class ProviderPlanningEvidenceBootstrapper {
  private readonly artifactStore: OrchestrationArtifactStore;
  private readonly metadata: FactoryMetadataAdapter;
  private readonly traceWriter: FactoryTraceWriter;

  constructor(private readonly options: ProviderPlanningEvidenceBootstrapperOptions) {
    this.artifactStore = new OrchestrationArtifactStore(options.workspacePath, options.memoryDir);
    this.metadata = new FactoryMetadataAdapter(options.workspacePath, options.memoryDir);
    this.traceWriter = new FactoryTraceWriter({
      workspacePath: options.workspacePath,
      memoryDir: options.memoryDir,
      sourceComponent: "ProviderPlanningEvidenceBootstrapper"
    });
  }

  async ensurePlanningEvidence(input: EnsurePlanningEvidenceInput): Promise<PlanningEvidenceBootstrapResult> {
    const context = await new IntentLedgerService({
      workspacePath: this.options.workspacePath,
      memoryDir: this.options.memoryDir,
      sourceComponent: "ProviderPlanningEvidenceBootstrapper"
    }).loadContext(input.run.id, "core", input.run.artifacts_path);
    if (!context.original_request || !context.original_request_ref || !context.original_request_hash || !context.intent_contract_ref) {
      throw new Error("canonical_intent_context_required_for_planning_evidence");
    }
    const task = planningTask(input);
    const frame = createCoreIntentFrame({ run: input.run, task, context });
    const invocationId = `worker_inv_planner_${randomUUID().slice(0, 8)}`;
    const createdAt = new Date().toISOString();
    const traceMetadata = {
      bootstrap_kind: "planning_evidence",
      worker_invocation_id: invocationId,
      task_slice_id: frame.current_task_slice.task_slice_id,
      intent_contract_ref: frame.intent_contract_ref,
      original_request_ref: frame.original_request_ref,
      plan_only: Boolean(input.planOnly)
    };
    const started = await this.traceWriter.write({
      run_id: input.run.id,
      task_id: task.id,
      event_type: "provider_invocation_started",
      lifecycle_stage: "planning",
      summary: "PlannerAgent provider invocation started for planning evidence.",
      artifact_refs: [frame.original_request_ref, frame.intent_contract_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: traceMetadata
    });

    const systemPrompt = [
      "You are a read-only PlannerAgent generating advisory planning evidence for multi-plan factory synthesis.",
      "Return strict JSON matching the swarm_planner_output schema, including your own intent_alignment grounded in the supplied canonical intent frame.",
      "Never propose patches, file writes, or arbitrary execution commands.",
      this.options.responseLanguage === "ar"
        ? "The user's response language is Arabic. Write natural-language plan summaries, tasks, and risks in Arabic where possible, while preserving code terms and file paths exactly."
        : "The user's response language is English. Write concise user-facing English planning outputs."
    ].join(" ");

    const userPrompt = [
      `User request / goal: ${input.planningRequest}`,
      `Workspace indexed files: ${input.repoIndex.totals.indexedFiles}`,
      `Entrypoints: ${input.repoIndex.entrypoints.slice(0, 10).join(", ") || "none"}`,
      `Important files: ${input.repoIndex.importantFiles.slice(0, 10).join(", ") || "none"}`,
      `Validation test commands: ${input.commandInventory.byKind.test.slice(0, 5).join(", ") || "none"}`,
      `Validation build/typecheck commands: ${[...input.commandInventory.byKind.build, ...input.commandInventory.byKind.typecheck].slice(0, 5).join(", ") || "none"}`,
      input.planOnly ? "Plan-only mode is active; focus on safe discovery, structure, dependencies, and validation strategy." : ""
    ].filter(Boolean).join("\n\n");

    let rawOutput: unknown;
    try {
      rawOutput = await invokeReasoningProviderStructured(
        input.provider,
        {
          purpose: "reason",
          reasoningStage: "reason",
          systemPrompt,
          userPrompt,
          context: {
            planning_request: input.planningRequest,
            intent_frame: frame,
            repo_index: {
              totals: input.repoIndex.totals,
              entrypoints: input.repoIndex.entrypoints,
              important_files: input.repoIndex.importantFiles
            },
            command_inventory: {
              test: input.commandInventory.byKind.test,
              build: input.commandInventory.byKind.build,
              typecheck: input.commandInventory.byKind.typecheck,
              lint: input.commandInventory.byKind.lint
            },
            plan_only: Boolean(input.planOnly)
          }
        },
        swarmPlannerOutputSchema
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.recordFailure({
        run: input.run, task, invocationId, createdAt, startedTraceId: started.trace_event_id,
        traceMetadata, message, outputSchemaStatus: "not_run"
      });
      return { ok: false, workerInvocationId: invocationId, error: message };
    }

    await this.traceWriter.write({
      run_id: input.run.id,
      task_id: task.id,
      event_type: "provider_invocation_completed",
      lifecycle_stage: "planning",
      causal_parent_event_id: started.trace_event_id,
      summary: "PlannerAgent provider invocation completed.",
      metadata_json: traceMetadata
    });
    const rawRef = await this.artifactStore.saveRawOutput(input.run.id, invocationId, rawOutput);
    await this.traceWriter.write({
      run_id: input.run.id,
      task_id: task.id,
      event_type: "provider_output_saved",
      lifecycle_stage: "planning",
      causal_parent_event_id: started.trace_event_id,
      summary: "Raw PlannerAgent output saved.",
      artifact_refs: [rawRef],
      metadata_json: traceMetadata
    });

    const normalized = normalizeReadOnlySwarmOutput(rawOutput, swarmPlannerOutputSchema);
    if (!normalized.validation.valid) {
      const message = normalized.validation.errors.join("; ");
      await this.recordFailure({
        run: input.run, task, invocationId, createdAt, startedTraceId: started.trace_event_id,
        traceMetadata, message, outputSchemaStatus: "failed", rawOutputRef: rawRef
      });
      return { ok: false, workerInvocationId: invocationId, rawOutputRef: rawRef, error: message };
    }

    const parsedOutput = normalized.value as { intent_alignment: AgentIntentAlignment };
    const gate = await new IntentHandoffGate({
      workspacePath: this.options.workspacePath,
      memoryDir: this.options.memoryDir,
      sourceComponent: "ProviderPlanningEvidenceBootstrapper"
    }).evaluate({
      runId: input.run.id,
      runKind: "core",
      artifactsPath: input.run.artifacts_path,
      layer: "core",
      taskId: task.id,
      frame,
      alignment: parsedOutput.intent_alignment,
      candidate: parsedOutput,
      reviewedArtifactRefs: [rawRef],
      target: "plan"
    });
    if (!gate.passed) {
      const message = gate.deterministic_errors.join("; ");
      await this.recordFailure({
        run: input.run, task, invocationId, createdAt, startedTraceId: started.trace_event_id,
        traceMetadata, message, outputSchemaStatus: "failed", rawOutputRef: rawRef,
        gateRef: gate.artifact_ref
      });
      return { ok: false, workerInvocationId: invocationId, rawOutputRef: rawRef, error: message };
    }

    const parsedRef = await this.artifactStore.saveParsedOutput(input.run.id, invocationId, normalized.value);
    await this.traceWriter.write({
      run_id: input.run.id,
      task_id: task.id,
      event_type: "provider_output_schema_validated",
      lifecycle_stage: "planning",
      causal_parent_event_id: started.trace_event_id,
      summary: "PlannerAgent schema and canonical intent alignment passed.",
      artifact_refs: [rawRef, parsedRef, gate.artifact_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { ...traceMetadata, intent_handoff_gate_status: gate.status, schema_repaired: normalized.repaired }
    });
    await this.metadata.recordWorkerInvocationSaved({
      workerInvocationId: invocationId,
      runId: input.run.id,
      taskId: task.id,
      agentRole: "PlannerAgent",
      workerMode: "provider_read_only",
      providerName: this.options.providerName,
      modelName: this.options.modelName,
      rawOutputRef: rawRef,
      parsedOutputRef: parsedRef,
      outputSchemaName: "swarm_planner_output",
      outputSchemaStatus: "passed",
      traceEventId: started.trace_event_id,
      status: "succeeded",
      createdAt,
      completedAt: new Date().toISOString(),
      metadata: {
        ...traceMetadata,
        intent_handoff_gate_ref: gate.artifact_ref,
        repaired: normalized.repaired,
        repair_reasons: normalized.repair_reasons
      }
    });
    return { ok: true, workerInvocationId: invocationId, parsedOutputRef: parsedRef, rawOutputRef: rawRef };
  }

  private async recordFailure(input: {
    run: Run;
    task: Task;
    invocationId: string;
    createdAt: string;
    startedTraceId: string;
    traceMetadata: Record<string, unknown>;
    message: string;
    outputSchemaStatus: "not_run" | "failed";
    rawOutputRef?: string;
    gateRef?: string;
  }) {
    await this.metadata.recordWorkerInvocationSaved({
      workerInvocationId: input.invocationId,
      runId: input.run.id,
      taskId: input.task.id,
      agentRole: "PlannerAgent",
      workerMode: "provider_read_only",
      providerName: this.options.providerName,
      modelName: this.options.modelName,
      rawOutputRef: input.rawOutputRef,
      outputSchemaName: "swarm_planner_output",
      outputSchemaStatus: input.outputSchemaStatus,
      traceEventId: input.startedTraceId,
      status: "failed",
      errorSummary: input.message,
      createdAt: input.createdAt,
      completedAt: new Date().toISOString(),
      metadata: { ...input.traceMetadata, intent_handoff_gate_ref: input.gateRef }
    });
    await this.traceWriter.write({
      run_id: input.run.id,
      task_id: input.task.id,
      event_type: input.outputSchemaStatus === "not_run" ? "provider_invocation_failed" : "provider_output_schema_failed",
      lifecycle_stage: "planning",
      causal_parent_event_id: input.startedTraceId,
      severity: "warning",
      summary: `PlannerAgent planning evidence failed: ${input.message}`,
      reason: input.message,
      artifact_refs: [input.rawOutputRef, input.gateRef].filter((ref): ref is string => Boolean(ref)),
      metadata_json: input.traceMetadata
    });
  }
}

function planningTask(input: EnsurePlanningEvidenceInput): Task {
  const now = new Date().toISOString();
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id: `planning_evidence_${input.run.id}`,
    run_id: input.run.id,
    title: "Provider planning evidence",
    objective: input.planningRequest,
    role_required: "PlannerAgent",
    status: "pending",
    dependencies: [],
    relevant_files: input.repoIndex.importantFiles.slice(0, 10),
    allowed_files_to_edit: [],
    forbidden_files: [],
    expected_output_schema: swarmPlannerOutputSchema.name,
    validation_commands: [],
    max_attempts: 1,
    attempt_count: 0,
    artifacts: [],
    created_at: now,
    updated_at: now
  };
}
