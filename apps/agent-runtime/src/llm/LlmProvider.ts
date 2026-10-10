import type { ProviderPipelineStage, ReasoningStage } from "@hivo/protocol";

import { performance } from "node:perf_hooks";

export type LlmRequest = {
  systemPrompt: string;
  userPrompt: string;
  context?: unknown;
  purpose?: ProviderPipelineStage;
  reasoningStage?: ReasoningStage;
  timeoutMs?: number;
  maxOutputTokens?: number;
  maxContextChars?: number;
  responseFormat?: "json";
  structuredSchema?: unknown;
  providerRunBudget?: ProviderRunBudget;
};

export type EmbeddingRequest = {
  inputs: string[];
  model?: string;
  timeoutMs?: number;
  providerRunBudget?: ProviderRunBudget;
};

export class ProviderRunBudget {
  private usedCalls = 0;
  private readonly startedAt = performance.now();

  constructor(
    readonly maxCalls: number,
    readonly maxElapsedMs: number
  ) {}

  reserveCall(): number {
    const remainingMs = this.assertAvailable();
    this.usedCalls += 1;
    return remainingMs;
  }

  assertAvailable(): number {
    const remainingMs = this.remainingMs();
    if (this.usedCalls >= this.maxCalls) {
      throw new Error(`provider_budget_exhausted:model_calls:${this.maxCalls}`);
    }
    return remainingMs;
  }

  remainingMs(): number {
    const remainingMs = this.maxElapsedMs - (performance.now() - this.startedAt);
    if (remainingMs <= 0) {
      throw new Error(`provider_budget_exhausted:wall_clock:${this.maxElapsedMs}`);
    }
    return remainingMs;
  }

  get callCount() {
    return this.usedCalls;
  }
}

export type EmbeddingResponse = {
  model: string;
  vectors: number[][];
};

export interface LlmProvider {
  generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T>;
  generateText(input: LlmRequest): Promise<string>;
  embed?(input: EmbeddingRequest): Promise<EmbeddingResponse>;
}

export function providerJsonSchema(schema: unknown) {
  if (!schema || typeof schema !== "object" || !("type" in schema)) return undefined;
  const { name: _name, ...jsonSchema } = schema as Record<string, unknown>;
  return jsonSchema;
}

export function providerJsonSchemaName(schema: unknown) {
  const raw = schema && typeof schema === "object" && "name" in schema
    ? String((schema as { name: unknown }).name)
    : "structured_result";
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "structured_result";
}

const DEFAULT_MAX_RENDERED_CONTEXT_CHARS = 128_000;

export function userPromptWithContext(input: LlmRequest): string {
  if (input.context === undefined) return input.userPrompt;
  const rendered = renderProviderContext(input.context, input.maxContextChars ?? DEFAULT_MAX_RENDERED_CONTEXT_CHARS);
  if (!rendered) return input.userPrompt;
  return [
    input.userPrompt,
    "",
    "Provider context:",
    "```json",
    rendered,
    "```"
  ].join("\n");
}

function renderProviderContext(context: unknown, maxChars: number) {
  let rendered: string;
  try {
    rendered = JSON.stringify(context, null, 2);
  } catch {
    rendered = String(context);
  }
  if (!rendered || rendered === "null") return "";
  if (rendered.length > maxChars) {
    throw new Error(`provider.context_too_large:${rendered.length}:${maxChars}`);
  }
  return rendered;
}
