import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import type { ProjectMap, SanitizedProviderConfig } from "@hivo/protocol";
import { EventBus } from "../runtime/EventBus.js";
import { SessionManager } from "../runtime/SessionManager.js";
import { RuntimeDirectTurnService } from "../runtime/RuntimeDirectTurnService.js";
import { RuntimeRecursiveSwarmService } from "../runtime/RuntimeRecursiveSwarmService.js";
import { RecursiveSwarmOrchestrator } from "../orchestration/RecursiveSwarmOrchestrator.js";
import { HierarchicalCollector } from "../orchestration/HierarchicalCollector.js";
import {
  createGoalEnvelope,
  RECURSIVE_SWARM_SCHEMA_VERSION,
  type RecursiveSwarmNode,
  type GeneratedArtifact
} from "../orchestration/RecursiveSwarmModels.js";
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
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "hivo-source-evidence-test-"));
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

test("HierarchicalCollector propagates artifact contents in childResults and mergedFindings", async () => {
  const collector = new HierarchicalCollector();
  const artifact: GeneratedArtifact = {
    kind: "generated_artifact",
    path: "sourceLocation.txt",
    content: "src/calculator.ts:7-9",
    artifact_type: "text",
    description: "Location of the multiply bug",
    validation_steps: ["npm test"],
    completeness_notes: ["Identified buggy multiply line"],
    confidence: 0.95
  };

  const childNode: RecursiveSwarmNode = {
    schema_version: RECURSIVE_SWARM_SCHEMA_VERSION,
    id: "child-diag-1",
    parentId: "root",
    runId: "run-1",
    kind: "task_agent",
    status: "succeeded",
    name: "Diagnostic Child",
    role: "Investigator",
    goalEnvelope: createGoalEnvelope({ originalGoal: "Fix calculator", localTask: "Locate bug", workspaceIdentity: "test-workspace" }),
    taskPrompt: "Locate bug",
    depth: 1,
    goalChecks: [],
    steeringQueue: [],
    children: [],
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    structuredOutput: artifact,
    outputSummary: "Created artifact: sourceLocation.txt"
  };

  const result = await collector.collect([childNode], "Fix calculator");
  assert.ok(result.childResults["child-diag-1"].includes("src/calculator.ts:7-9"),
    "childResults must contain actual artifact content");
  
  const parsedTrace = JSON.parse(result.mergedOutput);
  const findings: string[] = parsedTrace.integrationSummary.merged_findings;
  assert.ok(
    findings.some((f) => f.includes("sourceLocation.txt") && f.includes("src/calculator.ts:7-9")),
    "merged_findings must contain artifact path and content"
  );
});

