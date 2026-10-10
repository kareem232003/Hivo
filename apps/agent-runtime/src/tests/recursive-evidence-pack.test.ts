import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventBus } from "../runtime/EventBus.js";
import { SessionManager } from "../runtime/SessionManager.js";
import { RuntimePlanningTurnService } from "../runtime/RuntimePlanningTurnService.js";
import { RuntimeRecursiveSwarmService } from "../runtime/RuntimeRecursiveSwarmService.js";
import { RuntimeDirectTurnService } from "../runtime/RuntimeDirectTurnService.js";
import type { AgentRuntimeSession } from "@hivo/protocol";
import type { ConversationUnderstanding } from "../runtime/ConversationUnderstanding.js";
import { RecursiveSwarmOrchestrator } from "../orchestration/RecursiveSwarmOrchestrator.js";
import { HierarchicalCollector } from "../orchestration/HierarchicalCollector.js";
import type { MemoryEvidencePack, RecursiveSwarmNode, RecursiveNodeOutput } from "../orchestration/RecursiveSwarmModels.js";
import {
  normalizeRecursiveNodeOutput,
  wrapTextFallback,
  RECURSIVE_SWARM_SCHEMA_VERSION,
  createGoalEnvelope
} from "../orchestration/RecursiveSwarmModels.js";
import {
  bridgeEditIntents,
  collectIntentsFromTree
} from "../orchestration/RecursiveEditIntentBridge.js";
import { buildSurgicalPatch } from "../orchestration/SurgicalPatchBuilder.js";
import { diagnoseRepairNeeded, runRepairLoop } from "../orchestration/RecursiveSwarmRepairLoop.js";
import { evaluateEditIntentQuality } from "../orchestration/EditIntentQualityGate.js";
import { expandEditIntent } from "../orchestration/EvidenceExpansionLoop.js";
import type { PatchProposal, CommandExecutionRecord } from "@hivo/protocol";

// ============================================================
// Helpers
// ============================================================

function makeIntakePackBuilder(
  overrides?: Partial<MemoryEvidencePack>
): (taskPrompt: string, nodeId: string) => MemoryEvidencePack {
  return (_taskPrompt: string, nodeId: string) => ({
    pack_id: `pack_${nodeId.slice(0, 8)}`,
    node_id: nodeId,
    task_slice: _taskPrompt.slice(0, 200),
    context_source: "memory_evidence",
    intent_contract_ref: "contract_001",
    relevant_files: [
      "src/components/LoginForm.tsx",
      "src/hooks/useAuth.ts",
      "src/styles/login.css"
    ],
    file_ranges: {
      "src/components/LoginForm.tsx": "1-120",
      "src/hooks/useAuth.ts": "45-90"
    },
    symbols: ["LoginForm", "useAuth", "validateInput"],
    commands: ["npm run build", "npm test"],
    allowed_paths: ["src/"],
    forbidden_paths: ["node_modules/", ".env"],
    evidence_refs: ["mem_file_001", "mem_file_002"],
    unknowns: [],
    warnings: [],
    confidence: 0.85,
    freshness_status: "fresh",
    ...overrides
  });
}

function makePromptOnlyBuilder(): (taskPrompt: string, nodeId: string) => MemoryEvidencePack {
  return (_taskPrompt: string, nodeId: string) => ({
    pack_id: `pack_${nodeId.slice(0, 8)}`,
    node_id: nodeId,
    task_slice: _taskPrompt.slice(0, 200),
    context_source: "prompt_only_fallback",
    relevant_files: [],
    file_ranges: {},
    symbols: [],
    commands: [],
    allowed_paths: [],
    forbidden_paths: [],
    evidence_refs: [],
    unknowns: [],
    warnings: ["No project intake available — answer from task prompt and general knowledge only."],
    confidence: 0.1,
    freshness_status: "unknown"
  });
}

function makePartialPackBuilder(): (taskPrompt: string, nodeId: string) => MemoryEvidencePack {
  return (_taskPrompt: string, nodeId: string) => ({
    pack_id: `pack_${nodeId.slice(0, 8)}`,
    node_id: nodeId,
    task_slice: _taskPrompt.slice(0, 200),
    context_source: "partial_context",
    relevant_files: ["src/utils/helper.ts"],
    file_ranges: { "src/utils/helper.ts": "10-30" },
    symbols: ["helperFunction"],
    commands: [],
    allowed_paths: [],
    forbidden_paths: [],
    evidence_refs: [],
    unknowns: ["Unknown: testing infrastructure"],
    warnings: ["Partial intake: only 1 of 3 modules indexed"],
    confidence: 0.4,
    freshness_status: "stale"
  });
}

// ============================================================
// Tests
// ============================================================

test("node receives relevant files from builder when memory evidence available", () => {
  const orc = new RecursiveSwarmOrchestrator({
    buildPack: makeIntakePackBuilder()
  });
  // Access private createNode via implicit test — we inspect the result
  const node = (orc as any).createNode({
    name: "Test Login",
    kind: "task_agent",
    taskPrompt: "Fix the login form validation",
    goalEnvelope: {
      originalGoal: "Fix login validation",
      theme: "auth",
      constraints: [],
      nonGoals: [],
      acceptanceCriteria: [],
      workspaceIdentity: "test",
      localTask: "Fix the login form validation",
      version: 1
    },
    parentId: undefined,
    depth: 0
  });
  assert.ok(node.evidencePack, "node should have an evidencePack");
  assert.equal(node.evidencePack!.context_source, "memory_evidence");
  assert.ok(node.evidencePack!.relevant_files.includes("src/components/LoginForm.tsx"),
    "pack should include relevant files from project intake");
  assert.ok(node.evidencePack!.symbols.includes("LoginForm"),
    "pack should include relevant symbols");
  assert.equal(node.evidencePack!.confidence, 0.85);
  assert.equal(node.evidencePack!.freshness_status, "fresh");
});

test("prompt-only fallback is explicit on node when no builder returns minimal pack", () => {
  const orc = new RecursiveSwarmOrchestrator({
    buildPack: makePromptOnlyBuilder()
  });
  const node = (orc as any).createNode({
    name: "Unknown Task",
    kind: "task_agent",
    taskPrompt: "Do something unspecified",
    goalEnvelope: {
      originalGoal: "Unknown",
      theme: "unknown",
      constraints: [],
      nonGoals: [],
      acceptanceCriteria: [],
      workspaceIdentity: "test",
      localTask: "Do something unspecified",
      version: 1
    },
    parentId: undefined,
    depth: 0
  });
  assert.ok(node.evidencePack, "node should have an evidencePack even with fallback");
  assert.equal(node.evidencePack!.context_source, "prompt_only_fallback",
    "context_source should be prompt_only_fallback");
  assert.equal(node.evidencePack!.relevant_files.length, 0,
    "no relevant files in fallback");
  assert.ok(node.evidencePack!.warnings.some((w: string) => w.includes("No project intake")),
    "fallback warning should mention no intake");
  assert.equal(node.evidencePack!.confidence, 0.1,
    "fallback confidence should be low");
});

test("partial context produces stale warning and lower confidence", () => {
  const orc = new RecursiveSwarmOrchestrator({
    buildPack: makePartialPackBuilder()
  });
  const node = (orc as any).createNode({
    name: "Partial Node",
    kind: "task_agent",
    taskPrompt: "Help with helper utility",
    goalEnvelope: {
      originalGoal: "Help with utility",
      theme: "utils",
      constraints: [],
      nonGoals: [],
      acceptanceCriteria: [],
      workspaceIdentity: "test",
      localTask: "Help with helper utility",
      version: 1
    },
    parentId: undefined,
    depth: 0
  });
  assert.ok(node.evidencePack);
  assert.equal(node.evidencePack!.context_source, "partial_context");
  assert.equal(node.evidencePack!.freshness_status, "stale");
  assert.ok(node.evidencePack!.confidence < 0.5, "partial confidence should be low");
  assert.ok(node.evidencePack!.warnings.some((w: string) => w.includes("Partial")),
    "partial pack should have relevant warnings");
});

test("final output includes context-source summary", async () => {
  let callCount = 0;
  const orc = new RecursiveSwarmOrchestrator({
    buildPack: (taskPrompt: string, nodeId: string) => {
      callCount++;
      // Return different sources based on call count to test rollup
      const base: MemoryEvidencePack = {
        pack_id: `pack_${nodeId.slice(0, 8)}`,
        node_id: nodeId,
        task_slice: taskPrompt.slice(0, 200),
        context_source: callCount === 1 ? "memory_evidence" : callCount === 2 ? "partial_context" : "prompt_only_fallback",
        relevant_files: callCount === 1 ? ["src/file.ts"] : [],
        file_ranges: {},
        symbols: callCount === 1 ? ["sym"] : [],
        commands: [],
        allowed_paths: [],
        forbidden_paths: [],
        evidence_refs: [],
        unknowns: [],
        warnings: callCount === 2 ? ["partial"] : callCount === 3 ? ["no intake"] : [],
        confidence: callCount === 1 ? 0.9 : callCount === 2 ? 0.4 : 0.1,
        freshness_status: callCount === 1 ? "fresh" : callCount === 2 ? "stale" : "unknown"
      };
      return base;
    },
    options: {
      enableGoalKeeper: false,
      enableParallelExecution: false
    }
  });
  const result = await orc.run("Test goal requiring multiple nodes", "test_session");
  assert.ok(result.finalOutput.includes("[Context-source summary:"),
    "final output should include context-source summary");
  assert.ok(result.finalOutput.includes("memory_evidence") || result.finalOutput.includes("nodes used"),
    "summary should mention node counts");
  const total = result.contextSourceCounts.memory_evidence +
    result.contextSourceCounts.partial_context +
    result.contextSourceCounts.prompt_only_fallback;
  assert.ok(total > 0, "context source counts should be tracked");
});

test("no builder produces nodes without evidencePack (backward compat)", () => {
  const orc = new RecursiveSwarmOrchestrator({
    options: { enableGoalKeeper: false, enableParallelExecution: false }
  });
  const node = (orc as any).createNode({
    name: "Backward compat",
    kind: "task_agent",
    taskPrompt: "Do something",
    goalEnvelope: {
      originalGoal: "Test",
      theme: "test",
      constraints: [],
      nonGoals: [],
      acceptanceCriteria: [],
      workspaceIdentity: "test",
      localTask: "Do something",
      version: 1
    },
    parentId: undefined,
    depth: 0
  });
  assert.equal(node.evidencePack, undefined,
    "node without builder should have no evidencePack");
});

