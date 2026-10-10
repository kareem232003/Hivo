import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentRuntimeSession, CommandExecutionRecord, IntentContract } from "@hivo/protocol";
import { EventBus } from "../runtime/EventBus.js";
import { createConversationUnderstanding } from "../runtime/ConversationUnderstanding.js";
import { RuntimePlanningTurnService, type RuntimePlanningTurnServices } from "../runtime/RuntimePlanningTurnService.js";
import { RuntimePendingActionService } from "../runtime/RuntimePendingActionService.js";
import { RuntimeSessionOutcomeService } from "../runtime/RuntimeSessionOutcomeService.js";
import { SessionManager } from "../runtime/SessionManager.js";
import { AgentRuntime } from "../runtime/AgentRuntime.js";
import { loadConfig } from "../config.js";
import { ScriptedProvider } from "./fixtures/ScriptedProvider.js";

test("1. baseline npm test is requested exactly once before recursive dispatch", async () => {
  const fixture = await createFixture();
  try {
    const calls: string[] = [];
    const services = planningServices({
      calls,
      session: fixture.session,
      compileReady: true
    });
    const planningService = new RuntimePlanningTurnService(fixture.manager, services);

    const firstRun = await planningService.run({
      sessionId: fixture.session.id,
      session: fixture.manager.getSession(fixture.session.id)!,
      prompt: "recursive child agents solve bug",
      conversationUnderstanding: createConversationUnderstanding("recursive child agents solve bug"),
      decisionPipelineId: "decision_pipeline_test",
      providerContext: providerContext(),
      swarmMode: "recursive_tree"
    });

    assert.equal(firstRun.status, "needs_approval");
    const sessionAfterFirst = fixture.manager.getSession(fixture.session.id)!;
    assert.equal(sessionAfterFirst.commandRequests.length, 1);
    assert.equal(sessionAfterFirst.commandRequests[0]?.command, "npm test");
    assert.equal(sessionAfterFirst.nextAction?.kind, "await_baseline_command");
    assert.equal(sessionAfterFirst.nextAction.command, "npm test");
    assert.equal(sessionAfterFirst.nextAction.originalPrompt, "recursive child agents solve bug");
    assert.equal(sessionAfterFirst.nextAction.commandRequestId, sessionAfterFirst.commandRequests[0]?.id);

    // Call planning service again while baseline request is pending
    const secondRun = await planningService.run({
      sessionId: fixture.session.id,
      session: fixture.manager.getSession(fixture.session.id)!,
      prompt: "recursive child agents solve bug",
      conversationUnderstanding: createConversationUnderstanding("recursive child agents solve bug"),
      decisionPipelineId: "decision_pipeline_test",
      providerContext: providerContext(),
      swarmMode: "recursive_tree"
    });

    assert.equal(secondRun.status, "needs_approval");
    const sessionAfterSecond = fixture.manager.getSession(fixture.session.id)!;
    // Exactly one command request must exist, not duplicated
    assert.equal(sessionAfterSecond.commandRequests.length, 1);
    assert.equal(sessionAfterSecond.commandRequests[0]?.id, sessionAfterFirst.commandRequests[0]?.id);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("2. test exitCode 1 is treated as valid evidence, not terminal session failure", async () => {
  const fixture = await createFixture();
  try {
    const requestId = "cmd_baseline_123";
    await fixture.manager.addCommandRequest(fixture.session.id, {
      id: requestId,
      sessionId: fixture.session.id,
      command: "npm test",
      cwd: fixture.workspace,
      risk: "safe",
      reason: "Run baseline test",
      status: "requested",
      createdAt: new Date().toISOString()
    });
    await fixture.manager.updateSession(fixture.session.id, (draft) => {
      draft.status = "needs_approval";
      draft.lifecycleStage = "INTAKE";
      draft.nextAction = {
        kind: "await_baseline_command",
        commandRequestId: requestId,
        command: "npm test",
        originalPrompt: "recursive child agents solve bug",
        message: "Awaiting baseline command execution: npm test"
      };
    });

    const execution: CommandExecutionRecord = {
      id: "exec_baseline_123",
      sessionId: fixture.session.id,
      requestId,
      autoRun: false,
      command: "npm test",
      cwd: fixture.workspace,
      risk: "safe",
      status: "failed",
      exitCode: 1,
      stdout: "FAIL src/calculator.test.ts\nmultiply actual = 7, expected = 12",
      stderr: "",
      provenance: {
        source: "agent",
        trigger: "manual",
        requestedBy: "agent",
        sessionId: fixture.session.id,
        requestId
      },
      createdAt: new Date().toISOString()
    };
    await fixture.manager.addCommandExecution(fixture.session.id, execution);

    const outcomeService = new RuntimeSessionOutcomeService(fixture.manager);
    await outcomeService.sync(fixture.session.id);

    const session = fixture.manager.getSession(fixture.session.id)!;
    // Must NOT be marked as failed or completed
    assert.notEqual(session.status, "failed");
    assert.notEqual(session.status, "completed");
    assert.equal(session.status, "needs_approval");
    assert.equal(session.lifecycleStage, "INTAKE");
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("3. nextAction survives command-result processing", async () => {
  const fixture = await createFixture();
  try {
    const requestId = "cmd_baseline_456";
    await fixture.manager.addCommandRequest(fixture.session.id, {
      id: requestId,
      sessionId: fixture.session.id,
      command: "npm test",
      cwd: fixture.workspace,
      risk: "safe",
      reason: "Run baseline test",
      status: "requested",
      createdAt: new Date().toISOString()
    });
    await fixture.manager.updateSession(fixture.session.id, (draft) => {
      draft.status = "needs_approval";
      draft.lifecycleStage = "INTAKE";
      draft.nextAction = {
        kind: "await_baseline_command",
        commandRequestId: requestId,
        command: "npm test",
        originalPrompt: "recursive child agents solve bug",
        message: "Awaiting baseline command execution: npm test"
      };
    });

    const execution: CommandExecutionRecord = {
      id: "exec_baseline_456",
      sessionId: fixture.session.id,
      requestId,
      autoRun: false,
      command: "npm test",
      cwd: fixture.workspace,
      risk: "safe",
      status: "failed",
      exitCode: 1,
      stdout: "1 test failed",
      stderr: "",
      provenance: {
        source: "agent",
        trigger: "manual",
        requestedBy: "agent",
        sessionId: fixture.session.id,
        requestId
      },
      createdAt: new Date().toISOString()
    };
    await fixture.manager.addCommandExecution(fixture.session.id, execution);

    const outcomeService = new RuntimeSessionOutcomeService(fixture.manager);
    await outcomeService.sync(fixture.session.id);

    const session = fixture.manager.getSession(fixture.session.id)!;
    // nextAction must be preserved intact
    assert.equal(session.nextAction?.kind, "await_baseline_command");
    assert.equal(session.nextAction.commandRequestId, requestId);
    assert.equal(session.nextAction.command, "npm test");
    assert.equal(session.nextAction.originalPrompt, "recursive child agents solve bug");
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("4. planning resumes with the original prompt", async () => {
  const fixture = await createFixture();
  try {
    const requestId = "cmd_baseline_789";
    await fixture.manager.addCommandRequest(fixture.session.id, {
      id: requestId,
      sessionId: fixture.session.id,
      command: "npm test",
      cwd: fixture.workspace,
      risk: "safe",
      reason: "Run baseline test",
      status: "requested",
      createdAt: new Date().toISOString()
    });
    await fixture.manager.updateSession(fixture.session.id, (draft) => {
      draft.status = "needs_approval";
      draft.lifecycleStage = "INTAKE";
      draft.nextAction = {
        kind: "await_baseline_command",
        commandRequestId: requestId,
        command: "npm test",
        originalPrompt: "recursive child agents solve bug",
        message: "Awaiting baseline command execution: npm test"
      };
    });

    const execution: CommandExecutionRecord = {
      id: "exec_baseline_789",
      sessionId: fixture.session.id,
      requestId,
      autoRun: false,
      command: "npm test",
      cwd: fixture.workspace,
      risk: "safe",
      status: "failed",
      exitCode: 1,
      stdout: "1 test failed",
      stderr: "",
      provenance: {
        source: "agent",
        trigger: "manual",
        requestedBy: "agent",
        sessionId: fixture.session.id,
        requestId
      },
      createdAt: new Date().toISOString()
    };
    await fixture.manager.addCommandExecution(fixture.session.id, execution);

    const pendingActionService = new RuntimePendingActionService(fixture.manager);
    const result = await pendingActionService.handle(fixture.manager.getSession(fixture.session.id)!, "resume_baseline_planning");

    assert.equal(result.handled, false);
    assert.equal(result.resumePrompt, "recursive child agents solve bug");

    const sessionAfterHandle = fixture.manager.getSession(fixture.session.id)!;
    assert.equal(sessionAfterHandle.nextAction, undefined);
    assert.equal(sessionAfterHandle.status, "running");
    assert.equal(sessionAfterHandle.lifecycleStage, "PLAN");
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("5. the sentinel is not stored/routed as a user prompt", async () => {
  const storageDir = path.join(os.tmpdir(), `hivo-baseline-sentinel-storage-${Date.now()}`);
  const workspace = path.join(os.tmpdir(), `hivo-baseline-sentinel-workspace-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({ scripts: { test: "npm test" } }), "utf8");

  try {
    const sessionManager = new SessionManager(storageDir, new EventBus());
    await sessionManager.load();
    const runtime = new AgentRuntime({ ...loadConfig(), storageDir }, sessionManager, {
      providerFactory: () => new ScriptedProvider()
    });

    const session = await sessionManager.createSession({
      workspacePath: workspace,
      mode: "real_provider",
      executionMode: "auto_mode",
      userPrompt: "recursive child agents solve bug"
    });

    const requestId = "cmd_baseline_sentinel";
    await sessionManager.addCommandRequest(session.id, {
      id: requestId,
      sessionId: session.id,
      command: "npm test",
      cwd: workspace,
      risk: "safe",
      reason: "Run baseline test",
      status: "requested",
      createdAt: new Date().toISOString()
    });
    await sessionManager.updateSession(session.id, (draft) => {
      draft.status = "needs_approval";
      draft.lifecycleStage = "INTAKE";
      draft.nextAction = {
        kind: "await_baseline_command",
        commandRequestId: requestId,
        command: "npm test",
        originalPrompt: "recursive child agents solve bug",
        message: "Awaiting baseline command execution: npm test"
      };
    });

    const execution: CommandExecutionRecord = {
      id: "exec_baseline_sentinel",
      sessionId: session.id,
      requestId,
      autoRun: false,
      command: "npm test",
      cwd: workspace,
      risk: "safe",
      status: "failed",
      exitCode: 1,
      stdout: "1 test failed",
      stderr: "",
      provenance: {
        source: "agent",
        trigger: "manual",
        requestedBy: "agent",
        sessionId: session.id,
        requestId
      },
      createdAt: new Date().toISOString()
    };
    await sessionManager.addCommandExecution(session.id, execution);

    // Run the continuation turn via runtime
    await runtime.runTurn(session.id, "resume_baseline_planning");

    const sessionAfterTurn = sessionManager.getSession(session.id)!;
    // Sentinel must never be stored as a user message
    const hasSentinelMessage = sessionAfterTurn.messages.some((m) => m.content === "resume_baseline_planning");
    assert.equal(hasSentinelMessage, false);
    // User prompt on session remains the original prompt
    assert.equal(sessionAfterTurn.userPrompt, "recursive child agents solve bug");
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("6. duplicate result/reconcile events do not cause duplicate planning", async () => {
  const fixture = await createFixture();
  try {
    const requestId = "cmd_baseline_dup";
    await fixture.manager.addCommandRequest(fixture.session.id, {
      id: requestId,
      sessionId: fixture.session.id,
      command: "npm test",
      cwd: fixture.workspace,
      risk: "safe",
      reason: "Run baseline test",
      status: "requested",
      createdAt: new Date().toISOString()
    });
    await fixture.manager.updateSession(fixture.session.id, (draft) => {
      draft.status = "needs_approval";
      draft.lifecycleStage = "INTAKE";
      draft.nextAction = {
        kind: "await_baseline_command",
        commandRequestId: requestId,
        command: "npm test",
        originalPrompt: "recursive child agents solve bug",
        message: "Awaiting baseline command execution: npm test"
      };
    });

    const execution: CommandExecutionRecord = {
      id: "exec_baseline_dup",
      sessionId: fixture.session.id,
      requestId,
      autoRun: false,
      command: "npm test",
      cwd: fixture.workspace,
      risk: "safe",
      status: "failed",
      exitCode: 1,
      stdout: "1 test failed",
      stderr: "",
      provenance: {
        source: "agent",
        trigger: "manual",
        requestedBy: "agent",
        sessionId: fixture.session.id,
        requestId
      },
      createdAt: new Date().toISOString()
    };
    await fixture.manager.addCommandExecution(fixture.session.id, execution);

    const pendingActionService = new RuntimePendingActionService(fixture.manager);

    // First continuation consume
    const firstResult = await pendingActionService.handle(fixture.manager.getSession(fixture.session.id)!, "resume_baseline_planning");
    assert.equal(firstResult.handled, false);
    assert.equal(firstResult.resumePrompt, "recursive child agents solve bug");

    // Second continuation attempt (e.g. duplicate reconcile event or duplicate call)
    const secondResult = await pendingActionService.handle(fixture.manager.getSession(fixture.session.id)!, "resume_baseline_planning");
    assert.equal(secondResult.handled, true);
    assert.equal(secondResult.resumePrompt, undefined);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("7. infrastructure failure does not resume planning", async () => {
  const fixture = await createFixture();
  try {
    const requestId = "cmd_baseline_infra_fail";
    await fixture.manager.addCommandRequest(fixture.session.id, {
      id: requestId,
      sessionId: fixture.session.id,
      command: "npm test",
      cwd: fixture.workspace,
      risk: "safe",
      reason: "Run baseline test",
      status: "requested",
      createdAt: new Date().toISOString()
    });
    await fixture.manager.updateSession(fixture.session.id, (draft) => {
      draft.status = "needs_approval";
      draft.lifecycleStage = "INTAKE";
      draft.nextAction = {
        kind: "await_baseline_command",
        commandRequestId: requestId,
        command: "npm test",
        originalPrompt: "recursive child agents solve bug",
        message: "Awaiting baseline command execution: npm test"
      };
    });

    // Infrastructure / spawn / policy failure: blocked status and command_not_found diagnosis
    const execution: CommandExecutionRecord = {
      id: "exec_baseline_infra_fail",
      sessionId: fixture.session.id,
      requestId,
      autoRun: false,
      command: "npm test",
      cwd: fixture.workspace,
      risk: "safe",
      status: "blocked",
      exitCode: undefined,
      stdout: "",
      stderr: "command not found: npm",
      diagnosis: {
        category: "command_not_found",
        severity: "error",
        summary: "npm is not installed on path."
      },
      provenance: {
        source: "agent",
        trigger: "manual",
        requestedBy: "agent",
        sessionId: fixture.session.id,
        requestId
      },
      createdAt: new Date().toISOString()
    };
    await fixture.manager.addCommandExecution(fixture.session.id, execution);

    const outcomeService = new RuntimeSessionOutcomeService(fixture.manager);
    await outcomeService.sync(fixture.session.id);

    const session = fixture.manager.getSession(fixture.session.id)!;
    // Normal failure behavior must be preserved
    assert.equal(session.status, "failed");
    assert.equal(session.lifecycleStage, "FAILED");
    assert.equal(session.nextAction, undefined);

    // Continuation attempt must be swallowed, not resumed
    const pendingActionService = new RuntimePendingActionService(fixture.manager);
    const result = await pendingActionService.handle(session, "resume_baseline_planning");
    assert.equal(result.handled, true);
    assert.equal(result.resumePrompt, undefined);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("8. unrelated command results cannot trigger baseline continuation", async () => {
  const fixture = await createFixture();
  try {
    const baselineRequestId = "cmd_baseline_expected";
    const unrelatedRequestId = "cmd_unrelated_lint";

    await fixture.manager.addCommandRequest(fixture.session.id, {
      id: baselineRequestId,
      sessionId: fixture.session.id,
      command: "npm test",
      cwd: fixture.workspace,
      risk: "safe",
      reason: "Run baseline test",
      status: "requested",
      createdAt: new Date().toISOString()
    });
    await fixture.manager.addCommandRequest(fixture.session.id, {
      id: unrelatedRequestId,
      sessionId: fixture.session.id,
      command: "npm run lint",
      cwd: fixture.workspace,
      risk: "safe",
      reason: "Run lint command",
      status: "requested",
      createdAt: new Date().toISOString()
    });
    await fixture.manager.updateSession(fixture.session.id, (draft) => {
      draft.status = "needs_approval";
      draft.lifecycleStage = "INTAKE";
      draft.nextAction = {
        kind: "await_baseline_command",
        commandRequestId: baselineRequestId,
        command: "npm test",
        originalPrompt: "recursive child agents solve bug",
        message: "Awaiting baseline command execution: npm test"
      };
    });

    // Record an execution for the UNRELATED command
    const unrelatedExecution: CommandExecutionRecord = {
      id: "exec_unrelated_lint",
      sessionId: fixture.session.id,
      requestId: unrelatedRequestId,
      autoRun: false,
      command: "npm run lint",
      cwd: fixture.workspace,
      risk: "safe",
      status: "executed",
      exitCode: 0,
      stdout: "lint passed",
      stderr: "",
      provenance: {
        source: "agent",
        trigger: "manual",
        requestedBy: "agent",
        sessionId: fixture.session.id,
        requestId: unrelatedRequestId
      },
      createdAt: new Date().toISOString()
    };
    await fixture.manager.addCommandExecution(fixture.session.id, unrelatedExecution);

    // The baseline command has NOT executed yet
    const pendingActionService = new RuntimePendingActionService(fixture.manager);
    const result = await pendingActionService.handle(fixture.manager.getSession(fixture.session.id)!, "resume_baseline_planning");

    // Must NOT resume planning because the baseline command did not execute
    assert.equal(result.handled, true);
    assert.equal(result.resumePrompt, undefined);

    const session = fixture.manager.getSession(fixture.session.id)!;
    // Session remains waiting for the baseline command
    assert.equal(session.nextAction?.kind, "await_baseline_command");
    assert.equal(session.nextAction.commandRequestId, baselineRequestId);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

async function createFixture() {
  const workspace = path.join(os.tmpdir(), `hivo-baseline-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({ scripts: { test: "npm test" } }), "utf8");
  const manager = new SessionManager(path.join(workspace, ".runtime-test"), new EventBus(), {
    runtimeEventLoader: async () => []
  });
  await manager.load();
  const session = await manager.createSession({
    workspacePath: workspace,
    mode: "real_provider",
    executionMode: "auto_mode",
    userPrompt: "recursive child agents solve bug"
  });
  return { workspace, manager, session };
}

function planningServices(input: {
  calls: string[];
  session: AgentRuntimeSession;
  compileReady: boolean;
}): RuntimePlanningTurnServices {
  const contract = intentContract(input.compileReady ? "ready" : "needs_clarification", "recursive child agents solve bug");
  return {
    intentContract: {
      compile: async ({ originalRequest }: { originalRequest: string }) => {
        input.calls.push(`compile:${originalRequest}`);
        return {
          ready: input.compileReady,
          contract,
          blockingQuestions: input.compileReady ? [] : ["What should be built?"],
          validationErrors: [],
          errors: []
        };
      },
      blockPlanning: async ({ originalRequest }: { originalRequest: string }) => {
        input.calls.push(`block:${originalRequest}`);
        return { sessionId: input.session.id, status: "needs_approval" };
      }
    },
    recursiveSwarm: {
      run: async () => {
        input.calls.push("recursive_swarm");
        return { ...input.session, status: "completed" };
      }
    },
    recursiveFactoryPlanning: {
      startRecursiveFactory: async () => {
        input.calls.push("recursive_factory");
        return { ...input.session, status: "completed" };
      }
    },
    providerBackedSwarm: {
      run: async () => {
        input.calls.push("provider_backed_swarm");
        return { ...input.session, status: "completed" };
      }
    },
    runEngine: {
      run: async ({ prompt }: { prompt: string }) => {
        input.calls.push(`simple:${prompt}`);
        return { ...input.session, status: "completed" };
      }
    }
  } as unknown as RuntimePlanningTurnServices;
}

function intentContract(status: IntentContract["status"], request: string): IntentContract {
  return {
    version: 1,
    status,
    original_user_request: request,
    precise_rewrite: request,
    task_type: "fix",
    target_files: [],
    acceptance_criteria: [],
    constraints: [],
    assumptions: [],
    risks: [],
    blocking_questions: status === "ready" ? [] : ["What should be built?"],
    non_blocking_questions: [],
    provider_request_refs: [],
    created_at: new Date().toISOString()
  } as unknown as IntentContract;
}

function providerContext() {
  return {
    provider: {},
    routerProvider: {},
    verifierProvider: {},
    telemetry: {
      snapshot: () => ({
        providerRequestRefs: [],
        providerRequestCount: 0,
        providerFailureCount: 0,
        providerTimeoutCount: 0,
        reasoningAttempts: 0,
        repairAttempts: 0,
        finalResponseSource: "none"
      })
    }
  } as never;
}
