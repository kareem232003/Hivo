import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { PatchProposal } from "@hivo/protocol";
import type { LlmProvider, LlmRequest } from "../llm/LlmProvider.js";
import { OrchestrationArtifactStore } from "../orchestration/ArtifactStore.js";
import type { Task } from "../orchestration/OrchestrationModels.js";
import { ValidationRunner } from "../orchestration/ValidationRunner.js";
import type { CommandInventory } from "../memory/types.js";
import { runAdaptiveReasoningTurn } from "../runtime/ReasoningKernel.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "../../..", "..");
const tauriManifest = path.join(repositoryRoot, "apps", "desktop", "src-tauri", "Cargo.toml");
const runtimeBridgeArgs = [
  "run",
  "--quiet",
  "--manifest-path",
  tauriManifest,
  "--bin",
  "runtime_bridge_smoke",
  "--"
];

const originalSource = `function multiply(a, b) {
  return a + b;
}

module.exports = { multiply };
`;

const sourceReadPatch = `diff --git a/src/calculator.js b/src/calculator.js
index 1234567..89abcde 100644
--- a/src/calculator.js
+++ b/src/calculator.js
@@ -1,3 +1,3 @@
 function multiply(a, b) {
-  return a + b;
+  return a * b;
 }
 module.exports = { multiply };
`;

