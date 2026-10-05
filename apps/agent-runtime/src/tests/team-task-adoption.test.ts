import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeJson } from "../memory/ProjectMemory.js";
import {
  AgentTeamManager,
  CoreOrchestrator,
  FactoryMetadataStore,
  ORCHESTRATION_SCHEMA_VERSION,
  OrchestrationArtifactStore,
  TeamTaskAdoptionGate,
  TeamTaskReadinessGate,
  createAdoptedTaskProposal,
  createTaskAdoptionDecision,
  createTaskAdoptionFinding,
  createTaskReadinessProfile,
  createTeamSubPlan,
  createTeamSubPlanTaskDraft,
  createTeamTaskAdoptionRequest,
  loadOrchestrationConfig,
  reconstructFactoryRunTrace,
  type AgentRoleName,
  type Run,
  type Task,
  type TaskPromotionPolicy,
  type TeamSubPlan
} from "../orchestration/index.js";
import { ScriptedProvider } from "./fixtures/ScriptedProvider.js";

test("team task adoption models create request proposal readiness decision and findings", () => {
  const request = createTeamTaskAdoptionRequest({
    run_id: "run_models",
    sub_plan_ids: ["sub_model"],
    mode: "metadata_only",
    policy: policy(),
    requested_by: "test"
  });
  const proposal = createAdoptedTaskProposal({
    run_id: "run_models",
    team_id: "team_model",
    sub_plan_id: "sub_model",
    source_task_draft_id: "draft_model",
    title: "Read model",
    objective: "Read model objective",
    task_type: "review",
    read_or_write_classification: "read_only",
    proposed_role: "ReviewerAgent",
    allowed_files: [],
    forbidden_files: [".env"],
    read_only_files: ["src/index.ts"],
    module_locks: [],
    semantic_locks: [],
    dependencies: [],
    validation_strategy: validationStrategy([]),
    success_criteria: ["understand"],
    stop_conditions: [],
    evidence_refs: [],
    risk_level: "low",
    readiness_status: "read_only_ready",
    adoption_status: "adopted_read_only"
  });
  const finding = createTaskAdoptionFinding({ code: "scope_valid", severity: "info", message: "ok", refs: [] });
  const readiness = createTaskReadinessProfile({
    run_id: proposal.run_id,
    team_id: proposal.team_id,
    sub_plan_id: proposal.sub_plan_id,
    task_draft_id: proposal.source_task_draft_id,
    adopted_task_id: proposal.adopted_task_id,
    readiness_status: "read_only_ready",
    requirements: [],
    findings: [finding],
    executable_allowed: false
  });
  const decision = createTaskAdoptionDecision({
    run_id: proposal.run_id,
    team_id: proposal.team_id,
    sub_plan_id: proposal.sub_plan_id,
    task_draft_id: proposal.source_task_draft_id,
    adopted_task_id: proposal.adopted_task_id,
    adoption_status: "adopted_read_only",
    readiness_status: readiness.readiness_status,
    reason: "accepted",
    findings: [finding]
  });
  assert.equal(request.mode, "metadata_only");
  assert.equal(proposal.adoption_status, "adopted_read_only");
  assert.equal(readiness.readiness_status, "read_only_ready");
  assert.equal(decision.findings[0].code, "scope_valid");
  assert.doesNotMatch(JSON.stringify(decision), /diff --git/);
});

test("TaskReadinessGate keeps read-only ready and write candidates non-executable by default", () => {
  const gate = new TeamTaskReadinessGate();
  const readOnly = proposalFixture({ classification: "read_only", adoptionStatus: "adopted_read_only" });
  const readOnlyProfile = gate.checkReadiness(readOnly, policy());
  assert.equal(readOnlyProfile.readiness_status, "read_only_ready");
  assert.equal(readOnlyProfile.executable_allowed, false);

  const write = proposalFixture({ classification: "write_candidate", adoptionStatus: "adopted_metadata_only" });
  const writeProfile = gate.checkReadiness(write, policy());
  assert.equal(writeProfile.readiness_status, "metadata_only");
  assert.equal(writeProfile.executable_allowed, false);

  const future = gate.checkReadiness(write, policy({ mode: "gated_future_ready" }));
  assert.equal(future.readiness_status, "future_write_candidate");
  assert.equal(future.executable_allowed, false);

  const executableDisabled = gate.checkReadiness(write, policy({ mode: "gated_future_ready", allow_executable_adoption: false }));
  assert.notEqual(executableDisabled.readiness_status, "executable_ready");
});

