import type {
  AccessProfile,
  AgentScopedMessageResponse,
  AgentRuntimeSession,
  AppEvent,
  CreateRuntimeSessionResponse,
  FactoryApprovalDecisionRequest,
  PatchApprovalResponse,
  RecursiveBranchExecutionStartRequest,
  ReportCommandResultRequest,
  ReportPatchApplyResultRequest,
  RuntimeExecutionMode,
  SafetySettings,
  RuntimeTurnResponse
} from "@hivo/protocol";

const runtimeBaseUrl = import.meta.env?.VITE_AGENT_RUNTIME_URL ?? "http://127.0.0.1:4317";

export type RuntimeHealth = {
  status: "ok";
  mode: "real_provider";
  startedAt: string;
};

export class RuntimeUnavailableError extends Error {
  readonly code = "runtime_unavailable";

  constructor(message = "Agent runtime disconnected. Start or restart the agent-runtime service on 127.0.0.1:4317, then retry.") {
    super(message);
    this.name = "RuntimeUnavailableError";
  }
}

export type RuntimeAuthFailureCode = "unauthorized" | "token_expired";

export class RuntimeHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: RuntimeAuthFailureCode | "runtime_request_failed"
  ) {
    super(message);
    this.name = "RuntimeHttpError";
  }
}

export type RuntimeEventConnectionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "reconnecting"
  | "unauthorized"
  | "token_expired";

export type RuntimeEventSubscriptionState = {
  status: RuntimeEventConnectionStatus;
  connected: boolean;
  disconnected: boolean;
  reconnecting: boolean;
  unauthorized: boolean;
  tokenExpired: boolean;
  lastEventAt?: string;
  lastError?: string;
  retryAttempt: number;
  nextRetryAt?: string;
};

