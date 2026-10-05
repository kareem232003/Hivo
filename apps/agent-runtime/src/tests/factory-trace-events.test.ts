import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { writeJson } from "../memory/ProjectMemory.js";
import {
  CoreOrchestrator,
  FactoryMetadataStore,
  FactoryTraceWriter,
  SwarmAutopilotRuntime,
  createFactoryTraceEvent,
  reconstructFactoryRunTrace,
  transitionRun,
  IntentHandoffGate,
  createAlignmentFromFrame,
  type SwarmWorker
} from "../orchestration/index.js";
import { ScriptedProvider } from "./fixtures/ScriptedProvider.js";

test("factory trace writer inserts SQLite trace events with artifact refs and causal parent links", async () => {
  const workspace = await fixtureWorkspace("factory-trace-sqlite");
  try {
    const writer = new FactoryTraceWriter({ workspacePath: workspace, sourceComponent: "CoreOrchestrator" });
    const runId = "run_trace_sqlite";
    const taskRef = path.join(workspace, ".agent_memory", "runs", runId, "tasks.json");
    const promptRef = path.join(workspace, ".agent_memory", "runs", runId, "invocations", "invocation_trace.json");

    const parent = await writer.write({
      run_id: runId,
      task_id: "task_trace",
      event_type: "task_created",
      lifecycle_stage: "planning",
      summary: "Task trace created.",
      artifact_refs: [taskRef]
    });
    const child = await writer.write({
      run_id: runId,
      task_id: "task_trace",
      event_type: "prompt_created",
      lifecycle_stage: "executing",
      summary: "Prompt trace created.",
      artifact_refs: [promptRef]
    });

    const metadata = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      const rows = metadata.all<{ event_type: string; causal_parent_event_id: string | null; artifact_refs_json: string }>(
        "SELECT event_type, causal_parent_event_id, artifact_refs_json FROM factory_trace_events WHERE run_id = ? ORDER BY created_at",
        runId
      );
      assert.equal(rows.length, 2);
      assert.equal(rows[0].event_type, "task_created");
      assert.equal(rows[1].event_type, "prompt_created");
      assert.equal(rows[1].causal_parent_event_id, parent.trace_event_id);
      assert.equal(child.causal_parent_event_id, parent.trace_event_id);
      assert.deepEqual(JSON.parse(rows[1].artifact_refs_json), [promptRef]);
    } finally {
      metadata.close();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("run transition accepted and rejected trace events are persisted", async () => {
  const workspace = await fixtureWorkspace("factory-trace-transition");
  try {
    const runId = "run_trace_transition";
    const writer = new FactoryTraceWriter({ workspacePath: workspace, sourceComponent: "CoreOrchestrator" });
    const requested = await writer.recordRunTransitionRequested({
      runId,
      previousStatus: "planning",
      nextStatus: "task_graph_ready",
      reason: "Task graph ready.",
      sourceComponent: "CoreOrchestrator"
    });
    const acceptedRecord = transitionRun(runId, "task_graph_ready", {
      currentStatus: "planning",
      reason: "Task graph ready.",
      sourceComponent: "CoreOrchestrator"
    });
    const metadataWriter = await FactoryMetadataStore.open({ workspacePath: workspace });
    try {
      metadataWriter.recordRunTransition(acceptedRecord);
    } finally {
      metadataWriter.close();
    }
    await writer.recordRunTransitionAccepted(acceptedRecord, { causalParentEventId: requested.trace_event_id });

    const rejectedRequest = await writer.recordRunTransitionRequested({
      runId,
      previousStatus: "created",
      nextStatus: "succeeded",
      reason: "Invalid shortcut.",
      sourceComponent: "CoreOrchestrator"
    });
    assert.throws(() => transitionRun(runId, "succeeded", {
      currentStatus: "created",
      reason: "Invalid shortcut.",
      sourceComponent: "CoreOrchestrator"
    }), /Invalid run transition/);
    await writer.recordRunTransitionRejected({
      runId,
      previousStatus: "created",
      nextStatus: "succeeded",
      reason: "Invalid run transition created -> succeeded.",
      sourceComponent: "CoreOrchestrator",
      causalParentEventId: rejectedRequest.trace_event_id
    });

    const metadata = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      const traceRows = metadata.all<{ event_type: string; causal_parent_event_id: string | null; next_status: string }>(
        "SELECT event_type, causal_parent_event_id, next_status FROM factory_trace_events WHERE run_id = ? ORDER BY created_at",
        runId
      );
      assert.ok(traceRows.some((row) => row.event_type === "run_transition_accepted" && row.causal_parent_event_id === requested.trace_event_id));
      assert.ok(traceRows.some((row) => row.event_type === "run_transition_rejected" && row.next_status === "succeeded"));
      const transitionRow = metadata.get<{ next_status: string; source_component: string }>(
        "SELECT next_status, source_component FROM factory_run_transitions WHERE id = ?",
        acceptedRecord.id
      );
      assert.deepEqual(transitionRow, { next_status: "task_graph_ready", source_component: "CoreOrchestrator" });
    } finally {
      metadata.close();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("trace reconstruction returns an ordered timeline and blocked or failed chains", async () => {
  const workspace = await fixtureWorkspace("factory-trace-reconstruct");
  try {
    const runId = "run_trace_reconstruct";
    const metadata = await FactoryMetadataStore.open({ workspacePath: workspace });
    try {
      metadata.recordFactoryTraceEvent(createFactoryTraceEvent({
        trace_event_id: "trace_late",
        run_id: runId,
        event_type: "run_blocked",
        lifecycle_stage: "blocked",
        next_status: "blocked",
        severity: "warning",
        timestamp: "2026-01-01T00:00:03.000Z",
        reason: "Approval required before continuing.",
        summary: "Run blocked."
      }));
      metadata.recordFactoryTraceEvent(createFactoryTraceEvent({
        trace_event_id: "trace_early",
        run_id: runId,
        event_type: "validation_failed",
        lifecycle_stage: "validating",
        severity: "error",
        timestamp: "2026-01-01T00:00:01.000Z",
        reason: "Validation command failed.",
        summary: "Validation failed."
      }));
      metadata.recordFactoryTraceEvent(createFactoryTraceEvent({
        trace_event_id: "trace_missing_parent",
        run_id: runId,
        event_type: "report_completed",
        lifecycle_stage: "reporting",
        causal_parent_event_id: "trace_not_present",
        timestamp: "2026-01-01T00:00:02.000Z",
        summary: "Report completed with missing parent."
      }));
    } finally {
      metadata.close();
    }

    const trace = await reconstructFactoryRunTrace({ workspacePath: workspace, runId });
    assert.deepEqual(trace.events.map((event) => event.trace_event_id), ["trace_early", "trace_missing_parent", "trace_late"]);
    assert.equal(trace.failedValidations.length, 1);
    assert.equal(trace.blockedReasons.length, 1);
    assert.deepEqual(trace.missingExpectedTraceLinks, ["trace_missing_parent:report_completed"]);
    assert.equal(trace.summary.validation_failures, 1);
    assert.equal(trace.summary.blocked_events, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("CoreOrchestrator emits plan-only trace events while preserving artifact layout and events.jsonl", async () => {
  const workspace = await fixtureWorkspace("factory-trace-core-plan");
  try {
    const result = await new CoreOrchestrator({
      workspacePath: workspace,
      providerFactory: () => new ScriptedProvider()
    }).planOnly("Explain src/index.ts without changing files.");
    const trace = await reconstructFactoryRunTrace({ workspacePath: workspace, runId: result.run.id });
    const eventTypes = new Set(trace.events.map((event) => event.event_type));

    assert.equal(result.run.status, "succeeded");
    assert.ok(eventTypes.has("run_created"));
    assert.ok(eventTypes.has("run_transition_requested"));
    assert.ok(eventTypes.has("run_transition_accepted"));
    assert.ok(eventTypes.has("task_created"));
    assert.ok(eventTypes.has("report_started"));
    assert.ok(eventTypes.has("report_completed"));
    assert.equal(trace.summary.rejected_transitions, 0);
    assert.match(result.run.artifacts_path, /[\\\/]\.agent_memory[\\\/]runs[\\\/]run_/);
    assert.equal(existsSync(path.join(result.run.artifacts_path, "events.jsonl")), true);
    assert.equal(existsSync(path.join(result.run.artifacts_path, "reports", "final_report.json")), true);
    const eventsJsonl = await readFile(path.join(result.run.artifacts_path, "events.jsonl"), "utf8");
    assert.match(eventsJsonl, /"type":"run\.created"/);
    assert.match(eventsJsonl, /"type":"task\.created"/);
    assert.ok(result.report.limitations.some((limitation) => limitation.includes("Plan-only mode")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("CoreOrchestrator emits review trace events on the existing mock execution path", async () => {
  const workspace = await fixtureWorkspace("factory-trace-core-review");
  try {
    const result = await new CoreOrchestrator({
      workspacePath: workspace,
      providerFactory: () => new ScriptedProvider(),
      maxContextFiles: 3,
      maxContextChars: 2500
    }).runAgenticTask("Explain src/index.ts and do not change files.");
    const trace = await reconstructFactoryRunTrace({ workspacePath: workspace, runId: result.run.id });
    const eventTypes = new Set(trace.events.map((event) => event.event_type));

    assert.equal(result.run.status, "succeeded");
    assert.ok(eventTypes.has("context_pack_created"));
    assert.ok(eventTypes.has("prompt_created"));
    assert.ok(eventTypes.has("prompt_rendered"));
    assert.ok(eventTypes.has("agent_invocation_started"));
    assert.ok(eventTypes.has("raw_output_saved"));
    assert.ok(eventTypes.has("parsed_output_saved"));
    assert.ok(eventTypes.has("review_started"));
    assert.ok(eventTypes.has("review_completed"));
    assert.ok(eventTypes.has("integration_completed"));
    assert.ok(trace.artifactRefs.some((ref) => ref.includes(`${path.sep}reviews${path.sep}`)));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("active SwarmAutopilotRuntime emits unified trace events and preserves swarm trace artifacts", async () => {
  const workspace = await fixtureWorkspace("factory-trace-swarm");
  try {
    const worker: SwarmWorker = async (input) => {
      const frame = await new IntentHandoffGate({
        workspacePath: workspace
      }).swarmFrame(input.run, input.workItem);

      return {
        schema_version: 1,
        work_item_id: input.workItem.id,
        status: "succeeded",
        summary: `${input.agent.role} handled ${input.workItem.type}.`,
        relevant_files: input.workItem.read_files.filter((entry) => entry.endsWith(".ts")),
        findings: ["ok"],
        risks: [],
        unknowns: [],
        validation_passed: input.workItem.type === "test" ? true : undefined,
        structured_output_valid: true,
        confidence: 0.9,

        intent_alignment: createAlignmentFromFrame(frame, {
          taskUnderstanding: `${input.agent.role} handled ${input.workItem.type}.`,
          originalGoalContribution: "This work item contributes to the requested swarm task."
        })
      };
    };
    const result = await new SwarmAutopilotRuntime({
      workspacePath: workspace,
      worker,
      providerFactory: () => new ScriptedProvider()
    }).run("Fix a small bug in src/index.ts");
    const trace = await reconstructFactoryRunTrace({ workspacePath: workspace, runId: result.run.id });
    const eventTypes = new Set(trace.events.map((event) => event.event_type));

    assert.equal(result.run.status, "succeeded");
    assert.ok(eventTypes.has("run_created"));
    assert.ok(eventTypes.has("policy_decision_recorded"));
    assert.ok(eventTypes.has("task_created"));
    assert.ok(eventTypes.has("agent_invocation_started"));
    assert.ok(eventTypes.has("agent_invocation_completed"));
    assert.ok(eventTypes.has("report_completed"));
    assert.match(result.run.artifacts_path, /[\\\/]\.agent_memory[\\\/]swarm_runs[\\\/]swarm_/);
    assert.equal(existsSync(path.join(result.run.artifacts_path, "events.jsonl")), true);
    assert.equal(existsSync(path.join(result.run.artifacts_path, "scheduler_trace.jsonl")), true);
    const eventsJsonl = await readFile(path.join(result.run.artifacts_path, "events.jsonl"), "utf8");
    assert.match(eventsJsonl, /"type":"swarm\.run\.created"/);
    assert.match(eventsJsonl, /"type":"swarm\.work_item\.queued"/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("unified trace work does not introduce or expand a duplicate SwarmRuntime path", () => {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  assert.equal(existsSync(path.join(packageRoot, "src", "swarm", "SwarmRuntime.ts")), false);
  assert.equal(existsSync(path.join(packageRoot, "src", "orchestration", "SwarmRuntime.ts")), true);
});

async function fixtureWorkspace(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeJson(path.join(root, "package.json"), {
    name: prefix,
    scripts: {
      test: "node -e \"process.exit(0)\"",
      build: "node -e \"process.exit(0)\"",
      typecheck: "node -e \"process.exit(0)\""
    }
  });
  await writeFile(path.join(root, "package-lock.json"), "{}\n", "utf8");
  await writeFile(path.join(root, "src", "index.ts"), [
    "export function greet(name: string) {",
    "  return `hello ${name}`;",
    "}",
    ""
  ].join("\n"), "utf8");
  return root;
}
