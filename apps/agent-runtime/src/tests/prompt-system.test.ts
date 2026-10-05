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
  getPromptTemplate,
  hashPromptInput,
  hashRenderedPrompt,
  reconstructFactoryRunTrace,
  reconstructPromptMetadataForRun,
  registerPromptTemplate,
  renderPromptTemplate,
  renderRolePrompt,
  rolePromptInputFromTask,
  type AgentInvocation,
  type Task
} from "../orchestration/index.js";
import { ScriptedProvider } from "./fixtures/ScriptedProvider.js";

test("prompt registry registers retrieves and falls back for role templates", () => {
  const registry = new PromptTemplateRegistry();
  registerPromptTemplate({
    template_id: "custom.template",
    version: "1.0.0",
    description: "Custom template.",
    target_role: "generic",
    prompt_type: "role_invocation",
    required_input_fields: ["run_id", "task_id", "agent_role", "context_pack_ref", "output_schema_name"],
    optional_input_fields: [],
    output_schema_name: "ParsedAgentOutput",
    created_at: "2026-05-25T00:00:00.000Z",
    render: (input) => `Role: ${input.agent_role}`
  }, registry);

  assert.equal(registry.getPromptTemplate("custom.template", "1.0.0")?.description, "Custom template.");
  assert.equal(registry.getPromptTemplate("missing.template"), undefined);
  assert.equal(getPromptTemplate("factory.role.executor")?.version, "1.0.0");

  const fallback = renderRolePrompt(roleInput({ agent_role: "UnmappedAgent" }));
  assert.equal(fallback.ok, true);
  if (fallback.ok) {
    assert.equal(fallback.rendered.template_id, "factory.role.generic");
    assert.match(fallback.rendered.text, /^Role: UnmappedAgent/m);
  }
});

test("prompt renderer preserves legacy role prompt content and validates required inputs", () => {
  for (const role of ["ScoutAgent", "PlannerAgent", "ExecutorAgent", "ReviewerAgent", "TesterAgent", "ReporterAgent"] as const) {
    const result = renderRolePrompt(roleInput({ agent_role: role }));
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    assert.match(result.rendered.text, new RegExp(`^Role: ${role}`, "m"));
    assert.match(result.rendered.text, /^Task: Task prompt/m);
    assert.match(result.rendered.text, /^Objective: Explain prompt metadata/m);
    assert.match(result.rendered.text, /^- src\/index.ts/m);
    assert.match(result.rendered.text, /^Return structured output and do not claim validation that was not run\.$/m);
    assert.equal(result.rendered.input_hash.length, 64);
    assert.equal(result.rendered.rendered_prompt_hash, hashRenderedPrompt(result.rendered.text));
  }

  const invalid = renderPromptTemplate("factory.role.executor", {
    run_id: "run_prompt_invalid",
    task_id: "task_prompt_invalid",
    agent_role: "ExecutorAgent"
  });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) {
    assert.equal(invalid.error.code, "missing_required_input");
    assert.ok(invalid.error.missing_fields?.includes("context_pack_ref"));
  }

  assert.equal(hashPromptInput(roleInput()), hashPromptInput({ ...roleInput() }));
});

