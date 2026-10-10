import type {
  ActiveProviderSource,
  AgentRuntimeMode,
  ProviderPromptLatency,
  ProviderTruthTelemetry,
  SanitizedProviderConfig
} from "@hivo/protocol";
import { ProviderRunBudget, type EmbeddingRequest, type EmbeddingResponse, type LlmProvider, type LlmRequest } from "./LlmProvider.js";

export const DEFAULT_RUN_MAX_PROVIDER_CALLS = 24;
export const DEFAULT_RUN_MAX_WALL_CLOCK_MS = 1_200_000;

type ProviderTelemetryInput = {
  mode: AgentRuntimeMode;
  providerConfig?: SanitizedProviderConfig;
  activeProviderSource?: ActiveProviderSource;
  modelCertification?: ProviderTruthTelemetry["modelCertification"];
  maxProviderCalls?: number;
  maxElapsedMs?: number;
};

type ProviderRequestType = ProviderPromptLatency["requestType"];

export class ProviderTelemetryRecorder {
  private providerRequestCount = 0;
  private providerResponseCount = 0;
  private providerFailureCount = 0;
  private providerTimeoutCount = 0;
  private totalProviderLatencyMs = 0;
  private totalProviderPromptChars = 0;
  private totalProviderResponseChars = 0;
  private totalProviderContextChars = 0;
  private perPromptProviderLatencyMs: ProviderPromptLatency[] = [];
  private lastError: string | undefined;
  private finalResponseSource: ProviderTruthTelemetry["finalResponseSource"] = "none";
  private terminalFailure: string | undefined;

  private readonly runBudget: ProviderRunBudget;

  constructor(private readonly input: ProviderTelemetryInput) {
    this.runBudget = new ProviderRunBudget(
      input.maxProviderCalls ?? DEFAULT_RUN_MAX_PROVIDER_CALLS,
      input.maxElapsedMs ?? DEFAULT_RUN_MAX_WALL_CLOCK_MS
    );
  }

  async measure<T>(
    requestType: ProviderRequestType,
    request: LlmRequest,
    operation: (boundedRequest: LlmRequest) => Promise<T>
  ): Promise<T> {
    const requestId = `provider_${Date.now()}_${this.providerRequestCount + 1}`;
    const promptSize = measureProviderPromptSize(request);
    const startedAt = Date.now();
    try {
      const remainingMs = this.runBudget.reserveCall();
      this.providerRequestCount += 1;
      const boundedRequest: LlmRequest = {
        ...request,
        timeoutMs: Math.min(request.timeoutMs ?? remainingMs, remainingMs),
        providerRunBudget: this.runBudget
      };
      const result = await operation(boundedRequest);
      this.recordLatency({
        requestId,
        requestType,
        purpose: request.purpose,
        reasoningStage: request.reasoningStage,
        latencyMs: Date.now() - startedAt,
        status: "success",
        ...promptSize,
        responseChars: estimateSerializedChars(result),
        maxOutputTokens: request.maxOutputTokens
      });
      this.providerResponseCount += 1;
      if (!this.terminalFailure) this.lastError = undefined;
      return result;
    } catch (error) {
      this.markProviderError(error);
      const timeout = isProviderTimeout(error);
      this.recordLatency({
        requestId,
        requestType,
        purpose: request.purpose,
        reasoningStage: request.reasoningStage,
        latencyMs: Date.now() - startedAt,
        status: timeout ? "timeout" : "failure",
        errorSummary: summarizeProviderError(error),
        ...promptSize,
        maxOutputTokens: request.maxOutputTokens
      });
      this.providerFailureCount += 1;
      if (timeout) this.providerTimeoutCount += 1;
      throw error;
    }
  }

  markProviderError(error: unknown) {
    this.lastError = summarizeProviderError(error);
  }

  markProviderAuthoredResponse() {
    this.finalResponseSource = "provider";
  }

  markTerminalFailure(error: unknown) {
    this.terminalFailure = summarizeProviderError(error);
    this.lastError = this.terminalFailure;
    this.finalResponseSource = "none";
  }

