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
import { RuntimePlanPendingActionService } from "../runtime/RuntimePlanPendingActionService.js";
import { AgentRuntime } from "../runtime/AgentRuntime.js";
import { loadConfig } from "../config.js";
import type { LlmProvider, LlmRequest } from "../llm/LlmProvider.js";
import { ProviderTelemetryRecorder, TelemetryLlmProvider } from "../llm/ProviderTelemetry.js";
import { ScriptedProvider } from "./fixtures/ScriptedProvider.js";

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

function createTestWorkspace(): { workspaceDir: string; storageDir: string } {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "hivo-plan-mode-test-"));
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

const mockProjectMap: ProjectMap = {
  stack: ["typescript", "node"],
  packageManagers: ["npm"],
  testCommands: ["npm test"],
  entryPoints: ["src/calculator.ts"],
  importantFiles: ["src/calculator.ts"]
};

function createTelemetry(session: AgentRuntimeSession) {
  return new ProviderTelemetryRecorder({
    mode: session.mode,
    providerConfig: session.providerConfig ?? validProviderConfig
  });
}

function createMockLlmProvider(counters = { generateStructuredCalls: 0, expandedGoalCalls: 0 }) {
  const provider: LlmProvider = {
    async generateStructured<T>(req: LlmRequest, schema: unknown): Promise<T> {
      counters.generateStructuredCalls++;
      const name = (schema as { name?: string })?.name ?? "";
      if (name === "expanded_goal_spec") {
        counters.expandedGoalCalls++;
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
        const isRoot = req.userPrompt.includes("DEPTH: 0");
        if (isRoot) {
          return { isAtomic: false, score: 6, rationale: "Root task needs split.", failures: ["MULTIPLE_STEPS"] } as T;
        }
        return { isAtomic: true, score: 2, rationale: "Atomic sub-task.", failures: [] } as T;
      }
      if (name === "split_result") {
        return {
          shouldSplit: true,
          desiredChildCount: 2,
          splitReason: "Split into code fix and test validation",
          subTasks: [
            {
              title: "Fix multiply bug",
              taskPrompt: "Fix multiply function in src/calculator.ts",
              expectedOutput: "patch.diff with multiply fix",
              dependencies: []
            },
            {
              title: "Run tests",
              taskPrompt: "Validate multiply fix with tests",
              expectedOutput: "validation plan with npm test",
              dependencies: ["0"]
            }
          ],
          stopConditions: [],
          rationale: "Fix then test"
        } as T;
      }
      if (name === "goal_keeper_alignment") {
        return { aligned: true, confidence: 0.95, rationale: "Goal aligned." } as T;
      }

      // Worker task outputs (structured_node_output)
      if (req.userPrompt.includes("Validate")) {
        return {
          kind: "validation_plan",
          commands: ["npm test"],
          smoke_checks: ["npm test"],
          expected_results: ["Tests pass"],
          blockers: []
        } as T;
      }

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
    },
    async generateText(): Promise<string> {
      return "Diagnosed multiply bug in src/calculator.ts. Fix is return a * b.";
    }
  };
  return { provider, counters };
}

test("Requirement G.1: recursive_swarm + Plan OFF behaves as before", async () => {
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

    const { provider: rawProvider } = createMockLlmProvider();
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

    assert.equal(result.status, "needs_approval", "Session enters needs_approval waiting state, not completed");
    assert.equal(result.lifecycleStage, "APPROVAL", "Session enters APPROVAL stage awaiting operator review");
    assert.equal(result.patchProposals.length, 1, "Patch proposal must be registered when Plan Mode is OFF");
    assert.equal(result.patchProposals[0].filesChanged[0].path, "src/calculator.ts");
    assert.equal(result.recursiveSwarmRunState?.stagedValidationCommands?.length, 1, "Post-apply validation command is staged");
  } finally {
    cleanupTestWorkspace(workspaceDir);
  }
});

