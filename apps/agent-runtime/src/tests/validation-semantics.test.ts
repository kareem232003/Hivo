import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeJson } from "../memory/ProjectMemory.js";
import type { CommandInventory } from "../memory/types.js";
import {
  FactoryMetadataStore,
  ORCHESTRATION_SCHEMA_VERSION,
  OrchestrationArtifactStore,
  CoreOrchestrator,
  ValidationRunner,
  aggregateValidationStatus,
  assertRunTransition,
  canTransitionRun,
  reconstructFactoryRunTrace,
  validationStatusToRunImpact,
  type Task
} from "../orchestration/index.js";
import { ScriptedProvider } from "./fixtures/ScriptedProvider.js";

test("validation aggregation reports all required commands passed", () => {
  const result = aggregateValidationStatus([
    { command: "npm test", status: "passed", required: true }
  ]);
  assert.equal(result.status, "passed");
  assert.equal(result.fully_passed, true);
  assert.equal(validationStatusToRunImpact(result.status), "allow_success");
});

test("validation aggregation fails when a required command fails", () => {
  const result = aggregateValidationStatus([
    { command: "npm test", status: "passed", required: true },
    { command: "npm run typecheck", status: "failed", required: true }
  ]);
  assert.equal(result.status, "failed");
  assert.equal(result.blocking_completion, true);
});

test("validation aggregation blocks when a required command is blocked before anything passes", () => {
  const result = aggregateValidationStatus([
    { command: "npm test", status: "blocked", required: true, reason: "Not allowlisted." }
  ]);
  assert.equal(result.status, "blocked");
  assert.equal(validationStatusToRunImpact(result.status), "block");
});

test("validation aggregation skips explicitly skipped required commands", () => {
  const result = aggregateValidationStatus([
    { command: "npm test", status: "skipped", required: true, reason: "Operator deferred." }
  ], [], { skippedAllowed: true });
  assert.equal(result.status, "skipped");
  assert.equal(result.fully_passed, false);
});

test("validation aggregation marks required commands as not_run when none ran", () => {
  const result = aggregateValidationStatus([], [
    { command: "npm test", required: true }
  ]);
  assert.equal(result.status, "not_run");
  assert.deepEqual(result.missing_required_commands, ["npm test"]);
});

test("validation aggregation allows optional command failure when required commands passed", () => {
  const result = aggregateValidationStatus([
    { command: "npm test", status: "passed", required: true },
    { command: "npm run lint", status: "failed", required: false }
  ]);
  assert.equal(result.status, "passed");
  assert.equal(result.warnings.length, 1);
});

test("validation aggregation marks plan-only runs as not_required", () => {
  const result = aggregateValidationStatus([], [], {
    mode: "plan_only",
    notRequiredReason: "Validation not required because this was a plan-only/read-only run."
  });
  assert.equal(result.status, "not_required");
  assert.equal(validationStatusToRunImpact(result.status), "allow_plan_only_success");
});

test("validation aggregation marks mixed passed and blocked required commands partial", () => {
  const result = aggregateValidationStatus([
    { command: "npm test", status: "passed", required: true },
    { command: "npm run build", status: "blocked", required: true }
  ]);
  assert.equal(result.status, "partial");
});

test("validation aggregation marks mixed passed and skipped required commands partial", () => {
  const result = aggregateValidationStatus([
    { command: "npm test", status: "passed", required: true },
    { command: "npm run build", status: "skipped", required: true }
  ]);
  assert.equal(result.status, "partial");
});

test("validation aggregation treats timed-out required commands as not passed", () => {
  const result = aggregateValidationStatus([
    { command: "npm test", status: "timed_out", required: true }
  ]);
  assert.equal(result.status, "failed");
});

