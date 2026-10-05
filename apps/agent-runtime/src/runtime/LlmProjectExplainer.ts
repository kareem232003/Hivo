import type { ProjectExplainEvidenceRef, ProjectExplainReport, ProjectExplainSection } from "@hivo/protocol";
import type { LlmProvider } from "../llm/LlmProvider.js";
import { evidenceCurationSchema, projectExplainSchema } from "../schemas/sessionSchemas.js";
import { validateStructuredOutput } from "../schemas/validators.js";
import {
  analyzeProjectQuestionGrounding,
  answerSatisfiesRequestedStyle,
  createConceptEvidenceGroupCoverage,
  createGroundingPackText,
  createStyleInstruction,
  evidenceItemSupportsConcept,
  evidenceItemSupportsPageInventory,
  findUnsupportedDomainClaims,
  isForecastingScopeConcept,
  isDecisionPolicyConcept,
  isPageInventoryConcept,
  isThresholdInventoryConcept,
  selectGroundingEvidenceRefs,
  type GroundingEvidenceItem,
  type ProjectQuestionGrounding
} from "./ProjectQuestionGrounding.js";
import {
  createWorkspaceReasoningPrompt,
  evidenceItemsForWorkspaceReasoning,
  responseLooksOffIntent
} from "./WorkspaceReasoningPipeline.js";
import { invokeReasoningProviderStructured, invokeReasoningProviderText } from "./ReasoningKernel.js";

export type ProjectExplainLlmResponse = {
  answerMarkdown: string;
  usedEvidenceRefs: string[];
  unsupportedOrUnclearParts: string[];
};

export type ProjectExplainResult = ProjectExplainLlmResponse & {
  revisionCount: number;
  validationWarnings: string[];
  grounding: ProjectQuestionGrounding;
  fallbackUsed: boolean;
  fallbackReason?: string;
};

export type ProjectExplainProviderAnswerMode = "structured_json" | "natural_text";

type EvidenceItem = GroundingEvidenceItem & {
  ref: string;
  markdownLink: string;
  path: string;
  line: number;
  title: string;
  reason: string;
  snippet?: string;
};

type RepairEvidenceGroup = NonNullable<ProjectQuestionGrounding["concept"]["evidenceGroups"]>[number];

type EvidenceCurationResponse = {
  selectedEvidenceRefs: string[];
  missingFacts: string[];
  rationale: string;
};

const MAX_EVIDENCE_ITEMS = 120;
const MAX_NATURAL_TEXT_EVIDENCE_ITEMS = 45;
const MAX_REPAIR_TEXT_EVIDENCE_ITEMS = 75;
const MAX_SNIPPET_CHARS = 700;

export async function explainProjectWithLlm(input: {
  provider: LlmProvider;
  userPrompt: string;
  report: ProjectExplainReport;
  providerAnswerMode?: ProjectExplainProviderAnswerMode;
}): Promise<ProjectExplainResult> {
  const providerAnswerMode = input.providerAnswerMode ?? "structured_json";
  const evidenceItems = createEvidenceItems(input.report);
  const grounding = analyzeProjectQuestionGrounding(input.userPrompt, input.report, evidenceItems);
  let providerEvidenceItems = providerAnswerMode === "natural_text"
    ? selectProviderEvidenceItems(evidenceItems, grounding)
    : evidenceItems;
  if (providerAnswerMode === "natural_text" && evidenceItems.length > MAX_NATURAL_TEXT_EVIDENCE_ITEMS) {
    providerEvidenceItems = await curateProviderEvidenceItems(input.provider, input.userPrompt, evidenceItems, providerEvidenceItems, grounding);
  }
  const firstRequest = createExplainRequest(input.userPrompt, input.report, providerEvidenceItems, grounding);
  let first: ProjectExplainLlmResponse;
  try {
    first = providerAnswerMode === "natural_text"
      ? naturalTextToProjectExplainResponse(await invokeReasoningProviderText(input.provider, createNaturalTextExplainRequest(input.userPrompt, input.report, providerEvidenceItems, grounding)))
      : await invokeReasoningProviderStructured<ProjectExplainLlmResponse>(input.provider, firstRequest, projectExplainSchema);
  } catch (error) {
    throw new Error(`project_explain_provider_failed: ${formatProviderError(error)}`);
  }
  const firstValidation = validateProjectExplainResponse(first, input.userPrompt, providerEvidenceItems, grounding);
  if (firstValidation.valid) {
    const result = normalizeProjectExplainResponse(first, 0, firstValidation.warnings, grounding);
    return result;
  }

  const revisionEvidenceItems = providerAnswerMode === "natural_text"
    ? selectRepairEvidenceItems(evidenceItems, providerEvidenceItems, grounding, firstValidation.errors)
    : providerEvidenceItems;
  let revision: ProjectExplainLlmResponse;
  try {
    revision = providerAnswerMode === "natural_text"
      ? naturalTextToProjectExplainResponse(await invokeReasoningProviderText(input.provider, createNaturalTextRevisionRequest(input.userPrompt, input.report, revisionEvidenceItems, grounding, first, firstValidation.errors)))
      : await invokeReasoningProviderStructured<ProjectExplainLlmResponse>(
          input.provider,
          createRevisionRequest(input.userPrompt, input.report, revisionEvidenceItems, grounding, first, firstValidation.errors),
          projectExplainSchema
        );
  } catch (error) {
    throw new Error(`project_explain_provider_repair_failed: ${formatProviderError(error)}`);
  }
  const revisionValidation = validateProjectExplainResponse(revision, input.userPrompt, revisionEvidenceItems, grounding);
  if (revisionValidation.valid) {
    const result = normalizeProjectExplainResponse(revision, 1, revisionValidation.warnings, grounding);
    return result;
  }

  const validationErrors = [
    ...firstValidation.errors,
    ...revisionValidation.errors
  ].filter((error, index, all) => all.indexOf(error) === index);
  throw new Error(providerValidationFailureReason(validationErrors));
}

function providerValidationFailureReason(errors: string[]) {
  const details = uniqueStrings(errors).slice(0, 3).join("; ");
  return details
    ? `provider_answer_failed_local_validation: ${details}`
    : "provider_answer_failed_local_validation";
}

