import type { AgentRuntimeSession, CommandExecutionRecord, ProjectIntake, RuntimeTurnResponse } from "@hivo/protocol";
import { randomUUID } from "node:crypto";
import type { SwarmMode } from "../orchestration/OrchestrationConfig.js";
import type { ConversationUnderstanding } from "./ConversationUnderstanding.js";
import type { RuntimeProviderContext } from "./RuntimeProviderContextService.js";
import type { RuntimeIntentContractService } from "./RuntimeIntentContractService.js";
import { RuntimeOrchestrationDispatchService } from "./RuntimeOrchestrationDispatchService.js";
import { RuntimeOrchestrationPreludeService, type RuntimeModeResolution } from "./RuntimeOrchestrationPreludeService.js";
import type { RuntimeProviderBackedSwarmService } from "./RuntimeProviderBackedSwarmService.js";
import type { RuntimeRecursiveFactoryPlanningService } from "./RuntimeRecursiveFactoryPlanningService.js";
import type { RuntimeRecursiveSwarmService } from "./RuntimeRecursiveSwarmService.js";
import type { RuntimeRunEngineService } from "./RuntimeRunEngineService.js";
import { SessionManager } from "./SessionManager.js";

export type RuntimePlanningTurnServices = {
  intentContract: RuntimeIntentContractService;
  recursiveSwarm: RuntimeRecursiveSwarmService;
  recursiveFactoryPlanning: RuntimeRecursiveFactoryPlanningService;
  providerBackedSwarm: RuntimeProviderBackedSwarmService;
  runEngine: RuntimeRunEngineService;
};

export type RuntimePlanningTurnInput = {
  sessionId: string;
  session: AgentRuntimeSession;
  prompt: string;
  conversationUnderstanding: ConversationUnderstanding;
  decisionPipelineId: string;
  providerContext: RuntimeProviderContext;
  swarmMode?: SwarmMode;
};

export class RuntimePlanningTurnService {
  private readonly preludeService = new RuntimeOrchestrationPreludeService();
  private readonly dispatchService = new RuntimeOrchestrationDispatchService();

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly services: RuntimePlanningTurnServices
  ) {}

  async run(input: RuntimePlanningTurnInput): Promise<RuntimeTurnResponse> {
    const { sessionId, session, prompt, conversationUnderstanding, providerContext } = input;
    const { provider, telemetry: providerTelemetry } = providerContext;
    const intentCompilation = await this.services.intentContract.compile({
      sessionId,
      originalRequest: prompt,
      provider,
      parentContext: {
        route: conversationUnderstanding.routeDecision.route,
        intent_kind: conversationUnderstanding.intentDecision.kind,
        decision_pipeline_id: input.decisionPipelineId
      }
    });
    if (!intentCompilation.ready) {
      return this.services.intentContract.blockPlanning({
        sessionId,
        originalRequest: prompt,
        compilation: intentCompilation,
        providerTelemetry
      });
    }

    const planningPrompt = intentCompilation.contract.precise_rewrite;
    const prelude = this.preludeService.build({
      session,
      prompt: planningPrompt,
      conversationUnderstanding,
      swarmMode: input.swarmMode
    });
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.projectIntake = prelude.intake;
      draft.contextPack = prelude.intake.contextPack;
      draft.runIntent = prelude.intake.runIntent;
    });
    const { projectMap, modeResolution, thinkFirst, swarmMode } = prelude;

    const isRecursive = isRecursiveDispatch({
      swarmMode,
      prompt: planningPrompt,
      modeResolution,
      conversationUnderstanding
    });

    if (isRecursive) {
      const baselineCommand = selectBaselineTestCommand(prelude.intake);
      if (baselineCommand) {
        const currentSession = this.sessionManager.getSession(sessionId) ?? session;
        const matchingPendingRequest = currentSession.commandRequests.find((req) =>
          req.command.trim() === baselineCommand.trim() &&
          (req.status === "requested" || req.status === "approved" || req.status === "executing" || req.status === "running")
        );
        const hasValidEvidence = hasValidBaselineEvidence(currentSession, baselineCommand, matchingPendingRequest?.id);
        if (!hasValidEvidence) {
          const infraFailedExecution = currentSession.commandExecutions.find((exec) =>
            isInfraFailureExecution(exec, baselineCommand, matchingPendingRequest?.id)
          );
          if (infraFailedExecution) {
            return { sessionId, status: currentSession.status };
          }

          const commandRequestId = matchingPendingRequest?.id ?? `cmd_${randomUUID()}`;
          if (!matchingPendingRequest) {
            await this.sessionManager.addCommandRequest(sessionId, {
              id: commandRequestId,
              sessionId,
              command: baselineCommand,
              cwd: session.workspacePath,
              risk: "safe",
              reason: "Baseline test command execution to ground planning evidence.",
              provenance: {
                source: "agent",
                trigger: "manual",
                requestedBy: "agent",
                reason: "Baseline test command execution before recursive swarm planning."
              },
              status: "requested",
              createdAt: new Date().toISOString()
            });
          }
          await this.sessionManager.updateSession(sessionId, (draft) => {
            draft.status = "needs_approval";
            draft.lifecycleStage = "INTAKE";
            draft.nextAction = {
              kind: "await_baseline_command",
              commandRequestId,
              command: baselineCommand,
              originalPrompt: prompt,
              message: `Awaiting baseline command execution: ${baselineCommand}`
            };
          });
          return { sessionId, status: "needs_approval" };
        }
      }
    }

    const dispatched = await this.dispatchService.dispatch({
      sessionId,
      prompt: planningPrompt,
      projectMap,
      modeResolution,
      swarmMode,
      thinkFirst,
      conversationUnderstanding,
      branches: {
        recursiveSwarm: () => this.services.recursiveSwarm.run({
          sessionId,
          message: planningPrompt,
          provider,
          providerTelemetry,
          projectMap,
          thinkFirst
        }),
        recursiveFactory: () => this.services.recursiveFactoryPlanning.startRecursiveFactory(sessionId, planningPrompt, projectMap),
        providerBackedSwarm: () => this.services.providerBackedSwarm.run({
          sessionId,
          message: planningPrompt,
          provider,
          providerTelemetry,
          projectMap,
          conversationUnderstanding
        }),
        simple: (options) => this.services.runEngine.run({
          sessionId,
          prompt: planningPrompt,
          provider,
          providerTelemetry,
          ...options
        })
      }
    });
    const updated = dispatched.session;
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.resolvedExecutionMode = modeResolution.mode;
    });
    return { sessionId, status: updated.status };
  }
}

