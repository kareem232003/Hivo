import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  gatherCurrentFileContents,
  RuntimeRecursiveSwarmService
} from "../runtime/RuntimeRecursiveSwarmService.js";
import {
  bridgeEditIntents,
  collectIntentsFromTree,
  type BridgeEditIntent,
  type BridgeGeneratedArtifact
} from "../orchestration/RecursiveEditIntentBridge.js";
import type {
  RecursiveSwarmNode,
  EditIntent,
  GeneratedArtifact
} from "../orchestration/RecursiveSwarmModels.js";
import {
  RECURSIVE_SWARM_SCHEMA_VERSION,
  createGoalEnvelope
} from "../orchestration/RecursiveSwarmModels.js";
import { WorkspaceTools } from "../tools/WorkspaceTools.js";

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

function createTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hivo-swarm-gather-test-"));
  const srcDir = path.join(dir, "src");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, "calculator.ts"), BUGGY_CALCULATOR_FILE_CONTENT, "utf8");
  return dir;
}

function cleanupTempWorkspace(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

function makeWorkerNodeWithEditIntent(id: string, intent: EditIntent): RecursiveSwarmNode {
  return {
    schema_version: RECURSIVE_SWARM_SCHEMA_VERSION,
    id,
    runId: "run_gather_test",
    kind: "task_agent",
    status: "succeeded",
    name: "Calculator Worker",
    role: "Task Agent",
    goalEnvelope: createGoalEnvelope({
      originalGoal: "Fix calculator bug",
      workspaceIdentity: "test",
      localTask: "Fix multiply function"
    }),
    taskPrompt: "Fix multiply bug in calculator.ts",
    depth: 1,
    goalChecks: [],
    steeringQueue: [],
    children: [],
    revision: 1,
    structuredOutput: intent,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

// ---------------------------------------------------------------------------
// 1. RuntimeRecursiveSwarmService supplies actual current file content to
//    bridgeEditIntents for a modify intent.
// ---------------------------------------------------------------------------
test("Requirement 1: RuntimeRecursiveSwarmService supplies actual current file content for a modify intent", () => {
  const workspaceDir = createTempWorkspace();
  try {
    const intent: EditIntent = {
      kind: "edit_intent",
      target_file: "src/calculator.ts",
      target_symbol_or_range: "multiply",
      operation: "modify",
      reason: "Fix multiply function to multiply instead of add",
      expected_behavior: "return a * b;",
      risk: "low",
      evidence_refs: ["file:src/calculator.ts#9-11"]
    };

    const node = makeWorkerNodeWithEditIntent("worker_calc_1", intent);
    const { intents, generatedArtifacts } = collectIntentsFromTree({ [node.id]: node });

    const fileContents = gatherCurrentFileContents(workspaceDir, intents, generatedArtifacts);

    assert.ok(fileContents["src/calculator.ts"], "Must include src/calculator.ts in fileContents");
    assert.equal(fileContents["src/calculator.ts"], BUGGY_CALCULATOR_FILE_CONTENT, "Content must match actual workspace file");
  } finally {
    cleanupTempWorkspace(workspaceDir);
  }
});

// ---------------------------------------------------------------------------
// 2. A valid modify intent against an existing file no longer fails with:
//    "Target file appears to be empty or non-existent".
// ---------------------------------------------------------------------------
test("Requirement 2: Valid modify intent against existing file does not fail with empty or non-existent blocker", () => {
  const workspaceDir = createTempWorkspace();
  try {
    const intent: EditIntent = {
      kind: "edit_intent",
      target_file: "src/calculator.ts",
      target_symbol_or_range: "multiply",
      operation: "modify",
      reason: "Fix multiply function to multiply instead of add",
      expected_behavior: "export function multiply(a: number, b: number): number {\n  return a * b;\n}",
      risk: "low",
      evidence_refs: ["file:src/calculator.ts#9-11"]
    };

    const node = makeWorkerNodeWithEditIntent("worker_calc_2", intent);
    const { intents, generatedArtifacts, validationPlans } = collectIntentsFromTree({ [node.id]: node });

    // Without fileContents: fails with "Target file appears to be empty or non-existent"
    const unbridged = bridgeEditIntents({
      sessionId: "sess_test_fail",
      workspacePath: workspaceDir,
      intents,
      generatedArtifacts,
      validationPlans,
      allowedPaths: [],
      forbiddenPaths: []
    });
    assert.equal(unbridged.patchCandidates.length, 0, "Without fileContents, must produce 0 patch candidates");
    assert.ok(
      unbridged.blockedIntents.some((b) => b.reason.includes("Target file appears to be empty or non-existent")),
      "Without fileContents, must block with empty/non-existent reason"
    );

    // With gatherCurrentFileContents: succeeds without empty/non-existent blocker
    const fileContents = gatherCurrentFileContents(workspaceDir, intents, generatedArtifacts);
    const bridged = bridgeEditIntents({
      sessionId: "sess_test_pass",
      workspacePath: workspaceDir,
      intents,
      generatedArtifacts,
      validationPlans,
      allowedPaths: [],
      forbiddenPaths: [],
      fileContents,
      builderOverrides: {
        "src/calculator.ts": {
          exactOldText: "  return a + b;",
          replacementText: "  return a * b;"
        }
      }
    });

    assert.equal(bridged.summaryCounts.blocked, 0, "Must have 0 blocked intents");
    assert.equal(bridged.summaryCounts.realDiff, 1, "Must produce 1 real diff");
    assert.equal(bridged.patchCandidates.length, 1, "Must produce 1 patch candidate");
    assert.ok(
      !bridged.blockedIntents.some((b) => b.reason.includes("Target file appears to be empty or non-existent")),
      "Must not block with empty/non-existent reason"
    );
  } finally {
    cleanupTempWorkspace(workspaceDir);
  }
});

// ---------------------------------------------------------------------------
// 3. The resulting PatchProposal is:
//    - changeType: "modify"
//    - target: src/calculator.ts
//    - requires approval
//    - contains the minimal expected diff.
// ---------------------------------------------------------------------------
test("Requirement 3: Resulting PatchProposal is modify, targets src/calculator.ts, requires approval, minimal diff", () => {
  const workspaceDir = createTempWorkspace();
  try {
    const intent: EditIntent = {
      kind: "edit_intent",
      target_file: "src/calculator.ts",
      target_symbol_or_range: "multiply",
      operation: "modify",
      reason: "Fix multiply bug",
      expected_behavior: "return a * b;",
      risk: "low",
      evidence_refs: ["file:src/calculator.ts#9-11"]
    };

    const node = makeWorkerNodeWithEditIntent("worker_calc_3", intent);
    const { intents, generatedArtifacts, validationPlans } = collectIntentsFromTree({ [node.id]: node });
    const fileContents = gatherCurrentFileContents(workspaceDir, intents, generatedArtifacts);

    const bridged = bridgeEditIntents({
      sessionId: "sess_test_prop",
      workspacePath: workspaceDir,
      intents,
      generatedArtifacts,
      validationPlans,
      allowedPaths: [],
      forbiddenPaths: [],
      fileContents,
      builderOverrides: {
        "src/calculator.ts": {
          exactOldText: "export function multiply(a: number, b: number): number {\n  return a + b;\n}",
          replacementText: "export function multiply(a: number, b: number): number {\n  return a * b;\n}"
        }
      }
    });

    assert.equal(bridged.patchCandidates.length, 1);
    const proposal = bridged.patchCandidates[0];

    assert.equal(proposal.filesChanged[0].changeType, "modify", "changeType must be 'modify'");
    assert.equal(proposal.filesChanged[0].path, "src/calculator.ts", "target file must be src/calculator.ts");
    assert.equal(proposal.requiresApproval, true, "proposal must require approval");
    assert.equal(proposal.status, "proposed");

    // Unified diff assertions
    assert.ok(proposal.unifiedDiff.includes("--- a/src/calculator.ts"), "must reference a/src/calculator.ts");
    assert.ok(proposal.unifiedDiff.includes("+++ b/src/calculator.ts"), "must reference b/src/calculator.ts");
    assert.ok(!proposal.unifiedDiff.includes("/dev/null"), "must not reference /dev/null");
    assert.ok(proposal.unifiedDiff.includes("-  return a + b;"), "must remove return a + b");
    assert.ok(proposal.unifiedDiff.includes("+  return a * b;"), "must add return a * b");
    assert.ok(proposal.unifiedDiff.includes("export function multiply"), "must keep multiply function context");
    assert.ok(!proposal.unifiedDiff.includes("-export function subtract") && !proposal.unifiedDiff.includes("-  return a - b;"), "must not modify subtract");
  } finally {
    cleanupTempWorkspace(workspaceDir);
  }
});

// ---------------------------------------------------------------------------
// 4. Create intents still work without existing file contents.
// ---------------------------------------------------------------------------
test("Requirement 4: Create intents still work without existing file contents", () => {
  const workspaceDir = createTempWorkspace();
  try {
    const createIntent: EditIntent = {
      kind: "edit_intent",
      target_file: "src/helper.ts",
      target_symbol_or_range: "helperFn",
      operation: "create",
      reason: "Add new helper module",
      expected_behavior: "export function helperFn() { return 42; }",
      risk: "low",
      evidence_refs: ["spec:new_helper"]
    };

    const node = makeWorkerNodeWithEditIntent("worker_create_1", createIntent);
    const { intents, generatedArtifacts, validationPlans } = collectIntentsFromTree({ [node.id]: node });

    // gatherCurrentFileContents should NOT attempt to read the new file
    const fileContents = gatherCurrentFileContents(workspaceDir, intents, generatedArtifacts);
    assert.equal(fileContents["src/helper.ts"], undefined, "Create intent target must not be in fileContents");

    // Bridge creates new file proposal
    const bridged = bridgeEditIntents({
      sessionId: "sess_create_test",
      workspacePath: workspaceDir,
      intents,
      generatedArtifacts,
      validationPlans,
      allowedPaths: [],
      forbiddenPaths: [],
      fileContents,
      builderOverrides: {
        "src/helper.ts": {
          replacementText: "export function helperFn(): number {\n  return 42;\n}\n"
        }
      }
    });

    assert.equal(bridged.patchCandidates.length, 1, "Must produce patch proposal for create intent");
    const proposal = bridged.patchCandidates[0];
    assert.equal(proposal.filesChanged[0].changeType, "create");
    assert.equal(proposal.filesChanged[0].path, "src/helper.ts");
    assert.ok(proposal.unifiedDiff.includes("--- /dev/null"), "Create patch must start from /dev/null");
    assert.ok(proposal.unifiedDiff.includes("+++ b/src/helper.ts"));
    assert.ok(proposal.unifiedDiff.includes("+export function helperFn(): number {"));
  } finally {
    cleanupTempWorkspace(workspaceDir);
  }
});

// ---------------------------------------------------------------------------
// 5. Missing/unreadable existing files remain blocked safely.
// ---------------------------------------------------------------------------
test("Requirement 5: Missing or unreadable existing files remain blocked safely without fake empty string", () => {
  const workspaceDir = createTempWorkspace();
  try {
    const missingIntent: EditIntent = {
      kind: "edit_intent",
      target_file: "src/nonexistent_file.ts",
      target_symbol_or_range: "foo",
      operation: "modify",
      reason: "Modify nonexistent file",
      expected_behavior: "return true;",
      risk: "low",
      evidence_refs: ["ref:missing"]
    };

    const node = makeWorkerNodeWithEditIntent("worker_missing_1", missingIntent);
    const { intents, generatedArtifacts, validationPlans } = collectIntentsFromTree({ [node.id]: node });

    const fileContents = gatherCurrentFileContents(workspaceDir, intents, generatedArtifacts);
    // Must NOT substitute "" or pretend it was read
    assert.equal(fileContents["src/nonexistent_file.ts"], undefined, "Missing file must NOT be present in fileContents");

    const bridged = bridgeEditIntents({
      sessionId: "sess_missing_test",
      workspacePath: workspaceDir,
      intents,
      generatedArtifacts,
      validationPlans,
      allowedPaths: [],
      forbiddenPaths: [],
      fileContents
    });

    assert.equal(bridged.patchCandidates.length, 0, "No patch candidate should be created for missing file");
    assert.equal(bridged.blockedIntents.length, 1, "Intent must be blocked");
    assert.ok(
      bridged.blockedIntents[0].reason.includes("Target file appears to be empty or non-existent"),
      "Blocked reason must explicitly state empty or non-existent file"
    );
  } finally {
    cleanupTempWorkspace(workspaceDir);
  }
});

// ---------------------------------------------------------------------------
// 6. Unsafe/out-of-workspace paths are not read.
// ---------------------------------------------------------------------------
test("Requirement 6: Unsafe, secret, binary, and out-of-workspace paths are not read", () => {
  const workspaceDir = createTempWorkspace();
  try {
    // Write a secret file and a binary file inside workspace to test security checks
    fs.writeFileSync(path.join(workspaceDir, ".env"), "SECRET_KEY=12345\n", "utf8");
    fs.writeFileSync(path.join(workspaceDir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const intents: BridgeEditIntent[] = [
      {
        nodeId: "n_traversal",
        intent: {
          kind: "edit_intent",
          target_file: "../../outside.ts",
          target_symbol_or_range: "x",
          operation: "modify",
          reason: "Read outside file",
          expected_behavior: "hack",
          risk: "high",
          evidence_refs: []
        }
      },
      {
        nodeId: "n_secret",
        intent: {
          kind: "edit_intent",
          target_file: ".env",
          target_symbol_or_range: "key",
          operation: "modify",
          reason: "Modify secret",
          expected_behavior: "leak",
          risk: "high",
          evidence_refs: []
        }
      },
      {
        nodeId: "n_binary",
        intent: {
          kind: "edit_intent",
          target_file: "logo.png",
          target_symbol_or_range: "image",
          operation: "modify",
          reason: "Modify binary",
          expected_behavior: "corrupt",
          risk: "high",
          evidence_refs: []
        }
      }
    ];

    const fileContents = gatherCurrentFileContents(workspaceDir, intents, []);

    assert.equal(fileContents["../../outside.ts"], undefined, "Traversal path must not be read");
    assert.equal(fileContents[".env"], undefined, "Secret file must not be read");
    assert.equal(fileContents["logo.png"], undefined, "Binary file must not be read");
    assert.equal(Object.keys(fileContents).length, 0, "No unsafe file content may be populated");
  } finally {
    cleanupTempWorkspace(workspaceDir);
  }
});

// ---------------------------------------------------------------------------
// 7. No filesystem write occurs while gathering fileContents.
// ---------------------------------------------------------------------------
test("Requirement 7: No filesystem write occurs while gathering fileContents", () => {
  const workspaceDir = createTempWorkspace();
  try {
    const filePath = path.join(workspaceDir, "src", "calculator.ts");
    const statBefore = fs.statSync(filePath);

    const intent: EditIntent = {
      kind: "edit_intent",
      target_file: "src/calculator.ts",
      target_symbol_or_range: "multiply",
      operation: "modify",
      reason: "Fix multiply bug",
      expected_behavior: "return a * b;",
      risk: "low",
      evidence_refs: ["file:src/calculator.ts#9-11"]
    };

    const node = makeWorkerNodeWithEditIntent("worker_calc_mtime", intent);
    const { intents, generatedArtifacts } = collectIntentsFromTree({ [node.id]: node });

    const fileContents = gatherCurrentFileContents(workspaceDir, intents, generatedArtifacts);

    const statAfter = fs.statSync(filePath);
    assert.equal(statBefore.mtimeMs, statAfter.mtimeMs, "mtime must be unchanged");
    assert.equal(statBefore.size, statAfter.size, "file size must be unchanged");
    assert.equal(fs.readFileSync(filePath, "utf8"), BUGGY_CALCULATOR_FILE_CONTENT, "file content on disk must be identical");
    assert.ok(fileContents["src/calculator.ts"], "content was read into memory only");
  } finally {
    cleanupTempWorkspace(workspaceDir);
  }
});

// ---------------------------------------------------------------------------
// 8. Recursive children still receive no filesystem authority.
// ---------------------------------------------------------------------------
test("Requirement 8: Children receive no filesystem authority and WorkspaceTools blocks writes", () => {
  const workspaceDir = createTempWorkspace();
  try {
    const tools = new WorkspaceTools(workspaceDir);

    // Verify WorkspaceTools itself strictly rejects writes and deletes
    assert.throws(
      () => tools.writeFile("src/test.txt", "content"),
      /Runtime file writes are disabled/
    );
    assert.throws(
      () => tools.deleteFile("src/calculator.ts"),
      /Runtime file deletes are disabled/
    );

    // Verify empty/missing workspacePath safely returns empty record
    const emptyContents = gatherCurrentFileContents(undefined, []);
    assert.deepEqual(emptyContents, {}, "undefined workspace returns empty record");
  } finally {
    cleanupTempWorkspace(workspaceDir);
  }
});