function createExplainRequest(
  userPrompt: string,
  report: ProjectExplainReport,
  evidenceItems: EvidenceItem[],
  grounding: ProjectQuestionGrounding
) {
  return {
    purpose: "compose" as const,
    systemPrompt: createSystemPrompt(grounding),
    userPrompt: [
      "User prompt:",
      userPrompt,
      "",
      "Grounding gate:",
      createGroundingPackText(grounding),
      "",
      createWorkspaceReasoningPrompt(grounding.workspaceReasoning),
      "",
      "Project evidence pack:",
      createEvidencePackText(report, evidenceItems, grounding),
      "",
      "Return strict JSON with this exact shape:",
      JSON.stringify({
        answerMarkdown: "Markdown answer that directly answers the user's prompt.",
        usedEvidenceRefs: ["path/to/file.ext:line"],
        unsupportedOrUnclearParts: ["Any claim the evidence does not prove, or an empty array."]
      }, null, 2)
    ].join("\n")
  };
}

function createNaturalTextExplainRequest(
  userPrompt: string,
  report: ProjectExplainReport,
  evidenceItems: EvidenceItem[],
  grounding: ProjectQuestionGrounding
) {
  return {
    purpose: "compose" as const,
    systemPrompt: [
      createSystemPrompt(grounding).replace("Return strict JSON only. Do not wrap it in markdown.", "Return Markdown only. Do not return JSON."),
      "Your answer must cite the provided hivo-file links inline for every concrete code-behavior claim.",
      "Do not include a separate metadata object. The runtime will extract refs from your Markdown links."
    ].join("\n"),
    userPrompt: [
      "User prompt:",
      userPrompt,
      "",
      "Grounding gate:",
      createGroundingPackText(grounding),
      "",
      createWorkspaceReasoningPrompt(grounding.workspaceReasoning),
      "",
      "Project evidence pack:",
      createEvidencePackText(report, evidenceItems, grounding),
      "",
      "Write the final answer as Markdown prose.",
      "Use only the hivo-file links listed in the evidence pack, copied exactly.",
      "If the evidence does not prove part of the answer, say that plainly instead of filling the gap."
    ].join("\n")
  };
}

function createRevisionRequest(
  userPrompt: string,
  report: ProjectExplainReport,
  evidenceItems: EvidenceItem[],
  grounding: ProjectQuestionGrounding,
  previous: ProjectExplainLlmResponse,
  errors: string[]
) {
  return {
    purpose: "compose" as const,
    systemPrompt: createSystemPrompt(grounding),
    userPrompt: [
      "Revise the previous project explanation. It failed local validation.",
      "",
      "Validation errors:",
      ...errors.map((error) => `- ${error}`),
      "",
      "Validation repair instructions:",
      createValidationRepairInstructions(errors, grounding),
      "",
      "Original user prompt:",
      userPrompt,
      "",
      "Grounding gate:",
      createGroundingPackText(grounding),
      "",
      createWorkspaceReasoningPrompt(grounding.workspaceReasoning),
      "",
      "Previous response:",
      JSON.stringify(previous, null, 2),
      "",
      "Project evidence pack:",
      createEvidencePackText(report, evidenceItems, grounding),
      "",
      "Return corrected strict JSON only."
    ].join("\n")
  };
}

function createNaturalTextRevisionRequest(
  userPrompt: string,
  report: ProjectExplainReport,
  evidenceItems: EvidenceItem[],
  grounding: ProjectQuestionGrounding,
  previous: ProjectExplainLlmResponse,
  errors: string[]
) {
  return {
    purpose: "compose" as const,
    systemPrompt: [
      createSystemPrompt(grounding).replace("Return strict JSON only. Do not wrap it in markdown.", "Return Markdown only. Do not return JSON."),
      "Your revised answer must fix the validation errors and cite only provided hivo-file links."
    ].join("\n"),
    userPrompt: [
      "Revise the previous project explanation. It failed local validation.",
      "",
      "Validation errors:",
      ...errors.map((error) => `- ${error}`),
      "",
      "Validation repair instructions:",
      createValidationRepairInstructions(errors, grounding),
      "",
      "Original user prompt:",
      userPrompt,
      "",
      "Previous Markdown answer:",
      previous.answerMarkdown,
      "",
      "Grounding gate:",
      createGroundingPackText(grounding),
      "",
      createWorkspaceReasoningPrompt(grounding.workspaceReasoning),
      "",
      "Project evidence pack:",
      createEvidencePackText(report, evidenceItems, grounding),
      "",
      "Return corrected Markdown only."
    ].join("\n")
  };
}

function createValidationRepairInstructions(errors: string[], grounding: ProjectQuestionGrounding) {
  const lines = [
    "Use the validation errors as a repair plan, not as text to quote to the user.",
    "Keep the same user question. Do not switch to a different specialized flow.",
    "Every repaired claim must cite an allowed hivo-file link from the evidence pack."
  ];
  const errorText = errors.join("\n");
  if (/no hivo-file citations|must include at least one provided hivo-file link|unknown hivo-file ref|ungrounded plain file ref/i.test(errorText)) {
    lines.push("Citation repair: replace plain paths or uncited claims with exact hivo-file links copied from the evidence pack.");
  }
  if (/directly supports the requested concept|requested concept was not found|requested evidence group/i.test(errorText)) {
    lines.push(`Concept repair: cite refs whose reason, title, snippet, or relationship context directly supports \`${grounding.concept.label}\`; if support is missing, say which relationship is not proven.`);
  }
  if (/wrong flow|different topic|does not appear to directly answer/i.test(errorText)) {
    lines.push("Intent repair: answer the original question directly before adding context; remove unrelated overview material.");
  }
  if (/too shallow|too few sections|detailed flow/i.test(errorText)) {
    lines.push("Depth repair: expand the concrete chain of files, functions, data/control-flow handoffs, inputs, outputs, and limits, with citations for each step.");
  }
  if (/forecasting|threshold|page inventory|numeric|domain|project identity/i.test(errorText)) {
    lines.push("Shape repair: only satisfy the specialized shape if it truly applies to this question; otherwise keep the answer centered on the requested concept and supported relationships.");
  }
  if (/dependency|configuration|config|manifest|requirements|package/i.test(errorText) || isDependencyOrConfigurationGrounding(grounding)) {
    lines.push("Dependency/config repair: cite dependency or configuration evidence from README.md, requirements.txt, package.json, pyproject.toml, Cargo.toml, entrypoint config, or detected script/config files when those refs are present.");
  }
  lines.push("If the evidence pack includes 'Agentic relationship-model evidence' or 'Relationships followed', use those refs to explain cross-file relationships instead of relying only on isolated snippets.");
  lines.push("If a validator asks for evidence that is not present in the pack, do not invent it; state the missing proof boundary clearly.");
  return lines.map((line) => `- ${line}`).join("\n");
}