export function selectBaselineTestCommand(intake: ProjectIntake | undefined): string | undefined {
  if (!intake) return undefined;
  if (intake.testCommands && intake.testCommands.length > 0) {
    const primaryTest = intake.testCommands.find((cmd: string) =>
      /^(npm\s+test|npm\s+run\s+test|pnpm\s+test|yarn\s+test|cargo\s+test|pytest|python\s+-m\s+pytest|vitest|jest)\b/i.test(cmd)
    ) ?? intake.testCommands[0];
    return primaryTest;
  }
  const knownTest = intake.knownCommands?.find((cmd: string) => /\b(test|check|spec)\b/i.test(cmd));
  if (knownTest) return knownTest;
  const verificationTest = intake.contextPack?.verificationCommands?.find((cmd: string) => /\b(test|check|spec)\b/i.test(cmd));
  if (verificationTest) return verificationTest;
  if (intake.contextPack?.relatedTests && intake.contextPack.relatedTests.length > 0) {
    return "npm test";
  }
  return undefined;
}

export function isValidBaselineExecution(
  execution: CommandExecutionRecord,
  expectedCommand: string,
  expectedRequestId?: string
): boolean {
  const commandMatches = execution.command.trim() === expectedCommand.trim() ||
    (expectedRequestId !== undefined && execution.requestId === expectedRequestId);
  if (!commandMatches) return false;
  const hasNumericExitCode = typeof execution.exitCode === "number";
  const hasOutput = (execution.stdout?.length ?? 0) > 0 || (execution.stderr?.length ?? 0) > 0;
  const notInfraFailure = execution.status !== "blocked" && execution.diagnosis?.category !== "command_not_found";
  return hasNumericExitCode && hasOutput && notInfraFailure;
}

export function hasValidBaselineEvidence(session: AgentRuntimeSession, command: string, requestId?: string): boolean {
  return (session.commandExecutions ?? []).some((execution) => isValidBaselineExecution(execution, command, requestId));
}

export function isInfraFailureExecution(
  execution: CommandExecutionRecord,
  expectedCommand: string,
  expectedRequestId?: string
): boolean {
  const commandMatches = execution.command.trim() === expectedCommand.trim() ||
    (expectedRequestId !== undefined && execution.requestId === expectedRequestId);
  if (!commandMatches) return false;
  return execution.status === "blocked" ||
    typeof execution.exitCode !== "number" ||
    execution.diagnosis?.category === "command_not_found";
}

export function isRecursiveDispatch(input: {
  swarmMode: SwarmMode;
  prompt: string;
  modeResolution: RuntimeModeResolution;
  conversationUnderstanding?: ConversationUnderstanding;
}): boolean {
  if (input.conversationUnderstanding?.intentDecision.kind === "run_request") return false;
  if (
    input.conversationUnderstanding?.intentDecision.kind === "workspace_question" &&
    input.conversationUnderstanding.routeDecision.route === "inspect_explain"
  ) {
    return false;
  }
  if (input.modeResolution.mode === "recursive_factory") return true;
  if (shouldUseRecursiveActionTree(input)) return true;
  if (input.swarmMode === "recursive_tree") return true;
  return false;
}

function shouldUseRecursiveActionTree(input: { swarmMode: SwarmMode; prompt: string }) {
  if (input.swarmMode !== "recursive_tree") return false;
  const normalized = input.prompt.toLowerCase();
  return /\brecursive\b[\s\S]{0,80}\b(child|children|childs|sub[- ]?tasks?|agents?|action|execute|execution|tree)\b/.test(normalized)
    || /\b(child|children|childs|sub[- ]?tasks?|agents?)\b[\s\S]{0,80}\brecursive\b/.test(normalized)
    || /\b(parent|llm)\b[\s\S]{0,100}\b(decide|decides|choose|chooses|split|splits)\b[\s\S]{0,100}\b(number|numbers|tasks?|prompts?|children|childs)\b/.test(normalized)
    || /\bchain of thou(?:gh)?t\b[\s\S]{0,100}\b(action|recursive|children|childs)\b/.test(normalized);
}
