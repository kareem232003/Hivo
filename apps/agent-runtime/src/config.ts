import { existsSync } from "node:fs";

export type RuntimeConfig = {
  host: string;
  port: number;
  storageDir: string;
  defaultMode: "real_provider";
  providerRequestTimeoutMs: number;
  maxProviderCallsPerRun: number;
  maxRunWallClockMs: number;
  openaiApiKey?: string;
  openaiBaseUrl: string;
  agenticTaskKernelEnabled: boolean;
  agenticTaskKernelMode: "off" | "auto" | "force";
  agenticTaskMaxOpenedFiles: number;
  agenticTaskMaxRelationshipDepth: number;
  agenticTaskMaxFileChars: number;
  agenticTaskMaxTotalReadChars: number;
  agenticTaskMaxEvidenceItems: number;
  agenticTaskProviderTimeoutMs: number;
  agenticTaskAllowNaturalDraft: boolean;
  agenticTaskClaimValidationRequired: boolean;
  agenticTaskDisableGenericFallbackForComplexQuestions: boolean;
  projectExplainUseAgenticKernel: boolean;
};

export function loadConfig(): RuntimeConfig {
  return {
    host: process.env.HIVO_AGENT_HOST ?? process.env.ORCHCODE_AGENT_HOST ?? "127.0.0.1",
    port: Number(process.env.HIVO_AGENT_PORT ?? process.env.ORCHCODE_AGENT_PORT ?? "4317"),
    storageDir: process.env.HIVO_AGENT_STORAGE ?? process.env.ORCHCODE_AGENT_STORAGE ?? resolveDefaultStorageDir(),
    defaultMode: "real_provider",
    providerRequestTimeoutMs: intEnv("HIVO_PROVIDER_TIMEOUT_MS", intEnv("ORCHCODE_PROVIDER_TIMEOUT_MS", 600_000)),
    maxProviderCallsPerRun: intEnv("HIVO_RUN_MAX_PROVIDER_CALLS", 24),
    maxRunWallClockMs: intEnv("HIVO_RUN_MAX_WALL_CLOCK_MS", 1_200_000),
    openaiApiKey: process.env.OPENAI_API_KEY,
    openaiBaseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com",
    agenticTaskKernelEnabled: boolEnv("HIVO_AGENTIC_TASK_KERNEL_ENABLED", true),
    agenticTaskKernelMode: agenticModeEnv("HIVO_AGENTIC_TASK_KERNEL_MODE", "auto"),
    agenticTaskMaxOpenedFiles: intEnv("HIVO_AGENTIC_TASK_MAX_OPENED_FILES", 24),
    agenticTaskMaxRelationshipDepth: intEnv("HIVO_AGENTIC_TASK_MAX_RELATIONSHIP_DEPTH", 1),
    agenticTaskMaxFileChars: intEnv("HIVO_AGENTIC_TASK_MAX_FILE_CHARS", 24_000),
    agenticTaskMaxTotalReadChars: intEnv("HIVO_AGENTIC_TASK_MAX_TOTAL_READ_CHARS", 140_000),
    agenticTaskMaxEvidenceItems: intEnv("HIVO_AGENTIC_TASK_MAX_EVIDENCE_ITEMS", 80),
    agenticTaskProviderTimeoutMs: intEnv("HIVO_AGENTIC_TASK_PROVIDER_TIMEOUT_MS", 12_000),
    agenticTaskAllowNaturalDraft: boolEnv("HIVO_AGENTIC_TASK_ALLOW_NATURAL_DRAFT", true),
    agenticTaskClaimValidationRequired: boolEnv("HIVO_AGENTIC_TASK_CLAIM_VALIDATION_REQUIRED", true),
    agenticTaskDisableGenericFallbackForComplexQuestions: boolEnv("HIVO_AGENTIC_TASK_DISABLE_GENERIC_FALLBACK_FOR_COMPLEX_QUESTIONS", true),
    projectExplainUseAgenticKernel: boolEnv("HIVO_PROJECT_EXPLAIN_USE_AGENTIC_KERNEL", true)
  };
}

function resolveDefaultStorageDir() {
  if (existsSync(".hivo-agent-runtime")) return ".hivo-agent-runtime";
  if (existsSync(".orchcode-agent-runtime")) return ".orchcode-agent-runtime";
  return ".hivo-agent-runtime";
}

function boolEnv(name: string, fallback: boolean) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function intEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function agenticModeEnv(name: string, fallback: RuntimeConfig["agenticTaskKernelMode"]) {
  const value = process.env[name];
  return value === "off" || value === "auto" || value === "force" ? value : fallback;
}
