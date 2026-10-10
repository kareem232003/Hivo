import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import type { AgentRuntimeSession, ProjectMap, SanitizedProviderConfig } from "@hivo/protocol";
import { EventBus } from "../runtime/EventBus.js";
import { SessionManager } from "../runtime/SessionManager.js";
import { RuntimeDirectTurnService } from "../runtime/RuntimeDirectTurnService.js";
import { RuntimeRecursiveSwarmService, isImplementationIntent } from "../runtime/RuntimeRecursiveSwarmService.js";
import { wrapTextFallback } from "../orchestration/RecursiveSwarmModels.js";
import { bridgeEditIntents } from "../orchestration/RecursiveEditIntentBridge.js";
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
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "hivo-recovery-test-"));
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

test("Points 1-7: Single bounded structured-output recovery attempt upon malformed first response", async () => {
  const { workspaceDir, storageDir } = createTestWorkspace();
  try {
    const eventBus = new EventBus();
    const sessionManager = new SessionManager(storageDir, eventBus);
    await sessionManager.load();
    const directTurnService = new RuntimeDirectTurnService(sessionManager);
    const service = new RuntimeRecursiveSwarmService(sessionManager, directTurnService);
    const session = await sessionManager.createSession({
      workspacePath: workspaceDir,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      userPrompt: "Fix multiply bug in calculator.ts"
    });

    // Populate baseline execution evidence so we can check if it is repeated
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
    let splitCallsAfterExecStarted = 0;
    let atomicityCalls = 0;
    let workerExecutionCalls = 0;
    let recoveryPromptCaptured = "";
    let receivedTaskContext = "";

    const rawProvider: LlmProvider = {
      async generateStructured<T>(req: LlmRequest, schema: unknown): Promise<T> {
        const name = (schema as { name?: string })?.name ?? "";
        if (name === "expanded_goal_spec") {
          return {
            isAlreadyDetailed: true,
            expandedGoal: req.userPrompt,
            requirements: ["Fix multiply test"],
            acceptanceCriteria: ["Multiply returns product"],
            deliverableContract: "Fix multiply bug",
            constraints: [],
            nonGoals: [],
            qualityBar: ["Complete"]
          } as T;
        }
        if (name === "atomicity_assessment") {
          atomicityCalls++;
          const isRoot = req.userPrompt.includes("DEPTH: 0");
          if (isRoot) {
            return { isAtomic: false, score: 6, rationale: "Root task needs split.", failures: ["MULTIPLE_STEPS"] } as T;
          }
          return { isAtomic: true, score: 2, rationale: "Atomic sub-task.", failures: [] } as T;
        }
        if (name === "split_result") {
          splitCalls++;
          if (workerExecutionCalls > 0) {
            splitCallsAfterExecStarted++;
          }
          return {
            shouldSplit: true,
            desiredChildCount: 1,
            splitReason: "Split into worker",
            subTasks: [
              {
                title: "Fix multiply bug",
                taskPrompt: "Fix multiply function in src/calculator.ts to return a * b",
                expectedOutput: "edit_intent with multiply fix",
                dependencies: []
              }
            ],
            stopConditions: [],
            rationale: "Fix multiply"
          } as T;
        }
        if (name === "goal_keeper_alignment") {
          return { aligned: true, confidence: 0.95, rationale: "Goal aligned." } as T;
        }

        if (name === "structured_node_output") {
          workerExecutionCalls++;
          if (workerExecutionCalls === 1) {
            // First attempt: return malformed non-schema object (or plain text)
            return {
              not_a_valid_schema: true,
              prose: "Edit modify src/calculator.ts (low risk): The multiply function returns sum instead of product"
            } as unknown as T;
          }
          if (workerExecutionCalls === 2) {
            // Second attempt (recovery): verify prompt has recovery instruction
            recoveryPromptCaptured = req.userPrompt;
            receivedTaskContext = req.userPrompt;
            return {
              kind: "generated_artifact",
              path: "patch.diff",
              content: `--- a/src/calculator.ts\n+++ b/src/calculator.ts\n@@ -5,3 +5,3 @@\n export function multiply(a: number, b: number): number {\n-  return a + b;\n+  return a * b;\n }\n`,
              artifact_type: "text",
              description: "Fix multiply function in src/calculator.ts",
              validation_steps: ["npm test"],
              completeness_notes: ["Fixed multiply function to return a * b"],
              confidence: 0.95
            } as T;
          }
          throw new Error("Worker called more than twice!");
        }

        return {} as T;
      },
      async generateText(): Promise<string> {
        throw new Error("generateText should not be called during structured recovery");
      }
    };

    const telemetry = createTelemetry(session);
    const provider = new TelemetryLlmProvider(rawProvider, telemetry);

    const splitsBeforeExec = splitCalls;

    const result = await service.run({
      sessionId: session.id,
      message: "Fix multiply bug in calculator.ts",
      provider,
      providerTelemetry: telemetry,
      projectMap: mockProjectMap,
      thinkFirst: false
    });

    const updated = await sessionManager.getSession(session.id);
    assert.ok(updated);

    // 1. Worker returns malformed/plain-text output on first call
    // 2. Exactly ONE structured recovery call occurs (workerExecutionCalls === 2)
    assert.equal(workerExecutionCalls, 2, "Expected exactly 2 worker calls: 1 initial + 1 recovery");

    // 3. Recovery receives the same task/evidence context and recovery text
    assert.ok(
      recoveryPromptCaptured.includes("The previous response did not satisfy the required structured output schema"),
      "Recovery prompt must include schema recovery instruction"
    );
    assert.ok(
      receivedTaskContext.includes("Fix multiply bug in calculator.ts"),
      "Recovery prompt must preserve task context"
    );

    // 4. Recovery valid edit_intent continues into a PatchProposal
    assert.ok(result.patchProposals && result.patchProposals.length > 0, "PatchProposal must be created after recovery");
    const patch = result.patchProposals[0]!;
    assert.ok(patch.unifiedDiff.includes("return a * b;"), "PatchProposal diff must reflect the fix");

    // 5. Recursive tree/decomposition is not regenerated
    assert.equal(splitCallsAfterExecStarted, 0, "Decomposition must not be rerun during recovery");
    assert.equal(splitCalls, 1, "Decomposition must run only once for initial tree");

    // 6. Baseline command was not executed again
    assert.equal(updated.commandExecutions?.length, 1, "Baseline command must not be executed again");

    // 7. Children still have no filesystem/shell authority: workspace files unchanged
    const currentFileContent = fs.readFileSync(path.join(workspaceDir, "src", "calculator.ts"), "utf8");
    assert.equal(currentFileContent, BUGGY_CALCULATOR_FILE, "Worker must not directly mutate filesystem");
  } finally {
    cleanupTestWorkspace(workspaceDir);
  }
});