test("ValidationRunner records unsafe and non-allowlisted required commands as blocked", async () => {
  const workspace = await fixtureWorkspace("validation-runner-blocked");
  try {
    const store = new OrchestrationArtifactStore(workspace);
    const runner = new ValidationRunner(workspace, store, {
      validation_timeout: 5_000,
      max_validation_log_size: 2_000,
      safe_commands_allowlist: ["node -e"]
    });

    const unsafe = await runner.runForTask({
      runId: "run_validation_blocked",
      task: task("run_validation_blocked", ["rm -rf ."]),
      commandInventory: inventory([{ command: "rm -rf .", kind: "test" }])
    });
    assert.equal(unsafe.validation_status, "blocked");
    assert.equal(unsafe.passed, false);
    assert.equal(unsafe.commands_run[0]?.status, "blocked");

    const nonAllowlisted = await runner.runForTask({
      runId: "run_validation_blocked",
      task: task("run_validation_blocked", ["npm run test"]),
      commandInventory: inventory([{ command: "npm run test", kind: "test" }])
    });
    assert.equal(nonAllowlisted.validation_status, "blocked");
    assert.equal(nonAllowlisted.commands_run[0]?.status, "blocked");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("ValidationRunner no-safe-command case does not pass and preserves artifacts", async () => {
  const workspace = await fixtureWorkspace("validation-runner-not-run");
  try {
    const store = new OrchestrationArtifactStore(workspace);
    const runner = new ValidationRunner(workspace, store, {
      validation_timeout: 5_000,
      max_validation_log_size: 2_000,
      safe_commands_allowlist: ["node -e"]
    });
    const result = await runner.runForTask({
      runId: "run_validation_not_run",
      task: task("run_validation_not_run", []),
      commandInventory: inventory([])
    });
    assert.equal(result.validation_status, "not_run");
    assert.equal(result.passed, false);
    assert.equal(result.logs_refs.length, 1);
    assert.equal(existsSync(result.logs_refs[0]!), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("ValidationRunner persists command-level statuses and emits unified validation traces", async () => {
  const workspace = await fixtureWorkspace("validation-runner-trace");
  try {
    const store = new OrchestrationArtifactStore(workspace);
    const runner = new ValidationRunner(workspace, store, {
      validation_timeout: 5_000,
      max_validation_log_size: 2_000,
      safe_commands_allowlist: ["node -e"]
    });
    const runId = "run_validation_trace";
    const result = await runner.runForTask({
      runId,
      task: task(runId, ["npm run test"]),
      commandInventory: inventory([{ command: "npm run test", kind: "test" }]),
      onEvent: async (event) => {
        await store.appendEvent({
          id: `event_${Date.now()}_${Math.random().toString(16).slice(2)}`,
          created_at: new Date().toISOString(),
          ...event
        });
      }
    });
    assert.equal(result.validation_status, "blocked");

    const metadata = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      const row = metadata.get<{ status: string; metadata_json: string }>(
        "SELECT status, metadata_json FROM factory_validations WHERE run_id = ? AND validation_kind = ?",
        runId,
        "validation"
      );
      assert.equal(row?.status, "blocked");
      const json = JSON.parse(row?.metadata_json ?? "{}") as Record<string, unknown>;
      assert.equal(json.validation_status, "blocked");
      assert.deepEqual(json.command_status_counts, { blocked: 1 });
    } finally {
      metadata.close();
    }

    const trace = await reconstructFactoryRunTrace({ workspacePath: workspace, runId });
    assert.ok(trace.events.some((event) => event.event_type === "validation_started"));
    assert.ok(trace.events.some((event) => event.event_type === "validation_blocked"));
    assert.equal(trace.blockedReasons.length >= 1, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("run lifecycle accepts passed validation and blocks failed partial or not-run validation", () => {
  assert.equal(canTransitionRun("validating", "integrating", { validationStatus: "passed" }), true);
  assert.throws(() => assertRunTransition("validating", "integrating", { validationStatus: "failed" }), /Validation status failed/);
  assert.equal(canTransitionRun("validating", "failed", { validationStatus: "failed" }), true);
  assert.equal(canTransitionRun("validating", "blocked", { validationStatus: "blocked" }), true);
  assert.throws(() => assertRunTransition("validating", "integrating", { validationStatus: "partial" }), /Validation status partial/);
  assert.throws(() => assertRunTransition("validating", "integrating", { validationStatus: "not_run" }), /Validation status not_run/);
  assert.equal(canTransitionRun("reporting", "succeeded", { validationStatus: "not_required", mode: "plan_only" }), true);
});

test("plan-only report states validation was not required", async () => {
  const workspace = await fixtureWorkspace("validation-plan-report");
  try {
    const result = await new CoreOrchestrator({
      workspacePath: workspace,
      providerFactory: () => new ScriptedProvider()
    })
      .planOnly("Explain src/index.ts without changing files.");
    assert.equal(result.run.status, "succeeded");
    assert.ok(result.report.limitations.some((limitation) => limitation.includes("Validation not required")));
    assert.ok(result.report.limitations.some((limitation) => limitation.includes("Plan-only mode")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("validation artifacts and logs keep the existing layout", async () => {
  const workspace = await fixtureWorkspace("validation-layout");
  try {
    const store = new OrchestrationArtifactStore(workspace);
    const runner = new ValidationRunner(workspace, store, {
      validation_timeout: 5_000,
      max_validation_log_size: 2_000,
      safe_commands_allowlist: ["node -e"]
    });
    const runId = "run_validation_layout";
    const result = await runner.runForTask({
      runId,
      task: task(runId, ["node -e \"process.exit(0)\""]),
      commandInventory: inventory([{ command: "node -e \"process.exit(0)\"", kind: "test" }])
    });
    assert.equal(result.validation_status, "passed");
    assert.ok(result.logs_refs.some((ref) => ref.includes(`${path.sep}.agent_memory${path.sep}runs${path.sep}${runId}${path.sep}validation${path.sep}`)));
    const logRef = result.logs_refs.find((ref) => ref.endsWith(".log"));
    assert.ok(logRef);
    assert.match(await readFile(logRef, "utf8"), /status: passed/);
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
      test: "node -e \"process.exit(0)\""
    }
  });
  await writeFile(path.join(root, "src", "index.ts"), "export const value = 1;\n", "utf8");
  return root;
}

function task(runId: string, validationCommands: string[]): Task {
  const now = new Date().toISOString();
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id: "task_validation",
    run_id: runId,
    title: "Validate change",
    objective: "Validate the proposed change.",
    role_required: "ExecutorAgent",
    status: "pending",
    dependencies: [],
    relevant_files: ["src/index.ts"],
    allowed_files_to_edit: ["src/index.ts"],
    forbidden_files: [".agent_memory/"],
    expected_output_schema: "ParsedAgentOutput",
    validation_commands: validationCommands,
    max_attempts: 1,
    attempt_count: 0,
    artifacts: [],
    created_at: now,
    updated_at: now
  };
}

function inventory(entries: Array<{ command: string; kind: "test" | "lint" | "typecheck" | "build" | "smoke" }>): CommandInventory {
  const byKind = {
    test: [] as string[],
    lint: [] as string[],
    typecheck: [] as string[],
    build: [] as string[],
    format: [] as string[],
    smoke: [] as string[],
    dev: [] as string[],
    run: [] as string[],
    unknown: [] as string[]
  };
  for (const entry of entries) byKind[entry.kind].push(entry.command);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    packageManagers: [],
    commands: entries.map((entry, index) => ({
      id: `cmd_${index}`,
      kind: entry.kind,
      command: entry.command,
      cwd: ".",
      sourceFile: "package.json",
      source: "package_json",
      confidence: "high"
    })),
    byKind
  };
}
