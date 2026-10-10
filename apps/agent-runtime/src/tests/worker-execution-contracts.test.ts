import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import type { AgentRuntimeSession, ProjectMap, SanitizedProviderConfig } from "@hivo/protocol";
import { EventBus } from "../runtime/EventBus.js";
import { SessionManager } from "../runtime/SessionManager.js";
import { RuntimeDirectTurnService } from "../runtime/RuntimeDirectTurnService.js";
import { RuntimeRecursiveSwarmService } from "../runtime/RuntimeRecursiveSwarmService.js";
import {
  classifyWorkerResponsibility,
  extractLocalTaskObjective,
  createWorkerExecutionContract,
  normalizeRecursiveNodeOutput,
  type WorkerResponsibility,
  type EditIntent,
  type GeneratedArtifact
} from "../orchestration/RecursiveSwarmModels.js";
import {
  assessImplementationPatchReadiness,
  isActionableImplementationOutput,
  isCandidateImplementationOutput,
  isPatchReadyImplementationOutput,
  bridgeEditIntents
} from "../orchestration/RecursiveEditIntentBridge.js";
import type { LlmProvider, LlmRequest } from "../llm/LlmProvider.js";
import { ProviderTelemetryRecorder, TelemetryLlmProvider } from "../llm/ProviderTelemetry.js";

const BUGGY_CALCULATOR_FILE = `export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a + b;
}
`;

const validProviderConfig: SanitizedProviderConfig = {
  providerType: "ollama",
  providerName: "Ollama",
  baseUrl: "http://127.0.0.1:11434",
  selectedModel: "test-model",
  isValid: true
};

const mockProjectMap: ProjectMap = {
  stack: ["typescript", "node"],
  packageManagers: ["npm"],
  testCommands: ["npm test"],
  entryPoints: ["src/calculator.ts"],
  importantFiles: ["src/calculator.ts"]
};

function createTestWorkspace(): { workspaceDir: string; storageDir: string } {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "hivo-contract-test-"));
  const storageDir = path.join(workspaceDir, ".agent_memory");
  fs.mkdirSync(path.join(workspaceDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "src", "calculator.ts"), BUGGY_CALCULATOR_FILE, "utf8");
  fs.writeFileSync(
    path.join(workspaceDir, "package.json"),
    JSON.stringify({ name: "buggy-calc", scripts: { test: "node --test" } }),
    "utf8"
  );
  return { workspaceDir, storageDir };
}