test("RecursiveSwarmOrchestrator resolves placeholder sourcePath dynamically from prerequisite artifact without ENOENT", async () => {
  const { workspaceDir } = createTestWorkspace();
  try {
    let capturedImplementationPrompt = "";

    const rawProvider: LlmProvider = {
      async generateStructured<T>(req: LlmRequest, schema: unknown): Promise<T> {
        const schemaName = schema && typeof schema === "object" && "name" in schema
          ? String((schema as { name: unknown }).name)
          : "";

        if (schemaName === "atomicity_assessment") {
          const isRoot = req.userPrompt.includes("DEPTH: 0");
          if (isRoot) {
            return { isAtomic: false, score: 7, rationale: "Needs decomposition", failures: ["composite"] } as T;
          }
          return { isAtomic: true, score: 2, rationale: "Atomic leaf task", failures: [] } as T;
        }

        if (schemaName === "expanded_goal_spec") {
          return {
            isAlreadyDetailed: true,
            expandedGoal: req.userPrompt,
            requirements: ["Fix multiply"],
            acceptanceCriteria: ["Tests pass"],
            deliverableContract: "Propose verified patch",
            constraints: [],
            nonGoals: [],
            qualityBar: ["Complete"]
          } as T;
        }

        if (schemaName === "split_result") {
          return {
            shouldSplit: true,
            desiredChildCount: 2,
            splitReason: "Separate diagnostic from implementation",
            subTasks: [
              {
                id: "1",
                title: "Diagnose failing test and locate source",
                taskPrompt: "Run tests and save the file and line range to sourceLocation.txt",
                expectedOutput: "sourceLocation.txt",
                dependencies: [],
                responsibility: "INSPECT",
                canWrite: false
              },
              {
                id: "2",
                title: "Fix multiply bug in source code",
                taskPrompt: "Fix multiply to return a * b",
                expectedOutput: "code_patch.diff",
                dependencies: ["1"],
                sourceEvidenceRequirement: {
                  prerequisiteSubtaskId: "1",
                  sourcePath: "<to be filled by runtime using sourceLocation.txt>",
                  evidenceType: "verified_workspace_source"
                },
                responsibility: "IMPLEMENT",
                canWrite: true
              }
            ],
            stopConditions: [],
            rationale: "Diagnostic then implementation"
          } as T;
        }

        if (schemaName === "structured_node_output") {
          if (req.userPrompt.includes("CHILD TASK:\nFix multiply to return a * b") || req.userPrompt.includes("EXPECTED OUTPUT:\ncode_patch.diff")) {
            capturedImplementationPrompt = req.userPrompt;
            return {
              kind: "edit_intent",
              operation: "modify",
              target_file: "src/calculator.ts",
              replacement_chunk: {
                start_line: 5,
                end_line: 7,
                original_text: "export function multiply(a: number, b: number): number {\n  return a + b;\n}",
                replacement_text: "export function multiply(a: number, b: number): number {\n  return a * b;\n}"
              },
              reason: "Fix multiply implementation",
              risk: "low",
              confidence: 0.95
            } as T;
          }

          if (req.userPrompt.includes("CHILD TASK:\nRun tests") || req.userPrompt.includes("EXPECTED OUTPUT:\nsourceLocation.txt")) {
            return {
              kind: "generated_artifact",
              path: "sourceLocation.txt",
              content: "src/calculator.ts:5-7",
              artifact_type: "text",
              description: "Location of multiply bug",
              validation_steps: ["npm test"],
              completeness_notes: ["Identified buggy function"],
              confidence: 0.95
            } as T;
          }
        }

        return {} as T;
      },
      async generateText(): Promise<string> {
        return "Merged results: bug located in src/calculator.ts and fixed";
      }
    };

    const orchestrator = new RecursiveSwarmOrchestrator({
      provider: rawProvider,
      workspacePath: workspaceDir,
      options: {
        maxDepth: 2,
        maxAgents: 20,
        enableGoalKeeper: false,
        enableParallelExecution: false,
        enableErrorRecovery: false
      }
    });

    const runResult = await orchestrator.run("Fix the multiply function in calculator");

    // Check captured prompt for dependent child
    assert.ok(
      capturedImplementationPrompt.includes("=== Independently Verified Workspace Source ===") &&
      capturedImplementationPrompt.includes("Source: src/calculator.ts"),
      "Dependent worker must receive verified workspace source evidence for resolved path"
    );
    assert.ok(
      capturedImplementationPrompt.includes("=== Dependency Deliverable: sourceLocation.txt"),
      "Dependent worker must receive upstream deliverable content"
    );
    assert.ok(
      capturedImplementationPrompt.includes("src/calculator.ts:5-7"),
      "Dependent worker prompt must include the artifact content"
    );

    // Verify all nodes succeeded without ENOENT
    const nodes = Object.values(runResult.runState.tree.nodes);
    const blockedNodes = nodes.filter((n) => n.status === "blocked");
    assert.equal(blockedNodes.length, 0, `No nodes should be blocked. Found: ${blockedNodes.map((n) => n.errorSummary).join(", ")}`);
    const failedNodes = nodes.filter((n) => n.status === "failed");
    assert.equal(failedNodes.length, 0, `No nodes should fail. Found: ${failedNodes.map((n) => n.errorSummary).join(", ")}`);
  } finally {
    cleanupTestWorkspace(workspaceDir);
  }
});