test("native single-worker path reads, proposes, Rust-applies, tests, and diffs in a disposable fixture", async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "hivo-native-execution-"));
  const originalRoot = path.join(fixtureRoot, "original");
  const workspace = path.join(fixtureRoot, "isolated-workspace");
  const stateRoot = path.join(fixtureRoot, "isolated-appdata");
  const originalFile = path.join(originalRoot, "src", "calculator.js");
  const isolatedFile = path.join(workspace, "src", "calculator.js");
  const testFileContent = `const assert = require("node:assert/strict");
const { test } = require("node:test");
const { multiply } = require("../src/calculator.js");

test("multiply returns the product", () => {
  assert.equal(multiply(3, 4), 12);
});
`;
  const testPath = "tests/calculator.test.js";
  const packageManifest = JSON.stringify({
    name: "native-execution-fixture",
    private: true,
    scripts: { test: "node --test tests/calculator.test.js" }
  }, null, 2) + "\n";

  try {
    await mkdir(path.dirname(originalFile), { recursive: true });
    await mkdir(path.join(originalRoot, "tests"), { recursive: true });
    await writeFile(originalFile, originalSource, "utf8");
    await writeFile(path.join(originalRoot, "tests", "calculator.test.js"), testFileContent, "utf8");
    await writeFile(path.join(originalRoot, "package.json"), packageManifest, "utf8");

    await mkdir(path.dirname(isolatedFile), { recursive: true });
    await mkdir(path.join(workspace, "tests"), { recursive: true });
    await writeFile(isolatedFile, await readFile(originalFile));
    await writeFile(path.join(workspace, testPath), testFileContent, "utf8");
    await writeFile(path.join(workspace, "package.json"), packageManifest, "utf8");
    await initializeGitWorkspace(workspace);

    const provider = new NativeEditProvider();
    const proposals: PatchProposal[] = [];
    const reasoning = await runAdaptiveReasoningTurn({
      provider,
      message: "Fix multiply in src/calculator.js and verify the regression test.",
      sessionId: "session_native_execution_fixture",
      tools: new ToolRegistry(workspace),
      onPatchProposal: async (proposal) => {
        proposals.push(proposal);
      }
    });

    assert.equal(provider.sawActualSource, true, "the provider must receive actual source from the workspace read tool");
    assert.deepEqual(reasoning.trace.toolResults.map((result) => result.kind), ["repository_search", "read_file", "propose_patch"]);
    assert.ok(reasoning.trace.toolResults.every((result) => result.status === "success" || result.status === "approval_required"));
    assert.equal(reasoning.trace.toolResults[1]?.status, "success");
    assert.equal(reasoning.trace.toolResults[2]?.status, "approval_required");
    assert.equal(proposals.length, 1, "the runtime must emit one validated patch proposal");
    const proposal = proposals[0]!;
    assert.equal(proposal.requiresApproval, true);
    assert.equal(proposal.status, "proposed");
    assert.equal(await readFile(isolatedFile, "utf8"), originalSource, "the runtime must not write before Rust approval");
    assert.notEqual(reasoning.result.decision, "ANSWER", "the provider must not claim verified success before application and tests");
    assert.match(reasoning.result.answerMarkdown, /not been applied or tested/i);

    const patchAuthorityOutput = await runRuntimeBridge([
      "--workspace", workspace,
      "--apply-runtime-patch", "true",
      "--session-id", "session_native_execution_fixture",
      "--patch-id", proposal.id,
      "--proposal-json", JSON.stringify(proposal)
    ], stateRoot);
    const patchResult = JSON.parse(patchAuthorityOutput.stdout) as {
      patchResult: { status: string; authority: string; reconciliationSource: string };
    };
    assert.equal(patchResult.patchResult.status, "applied");
    assert.equal(patchResult.patchResult.authority, "rust_patch_service");
    assert.equal(patchResult.patchResult.reconciliationSource, "rust_git_snapshot");

    const changedBytes = await readFile(isolatedFile);
    assert.notDeepEqual(changedBytes, await readFile(originalFile), "only the isolated workspace source should change");
    assert.match(changedBytes.toString("utf8"), /return a \* b;/);

    const nodeTestContext = process.env.NODE_TEST_CONTEXT;
    delete process.env.NODE_TEST_CONTEXT;
    let validation: Awaited<ReturnType<ValidationRunner["runForTask"]>>;
    try {
      validation = await new ValidationRunner(
        workspace,
        new OrchestrationArtifactStore(workspace),
        {
          validation_timeout: 15_000,
          max_validation_log_size: 20_000,
          safe_commands_allowlist: ["npm test", "git diff --check"]
        }
      ).runForTask({
        runId: "run_native_execution_fixture",
        task: createValidationTask(),
        commandInventory: createCommandInventory()
      });
    } finally {
      if (nodeTestContext !== undefined) process.env.NODE_TEST_CONTEXT = nodeTestContext;
    }
    const testCommand = validation.commands_run.find((command) => command.command === "npm test");
    assert.equal(testCommand?.status, "passed", JSON.stringify(validation.commands_run));
    assert.equal(testCommand?.exit_code, 0);
    assert.ok(testCommand?.log_ref);
    const validationLog = await readFile(testCommand.log_ref!, "utf8");
    assert.match(validationLog, /tests 1/);
    assert.match(validationLog, /pass 1/);
    assert.equal(validation.passed, true);

    const { stdout: diff } = await execFileAsync("git", ["diff", "--", "src/calculator.js"], {
      cwd: workspace,
      windowsHide: true
    });
    assert.match(diff, /-  return a \+ b;/);
    assert.match(diff, /\+  return a \* b;/);
    assert.equal(await readFile(originalFile, "utf8"), originalSource, "the original fixture must remain unchanged");
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

class NativeEditProvider implements LlmProvider {
  sawActualSource = false;
  private reasoningStep = 0;

  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    const name = schemaName(schema);
    if (name === "initial-reasoning-decision") {
      return {
        understanding: {
          originalRequest: input.userPrompt,
          cleanedRequest: input.userPrompt,
          language: "english",
          intentKind: "workspace_action",
          route: "simple_run",
          needsWorkspace: true,
          goal: input.userPrompt,
          ambiguities: [],
          requiredEvidence: ["src/calculator.js"],
          risk: "low",
          confidence: "high",
          rationale: "The task requests a bounded source edit and test."
        },
        step: {
          id: "discover_source",
          kind: "tool_batch",
          rationale: "Search the workspace for the requested function before reading it.",
          toolRequests: [{
            id: "find_multiply",
            kind: "repository_search",
            query: "multiply",
            reason: "Locate the multiply implementation."
          }],
          missingFacts: [],
          successCriteria: ["Discover the implementation path containing multiply."]
        }
      } as T;
    }
    if (name === "reasoning-step") {
      this.reasoningStep += 1;
      const context = input.context as {
        toolResults: Array<{
          kind: string;
          data?: {
            matches?: Array<{ path: string }>;
            files?: Array<{ path: string; content: string }>;
          };
        }>;
        allowedEvidenceIds: string[];
      };
      if (this.reasoningStep === 1) {
        const discoveredPath = context.toolResults[0]?.data?.matches?.find((match) => match.path === "src/calculator.js")?.path;
        if (!discoveredPath) throw new Error("Runtime repository search did not discover src/calculator.js.");
        return {
          id: "read_discovered_source",
          kind: "tool_batch",
          rationale: "Read the implementation path returned by repository search.",
          toolRequests: [{
            id: "read_calculator",
            kind: "read_file",
            path: discoveredPath,
            reason: "Ground the proposed edit in the discovered implementation."
          }],
          missingFacts: [],
          successCriteria: ["Read the current multiply implementation."]
        } as T;
      }
      if (this.reasoningStep === 2) {
        const source = context.toolResults
          .find((toolResult) => toolResult.kind === "read_file")
          ?.data?.files?.find((file) => file.path === "src/calculator.js")?.content;
        this.sawActualSource = source === originalSource;
        if (!this.sawActualSource) throw new Error("Runtime did not provide actual calculator source.");
        return {
          id: "propose_source_edit",
          kind: "tool_batch",
          rationale: "Propose the minimal operator correction against the source just read.",
          toolRequests: [{
            id: "propose_calculator_fix",
            kind: "propose_patch",
            reason: "Change multiply to return the product.",
            patch: {
              title: "Fix multiply implementation",
              summary: "Use multiplication in the multiply function.",
              riskLevel: "low",
              filesChanged: [{ path: "src/calculator.js", changeType: "modify", summary: "Correct the multiply operator." }],
              unifiedDiff: sourceReadPatch
            }
          }],
          missingFacts: [],
          successCriteria: ["A validated patch is submitted for approval."]
        } as T;
      }
      return {
        id: "await_authority",
        kind: "escalate",
        rationale: "The patch requires Rust authority and has not been applied or tested.",
        toolRequests: [],
        missingFacts: ["Patch application and test execution are pending."],
        successCriteria: ["Wait for authoritative patch application and executable validation."],
        result: {
          decision: "ESCALATE",
          answerMarkdown: "The patch has not been applied or tested.",
          claims: [],
          evidenceRefs: context.allowedEvidenceIds,
          unknowns: ["Patch application and executable validation remain pending."],
          rationale: "A proposal is not proof of a changed file or a passing test."
        }
      } as T;
    }
    throw new Error(`Unexpected scripted-provider schema: ${name}`);
  }

  async generateText(): Promise<string> {
    throw new Error("Unexpected text generation in native execution test.");
  }
}

