import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkerExecutionContract,
  type WorkerExecutionContract
} from "../orchestration/RecursiveSwarmModels.js";

test("Counterexample 1: Parent permits exact file 'src/calculator.ts'; child requests parent directory 'src' — MUST REJECT", () => {
  const parentContract = createWorkerExecutionContract({
    nodeId: "parent-1",
    taskPrompt: "Fix multiply in src/calculator.ts",
    originalGoal: "Fix multiply in src/calculator.ts",
    proposedMutationScope: ["src/calculator.ts"]
  });
  assert.deepEqual(parentContract.proposedMutationScope, ["src/calculator.ts"]);

  const childContract = createWorkerExecutionContract({
    nodeId: "child-1",
    parentId: "parent-1",
    taskPrompt: "Fix multiply in src/calculator.ts",
    originalGoal: "Fix multiply in src/calculator.ts",
    parentContract,
    proposedMutationScope: ["src"]
  });

  // Child MUST NOT be granted 'src' because parent only granted 'src/calculator.ts'
  assert.ok(
    !childContract.proposedMutationScope.includes("src"),
    `Child scope expansion vulnerability: child granted 'src' from parent scope '${parentContract.proposedMutationScope.join(",")}'`
  );
  assert.deepEqual(childContract.proposedMutationScope, []);
});

test("Counterexample 2: Parent permits 'src/foo.ts'; child requests sibling prefix extension 'src/foo.ts.bak' — MUST REJECT", () => {
  const parentContract = createWorkerExecutionContract({
    nodeId: "parent-2",
    taskPrompt: "Fix foo in src/foo.ts",
    originalGoal: "Fix foo in src/foo.ts",
    proposedMutationScope: ["src/foo.ts"]
  });

  const childContract = createWorkerExecutionContract({
    nodeId: "child-2",
    parentId: "parent-2",
    taskPrompt: "Fix foo in src/foo.ts",
    originalGoal: "Fix foo in src/foo.ts",
    parentContract,
    proposedMutationScope: ["src/foo.ts.bak"]
  });

  assert.ok(
    !childContract.proposedMutationScope.includes("src/foo.ts.bak"),
    `Child scope string-prefix vulnerability: child granted 'src/foo.ts.bak' from parent 'src/foo.ts'`
  );
  assert.deepEqual(childContract.proposedMutationScope, []);
});

test("Counterexample 3: Parent permits directory 'src'; child requests subpath 'src/calculator.ts' — ALLOW", () => {
  const parentContract = createWorkerExecutionContract({
    nodeId: "parent-3",
    taskPrompt: "Fix files in src",
    originalGoal: "Fix files in src",
    proposedMutationScope: ["src"]
  });

  const childContract = createWorkerExecutionContract({
    nodeId: "child-3",
    parentId: "parent-3",
    taskPrompt: "Fix calculator in src/calculator.ts",
    originalGoal: "Fix calculator in src/calculator.ts",
    parentContract,
    proposedMutationScope: ["src/calculator.ts"]
  });

  assert.deepEqual(childContract.proposedMutationScope, ["src/calculator.ts"]);
});

test("Counterexample 4: Parent has no mutation authority (empty mutation scope); child requests 'src/calculator.ts' — MUST NOT invent or grant authority", () => {
  const parentContract = createWorkerExecutionContract({
    nodeId: "parent-4",
    taskPrompt: "Inspect calculator defect",
    originalGoal: "Fix multiply bug in calculator",
    explicitResponsibility: "INSPECT",
    proposedMutationScope: []
  });
  assert.deepEqual(parentContract.proposedMutationScope, []);

  const childContract = createWorkerExecutionContract({
    nodeId: "child-4",
    parentId: "parent-4",
    taskPrompt: "Fix multiply in src/calculator.ts",
    originalGoal: "Fix multiply bug in calculator",
    parentContract,
    proposedMutationScope: ["src/calculator.ts"]
  });

  // When parent has no mutation scope / authority, child MUST NOT invent authority
  assert.deepEqual(
    childContract.proposedMutationScope,
    [],
    "Child contract must not invent mutation authority when parent has no mutation authority"
  );

  // Subcase 4b: Parent is IMPLEMENT but has explicitly empty proposedMutationScope
  const parentImplEmptyScope = createWorkerExecutionContract({
    nodeId: "parent-4b",
    taskPrompt: "Refactor code without files",
    originalGoal: "Fix calculator",
    explicitResponsibility: "IMPLEMENT",
    proposedMutationScope: []
  });
  const childOfEmptyScope = createWorkerExecutionContract({
    nodeId: "child-4b",
    parentId: "parent-4b",
    taskPrompt: "Fix multiply in src/calculator.ts",
    originalGoal: "Fix calculator",
    parentContract: parentImplEmptyScope,
    proposedMutationScope: ["src/calculator.ts"]
  });
  assert.deepEqual(
    childOfEmptyScope.proposedMutationScope,
    [],
    "Child must not invent mutation scope when parent has explicitly empty proposedMutationScope"
  );
});

test("Counterexample 5: Traversal and absolute-path tricks must not bypass scope rules", () => {
  const parentContract = createWorkerExecutionContract({
    nodeId: "parent-5",
    taskPrompt: "Fix calculator",
    originalGoal: "Fix calculator",
    proposedMutationScope: ["src/calculator.ts"]
  });

  // Try directory traversal out of parent scope
  const childTraversal = createWorkerExecutionContract({
    nodeId: "child-5-traversal",
    parentId: "parent-5",
    taskPrompt: "Fix calculator",
    originalGoal: "Fix calculator",
    parentContract,
    proposedMutationScope: ["src/calculator.ts/../../package.json"]
  });
  assert.deepEqual(childTraversal.proposedMutationScope, []);

  // Try absolute POSIX path
  const childAbsolutePosix = createWorkerExecutionContract({
    nodeId: "child-5-abs-posix",
    parentId: "parent-5",
    taskPrompt: "Fix calculator",
    originalGoal: "Fix calculator",
    parentContract,
    proposedMutationScope: ["/etc/passwd"]
  });
  assert.deepEqual(childAbsolutePosix.proposedMutationScope, []);

  // Try absolute Windows path
  const childAbsoluteWin = createWorkerExecutionContract({
    nodeId: "child-5-abs-win",
    parentId: "parent-5",
    taskPrompt: "Fix calculator",
    originalGoal: "Fix calculator",
    parentContract,
    proposedMutationScope: ["C:\\Windows\\System32\\cmd.exe"]
  });
  assert.deepEqual(childAbsoluteWin.proposedMutationScope, []);
});

test("Root task authority establishment: Root with no parent can establish authorized mutation scope", () => {
  const rootContract = createWorkerExecutionContract({
    nodeId: "root-node",
    taskPrompt: "Fix multiply in src/calculator.ts",
    originalGoal: "Fix multiply in src/calculator.ts",
    proposedMutationScope: ["src/calculator.ts"]
  });

  assert.equal(rootContract.responsibility, "IMPLEMENT");
  assert.deepEqual(rootContract.proposedMutationScope, ["src/calculator.ts"]);
});