function cleanupTestWorkspace(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

function createTelemetry(session: AgentRuntimeSession) {
  return new ProviderTelemetryRecorder({
    mode: session.mode,
    providerConfig: session.providerConfig ?? validProviderConfig
  });
}

test("Contract Proof 1: An inspection child whose prompt includes the original implementation goal remains INSPECT", () => {
  const inheritedPrompt = `ORIGINAL GOAL: Fix the failing test in calculator by updating multiply() to return a * b instead of a + b

LOCAL TASK OBJECTIVE:
Run the test suite and inspect test output to diagnose the failing test failure details and root cause.`;

  const extracted = extractLocalTaskObjective(inheritedPrompt);
  assert.ok(extracted.includes("Run the test suite and inspect"));
  assert.ok(!extracted.includes("ORIGINAL GOAL"));

  const responsibility = classifyWorkerResponsibility({
    taskPrompt: inheritedPrompt,
    title: "Inspect test failure and logs"
  });
  assert.equal(responsibility, "INSPECT");

  const contract = createWorkerExecutionContract({
    id: "child-inspect-1",
    parentId: "root",
    taskPrompt: inheritedPrompt,
    originalGoal: "Fix the failing test in calculator by updating multiply()",
    title: "Inspect test failure"
  });
  assert.equal(contract.responsibility, "INSPECT");
  assert.deepEqual(contract.proposedMutationScope, []);
  assert.equal(contract.expectedDeliverable, "Diagnostic evidence or report");
});

test("Contract Proof 2: A verification child is not classified as an implementation worker", () => {
  const verifyPrompt = `ORIGINAL GOAL: Fix multiply bug in src/calculator.ts

LOCAL TASK OBJECTIVE:
Run npm test to verify whether all test assertions pass cleanly.`;

  const responsibility = classifyWorkerResponsibility({
    taskPrompt: verifyPrompt,
    title: "Verify test suite passes"
  });
  assert.equal(responsibility, "VERIFY");

  const contract = createWorkerExecutionContract({
    id: "child-verify-1",
    parentId: "root",
    taskPrompt: verifyPrompt,
    originalGoal: "Fix multiply bug in src/calculator.ts",
    title: "Verify test suite"
  });
  assert.equal(contract.responsibility, "VERIFY");
  assert.deepEqual(contract.proposedMutationScope, []);
});

test("Contract Proof 3: An implementation child retains IMPLEMENT responsibility", () => {
  const implPrompt = `ORIGINAL GOAL: Fix multiply bug in src/calculator.ts

LOCAL TASK OBJECTIVE:
Update the multiply function in src/calculator.ts to return a * b instead of a + b.`;

  const responsibility = classifyWorkerResponsibility({
    taskPrompt: implPrompt,
    title: "Fix multiply implementation"
  });
  assert.equal(responsibility, "IMPLEMENT");

  const contract = createWorkerExecutionContract({
    id: "child-impl-1",
    parentId: "root",
    taskPrompt: implPrompt,
    originalGoal: "Fix multiply bug in src/calculator.ts",
    title: "Fix multiply implementation"
  });
  assert.equal(contract.responsibility, "IMPLEMENT");
  assert.equal(contract.expectedDeliverable, "Concrete structured code patch proposal");
});

test("Contract Proof 3a: An Add goal grants implementation responsibility to its workers", () => {
  const goal = "Add full promotion-code support to checkout.";
  const rootContract = createWorkerExecutionContract({
    id: "root",
    taskPrompt: goal,
    originalGoal: goal,
    title: "Root"
  });
  const implementationContract = createWorkerExecutionContract({
    id: "child-impl-add",
    parentId: "root",
    taskPrompt: "Implement promotion-code lookup and validation.",
    originalGoal: goal,
    title: "Implement promotion-code support",
    explicitResponsibility: "IMPLEMENT",
    parentContract: rootContract
  });

  assert.equal(rootContract.responsibility, "IMPLEMENT");
  assert.equal(rootContract.authorityProvenance.isRootGoalImplementation, true);
  assert.equal(implementationContract.responsibility, "IMPLEMENT");
});

test("Contract Proof 4: A child contract cannot expand parent mutation scope", () => {
  const parentContract = createWorkerExecutionContract({
    id: "parent-node",
    parentId: undefined,
    taskPrompt: "Fix multiply in src/calculator.ts",
    originalGoal: "Fix multiply in src/calculator.ts",
    allowedPaths: ["src/calculator.ts"]
  });

  // Attempt to claim package.json and src/other.ts beyond parent's mutation scope
  const childContract = createWorkerExecutionContract({
    id: "child-node",
    parentId: "parent-node",
    taskPrompt: "Update src/calculator.ts and install a new dependency in package.json",
    originalGoal: "Fix multiply in src/calculator.ts",
    parentContract,
    allowedPaths: ["src/calculator.ts", "package.json", "src/other.ts"]
  });

  // Child mutation scope must be strictly bounded by parent contract
  assert.deepEqual(childContract.proposedMutationScope, ["src/calculator.ts"]);
  assert.ok(!childContract.proposedMutationScope.includes("package.json"));
  assert.ok(!childContract.proposedMutationScope.includes("src/other.ts"));
});

test("Contract Proof 5: A metadata-only edit_intent is not counted as patch-ready (needs_generation)", () => {
  const { workspaceDir } = createTestWorkspace();
  try {
    const metadataOnlyIntent: EditIntent = {
      kind: "edit_intent",
      target_file: "src/calculator.ts",
      target_symbol_or_range: "",
      operation: "modify",
      reason: "Fix multiply function to multiply a and b",
      expected_behavior: "Multiply function returns product",
      risk: "low",
      evidence_refs: []
      // note: no exact_old_text, no replacement_text, no patch content
    };

    const assessment = assessImplementationPatchReadiness(metadataOnlyIntent, {
      originalGoal: "Fix multiply bug",
      workspacePath: workspaceDir
    });

    assert.equal(assessment.isCandidate, true, "Should be recognized as a candidate implementation output");
    assert.equal(assessment.isPatchReady, false, "Must not be considered patch-ready");
    assert.equal(assessment.status, "needs_generation");
    assert.ok(assessment.missingRequirement?.includes("replacement text"));

    assert.equal(isCandidateImplementationOutput(metadataOnlyIntent, { originalGoal: "Fix multiply bug" }), true);
    assert.equal(isPatchReadyImplementationOutput(metadataOnlyIntent, { originalGoal: "Fix multiply bug", workspacePath: workspaceDir }), false);
    assert.equal(isActionableImplementationOutput(metadataOnlyIntent, { originalGoal: "Fix multiply bug", workspacePath: workspaceDir }), false);
  } finally {
    cleanupTestWorkspace(workspaceDir);
  }
});

test("Contract Proof 6: An invalid or headerless .diff is not counted as patch-ready (blocked)", () => {
  const { workspaceDir } = createTestWorkspace();
  try {
    const invalidDiffArtifact: GeneratedArtifact = {
      kind: "generated_artifact",
      path: "code_patch.diff",
      content: "multiply(a, b) should return a * b instead of a + b",
      artifact_type: "text",
      description: "Diff without unified diff headers",
      validation_steps: [],
      completeness_notes: [],
      confidence: 0.8
    };

    const assessment = assessImplementationPatchReadiness(invalidDiffArtifact, {
      originalGoal: "Fix multiply bug",
      workspacePath: workspaceDir
    });

    assert.equal(assessment.isCandidate, true);
    assert.equal(assessment.isPatchReady, false);
    assert.equal(assessment.status, "blocked");
    assert.ok(assessment.reason?.includes("diff") || assessment.missingRequirement?.includes("unified diff"));

    assert.equal(isPatchReadyImplementationOutput(invalidDiffArtifact, { originalGoal: "Fix multiply bug", workspacePath: workspaceDir }), false);
  } finally {
    cleanupTestWorkspace(workspaceDir);
  }
});

test("Contract Proof 7: A valid, grounded implementation output reaches a PatchProposal", () => {
  const { workspaceDir } = createTestWorkspace();
  try {
    const validIntent: EditIntent = {
      kind: "edit_intent",
      target_file: "src/calculator.ts",
      target_symbol_or_range: "multiply",
      operation: "modify",
      exact_old_text: "export function multiply(a: number, b: number): number {\n  return a + b;\n}",
      replacement_text: "export function multiply(a: number, b: number): number {\n  return a * b;\n}",
      reason: "Fix multiply implementation",
      expected_behavior: "Multiply returns a * b",
      risk: "low",
      evidence_refs: []
    };

    const assessment = assessImplementationPatchReadiness(validIntent, {
      originalGoal: "Fix multiply bug",
      workspacePath: workspaceDir
    });

    assert.equal(assessment.isCandidate, true);
    assert.equal(assessment.isPatchReady, true);
    assert.equal(assessment.status, "patch_ready");

    const bridgeResult = bridgeEditIntents({
      sessionId: "sess-contract-1",
      workspacePath: workspaceDir,
      intents: [{ nodeId: "child-node-1", intent: validIntent }],
      generatedArtifacts: [],
      validationPlans: [],
      allowedPaths: ["src/calculator.ts"],
      forbiddenPaths: [],
      fileContents: {
        "src/calculator.ts": BUGGY_CALCULATOR_FILE
      },
      isImplementation: true,
      originalGoal: "Fix multiply bug"
    });

    assert.equal(bridgeResult.blockedIntents.length, 0);
    assert.equal(bridgeResult.patchCandidates.length, 1);
    assert.equal(bridgeResult.patchCandidates[0].filesChanged[0].path, "src/calculator.ts");
    assert.ok(bridgeResult.patchCandidates[0].unifiedDiff.includes("-  return a + b;"));
    assert.ok(bridgeResult.patchCandidates[0].unifiedDiff.includes("+  return a * b;"));
  } finally {
    cleanupTestWorkspace(workspaceDir);
  }
});

test("Contract Proof 8: Multi-artifact worker requests do not violate the structured-output schema", () => {
  const rawArray = [
    {
      kind: "generated_artifact",
      path: "commit_message.txt",
      content: "fix: multiply implementation",
      artifact_type: "text",
      description: "Commit message",
      validation_steps: [],
      completeness_notes: [],
      confidence: 0.9
    },
    {
      kind: "generated_artifact",
      path: "code_patch.diff",
      content: `--- a/src/calculator.ts\n+++ b/src/calculator.ts\n@@ -5,3 +5,3 @@\n export function multiply(a: number, b: number): number {\n-  return a + b;\n+  return a * b;\n }\n`,
      artifact_type: "text",
      description: "Code patch for multiply",
      validation_steps: [],
      completeness_notes: [],
      confidence: 0.95
    }
  ];

  const normalized = normalizeRecursiveNodeOutput(rawArray);
  assert.ok(normalized.output);
  // Must prioritize the implementation patch artifact over auxiliary commit message
  assert.equal(normalized.output.kind, "generated_artifact");
  assert.equal((normalized.output as GeneratedArtifact).path, "code_patch.diff");
});

test("Contract Proof 9 & Reproduction: Diagnostic child runs first, produces test_failure_output.txt, does not consume recovery, and implementation child recovers to produce PatchProposal", async () => {
  const { workspaceDir, storageDir } = createTestWorkspace();
  try {
    const eventBus = new EventBus();
    const sessionManager = new SessionManager(storageDir, eventBus);
    await sessionManager.load();
    const directTurnService = new RuntimeDirectTurnService(sessionManager);
    const swarmService = new RuntimeRecursiveSwarmService(sessionManager, directTurnService);

    const session = await sessionManager.createSession({
      workspacePath: workspaceDir,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      userPrompt: "Fix the failing test in calculator by updating multiply() to return a * b instead of a + b"
    });

    await sessionManager.updateSession(session.id, (draft) => {
      draft.commandRequests = [
        {
          id: "cmd_req_1",
          sessionId: session.id,
          command: "npm test",
          reason: "baseline verification",
          risk: "safe",
          cwd: workspaceDir,
          status: "executed",
          createdAt: new Date().toISOString()
        }
      ];
      draft.commandExecutions = [
        {
          id: "cmd_exec_1",
          sessionId: session.id,
          requestId: "cmd_req_1",
          command: "npm test",
          cwd: workspaceDir,
          risk: "safe",
          status: "failed",
          exitCode: 1,
          stdout: "fail 1 - multiply\n1 failing",
          stderr: "",
          autoRun: false,
          createdAt: new Date().toISOString()
        }
      ];
    });

    let splitCalls = 0;
    let diagnosticWorkerCalls = 0;
    let implWorkerCalls = 0;
    let recoveryPromptCaptured = "";

    const rawProvider: LlmProvider = {
      async generateStructured<T>(req: LlmRequest, schema: unknown): Promise<T> {
        const name = (schema as { name?: string })?.name ?? "";
        if (name === "expanded_goal_spec") {
          return {
            isAlreadyDetailed: true,
            expandedGoal: req.userPrompt,
            requirements: ["Fix failing test in calculator"],
            acceptanceCriteria: ["All calculator tests pass"],
            deliverableContract: "Fix multiply bug in src/calculator.ts",
            constraints: [],
            nonGoals: [],
            qualityBar: ["Complete"]
          } as T;
        }
        if (name === "atomicity_assessment") {
          const isRoot = req.userPrompt.includes("DEPTH: 0");
          if (isRoot) {
            return { isAtomic: false, score: 7, rationale: "Needs diagnosis then fix", failures: ["MULTIPLE_STEPS"] } as T;
          }
          return { isAtomic: true, score: 2, rationale: "Atomic leaf task", failures: [] } as T;
        }
        if (name === "split_result") {
          splitCalls++;
          return {
            shouldSplit: true,
            desiredChildCount: 2,
            splitReason: "Split into diagnostic child then implementation child",
            subTasks: [
              {
                title: "Diagnose failing calculator test",
                taskPrompt: "Run npm test and inspect calculator.test.ts to isolate the root cause failure output",
                expectedOutput: "test_failure_output.txt with test runner output and root cause details",
                dependencies: [],
                responsibility: "INSPECT"
              },
              {
                title: "Fix multiply implementation in src/calculator.ts",
                taskPrompt: "Update multiply in src/calculator.ts so that it returns a * b",
                expectedOutput: "Concrete edit intent or unified diff patch for src/calculator.ts",
                dependencies: ["Diagnose failing calculator test"],
                responsibility: "IMPLEMENT"
              }
            ],
            stopConditions: [],
            rationale: "Sequential inspect then fix"
          } as T;
        }
        if (name === "goal_keeper_alignment") {
          return { aligned: true, confidence: 0.95, rationale: "Goal aligned." } as T;
        }

        if (name === "structured_node_output") {
          if (
            req.userPrompt.includes("Fix multiply implementation") ||
            req.userPrompt.includes("Update multiply in src/calculator.ts") ||
            req.userPrompt.includes("Your IMPLEMENT contract")
          ) {
            implWorkerCalls++;
            if (implWorkerCalls === 1) {
              // First attempt by implementation worker: returns metadata-only edit_intent without concrete replacement
              return {
                kind: "edit_intent",
                target_file: "src/calculator.ts",
                operation: "modify",
                reason: "Multiply function should return a * b"
              } as T;
            }
            if (implWorkerCalls === 2) {
              // Bounded recovery attempt: provider returns concrete replacement text
              recoveryPromptCaptured = req.userPrompt;
              return {
                kind: "edit_intent",
                target_file: "src/calculator.ts",
                operation: "modify",
                exact_old_text: "export function multiply(a: number, b: number): number {\n  return a + b;\n}",
                replacement_text: "export function multiply(a: number, b: number): number {\n  return a * b;\n}",
                reason: "Fix multiply function to use multiplication operator"
              } as T;
            }
            throw new Error(`Implementation worker called too many times: ${implWorkerCalls}`);
          }

          if (req.userPrompt.includes("Merge results from") || req.userPrompt.includes("Collector")) {
            return {
              kind: "integration_summary",
              summary: "Merged child diagnostic findings and implementation results",
              confidence: 0.95
            } as T;
          }

          diagnosticWorkerCalls++;
          // Diagnostic child produces test failure report artifact
          return {
            kind: "generated_artifact",
            path: "test_failure_output.txt",
            content: "FAIL: multiply should return product\nExpected: 6\nReceived: 5",
            artifact_type: "text",
            description: "Test execution failure log",
            validation_steps: ["npm test"],
            completeness_notes: ["Isolated failing test to multiply()"],
            confidence: 0.95
          } as T;
        }

        return {} as T;
      },
      async generateText(): Promise<string> {
        return "Merged child outputs: test failure isolated to multiply(), implementation fix prepared for src/calculator.ts.";
      }
    };

    const telemetry = createTelemetry(session);
    const provider = new TelemetryLlmProvider(rawProvider, telemetry);

    const result = await swarmService.run({
      sessionId: session.id,
      message: "Fix the failing test in calculator by updating multiply() to return a * b instead of a + b",
      provider,
      providerTelemetry: telemetry,
      projectMap: mockProjectMap,
      thinkFirst: false
    });

    const updated = await sessionManager.getSession(session.id);
    assert.ok(updated);

    // 1. Diagnostic child ran exactly once and did NOT trigger or consume recovery
    assert.equal(diagnosticWorkerCalls, 1, "Diagnostic worker must run once without recovery");

    // 2. Implementation worker ran twice (initial metadata-only + 1 bounded recovery)
    assert.equal(implWorkerCalls, 2, "Implementation worker must have exactly 1 bounded recovery");

    // 3. Recovery prompt specifically targeted the missing concrete replacement requirement
    assert.ok(
      recoveryPromptCaptured.includes("concrete replacement text") ||
      recoveryPromptCaptured.includes("concrete patch proposal"),
      "Recovery prompt must state the missing implementation deliverable"
    );

    // 4. Resulting session reached APPROVAL stage with 1 PatchProposal
    assert.equal(updated.status, "needs_approval");
    assert.equal(updated.lifecycleStage, "APPROVAL");
    assert.equal(result.patchProposals?.length, 1);
    assert.equal(result.patchProposals[0].filesChanged[0].path, "src/calculator.ts");
    assert.equal(result.patchProposals[0].filesChanged[0].changeType, "modify");
    assert.ok(result.patchProposals[0].unifiedDiff.includes("+  return a * b;"));

    // 5. Decomposition was not rerun
    assert.equal(splitCalls, 1, "Decomposition should not be rerun during recovery");
  } finally {
    cleanupTestWorkspace(workspaceDir);
  }
});
