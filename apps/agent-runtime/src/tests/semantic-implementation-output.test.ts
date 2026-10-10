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
import {
  bridgeEditIntents,
  isAuxiliaryReportArtifact,
  isExplicitlyRequestedDeliverable,
  isActionableImplementationProposal,
  isActionableImplementationOutput
} from "../orchestration/RecursiveEditIntentBridge.js";
import { wrapTextFallback, type EditIntent, type GeneratedArtifact } from "../orchestration/RecursiveSwarmModels.js";
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
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "hivo-semantic-test-"));
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

test("Point 1 & 4: Auxiliary report artifacts do not satisfy implementation, but explicit deliverables are preserved", () => {
  const { workspaceDir } = createTestWorkspace();
  try {
    const goal = "Fix multiply bug in calculator.ts. Report: - root cause - file changed - whether all tests pass.";

    // Point 1: Auxiliary report artifacts
    assert.equal(
      isAuxiliaryReportArtifact(
        { kind: "generated_artifact", path: "root_cause.md", content: "# Root Cause\nMultiply adds", artifact_type: "markdown", description: "Root cause", validation_steps: [], completeness_notes: [], confidence: 0.9 },
        { isImplementation: true, originalGoal: goal, workspacePath: workspaceDir }
      ),
      true,
      "root_cause.md must be classified as auxiliary report"
    );

    assert.equal(
      isAuxiliaryReportArtifact(
        { kind: "generated_artifact", path: "test_output.txt", content: "fail 1 - multiply", artifact_type: "text", description: "Test runner output", validation_steps: [], completeness_notes: [], confidence: 0.9 },
        { isImplementation: true, originalGoal: goal, workspacePath: workspaceDir }
      ),
      true,
      "test_output.txt must be classified as auxiliary report"
    );

    assert.equal(
      isAuxiliaryReportArtifact(
        { kind: "generated_artifact", path: "failure_details.json", content: '{"test": "multiply"}', artifact_type: "json", description: "Failing test info", validation_steps: [], completeness_notes: [], confidence: 0.9 },
        { isImplementation: true, originalGoal: goal, workspacePath: workspaceDir }
      ),
      true,
      "failure_details.json must be classified as auxiliary report"
    );

    // Bridge with only auxiliary artifacts returns 0 patchCandidates
    const bridgeResult = bridgeEditIntents({
      sessionId: "s1",
      workspacePath: workspaceDir,
      intents: [],
      generatedArtifacts: [
        { nodeId: "n1", artifact: { kind: "generated_artifact", path: "root_cause.md", content: "# Root cause", artifact_type: "markdown", description: "Root cause", validation_steps: [], completeness_notes: [], confidence: 0.9 } },
        { nodeId: "n2", artifact: { kind: "generated_artifact", path: "test_output.txt", content: "failing", artifact_type: "text", description: "Test log", validation_steps: [], completeness_notes: [], confidence: 0.9 } },
        { nodeId: "n3", artifact: { kind: "generated_artifact", path: "failure_details.json", content: "{}", artifact_type: "json", description: "Details", validation_steps: [], completeness_notes: [], confidence: 0.9 } }
      ],
      validationPlans: [],
      allowedPaths: [],
      forbiddenPaths: [],
      isImplementation: true,
      originalGoal: goal
    });

    assert.equal(bridgeResult.patchCandidates.length, 0, "Auxiliary artifacts must not produce patchCandidates");
    assert.equal(bridgeResult.auxiliaryArtifacts?.length, 3, "Auxiliary artifacts must be stored in auxiliaryArtifacts");

    // Point 4: Explicit user request to create a documentation/artifact file
    const explicitGoal = "Please create docs/architecture.md and document the system.";
    assert.equal(
      isExplicitlyRequestedDeliverable("docs/architecture.md", explicitGoal),
      true,
      "Explicitly requested file must be recognized"
    );
    assert.equal(
      isAuxiliaryReportArtifact(
        { kind: "generated_artifact", path: "docs/architecture.md", content: "# Architecture", artifact_type: "markdown", description: "System doc", validation_steps: [], completeness_notes: [], confidence: 0.9 },
        { isImplementation: true, originalGoal: explicitGoal, workspacePath: workspaceDir }
      ),
      false,
      "Explicitly requested deliverable must NOT be classified as auxiliary"
    );

    const explicitBridge = bridgeEditIntents({
      sessionId: "s2",
      workspacePath: workspaceDir,
      intents: [],
      generatedArtifacts: [
        { nodeId: "n4", artifact: { kind: "generated_artifact", path: "docs/architecture.md", content: "# Architecture", artifact_type: "markdown", description: "System doc", validation_steps: [], completeness_notes: [], confidence: 0.9 } }
      ],
      validationPlans: [],
      allowedPaths: [],
      forbiddenPaths: [],
      isImplementation: true,
      originalGoal: explicitGoal
    });
    assert.equal(explicitBridge.patchCandidates.length, 1, "Explicitly requested file must produce a patch candidate");
    assert.equal(explicitBridge.patchCandidates[0].filesChanged[0].changeType, "create");
  } finally {
    cleanupTestWorkspace(workspaceDir);
  }
});