function createSystemPrompt(grounding: ProjectQuestionGrounding) {
  return [
    "You are the only reasoning layer for a production project explanation feature.",
    "Use the unified workspace intent and evidence facets as the primary request understanding.",
    "Do not use memorized project categories, canned domain labels, or template stories.",
    "Infer what the project does only from the supplied evidence pack and the user's exact prompt.",
    `Question kind: ${grounding.questionKind}. Do not answer using a different specialized flow from an earlier turn.`,
    `Unified intent: actionMode=${grounding.workspaceReasoning.intent.actionMode}, answerGoal=${grounding.workspaceReasoning.intent.answerGoal}, topicPhrase=${grounding.workspaceReasoning.intent.topicPhrase}, outputShape=${grounding.workspaceReasoning.intent.outputShape}.`,
    `Required evidence facets: ${grounding.workspaceReasoning.intent.requiredFacets.join(", ") || "none"}.`,
    grounding.projectContextRequired
      ? "The user is asking about how something works inside this project. First state what the current project appears to be from project-domain refs, then answer the exact requested concept."
      : "Answer the user's specific question first. Do not default to a broad project overview unless the user asked for one.",
    `Requested answer style: ${grounding.style}. ${createStyleInstruction(grounding.style)}`,
    grounding.style === "detailed" || grounding.workspaceReasoning.intent.outputShape === "walkthrough"
      ? "For detailed walkthroughs: use multiple named sections, explain each proven step in several sentences, cite concrete files/functions/endpoints, and avoid returning only a short bullet list."
      : "",
    `Project domain candidate: ${grounding.projectDomain.label} (${grounding.projectDomain.confidence}). Use it only if you cite its project-domain refs.`,
    grounding.concept.specific
      ? `Requested concept: ${grounding.concept.label}. Only explain this concept using the listed concept-supporting refs.`
      : "This is a general project explanation. Do not invent project name, users, business purpose, or domain unless the evidence states it.",
    `Requested answer shape: ${grounding.answerShape}. ${createAnswerShapeInstruction(grounding.answerShape)}`,
    isThresholdInventoryConcept(grounding) && grounding.answerShape === "inventory_table"
      ? "For threshold, formula, or numeric comparison questions: extract the concrete numbers, comparisons, formulas, branches, and actions into a useful table. Every number must have a cited ref."
      : "",
    isForecastingScopeConcept(grounding)
      ? "For forecasting questions: identify the proven forecasting type, inputs, outputs, and whether the scope is per-customer or aggregate/global. Say 'not proven' for scope if refs do not show it."
      : "",
    isDecisionPolicyConcept(grounding)
      ? "For decision-policy questions: explain the full condition chain across model signals, agent recommendation rules, orchestrator voting/routing rules, and final selected action. Do not answer as only an FCM implementation or only a forecasting scope question."
      : "",
    isPageInventoryConcept(grounding)
      ? "For page/screen inventory questions: inspect UI entrypoints, routes, nav/sidebar, sections, tabs, and rendered components first. Classify each item as route/page/section/tab/component. CSS or page titles are styling/context only and must never be counted as pages. Include what each item does, confidence, and UI evidence refs. Do not give threshold, formula, or forecasting tables unless the user asked for those."
      : "",
    grounding.workspaceReasoning.intent.requiredFacets.includes("algorithms_models")
      ? "For algorithm/model questions: distinguish actual algorithms/models from service wrappers, managers, and UI labels. If the user asks how one algorithm works, synthesize role, inputs, labels/training, prediction/use site, and related explainability from code refs instead of dumping snippets."
      : "",
    "For realtime claims, distinguish true realtime streams/sockets/consumers from polling/timers/repeated refresh. Say 'not proven' when the evidence does not prove either.",
    "Every factual claim about code behavior must be grounded in one of the provided refs.",
    "If a concept or project identity is not proven by the current workspace evidence, say you cannot confirm it instead of guessing.",
    "Use only provided hivo-file links. Do not invent file paths, line numbers, tools, or run commands.",
    "If evidence conflicts with the user's project name or idea, explain the conflict instead of forcing a label.",
    "Return strict JSON only. Do not wrap it in markdown."
  ].join("\n");
}

function createAnswerShapeInstruction(shape: ProjectQuestionGrounding["answerShape"]) {
  if (shape === "inventory_table") {
    return "Use a compact table when it helps list many values, comparisons, formulas, or conditions.";
  }
  if (shape === "detailed_walkthrough") {
    return "Use a structured walkthrough, but keep it grounded and avoid unrelated architecture dumps.";
  }
  return "Use concise prose. Do not add a table unless the user explicitly asked for an inventory, comparison, formulas, or many numbers.";
}

function createEvidencePackText(report: ProjectExplainReport, evidenceItems: EvidenceItem[], grounding: ProjectQuestionGrounding) {
  const moduleLines = report.moduleMap.slice(0, 12).map((module) => {
    const files = module.importantFiles.slice(0, 5).join(", ") || "no important files captured";
    return `- ${module.root}: ${module.responsibility}; files: ${files}`;
  });
  const evidenceLines = evidenceItems.map((item) => {
    const snippet = item.snippet ? `\n  snippet:\n${indent(trimText(item.snippet, MAX_SNIPPET_CHARS), "  ")}` : "";
    return [
      `- ref: ${item.ref}`,
      `  link: ${item.markdownLink}`,
      `  title: ${item.title}`,
      `  reason: ${item.reason}`,
      snippet
    ].filter(Boolean).join("\n");
  });
  return [
    `Overview: ${report.overview}`,
    `Architecture: ${report.architecture}`,
    `Data flow summary: ${report.dataFlow}`,
    `Entry points: ${report.entryPoints.join(", ") || "none proven"}`,
    `Important files: ${report.importantFiles.slice(0, 20).join(", ") || "none"}`,
    `Run commands found: ${report.howToRun.join(", ") || "none"}`,
    `Risks/unknowns: ${report.risksAndUnknowns.join(" | ") || "none recorded"}`,
    "",
    "Module map:",
    ...(moduleLines.length ? moduleLines : ["- none"]),
    "",
    "Internal read-only understanding lanes:",
    `- Project Mapper: ${grounding.understanding.projectMapperSummary}`,
    `- Data Flow Mapper: ${grounding.understanding.dataFlowSummary}`,
    `- Concept Specialist: ${grounding.concept.specific ? `${grounding.concept.label}; refs ${grounding.supportingRefs.join(", ") || "none"}` : "general project explanation"}`,
    `- Grounding Skeptic: project-domain refs ${grounding.projectDomain.evidenceRefs.join(", ") || "none"}; validation refs ${grounding.understanding.validationEvidence.slice(0, 10).map((item) => item.ref).join(", ") || "none"}`,
    "",
    "Allowed evidence refs and links:",
    ...(evidenceLines.length ? evidenceLines : ["- none"])
  ].join("\n");
}

