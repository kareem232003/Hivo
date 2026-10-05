import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeJson } from "../memory/ProjectMemory.js";
import {
  CoreOrchestrator,
  ExecutionApprovalManager,
  ExecutionPromotionQueue,
  FactoryMetadataStore,
  ORCHESTRATION_SCHEMA_VERSION,
  OrchestrationArtifactStore,
  createApprovalConstraint,
  createApprovalScope,
  createExecutionPromotionRequest,
  createExecutionReadinessDecision,
  createHumanApprovalRecord,
  createPromotionQueueItem,
  loadOrchestrationConfig,
  reconstructFactoryRunTrace,
  type AgentRoleName,
  type ExecutionReadinessDecision,
  type Run,
  type Task
} from "../orchestration/index.js";
import { TaskGraphManager } from "../orchestration/TaskGraphManager.js";
import { ScriptedProvider } from "./fixtures/ScriptedProvider.js";

test("execution approval models create requests approval records queue items and constraints", () => {
  const scope = createApprovalScope({ allowed_files: ["src/runtime.ts"], forbidden_files: [".env"], required_locks: ["module:src"] });
  const request = createExecutionPromotionRequest({
    run_id: "run_model",
    proposed_node_id: "node_model",
    readiness_decision_id: "decision_model",
    task_type: "domain",
    read_or_write_classification: "write_candidate",
    proposed_role: "ExecutorAgent",
    requested_promotion_type: "future_write_candidate",
    readiness_status: "future_write_candidate",
    risk_level: "medium",
    approval_required: true,
    approval_reason: "write_classified_node",
    requested_scope: scope,
    required_locks: ["module:src"],
    required_context_refs: ["context"],
    required_prompt_template_ref: "role_prompt:ExecutorAgent",
    required_validation_strategy: ["npm test"],
    required_success_criteria: ["Done"],
    required_review_policy: ["IntegrationManager"],
    status: "awaiting_human_approval"
  });
  const constraint = createApprovalConstraint({ constraint_type: "locks_preserved", description: "locks", refs: ["module:src"], status: "satisfied" });
  const approval = createHumanApprovalRecord({
    promotion_request_id: request.promotion_request_id,
    run_id: request.run_id,
    proposed_node_id: request.proposed_node_id,
    approver_type: "human",
    decision: "approved",
    decision_reason: "Scoped approval.",
    approved_scope: scope,
    constraints: [constraint]
  });
  const item = createPromotionQueueItem({
    promotion_request_id: request.promotion_request_id,
    approval_id: approval.approval_id,
    run_id: request.run_id,
    proposed_node_id: request.proposed_node_id,
    queue_status: "ready_for_future_execution_gate",
    promotion_type: "future_write_candidate",
    priority: 5,
    blockers: [],
    constraints: [constraint]
  });
  assert.equal(request.status, "awaiting_human_approval");
  assert.equal(approval.approval_status, "approved");
  assert.equal(item.queue_status, "ready_for_future_execution_gate");
  assert.doesNotMatch(JSON.stringify(item), /executing/);
});