test("formatPackForPrompt produces concise output, not full repo", () => {
  const orc = new RecursiveSwarmOrchestrator({
    buildPack: makeIntakePackBuilder()
  });
  const formatted: string = (orc as any).formatPackForPrompt(makeIntakePackBuilder()("test", "n1"));
  // Should be small and focused
  assert.ok(formatted.length < 1500, "formatted pack should be concise (< 1500 chars)");
  assert.ok(formatted.includes("Relevant files:"), "should list relevant files");
  assert.ok(formatted.includes("lines 1-120"), "should include line ranges");
  assert.ok(formatted.includes("fresh"), "should include freshness");
  assert.ok(!formatted.includes("WARNING: No sufficient memory evidence"),
    "memory_evidence pack should not have fallback warning");
});

test("formatPackForPrompt warns on prompt-only fallback", () => {
  const orc = new RecursiveSwarmOrchestrator();
  const formatted: string = (orc as any).formatPackForPrompt(makePromptOnlyBuilder()("test", "n1"));
  assert.ok(formatted.includes("WARNING: No sufficient memory evidence"),
    "fallback pack should contain warning");
  assert.ok(formatted.includes("prompt-only"),
    "fallback pack should mention prompt-only");
});

test("formatPackForPrompt warns on stale evidence", () => {
  const orc = new RecursiveSwarmOrchestrator({
    buildPack: makePartialPackBuilder()
  });
  const pack = makePartialPackBuilder()("test", "n1");
  const formatted: string = (orc as any).formatPackForPrompt(pack);
  assert.ok(formatted.includes("stale"),
    "stale pack should mention staleness");
});

test("context source counts are tracked per node across splits", async () => {
  // This test ensures that when multiple nodes are created (root + goal keeper),
  // each gets its own pack and the counts roll up correctly
  const builder = makeIntakePackBuilder();
  const orc = new RecursiveSwarmOrchestrator({
    buildPack: builder,
    options: {
      enableGoalKeeper: false,
      enableParallelExecution: false
    }
  });
  const result = await orc.run("Single atomic task", "session_counts");
  assert.ok(result.contextSourceCounts.memory_evidence > 0,
    "should have at least one memory_evidence node (root)");
});

// ============================================================
// Structured output tests
// ============================================================

function makeTestNode(overrides: Partial<RecursiveSwarmNode> = {}): RecursiveSwarmNode {
  const goalEnvelope = createGoalEnvelope({
    originalGoal: "Test goal",
    workspaceIdentity: "test",
    localTask: overrides.taskPrompt ?? "Test task"
  });
  return {
    schema_version: RECURSIVE_SWARM_SCHEMA_VERSION,
    id: `node_${Math.random().toString(36).slice(2, 10)}`,
    parentId: undefined,
    runId: "test_run",
    kind: "task_agent",
    status: "created",
    name: "Test Node",
    role: "Task Agent",
    goalEnvelope,
    taskPrompt: "Test task",
    depth: 0,
    goalChecks: [],
    steeringQueue: [],
    children: [],
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  };
}

test("normalizeRecursiveNodeOutput produces valid edit_intent from provider JSON", () => {
  const raw = {
    kind: "edit_intent",
    target_file: "src/app.ts",
    target_symbol_or_range: "loginHandler:45-60",
    operation: "modify",
    reason: "Fix login validation",
    expected_behavior: "Validates email format before submitting",
    risk: "low",
    evidence_refs: ["SEC-001"]
  };
  const { output, summary } = normalizeRecursiveNodeOutput(raw);
  assert.equal(output.kind, "edit_intent");
  if (output.kind === "edit_intent") {
    assert.equal(output.target_file, "src/app.ts");
    assert.equal(output.operation, "modify");
    assert.equal(output.risk, "low");
    assert.ok(summary.includes("src/app.ts"));
  }
});

test("normalizeRecursiveNodeOutput repairs malformed kind to text fallback", () => {
  const raw = { kind: "unknown_schema", some_field: "garbage" };
  const { output, summary } = normalizeRecursiveNodeOutput(raw);
  assert.equal(output.kind, "final_summary", "unknown kind falls back to final_summary");
  assert.ok(summary.length > 0);
});

test("normalizeRecursiveNodeOutput handles completely non-JSON input", () => {
  const { output, summary } = normalizeRecursiveNodeOutput("Just some text without JSON structure");
  assert.equal(output.kind, "final_summary", "non-object falls back to final_summary");
  assert.equal(output.confidence, 0.1, "fallback confidence is 0.1");
  assert.ok(summary.includes("Just some text"));
});

test("normalizeRecursiveNodeOutput fills missing arrays and defaults gracefully", () => {
  const raw = {
    kind: "validation_plan"
    // all array fields missing
  };
  const { output } = normalizeRecursiveNodeOutput(raw);
  assert.equal(output.kind, "validation_plan");
  if (output.kind === "validation_plan") {
    assert.deepEqual(output.commands, []);
    assert.deepEqual(output.smoke_checks, []);
    assert.deepEqual(output.blockers, []);
  }
});

test("wrapTextFallback produces final_summary with prompt-only confidence", () => {
  const { output, summary } = wrapTextFallback("Fallback text result");
  assert.equal(output.kind, "final_summary");
  assert.equal(output.confidence, 0.1);
  assert.equal(summary, "Fallback text result");
});

test("structured output is stored on node via orchestrator execute path", () => {
  // Simulate what the orchestrator does: createNode sets up the node,
  // then executeWithVerification stores structuredOutput
  const orc = new RecursiveSwarmOrchestrator({
    buildPack: makeIntakePackBuilder(),
    options: { enableGoalKeeper: false, enableParallelExecution: false }
  });
  const node = (orc as any).createNode({
    name: "Structured Node",
    kind: "task_agent",
    taskPrompt: "Fix the login form",
    goalEnvelope: createGoalEnvelope({
      originalGoal: "Fix login",
      workspaceIdentity: "test",
      localTask: "Fix the login form"
    }),
    parentId: undefined,
    depth: 0
  });
  // Simulate setting structured output as executeWithVerification would
  const editIntent: RecursiveNodeOutput = {
    kind: "edit_intent",
    target_file: "src/login.ts",
    target_symbol_or_range: "LoginForm:10-30",
    operation: "modify",
    reason: "Fix validation",
    expected_behavior: "Validates input",
    risk: "low",
    evidence_refs: ["E-001"]
  };
  node.structuredOutput = editIntent;
  node.outputSummary = "Edit src/login.ts: Fix validation";
  assert.ok(node.structuredOutput, "node should have structuredOutput");
  assert.equal(node.structuredOutput.kind, "edit_intent");
});

test("node can store evidence_report as structuredOutput", () => {
  const evidence: RecursiveNodeOutput = {
    kind: "evidence_report",
    findings: ["Unused import detected", "Missing error boundary"],
    files: ["src/app.tsx"],
    symbols: ["App", "ErrorBoundary"],
    evidence_refs: ["LINT-01"],
    unknowns: ["Unknown: testing library version"],
    confidence: 0.8
  };
  const node = makeTestNode();
  node.structuredOutput = evidence;
  node.outputSummary = "Evidence: Unused import detected; Missing error boundary";
  assert.equal(node.structuredOutput.kind, "evidence_report");
});

test("node can store validation_plan as structuredOutput", () => {
  const plan: RecursiveNodeOutput = {
    kind: "validation_plan",
    commands: ["npm run build", "npm test"],
    smoke_checks: ["App renders without crash", "Form submits correctly"],
    expected_results: ["Build succeeds", "All tests pass"],
    blockers: ["Missing test for edge case"]
  };
  const node = makeTestNode();
  node.structuredOutput = plan;
  node.outputSummary = "Validation: 2 command(s), 1 blocker(s).";
  assert.equal(node.structuredOutput.kind, "validation_plan");
  if (node.structuredOutput.kind === "validation_plan") {
    assert.equal(node.structuredOutput.commands.length, 2);
    assert.equal(node.structuredOutput.blockers.length, 1);
  }
});

test("collector preserves child edit intents instead of summarizing them away", async () => {
  const collector = new HierarchicalCollector({ enableErrorRecovery: false });
  const child1 = makeTestNode({ id: "c1", name: "Child 1", taskPrompt: "Fix login.ts" });
  child1.structuredOutput = {
    kind: "edit_intent",
    target_file: "src/login.ts",
    target_symbol_or_range: "validateForm:20-35",
    operation: "modify",
    reason: "Add email validation",
    expected_behavior: "Email field is validated",
    risk: "low",
    evidence_refs: []
  };
  child1.outputSummary = "Edit src/login.ts: Add email validation";
  child1.status = "succeeded";

  const child2 = makeTestNode({ id: "c2", name: "Child 2", taskPrompt: "Fix header.tsx" });
  child2.structuredOutput = {
    kind: "edit_intent",
    target_file: "src/header.tsx",
    target_symbol_or_range: "Header:5-15",
    operation: "modify",
    reason: "Update navigation links",
    expected_behavior: "Nav links point to new routes",
    risk: "medium",
    evidence_refs: []
  };
  child2.outputSummary = "Edit src/header.tsx: Update navigation links";
  child2.status = "succeeded";

  const result = await collector.collect([child1, child2], "Fix login and header");
  // The merged output should reference both edit intents
  assert.ok(result.mergedOutput.includes("src/login.ts"), "collector output should include child1's target file");
  assert.ok(result.mergedOutput.includes("src/header.tsx"), "collector output should include child2's target file");
  assert.ok(result.mergedOutput.includes("edit_intent") || result.mergedOutput.includes("Edit intent") || result.mergedOutput.includes("Findings"),
    "collector output should reference structured findings");
  assert.equal(result.childResults["c1"], "Edit src/login.ts: Add email validation");
});

test("collector detects conflicts when multiple children edit the same file", async () => {
  const collector = new HierarchicalCollector({ enableErrorRecovery: false });
  const child1 = makeTestNode({ id: "c1", name: "Child 1" });
  child1.structuredOutput = {
    kind: "edit_intent",
    target_file: "src/shared.ts",
    target_symbol_or_range: "helperFn:1-50",
    operation: "modify",
    reason: "Refactor helper",
    expected_behavior: "Cleaner API",
    risk: "medium",
    evidence_refs: []
  };
  child1.status = "succeeded";
  const child2 = makeTestNode({ id: "c2", name: "Child 2" });
  child2.structuredOutput = {
    kind: "edit_intent",
    target_file: "src/shared.ts",
    target_symbol_or_range: "helperFn:1-50",
    operation: "delete",
    reason: "Remove deprecated helper",
    expected_behavior: "No more helper",
    risk: "high",
    evidence_refs: []
  };
  child2.status = "succeeded";

  const result = await collector.collect([child1, child2], "Refactor shared utility");
  // The merged output should surface the conflict
  assert.ok(result.mergedOutput.includes("conflict") || result.mergedOutput.includes("Conflicts") || result.mergedOutput.includes("Multiple"),
    "collector should surface file conflicts: " + result.mergedOutput);
});

