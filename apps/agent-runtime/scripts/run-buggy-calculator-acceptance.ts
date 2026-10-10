import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRuntimeSession, ModelProviderConfig, PatchProposal } from "@hivo/protocol";
import { loadConfig } from "../src/config.js";
import { AgentRuntime } from "../src/runtime/AgentRuntime.js";
import { EventBus } from "../src/runtime/EventBus.js";
import { SessionManager } from "../src/runtime/SessionManager.js";

const ORIGINAL_FIXTURE_PATH = "F:\\Projects\\Python\\HIVO_TEST_PROJECTS\\buggy-calculator";
let WORKSPACE_PATH = ORIGINAL_FIXTURE_PATH;
let CALC_FILE_PATH = path.join(WORKSPACE_PATH, "src", "calculator.ts");
const RUST_BRIDGE_EXE = "F:\\Projects\\Python\\HIVO\\apps\\desktop\\src-tauri\\target\\debug\\runtime_bridge_smoke.exe";

const BUGGY_CALC_CONTENT = `export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}

export function multiply(a: number, b: number): number {
  return a + b;
}

export function divide(a: number, b: number): number {
  if (b === 0) {
    throw new Error("Cannot divide by zero");
  }

  return a / b;
}
`;

const NATURAL_PROMPT = `The existing test suite contains a failing behavior.

Investigate the project, determine the root cause, and make the smallest safe
change required to fix it.

Do not rewrite unrelated code or change the tests just to make them pass.

Use the existing project structure and validation commands.

Verify the final implementation using the existing tests and report:
- root cause
- file changed
- change made
- validation performed
- whether all tests pass.`;

const REAL_PROVIDER_CONFIG: ModelProviderConfig = {
  providerType: "ollama",
  providerName: "Ollama",
  baseUrl: "http://127.0.0.1:11434",
  selectedModel: "gpt-oss:120b-cloud",
  routerModel: "gpt-oss:120b-cloud",
  verifierModel: "gpt-oss:120b-cloud",
  isValid: true
};

function resetBuggyCalculator() {
  assert.notEqual(WORKSPACE_PATH, ORIGINAL_FIXTURE_PATH, "Refusing to reset original fixture workspace! Must target isolated temporary workspace.");
  writeFileSync(CALC_FILE_PATH, BUGGY_CALC_CONTENT, "utf8");
  for (const extra of ["test_output.txt", "root_cause_analysis.txt", "patch.diff"]) {
    const p = path.join(WORKSPACE_PATH, extra);
    if (existsSync(p)) {
      try { unlinkSync(p); } catch {}
    }
  }
}

function runRealNpmTest(): { exitCode: number; stdout: string; stderr: string } {
  assert.notEqual(WORKSPACE_PATH, ORIGINAL_FIXTURE_PATH, "Refusing to run npm test on original fixture workspace! Must target isolated temporary workspace.");
  try {
    const res = spawnSync("npm.cmd", ["test"], {
      cwd: WORKSPACE_PATH,
      encoding: "utf8",
      shell: true
    });
    return {
      exitCode: res.status ?? 0,
      stdout: res.stdout || "",
      stderr: res.stderr || ""
    };
  } catch (error: any) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: String(error)
    };
  }
}

function applyPatchViaRustAuthority(sessionId: string, patch: PatchProposal) {
  assert.notEqual(WORKSPACE_PATH, ORIGINAL_FIXTURE_PATH, "Refusing to apply patch to original fixture workspace! Must target isolated temporary workspace.");
  assert.ok(existsSync(RUST_BRIDGE_EXE), `Rust bridge exe not found at ${RUST_BRIDGE_EXE}`);
  const out = execFileSync(
    RUST_BRIDGE_EXE,
    [
      "--workspace",
      WORKSPACE_PATH,
      "--apply-runtime-patch",
      "true",
      "--session-id",
      sessionId,
      "--patch-id",
      patch.id,
      "--proposal-json",
      JSON.stringify(patch)
    ],
    { encoding: "utf8" }
  );
  return JSON.parse(out) as {
    patchResult: {
      patchId: string;
      status: string;
      message: string;
      beforeSnapshot?: any;
      afterSnapshot?: any;
    };
  };
}