test("Point 8 & 9: Double malformed output does not create patch and blocks implementation session", async () => {
  const { workspaceDir, storageDir } = createTestWorkspace();
  try {
    const eventBus = new EventBus();
    const sessionManager = new SessionManager(storageDir, eventBus);
    await sessionManager.load();
    const directTurnService = new RuntimeDirectTurnService(sessionManager);
    const service = new RuntimeRecursiveSwarmService(sessionManager, directTurnService);
    const session = await sessionManager.createSession({
      workspacePath: workspaceDir,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      userPrompt: "Fix multiply bug in calculator.ts"
    });

    let workerExecutionCalls = 0;

    const rawProvider: LlmProvider = {
      async generateStructured<T>(req: LlmRequest, schema: unknown): Promise<T> {
        const name = (schema as { name?: string })?.name ?? "";
        if (name === "expanded_goal_spec") {
          return {
            isAlreadyDetailed: true,
            expandedGoal: req.userPrompt,
            requirements: ["Fix multiply test"],
            acceptanceCriteria: ["Multiply returns product"],
            deliverableContract: "Fix multiply bug",
            constraints: [],
            nonGoals: [],
            qualityBar: ["Complete"]
          } as T;
        }
        if (name === "atomicity_assessment") {
          return { isAtomic: true, score: 2, rationale: "Atomic", failures: [] } as T;
        }
        if (name === "goal_keeper_alignment") {
          return { aligned: true, confidence: 0.95, rationale: "Goal aligned." } as T;
        }

        if (name === "structured_node_output") {
          workerExecutionCalls++;
          // Both attempt 1 and recovery attempt 2 return malformed non-schema output
          return {
            malformed: true,
            prose: "Edit modify src/calculator.ts (low risk): Cannot format as JSON"
          } as unknown as T;
        }

        return {} as T;
      },
      async generateText(): Promise<string> {
        throw new Error("generateText should not be called");
      }
    };

    const telemetry = createTelemetry(session);
    const provider = new TelemetryLlmProvider(rawProvider, telemetry);

    const result = await service.run({
      sessionId: session.id,
      message: "Fix multiply bug in calculator.ts",
      provider,
      providerTelemetry: telemetry,
      projectMap: mockProjectMap,
      thinkFirst: false
    });

    const updated = await sessionManager.getSession(session.id);
    assert.ok(updated);

    // Exactly 2 worker calls occurred (initial + 1 recovery), then stopped
    assert.equal(workerExecutionCalls, 2, "Expected exactly 2 worker calls (1 initial + 1 recovery)");

    // No PatchProposal produced
    assert.equal(result.patchProposals?.length ?? 0, 0, "No patch proposal should be produced");

    // Implementation session is NOT completed/DONE
    assert.notEqual(result.status, "completed", "Status must NOT be completed");
    assert.notEqual(result.lifecycleStage, "DONE", "Lifecycle must NOT be DONE");

    // Session becomes blocked using existing semantics
    assert.equal(result.status, "blocked", "Status must be blocked");
    assert.equal(result.lifecycleStage, "BLOCKED", "Lifecycle must be BLOCKED");
    assert.match(
      updated.runSummary?.summary ?? "",
      /Recursive execution (produced structured output but no actionable implementation patch|completed without producing an actionable patch)/
    );
  } finally {
    cleanupTestWorkspace(workspaceDir);
  }
});