  snapshot(): ProviderTruthTelemetry {
    const providerName = this.providerName();
    const modelName = this.modelName();
    return {
      providerMode: this.input.mode,
      providerName,
      modelName,
      providerBaseUrl: sanitizeProviderBaseUrl(this.input.providerConfig?.baseUrl),
      providerRequestCount: this.runBudget.callCount,
      realProviderRequestCount: this.runBudget.callCount,
      providerResponseCount: this.providerResponseCount,
      providerFailureCount: this.providerFailureCount,
      providerTimeoutCount: this.providerTimeoutCount,
      totalProviderLatencyMs: this.totalProviderLatencyMs,
      totalProviderPromptChars: this.totalProviderPromptChars,
      totalProviderResponseChars: this.totalProviderResponseChars,
      totalProviderContextChars: this.totalProviderContextChars,
      perPromptProviderLatencyMs: this.perPromptProviderLatencyMs,
      lastError: this.lastError,
      reasoningAttempts: this.perPromptProviderLatencyMs.filter((entry) => entry.purpose === "route" || entry.purpose === "reason").length,
      repairAttempts: this.perPromptProviderLatencyMs.filter((entry) => entry.purpose === "repair").length,
      providerRequestRefs: this.perPromptProviderLatencyMs.map((entry) => entry.requestId),
      finalResponseSource: this.finalResponseSource,
      terminalFailure: this.terminalFailure,
      modelCertification: this.input.modelCertification ?? {
        status: "uncertified",
        routerModel: this.input.providerConfig?.routerModel ?? modelName,
        authorModel: modelName,
        verifierModel: this.input.providerConfig?.verifierModel ?? modelName,
        reason: "No certification registry was supplied to provider telemetry."
      },
      activeProviderSource: this.input.activeProviderSource ?? "unknown",
      updatedAt: new Date().toISOString()
    };
  }

  private recordLatency(input: Omit<ProviderPromptLatency, "providerName" | "modelName">) {
    this.totalProviderLatencyMs += input.latencyMs;
    this.totalProviderPromptChars += input.promptChars ?? 0;
    this.totalProviderResponseChars += input.responseChars ?? 0;
    this.totalProviderContextChars += input.contextChars ?? 0;
    this.perPromptProviderLatencyMs.push({
      ...input,
      providerName: this.providerName(),
      modelName: this.modelName()
    });
  }

  private providerName() {
    return this.input.providerConfig?.providerName || this.input.providerConfig?.providerType || "real_provider";
  }

  private modelName() {
    return this.input.providerConfig?.selectedModel;
  }
}

export class TelemetryLlmProvider implements LlmProvider {
  constructor(
    private readonly inner: LlmProvider,
    private readonly recorder: ProviderTelemetryRecorder
  ) {}

  generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    return this.recorder.measure("structured", input, (boundedRequest) => this.inner.generateStructured<T>(boundedRequest, schema));
  }

  generateText(input: LlmRequest): Promise<string> {
    return this.recorder.measure("text", input, (boundedRequest) => this.inner.generateText(boundedRequest));
  }

  embed(input: EmbeddingRequest): Promise<EmbeddingResponse> {
    if (!this.inner.embed) return Promise.reject(new Error("provider.embedding_not_supported"));
    const request: LlmRequest = {
      purpose: "retrieve",
      systemPrompt: "Embedding request",
      userPrompt: input.inputs.join("\n")
    };
    return this.recorder.measure("structured", request, (boundedRequest) => this.inner.embed!({
      ...input,
      timeoutMs: boundedRequest.timeoutMs,
      providerRunBudget: boundedRequest.providerRunBudget
    }));
  }
}

export function createProviderTelemetryRecorder(input: ProviderTelemetryInput) {
  return new ProviderTelemetryRecorder({
    ...input,
    activeProviderSource: input.activeProviderSource ?? inferActiveProviderSource(input.mode, input.providerConfig)
  });
}

export function inferActiveProviderSource(
  mode: AgentRuntimeMode,
  providerConfig?: SanitizedProviderConfig
): ActiveProviderSource {
  if (providerConfig?.isValid) return "session_override";
  return "unknown";
}

function sanitizeProviderBaseUrl(baseUrl: string | undefined) {
  if (!baseUrl) return undefined;
  try {
    const parsed = new URL(baseUrl);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return baseUrl.replace(/\/\/[^/@]+@/, "//[redacted]@").split("?")[0];
  }
}

function isProviderTimeout(error: unknown) {
  const text = summarizeProviderError(error);
  return /\b(timeout|timed out|abort|aborted|AbortError)\b/i.test(text);
}

function summarizeProviderError(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function measureProviderPromptSize(request: LlmRequest) {
  const systemPromptChars = request.systemPrompt.length;
  const userPromptChars = request.userPrompt.length;
  const contextChars = request.context === undefined ? 0 : estimateSerializedChars(request.context);
  return {
    systemPromptChars,
    userPromptChars,
    contextChars,
    promptChars: systemPromptChars + userPromptChars + contextChars
  };
}

function estimateSerializedChars(value: unknown, depth = 0, seen = new WeakSet<object>()): number {
  if (value === null) return 4;
  if (typeof value === "string") return value.length + 2;
  if (typeof value === "number" || typeof value === "boolean") return String(value).length;
  if (typeof value === "undefined") return 0;
  if (typeof value !== "object") return String(value).length;
  if (seen.has(value)) return 12;
  if (depth > 6) return 64;
  seen.add(value);
  if (Array.isArray(value)) {
    return 2 + value.reduce((sum, item, index) => sum + (index ? 1 : 0) + estimateSerializedChars(item, depth + 1, seen), 0);
  }
  return 2 + Object.entries(value as Record<string, unknown>).reduce((sum, [key, entry]) => {
    return sum + key.length + 3 + estimateSerializedChars(entry, depth + 1, seen);
  }, 0);
}
