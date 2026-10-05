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
  assertRunTransition,
  canTransitionRun,
  isBlockedRunStatus,
  isTerminalRunStatus,
  legacyRunStatusAliases,
  normalizeRunStatus,
  transitionRun,
  type Run,
  type Task
} from "../orchestration/index.js";
import { ScriptedProvider } from "./fixtures/ScriptedProvider.js";

test("run state machine accepts the happy-path execution lifecycle", () => {
  const statuses = [
    "created",
    "intake",
    "prompt_rewrite",
    "clarification_check",
    "repo_mapping",
    "complexity_estimation",
    "planning",
    "task_graph_ready",
    "executing",
    "reviewing",
    "validating",
    "integrating",
    "memory_update",
    "reporting",
    "succeeded"
  ];

  let previous: string | undefined;
  for (const status of statuses) {
    assert.equal(canTransitionRun(previous, status), true, `${previous ?? "<none>"} -> ${status}`);
    previous = status;
  }
  assert.equal(isTerminalRunStatus("succeeded"), true);
});

test("run state machine accepts the plan-only lifecycle", () => {
  const statuses = ["created", "intake", "planning", "task_graph_ready", "reporting", "succeeded"];
  let previous: string | undefined;
  for (const status of statuses) {
    const record = transitionRun("run_plan_only", status, {
      currentStatus: previous,
      reason: `Move to ${status}`,
      sourceComponent: "test",
      mode: "plan_only"
    });
    assert.equal(record.canonical_next_status, normalizeRunStatus(status));
    previous = status;
  }
});

test("run state machine rejects invalid success shortcuts", () => {
  assert.throws(() => assertRunTransition("created", "succeeded"), /Invalid run transition/);
  assert.throws(() => assertRunTransition("planning", "succeeded"), /Invalid run transition/);
  assert.throws(() => assertRunTransition("executing", "succeeded"), /Invalid run transition/);
  assert.throws(() => assertRunTransition("validating", "succeeded", { validationStatus: "blocked" }), /Invalid run transition/);
});

test("run state machine handles failed blocked and cancelled semantics", () => {
  assert.equal(canTransitionRun("reporting", "failed", { trigger: "failure_handling" }), true);
  assert.throws(() => assertRunTransition("failed", "executing"), /explicit resume or retry/);
  assert.equal(canTransitionRun("failed", "executing", { trigger: "retry" }), true);

  assert.equal(canTransitionRun("created", "blocked"), true);
  assert.equal(isBlockedRunStatus("blocked"), true);
  assert.equal(canTransitionRun("blocked", "planning", { trigger: "resume" }), true);

  assert.equal(canTransitionRun("reporting", "cancelled", { trigger: "user" }), true);
  assert.throws(() => assertRunTransition("cancelled", "executing", { trigger: "resume" }), /terminal/);
});

test("run state machine maps legacy public statuses to canonical lifecycle states", () => {
  assert.deepEqual(legacyRunStatusAliases(), {
    indexing: "repo_mapping",
    verifying: "validating",
    analyzing: "complexity_estimation",
    staffing: "staffing_plan",
    scheduling: "executing"
  });
  assert.equal(normalizeRunStatus("indexing"), "repo_mapping");
  assert.equal(normalizeRunStatus("verifying"), "validating");
  assert.equal(normalizeRunStatus("analyzing"), "complexity_estimation");
  assert.equal(normalizeRunStatus("staffing"), "staffing_plan");
  assert.equal(normalizeRunStatus("scheduling"), "executing");
  assert.equal(canTransitionRun("created", "indexing"), true);
  assert.equal(canTransitionRun("created", "analyzing"), true);
  assert.equal(canTransitionRun("indexing", "planning"), true);
  assert.equal(canTransitionRun("analyzing", "staffing"), true);
  assert.equal(canTransitionRun("staffing", "planning"), true);
  assert.equal(canTransitionRun("scheduling", "reviewing"), true);
});

