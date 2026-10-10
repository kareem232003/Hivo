import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import type { AgentRuntimeSession, PatchProposal, ProjectMap, SanitizedProviderConfig } from "@hivo/protocol";
import { EventBus } from "../runtime/EventBus.js";
import { SessionManager } from "../runtime/SessionManager.js";
import { RuntimeDirectTurnService } from "../runtime/RuntimeDirectTurnService.js";
import { RuntimeRecursiveSwarmService } from "../runtime/RuntimeRecursiveSwarmService.js";
import { RuntimePlanPendingActionService } from "../runtime/RuntimePlanPendingActionService.js";
import { RuntimeApprovalBoundaryService } from "../runtime/RuntimeApprovalBoundaryService.js";
import { RuntimeSessionOutcomeService } from "../runtime/RuntimeSessionOutcomeService.js";
import { AgentRuntime } from "../runtime/AgentRuntime.js";
import { loadConfig } from "../config.js";
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

const repositoryRoot = path.resolve(import.meta.dirname, "../../..", "..");
const calculatorFixture = "F:\\Projects\\Python\\HIVO_TEST_PROJECTS\\buggy-calculator";
const calculatorPatch = `--- a/src/calculator.ts
+++ b/src/calculator.ts
@@ -9,3 +9,3 @@
 export function multiply(a: number, b: number): number {
-  return a + b;
+  return a * b;
 }
`;

class RecursiveCalculatorProvider implements LlmProvider {
  workerReceivedActualSource = false;
  implementationWorkerReached = false;

  constructor(private readonly artifactPath: string, private readonly artifactContent: string) {}

  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    const name = (schema as { name?: string })?.name ?? "";
    if (name === "expanded_goal_spec") {
      return {
        isAlreadyDetailed: true,
        expandedGoal: input.userPrompt,
        requirements: ["Correct multiply behavior"],
        acceptanceCriteria: ["multiply(3, 4) returns 12"],
        deliverableContract: "A concrete source patch for src/calculator.ts",
        constraints: [],
        nonGoals: [],
        qualityBar: ["Minimal patch"]
      } as T;
    }
    if (name === "atomicity_assessment") {
      const isRoot = input.userPrompt.includes("DEPTH: 0");
      return {
        isAtomic: !isRoot,
        score: isRoot ? 6 : 2,
        rationale: isRoot ? "Delegate the source edit to an implementation worker." : "The source edit is atomic.",
        failures: isRoot ? ["MULTIPLE_STEPS"] : []
      } as T;
    }
    if (name === "split_result") {
      return {
        shouldSplit: true,
        desiredChildCount: 2,
        splitReason: "Inspect the source, then assign the edit to an implementation worker.",
        subTasks: [
          {
            id: "calculator-source-inspection",
            title: "Inspect calculator source",
            taskPrompt: "Inspect src/calculator.ts and identify the current multiply behavior.",
            expectedOutput: "Evidence report for the multiply implementation.",
            dependencies: [],
            responsibility: "INSPECT"
          },
          {
            id: "calculator-edit",
            title: "Implement multiply correction",
            taskPrompt: "Correct multiply in src/calculator.ts to use multiplication.",
            expectedOutput: "A concrete unified diff for src/calculator.ts.",
            dependencies: ["0"],
            canWrite: true,
            responsibility: "IMPLEMENT"
          }
        ],
        stopConditions: [],
        rationale: "One source file requires one implementation worker."
      } as T;
    }
    if (name === "goal_check") {
      return { aligned: true, status: "aligned", findings: [], warnings: [] } as T;
    }
    if (name === "structured_node_output") {
      if (input.userPrompt.includes("Inspect src/calculator.ts")) {
        return {
          kind: "evidence_report",
          findings: ["multiply currently returns a + b instead of a * b."],
          files: ["src/calculator.ts"],
          symbols: ["multiply"],
          evidence_refs: ["file:src/calculator.ts#9-11"],
          unknowns: [],
          confidence: 0.95
        } as T;
      }
      this.implementationWorkerReached = input.userPrompt.includes("Correct multiply in src/calculator.ts");
      this.workerReceivedActualSource = this.implementationWorkerReached &&
        input.systemPrompt.includes("export function multiply(a: number, b: number): number {\n  return a + b;\n}");
      return {
        kind: "generated_artifact",
        path: this.artifactPath,
        content: this.artifactContent,
        artifact_type: "text",
        description: "Correct the multiply implementation.",
        validation_steps: ["npm test"],
        completeness_notes: ["Change the multiply operator from + to *."],
        confidence: 0.95
      } as T;
    }
    throw new Error(`Unexpected scripted recursive provider schema: ${name}`);
  }

  async generateText(): Promise<string> {
    return "Collected the implementation worker's structured output without claiming it was applied.";
  }
}

function initializeCalculatorFixture(workspaceDir: string) {
  fs.mkdirSync(workspaceDir, { recursive: true });
  for (const entry of ["src", "tests"]) {
    fs.cpSync(path.join(calculatorFixture, entry), path.join(workspaceDir, entry), { recursive: true });
  }
  for (const entry of ["package.json", "tsconfig.json"]) {
    fs.copyFileSync(path.join(calculatorFixture, entry), path.join(workspaceDir, entry));
  }
  fs.symlinkSync(path.join(calculatorFixture, "node_modules"), path.join(workspaceDir, "node_modules"), "junction");
  execFileSync("git", ["init"], { cwd: workspaceDir, windowsHide: true });
  execFileSync("git", ["config", "user.email", "hivo-test@example.com"], { cwd: workspaceDir, windowsHide: true });
  execFileSync("git", ["config", "user.name", "Hivo Test"], { cwd: workspaceDir, windowsHide: true });
  execFileSync("git", ["add", "src", "tests", "package.json", "tsconfig.json"], { cwd: workspaceDir, windowsHide: true });
  execFileSync("git", ["commit", "-m", "calculator fixture baseline"], { cwd: workspaceDir, windowsHide: true });
}

