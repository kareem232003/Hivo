import { providerJsonSchema, userPromptWithContext, type EmbeddingRequest, type EmbeddingResponse, type LlmProvider, type LlmRequest } from "./LlmProvider.js";
import { normalizeStructuredOutputCandidate, validateStructuredOutput } from "../schemas/validators.js";

type OllamaChatResponse = {
  message?: {
    content?: string;
  };
  error?: string;
};

export class OllamaProvider implements LlmProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly timeoutMs = 60_000,
    private readonly embeddingModel?: string
  ) {}

  async generateStructured<T>(input: LlmRequest, _schema: unknown): Promise<T> {
    const maxAttempts = 3;
    let lastError = "";
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (attempt > 0) {
        await waitForRetry(input, Math.min(1000 * 2 ** attempt, 8_000));
        input.providerRunBudget?.reserveCall();
      }
      let text: string;
      try {
        text = await this.generateText({
          ...input,
          responseFormat: "json",
          structuredSchema: _schema,
          maxOutputTokens: Math.max(input.maxOutputTokens ?? 0, 8_192),
          userPrompt: attempt === 0
            ? `${input.userPrompt}\n\nReturn only strict JSON. Do not wrap it in markdown.`
            : `${input.userPrompt}\n\nYour previous response had a JSON error: ${lastError}\n\nReturn only strict valid JSON. Do not wrap it in markdown.`
        });
      } catch (error) {
        lastError = String(error);
        const errorStr = String(error);
        if (
          attempt < maxAttempts - 1 &&
          (errorStr.includes("real_provider.unreachable") || errorStr.includes("real_provider.malformed_response"))
        ) {
          continue;
        }
        throw new Error(`real_provider.invalid_json: Ollama returned malformed structured JSON. ${lastError}`);
      }
      for (const candidate of [text, extractJsonObject(text)]) {
        if (!candidate) continue;
        try {
          const parsed = JSON.parse(candidate) as T;
          const normalized = normalizeStructuredOutputCandidate(parsed, _schema);
          const validation = validateStructuredOutput(normalized, _schema);
          if (!validation.valid) {
            lastError = `schema_validation_failed: ${validation.errors.join("; ")}`;
            continue;
          }
          return normalized;
        } catch (error) {
          lastError = String(error);
        }
      }
    }
    throw new Error(`real_provider.invalid_json: Ollama returned malformed structured JSON. ${lastError}`);
  }

  async generateText(input: LlmRequest): Promise<string> {
    const maxRetries = 2;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (attempt > 0) {
        await waitForRetry(input, Math.min(1000 * 2 ** attempt, 8_000));
        input.providerRunBudget?.reserveCall();
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs(input));
      try {
        const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: this.model,
            stream: false,
            keep_alive: "30m",
            ...(input.responseFormat === "json"
              ? {
                  format:
                    attempt === 0
                      ? providerJsonSchema(input.structuredSchema) ?? "json"
                      : "json"
                }
              : {}),
            options: {
              temperature: input.responseFormat === "json" ? 0 : 0.1,
              num_predict: input.maxOutputTokens ?? 4_096
            },
            messages: [
              { role: "system", content: input.systemPrompt ?? "" },
              { role: "user", content: userPromptWithContext(input) }
            ]
          }),
          signal: controller.signal
        });
        if (!response.ok) {
          if (attempt < maxRetries) {
            continue;
          }
          throw new Error(`real_provider.unreachable: Ollama returned HTTP ${response.status}`);
        }
        const body = (await response.json()) as OllamaChatResponse;
        if (body.error) {
          if (attempt < maxRetries) {
            continue;
          }
          throw new Error(`real_provider.malformed_response: ${body.error}`);
        }
        const content = body.message?.content;
        if (!content) throw new Error("real_provider.malformed_response: missing message.content");
        return content;
      } catch (error) {
        if (String(error).includes("AbortError")) {
          throw new Error("real_provider.timeout: Ollama request timed out");
        }
        if (attempt < maxRetries && !String(error).includes("real_provider.timeout")) {
          continue;
        }
        throw error instanceof Error ? error : new Error(String(error));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new Error("real_provider.unreachable: Ollama request failed after retries");
  }

  private requestTimeoutMs(input: LlmRequest) {
    if (!input.providerRunBudget) return Math.max(this.timeoutMs, input.timeoutMs ?? this.timeoutMs);
    return Math.min(this.timeoutMs, input.timeoutMs ?? this.timeoutMs, input.providerRunBudget.remainingMs());
  }

  async embed(input: EmbeddingRequest): Promise<EmbeddingResponse> {
    const model = input.model ?? this.embeddingModel;
    if (!model) throw new Error("real_provider.embedding_model_missing");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, input.timeoutMs ?? this.timeoutMs, input.providerRunBudget?.remainingMs() ?? this.timeoutMs));
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: input.inputs }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`real_provider.embedding_http_${response.status}`);
      const body = await response.json() as { embeddings?: number[][]; model?: string; error?: string };
      if (body.error) throw new Error(`real_provider.embedding_error: ${body.error}`);
      if (!body.embeddings || body.embeddings.length !== input.inputs.length || body.embeddings.some((vector) => !vector.length)) {
        throw new Error("real_provider.embedding_malformed_response");
      }
      return { model: body.model ?? model, vectors: body.embeddings };
    } catch (error) {
      if (String(error).includes("AbortError")) throw new Error("real_provider.embedding_timeout");
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(timeout);
    }
  }
}

function extractJsonObject(text: string) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRetry(input: LlmRequest, delayMs: number) {
  const remainingMs = input.providerRunBudget?.assertAvailable();
  if (remainingMs !== undefined && delayMs >= remainingMs) {
    throw new Error(`provider_budget_exhausted:wall_clock:${input.providerRunBudget?.maxElapsedMs}`);
  }
  await sleep(delayMs);
}