function runCommandViaRustAuthority(command: string) {
  assert.notEqual(WORKSPACE_PATH, ORIGINAL_FIXTURE_PATH, "Refusing to run command against original fixture workspace! Must target isolated temporary workspace.");
  assert.ok(existsSync(RUST_BRIDGE_EXE), `Rust bridge exe not found at ${RUST_BRIDGE_EXE}`);
  const out = execFileSync(
    RUST_BRIDGE_EXE,
    [
      "--workspace",
      WORKSPACE_PATH,
      "--cwd",
      WORKSPACE_PATH,
      "--command",
      command,
      "--approval-granted",
      "true"
    ],
    { encoding: "utf8" }
  );
  return JSON.parse(out) as {
    commandResult: {
      command: string;
      status: string;
      exitCode?: number;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
  };
}

async function runFlow1PlanOff() {
  console.log("\n=======================================================");
  console.log("STARTING FLOW 1 — PLAN MODE OFF");
  console.log("=======================================================");

  resetBuggyCalculator();
  const baselineDirect = runRealNpmTest();
  console.log(`Baseline direct npm test exitCode: ${baselineDirect.exitCode} (expected failure)`);
  assert.equal(baselineDirect.exitCode, 1, "Baseline tests must fail before patch");

  const storageDir = path.join(os.tmpdir(), `hivo-calc-flow1-${Date.now()}`);
  const eventBus = new EventBus();
  const sessionManager = new SessionManager(storageDir, eventBus);
  await sessionManager.load();
  const runtime = new AgentRuntime({ ...loadConfig(), storageDir }, sessionManager);

  console.log("Creating session (thinkFirst: false, accessProfile: default_permissions)...");
  const created = await runtime.createSession({
    workspacePath: WORKSPACE_PATH,
    mode: "real_provider",
    providerConfig: REAL_PROVIDER_CONFIG,
    accessProfile: "default_permissions",
    thinkFirst: false,
    userPrompt: NATURAL_PROMPT
  });

  console.log(`Session created: ${created.sessionId}`);
  console.log("Running Turn 1 with natural prompt...");
  let turn = await runtime.runTurn(created.sessionId, NATURAL_PROMPT);
  let session = runtime.getSession(created.sessionId)!;

  // Check if baseline command was requested
  if (session.nextAction?.kind === "await_baseline_command") {
    const baselineAction = session.nextAction;
    console.log(`Baseline command requested: ${baselineAction.command} (reqId: ${baselineAction.commandRequestId})`);
    console.log("Executing baseline command via Rust authority...");
    const rustCmd = runCommandViaRustAuthority(baselineAction.command);
    console.log(`Rust command executed: status=${rustCmd.commandResult.status} exitCode=${rustCmd.commandResult.exitCode}`);

    await runtime.reportCommandResult(created.sessionId, baselineAction.commandRequestId, {
      command: baselineAction.command,
      cwd: WORKSPACE_PATH,
      risk: "safe",
      status: rustCmd.commandResult.exitCode === 0 ? "executed" : "failed",
      exitCode: rustCmd.commandResult.exitCode,
      stdout: rustCmd.commandResult.stdout ?? "",
      stderr: rustCmd.commandResult.stderr ?? ""
    });

    console.log("Resuming turn with resume_baseline_planning...");
    turn = await runtime.runTurn(created.sessionId, "resume_baseline_planning");
    session = runtime.getSession(created.sessionId)!;
  }

  console.log(`After reasoning turn: status=${session.status}, lifecycleStage=${session.lifecycleStage}`);
  console.log(`Patch proposals count: ${session.patchProposals.length}`);

  // Verification 1: Creating a proposal does NOT mark session completed/DONE
  assert.notEqual(session.status, "completed", "Must NOT be completed merely upon proposal creation");
  assert.notEqual(session.lifecycleStage, "DONE", "Must NOT be DONE merely upon proposal creation");
  assert.equal(session.status, "needs_approval");
  assert.equal(session.lifecycleStage, "APPROVAL");

  const calcProposal = session.patchProposals.find((p) => p.filesChanged.some((f) => f.path.includes("calculator.ts")));
  assert.ok(calcProposal, "Must have created a PatchProposal for calculator.ts");
  console.log(`Found PatchProposal for calculator.ts: ID=${calcProposal.id}, status=${calcProposal.status}`);
  console.log(`Unified diff:\n${calcProposal.unifiedDiff}`);
  assert.match(calcProposal.unifiedDiff, /return a \* b/, "Diff must fix + to *");

  // Verification 2: Operator approval
  console.log("Approving patches via runtime approval...");
  for (const proposal of session.patchProposals) {
    if (proposal.status === "proposed") {
      console.log(`Approving patch: ${proposal.id} (${proposal.title})`);
      await runtime.approvePatch(created.sessionId, proposal.id);
    }
  }
  session = runtime.getSession(created.sessionId)!;
  assert.equal(session.lifecycleStage, "APPLY", "Approved patch moves to APPLY stage");
  assert.notEqual(session.status, "completed", "Approved patch is not completed before Rust apply");

  // Verification 3: Rust apply
  console.log("Applying patches via Rust authority (runtime_bridge_smoke)...");
  for (const proposal of session.patchProposals) {
    if (proposal.status === "approved") {
      console.log(`Applying patch ${proposal.id} (${proposal.title}) via Rust...`);
      const rustApply = applyPatchViaRustAuthority(created.sessionId, proposal);
      console.log(`Rust apply result: ${rustApply.patchResult.status} — ${rustApply.patchResult.message}`);
      assert.equal(rustApply.patchResult.status, "applied");

      console.log("Reporting Rust patch apply result to runtime...");
      await runtime.reportPatchApplyResult(created.sessionId, proposal.id, {
        status: "applied",
        message: rustApply.patchResult.message,
        reconciliationSnapshot: {
          before: rustApply.patchResult.beforeSnapshot,
          after: rustApply.patchResult.afterSnapshot
        }
      });
    }
  }

  session = runtime.getSession(created.sessionId)!;
  console.log(`After patch apply: status=${session.status}, lifecycleStage=${session.lifecycleStage}, planState=${session.recursiveSwarmRunState?.planState}`);
  assert.equal(session.recursiveSwarmRunState?.planState, "implemented");
  assert.notEqual(session.status, "completed", "Must NOT be completed before post-apply validation");
  assert.notEqual(session.lifecycleStage, "DONE", "Must NOT be DONE before post-apply validation");

  // Verification 4: Post-apply validation commands scheduled
  const postApplyCommands = session.commandRequests.filter(
    (c) => c.status === "requested" || c.status === "approved"
  );
  assert.ok(postApplyCommands.length > 0, "Must schedule at least one post-apply validation command");
  console.log(`Post-apply validation commands scheduled: ${postApplyCommands.map((c) => c.command).join(", ")}`);

  // Verification 5: Execute post-apply validation via Rust authority
  for (const cmd of postApplyCommands) {
    console.log(`Executing post-apply validation via Rust authority: ${cmd.command}...`);
    const valResult = runCommandViaRustAuthority(cmd.command);
    console.log(`Post-apply validation executed: status=${valResult.commandResult.status}, exitCode=${valResult.commandResult.exitCode}`);
    assert.equal(valResult.commandResult.exitCode, 0, `Validation command ${cmd.command} must succeed with exitCode 0`);

    console.log("Reporting post-apply validation result to runtime...");
    await runtime.reportCommandResult(created.sessionId, cmd.id, {
      command: cmd.command,
      cwd: WORKSPACE_PATH,
      risk: "safe",
      status: "executed",
      exitCode: valResult.commandResult.exitCode,
      stdout: valResult.commandResult.stdout ?? "",
      stderr: valResult.commandResult.stderr ?? ""
    });
  }

  session = runtime.getSession(created.sessionId)!;
  console.log(`Final session state: status=${session.status}, lifecycleStage=${session.lifecycleStage}`);
  assert.equal(session.status, "completed", "Session must be completed after post-apply validation passes");
  assert.equal(session.lifecycleStage, "DONE", "Session must be DONE after post-apply validation passes");

  // Verification 6: Physical file content and npm test
  const finalContent = readFileSync(CALC_FILE_PATH, "utf8");
  console.log(`Physical file content:\n${finalContent}`);
  assert.match(finalContent, /return a \* b;/, "Physical file must contain return a * b;");

  const finalNpmTest = runRealNpmTest();
  console.log(`Direct npm test on disk: exitCode=${finalNpmTest.exitCode}\n${finalNpmTest.stdout}`);
  assert.equal(finalNpmTest.exitCode, 0, "Physical npm test must pass 4/4");
  assert.match(finalNpmTest.stdout, /pass 4|4 pass/i);

  console.log("FLOW 1 — PLAN MODE OFF PASSED 100%!");
  const primaryProposal = session.patchProposals.find((p) => p.filesChanged.some((f) => f.path.includes("calculator.ts")))!;
  return {
    sessionId: created.sessionId,
    proposalId: primaryProposal.id,
    postApplyCmdId: postApplyCommands[0].id,
    storageDir
  };
}

async function runFlow2PlanOn() {
  console.log("\n=======================================================");
  console.log("STARTING FLOW 2 — PLAN MODE ON");
  console.log("=======================================================");

  resetBuggyCalculator();
  const baselineDirect = runRealNpmTest();
  console.log(`Baseline direct npm test exitCode: ${baselineDirect.exitCode} (expected failure)`);
  assert.equal(baselineDirect.exitCode, 1, "Baseline tests must fail before patch");

  const storageDir = path.join(os.tmpdir(), `hivo-calc-flow2-${Date.now()}`);
  const eventBus = new EventBus();
  const sessionManager = new SessionManager(storageDir, eventBus);
  await sessionManager.load();
  const runtime = new AgentRuntime({ ...loadConfig(), storageDir }, sessionManager);

  console.log("Creating session (thinkFirst: true, accessProfile: default_permissions)...");
  const created = await runtime.createSession({
    workspacePath: WORKSPACE_PATH,
    mode: "real_provider",
    providerConfig: REAL_PROVIDER_CONFIG,
    accessProfile: "default_permissions",
    thinkFirst: true,
    userPrompt: NATURAL_PROMPT
  });

  console.log(`Session created: ${created.sessionId}`);
  console.log("Running Turn 1 with natural prompt...");
  let turn = await runtime.runTurn(created.sessionId, NATURAL_PROMPT);
  let session = runtime.getSession(created.sessionId)!;

  // Check if baseline command was requested
  if (session.nextAction?.kind === "await_baseline_command") {
    const baselineAction = session.nextAction;
    console.log(`Baseline command requested: ${baselineAction.command} (reqId: ${baselineAction.commandRequestId})`);
    console.log("Executing baseline command via Rust authority...");
    const rustCmd = runCommandViaRustAuthority(baselineAction.command);
    console.log(`Rust command executed: status=${rustCmd.commandResult.status} exitCode=${rustCmd.commandResult.exitCode}`);

    await runtime.reportCommandResult(created.sessionId, baselineAction.commandRequestId, {
      command: baselineAction.command,
      cwd: WORKSPACE_PATH,
      risk: "safe",
      status: rustCmd.commandResult.exitCode === 0 ? "executed" : "failed",
      exitCode: rustCmd.commandResult.exitCode,
      stdout: rustCmd.commandResult.stdout ?? "",
      stderr: rustCmd.commandResult.stderr ?? ""
    });

    console.log("Resuming turn with resume_baseline_planning...");
    turn = await runtime.runTurn(created.sessionId, "resume_baseline_planning");
    session = runtime.getSession(created.sessionId)!;
  }

  console.log(`After plan turn: status=${session.status}, lifecycleStage=${session.lifecycleStage}, nextAction=${JSON.stringify(session.nextAction)}`);
  
  // Verification 1: Plan Mode ON stops at confirm_plan
  assert.equal(session.status, "needs_approval");
  assert.equal(session.lifecycleStage, "PLAN");
  assert.equal(session.nextAction?.kind, "confirm_plan");
  assert.equal(session.recursiveSwarmRunState?.planState, "ready_to_implement");

  // Verification 2: Physical file remains UNCHANGED in Plan Mode ON before confirmation
  const midContent = readFileSync(CALC_FILE_PATH, "utf8");
  assert.match(midContent, /return a \+ b;/, "Physical file must remain UNCHANGED before plan confirmation");
  console.log("Confirmed: physical file remained unchanged before plan confirmation.");

  // Verification 3: Implement plan (confirm_plan)
  console.log("Confirming plan (Implement plan)...");
  turn = await runtime.runTurn(created.sessionId, "Implement plan");
  session = runtime.getSession(created.sessionId)!;

  console.log(`After Implement plan: status=${session.status}, lifecycleStage=${session.lifecycleStage}`);
  assert.equal(session.status, "needs_approval");
  assert.equal(session.lifecycleStage, "APPROVAL");
  assert.notEqual(session.status, "completed", "Must NOT be completed merely upon confirmation");
  assert.notEqual(session.lifecycleStage, "DONE", "Must NOT be DONE merely upon confirmation");

  const calcProposal = session.patchProposals.find((p) => p.filesChanged.some((f) => f.path.includes("calculator.ts")));
  assert.ok(calcProposal, "Must have created PatchProposal after plan confirmation");
  console.log(`Found PatchProposal: ID=${calcProposal.id}, title=${calcProposal.title}`);
  assert.match(calcProposal.unifiedDiff, /return a \* b/, "Diff must fix + to *");

  // Verification 4: Operator approval
  console.log("Approving patches via runtime approval...");
  for (const proposal of session.patchProposals) {
    if (proposal.status === "proposed") {
      console.log(`Approving patch: ${proposal.id} (${proposal.title})`);
      await runtime.approvePatch(created.sessionId, proposal.id);
    }
  }
  session = runtime.getSession(created.sessionId)!;
  assert.equal(session.lifecycleStage, "APPLY");

  // Verification 5: Rust apply
  console.log("Applying patches via Rust authority...");
  for (const proposal of session.patchProposals) {
    if (proposal.status === "approved") {
      console.log(`Applying patch ${proposal.id} (${proposal.title}) via Rust...`);
      const rustApply = applyPatchViaRustAuthority(created.sessionId, proposal);
      console.log(`Rust apply result: ${rustApply.patchResult.status} — ${rustApply.patchResult.message}`);
      assert.equal(rustApply.patchResult.status, "applied");

      console.log("Reporting Rust patch apply result to runtime...");
      await runtime.reportPatchApplyResult(created.sessionId, proposal.id, {
        status: "applied",
        message: rustApply.patchResult.message,
        reconciliationSnapshot: {
          before: rustApply.patchResult.beforeSnapshot,
          after: rustApply.patchResult.afterSnapshot
        }
      });
    }
  }

  session = runtime.getSession(created.sessionId)!;
  console.log(`After patch apply: status=${session.status}, lifecycleStage=${session.lifecycleStage}, planState=${session.recursiveSwarmRunState?.planState}`);
  assert.equal(session.recursiveSwarmRunState?.planState, "implemented");
  assert.notEqual(session.status, "completed", "Must NOT be completed before post-apply validation");

  // Verification 6: Post-apply validation scheduled
  const postApplyCommands = session.commandRequests.filter(
    (c) => c.status === "requested" || c.status === "approved"
  );
  assert.ok(postApplyCommands.length > 0, "Must schedule at least one post-apply validation command");
  console.log(`Post-apply validation commands scheduled: ${postApplyCommands.map((c) => c.command).join(", ")}`);

  // Verification 7: Execute post-apply validation via Rust authority
  for (const cmd of postApplyCommands) {
    console.log(`Executing post-apply validation via Rust authority: ${cmd.command}...`);
    const valResult = runCommandViaRustAuthority(cmd.command);
    console.log(`Post-apply validation executed: exitCode=${valResult.commandResult.exitCode}`);
    assert.equal(valResult.commandResult.exitCode, 0, `Validation command ${cmd.command} must succeed`);

    console.log("Reporting post-apply validation result to runtime...");
    await runtime.reportCommandResult(created.sessionId, cmd.id, {
      command: cmd.command,
      cwd: WORKSPACE_PATH,
      risk: "safe",
      status: "executed",
      exitCode: valResult.commandResult.exitCode,
      stdout: valResult.commandResult.stdout ?? "",
      stderr: valResult.commandResult.stderr ?? ""
    });
  }

  session = runtime.getSession(created.sessionId)!;
  console.log(`Final session state: status=${session.status}, lifecycleStage=${session.lifecycleStage}`);
  assert.equal(session.status, "completed", "Session must be completed after post-apply validation passes");
  assert.equal(session.lifecycleStage, "DONE", "Session must be DONE after post-apply validation passes");

  // Verification 8: Physical file content and npm test
  const finalContent = readFileSync(CALC_FILE_PATH, "utf8");
  console.log(`Physical file content:\n${finalContent}`);
  assert.match(finalContent, /return a \* b;/, "Physical file must contain return a * b;");

  const finalNpmTest = runRealNpmTest();
  console.log(`Direct npm test on disk: exitCode=${finalNpmTest.exitCode}\n${finalNpmTest.stdout}`);
  assert.equal(finalNpmTest.exitCode, 0, "Physical npm test must pass 4/4");
  assert.match(finalNpmTest.stdout, /pass 4|4 pass/i);

  console.log("FLOW 2 — PLAN MODE ON PASSED 100%!");
  const primaryProposal = session.patchProposals.find((p) => p.filesChanged.some((f) => f.path.includes("calculator.ts")))!;
  return {
    sessionId: created.sessionId,
    proposalId: primaryProposal.id,
    postApplyCmdId: postApplyCommands[0].id
  };
}

async function main() {
  const isIsolatedFlow1 = process.argv.includes("--isolated-flow1");
  if (!isIsolatedFlow1) {
    console.error("SAFETY STOP: Explicit '--isolated-flow1' flag is required to run the acceptance harness.");
    console.error("Execution halted before any workspace mutation, reset, or test execution.");
    console.error("Usage: npx tsx scripts/run-buggy-calculator-acceptance.ts --isolated-flow1");
    process.exit(1);
  }

  // Create isolated temporary workspace and copy calculator fixture
  const tempWorkspace = mkdtempSync(path.join(os.tmpdir(), "hivo-buggy-calc-flow1-"));
  console.log(`[Harness] Created isolated temporary workspace: ${tempWorkspace}`);
  console.log(`[Harness] Copying fixture from ${ORIGINAL_FIXTURE_PATH} to ${tempWorkspace}...`);
  cpSync(ORIGINAL_FIXTURE_PATH, tempWorkspace, { recursive: true });
  console.log(`[Harness] Fixture copy completed.`);

  WORKSPACE_PATH = tempWorkspace;
  CALC_FILE_PATH = path.join(WORKSPACE_PATH, "src", "calculator.ts");

  console.log("===============================================================================");
  console.log("HIVO REAL BUGGY-CALCULATOR ACCEPTANCE TEST (ISOLATED FLOW 1 ONLY)");
  console.log(`Isolated Workspace: ${WORKSPACE_PATH}`);
  console.log(`Original Fixture:   ${ORIGINAL_FIXTURE_PATH} (untouched)`);
  console.log(`Rust Bridge:        ${RUST_BRIDGE_EXE}`);
  console.log(`Model:              ${REAL_PROVIDER_CONFIG.selectedModel} on ${REAL_PROVIDER_CONFIG.baseUrl}`);
  console.log("===============================================================================");

  const flow1 = await runFlow1PlanOff();

  console.log("\n===============================================================================");
  console.log("FLOW 1 ISOLATED ACCEPTANCE TEST COMPLETED SUCCESSFULLY!");
  console.log(`FLOW 1 (Plan OFF): Session=${flow1.sessionId}, Proposal=${flow1.proposalId}, ValCmd=${flow1.postApplyCmdId}`);
  console.log(`Preserved Temporary Workspace: ${WORKSPACE_PATH}`);
  console.log(`Preserved Session Storage:     ${flow1.storageDir}`);
  console.log("===============================================================================");
}

main().catch((err) => {
  console.error("ACCEPTANCE TEST FAILED:", err);
  if (WORKSPACE_PATH !== ORIGINAL_FIXTURE_PATH) {
    console.error(`Preserved Temporary Workspace for inspection: ${WORKSPACE_PATH}`);
  }
  process.exit(1);
});