test("recursive implementation worker proposes a PatchTools-validated calculator edit for Rust approval", async () => {
  const disposableRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hivo-recursive-calculator-patch-"));
  const workspaceDir = path.join(disposableRoot, "workspace");
  const storageDir = path.join(disposableRoot, "runtime-state");
  const originalSource = fs.readFileSync(path.join(calculatorFixture, "src", "calculator.ts"), "utf8");

  try {
    initializeCalculatorFixture(workspaceDir);
    const eventBus = new EventBus();
    const sessionManager = new SessionManager(storageDir, eventBus);
    await sessionManager.load();
    const service = new RuntimeRecursiveSwarmService(
      sessionManager,
      new RuntimeDirectTurnService(sessionManager)
    );
    const approvalService = new RuntimeApprovalBoundaryService(sessionManager);
    const goal = "Fix multiply in src/calculator.ts so it returns the product, then verify the existing tests.";

    const runRecursiveWorker = async (artifactContent: string) => {
      const session = await sessionManager.createSession({
        workspacePath: workspaceDir,
        mode: "real_provider",
        providerConfig: validProviderConfig,
        accessProfile: "default_permissions",
        userPrompt: goal,
        thinkFirst: false
      });
      const scriptedProvider = new RecursiveCalculatorProvider("patch.diff", artifactContent);
      const telemetry = createTelemetry(session);
      const result = await service.run({
        sessionId: session.id,
        message: goal,
        provider: new TelemetryLlmProvider(scriptedProvider, telemetry),
        providerTelemetry: telemetry,
        projectMap: mockProjectMap,
        thinkFirst: false
      });
      return { result, scriptedProvider };
    };

    const invalidArtifact = `--- /dev/null
+++ b/src/session.p12
@@ -0,0 +1,1 @@
+not-a-real-secret
`;
    const invalidRun = await runRecursiveWorker(invalidArtifact);
    assert.equal(invalidRun.scriptedProvider.implementationWorkerReached, true);
    assert.equal(invalidRun.scriptedProvider.workerReceivedActualSource, true);
    assert.equal(invalidRun.result.patchProposals.length, 0, "PatchTools must reject a candidate before it reaches approval.");
    assert.equal(invalidRun.result.status, "blocked");
    assert.ok(
      invalidRun.result.runSummary?.gates.some((gate) =>
        gate.notes.some((note) => note.includes("PatchTools rejected recursive proposal"))
      ),
      `The rejected proposal must be reported in the recursive run gate: ${JSON.stringify({
        gates: invalidRun.result.runSummary?.gates,
        nodes: invalidRun.result.swarmState?.nodes
      })}`
    );
    assert.equal(
      fs.readFileSync(path.join(workspaceDir, "src", "calculator.ts"), "utf8"),
      originalSource,
      "A rejected recursive candidate must not mutate workspace source."
    );

    const validRun = await runRecursiveWorker(calculatorPatch);
    assert.equal(validRun.scriptedProvider.implementationWorkerReached, true);
    assert.equal(validRun.scriptedProvider.workerReceivedActualSource, true);
    assert.equal(validRun.result.status, "needs_approval");
    assert.equal(validRun.result.lifecycleStage, "APPROVAL");
    assert.equal(validRun.result.patchProposals.length, 1);

    const rawNodes = validRun.result.recursiveSwarmRunState?.tree.rawNodes as
      | Record<string, { kind?: string; status?: string; contract?: { responsibility?: string }; structuredOutput?: { kind?: string } }>
      | undefined;
    const implementationWorker = Object.values(rawNodes ?? {}).find((node) =>
      node.kind === "task_agent" &&
      node.contract?.responsibility === "IMPLEMENT" &&
      node.status === "succeeded" &&
      node.structuredOutput?.kind === "generated_artifact"
    );
    assert.ok(implementationWorker, "The completed recursive tree must retain its real IMPLEMENT worker output.");

    const proposal = validRun.result.patchProposals[0] as PatchProposal;
    assert.match(proposal.id, /^patch_/, "Recursive proposals must use the shared PatchTools proposal interface.");
    assert.deepEqual(proposal.filesChanged.map((file) => file.path), ["src/calculator.ts"]);
    assert.equal(proposal.requiresApproval, true);
    assert.equal(proposal.status, "proposed");
    assert.match(proposal.unifiedDiff, /\+  return a \* b;/);
    assert.equal(
      fs.readFileSync(path.join(workspaceDir, "src", "calculator.ts"), "utf8"),
      originalSource,
      "The source must remain unchanged until an operator approves the proposal."
    );

    const approval = await approvalService.approvePatch(validRun.result.id, proposal.id);
    assert.equal(approval.proposal.status, "approved");
    const beforeRustApply = fs.readFileSync(path.join(workspaceDir, "src", "calculator.ts"), "utf8");
    assert.equal(beforeRustApply, originalSource, "Runtime approval alone must not apply the source change.");

    const tauriManifest = path.join(repositoryRoot, "apps", "desktop", "src-tauri", "Cargo.toml");
    const isolatedAppData = path.join(disposableRoot, "appdata");
    const patchOutput = execFileSync("cargo", [
      "run",
      "--quiet",
      "--manifest-path",
      tauriManifest,
      "--bin",
      "runtime_bridge_smoke",
      "--",
      "--workspace",
      workspaceDir,
      "--apply-runtime-patch",
      "true",
      "--session-id",
      validRun.result.id,
      "--patch-id",
      proposal.id,
      "--proposal-json",
      JSON.stringify(approval.proposal)
    ], {
      cwd: repositoryRoot,
      encoding: "utf8",
      windowsHide: true,
      timeout: 180_000,
      env: {
        ...process.env,
        APPDATA: isolatedAppData,
        LOCALAPPDATA: isolatedAppData
      }
    });
    const rustResult = JSON.parse(patchOutput) as {
      patchResult: { status: string; authority: string };
    };
    assert.equal(rustResult.patchResult.status, "applied");
    assert.equal(rustResult.patchResult.authority, "rust_patch_service");
    await approvalService.recordPatchApplyResult(validRun.result.id, proposal.id, {
      status: "applied",
      message: "Rust PatchService applied the approved recursive worker proposal."
    });

    const calculatorTestEnv = { ...process.env };
    delete calculatorTestEnv.NODE_TEST_CONTEXT;
    const npmTest = spawnSync("npm.cmd", ["test"], {
      cwd: workspaceDir,
      encoding: "utf8",
      shell: true,
      windowsHide: true,
      timeout: 180_000,
      env: calculatorTestEnv
    });
    assert.equal(npmTest.status, 0, `${npmTest.stdout}\n${npmTest.stderr}`);
    assert.match(`${npmTest.stdout}\n${npmTest.stderr}`, /pass 4|4 pass/i);
    assert.match(
      fs.readFileSync(path.join(workspaceDir, "src", "calculator.ts"), "utf8"),
      /return a \* b;/
    );
    assert.equal(
      fs.readFileSync(path.join(calculatorFixture, "src", "calculator.ts"), "utf8"),
      originalSource,
      "Only the isolated fixture copy may be edited."
    );
  } finally {
    fs.rmSync(disposableRoot, { recursive: true, force: true });
  }
});

