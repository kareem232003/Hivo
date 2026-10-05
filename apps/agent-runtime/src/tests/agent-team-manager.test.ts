import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AgentTeamManager,
  CoreOrchestrator,
  FactoryMetadataStore,
  OrchestrationArtifactStore,
  ORCHESTRATION_SCHEMA_VERSION,
  createAgentTeam,
  inheritedBudget,
  type AgentInstance,
  type AgentTeamCreationRequest,
  type MergedPlan,
  type Run,
  type WorkItem
} from "../orchestration/index.js";
import { ScriptedProvider } from "./fixtures/ScriptedProvider.js";

test("agent team models create root domain and specialist team shapes with memory scopes", () => {
  const root = createAgentTeam({
    run_id: "run_models",
    domain: "root",
    objective: "Coordinate the run",
    team_type: "root",
    scope: { allowed_files: ["src/"], forbidden_files: [".env"], context_refs: ["ctx"], evidence_refs: ["evidence"] }
  });
  const domain = createAgentTeam({
    run_id: "run_models",
    parent_team_id: root.team_id,
    domain: "runtime",
    objective: "Runtime planning",
    team_type: "domain",
    budgets: { max_active_writers: 1 }
  });
  const review = createAgentTeam({ run_id: "run_models", parent_team_id: root.team_id, domain: "review", objective: "Review", team_type: "review" });
  const validation = createAgentTeam({ run_id: "run_models", parent_team_id: root.team_id, domain: "validation", objective: "Validate", team_type: "validation" });
  const integration = createAgentTeam({ run_id: "run_models", parent_team_id: root.team_id, domain: "integration", objective: "Integrate", team_type: "integration" });
  const memory = createAgentTeam({ run_id: "run_models", parent_team_id: root.team_id, domain: "memory", objective: "Memory", team_type: "memory" });
  assert.equal(root.memory_scope.scope_id.startsWith(`run:run_models/team:${root.team_id}`), true);
  assert.equal(domain.budgets.max_active_writers, 1);
  assert.deepEqual([review.team_type, validation.team_type, integration.team_type, memory.team_type], ["review", "validation", "integration", "memory"]);
  assert.doesNotMatch(JSON.stringify(root.metadata_json), /diff --git/);
});

