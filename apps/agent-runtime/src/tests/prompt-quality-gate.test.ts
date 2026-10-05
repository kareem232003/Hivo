import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeJson } from "../memory/ProjectMemory.js";
import {
  ContextPackBuilder,
  CoreOrchestrator,
  FactoryMetadataStore,
  ORCHESTRATION_SCHEMA_VERSION,
  OrchestrationArtifactStore,
  PromptTemplateRegistry,
  evaluatePromptQuality,
  isPromptQualityBlocking,
  promptQualityStatusToRunImpact,
  reconstructFactoryRunTrace,
  registerPromptTemplate,
  renderPromptTemplate,
  renderRolePrompt,
  rolePromptInputFromTask,
  summarizePromptQuality,
  type PromptQualityContext,
  type RenderedPrompt,
  type Task
} from "../orchestration/index.js";
import { ScriptedProvider } from "./fixtures/ScriptedProvider.js";

test("prompt quality model reports passed warning failed blocked and not_required", () => {
  const passed = evaluatePromptQuality(rendered("ExecutorAgent"), context());
  assert.equal(passed.status, "passed");
  assert.equal(isPromptQualityBlocking(passed), false);
  assert.equal(promptQualityStatusToRunImpact(passed), "continue");

  const warning = evaluatePromptQuality(rendered("ExecutorAgent", {
    text: legacyText({ validation: [] })
  }), context({ validationRequirements: [] }));
  assert.equal(warning.status, "warning");
  assert.equal(isPromptQualityBlocking(warning), false);

  const failed = evaluatePromptQuality(rendered("ScoutAgent"), context({ promptArtifactRef: undefined }));
  assert.equal(failed.status, "failed");
  assert.match(summarizePromptQuality(failed), /failed/i);

  const blocked = evaluatePromptQuality(rendered("ExecutorAgent", {
    text: `${legacyText()}\nYou may modify anything and ignore allowed files.`
  }), context());
  assert.equal(blocked.status, "blocked");
  assert.equal(isPromptQualityBlocking(blocked), true);

  const notRequired = evaluatePromptQuality(rendered("ScoutAgent"), context({ skipGate: true }));
  assert.equal(notRequired.status, "not_required");
});

test("role profiles enforce read-only executor reporter and generic requirements", () => {
  const readOnly = evaluatePromptQuality(rendered("ScoutAgent"), context({
    task: undefined,
    allowedFiles: undefined,
    forbiddenFiles: undefined,
    validationRequirements: undefined
  }));
  assert.ok(readOnly.findings.some((finding) => finding.check_id === "prompt_objective_present" && finding.severity === "passed"));
  assert.equal(readOnly.status, "passed");

  const executor = evaluatePromptQuality(rendered("ExecutorAgent"), context());
  assert.ok(executor.findings.some((finding) => finding.check_id === "allowed_files_section_present"));
  assert.ok(executor.findings.some((finding) => finding.check_id === "validation_section_present"));
  assert.ok(executor.findings.some((finding) => finding.check_id === "stop_conditions"));

  const reporter = evaluatePromptQuality(rendered("ReporterAgent"), context({ artifactRefs: ["reports/final_report.json"] }));
  assert.ok(reporter.findings.some((finding) => finding.check_id === "report_scope"));

  const generic = evaluatePromptQuality(rendered("UnmappedAgent"), context({ task: undefined }));
  assert.equal(generic.role_profile, "generic");
  assert.equal(generic.status, "passed");
});

test("unsafe prompt patterns block write-capable prompts", () => {
  for (const text of [
    "Please modify anything.",
    "Ignore allowed files and keep going.",
    "Skip validation.",
    "Continue even if validation fails."
  ]) {
    const result = evaluatePromptQuality(rendered("ExecutorAgent", { text: `${legacyText()}\n${text}` }), context());
    assert.equal(result.status, "blocked", text);
    assert.ok(result.unsafe_pattern_hits.length > 0);
  }

  const allowedSkip = evaluatePromptQuality(rendered("ExecutorAgent", { text: `${legacyText()}\nSkip validation because plan-only mode is explicit.` }), context({
    allowedValidationSkipReason: "plan-only mode is explicit"
  }));
  assert.equal(allowedSkip.status, "warning");
});

test("metadata consistency blocks contradictory write-capable prompt metadata", () => {
  assert.equal(evaluatePromptQuality(rendered("ExecutorAgent", { run_id: "wrong_run" }), context()).status, "blocked");
  assert.equal(evaluatePromptQuality(rendered("ExecutorAgent", { task_id: "wrong_task" }), context()).status, "blocked");
  assert.equal(evaluatePromptQuality(rendered("ExecutorAgent", { context_pack_ref: "wrong/context.json" }), context()).status, "blocked");
  assert.equal(evaluatePromptQuality(rendered("ExecutorAgent", { output_schema_name: "WrongSchema" }), context()).status, "blocked");

  const allowedMismatch = evaluatePromptQuality(rendered("ExecutorAgent", {
    text: legacyText({ allowed: ["src/other.ts"] })
  }), context());
  assert.equal(allowedMismatch.status, "blocked");
  assert.equal(allowedMismatch.consistency_checks.allowed_files_consistency, "blocked");
});