test("Point 2 & 3: Valid edit_intent and valid patch.diff count as actionable implementation", () => {
  const { workspaceDir } = createTestWorkspace();
  try {
    // Point 2: Valid edit_intent for existing source file
    const validIntent: EditIntent = {
      kind: "edit_intent",
      target_file: "src/calculator.ts",
      target_symbol_or_range: "multiply",
      operation: "modify",
      reason: "Fix multiply to return a * b",
      expected_behavior: "return a * b",
      risk: "low",
      evidence_refs: []
    };
    assert.equal(
      isActionableImplementationOutput(validIntent),
      true,
      "edit_intent must be actionable"
    );

    const fileContents = { "src/calculator.ts": "export function multiply(a: number, b: number): number {\n  return a + b;\n}\n" };
    const bridged = bridgeEditIntents({
      sessionId: "test_session",
      workspacePath: workspaceDir,
      intents: [{ nodeId: "node_1", intent: validIntent }],
      validationPlans: [],
      allowedPaths: [],
      forbiddenPaths: [],
      fileContents,
      builderOverrides: {
        "src/calculator.ts": {
          exactOldText: "  return a + b;",
          replacementText: "  return a * b;"
        }
      },
      isImplementation: true
    });
    assert.equal(bridged.patchCandidates.length, 1, "Valid edit_intent must become PatchProposal normally");
    assert.equal(
      isActionableImplementationProposal(bridged.patchCandidates[0], { isImplementation: true }),
      true,
      "PatchProposal from edit_intent must be actionable"
    );

    // Point 3: Valid patch.diff targeting source
    const patchContent = `--- a/src/calculator.ts\n+++ b/src/calculator.ts\n@@ -5,3 +5,3 @@\n export function multiply(a: number, b: number): number {\n-  return a + b;\n+  return a * b;\n }\n`;
    assert.equal(
      isActionableImplementationOutput(
        {
          kind: "generated_artifact",
          path: "patch.diff",
          content: patchContent,
          artifact_type: "text",
          description: "Patch for calculator.ts",
          validation_steps: [],
          completeness_notes: [],
          confidence: 0.95
        },
        { workspacePath: workspaceDir }
      ),
      true,
      "patch.diff targeting source must be actionable"
    );
  } finally {
    cleanupTestWorkspace(workspaceDir);
  }
});