test("agent team hierarchy enforces one root, depth, child count, scope, inherited forbidden files, and inactive parent rules", async () => {
  const workspace = await fixtureWorkspace("agent-team-hierarchy");
  try {
    const run = fakeRun(workspace, "run_hierarchy");
    const manager = new AgentTeamManager({ workspacePath: workspace, artifactStore: new OrchestrationArtifactStore(workspace) });
    const root = (await manager.createRootTeam(run, {
      scope: { allowed_files: ["src/"], forbidden_files: [".env", ".agent_memory/"] },
      budgets: { max_depth: 1, max_children: 1, max_active_writers: 1 }
    })).team;
    const duplicateRoot = await manager.createRootTeam(run);
    assert.equal(duplicateRoot.team.team_id, root.team_id);

    const child = await manager.createChildTeam(root.team_id, childRequest(run.id, "src/a.ts", "runtime"));
    assert.equal(child.team.status, "planned");
    assert.ok(child.team.forbidden_files.includes(".env"));

    const tooMany = await manager.createChildTeam(root.team_id, childRequest(run.id, "src/b.ts", "runtime-extra"));
    assert.equal(tooMany.team.status, "blocked");
    assert.ok(tooMany.validation.findings.some((finding) => finding.code === "child_count_exceeded"));

    const tooDeep = await manager.createChildTeam(child.team.team_id, childRequest(run.id, "src/c.ts", "runtime-deep"));
    assert.equal(tooDeep.team.status, "blocked");
    assert.ok(tooDeep.validation.findings.some((finding) => finding.code === "depth_exceeded"));

    const scopeExceeded = await manager.createTeam({
      ...childRequest(run.id, "package.json", "bad-scope"),
      parent_team_id: root.team_id,
      scope: { allowed_files: ["package.json"], forbidden_files: [".env", ".agent_memory/"] }
    });
    assert.equal(scopeExceeded.team.status, "blocked");
    assert.ok(scopeExceeded.validation.findings.some((finding) => finding.code === "allowed_scope_exceeded"));

    const missingForbidden = await manager.createTeam({
      ...childRequest(run.id, "src/d.ts", "missing-forbidden"),
      parent_team_id: root.team_id,
      scope: { allowed_files: ["src/d.ts"], forbidden_files: [] }
    });
    assert.equal(missingForbidden.team.status, "blocked");
    assert.ok(missingForbidden.validation.findings.some((finding) => finding.code === "forbidden_scope_not_inherited"));

    const failedParent = (await manager.createTeam({
      run_id: run.id,
      domain: "failed",
      objective: "failed parent",
      team_type: "ad_hoc",
      status: "failed",
      scope: { allowed_files: ["src/"], forbidden_files: [".env"] }
    })).team;
    const activeChild = await manager.createTeam({
      ...childRequest(run.id, "src/e.ts", "active-child"),
      parent_team_id: failedParent.team_id,
      status: "active",
      scope: { allowed_files: ["src/e.ts"], forbidden_files: [".env"] }
    });
    assert.equal(activeChild.team.status, "blocked");
    assert.ok(activeChild.validation.findings.some((finding) => finding.code === "inactive_parent"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("agent team budgets inherit conservatively and budget checks emit findings", async () => {
  const workspace = await fixtureWorkspace("agent-team-budget");
  try {
    const run = fakeRun(workspace, "run_budget");
    const manager = new AgentTeamManager({ workspacePath: workspace, artifactStore: new OrchestrationArtifactStore(workspace) });
    const root = (await manager.createRootTeam(run, { budgets: { max_active_writers: 1, max_tasks: 1 } })).team;
    const inherited = inheritedBudget(root, { max_active_writers: 5, max_tasks: 5 });
    assert.equal(inherited.max_active_writers, 1);
    assert.equal(inherited.max_tasks, 1);
    await manager.assignTaskToTeam("task_a", root.team_id);
    await manager.assignTaskToTeam("task_b", root.team_id);
    const result = await manager.checkTeamBudgets(root.team_id);
    assert.equal(result.valid, false);
    assert.ok(result.findings.some((finding) => finding.code === "task_budget_exceeded"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("agent team context helpers resolve inherited scopes locks summaries and task validation", async () => {
  const workspace = await fixtureWorkspace("agent-team-context-helpers");
  try {
    const run = fakeRun(workspace, "run_team_context_helpers");
    const store = new OrchestrationArtifactStore(workspace);
    const manager = new AgentTeamManager({ workspacePath: workspace, artifactStore: store });
    const root = (await manager.createRootTeam(run, {
      scope: {
        allowed_files: ["src/"],
        forbidden_files: [".env", "secret/"],
        module_locks: ["module:root"],
        semantic_locks: ["semantic:security-sensitive"]
      }
    })).team;
    const child = (await manager.createChildTeam(root.team_id, {
      run_id: run.id,
      domain: "runtime",
      objective: "Runtime context",
      team_type: "domain",
      scope: {
        allowed_files: ["src/runtime.ts"],
        forbidden_files: ["secret/"],
        module_locks: ["module:runtime"],
        semantic_locks: ["semantic:validation-runner"]
      }
    })).team;
    const task = fakeTask(run.id, "task_runtime_scope", {
      relevant_files: ["src/runtime.ts"],
      allowed_files_to_edit: ["src/runtime.ts"],
      forbidden_files: ["secret/config.json"]
    });
    const outside = fakeTask(run.id, "task_outside_scope", {
      relevant_files: ["package.json"],
      allowed_files_to_edit: ["package.json"]
    });
    await store.saveTasks(run.id, [task, outside]);

    const inherited = await manager.getInheritedTeamScopes(child.team_id);
    assert.deepEqual(inherited.map((team) => team.team_id), [root.team_id]);
    assert.ok((await manager.getTeamMemoryScopes(child.team_id)).some((scope) => scope.inherited));
    assert.ok((await manager.getTeamEffectiveAllowedFiles(child.team_id)).includes("src/"));
    assert.ok((await manager.getTeamEffectiveAllowedFiles(child.team_id)).includes("src/runtime.ts"));
    assert.ok((await manager.getTeamEffectiveForbiddenFiles(child.team_id)).includes(".env"));
    assert.ok((await manager.getTeamSemanticLocks(child.team_id)).includes("semantic:validation-runner"));
    assert.ok((await manager.getTeamModuleLocks(child.team_id)).includes("module:runtime"));

    const scope = await manager.getTeamContextScope(child.team_id);
    assert.equal(scope?.team_id, child.team_id);
    assert.equal(scope?.parent_team_id, root.team_id);
    assert.ok(scope?.artifact_ref && existsSync(scope.artifact_ref));
    assert.ok(scope?.summary_ref && existsSync(scope.summary_ref));

    const summary = await manager.summarizeTeamForContext(child.team_id);
    assert.equal(summary?.team_id, child.team_id);
    assert.equal(summary?.inherited_memory_scope_count, 1);

    const valid = await manager.validateTaskWithinTeamScope(task.id, child.team_id);
    assert.equal(valid.valid, true);
    const invalid = await manager.validateTaskWithinTeamScope(outside.id, child.team_id);
    assert.equal(invalid.valid, false);
    assert.ok(invalid.outside_allowed_files.includes("package.json"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("agent team planning derives domains and review validation integration teams from merged plan signals", async () => {
  const workspace = await fixtureWorkspace("agent-team-planning");
  try {
    const run = fakeRun(workspace, "run_planning");
    const manager = new AgentTeamManager({ workspacePath: workspace, artifactStore: new OrchestrationArtifactStore(workspace) });
    const teams = await manager.proposeTeamsFromMergedPlan(run, fakeMergedPlan(run.id));
    assert.ok(teams.some((team) => team.team_type === "root"));
    assert.ok(teams.some((team) => team.team_type === "domain" && team.domain === "orchestration"));
    assert.ok(teams.some((team) => team.team_type === "review"));
    assert.ok(teams.some((team) => team.team_type === "validation"));
    assert.ok(teams.some((team) => team.team_type === "integration"));

    const fallbackRun = fakeRun(workspace, "run_root_only");
    const fallback = await manager.proposeTeamsFromMergedPlan(fallbackRun);
    assert.equal(fallback.length, 1);
    assert.equal(fallback[0].team_type, "root");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("agent team metadata artifacts traces and assignments persist refs only", async () => {
  const workspace = await fixtureWorkspace("agent-team-metadata");
  try {
    const run = fakeRun(workspace, "run_metadata");
    const manager = new AgentTeamManager({ workspacePath: workspace, artifactStore: new OrchestrationArtifactStore(workspace) });
    const root = (await manager.createRootTeam(run)).team;
    const child = (await manager.createChildTeam(root.team_id, childRequest(run.id, "src/index.ts", "runtime"))).team;
    await manager.assignTaskToTeam("task_runtime", child.team_id);
    await manager.assignAgentToTeam("agent_reader", child.team_id, "worker_agent_ids");
    await manager.completeTeam(child.team_id);
    const hierarchy = await manager.summarizeTeamHierarchy(run.id, await manager.validateTeamHierarchy(run.id));
    const hierarchyRef = await new OrchestrationArtifactStore(workspace).saveAgentTeamHierarchy(run.id, hierarchy.hierarchy_id, hierarchy);
    const summaryRef = await new OrchestrationArtifactStore(workspace).saveAgentTeamSummary(run.id, hierarchy.hierarchy_id, "summary", { team_count: hierarchy.teams.length });

    assert.ok(root.artifact_ref && existsSync(root.artifact_ref));
    assert.ok(child.artifact_ref && existsSync(child.artifact_ref));
    assert.ok(existsSync(hierarchyRef));
    assert.ok(existsSync(summaryRef));

    const metadata = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.equal(metadata.all("SELECT team_id FROM factory_agent_teams WHERE run_id = ?", run.id).length >= 2, true);
      assert.equal(metadata.all("SELECT child_team_id FROM factory_agent_team_edges WHERE run_id = ?", run.id).length >= 1, true);
      assert.equal(metadata.all("SELECT assignment_id FROM factory_agent_team_assignments WHERE run_id = ?", run.id).length, 2);
      assert.equal(metadata.all("SELECT team_id FROM factory_agent_team_budgets WHERE run_id = ?", run.id).length >= 2, true);
      const joined = metadata.all<{ metadata_json: string }>("SELECT metadata_json FROM factory_agent_teams WHERE run_id = ?", run.id).map((row) => row.metadata_json).join("\n");
      assert.doesNotMatch(joined, /diff --git|large patch body/);
      const events = new Set(metadata.all<{ event_type: string }>("SELECT event_type FROM factory_trace_events WHERE run_id = ?", run.id).map((row) => row.event_type));
      assert.ok(events.has("agent_team_root_created"));
      assert.ok(events.has("agent_team_child_created"));
      assert.ok(events.has("agent_team_budget_inherited"));
      assert.ok(events.has("agent_team_hierarchy_validated"));
      assert.ok(events.has("agent_team_task_assigned"));
      assert.ok(events.has("agent_team_agent_assigned"));
      assert.ok(events.has("agent_team_completed"));
    } finally {
      metadata.close();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("CoreOrchestrator plan-only medium run creates team metadata without changing execution behavior", async () => {
  const workspace = await fixtureWorkspace("agent-team-core-plan");
  try {
    const result = await new CoreOrchestrator({
      workspacePath: workspace,
      providerFactory: () => new ScriptedProvider(),
      config: {
        enable_team_sub_planning: false,
        enable_team_task_adoption: false,
        enable_proposed_task_graph: false,
        execution_readiness_gate_enabled: false
      }
    }).planOnly(
      "Plan a careful orchestration and runtime validation improvement across orchestration, runtime, memory, and tests without changing files yet."
    );
    assert.equal(result.run.status, "succeeded");
    assert.ok((result.report.team_count ?? 0) >= 1);
    assert.ok(result.report.root_team_id);
    assert.ok(result.report.hierarchy_ref && existsSync(result.report.hierarchy_ref));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("swarm read-only agents and work items can be assigned to team metadata without scheduler changes", async () => {
  const workspace = await fixtureWorkspace("agent-team-swarm");
  try {
    const run = fakeRun(workspace, "run_swarm");
    const manager = new AgentTeamManager({ workspacePath: workspace, artifactStore: new OrchestrationArtifactStore(workspace) });
    const root = (await manager.createRootTeam(run)).team;
    const agents: AgentInstance[] = [{
      schema_version: 1,
      id: "agent_scout",
      template_id: "template_scout",
      role: "ScoutAgent",
      status: "idle",
      current_work_item_id: undefined,
      created_at: new Date().toISOString(),
      last_heartbeat_at: new Date().toISOString(),
      failure_count: 0,
      completed_work_item_count: 0
    }];
    const workItems: WorkItem[] = [{
      schema_version: 1,
      id: "work_item_read",
      swarm_run_id: run.id,
      type: "scout",
      priority: 1,
      dependencies: [],
      required_role: "ScoutAgent",
      read_files: ["src/index.ts"],
      write_files: [],
      risk_level: "low",
      context_pack_ref: undefined,
      expected_output_schema: "SwarmScoutResult",
      status: "queued",
      attempt_count: 0,
      max_attempts: 1,
      result_ref: undefined,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }];
    await manager.assignSwarmMetadata({ runId: run.id, rootTeamId: root.team_id, agents, workItems });
    const metadata = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.equal(metadata.all("SELECT assignment_id FROM factory_agent_team_assignments WHERE run_id = ?", run.id).length, 2);
    } finally {
      metadata.close();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function childRequest(runId: string, file: string, domain: string): AgentTeamCreationRequest {
  return {
    run_id: runId,
    domain,
    objective: `Coordinate ${domain}`,
    team_type: "domain",
    scope: {
      allowed_files: [file],
      forbidden_files: [],
      module_locks: [`module:${domain}`],
      semantic_locks: [],
      context_refs: [],
      evidence_refs: []
    },
    budgets: { max_active_writers: 1 }
  };
}

function fakeRun(workspace: string, id: string): Run {
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id,
    user_request: "Plan team metadata",
    status: "planning",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    root_task_ids: [],
    memory_snapshot_ref: path.join(workspace, ".agent_memory", "repo_index.json"),
    artifacts_path: path.join(workspace, ".agent_memory", "runs", id),
    config: {
      workspace_path: workspace,
      memory_dir: ".agent_memory",
      max_context_files: 4,
      max_context_chars: 4000,
      max_task_attempts: 1,
      provider_mode: "real_provider"
    }
  };
}

function fakeTask(runId: string, id: string, overrides: Partial<import("../orchestration/index.js").Task> = {}): import("../orchestration/index.js").Task {
  const now = new Date().toISOString();
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id,
    run_id: runId,
    title: id,
    objective: "Validate team task scope",
    role_required: "ExecutorAgent",
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
    updated_at: now,
    ...overrides
  };
}

function fakeMergedPlan(runId: string): MergedPlan {
  const now = new Date().toISOString();
  return {
    merged_plan_id: "merged_plan_test",
    run_id: runId,
    generation_mode: "heuristic",
    selected_plan_ids: ["plan_a"],
    rejected_plan_ids: [],
    summary: "Merged plan",
    chosen_strategy: "Safe metadata-first team planning.",
    merged_tasks: [{
      id: "draft_orchestration",
      title: "Draft orchestration metadata",
      objective: "Add metadata",
      role_hint: "PlannerAgent",
      read_only: false,
      proposed_files: ["apps/agent-runtime/src/orchestration/AgentTeamManager.ts"],
      allowed_write_paths: ["apps/agent-runtime/src/orchestration/AgentTeamManager.ts"],
      dependencies: [],
      validation_refs: ["npm test"],
      rationale: "needed"
    }],
    dependencies: [],
    risks: [{
      id: "risk_public",
      summary: "Public orchestration metadata risk",
      severity: "high",
      affected_domains: ["orchestration"],
      mitigation: "review first",
      approval_required: false
    }],
    assumptions: [],
    validation_strategy: {
      required_commands: ["npm run typecheck", "npm test"],
      optional_commands: [],
      smoke_checks: [],
      manual_checks: [],
      success_criteria: ["tests pass"],
      validation_risk: "high"
    },
    recommended_limits: { max_active_writers: 1 },
    merge_rationale: ["metadata first"],
    merge_decisions: [],
    unresolved_questions: [],
    confidence: 0.8,
    artifact_ref: path.join(os.tmpdir(), "merged_plan_test.json"),
    evidence_item_refs: ["evidence_a"],
    created_at: now
  };
}

async function fixtureWorkspace(name: string) {
  return mkdtemp(path.join(os.tmpdir(), `${name}-`));
}