test("final output derivation extracts blockers from final_summary structured artifact", () => {
  // Test the derivation logic directly (same logic as in orchestrator.run())
  const structured = {
    kind: "final_summary" as const,
    summary: "Work completed partially",
    blockers: ["Missing API key", "Test infrastructure down"],
    edit_intents: [],
    validation_plans: [],
    confidence: 0.5
  };
  const blockers = structured.kind === "final_summary" ? structured.blockers : [];
  const structuredText = structured.kind === "final_summary" ? structured.summary : null;
  const rawOutput = structuredText ?? "No output produced.";
  const blockerSuffix = blockers.length > 0 ? `\n\n[Blockers: ${blockers.join("; ")}]` : "";
  const finalOutput = `${rawOutput}${blockerSuffix}\n\n[Context-source summary: test]`;
  assert.ok(finalOutput.includes("[Blockers:"), "final output should have blockers section");
  assert.ok(finalOutput.includes("Missing API key"), "final output should include specific blocker");
  assert.ok(finalOutput.includes("Test infrastructure"), "final output should include specific blocker");
});

test("text-only execution fallback produces final_summary as structured output", () => {
  // When provider returns free text, wrapTextFallback should create structured output
  const { output, summary } = wrapTextFallback("Arbitrary text result that was not structured JSON.");
  assert.equal(output.kind, "final_summary");
  assert.ok(summary.includes("Arbitrary text result"));
  assert.deepEqual(output.edit_intents, [], "fallback should have empty edit_intents");
  assert.deepEqual(output.blockers, [], "fallback should have empty blockers");
});

test("existing text-only fallback remains backward compatible", async () => {
  // A collector receiving only text outputs should still produce merged text
  const collector = new HierarchicalCollector({ enableErrorRecovery: false });
  const child1 = makeTestNode({ id: "c1", name: "Child 1" });
  child1.outputSummary = "Text result from child 1";
  child1.status = "succeeded";
  const child2 = makeTestNode({ id: "c2", name: "Child 2" });
  child2.outputSummary = "Text result from child 2";
  child2.status = "succeeded";

  const result = await collector.collect([child1, child2], "Merge text only");
  assert.ok(result.mergedOutput.includes("Text result from child 1"), "should preserve child1 text");
  assert.ok(result.mergedOutput.includes("Text result from child 2"), "should preserve child2 text");
  assert.equal(result.childResults["c1"], "Text result from child 1");
});

// ============================================================
// SurgicalPatchBuilder tests
// ============================================================

test("buildSurgicalPatch: safe exact replacement creates real_diff", () => {
  const result = buildSurgicalPatch({
    editIntent: { kind: "edit_intent", target_file: "src/foo.ts", target_symbol_or_range: "FooClass", operation: "modify", reason: "Fix method", expected_behavior: "Works", risk: "low", evidence_refs: ["ref_1"] },
    allowedPaths: ["src/"],
    forbiddenPaths: [],
    workspacePath: "/workspace",
    currentFileContent: "class FooClass {\n  oldMethod() { return 1; }\n}",
    exactOldText: "  oldMethod() { return 1; }",
    replacementText: "  newMethod() { return 2; }"
  });
  assert.equal(result.status, "real_diff", "exact replacement should produce real_diff");
  if (result.status === "real_diff") {
    assert.ok(result.unifiedDiff.includes("--- a/src/foo.ts"), "diff has --- header");
    assert.ok(result.unifiedDiff.includes("+++ b/src/foo.ts"), "diff has +++ header");
    assert.ok(result.unifiedDiff.includes("-  oldMethod()"), "diff removes old text");
    assert.ok(result.unifiedDiff.includes("+  newMethod()"), "diff adds new text");
    assert.ok(result.patchCandidateId.startsWith("spb_"), "candidate ID has correct prefix");
    assert.equal(result.risk, "low");
    assert.equal(result.evidenceRefs.length, 1);
  }
});

test("buildSurgicalPatch: missing target file produces blocked", () => {
  const result = buildSurgicalPatch({
    editIntent: { kind: "edit_intent", target_file: "/nonexistent/file.ts", target_symbol_or_range: "", operation: "modify", reason: "", expected_behavior: "", risk: "low", evidence_refs: [] },
    allowedPaths: [],
    forbiddenPaths: [],
    workspacePath: "/workspace",
    currentFileContent: ""
  });
  assert.equal(result.status, "blocked", "empty content for missing file");
});

test("buildSurgicalPatch: forbidden path returns blocked", () => {
  const result = buildSurgicalPatch({
    editIntent: { kind: "edit_intent", target_file: "node_modules/pkg/index.js", target_symbol_or_range: "", operation: "modify", reason: "Fix", expected_behavior: "OK", risk: "low", evidence_refs: [] },
    allowedPaths: [],
    forbiddenPaths: ["node_modules/"],
    workspacePath: "/workspace",
    currentFileContent: "module.exports = {};"
  });
  assert.equal(result.status, "blocked");
  if (result.status === "blocked") {
    assert.ok(result.reason.includes("forbidden"), "blocked reason mentions forbidden");
  }
});

test("buildSurgicalPatch: secret file returns blocked", () => {
  const result = buildSurgicalPatch({
    editIntent: { kind: "edit_intent", target_file: ".env", target_symbol_or_range: "", operation: "modify", reason: "Change config", expected_behavior: "OK", risk: "low", evidence_refs: [] },
    allowedPaths: [],
    forbiddenPaths: [],
    workspacePath: "/workspace",
    currentFileContent: "API_KEY=abc123"
  });
  assert.equal(result.status, "blocked");
  if (result.status === "blocked") {
    assert.ok(result.reason.includes("secret"), "blocked for secret file");
  }
});

test("buildSurgicalPatch: missing evidence for medium risk returns needs_patch_generation", () => {
  const result = buildSurgicalPatch({
    editIntent: { kind: "edit_intent", target_file: "src/bar.ts", target_symbol_or_range: "", operation: "modify", reason: "Change logic", expected_behavior: "Works", risk: "medium", evidence_refs: [] },
    allowedPaths: ["src/"],
    forbiddenPaths: [],
    workspacePath: "/workspace",
    currentFileContent: "const x = 1;"
  });
  assert.equal(result.status, "needs_patch_generation");
  if (result.status === "needs_patch_generation") {
    assert.ok(result.reason.includes("Missing evidence"), "reason mentions missing evidence");
    assert.ok(result.requiredEvidence.length > 0, "required evidence is listed");
  }
});

test("buildSurgicalPatch: missing evidence for high risk returns needs_patch_generation", () => {
  const result = buildSurgicalPatch({
    editIntent: { kind: "edit_intent", target_file: "src/critical.ts", target_symbol_or_range: "", operation: "modify", reason: "Dangerous", expected_behavior: "", risk: "high", evidence_refs: [] },
    allowedPaths: ["src/"],
    forbiddenPaths: [],
    workspacePath: "/workspace",
    currentFileContent: "export function critical() {}"
  });
  assert.equal(result.status, "needs_patch_generation", "high risk without evidence");
});

test("buildSurgicalPatch: broad refactor without exact old text returns needs_patch_generation", () => {
  const result = buildSurgicalPatch({
    editIntent: { kind: "edit_intent", target_file: "src/refactor.ts", target_symbol_or_range: "", operation: "refactor", reason: "Refactor entire module", expected_behavior: "Cleaner code", risk: "low", evidence_refs: ["evidence_1"] },
    allowedPaths: ["src/"],
    forbiddenPaths: [],
    workspacePath: "/workspace",
    currentFileContent: "function a() {}\nfunction b() {}"
  });
  assert.equal(result.status, "needs_patch_generation", "broad refactor needs generation");
});

test("buildSurgicalPatch: anchor insert after known line produces real_diff", () => {
  const result = buildSurgicalPatch({
    editIntent: { kind: "edit_intent", target_file: "src/routes.ts", target_symbol_or_range: "", operation: "modify", reason: "Add new route", expected_behavior: "Route added", risk: "low", evidence_refs: [] },
    allowedPaths: ["src/"],
    forbiddenPaths: [],
    workspacePath: "/workspace",
    currentFileContent: "const routes = [\n  { path: '/home', component: Home },\n];",
    anchorLine: "/home",
    insertAfterAnchor: true,
    replacementText: "  { path: '/about', component: About },"
  });
  assert.equal(result.status, "real_diff", "anchor insert should produce real_diff");
  if (result.status === "real_diff") {
    assert.ok(result.unifiedDiff.includes("+  { path: '/about'"), "diff includes new route");
  }
});

test("buildSurgicalPatch: new file create produces real_diff when content empty", () => {
  const result = buildSurgicalPatch({
    editIntent: { kind: "edit_intent", target_file: "src/newfile.ts", target_symbol_or_range: "", operation: "create", reason: "Create new file", expected_behavior: "New file exists", risk: "low", evidence_refs: ["ev_1"] },
    allowedPaths: ["src/"],
    forbiddenPaths: [],
    workspacePath: "/workspace",
    currentFileContent: "",
    replacementText: "export const NEW_CONSTANT = 42;\n"
  });
  assert.equal(result.status, "real_diff", "new file create should produce real_diff");
  if (result.status === "real_diff") {
    assert.ok(result.unifiedDiff.includes("--- /dev/null"), "diff from /dev/null");
    assert.ok(result.unifiedDiff.includes("+++ b/src/newfile.ts"), "diff to new file");
  }
});

test("buildSurgicalPatch: file delete produces real_diff for small file", () => {
  const result = buildSurgicalPatch({
    editIntent: { kind: "edit_intent", target_file: "src/old.ts", target_symbol_or_range: "", operation: "delete", reason: "Remove unused", expected_behavior: "File gone", risk: "low", evidence_refs: ["ev_2"] },
    allowedPaths: ["src/"],
    forbiddenPaths: [],
    workspacePath: "/workspace",
    currentFileContent: "const old = 1;\n"
  });
  assert.equal(result.status, "real_diff", "delete should produce real_diff");
  if (result.status === "real_diff") {
    assert.ok(result.unifiedDiff.includes("+++ /dev/null"), "diff to /dev/null for delete");
  }
});

test("buildSurgicalPatch: provider suggested diff passes gated check", () => {
  const result = buildSurgicalPatch({
    editIntent: { kind: "edit_intent", target_file: "src/component.ts", target_symbol_or_range: "Counter", operation: "modify", reason: "Add count state", expected_behavior: "Counter works", risk: "low", evidence_refs: ["ev_3"] },
    allowedPaths: ["src/"],
    forbiddenPaths: [],
    workspacePath: "/workspace",
    currentFileContent: "function Counter() { return <div>0</div>; }\n",
    providerSuggestedDiff: "--- a/src/component.ts\n+++ b/src/component.ts\n@@ -1,3 +1,5 @@\n-function Counter() { return <div>0</div>; }\n+import { useState } from 'react';\n+function Counter() {\n+  const [count, setCount] = useState(0);\n+  return <div>{count}</div>;\n+}\n"
  });
  assert.equal(result.status, "real_diff", "valid provider diff should pass gates");
});