function createEvidenceItems(report: ProjectExplainReport): EvidenceItem[] {
  const byRef = new Map<string, EvidenceItem>();
  const sectionCountsByFile = new Map<string, number>();
  const addSection = (section: ProjectExplainSection) => {
    const sectionCount = sectionCountsByFile.get(section.filePath) ?? 0;
    if (sectionCount >= 10) return;
    sectionCountsByFile.set(section.filePath, sectionCount + 1);
    const ref = normalizeRef(section.filePath, section.lineStart);
    const existing = byRef.get(ref);
    if (existing) {
      if (!existing.snippet && section.snippet) existing.snippet = section.snippet;
      if (!existing.reason && (section.whyItMatters || section.explanation)) existing.reason = section.whyItMatters || section.explanation;
      if (!existing.title && section.title) existing.title = section.title;
      return;
    }
    byRef.set(ref, {
      ref,
      markdownLink: formatFileLineLink(section.filePath, section.lineStart),
      path: section.filePath,
      line: section.lineStart,
      title: section.title,
      reason: section.whyItMatters || section.explanation,
      snippet: section.snippet
    });
  };
  const addEvidence = (evidence: ProjectExplainEvidenceRef) => {
    if (evidence.type === "directory") return;
    const line = evidence.lineStart ?? 1;
    const ref = normalizeRef(evidence.path, line);
    const existing = byRef.get(ref);
    if (existing) {
      if (!existing.snippet && (evidence.snippet ?? evidence.excerpt)) existing.snippet = evidence.snippet ?? evidence.excerpt;
      if (!existing.reason && evidence.reason) existing.reason = evidence.reason;
      if (!existing.title && evidence.symbol) existing.title = evidence.symbol;
      return;
    }
    byRef.set(ref, {
      ref,
      markdownLink: formatFileLineLink(evidence.path, line),
      path: evidence.path,
      line,
      title: evidence.symbol ?? evidence.type,
      reason: evidence.reason,
      snippet: evidence.snippet ?? evidence.excerpt
    });
  };
  for (const evidence of report.evidence) {
    if (/arima|forecast|trend|model|models|classifier|classification|cluster|clustering|algorithm|analytics|pipeline|shap|svm|kmeans|orchestrator|agents?|routes?|services|frontend|dashboard_ui|(^|\/)src\/app\/|pages|screens|views|components|app\.(jsx|tsx|js|ts)|index\.html/i.test(evidence.path)) {
      addEvidence(evidence);
    }
  }
  for (const section of report.sections) addSection(section);
  for (const evidence of report.evidence) addEvidence(evidence);
  for (const module of report.moduleMap) {
    for (const evidence of module.evidence) addEvidence(evidence);
  }
  return [...byRef.values()].slice(0, MAX_EVIDENCE_ITEMS);
}

function selectProviderEvidenceItems(evidenceItems: EvidenceItem[], grounding: ProjectQuestionGrounding) {
  if (evidenceItems.length <= MAX_NATURAL_TEXT_EVIDENCE_ITEMS) return evidenceItems;
  const byRef = new Map(evidenceItems.map((item) => [item.ref, item]));
  const selected: EvidenceItem[] = [];
  const addRef = (ref: string) => {
    const item = byRef.get(normalizeRefString(ref));
    if (item && !selected.some((candidate) => candidate.ref === item.ref)) selected.push(item);
  };
  const addItem = (item: EvidenceItem | undefined) => {
    if (item && !selected.some((candidate) => candidate.ref === item.ref)) selected.push(item);
  };

  for (const ref of selectGroundingEvidenceRefs(grounding, evidenceItems)) addRef(ref);
  for (const ref of grounding.projectDomain.evidenceRefs) addRef(ref);
  for (const ref of grounding.projectDomain.sourceEvidenceRefs) addRef(ref);
  for (const ref of grounding.projectDomain.documentationEvidenceRefs) addRef(ref);
  for (const ref of grounding.supportingRefs) addRef(ref);
  for (const item of evidenceItemsForWorkspaceReasoning(grounding.workspaceReasoning)) addRef(item.ref);
  for (const item of grounding.understanding.validationEvidence) addRef(item.ref);
  if (isDependencyOrConfigurationGrounding(grounding)) {
    for (const item of evidenceItems) {
      if (isDependencyOrConfigurationEvidencePath(item.path)) addItem(item);
      if (selected.length >= MAX_NATURAL_TEXT_EVIDENCE_ITEMS) break;
    }
  }
  if (grounding.concept.specific) {
    for (const item of evidenceItems) {
      if (evidenceItemSupportsConcept(item, grounding.concept)) addItem(item);
      if (selected.length >= MAX_NATURAL_TEXT_EVIDENCE_ITEMS) break;
    }
  }
  for (const item of evidenceItems) {
    addItem(item);
    if (selected.length >= MAX_NATURAL_TEXT_EVIDENCE_ITEMS) break;
  }
  return selected.slice(0, MAX_NATURAL_TEXT_EVIDENCE_ITEMS);
}

function selectRepairEvidenceItems(
  evidenceItems: EvidenceItem[],
  currentItems: EvidenceItem[],
  grounding: ProjectQuestionGrounding,
  errors: string[]
) {
  if (evidenceItems.length <= currentItems.length) return currentItems;
  const selected: EvidenceItem[] = [...currentItems];
  const addItem = (item: EvidenceItem | undefined) => {
    if (item && !selected.some((candidate) => candidate.ref === item.ref)) selected.push(item);
  };
  const addRef = (ref: string) => addItem(evidenceItems.find((item) => item.ref === normalizeRefString(ref)));
  const errorText = errors.join("\n");

  for (const ref of selectGroundingEvidenceRefs(grounding, evidenceItems)) addRef(ref);
  for (const ref of grounding.supportingRefs) addRef(ref);
  for (const ref of grounding.projectDomain.evidenceRefs) addRef(ref);
  for (const ref of grounding.projectDomain.sourceEvidenceRefs) addRef(ref);
  for (const item of evidenceItemsForWorkspaceReasoning(grounding.workspaceReasoning)) addRef(item.ref);
  if (isDependencyOrConfigurationGrounding(grounding)) {
    for (const item of evidenceItems) {
      if (isDependencyOrConfigurationEvidencePath(item.path)) addItem(item);
      if (selected.length >= MAX_REPAIR_TEXT_EVIDENCE_ITEMS) break;
    }
  }

  if (/requested evidence group|directly supports the requested concept|wrong flow|too shallow|detailed flow/i.test(errorText)) {
    for (const item of evidenceItems) {
      const text = evidenceItemText(item);
      if (/Agentic relationship-model evidence|Relationships followed|Data\/control flow|mental model/i.test(text)) addItem(item);
      if (grounding.concept.specific && evidenceItemSupportsConcept(item, grounding.concept)) addItem(item);
      if (selected.length >= MAX_REPAIR_TEXT_EVIDENCE_ITEMS) break;
    }
  }

  if (grounding.concept.evidenceGroups?.length) {
    for (const group of grounding.concept.evidenceGroups) {
      for (const item of evidenceItems) {
        if (itemSupportsEvidenceGroup(item, group)) addItem(item);
        if (selected.length >= MAX_REPAIR_TEXT_EVIDENCE_ITEMS) break;
      }
      if (selected.length >= MAX_REPAIR_TEXT_EVIDENCE_ITEMS) break;
    }
  }

  for (const item of evidenceItems) {
    addItem(item);
    if (selected.length >= MAX_REPAIR_TEXT_EVIDENCE_ITEMS) break;
  }
  return selected.slice(0, MAX_REPAIR_TEXT_EVIDENCE_ITEMS);
}

