import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeJson } from "../memory/ProjectMemory.js";
import {
  CoreOrchestrator,
  FactoryMetadataStore,
  ORCHESTRATION_SCHEMA_VERSION,
  OrchestrationArtifactStore,
  ProposedTaskGraphManager,
  createAdoptedTaskProposal,
  createProposedTaskGraph,
  createProposedTaskGraphEdge,
  createProposedTaskGraphNode,
  createProposedTaskGraphValidationResult,
  loadOrchestrationConfig,
  reconstructFactoryRunTrace,
  type AdoptedTaskProposal,
  type AgentRoleName,
  type Run,
  type Task
} from "../orchestration/index.js";
import { TaskGraphManager } from "../orchestration/TaskGraphManager.js";
import { ScriptedProvider } from "./fixtures/ScriptedProvider.js";

test("proposed task graph models create graph node edge and validation summary", () => {
  const node = createProposedTaskGraphNode({
    run_id: "run_model",
    team_id: "team_model",
    title: "Inspect runtime",
    objective: "Inspect runtime safely.",
    task_type: "review",
    read_or_write_classification: "read_only",
    proposed_role: "ReviewerAgent",
    status: "read_only_ready",
    readiness_status: "read_only_ready",
    adoption_status: "adopted_read_only",
    allowed_files: [],
    forbidden_files: [".env"],
    read_only_files: ["src/runtime.ts"],
    module_locks: [],
    semantic_locks: [],
    dependencies: [],
    success_criteria: ["understand"],
    stop_conditions: [],
    evidence_refs: [],
    risk_level: "low",
    non_executable_reason: "not executable"
  });
  const edge = createProposedTaskGraphEdge({
    run_id: "run_model",
    source_node_id: node.proposed_node_id,
    target_node_id: "target",
    edge_type: "related_to",
    reason: "model test"
  });
  const graph = createProposedTaskGraph({ run_id: "run_model", status: "created", nodes: [node], edges: [edge] });
  const validation = createProposedTaskGraphValidationResult({
    run_id: graph.run_id,
    graph_id: graph.graph_id,
    valid: true,
    cycle_count: 0,
    duplicate_count: 0,
    scope_overlap_count: 0,
    blocked_node_count: 0,
    warnings: [],
    cycles: [],
    duplicate_groups: [],
    scope_overlaps: []
  });
  assert.equal(graph.nodes[0].status, "read_only_ready");
  assert.equal(edge.edge_type, "related_to");
  assert.equal(JSON.parse(JSON.stringify(validation)).valid, true);
});