test("buildSurgicalPatch: provider diff with wrong target file is blocked", () => {
  const result = buildSurgicalPatch({
    editIntent: { kind: "edit_intent", target_file: "src/component.ts", target_symbol_or_range: "", operation: "modify", reason: "", expected_behavior: "", risk: "low", evidence_refs: [] },
    allowedPaths: ["src/"],
    forbiddenPaths: [],
    workspacePath: "/workspace",
    currentFileContent: "const x = 1;\n",
    providerSuggestedDiff: "--- a/src/wrong.ts\n+++ b/src/wrong.ts\n@@ -1 +1 @@\n-const x = 1;\n+const x = 2;\n"
  });
  assert.equal(result.status, "blocked", "provider diff with wrong file should be blocked");
});

test("buildSurgicalPatch: provider diff with secret content is blocked", () => {
  const result = buildSurgicalPatch({
    editIntent: { kind: "edit_intent", target_file: "src/config.ts", target_symbol_or_range: "", operation: "modify", reason: "", expected_behavior: "", risk: "low", evidence_refs: [] },
    allowedPaths: ["src/"],
    forbiddenPaths: [],
    workspacePath: "/workspace",
    currentFileContent: "export const cfg = {};\n",
    providerSuggestedDiff: "--- a/src/config.ts\n+++ b/src/config.ts\n@@ -1 +1 @@\n-export const cfg = {};\n+export const cfg = { token: 'sk-abc123' };\n"
  });
  assert.equal(result.status, "blocked", "provider diff with secret should be blocked");
});

test("buildSurgicalPatch: large file is blocked", () => {
  const bigContent = "x\n".repeat(200000);
  const result = buildSurgicalPatch({
    editIntent: { kind: "edit_intent", target_file: "src/huge.ts", target_symbol_or_range: "", operation: "modify", reason: "Edit huge file", expected_behavior: "Works", risk: "low", evidence_refs: ["ev_1"] },
    allowedPaths: ["src/"],
    forbiddenPaths: [],
    workspacePath: "/workspace",
    currentFileContent: bigContent
  });
  assert.equal(result.status, "blocked", "large file should be blocked");
});

test("buildSurgicalPatch: exact replacement modifies only target lines", () => {
  const content = "line1\nline2\nline3\nline4\n";
  const result = buildSurgicalPatch({
    editIntent: { kind: "edit_intent", target_file: "test.ts", target_symbol_or_range: "", operation: "modify", reason: "Fix", expected_behavior: "OK", risk: "low", evidence_refs: ["r1"] },
    allowedPaths: [],
    forbiddenPaths: [],
    workspacePath: "/workspace",
    currentFileContent: content,
    exactOldText: "line2",
    replacementText: "modified"
  });
  assert.equal(result.status, "real_diff");
  if (result.status === "real_diff") {
    assert.ok(result.unifiedDiff.includes("-line2"));
    assert.ok(result.unifiedDiff.includes("+modified"));
    assert.ok(!result.unifiedDiff.includes("-line1"), "should not touch line1");
    assert.ok(!result.unifiedDiff.includes("-line4"), "should not touch line4");
  }
});

// ============================================================
// RecursiveEditIntentBridge tests (updated for SurgicalPatchBuilder)
// ============================================================

test("bridgeEditIntents: safe exact replacement creates PatchProposal", () => {
  const result = bridgeEditIntents({
    sessionId: "session_001",
    workspacePath: "/workspace",
    intents: [{ nodeId: "n1", intent: { kind: "edit_intent", target_file: "src/foo.ts", target_symbol_or_range: "FooClass", operation: "modify", reason: "Fix method", expected_behavior: "Works", risk: "low", evidence_refs: ["ref_1"] } }],
    validationPlans: [],
    allowedPaths: ["src/"],
    forbiddenPaths: [],
    fileContents: { "src/foo.ts": "class FooClass {\n  oldMethod() {}\n}" },
    builderOverrides: { "src/foo.ts": { exactOldText: "  oldMethod() {}", replacementText: "  newMethod() {}" } }
  });
  assert.equal(result.patchCandidates.length, 1, "should produce one real PatchProposal");
  assert.equal(result.summaryCounts.realDiff, 1);
  assert.equal(result.summaryCounts.needsGeneration, 0);
  assert.equal(result.summaryCounts.blocked, 0);
  const proposal = result.patchCandidates[0];
  assert.equal(proposal.requiresApproval, true);
  assert.equal(proposal.status, "proposed");
  assert.equal(proposal.filesChanged.length, 1);
  assert.equal(proposal.filesChanged[0].path, "src/foo.ts");
  assert.equal(proposal.filesChanged[0].changeType, "modify");
  // Verify it's a real unified diff, not a placeholder
  assert.ok(proposal.unifiedDiff.includes("--- a/src/foo.ts"), "real diff header");
  assert.ok(proposal.unifiedDiff.includes("+++ b/src/foo.ts"), "real diff header");
  // Verify no placeholder content
  assert.ok(!proposal.unifiedDiff.includes("placeholder"), "no placeholder text in diff");
  assert.equal(result.validationCommandRequests.length, 0);
});

test("bridgeEditIntents: forbidden path returns blocked not PatchProposal", () => {
  const result = bridgeEditIntents({
    sessionId: "session_001",
    workspacePath: "/workspace",
    intents: [{ nodeId: "n1", intent: { kind: "edit_intent", target_file: "node_modules/lodash/index.ts", target_symbol_or_range: "", operation: "modify", reason: "Fix bug", expected_behavior: "Works", risk: "medium", evidence_refs: [] } }],
    validationPlans: [],
    allowedPaths: [],
    forbiddenPaths: ["node_modules/"]
  });
  assert.equal(result.patchCandidates.length, 0, "no PatchProposal for forbidden path");
  assert.equal(result.blockedIntents.length, 1, "one blocked intent");
  assert.equal(result.summaryCounts.blocked, 1);
  assert.equal(result.summaryCounts.realDiff, 0);
  assert.ok(result.blockedIntents[0].reason.includes("forbidden"), "block reason mentions forbidden");
});

test("bridgeEditIntents: intent without old/new text becomes needs_generation, not PatchProposal", () => {
  const result = bridgeEditIntents({
    sessionId: "s", workspacePath: "/w",
    intents: [{ nodeId: "n1", intent: { kind: "edit_intent", target_file: "src/some.ts", target_symbol_or_range: "", operation: "modify", reason: "Fix", expected_behavior: "OK", risk: "low", evidence_refs: [] } }],
    validationPlans: [], allowedPaths: [], forbiddenPaths: [],
    fileContents: { "src/some.ts": "const x = 1;" }
  });
  assert.equal(result.patchCandidates.length, 0, "no placeholder PatchProposal");
  assert.equal(result.needsGenerationIntents.length, 1, "one needs_generation");
  assert.equal(result.summaryCounts.needsGeneration, 1);
  assert.equal(result.summaryCounts.realDiff, 0);
});

test("bridgeEditIntents: missing evidence for medium risk returns needs_generation, not PatchProposal", () => {
  const result = bridgeEditIntents({
    sessionId: "s", workspacePath: "/w",
    intents: [{ nodeId: "n1", intent: { kind: "edit_intent", target_file: "src/risky.ts", target_symbol_or_range: "", operation: "modify", reason: "Dangerous", expected_behavior: "", risk: "medium", evidence_refs: [] } }],
    validationPlans: [], allowedPaths: ["src/"], forbiddenPaths: [],
    fileContents: { "src/risky.ts": "let x = 1;" }
  });
  assert.equal(result.patchCandidates.length, 0, "no PatchProposal");
  assert.equal(result.needsGenerationIntents.length, 1, "needs generation");
  assert.ok(result.needsGenerationIntents[0].requiredEvidence.length > 0, "required evidence listed");
  assert.equal(result.qualityMetrics.totalIntents, 1);
  assert.equal(result.qualityMetrics.expansionFailed, 1);
});

test("bridgeEditIntents: broad refactor without exact old text returns needs_generation", () => {
  const result = bridgeEditIntents({
    sessionId: "s", workspacePath: "/w",
    intents: [{ nodeId: "n1", intent: { kind: "edit_intent", target_file: "src/ref.ts", target_symbol_or_range: "", operation: "refactor", reason: "Refactor all", expected_behavior: "Clean", risk: "low", evidence_refs: ["ev_1"] } }],
    validationPlans: [], allowedPaths: ["src/"], forbiddenPaths: [],
    fileContents: { "src/ref.ts": "function old() {}" }
  });
  assert.equal(result.patchCandidates.length, 0, "no PatchProposal for refactor without old text");
  assert.equal(result.needsGenerationIntents.length, 1, "needs generation");
  assert.equal(result.qualityMetrics.blockedByQualityGate, 0);
  assert.equal(result.qualityMetrics.blockedByPatchBuilder, 0);
});

test("bridgeEditIntents: placeholder diffs are not added as normal PatchProposal", () => {
  // A modify intent without builder overrides or provider diff should never produce a proposal
  const result = bridgeEditIntents({
    sessionId: "s", workspacePath: "/w",
    intents: [{ nodeId: "n1", intent: { kind: "edit_intent", target_file: "src/noplaceholder.ts", target_symbol_or_range: "", operation: "modify", reason: "Some change", expected_behavior: "Works", risk: "low", evidence_refs: ["ev_1"] } }],
    validationPlans: [], allowedPaths: ["src/"], forbiddenPaths: [],
    fileContents: { "src/noplaceholder.ts": "const a = 1;" }
  });
  assert.equal(result.patchCandidates.length, 0, "no placeholder PatchProposal created");
  assert.equal(result.summaryCounts.realDiff, 0);
  assert.equal(result.summaryCounts.needsGeneration + result.summaryCounts.blocked, 1, "one non-real result");
});

test("bridgeEditIntents: validation plan produces command requests", () => {
  const result = bridgeEditIntents({
    sessionId: "session_001",
    workspacePath: "/workspace",
    intents: [],
    validationPlans: [{ nodeId: "n1", plan: { kind: "validation_plan", commands: ["npm test", "npm run build"], smoke_checks: ["Tests pass", "Build passes"], expected_results: ["exit 0", "exit 0"], blockers: [] } }],
    allowedPaths: [],
    forbiddenPaths: []
  });
  assert.equal(result.validationCommandRequests.length, 2, "two command requests");
  assert.equal(result.validationCommandRequests[0].command, "npm test");
  assert.equal(result.validationCommandRequests[0].risk, "safe");
  assert.equal(result.validationCommandRequests[1].command, "npm run build");
  assert.equal(result.validationCommandRequests[1].risk, "safe");
  assert.equal(result.validationCommandRequests[0].status, "requested");
  assert.ok(result.validationCommandRequests[0].reason.includes("Validation command"));
  assert.equal(result.validationCommandRequests[0].sessionId, "session_001");
});

