import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  bridgeEditIntents,
  collectIntentsFromTree,
  tryNormalizeExistingFilePatch,
  parseUnifiedDiffHunks,
  isPatchArtifact,
  parsePatchArtifact,
  extractPatchArtifactTargetPath,
  isAuxiliaryReportArtifact
} from "../orchestration/RecursiveEditIntentBridge.js";
import { gatherCurrentFileContents } from "../runtime/RuntimeRecursiveSwarmService.js";
import type { RecursiveSwarmNode, GeneratedArtifact } from "../orchestration/RecursiveSwarmModels.js";
import { RECURSIVE_SWARM_SCHEMA_VERSION, createGoalEnvelope } from "../orchestration/RecursiveSwarmModels.js";

const BUGGY_CALCULATOR_FILE_CONTENT = `/**
 * Simple calculator module.
 */

export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}
`;

const REAL_WORKER_UNIFIED_DIFF = `--- a/src/calculator.ts
+++ b/src/calculator.ts
@@
 export function multiply(a: number, b: number): number {
-  return a + b;
+  return a * b;
 }
`;

function makeTestNodeWithArtifact(id: string, artifact: GeneratedArtifact): RecursiveSwarmNode {
  return {
    schema_version: RECURSIVE_SWARM_SCHEMA_VERSION,
    id,
    runId: "run_bridge_test",
    kind: "task_agent",
    status: "succeeded",
    name: "Artifact Worker",
    role: "Task Agent",
    goalEnvelope: createGoalEnvelope({
      originalGoal: "Fix calculator bug",
      workspaceIdentity: "test",
      localTask: "Fix multiply function"
    }),
    taskPrompt: "Fix multiply bug",
    depth: 2,
    goalChecks: [],
    steeringQueue: [],
    children: [],
    revision: 1,
    structuredOutput: artifact,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

// ---------------------------------------------------------------------------
// 1. generated_artifact targeting an existing file with a valid unified diff
//    becomes an existing-file patch candidate.
// 2. The patch preserves the real file and changes only return a + b -> return a * b
// 3. It is NOT represented as /dev/null new-file creation.
// ---------------------------------------------------------------------------
test("Regression 1-3: existing-file generated artifact with valid unified diff becomes modify patch candidate without /dev/null", () => {
  const artifact: GeneratedArtifact = {
    kind: "generated_artifact",
    path: "src/calculator.ts",
    content: REAL_WORKER_UNIFIED_DIFF,
    artifact_type: "text",
    description: "Fix multiply function to perform multiplication instead of addition",
    validation_steps: ["Run npm test to verify calculator test passes"],
    completeness_notes: ["Replaces + with * in multiply function"],
    confidence: 0.95
  };

  const node = makeTestNodeWithArtifact("worker_node_1", artifact);
  const collected = collectIntentsFromTree({ [node.id]: node });
  assert.equal(collected.generatedArtifacts.length, 1);

  const bridged = bridgeEditIntents({
    sessionId: "session_calc_fix",
    workspacePath: "/workspace/buggy-calculator",
    intents: collected.intents,
    generatedArtifacts: collected.generatedArtifacts,
    validationPlans: collected.validationPlans,
    allowedPaths: ["src/"],
    forbiddenPaths: [],
    fileContents: {
      "src/calculator.ts": BUGGY_CALCULATOR_FILE_CONTENT
    }
  });

  // Verify counts
  assert.equal(bridged.summaryCounts.realDiff, 1, "Must produce exactly 1 real diff");
  assert.equal(bridged.summaryCounts.blocked, 0, "Must not be blocked");
  assert.equal(bridged.summaryCounts.needsGeneration, 0, "Must not need generation");
  assert.equal(bridged.patchCandidates.length, 1, "Must produce 1 patch candidate");

  const proposal = bridged.patchCandidates[0];
  assert.ok(proposal, "Proposal must exist");
  assert.equal(proposal.title, "modify src/calculator.ts");
  assert.equal(proposal.requiresApproval, true);
  assert.equal(proposal.status, "proposed");

  // Verify file change details
  assert.equal(proposal.filesChanged.length, 1);
  assert.equal(proposal.filesChanged[0].path, "src/calculator.ts");
  assert.equal(proposal.filesChanged[0].changeType, "modify", "Must be 'modify', NOT 'create'");

  // Verify unified diff structure (Requirement 3: NOT /dev/null)
  assert.ok(!proposal.unifiedDiff.includes("/dev/null"), "Must NOT reference /dev/null");
  assert.ok(proposal.unifiedDiff.startsWith("diff --git a/src/calculator.ts b/src/calculator.ts"), "Must have standard git header");
  assert.ok(proposal.unifiedDiff.includes("--- a/src/calculator.ts"), "Must have --- a/ header");
  assert.ok(proposal.unifiedDiff.includes("+++ b/src/calculator.ts"), "Must have +++ b/ header");

  // Requirement 2: Verify exact changes inside hunk
  assert.ok(proposal.unifiedDiff.includes(" export function multiply(a: number, b: number): number {"), "Must keep multiply context");
  assert.ok(proposal.unifiedDiff.includes("-  return a + b;"), "Must remove return a + b");
  assert.ok(proposal.unifiedDiff.includes("+  return a * b;"), "Must add return a * b");
  assert.ok(proposal.unifiedDiff.includes("@@ -7,7 +7,7 @@"), "Hunk header must have 3-line surrounding context anchoring at line 7");

  // Verify add() is NOT modified
  assert.ok(!proposal.unifiedDiff.includes("add"), "Must not touch add()");
});

// ---------------------------------------------------------------------------
// 4. generated_artifact targeting a genuinely new file still uses existing new-file behavior
// ---------------------------------------------------------------------------
test("Regression 4: generated_artifact targeting a new file retains /dev/null new-file create behavior", () => {
  const newFileContent = `export function divide(a: number, b: number): number {\n  return a / b;\n}\n`;
  const artifact: GeneratedArtifact = {
    kind: "generated_artifact",
    path: "src/new_math.ts",
    content: newFileContent,
    artifact_type: "text",
    description: "New math helper module",
    validation_steps: [],
    completeness_notes: ["Initial implementation"],
    confidence: 0.9
  };

  const node = makeTestNodeWithArtifact("worker_node_new", artifact);
  const collected = collectIntentsFromTree({ [node.id]: node });

  const bridged = bridgeEditIntents({
    sessionId: "session_new_file",
    workspacePath: "/workspace/buggy-calculator",
    intents: collected.intents,
    generatedArtifacts: collected.generatedArtifacts,
    validationPlans: collected.validationPlans,
    allowedPaths: ["src/"],
    forbiddenPaths: [],
    fileContents: {
      "src/calculator.ts": BUGGY_CALCULATOR_FILE_CONTENT
      // src/new_math.ts is not in fileContents and does not exist on disk
    }
  });

  assert.equal(bridged.summaryCounts.realDiff, 1);
  assert.equal(bridged.patchCandidates.length, 1);
  const proposal = bridged.patchCandidates[0];
  assert.equal(proposal.title, "create src/new_math.ts");
  assert.equal(proposal.filesChanged[0].changeType, "create");
  assert.ok(proposal.unifiedDiff.includes("--- /dev/null"), "New file MUST use --- /dev/null");
  assert.ok(proposal.unifiedDiff.includes("+++ b/src/new_math.ts"));
  assert.ok(proposal.unifiedDiff.includes("+export function divide"));
});

// ---------------------------------------------------------------------------
// 5. invalid/pseudo patch content targeting an existing file remains blocked
// ---------------------------------------------------------------------------
test("Regression 5: pseudo-patch or arbitrary full-file text targeting existing file remains blocked", () => {
  // 5a. Pseudo-patch with commentary / *** Begin Patch
  const pseudoPatchArtifact: GeneratedArtifact = {
    kind: "generated_artifact",
    path: "src/calculator.ts",
    content: `*** Begin Patch\n*** Update File: src/calculator.ts\n@@\n-  return a + b;\n+  return a * b;\n*** End Patch\n`,
    artifact_type: "text",
    description: "Fix multiply with custom pseudo-patch",
    validation_steps: [],
    completeness_notes: [],
    confidence: 0.8
  };

  const nodeA = makeTestNodeWithArtifact("worker_pseudo", pseudoPatchArtifact);
  const collectedA = collectIntentsFromTree({ [nodeA.id]: nodeA });

  const bridgedA = bridgeEditIntents({
    sessionId: "session_pseudo",
    workspacePath: "/workspace/buggy-calculator",
    intents: collectedA.intents,
    generatedArtifacts: collectedA.generatedArtifacts,
    validationPlans: collectedA.validationPlans,
    allowedPaths: ["src/"],
    forbiddenPaths: [],
    fileContents: { "src/calculator.ts": BUGGY_CALCULATOR_FILE_CONTENT }
  });

  assert.equal(bridgedA.summaryCounts.realDiff, 0, "Pseudo patch must not produce real diff");
  assert.equal(bridgedA.summaryCounts.blocked, 1, "Pseudo patch must be blocked");
  assert.ok(bridgedA.blockedIntents[0].reason.includes("Pseudo-patch"), "Reason must mention pseudo-patch");

  // 5b. Arbitrary code replacement (not a diff) targeting existing file
  const arbitraryCodeArtifact: GeneratedArtifact = {
    kind: "generated_artifact",
    path: "src/calculator.ts",
    content: `export function completelyDifferent(): void {}`,
    artifact_type: "text",
    description: "Overwrite calculator with new code",
    validation_steps: [],
    completeness_notes: [],
    confidence: 0.9
  };

  const nodeB = makeTestNodeWithArtifact("worker_arbitrary", arbitraryCodeArtifact);
  const collectedB = collectIntentsFromTree({ [nodeB.id]: nodeB });

  const bridgedB = bridgeEditIntents({
    sessionId: "session_arbitrary",
    workspacePath: "/workspace/buggy-calculator",
    intents: collectedB.intents,
    generatedArtifacts: collectedB.generatedArtifacts,
    validationPlans: collectedB.validationPlans,
    allowedPaths: ["src/"],
    forbiddenPaths: [],
    fileContents: { "src/calculator.ts": BUGGY_CALCULATOR_FILE_CONTENT }
  });

  assert.equal(bridgedB.summaryCounts.realDiff, 0, "Arbitrary code must not produce real diff");
  assert.equal(bridgedB.summaryCounts.blocked, 1, "Arbitrary code must be blocked");
  assert.ok(bridgedB.blockedIntents[0].reason.includes("No unified diff hunks found"), "Must reject lack of hunks");

  // 5c. Diff targeting wrong file
  const wrongFileArtifact: GeneratedArtifact = {
    kind: "generated_artifact",
    path: "src/calculator.ts",
    content: `--- a/src/other.ts\n+++ b/src/other.ts\n@@\n-foo\n+bar\n`,
    artifact_type: "text",
    description: "Diff headers do not match target path",
    validation_steps: [],
    completeness_notes: [],
    confidence: 0.9
  };

  const nodeC = makeTestNodeWithArtifact("worker_wrong_file", wrongFileArtifact);
  const collectedC = collectIntentsFromTree({ [nodeC.id]: nodeC });

  const bridgedC = bridgeEditIntents({
    sessionId: "session_wrong_file",
    workspacePath: "/workspace/buggy-calculator",
    intents: collectedC.intents,
    generatedArtifacts: collectedC.generatedArtifacts,
    validationPlans: collectedC.validationPlans,
    allowedPaths: ["src/"],
    forbiddenPaths: [],
    fileContents: { "src/calculator.ts": BUGGY_CALCULATOR_FILE_CONTENT }
  });

  assert.equal(bridgedC.summaryCounts.realDiff, 0);
  assert.equal(bridgedC.summaryCounts.blocked, 1);
  assert.ok(bridgedC.blockedIntents[0].reason.includes("does not match target file"));
});

// ---------------------------------------------------------------------------
// 6. two equivalent normalized patches for the same target are deduplicated
// ---------------------------------------------------------------------------
test("Regression 6: two equivalent normalized patches for same target are deduplicated", () => {
  const artifact1: GeneratedArtifact = {
    kind: "generated_artifact",
    path: "src/calculator.ts",
    content: REAL_WORKER_UNIFIED_DIFF,
    artifact_type: "text",
    description: "First worker fix",
    validation_steps: [],
    completeness_notes: [],
    confidence: 0.9
  };

  // Second worker produces the exact same change, maybe with slightly different trailing spaces
  const artifact2: GeneratedArtifact = {
    kind: "generated_artifact",
    path: "src/calculator.ts",
    content: REAL_WORKER_UNIFIED_DIFF.trimEnd() + "\n",
    artifact_type: "text",
    description: "Second worker fix (duplicate)",
    validation_steps: [],
    completeness_notes: [],
    confidence: 0.85
  };

  const node1 = makeTestNodeWithArtifact("worker_1", artifact1);
  const node2 = makeTestNodeWithArtifact("worker_2", artifact2);
  const collected = collectIntentsFromTree({ [node1.id]: node1, [node2.id]: node2 });
  assert.equal(collected.generatedArtifacts.length, 2);

  const bridged = bridgeEditIntents({
    sessionId: "session_dedup",
    workspacePath: "/workspace/buggy-calculator",
    intents: collected.intents,
    generatedArtifacts: collected.generatedArtifacts,
    validationPlans: collected.validationPlans,
    allowedPaths: ["src/"],
    forbiddenPaths: [],
    fileContents: { "src/calculator.ts": BUGGY_CALCULATOR_FILE_CONTENT }
  });

  assert.equal(bridged.summaryCounts.realDiff, 1, "Only 1 proposal should remain after deduplication");
  assert.equal(bridged.patchCandidates.length, 1);
  assert.ok(bridged.diagnostics.some((d) => d.includes("Deduplicating identical patch proposal")), "Diagnostic notes deduplication");
});

// ---------------------------------------------------------------------------
// 7. conflicting edits for the same target are not silently merged
// ---------------------------------------------------------------------------
test("Regression 7: conflicting edits for same target are blocked rather than silently merged", () => {
  const artifactValid: GeneratedArtifact = {
    kind: "generated_artifact",
    path: "src/calculator.ts",
    content: REAL_WORKER_UNIFIED_DIFF,
    artifact_type: "text",
    description: "Valid fix",
    validation_steps: [],
    completeness_notes: [],
    confidence: 0.9
  };

  // Different, conflicting diff for the same file
  const artifactConflict: GeneratedArtifact = {
    kind: "generated_artifact",
    path: "src/calculator.ts",
    content: `--- a/src/calculator.ts\n+++ b/src/calculator.ts\n@@\n export function multiply(a: number, b: number): number {\n-  return a + b;\n+  return 0;\n }\n`,
    artifact_type: "text",
    description: "Conflicting fix returning 0",
    validation_steps: [],
    completeness_notes: [],
    confidence: 0.8
  };

  const node1 = makeTestNodeWithArtifact("worker_good", artifactValid);
  const node2 = makeTestNodeWithArtifact("worker_bad", artifactConflict);
  const collected = collectIntentsFromTree({ [node1.id]: node1, [node2.id]: node2 });

  const bridged = bridgeEditIntents({
    sessionId: "session_conflict",
    workspacePath: "/workspace/buggy-calculator",
    intents: collected.intents,
    generatedArtifacts: collected.generatedArtifacts,
    validationPlans: collected.validationPlans,
    allowedPaths: ["src/"],
    forbiddenPaths: [],
    fileContents: { "src/calculator.ts": BUGGY_CALCULATOR_FILE_CONTENT }
  });

  // The first valid one is kept as a candidate; the second conflicting one is blocked as a conflict
  assert.equal(bridged.summaryCounts.realDiff, 1, "One candidate preserved");
  assert.equal(bridged.summaryCounts.blocked, 1, "Conflicting edit must be blocked");
  assert.ok(bridged.blockedIntents[0].reason.includes("Conflicting patch proposal"), "Block reason indicates conflict");
  assert.ok(bridged.diagnostics.some((d) => d.includes("Conflict detected")), "Diagnostic notes conflict");
});

// ---------------------------------------------------------------------------
// 8. no filesystem write or Rust apply happens inside RecursiveEditIntentBridge
// ---------------------------------------------------------------------------
test("Regression 8: RecursiveEditIntentBridge does not perform filesystem writes or Rust apply", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hivo_bridge_test_"));
  try {
    const srcDir = path.join(tempDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const calcFile = path.join(srcDir, "calculator.ts");
    fs.writeFileSync(calcFile, BUGGY_CALCULATOR_FILE_CONTENT, "utf8");

    const statBefore = fs.statSync(calcFile);

    const artifact: GeneratedArtifact = {
      kind: "generated_artifact",
      path: "src/calculator.ts",
      content: REAL_WORKER_UNIFIED_DIFF,
      artifact_type: "text",
      description: "Multiply fix",
      validation_steps: [],
      completeness_notes: [],
      confidence: 0.95
    };

    const node = makeTestNodeWithArtifact("worker_node", artifact);
    const collected = collectIntentsFromTree({ [node.id]: node });

    // Run bridge with actual temp workspace on disk
    const bridged = bridgeEditIntents({
      sessionId: "session_fs_check",
      workspacePath: tempDir,
      intents: collected.intents,
      generatedArtifacts: collected.generatedArtifacts,
      validationPlans: collected.validationPlans,
      allowedPaths: ["src/"],
      forbiddenPaths: []
    });

    // File on disk must remain COMPLETELY UNMODIFIED
    const contentAfter = fs.readFileSync(calcFile, "utf8");
    const statAfter = fs.statSync(calcFile);
    assert.equal(contentAfter, BUGGY_CALCULATOR_FILE_CONTENT, "Workspace file on disk must NOT be modified");
    assert.equal(statAfter.mtimeMs, statBefore.mtimeMs, "mtime must not change");

    // Patch proposal is generated with approval required
    assert.equal(bridged.patchCandidates.length, 1);
    assert.equal(bridged.patchCandidates[0].requiresApproval, true);
    assert.equal(bridged.patchCandidates[0].status, "proposed");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 9. Regression 9 (Req 1-4): patch.diff containing a valid single-file unified
//    diff targeting an existing file becomes a modify PatchProposal for that
//    inner target (src/calculator.ts), NOT patch.diff, and does NOT produce
//    a /dev/null create patch.
// ---------------------------------------------------------------------------
test("Regression 9: patch.diff artifact with inner unified diff becomes modify PatchProposal for src/calculator.ts without /dev/null", () => {
  const artifact: GeneratedArtifact = {
    kind: "generated_artifact",
    path: "patch.diff",
    content: REAL_WORKER_UNIFIED_DIFF,
    artifact_type: "text",
    description: "Correct the multiply function to perform multiplication instead of addition.",
    validation_steps: ["Run npm test to verify calculator test passes."],
    completeness_notes: ["Direct surgical fix for the bug in multiply function."],
    confidence: 0.95
  };

  const node = makeTestNodeWithArtifact("worker_patch_diff", artifact);
  const collected = collectIntentsFromTree({ [node.id]: node });
  assert.equal(collected.generatedArtifacts.length, 1);

  const bridged = bridgeEditIntents({
    sessionId: "session_patch_diff_real",
    workspacePath: "/workspace/buggy-calculator",
    intents: collected.intents,
    generatedArtifacts: collected.generatedArtifacts,
    validationPlans: collected.validationPlans,
    allowedPaths: ["src/"],
    forbiddenPaths: [],
    fileContents: {
      "src/calculator.ts": BUGGY_CALCULATOR_FILE_CONTENT
    }
  });

  // Verify counts
  assert.equal(bridged.summaryCounts.realDiff, 1, "Must produce exactly 1 real diff");
  assert.equal(bridged.summaryCounts.blocked, 0, "Must not be blocked");
  assert.equal(bridged.summaryCounts.needsGeneration, 0, "Must not need generation");
  assert.equal(bridged.patchCandidates.length, 1, "Must produce 1 patch candidate");

  const proposal = bridged.patchCandidates[0];
  assert.ok(proposal, "Proposal must exist");

  // Requirement 2: resulting proposal targets src/calculator.ts, NOT patch.diff
  assert.equal(proposal.title, "modify src/calculator.ts");
  assert.equal(proposal.requiresApproval, true);
  assert.equal(proposal.status, "proposed");
  assert.equal(proposal.filesChanged.length, 1);
  assert.equal(proposal.filesChanged[0].path, "src/calculator.ts", "Target file MUST be src/calculator.ts");
  assert.equal(proposal.filesChanged[0].changeType, "modify", "Must be 'modify', NOT 'create'");

  // Requirement 4: No /dev/null create patch for patch.diff
  assert.ok(!proposal.unifiedDiff.includes("/dev/null"), "Must NOT create patch.diff from /dev/null");
  assert.ok(!proposal.unifiedDiff.includes("patch.diff"), "Diff must NOT reference patch.diff as file path");
  assert.ok(proposal.unifiedDiff.includes("--- a/src/calculator.ts"), "Must have --- a/src/calculator.ts");
  assert.ok(proposal.unifiedDiff.includes("+++ b/src/calculator.ts"), "Must have +++ b/src/calculator.ts");

  // Requirement 3: normalized diff preserves only return a + b -> return a * b
  assert.ok(proposal.unifiedDiff.includes("-  return a + b;"), "Must remove return a + b;");
  assert.ok(proposal.unifiedDiff.includes("+  return a * b;"), "Must add return a * b;");
  assert.ok(!proposal.unifiedDiff.includes("add"), "Must not touch add()");
});

// ---------------------------------------------------------------------------
// 10. Regression 10 (Req 5): Normal generated files like test_output.txt still
//     remain generated-file create proposals.
// ---------------------------------------------------------------------------
test("Regression 10: normal generated files like test_output.txt and root_cause_analysis.txt remain create proposals", () => {
  const testOutputArtifact: GeneratedArtifact = {
    kind: "generated_artifact",
    path: "test_output.txt",
    content: "FAIL src/calculator.test.ts\n  ✕ multiply (5ms)\n",
    artifact_type: "text",
    description: "Raw test run output",
    validation_steps: [],
    completeness_notes: [],
    confidence: 0.9
  };

  const rcaArtifact: GeneratedArtifact = {
    kind: "generated_artifact",
    path: "root_cause_analysis.txt",
    content: "Root Cause: multiply uses + instead of *\n",
    artifact_type: "text",
    description: "RCA documentation",
    validation_steps: [],
    completeness_notes: [],
    confidence: 0.95
  };

  const node1 = makeTestNodeWithArtifact("worker_test_out", testOutputArtifact);
  const node2 = makeTestNodeWithArtifact("worker_rca", rcaArtifact);
  const collected = collectIntentsFromTree({ [node1.id]: node1, [node2.id]: node2 });

  const bridged = bridgeEditIntents({
    sessionId: "session_normal_artifacts",
    workspacePath: "/workspace/buggy-calculator",
    intents: collected.intents,
    generatedArtifacts: collected.generatedArtifacts,
    validationPlans: collected.validationPlans,
    allowedPaths: [],
    forbiddenPaths: [],
    originalGoal: "Create test_output.txt and write root_cause_analysis.txt for documentation"
  });

  assert.equal(bridged.summaryCounts.realDiff, 2);
  assert.equal(bridged.patchCandidates.length, 2);

  const testOutProposal = bridged.patchCandidates.find((p) => p.filesChanged[0].path === "test_output.txt");
  const rcaProposal = bridged.patchCandidates.find((p) => p.filesChanged[0].path === "root_cause_analysis.txt");

  assert.ok(testOutProposal);
  assert.equal(testOutProposal.filesChanged[0].changeType, "create");
  assert.ok(testOutProposal.unifiedDiff.includes("--- /dev/null"));
  assert.ok(testOutProposal.unifiedDiff.includes("+++ b/test_output.txt"));

  assert.ok(rcaProposal);
  assert.equal(rcaProposal.filesChanged[0].changeType, "create");
  assert.ok(rcaProposal.unifiedDiff.includes("--- /dev/null"));
  assert.ok(rcaProposal.unifiedDiff.includes("+++ b/root_cause_analysis.txt"));
});

test("Regression: worker-generated .test.js is a create candidate while reports stay auxiliary and patches remain grounded and approval-gated", () => {
  const regressionTestArtifact: GeneratedArtifact = {
    kind: "generated_artifact",
    path: "test/zeroValueBar.test.js",
    content: `import test from "node:test";\n\ntest("zero-value bar respects borderRadius", () => {});\n`,
    artifact_type: "javascript",
    description: "Regression test for zero-value bars with minBarLength and borderRadius",
    validation_steps: [],
    completeness_notes: [],
    confidence: 0.9
  };
  const evidenceArtifact: GeneratedArtifact = {
    kind: "generated_artifact",
    path: "evidence_report.txt",
    content: "The source-grounded change is described here.",
    artifact_type: "text",
    description: "Investigation evidence report",
    validation_steps: [],
    completeness_notes: [],
    confidence: 0.9
  };
  const testResultsArtifact: GeneratedArtifact = {
    kind: "generated_artifact",
    path: "test_results.txt",
    content: "PASS 12 tests",
    artifact_type: "text",
    description: "Test execution results",
    validation_steps: [],
    completeness_notes: [],
    confidence: 0.9
  };
  const stalePatchArtifact: GeneratedArtifact = {
    kind: "generated_artifact",
    path: "stale_change.diff",
    content: `*** Begin Patch
*** Update File: src/calculator.ts
@@
-  return a + b;
+  return a * b;
*** End Patch`,
    artifact_type: "text",
    description: "Stale patch with source lines that do not match",
    validation_steps: [],
    completeness_notes: [],
    confidence: 0.9
  };
  const testNode = makeTestNodeWithArtifact("worker_zero_bar_test", regressionTestArtifact);
  const evidenceNode = makeTestNodeWithArtifact("worker_evidence_report", evidenceArtifact);
  const testResultsNode = makeTestNodeWithArtifact("worker_test_results", testResultsArtifact);
  const groundedNode = makeTestNodeWithArtifact("worker_grounded_change", {
    ...regressionTestArtifact,
    path: "src/calculator.ts",
    content: REAL_WORKER_UNIFIED_DIFF,
    artifact_type: "text",
    description: "Source-grounded calculator patch"
  });
  const staleNode = makeTestNodeWithArtifact("worker_stale_change", stalePatchArtifact);
  const collected = collectIntentsFromTree({
    [testNode.id]: testNode,
    [evidenceNode.id]: evidenceNode,
    [testResultsNode.id]: testResultsNode,
    [groundedNode.id]: groundedNode,
    [staleNode.id]: staleNode
  });

  const bridged = bridgeEditIntents({
    sessionId: "session_zero_bar_test_artifact",
    workspacePath: "/workspace/buggy-calculator",
    intents: collected.intents,
    generatedArtifacts: collected.generatedArtifacts,
    validationPlans: collected.validationPlans,
    allowedPaths: [],
    forbiddenPaths: [],
    fileContents: {
      "src/calculator.ts": BUGGY_CALCULATOR_FILE_CONTENT
    },
    originalGoal: "Fix the zero-value bar rendering issue and add a regression test."
  });

  const testProposal = bridged.patchCandidates.find((proposal) =>
    proposal.filesChanged.some((file) => file.path === "test/zeroValueBar.test.js")
  );
  assert.ok(testProposal, "A worker-generated .test.js artifact must become a create-patch candidate");
  assert.equal(testProposal.filesChanged[0].changeType, "create");
  assert.equal(testProposal.requiresApproval, true, "New-file proposals must still require approval");
  assert.equal(testProposal.status, "proposed");

  assert.deepEqual(
    bridged.auxiliaryArtifacts?.map(({ artifact }) => artifact.path),
    ["evidence_report.txt", "test_results.txt"],
    "Evidence and test-result reports remain auxiliary, but valid .test.js files must not be filtered as reports"
  );

  const groundedProposal = bridged.patchCandidates.find((proposal) =>
    proposal.filesChanged.some((file) => file.path === "src/calculator.ts")
  );
  assert.ok(groundedProposal, "A patch grounded in current source must remain eligible");
  assert.equal(groundedProposal.requiresApproval, true, "Source edits must still require approval");
  assert.equal(groundedProposal.status, "proposed");
  assert.equal(bridged.blockedIntents.length, 1, "The stale source patch must remain blocked");
  assert.match(
    bridged.blockedIntents[0].reason,
    /Patch artifact failed to apply to src\/calculator\.ts:/,
    "Source-grounding must continue rejecting stale or ambiguous patches"
  );
});

// ---------------------------------------------------------------------------
// 11. Regression 11 (Req 6): Malformed patch.diff is blocked and is not written
//     as a normal artifact.
// ---------------------------------------------------------------------------
test("Regression 11: malformed patch.diff is blocked and NOT written as a normal artifact", () => {
  const malformedArtifact: GeneratedArtifact = {
    kind: "generated_artifact",
    path: "patch.diff",
    content: "I think you should change return a + b to return a * b.",
    artifact_type: "text",
    description: "Fix description without unified diff headers",
    validation_steps: [],
    completeness_notes: [],
    confidence: 0.7
  };

  const node = makeTestNodeWithArtifact("worker_malformed", malformedArtifact);
  const collected = collectIntentsFromTree({ [node.id]: node });

  const bridged = bridgeEditIntents({
    sessionId: "session_malformed_patch",
    workspacePath: "/workspace/buggy-calculator",
    intents: collected.intents,
    generatedArtifacts: collected.generatedArtifacts,
    validationPlans: collected.validationPlans,
    allowedPaths: ["src/"],
    forbiddenPaths: [],
    fileContents: { "src/calculator.ts": BUGGY_CALCULATOR_FILE_CONTENT }
  });

  assert.equal(bridged.summaryCounts.realDiff, 0, "Must NOT produce real diff");
  assert.equal(bridged.summaryCounts.blocked, 1, "Must be blocked explicitly");
  assert.equal(bridged.patchCandidates.length, 0, "No patch candidates produced");
  assert.ok(bridged.blockedIntents[0].reason.includes("missing file headers") || bridged.blockedIntents[0].reason.includes("No unified diff hunks"));
});

// ---------------------------------------------------------------------------
// 12. Regression 12 (Req 7): Out-of-workspace target paths in patch.diff are blocked.
// ---------------------------------------------------------------------------
test("Regression 12: out-of-workspace target paths in patch.diff are blocked", () => {
  const outOfWorkspaceDiff = `--- a/../../etc/passwd\n+++ b/../../etc/passwd\n@@ -1,1 +1,1 @@\n-root:x:0:0\n+root:x:1:1\n`;
  const escapeArtifact: GeneratedArtifact = {
    kind: "generated_artifact",
    path: "patch.diff",
    content: outOfWorkspaceDiff,
    artifact_type: "text",
    description: "Malicious out-of-workspace patch",
    validation_steps: [],
    completeness_notes: [],
    confidence: 0.9
  };

  const node = makeTestNodeWithArtifact("worker_escape", escapeArtifact);
  const collected = collectIntentsFromTree({ [node.id]: node });

  const bridged = bridgeEditIntents({
    sessionId: "session_escape",
    workspacePath: "/workspace/buggy-calculator",
    intents: collected.intents,
    generatedArtifacts: collected.generatedArtifacts,
    validationPlans: collected.validationPlans,
    allowedPaths: [],
    forbiddenPaths: []
  });

  assert.equal(bridged.summaryCounts.realDiff, 0);
  assert.equal(bridged.summaryCounts.blocked, 1);
  assert.ok(bridged.blockedIntents[0].reason.includes("outside workspace") || bridged.blockedIntents[0].reason.includes("invalid"));
});

// ---------------------------------------------------------------------------
// 13. Regression 13 (Req 8): Multi-file diff artifacts in patch.diff are blocked.
// ---------------------------------------------------------------------------
test("Regression 13: multi-file diff artifacts in patch.diff are blocked", () => {
  const multiFileDiff = `--- a/src/calculator.ts\n+++ b/src/calculator.ts\n@@\n export function multiply(a: number, b: number): number {\n-  return a + b;\n+  return a * b;\n }\n--- a/src/index.ts\n+++ b/src/index.ts\n@@\n-export default null;\n+export default {};\n`;
  const multiArtifact: GeneratedArtifact = {
    kind: "generated_artifact",
    path: "patch.diff",
    content: multiFileDiff,
    artifact_type: "text",
    description: "Multi-file patch",
    validation_steps: [],
    completeness_notes: [],
    confidence: 0.8
  };

  const node = makeTestNodeWithArtifact("worker_multi", multiArtifact);
  const collected = collectIntentsFromTree({ [node.id]: node });

  const bridged = bridgeEditIntents({
    sessionId: "session_multi",
    workspacePath: "/workspace/buggy-calculator",
    intents: collected.intents,
    generatedArtifacts: collected.generatedArtifacts,
    validationPlans: collected.validationPlans,
    allowedPaths: ["src/"],
    forbiddenPaths: [],
    fileContents: { "src/calculator.ts": BUGGY_CALCULATOR_FILE_CONTENT }
  });

  assert.equal(bridged.summaryCounts.realDiff, 0);
  assert.equal(bridged.summaryCounts.blocked, 1);
  assert.ok(bridged.blockedIntents[0].reason.includes("Multi-file diff"));
});

// ---------------------------------------------------------------------------
// 14. Regression 14 (Req 9): Duplicate equivalent inner diffs in patch.diff are deduplicated.
// ---------------------------------------------------------------------------
test("Regression 14: duplicate equivalent inner diffs across patch.diff artifacts are deduplicated", () => {
  const artifact1: GeneratedArtifact = {
    kind: "generated_artifact",
    path: "patch.diff",
    content: REAL_WORKER_UNIFIED_DIFF,
    artifact_type: "text",
    description: "Fix multiply bug (worker 1)",
    validation_steps: [],
    completeness_notes: [],
    confidence: 0.95
  };

  const artifact2: GeneratedArtifact = {
    kind: "generated_artifact",
    path: "fix_multiply.patch",
    content: REAL_WORKER_UNIFIED_DIFF.trimEnd() + "\n",
    artifact_type: "text",
    description: "Fix multiply bug (worker 2 duplicate)",
    validation_steps: [],
    completeness_notes: [],
    confidence: 0.9
  };

  const node1 = makeTestNodeWithArtifact("worker_1", artifact1);
  const node2 = makeTestNodeWithArtifact("worker_2", artifact2);
  const collected = collectIntentsFromTree({ [node1.id]: node1, [node2.id]: node2 });

  const bridged = bridgeEditIntents({
    sessionId: "session_dedup_patch_diff",
    workspacePath: "/workspace/buggy-calculator",
    intents: collected.intents,
    generatedArtifacts: collected.generatedArtifacts,
    validationPlans: collected.validationPlans,
    allowedPaths: ["src/"],
    forbiddenPaths: [],
    fileContents: { "src/calculator.ts": BUGGY_CALCULATOR_FILE_CONTENT }
  });

  assert.equal(bridged.summaryCounts.realDiff, 1, "Must deduplicate to 1 real diff");
  assert.equal(bridged.patchCandidates.length, 1);
  assert.equal(bridged.patchCandidates[0].filesChanged[0].path, "src/calculator.ts");
  assert.ok(bridged.diagnostics.some((d) => d.includes("Deduplicating identical patch proposal")));
});

// ---------------------------------------------------------------------------
// 15. Regression 15: Conflicting patch.diff artifacts for same target are blocked
// ---------------------------------------------------------------------------
test("Regression 15: conflicting patch.diff artifacts for same target are blocked with conflict diagnostic", () => {
  const goodArtifact: GeneratedArtifact = {
    kind: "generated_artifact",
    path: "patch.diff",
    content: REAL_WORKER_UNIFIED_DIFF,
    artifact_type: "text",
    description: "Correct multiply fix",
    validation_steps: [],
    completeness_notes: [],
    confidence: 0.95
  };

  const conflictArtifact: GeneratedArtifact = {
    kind: "generated_artifact",
    path: "other_patch.diff",
    content: `--- a/src/calculator.ts\n+++ b/src/calculator.ts\n@@\n export function multiply(a: number, b: number): number {\n-  return a + b;\n+  return 0;\n }\n`,
    artifact_type: "text",
    description: "Conflicting multiply fix",
    validation_steps: [],
    completeness_notes: [],
    confidence: 0.8
  };

  const node1 = makeTestNodeWithArtifact("worker_good", goodArtifact);
  const node2 = makeTestNodeWithArtifact("worker_conflict", conflictArtifact);
  const collected = collectIntentsFromTree({ [node1.id]: node1, [node2.id]: node2 });

  const bridged = bridgeEditIntents({
    sessionId: "session_conflict_patch_diff",
    workspacePath: "/workspace/buggy-calculator",
    intents: collected.intents,
    generatedArtifacts: collected.generatedArtifacts,
    validationPlans: collected.validationPlans,
    allowedPaths: ["src/"],
    forbiddenPaths: [],
    fileContents: { "src/calculator.ts": BUGGY_CALCULATOR_FILE_CONTENT }
  });

  assert.equal(bridged.summaryCounts.realDiff, 1, "First valid proposal kept");
  assert.equal(bridged.summaryCounts.blocked, 1, "Second conflicting proposal blocked");
  assert.ok(bridged.blockedIntents[0].reason.includes("Conflicting patch proposal"));
});

// ---------------------------------------------------------------------------
// 16. Regression 16 (Req 10): No filesystem write or Rust apply occurs in bridge with patch.diff
// ---------------------------------------------------------------------------
test("Regression 16: patch.diff bridging performs no filesystem write or Rust apply", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hivo_patch_diff_fs_"));
  try {
    const srcDir = path.join(tempDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const calcFile = path.join(srcDir, "calculator.ts");
    fs.writeFileSync(calcFile, BUGGY_CALCULATOR_FILE_CONTENT, "utf8");
    const statBefore = fs.statSync(calcFile);

    const artifact: GeneratedArtifact = {
      kind: "generated_artifact",
      path: "patch.diff",
      content: REAL_WORKER_UNIFIED_DIFF,
      artifact_type: "text",
      description: "Multiply fix in patch.diff",
      validation_steps: [],
      completeness_notes: [],
      confidence: 0.95
    };

    const node = makeTestNodeWithArtifact("worker_node", artifact);
    const collected = collectIntentsFromTree({ [node.id]: node });

    const bridged = bridgeEditIntents({
      sessionId: "session_fs_check_patch_diff",
      workspacePath: tempDir,
      intents: collected.intents,
      generatedArtifacts: collected.generatedArtifacts,
      validationPlans: collected.validationPlans,
      allowedPaths: ["src/"],
      forbiddenPaths: []
    });

    // File on disk must remain COMPLETELY UNMODIFIED
    const contentAfter = fs.readFileSync(calcFile, "utf8");
    const statAfter = fs.statSync(calcFile);
    assert.equal(contentAfter, BUGGY_CALCULATOR_FILE_CONTENT, "File on disk must not be touched");
    assert.equal(statAfter.mtimeMs, statBefore.mtimeMs, "mtime must not change");

    // No patch.diff file was created on disk
    assert.equal(fs.existsSync(path.join(tempDir, "patch.diff")), false, "patch.diff must NOT be written to disk");

    // Patch proposal is generated targeting src/calculator.ts with approval required
    assert.equal(bridged.patchCandidates.length, 1);
    assert.equal(bridged.patchCandidates[0].filesChanged[0].path, "src/calculator.ts");
    assert.equal(bridged.patchCandidates[0].requiresApproval, true);
    assert.equal(bridged.patchCandidates[0].status, "proposed");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 17. Regression 17: gatherCurrentFileContents extracts inner target from patch.diff
// ---------------------------------------------------------------------------
test("Regression 17: gatherCurrentFileContents extracts inner target from patch.diff and reads content", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hivo_gather_patch_diff_"));
  try {
    const srcDir = path.join(tempDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const calcFile = path.join(srcDir, "calculator.ts");
    fs.writeFileSync(calcFile, BUGGY_CALCULATOR_FILE_CONTENT, "utf8");

    const artifact: GeneratedArtifact = {
      kind: "generated_artifact",
      path: "patch.diff",
      content: REAL_WORKER_UNIFIED_DIFF,
      artifact_type: "text",
      description: "Multiply fix in patch.diff",
      validation_steps: [],
      completeness_notes: [],
      confidence: 0.95
    };

    const node = makeTestNodeWithArtifact("worker_node", artifact);
    const collected = collectIntentsFromTree({ [node.id]: node });

    const contents = gatherCurrentFileContents(tempDir, collected.intents, collected.generatedArtifacts);

    assert.ok(contents["src/calculator.ts"], "Must gather content for inner target src/calculator.ts");
    assert.equal(contents["src/calculator.ts"], BUGGY_CALCULATOR_FILE_CONTENT);
    assert.equal(contents["patch.diff"], undefined, "Must not have content for non-existent patch.diff");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 18. Regression 18: Patch detection and extraction helpers unit test
// ---------------------------------------------------------------------------
test("Regression 18: isPatchArtifact, parsePatchArtifact, and extractPatchArtifactTargetPath helpers", () => {
  // .diff path
  assert.equal(isPatchArtifact({ kind: "generated_artifact", path: "patch.diff", content: "", artifact_type: "text", description: "", validation_steps: [], completeness_notes: [], confidence: 1 }), true);
  // .patch path
  assert.equal(isPatchArtifact({ kind: "generated_artifact", path: "fix.patch", content: "", artifact_type: "text", description: "", validation_steps: [], completeness_notes: [], confidence: 1 }), true);
  // .txt with diff headers
  assert.equal(isPatchArtifact({ kind: "generated_artifact", path: "fix.txt", content: "--- a/foo.ts\n+++ b/foo.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n", artifact_type: "text", description: "", validation_steps: [], completeness_notes: [], confidence: 1 }), true);
  // Normal .txt output
  assert.equal(isPatchArtifact({ kind: "generated_artifact", path: "test_output.txt", content: "PASS all tests", artifact_type: "text", description: "", validation_steps: [], completeness_notes: [], confidence: 1 }), false);

  // Target path extraction
  const target = extractPatchArtifactTargetPath({
    kind: "generated_artifact",
    path: "patch.diff",
    content: REAL_WORKER_UNIFIED_DIFF,
    artifact_type: "text",
    description: "",
    validation_steps: [],
    completeness_notes: [],
    confidence: 1
  });
  assert.equal(target, "src/calculator.ts");
});

// ---------------------------------------------------------------------------
// 19. Regression 19: Implementation .diff artifact with description mentioning
//     "fixing the failing test" must not be misclassified as auxiliary report
// ---------------------------------------------------------------------------
test("Regression 19: implementation .diff artifact with description mentioning 'fixing the failing test' must be an implementation candidate, not auxiliary", () => {
  // Exact artifact payload produced by the implementation worker in the failed acceptance run
  const FAILED_RUN_PROPOSED_DIFF = `*** Begin Patch
*** Update File: src/calculator.ts
@@
-export function multiply(a: number, b: number): number {
-  return a + b;
-}
+export function multiply(a: number, b: number): number {
+  return a * b;
+}
*** End Patch
`;

  const artifact: GeneratedArtifact = {
    kind: "generated_artifact",
    path: "proposed_change.diff",
    content: FAILED_RUN_PROPOSED_DIFF,
    artifact_type: "text",
    description: "Correct the multiply function to perform multiplication instead of addition, fixing the failing test.",
    validation_steps: ["Run npm test to verify calculator test passes"],
    completeness_notes: ["Fixes failing test in multiply"],
    confidence: 0.95
  };

  // 1. Direct check: isAuxiliaryReportArtifact must be false for an implementation .diff artifact
  const isAux = isAuxiliaryReportArtifact(artifact, {
    isImplementation: true,
    originalGoal: "Fix the failing multiply test in calculator.ts",
    workspacePath: "/workspace/buggy-calculator"
  });
  assert.equal(
    isAux,
    false,
    "Implementation .diff artifact must not be classified as auxiliary report"
  );

  // 2. End-to-end bridge check: the artifact must be evaluated by the implementation pipeline
  // (e.g. either creating a patch candidate or being evaluated as a candidate/blocked intent)
  // rather than being relegated to auxiliaryArtifacts.
  const node = makeTestNodeWithArtifact("worker_node_diff_fix", artifact);
  const collected = collectIntentsFromTree({ [node.id]: node });

  const bridged = bridgeEditIntents({
    sessionId: "session_aux_repro",
    workspacePath: "/workspace/buggy-calculator",
    intents: collected.intents,
    generatedArtifacts: collected.generatedArtifacts,
    validationPlans: collected.validationPlans,
    allowedPaths: ["src/"],
    forbiddenPaths: [],
    fileContents: {
      "src/calculator.ts": BUGGY_CALCULATOR_FILE_CONTENT
    },
    originalGoal: "Fix the failing multiply test in calculator.ts"
  });

  assert.equal(
    (bridged.auxiliaryArtifacts ?? []).length,
    0,
    "Implementation .diff artifact must not be relegated to auxiliaryArtifacts"
  );
});

// ---------------------------------------------------------------------------
// 20. Regression 20: Worker A pseudo-patch conversion to valid modify candidate
// ---------------------------------------------------------------------------
test("Regression 20: Worker A pseudo-patch must convert into a valid modify patch candidate for src/calculator.ts", () => {
  const FAILED_RUN_PROPOSED_DIFF = `*** Begin Patch
*** Update File: src/calculator.ts
@@
-export function multiply(a: number, b: number): number {
-  return a + b;
-}
+export function multiply(a: number, b: number): number {
+  return a * b;
+}
*** End Patch
`;

  const artifact: GeneratedArtifact = {
    kind: "generated_artifact",
    path: "proposed_change.diff",
    content: FAILED_RUN_PROPOSED_DIFF,
    artifact_type: "text",
    description: "Correct the multiply function to perform multiplication instead of addition, fixing the failing test.",
    validation_steps: ["Run npm test to verify calculator test passes"],
    completeness_notes: ["Fixes failing test in multiply"],
    confidence: 0.95
  };

  const node = makeTestNodeWithArtifact("worker_a_pseudo_patch_node", artifact);
  const collected = collectIntentsFromTree({ [node.id]: node });

  const bridged = bridgeEditIntents({
    sessionId: "session_pseudo_patch_conversion",
    workspacePath: "/workspace/buggy-calculator",
    intents: collected.intents,
    generatedArtifacts: collected.generatedArtifacts,
    validationPlans: collected.validationPlans,
    allowedPaths: ["src/"],
    forbiddenPaths: [],
    fileContents: {
      "src/calculator.ts": BUGGY_CALCULATOR_FILE_CONTENT
    },
    originalGoal: "Fix the failing multiply test in calculator.ts"
  });

  // Expected:
  // - One valid modify patch candidate targeting src/calculator.ts
  // - Zero auxiliary artifacts
  // - Zero blocked intents
  assert.equal(
    (bridged.auxiliaryArtifacts ?? []).length,
    0,
    "Must have zero auxiliary artifacts"
  );
  assert.equal(
    bridged.blockedIntents.length,
    0,
    `Must have zero blocked intents, but got blocked: ${bridged.blockedIntents[0]?.reason}`
  );
  assert.equal(
    bridged.patchCandidates.length,
    1,
    "Must produce exactly one patch candidate"
  );
  assert.equal(
    bridged.patchCandidates[0].filesChanged[0]?.path,
    "src/calculator.ts",
    "Patch candidate must target src/calculator.ts"
  );
  assert.equal(
    bridged.patchCandidates[0].filesChanged[0]?.changeType,
    "modify",
    "Patch candidate changeType must be modify"
  );
});

// ---------------------------------------------------------------------------
// 21. Safety 1: Worker A converted patch applies cleanly and changes strictly multiply()
// ---------------------------------------------------------------------------
test("Regression 21: Worker A converted patch applies cleanly via git apply and changes strictly multiply()", () => {
  const FAILED_RUN_PROPOSED_DIFF = `*** Begin Patch
*** Update File: src/calculator.ts
@@
-export function multiply(a: number, b: number): number {
-  return a + b;
-}
+export function multiply(a: number, b: number): number {
+  return a * b;
+}
*** End Patch
`;

  const artifact: GeneratedArtifact = {
    kind: "generated_artifact",
    path: "proposed_change.diff",
    content: FAILED_RUN_PROPOSED_DIFF,
    artifact_type: "text",
    description: "Correct multiply function",
    validation_steps: [],
    completeness_notes: [],
    confidence: 0.95
  };

  const node = makeTestNodeWithArtifact("worker_clean_apply", artifact);
  const collected = collectIntentsFromTree({ [node.id]: node });

  const bridged = bridgeEditIntents({
    sessionId: "session_clean_apply",
    workspacePath: "/workspace/buggy-calculator",
    intents: collected.intents,
    generatedArtifacts: collected.generatedArtifacts,
    validationPlans: collected.validationPlans,
    allowedPaths: ["src/"],
    forbiddenPaths: [],
    fileContents: {
      "src/calculator.ts": BUGGY_CALCULATOR_FILE_CONTENT
    }
  });

  assert.equal(bridged.patchCandidates.length, 1);
  const proposal = bridged.patchCandidates[0];

  // Verify hunk structure
  assert.ok(proposal.unifiedDiff.includes("--- a/src/calculator.ts"));
  assert.ok(proposal.unifiedDiff.includes("+++ b/src/calculator.ts"));
  assert.ok(proposal.unifiedDiff.includes(" export function multiply(a: number, b: number): number {"));

  // Verify only return a + b is changed to return a * b
  const changedLines = proposal.unifiedDiff
    .split(/\r?\n/)
    .filter((l) => (l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---"));
  assert.deepEqual(
    changedLines,
    ["-  return a + b;", "+  return a * b;"],
    "Patch must only change return a + b; to return a * b; in multiply()"
  );

  // Real git apply test in a temporary git repository
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hivo_pseudo_patch_apply_"));
  try {
    execFileSync("git", ["init"], { cwd: tempDir, stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "test@test.local"], { cwd: tempDir, stdio: "pipe" });
    execFileSync("git", ["config", "user.name", "Test Runner"], { cwd: tempDir, stdio: "pipe" });
    const fullPath = path.join(tempDir, "src/calculator.ts");
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, BUGGY_CALCULATOR_FILE_CONTENT, "utf8");
    execFileSync("git", ["add", "."], { cwd: tempDir, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "initial buggy calculator"], { cwd: tempDir, stdio: "pipe" });

    const patchPath = path.join(tempDir, "converted.patch");
    fs.writeFileSync(patchPath, proposal.unifiedDiff, "utf8");

    // Apply the patch using git apply
    execFileSync("git", ["apply", patchPath], { cwd: tempDir, stdio: "pipe" });

    const rawContent = fs.readFileSync(fullPath, "utf8");
    const updatedContent = rawContent.replace(/\r\n/g, "\n");

    // Verify: add() is still a + b
    assert.ok(
      updatedContent.includes("export function add(a: number, b: number): number {\n  return a + b;\n}"),
      "add() must remain unmodified"
    );

    // Verify: multiply() is now a * b
    assert.ok(
      updatedContent.includes("export function multiply(a: number, b: number): number {\n  return a * b;\n}"),
      "multiply() must be updated to return a * b"
    );

    // Verify: subtract() is still a - b
    assert.ok(
      updatedContent.includes("export function subtract(a: number, b: number): number {\n  return a - b;\n}"),
      "subtract() must remain unmodified"
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 22. Safety 2: Pseudo-patch with stale source text is rejected
// ---------------------------------------------------------------------------
test("Regression 22: pseudo-patch with stale source text is rejected as blocked intent", () => {
  const STALE_PSEUDO_PATCH = `*** Begin Patch
*** Update File: src/calculator.ts
@@
-export function multiply(x: number, y: number, z: number): number {
-  return x * y * z;
-}
+export function multiply(x: number, y: number): number {
+  return x * y;
+}
*** End Patch
`;

  const artifact: GeneratedArtifact = {
    kind: "generated_artifact",
    path: "stale_change.diff",
    content: STALE_PSEUDO_PATCH,
    artifact_type: "text",
    description: "Stale edit for old version of calculator",
    validation_steps: [],
    completeness_notes: [],
    confidence: 0.9
  };

  const node = makeTestNodeWithArtifact("worker_stale", artifact);
  const collected = collectIntentsFromTree({ [node.id]: node });

  const bridged = bridgeEditIntents({
    sessionId: "session_stale",
    workspacePath: "/workspace/buggy-calculator",
    intents: collected.intents,
    generatedArtifacts: collected.generatedArtifacts,
    validationPlans: collected.validationPlans,
    allowedPaths: ["src/"],
    forbiddenPaths: [],
    fileContents: {
      "src/calculator.ts": BUGGY_CALCULATOR_FILE_CONTENT
    }
  });

  assert.equal(bridged.patchCandidates.length, 0, "Stale pseudo-patch must produce zero patch candidates");
  assert.equal(bridged.blockedIntents.length, 1, "Stale pseudo-patch must produce one blocked intent");
  assert.ok(
    bridged.blockedIntents[0].reason.includes("expected context or removed lines not found in target file"),
    `Reason must indicate context not found, got: ${bridged.blockedIntents[0].reason}`
  );
});

// ---------------------------------------------------------------------------
// 23. Safety 3: Pseudo-patch with ambiguous matching location is rejected
// ---------------------------------------------------------------------------
test("Regression 23: pseudo-patch with ambiguous matching location is rejected as blocked intent", () => {
  // 'return a + b;' exists in both add() and multiply() in BUGGY_CALCULATOR_FILE_CONTENT
  const AMBIGUOUS_PSEUDO_PATCH = `*** Begin Patch
*** Update File: src/calculator.ts
@@
-  return a + b;
+  return a * b;
*** End Patch
`;

  const artifact: GeneratedArtifact = {
    kind: "generated_artifact",
    path: "ambiguous_change.diff",
    content: AMBIGUOUS_PSEUDO_PATCH,
    artifact_type: "text",
    description: "Ambiguous edit without function header context",
    validation_steps: [],
    completeness_notes: [],
    confidence: 0.8
  };

  const node = makeTestNodeWithArtifact("worker_ambiguous", artifact);
  const collected = collectIntentsFromTree({ [node.id]: node });

  const bridged = bridgeEditIntents({
    sessionId: "session_ambiguous",
    workspacePath: "/workspace/buggy-calculator",
    intents: collected.intents,
    generatedArtifacts: collected.generatedArtifacts,
    validationPlans: collected.validationPlans,
    allowedPaths: ["src/"],
    forbiddenPaths: [],
    fileContents: {
      "src/calculator.ts": BUGGY_CALCULATOR_FILE_CONTENT
    }
  });

  assert.equal(bridged.patchCandidates.length, 0, "Ambiguous pseudo-patch must produce zero patch candidates");
  assert.equal(bridged.blockedIntents.length, 1, "Ambiguous pseudo-patch must produce one blocked intent");
  assert.ok(
    bridged.blockedIntents[0].reason.includes("Ambiguous patch match"),
    `Reason must cite ambiguous match, got: ${bridged.blockedIntents[0].reason}`
  );
});

// ---------------------------------------------------------------------------
// 24. Safety 4: Pseudo-patch with malformed wrappers or multiple file targets is rejected
// ---------------------------------------------------------------------------
test("Regression 24: pseudo-patch with malformed wrappers or multiple file targets is rejected", () => {
  // 24a. Missing End Patch wrapper
  const missingEndArtifact: GeneratedArtifact = {
    kind: "generated_artifact",
    path: "unclosed.diff",
    content: `*** Begin Patch\n*** Update File: src/calculator.ts\n@@\n-export function multiply(a: number, b: number): number {\n+export function multiply(a: number, b: number): number {\n`,
    artifact_type: "text",
    description: "Missing end patch marker",
    validation_steps: [],
    completeness_notes: [],
    confidence: 0.8
  };

  const nodeA = makeTestNodeWithArtifact("worker_unclosed", missingEndArtifact);
  const collectedA = collectIntentsFromTree({ [nodeA.id]: nodeA });
  const bridgedA = bridgeEditIntents({
    sessionId: "session_unclosed",
    workspacePath: "/workspace/buggy-calculator",
    intents: collectedA.intents,
    generatedArtifacts: collectedA.generatedArtifacts,
    validationPlans: collectedA.validationPlans,
    allowedPaths: ["src/"],
    forbiddenPaths: [],
    fileContents: { "src/calculator.ts": BUGGY_CALCULATOR_FILE_CONTENT }
  });

  assert.equal(bridgedA.patchCandidates.length, 0);
  assert.equal(bridgedA.blockedIntents.length, 1);
  assert.ok(bridgedA.blockedIntents[0].reason.includes("Malformed pseudo-patch"));

  // 24b. Missing Update File header
  const missingHeaderArtifact: GeneratedArtifact = {
    kind: "generated_artifact",
    path: "no_header.patch",
    content: `*** Begin Patch\n@@\n-export function multiply(a: number, b: number): number {\n+export function multiply(a: number, b: number): number {\n*** End Patch\n`,
    artifact_type: "text",
    description: "Missing Update File header",
    validation_steps: [],
    completeness_notes: [],
    confidence: 0.8
  };

  const nodeB = makeTestNodeWithArtifact("worker_no_header", missingHeaderArtifact);
  const collectedB = collectIntentsFromTree({ [nodeB.id]: nodeB });
  const bridgedB = bridgeEditIntents({
    sessionId: "session_no_header",
    workspacePath: "/workspace/buggy-calculator",
    intents: collectedB.intents,
    generatedArtifacts: collectedB.generatedArtifacts,
    validationPlans: collectedB.validationPlans,
    allowedPaths: ["src/"],
    forbiddenPaths: [],
    fileContents: { "src/calculator.ts": BUGGY_CALCULATOR_FILE_CONTENT }
  });

  assert.equal(bridgedB.patchCandidates.length, 0);
  assert.equal(bridgedB.blockedIntents.length, 1);
  assert.ok(bridgedB.blockedIntents[0].reason.includes("missing '*** Update File:' header"));

  // 24c. Multiple file targets in single pseudo-patch
  const multiFileArtifact: GeneratedArtifact = {
    kind: "generated_artifact",
    path: "multi_file.diff",
    content: `*** Begin Patch\n*** Update File: src/calculator.ts\n@@\n-  return a + b;\n+  return a * b;\n*** Update File: src/other.ts\n@@\n-foo\n+bar\n*** End Patch\n`,
    artifact_type: "text",
    description: "Multiple file targets in pseudo-patch",
    validation_steps: [],
    completeness_notes: [],
    confidence: 0.8
  };

  const nodeC = makeTestNodeWithArtifact("worker_multi_target", multiFileArtifact);
  const collectedC = collectIntentsFromTree({ [nodeC.id]: nodeC });
  const bridgedC = bridgeEditIntents({
    sessionId: "session_multi_target",
    workspacePath: "/workspace/buggy-calculator",
    intents: collectedC.intents,
    generatedArtifacts: collectedC.generatedArtifacts,
    validationPlans: collectedC.validationPlans,
    allowedPaths: ["src/"],
    forbiddenPaths: [],
    fileContents: { "src/calculator.ts": BUGGY_CALCULATOR_FILE_CONTENT }
  });

  assert.equal(bridgedC.patchCandidates.length, 0);
  assert.equal(bridgedC.blockedIntents.length, 1);
  assert.ok(bridgedC.blockedIntents[0].reason.includes("Multi-file diff artifacts are not supported"));

  // 24d. No diff hunks (missing '@@')
  const noHunkArtifact: GeneratedArtifact = {
    kind: "generated_artifact",
    path: "no_hunks.diff",
    content: `*** Begin Patch\n*** Update File: src/calculator.ts\nJust change the return statement\n*** End Patch\n`,
    artifact_type: "text",
    description: "Prose instead of hunks",
    validation_steps: [],
    completeness_notes: [],
    confidence: 0.8
  };

  const nodeD = makeTestNodeWithArtifact("worker_no_hunks", noHunkArtifact);
  const collectedD = collectIntentsFromTree({ [nodeD.id]: nodeD });
  const bridgedD = bridgeEditIntents({
    sessionId: "session_no_hunks",
    workspacePath: "/workspace/buggy-calculator",
    intents: collectedD.intents,
    generatedArtifacts: collectedD.generatedArtifacts,
    validationPlans: collectedD.validationPlans,
    allowedPaths: ["src/"],
    forbiddenPaths: [],
    fileContents: { "src/calculator.ts": BUGGY_CALCULATOR_FILE_CONTENT }
  });

  assert.equal(bridgedD.patchCandidates.length, 0);
  assert.equal(bridgedD.blockedIntents.length, 1);
  assert.ok(bridgedD.blockedIntents[0].reason.includes("no diff hunks found"));
});