async function curateProviderEvidenceItems(
  provider: LlmProvider,
  question: string,
  allEvidence: EvidenceItem[],
  deterministicSelection: EvidenceItem[],
  grounding: ProjectQuestionGrounding
) {
  try {
    const generated = await invokeReasoningProviderStructured<EvidenceCurationResponse>(provider, {
      purpose: "curate",
      systemPrompt: [
        "You curate an allow-listed evidence pack for a project question.",
        "Select only refs supplied below. Do not create or rewrite refs.",
        "Prefer evidence that directly answers the question and preserves required structural manifests/configs.",
        `Select at most ${MAX_NATURAL_TEXT_EVIDENCE_ITEMS} refs. Return strict JSON only.`
      ].join("\n"),
      userPrompt: [
        "Question:",
        question,
        "",
        `Required facets: ${grounding.workspaceReasoning.intent.requiredFacets.join(", ") || "none"}`,
        "",
        "Evidence allow-list:",
        ...allEvidence.map((item) => `- ${item.ref} | ${item.title} | ${item.reason}`).slice(0, MAX_EVIDENCE_ITEMS),
        "",
        "Return { selectedEvidenceRefs, missingFacts, rationale }."
      ].join("\n")
    }, evidenceCurationSchema);
    const validation = validateStructuredOutput(generated, evidenceCurationSchema);
    if (!validation.valid) return deterministicSelection;
    const byRef = new Map(allEvidence.map((item) => [normalizeRefString(item.ref), item]));
    const selected = generated.selectedEvidenceRefs
      .map((ref) => byRef.get(normalizeRefString(ref)))
      .filter((item): item is EvidenceItem => Boolean(item));
    if (isDependencyOrConfigurationGrounding(grounding)) {
      for (const item of allEvidence.filter((candidate) => isDependencyOrConfigurationEvidencePath(candidate.path))) {
        if (!selected.some((candidate) => candidate.ref === item.ref)) selected.push(item);
      }
    }
    return selected.length
      ? selected.slice(0, MAX_NATURAL_TEXT_EVIDENCE_ITEMS)
      : deterministicSelection;
  } catch {
    return deterministicSelection;
  }
}

function itemSupportsEvidenceGroup(item: EvidenceItem, group: RepairEvidenceGroup) {
  const normalizedText = normalizeRepairEvidenceText(evidenceItemText(item));
  return [...group.aliases, ...group.coreTerms].some((term) => {
    const normalizedTerm = normalizeRepairEvidenceText(term);
    return normalizedTerm.length > 1 && normalizedText.includes(normalizedTerm);
  });
}