test("Requirement G.1b: Plan OFF in full_access mode reaches APPLY, not completed/DONE before Rust apply", async () => {
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
      accessProfile: "full_access",
      userPrompt: "Fix multiply bug in calculator.ts"
    });

    const { provider: rawProvider } = createMockLlmProvider();
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

    assert.equal(result.status, "needs_approval", "Full access must NOT mark completed before Rust apply");
    assert.equal(result.lifecycleStage, "APPLY", "Auto-approved patch proposal enters APPLY stage");
    assert.equal(result.patchProposals.length, 1);
    assert.equal(result.patchProposals[0].status, "approved");
    assert.equal(result.recursiveSwarmRunState?.stagedValidationCommands?.length, 1);
  } finally {
    cleanupTestWorkspace(workspaceDir);
  }
});

test("Requirement G.2, G.3, G.4: recursive_swarm + Plan ON performs reasoning, stops before patch application, allows baseline evidence commands, nextAction becomes confirm_plan, no Rust patch apply occurs", async () => {
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
      accessProfile: "full_access",
      thinkFirst: true,
      userPrompt: "Fix multiply bug in calculator.ts"
    });

    // Simulate baseline command request and execution existing before plan confirmation
    await sessionManager.addCommandRequest(session.id, {
      id: "cmd_baseline_npm_test",
      sessionId: session.id,
      command: "npm test",
      cwd: workspaceDir,
      risk: "safe",
      reason: "Baseline test command execution to ground planning evidence.",
      provenance: {
        source: "agent",
        trigger: "manual",
        reason: "Baseline test command execution before recursive swarm planning."
      },
      status: "executed",
      createdAt: new Date().toISOString()
    });
    await sessionManager.addCommandExecution(session.id, {
      id: "exec_baseline_npm_test",
      sessionId: session.id,
      requestId: "cmd_baseline_npm_test",
      command: "npm test",
      cwd: workspaceDir,
      risk: "safe",
      exitCode: 1,
      stdout: "1 failing test",
      stderr: "",
      status: "executed",
      autoRun: false,
      provenance: {
        source: "agent",
        trigger: "manual",
        reason: "Baseline test command execution before recursive swarm planning."
      },
      createdAt: new Date().toISOString()
    });

    const { provider: rawProvider } = createMockLlmProvider();
    const telemetry = createTelemetry(session);
    const provider = new TelemetryLlmProvider(rawProvider, telemetry);

    const result = await service.run({
      sessionId: session.id,
      message: "Fix multiply bug in calculator.ts",
      provider,
      providerTelemetry: telemetry,
      projectMap: mockProjectMap,
      thinkFirst: true
    });

    // 1 & 3: Baseline evidence command is allowed and preserved before confirmation
    assert.equal(result.commandRequests.length, 1, "Baseline command request is preserved");
    assert.equal(result.commandRequests[0].id, "cmd_baseline_npm_test");
    assert.equal(result.commandExecutions.length, 1, "Baseline command execution is preserved");

    // 2. Performs reasoning but stops before patch/application
    assert.ok(result.recursiveSwarmRunState, "Run state must be saved");
    assert.ok(result.recursiveSwarmRunState.tree.nodeCount > 0, "Tree decomposition was performed");
    assert.equal(result.patchProposals.length, 0, "No patch proposals registered before confirmation");

    // 4. No post-implementation or mutating command registered before confirmation
    const postApplyCommands = result.commandRequests.filter(
      (c) => !c.reason?.toLowerCase().includes("baseline") && !c.provenance?.reason?.toLowerCase().includes("baseline")
    );
    assert.equal(postApplyCommands.length, 0, "No post-apply validation or mutating commands registered before confirmation");

    // 5. nextAction becomes confirm_plan, lifecycleStage is PLAN
    assert.equal(result.status, "needs_approval");
    assert.equal(result.lifecycleStage, "PLAN");
    assert.equal(result.nextAction?.kind, "confirm_plan");
    assert.equal(result.recursiveSwarmRunState.planState, "ready_to_implement");

    // 6. No Rust patch apply occurs before confirmation
    assert.equal(result.patchProposals.filter((p) => p.status === "approved" || p.status === "applied").length, 0);

    // Verify assistant message presented the plan
    const lastMsg = result.messages.at(-1);
    assert.equal(lastMsg?.role, "assistant");
    assert.match(lastMsg?.content ?? "", /Plan mode/i);
    assert.match(lastMsg?.content ?? "", /src\/calculator\.ts/);
    assert.match(lastMsg?.content ?? "", /npm test/);
  } finally {
    cleanupTestWorkspace(workspaceDir);
  }
});