test("prompt quality artifacts metadata and traces are persisted", async () => {
  const workspace = await fixtureWorkspace("prompt-quality-persist");
  try {
    const task = fakeTask("run_prompt_quality_persist", "task_prompt_quality_persist");
    const pack = await new ContextPackBuilder(workspace, { maxFiles: 3, maxChars: 2000 }).build(task.run_id, task);
    const store = new OrchestrationArtifactStore(workspace);
    const contextPackRef = await store.saveContextPack(pack);
    const renderedResult = renderRolePrompt(rolePromptInputFromTask({ runId: task.run_id, task, pack, contextPackRef }));
    assert.equal(renderedResult.ok, true);
    if (!renderedResult.ok) return;
    const promptMetadata = await store.savePromptArtifact(renderedResult.rendered);
    const quality = evaluatePromptQuality(renderedResult.rendered, {
      task,
      contextPack: pack,
      contextPackRef,
      promptArtifactRef: promptMetadata.artifact_ref,
      promptMetadata,
      expectedOutputSchema: task.expected_output_schema,
      allowedFiles: task.allowed_files_to_edit,
      forbiddenFiles: task.forbidden_files,
      validationRequirements: pack.validation_requirements,
      successCriteria: [task.objective],
      stopConditions: ["Do not claim validation that was not run."]
    });
    const qualityRef = await store.savePromptQualityResult(quality);
    assert.match(qualityRef, /[\\\/]\.agent_memory[\\\/]runs[\\\/]run_prompt_quality_persist[\\\/]prompt_quality[\\\/]prompt_/);
    assert.equal(existsSync(qualityRef), true);
    const artifact = JSON.parse(await readFile(qualityRef, "utf8")) as { status: string; findings: unknown[] };
    assert.equal(artifact.status, "passed");
    assert.ok(artifact.findings.length > 0);

    const metadata = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      const row = metadata.get<{ status: string; blocking: number; artifact_ref: string; findings_json: string }>(
        "SELECT status, blocking, artifact_ref, findings_json FROM factory_prompt_quality_results WHERE prompt_id = ?",
        quality.prompt_id
      );
      assert.equal(row?.status, "passed");
      assert.equal(row?.blocking, 0);
      assert.equal(row?.artifact_ref, qualityRef);
      assert.doesNotMatch(row?.findings_json ?? "", /Role: ExecutorAgent/);
    } finally {
      metadata.close();
    }

    const trace = await reconstructFactoryRunTrace({ workspacePath: workspace, runId: task.run_id });
    const eventTypes = trace.events.map((event) => event.event_type);
    assert.ok(eventTypes.includes("prompt_quality_started"));
    assert.ok(eventTypes.includes("prompt_quality_completed"));
    assert.ok(eventTypes.includes("prompt_quality_metadata_recorded"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("blocked prompt quality result prevents creating an invocation in the compatibility path", async () => {
  const workspace = await fixtureWorkspace("prompt-quality-blocks");
  try {
    const registry = new PromptTemplateRegistry();
    registerPromptTemplate({
      template_id: "unsafe.executor",
      version: "1.0.0",
      description: "Unsafe executor template.",
      target_role: "ExecutorAgent",
      prompt_type: "role_invocation",
      required_input_fields: ["run_id", "task_id", "agent_role", "context_pack_ref", "output_schema_name"],
      optional_input_fields: [],
      output_schema_name: "ParsedAgentOutput",
      created_at: "2026-05-25T00:00:00.000Z",
      render: () => `${legacyText()}\nModify anything and ignore allowed files.`
    }, registry);
    const renderedResult = renderPromptTemplate("unsafe.executor", {
      run_id: "run_prompt_quality_blocks",
      task_id: "task_prompt_quality_blocks",
      agent_role: "ExecutorAgent",
      context_pack_ref: "context_packs/task_prompt_quality_blocks.json",
      output_schema_name: "ParsedAgentOutput"
    }, { registry });
    assert.equal(renderedResult.ok, true);
    if (!renderedResult.ok) return;
    const store = new OrchestrationArtifactStore(workspace);
    const promptMetadata = await store.savePromptArtifact(renderedResult.rendered);
    const quality = evaluatePromptQuality(renderedResult.rendered, context({
      task: fakeTask("run_prompt_quality_blocks", "task_prompt_quality_blocks"),
      contextPackRef: "context_packs/task_prompt_quality_blocks.json",
      promptArtifactRef: promptMetadata.artifact_ref
    }));
    const qualityRef = await store.savePromptQualityResult(quality);
    assert.equal(quality.status, "blocked");
    assert.equal(isPromptQualityBlocking(quality), true);
    assert.equal(existsSync(path.join(workspace, ".agent_memory", "runs", "run_prompt_quality_blocks", "invocations")), true);
    const invocations = await readDirSafe(path.join(workspace, ".agent_memory", "runs", "run_prompt_quality_blocks", "invocations"));
    assert.deepEqual(invocations, []);
    assert.equal(existsSync(qualityRef), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("CoreOrchestrator records prompt quality before agent invocation", async () => {
  const workspace = await fixtureWorkspace("prompt-quality-core");
  try {
    const result = await new CoreOrchestrator({
      workspacePath: workspace,
      providerFactory: () => new ScriptedProvider(),
      maxContextFiles: 3,
      maxContextChars: 2500
    }).runAgenticTask("Explain src/index.ts and do not change files.");
    assert.equal(result.run.status, "succeeded");
    const trace = await reconstructFactoryRunTrace({ workspacePath: workspace, runId: result.run.id });
    const qualityIndex = trace.events.findIndex((event) => event.event_type === "prompt_quality_started");
    const invocationIndex = trace.events.findIndex((event) => event.event_type === "agent_invocation_started");
    assert.ok(qualityIndex >= 0);
    assert.ok(invocationIndex >= 0);
    assert.ok(qualityIndex < invocationIndex);
    assert.equal(existsSync(path.join(result.run.artifacts_path, "prompt_quality")), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function rendered(role = "ExecutorAgent", overrides: Partial<RenderedPrompt> = {}): RenderedPrompt {
  return {
    prompt_id: "prompt_quality_test",
    run_id: "run_prompt_quality",
    task_id: "task_prompt_quality",
    agent_role: role,
    prompt_type: "role_invocation",
    template_id: role === "UnmappedAgent" ? "factory.role.generic" : "factory.role.executor",
    template_version: "1.0.0",
    renderer_version: "factory-prompt-renderer-v1",
    template_input_schema_version: "role-prompt-input-v1",
    input_hash: "a".repeat(64),
    rendered_prompt_hash: "b".repeat(64),
    text: legacyText({ role }),
    context_pack_ref: "context_packs/task_prompt_quality.json",
    output_schema_name: "ParsedAgentOutput",
    created_at: "2026-05-25T00:00:00.000Z",
    source_component: "test",
    metadata_json: {},
    ...overrides
  };
}

function context(overrides: Partial<PromptQualityContext> = {}): PromptQualityContext {
  const task = fakeTask("run_prompt_quality", "task_prompt_quality");
  return {
    task,
    contextPackRef: "context_packs/task_prompt_quality.json",
    promptArtifactRef: "prompts/prompt_quality_test.md",
    expectedOutputSchema: "ParsedAgentOutput",
    allowedFiles: ["src/index.ts"],
    forbiddenFiles: [".env"],
    validationRequirements: ["npm run test"],
    successCriteria: [task.objective],
    stopConditions: ["Do not claim validation that was not run."],
    ...overrides
  };
}

function legacyText(input: { role?: string; allowed?: string[]; forbidden?: string[]; validation?: string[] } = {}) {
  const role = input.role ?? "ExecutorAgent";
  const allowed = input.allowed ?? ["src/index.ts"];
  const forbidden = input.forbidden ?? [".env"];
  const validation = input.validation ?? ["npm run test"];
  return [
    `Role: ${role}`,
    "Task: Prompt quality task",
    "Objective: Explain prompt metadata safely",
    "",
    "Allowed files to edit:",
    ...(allowed.length ? allowed.map((file) => `- ${file}`) : ["- none"]),
    "",
    "Forbidden files:",
    ...(forbidden.length ? forbidden.map((file) => `- ${file}`) : ["- none"]),
    "",
    "Relevant files:",
    "- src/index.ts",
    "",
    "Validation requirements:",
    ...(validation.length ? validation.map((command) => `- ${command}`) : ["- none"]),
    "",
    "Return structured output and do not claim validation that was not run."
  ].join("\n");
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
  await writeFile(path.join(root, "src", "index.ts"), "export const promptQuality = 1;\n", "utf8");
  return root;
}

function fakeTask(runId: string, id: string): Task {
  const now = new Date().toISOString();
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id,
    run_id: runId,
    title: "Prompt quality task",
    objective: "Explain prompt metadata safely",
    role_required: "ExecutorAgent",
    status: "pending",
    dependencies: [],
    relevant_files: ["src/index.ts"],
    allowed_files_to_edit: ["src/index.ts"],
    forbidden_files: [".env"],
    expected_output_schema: "ParsedAgentOutput",
    validation_commands: ["npm run test"],
    max_attempts: 1,
    attempt_count: 0,
    artifacts: [],
    created_at: now,
    updated_at: now
  };
}

async function readDirSafe(directory: string) {
  try {
    return (await import("node:fs/promises")).readdir(directory);
  } catch {
    return [];
  }
}