function normalizeRepairEvidenceText(value: string) {
  return value
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isDependencyOrConfigurationGrounding(grounding: ProjectQuestionGrounding) {
  const text = [
    grounding.workspaceReasoning.intent.topicPhrase,
    ...grounding.workspaceReasoning.intent.topicTerms,
    grounding.concept.label
  ].join(" ");
  return /\b((?:tech|technology)\s+stack|dependenc(?:y|ies)|configuration|config|runtime|package manager|package\.json|requirements?\.txt|manifest|scripts?|pyproject|Cargo\.toml|README\.md)\b/i.test(text);
}

function isDependencyOrConfigurationEvidencePath(filePath: string) {
  const normalized = filePath.replaceAll("\\", "/");
  return /(^|\/)(README\.md|requirements(?:-[\w.-]+)?\.txt|package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|pyproject\.toml|poetry\.lock|Pipfile|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|deno\.jsonc?|vite\.config\.[cm]?[jt]s|tsconfig\.json|backend\/main\.py|frontend\/app\.js)$/i.test(normalized)
    || /(^|\/)(config|settings|scripts?)[\w./-]*\.(?:json|toml|ya?ml|js|ts|py|sh|ps1)$/i.test(normalized);
}

function validateProjectExplainResponse(
  response: ProjectExplainLlmResponse,
  userPrompt: string,
  evidenceItems: EvidenceItem[],
  grounding: ProjectQuestionGrounding
) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const allowedRefs = new Set(evidenceItems.map((item) => item.ref));
  const conceptSupportingRefs = new Set(grounding.supportingRefs);
  if (!response || typeof response !== "object") {
    return { valid: false, errors: ["response must be an object"], warnings };
  }
  if (typeof response.answerMarkdown !== "string" || response.answerMarkdown.trim().length < 40) {
    errors.push("answerMarkdown must be a non-empty, useful answer.");
  }
  if (!Array.isArray(response.usedEvidenceRefs)) {
    errors.push("usedEvidenceRefs must be an array.");
  } else {
    for (const ref of response.usedEvidenceRefs) {
      if (typeof ref !== "string" || !allowedRefs.has(normalizeRefString(ref))) {
        errors.push(`usedEvidenceRefs contains an unknown ref: ${String(ref)}`);
      }
    }
  }
  if (!Array.isArray(response.unsupportedOrUnclearParts)) {
    errors.push("unsupportedOrUnclearParts must be an array.");
  }
  const linkedRefs = extractOrchcodeRefs(response.answerMarkdown ?? "");
  for (const ref of linkedRefs) {
    if (!allowedRefs.has(ref)) {
      errors.push(`answerMarkdown contains an unknown hivo-file ref: ${ref}`);
    }
  }
  const plainRefs = extractPlainPathRefs(response.answerMarkdown ?? "");
  for (const ref of plainRefs) {
    if (!allowedRefs.has(ref)) {
      errors.push(`answerMarkdown contains an ungrounded plain file ref: ${ref}`);
    }
  }
  const citedRefs = uniqueStrings([
    ...linkedRefs,
    ...plainRefs,
    ...(Array.isArray(response.usedEvidenceRefs) ? response.usedEvidenceRefs.map((ref) => typeof ref === "string" ? normalizeRefString(ref) : "") : [])
  ]);
  if (evidenceItems.length && citedRefs.length === 0) {
    errors.push("answerMarkdown must include at least one provided hivo-file link or verified plain file ref.");
  }
  if (responseLooksOffIntent(response.answerMarkdown ?? "", grounding.workspaceReasoning)) {
    errors.push(`answer appears to follow the wrong flow for topic: ${grounding.workspaceReasoning.intent.topicPhrase}`);
  }
  const primaryEvidenceRefs = new Set(evidenceItemsForWorkspaceReasoning(grounding.workspaceReasoning).map((item) => item.ref));
  if (grounding.workspaceReasoning.intent.requiredFacets.length && citedRefs.length && !citedRefs.some((ref) => primaryEvidenceRefs.has(ref))) {
    warnings.push(`answer did not cite the top unified workspace evidence for topic: ${grounding.workspaceReasoning.intent.topicPhrase}`);
  }
  if (isDependencyOrConfigurationGrounding(grounding)) {
    const dependencyConfigItems = evidenceItems.filter((item) => isDependencyOrConfigurationEvidencePath(item.path));
    if (dependencyConfigItems.length && citedRefs.length && !citedRefs.some((ref) => dependencyConfigItems.some((item) => item.ref === ref))) {
      errors.push(`dependency/configuration answers must cite available dependency or configuration refs: ${dependencyConfigItems.slice(0, 8).map((item) => item.ref).join(", ")}`);
    }
  }
  if (grounding.concept.specific) {
    const citedItems = citedRefs
      .map((ref) => evidenceItems.find((candidate) => candidate.ref === ref))
      .filter((item): item is EvidenceItem => Boolean(item));
    const expandedCitedItems = expandCitedEvidenceItems(citedItems, evidenceItems);
    if (!grounding.conceptFound) {
      errors.push(`requested concept was not found in the current workspace evidence: ${grounding.concept.label}`);
    } else if (!expandedCitedItems.some((item) => conceptSupportingRefs.has(item.ref))) {
      errors.push(`answer must cite evidence that directly supports the requested concept: ${grounding.concept.label}`);
    }
    if (grounding.concept.evidenceGroups?.length) {
      const citedCoverage = createConceptEvidenceGroupCoverage(grounding.concept, expandedCitedItems);
      const missingGroups = citedCoverage.filter((group) => !group.found).map((group) => group.label);
      if (missingGroups.length) {
        errors.push(`answer citations must cover requested evidence group(s): ${missingGroups.join(", ")}`);
      }
    }
    if (isThresholdInventoryConcept(grounding)) {
      if (!expandedCitedItems.some(citationHasNumericSupport)) {
        errors.push("threshold answers must cite current-workspace lines that contain numeric comparisons, constants, weights, or formulas.");
      }
    }
    if (isForecastingScopeConcept(grounding)) {
      if (!expandedCitedItems.some((item) => /\b(forecast|forecasting|arima|sarima|trend|prediction|delta|deviation)\b/i.test(evidenceItemText(item)))) {
        errors.push("forecasting answers must cite current-workspace lines that support the forecasting type or trend logic.");
      }
      errors.push(...validateForecastingAnswerShape(response.answerMarkdown ?? "", userPrompt, expandedCitedItems));
    }
    if (isPageInventoryConcept(grounding)) {
      if (!expandedCitedItems.some((item) => evidenceItemSupportsPageInventory(item))) {
        errors.push("page inventory answers must cite current-workspace UI route, navigation, view, or section evidence.");
      }
      if (!answerMentionsPageInventory(response.answerMarkdown ?? "")) {
        errors.push("page inventory answers must actually discuss pages, screens, views, routes, or sections.");
      }
      if (!answerExplainsPageFunctions(response.answerMarkdown ?? "")) {
        errors.push("page inventory answers must describe what each page, screen, view, route, or section does.");
      }
      if (answerLooksLikeWrongSpecializedFlow(response.answerMarkdown ?? "", "page_inventory")) {
        errors.push("page inventory answers must not answer with thresholds, formulas, forecasting, or unrelated numeric inventories.");
      }
      if (citedItems.length && !expandedCitedItems.some((item) => pageInventoryCitationHasStructuralSupport(item))) {
        errors.push("page inventory citations must include real route, nav, tab, or section structure, not only CSS, titles, package files, or generic docs.");
      }
    }
    for (const ref of citedRefs.filter(Boolean)) {
      const item = evidenceItems.find((candidate) => candidate.ref === ref);
      if (item && !evidenceItemSupportsConcept(item, grounding.concept) && answerMentionsRequestedConcept(response.answerMarkdown ?? "", grounding)) {
        warnings.push(`citation ${ref} does not itself support ${grounding.concept.label}; another cited ref must carry that claim.`);
      }
    }
  }
  if (grounding.projectContextRequired && grounding.projectDomain.confidence !== "unknown" && grounding.projectDomain.label !== "unknown") {
    const domainRefs = new Set(grounding.projectDomain.evidenceRefs);
    const domainSourceRefs = new Set(grounding.projectDomain.sourceEvidenceRefs);
    const mentionsDomain = answerMentionsProjectDomain(response.answerMarkdown ?? "", grounding);
    if (!mentionsDomain) {
      errors.push(`answer must explain the current project identity/domain before the focused concept: ${grounding.projectDomain.label}`);
    }
    if (!citedRefs.some((ref) => domainRefs.has(ref))) {
      errors.push(`answer must cite current-workspace evidence for project identity/domain: ${grounding.projectDomain.label}`);
    }
    if (domainSourceRefs.size && mentionsDomain && !citedRefs.some((ref) => domainSourceRefs.has(ref))) {
      errors.push(`answer must cite source evidence for project identity/domain when source evidence exists: ${grounding.projectDomain.label}`);
    }
  }
  const structuralFileContext = isStructuralFileContextQuestion(userPrompt);
  const unsupportedDomainClaims = structuralFileContext
    ? []
    : findUnsupportedDomainClaims(response.answerMarkdown ?? "", evidenceItems, grounding.concept);
  if (unsupportedDomainClaims.length) {
    errors.push(`answer mentions unsupported project/domain claim(s): ${unsupportedDomainClaims.join(", ")}`);
  }
  if (!answerSatisfiesRequestedStyle(response.answerMarkdown ?? "", grounding.style)) {
    errors.push(`answer does not preserve the requested ${grounding.style} style.`);
  }
  if ((grounding.style === "detailed" || grounding.workspaceReasoning.intent.outputShape === "walkthrough") && evidenceItems.length) {
    const answerText = response.answerMarkdown ?? "";
    const sectionCount = countDetailedAnswerSections(answerText);
    if (answerText.trim().length < 900 || sectionCount < 3) {
      errors.push(`detailed walkthrough answer is too shallow: ${answerText.trim().length} chars and ${sectionCount} section(s).`);
    }
    if (!structuralFileContext && grounding.workspaceReasoning.intent.answerGoal === "trace_flow" && !/\b(def|function|class|endpoint|route|api|fit|predict|predict_proba|SVC|SHAP|joblib|pickle|train_|predict_)\b/i.test(answerText)) {
      errors.push("detailed flow answer must mention concrete functions, endpoints, or implementation symbols from the evidence.");
    }
  }
  if (!appearsToAnswerPrompt(response.answerMarkdown ?? "", userPrompt)) {
    errors.push("answerMarkdown does not appear to directly answer the user's prompt.");
  }
  return { valid: errors.length === 0, errors, warnings };
}

