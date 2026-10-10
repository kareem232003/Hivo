import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRuntimeSession, SanitizedProviderConfig } from "@hivo/protocol";
import type { LlmProvider, LlmRequest } from "../llm/LlmProvider.js";
import { RuntimeProviderContextService } from "../runtime/RuntimeProviderContextService.js";

test("runtime provider context creates specialized router and verifier providers", async () => {
  const createdModels: string[] = [];
  const service = new RuntimeProviderContextService({
    providerRequestTimeoutMs: 1234,
    getProvider: () => new NamedProvider("author"),
    createProvider: (config) => {
      createdModels.push(config?.selectedModel ?? "missing");
      return new NamedProvider(config?.selectedModel ?? "missing");
    },
    useSessionProviderForSpecializedModels: false
  });

  const context = service.create(session(providerConfig({
    selectedModel: "author-model",
    routerModel: "router-model",
    verifierModel: "verifier-model"
  })));

  assert.equal(await context.provider.generateText(request()), "author");
  assert.equal(await context.routerProvider.generateText(request()), "router-model");
  assert.equal(await context.verifierProvider.generateText(request()), "verifier-model");
  assert.deepEqual(createdModels, ["router-model", "verifier-model"]);
  assert.equal(context.telemetry.snapshot().providerRequestCount, 3);
});

test("runtime provider context reuses session provider when provider factory owns model selection", async () => {
  const createdModels: string[] = [];
  const service = new RuntimeProviderContextService({
    providerRequestTimeoutMs: 1234,
    getProvider: () => new NamedProvider("factory-provider"),
    createProvider: (config) => {
      createdModels.push(config?.selectedModel ?? "missing");
      return new NamedProvider(config?.selectedModel ?? "missing");
    },
    useSessionProviderForSpecializedModels: true
  });

  const context = service.create(session(providerConfig({
    selectedModel: "author-model",
    routerModel: "router-model",
    verifierModel: "verifier-model"
  })));

  assert.equal(await context.provider.generateText(request()), "factory-provider");
  assert.equal(await context.routerProvider.generateText(request()), "factory-provider");
  assert.equal(await context.verifierProvider.generateText(request()), "factory-provider");
  assert.deepEqual(createdModels, []);
  assert.equal(context.telemetry.snapshot().providerRequestCount, 3);
});

test("author, router, and verifier providers share one per-run call limit", async () => {
  let dispatched = 0;
  const service = new RuntimeProviderContextService({
    providerRequestTimeoutMs: 1234,
    maxProviderCallsPerRun: 2,
    maxRunWallClockMs: 10_000,
    getProvider: () => new NamedProvider("author", () => dispatched++),
    createProvider: (config) => new NamedProvider(config?.selectedModel ?? "missing", () => dispatched++),
    useSessionProviderForSpecializedModels: false
  });
  const context = service.create(session(providerConfig({
    selectedModel: "author-model",
    routerModel: "router-model",
    verifierModel: "verifier-model"
  })));

  const results = await Promise.allSettled([
    context.provider.generateText(request()),
    context.routerProvider.generateText(request()),
    context.verifierProvider.generateText(request())
  ]);

  assert.equal(dispatched, 2);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
  assert.equal(context.telemetry.snapshot().providerRequestCount, 2);
});

function session(providerConfig: SanitizedProviderConfig): AgentRuntimeSession {
  return ({
    id: "session-provider-context",
    mode: "real_provider",
    activeProviderSource: "session_override",
    providerConfig
  } as unknown) as AgentRuntimeSession;
}

function providerConfig(input: Pick<SanitizedProviderConfig, "selectedModel" | "routerModel" | "verifierModel">): SanitizedProviderConfig {
  return {
    providerType: "ollama",
    providerName: "Ollama",
    baseUrl: "http://127.0.0.1:11434",
    isValid: true,
    ...input
  };
}

function request(): LlmRequest {
  return {
    purpose: "route",
    systemPrompt: "test",
    userPrompt: "test"
  };
}

class NamedProvider implements LlmProvider {
  constructor(private readonly name: string, private readonly onCall: () => void = () => {}) {}

  async generateText(): Promise<string> {
    this.onCall();
    return this.name;
  }

  async generateStructured<T>(): Promise<T> {
    return { name: this.name } as T;
  }
}