test("prompt artifacts metadata and traces are recorded without moving prompt text into SQLite", async () => {
  const workspace = await fixtureWorkspace("prompt-system-artifact");
  try {
    const task = fakeTask("run_prompt_artifact", "task_prompt_artifact");
    const pack = await new ContextPackBuilder(workspace, { maxFiles: 3, maxChars: 2000 }).build(task.run_id, task);
    const store = new OrchestrationArtifactStore(workspace);
    const contextPackRef = await store.saveContextPack(pack);
    const renderedResult = renderRolePrompt(rolePromptInputFromTask({
      runId: task.run_id,
      task,
      pack,
      contextPackRef,
      sourceComponent: "CoreOrchestrator"
    }));
    assert.equal(renderedResult.ok, true);
    if (!renderedResult.ok) return;

    const promptMetadata = await store.savePromptArtifact(renderedResult.rendered);
    assert.match(promptMetadata.artifact_ref, /[\\\/]\.agent_memory[\\\/]runs[\\\/]run_prompt_artifact[\\\/]prompts[\\\/]prompt_/);
    assert.equal(existsSync(promptMetadata.artifact_ref), true);
    assert.equal(await readFile(promptMetadata.artifact_ref, "utf8"), renderedResult.rendered.text);

    const invocation: AgentInvocation = {
      schema_version: ORCHESTRATION_SCHEMA_VERSION,
      id: "invocation_prompt_artifact",
      run_id: task.run_id,
      task_id: task.id,
      role: "ExecutorAgent",
      prompt: renderedResult.rendered.text,
      context_pack_ref: contextPackRef,
      started_at: new Date().toISOString(),
      status: "running",
      prompt_metadata: {
        prompt_id: promptMetadata.prompt_id,
        prompt_type: promptMetadata.prompt_type,
        template_id: promptMetadata.template_id,
        template_version: promptMetadata.template_version,
        renderer_version: promptMetadata.renderer_version,
        template_input_schema_version: promptMetadata.template_input_schema_version,
        input_hash: promptMetadata.input_hash,
        rendered_prompt_hash: promptMetadata.rendered_prompt_hash,
        context_pack_ref: promptMetadata.context_pack_ref,
        output_schema_name: promptMetadata.output_schema_name,
        prompt_artifact_ref: promptMetadata.artifact_ref,
        source_component: promptMetadata.source_component
      }
    };
    const invocationRef = await store.saveInvocation(invocation);
    assert.equal(existsSync(invocationRef), true);

    const metadata = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      const promptRow = metadata.get<{
        prompt_id: string;
        template_id: string;
        template_version: string;
        renderer_version: string;
        input_hash: string;
        rendered_prompt_hash: string;
        context_pack_ref: string;
        artifact_ref: string;
        agent_role: string;
        output_schema_name: string;
        metadata_json: string;
      }>("SELECT prompt_id, template_id, template_version, renderer_version, input_hash, rendered_prompt_hash, context_pack_ref, artifact_ref, agent_role, output_schema_name, metadata_json FROM factory_prompts WHERE prompt_id = ?", promptMetadata.prompt_id);
      assert.equal(promptRow?.template_id, "factory.role.executor");
      assert.equal(promptRow?.template_version, "1.0.0");
      assert.equal(promptRow?.input_hash, promptMetadata.input_hash);
      assert.equal(promptRow?.rendered_prompt_hash, promptMetadata.rendered_prompt_hash);
      assert.equal(promptRow?.context_pack_ref, contextPackRef);
      assert.equal(promptRow?.artifact_ref, promptMetadata.artifact_ref);
      assert.equal(promptRow?.agent_role, "ExecutorAgent");
      assert.equal(promptRow?.output_schema_name, "ParsedAgentOutput");
      assert.doesNotMatch(promptRow?.metadata_json ?? "", /Return structured output/);
    } finally {
      metadata.close();
    }

    const reconstructed = await reconstructPromptMetadataForRun({ workspacePath: workspace, runId: task.run_id, taskId: task.id });
    assert.equal(reconstructed.length, 1);
    assert.equal(reconstructed[0].prompt_id, promptMetadata.prompt_id);
    assert.equal(reconstructed[0].artifact_ref, promptMetadata.artifact_ref);

    const trace = await reconstructFactoryRunTrace({ workspacePath: workspace, runId: task.run_id });
    const eventTypes = new Set(trace.events.map((event) => event.event_type));
    assert.ok(eventTypes.has("prompt_template_selected"));
    assert.ok(eventTypes.has("prompt_render_started"));
    assert.ok(eventTypes.has("prompt_rendered"));
    assert.ok(eventTypes.has("prompt_artifact_written"));
    assert.ok(eventTypes.has("prompt_metadata_recorded"));
    assert.ok(trace.artifactRefs.includes(promptMetadata.artifact_ref));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("prompt render failures emit structured trace events", async () => {
  const workspace = await fixtureWorkspace("prompt-system-failure");
  try {
    const result = renderPromptTemplate("factory.role.executor", {
      run_id: "run_prompt_failure",
      task_id: "task_prompt_failure",
      agent_role: "ExecutorAgent"
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    await new OrchestrationArtifactStore(workspace).recordPromptRenderFailure(result.error, {
      runId: "run_prompt_failure",
      taskId: "task_prompt_failure"
    });
    const trace = await reconstructFactoryRunTrace({ workspacePath: workspace, runId: "run_prompt_failure" });
    assert.ok(trace.events.some((event) => event.event_type === "prompt_render_failed" && event.severity === "error"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("CoreOrchestrator uses PromptSystem while preserving execution and artifact behavior", async () => {
  const workspace = await fixtureWorkspace("prompt-system-core");
  try {
    const result = await new CoreOrchestrator({
      workspacePath: workspace,
      providerFactory: () => new ScriptedProvider(),
      maxContextFiles: 3,
      maxContextChars: 2500
    }).runAgenticTask("Explain src/index.ts and do not change files.");
    assert.equal(result.run.status, "succeeded");

    const promptsDir = path.join(result.run.artifacts_path, "prompts");
    assert.equal(existsSync(promptsDir), true);
    assert.equal(existsSync(path.join(result.run.artifacts_path, "invocations")), true);

    const prompts = await reconstructPromptMetadataForRun({ workspacePath: workspace, runId: result.run.id });
    assert.ok(prompts.length >= 1);
    assert.ok(prompts.every((prompt) => prompt.template_id.startsWith("factory.role.")));
    assert.ok(prompts.every((prompt) => existsSync(prompt.artifact_ref)));

    const trace = await reconstructFactoryRunTrace({ workspacePath: workspace, runId: result.run.id });
    const eventTypes = new Set(trace.events.map((event) => event.event_type));
    assert.ok(eventTypes.has("prompt_rendered"));
    assert.ok(eventTypes.has("agent_invocation_started"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function roleInput(overrides: Record<string, unknown> = {}) {
  return {
    run_id: "run_prompt_registry",
    task_id: "task_prompt_registry",
    agent_role: "ExecutorAgent",
    task_title: "Task prompt",
    task_objective: "Explain prompt metadata",
    context_pack_ref: ".agent_memory/runs/run_prompt_registry/context_packs/task_prompt_registry.json",
    allowed_files: ["src/index.ts"],
    forbidden_files: [".env"],
    relevant_files: ["src/index.ts", "src/helper.ts"],
    validation_requirements: ["npm run test"],
    expected_output_schema: "ParsedAgentOutput",
    output_schema_name: "ParsedAgentOutput",
    ...overrides
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
  await writeFile(path.join(root, "src", "index.ts"), "export const promptValue = 1;\n", "utf8");
  await writeFile(path.join(root, "src", "helper.ts"), "export const helper = 2;\n", "utf8");
  return root;
}

function fakeTask(runId: string, id: string): Task {
  const now = new Date().toISOString();
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id,
    run_id: runId,
    title: "Prompt task",
    objective: "Explain prompt metadata in src/index.ts",
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