function isStructuralFileContextQuestion(userPrompt: string) {
  const normalized = normalizeRepairEvidenceText(userPrompt).replace(/[.\\/]+/g, " ");
  return /\b(?:main\s+)?entry\s*points?\b|\bentrypoints?\b|\bentry\s+files?\b/.test(normalized)
    || /\bwhat\s+are\s+the\s+main\s+files\b/.test(normalized)
    || /\buse\s+the\s+detected\s+candidates\b/.test(normalized) && /\bmain\b|\bentry\b|\bbackend\s+main\b|\bapp\s+js\b|\bapp\s+ts\b|\bapp\s+tsx\b|\bapp\s+jsx\b/.test(normalized)
    || /\bdetected\s+source\s+files\b/.test(normalized) && /\bconnect\b/.test(normalized) && /\bflow\b/.test(normalized)
    || /\bbackend\b/.test(normalized) && /\bfrontend\b/.test(normalized) && /\b(connect|wire|flow|source\s+files)\b/.test(normalized)
    || /\buse\s+only\s+project\s+files\s+such\s+as\b/.test(normalized) && /\b(connect|flow|backend|frontend)\b/.test(normalized)
    || /\b(?:tech|technology)\s+stack\b/i.test(normalized);
}

function naturalTextToProjectExplainResponse(markdown: string): ProjectExplainLlmResponse {
  const answerMarkdown = markdown.trim();
  return {
    answerMarkdown,
    usedEvidenceRefs: uniqueStrings([
      ...extractOrchcodeRefs(answerMarkdown),
      ...extractPlainPathRefs(answerMarkdown)
    ]),
    unsupportedOrUnclearParts: []
  };
}

function normalizeProjectExplainResponse(
  response: ProjectExplainLlmResponse,
  revisionCount: number,
  validationWarnings: string[],
  grounding: ProjectQuestionGrounding
): ProjectExplainResult {
  return {
    answerMarkdown: response.answerMarkdown.trim(),
    usedEvidenceRefs: [...new Set(response.usedEvidenceRefs.map(normalizeRefString))],
    unsupportedOrUnclearParts: response.unsupportedOrUnclearParts.filter((entry) => typeof entry === "string" && entry.trim()),
    revisionCount,
    validationWarnings,
    grounding,
    fallbackUsed: false
  };
}

function appearsToAnswerPrompt(answer: string, userPrompt: string) {
  const promptTerms = meaningfulTerms(userPrompt);
  if (!promptTerms.length) return true;
  const answerLower = answer.toLowerCase();
  return promptTerms.some((term) => answerLower.includes(term));
}

function answerMentionsRequestedConcept(answer: string, grounding: ProjectQuestionGrounding) {
  if (!grounding.concept.specific) return false;
  const answerLower = answer.toLowerCase();
  return [grounding.concept.label, ...grounding.concept.terms, ...grounding.concept.aliases]
    .some((term) => answerLower.includes(term.toLowerCase()));
}

function answerMentionsProjectDomain(answer: string, grounding: ProjectQuestionGrounding) {
  const domain = grounding.projectDomain;
  if (domain.confidence === "unknown" || domain.label === "unknown") return true;
  const answerLower = answer.toLowerCase();
  return [domain.label, ...domain.aliases]
    .filter((term) => term.trim().length > 2)
    .some((term) => answerLower.includes(term.toLowerCase()));
}

function answerLooksLikeWrongSpecializedFlow(answer: string, expected: ProjectQuestionGrounding["questionKind"]) {
  const normalized = answer.toLowerCase();
  if (expected === "page_inventory") {
    const pageMentions = /\b(page|pages|screen|screens|view|views|route|routes|nav|navigation|section|sections)\b|(?:\u0635\u0641\u062d|\u0634\u0627\u0634|\u0648\u0627\u062c\u0647)/i.test(answer);
    const thresholdMentions = /\b(threshold|thresholds|threshlod|score|formula|weight|cosine|membership|orchestrator|dispatch)\b|(?:\u0628\u0642\u0627\u0631\u0646|\u0623\u0631\u0642\u0627\u0645|\u0627\u0631\u0642\u0627\u0645|\u0645\u0639\u0627\u062f\u0644)/i.test(answer);
    return thresholdMentions && !pageMentions && (normalized.includes("| signal |") || normalized.includes("threshold"));
  }
  return false;
}

function validateForecastingAnswerShape(answer: string, userPrompt: string, citedItems: EvidenceItem[]) {
  const errors: string[] = [];
  const repeatedGeneric = (answer.match(/forecasting implementation:\s*The implementation applies forecasting in this code block/gi) ?? []).length;
  if (repeatedGeneric >= 3) {
    errors.push("forecasting answer repeats a generic implementation template instead of explaining the evidence.");
  }
  const shallowLineOneRefs = (answer.match(/\bbackend\/(?:routes|services\/arima_model)\.py:1\b/g) ?? []).length;
  const evidenceText = citedItems.map(evidenceItemText).join("\n");
  if (shallowLineOneRefs >= 3 && /\b(fit_cluster_models|get_cluster_state|trend_multiplier|normalized_trend|SARIMAX?|cluster)\b/i.test(evidenceText)) {
    errors.push("forecasting answer cites only shallow line-1 locations while deeper forecasting evidence is available.");
  }
  const mentionsScope = /\b(cluster-level|per-cluster|per-segment|predicted_cluster|get_cluster_state|customer-level|per customer|aggregate|global)\b|(?:مستوى\s+cluster|لكل\s+cluster|للعميل|للـ\s*customer)/iu.test(answer);
  if (!mentionsScope) {
    errors.push("forecasting answer must identify whether the forecast is cluster-level, aggregate, or customer-level.");
  }
  const requestsJudgment = /\b(wrong|correct|logical|logic|reasonable|sensible|valid|invalid|bug|flaw|production|demo|academic)\b/i.test(userPrompt)
    || /(?:منطقي|غلط|صح|صحيح|خطأ|خطا|مقبول|ينفع|مش\s+منطقي|متطبق\s+غلط|بشكل\s+غلط|ب\s*شكل\s+غلط|هل\s+دا)/u.test(userPrompt);
  if (requestsJudgment && !/\b(wrong|correct|logical|reasonable|production|demo|academic|weak|flaw|issue)\b|(?:منطقي|غلط|مقبول|ضعيف|خلل|production|demo|أكاديمي|اكاديمي)/iu.test(answer)) {
    errors.push("forecasting answer must answer the requested logic/correctness judgment.");
  }
  return errors;
}

