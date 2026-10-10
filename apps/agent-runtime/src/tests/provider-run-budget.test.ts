import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProjectMap } from "@hivo/protocol";
import type { LlmProvider, LlmRequest } from "../llm/LlmProvider.js";
import { OllamaProvider } from "../llm/OllamaProvider.js";
import { ProviderTelemetryRecorder, TelemetryLlmProvider } from "../llm/ProviderTelemetry.js";
import { RecursiveSwarmOrchestrator } from "../orchestration/RecursiveSwarmOrchestrator.js";
import { RuntimeDirectTurnService } from "../runtime/RuntimeDirectTurnService.js";
import { RuntimeRecursiveSwarmService } from "../runtime/RuntimeRecursiveSwarmService.js";
import { EventBus } from "../runtime/EventBus.js";
import { SessionManager } from "../runtime/SessionManager.js";

test("one shared provider budget gates concurrent calls before dispatch", async () => {
  let dispatched = 0;
  const telemetry = recorder({ maxProviderCalls: 2, maxElapsedMs: 10_000 });
  const provider = new TelemetryLlmProvider(
    new CountingProvider(() => {
      dispatched += 1;
      return "ok";
    }),
    telemetry
  );

  const results = await Promise.allSettled([
    provider.generateText(request()),
    provider.generateText(request()),
    provider.generateText(request())
  ]);

  assert.equal(dispatched, 2);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.match(String((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason), /provider_budget_exhausted:model_calls:2/);
  assert.equal(telemetry.snapshot().providerRequestCount, 2);
});

test("provider request timeout is capped by the shared run deadline", async () => {
  let observedTimeout: number | undefined;
  const provider = new TelemetryLlmProvider({
    async generateText(input) {
      observedTimeout = input.timeoutMs;
      return "ok";
    },
    async generateStructured<T>() {
      return {} as T;
    }
  }, recorder({ maxProviderCalls: 2, maxElapsedMs: 60_000 }));

  await provider.generateText({ ...request(), timeoutMs: 120_000 });

  assert.ok(observedTimeout !== undefined && observedTimeout <= 60_000);
});

test("native Ollama request is aborted when its remaining run budget expires", async () => {
  const originalFetch = globalThis.fetch;
  let aborted = false;
  globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    signal?.addEventListener("abort", () => {
      aborted = true;
      reject(new DOMException("The operation was aborted.", "AbortError"));
    }, { once: true });
  });
  const telemetry = recorder({ maxProviderCalls: 2, maxElapsedMs: 20 });
  const provider = new TelemetryLlmProvider(
    new OllamaProvider("http://127.0.0.1:11434", "offline-test-model", 60_000),
    telemetry
  );
  try {
    await assert.rejects(provider.generateText(request()), /real_provider\.timeout/);
    assert.equal(aborted, true);
    assert.equal(telemetry.snapshot().providerRequestCount, 1);
    assert.equal(telemetry.snapshot().providerTimeoutCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("expired run deadline blocks later calls without dispatch", async () => {
  let dispatched = 0;
  const telemetry = recorder({ maxProviderCalls: 2, maxElapsedMs: 2 });
  const provider = new TelemetryLlmProvider(
    new CountingProvider(() => {
      dispatched += 1;
      return "ok";
    }),
    telemetry
  );

  await new Promise((resolve) => setTimeout(resolve, 10));
  await assert.rejects(provider.generateText(request()), /provider_budget_exhausted:wall_clock:2/);
  assert.equal(dispatched, 0);
  assert.equal(telemetry.snapshot().providerRequestCount, 0);
});

test("Ollama retries consume the same provider-call budget", async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return new Response("temporarily unavailable", { status: 503 });
  };
  const telemetry = recorder({ maxProviderCalls: 1, maxElapsedMs: 10_000 });
  const provider = new TelemetryLlmProvider(
    new OllamaProvider("http://127.0.0.1:11434", "offline-test-model", 1_000),
    telemetry
  );
  try {
    await assert.rejects(provider.generateText(request()), /provider_budget_exhausted:model_calls:1/);
    assert.equal(fetches, 1);
    assert.equal(telemetry.snapshot().providerRequestCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Ollama structured-output recovery is charged to the same provider-call budget", async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return Response.json({ message: { content: "not valid JSON" } });
  };
  const telemetry = recorder({ maxProviderCalls: 1, maxElapsedMs: 10_000 });
  const provider = new TelemetryLlmProvider(
    new OllamaProvider("http://127.0.0.1:11434", "offline-test-model", 1_000),
    telemetry
  );
  try {
    await assert.rejects(
      provider.generateStructured(request(), { type: "object" }),
      /provider_budget_exhausted:model_calls:1/
    );
    assert.equal(fetches, 1);
    assert.equal(telemetry.snapshot().providerRequestCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("recursive manager, workers, collectors and goal checks share one exhausted run budget", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hivo-recursive-budget-"));
  const requestNames: string[] = [];
  const telemetry = recorder({ maxProviderCalls: 10, maxElapsedMs: 60_000 });
  const provider = new TelemetryLlmProvider(
    recursiveProvider(requestNames),
    telemetry
  );
  try {
    const result = await new RecursiveSwarmOrchestrator({
      provider,
      workspacePath: workspace,
      options: {
        maxDepth: 3,
        maxAgents: 10,
        softMaxAgents: 8,
        maxChildrenPerParent: 4,
        maxWriteExecutors: 2,
        enableParallelExecution: true,
        enableErrorRecovery: true,
        enableGoalKeeper: true
      }
    }).run("Implement promotion support in checkout", "budget-test");

    assert.equal(telemetry.snapshot().providerRequestCount, 10);
    assert.equal(requestNames.filter((name) => name === "goal_check").length, 3);
    assert.equal(requestNames.filter((name) => name === "atomicity_assessment").length, 3);
    assert.ok(requestNames.includes("split_result"), "manager decomposition uses the shared provider");
    assert.ok(requestNames.includes("structured_node_output"), "worker output uses the shared provider");
    assert.ok(Object.values(result.tree.nodes).some((node) => node.kind === "task_agent"));
    assert.ok(Object.values(result.tree.nodes).some((node) => node.kind === "collector"));
    assert.equal(result.tree.status, "failed");
    assert.ok(result.unresolvedErrors.some((error) => error.includes("provider_budget_exhausted:model_calls:10")));
    assert.ok(result.unresolvedErrors.some((error) => error.includes("hierarchical collection merge failed")));
    assert.ok(Object.values(result.tree.nodes).some((node) =>
      node.goalChecks.some((check) => check.findings.includes("provider_failed"))
    ));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("recursive plan mode cannot report a failed budget-limited root as ready", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hivo-recursive-plan-budget-"));
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "src", "checkout.js"), "export function checkout() {}\n");
  const storage = path.join(workspace, ".agent_memory");
  const sessionManager = new SessionManager(storage, new EventBus());
  await sessionManager.load();
  const session = await sessionManager.createSession({
    workspacePath: workspace,
    mode: "real_provider",
    userPrompt: "Implement promotion support in checkout"
  });
  const telemetry = recorder({ maxProviderCalls: 1, maxElapsedMs: 60_000 });
  const provider = new TelemetryLlmProvider(recursiveProvider([]), telemetry);
  const service = new RuntimeRecursiveSwarmService(sessionManager, new RuntimeDirectTurnService(sessionManager));
  try {
    const result = await service.run({
      sessionId: session.id,
      message: "Implement promotion support in checkout",
      provider,
      providerTelemetry: telemetry,
      projectMap: projectMap(),
      thinkFirst: true
    });

    assert.equal(result.status, "failed");
    assert.equal(result.lifecycleStage, "FAILED");
    assert.equal(result.nextAction, undefined);
    assert.notEqual(result.runSummary?.gates[0]?.status, "passed");
    assert.equal(result.recursiveSwarmRunState?.planState, undefined);
    assert.match(result.runSummary?.summary ?? "", /provider_budget_exhausted:model_calls:1/);
    assert.ok(!result.messages.some((message) =>
      message.role === "assistant" && message.content.includes("If the plan looks right")
    ));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

function recorder(input: { maxProviderCalls: number; maxElapsedMs: number }) {
  return new ProviderTelemetryRecorder({
    mode: "real_provider",
    ...input
  });
}

function recursiveProvider(requestNames: string[]): LlmProvider {
  return {
    async generateStructured<T>(request: LlmRequest, schema: unknown): Promise<T> {
      const name = schema && typeof schema === "object" && "name" in schema
        ? String((schema as { name: unknown }).name)
        : "";
      requestNames.push(name);
      if (name === "expanded_goal_spec") {
        return {
          isAlreadyDetailed: true,
          expandedGoal: request.userPrompt,
          requirements: ["Implement promotion lookup and discount math", "Apply discounts before tax"],
          acceptanceCriteria: ["Promotion checkout works"],
          deliverableContract: "Implement the requested checkout feature.",
          constraints: [],
          nonGoals: [],
          qualityBar: ["Correct results"]
        } as T;
      }
      if (name === "goal_check") {
        return { aligned: true, status: "aligned", findings: [], warnings: [] } as T;
      }
      if (name === "atomicity_assessment") {
        const root = request.userPrompt.includes("DEPTH: 0");
        return root
          ? { isAtomic: false, score: 6, rationale: "Needs separate policy and checkout work.", failures: ["MULTIPLE_STEPS"] } as T
          : { isAtomic: true, score: 2, rationale: "One bounded implementation task.", failures: [] } as T;
      }
      if (name === "split_result") {
        return {
          shouldSplit: true,
          desiredChildCount: 2,
          splitReason: "Separate reusable discount policy from dependent checkout integration.",
          subTasks: [
            {
              id: "pricing-policy",
              title: "Implement promotion pricing policy",
              taskPrompt: "Implement promotion lookup and discount calculation in the pricing module.",
              expectedOutput: "Concrete source change implementing promotion discount calculations.",
              dependencies: [],
              responsibility: "IMPLEMENT",
              canWrite: true,
              acceptanceCriteria: ["Unknown codes are rejected", "Fixed discounts are capped"]
            },
            {
              id: "checkout-integration",
              title: "Integrate promotion in checkout",
              taskPrompt: "Apply the verified promotion policy to checkout totals before tax.",
              expectedOutput: "Concrete checkout source change applying discount before tax.",
              dependencies: ["0"],
              responsibility: "IMPLEMENT",
              canWrite: true,
              acceptanceCriteria: ["No-code totals remain unchanged"]
            }
          ],
          stopConditions: [],
          rationale: "Checkout integration depends on the policy interface."
        } as T;
      }
      if (name === "structured_node_output") {
        return {
          kind: "edit_intent",
          target_file: "src/pricing/discount.js",
          target_symbol_or_range: "calculateDiscountCents",
          operation: "modify",
          reason: "Implement promotion discount behavior.",
          expected_behavior: "Calculates percentage and capped fixed discounts.",
          risk: "low",
          evidence_refs: []
        } as T;
      }
      throw new Error(`Unexpected recursive test schema: ${name}`);
    },
    async generateText(request: LlmRequest): Promise<string> {
      requestNames.push(`text:${request.purpose ?? "unspecified"}`);
      return "Collected child work and unresolved items.";
    }
  };
}

function projectMap(): ProjectMap {
  return {
    stack: ["javascript", "node"],
    packageManagers: ["npm"],
    entryPoints: ["src/checkout/checkout.js"],
    importantFiles: ["src/checkout/checkout.js", "src/pricing/discount.js"],
    testCommands: ["npm test"]
  };
}

function request(): LlmRequest {
  return { systemPrompt: "test", userPrompt: "test" };
}

class CountingProvider implements LlmProvider {
  constructor(private readonly respond: () => string) {}

  async generateText(): Promise<string> {
    return this.respond();
  }

  async generateStructured<T>(): Promise<T> {
    return {} as T;
  }
}