test("ProposedTaskGraphManager imports adopted proposals as non-executable nodes and persists refs only", async () => {
  const workspace = await fixtureWorkspace("proposed-task-graph-import");
  try {
    const store = new OrchestrationArtifactStore(workspace);
    const manager = new ProposedTaskGraphManager({ workspacePath: workspace, config: config({ proposed_task_graph_mode: "read_only_ready" }), artifactStore: store });
    const run = fakeRun(workspace, "run_proposed_import");
    const readOnly = proposal(run.id, "read", { classification: "read_only", readiness: "read_only_ready", adoption: "adopted_read_only" });
    const write = proposal(run.id, "write", { classification: "write_candidate", readiness: "metadata_only", adoption: "adopted_metadata_only" });
    const result = await manager.buildProposedGraphFromAdoptedTasks(run.id, { adoptedProposals: [readOnly, write], existingTasks: [] });
    assert.equal(result.skipped, false);
    assert.equal(result.graph.nodes.length, 2);
    assert.equal(result.graph.nodes.find((node) => node.adopted_task_id === readOnly.adopted_task_id)?.status, "read_only_ready");
    assert.notEqual(result.graph.nodes.find((node) => node.adopted_task_id === write.adopted_task_id)?.status, "read_only_ready");
    assert.ok(result.graph.nodes.every((node) => /not scheduled|approval gate|Metadata-only|read-only planning/i.test(node.non_executable_reason)));
    assert.ok(result.graph.summary_ref && existsSync(result.graph.summary_ref));

    const metadata = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.equal(metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_proposed_task_graphs WHERE run_id = ?", run.id)?.count, 1);
      assert.equal(metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_proposed_task_nodes WHERE run_id = ?", run.id)?.count, 2);
      assert.equal(metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_proposed_task_graph_validations WHERE run_id = ?", run.id)?.count, 1);
      const row = metadata.get<{ metadata_json: string }>("SELECT metadata_json FROM factory_proposed_task_nodes WHERE run_id = ? LIMIT 1", run.id);
      assert.doesNotMatch(row?.metadata_json ?? "", /diff --git/);
    } finally {
      metadata.close();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("ProposedTaskGraphManager produces skipped graph when no adopted proposals exist", async () => {
  const workspace = await fixtureWorkspace("proposed-task-graph-empty");
  try {
    const result = await new ProposedTaskGraphManager({ workspacePath: workspace, config: config() }).buildProposedGraphFromAdoptedTasks("run_empty", { adoptedProposals: [] });
    assert.equal(result.skipped, true);
    assert.equal(result.graph.status, "not_required");
    assert.equal(result.graph.nodes.length, 0);
    assert.ok(result.summary.graph_summary_ref);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("ProposedTaskGraphManager creates dependency edges detects cycles duplicates scope overlaps and blocks cycles", async () => {
  const workspace = await fixtureWorkspace("proposed-task-graph-validation");
  try {
    const manager = new ProposedTaskGraphManager({ workspacePath: workspace, config: config({ proposed_task_graph_mode: "read_only_ready" }) });
    const runId = "run_proposed_validation";
    const first = proposal(runId, "a", {
      title: "Shared title",
      objective: "Shared objective",
      dependencies: ["adopted_b"],
      classification: "read_only",
      readiness: "read_only_ready",
      adoption: "adopted_read_only"
    });
    const second = proposal(runId, "b", {
      adoptedId: "adopted_b",
      title: "Shared title",
      objective: "Shared objective",
      dependencies: [first.adopted_task_id],
      classification: "read_only",
      readiness: "read_only_ready",
      adoption: "adopted_read_only"
    });
    const result = await manager.buildProposedGraphFromAdoptedTasks(runId, { adoptedProposals: [first, second] });
    assert.ok(result.graph.edges.some((edge) => edge.edge_type === "depends_on"));
    assert.ok(result.graph.edges.some((edge) => edge.edge_type === "duplicates"));
    assert.ok(result.graph.edges.some((edge) => edge.edge_type === "shares_scope_with" || edge.edge_type === "requires_same_lock"));
    assert.ok(result.validation.cycle_count >= 1);
    assert.ok(result.graph.nodes.some((node) => node.status === "blocked"));

    const trace = await reconstructFactoryRunTrace({ workspacePath: workspace, runId });
    const events = new Set(trace.events.map((event) => event.event_type));
    assert.ok(events.has("proposed_task_graph_build_started"));
    assert.ok(events.has("proposed_task_graph_node_created"));
    assert.ok(events.has("proposed_task_graph_edge_created"));
    assert.ok(events.has("proposed_task_graph_duplicate_detected"));
    assert.ok(events.has("proposed_task_graph_scope_overlap_detected"));
    assert.ok(events.has("proposed_task_graph_cycle_detected"));
    assert.ok(events.has("proposed_task_graph_persisted"));
    assert.ok(events.has("proposed_task_graph_summary_created"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("proposed graph leaves execution task queue and lock state untouched", async () => {
  const workspace = await fixtureWorkspace("proposed-task-graph-safety");
  try {
    const run = fakeRun(workspace, "run_proposed_safety");
    const artifactStore = new OrchestrationArtifactStore(workspace);
    const taskGraph = new TaskGraphManager(run.id, workspace, artifactStore);
    taskGraph.createTask(fakeTask(run.id, "task_existing"));
    const beforeReady = taskGraph.getReadyTasks().map((task) => task.id);
    const manager = new ProposedTaskGraphManager({ workspacePath: workspace, config: config(), artifactStore });
    const result = await manager.buildProposedGraphFromAdoptedTasks(run.id, {
      adoptedProposals: [proposal(run.id, "write", { classification: "write_candidate", readiness: "future_write_candidate", adoption: "ready_for_future_gate" })],
      existingTasks: taskGraph.listTasks()
    });
    const afterReady = taskGraph.getReadyTasks().map((task) => task.id);
    assert.deepEqual(afterReady, beforeReady);
    assert.equal(result.graph.nodes.some((node) => node.readiness_status === "executable_ready"), false);
    assert.equal(result.graph.nodes.some((node) => node.status === "read_only_ready" && node.read_or_write_classification !== "read_only"), false);
    const metadata = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.equal(metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_locks WHERE run_id = ?", run.id)?.count ?? 0, 0);
    } finally {
      metadata.close();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("CoreOrchestrator plan-only run builds proposed graph without ready executor tasks", async () => {
  const workspace = await fixtureWorkspace("proposed-task-graph-core");
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
        proposed_task_graph_mode: "metadata_only"
      }
    }).planOnly("Plan a medium recursive planning graph change across src/runtime.ts and src/review.ts without editing files.");
    assert.equal(result.run.status, "succeeded");
    assert.equal(result.report.proposed_task_graph_used, true);
    assert.ok((result.report.proposed_node_count ?? 0) >= 1);
    assert.equal(result.tasks.some((task) => task.status === "ready" || task.status === "running"), false);
    assert.ok(result.report.graph_summary_ref && existsSync(result.report.graph_summary_ref));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function proposal(runId: string, id: string, options: Partial<{
  adoptedId: string;
  title: string;
  objective: string;
  classification: "read_only" | "write_candidate";
  readiness: "metadata_only" | "read_only_ready" | "future_write_candidate";
  adoption: "adopted_metadata_only" | "adopted_read_only" | "ready_for_future_gate";
  dependencies: string[];
}> = {}): AdoptedTaskProposal {
  const classification = options.classification ?? "read_only";
  return createAdoptedTaskProposal({
    adopted_task_id: options.adoptedId ?? `adopted_${id}`,
    run_id: runId,
    team_id: id === "b" ? "team_sibling" : "team_runtime",
    sub_plan_id: `sub_${id}`,
    source_task_draft_id: `draft_${id}`,
    title: options.title ?? `${classification} proposal ${id}`,
    objective: options.objective ?? `Safely represent ${id}.`,
    task_type: "review",
    read_or_write_classification: classification,
    proposed_role: classification === "read_only" ? "ReviewerAgent" : "ExecutorAgent",
    allowed_files: classification === "read_only" ? [] : ["src/runtime.ts"],
    forbidden_files: [".env"],
    read_only_files: ["src/runtime.ts"],
    module_locks: ["module:runtime"],
    semantic_locks: ["semantic:runtime"],
    dependencies: options.dependencies ?? [],
    validation_strategy: {
      strategy_id: `validation_${id}`,
      status: "planned",
      commands: classification === "read_only" ? [] : ["git diff --check"],
      required_checks: classification === "read_only" ? [] : ["git diff --check"],
      artifact_refs: [],
      notes: [],
      metadata_json: {}
    },
    success_criteria: ["Criterion"],
    stop_conditions: classification === "read_only" ? [] : ["Stop if unsafe."],
    prompt_template_ref: "role_prompt:ReviewerAgent",
    context_pack_ref: "context_pack_ref",
    evidence_refs: ["evidence_ref"],
    risk_level: classification === "read_only" ? "low" : "medium",
    readiness_status: options.readiness ?? (classification === "read_only" ? "read_only_ready" : "metadata_only"),
    adoption_status: options.adoption ?? (classification === "read_only" ? "adopted_read_only" : "adopted_metadata_only")
  });
}

function config(overrides: Parameters<typeof loadOrchestrationConfig>[0] = {}) {
  return loadOrchestrationConfig({
    memory_path: ".agent_memory",
    enable_team_task_adoption: true,
    enable_proposed_task_graph: true,
    proposed_task_graph_mode: "metadata_only",
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
    user_request: "Build proposed graph.",
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