function answerMentionsPageInventory(answer: string) {
  return /\b(page|pages|screen|screens|view|views|route|routes|nav|navigation|section|sections)\b|(?:\u0635\u0641\u062d|\u0634\u0627\u0634|\u0648\u0627\u062c\u0647)/i.test(answer);
}

function answerExplainsPageFunctions(answer: string) {
  return /\b(does|shows|lists|renders|opens|handles|displays|contains|what it does)\b|(?:\u0628\u062a\u0639\u0645\u0644|\u0628\u064a\u0639\u0631\u0636|\u062a\u0639\u0631\u0636|\u0628\u064a\u0641\u062a\u062d|\u0628\u062a\u0641\u062a\u062d|\u0648\u0638\u064a\u0641|\u0627\u0644\u0648\u0638\u064a\u0641\u0629)/i.test(answer);
}

function pageInventoryCitationHasStructuralSupport(item: EvidenceItem) {
  const path = item.path.replaceAll("\\", "/").toLowerCase();
  if (/\.(css|scss|sass|less)$/i.test(path)) return false;
  if (/package\.json|requirements\.txt|pyproject\.toml|cargo\.toml|readme\.md$/i.test(path)) return false;
  return /\b(BrowserRouter|createBrowserRouter|Routes|Route|router|path\s*:|href=|data-view|data-page|CHAPTERS|PAGES|ROUTES|VIEWS|TABS)\b|<\s*(nav|section|aside|main|a|button)\b/i.test(item.snippet ?? "");
}

function citationHasNumericSupport(item: EvidenceItem) {
  return /-?\d+(?:\.\d+)?/.test(evidenceItemText(item))
    && (/\b(threshold|threshlod|cutoff|floor|min|max|minimum|maximum|score|weight|gap|cosine|membership|severity|trend|drift|accepted|f1|accuracy|delta|deviation|multiplier|guardrail|forecast|arima|sarima|orchestrator|dispatch|condition|rule)\b/i.test(evidenceItemText(item))
      || /[<>]=?|==/.test(evidenceItemText(item)));
}

function expandCitedEvidenceItems(citedItems: EvidenceItem[], evidenceItems: EvidenceItem[]) {
  const citedRefs = new Set(citedItems.map((item) => item.ref));
  const citedPaths = new Set(citedItems.map((item) => item.path.replaceAll("\\", "/").toLowerCase()));
  const nearby = evidenceItems.filter((item) => {
    if (citedRefs.has(item.ref)) return true;
    const normalizedPath = item.path.replaceAll("\\", "/").toLowerCase();
    if (!citedPaths.has(normalizedPath)) return false;
    return citedItems.some((cited) => Math.abs(cited.line - item.line) <= 4);
  });
  return uniqueEvidenceItems([...citedItems, ...nearby]);
}

function evidenceItemText(item: EvidenceItem) {
  return [item.path, item.title, item.reason, item.snippet ?? ""].join("\n");
}

function meaningfulTerms(text: string) {
  const stopWords = new Set([
    "the", "and", "for", "this", "that", "with", "from", "project", "explain",
    "اشرح", "شرح", "المشروع", "مشروع", "دا", "ده", "دي", "ازاي", "كيف", "ايه", "إيه", "من", "في", "على", "هو", "هي"
  ]);
  return [...text.toLowerCase().matchAll(/[\p{L}\p{N}_-]+/gu)]
    .map((match) => match[0])
    .filter((term) => term.length > 2 && !stopWords.has(term))
    .slice(0, 12);
}

function extractOrchcodeRefs(markdown: string) {
  const refs: string[] = [];
  for (const match of markdown.matchAll(/hivo-file:([^)\s]+):(\d+)/g)) {
    try {
      refs.push(normalizeRef(decodeURIComponent(match[1] ?? ""), Number(match[2])));
    } catch {
      refs.push(`${match[1] ?? ""}:${match[2] ?? ""}`);
    }
  }
  return refs;
}

function extractPlainPathRefs(markdown: string) {
  const refs: string[] = [];
  for (const match of markdown.matchAll(/\b((?:[A-Za-z0-9_.-]+\/){1,}[A-Za-z0-9_.-]+\.[A-Za-z0-9]+):(\d+)\b/g)) {
    const path = match[1] ?? "";
    if (!path || path.startsWith("http/") || path.includes("hivo-file")) continue;
    refs.push(normalizeRef(path, Number(match[2])));
  }
  return uniqueStrings(refs);
}

function normalizeRefString(ref: string) {
  const match = ref.match(/^(.+):(\d+)$/);
  if (!match) return ref.trim();
  return normalizeRef(match[1] ?? "", Number(match[2]));
}

function normalizeRef(path: string, line: number) {
  return `${path.replaceAll("\\", "/")}:${line}`;
}

function formatFileLineLink(filePath: string, line: number) {
  return `[${filePath}:${line}](hivo-file:${encodeURIComponent(filePath)}:${line})`;
}

function trimText(value: string, maxChars: number) {
  return value.length > maxChars ? `${value.slice(0, maxChars - 3)}...` : value;
}

function formatProviderError(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function indent(value: string, prefix: string) {
  return value.split(/\r?\n/).map((line) => `${prefix}${line}`).join("\n");
}

function countDetailedAnswerSections(answer: string) {
  const markdownHeadings = (answer.match(/^#{2,4}\s+/gm) ?? []).length;
  const boldHeadings = (answer.match(/^\*\*[^*\n]{3,80}\*\*/gm) ?? []).length;
  return markdownHeadings + boldHeadings;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function uniqueEvidenceItems<T extends EvidenceItem>(items: T[]) {
  const byRef = new Map<string, T>();
  for (const item of items) {
    if (!byRef.has(item.ref)) byRef.set(item.ref, item);
  }
  return [...byRef.values()];
}