test("Point 10: Read-only task with zero patches completes normally", async () => {
  const { workspaceDir, storageDir } = createTestWorkspace();
  try {
    const eventBus = new EventBus();
    const sessionManager = new SessionManager(storageDir, eventBus);
    await sessionManager.load();
    const directTurnService = new RuntimeDirectTurnService(sessionManager);
    const service = new RuntimeRecursiveSwarmService(sessionManager, directTurnService);
    const session = await sessionManager.createSession({
      workspacePath: workspaceDir,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      userPrompt: "Read-only inspection: explain calculator.ts functions without modifying anything"
    });

    const rawProvider: LlmProvider = {
      async generateStructured<T>(req: LlmRequest, schema: unknown): Promise<T> {
        const name = (schema as { name?: string })?.name ?? "";
        if (name === "expanded_goal_spec") {
          return {
            isAlreadyDetailed: true,
            expandedGoal: req.userPrompt,
            requirements: ["Explain code"],
            acceptanceCriteria: ["Explanation provided"],
            deliverableContract: "Explanation text",
            constraints: ["read-only"],
            nonGoals: ["code modification"],
            qualityBar: ["Accurate"]
          } as T;
        }
        if (name === "atomicity_assessment") {
          return { isAtomic: true, score: 2, rationale: "Atomic", failures: [] } as T;
        }
        if (name === "goal_keeper_alignment") {
          return { aligned: true, confidence: 0.95, rationale: "Goal aligned." } as T;
        }

        if (name === "structured_node_output") {
          return {
            kind: "evidence_report",
            findings: ["Calculator has add and multiply functions", "Multiply returns a + b"],
            files: ["src/calculator.ts"],
            symbols: ["add", "multiply"],
            evidence_refs: ["file:src/calculator.ts#1-10"],
            unknowns: [],
            confidence: 0.9
          } as T;
        }

        return {} as T;
      },
      async generateText(): Promise<string> {
        return "Explanation";
      }
    };

    const telemetry = createTelemetry(session);
    const provider = new TelemetryLlmProvider(rawProvider, telemetry);

    assert.equal(isImplementationIntent(session), false, "Read-only task must not be flagged as implementation");

    const result = await service.run({
      sessionId: session.id,
      message: "Read-only inspection: explain calculator.ts functions without modifying anything",
      provider,
      providerTelemetry: telemetry,
      projectMap: mockProjectMap,
      thinkFirst: false
    });

    const updated = await sessionManager.getSession(session.id);
    assert.ok(updated);

    assert.equal(result.patchProposals?.length ?? 0, 0, "Zero patches produced");
    assert.equal(result.status, "completed", "Read-only task should complete");
    assert.equal(result.lifecycleStage, "DONE", "Read-only task lifecycle should be DONE");
  } finally {
    cleanupTestWorkspace(workspaceDir);
  }
});