function createTestWorkspace(): { workspaceDir: string; storageDir: string } {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "hivo-lifecycle-test-"));
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

function createMockLlmProvider() {
  const provider: LlmProvider = {
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
  return { provider };
}

test("Requirement H.1: Creating a PatchProposal does NOT mark the session completed", async () => {
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

    assert.notEqual(result.status, "completed", "Creating a patch proposal must not mark session completed");
    assert.notEqual(result.lifecycleStage, "DONE", "Lifecycle stage must not be DONE");
    assert.equal(result.status, "needs_approval");
    assert.equal(result.patchProposals.length, 1);
  } finally {
    cleanupTestWorkspace(workspaceDir);
  }
});

test("Requirement H.2: Manual-approval mode waits for approval", async () => {
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
      accessProfile: "default_permissions",
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

    assert.equal(result.status, "needs_approval");
    assert.equal(result.lifecycleStage, "APPROVAL", "Must wait in APPROVAL stage");
    assert.equal(result.patchProposals[0].status, "proposed", "Patch proposal must be in proposed status");
  } finally {
    cleanupTestWorkspace(workspaceDir);
  }
});

test("Requirement H.3: No Rust apply acknowledgement means no completed/DONE state", async () => {
  const { workspaceDir, storageDir } = createTestWorkspace();
  try {
    const eventBus = new EventBus();
    const sessionManager = new SessionManager(storageDir, eventBus);
    await sessionManager.load();
    const approvalService = new RuntimeApprovalBoundaryService(sessionManager);
    const outcomeService = new RuntimeSessionOutcomeService(sessionManager);

    const session = await sessionManager.createSession({
      workspacePath: workspaceDir,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      userPrompt: "Fix multiply bug in calculator.ts"
    });

    await sessionManager.addPatchProposal(session.id, {
      id: "patch_1",
      sessionId: session.id,
      title: "Fix multiply bug",
      summary: "Change + to *",
      riskLevel: "low",
      filesChanged: [{ path: "src/calculator.ts", changeType: "modify", explanation: "Fix bug" }],
      unifiedDiff: "diff --git a/src/calculator.ts b/src/calculator.ts\n--- a/src/calculator.ts\n+++ b/src/calculator.ts\n@@ -5,3 +5,3 @@\n export function multiply(a: number, b: number): number {\n-  return a + b;\n+  return a * b;\n }\n",
      requiresApproval: true,
      status: "proposed",
      createdAt: new Date().toISOString()
    });

    // Approve the patch (operator approved, but Rust has NOT applied it yet)
    await approvalService.approvePatch(session.id, "patch_1");
    await outcomeService.sync(session.id);

    const afterApproval = sessionManager.getSession(session.id)!;
    assert.equal(afterApproval.status, "needs_approval");
    assert.equal(afterApproval.lifecycleStage, "APPLY", "Approved patch is in APPLY stage waiting for Rust apply");
    assert.notEqual(afterApproval.status, "completed", "Must not be completed before Rust apply acknowledgement");
    assert.notEqual(afterApproval.lifecycleStage, "DONE", "Must not be DONE before Rust apply acknowledgement");
  } finally {
    cleanupTestWorkspace(workspaceDir);
  }
});