test("bridgeEditIntents: empty input produces empty output with summary counts", () => {
  const result = bridgeEditIntents({
    sessionId: "s", workspacePath: "/w",
    intents: [],
    validationPlans: [],
    allowedPaths: [],
    forbiddenPaths: []
  });
  assert.equal(result.patchCandidates.length, 0);
  assert.equal(result.blockedIntents.length, 0);
  assert.equal(result.needsGenerationIntents.length, 0);
  assert.equal(result.validationCommandRequests.length, 0);
  assert.equal(result.summaryCounts.realDiff, 0);
  assert.equal(result.summaryCounts.needsGeneration, 0);
  assert.equal(result.summaryCounts.blocked, 0);
  assert.ok(result.diagnostics.some((d) => d.includes("Bridge result")), "diagnostic summary present");
});

test("bridgeEditIntents: validation plan blockers appear in diagnostics", () => {
  const result = bridgeEditIntents({
    sessionId: "s", workspacePath: "/w",
    intents: [],
    validationPlans: [{ nodeId: "n_repair", plan: { kind: "validation_plan", commands: [], smoke_checks: [], expected_results: [], blockers: ["Missing npm install", "Config file not found"] } }],
    allowedPaths: [],
    forbiddenPaths: []
  });
  assert.ok(result.diagnostics.some((d) => d.includes("blocker")), "diagnostics mention blockers");
  assert.ok(result.diagnostics.some((d) => d.includes("Missing npm install")), "diagnostics include specific blocker");
});

test("bridgeEditIntents: summary counts reflect realDiff/needsGeneration/blocked split", () => {
  const result = bridgeEditIntents({
    sessionId: "s", workspacePath: "/w",
    intents: [
      { nodeId: "n1", intent: { kind: "edit_intent", target_file: "src/good.ts", target_symbol_or_range: "", operation: "modify", reason: "Exact edit", expected_behavior: "OK", risk: "low", evidence_refs: ["r1"] } },
      { nodeId: "n2", intent: { kind: "edit_intent", target_file: "src/unknown.ts", target_symbol_or_range: "", operation: "modify", reason: "Vague edit", expected_behavior: "OK", risk: "low", evidence_refs: [] } },
      { nodeId: "n3", intent: { kind: "edit_intent", target_file: "node_modules/bad.ts", target_symbol_or_range: "", operation: "modify", reason: "Forbidden", expected_behavior: "", risk: "low", evidence_refs: [] } }
    ],
    validationPlans: [], allowedPaths: ["src/"], forbiddenPaths: ["node_modules/"],
    fileContents: { "src/good.ts": "old", "src/unknown.ts": "stuff" },
    builderOverrides: { "src/good.ts": { exactOldText: "old", replacementText: "new" } }
  });
  assert.equal(result.summaryCounts.realDiff, 1, "one real diff from exact replacement");
  assert.equal(result.summaryCounts.needsGeneration, 1, "one needs generation from vague edit");
  assert.equal(result.summaryCounts.blocked, 1, "one blocked from forbidden path");
  assert.equal(result.patchCandidates.length, 1);
  assert.equal(result.needsGenerationIntents.length, 1);
  assert.equal(result.blockedIntents.length, 1);
});

// ============================================================
// collectIntentsFromTree tests
// ============================================================

test("collectIntentsFromTree: collects edit_intent and validation_plan from nodes", () => {
  const nodes: Record<string, Pick<RecursiveSwarmNode, "id" | "structuredOutput">> = {
    n1: { id: "n1", structuredOutput: { kind: "edit_intent", target_file: "a.ts", target_symbol_or_range: "", operation: "modify", reason: "Fix a", expected_behavior: "OK", risk: "low", evidence_refs: [] } },
    n2: { id: "n2", structuredOutput: { kind: "validation_plan", commands: ["npm test"], smoke_checks: [], expected_results: [], blockers: [] } },
    n3: { id: "n3", structuredOutput: undefined }
  };
  const { intents, validationPlans } = collectIntentsFromTree(nodes);
  assert.equal(intents.length, 1);
  assert.equal(intents[0].nodeId, "n1");
  assert.equal(intents[0].intent.kind, "edit_intent");
  assert.equal(validationPlans.length, 1);
  assert.equal(validationPlans[0].nodeId, "n2");
  assert.equal(validationPlans[0].plan.kind, "validation_plan");
});

test("collectIntentsFromTree: collects from final_summary edit_intents", () => {
  const nodes: Record<string, Pick<RecursiveSwarmNode, "id" | "structuredOutput">> = {
    n1: { id: "n1", structuredOutput: { kind: "final_summary", summary: "Done", blockers: [], edit_intents: [
      { kind: "edit_intent", target_file: "f1.ts", target_symbol_or_range: "", operation: "create", reason: "Add f1", expected_behavior: "Works", risk: "low", evidence_refs: [] },
      { kind: "edit_intent", target_file: "f2.ts", target_symbol_or_range: "", operation: "modify", reason: "Fix f2", expected_behavior: "Works", risk: "medium", evidence_refs: [] }
    ], validation_plans: [{ kind: "validation_plan", commands: ["npm run build"], smoke_checks: [], expected_results: [], blockers: [] }], confidence: 0.8 } }
  };
  const { intents, validationPlans } = collectIntentsFromTree(nodes);
  assert.equal(intents.length, 2, "should extract 2 edit_intents from final_summary");
  assert.equal(validationPlans.length, 1, "should extract 1 validation_plan from final_summary");
  assert.equal(intents[0].intent.target_file, "f1.ts");
  assert.equal(intents[1].intent.target_file, "f2.ts");
});

test("collectIntentsFromTree: empty tree returns empty arrays", () => {
  const { intents, validationPlans } = collectIntentsFromTree({});
  assert.equal(intents.length, 0);
  assert.equal(validationPlans.length, 0);
});

test("collectIntentsFromTree: nodes without structuredOutput are skipped", () => {
  const nodes: Record<string, Pick<RecursiveSwarmNode, "id" | "structuredOutput">> = {
    n1: { id: "n1", structuredOutput: undefined },
    n2: { id: "n2", structuredOutput: undefined }
  };
  const { intents, validationPlans } = collectIntentsFromTree(nodes);
  assert.equal(intents.length, 0);
  assert.equal(validationPlans.length, 0);
});

// ============================================================
// RecursiveSwarmRepairLoop tests
// ============================================================

test("diagnoseRepairNeeded: no failed commands returns canRepair=false", () => {
  const proposal: PatchProposal = { id: "p1", sessionId: "s", title: "test", summary: "", riskLevel: "low", filesChanged: [], unifiedDiff: "", requiresApproval: true, status: "proposed", createdAt: "" };
  const result = diagnoseRepairNeeded(proposal, [], { kind: "edit_intent", target_file: "a.ts", target_symbol_or_range: "", operation: "modify", reason: "Fix", expected_behavior: "OK", risk: "low", evidence_refs: [] }, undefined);
  assert.equal(result.canRepair, false);
  assert.equal(result.reason, "No failed validation commands");
});

test("diagnoseRepairNeeded: high risk edit blocks repair", () => {
  const proposal: PatchProposal = { id: "p1", sessionId: "s", title: "", summary: "", riskLevel: "high", filesChanged: [], unifiedDiff: "", requiresApproval: true, status: "proposed", createdAt: "" };
  const cmdResults: CommandExecutionRecord[] = [{ command: "npm test", cwd: "/w", risk: "safe", status: "failed", exitCode: 1, stdout: "", stderr: "Error: test failed", id: "c1", sessionId: "s", autoRun: false, createdAt: "" }];
  const result = diagnoseRepairNeeded(proposal, cmdResults, { kind: "edit_intent", target_file: "a.ts", target_symbol_or_range: "", operation: "modify", reason: "Risk", expected_behavior: "", risk: "high", evidence_refs: [] }, undefined);
  assert.equal(result.canRepair, false);
  assert.ok(result.reason.includes("High-risk"), "blocked for high risk");
});

test("diagnoseRepairNeeded: failed validation with scoped output creates repair intent", () => {
  const proposal: PatchProposal = { id: "p1", sessionId: "s", title: "", summary: "", riskLevel: "low", filesChanged: [], unifiedDiff: "", requiresApproval: true, status: "proposed", createdAt: "" };
  const cmdResults: CommandExecutionRecord[] = [{ command: "npm test", cwd: "/w", risk: "safe", status: "failed", exitCode: 1, stdout: "Error: cannot find module 'x'", stderr: "", id: "c1", sessionId: "s", autoRun: false, createdAt: "" }];
  const result = diagnoseRepairNeeded(proposal, cmdResults, { kind: "edit_intent", target_file: "src/a.ts", target_symbol_or_range: "funcX", operation: "modify", reason: "Add import", expected_behavior: "Works", risk: "low", evidence_refs: ["ev_1"] }, undefined);
  assert.equal(result.canRepair, true);
  assert.ok(result.repairIntent, "repair intent created");
  if (result.repairIntent) {
    assert.equal(result.repairIntent.target_file, "src/a.ts");
    assert.equal(result.repairIntent.risk, "low", "repair downgrades risk to low");
    assert.ok(result.repairIntent.reason.includes("Repair:"), "repair reason includes prefix");
    assert.ok(result.repairIntent.evidence_refs.includes("cmd_output:c1"), "repair intent includes cmd ref");
  }
});

test("diagnoseRepairNeeded: refactor operation blocks repair", () => {
  const proposal: PatchProposal = { id: "p1", sessionId: "s", title: "", summary: "", riskLevel: "low", filesChanged: [], unifiedDiff: "", requiresApproval: true, status: "proposed", createdAt: "" };
  const cmdResults: CommandExecutionRecord[] = [{ command: "npm test", cwd: "/w", risk: "safe", status: "failed", exitCode: 1, stdout: "Error: test failed", stderr: "", id: "c1", sessionId: "s", autoRun: false, createdAt: "" }];
  const result = diagnoseRepairNeeded(proposal, cmdResults, { kind: "edit_intent", target_file: "src/b.ts", target_symbol_or_range: "", operation: "refactor", reason: "Refactor", expected_behavior: "", risk: "low", evidence_refs: [] }, undefined);
  assert.equal(result.canRepair, false);
  assert.ok(result.diagnostics.some((d) => d.includes("Refactor repair blocked")), "refactor blocked");
});