test("Point 11: Valid structured output on first attempt triggers no recovery call", async () => {
  const { workspaceDir, storageDir } = createTestWorkspace();
  try {
    const eventBus = new EventBus();
    const sessionManager = new SessionManager(storageDir, eventBus);
    await sessionManager.load();
    const directTurnService = new RuntimeDirectTurnService(sessionManager);
    const service = new RuntimeRecursiveSwarmService(sessionManager, directTurnService);
    const session = await sessionManager.createSession({
      workspacePath: workspaceDir,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      userPrompt: "Fix multiply bug in calculator.ts"
    });

    let workerExecutionCalls = 0;

    const rawProvider: LlmProvider = {
      async generateStructured<T>(req: LlmRequest, schema: unknown): Promise<T> {
        const name = (schema as { name?: string })?.name ?? "";
        if (name === "expanded_goal_spec") {
          return {
            isAlreadyDetailed: true,
            expandedGoal: req.userPrompt,
            requirements: ["Fix multiply test"],
            acceptanceCriteria: ["Multiply returns product"],
            deliverableContract: "Fix multiply bug",
            constraints: [],
            nonGoals: [],
            qualityBar: ["Complete"]
          } as T;
        }
        if (name === "atomicity_assessment") {
          return { isAtomic: true, score: 2, rationale: "Atomic", failures: [] } as T;
        }
        if (name === "goal_keeper_alignment") {
          return { aligned: true, confidence: 0.95, rationale: "Goal aligned." } as T;
        }

        if (name === "structured_node_output") {
          workerExecutionCalls++;
          return {
            kind: "generated_artifact",
            path: "patch.diff",
            content: `--- a/src/calculator.ts\n+++ b/src/calculator.ts\n@@ -5,3 +5,3 @@\n export function multiply(a: number, b: number): number {\n-  return a + b;\n+  return a * b;\n }\n`,
            artifact_type: "text",
            description: "Fix multiply function in src/calculator.ts",
            validation_steps: ["npm test"],
            completeness_notes: ["Fixed multiply function to return a * b"],
            confidence: 0.95
          } as T;
        }

        return {} as T;
      },
      async generateText(): Promise<string> {
        throw new Error("generateText should not be called");
      }
    };

    const telemetry = createTelemetry(session);
    const provider = new TelemetryLlmProvider(rawProvider, telemetry);

    const result = await service.run({
      sessionId: session.id,
      message: "Fix multiply bug in calculator.ts",
      provider,
      providerTelemetry: telemetry,
      projectMap: mockProjectMap,
      thinkFirst: false
    });

    const updated = await sessionManager.getSession(session.id);
    assert.ok(updated);

    // Exactly 1 worker call occurred (no recovery call)
    assert.equal(workerExecutionCalls, 1, "Exactly 1 worker call on first valid output");
    assert.ok(result.patchProposals && result.patchProposals.length > 0, "Patch proposal created");
  } finally {
    cleanupTestWorkspace(workspaceDir);
  }
});

test("Point 12: Arbitrary plain text prose does not gain code-mutation authority or create patches", () => {
  const plainText = "Edit modify src/calculator.ts (low risk): The multiply function returns the sum of the arguments instead of the product. Change `return a + b;` to `return a * b;`.";

  const fallback = wrapTextFallback(plainText);
  assert.equal(fallback.output.kind, "final_summary");
  assert.deepEqual(fallback.output.edit_intents, [], "Fallback must have zero edit intents");

  const bridgeResult = bridgeEditIntents({
    sessionId: "test_session",
    workspacePath: "/dummy/workspace",
    intents: [],
    validationPlans: [],
    allowedPaths: [],
    forbiddenPaths: []
  });

  assert.equal(bridgeResult.patchCandidates.length, 0, "No patch candidates should be created from prose");
  assert.equal(bridgeResult.summaryCounts.realDiff, 0, "realDiff count must be 0");
});