export async function checkRuntimeHealth(timeoutMs = 2500): Promise<RuntimeHealth> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${runtimeBaseUrl}/health`, { signal: controller.signal });
    if (!response.ok) {
      throw new RuntimeUnavailableError(`Agent runtime disconnected. /health returned HTTP ${response.status}.`);
    }
    const health = await response.json() as RuntimeHealth;
    if (health.status !== "ok") {
      throw new RuntimeUnavailableError("Agent runtime disconnected. /health did not report an ok runtime.");
    }
    if (!health.startedAt || !Number.isFinite(Date.parse(health.startedAt))) {
      throw new RuntimeUnavailableError("Agent runtime disconnected. /health did not report a valid start timestamp.");
    }
    return health;
  } catch (error) {
    if (error instanceof RuntimeUnavailableError) throw error;
    throw new RuntimeUnavailableError();
  } finally {
    globalThis.clearTimeout(timer);
  }
}

export async function assertRuntimeAvailable() {
  return checkRuntimeHealth();
}

export async function createRuntimeSession(input: {
  workspacePath: string;
  trustProfile?: "strict_gated" | "trusted_internal";
  providerConfig?: AgentRuntimeSession["providerConfig"];
  activeProviderSource?: AgentRuntimeSession["activeProviderSource"];
  sessionToken?: string;
  sessionTokenExpiresAt?: string;
  executionMode: RuntimeExecutionMode;
  accessProfile?: AccessProfile;
  thinkFirst?: boolean;
  userPrompt: string;
  safetySettings?: Partial<SafetySettings>;
}) {
  await assertRuntimeAvailable();
  return runtimeFetch<CreateRuntimeSessionResponse>("/sessions", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function runRuntimeTurn(
  sessionId: string,
  message: string,
  sessionToken?: string,
  options?: { thinkFirst?: boolean }
) {
  await assertRuntimeAvailable();
  return runtimeFetch<RuntimeTurnResponse>(`/sessions/${sessionId}/turn`, {
    method: "POST",
    body: JSON.stringify({ message, thinkFirst: options?.thinkFirst }),
    sessionToken
  });
}

export async function sendRuntimeAgentMessage(sessionId: string, agentId: string, message: string, sessionToken?: string) {
  return runtimeFetch<AgentScopedMessageResponse>(`/sessions/${sessionId}/agents/${encodeURIComponent(agentId)}/messages`, {
    method: "POST",
    body: JSON.stringify({ message }),
    sessionToken
  });
}

export async function getRuntimeSession(sessionId: string, sessionToken?: string) {
  return runtimeFetch<AgentRuntimeSession>(`/sessions/${sessionId}`, { sessionToken });
}

export async function decideRuntimeProductSpec(sessionId: string, decision: FactoryApprovalDecisionRequest, sessionToken?: string) {
  return runtimeFetch<AgentRuntimeSession>(`/sessions/${sessionId}/factory/product-spec/decision`, {
    method: "POST",
    body: JSON.stringify(decision),
    sessionToken
  });
}

export async function decideRuntimeTechnicalPlan(sessionId: string, decision: FactoryApprovalDecisionRequest, sessionToken?: string) {
  return runtimeFetch<AgentRuntimeSession>(`/sessions/${sessionId}/factory/technical-plan/decision`, {
    method: "POST",
    body: JSON.stringify(decision),
    sessionToken
  });
}

export async function startRuntimeRecursiveBranchExecution(sessionId: string, request: RecursiveBranchExecutionStartRequest, sessionToken?: string) {
  return runtimeFetch<AgentRuntimeSession>(`/sessions/${sessionId}/factory/branch-execution/start`, {
    method: "POST",
    body: JSON.stringify(request),
    sessionToken
  });
}

export async function approveRuntimePatch(sessionId: string, patchId: string, sessionToken?: string) {
  return runtimeFetch<PatchApprovalResponse>(`/sessions/${sessionId}/patches/${patchId}/approve`, {
    method: "POST",
    sessionToken
  });
}

export async function rejectRuntimePatch(sessionId: string, patchId: string, sessionToken?: string) {
  return runtimeFetch<PatchApprovalResponse>(`/sessions/${sessionId}/patches/${patchId}/reject`, {
    method: "POST",
    sessionToken
  });
}

export async function reportRuntimePatchApplyResult(
  sessionId: string,
  patchId: string,
  result: ReportPatchApplyResultRequest,
  sessionToken?: string
) {
  return runtimeFetch<AgentRuntimeSession>(`/sessions/${sessionId}/patches/${patchId}/result`, {
    method: "POST",
    body: JSON.stringify(result),
    sessionToken
  });
}

export async function reportRuntimeCommandResult(
  sessionId: string,
  requestId: string,
  result: ReportCommandResultRequest,
  sessionToken?: string
) {
  return runtimeFetch<AgentRuntimeSession>(`/sessions/${sessionId}/commands/${requestId}/result`, {
    method: "POST",
    body: JSON.stringify(result),
    sessionToken
  });
}

export function subscribeRuntimeEvents(
  sessionId: string,
  sessionToken: string | undefined,
  handlers: {
    onEvent?: (event: AppEvent) => void;
    onSession?: (session: AgentRuntimeSession) => void;
    onStateChange?: (state: RuntimeEventSubscriptionState) => void;
    onReconnect?: (state: RuntimeEventSubscriptionState) => void;
    onError?: (state: RuntimeEventSubscriptionState) => void;
  }
) {
  let source: EventSource | null = null;
  let stopped = false;
  let reconnectTimer: number | undefined;
  let retryAttempt = 0;
  let lastEventAt: string | undefined;
  let lastError: string | undefined;

  const tokenQuery = sessionToken ? `?token=${encodeURIComponent(sessionToken)}` : "";

  const emitState = (status: RuntimeEventConnectionStatus, extras: Partial<RuntimeEventSubscriptionState> = {}) => {
    const state: RuntimeEventSubscriptionState = {
      status,
      connected: status === "connected",
      disconnected: status === "disconnected" || status === "unauthorized" || status === "token_expired",
      reconnecting: status === "reconnecting",
      unauthorized: status === "unauthorized",
      tokenExpired: status === "token_expired",
      lastEventAt,
      lastError,
      retryAttempt,
      ...extras
    };
    handlers.onStateChange?.(state);
    return state;
  };

  const handleEvent = (raw: MessageEvent<string>) => {
    lastEventAt = new Date().toISOString();
    lastError = undefined;
    emitState("connected");
    const event = JSON.parse(raw.data) as AppEvent;
    handlers.onEvent?.(event);
    if (event.type === "runtime.session.updated") {
      handlers.onSession?.(event.session);
    }
  };
  const eventTypes: AppEvent["type"][] = [
    "runtime.session.created",
    "runtime.session.updated",
    "runtime.session.restored",
    "runtime.session.expired",
    "runtime.session.completed",
    "runtime.session.failed",
    "runtime.stage.changed",
    "runtime.tool_call.updated",
    "runtime.progress.updated",
    "runtime.tool_intent.updated",
    "runtime.artifact.created",
    "runtime.verification.pending",
    "runtime.verification.running",
    "runtime.verification.passed",
    "runtime.verification.failed",
    "runtime.verification.unavailable",
    "runtime.verification.not_run",
    "runtime.verification.skipped",
    "runtime.patch.stats.updated",
    "runtime.run.completed",
    "runtime.orchestration.event",
    "runtime.product_spec.proposed",
    "runtime.product_spec.approved",
    "runtime.technical_plan.proposed",
    "runtime.technical_plan.approved",
    "runtime.recursive_graph.proposed",
    "runtime.recursive_graph.ready",
    "runtime.recursive_graph.blocked",
    "runtime.branch_orchestrator.planned",
    "runtime.branch_execution.ready",
    "runtime.branch_execution.started",
    "runtime.branch_execution.patch_proposed",
    "runtime.branch_execution.reviewing",
    "runtime.branch_execution.validation_pending",
    "runtime.branch_execution.completed",
    "runtime.branch_execution.blocked",
    "runtime.branch_execution.failed",
    "runtime.branch_result.recorded",
    "runtime.recursive_fan_in.updated",
    "runtime.recursive_final_report.created",
    "runtime.branch_scope.conflict_detected",
    "runtime.patch.proposed",
    "runtime.patch.approved",
    "runtime.patch.apply_started",
    "runtime.patch.rejected",
    "runtime.patch.applied",
    "runtime.patch.apply_failed",
    "runtime.command.requested",
    "runtime.command.approved",
    "runtime.command.rejected",
    "runtime.command.started",
    "runtime.command.completed",
    "runtime.command.failed",
    "runtime.command.blocked"
  ];

  const open = () => {
    if (stopped) return;
    const reconnecting = retryAttempt > 0;
    emitState(reconnecting ? "reconnecting" : "connecting");
    source = new EventSource(`${runtimeBaseUrl}/sessions/${sessionId}/events${tokenQuery}`);
    source.onopen = () => {
      lastError = undefined;
      const state = emitState("connected");
      if (reconnecting) handlers.onReconnect?.(state);
    };
    source.onmessage = (raw) => {
      try {
        handleEvent(raw);
      } catch (error) {
        lastError = `Failed to decode runtime event: ${String(error)}`;
        const state = emitState("connected");
        handlers.onError?.(state);
      }
    };
    for (const type of eventTypes) {
      source.addEventListener(type, handleEvent as EventListener);
    }
    source.onerror = () => {
      if (stopped) return;
      source?.close();
      source = null;
      void handleDisconnect();
    };
  };

  const handleDisconnect = async () => {
    const authFailure = await getSessionAuthFailure(sessionId, sessionToken);
    if (stopped) return;
    if (authFailure) {
      lastError = authFailure.message;
      const state = emitState(authFailure.code);
      handlers.onError?.(state);
      return;
    }
    retryAttempt += 1;
    lastError = "SSE disconnected.";
    const retryDelayMs = nextReconnectDelayMs(retryAttempt);
    const nextRetryAt = new Date(Date.now() + retryDelayMs).toISOString();
    const state = emitState("reconnecting", { nextRetryAt });
    handlers.onError?.(state);
    reconnectTimer = window.setTimeout(open, retryDelayMs);
  };

  open();

  return () => {
    stopped = true;
    if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
    source?.close();
    source = null;
    emitState("disconnected");
  };
}

async function runtimeFetch<T>(path: string, init?: RequestInit & { sessionToken?: string }): Promise<T> {
  const { sessionToken, ...requestInit } = init ?? {};
  let response: Response;
  try {
    response = await fetch(`${runtimeBaseUrl}${path}`, {
      ...requestInit,
      headers: {
        "content-type": "application/json",
        ...(sessionToken ? { "x-hivo-session-token": sessionToken } : {}),
        ...(requestInit.headers ?? {})
      }
    });
  } catch {
    throw new RuntimeUnavailableError();
  }
  if (!response.ok) {
    const text = await response.text();
    const parsed = parseRuntimeError(text);
    throw new RuntimeHttpError(
      parsed.message || `Runtime request failed with HTTP ${response.status}`,
      response.status,
      response.status === 401 ? parsed.code ?? "unauthorized" : parsed.code ?? "runtime_request_failed"
    );
  }
  return response.json() as Promise<T>;
}

async function getSessionAuthFailure(sessionId: string, sessionToken: string | undefined): Promise<{ code: RuntimeAuthFailureCode; message: string } | null> {
  if (!sessionToken) {
    return { code: "unauthorized", message: "Session event stream requires a session token." };
  }
  try {
    const response = await fetch(`${runtimeBaseUrl}/sessions/${sessionId}`, {
      headers: { "x-hivo-session-token": sessionToken }
    });
    if (response.status === 401) {
      const parsed = parseRuntimeError(await response.text());
      return {
        code: parsed.code === "token_expired" ? "token_expired" : "unauthorized",
        message: parsed.message || "Session event stream is unauthorized."
      };
    }
    return null;
  } catch {
    return null;
  }
}

function nextReconnectDelayMs(attempt: number) {
  const base = Math.min(10_000, 500 * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.random() * 250);
  return base + jitter;
}

function parseRuntimeError(text: string): { message: string; code?: RuntimeAuthFailureCode | "runtime_request_failed" } {
  try {
    const parsed = JSON.parse(text) as { error?: unknown; code?: unknown };
    const code = parsed.code === "token_expired" || parsed.code === "unauthorized" ? parsed.code : undefined;
    return { message: typeof parsed.error === "string" ? parsed.error : text, code };
  } catch {
    return { message: text };
  }
}