test("Requirement H.4: After authoritative patch apply success, post-apply validation is requested exactly once", async () => {
  const { workspaceDir, storageDir } = createTestWorkspace();
  try {
    const eventBus = new EventBus();
    const sessionManager = new SessionManager(storageDir, eventBus);
    await sessionManager.load();
    const runtime = new AgentRuntime({ ...loadConfig(), storageDir }, sessionManager, {
      providerFactory: () => createMockLlmProvider().provider
    });

    const created = await runtime.createSession({
      workspacePath: workspaceDir,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      accessProfile: "full_access",
      userPrompt: "Fix multiply bug in calculator.ts"
    });

    const patchId = "patch_rec_1";
    await sessionManager.addPatchProposal(created.sessionId, {
      id: patchId,
      sessionId: created.sessionId,
      title: "Fix multiply bug",
      summary: "Change + to *",
      riskLevel: "low",
      filesChanged: [{ path: "src/calculator.ts", changeType: "modify", explanation: "Fix bug" }],
      unifiedDiff: "--- a/src/calculator.ts\n+++ b/src/calculator.ts\n@@ -5,3 +5,3 @@\n export function multiply(a: number, b: number): number {\n-  return a + b;\n+  return a * b;\n }\n",
      requiresApproval: false,
      status: "approved",
      createdAt: new Date().toISOString()
    });

    await sessionManager.updateSession(created.sessionId, (draft) => {
      draft.recursiveSwarmRunState = {
        schemaVersion: 1,
        runId: "run_test_1",
        sessionId: created.sessionId,
        goalEnvelope: {
          originalGoal: "Fix multiply bug",
          theme: "fix",
          constraints: [],
          nonGoals: [],
          acceptanceCriteria: [],
          workspaceIdentity: "test",
          localTask: "fix",
          version: 1
        },
        planState: "ready_to_implement",
        stagedValidationCommands: [
          {
            id: "valcmd_post_apply_test",
            sessionId: created.sessionId,
            command: "npm test",
            cwd: workspaceDir,
            risk: "safe",
            reason: "Validate multiply fix with tests",
            status: "requested",
            createdAt: new Date().toISOString()
          }
        ],
        tree: {
          schemaVersion: 1,
          runId: "run_test_1",
          rootGoal: "Fix multiply bug",
          rootId: "0",
          nodeCount: 2,
          depth: 1,
          status: "completed",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    });

    // Authoritative Rust patch apply report
    const sessionAfterApply = await runtime.reportPatchApplyResult(created.sessionId, patchId, {
      status: "applied",
      message: "Patch applied cleanly by Rust authority."
    });

    assert.equal(sessionAfterApply.status, "needs_approval");
    assert.equal(sessionAfterApply.lifecycleStage, "POST_VERIFY", "Enters POST_VERIFY stage");
    assert.equal(sessionAfterApply.nextAction?.kind, "approve_commands");

    // Post-apply validation command requested
    const valCommands = sessionAfterApply.commandRequests.filter(
      (c) => c.reason?.includes(`Post-apply validation for patch ${patchId}`)
    );
    assert.equal(valCommands.length, 1, "Validation command must be requested exactly once");
    assert.equal(valCommands[0].command, "npm test");
    assert.equal(valCommands[0].provenance?.approvalId, patchId);
  } finally {
    cleanupTestWorkspace(workspaceDir);
  }
});

test("Requirement H.5: Baseline validation and post-apply validation are distinct executions", async () => {
  const { workspaceDir, storageDir } = createTestWorkspace();
  try {
    const eventBus = new EventBus();
    const sessionManager = new SessionManager(storageDir, eventBus);
    await sessionManager.load();
    const runtime = new AgentRuntime({ ...loadConfig(), storageDir }, sessionManager, {
      providerFactory: () => createMockLlmProvider().provider
    });

    const created = await runtime.createSession({
      workspacePath: workspaceDir,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      accessProfile: "full_access",
      userPrompt: "Fix multiply bug in calculator.ts"
    });

    // 1. Record pre-plan baseline command execution (failing exitCode 1)
    await sessionManager.addCommandRequest(created.sessionId, {
      id: "cmd_baseline",
      sessionId: created.sessionId,
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
    await sessionManager.addCommandExecution(created.sessionId, {
      id: "exec_baseline",
      sessionId: created.sessionId,
      requestId: "cmd_baseline",
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

    // 2. Propose patch
    const patchId = "patch_h5";
    await sessionManager.addPatchProposal(created.sessionId, {
      id: patchId,
      sessionId: created.sessionId,
      title: "Fix multiply bug",
      summary: "Change + to *",
      riskLevel: "low",
      filesChanged: [{ path: "src/calculator.ts", changeType: "modify", explanation: "Fix bug" }],
      unifiedDiff: "--- a/src/calculator.ts\n+++ b/src/calculator.ts\n@@ -5,3 +5,3 @@\n export function multiply(a: number, b: number): number {\n-  return a + b;\n+  return a * b;\n }\n",
      requiresApproval: false,
      status: "approved",
      createdAt: new Date().toISOString()
    });

    await sessionManager.updateSession(created.sessionId, (draft) => {
      draft.recursiveSwarmRunState = {
        schemaVersion: 1,
        runId: "run_h5",
        sessionId: created.sessionId,
        goalEnvelope: {
          originalGoal: "Fix multiply bug",
          theme: "fix",
          constraints: [],
          nonGoals: [],
          acceptanceCriteria: [],
          workspaceIdentity: "test",
          localTask: "fix",
          version: 1
        },
        planState: "ready_to_implement",
        stagedValidationCommands: [
          {
            id: "valcmd_post_h5",
            sessionId: created.sessionId,
            command: "npm test",
            cwd: workspaceDir,
            risk: "safe",
            reason: "Validate multiply fix with tests",
            status: "requested",
            createdAt: new Date().toISOString()
          }
        ],
        tree: {
          schemaVersion: 1,
          runId: "run_h5",
          rootGoal: "Fix multiply bug",
          rootId: "0",
          nodeCount: 2,
          depth: 1,
          status: "completed",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    });

    // 3. Apply patch
    await runtime.reportPatchApplyResult(created.sessionId, patchId, {
      status: "applied",
      message: "Patch applied by Rust."
    });

    // 4. Report post-apply validation execution (passing exitCode 0)
    await runtime.reportCommandResult(created.sessionId, "valcmd_post_h5", {
      command: "npm test",
      cwd: workspaceDir,
      risk: "safe",
      exitCode: 0,
      stdout: "4 passed\n0 failed",
      stderr: "",
      status: "executed"
    });

    const finalSession = runtime.getSession(created.sessionId)!;

    // Both executions are present and distinct
    assert.equal(finalSession.commandExecutions.length, 2);
    const baselineExec = finalSession.commandExecutions.find((e) => e.requestId === "cmd_baseline");
    const postApplyExec = finalSession.commandExecutions.find((e) => e.requestId === "valcmd_post_h5");
    assert.ok(baselineExec);
    assert.ok(postApplyExec);
    assert.equal(baselineExec.exitCode, 1, "Baseline was failing");
    assert.equal(postApplyExec.exitCode, 0, "Post-apply was passing");

    // Session is completed based on post-apply validation pass
    assert.equal(finalSession.status, "completed");
    assert.equal(finalSession.lifecycleStage, "DONE");
  } finally {
    cleanupTestWorkspace(workspaceDir);
  }
});

test("Requirement H.6: Post-apply exitCode 0 -> completed / DONE", async () => {
  const { workspaceDir, storageDir } = createTestWorkspace();
  try {
    const eventBus = new EventBus();
    const sessionManager = new SessionManager(storageDir, eventBus);
    await sessionManager.load();
    const runtime = new AgentRuntime({ ...loadConfig(), storageDir }, sessionManager, {
      providerFactory: () => createMockLlmProvider().provider
    });

    const created = await runtime.createSession({
      workspacePath: workspaceDir,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      accessProfile: "full_access",
      userPrompt: "Fix multiply bug in calculator.ts"
    });

    const patchId = "patch_h6";
    await sessionManager.addPatchProposal(created.sessionId, {
      id: patchId,
      sessionId: created.sessionId,
      title: "Fix multiply bug",
      summary: "Change + to *",
      riskLevel: "low",
      filesChanged: [{ path: "src/calculator.ts", changeType: "modify", explanation: "Fix bug" }],
      unifiedDiff: "--- a/src/calculator.ts\n+++ b/src/calculator.ts\n@@ -5,3 +5,3 @@\n export function multiply(a: number, b: number): number {\n-  return a + b;\n+  return a * b;\n }\n",
      requiresApproval: false,
      status: "approved",
      createdAt: new Date().toISOString()
    });

    await sessionManager.updateSession(created.sessionId, (draft) => {
      draft.recursiveSwarmRunState = {
        schemaVersion: 1,
        runId: "run_h6",
        sessionId: created.sessionId,
        goalEnvelope: { originalGoal: "fix", theme: "fix", constraints: [], nonGoals: [], acceptanceCriteria: [], workspaceIdentity: "t", localTask: "f", version: 1 },
        planState: "ready_to_implement",
        stagedValidationCommands: [
          {
            id: "cmd_h6_val",
            sessionId: created.sessionId,
            command: "npm test",
            cwd: workspaceDir,
            risk: "safe",
            reason: "validate",
            status: "requested",
            createdAt: new Date().toISOString()
          }
        ],
        tree: { schemaVersion: 1, runId: "run_h6", rootGoal: "fix", rootId: "0", nodeCount: 1, depth: 1, status: "completed", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    });

    await runtime.reportPatchApplyResult(created.sessionId, patchId, { status: "applied", message: "Applied" });
    const completedSession = await runtime.reportCommandResult(created.sessionId, "cmd_h6_val", {
      command: "npm test",
      cwd: workspaceDir,
      risk: "safe",
      exitCode: 0,
      stdout: "All tests pass",
      stderr: "",
      status: "executed"
    });

    assert.equal(completedSession.status, "completed");
    assert.equal(completedSession.lifecycleStage, "DONE");
    assert.equal(completedSession.recursiveSwarmRunState?.planState, "implemented");
  } finally {
    cleanupTestWorkspace(workspaceDir);
  }
});

test("Requirement H.7: Post-apply exitCode != 0 -> NOT successful, failure flow entered", async () => {
  const { workspaceDir, storageDir } = createTestWorkspace();
  try {
    const eventBus = new EventBus();
    const sessionManager = new SessionManager(storageDir, eventBus);
    await sessionManager.load();
    const runtime = new AgentRuntime({ ...loadConfig(), storageDir }, sessionManager, {
      providerFactory: () => createMockLlmProvider().provider
    });

    const created = await runtime.createSession({
      workspacePath: workspaceDir,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      accessProfile: "full_access",
      userPrompt: "Fix multiply bug in calculator.ts"
    });

    const patchId = "patch_h7";
    await sessionManager.addPatchProposal(created.sessionId, {
      id: patchId,
      sessionId: created.sessionId,
      title: "Fix multiply bug",
      summary: "Change + to *",
      riskLevel: "low",
      filesChanged: [{ path: "src/calculator.ts", changeType: "modify", explanation: "Fix bug" }],
      unifiedDiff: "--- a/src/calculator.ts\n+++ b/src/calculator.ts\n@@ -5,3 +5,3 @@\n export function multiply(a: number, b: number): number {\n-  return a + b;\n+  return a * b;\n }\n",
      requiresApproval: false,
      status: "approved",
      createdAt: new Date().toISOString()
    });

    await sessionManager.updateSession(created.sessionId, (draft) => {
      draft.recursiveSwarmRunState = {
        schemaVersion: 1,
        runId: "run_h7",
        sessionId: created.sessionId,
        goalEnvelope: { originalGoal: "fix", theme: "fix", constraints: [], nonGoals: [], acceptanceCriteria: [], workspaceIdentity: "t", localTask: "f", version: 1 },
        planState: "ready_to_implement",
        stagedValidationCommands: [
          {
            id: "cmd_h7_val",
            sessionId: created.sessionId,
            command: "npm test",
            cwd: workspaceDir,
            risk: "safe",
            reason: "validate",
            status: "requested",
            createdAt: new Date().toISOString()
          }
        ],
        tree: { schemaVersion: 1, runId: "run_h7", rootGoal: "fix", rootId: "0", nodeCount: 1, depth: 1, status: "completed", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    });

    await runtime.reportPatchApplyResult(created.sessionId, patchId, { status: "applied", message: "Applied" });
    const failedSession = await runtime.reportCommandResult(created.sessionId, "cmd_h7_val", {
      command: "npm test",
      cwd: workspaceDir,
      risk: "safe",
      exitCode: 1,
      stdout: "",
      stderr: "Test failed",
      status: "failed"
    });

    assert.notEqual(failedSession.status, "completed");
    assert.notEqual(failedSession.lifecycleStage, "DONE");
    assert.equal(failedSession.status, "failed");
    assert.equal(failedSession.lifecycleStage, "FAILED");
  } finally {
    cleanupTestWorkspace(workspaceDir);
  }
});

test("Requirement H.8: Patch apply failure -> NOT completed", async () => {
  const { workspaceDir, storageDir } = createTestWorkspace();
  try {
    const eventBus = new EventBus();
    const sessionManager = new SessionManager(storageDir, eventBus);
    await sessionManager.load();
    const runtime = new AgentRuntime({ ...loadConfig(), storageDir }, sessionManager, {
      providerFactory: () => createMockLlmProvider().provider
    });

    const created = await runtime.createSession({
      workspacePath: workspaceDir,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      accessProfile: "full_access",
      userPrompt: "Fix multiply bug in calculator.ts"
    });

    const patchId = "patch_h8";
    await sessionManager.addPatchProposal(created.sessionId, {
      id: patchId,
      sessionId: created.sessionId,
      title: "Fix multiply bug",
      summary: "Change + to *",
      riskLevel: "low",
      filesChanged: [{ path: "src/calculator.ts", changeType: "modify", explanation: "Fix bug" }],
      unifiedDiff: "invalid diff",
      requiresApproval: false,
      status: "approved",
      createdAt: new Date().toISOString()
    });

    const failedApplySession = await runtime.reportPatchApplyResult(created.sessionId, patchId, {
      status: "failed",
      message: "Hunk failed to apply to target file."
    });

    assert.notEqual(failedApplySession.status, "completed");
    assert.notEqual(failedApplySession.lifecycleStage, "DONE");
    assert.equal(failedApplySession.status, "failed");
    assert.equal(failedApplySession.lifecycleStage, "FAILED");
  } finally {
    cleanupTestWorkspace(workspaceDir);
  }
});

test("Requirement H.9: Duplicate callbacks do not apply the same proposal twice or run validation twice", async () => {
  const { workspaceDir, storageDir } = createTestWorkspace();
  try {
    const eventBus = new EventBus();
    const sessionManager = new SessionManager(storageDir, eventBus);
    await sessionManager.load();
    const runtime = new AgentRuntime({ ...loadConfig(), storageDir }, sessionManager, {
      providerFactory: () => createMockLlmProvider().provider
    });

    const created = await runtime.createSession({
      workspacePath: workspaceDir,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      accessProfile: "full_access",
      userPrompt: "Fix multiply bug in calculator.ts"
    });

    const patchId = "patch_h9";
    await sessionManager.addPatchProposal(created.sessionId, {
      id: patchId,
      sessionId: created.sessionId,
      title: "Fix multiply bug",
      summary: "Change + to *",
      riskLevel: "low",
      filesChanged: [{ path: "src/calculator.ts", changeType: "modify", explanation: "Fix bug" }],
      unifiedDiff: "--- a/src/calculator.ts\n+++ b/src/calculator.ts\n@@ -5,3 +5,3 @@\n export function multiply(a: number, b: number): number {\n-  return a + b;\n+  return a * b;\n }\n",
      requiresApproval: false,
      status: "approved",
      createdAt: new Date().toISOString()
    });

    await sessionManager.updateSession(created.sessionId, (draft) => {
      draft.recursiveSwarmRunState = {
        schemaVersion: 1,
        runId: "run_h9",
        sessionId: created.sessionId,
        goalEnvelope: { originalGoal: "fix", theme: "fix", constraints: [], nonGoals: [], acceptanceCriteria: [], workspaceIdentity: "t", localTask: "f", version: 1 },
        planState: "ready_to_implement",
        stagedValidationCommands: [
          {
            id: "cmd_h9_val",
            sessionId: created.sessionId,
            command: "npm test",
            cwd: workspaceDir,
            risk: "safe",
            reason: "validate",
            status: "requested",
            createdAt: new Date().toISOString()
          }
        ],
        tree: { schemaVersion: 1, runId: "run_h9", rootGoal: "fix", rootId: "0", nodeCount: 1, depth: 1, status: "completed", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    });

    // First apply report
    await runtime.reportPatchApplyResult(created.sessionId, patchId, { status: "applied", message: "Applied" });
    const sessionFirst = runtime.getSession(created.sessionId)!;
    const countAfterFirst = sessionFirst.commandRequests.length;

    // Second apply report (duplicate callback)
    try {
      await runtime.reportPatchApplyResult(created.sessionId, patchId, { status: "applied", message: "Applied again" });
    } catch {
      // It's acceptable for the boundary service to reject duplicate status transitions
    }

    const sessionSecond = runtime.getSession(created.sessionId)!;
    assert.equal(sessionSecond.commandRequests.length, countAfterFirst, "Validation command was not duplicated");
  } finally {
    cleanupTestWorkspace(workspaceDir);
  }
});

test("Requirement H.10: Normal Plan OFF and resumed Plan ON both converge onto the SAME downstream approval/apply/validation pipeline", async () => {
  const { workspaceDir, storageDir } = createTestWorkspace();
  try {
    const eventBus = new EventBus();
    const sessionManager = new SessionManager(storageDir, eventBus);
    await sessionManager.load();
    const directTurnService = new RuntimeDirectTurnService(sessionManager);
    const service = new RuntimeRecursiveSwarmService(sessionManager, directTurnService);
    const pendingActionService = new RuntimePlanPendingActionService(sessionManager);
    const runtime = new AgentRuntime({ ...loadConfig(), storageDir }, sessionManager, {
      providerFactory: () => createMockLlmProvider().provider
    });

    // --- PIPELINE 1: Plan Mode OFF ---
    const sessionOff = await sessionManager.createSession({
      workspacePath: workspaceDir,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      accessProfile: "full_access",
      userPrompt: "Fix multiply bug in calculator.ts"
    });

    const { provider: rawProvider } = createMockLlmProvider();
    const telemetryOff = createTelemetry(sessionOff);
    const providerOff = new TelemetryLlmProvider(rawProvider, telemetryOff);

    const resultOff = await service.run({
      sessionId: sessionOff.id,
      message: "Fix multiply bug in calculator.ts",
      provider: providerOff,
      providerTelemetry: telemetryOff,
      projectMap: mockProjectMap,
      thinkFirst: false
    });

    // Off reaches APPLY stage
    assert.equal(resultOff.status, "needs_approval");
    assert.equal(resultOff.lifecycleStage, "APPLY");
    const patchOff = resultOff.patchProposals[0];
    assert.ok(patchOff);

    // Off applies patch via runtime
    await runtime.reportPatchApplyResult(sessionOff.id, patchOff.id, { status: "applied", message: "Applied" });
    const postApplyOff = sessionManager.getSession(sessionOff.id)!;
    assert.equal(postApplyOff.lifecycleStage, "POST_VERIFY");
    const valReqOff = postApplyOff.commandRequests.find((c) => c.provenance?.approvalId === patchOff.id);
    assert.ok(valReqOff);

    // Off executes validation -> reaches completed/DONE
    const finalOff = await runtime.reportCommandResult(sessionOff.id, valReqOff.id, {
      command: "npm test",
      cwd: workspaceDir,
      risk: "safe",
      exitCode: 0,
      stdout: "4 passed",
      stderr: "",
      status: "executed"
    });
    assert.equal(finalOff.status, "completed");
    assert.equal(finalOff.lifecycleStage, "DONE");

    // --- PIPELINE 2: Plan Mode ON ---
    const sessionOn = await sessionManager.createSession({
      workspacePath: workspaceDir,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      accessProfile: "full_access",
      thinkFirst: true,
      userPrompt: "Fix multiply bug in calculator.ts"
    });

    const telemetryOn = createTelemetry(sessionOn);
    const providerOn = new TelemetryLlmProvider(rawProvider, telemetryOn);

    // Plan turn: reaches PLAN / confirm_plan
    const planResult = await service.run({
      sessionId: sessionOn.id,
      message: "Fix multiply bug in calculator.ts",
      provider: providerOn,
      providerTelemetry: telemetryOn,
      projectMap: mockProjectMap,
      thinkFirst: true
    });
    assert.equal(planResult.status, "needs_approval");
    assert.equal(planResult.lifecycleStage, "PLAN");
    assert.equal(planResult.nextAction?.kind, "confirm_plan");

    // Implement plan confirmed
    const confirmAction = await pendingActionService.handle(planResult, "Proceed with implementation.");
    assert.equal(confirmAction.matched, true);

    // Resumption turn: converges to the EXACT SAME stage as Plan OFF (APPLY)
    const resumedResult = await service.run({
      sessionId: sessionOn.id,
      message: confirmAction.resumePrompt ?? "Fix multiply bug in calculator.ts",
      provider: providerOn,
      providerTelemetry: telemetryOn,
      projectMap: mockProjectMap,
      thinkFirst: false
    });
    assert.equal(resumedResult.status, "needs_approval");
    assert.equal(resumedResult.lifecycleStage, "APPLY");
    const patchOn = resumedResult.patchProposals[0];
    assert.ok(patchOn);

    // Resumed applies patch via SAME runtime endpoint
    await runtime.reportPatchApplyResult(sessionOn.id, patchOn.id, { status: "applied", message: "Applied" });
    const postApplyOn = sessionManager.getSession(sessionOn.id)!;
    assert.equal(postApplyOn.lifecycleStage, "POST_VERIFY");
    const valReqOn = postApplyOn.commandRequests.find((c) => c.provenance?.approvalId === patchOn.id);
    assert.ok(valReqOn);

    // Resumed executes validation via SAME runtime endpoint -> reaches completed/DONE
    const finalOn = await runtime.reportCommandResult(sessionOn.id, valReqOn.id, {
      command: "npm test",
      cwd: workspaceDir,
      risk: "safe",
      exitCode: 0,
      stdout: "4 passed",
      stderr: "",
      status: "executed"
    });
    assert.equal(finalOn.status, "completed");
    assert.equal(finalOn.lifecycleStage, "DONE");
  } finally {
    cleanupTestWorkspace(workspaceDir);
  }
});

test("Requirement H.11: applied patch + verification passed + post-apply validation exitCode 0 + reconciliation unavailable -> completed / DONE", async () => {
  const { workspaceDir, storageDir } = createTestWorkspace();
  try {
    const eventBus = new EventBus();
    const sessionManager = new SessionManager(storageDir, eventBus);
    await sessionManager.load();
    const outcomeService = new RuntimeSessionOutcomeService(sessionManager);

    const session = await sessionManager.createSession({
      workspacePath: workspaceDir,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      userPrompt: "Fix multiply bug in calculator.ts"
    });

    await sessionManager.addPatchProposal(session.id, {
      id: "patch_h11",
      sessionId: session.id,
      title: "Fix multiply bug",
      summary: "Change + to *",
      riskLevel: "low",
      filesChanged: [{ path: "src/calculator.ts", changeType: "modify", explanation: "Fix bug" }],
      unifiedDiff: "--- a/src/calculator.ts\n+++ b/src/calculator.ts\n@@ -5,3 +5,3 @@\n export function multiply(a: number, b: number): number {\n-  return a + b;\n+  return a * b;\n }\n",
      requiresApproval: false,
      status: "applied",
      createdAt: new Date().toISOString()
    });

    await sessionManager.addCommandRequest(session.id, {
      id: "valcmd_h11",
      sessionId: session.id,
      command: "npm test",
      cwd: workspaceDir,
      risk: "safe",
      reason: "Post-apply validation for patch patch_h11",
      provenance: { source: "agent", trigger: "manual", reason: "Post-apply validation", approvalId: "patch_h11" },
      status: "executed",
      createdAt: new Date().toISOString()
    });

    await sessionManager.addCommandExecution(session.id, {
      id: "exec_val_h11",
      sessionId: session.id,
      requestId: "valcmd_h11",
      autoRun: false,
      command: "npm test",
      cwd: workspaceDir,
      risk: "safe",
      status: "executed",
      exitCode: 0,
      stdout: "4 passed",
      stderr: "",
      createdAt: new Date().toISOString()
    });

    await sessionManager.updateSession(session.id, (draft) => {
      draft.reconciliationReport = {
        status: "unavailable",
        patchId: "patch_h11",
        sourceDiffId: "patch_h11",
        checkedAt: new Date().toISOString(),
        checkedBy: "rust",
        evidenceSource: "unavailable",
        confidence: "unknown",
        reason: "Workspace is not a git repository.",
        retryable: true,
        matchedFiles: [],
        missingFiles: [],
        extraFiles: [],
        changedFilesWithDifferentStats: [],
        sharedOrAmbiguousFiles: [],
        dirtyBeforeApply: false,
        dirtyAfterApply: false,
        unknowns: ["Git diff or status could not be read after apply."]
      };
    });

    await outcomeService.sync(session.id);
    const updated = sessionManager.getSession(session.id)!;
    assert.equal(updated.status, "completed", "Must be completed when validation passed even if reconciliation is unavailable");
    assert.equal(updated.lifecycleStage, "DONE", "Must be DONE when validation passed even if reconciliation is unavailable");
  } finally {
    cleanupTestWorkspace(workspaceDir);
  }
});

test("Requirement H.12: reconciliation unavailable + verification not passed -> NOT completed", async () => {
  const { workspaceDir, storageDir } = createTestWorkspace();
  try {
    const eventBus = new EventBus();
    const sessionManager = new SessionManager(storageDir, eventBus);
    await sessionManager.load();
    const outcomeService = new RuntimeSessionOutcomeService(sessionManager);

    const session = await sessionManager.createSession({
      workspacePath: workspaceDir,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      userPrompt: "Fix multiply bug in calculator.ts"
    });

    await sessionManager.addPatchProposal(session.id, {
      id: "patch_h12",
      sessionId: session.id,
      title: "Fix multiply bug",
      summary: "Change + to *",
      riskLevel: "low",
      filesChanged: [{ path: "src/calculator.ts", changeType: "modify", explanation: "Fix bug" }],
      unifiedDiff: "--- a/src/calculator.ts\n+++ b/src/calculator.ts\n@@ -5,3 +5,3 @@\n export function multiply(a: number, b: number): number {\n-  return a + b;\n+  return a * b;\n }\n",
      requiresApproval: false,
      status: "applied",
      createdAt: new Date().toISOString()
    });

    // Post-apply validation is still pending (requested, not yet executed)
    await sessionManager.addCommandRequest(session.id, {
      id: "valcmd_h12",
      sessionId: session.id,
      command: "npm test",
      cwd: workspaceDir,
      risk: "safe",
      reason: "Post-apply validation for patch patch_h12",
      provenance: { source: "agent", trigger: "manual", reason: "Post-apply validation", approvalId: "patch_h12" },
      status: "requested",
      createdAt: new Date().toISOString()
    });

    await sessionManager.updateSession(session.id, (draft) => {
      draft.reconciliationReport = {
        status: "unavailable",
        patchId: "patch_h12",
        sourceDiffId: "patch_h12",
        checkedAt: new Date().toISOString(),
        checkedBy: "rust",
        evidenceSource: "unavailable",
        confidence: "unknown",
        reason: "Workspace is not a git repository.",
        retryable: true,
        matchedFiles: [],
        missingFiles: [],
        extraFiles: [],
        changedFilesWithDifferentStats: [],
        sharedOrAmbiguousFiles: [],
        dirtyBeforeApply: false,
        dirtyAfterApply: false,
        unknowns: []
      };
    });

    await outcomeService.sync(session.id);
    const updated = sessionManager.getSession(session.id)!;
    assert.notEqual(updated.status, "completed", "Must NOT be completed when verification has not passed");
    assert.notEqual(updated.lifecycleStage, "DONE", "Must NOT be DONE when verification has not passed");
    assert.equal(updated.status, "needs_approval");
    assert.equal(updated.lifecycleStage, "POST_VERIFY");
  } finally {
    cleanupTestWorkspace(workspaceDir);
  }
});

test("Requirement H.13: reconciliation failed/conflicted -> NOT completed", async () => {
  const { workspaceDir, storageDir } = createTestWorkspace();
  try {
    const eventBus = new EventBus();
    const sessionManager = new SessionManager(storageDir, eventBus);
    await sessionManager.load();
    const outcomeService = new RuntimeSessionOutcomeService(sessionManager);

    const session = await sessionManager.createSession({
      workspacePath: workspaceDir,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      userPrompt: "Fix multiply bug in calculator.ts"
    });

    await sessionManager.addPatchProposal(session.id, {
      id: "patch_h13",
      sessionId: session.id,
      title: "Fix multiply bug",
      summary: "Change + to *",
      riskLevel: "low",
      filesChanged: [{ path: "src/calculator.ts", changeType: "modify", explanation: "Fix bug" }],
      unifiedDiff: "--- a/src/calculator.ts\n+++ b/src/calculator.ts\n@@ -5,3 +5,3 @@\n export function multiply(a: number, b: number): number {\n-  return a + b;\n+  return a * b;\n }\n",
      requiresApproval: false,
      status: "applied",
      createdAt: new Date().toISOString()
    });

    await sessionManager.addCommandRequest(session.id, {
      id: "valcmd_h13",
      sessionId: session.id,
      command: "npm test",
      cwd: workspaceDir,
      risk: "safe",
      reason: "Post-apply validation for patch patch_h13",
      status: "executed",
      createdAt: new Date().toISOString()
    });

    await sessionManager.addCommandExecution(session.id, {
      id: "exec_val_h13",
      sessionId: session.id,
      requestId: "valcmd_h13",
      autoRun: false,
      command: "npm test",
      cwd: workspaceDir,
      risk: "safe",
      status: "executed",
      exitCode: 0,
      stdout: "4 passed",
      stderr: "",
      createdAt: new Date().toISOString()
    });

    await sessionManager.updateSession(session.id, (draft) => {
      draft.reconciliationReport = {
        status: "diverged",
        patchId: "patch_h13",
        sourceDiffId: "patch_h13",
        checkedAt: new Date().toISOString(),
        checkedBy: "rust",
        evidenceSource: "rust_git_snapshot",
        confidence: "high",
        reason: "Changes on disk diverged from patch.",
        retryable: false,
        matchedFiles: [],
        missingFiles: [],
        extraFiles: [],
        changedFilesWithDifferentStats: [],
        sharedOrAmbiguousFiles: [],
        dirtyBeforeApply: false,
        dirtyAfterApply: false,
        unknowns: []
      };
    });

    await outcomeService.sync(session.id);
    const updated = sessionManager.getSession(session.id)!;
    assert.notEqual(updated.status, "completed", "Must NOT be completed when reconciliation diverged");
    assert.equal(updated.status, "failed");
    assert.equal(updated.lifecycleStage, "FAILED");
  } finally {
    cleanupTestWorkspace(workspaceDir);
  }
});

test("Requirement H.14: post-apply validation failure -> NOT completed", async () => {
  const { workspaceDir, storageDir } = createTestWorkspace();
  try {
    const eventBus = new EventBus();
    const sessionManager = new SessionManager(storageDir, eventBus);
    await sessionManager.load();
    const outcomeService = new RuntimeSessionOutcomeService(sessionManager);

    const session = await sessionManager.createSession({
      workspacePath: workspaceDir,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      userPrompt: "Fix multiply bug in calculator.ts"
    });

    await sessionManager.addPatchProposal(session.id, {
      id: "patch_h14",
      sessionId: session.id,
      title: "Fix multiply bug",
      summary: "Change + to *",
      riskLevel: "low",
      filesChanged: [{ path: "src/calculator.ts", changeType: "modify", explanation: "Fix bug" }],
      unifiedDiff: "--- a/src/calculator.ts\n+++ b/src/calculator.ts\n@@ -5,3 +5,3 @@\n export function multiply(a: number, b: number): number {\n-  return a + b;\n+  return a * b;\n }\n",
      requiresApproval: false,
      status: "applied",
      createdAt: new Date().toISOString()
    });

    await sessionManager.addCommandRequest(session.id, {
      id: "valcmd_h14",
      sessionId: session.id,
      command: "npm test",
      cwd: workspaceDir,
      risk: "safe",
      reason: "Post-apply validation for patch patch_h14",
      status: "failed",
      createdAt: new Date().toISOString()
    });

    await sessionManager.addCommandExecution(session.id, {
      id: "exec_val_h14",
      sessionId: session.id,
      requestId: "valcmd_h14",
      autoRun: false,
      command: "npm test",
      cwd: workspaceDir,
      risk: "safe",
      status: "failed",
      exitCode: 1,
      stdout: "1 failed",
      stderr: "AssertionError",
      createdAt: new Date().toISOString()
    });

    await outcomeService.sync(session.id);
    const updated = sessionManager.getSession(session.id)!;
    assert.notEqual(updated.status, "completed", "Must NOT be completed when post-apply validation fails");
    assert.equal(updated.status, "failed");
    assert.equal(updated.lifecycleStage, "FAILED");
  } finally {
    cleanupTestWorkspace(workspaceDir);
  }
});

test("Requirement H.15: no applied patch -> NOT completed", async () => {
  const { workspaceDir, storageDir } = createTestWorkspace();
  try {
    const eventBus = new EventBus();
    const sessionManager = new SessionManager(storageDir, eventBus);
    await sessionManager.load();
    const outcomeService = new RuntimeSessionOutcomeService(sessionManager);

    const session = await sessionManager.createSession({
      workspacePath: workspaceDir,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      userPrompt: "Fix multiply bug in calculator.ts"
    });

    await sessionManager.addPatchProposal(session.id, {
      id: "patch_h15",
      sessionId: session.id,
      title: "Fix multiply bug",
      summary: "Change + to *",
      riskLevel: "low",
      filesChanged: [{ path: "src/calculator.ts", changeType: "modify", explanation: "Fix bug" }],
      unifiedDiff: "--- a/src/calculator.ts\n+++ b/src/calculator.ts\n@@ -5,3 +5,3 @@\n export function multiply(a: number, b: number): number {\n-  return a + b;\n+  return a * b;\n }\n",
      requiresApproval: true,
      status: "proposed",
      createdAt: new Date().toISOString()
    });

    await outcomeService.sync(session.id);
    const updated = sessionManager.getSession(session.id)!;
    assert.notEqual(updated.status, "completed", "Must NOT be completed without applied patch");
    assert.equal(updated.status, "needs_approval");
    assert.equal(updated.lifecycleStage, "APPROVAL");
  } finally {
    cleanupTestWorkspace(workspaceDir);
  }
});
