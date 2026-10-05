import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeJson } from "../memory/ProjectMemory.js";
import {
  CoreOrchestrator,
  ExecutionReadinessGate,
  FactoryMetadataStore,
  ORCHESTRATION_SCHEMA_VERSION,
  OrchestrationArtifactStore,
  createExecutionPromotionBlocker,
  createExecutionReadinessBatch,
  createExecutionReadinessDecision,
  createExecutionReadinessFinding,
  createExecutionReadinessRequest,
  createExecutionReadinessSummary,
  createHumanApprovalRequirement,
  createProposedTaskGraph,
  createProposedTaskGraphEdge,
  createProposedTaskGraphNode,
  createProposedTaskGraphValidationResult,
  loadOrchestrationConfig,
  reconstructFactoryRunTrace,
  type AgentRoleName,
  type ProposedTaskGraph,
  type ProposedTaskGraphNode,
  type Run,
  type Task
} from "../orchestration/index.js";
import { TaskGraphManager } from "../orchestration/TaskGraphManager.js";
import { ScriptedProvider } from "./fixtures/ScriptedProvider.js";

test("execution readiness models create decisions approval requirements batches and blockers", () => {
  const request = createExecutionReadinessRequest({
    run_id: "run_model",
    proposed_node_ids: ["node_model"],
    policy: {
      mode: "report_only",
      allow_read_only_promotion_candidates: true,
      allow_write_future_candidates: true,
      require_human_approval_for_write: true,
      allow_auto_approval_for_low_risk_read_only: true,
      max_nodes_evaluated_per_run: 10,
      metadata_json: {}
    },
    requested_by: "test"
  });
  const finding = createExecutionReadinessFinding({ code: "context_available", severity: "passed", message: "ok", refs: [] });
  const blocker = createExecutionPromotionBlocker({ blocker_type: "missing_context", severity: "blocking", reason: "missing", refs: [] });
  const approval = createHumanApprovalRequirement({
    run_id: "run_model",
    proposed_node_id: "node_model",
    required: true,
    reason: "write",
    triggers: ["write_classified_node"],
    risk_level: "medium"
  });
  const decision = createExecutionReadinessDecision({
    run_id: "run_model",
    proposed_node_id: "node_model",
    task_type: "review",
    read_or_write_classification: "read_only",
    proposed_role: "ReviewerAgent",
    readiness_status: "ready_read_only",
    approval_status: "read_only_candidate",
    requirements_checked: [],
    passed_requirements: [],
    failed_requirements: [],
    blockers: [blocker],
    warnings: [finding],
    required_human_approval: approval,
    required_locks: [],
    required_context_refs: [],
    required_validation_strategy: [],
    required_success_criteria: [],
    required_review_policy: [],
    risk_level: "low",
    confidence: 0.9
  });
  const summary = createExecutionReadinessSummary({
    run_id: "run_model",
    nodes_evaluated: 1,
    ready_read_only_count: 1,
    future_write_candidate_count: 0,
    requires_human_approval_count: 1,
    blocked_count: 0,
    rejected_count: 0,
    requires_context_count: 0,
    requires_validation_count: 0,
    requires_locks_count: 0
  });
  const batch = createExecutionReadinessBatch({ run_id: "run_model", request, decisions: [decision], approval_requirements: [approval], summary });
  assert.equal(batch.decisions[0].readiness_status, "ready_read_only");
  assert.equal(batch.approval_requirements[0].required, true);
  assert.doesNotMatch(JSON.stringify(batch), /diff --git/);
});