test("CoreOrchestrator plan-only run writes transition metadata and preserves artifact layout", async () => {
  const workspace = await fixtureWorkspace("factory-state-plan");
  try {
    const result = await new CoreOrchestrator({
      workspacePath: workspace,
      providerFactory: () => new ScriptedProvider()
    }).planOnly("Explain src/index.ts without changing files.");
    assert.equal(result.run.status, "succeeded");
    assert.match(result.run.artifacts_path, /[\\\/]\.agent_memory[\\\/]runs[\\\/]run_/);
    assert.equal(existsSync(path.join(result.run.artifacts_path, "run.json")), true);
    assert.equal(existsSync(path.join(result.run.artifacts_path, "tasks.json")), true);
    assert.equal(existsSync(path.join(result.run.artifacts_path, "reports", "final_report.json")), true);
    assert.ok(result.report.limitations.some((limitation) => limitation.includes("Plan-only mode")));

    const metadata = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      const transitions = metadata.all<{ next_status: string; canonical_next_status: string; source_component: string }>(
        "SELECT next_status, canonical_next_status, source_component FROM factory_run_transitions WHERE run_id = ? ORDER BY created_at",
        result.run.id
      );
      assert.ok(transitions.some((transition) => transition.next_status === "task_graph_ready"));
      assert.equal(transitions.at(-1)?.next_status, "succeeded");
      assert.equal(transitions.every((transition) => transition.source_component === "CoreOrchestrator"), true);
    } finally {
      metadata.close();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("resume from a valid checkpoint leaves the run in its persisted resume-safe state", async () => {
  const workspace = await fixtureWorkspace("factory-state-resume-valid");
  try {
    const store = new OrchestrationArtifactStore(workspace);
    const run = fakeRun(workspace, "run_resume_valid", "task_graph_ready");
    await store.saveRun(run);
    await store.saveTasks(run.id, [fakeTask(run.id)]);

    const result = await new CoreOrchestrator({ workspacePath: workspace }).resumeRun(run.id);
    assert.equal(result.run.status, "task_graph_ready");
    assert.equal(existsSync(path.join(result.run.artifacts_path, "checkpoints")), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("resume uses DB-first state when compatibility run artifacts are stale or missing", async () => {
  const workspace = await fixtureWorkspace("factory-state-resume-mismatch");
  try {
    const store = new OrchestrationArtifactStore(workspace);
    const run = fakeRun(workspace, "run_resume_mismatch", "task_graph_ready");
    await store.saveRun(run);
    await store.saveTasks(run.id, [fakeTask(run.id)]);

    const mismatched = { ...run, status: "executing" as const, updated_at: new Date().toISOString() };
    await writeJson(path.join(run.artifacts_path, "run.json"), mismatched);
    await rm(path.join(run.artifacts_path, "tasks.json"), { force: true });

    const result = await new CoreOrchestrator({ workspacePath: workspace }).resumeRun(run.id);
    assert.equal(result.run.status, "task_graph_ready");

    const metadata = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      const blockedTransition = metadata.get<{ next_status: string; transition_trigger: string }>(
        "SELECT next_status, transition_trigger FROM factory_run_transitions WHERE run_id = ? AND next_status = ?",
        run.id,
        "blocked"
      );
      assert.equal(blockedTransition, undefined);
    } finally {
      metadata.close();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function fixtureWorkspace(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeJson(path.join(root, "package.json"), {
    name: prefix,
    scripts: {
      test: "node -e \"process.exit(0)\"",
      typecheck: "node -e \"process.exit(0)\""
    }
  });
  await writeFile(path.join(root, "src", "index.ts"), "export const value = 1;\n", "utf8");
  return root;
}

function fakeRun(workspace: string, id: string, status: Run["status"]): Run {
  const now = new Date().toISOString();
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id,
    user_request: "Resume saved run",
    status,
    created_at: now,
    updated_at: now,
    root_task_ids: ["task_resume"],
    memory_snapshot_ref: "repo_index.json",
    config: {
      workspace_path: workspace,
      memory_dir: ".agent_memory",
      max_context_files: 2,
      max_context_chars: 1200,
      max_task_attempts: 1,
      provider_mode: "real_provider"
    },
    artifacts_path: path.join(workspace, ".agent_memory", "runs", id)
  };
}

function fakeTask(runId: string): Task {
  const now = new Date().toISOString();
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id: "task_resume",
    run_id: runId,
    title: "Resume task",
    objective: "Exercise resume reconciliation.",
    role_required: "ScoutAgent",
    status: "pending",
    dependencies: [],
    relevant_files: ["src/index.ts"],
    allowed_files_to_edit: [],
    forbidden_files: [".agent_memory/"],
    expected_output_schema: "ScoutResult",
    validation_commands: [],
    max_attempts: 1,
    attempt_count: 0,
    artifacts: [],
    created_at: now,
    updated_at: now
  };
}