test("RecursiveSwarmOrchestrator safely blocks dependent worker when placeholder cannot be resolved without ENOENT", async () => {
  const { workspaceDir } = createTestWorkspace();
  try {
    const rawProvider: LlmProvider = {
      async generateStructured<T>(req: LlmRequest, schema: unknown): Promise<T> {
        const schemaName = schema && typeof schema === "object" && "name" in schema
          ? String((schema as { name: unknown }).name)
          : "";

        if (schemaName === "atomicity_assessment") {
          const isRoot = req.userPrompt.includes("DEPTH: 0");
          if (isRoot) {
            return { isAtomic: false, score: 7, rationale: "Needs decomposition", failures: ["composite"] } as T;
          }
          return { isAtomic: true, score: 2, rationale: "Atomic leaf task", failures: [] } as T;
        }

        if (schemaName === "expanded_goal_spec") {
          return {
            isAlreadyDetailed: true,
            expandedGoal: "Fix something",
            requirements: ["Fix"],
            acceptanceCriteria: ["Tests pass"],
            deliverableContract: "Propose patch",
            constraints: [],
            nonGoals: [],
            qualityBar: ["Complete"]
          } as T;
        }

        if (schemaName === "split_result") {
          return {
            shouldSplit: true,
            desiredChildCount: 2,
            splitReason: "Diagnostic then implementation",
            subTasks: [
              {
                id: "1",
                title: "Diagnostic with no valid file reference",
                taskPrompt: "Inspect errors",
                expectedOutput: "notes.txt",
                dependencies: [],
                responsibility: "INSPECT",
                canWrite: false
              },
              {
                id: "2",
                title: "Fix bug",
                taskPrompt: "Fix bug",
                expectedOutput: "code_patch.diff",
                dependencies: ["1"],
                sourceEvidenceRequirement: {
                  prerequisiteSubtaskId: "1",
                  sourcePath: "<to be filled by runtime using nonExistent.txt>",
                  evidenceType: "verified_workspace_source"
                },
                responsibility: "IMPLEMENT",
                canWrite: true
              }
            ],
            stopConditions: [],
            rationale: "Diagnostic then implementation"
          } as T;
        }

        if (schemaName === "structured_node_output") {
          return {
            kind: "generated_artifact",
            path: "notes.txt",
            content: "No source files were identified in this run",
            artifact_type: "text",
            description: "Diagnostic notes",
            validation_steps: [],
            completeness_notes: [],
            confidence: 0.95
          } as T;
        }

        return {} as T;
      },
      async generateText(): Promise<string> {
        return "Merged results";
      }
    };

    const orchestrator = new RecursiveSwarmOrchestrator({
      provider: rawProvider,
      workspacePath: workspaceDir,
      options: {
        maxDepth: 2,
        maxAgents: 20,
        enableGoalKeeper: false,
        enableParallelExecution: false,
        enableErrorRecovery: false
      }
    });

    const runResult = await orchestrator.run("Fix the multiply function in calculator");

    // The implementation child must be blocked safely with a descriptive reason, NOT throw ENOENT or crash
    const nodes = Object.values(runResult.runState.tree.nodes);
    const implNode = nodes.find((n) => n.name.includes("Fix bug"));
    assert.ok(implNode, "Implementation node must exist");
    assert.equal(implNode.status, "blocked", "Implementation node should be safely blocked");
    assert.ok(
      implNode.errorSummary?.includes("placeholder path") ||
      implNode.errorSummary?.includes("could not be resolved"),
      `Blocked summary must clearly state placeholder resolution failure. Found: ${implNode.errorSummary}`
    );
  } finally {
    cleanupTestWorkspace(workspaceDir);
  }
});