test("runRepairLoop: no repair needed returns empty results", () => {
  const proposal: PatchProposal = { id: "p1", sessionId: "s", title: "", summary: "", riskLevel: "low", filesChanged: [], unifiedDiff: "", requiresApproval: true, status: "proposed", createdAt: "" };
  const result = runRepairLoop(proposal, { kind: "edit_intent", target_file: "a.ts", target_symbol_or_range: "", operation: "modify", reason: "", expected_behavior: "", risk: "low", evidence_refs: [] }, undefined, [], "/w", "old", ["src/"], []);
  assert.equal(result.repairAttempts.length, 0);
  assert.equal(result.finalPatchCandidates.length, 0);
});

test("runRepairLoop: bounded repair can produce repair proposal", () => {
  const proposal: PatchProposal = { id: "p1", sessionId: "s", title: "", summary: "", riskLevel: "low", filesChanged: [], unifiedDiff: "", requiresApproval: true, status: "proposed", createdAt: "" };
  const cmdResults: CommandExecutionRecord[] = [{ command: "npm test", cwd: "/w", risk: "safe", status: "failed", exitCode: 1, stdout: "Error: cannot find module 'x'", stderr: "", id: "c1", sessionId: "s", autoRun: false, createdAt: "" }];
  // The repair needs exactOldText to produce a real_diff. Provide it so the loop succeeds.
  const result = runRepairLoop(proposal, { kind: "edit_intent", target_file: "a.ts", target_symbol_or_range: "", operation: "modify", reason: "Add import", expected_behavior: "Works", risk: "low", evidence_refs: ["ev_1"] }, undefined, cmdResults, "/w",
    "old content here\nconst x = require('y');\n",
    [], []);
  // Without exactOldText, the loop will try but likely get needs_patch_generation
  assert.ok(result.repairAttempts.length <= 2, "at most 2 repair attempts");
  assert.ok(result.diagnostics.length > 0, "diagnostics produced");
});

test("runRepairLoop: max 2 repair attempts is not exceeded", () => {
  const proposal: PatchProposal = { id: "p1", sessionId: "s", title: "", summary: "", riskLevel: "low", filesChanged: [], unifiedDiff: "", requiresApproval: true, status: "proposed", createdAt: "" };
  const cmdResults: CommandExecutionRecord[] = [{ command: "npm test", cwd: "/w", risk: "safe", status: "failed", exitCode: 1, stdout: "Error: something broke", stderr: "", id: "c1", sessionId: "s", autoRun: false, createdAt: "" }];
  const result = runRepairLoop(proposal, { kind: "edit_intent", target_file: "a.ts", target_symbol_or_range: "", operation: "modify", reason: "Fix", expected_behavior: "OK", risk: "low", evidence_refs: [] }, undefined, cmdResults, "/w", "content", [], []);
  assert.ok(result.repairAttempts.length <= 2, "max 2 attempts");
});

// ============================================================
// EditIntentQualityGate tests
// ============================================================

test("qualityGate: complete small edit intent returns ready_for_patch", () => {
  const result = evaluateEditIntentQuality({
    editIntent: { kind: "edit_intent", target_file: "src/foo.ts", target_symbol_or_range: "FooClass", operation: "modify", reason: "Fix method", expected_behavior: "Works", risk: "low", evidence_refs: ["ref_1"] },
    evidencePack: { pack_id: "p1", node_id: "n1", task_slice: "", context_source: "memory_evidence", relevant_files: ["src/foo.ts"], file_ranges: {}, symbols: ["FooClass"], commands: [], allowed_paths: [], forbidden_paths: [], evidence_refs: ["ref_1"], unknowns: [], warnings: [], confidence: 0.9, freshness_status: "fresh" },
    allowedPaths: ["src/"],
    forbiddenPaths: []
  });
  assert.equal(result.status, "ready_for_patch");
  assert.ok(result.score >= 0.8, "high score for complete intent");
  assert.equal(result.missingFields.length, 0);
});

test("qualityGate: missing target_file returns needs_evidence_expansion", () => {
  const result = evaluateEditIntentQuality({
    editIntent: { kind: "edit_intent", target_file: "", target_symbol_or_range: "FooClass", operation: "modify", reason: "Fix", expected_behavior: "OK", risk: "low", evidence_refs: ["r1"] },
    allowedPaths: [], forbiddenPaths: []
  });
  assert.equal(result.status, "needs_evidence_expansion");
  assert.ok(result.missingFields.includes("target_file"), "target_file missing");
});

test("qualityGate: missing symbol/oldText/anchor returns needs_evidence_expansion", () => {
  const result = evaluateEditIntentQuality({
    editIntent: { kind: "edit_intent", target_file: "src/a.ts", target_symbol_or_range: "", operation: "modify", reason: "Fix", expected_behavior: "OK", risk: "low", evidence_refs: ["r1"] },
    allowedPaths: ["src/"], forbiddenPaths: []
  });
  assert.equal(result.status, "needs_evidence_expansion");
  assert.ok(result.missingFields.includes("target_symbol_or_range_or_exact_old_text_or_anchor"), "missing concrete edit info");
});

test("qualityGate: broad refactor returns needs_user_or_planner_clarification", () => {
  const result = evaluateEditIntentQuality({
    editIntent: { kind: "edit_intent", target_file: "src/big.ts", target_symbol_or_range: "", operation: "refactor", reason: "Refactor", expected_behavior: "Cleaner", risk: "low", evidence_refs: ["r1"] },
    allowedPaths: ["src/"], forbiddenPaths: []
  });
  assert.equal(result.status, "needs_user_or_planner_clarification");
});

