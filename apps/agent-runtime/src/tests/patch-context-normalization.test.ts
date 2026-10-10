import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  tryNormalizeExistingFilePatch,
  bridgeEditIntents
} from "../orchestration/RecursiveEditIntentBridge.js";
import { buildSurgicalPatch } from "../orchestration/SurgicalPatchBuilder.js";
import type { GeneratedArtifact } from "../orchestration/RecursiveSwarmModels.js";

const CALCULATOR_FILE_CONTENT_LF = `export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}

export function multiply(a: number, b: number): number {
  return a + b;
}

export function divide(a: number, b: number): number {
  return a / b;
}
`;

const ZERO_CONTEXT_MULTIPLY_DIFF = `--- a/src/calculator.ts
+++ b/src/calculator.ts
@@ -9,3 +9,3 @@
-export function multiply(a: number, b: number): number {
-  return a + b;
-}
+export function multiply(a: number, b: number): number {
+  return a * b;
+}
`;

function createGitRepo(tempDir: string, filePath: string, content: string): void {
  execFileSync("git", ["init"], { cwd: tempDir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.local"], { cwd: tempDir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test Runner"], { cwd: tempDir, stdio: "pipe" });
  const fullPath = path.join(tempDir, filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
  execFileSync("git", ["add", "."], { cwd: tempDir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial commit"], { cwd: tempDir, stdio: "pipe" });
}

// ---------------------------------------------------------------------------
// 1. zero-context incoming modify patch becomes contextual
// 2. common unchanged prefix/suffix become context where appropriate
// 3. 3-line surrounding context is used when available
// 4. correct old/new hunk counts
// ---------------------------------------------------------------------------
test("Proof 1-4: zero-context incoming modify patch converts prefix/suffix and adds 3-line context with accurate counts", () => {
  const norm = tryNormalizeExistingFilePatch(
    "src/calculator.ts",
    CALCULATOR_FILE_CONTENT_LF,
    ZERO_CONTEXT_MULTIPLY_DIFF
  );

  assert.equal(norm.valid, true, `Normalization must succeed: ${norm.reason}`);
  const diff = norm.normalizedDiff!;
  assert.ok(diff, "Must produce normalized diff");

  // 1 & 2: common unchanged prefix/suffix converted to context lines
  assert.ok(diff.includes(" export function multiply(a: number, b: number): number {"), "Common prefix must be context line");
  assert.ok(diff.includes(" }"), "Common suffix must be context line");
  assert.ok(diff.includes("-  return a + b;"), "Removed line must be strictly the buggy return");
  assert.ok(diff.includes("+  return a * b;"), "Added line must be strictly the fixed return");
  assert.ok(!diff.includes("-export function multiply"), "Header line must NOT be marked as removed");
  assert.ok(!diff.includes("+export function multiply"), "Header line must NOT be marked as added");

  // 3: 3-line surrounding context before and after
  // 3 lines before:
  // line 7: "}"
  // line 8: ""
  // line 9: "export function multiply(a: number, b: number): number {"
  // 3 lines after:
  // line 11: "}"
  // line 12: ""
  // line 13: "export function divide(a: number, b: number): number {"
  assert.ok(diff.includes("@@ -7,7 +7,7 @@"), "Must have hunk header @@ -7,7 +7,7 @@");
  assert.ok(diff.includes(" export function divide(a: number, b: number): number {"), "Post-context must include divide function line");

  // 4: count verify
  const lines = diff.split("\n");
  const hunkLines = lines.filter((l) => (l.startsWith(" ") || l.startsWith("-") || l.startsWith("+")) && !l.startsWith("---") && !l.startsWith("+++"));
  const contextLines = hunkLines.filter((l) => l.startsWith(" "));
  const minusLines = hunkLines.filter((l) => l.startsWith("-"));
  const plusLines = hunkLines.filter((l) => l.startsWith("+"));

  assert.equal(contextLines.length, 6, "Must have exactly 6 context lines (3 pre + 3 post)");
  assert.equal(minusLines.length, 1, "Must have exactly 1 removed line");
  assert.equal(plusLines.length, 1, "Must have exactly 1 added line");

  const oldCount = contextLines.length + minusLines.length;
  const newCount = contextLines.length + plusLines.length;
  assert.equal(oldCount, 7);
  assert.equal(newCount, 7);
});

// ---------------------------------------------------------------------------
// 5. LF patch passes real `git apply --check`
// ---------------------------------------------------------------------------
test("Proof 5: LF patch passes real git apply --check", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hivo_test_lf_"));
  try {
    createGitRepo(tempDir, "src/calculator.ts", CALCULATOR_FILE_CONTENT_LF);

    const norm = tryNormalizeExistingFilePatch(
      "src/calculator.ts",
      CALCULATOR_FILE_CONTENT_LF,
      ZERO_CONTEXT_MULTIPLY_DIFF
    );
    assert.equal(norm.valid, true);

    const patchPath = path.join(tempDir, "test.patch");
    fs.writeFileSync(patchPath, norm.normalizedDiff!, "utf8");

    // Must pass git apply --check without error
    const result = execFileSync("git", ["apply", "--check", patchPath], { cwd: tempDir, encoding: "utf8" });
    assert.equal(result, "", "git apply --check should output nothing on success");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. CRLF patch passes real `git apply --check`
// ---------------------------------------------------------------------------
test("Proof 6: CRLF patch passes real git apply --check", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hivo_test_crlf_"));
  try {
    const CRLF_CONTENT = CALCULATOR_FILE_CONTENT_LF.replace(/\n/g, "\r\n");
    createGitRepo(tempDir, "src/calculator.ts", CRLF_CONTENT);

    const norm = tryNormalizeExistingFilePatch(
      "src/calculator.ts",
      CRLF_CONTENT,
      ZERO_CONTEXT_MULTIPLY_DIFF
    );
    assert.equal(norm.valid, true);

    const patchPath = path.join(tempDir, "test.patch");
    fs.writeFileSync(patchPath, norm.normalizedDiff!, "utf8");

    // Must pass git apply --check without error against CRLF file
    const result = execFileSync("git", ["apply", "--check", patchPath], { cwd: tempDir, encoding: "utf8" });
    assert.equal(result, "", "git apply --check should output nothing on success for CRLF");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7. Beginning-of-file edit works
// ---------------------------------------------------------------------------
test("Proof 7: beginning-of-file edit works and passes git apply --check", () => {
  const content = `line 1
line 2
line 3
line 4
line 5
`;
  const incomingDiff = `--- a/file.txt
+++ b/file.txt
@@ -1,1 +1,1 @@
-line 1
+line 1 updated
`;
  const norm = tryNormalizeExistingFilePatch("file.txt", content, incomingDiff);
  assert.equal(norm.valid, true);

  // 0 pre-context lines, 3 post-context lines
  assert.ok(norm.normalizedDiff!.includes("@@ -1,4 +1,4 @@"), `Hunk must be @@ -1,4 +1,4 @@ but got: ${norm.normalizedDiff}`);
  assert.ok(norm.normalizedDiff!.includes("-line 1"));
  assert.ok(norm.normalizedDiff!.includes("+line 1 updated"));
  assert.ok(norm.normalizedDiff!.includes(" line 2"));
  assert.ok(norm.normalizedDiff!.includes(" line 3"));
  assert.ok(norm.normalizedDiff!.includes(" line 4"));

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hivo_test_bof_"));
  try {
    createGitRepo(tempDir, "file.txt", content);
    const patchPath = path.join(tempDir, "bof.patch");
    fs.writeFileSync(patchPath, norm.normalizedDiff!, "utf8");
    const result = execFileSync("git", ["apply", "--check", patchPath], { cwd: tempDir, encoding: "utf8" });
    assert.equal(result, "");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 8. End-of-file edit works
// ---------------------------------------------------------------------------
test("Proof 8: end-of-file edit works and passes git apply --check", () => {
  const content = `line 1
line 2
line 3
line 4
line 5
`;
  const incomingDiff = `--- a/file.txt
+++ b/file.txt
@@ -5,1 +5,1 @@
-line 5
+line 5 updated
`;
  const norm = tryNormalizeExistingFilePatch("file.txt", content, incomingDiff);
  assert.equal(norm.valid, true);

  // 3 pre-context lines, 0 post-context lines
  assert.ok(norm.normalizedDiff!.includes("@@ -2,4 +2,4 @@"), `Hunk must be @@ -2,4 +2,4 @@ but got: ${norm.normalizedDiff}`);
  assert.ok(norm.normalizedDiff!.includes(" line 2"));
  assert.ok(norm.normalizedDiff!.includes(" line 3"));
  assert.ok(norm.normalizedDiff!.includes(" line 4"));
  assert.ok(norm.normalizedDiff!.includes("-line 5"));
  assert.ok(norm.normalizedDiff!.includes("+line 5 updated"));

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hivo_test_eof_"));
  try {
    createGitRepo(tempDir, "file.txt", content);
    const patchPath = path.join(tempDir, "eof.patch");
    fs.writeFileSync(patchPath, norm.normalizedDiff!, "utf8");
    const result = execFileSync("git", ["apply", "--check", patchPath], { cwd: tempDir, encoding: "utf8" });
    assert.equal(result, "");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 9. create-file behavior unchanged
// ---------------------------------------------------------------------------
test("Proof 9: create-file behavior unchanged", () => {
  const newFileContent = "export const x = 1;\nexport const y = 2;";
  const artifact: GeneratedArtifact = {
    kind: "generated_artifact",
    path: "src/new-module.ts",
    content: newFileContent,
    artifact_type: "text",
    description: "Create new module",
    validation_steps: [],
    completeness_notes: [],
    confidence: 0.9
  };

  const bridged = bridgeEditIntents({
    sessionId: "sess_create",
    workspacePath: "/fake/workspace",
    intents: [],
    generatedArtifacts: [{ nodeId: "node_create", artifact }],
    validationPlans: [],
    allowedPaths: ["src/"],
    forbiddenPaths: [],
    fileContents: {}
  });

  assert.equal(bridged.summaryCounts.realDiff, 1);
  const p = bridged.patchCandidates[0];
  assert.equal(p.filesChanged[0].changeType, "create");
  assert.ok(p.unifiedDiff.includes("--- /dev/null"));
  assert.ok(p.unifiedDiff.includes("+++ b/src/new-module.ts"));
  assert.ok(p.unifiedDiff.includes("@@ -0,0 +1,2 @@"));
  assert.ok(p.unifiedDiff.includes("+export const x = 1;"));
});

// ---------------------------------------------------------------------------
// 10. delete-file behavior unchanged
// ---------------------------------------------------------------------------
test("Proof 10: delete-file behavior unchanged", () => {
  const artifact: GeneratedArtifact = {
    kind: "generated_artifact",
    path: "src/old-module.ts",
    content: `--- a/src/old-module.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const old = true;
-export const remove = true;
-`,
    artifact_type: "text",
    description: "Delete old module",
    validation_steps: [],
    completeness_notes: [],
    confidence: 0.9
  };

  const bridged = bridgeEditIntents({
    sessionId: "sess_delete",
    workspacePath: "/fake/workspace",
    intents: [],
    generatedArtifacts: [{ nodeId: "node_delete", artifact }],
    validationPlans: [],
    allowedPaths: ["src/"],
    forbiddenPaths: [],
    fileContents: {
      "src/old-module.ts": "export const old = true;\nexport const remove = true;"
    }
  });

  assert.equal(bridged.summaryCounts.realDiff, 1);
  const p = bridged.patchCandidates[0];
  assert.equal(p.filesChanged[0].changeType, "delete");
  assert.ok(p.unifiedDiff.includes("--- a/src/old-module.ts"));
  assert.ok(p.unifiedDiff.includes("+++ /dev/null"));
  assert.ok(p.unifiedDiff.includes("@@ -1,2 +0,0 @@"));
  assert.ok(p.unifiedDiff.includes("-export const old = true;"));
});

// ---------------------------------------------------------------------------
// 11. SurgicalPatchBuilder existing-file modification produces valid contextual patch
// ---------------------------------------------------------------------------
test("Proof 11: SurgicalPatchBuilder existing-file modification produces valid contextual patch that passes git apply --check", () => {
  const result = buildSurgicalPatch({
    editIntent: {
      kind: "edit_intent",
      target_file: "src/calculator.ts",
      target_symbol_or_range: "multiply",
      operation: "modify",
      reason: "Fix multiply operator",
      expected_behavior: "Multiplies instead of adds",
      risk: "low",
      evidence_refs: ["ref_1"]
    },
    allowedPaths: ["src/"],
    forbiddenPaths: [],
    workspacePath: "/workspace",
    currentFileContent: CALCULATOR_FILE_CONTENT_LF,
    exactOldText: `export function multiply(a: number, b: number): number {
  return a + b;
}`,
    replacementText: `export function multiply(a: number, b: number): number {
  return a * b;
}`
  });

  assert.equal(result.status, "real_diff");
  if (result.status === "real_diff") {
    assert.ok(result.unifiedDiff.includes("@@ -7,7 +7,7 @@"), `Hunk must be @@ -7,7 +7,7 @@ but got: ${result.unifiedDiff}`);
    assert.ok(result.unifiedDiff.includes(" export function multiply(a: number, b: number): number {"));
    assert.ok(result.unifiedDiff.includes("-  return a + b;"));
    assert.ok(result.unifiedDiff.includes("+  return a * b;"));

    // Test real git apply --check with SurgicalPatchBuilder output
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hivo_test_spb_"));
    try {
      createGitRepo(tempDir, "src/calculator.ts", CALCULATOR_FILE_CONTENT_LF);
      const patchPath = path.join(tempDir, "spb.patch");
      fs.writeFileSync(patchPath, result.unifiedDiff, "utf8");
      const checkResult = execFileSync("git", ["apply", "--check", patchPath], { cwd: tempDir, encoding: "utf8" });
      assert.equal(checkResult, "");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------------------
// 12. No direct workspace mutation occurs
// ---------------------------------------------------------------------------
test("Proof 12: no direct workspace mutation occurs during normalization or bridging", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hivo_test_nomutate_"));
  try {
    const calcPath = path.join(tempDir, "src", "calculator.ts");
    fs.mkdirSync(path.dirname(calcPath), { recursive: true });
    fs.writeFileSync(calcPath, CALCULATOR_FILE_CONTENT_LF, "utf8");

    const contentBefore = fs.readFileSync(calcPath, "utf8");

    // Run normalization
    tryNormalizeExistingFilePatch("src/calculator.ts", contentBefore, ZERO_CONTEXT_MULTIPLY_DIFF);

    // Run bridging
    bridgeEditIntents({
      sessionId: "sess_nomutate",
      workspacePath: tempDir,
      intents: [],
      generatedArtifacts: [{
        nodeId: "node_nomutate",
        artifact: {
          kind: "generated_artifact",
          path: "src/calculator.ts",
          content: ZERO_CONTEXT_MULTIPLY_DIFF,
          artifact_type: "text",
          description: "Test",
          validation_steps: [],
          completeness_notes: [],
          confidence: 0.9
        }
      }],
      validationPlans: [],
      allowedPaths: ["src/"],
      forbiddenPaths: []
    });

    // Run SurgicalPatchBuilder
    buildSurgicalPatch({
      editIntent: {
        kind: "edit_intent",
        target_file: "src/calculator.ts",
        target_symbol_or_range: "multiply",
        operation: "modify",
        reason: "Fix",
        expected_behavior: "Multiplies",
        risk: "low",
        evidence_refs: ["ref_1"]
      },
      allowedPaths: ["src/"],
      forbiddenPaths: [],
      workspacePath: tempDir,
      currentFileContent: contentBefore,
      exactOldText: "return a + b;",
      replacementText: "return a * b;"
    });

    const contentAfter = fs.readFileSync(calcPath, "utf8");
    assert.equal(contentAfter, contentBefore, "Workspace file must not have been mutated in any way");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