test("TeamTaskAdoptionGate blocks missing validation scope success criteria stop conditions and forbidden files", async () => {
  const workspace = await fixtureWorkspace("team-task-adoption-validation");
  try {
    const { gate, subPlan } = await adoptionFixture(workspace);
    const context = await contextFor(gate, subPlan, subPlan.proposed_tasks[0]);
    const readOnly = await gate.evaluateTaskDraftForAdoption(readOnlyDraft("draft_read"), contextForDraft(subPlan, readOnlyDraft("draft_read")));
    assert.equal(readOnly.proposal?.adoption_status, "adopted_read_only");

    const noValidationPlan = { ...subPlan, validation_strategy: validationStrategy([]) };
    const missingValidation = await gate.evaluateTaskDraftForAdoption(writeDraft("draft_no_validation", { validation: false }), contextForDraft(noValidationPlan, writeDraft("draft_no_validation", { validation: false })));
    assert.equal(missingValidation.decision.adoption_status, "missing_validation");

    const missingScope = await gate.evaluateTaskDraftForAdoption(writeDraft("draft_no_scope", { writePaths: [] }), contextForDraft(subPlan, writeDraft("draft_no_scope", { writePaths: [] })));
    assert.equal(missingScope.decision.adoption_status, "adopted_blocked");

    const forbidden = await gate.evaluateTaskDraftForAdoption(writeDraft("draft_forbidden", { files: [".env"], writePaths: [".env"] }), context);
    assert.equal(forbidden.decision.adoption_status, "unsafe_write_scope");

    const outOfScope = await gate.evaluateTaskDraftForAdoption(writeDraft("draft_outside", { files: ["package.json"], writePaths: ["package.json"] }), context);
    assert.equal(outOfScope.decision.adoption_status, "out_of_scope");

    const missingSuccess = await gate.evaluateTaskDraftForAdoption(writeDraft("draft_missing_success", { success: false }), context);
    assert.equal(missingSuccess.decision.adoption_status, "missing_success_criteria");

    const missingStop = await gate.evaluateTaskDraftForAdoption(writeDraft("draft_missing_stop", { stop: false }), context);
    assert.equal(missingStop.decision.adoption_status, "adopted_blocked");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("TeamTaskAdoptionGate persists adopted proposals rejected drafts readiness results metadata and traces", async () => {
  const workspace = await fixtureWorkspace("team-task-adoption-persist");
  try {
    const { gate, run, subPlan } = await adoptionFixture(workspace, {
      drafts: [
        readOnlyDraft("draft_read"),
        writeDraft("draft_write"),
        readOnlyDraft("draft_duplicate_existing", { title: "Existing task", objective: "Existing objective" })
      ]
    });
    const result = await gate.adoptTeamSubPlanTasks(subPlan, { existingTasks: [fakeTask(run.id, "task_existing", "Existing task", "Existing objective")] });
    assert.equal(result.evaluated_drafts, 3);
    assert.ok(result.proposals.some((proposal) => proposal.adoption_status === "adopted_read_only"));
    assert.ok(result.decisions.some((decision) => decision.adoption_status === "duplicate"));
    assert.ok(result.summary_ref && existsSync(result.summary_ref));
    assert.ok(result.artifact_ref && existsSync(result.artifact_ref));

    const metadata = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.ok((metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_adopted_task_proposals WHERE run_id = ?", run.id)?.count ?? 0) >= 1);
      assert.equal(metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_task_adoption_decisions WHERE run_id = ?", run.id)?.count, 3);
      assert.ok((metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_task_readiness_results WHERE run_id = ?", run.id)?.count ?? 0) >= 1);
      const row = metadata.get<{ metadata_json: string }>("SELECT metadata_json FROM factory_adopted_task_proposals WHERE run_id = ? LIMIT 1", run.id);
      assert.doesNotMatch(row?.metadata_json ?? "", /export const/);
    } finally {
      metadata.close();
    }

    const trace = await reconstructFactoryRunTrace({ workspacePath: workspace, runId: run.id });
    const events = new Set(trace.events.map((event) => event.event_type));
    assert.ok(events.has("team_task_adoption_started"));
    assert.ok(events.has("team_task_draft_evaluated"));
    assert.ok(events.has("team_task_draft_adopted"));
    assert.ok(events.has("team_task_draft_duplicate_detected"));
    assert.ok(events.has("team_task_readiness_checked"));
    assert.ok(events.has("team_task_adoption_summary_created"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("TeamTaskAdoptionGate detects duplicates against existing task graph records", async () => {
  const workspace = await fixtureWorkspace("team-task-adoption-duplicates");
  try {
    const { gate, run, subPlan } = await adoptionFixture(workspace, { drafts: [readOnlyDraft("draft_existing", { title: "Existing task", objective: "Existing objective" })] });
    const result = await gate.adoptTeamSubPlanTasks(subPlan, { existingTasks: [fakeTask(run.id, "task_existing", "Existing task", "Existing objective")] });
    assert.equal(result.decisions[0].adoption_status, "duplicate");
    assert.equal(result.proposals.length, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("TeamTaskAdoptionGate detects duplicates within and across sub-plans", async () => {
  const workspace = await fixtureWorkspace("team-task-adoption-sibling-duplicates");
  try {
    const { gate, subPlan } = await adoptionFixture(workspace, {
      drafts: [
        readOnlyDraft("draft_a", { title: "Same draft", objective: "Same objective" }),
        readOnlyDraft("draft_b", { title: "Same draft", objective: "Same objective" })
      ]
    });
    const sibling = { ...subPlan, sub_plan_id: `${subPlan.sub_plan_id}_sibling`, proposed_tasks: [readOnlyDraft("draft_c", { title: "Same draft", objective: "Same objective" })] };
    const result = await gate.adoptTeamSubPlanTasks([subPlan, sibling]);
    assert.equal(result.decisions.every((decision) => decision.adoption_status === "duplicate"), true);
    assert.equal(result.proposals.length, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("CoreOrchestrator plan-only run evaluates sub-plan drafts without making executor tasks ready", async () => {
  const workspace = await fixtureWorkspace("team-task-adoption-core");
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
        team_task_adoption_mode: "metadata_only"
      }
    }).planOnly("Plan a medium orchestration change across src/runtime.ts and src/review.ts without editing files.");
    assert.equal(result.run.status, "succeeded");
    assert.equal(result.report.team_task_adoption_used, true);
    assert.ok((result.report.drafts_evaluated ?? 0) >= 1);
    assert.equal(result.report.executable_ready_count, 0);
    assert.equal(result.tasks.some((task) => task.status === "ready" || task.status === "running"), false);
    assert.ok(result.report.adoption_summary_ref && existsSync(result.report.adoption_summary_ref));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function adoptionFixture(workspace: string, options: { drafts?: ReturnType<typeof readOnlyDraft>[] } = {}) {
  const run = fakeRun(workspace, `run_${path.basename(workspace).replace(/[^a-z0-9]+/gi, "_")}`);
  const store = new OrchestrationArtifactStore(workspace);
  const manager = new AgentTeamManager({ workspacePath: workspace, artifactStore: store });
  const root = (await manager.createRootTeam(run, {
    scope: { allowed_files: ["src/"], forbidden_files: [".env", ".agent_memory/"] },
    budgets: { max_depth: 2, max_tasks: 6 }
  })).team;
  const team = (await manager.createChildTeam(root.team_id, {
    run_id: run.id,
    domain: "runtime",
    objective: "Runtime adoption",
    team_type: "review",
    scope: {
      allowed_files: ["src/runtime.ts", "src/review.ts"],
      forbidden_files: [".env", ".agent_memory/"],
      module_locks: ["module:runtime"],
      semantic_locks: ["semantic:runtime"]
    }
  })).team;
  const subPlan = createTeamSubPlan({
    sub_plan_id: `sub_${team.team_id}`,
    run_id: run.id,
    team_id: team.team_id,
    parent_team_id: team.parent_team_id,
    team_domain: team.domain,
    team_type: team.team_type,
    objective: team.objective,
    status: "generated",
    scope_summary: "runtime review scope",
    assumptions: [],
    proposed_tasks: options.drafts ?? [readOnlyDraft("draft_read")],
    dependencies: [],
    risks: [],
    validation_strategy: validationStrategy(["git diff --check"]),
    required_context_refs: ["context_pack_ref"],
    evidence_refs: ["evidence"],
    memory_scope_refs: [],
    lock_context_refs: ["module:runtime", "semantic:runtime"],
    budget_usage: {
      max_task_count: 6,
      proposed_task_count: options.drafts?.length ?? 1,
      max_depth: 2,
      planned_depth: 1,
      max_active_writers: 1,
      provider_read_only_worker_budget: 2,
      budget_warnings: [],
      metadata_json: {}
    },
    unresolved_questions: [],
    confidence: 0.8,
    generation_mode: "deterministic",
    metadata_json: {
      team_allowed_files: ["src/runtime.ts", "src/review.ts"],
      team_forbidden_files: [".env", ".agent_memory/"],
      context_pack_ref: "context_pack_ref"
    }
  });
  const gate = new TeamTaskAdoptionGate({ workspacePath: workspace, config: config(), artifactStore: store, teamManager: manager });
  return { gate, run, subPlan };
}

async function contextFor(gate: TeamTaskAdoptionGate, subPlan: TeamSubPlan, draft: ReturnType<typeof readOnlyDraft>) {
  const result = await gate.adoptTaskDraft(draft, contextForDraft(subPlan, draft));
  assert.ok(result);
  return contextForDraft(subPlan, draft);
}

function contextForDraft(subPlan: TeamSubPlan, draft: ReturnType<typeof readOnlyDraft>) {
  return {
    sub_plan: subPlan,
    draft,
    allowed_files: ["src/runtime.ts", "src/review.ts"],
    forbidden_files: [".env", ".agent_memory/"],
    read_only_files: ["src/runtime.ts", "src/review.ts"],
    module_locks: ["module:runtime"],
    semantic_locks: ["semantic:runtime"],
    context_pack_ref: "context_pack_ref",
    existing_task_signatures: [],
    already_adopted_signatures: [],
    sibling_draft_signatures: []
  };
}

function readOnlyDraft(id: string, overrides: Partial<{ title: string; objective: string }> = {}) {
  return createTeamSubPlanTaskDraft({
    task_draft_id: id,
    title: overrides.title ?? "Read-only adoption draft",
    objective: overrides.objective ?? "Inspect the scoped files.",
    role_hint: "ReviewerAgent",
    read_only: true,
    proposed_files: ["src/review.ts"],
    allowed_write_paths: [],
    forbidden_files: [".env"],
    required_context_refs: ["context"],
    evidence_refs: ["evidence"],
    validation_refs: [],
    rationale: "read-only"
  });
}

function writeDraft(id: string, options: Partial<{ validation: boolean; success: boolean; stop: boolean; files: string[]; writePaths: string[]; title: string; objective: string }> = {}) {
  return createTeamSubPlanTaskDraft({
    task_draft_id: id,
    title: options.title ?? "Write adoption draft",
    objective: options.objective ?? "Update the scoped files.",
    role_hint: "ExecutorAgent",
    read_only: false,
    proposed_files: options.files ?? ["src/runtime.ts"],
    allowed_write_paths: options.writePaths ?? ["src/runtime.ts"],
    forbidden_files: [".env"],
    required_context_refs: ["context"],
    evidence_refs: ["evidence"],
    validation_refs: options.validation === false ? [] : ["validation"],
    rationale: "write",
    metadata_json: {
      success_criteria: options.success === false ? [] : ["Runtime behavior is updated."],
      stop_conditions: options.stop === false ? [] : ["Stop if scope expands."]
    }
  });
}

function validationStrategy(commands: string[]) {
  return {
    strategy_id: "validation_strategy",
    status: "planned" as const,
    commands,
    required_checks: commands.length ? commands : [],
    artifact_refs: [],
    notes: ["not run"],
    metadata_json: {}
  };
}

function proposalFixture(input: { classification: "read_only" | "write_candidate"; adoptionStatus: "adopted_read_only" | "adopted_metadata_only" }) {
  return createAdoptedTaskProposal({
    run_id: "run_readiness",
    team_id: "team_readiness",
    sub_plan_id: "sub_readiness",
    source_task_draft_id: "draft_readiness",
    title: "Readiness proposal",
    objective: "Check readiness.",
    task_type: "domain",
    read_or_write_classification: input.classification,
    proposed_role: input.classification === "read_only" ? "ReviewerAgent" : "ExecutorAgent",
    allowed_files: input.classification === "read_only" ? [] : ["src/runtime.ts"],
    forbidden_files: [".env"],
    read_only_files: ["src/runtime.ts"],
    module_locks: ["module:runtime"],
    semantic_locks: ["semantic:runtime"],
    dependencies: [],
    validation_strategy: validationStrategy(input.classification === "read_only" ? [] : ["git diff --check"]),
    success_criteria: ["Criterion"],
    stop_conditions: input.classification === "read_only" ? [] : ["Stop if scope expands."],
    prompt_template_ref: "role_prompt:ExecutorAgent",
    context_pack_ref: "context_pack_ref",
    evidence_refs: [],
    risk_level: input.classification === "read_only" ? "low" : "medium",
    readiness_status: "metadata_only",
    adoption_status: input.adoptionStatus
  });
}

function policy(overrides: Partial<TaskPromotionPolicy> = {}) {
  return {
    mode: "metadata_only" as const,
    allow_write_task_future_candidates: true,
    allow_executable_adoption: false,
    max_adopted_tasks_per_run: 24,
    max_adopted_tasks_per_team: 6,
    metadata_json: {},
    ...overrides
  };
}

function config() {
  return loadOrchestrationConfig({
    memory_path: ".agent_memory",
    enable_team_task_adoption: true,
    team_task_adoption_mode: "metadata_only"
  });
}

function fakeTask(runId: string, id: string, title: string, objective: string): Task {
  const now = new Date().toISOString();
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id,
    run_id: runId,
    title,
    objective,
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
    user_request: "Adopt task proposals.",
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