test("Requirement G.5 & G.6: Implement plan resumes the same recursive plan without unnecessarily regenerating the entire tree", async () => {
  const { workspaceDir, storageDir } = createTestWorkspace();
  try {
    const eventBus = new EventBus();
    const sessionManager = new SessionManager(storageDir, eventBus);
    await sessionManager.load();
    const directTurnService = new RuntimeDirectTurnService(sessionManager);
    const service = new RuntimeRecursiveSwarmService(sessionManager, directTurnService);
    const pendingActionService = new RuntimePlanPendingActionService(sessionManager);

    const session = await sessionManager.createSession({
      workspacePath: workspaceDir,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      thinkFirst: true,
      userPrompt: "Fix multiply bug in calculator.ts"
    });

    const { provider: rawProvider, counters } = createMockLlmProvider();
    const telemetry = createTelemetry(session);
    const provider = new TelemetryLlmProvider(rawProvider, telemetry);

    // Step 1: Run Plan Mode ON turn
    const planSession = await service.run({
      sessionId: session.id,
      message: "Fix multiply bug in calculator.ts",
      provider,
      providerTelemetry: telemetry,
      projectMap: mockProjectMap,
      thinkFirst: true
    });

    assert.equal(planSession.status, "needs_approval");
    assert.equal(planSession.nextAction?.kind, "confirm_plan");
    const plannedRunId = planSession.recursiveSwarmRunState?.runId;
    const plannedNodeCount = planSession.recursiveSwarmRunState?.tree.nodeCount;
    const callsDuringPlanning = counters.generateStructuredCalls;
    assert.ok(callsDuringPlanning > 0, "Provider was called to reason and decompose the tree");

    // Step 2: Operator confirms implementation ("Implement plan" / "Proceed with implementation.")
    const pendingResult = await pendingActionService.handle(planSession, "Proceed with implementation.");
    assert.equal(pendingResult.matched, true);
    assert.equal(pendingResult.handled, false);
    assert.equal(pendingResult.resumePrompt, "Fix multiply bug in calculator.ts");

    const sessionAfterConfirm = sessionManager.getSession(session.id)!;
    assert.equal(sessionAfterConfirm.nextAction, undefined, "nextAction cleared after confirmation");
    assert.equal(sessionAfterConfirm.thinkFirst, false, "thinkFirst set to false after confirmation");

    // Step 3: Continuation turn runs recursiveSwarmService.run with thinkFirst: false
    const implementedSession = await service.run({
      sessionId: session.id,
      message: pendingResult.resumePrompt ?? "Fix multiply bug in calculator.ts",
      provider,
      providerTelemetry: telemetry,
      projectMap: mockProjectMap,
      thinkFirst: false
    });

    // 5. Implement plan resumes the same recursive plan: creates PatchProposal and enters APPROVAL (not premature completion)
    assert.equal(implementedSession.status, "needs_approval", "Session transitions to needs_approval, not premature completion");
    assert.equal(implementedSession.lifecycleStage, "APPROVAL", "Session transitions to APPROVAL");
    assert.equal(implementedSession.patchProposals.length, 1);
    assert.equal(implementedSession.patchProposals[0].filesChanged[0].path, "src/calculator.ts");
    assert.equal(implementedSession.recursiveSwarmRunState?.planState, "ready_to_implement", "planState remains ready_to_implement until Rust apply");
    assert.equal(implementedSession.recursiveSwarmRunState?.stagedValidationCommands?.length, 1, "Validation command is staged for post-apply");
    assert.equal(implementedSession.recursiveSwarmRunState?.runId, plannedRunId, "Same runId resumed");
    assert.equal(implementedSession.recursiveSwarmRunState?.tree.nodeCount, plannedNodeCount, "Same node count preserved");

    // 6. Confirmation does not unnecessarily regenerate the entire tree (ZERO provider LLM calls made during resumption!)
    const callsAfterResumption = counters.generateStructuredCalls;
    assert.equal(
      callsAfterResumption,
      callsDuringPlanning,
      "No additional LLM provider calls should be made during plan implementation resumption"
    );
  } finally {
    cleanupTestWorkspace(workspaceDir);
  }
});

