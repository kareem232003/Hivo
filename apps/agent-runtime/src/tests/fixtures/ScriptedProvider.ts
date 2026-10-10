import type { AgentPlan, PatchProposal } from "@hivo/protocol";
import type { LlmProvider, LlmRequest } from "../../llm/LlmProvider.js";
import { createHash } from "node:crypto";
import { createThreeJsSnakeProposal, isThreeJsSnakePrompt } from "../../curatedProposals/threeJsSnake.js";
import { routeConversation } from "../../runtime/ConversationRouter.js";

export class ScriptedProvider implements LlmProvider {
  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    const schemaName = getSchemaName(schema);
    if (schemaName === "agent-plan") {
      return this.createPlan(input.userPrompt) as T;
    }
    if (schemaName === "patch-proposal") {
      return this.createPatchProposal(input.userPrompt, input.context) as T;
    }
    if (schemaName === "run-plan") {
      return this.createRunPlan(input.userPrompt) as T;
    }
    if (schemaName === "run-patch") {
      return this.createRunPatch(input.userPrompt) as T;
    }
    if (schemaName === "run-patch-intent") {
      return this.createRunPatchIntent(input.userPrompt) as T;
    }
    if (schemaName === "conversation-intent-decision") {
      return this.createConversationIntentDecision(input.userPrompt) as T;
    }
    if (schemaName === "turn-understanding") {
      return this.createTurnUnderstanding(input.userPrompt) as T;
    }
    if (schemaName === "initial-reasoning-decision") {
      return this.createInitialReasoningDecision(input.userPrompt) as T;
    }
    if (schemaName === "reasoning-step") {
      return this.createReasoningStep(input.userPrompt) as T;
    }
    if (schemaName === "answer-verification") {
      return {
        verdict: "pass",
        rationale: "Scripted fixture accepted the provider-authored answer.",
        supportedClaims: [],
        unsupportedClaims: [],
        missingFacts: [],
        evidenceRefs: []
      } as T;
    }
    if (schemaName === "provider-authored-result") {
      return this.createProviderAuthoredResult(input) as T;
    }
    if (schemaName === "intent-contract") {
      return this.createIntentContract(input) as T;
    }
    if (schemaName === "intent_review_result") {
      return {
        status: "aligned",
        rationale: "Scripted fixture verified the candidate against the canonical original request.",
        findings: []
      } as T;
    }
    if (schemaName === "semantic_conflict_resolution") {
      return { decisions: [] } as T;
    }
    if (schemaName === "swarm_planner_output") {
      return this.createSwarmPlannerOutput(input) as T;
    }
    if (schemaName === "parsed-agent-output") {
      return this.createParsedAgentOutput(input) as T;
    }
    if (schemaName === "run-verification") {
      return {
        summary: "Mock verification pending Rust apply.",
        checks: [{ name: "Mock verification", status: "pending", detail: "Waiting for approved apply." }]
      } as T;
    }
    if (schemaName === "project-explain") {
      return {
        answerMarkdown: [
          "Mock mode cannot produce a production project explanation because it does not actually reason over the workspace.",
          "",
          "The read-only project evidence report was still created. Switch to a configured real provider for an LLM-grounded explanation."
        ].join("\n"),
        usedEvidenceRefs: [],
        unsupportedOrUnclearParts: ["Mock mode intentionally avoids pretending to understand the project."]
      } as T;
    }
    return {} as T;
  }

  async generateText(input: LlmRequest): Promise<string> {
    return directAnswerMarkdown(input.userPrompt, routeConversation(input.userPrompt).language);
  }

  async embed(input: { inputs: string[]; model?: string }) {
    return {
      model: input.model ?? "mock-embedding",
      vectors: input.inputs.map((text) => deterministicVector(text))
    };
  }

  private createPlan(userPrompt: string): AgentPlan {
    return {
      summary: `Prepare a small, reviewable change for: ${userPrompt}`,
      steps: [
        {
          id: "scan",
          title: "Scan repository",
          detail: "Identify project type, important files, and current git state.",
          status: "completed"
        },
        {
          id: "context",
          title: "Gather context",
          detail: "Search for likely files before reading specific source files.",
          status: "completed"
        },
        {
          id: "patch",
          title: "Prepare patch proposal",
          detail: "Create a non-applied unified diff for user review.",
          status: "completed"
        }
      ],
      acceptanceCriteria: [
        "The proposal is visible before any file is written.",
        "The changed files are explained.",
        "A safe validation command is suggested."
      ],
      risks: [
        "Mock mode generates a representative patch and may not compile against the real code.",
        "Patch application remains disabled until explicit approval plumbing is complete."
      ]
    };
  }

  private createPatchProposal(userPrompt: string, context: unknown): Omit<PatchProposal, "id" | "sessionId" | "createdAt"> {
    if (isThreeJsSnakePrompt(userPrompt)) {
      return createThreeJsSnakeProposal(userPrompt);
    }
    const summaryFile = inferSummaryFile(context);
    const summaryContent = [
      "# Agent Proposal",
      "",
      `Request: ${userPrompt.replaceAll("\n", " ")}`,
      "",
      "This patch was generated in MOCK_LLM mode.",
      "It is intentionally not applied automatically.",
      "Review and approve before any future write operation.",
      "Suggested validation: git diff --check"
    ].join("\n");
    return {
      title: "Mock implementation note",
      summary: `Adds a local implementation note for the requested task: ${userPrompt}`,
      riskLevel: "low",
      filesChanged: [
        {
          path: summaryFile,
          changeType: "create",
          explanation: "Captures the proposed change in a reviewable generated note."
        }
      ],
      artifacts: [
        {
          path: summaryFile,
          content: `${summaryContent}\n`
        }
      ],
      unifiedDiff: [
        `diff --git a/${summaryFile} b/${summaryFile}`,
        "new file mode 100644",
        "index 0000000..1111111",
        "--- /dev/null",
        `+++ b/${summaryFile}`,
        "@@ -0,0 +1,8 @@",
        ...summaryContent.split("\n").map((line) => `+${line}`)
      ].join("\n"),
      requiresApproval: true,
      status: "proposed"
    };
  }

  private createRunPlan(userPrompt: string) {
    const request = extractUserRequest(userPrompt);
    const mode = /\b(create|new|scaffold|generate|make a new)\b/i.test(request) || /(أنشئ|انشئ|اعمل).*(مشروع|تطبيق|app|project)/.test(request)
      ? "create_project"
      : (/\b(run|launch|start|serve|open)\b.+\b(project|app|preview|site|game)\b/i.test(request) ||
        (/(شغل|افتح).*(المشروع|التطبيق|اللعبة|project|app|game)/i.test(request)) ||
        ((/\b(explain|inspect|analyze)\b/i.test(request) || /(اشرح|حلل|افهم|لخص|راجع)/.test(request)) && !(/\b(change|edit|fix|add|create|write|make)\b/i.test(request) || /(غيّر|غير|عدّل|عدل|صلح|أصلح|اضف|أضف|اكتب|اعمل|أنشئ|انشئ)/.test(request))))
        ? "inspect_only"
        : "edit_project";
    const requestedCount = Number(request.match(/\buse\s+(\d+)\s+agents?\b/i)?.[1] ?? "1");
    const count = mode === "inspect_only" ? 1 : Math.min(Math.max(requestedCount || 1, 1), 5);
    const rolePool = /\b(game|three|3d|snake)\b/i.test(request)
      ? ["Gameplay Implementer", "3D Rendering Implementer", "Frontend Integration Implementer", "Verification Planner", "UX Polish Implementer"]
      : ["Implementation Worker", "Workspace Integrator", "Verification Planner", "Documentation Worker", "Review Worker"];
    return {
      summary: mode === "create_project" ? "Create a new local project as reviewable files." : "Prepare a gated local coding run.",
      reasoningSummary: "Mock planning keeps the flow reviewable and Rust-gated.",
      mode,
      tasks: Array.from({ length: count }, (_, index) => ({
        id: `mock_task_${index + 1}`,
        title: mode === "create_project" && index === 0 ? "Create project scaffold" : `Prepare reviewable change ${index + 1}`,
        objective: request,
        roleTitle: mode === "create_project" && index === 0 ? "Project Scaffolder" : rolePool[index] ?? `Dynamic Worker ${index + 1}`,
        targetFiles: mode === "create_project" ? ["hivo-project/README.md", "hivo-project/index.html"] : ["AGENT_PROPOSAL.md"],
        expectedArtifact: "Reviewable diff",
        verification: "git diff --check"
      })),
      acceptanceCriteria: ["User can review before apply.", "Rust applies changes."],
      risks: ["Mock mode is not codebase-specific."],
      suggestedCommands: [{ command: "git diff --check", reason: "Validate the approved diff." }]
    };
  }

  private createRunPatch(userPrompt: string) {
    const request = extractUserRequest(userPrompt);
    return {
      title: "Mock gated patch",
      summary: "Creates a reviewable proposal artifact.",
      files: [
        {
          path: "AGENT_PROPOSAL.md",
          changeType: "create",
          explanation: "Reviewable mock artifact.",
          content: `# Agent Proposal\n\nRequest: ${request}\n\nThis is a gated mock artifact. Use a validated Ollama provider for project-specific code generation.\n`
        }
      ],
      suggestedCommands: [{ command: "git diff --check", reason: "Validate the approved diff." }]
    };
  }

  private createRunPatchIntent(userPrompt: string) {
    const recursiveRepair = /recursive validation repair|recursive repair/i.test(userPrompt);
    if (!recursiveRepair) {
      const request = extractUserRequest(userPrompt);
      const summaryFile = "AGENT_PROPOSAL.md";
      const content = [
        "# Agent Proposal",
        "",
        `Request: ${request.replaceAll("\n", " ")}`,
        "",
        "This provider-authored fixture patch keeps the edit reviewable and approval-gated.",
        "Suggested validation: git diff --check"
      ].join("\n");
      return {
        title: "Provider-authored implementation note",
        summary: `Creates a reviewable implementation note for: ${request}`,
        intents: [{
          path: summaryFile,
          operation: "create_file",
          replacementText: `${content}\n`,
          reason: "Create a narrow provider-authored artifact for the requested edit flow.",
          risk: "low"
        }],
        suggestedCommands: [{ command: "git diff --check", reason: "Validate the approved diff." }]
      };
    }
    if (!userPrompt.includes("HIVO_REPAIR_VALUE = \\\"broken\\\"")) {
      return {
        title: "No repair",
        summary: "Mock mode did not find a deterministic repair sentinel.",
        intents: []
      };
    }
    const allowedFiles = extractJsonArrayAfterLabel(userPrompt, "Allowed related files")
      .filter((entry): entry is string => typeof entry === "string");
    const targetFile = allowedFiles.find((entry) => entry.endsWith("/module.py") || entry.endsWith("/module.mjs"));
    if (!targetFile) {
      return {
        title: "No repair",
        summary: "Mock mode could not identify a single scoped module repair target.",
        intents: []
      };
    }
    const isPythonModule = targetFile.endsWith("/module.py");
    return {
      title: "Recursive repair",
      summary: `Restore the deterministic high-attribution smoke module in ${targetFile}.`,
      intents: [{
        path: targetFile,
        operation: "replace_range",
        preimageText: isPythonModule
          ? "HIVO_REPAIR_VALUE = \"broken\""
          : "export const HIVO_REPAIR_VALUE = \"broken\";",
        replacementText: isPythonModule
          ? "HIVO_REPAIR_VALUE = \"fixed\""
          : "export const HIVO_REPAIR_VALUE = \"fixed\";",
        reason: "Fix only the sentinel value proven by the traceback to come from the applied recursive patch.",
        risk: "low"
      }],
      suggestedCommands: []
    };
  }

  private createConversationIntentDecision(userPrompt: string) {
    const request = extractClassifiedUserMessage(userPrompt);
    const route = routeConversation(request);
    return {
      kind: intentKindForRoute(route.route),
      language: route.language,
      needsWorkspace: isWorkspaceRouteName(route.route),
      confidence: route.confidence,
      rationale: route.rationale,
      workspaceMessage: route.workspacePrompt || request
    };
  }

  private createTurnUnderstanding(userPrompt: string) {
    const request = extractClassifiedUserMessage(userPrompt);
    const route = routeConversation(request);
    return {
      originalRequest: request,
      cleanedRequest: route.workspacePrompt || request,
      language: route.language,
      intentKind: intentKindForRoute(route.route),
      route: route.route,
      needsWorkspace: isWorkspaceRouteName(route.route),
      goal: isWorkspaceRouteName(route.route) ? route.rationale : "Answer the user directly.",
      ambiguities: [],
      requiredEvidence: isWorkspaceRouteName(route.route) ? ["workspace context"] : [],
      risk: route.route === "recursive_factory" || route.route === "swarm_readonly" ? "high" : isWorkspaceRouteName(route.route) ? "medium" : "low",
      confidence: route.confidence,
      rationale: route.rationale
    };
  }

  private createInitialReasoningDecision(userPrompt: string) {
    const request = extractReasoningUserTurn(userPrompt);
    const route = routeConversation(request);
    const needsWorkspace = route.route !== "chat";
    const intentKind = route.route === "chat"
      ? "direct_conversation"
      : route.route === "inspect_explain" || route.route === "swarm_readonly"
        ? "workspace_question"
        : route.route === "simple_run"
          ? "run_request"
          : "workspace_action";
    return {
      understanding: {
        originalRequest: request,
        cleanedRequest: route.workspacePrompt || request,
        language: route.language,
        intentKind,
        route: route.route,
        needsWorkspace,
        goal: needsWorkspace ? route.rationale : "Answer the user directly.",
        ambiguities: [],
        requiredEvidence: needsWorkspace ? ["workspace context"] : [],
        risk: route.route === "recursive_factory" || route.route === "swarm_readonly" ? "high" : needsWorkspace ? "medium" : "low",
        confidence: route.confidence,
        rationale: route.rationale
      },
      step: needsWorkspace && intentKind === "workspace_question"
        ? {
          id: "scripted_initial_investigation",
          kind: "tool_batch",
          rationale: "Scripted provider requested read-only workspace evidence before answering.",
          toolRequests: [{
            id: "scripted_investigate_project",
            kind: "investigate_project",
            query: route.workspacePrompt || request,
            limit: 8,
            reason: "Collect bounded workspace evidence for the provider-authored answer."
          }],
          missingFacts: ["Workspace evidence for the requested explanation."],
          successCriteria: ["Answer only from cited workspace evidence."]
        }
        : {
          id: "scripted_initial_step",
          kind: "final",
          rationale: "Scripted provider selected the deterministic fixture route.",
          toolRequests: [],
          missingFacts: [],
          successCriteria: ["Continue through the selected runtime path."]
        }
    };
  }

  private createReasoningStep(userPrompt: string) {
    const request = extractReasoningUserTurn(userPrompt);
    const route = routeConversation(request);
    if (route.route !== "chat") {
      return {
        id: "scripted_final_step",
        kind: "final",
        rationale: "Scripted provider is ready for the compose stage to use current evidence.",
        toolRequests: [],
        missingFacts: [],
        successCriteria: ["Return a provider-authored fixture answer from supplied evidence."]
      };
    }
    return {
      id: "scripted_final_step",
      kind: "final",
      rationale: "Scripted provider produced a deterministic final step.",
      toolRequests: [],
      missingFacts: [],
      successCriteria: ["Return a provider-authored fixture answer."],
      result: {
        decision: "ANSWER",
        answerMarkdown: directAnswerMarkdown(request, route.language),
        claims: [],
        evidenceRefs: [],
        unknowns: [],
        rationale: "Scripted fixture response."
      }
    };
  }

  private createProviderAuthoredResult(input: LlmRequest) {
    const context = asRecord(input.context);
    const understanding = asRecord(context?.understanding);
    const needsWorkspace = understanding?.needsWorkspace === true;
    const language = understanding?.language === "arabic" ? "arabic" : "english";
    const evidenceRefs = Array.isArray(context?.allowedEvidenceRefs)
      ? context.allowedEvidenceRefs.filter((ref): ref is string => typeof ref === "string")
      : [];
    if (needsWorkspace && evidenceRefs.length === 0) {
      return {
        decision: "FOLLOW_UP",
        answerMarkdown: `I need workspace evidence before I can complete: ${extractReasoningUserTurn(input.userPrompt)}`,
        claims: [],
        evidenceRefs: [],
        unknowns: ["No workspace evidence refs were available to support a material answer."],
        rationale: "Scripted fixture refused to answer a workspace turn without evidence."
      };
    }
    return {
      decision: "ANSWER",
      answerMarkdown: directAnswerMarkdown(extractReasoningUserTurn(input.userPrompt), language),
      claims: evidenceRefs.length
        ? [{
          id: "scripted_claim_1",
          text: "The scripted provider completed the schema-valid response using supplied evidence.",
          material: false,
          evidenceIds: evidenceRefs,
          confidence: "medium"
        }]
        : [],
      evidenceRefs,
      unknowns: [],
      rationale: "Scripted fixture response."
    };
  }

  private createIntentContract(input: LlmRequest) {
    const context = asRecord(input.context);
    const original = typeof context?.original_user_request === "string" ? context.original_user_request : input.userPrompt;
    return {
      original_user_request: original,
      precise_rewrite: original,
      assumptions: ["The scripted provider fixture should preserve the user request exactly."],
      missing_questions: [],
      tradeoffs: [{
        name: "fixture_scope",
        options: ["small deterministic response", "broad generated response"],
        preferred: "small deterministic response",
        rationale: "Tests need stable provider-authored structure."
      }],
      priorities: {
        speed: { score: 70, rationale: "Keep fixture runs fast." },
        quality: { score: 80, rationale: "Return schema-valid contracts." },
        realism: { score: 60, rationale: "Model the provider boundary without external calls." },
        fun: { score: 10, rationale: "Not relevant for this fixture." },
        security: { score: 80, rationale: "Preserve gates and no-write defaults." },
        cost: { score: 80, rationale: "Avoid external provider costs in tests." }
      },
      definition_of_done: ["The requested workflow completes through the configured gates."],
      non_goals: ["Do not bypass provider-authored intent compilation."],
      conflict_rules: ["Prefer the exact original request and existing safety gates over inferred shortcuts."]
    };
  }

  private createParsedAgentOutput(input: LlmRequest) {
    return {
      summary: "Scripted provider completed this role from the supplied context.",
      status: "succeeded",
      files_changed: [],
      validation_results: [],
      artifacts: [],
      limitations: [],
      next_recommendations: ["Continue through the next gated orchestration step."],
      intent_alignment: intentAlignmentFromContext(input.context)
    };
  }

  private createSwarmPlannerOutput(input: LlmRequest) {
    return {
      plan_summary: `Plan created for: ${input.userPrompt.slice(0, 100)}`,
      task_drafts: ["Analyze repository structure", "Implement proposed change", "Run validation suite"],
      dependencies: ["package.json"],
      risks: [],
      validation_strategy: ["npm test"],
      assumptions: ["Repository dependencies are installed"],
      confidence: 0.9,
      intent_alignment: intentAlignmentFromContext(input.context)
    };
  }
}

