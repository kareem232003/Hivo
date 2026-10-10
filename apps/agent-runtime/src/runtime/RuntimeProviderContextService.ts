import type { AgentRuntimeSession, ProviderTruthTelemetry } from "@hivo/protocol";
import type { LlmProvider } from "../llm/LlmProvider.js";
import {
  createProviderTelemetryRecorder,
  TelemetryLlmProvider,
  type ProviderTelemetryRecorder
} from "../llm/ProviderTelemetry.js";

export type RuntimeProviderContext = {
  provider: TelemetryLlmProvider;
  routerProvider: TelemetryLlmProvider;
  verifierProvider: TelemetryLlmProvider;
  telemetry: ProviderTelemetryRecorder;
};

export type RuntimeProviderContextServiceOptions = {
  providerRequestTimeoutMs: number;
  maxProviderCallsPerRun?: number;
  maxRunWallClockMs?: number;
  getProvider: (session: AgentRuntimeSession) => LlmProvider;
  createProvider: (config: AgentRuntimeSession["providerConfig"], timeoutMs: number) => LlmProvider;
  useSessionProviderForSpecializedModels: boolean;
};

export class RuntimeProviderContextService {
  constructor(private readonly options: RuntimeProviderContextServiceOptions) {}

  create(
    session: AgentRuntimeSession,
    modelCertification?: ProviderTruthTelemetry["modelCertification"]
  ): RuntimeProviderContext {
    const telemetry = createProviderTelemetryRecorder({
      mode: session.mode,
      providerConfig: session.providerConfig,
      activeProviderSource: session.activeProviderSource,
      modelCertification,
      maxProviderCalls: this.options.maxProviderCallsPerRun,
      maxElapsedMs: this.options.maxRunWallClockMs
    });
    const provider = new TelemetryLlmProvider(this.options.getProvider(session), telemetry);
    return {
      provider,
      routerProvider: this.createSpecializedProvider(session, telemetry, "routerModel") ?? provider,
      verifierProvider: this.createSpecializedProvider(session, telemetry, "verifierModel") ?? provider,
      telemetry
    };
  }

  private createSpecializedProvider(
    session: AgentRuntimeSession,
    telemetry: ProviderTelemetryRecorder,
    key: "routerModel" | "verifierModel"
  ) {
    if (this.options.useSessionProviderForSpecializedModels) return undefined;
    if (!session.providerConfig) return undefined;
    const selectedModel = session.providerConfig?.[key];
    if (!selectedModel) return undefined;
    return new TelemetryLlmProvider(this.options.createProvider({
      ...session.providerConfig,
      selectedModel
    }, this.options.providerRequestTimeoutMs), telemetry);
  }
}