test("Points 5, 6, 8, 9: Implementation task + structurally valid report-only output triggers exactly ONE semantic recovery and continues to APPROVAL", async () => {
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
    let workerExecutionCalls = 0;
    let recoveryPromptCaptured = "";

    const rawProvider: LlmProvider = {
      async generateStructured<T>(req: LlmRequest, schema: unknown): Promise<T> {
        const name = (schema as { name?: string })?.name ?? "";
        if (name === "expanded_goal_spec") {
          return {
            isAlreadyDetailed: true,
            expandedGoal: req.userPrompt,
            requirements: ["Fix multiply test"],
            acceptanceCriteria: ["Multiply returns product"],
            deliverableContract: "Fix multiply bug in calculator.ts",
            constraints: [],
            nonGoals: [],
            qualityBar: ["Complete"]
          } as T;
        }
        if (name === "atomicity_assessment") {
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
            // First attempt: structurally valid, but only auxiliary report artifact
            return {
              kind: "generated_artifact",
              path: "root_cause.md",
              content: "# Root cause\nMultiply function returns addition instead of multiplication.",
              artifact_type: "markdown",
              description: "Root cause analysis",
              validation_steps: [],
              completeness_notes: [],
              confidence: 0.9
            } as T;
          }
          if (workerExecutionCalls === 2) {
            // Second attempt (semantic recovery): return valid patch deliverable
            recoveryPromptCaptured = req.userPrompt;
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

    // Point 5: Exactly ONE semantic recovery call occurs (workerExecutionCalls === 2)
    assert.equal(workerExecutionCalls, 2, "Expected exactly 2 worker calls (1 initial + 1 semantic recovery)");
    assert.ok(
      recoveryPromptCaptured.includes("The previous response was structurally valid but did not provide the implementation deliverable required by this task"),
      "Recovery prompt must include semantic recovery instruction"
    );

    // Point 6: Semantic recovery produces valid edit_intent, continues to APPROVAL
    assert.equal(updated.status, "needs_approval");
    assert.equal(updated.lifecycleStage, "APPROVAL");
    assert.equal(result.patchProposals?.length, 1);
    assert.equal(result.patchProposals[0].filesChanged[0].path, "src/calculator.ts");

    // Point 8: Recursive tree is not regenerated during recovery
    assert.equal(splitCallsAfterExecStarted, 0, "Decomposition must not be rerun during recovery");
    assert.equal(splitCalls, 1, "Decomposition must run only once");

    // Point 9: Baseline command is not rerun
    assert.equal(updated.commandExecutions?.length, 1, "Baseline command must not be rerun");
  } finally {
    cleanupTestWorkspace(workspaceDir);
  }
});

test("Point 7: Semantic recovery producing report-only output again leaves session BLOCKED", async () => {
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
      async generateStructured<T>(_req: LlmRequest, schema: unknown): Promise<T> {
        const name = (schema as { name?: string })?.name ?? "";
        if (name === "expanded_goal_spec") {
          return {
            isAlreadyDetailed: true,
            expandedGoal: "Fix multiply bug",
            requirements: ["Fix multiply"],
            acceptanceCriteria: ["Product returned"],
            deliverableContract: "Fix multiply bug",
            constraints: [],
            nonGoals: [],
            qualityBar: ["Complete"]
          } as T;
        }
        if (name === "atomicity_assessment") {
          return { isAtomic: true, score: 2, rationale: "Atomic sub-task.", failures: [] } as T;
        }
        if (name === "goal_keeper_alignment") {
          return { aligned: true, confidence: 0.95, rationale: "Goal aligned." } as T;
        }

        if (name === "structured_node_output") {
          workerExecutionCalls++;
          if (workerExecutionCalls === 1) {
            // First attempt: root_cause.md
            return {
              kind: "generated_artifact",
              path: "root_cause.md",
              content: "# Root cause\nMultiply adds",
              artifact_type: "markdown",
              description: "Root cause analysis",
              validation_steps: [],
              completeness_notes: [],
              confidence: 0.9
            } as T;
          }
          if (workerExecutionCalls === 2) {
            // Second attempt (semantic recovery): returns test_output.txt (still report only!)
            return {
              kind: "generated_artifact",
              path: "test_output.txt",
              content: "test failed",
              artifact_type: "text",
              description: "Test output",
              validation_steps: [],
              completeness_notes: [],
              confidence: 0.9
            } as T;
          }
          throw new Error("Worker called more than twice!");
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

    // Exactly 2 worker calls (1 initial + 1 recovery)
    assert.equal(workerExecutionCalls, 2);

    // No implementation PatchProposal
    assert.equal(updated.patchProposals.length, 0, "No implementation PatchProposal must exist");

    // Session becomes BLOCKED, not APPROVAL, not DONE
    assert.equal(updated.status, "blocked", "Session status must be blocked");
    assert.equal(updated.lifecycleStage, "BLOCKED", "Session lifecycleStage must be BLOCKED");
    assert.ok(
      updated.runSummary?.summary.includes("no actionable implementation patch"),
      `Summary must state no actionable patch was produced: ${updated.runSummary?.summary}`
    );
  } finally {
    cleanupTestWorkspace(workspaceDir);
  }
});

test("Point 10: Existing malformed-schema recovery still performs at most one schema recovery call", async () => {
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
      async generateStructured<T>(_req: LlmRequest, schema: unknown): Promise<T> {
        const name = (schema as { name?: string })?.name ?? "";
        if (name === "expanded_goal_spec") {
          return {
            isAlreadyDetailed: true,
            expandedGoal: "Fix multiply bug",
            requirements: ["Fix multiply"],
            acceptanceCriteria: ["Product returned"],
            deliverableContract: "Fix multiply bug",
            constraints: [],
            nonGoals: [],
            qualityBar: ["Complete"]
          } as T;
        }
        if (name === "atomicity_assessment") {
          return { isAtomic: true, score: 2, rationale: "Atomic sub-task.", failures: [] } as T;
        }
        if (name === "goal_keeper_alignment") {
          return { aligned: true, confidence: 0.95, rationale: "Goal aligned." } as T;
        }

        if (name === "structured_node_output") {
          workerExecutionCalls++;
          if (workerExecutionCalls === 1) {
            // Malformed schema
            return { invalid_schema: true } as unknown as T;
          }
          if (workerExecutionCalls === 2) {
            // Valid deliverable on schema recovery
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
    assert.equal(workerExecutionCalls, 2, "Schema recovery must perform exactly 1 recovery call");
    assert.equal(updated.status, "needs_approval");
    assert.equal(updated.patchProposals.length, 1);
  } finally {
    cleanupTestWorkspace(workspaceDir);
  }
});

test("Point 11: No arbitrary plain-text regex creates implementation authority", () => {
  const plainText = "I examined the bug in src/calculator.ts and fixed it by changing return a + b to return a * b.";
  const fallback = wrapTextFallback(plainText);
  assert.equal(fallback.output.kind, "final_summary");
  assert.equal(fallback.output.edit_intents.length, 0, "Plain text fallback must not invent edit_intents");
  assert.equal(
    isActionableImplementationOutput(fallback.output),
    false,
    "Fallback without edit_intents must not count as actionable implementation"
  );
});

test("Point 12: Read-only task with report artifacts can still complete normally", async () => {
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
      userPrompt: "Explain the architecture of calculator.ts (read-only inspect-only)"
    });

    assert.equal(isImplementationIntent(session), false, "Read-only prompt must not be flagged as implementation");

    const rawProvider: LlmProvider = {
      async generateStructured<T>(_req: LlmRequest, schema: unknown): Promise<T> {
        const name = (schema as { name?: string })?.name ?? "";
        if (name === "expanded_goal_spec") {
          return {
            isAlreadyDetailed: true,
            expandedGoal: "Explain architecture",
            requirements: ["Explain"],
            acceptanceCriteria: ["Architecture explained"],
            deliverableContract: "Explanation",
            constraints: [],
            nonGoals: [],
            qualityBar: ["Complete"]
          } as T;
        }
        if (name === "atomicity_assessment") {
          return { isAtomic: true, score: 2, rationale: "Atomic.", failures: [] } as T;
        }
        if (name === "goal_keeper_alignment") {
          return { aligned: true, confidence: 0.95, rationale: "Aligned." } as T;
        }

        if (name === "structured_node_output") {
          return {
            kind: "generated_artifact",
            path: "architecture.md",
            content: "# Architecture\nCalculator exports 4 operations.",
            artifact_type: "markdown",
            description: "Architecture doc",
            validation_steps: [],
            completeness_notes: [],
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
      message: "Explain the architecture of calculator.ts (read-only inspect-only)",
      provider,
      providerTelemetry: telemetry,
      projectMap: mockProjectMap,
      thinkFirst: false
    });

    const updated = await sessionManager.getSession(session.id);
    assert.ok(updated);
    // Read-only task preserves generated artifact and completes normally
    assert.equal(updated.status, "completed");
    assert.equal(updated.lifecycleStage, "DONE");
  } finally {
    cleanupTestWorkspace(workspaceDir);
  }
});