test("Full Runtime End-to-End: Diagnostic artifact dynamically grounds implementation worker and generates real patch proposal", async () => {
  const { workspaceDir, storageDir } = createTestWorkspace();
  const eventBus = new EventBus();
  const sessionManager = new SessionManager(storageDir, eventBus);
  await sessionManager.load();
  const directTurnService = new RuntimeDirectTurnService(sessionManager);
  const swarmService = new RuntimeRecursiveSwarmService(sessionManager, directTurnService);

  try {
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

    const rawProvider: LlmProvider = {
      async generateStructured<T>(req: LlmRequest, schema: unknown): Promise<T> {
        const schemaName = schema && typeof schema === "object" && "name" in schema
          ? String((schema as { name: unknown }).name)
          : "";

        if (schemaName === "atomicity_assessment") {
          const isRoot = req.userPrompt.includes("DEPTH: 0");
          if (isRoot) {
            return { isAtomic: false, score: 8, rationale: "Decompose into diagnostic and fix", failures: ["composite"] } as T;
          }
          return { isAtomic: true, score: 2, rationale: "Atomic leaf task", failures: [] } as T;
        }

        if (schemaName === "expanded_goal_spec") {
          return {
            isAlreadyDetailed: true,
            expandedGoal: req.userPrompt,
            requirements: ["Fix multiply"],
            acceptanceCriteria: ["Tests pass"],
            deliverableContract: "Patch proposal",
            constraints: [],
            nonGoals: [],
            qualityBar: ["Complete"]
          } as T;
        }

        if (schemaName === "goal_keeper_alignment") {
          return { aligned: true, confidence: 0.95, rationale: "Goal aligned." } as T;
        }

        if (schemaName === "split_result") {
          return {
            shouldSplit: true,
            desiredChildCount: 2,
            splitReason: "Diagnostic then implementation",
            subTasks: [
              {
                id: "1",
                title: "Run tests and record source location",
                taskPrompt: "Execute tests and save error location to sourceLocation.txt",
                expectedOutput: "sourceLocation.txt",
                dependencies: [],
                responsibility: "INSPECT",
                canWrite: false
              },
              {
                id: "2",
                title: "Apply code fix to multiply",
                taskPrompt: "Fix multiply to return a * b",
                expectedOutput: "code_patch.diff",
                dependencies: ["1"],
                sourceEvidenceRequirement: {
                  prerequisiteSubtaskId: "1",
                  sourcePath: "<to be filled by runtime using sourceLocation.txt>",
                  evidenceType: "verified_workspace_source"
                },
                responsibility: "IMPLEMENT",
                canWrite: true
              }
            ],
            stopConditions: [],
            rationale: "Diagnostic then implementation"
          } as T;
        }

        if (schemaName === "structured_node_output") {
          if (req.userPrompt.includes("CHILD TASK:\nFix multiply to return a * b") || req.userPrompt.includes("EXPECTED OUTPUT:\ncode_patch.diff")) {
            return {
              kind: "edit_intent",
              operation: "modify",
              target_file: "src/calculator.ts",
              exact_old_text: "export function multiply(a: number, b: number): number {\n  return a + b;\n}",
              replacement_text: "export function multiply(a: number, b: number): number {\n  return a * b;\n}",
              reason: "Fix multiply logic",
              risk: "low",
              confidence: 0.95
            } as T;
          }

          if (req.userPrompt.includes("CHILD TASK:\nExecute tests") || req.userPrompt.includes("EXPECTED OUTPUT:\nsourceLocation.txt")) {
            return {
              kind: "generated_artifact",
              path: "sourceLocation.txt",
              content: "src/calculator.ts:5-7",
              artifact_type: "text",
              description: "Location of multiply bug",
              validation_steps: ["npm test"],
              completeness_notes: ["Located buggy function"],
              confidence: 0.95
            } as T;
          }
        }

        return {} as T;
      },
      async generateText(): Promise<string> {
        return "Merged diagnostic and implementation results successfully.";
      }
    };

    const telemetry = new ProviderTelemetryRecorder({
      mode: session.mode,
      providerConfig: session.providerConfig ?? validProviderConfig
    });
    const provider = new TelemetryLlmProvider(rawProvider, telemetry);

    const result = await swarmService.run({
      sessionId: session.id,
      message: "Fix the failing test in calculator by updating multiply() to return a * b instead of a + b",
      provider,
      providerTelemetry: telemetry,
      projectMap: mockProjectMap,
      thinkFirst: false
    });

    const updatedSession = await sessionManager.getSession(session.id);
    assert.ok(updatedSession);

    // Verify session reached APPROVAL stage with 1 PatchProposal
    assert.equal(updatedSession.status, "needs_approval", "Session must transition to needs_approval");
    assert.equal(updatedSession.lifecycleStage, "APPROVAL", "Session must be in APPROVAL stage");
    assert.equal(result.patchProposals?.length, 1, "Exactly one patch proposal must be generated");
    assert.equal(result.patchProposals[0].filesChanged[0].path, "src/calculator.ts");
    assert.ok(result.patchProposals[0].unifiedDiff.includes("+  return a * b;"));

    // Verify source file on disk was NOT mutated prior to human approval
    const fileOnDisk = fs.readFileSync(path.join(workspaceDir, "src", "calculator.ts"), "utf8");
    assert.equal(fileOnDisk, BUGGY_CALCULATOR_FILE, "Workspace file must not be modified before manual approval");
  } finally {
    cleanupTestWorkspace(workspaceDir);
  }
});