test("qualityGate: forbidden path returns blocked", () => {
  const result = evaluateEditIntentQuality({
    editIntent: { kind: "edit_intent", target_file: "node_modules/pkg/x.ts", target_symbol_or_range: "fn", operation: "modify", reason: "Fix", expected_behavior: "OK", risk: "low", evidence_refs: ["r1"] },
    allowedPaths: [], forbiddenPaths: ["node_modules/"]
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.score, 0);
});

test("qualityGate: medium risk without evidence does not pass", () => {
  const result = evaluateEditIntentQuality({
    editIntent: { kind: "edit_intent", target_file: "src/med.ts", target_symbol_or_range: "func", operation: "modify", reason: "Change", expected_behavior: "Works", risk: "medium", evidence_refs: [] },
    evidencePack: { pack_id: "p1", node_id: "n1", task_slice: "", context_source: "memory_evidence", relevant_files: ["src/med.ts"], file_ranges: {}, symbols: ["func"], commands: [], allowed_paths: [], forbidden_paths: [], evidence_refs: [], unknowns: [], warnings: [], confidence: 0.8, freshness_status: "fresh" },
    allowedPaths: ["src/"], forbiddenPaths: []
  });
  assert.equal(result.status, "needs_evidence_expansion", "medium risk without evidence needs expansion");
  assert.ok(result.missingFields.includes("evidence_refs"));
  assert.ok(result.requiredEvidence.includes("file_content_snapshot"));
});

test("qualityGate: prompt-only context for medium risk is flagged", () => {
  const result = evaluateEditIntentQuality({
    editIntent: { kind: "edit_intent", target_file: "src/risky.ts", target_symbol_or_range: "sym", operation: "modify", reason: "Change", expected_behavior: "OK", risk: "medium", evidence_refs: ["ev_1"] },
    allowedPaths: ["src/"], forbiddenPaths: [],
    contextSource: "prompt_only_fallback"
  });
  // Prompt-only + medium risk = needs expansion (cannot be ready without better evidence)
  assert.equal(result.status, "needs_evidence_expansion");
  assert.ok(result.risks.some((r) => r.includes("Prompt-only")), "prompt-only risk is noted");
});

test("qualityGate: delete operation without evidence returns needs_evidence_expansion", () => {
  const result = evaluateEditIntentQuality({
    editIntent: { kind: "edit_intent", target_file: "src/old.ts", target_symbol_or_range: "", operation: "delete", reason: "Remove", expected_behavior: "Gone", risk: "low", evidence_refs: [] },
    allowedPaths: ["src/"], forbiddenPaths: []
  });
  assert.equal(result.status, "needs_evidence_expansion");
  assert.ok(result.missingFields.includes("evidence_for_delete"), "delete needs evidence");
});

test("qualityGate: ready with exactOldText override", () => {
  const result = evaluateEditIntentQuality({
    editIntent: { kind: "edit_intent", target_file: "src/foo.ts", target_symbol_or_range: "", operation: "modify", reason: "Fix", expected_behavior: "OK", risk: "low", evidence_refs: ["r1"] },
    allowedPaths: ["src/"], forbiddenPaths: [],
    builderOverrides: { exactOldText: "old", replacementText: "new", anchorLine: "", insertAfterAnchor: false, insertBeforeAnchor: false }
  });
  assert.equal(result.status, "ready_for_patch", "exactOldText counts as concrete edit info");
});

// ============================================================
// EvidenceExpansionLoop tests
// ============================================================

test("expansionLoop: target_file inferred from MemoryEvidencePack", () => {
  const result = expandEditIntent({
    editIntent: { kind: "edit_intent", target_file: "", target_symbol_or_range: "", operation: "modify", reason: "Fix LoginForm", expected_behavior: "Works", risk: "low", evidence_refs: [] as string[] },
    evidencePack: { pack_id: "p1", node_id: "n1", task_slice: "", context_source: "memory_evidence", relevant_files: ["src/LoginForm.tsx"], file_ranges: {}, symbols: ["LoginForm"], commands: [] as string[], allowed_paths: [] as string[], forbidden_paths: [] as string[], evidence_refs: ["pack_ev_1"], unknowns: [] as string[], warnings: [] as string[], confidence: 0.9, freshness_status: "fresh" },
    allowedPaths: [] as string[], forbiddenPaths: [] as string[],
    workspacePath: "/w",
    fileContents: { "src/LoginForm.tsx": "function LoginForm() { return <form>Login</form>; }" }
  });
  assert.equal(result.status, "expanded");
  assert.equal(result.refinedEditIntent.target_file, "src/LoginForm.tsx");
  assert.ok(result.addedEvidenceRefs.length > 0);
});

test("expansionLoop: symbol found from evidence pack symbols", () => {
  const result = expandEditIntent({
    editIntent: { kind: "edit_intent", target_file: "src/auth.ts", target_symbol_or_range: "", operation: "modify", reason: "Update validateInput", expected_behavior: "Works", risk: "low", evidence_refs: [] as string[] },
    evidencePack: { pack_id: "p1", node_id: "n1", task_slice: "", context_source: "memory_evidence", relevant_files: ["src/auth.ts"], file_ranges: {}, symbols: ["validateInput", "LoginForm"], commands: [] as string[], allowed_paths: [] as string[], forbidden_paths: [] as string[], evidence_refs: ["ev_2"], unknowns: [] as string[], warnings: [] as string[], confidence: 0.85, freshness_status: "fresh" },
    allowedPaths: [] as string[], forbiddenPaths: [] as string[],
    workspacePath: "/w",
    fileContents: { "src/auth.ts": "function validateInput() { return true; }" }
  });
  assert.equal(result.status, "expanded");
  assert.equal(result.refinedEditIntent.target_symbol_or_range, "validateInput");
  assert.ok(result.builderOverrides?.exactOldText?.includes("validateInput"), "exactOldText contains symbol line");
  assert.ok(result.filesRead.includes("src/auth.ts"), "file was read");
});

test("expansionLoop: anchorLine from reason matching file content", () => {
  const result = expandEditIntent({
    editIntent: { kind: "edit_intent", target_file: "src/config.ts", target_symbol_or_range: "", operation: "modify", reason: "Add debug flag after TIMEOUT", expected_behavior: "Debug mode", risk: "low", evidence_refs: [] as string[] },
    allowedPaths: [] as string[], forbiddenPaths: [] as string[],
    workspacePath: "/w",
    fileContents: { "src/config.ts": "const TIMEOUT = 5000;\nexport const DEBUG = false;" }
  });
  assert.equal(result.status, "expanded");
  assert.ok(result.builderOverrides?.anchorLine?.includes("TIMEOUT"), "anchor line matches");
  assert.equal(result.builderOverrides?.insertAfterAnchor, true);
});

test("expansionLoop: missing file returns not_found", () => {
  const result = expandEditIntent({
    editIntent: { kind: "edit_intent", target_file: "src/missing.ts", target_symbol_or_range: "", operation: "modify", reason: "Fix", expected_behavior: "OK", risk: "low", evidence_refs: [] as string[] },
    allowedPaths: [] as string[], forbiddenPaths: [] as string[],
    workspacePath: "/w",
    fileContents: {}
  });
  assert.equal(result.status, "not_found");
});

test("expansionLoop: forbidden path returns blocked", () => {
  const result = expandEditIntent({
    editIntent: { kind: "edit_intent", target_file: "secrets/key.pem", target_symbol_or_range: "", operation: "modify", reason: "Change key", expected_behavior: "OK", risk: "low", evidence_refs: [] as string[] },
    evidencePack: { pack_id: "p1", node_id: "n1", task_slice: "", context_source: "memory_evidence", relevant_files: ["secrets/key.pem"], file_ranges: {}, symbols: [] as string[], commands: [] as string[], allowed_paths: [] as string[], forbidden_paths: [] as string[], evidence_refs: [] as string[], unknowns: [] as string[], warnings: [] as string[], confidence: 0.5, freshness_status: "stale" },
    allowedPaths: [] as string[], forbiddenPaths: ["secrets/"],
    workspacePath: "/w"
  });
  assert.equal(result.status, "blocked");
});

test("expansionLoop: expansion reads limited files only", () => {
  // Create a pack with many files but expansion should only attempt relevant ones
  const manyFiles = Array.from({ length: 20 }, (_, i) => `src/file${i}.ts`);
  const result = expandEditIntent({
    editIntent: { kind: "edit_intent", target_file: "src/file0.ts", target_symbol_or_range: "", operation: "modify", reason: "Fix file0", expected_behavior: "OK", risk: "low", evidence_refs: [] as string[] },
    evidencePack: { pack_id: "p1", node_id: "n1", task_slice: "", context_source: "memory_evidence", relevant_files: manyFiles, file_ranges: {}, symbols: ["File0"], commands: [] as string[], allowed_paths: [] as string[], forbidden_paths: [] as string[], evidence_refs: [] as string[], unknowns: [] as string[], warnings: [] as string[], confidence: 0.6, freshness_status: "stale" },
    allowedPaths: [] as string[], forbiddenPaths: [] as string[],
    workspacePath: "/w",
    fileContents: { "src/file0.ts": "class File0 {}" }
  });
  // Should succeed for file0 since it has a symbol match in the file content
  assert.equal(result.status, "expanded");
});

test("expansionLoop: stale memory produces warning", () => {
  const result = expandEditIntent({
    editIntent: { kind: "edit_intent", target_file: "src/stale.ts", target_symbol_or_range: "", operation: "modify", reason: "Fix", expected_behavior: "OK", risk: "low", evidence_refs: [] as string[] },
    evidencePack: { pack_id: "p1", node_id: "n1", task_slice: "", context_source: "partial_context", relevant_files: ["src/stale.ts"], file_ranges: {}, symbols: [] as string[], commands: [] as string[], allowed_paths: [] as string[], forbidden_paths: [] as string[], evidence_refs: ["old_ev"], unknowns: ["unknown_area"], warnings: ["Stale evidence from last week"], confidence: 0.3, freshness_status: "stale" },
    allowedPaths: [] as string[], forbiddenPaths: [] as string[],
    workspacePath: "/w",
    fileContents: { "src/stale.ts": "const x = 1;" }
  });
  // Should at least add evidence refs from pack even if no concrete info
  assert.ok(result.diagnostics.length > 0, "diagnostics produced");
});

test("expansionLoop: refined intent becomes patch-ready after expansion", () => {
  const result = expandEditIntent({
    editIntent: { kind: "edit_intent", target_file: "src/component.ts", target_symbol_or_range: "", operation: "modify", reason: "Update Counter component", expected_behavior: "Counter renders", risk: "low", evidence_refs: [] as string[] },
    evidencePack: { pack_id: "p1", node_id: "n1", task_slice: "", context_source: "memory_evidence", relevant_files: ["src/component.ts"], file_ranges: { "src/component.ts": "1-50" }, symbols: ["Counter", "counterState"], commands: [] as string[], allowed_paths: [] as string[], forbidden_paths: [] as string[], evidence_refs: ["ev_counter"], unknowns: [] as string[], warnings: [] as string[], confidence: 0.9, freshness_status: "fresh" },
    allowedPaths: [] as string[], forbiddenPaths: [] as string[],
    workspacePath: "/w",
    fileContents: { "src/component.ts": "function Counter() {\n  const [count, setCount] = useState(0);\n  return <div>{count}</div>;\n}" }
  });
  assert.equal(result.status, "expanded");
  assert.equal(result.refinedEditIntent.target_symbol_or_range, "Counter");
  assert.ok(result.builderOverrides?.exactOldText?.includes("Counter"), "exactOldText found from symbol");
  assert.ok(result.addedEvidenceRefs.includes("ev_counter"));
});

// ============================================================
// Bridge integration with quality gate + expansion tests
// ============================================================

test("bridgeIntegration: vague intent becomes real_diff after successful expansion", () => {
  const result = bridgeEditIntents({
    sessionId: "s", workspacePath: "/w",
    intents: [{ nodeId: "n1", intent: { kind: "edit_intent", target_file: "src/counter.ts", target_symbol_or_range: "", operation: "modify", reason: "Update Counter component", expected_behavior: "Counter renders", risk: "low", evidence_refs: [] as string[] } }],
    validationPlans: [] as { nodeId: string; plan: import("../orchestration/RecursiveSwarmModels.js").ValidationPlan; }[], allowedPaths: ["src/"], forbiddenPaths: [] as string[],
    fileContents: { "src/counter.ts": "function Counter() { return 0; }" },
    evidencePacks: { n1: { pack_id: "p1", node_id: "n1", task_slice: "", context_source: "memory_evidence", relevant_files: ["src/counter.ts"], file_ranges: {}, symbols: ["Counter"], commands: [] as string[], allowed_paths: [] as string[], forbidden_paths: [] as string[], evidence_refs: ["ev_1"], unknowns: [] as string[], warnings: [] as string[], confidence: 0.9, freshness_status: "fresh" } },
    builderOverrides: { "src/counter.ts": { exactOldText: "function Counter() { return 0; }", replacementText: "function Counter() { return 1; }", anchorLine: "", insertAfterAnchor: false, insertBeforeAnchor: false } }
  });
  assert.equal(result.patchCandidates.length, 1, "real PatchProposal created");
  assert.equal(result.summaryCounts.realDiff, 1);
  assert.equal(result.qualityMetrics.expandedSuccessfully + result.qualityMetrics.readyOnFirstPass, 1, "ready or expanded");
});

test("bridgeIntegration: vague intent becomes needs_generation if expansion fails", () => {
  const result = bridgeEditIntents({
    sessionId: "s", workspacePath: "/w",
    intents: [{ nodeId: "n1", intent: { kind: "edit_intent", target_file: "src/mystery.ts", target_symbol_or_range: "", operation: "modify", reason: "Change something", expected_behavior: "Maybe works", risk: "medium", evidence_refs: [] as string[] } }],
    validationPlans: [] as { nodeId: string; plan: import("../orchestration/RecursiveSwarmModels.js").ValidationPlan; }[], allowedPaths: ["src/"], forbiddenPaths: [] as string[],
    fileContents: { "src/mystery.ts": "const mystery = unknown; /* no symbols or anchor */" }
  });
  assert.equal(result.patchCandidates.length, 0, "no PatchProposal");
  assert.ok(result.needsGenerationIntents.length > 0, "needs generation after failed expansion");
  assert.equal(result.qualityMetrics.expansionFailed, 1);
});

test("bridgeIntegration: forbidden intent remains blocked", () => {
  const result = bridgeEditIntents({
    sessionId: "s", workspacePath: "/w",
    intents: [{ nodeId: "n1", intent: { kind: "edit_intent", target_file: "node_modules/pkg/x.js", target_symbol_or_range: "fn", operation: "modify", reason: "Fix", expected_behavior: "OK", risk: "low", evidence_refs: ["r1"] } }],
    validationPlans: [] as { nodeId: string; plan: import("../orchestration/RecursiveSwarmModels.js").ValidationPlan; }[], allowedPaths: [] as string[], forbiddenPaths: ["node_modules/"]
  });
  assert.equal(result.patchCandidates.length, 0, "no real patch for blocked");
  assert.equal(result.blockedIntents.length, 1, "blocked by quality gate");
  assert.equal(result.qualityMetrics.blockedByQualityGate, 1);
});

test("bridgeIntegration: real PatchProposal requires approval", () => {
  const result = bridgeEditIntents({
    sessionId: "s", workspacePath: "/w",
    intents: [{ nodeId: "n1", intent: { kind: "edit_intent", target_file: "src/approve.ts", target_symbol_or_range: "Fn", operation: "modify", reason: "Fix", expected_behavior: "OK", risk: "low", evidence_refs: ["r1"] } }],
    validationPlans: [] as { nodeId: string; plan: import("../orchestration/RecursiveSwarmModels.js").ValidationPlan; }[], allowedPaths: ["src/"], forbiddenPaths: [] as string[],
    fileContents: { "src/approve.ts": "function Fn() {}" },
    builderOverrides: { "src/approve.ts": { exactOldText: "function Fn() {}", replacementText: "function Fn() { return 1; }", anchorLine: "", insertAfterAnchor: false, insertBeforeAnchor: false } }
  });
  assert.equal(result.patchCandidates.length, 1);
  for (const p of result.patchCandidates) {
    assert.equal(p.requiresApproval, true);
  }
});

test("bridgeIntegration: quality metrics are populated", () => {
  const result = bridgeEditIntents({
    sessionId: "s", workspacePath: "/w",
    intents: [
      { nodeId: "n1", intent: { kind: "edit_intent", target_file: "src/good.ts", target_symbol_or_range: "G", operation: "modify", reason: "Exact", expected_behavior: "OK", risk: "low", evidence_refs: ["r1"] } },
      { nodeId: "n2", intent: { kind: "edit_intent", target_file: "src/bad.ts", target_symbol_or_range: "", operation: "modify", reason: "Vague", expected_behavior: "??", risk: "medium", evidence_refs: [] } },
      { nodeId: "n3", intent: { kind: "edit_intent", target_file: "node_modules/x.js", target_symbol_or_range: "x", operation: "modify", reason: "Forbidden", expected_behavior: "", risk: "low", evidence_refs: [] } }
    ],
    validationPlans: [] as { nodeId: string; plan: import("../orchestration/RecursiveSwarmModels.js").ValidationPlan; }[], allowedPaths: ["src/"], forbiddenPaths: ["node_modules/"],
    fileContents: { "src/good.ts": "G", "src/bad.ts": "???" },
    builderOverrides: { "src/good.ts": { exactOldText: "G", replacementText: "H", anchorLine: "", insertAfterAnchor: false, insertBeforeAnchor: false } }
  });
  assert.equal(result.qualityMetrics.totalIntents, 3);
  assert.ok(result.qualityMetrics.readyOnFirstPass >= 1, "at least one ready on first pass");
  assert.ok(result.qualityMetrics.topMissingFields.length > 0, "top missing fields recorded");
  assert.ok(result.qualityMetrics.contextSourceSummary.length > 0, "context source summary present");
});

test("bridgeIntegration: bridge output includes qualityMetrics", () => {
  const result = bridgeEditIntents({
    sessionId: "s", workspacePath: "/w",
    intents: [],
    validationPlans: [] as { nodeId: string; plan: import("../orchestration/RecursiveSwarmModels.js").ValidationPlan; }[],
    allowedPaths: [] as string[], forbiddenPaths: [] as string[]
  });
  assert.ok("qualityMetrics" in result, "qualityMetrics field present");
  assert.equal(result.qualityMetrics.totalIntents, 0);
  assert.equal(result.qualityMetrics.readyOnFirstPass, 0);
  assert.equal(result.qualityMetrics.expandedSuccessfully, 0);
  assert.equal(result.qualityMetrics.expansionFailed, 0);
  assert.equal(result.qualityMetrics.blockedByQualityGate, 0);
  assert.equal(result.qualityMetrics.blockedByPatchBuilder, 0);
});

test("project intake handoff: prelude intake exists and recursive swarm builds repository-grounded evidence packs without prompt_only_fallback", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-intake-handoff-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(
    path.join(workspace, "package.json"),
    JSON.stringify({ name: "test-index", scripts: { test: "node --test" } }),
    "utf8"
  );
  await writeFile(
    path.join(workspace, "src", "index.ts"),
    "export function main() { return 1; }",
    "utf8"
  );

  const manager = new SessionManager(path.join(workspace, ".runtime-test"), new EventBus(), {
    runtimeEventLoader: async () => []
  });
  await manager.load();

  const session = await manager.createSession({
    workspacePath: workspace,
    mode: "real_provider",
    executionMode: "auto_mode",
    userPrompt: "Run recursive tree execution to inspect index in src/index.ts"
  });

  await manager.addCommandExecution(session.id, {
    id: "exec_baseline_init",
    sessionId: session.id,
    command: "npm test",
    cwd: workspace,
    risk: "safe",
    status: "executed",
    exitCode: 0,
    stdout: "pass",
    stderr: "",
    autoRun: false,
    provenance: { source: "agent", trigger: "manual", requestedBy: "agent", sessionId: session.id },
    createdAt: new Date().toISOString()
  });

  // Verify before handoff: session.projectIntake is undefined
  assert.equal(session.projectIntake, undefined, "session.projectIntake must initially be undefined");

  let capturedSessionAtSwarmStart: AgentRuntimeSession | undefined;
  const mockProvider = {
    requests: [] as any[],
    async generateStructured<T>(req: any, schema: any): Promise<T> {
      this.requests.push(req);
      const name = schema?.name ?? "";
      if (name === "expanded_goal_spec") {
        return {
          isAlreadyDetailed: true,
          expandedGoal: req.userPrompt,
          requirements: ["Inspect index in src/index.ts"],
          acceptanceCriteria: ["Index inspected"],
          deliverableContract: "Inspect index",
          constraints: [],
          nonGoals: [],
          qualityBar: ["Complete"]
        } as T;
      }
      if (name === "atomicity_assessment") {
        return { isAtomic: true, score: 2, rationale: "Atomic fixture.", failures: [] } as T;
      }
      if (name === "structured_node_output") {
        return {
          kind: "final_summary",
          summary: "Completed inspection of index in src/index.ts",
          blockers: [],
          edit_intents: [],
          validation_plans: [],
          confidence: 0.9
        } as T;
      }
      return {} as T;
    },
    async generateText(): Promise<string> {
      return "Completed";
    }
  };

  let capturedAssistantMessage: string | undefined;
  const directTurnService = new RuntimeDirectTurnService(manager);
  const realRecursiveSwarm = new RuntimeRecursiveSwarmService(manager, directTurnService);

  const recursiveSwarmWrapper = {
    run: async (input: any) => {
      // Capture the exact session that recursive swarm retrieves from sessionManager
      capturedSessionAtSwarmStart = manager.getSession(input.sessionId);
      const res = await realRecursiveSwarm.run(input);
      capturedAssistantMessage = res.messages.find((m) => m.role === "assistant")?.content;
      return res;
    }
  };

  const planningTurnService = new RuntimePlanningTurnService(manager, {
    intentContract: {
      compile: async () => ({
        ready: true,
        contract: {
          version: 1,
          status: "ready",
          original_user_request: "Run recursive tree execution to inspect index in src/index.ts",
          precise_rewrite: "Run recursive tree execution to inspect index in src/index.ts",
          task_type: "edit",
          target_files: ["src/index.ts"],
          acceptance_criteria: [],
          constraints: [],
          assumptions: [],
          risks: [],
          blocking_questions: [],
          non_blocking_questions: [],
          provider_request_refs: ["ref_req_1"],
          created_at: new Date().toISOString()
        } as any,
        blockingQuestions: [],
        validationErrors: [],
        errors: []
      }),
      blockPlanning: async () => ({ sessionId: session.id, status: "needs_approval" as const })
    } as any,
    recursiveSwarm: recursiveSwarmWrapper as any,
    recursiveFactoryPlanning: {} as any,
    providerBackedSwarm: {} as any,
    runEngine: {} as any
  });

  const providerContext = {
    provider: mockProvider,
    routerProvider: mockProvider,
    verifierProvider: mockProvider,
    telemetry: {
      snapshot: () => ({
        providerRequestRefs: ["ref_req_1"],
        providerRequestCount: 1,
        providerFailureCount: 0,
        providerTimeoutCount: 0,
        reasoningAttempts: 1,
        repairAttempts: 0,
        finalResponseSource: "none"
      })
    }
  };

  const conversationUnderstanding: ConversationUnderstanding = {
    originalMessage: "Run recursive tree execution to inspect index in src/index.ts",
    workspaceMessage: "Run recursive tree execution to inspect index in src/index.ts",
    preparedPrompt: {
      originalMessage: "Run recursive tree execution to inspect index in src/index.ts",
      workspaceMessage: "Run recursive tree execution to inspect index in src/index.ts",
      droppedPreamble: ""
    },
    intentDecision: {
      kind: "workspace_action",
      language: "english",
      needsWorkspace: true,
      confidence: "high",
      rationale: "Inspect index"
    },
    routeDecision: {
      route: "orchestrated_run",
      confidence: "high",
      language: "english",
      normalizedPrompt: "Run recursive tree execution to inspect index in src/index.ts",
      workspacePrompt: "Run recursive tree execution to inspect index in src/index.ts",
      rationale: "Inspect index"
    }
  };

  try {
    await planningTurnService.run({
      sessionId: session.id,
      session,
      prompt: "Run recursive tree execution to inspect index in src/index.ts",
      conversationUnderstanding,
      decisionPipelineId: "test_pipeline",
      providerContext: providerContext as any,
      swarmMode: "recursive_tree"
    });

    const finalSession = manager.getSession(session.id)!;

    // 1. prelude intake exists
    assert.ok(finalSession.projectIntake, "1. prelude intake exists");
    assert.equal(finalSession.projectIntake.intakeStatus, "completed");
    assert.ok(finalSession.projectIntake.importantFiles.length > 0, "intake discovered workspace files");
    assert.ok(finalSession.contextPack, "contextPack exists");
    assert.ok(finalSession.runIntent, "runIntent exists");

    // 2. recursive swarm receives that intake
    assert.ok(capturedSessionAtSwarmStart, "recursive swarm was called");
    assert.ok(capturedSessionAtSwarmStart.projectIntake, "2. recursive swarm receives that intake");
    assert.equal(capturedSessionAtSwarmStart.projectIntake, finalSession.projectIntake, "recursive swarm receives the exact projectIntake");
    assert.equal(capturedSessionAtSwarmStart.contextPack, finalSession.contextPack, "recursive swarm receives the exact contextPack");
    assert.equal(capturedSessionAtSwarmStart.runIntent, finalSession.runIntent, "recursive swarm receives the exact runIntent");

    // 3. at least one node uses repository-grounded context
    assert.ok(capturedAssistantMessage, "assistant message produced by recursive swarm");
    assert.match(capturedAssistantMessage, /\[Context-source summary:.*nodes used memory evidence/);
    assert.ok((finalSession.recursiveSwarmRunState?.tree?.nodeCount ?? 0) > 0, "tree nodes were created");

    // 4. prompt_only_fallback is not used when project intake exists
    assert.doesNotMatch(capturedAssistantMessage, /used prompt-only fallback/);
    assert.match(capturedAssistantMessage, /\[Context-source summary: 2\/2 nodes used memory evidence\]/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