test("promotion request creation queues low-risk read-only candidates without execution", async () => {
  const workspace = await fixtureWorkspace("execution-approval-readonly");
  try {
    const manager = new ExecutionApprovalManager({ workspacePath: workspace, config: config({ promotion_queue_mode: "queue_candidates" }), artifactStore: new OrchestrationArtifactStore(workspace) });
    const request = await manager.createPromotionRequestFromReadinessDecision(readOnlyDecision("run_readonly", "read"));
    assert.ok(request);
    assert.equal(request.approval_required, false);
    const summary = await manager.createPromotionRequestsFromReadinessBatch({
      batch_id: "batch_readonly",
      run_id: "run_readonly",
      request: {
        request_id: "req",
        run_id: "run_readonly",
        proposed_node_ids: ["node"],
        policy: {
          mode: "report_only",
          allow_read_only_promotion_candidates: true,
          allow_write_future_candidates: true,
          require_human_approval_for_write: true,
          allow_auto_approval_for_low_risk_read_only: true,
          max_nodes_evaluated_per_run: 10,
          metadata_json: {}
        },
        requested_by: "test",
        metadata_json: {},
        created_at: new Date().toISOString()
      },
      decisions: [readOnlyDecision("run_readonly", "batch")],
      approval_requirements: [],
      summary: {
        summary_id: "summary",
        run_id: "run_readonly",
        nodes_evaluated: 1,
        ready_read_only_count: 1,
        future_write_candidate_count: 0,
        requires_human_approval_count: 0,
        blocked_count: 0,
        rejected_count: 0,
        requires_context_count: 0,
        requires_validation_count: 0,
        requires_locks_count: 0,
        metadata_json: {},
        created_at: new Date().toISOString()
      },
      metadata_json: {},
      created_at: new Date().toISOString()
    });
    assert.equal(summary.summary.queue_items_created, 1);
    const metadata = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.equal(metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_execution_promotion_requests WHERE run_id = ?", "run_readonly")?.count, 2);
      assert.equal(metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_human_approval_records WHERE run_id = ? AND approver_type = 'system_policy'", "run_readonly")?.count, 1);
      assert.equal(metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_promotion_queue_items WHERE run_id = ?", "run_readonly")?.count, 1);
      assert.equal(metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_locks WHERE run_id = ?", "run_readonly")?.count ?? 0, 0);
      assert.equal(metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_validations WHERE run_id = ?", "run_readonly")?.count ?? 0, 0);
    } finally {
      metadata.close();
    }
    assert.ok(summary.summary.promotion_queue_summary_ref && existsSync(summary.summary.promotion_queue_summary_ref));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("write promotion requests require scoped human approval and reject broader approval", async () => {
  const workspace = await fixtureWorkspace("execution-approval-write");
  try {
    const manager = new ExecutionApprovalManager({ workspacePath: workspace, config: config({ promotion_queue_mode: "queue_candidates", allow_test_fixture_approvals: true }), artifactStore: new OrchestrationArtifactStore(workspace) });
    const request = await manager.createPromotionRequestFromReadinessDecision(writeDecision("run_write", "write"));
    assert.ok(request);
    assert.equal(request.status, "awaiting_human_approval");
    assert.equal(request.approval_required, true);

    const broad = await manager.recordHumanApproval(request.promotion_request_id, {
      approver_type: "test_fixture",
      decision_reason: "Too broad.",
      approved_scope: createApprovalScope({
        ...request.requested_scope,
        allowed_files: ["src/runtime.ts", "src/other.ts"]
      })
    });
    assert.equal(broad.approval_status, "invalid");

    const scoped = await manager.recordHumanApproval(request.promotion_request_id, {
      approver_type: "test_fixture",
      decision_reason: "Scoped approval.",
      approved_scope: request.requested_scope
    });
    assert.equal(scoped.approval_status, "approved");

    const denied = await manager.denyApproval(request.promotion_request_id, "Operator denied.");
    assert.equal(denied.approval_status, "denied");

    const metadata = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.equal(metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_approval_scope_constraints WHERE run_id = ? AND status = 'violated'", "run_write")?.count, 1);
      assert.ok((metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_promotion_queue_items WHERE run_id = ?", "run_write")?.count ?? 0) >= 2);
      assert.equal(metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_locks WHERE run_id = ?", "run_write")?.count ?? 0, 0);
    } finally {
      metadata.close();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("promotion queue validates non-executing queue items and does not alter executable graph", async () => {
  const workspace = await fixtureWorkspace("execution-approval-queue");
  try {
    const run = fakeRun(workspace, "run_queue");
    const artifactStore = new OrchestrationArtifactStore(workspace);
    const graph = new TaskGraphManager(run.id, workspace, artifactStore);
    graph.createTask(fakeTask(run.id, "task_existing"));
    const before = graph.getReadyTasks().map((task) => task.id);
    const queue = new ExecutionPromotionQueue({ workspacePath: workspace, config: config({ promotion_queue_mode: "queue_candidates" }), artifactStore });
    const request = createExecutionPromotionRequest({
      run_id: run.id,
      proposed_node_id: "node_queue",
      readiness_decision_id: "decision_queue",
      task_type: "review",
      read_or_write_classification: "read_only",
      proposed_role: "ReviewerAgent",
      requested_promotion_type: "read_only_candidate",
      readiness_status: "ready_read_only",
      risk_level: "low",
      approval_required: false,
      requested_scope: createApprovalScope({ read_only_files: ["src/review.ts"], required_context_refs: ["context"], required_prompt_template_ref: "role_prompt:ReviewerAgent" }),
      required_locks: [],
      required_context_refs: ["context"],
      required_prompt_template_ref: "role_prompt:ReviewerAgent",
      required_validation_strategy: [],
      required_success_criteria: ["Report findings."],
      required_review_policy: [],
      status: "requested"
    });
    const item = await queue.enqueueReadOnlyPromotionCandidate(request);
    assert.equal(item.queue_status, "queued");
    assert.equal(queue.validatePromotionQueueItem(item).valid, true);
    assert.deepEqual(graph.getReadyTasks().map((task) => task.id), before);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("CoreOrchestrator readiness batch creates promotion requests and report metadata without execution", async () => {
  const workspace = await fixtureWorkspace("execution-approval-core");
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
        enable_team_task_adoption: true,
        enable_proposed_task_graph: true,
        execution_readiness_gate_enabled: true,
        execution_readiness_mode: "report_only",
        enable_execution_promotion_queue: true,
        promotion_queue_mode: "approval_records",
        track_blocked_promotion_requests: true
      }
    }).planOnly("Plan a medium approval promotion queue change across src/runtime.ts and src/review.ts without editing files.");
    assert.equal(result.run.status, "succeeded");
    assert.ok((result.report.promotion_requests_created ?? 0) >= 1);
    assert.equal(result.tasks.some((task) => task.status === "ready" || task.status === "running"), false);
    assert.ok(result.report.promotion_queue_summary_ref && existsSync(result.report.promotion_queue_summary_ref));

    const trace = await reconstructFactoryRunTrace({ workspacePath: workspace, runId: result.run.id });
    const events = new Set(trace.events.map((event) => event.event_type));
    assert.ok(events.has("execution_promotion_request_created") || events.has("execution_promotion_request_blocked"));
    assert.ok(events.has("promotion_queue_summary_created"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function readOnlyDecision(runId: string, id: string): ExecutionReadinessDecision {
  return createExecutionReadinessDecision({
    decision_id: `decision_${id}`,
    run_id: runId,
    proposed_node_id: `node_${id}`,
    team_id: "team_read",
    adopted_task_id: `adopted_${id}`,
    task_type: "review",
    read_or_write_classification: "read_only",
    proposed_role: "ReviewerAgent",
    readiness_status: "ready_read_only",
    approval_status: "read_only_candidate",
    requirements_checked: [],
    passed_requirements: [],
    failed_requirements: [],
    blockers: [],
    warnings: [],
    required_locks: [],
    required_context_refs: ["context_pack"],
    required_prompt_template_ref: "role_prompt:ReviewerAgent",
    required_validation_strategy: [],
    required_success_criteria: ["Report findings."],
    required_review_policy: [],
    risk_level: "low",
    confidence: 0.95,
    metadata_json: {
      allowed_files: [],
      forbidden_files: [".env"],
      read_only_files: ["src/review.ts"]
    }
  });
}

function writeDecision(runId: string, id: string): ExecutionReadinessDecision {
  return createExecutionReadinessDecision({
    decision_id: `decision_${id}`,
    run_id: runId,
    proposed_node_id: `node_${id}`,
    team_id: "team_write",
    adopted_task_id: `adopted_${id}`,
    task_type: "domain",
    read_or_write_classification: "write_candidate",
    proposed_role: "ExecutorAgent",
    readiness_status: "future_write_candidate",
    approval_status: "human_approval_required",
    requirements_checked: [],
    passed_requirements: [],
    failed_requirements: [],
    blockers: [],
    warnings: [],
    human_approval_reason: "Human approval required: write_classified_node.",
    required_locks: ["module:src", "semantic:runtime"],
    required_context_refs: ["context_pack"],
    required_prompt_template_ref: "role_prompt:ExecutorAgent",
    required_validation_strategy: ["npm test"],
    required_success_criteria: ["Runtime behavior updated."],
    required_review_policy: ["review_required_before_integration", "prompt_quality_gate_required", "integration_manager_required"],
    risk_level: "medium",
    confidence: 0.8,
    metadata_json: {
      allowed_files: ["src/runtime.ts"],
      forbidden_files: [".env"],
      read_only_files: ["src/runtime.ts"]
    }
  });
}

function config(overrides: Parameters<typeof loadOrchestrationConfig>[0] = {}) {
  return loadOrchestrationConfig({
    memory_path: ".agent_memory",
    execution_readiness_gate_enabled: true,
    enable_execution_promotion_queue: true,
    promotion_queue_mode: "approval_records",
    ...overrides
  });
}

function fakeTask(runId: string, id: string): Task {
  const now = new Date().toISOString();
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id,
    run_id: runId,
    title: "Existing task",
    objective: "Existing objective",
    role_required: "PlannerAgent" as AgentRoleName,
    status: "pending",
    dependencies: [],
    relevant_files: [],
    allowed_files_to_edit: [],
    forbidden_files: [],
    expected_output_schema: "ParsedAgentOutput",
    validation_commands: [],
    max_attempts: 1,
    attempt_count: 0,
    artifacts: [],
    created_at: now,
    updated_at: now
  };
}

function fakeRun(workspace: string, id: string): Run {
  const now = new Date().toISOString();
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id,
    user_request: "Evaluate promotion queue.",
    status: "planning",
    created_at: now,
    updated_at: now,
    root_task_ids: [],
    memory_snapshot_ref: "memory",
    config: {
      workspace_path: workspace,
      memory_dir: ".agent_memory",
      max_context_files: 6,
      max_context_chars: 12000,
      max_task_attempts: 1,
      provider_mode: "real_provider"
    },
    artifacts_path: path.join(workspace, ".agent_memory", "runs", id)
  };
}

async function fixtureWorkspace(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeJson(path.join(root, "package.json"), {
    name: prefix,
    scripts: {
      test: "node -e \"process.exit(0)\"",
      build: "node -e \"process.exit(0)\""
    }
  });
  await writeFile(path.join(root, "package-lock.json"), "{}\n", "utf8");
  await writeFile(path.join(root, "src", "runtime.ts"), "export const runtime = 1;\n", "utf8");
  await writeFile(path.join(root, "src", "review.ts"), "export const review = 1;\n", "utf8");
  return root;
}
