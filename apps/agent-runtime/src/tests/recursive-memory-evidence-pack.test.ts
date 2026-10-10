import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  AgentRuntimeSession,
  CommandExecutionRecord,
  ProjectIntake,
  ProjectMap
} from "@hivo/protocol";
import { EventBus } from "../runtime/EventBus.js";
import { SessionManager } from "../runtime/SessionManager.js";
import {
  buildMemoryEvidencePack,
  findCorrelatedBaselineExecution
} from "../runtime/RuntimeRecursiveSwarmService.js";
import { RecursiveSwarmOrchestrator } from "../orchestration/RecursiveSwarmOrchestrator.js";

const CALCULATOR_SOURCE = `export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}

export function multiply(a: number, b: number): number {
  return a + b;
}

export function divide(a: number, b: number): number {
  if (b === 0) throw new Error("Divide by zero");
  return a / b;
}
`;

const CALCULATOR_TEST = `import { add, subtract, multiply, divide } from "../src/calculator.js";

// multiply expected 12, actual 7
`;

test("1. actual source content is present in MemoryEvidencePack", async () => {
  const fixture = await createCalculatorFixture();
  try {
    const pack = buildMemoryEvidencePack(
      "Fix failing multiply in src/calculator.ts",
      "node_test_1",
      fixture.session,
      fixture.projectMap
    );

    assert.ok(pack.source_snippets && pack.source_snippets.length > 0, "source_snippets should not be empty");
    const calcSnippet = pack.source_snippets.find((s) => s.path === "src/calculator.ts");
    assert.ok(calcSnippet, "src/calculator.ts snippet must be present");
    assert.ok(calcSnippet.content.includes("export function multiply(a: number, b: number): number"), "source content must contain multiply definition");
    assert.ok(calcSnippet.content.includes("return a + b;"), "source content must contain real implementation");
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("Chart.js worker receives a bounded excerpt of its named bar-element source", async () => {
  const fixture = await createCalculatorFixture();
  const targetPath = "src/elements/element.bar.js";
  const targetContent = `import Element from '../core/core.element';
import {addRoundedRectPath} from '../helpers/helpers.canvas';

function parseBorderRadius(bar, maxW, maxH) {
  const {enableBorderRadius} = bar.getProps(['enableBorderRadius']);
  const value = bar.options.borderRadius;
  const maxR = Math.min(maxW, maxH);
  return maxR;
}

export default class BarElement extends Element {
  draw(ctx) {
    const {inner, outer} = boundingRects(this);
    addRoundedRectPath(ctx, outer);
  }
}
`.padEnd(2400, " ");
  try {
    await mkdir(path.join(fixture.workspace, "src", "elements"), { recursive: true });
    await mkdir(path.join(fixture.workspace, "src", "controllers"), { recursive: true });
    await writeFile(path.join(fixture.workspace, targetPath), targetContent, "utf8");
    await writeFile(path.join(fixture.workspace, "src", "elements", "index.js"), "export {default as BarElement} from './element.bar';\n", "utf8");
    await writeFile(path.join(fixture.workspace, "src", "controllers", "index.js"), "export {default as BarController} from './controller.bar';\n", "utf8");

    const indexCandidates = ["src/elements/index.js", "src/controllers/index.js"];
    fixture.session.projectIntake!.importantFiles = indexCandidates;
    fixture.session.projectIntake!.knownEntryPoints = indexCandidates;
    fixture.session.projectIntake!.contextPack!.relevantFiles = indexCandidates;
    fixture.session.projectIntake!.contextPack!.relatedTests = [];
    fixture.session.projectIntake!.contextPack!.safeToEdit = indexCandidates;
    fixture.session.projectIntake!.contextPack!.confirmedRelevantFiles = indexCandidates;
    fixture.projectMap.importantFiles = indexCandidates;
    fixture.projectMap.entryPoints = indexCandidates;

    const pack = buildMemoryEvidencePack(
      "Implement the minimal fix in src/elements/element.bar.js for zero-value bars with minBarLength and borderRadius.",
      "node_chartjs_bar_source",
      fixture.session,
      fixture.projectMap
    );

    const targetSnippet = pack.source_snippets?.find((snippet) => snippet.path === targetPath);
    assert.ok(targetSnippet, `${targetPath} source excerpt must be included in the worker evidence pack`);
    assert.ok(targetSnippet.content.includes("function parseBorderRadius(bar, maxW, maxH)"), "the excerpt must contain actual target-file source");
    assert.equal(targetSnippet.content, targetContent.slice(0, 2000), "the target source must be bounded to the configured snippet size");
    assert.ok(pack.evidence_refs.includes(`file:${targetPath}#1-${targetSnippet.end_line}`), "the target excerpt must have a source evidence reference");
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("content-aware source discovery ranks bar implementation over generic index fallbacks", async () => {
  const fixture = await createCalculatorFixture();
  const targetPath = "src/elements/element.bar.js";
  const targetContent = `export default class BarElement {
  updateZeroBarLength(minBarLength) {
    return Math.max(this.height, minBarLength);
  }

  draw(ctx) {
    const borderRadius = this.options.borderRadius;
    ctx.roundRect(this.x, this.y, this.width, this.height, borderRadius);
  }
}
`;
  try {
    await mkdir(path.join(fixture.workspace, "src", "elements"), { recursive: true });
    await mkdir(path.join(fixture.workspace, "src", "controllers"), { recursive: true });
    await writeFile(path.join(fixture.workspace, targetPath), targetContent, "utf8");
    await writeFile(path.join(fixture.workspace, "src", "elements", "index.js"), "export {default as BarElement} from './element.bar';\n", "utf8");
    await writeFile(path.join(fixture.workspace, "src", "controllers", "index.js"), "export {default as BarController} from './controller.bar';\n", "utf8");

    const indexCandidates = ["src/elements/index.js", "src/controllers/index.js"];
    fixture.session.projectIntake!.importantFiles = indexCandidates;
    fixture.session.projectIntake!.knownEntryPoints = indexCandidates;
    fixture.session.projectIntake!.contextPack!.relevantFiles = indexCandidates;
    fixture.session.projectIntake!.contextPack!.relatedTests = [];
    fixture.session.projectIntake!.contextPack!.safeToEdit = indexCandidates;
    fixture.session.projectIntake!.contextPack!.confirmedRelevantFiles = indexCandidates;
    fixture.projectMap.importantFiles = indexCandidates;
    fixture.projectMap.entryPoints = indexCandidates;

    const pack = buildMemoryEvidencePack(
      "Fix zero-value bars so minBarLength and borderRadius are handled correctly.",
      "node_chartjs_content_discovery",
      fixture.session,
      fixture.projectMap
    );

    const targetSnippet = pack.source_snippets?.find((snippet) => snippet.path === targetPath);
    assert.ok(targetSnippet, `${targetPath} should be discovered from matching source contents`);
    assert.ok(targetSnippet.content.includes("minBarLength"), "the excerpt should contain the task-relevant identifier");
    assert.ok(targetSnippet.content.includes("borderRadius"), "the excerpt should contain the second task-relevant identifier");
    assert.equal(targetSnippet.start_line, 1);
    assert.equal(pack.file_ranges[targetPath], `1-${targetSnippet.end_line}`);
    assert.ok(pack.evidence_refs.includes(`file:${targetPath}#1-${targetSnippet.end_line}`));
    assert.ok(pack.source_snippets!.findIndex((snippet) => snippet.path === targetPath) <
      pack.source_snippets!.findIndex((snippet) => snippet.path === "src/elements/index.js"),
    "the real implementation match should precede the generic index fallback");
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("2. actual line ranges correspond to the source snippet", async () => {
  const fixture = await createCalculatorFixture();
  try {
    const pack = buildMemoryEvidencePack(
      "Inspect src/calculator.ts",
      "node_test_2",
      fixture.session,
      fixture.projectMap
    );

    const calcSnippet = pack.source_snippets?.find((s) => s.path === "src/calculator.ts");
    assert.ok(calcSnippet);
    const expectedLineCount = calcSnippet.content.split(/\r?\n/).length;

    assert.equal(calcSnippet.start_line, 1);
    assert.equal(calcSnippet.end_line, expectedLineCount);
    assert.equal(pack.file_ranges["src/calculator.ts"], `1-${expectedLineCount}`);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("3. baseline npm test stdout/stderr and exitCode are present", async () => {
  const fixture = await createCalculatorFixture();
  try {
    const pack = buildMemoryEvidencePack(
      "Resolve test failure in src/calculator.ts",
      "node_test_3",
      fixture.session,
      fixture.projectMap
    );

    assert.ok(pack.baseline_command, "baseline_command must be attached");
    assert.equal(pack.baseline_command.command, "npm test");
    assert.equal(pack.baseline_command.exitCode, 1);
    assert.equal(pack.baseline_command.status, "failed");
    assert.ok(pack.baseline_command.stdout.includes("multiply expected 12, actual 7"), "stdout must contain real test failure");
    assert.ok(pack.evidence_refs.some((ref) => ref.includes("npm test")), "evidence_refs must include command ref");
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("4. unrelated command executions are excluded", async () => {
  const fixture = await createCalculatorFixture();
  try {
    // Add unrelated command executions
    const lintExecution: CommandExecutionRecord = {
      id: "exec_unrelated_lint",
      sessionId: fixture.session.id,
      requestId: "cmd_lint_req",
      autoRun: false,
      command: "npm run lint",
      cwd: fixture.workspace,
      risk: "safe",
      status: "executed",
      exitCode: 0,
      stdout: "lint passed without errors",
      stderr: "",
      provenance: { source: "agent", trigger: "manual", requestedBy: "agent", sessionId: fixture.session.id },
      createdAt: new Date().toISOString()
    };
    const gitExecution: CommandExecutionRecord = {
      id: "exec_unrelated_git",
      sessionId: fixture.session.id,
      requestId: "cmd_git_req",
      autoRun: false,
      command: "git status",
      cwd: fixture.workspace,
      risk: "safe",
      status: "executed",
      exitCode: 0,
      stdout: "working tree clean",
      stderr: "",
      provenance: { source: "agent", trigger: "manual", requestedBy: "agent", sessionId: fixture.session.id },
      createdAt: new Date().toISOString()
    };

    fixture.session.commandExecutions.push(lintExecution, gitExecution);

    const correlated = findCorrelatedBaselineExecution(fixture.session);
    assert.ok(correlated);
    assert.equal(correlated.command, "npm test");
    assert.notEqual(correlated.command, "npm run lint");
    assert.notEqual(correlated.command, "git status");

    const pack = buildMemoryEvidencePack(
      "Fix multiply bug",
      "node_test_4",
      fixture.session,
      fixture.projectMap
    );

    assert.equal(pack.baseline_command?.command, "npm test");
    assert.equal(pack.baseline_commands?.length, 1);
    assert.equal(pack.baseline_commands?.[0]?.command, "npm test");
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("5. no command is executed a second time during pack building", async () => {
  const fixture = await createCalculatorFixture();
  try {
    const executionCountBefore = fixture.session.commandExecutions.length;

    const pack = buildMemoryEvidencePack(
      "Fix multiply bug",
      "node_test_5",
      fixture.session,
      fixture.projectMap
    );

    assert.ok(pack);
    const executionCountAfter = fixture.session.commandExecutions.length;
    assert.equal(executionCountAfter, executionCountBefore, "no command execution records should be added during pack building");
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("6. child workers still have no filesystem/shell authority", async () => {
  const fixture = await createCalculatorFixture();
  try {
    let capturedReq: any;
    const mockProvider = {
      async generateStructured<T>(req: any, schema: any): Promise<T> {
        const name = schema?.name ?? "";
        if (name === "expanded_goal_spec") {
          return {
            isAlreadyDetailed: true,
            expandedGoal: req.userPrompt,
            requirements: ["Fix multiply test"],
            acceptanceCriteria: ["Multiply works"],
            deliverableContract: "Fix multiply",
            constraints: [],
            nonGoals: [],
            qualityBar: ["Complete"]
          } as T;
        }
        if (name === "atomicity_assessment") {
          return { isAtomic: true, score: 2, rationale: "Atomic fixture.", failures: [] } as T;
        }
        capturedReq = req;
        return {
          kind: "evidence_report",
          findings: ["Found multiply bug"],
          files: ["src/calculator.ts"],
          symbols: ["multiply"],
          evidence_refs: [],
          unknowns: [],
          confidence: 0.95
        } as T;
      },
      async generateText(): Promise<string> {
        return "Completed";
      }
    };

    const orchestrator = new RecursiveSwarmOrchestrator({
      provider: mockProvider as any,
      buildPack: (taskPrompt, nodeId) => buildMemoryEvidencePack(taskPrompt, nodeId, fixture.session, fixture.projectMap)
    });

    const result = await orchestrator.run(
      "Fix failing multiply test in src/calculator.ts",
      fixture.session.id
    );

    assert.ok(result);
    assert.ok(capturedReq, "provider request must be captured");

    // Children are invoked purely via semantic structured prompt without capability grants or tool calling authority
    assert.equal(capturedReq.tools, undefined, "child worker must not receive tool execution definitions");
    assert.equal(capturedReq.capabilityGrant, undefined, "child worker must have no capability grant");
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("7. path-only evidence no longer receives misleading strong grounding/confidence", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-path-only-${Date.now()}`);
  await mkdir(workspace, { recursive: true });

  try {
    const intake: ProjectIntake = {
      workspaceRoot: workspace,
      intakeStatus: "completed",
      projectKind: "existing_project",
      confidence: "high", // Intake itself had high confidence
      detectedSignals: [],
      moduleSummary: ["src/"],
      knownEntryPoints: [],
      knownCommands: ["npm test"],
      testCommands: ["npm test"],
      buildCommands: [],
      importantFiles: ["src/missing-file.ts"], // File does NOT exist on disk
      riskyFiles: [],
      doNotTouchCandidates: [],
      unknowns: [],
      warnings: [],
      guardrails: { summary: "Guardrails", rules: [] }
    };

    const emptySession = {
      id: "session_path_only",
      workspacePath: workspace,
      mode: "real_provider",
      executionMode: "auto_mode",
      userPrompt: "fix missing component",
      status: "running",
      lifecycleStage: "PLAN",
      accessProfile: "default_permissions",
      responseLanguage: "en",
      projectIntake: intake,
      commandRequests: [],
      commandExecutions: [], // NO command execution evidence
      patchProposals: [],
      messages: [],
      artifacts: [],
      reasoningSummaries: [],
      agentWorkStatuses: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    } as unknown as AgentRuntimeSession;

    const projectMap: ProjectMap = {
      stack: ["node"],
      packageManagers: ["npm"],
      entryPoints: [],
      importantFiles: ["src/missing-file.ts"],
      testCommands: ["npm test"]
    };

    const pack = buildMemoryEvidencePack("fix missing component", "node_path_only", emptySession, projectMap);

    // Must NOT claim high-confidence fresh memory_evidence
    assert.notEqual(pack.context_source, "memory_evidence", "path-only pack must not claim memory_evidence");
    assert.equal(pack.context_source, "partial_context", "path-only pack with file paths should be partial_context");
    assert.ok(pack.confidence <= 0.35, `confidence must be low (got ${pack.confidence}), not 0.9`);
    assert.notEqual(pack.freshness_status, "fresh", "path-only pack must not be marked fresh");
    assert.equal(pack.freshness_status, "unknown");
    assert.ok(pack.warnings.some((w) => w.includes("Only path-level metadata available")), "must include path-only warning");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("8. the final provider prompt for a recursive child contains calculator source and failing test evidence", async () => {
  const fixture = await createCalculatorFixture();
  try {
    let capturedChildPrompt = "";
    const mockProvider = {
      async generateStructured<T>(req: any, schema: any): Promise<T> {
        const name = schema?.name ?? "";
        if (name === "expanded_goal_spec") {
          return {
            isAlreadyDetailed: true,
            expandedGoal: req.userPrompt,
            requirements: ["Fix multiply bug in src/calculator.ts"],
            acceptanceCriteria: ["Multiply works"],
            deliverableContract: "Fix multiply",
            constraints: [],
            nonGoals: [],
            qualityBar: ["Complete"]
          } as T;
        }
        if (name === "atomicity_assessment") {
          return { isAtomic: true, score: 2, rationale: "Atomic fixture.", failures: [] } as T;
        }
        capturedChildPrompt = `${req.systemPrompt ?? ""}\n${req.userPrompt ?? ""}`;
        return {
          kind: "evidence_report",
          findings: ["Inspected empirical source and test failure"],
          files: ["src/calculator.ts"],
          symbols: ["multiply"],
          evidence_refs: [],
          unknowns: [],
          confidence: 0.95
        } as T;
      },
      async generateText(): Promise<string> {
        return "Completed";
      }
    };

    const orchestrator = new RecursiveSwarmOrchestrator({
      provider: mockProvider as any,
      buildPack: (taskPrompt, nodeId) => buildMemoryEvidencePack(taskPrompt, nodeId, fixture.session, fixture.projectMap)
    });

    await orchestrator.run(
      "Fix multiply bug in src/calculator.ts",
      fixture.session.id
    );

    assert.ok(capturedChildPrompt, "child prompt must be captured");

    // Must contain actual calculator source
    assert.ok(capturedChildPrompt.includes("=== Source Evidence ==="), "prompt must include Source Evidence header");
    assert.ok(capturedChildPrompt.includes("File: src/calculator.ts"), "prompt must identify src/calculator.ts");
    assert.ok(capturedChildPrompt.includes("export function multiply(a: number, b: number): number"), "prompt must contain multiply source");
    assert.ok(capturedChildPrompt.includes("return a + b;"), "prompt must show actual buggy code");

    // Must contain actual test failure evidence
    assert.ok(capturedChildPrompt.includes("=== Baseline Command Evidence ==="), "prompt must include Baseline Command Evidence header");
    assert.ok(capturedChildPrompt.includes("Command: npm test"), "prompt must identify command");
    assert.ok(capturedChildPrompt.includes("Exit code: 1"), "prompt must state exit code 1");
    assert.ok(capturedChildPrompt.includes("multiply expected 12, actual 7"), "prompt must include failing test output");

    // Must NOT hard-code conclusion for the model
    assert.ok(!capturedChildPrompt.includes("change + to *"), "prompt must provide empirical evidence rather than hard-coding conclusion");
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

async function createCalculatorFixture() {
  const workspace = path.join(os.tmpdir(), `hivo-calc-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await mkdir(path.join(workspace, "tests"), { recursive: true });

  await writeFile(path.join(workspace, "src", "calculator.ts"), CALCULATOR_SOURCE, "utf8");
  await writeFile(path.join(workspace, "tests", "calculator.test.ts"), CALCULATOR_TEST, "utf8");
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({ scripts: { test: "npm test" } }), "utf8");

  const manager = new SessionManager(path.join(workspace, ".runtime-test"), new EventBus(), {
    runtimeEventLoader: async () => []
  });
  await manager.load();

  const session = await manager.createSession({
    workspacePath: workspace,
    mode: "real_provider",
    executionMode: "auto_mode",
    userPrompt: "Fix multiply bug in src/calculator.ts"
  });

  const intake: ProjectIntake = {
    workspaceRoot: workspace,
    intakeStatus: "completed",
    projectKind: "existing_project",
    confidence: "high",
    detectedSignals: [],
    moduleSummary: ["src/", "tests/"],
    knownEntryPoints: ["src/calculator.ts"],
    knownCommands: ["npm test"],
    testCommands: ["npm test"],
    buildCommands: [],
    importantFiles: ["src/calculator.ts", "tests/calculator.test.ts"],
    riskyFiles: [],
    doNotTouchCandidates: [],
    unknowns: [],
    warnings: [],
    contextPack: {
      projectSummary: "Calculator fixture project",
      relevantFiles: ["src/calculator.ts"],
      relatedTests: ["tests/calculator.test.ts"],
      conventionsDiscovered: [],
      apisLikelyToPreserve: [],
      safeToEdit: ["src/calculator.ts"],
      cautionPaths: [],
      doNotTouchCandidates: [],
      acceptanceCriteriaDraft: [],
      verificationCommands: ["npm test"],
      knownRisks: [],
      unknowns: [],
      guardrails: { summary: "Guardrails", rules: [] }
    },
    guardrails: { summary: "Guardrails", rules: [] }
  };

  session.projectIntake = intake;

  const baselineExecution: CommandExecutionRecord = {
    id: "exec_baseline_npm_test",
    sessionId: session.id,
    requestId: "cmd_baseline_req_1",
    autoRun: false,
    command: "npm test",
    cwd: workspace,
    risk: "safe",
    status: "failed",
    exitCode: 1,
    stdout: "FAIL tests/calculator.test.ts\nmultiply expected 12, actual 7",
    stderr: "",
    provenance: {
      source: "agent",
      trigger: "manual",
      requestedBy: "agent",
      sessionId: session.id,
      requestId: "cmd_baseline_req_1"
    },
    createdAt: new Date().toISOString()
  };

  session.commandRequests = [{
    id: "cmd_baseline_req_1",
    sessionId: session.id,
    command: "npm test",
    cwd: workspace,
    risk: "safe",
    reason: "Baseline test command execution before recursive swarm planning.",
    status: "failed",
    createdAt: new Date().toISOString()
  }];

  session.commandExecutions = [baselineExecution];

  const projectMap: ProjectMap = {
    stack: ["node"],
    packageManagers: ["npm"],
    entryPoints: ["src/calculator.ts"],
    importantFiles: ["src/calculator.ts", "tests/calculator.test.ts"],
    testCommands: ["npm test"]
  };

  return { workspace, manager, session, projectMap };
}