test("Requirement G.7: mid-session Plan Mode changes reach the backend", async () => {
  const { workspaceDir, storageDir } = createTestWorkspace();
  try {
    const eventBus = new EventBus();
    const sessionManager = new SessionManager(storageDir, eventBus);
    await sessionManager.load();
    const runtime = new AgentRuntime({ ...loadConfig(), storageDir }, sessionManager, {
      providerFactory: () => new ScriptedProvider()
    });

    // Turn 1: Created with thinkFirst = false
    const created = await runtime.createSession({
      workspacePath: workspaceDir,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      thinkFirst: false,
      userPrompt: "first question"
    });
    let session = runtime.getSession(created.sessionId)!;
    assert.equal(session.thinkFirst, false);

    // Turn 2: User changes Plan Mode toggle to ON mid-session
    await runtime.runTurn(created.sessionId, "follow up turn with plan mode on", { thinkFirst: true });
    session = runtime.getSession(created.sessionId)!;
    assert.equal(session.thinkFirst, true, "Mid-session toggle ON must reach session.thinkFirst");

    // Turn 3: User changes Plan Mode toggle to OFF mid-session
    await runtime.runTurn(created.sessionId, "follow up turn with plan mode off", { thinkFirst: false });
    session = runtime.getSession(created.sessionId)!;
    assert.equal(session.thinkFirst, false, "Mid-session toggle OFF must reach session.thinkFirst");
  } finally {
    cleanupTestWorkspace(workspaceDir);
  }
});

test("Requirement G.8: simple_mode existing behavior is unchanged", async () => {
  process.env.HIVO_DISABLE_BACKGROUND_COMMANDS = "1";
  const { workspaceDir, storageDir } = createTestWorkspace();
  try {
    const eventBus = new EventBus();
    const sessionManager = new SessionManager(storageDir, eventBus);
    await sessionManager.load();
    const runtime = new AgentRuntime({ ...loadConfig(), storageDir }, sessionManager, {
      providerFactory: () => new ScriptedProvider()
    });

    // Simple mode run with thinkFirst = true stops at confirm_plan
    const sessionPlanOn = await runtime.createSession({
      workspacePath: workspaceDir,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      accessProfile: "full_access",
      executionMode: "simple_mode",
      thinkFirst: true,
      userPrompt: "build feature in simple mode"
    });
    await runtime.runTurn(sessionPlanOn.sessionId, "build feature in simple mode", { thinkFirst: true });
    const planOnResult = runtime.getSession(sessionPlanOn.sessionId);
    assert.equal(planOnResult?.nextAction?.kind, "confirm_plan");
    assert.equal(planOnResult?.status, "needs_approval");
    assert.equal(planOnResult?.lifecycleStage, "PLAN");

    // Simple mode run with thinkFirst = false does not stop at confirm_plan
    const sessionPlanOff = await runtime.createSession({
      workspacePath: workspaceDir,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      accessProfile: "full_access",
      executionMode: "simple_mode",
      thinkFirst: false,
      userPrompt: "build feature in simple mode"
    });
    await runtime.runTurn(sessionPlanOff.sessionId, "build feature in simple mode", { thinkFirst: false });
    const planOffResult = runtime.getSession(sessionPlanOff.sessionId);
    assert.notEqual(planOffResult?.nextAction?.kind, "confirm_plan");
  } finally {
    cleanupTestWorkspace(workspaceDir);
  }
});