function deterministicVector(text: string) {
  const bytes = createHash("sha256").update(text).digest();
  const vector = Array.from({ length: 16 }, (_, index) => (bytes[index] ?? 0) / 127.5 - 1);
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

function extractUserRequest(prompt: string) {
  const match = prompt.match(/User request:\s*([\s\S]*?)(?:\n(?:Unified intent understanding|Workspace snapshot|Plan):|$)/i);
  return (match?.[1] ?? prompt).trim();
}

function extractReasoningUserTurn(prompt: string) {
  const match = prompt.match(/Understand this user turn and choose its first reasoning step:\s*([\s\S]*?)\n\nReturn \{ understanding, step \}\./i);
  return (match?.[1] ?? extractUserRequest(prompt)).trim();
}

function extractClassifiedUserMessage(prompt: string) {
  const classifyMatch = prompt.match(/Classify this single user message before retrieval:\n([\s\S]*?)\n\nReturn JSON/i);
  if (classifyMatch?.[1]) return classifyMatch[1].trim();
  return extractReasoningUserTurn(prompt);
}

function intentKindForRoute(route: string) {
  if (route === "chat") return "direct_conversation";
  if (route === "inspect_explain" || route === "swarm_readonly") return "workspace_question";
  if (route === "simple_run") return "run_request";
  return "workspace_action";
}

function isWorkspaceRouteName(route: string) {
  return route !== "chat";
}

function directAnswerMarkdown(request: string, language: "arabic" | "english") {
  if (language === "arabic") {
    return `\u062a\u0645 \u0625\u0646\u062c\u0627\u0632 \u0627\u0633\u062a\u062c\u0627\u0628\u0629 \u0627\u0644\u0645\u0632\u0648\u062f \u0627\u0644\u0645\u0628\u0631\u0645\u062c \u0644\u0640: ${request}`;
  }
  return `Scripted provider response complete for: ${request}`;
}

function getSchemaName(schema: unknown) {
  if (typeof schema === "object" && schema && "name" in schema) {
    return String((schema as { name: string }).name);
  }
  return "";
}

function inferSummaryFile(context: unknown) {
  if (
    typeof context === "object" &&
    context &&
    "summaryFile" in context &&
    typeof (context as { summaryFile: unknown }).summaryFile === "string"
  ) {
    return (context as { summaryFile: string }).summaryFile;
  }
  return "AGENT_PROPOSAL.md";
}

function intentAlignmentFromContext(context: unknown) {
  const record = asRecord(context);
  const frame = asRecord(record?.intent_frame);
  const taskSlice = asRecord(frame?.current_task_slice);
  const contract = asRecord(frame?.intent_contract);
  return {
    schema_version: 1,
    original_request_hash: typeof frame?.original_request_hash === "string" ? frame.original_request_hash : "missing_original_request_hash",
    intent_contract_ref: typeof frame?.intent_contract_ref === "string" ? frame.intent_contract_ref : undefined,
    intent_contract_revision: typeof contract?.revision === "number" ? contract.revision : undefined,
    task_slice_id: typeof taskSlice?.task_slice_id === "string" ? taskSlice.task_slice_id : "missing_task_slice_id",
    task_understanding: typeof taskSlice?.objective === "string" ? taskSlice.objective : "Complete the assigned role task.",
    original_goal_contribution: typeof contract?.precise_rewrite === "string"
      ? `This output contributes to the original goal: ${contract.precise_rewrite}`
      : "This output contributes to the original scripted provider goal.",
    possible_intent_conflicts: [],
    assumptions_used: Array.isArray(contract?.assumptions) ? contract.assumptions.filter((item): item is string => typeof item === "string") : [],
    evidence_refs: [
      typeof frame?.original_request_ref === "string" ? frame.original_request_ref : "",
      typeof frame?.intent_contract_ref === "string" ? frame.intent_contract_ref : ""
    ].filter(Boolean)
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function extractJsonArrayAfterLabel(text: string, label: string): unknown[] {
  const index = text.indexOf(`${label}:`);
  if (index < 0) return [];
  const start = text.indexOf("[", index);
  if (start < 0) return [];
  let depth = 0;
  for (let cursor = start; cursor < text.length; cursor += 1) {
    const char = text[cursor];
    if (char === "[") depth += 1;
    if (char === "]") depth -= 1;
    if (depth === 0) {
      try {
        const parsed = JSON.parse(text.slice(start, cursor + 1));
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
  }
  return [];
}