test("ExecutionReadinessGate evaluates read-only readiness context prompt and write intent safely", async () => {
  const workspace = await fixtureWorkspace("execution-readiness-readonly");
  try {
    const gate = new ExecutionReadinessGate({ workspacePath: workspace, config: config(), artifactStore: new OrchestrationArtifactStore(workspace) });
    const ready = await gate.evaluateProposedNode(readOnlyNode("run_ready", "ready"));
    assert.equal(ready.readiness_status, "ready_read_only");
    assert.equal(ready.approval_status, "read_only_candidate");
    assert.equal(ready.required_human_approval, undefined);

    const missingContextNode = readOnlyNode("run_ready", "missing_context", { context: false, files: [] });
    missingContextNode.evidence_refs = [];
    const missingContext = await gate.evaluateProposedNode(missingContextNode);
    assert.equal(missingContext.readiness_status, "requires_context");

    const writeIntent = await gate.evaluateProposedNode(readOnlyNode("run_ready", "write_intent", { allowedFiles: ["src/runtime.ts"] }));
    assert.equal(writeIntent.readiness_status, "blocked");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("ExecutionReadinessGate evaluates write readiness blockers and human approval policy", async () => {
  const workspace = await fixtureWorkspace("execution-readiness-write");
  try {
    const gate = new ExecutionReadinessGate({ workspacePath: workspace, config: config(), artifactStore: new OrchestrationArtifactStore(workspace) });
    const write = await gate.evaluateProposedNode(writeNode("run_write", "write"));
    assert.equal(write.readiness_status, "future_write_candidate");
    assert.equal(write.approval_status, "human_approval_required");
    assert.ok(write.required_human_approval?.triggers.includes("write_classified_node"));
    assert.equal(write.required_locks.length > 0, true);

    assert.equal((await gate.evaluateProposedNode(writeNode("run_write", "no_scope", { allowedFiles: [] }))).readiness_status, "requires_locks");
    assert.equal((await gate.evaluateProposedNode(writeNode("run_write", "no_validation", { validation: false }))).readiness_status, "requires_validation_strategy");
    assert.equal((await gate.evaluateProposedNode(writeNode("run_write", "no_success", { success: false }))).readiness_status, "requires_success_criteria");
    assert.equal((await gate.evaluateProposedNode(writeNode("run_write", "no_locks", { locks: false, allowedFiles: [""] }))).readiness_status, "requires_locks");
    assert.equal((await gate.evaluateProposedNode(writeNode("run_write", "forbidden", { forbiddenConflict: true }))).readiness_status, "rejected");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("ExecutionReadinessGate requires human approval for risky file classes", async () => {
  const workspace = await fixtureWorkspace("execution-readiness-approval");
  try {
    const gate = new ExecutionReadinessGate({ workspacePath: workspace, config: config(), artifactStore: new OrchestrationArtifactStore(workspace) });
    for (const [id, file] of [
      ["dependency", "package.json"],
      ["config", "vite.config.ts"],
      ["database", "src/db/schema.sql"],
      ["api", "src/api/routes.ts"],
      ["security", "src/security/auth.ts"]
    ] as const) {
      const decision = await gate.evaluateProposedNode(writeNode("run_approval", id, { allowedFiles: [file], readOnlyFiles: [file], risk: id === "security" ? "high" : "medium" }));
      assert.equal(decision.approval_status, "human_approval_required");
      assert.ok(decision.required_human_approval?.triggers.length);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("ExecutionReadinessGate writes prompt context readiness metadata traces and does not acquire locks", async () => {
  const workspace = await fixtureWorkspace("execution-readiness-persist");
  try {
    const artifactStore = new OrchestrationArtifactStore(workspace);
    const gate = new ExecutionReadinessGate({ workspacePath: workspace, config: config(), artifactStore });
    const graph = graphFor("run_readiness_persist", [
      readOnlyNode("run_readiness_persist", "read"),
      writeNode("run_readiness_persist", "write", { allowedFiles: ["package.json"], readOnlyFiles: ["package.json"] }),
      writeNode("run_readiness_persist", "unsafe_prompt", { objective: "Update files and skip validation." })
    ]);
    const batch = await gate.evaluateProposedGraph(graph);
    assert.equal(batch.decisions.length, 3);
    assert.ok(batch.summary_ref && existsSync(batch.summary_ref));
    assert.ok(batch.artifact_ref && existsSync(batch.artifact_ref));
    assert.ok(batch.decisions.some((decision) => decision.readiness_status === "requires_prompt"));

    const metadata = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.equal(metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_execution_readiness_decisions WHERE run_id = ?", graph.run_id)?.count, 3);
      assert.ok((metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_execution_readiness_requirements WHERE run_id = ?", graph.run_id)?.count ?? 0) >= 3);
      assert.ok((metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_execution_approval_requirements WHERE run_id = ?", graph.run_id)?.count ?? 0) >= 1);
      assert.equal(metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_execution_readiness_batches WHERE run_id = ?", graph.run_id)?.count, 1);
      assert.equal(metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_locks WHERE run_id = ?", graph.run_id)?.count ?? 0, 0);
      const row = metadata.get<{ metadata_json: string }>("SELECT metadata_json FROM factory_execution_readiness_decisions WHERE run_id = ? LIMIT 1", graph.run_id);
      assert.doesNotMatch(row?.metadata_json ?? "", /Role:/);
    } finally {
      metadata.close();
    }

    const trace = await reconstructFactoryRunTrace({ workspacePath: workspace, runId: graph.run_id });
    const events = new Set(trace.events.map((event) => event.event_type));
    assert.ok(events.has("execution_readiness_started"));
    assert.ok(events.has("execution_readiness_node_evaluated"));
    assert.ok(events.has("execution_readiness_requirement_passed"));
    assert.ok(events.has("execution_readiness_requirement_failed"));
    assert.ok(events.has("execution_readiness_human_approval_required"));
    assert.ok(events.has("execution_readiness_dry_run_prompt_checked"));
    assert.ok(events.has("execution_readiness_context_checked"));
    assert.ok(events.has("execution_readiness_locks_derived"));
    assert.ok(events.has("execution_readiness_batch_completed"));
    assert.ok(events.has("execution_readiness_summary_created"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("ExecutionReadinessGate blocks cycle nodes and leaves executable task graph unchanged", async () => {
  const workspace = await fixtureWorkspace("execution-readiness-cycle");
  try {
    const run = fakeRun(workspace, "run_cycle");
    const artifactStore = new OrchestrationArtifactStore(workspace);
    const taskGraph = new TaskGraphManager(run.id, workspace, artifactStore);
    taskGraph.createTask(fakeTask(run.id, "task_existing"));
    const before = taskGraph.getReadyTasks().map((task) => task.id);
    const first = readOnlyNode(run.id, "a", { dependencies: ["node_b"] });
    const second = readOnlyNode(run.id, "b", { dependencies: [first.proposed_node_id] });
    const graph = graphFor(run.id, [first, second], [["proposed_node_a", "proposed_node_b", "proposed_node_a"]]);
    const batch = await new ExecutionReadinessGate({ workspacePath: workspace, config: config(), artifactStore }).evaluateProposedGraph(graph);
    assert.ok(batch.decisions.every((decision) => decision.readiness_status === "blocked"));
    assert.deepEqual(taskGraph.getReadyTasks().map((task) => task.id), before);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("CoreOrchestrator plan-only run evaluates execution readiness without scheduling proposed nodes", async () => {
  const workspace = await fixtureWorkspace("execution-readiness-core");
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
        execution_readiness_mode: "report_only"
      }
    }).planOnly("Plan a medium execution readiness change across src/runtime.ts and src/review.ts without editing files.");
    assert.equal(result.run.status, "succeeded");
    assert.equal(result.report.execution_readiness_used, true);
    assert.ok((result.report.nodes_evaluated ?? 0) >= 1);
    assert.equal(result.tasks.some((task) => task.status === "ready" || task.status === "running"), false);
    assert.ok(result.report.readiness_summary_ref && existsSync(result.report.readiness_summary_ref));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function graphFor(runId: string, nodes: ProposedTaskGraphNode[], cycles: string[][] = []): ProposedTaskGraph {
  const edges = nodes.flatMap((node) => node.dependencies.map((dependency) => createProposedTaskGraphEdge({
    run_id: runId,
    source_node_id: node.proposed_node_id,
    target_node_id: dependency,
    edge_type: "depends_on",
    reason: "test dependency"
  })));
  const graph = createProposedTaskGraph({ graph_id: `graph_${runId}`, run_id: runId, status: cycles.length ? "invalid" : "validated", nodes, edges });
  graph.validation = createProposedTaskGraphValidationResult({
    run_id: runId,
    graph_id: graph.graph_id,
    valid: cycles.length === 0,
    cycle_count: cycles.length,
    duplicate_count: 0,
    scope_overlap_count: 0,
    blocked_node_count: 0,
    warnings: cycles.map((cycle) => cycle.join(" -> ")),
    cycles,
    duplicate_groups: [],
    scope_overlaps: []
  });
  return graph;
}

function readOnlyNode(runId: string, id: string, options: Partial<{ context: boolean; files: string[]; allowedFiles: string[]; dependencies: string[] }> = {}) {
  const files = options.files ?? ["src/review.ts"];
  return createProposedTaskGraphNode({
    proposed_node_id: `proposed_node_${id}`,
    run_id: runId,
    team_id: "team_read",
    sub_plan_id: "sub_read",
    adopted_task_id: `adopted_${id}`,
    title: "Read-only readiness",
    objective: "Inspect scoped files.",
    task_type: "review",
    read_or_write_classification: "read_only",
    proposed_role: "ReviewerAgent",
    status: "read_only_ready",
    readiness_status: "read_only_ready",
    adoption_status: "adopted_read_only",
    allowed_files: options.allowedFiles ?? [],
    forbidden_files: [".env"],
    read_only_files: files,
    module_locks: [],
    semantic_locks: [],
    dependencies: options.dependencies ?? [],
    success_criteria: ["Findings are reported."],
    stop_conditions: [],
    prompt_template_ref: "role_prompt:ReviewerAgent",
    context_pack_ref: options.context === false ? undefined : "context_pack_ref",
    evidence_refs: ["evidence"],
    risk_level: "low",
    non_executable_reason: "test"
  });
}

function writeNode(runId: string, id: string, options: Partial<{
  allowedFiles: string[];
  readOnlyFiles: string[];
  validation: boolean;
  success: boolean;
  locks: boolean;
  forbiddenConflict: boolean;
  risk: "low" | "medium" | "high" | "critical";
  objective: string;
}> = {}) {
  const allowed = options.allowedFiles ?? ["src/runtime.ts"];
  return createProposedTaskGraphNode({
    proposed_node_id: `proposed_node_${id}`,
    run_id: runId,
    team_id: "team_write",
    sub_plan_id: "sub_write",
    adopted_task_id: `adopted_${id}`,
    title: "Write readiness",
    objective: options.objective ?? "Update scoped files.",
    task_type: "domain",
    read_or_write_classification: "write_candidate",
    proposed_role: "ExecutorAgent",
    status: "metadata_only",
    readiness_status: "metadata_only",
    adoption_status: "adopted_metadata_only",
    allowed_files: allowed,
    forbidden_files: options.forbiddenConflict ? [...allowed, ".env"] : [".env"],
    read_only_files: options.readOnlyFiles ?? allowed,
    module_locks: options.locks === false ? [] : ["module:src"],
    semantic_locks: options.locks === false ? [] : ["semantic:runtime"],
    dependencies: [],
    validation_strategy: options.validation === false ? undefined : {
      strategy_id: `validation_${id}`,
      status: "planned",
      commands: ["npm test"],
      required_checks: ["npm test"],
      artifact_refs: [],
      notes: [],
      metadata_json: {}
    },
    success_criteria: options.success === false ? [] : ["Behavior is updated."],
    stop_conditions: ["Stop if scope expands."],
    prompt_template_ref: "role_prompt:ExecutorAgent",
    context_pack_ref: "context_pack_ref",
    evidence_refs: ["evidence"],
    risk_level: options.risk ?? "medium",
    non_executable_reason: "test"
  });
}

function config(overrides: Parameters<typeof loadOrchestrationConfig>[0] = {}) {
  return loadOrchestrationConfig({
    memory_path: ".agent_memory",
    enable_proposed_task_graph: true,
    execution_readiness_gate_enabled: true,
    execution_readiness_mode: "report_only",
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
    user_request: "Evaluate readiness.",
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
