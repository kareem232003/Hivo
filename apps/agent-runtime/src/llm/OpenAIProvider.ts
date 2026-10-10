import { providerJsonSchema, providerJsonSchemaName, userPromptWithContext, type EmbeddingRequest, type EmbeddingResponse, type LlmProvider, type LlmRequest } from "./LlmProvider.js";
import { normalizeStructuredOutputCandidate, validateStructuredOutput } from "../schemas/validators.js";

export class OpenAIProvider implements LlmProvider {
  constructor(
    private readonly apiKey?: string,
    private readonly baseUrl = "https://api.openai.com",
    private readonly model = "gpt-4o-mini",
    private readonly timeoutMs = 90_000,
    private readonly embeddingModel?: string
  ) {}

  async generateStructured<T>(input: LlmRequest, _schema: unknown): Promise<T> {
    const text = await this.generateText({
      ...input,
      responseFormat: "json",
      structuredSchema: _schema,
      userPrompt: `${input.userPrompt}\n\nReturn only strict JSON. Do not wrap it in markdown.`
    });
    for (const candidate of [text, extractJsonObject(text)]) {
      if (!candidate) continue;
      try {
        const parsed = JSON.parse(candidate) as T;
        const normalized = normalizeStructuredOutputCandidate(parsed, _schema);
        const validation = validateStructuredOutput(normalized, _schema);
        if (!validation.valid) continue;
        return normalized;
      } catch {
        // Try the next candidate before reporting the malformed response.
      }
    }
    throw new Error("openai_compatible.invalid_json: provider returned malformed structured JSON.");
  }

  async generateText(input: LlmRequest): Promise<string> {
    if (!this.apiKey) {
      throw new Error("OPENAI_API_KEY is not configured. Configure a real provider before starting a session.");
    }
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.min(this.timeoutMs, input.timeoutMs ?? this.timeoutMs, input.providerRunBudget?.remainingMs() ?? this.timeoutMs)
    );
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: input.systemPrompt },
            { role: "user", content: userPromptWithContext(input) }
          ],
          ...(input.responseFormat === "json" ? {
            response_format: providerJsonSchema(input.structuredSchema)
              ? {
                  type: "json_schema",
                  json_schema: {
                    name: providerJsonSchemaName(input.structuredSchema),
                    strict: false,
                    schema: providerJsonSchema(input.structuredSchema)
                  }
                }
              : { type: "json_object" }
          } : {}),
          ...(input.responseFormat === "json" ? { max_tokens: input.maxOutputTokens ?? 2_048 } : {}),
          temperature: 0.1
        }),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`openai_compatible.http_${response.status}: ${await response.text()}`);
      }
      const body = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
        error?: { message?: string };
      };
      if (body.error?.message) {
        throw new Error(`openai_compatible.error: ${body.error.message}`);
      }
      const content = body.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error("openai_compatible.malformed_response: missing choices[0].message.content");
      }
      return content;
    } catch (error) {
      if (String(error).includes("AbortError")) {
        throw new Error("openai_compatible.timeout: request timed out");
      }
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(timeout);
    }
  }

  async embed(input: EmbeddingRequest): Promise<EmbeddingResponse> {
    if (!this.apiKey) throw new Error("OPENAI_API_KEY is not configured.");
    const model = input.model ?? this.embeddingModel;
    if (!model) throw new Error("openai_compatible.embedding_model_missing");
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.min(this.timeoutMs, input.timeoutMs ?? this.timeoutMs, input.providerRunBudget?.remainingMs() ?? this.timeoutMs)
    );
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/v1/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({ model, input: input.inputs }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`openai_compatible.embedding_http_${response.status}: ${await response.text()}`);
      const body = await response.json() as { data?: Array<{ embedding?: number[]; index?: number }>; model?: string };
      const vectors = [...(body.data ?? [])]
        .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
        .map((entry) => entry.embedding ?? []);
      if (vectors.length !== input.inputs.length || vectors.some((vector) => !vector.length)) {
        throw new Error("openai_compatible.embedding_malformed_response");
      }
      return { model: body.model ?? model, vectors };
    } catch (error) {
      if (String(error).includes("AbortError")) throw new Error("openai_compatible.embedding_timeout");
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
