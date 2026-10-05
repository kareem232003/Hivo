import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeJson } from "../memory/ProjectMemory.js";
import {
  CoreOrchestrator,
  ExecutionPreparationPlanner,
  FactoryMetadataAdapter,
  FactoryMetadataStore,
  ORCHESTRATION_SCHEMA_VERSION,
  OrchestrationArtifactStore,
  createApprovalScope,
  createExecutionPreparationBlocker,
  createExecutionPreparationPlan,
  createExecutionPreparationRequest,
  createExecutionPreparationSummary,
  createExecutionPromotionRequest,
  createExecutionReadinessDecision,
  createExecutionValidationPlan,
  createExecutionReviewPolicy,
  createExecutionIntegrationPreview,
  createExecutionRollbackPreview,
  createHumanApprovalRecord,
  createPromotionQueueItem,
  createProposedTaskGraphNode,
  createWriterSlot,
  loadOrchestrationConfig,
  reconstructFactoryRunTrace,
  type ExecutionPromotionRequest,
  type HumanApprovalRecord,
  type PromotionQueueItem,
} from "../orchestration/index.js";
import { ScriptedProvider } from "./fixtures/ScriptedProvider.js";

test("execution preparation models create plans batches blockers and warnings", () => {
  const blocker = createExecutionPreparationBlocker({
    preparation_plan_id: "prep_model",
    blocker_type: "missing_validation",
    severity: "blocking",
    reason: "validation missing",
    refs: ["node_model"]
  });
  const plan = createExecutionPreparationPlan({
    preparation_plan_id: "prep_model",
    run_id: "run_model",
    queue_item_id: "queue_model",
    promotion_request_id: "request_model",
    approval_id: "approval_model",
    proposed_node_id: "node_model",
    status: "missing_validation",
    intended_writer_slot: createWriterSlot({
      run_id: "run_model",
      queue_item_id: "queue_model",
      proposed_node_id: "node_model",
      writer_role: "ExecutorAgent",
      write_capable: true
    }),
    writer_role: "ExecutorAgent",
    task_type: "domain",
    read_or_write_classification: "write_candidate",
    objective: "Prepare execution.",
    allowed_files: ["src/runtime.ts"],
    forbidden_files: [".env"],
    read_only_files: ["src/review.ts"],
    required_file_locks: ["file:src/runtime.ts"],
    required_module_locks: ["module:src"],
    required_semantic_locks: ["semantic:runtime"],
    context_freshness_summary: { status: "current" },
    validation_plan: createExecutionValidationPlan({ status: "missing", required_commands: [], required_checks: [], command_inventory_refs: [], strict_validation_required: true }),
    review_policy: createExecutionReviewPolicy({ status: "planned", required_reviews: ["basic_review"], specialist_reviews: [], validation_review_required: true, integration_review_required: true }),
    integration_preview: createExecutionIntegrationPreview({ status: "available", integration_manager_required: true, expected_candidate_requirements: ["accepted_review_ref"], required_post_integration_validation: ["npm test"], changed_files_preview: ["src/runtime.ts"], limitations: ["preview only"] }),
    rollback_preview: createExecutionRollbackPreview({ status: "manual_limited", rollback_available: false, limitations: ["manual"], refs: [] }),
    risk_level: "medium",
    blockers: [blocker],
    warnings: []
  });
  const request = createExecutionPreparationRequest({ run_id: "run_model", queue_item_ids: ["queue_model"], requested_by: "test", mode: "prepare_only" });
  const summary = createExecutionPreparationSummary({
    run_id: "run_model",
    execution_preparation_used: true,
    preparation_plan_count: 1,
    prepared_count: 0,
    blocked_count: 1,
    missing_approval_count: 0,
    missing_context_count: 0,
    missing_prompt_count: 0,
    missing_validation_count: 1,
    missing_locks_count: 0,
    stale_context_count: 0,
    cancelled_count: 0
  });
  assert.equal(plan.intended_writer_slot.max_active_writers, 1);
  assert.equal(plan.blockers[0].blocker_type, "missing_validation");
  assert.equal(request.queue_item_ids.length, 1);
  assert.equal(summary.missing_validation_count, 1);
  assert.equal(JSON.parse(JSON.stringify(plan)).metadata_json.no_execution, undefined);
});