function createValidationTask(): Task {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    id: "task_native_fixture_test",
    run_id: "run_native_execution_fixture",
    title: "Verify multiply fix",
    objective: "Run the calculator regression test.",
    role_required: "TesterAgent",
    status: "ready",
    dependencies: [],
    relevant_files: ["src/calculator.js", "tests/calculator.test.js"],
    allowed_files_to_edit: [],
    forbidden_files: [],
    expected_output_schema: "VerificationResult",
    validation_commands: ["npm test"],
    max_attempts: 1,
    attempt_count: 0,
    artifacts: [],
    created_at: now,
    updated_at: now
  };
}

function createCommandInventory(): CommandInventory {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    packageManagers: ["npm"],
    commands: [{
      id: "fixture_test",
      kind: "test",
      command: "npm test",
      cwd: ".",
      sourceFile: "package.json",
      source: "package_json",
      packageManager: "npm",
      scriptName: "test",
      confidence: "high"
    }],
    byKind: {
      test: ["npm test"],
      lint: [],
      typecheck: [],
      build: [],
      format: [],
      smoke: [],
      dev: [],
      run: [],
      unknown: []
    }
  };
}

async function initializeGitWorkspace(workspace: string) {
  await execFileAsync("git", ["init"], { cwd: workspace, windowsHide: true });
  await execFileAsync("git", ["config", "user.email", "hivo-test@example.com"], { cwd: workspace, windowsHide: true });
  await execFileAsync("git", ["config", "user.name", "Hivo Test"], { cwd: workspace, windowsHide: true });
  await execFileAsync("git", ["add", "src/calculator.js", "tests/calculator.test.js", "package.json"], { cwd: workspace, windowsHide: true });
  await execFileAsync("git", ["commit", "-m", "fixture baseline"], { cwd: workspace, windowsHide: true });
}

async function runRuntimeBridge(args: string[], appDataRoot: string) {
  const environment = {
    ...process.env,
    APPDATA: appDataRoot,
    LOCALAPPDATA: appDataRoot
  };
  return execFileAsync("cargo", [...runtimeBridgeArgs, ...args], {
    cwd: repositoryRoot,
    env: environment,
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 4 * 1024 * 1024
  });
}

function schemaName(schema: unknown) {
  return typeof schema === "object" && schema && "name" in schema
    ? String((schema as { name: string }).name)
    : "";
}