test("approved write queue item prepares one writer without locks validation integration candidates or writer invocation", async () => {
  const workspace = await fixtureWorkspace("execution-preparation-write");
  try {
    const artifactStore = new OrchestrationArtifactStore(workspace);
    const { queueItem } = await persistPreparationInputs(workspace, "run_prepare", "write");
    const planner = new ExecutionPreparationPlanner({ workspacePath: workspace, config: config(), artifactStore });
    const result = await planner.prepareApprovedQueueItem(queueItem);
    assert.equal(result.status, "prepared");
    assert.ok(result.plan);
    assert.equal(result.plan.intended_writer_slot.max_active_writers, 1);
    assert.equal(result.plan.writer_role, "ExecutorAgent");
    assert.deepEqual(result.plan.allowed_files, ["src/runtime.ts"]);
    assert.ok(result.plan.context_pack_ref && existsSync(result.plan.context_pack_ref));
    assert.ok(result.plan.prompt_id);
    assert.ok(result.plan.prompt_quality_result_ref && existsSync(result.plan.prompt_quality_result_ref));
    assert.ok(result.plan.required_file_locks.some((lock) => lock.includes("src/runtime.ts")));
    assert.equal(result.plan.validation_plan.no_commands_run, true);
    assert.equal(result.plan.integration_preview.no_candidate_created, true);
    assert.equal(result.plan.integration_preview.no_apply_called, true);

    const metadata = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.equal(metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_execution_preparation_plans WHERE run_id = ?", "run_prepare")?.count, 1);
      assert.equal(metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_execution_preparation_batches WHERE run_id = ?", "run_prepare")?.count ?? 0, 0);
      assert.equal(metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_locks WHERE run_id = ?", "run_prepare")?.count ?? 0, 0);
      assert.equal(metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_validations WHERE run_id = ?", "run_prepare")?.count ?? 0, 0);
      assert.equal(metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_integration_candidates WHERE run_id = ?", "run_prepare")?.count ?? 0, 0);
      assert.equal(metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_worker_invocations WHERE run_id = ?", "run_prepare")?.count ?? 0, 0);
      assert.equal(metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_execution_preparation_blockers WHERE run_id = ?", "run_prepare")?.count ?? 0, 0);
    } finally {
      metadata.close();
    }

    const trace = await reconstructFactoryRunTrace({ workspacePath: workspace, runId: "run_prepare" });
    const events = new Set(trace.events.map((event) => event.event_type));
    for (const event of [
      "execution_preparation_started",
      "execution_preparation_queue_item_loaded",
      "execution_preparation_context_prepared",
      "execution_preparation_prompt_prepared",
      "execution_preparation_prompt_quality_passed",
      "execution_preparation_locks_derived",
      "execution_preparation_validation_plan_created",
      "execution_preparation_review_policy_created",
      "execution_preparation_integration_preview_created",
      "execution_preparation_completed"
    ]) {
      assert.ok(events.has(event), `missing trace event ${event}`);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("invalid approvals missing readiness missing proposed nodes and read-only policy are enforced", async () => {
  const workspace = await fixtureWorkspace("execution-preparation-blocks");
  try {
    const denied = await persistPreparationInputs(workspace, "run_denied", "write", { approvalDecision: "denied" });
    const deniedResult = await new ExecutionPreparationPlanner({ workspacePath: workspace, config: config({ allow_test_fixture_approvals: true }) }).prepareApprovedQueueItem(denied.queueItem);
    assert.equal(deniedResult.status, "missing_approval");

    const missingNode = await persistPreparationInputs(workspace, "run_missing_node", "write", { skipNode: true });
    const missingNodeResult = await new ExecutionPreparationPlanner({ workspacePath: workspace, config: config() }).prepareApprovedQueueItem(missingNode.queueItem);
    assert.equal(missingNodeResult.status, "blocked");
    assert.ok(missingNodeResult.blockers.some((blocker) => blocker.blocker_type === "missing_proposed_node"));

    const readOnly = await persistPreparationInputs(workspace, "run_readonly_prepare", "read_only", { skipApproval: true });
    const readOnlyAllowed = await new ExecutionPreparationPlanner({ workspacePath: workspace, config: config({ execution_preparation_mode: "prepare_only", allow_read_only_preparation_without_human_approval: true }) }).prepareApprovedQueueItem(readOnly.queueItem);
    assert.equal(readOnlyAllowed.status, "prepared");

    const readOnlyBlocked = await new ExecutionPreparationPlanner({ workspacePath: workspace, config: config({ allow_read_only_preparation_without_human_approval: false }) }).prepareApprovedQueueItem(readOnly.queueItem);
    assert.equal(readOnlyBlocked.status, "missing_approval");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("preparation detects conflicting prepared plans and writes batch artifacts", async () => {
  const workspace = await fixtureWorkspace("execution-preparation-batch");
  try {
    await persistPreparationInputs(workspace, "run_batch", "write", { suffix: "a" });
    await persistPreparationInputs(workspace, "run_batch", "write", { suffix: "b" });
    const planner = new ExecutionPreparationPlanner({ workspacePath: workspace, config: config() });
    const batch = await planner.prepareRunPromotionQueue("run_batch");
    assert.equal(batch.plans.length, 2);
    assert.ok(batch.artifact_ref && existsSync(batch.artifact_ref));
    assert.ok(batch.summary_ref && existsSync(batch.summary_ref));
    assert.ok(batch.plans.some((plan) => plan.warnings.some((warning) => warning.warning_type === "existing_preparation_conflict")));
    for (const plan of batch.plans) {
      assert.ok(plan.artifact_ref && existsSync(plan.artifact_ref));
      assert.ok(plan.lock_plan_ref && existsSync(plan.lock_plan_ref));
      assert.ok(plan.validation_plan_ref && existsSync(plan.validation_plan_ref));
      assert.ok(plan.review_policy_ref && existsSync(plan.review_policy_ref));
      assert.ok(plan.integration_preview_ref && existsSync(plan.integration_preview_ref));
    }

    const metadata = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.equal(metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_execution_preparation_batches WHERE run_id = ?", "run_batch")?.count, 1);
      assert.ok((metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_execution_preparation_warnings WHERE run_id = ?", "run_batch")?.count ?? 0) >= 1);
    } finally {
      metadata.close();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("CoreOrchestrator creates preparation plans after promotion queue without changing execution behavior", async () => {
  const workspace = await fixtureWorkspace("execution-preparation-core");
  try {
    const result = await new CoreOrchestrator({
      workspacePath: workspace,
      providerFactory: () => new ScriptedProvider(),
      maxContextFiles: 3,
      maxContextChars: 3000,
      config: {
        execution_mode: "deep",
        enable_multi_plan_factory: true,
        enable_team_sub_planning: true,
        max_team_sub_plans_per_run: 1,
        max_team_sub_plan_tasks: 1,
        enable_team_task_adoption: true,
        enable_proposed_task_graph: true,
        execution_readiness_gate_enabled: true,
        execution_readiness_mode: "report_only",
        enable_execution_promotion_queue: true,
        promotion_queue_mode: "queue_candidates",
        enable_execution_preparation: true,
        execution_preparation_mode: "prepare_only",
        max_preparation_plans_per_run: 1,
        track_blocked_promotion_requests: true
      }
    }).planOnly("Plan a read-only and future write execution preparation change across src/runtime.ts without executing tasks.");
    assert.equal(result.run.status, "succeeded");
    assert.ok(result.report.execution_preparation_used);
    assert.ok((result.report.preparation_plan_count ?? 0) >= 1);
    assert.ok(result.report.preparation_summary_ref && existsSync(result.report.preparation_summary_ref));
    assert.equal(result.tasks.some((task) => task.status === "ready" || task.status === "running"), false);

    const metadata = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.equal(metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_locks WHERE run_id = ?", result.run.id)?.count ?? 0, 0);
      assert.equal(metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_worker_invocations WHERE run_id = ?", result.run.id)?.count ?? 0, 0);
    } finally {
      metadata.close();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function persistPreparationInputs(
  workspace: string,
  runId: string,
  kind: "write" | "read_only",
  options: { suffix?: string; approvalDecision?: "approved" | "denied" | "expired" | "revoked"; skipApproval?: boolean; skipNode?: boolean } = {}
) {
  const suffix = options.suffix ?? kind;
  const scope = createApprovalScope({
    allowed_files: kind === "write" ? ["src/runtime.ts"] : [],
    forbidden_files: [".env"],
    read_only_files: kind === "write" ? ["src/review.ts"] : ["src/review.ts", "src/runtime.ts"],
    required_locks: kind === "write" ? ["module:src"] : [],
    required_context_refs: ["context_pack"],
    required_prompt_template_ref: kind === "write" ? "factory.role.executor@1.0.0" : "factory.role.reviewer@1.0.0",
    required_validation_strategy: kind === "write" ? ["npm test"] : [],
    required_success_criteria: ["Prepared only."],
    required_review_policy: kind === "write" ? ["review_required_before_integration"] : []
  });
  const decision = createExecutionReadinessDecision({
    decision_id: `decision_${runId}_${suffix}`,
    run_id: runId,
    proposed_node_id: `node_${runId}_${suffix}`,
    team_id: "team_runtime",
    adopted_task_id: `adopted_${suffix}`,
    task_type: kind === "write" ? "domain" : "review",
    read_or_write_classification: kind === "write" ? "write_candidate" : "read_only",
    proposed_role: kind === "write" ? "ExecutorAgent" : "ReviewerAgent",
    readiness_status: kind === "write" ? "future_write_candidate" : "ready_read_only",
    approval_status: kind === "write" ? "human_approval_required" : "read_only_candidate",
    requirements_checked: [],
    passed_requirements: ["context", "prompt"],
    failed_requirements: [],
    blockers: [],
    warnings: [],
    required_locks: scope.required_locks,
    required_context_refs: scope.required_context_refs,
    required_prompt_template_ref: scope.required_prompt_template_ref,
    required_validation_strategy: scope.required_validation_strategy,
    required_success_criteria: scope.required_success_criteria,
    required_review_policy: scope.required_review_policy,
    risk_level: kind === "write" ? "medium" : "low",
    confidence: 0.9,
    metadata_json: {
      title: kind === "write" ? "Update runtime" : "Review runtime",
      objective: kind === "write" ? "Prepare to update src/runtime.ts safely." : "Prepare to review runtime context.",
      allowed_files: scope.allowed_files,
      forbidden_files: scope.forbidden_files,
      read_only_files: scope.read_only_files
    }
  });
  const request = createExecutionPromotionRequest({
    promotion_request_id: `request_${runId}_${suffix}`,
    run_id: runId,
    proposed_node_id: decision.proposed_node_id,
    readiness_decision_id: decision.decision_id,
    team_id: decision.team_id,
    adopted_task_id: decision.adopted_task_id,
    task_type: decision.task_type,
    read_or_write_classification: decision.read_or_write_classification,
    proposed_role: decision.proposed_role,
    requested_promotion_type: kind === "write" ? "future_write_candidate" : "read_only_candidate",
    readiness_status: decision.readiness_status,
    risk_level: decision.risk_level,
    approval_required: kind === "write",
    approval_reason: kind === "write" ? "write_classified_node" : undefined,
    requested_scope: scope,
    required_locks: scope.required_locks,
    required_context_refs: scope.required_context_refs,
    required_prompt_template_ref: scope.required_prompt_template_ref,
    required_validation_strategy: scope.required_validation_strategy,
    required_success_criteria: scope.required_success_criteria,
    required_review_policy: scope.required_review_policy,
    status: kind === "write" ? "awaiting_human_approval" : "requested",
    metadata_json: {
      title: kind === "write" ? "Update runtime" : "Review runtime",
      objective: kind === "write" ? "Prepare to update src/runtime.ts safely." : "Prepare to review runtime context."
    }
  });
  const approval = options.skipApproval ? undefined : createHumanApprovalRecord({
    approval_id: `approval_${runId}_${suffix}`,
    promotion_request_id: request.promotion_request_id,
    run_id: runId,
    proposed_node_id: request.proposed_node_id,
    approver_type: "test_fixture",
    decision: options.approvalDecision ?? "approved",
    decision_reason: "Scoped approval for preparation.",
    approved_scope: scope,
    constraints: [],
    expires_at: options.approvalDecision === "expired" ? "2000-01-01T00:00:00.000Z" : undefined
  });
  const queueItem = createPromotionQueueItem({
    queue_item_id: `queue_${runId}_${suffix}`,
    promotion_request_id: request.promotion_request_id,
    approval_id: approval?.approval_id,
    run_id: runId,
    proposed_node_id: request.proposed_node_id,
    queue_status: kind === "write" ? "ready_for_future_execution_gate" : "queued",
    promotion_type: request.requested_promotion_type,
    priority: kind === "write" ? 5 : 3,
    blockers: [],
    constraints: []
  });
  const node = createProposedTaskGraphNode({
    proposed_node_id: request.proposed_node_id,
    run_id: runId,
    team_id: request.team_id,
    adopted_task_id: request.adopted_task_id,
    title: String(request.metadata_json.title),
    objective: String(request.metadata_json.objective),
    task_type: request.task_type,
    read_or_write_classification: request.read_or_write_classification,
    proposed_role: request.proposed_role,
    status: kind === "write" ? "future_write_candidate" : "read_only_ready",
    readiness_status: kind === "write" ? "future_write_candidate" : "read_only_ready",
    adoption_status: "adopted_read_only",
    allowed_files: scope.allowed_files,
    forbidden_files: scope.forbidden_files,
    read_only_files: scope.read_only_files,
    module_locks: ["module:src"],
    semantic_locks: kind === "write" ? ["semantic:runtime"] : [],
    dependencies: [],
    validation_strategy: { strategy_id: `validation_${runId}_${suffix}`, status: "planned", commands: scope.required_validation_strategy, required_checks: [], artifact_refs: [], notes: [], metadata_json: {} },
    success_criteria: scope.required_success_criteria,
    stop_conditions: ["Stop if approval, locks, validation, review, or integration preview is missing."],
    prompt_template_ref: scope.required_prompt_template_ref,
    context_pack_ref: "context_pack",
    evidence_refs: [],
    risk_level: request.risk_level,
    non_executable_reason: "Preparation test node."
  });
  const metadata = new FactoryMetadataAdapter(workspace);
  await metadata.recordExecutionReadinessDecisionSaved(decision);
  await metadata.recordExecutionPromotionRequestSaved(request);
  if (approval) await metadata.recordHumanApprovalRecordSaved(approval);
  await metadata.recordPromotionQueueItemSaved(queueItem);
  if (!options.skipNode) await metadata.recordProposedTaskNodeSaved("graph_test", node);
  return { request, approval, queueItem, node };
}

function config(overrides: Parameters<typeof loadOrchestrationConfig>[0] = {}) {
  return loadOrchestrationConfig({
    memory_path: ".agent_memory",
    execution_readiness_gate_enabled: true,
    enable_execution_promotion_queue: true,
    promotion_queue_mode: "queue_candidates",
    enable_execution_preparation: true,
    execution_preparation_mode: "prepare_only",
    allow_test_fixture_approvals: true,
    ...overrides
  });
}

async function fixtureWorkspace(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeJson(path.join(root, "package.json"), {
    name: prefix,
    scripts: {
      test: "node -e \"process.exit(0)\"",
      build: "node -e \"process.exit(0)\"",
      typecheck: "tsc --noEmit"
    }
  });
  await writeFile(path.join(root, "package-lock.json"), "{}\n", "utf8");
  await writeFile(path.join(root, "src", "runtime.ts"), "export const runtime = 1;\n", "utf8");
  await writeFile(path.join(root, "src", "review.ts"), "export const review = 1;\n", "utf8");
  await writeFile(path.join(root, "README.md"), "fixture workspace\n", "utf8");
  return root;
}
