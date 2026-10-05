import type { WorkspaceTools } from "../tools/WorkspaceTools.js";
import type { ProjectQuestionEvidence, ProjectQuestionUnderstanding } from "./UniversalProjectQuestionEngine.js";
import { resolveInvestigationConcept } from "./ProjectIntelligenceKernel.js";

export type RequestedQuestionFacet =
  | "location"
  | "input_data"
  | "output"
  | "parameters"
  | "order"
  | "persistence"
  | "downstream_usage"
  | "uncertainty"
  | "code_snippets";

export type SourceRole =
  | "implementation"
  | "orchestration"
  | "artifact_preparation"
  | "downstream_stage"
  | "visualization"
  | "test"
  | "documentation"
  | "unrelated_name_match";

export type ConceptCallKind = "direct_algorithm_call" | "wrapper_call" | "payload_helper" | "downstream_usage" | "name_match";

export type ImplementationEvidence = {
  ref: string;
  path: string;
  line: number;
  markdownLink: string;
  snippet: string;
  sourceRole: SourceRole;
  semanticRole: SourceRole;
  roleReason: string;
  ownerSymbol: string;
  ownerStartLine: number;
  targetCallLine?: number;
  callKind: ConceptCallKind;
  canonicalAction: string;
  symbols: string[];
  calls: Array<{ name: string; arguments: string[] }>;
  assignments: Array<{ name: string; expression: string }>;
  outputNames: string[];
  returns: string[];
  upstreamReferences: string[];
  downstreamReferences: string[];
  confidence: "high" | "medium" | "low";
};

export type ConceptFlowStep = {
  order: number;
  label: string;
  whatHappens: string;
  inputData?: string;
  output?: string;
  outputNames: string[];
  parameters: string[];
  nextConsumers: string[];
  evidenceRef: string;
  sourceRole: SourceRole;
  semanticRole: SourceRole;
  roleReason: string;
  ownerSymbol: string;
  targetCallLine?: number;
  callKind: ConceptCallKind;
  canonicalAction: string;
  confidence: "high" | "medium" | "low";
};

export type ConceptFlow = {
  targetConcept: string;
  steps: ConceptFlowStep[];
  primaryEvidenceRefs: string[];
  secondaryEvidenceRefs: string[];
  uncertainties: string[];
};

export type CoverageValidation = {
  valid: boolean;
  coveredFacets: RequestedQuestionFacet[];
  missingFacets: RequestedQuestionFacet[];
  errors: string[];
};

export type RoleClassificationValidation = {
  valid: boolean;
  errors: string[];
  implementationRefs: string[];
  suppressedRefs: string[];
};

export type EvidenceGroup = {
  key: string;
  keptRef: string;
  refs: string[];
  semanticRole: SourceRole;
  ownerSymbol: string;
  canonicalAction: string;
};

export type DedupeValidation = {
  valid: boolean;
  errors: string[];
  groups: EvidenceGroup[];
};

export type OutputCleanupValidation = {
  valid: boolean;
  errors: string[];
  cleanedOutputs: string[];
};

export type LanguageValidation = {
  valid: boolean;
  expected: "arabic" | "english" | "mixed";
  errors: string[];
};

const CONCEPT_ALIASES: Record<string, string[]> = {
  dbscan: ["dbscan", "density-based", "density based", "fit_predict"],
  svm: ["svm", "svc", "linearsvc", "support vector"],
  fcm: ["fcm", "cmeans", "fuzzy c", "fuzzy c-means", "skfuzzy"],
  shap: ["shap", "kernelexplainer", "shap_values"],
  sarima: ["sarima", "sarimax", "arima"],
  feedback: ["feedback", "customer feedback", "customer_feedback", "submitfeedback", "awaiting_feedback", "positive", "negative", "neutral", "outcome"],
  outerloop: ["outerloop", "outer loop", "outer_loop", "orchestrator", "actionexecutor", "action executor", "feedback loop", "decision loop", "human review", "retention offer"],
  inner_loop: ["inner loop", "inner_loop", "innerloop", "model pipeline", "prediction", "decision"],
  inner_outer_loop: ["inner loop", "outer loop", "feedback loop", "decision loop", "action executor"],
  multi_agent_system: ["multi agent", "multi-agent", "multi agentic", "multi-agentic", "multiagent", "agentic system", "specialist agents", "build_default_agents", "reactorchestrator", "agent_recommendations", "agent_consensus", "weighted_votes"],
  human_review_loop: [
    "human review",
    "manual review",
    "review loop",
    "review route",
    "route_name review",
    "awaiting_feedback",
    "selected_action_name human review",
    "\u0645\u0631\u0627\u062c\u0639\u0629 \u0628\u0634\u0631\u064a\u0629",
    "\u0627\u0644\u0645\u0631\u0627\u062c\u0639\u0629 \u0627\u0644\u0628\u0634\u0631\u064a\u0629",
    "\u0645\u0631\u0627\u062c\u0639\u0629 \u064a\u062f\u0648\u064a\u0629",
    "\u062a\u062d\u0648\u064a\u0644 \u0644\u0644\u0645\u0631\u0627\u062c\u0639\u0629",
    "\u0628\u0648\u0627\u0628\u0629 \u0645\u0631\u0627\u062c\u0639\u0629",
    "\u062a\u062f\u062e\u0644 \u0628\u0634\u0631\u064a"
  ],
  action_loop: [
    "action loop",
    "action executor",
    "direct dispatch",
    "dispatch",
    "selected_action",
    "selected_action_name",
    "retention offer",
    "recommendation",
    "\u062a\u0646\u0641\u064a\u0630 \u0645\u0628\u0627\u0634\u0631",
    "\u062a\u0648\u062c\u064a\u0647 \u0645\u0628\u0627\u0634\u0631",
    "\u0625\u0631\u0633\u0627\u0644 \u0645\u0628\u0627\u0634\u0631",
    "\u0627\u0644\u0625\u062c\u0631\u0627\u0621 \u0627\u0644\u0641\u0627\u0626\u0632",
    "\u0627\u0644\u0623\u0643\u0634\u0646"
  ]
};

const STYLE_TERMS = new Set([
  "answer", "applied", "apply", "code", "current", "detail", "details", "detailed",
  "chain", "describe", "explain", "flow", "full", "here", "how", "implementation", "implemented", "inside",
  "list", "me", "show", "summarize", "tell",
  "path", "project", "snippet", "snippets", "stage", "stages", "step", "steps", "usage", "walkthrough", "work",
  "works", "ازاي", "إزاي", "كيف", "اشرح", "بالتفصيل", "هنا", "المشروع", "بيطبق", "بيتطبق"
]);

export function inferTargetConcept(input: {
  question: string;
  topicPhrase: string;
  topicTerms: string[];
  entities: string[];
}) {
  if (isStructuralFileContextQuestion(input.question)) return "general";
  const investigationConcept = resolveInvestigationConcept(input.question);
  if (
    investigationConcept.isTargeted
    && investigationConcept.targetConcept !== "general"
    && !(STYLE_TERMS.has(normalizeConceptTerm(investigationConcept.targetConcept)) && looksLikeRelationshipExploration(input.question))
  ) {
    return investigationConcept.targetConcept;
  }
  const fullQuestionConcept = canonicalConcept(input.question);
  if (fullQuestionConcept) return fullQuestionConcept;
  const candidates = [
    ...input.entities,
    ...input.topicTerms,
    input.topicPhrase,
    ...extractAsciiTokens(input.question)
  ].map(normalizeConceptTerm).filter(Boolean);
  for (const candidate of candidates) {
    const canonical = canonicalConcept(candidate);
    if (canonical) return canonical;
  }
  if (looksLikeRelationshipExploration(input.question)) return "general";
  return candidates.find((candidate) => !STYLE_TERMS.has(candidate) && candidate.length > 2) ?? normalizeConceptTerm(input.topicPhrase);
}

function isStructuralFileContextQuestion(question: string) {
  return isEntrypointInventoryQuestion(question)
    || isSourceFlowFileQuestion(question)
    || isTechStackInventoryQuestion(question);
}

function isTechStackInventoryQuestion(question: string) {
  const normalized = normalizeConceptTerm(question);

  return /\b(?:tech|technology)\s+stack\b/.test(normalized);
}

function isEntrypointInventoryQuestion(question: string) {
  const normalized = normalizeConceptTerm(question);
  return /\b(?:main\s+)?entry\s*points?\b|\bentrypoints?\b|\bentry\s+files?\b/.test(normalized)
    || /\bwhat\s+are\s+the\s+main\s+files\b/.test(normalized)
    || /\buse\s+the\s+detected\s+candidates\b/.test(normalized) && /\bmain\b|\bentry\b|\bbackend\s+main\b|\bapp\s+js\b|\bapp\s+ts\b|\bapp\s+tsx\b|\bapp\s+jsx\b/.test(normalized);
}

function isSourceFlowFileQuestion(question: string) {
  const normalized = normalizeConceptTerm(question);
  return /\bdetected\s+source\s+files\b/.test(normalized) && /\bconnect\b/.test(normalized) && /\bflow\b/.test(normalized)
    || /\bbackend\b/.test(normalized) && /\bfrontend\b/.test(normalized) && /\b(connect|wire|flow|source\s+files)\b/.test(normalized)
    || /\buse\s+only\s+project\s+files\s+such\s+as\b/.test(normalized) && /\b(connect|flow|backend|frontend)\b/.test(normalized);
}

function looksLikeRelationshipExploration(question: string) {
  const normalized = normalizeConceptTerm(question);
  return /\b(chain|flow|path|pipeline|stage|stages|step|steps|from|into|through|between|connect|link|follow|trace|relationship|handoff)\b/i.test(normalized)
    || /\bwhat does each stage prove\b/i.test(question);
}

export function inferRequestedFacets(question: string, understanding: Pick<ProjectQuestionUnderstanding, "expectedAnswerShape" | "detailLevel" | "wantsCodeExamples">): RequestedQuestionFacet[] {
  const normalized = normalizeConceptTerm(question);
  const facets: RequestedQuestionFacet[] = [];
  const add = (facet: RequestedQuestionFacet) => {
    if (!facets.includes(facet)) facets.push(facet);
  };
  add("location");
  if (understanding.expectedAnswerShape === "flow" || understanding.detailLevel === "detailed" || understanding.detailLevel === "deep") {
    add("input_data");
    add("output");
    add("parameters");
    add("order");
    add("downstream_usage");
    add("uncertainty");
  }
  if (/\b(input|feature|features|data|dataset|payload|takes?|arguments?)\b/.test(normalized) || /(?:بيانات|داتا|مدخلات|features)/.test(question)) add("input_data");
  if (/\b(output|return|returns?|result|labels?|clusters?|noise)\b/.test(normalized) || /(?:بيطلع|ناتج|نتيجة|labels|clusters|noise)/.test(question)) add("output");
  if (/\b(param|params|parameter|parameters|eps|min_samples|threshold|config)\b/.test(normalized) || /(?:بارامتر|براميتر|اعدادات|إعدادات)/.test(question)) add("parameters");
  if (/\b(before|after|order|sequence|pipeline|flow)\b/.test(normalized) || /(?:قبل|بعد|تسلسل|فلو)/.test(question)) add("order");
  if (/\b(save|saved|store|stored|persist|persistence|load|dump|joblib|pickle)\b/.test(normalized) || /(?:بيتخزن|تخزين|تحميل)/.test(question)) add("persistence");
  if (/\b(next|downstream|used by|feeds?|consumer|usage|api|endpoint|route)\b/.test(normalized) || /(?:بعدها|بيروح|بتدخل|استخدام|endpoint|api)/.test(question)) add("downstream_usage");
  if (understanding.wantsCodeExamples) add("code_snippets");
  return facets;
}

export function sanitizeSearchQuery(raw: string) {
  const compact = raw.trim();
  if (!compact) return "";
  const normalized = normalizeConceptTerm(compact);
  if (!normalized || STYLE_TERMS.has(normalized)) return "";
  const ascii = extractAsciiTokens(compact);
  if (ascii.length === 1 && canonicalConcept(ascii[0] ?? "")) return canonicalConcept(ascii[0] ?? "");
  if (/^[\u0600-\u06ff]+$/u.test(compact) && compact.length < 4) return "";
  return canonicalConcept(normalized) || normalized;
}

export function extractImplementationEvidence(input: {
  workspace: WorkspaceTools;
  filePaths: string[];
  targetConcept: string;
  requestedFacets: RequestedQuestionFacet[];
  positiveEvidence: ProjectQuestionEvidence[];
}): ImplementationEvidence[] {
  const aliases = aliasesForConcept(input.targetConcept);
  const candidatePaths = uniqueStrings([
    ...input.positiveEvidence.map((item) => item.path),
    ...input.filePaths.filter((filePath) => aliases.some((alias) => normalizeConceptTerm(filePath).includes(alias)))
  ]).filter((filePath) => isUsefulTextPath(filePath));
  const result: ImplementationEvidence[] = [];
  for (const path of candidatePaths) {
    let content = "";
    try {
      content = input.workspace.readWholeFile(path);
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const lineText = normalizeConceptTerm(line);
      if (!aliases.some((alias) => lineText.includes(alias))) continue;
      const block = enclosingCodeBlock(lines, index);
      if (/^\s*class\s+/.test(block.lines[0] ?? "") && !directTargetCalls(input.targetConcept, line, extractCalls(line)).length) continue;
      const snippet = block.lines.join("\n").trim().slice(0, 2_000);
      result.push(createImplementationEvidence(path, lines, block, index, snippet, input.targetConcept, "high"));
    }
  }
  const conceptSymbols = uniqueStrings(result.flatMap((item) => item.symbols).filter((symbol) => symbol.length > 3));
  if (conceptSymbols.length) {
    for (const path of input.filePaths.filter((filePath) => isUsefulTextPath(filePath))) {
      if (result.some((item) => item.path === path && item.semanticRole === "implementation")) continue;
      let content = "";
      try {
        content = input.workspace.readWholeFile(path);
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      const hitIndexes = lines
        .map((line, index) => ({ line, index }))
        .filter((item) => conceptSymbols.some((symbol) => item.line.includes(symbol)))
        .map((item) => item.index)
        .slice(0, 5);
      for (const hitIndex of hitIndexes) {
      const block = enclosingCodeBlock(lines, hitIndex);
      const snippet = block.lines.join("\n").trim().slice(0, 2_000);
      result.push(createImplementationEvidence(path, lines, block, hitIndex, snippet, input.targetConcept, "medium"));
      }
    }
  }
  return mergeImplementationEvidence(result)
    .sort((left, right) => implementationScore(right, input.targetConcept) - implementationScore(left, input.targetConcept))
    .slice(0, 12);
}

export function synthesizeConceptFlow(input: {
  targetConcept: string;
  requestedFacets: RequestedQuestionFacet[];
  implementationEvidence: ImplementationEvidence[];
}): ConceptFlow {
  const implementation = input.implementationEvidence.filter((item) => item.semanticRole === "implementation");
  const primary = implementation.length ? implementation : input.implementationEvidence;
  const steps: ConceptFlowStep[] = [];
  for (const item of primary.filter((entry) => entry.semanticRole === "implementation").slice(0, 6)) {
    const conceptCalls = directTargetCalls(input.targetConcept, item.snippet, item.calls);
    const calls = conceptCalls;
    const outputNames = item.outputNames.length ? item.outputNames : cleanOutputNames(item.returns.join(", "));
    const outputs = outputNames.join(", ");
    steps.push({
      order: steps.length + 1,
      label: labelForConceptStep(input.targetConcept, item),
      whatHappens: describeConceptEvidence(input.targetConcept, item, calls),
      inputData: inferInputData(item),
      output: outputs || undefined,
      outputNames,
      parameters: uniqueStrings(calls.flatMap((call) => call.arguments)).slice(0, 8),
      nextConsumers: uniqueStrings([
        ...item.downstreamReferences,
        ...item.upstreamReferences,
        ...secondaryRelationNames(input.implementationEvidence, item)
      ]).slice(0, 8),
      evidenceRef: item.ref,
      sourceRole: item.sourceRole,
      semanticRole: item.semanticRole,
      roleReason: item.roleReason,
      ownerSymbol: item.ownerSymbol,
      targetCallLine: item.targetCallLine,
      callKind: item.callKind,
      canonicalAction: item.canonicalAction,
      confidence: item.confidence
    });
  }
  return {
    targetConcept: input.targetConcept,
    steps,
    primaryEvidenceRefs: primary.slice(0, 8).map((item) => item.ref),
    secondaryEvidenceRefs: input.implementationEvidence.filter((item) => !primary.includes(item)).slice(0, 8).map((item) => item.ref),
    uncertainties: conceptUncertainties(input.requestedFacets, steps, input.implementationEvidence)
  };
}

export function validateConceptCoverage(input: {
  answerMarkdown: string;
  targetConcept: string;
  requestedFacets: RequestedQuestionFacet[];
  implementationEvidence: ImplementationEvidence[];
  conceptFlow: ConceptFlow;
}): CoverageValidation {
  const errors: string[] = [];
  const answer = normalizeConceptTerm(input.answerMarkdown);
  const covered = new Set<RequestedQuestionFacet>();
  if (!input.targetConcept || input.targetConcept === "general") return { valid: true, coveredFacets: [], missingFacets: [], errors: [] };
  if (!answerMentionsTargetConcept(answer, input.targetConcept)) errors.push(`Answer does not stay centered on target concept "${input.targetConcept}".`);
  if (input.implementationEvidence.some((item) => item.semanticRole === "implementation") && /tests?\//i.test(input.answerMarkdown) && !/implementation|source|service|backend|src\//i.test(input.answerMarkdown)) {
    errors.push("Answer relies on test evidence while implementation evidence exists.");
  }
  if (input.requestedFacets.includes("parameters") && coversParameters(input.answerMarkdown, input.conceptFlow)) covered.add("parameters");
  if (input.requestedFacets.includes("input_data") && mentionsInputData(input.answerMarkdown)) covered.add("input_data");
  if (input.requestedFacets.includes("output") && mentionsOutput(input.answerMarkdown)) covered.add("output");
  if (input.requestedFacets.includes("order") && mentionsOrder(input.answerMarkdown)) covered.add("order");
  if (input.requestedFacets.includes("downstream_usage") && mentionsDownstreamUsage(input.answerMarkdown)) covered.add("downstream_usage");
  if (input.requestedFacets.includes("location") && /hivo-file:/i.test(input.answerMarkdown)) covered.add("location");
  if (input.requestedFacets.includes("code_snippets") && /```/.test(input.answerMarkdown)) covered.add("code_snippets");
  if (input.requestedFacets.includes("uncertainty") && mentionsUncertainty(input.answerMarkdown)) covered.add("uncertainty");
  if (input.requestedFacets.includes("persistence") && mentionsPersistence(input.answerMarkdown)) covered.add("persistence");
  const required = input.requestedFacets.filter((facet) => facet !== "uncertainty" && facet !== "persistence");
  const missing = required.filter((facet) => !covered.has(facet));
  if (required.length >= 3 && missing.length > Math.floor(required.length / 2)) {
    errors.push(`Answer misses requested concept facets: ${missing.join(", ")}.`);
  }
  if (input.targetConcept !== "svm" && /\bupstream-clustering\s*->\s*training\s*->\s*prediction\s*->\s*explainability\s*->\s*usage\b/i.test(input.answerMarkdown)) {
    errors.push("Answer uses the generic ML pipeline instead of the requested concept flow.");
  }
  if (/No local matches for query/i.test(input.answerMarkdown) && input.implementationEvidence.length) {
    errors.push("Answer exposes irrelevant negative search queries even though concept evidence exists.");
  }
  return {
    valid: errors.length === 0,
    coveredFacets: Array.from(covered),
    missingFacets: missing,
    errors
  };
}

function answerMentionsTargetConcept(normalizedAnswer: string, targetConcept: string) {
  return aliasesForConcept(targetConcept).some((alias) => normalizedAnswer.includes(alias));
}

function mentionsInputData(value: string) {
  return hasAnyTerm(value, [
    "input", "feature", "features", "payload", "data", "dataset", "argument",
    "\u0645\u062f\u062e\u0644", "\u0645\u062f\u062e\u0644\u0627\u062a", "\u0628\u064a\u0627\u0646\u0627\u062a", "\u062f\u0627\u062a\u0627"
  ]);
}

function mentionsOutput(value: string) {
  return hasAnyTerm(value, [
    "output", "return", "returns", "label", "labels", "cluster", "clusters", "noise", "result",
    "selected action", "route name", "recommendation",
    "\u0645\u062e\u0631\u062c", "\u0645\u062e\u0631\u062c\u0627\u062a", "\u0646\u0627\u062a\u062c", "\u0646\u062a\u064a\u062c\u0629",
    "\u0628\u064a\u0637\u0644\u0639", "\u0628\u064a\u0631\u062c\u0639", "\u064a\u0631\u062c\u0639", "\u064a\u0637\u0644\u0639", "\u064a\u0645\u0631\u0631"
  ]);
}

function mentionsOrder(value: string) {
  return hasAnyTerm(value, [
    "before", "after", "then", "next", "followed", "pipeline", "flow", "upstream", "downstream",
    "\u0642\u0628\u0644", "\u0628\u0639\u062f", "\u0628\u0639\u062f\u0647\u0627", "\u0628\u0627\u0644\u062a\u0627\u0644\u064a", "\u062a\u0633\u0644\u0633\u0644", "\u0645\u0633\u0627\u0631"
  ]);
}

function mentionsDownstreamUsage(value: string) {
  return hasAnyTerm(value, [
    "used", "usage", "feeds", "consumer", "route", "api", "endpoint", "svm", "training", "next", "downstream",
    "dispatch", "executor", "actionexecutor", "execute",
    "\u0627\u0633\u062a\u062e\u062f\u0627\u0645", "\u064a\u0633\u062a\u062e\u062f\u0645", "\u0628\u0639\u062f\u0647\u0627", "\u0628\u064a\u0631\u0648\u062d",
    "\u0628\u064a\u062f\u062e\u0644", "\u062a\u0646\u0641\u064a\u0630", "\u064a\u062a\u0646\u0641\u0630", "\u064a\u0645\u0631\u0631", "\u0627\u0644\u0645\u0633\u0627\u0631"
  ]);
}

function mentionsUncertainty(value: string) {
  return hasAnyTerm(value, [
    "uncertain", "not proven", "not confirmed",
    "\u063a\u064a\u0631 \u0645\u062b\u0628\u062a", "\u063a\u064a\u0631 \u0645\u0624\u0643\u062f", "\u0645\u0634 \u0645\u062b\u0628\u062a"
  ]);
}

function mentionsPersistence(value: string) {
  return hasAnyTerm(value, [
    "joblib", "pickle", "save", "load", "dump", "persist", "store", "storage",
    "\u062a\u062e\u0632\u064a\u0646", "\u064a\u062a\u062e\u0632\u0646", "\u064a\u062a\u062d\u0645\u0644", "\u062d\u0641\u0638"
  ]);
}

function hasAnyTerm(value: string, terms: string[]) {
  const normalized = normalizeConceptTerm(value);
  return terms.some((term) => {
    const normalizedTerm = normalizeConceptTerm(term);
    return normalizedTerm.length > 0 && (
      normalized.includes(normalizedTerm)
      || new RegExp(`\\b${escapeRegex(normalizedTerm)}\\b`, "i").test(value)
    );
  });
}

export function validateRoleClassification(input: {
  conceptFlow: ConceptFlow;
  implementationEvidence: ImplementationEvidence[];
  targetConcept: string;
}): RoleClassificationValidation {
  const errors: string[] = [];
  const invalidStep = input.conceptFlow.steps.find((step) => step.semanticRole !== "implementation");
  if (invalidStep) errors.push(`Concept flow contains non-implementation step ${invalidStep.evidenceRef} (${invalidStep.semanticRole}).`);
  const nonDirectStep = input.conceptFlow.steps.find((step) => step.callKind !== "direct_algorithm_call");
  if (nonDirectStep) errors.push(`Concept flow implementation step is not a direct target call: ${nonDirectStep.evidenceRef} (${nonDirectStep.callKind}).`);
  const downstreamAsCall = input.conceptFlow.steps.find((step) => step.label.includes("fit_fcm") || step.label.includes("cmeans") && input.targetConcept !== "fcm");
  if (downstreamAsCall) errors.push("Downstream stage is labeled as a target implementation call.");
  const dirtyOutput = input.conceptFlow.steps.find((step) => step.output && !isCleanOutput(step.output));
  if (dirtyOutput) errors.push(`Concept flow exposes invalid output fragment for ${dirtyOutput.evidenceRef}.`);
  const duplicateActions = findDuplicateActions(input.conceptFlow.steps);
  if (duplicateActions.length) errors.push(`Concept flow repeats implementation actions: ${duplicateActions.join(", ")}.`);
  return {
    valid: errors.length === 0,
    errors,
    implementationRefs: input.implementationEvidence.filter((item) => item.semanticRole === "implementation").map((item) => item.ref),
    suppressedRefs: input.implementationEvidence.filter((item) => isSuppressedRole(item.semanticRole)).map((item) => item.ref)
  };
}

export function validateEvidenceDedupe(evidence: ImplementationEvidence[]): DedupeValidation {
  const groups = evidenceGroups(evidence);
  return {
    valid: true,
    errors: [],
    groups
  };
}

export function validateOutputCleanup(flow: ConceptFlow): OutputCleanupValidation {
  const cleanedOutputs = cleanedOutputsFromFlow(flow);
  const errors: string[] = [];
  for (const step of flow.steps) {
    if (step.output && !isCleanOutput(step.output)) errors.push(`Dirty output in ${step.evidenceRef}: ${step.output}`);
    for (const output of step.outputNames) {
      if (!isCleanOutput(output)) errors.push(`Dirty output name in ${step.evidenceRef}: ${output}`);
    }
  }
  return { valid: errors.length === 0, errors, cleanedOutputs };
}

export function validateAnswerLanguage(input: {
  answerMarkdown: string;
  expected: "arabic" | "english" | "mixed";
}): LanguageValidation {
  if (input.expected === "mixed") return { valid: true, expected: input.expected, errors: [] };
  const arabicChars = (input.answerMarkdown.match(/[\u0600-\u06ff]/g) ?? []).length;
  const latinWords = (input.answerMarkdown.match(/[A-Za-z]{3,}/g) ?? []).length;
  const errors: string[] = [];
  if (input.expected === "arabic" && arabicChars < 30) errors.push("Arabic question received a non-Arabic concept answer.");
  if (input.expected === "english" && arabicChars > latinWords * 2) errors.push("English question received an Arabic-heavy concept answer.");
  return { valid: errors.length === 0, expected: input.expected, errors };
}

export function suppressedEvidenceFromRoles(evidence: ImplementationEvidence[]) {
  return evidence
    .filter((item) => isSuppressedRole(item.semanticRole))
    .map((item) => ({
      ref: item.ref,
      path: item.path,
      semanticRole: item.semanticRole,
      roleReason: item.roleReason
    }));
}

export function cleanedOutputsFromFlow(flow: ConceptFlow) {
  return uniqueStrings(flow.steps.flatMap((step) => step.outputNames.length ? step.outputNames : [step.output ?? ""]).filter(isCleanOutput));
}

function coversParameters(answer: string, flow: ConceptFlow) {
  const answerText = normalizeConceptTerm(answer);
  return flow.steps.some((step) => step.parameters.some((parameter) => {
    const name = parameter.split("=")[0]?.trim();
    return Boolean(name && name.length > 1 && answerText.includes(normalizeConceptTerm(name)));
  }));
}

function conceptUncertainties(facets: RequestedQuestionFacet[], steps: ConceptFlowStep[], evidence: ImplementationEvidence[]) {
  const uncertainties: string[] = [];
  if (facets.includes("parameters") && !steps.some((step) => step.parameters.length)) uncertainties.push("Parameters are not proven from the inspected implementation snippets.");
  if (facets.includes("output") && !steps.some((step) => step.output)) uncertainties.push("Returned values or assigned outputs are not explicit in the inspected snippets.");
  const hasDownstreamEvidence = evidence.some((item) =>
    (item.semanticRole === "orchestration" || item.semanticRole === "downstream_stage" || item.semanticRole === "artifact_preparation")
      && (item.downstreamReferences.length || item.calls.some((call) => /\b(fit_fcm|cmeans|train_|predict_|build_|load_|save_)\b/i.test(call.name)) || /\b(X_clean|feature_frame|dbscan_labels|fcm_labels|memberships)\b/.test(item.snippet))
  );
  if (facets.includes("downstream_usage") && !steps.some((step) => step.nextConsumers.length) && !hasDownstreamEvidence) uncertainties.push("Downstream consumers are not explicit in the inspected snippets.");
  return uncertainties;
}

function secondaryRelationNames(evidence: ImplementationEvidence[], primary: ImplementationEvidence) {
  const primaryOutputs = new Set(primary.outputNames.map(normalizeConceptTerm));
  return uniqueStrings(evidence
    .filter((item) => item.ref !== primary.ref)
    .filter((item) => item.semanticRole === "orchestration" || item.semanticRole === "downstream_stage" || item.semanticRole === "artifact_preparation")
    .filter((item) => {
      const text = normalizeConceptTerm(item.snippet);
      return Array.from(primaryOutputs).some((name) => name && text.includes(name))
        || /\b(X_clean|feature_frame|dbscan_labels|fcm_labels|memberships|fit_fcm|cmeans|train_|predict_)\b/i.test(item.snippet);
    })
    .flatMap((item) => [
      ...item.downstreamReferences,
      ...item.calls.map((call) => call.name),
      ...item.symbols
    ])
    .filter((name) => /\b(X_clean|feature_frame|dbscan_labels|fcm_labels|memberships|fit_fcm|cmeans|train_|predict_|build_)\b/i.test(name))
  );
}

function labelForConceptStep(targetConcept: string, evidence: ImplementationEvidence) {
  const mainCall = directTargetCalls(targetConcept, evidence.snippet, evidence.calls)[0];
  if (mainCall) return `${targetConcept} implementation: ${evidence.ownerSymbol}`;
  if (evidence.ownerSymbol) return `${targetConcept} in ${evidence.ownerSymbol}`;
  return `${targetConcept} implementation`;
}

function describeConceptEvidence(targetConcept: string, evidence: ImplementationEvidence, calls: Array<{ name: string; arguments: string[] }>) {
  const callText = calls.length ? calls.map((call) => `${call.name}(${call.arguments.join(", ")})`).join(", ") : targetConcept;
  if (targetConcept === "dbscan") return `The code applies DBSCAN through ${callText}; this is the density-clustering step proven by the implementation snippet.`;
  if (targetConcept === "fcm") return `The code applies Fuzzy C-Means through ${callText}; this is the soft-clustering step proven by the implementation snippet.`;
  if (targetConcept === "svm") return `The code applies SVM through ${callText}; this is the classifier/training or prediction step proven by the implementation snippet.`;
  return `The implementation evidence shows ${callText} in this code block.`;
}

function inferInputData(evidence: ImplementationEvidence) {
  const callArgs = evidence.calls.flatMap((call) => call.arguments);
  const likely = callArgs.find((arg) => /\b(features|payload|data|records|input|sample|background|labels)\b/i.test(arg));
  if (likely) return likely;
  const symbol = evidence.symbols.find((item) => /\b(features|payload|data|records|input|sample|labels)\b/i.test(item));
  return symbol;
}

function extractAsciiTokens(value: string) {
  return Array.from(value.matchAll(/[A-Za-z][A-Za-z0-9_./:-]*/g)).map((match) => match[0] ?? "");
}

function normalizeConceptTerm(value: string) {
  const ascii = extractAsciiTokens(value);
  const arabic = Array.from(value.matchAll(/[\u0600-\u06ff]+/gu)).map((match) => match[0] ?? "");
  const base = ascii.length || arabic.length ? uniqueStrings([...ascii, ...arabic]).join(" ") : value;
  return base.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function canonicalConcept(value: string) {
  const normalized = normalizeConceptTerm(value);
  for (const [canonical, aliases] of Object.entries(CONCEPT_ALIASES)) {
    if (aliases.some((alias) => normalized === alias || normalized.includes(alias))) return canonical;
  }
  if (/^\/api\//.test(normalized)) return normalized;
  return "";
}

function aliasesForConcept(concept: string) {
  return uniqueStrings([concept, ...(CONCEPT_ALIASES[concept] ?? [])].map(normalizeConceptTerm).filter(Boolean));
}

function isUsefulTextPath(path: string) {
  return /\.(c|cc|conf|cpp|cs|go|h|hpp|html|java|js|json|jsx|kt|md|mjs|py|rs|sh|sql|swift|toml|ts|tsx|yaml|yml)$/i.test(path)
    && !/(^|\/)(\.git|node_modules|dist|build|coverage|target|venv|\.venv|__pycache__)(\/|$)/i.test(path);
}

function createImplementationEvidence(
  path: string,
  lines: string[],
  block: { startLine: number; lines: string[] },
  hitIndex: number,
  snippet: string,
  targetConcept: string,
  directConfidence: "high" | "medium"
): ImplementationEvidence {
  const calls = extractCalls(snippet);
  const assignments = extractAssignments(snippet).filter((item) => cleanOutputNames(item.name).length > 0);
  const returns = extractReturns(snippet).flatMap(cleanOutputNames);
  const owner = ownerMetadata(lines, block.startLine - 1);
  const targetCallLine = findTargetCallLine(lines, block.startLine - 1, targetConcept) ?? hitIndex + 1;
  const role = classifyEvidenceRole(path, snippet, targetConcept, calls);
  const directCalls = directTargetCalls(targetConcept, snippet, calls);
  const canonicalAction = canonicalActionForEvidence(targetConcept, snippet, calls, role.role, owner.ownerSymbol);
  const outputNames = outputNamesForEvidence(targetConcept, assignments, returns, role.role);
  return {
    ref: `${path}:${block.startLine}`,
    path,
    line: block.startLine,
    markdownLink: link(path, block.startLine),
    snippet,
    sourceRole: role.role,
    semanticRole: role.role,
    roleReason: role.reason,
    ownerSymbol: owner.ownerSymbol,
    ownerStartLine: owner.ownerStartLine,
    targetCallLine,
    callKind: role.callKind,
    canonicalAction,
    symbols: extractSymbols(snippet),
    calls,
    assignments,
    outputNames,
    returns,
    upstreamReferences: extractUpstreamReferences(snippet),
    downstreamReferences: extractDownstreamReferences(snippet),
    confidence: role.role === "implementation"
      ? directConfidence
      : role.role === "orchestration" || role.role === "downstream_stage" || role.role === "artifact_preparation"
        ? "medium"
        : "low"
  };
}

function classifyEvidenceRole(
  path: string,
  snippet: string,
  targetConcept: string,
  calls = extractCalls(snippet)
): { role: SourceRole; reason: string; callKind: ConceptCallKind } {
  const pathText = normalizeConceptTerm(path);
  const text = normalizeConceptTerm(`${path}\n${snippet}`);
  const aliases = aliasesForConcept(targetConcept);
  const directCalls = directTargetCalls(targetConcept, snippet, calls);
  const hasDirectTargetCall = directCalls.length > 0;
  const hasTargetMention = aliases.some((alias) => text.includes(alias));
  if (/\.test\.|\.spec\.|(^|\/)tests?\//i.test(path)) return { role: "test", reason: "Evidence is in a test/spec path.", callKind: "name_match" };
  if (/\.(md|mdx|txt)$/i.test(path) || /(^|\/)docs?\//i.test(path)) return { role: "documentation", reason: "Evidence is documentation, not implementation.", callKind: "name_match" };
  if (isVisualizationEvidence(path, snippet)) return { role: "visualization", reason: "Evidence is frontend/chart/color rendering or UI helper code.", callKind: "name_match" };
  if (hasDirectTargetCall) return { role: "implementation", reason: "Snippet contains a direct target algorithm/library call in the owner body.", callKind: "direct_algorithm_call" };
  if (isArtifactPreparationEvidence(snippet) && hasTargetMention) {
    return { role: "artifact_preparation", reason: "Snippet prepares or replays payload/artifact data derived from the target output.", callKind: "payload_helper" };
  }
  if (/routes?|api|controller|endpoint/.test(pathText) || /\b(app|router)\.(get|post|put|delete|patch)\b/i.test(snippet)) {
    if (!hasTargetMention && !routeSnippetSupportsTarget(snippet, targetConcept, calls)) {
      return { role: "unrelated_name_match", reason: "Route/API snippet does not call or carry the requested target concept.", callKind: "name_match" };
    }
    return { role: "orchestration", reason: "Snippet wires a route/API or orchestrates service calls.", callKind: "wrapper_call" };
  }
  if (calls.some((call) => isWrapperCall(call.name, targetConcept)) && hasTargetMention) {
    return { role: "orchestration", reason: "Snippet calls a wrapper/helper whose name mentions the target but does not apply the algorithm directly.", callKind: "wrapper_call" };
  }
  if (/\b(train|predict|fit_|cmeans|fcm|svm|shap|downstream|consumer|return)\b/i.test(snippet) && hasTargetMention) {
    return { role: "downstream_stage", reason: "Snippet is related to a later pipeline stage, not the target call itself.", callKind: "downstream_usage" };
  }
  if (hasTargetMention) return { role: "unrelated_name_match", reason: "Snippet mentions the target name without a direct implementation call.", callKind: "name_match" };
  return { role: "unrelated_name_match", reason: "No semantic relationship to the target concept was proven.", callKind: "name_match" };
}

function isVisualizationEvidence(path: string, snippet: string) {
  return /\.(tsx?|jsx?|css|scss|html)$/i.test(path)
    && /\b(rgba|Number|parseFloat|chart|canvas|svg|React|component|className|style|color|tooltip)\b/i.test(snippet);
}

function isArtifactPreparationEvidence(snippet: string) {
  return /\b(payload|artifact|replay|report|serialize|summary|snapshot|np\.asarray|tolist|to_dict|DataFrame|labels?_payload)\b/i.test(snippet)
    || /_payload\b|payload_/i.test(snippet);
}

function isWrapperCall(name: string, targetConcept: string) {
  const normalized = normalizeConceptTerm(name);
  return aliasesForConcept(targetConcept).some((alias) => normalized.includes(alias))
    && !directTargetCalls(targetConcept, `${name}()`, [{ name, arguments: [] }]).length;
}

function isSuppressedRole(role: SourceRole) {
  return role === "visualization" || role === "test" || role === "documentation" || role === "unrelated_name_match";
}

function directTargetCalls(targetConcept: string, snippet: string, calls: Array<{ name: string; arguments: string[] }>) {
  const targetInstances = targetInstanceNames(targetConcept, snippet);
  const direct = calls.filter((call) => {
    const name = call.name;
    const normalized = normalizeConceptTerm(name);
    if (targetConcept === "dbscan") {
      if (/\bDBSCAN\b/.test(name)) return true;
      if (/\bfit_predict\b/.test(name) && /\bDBSCAN\s*\(/.test(snippet)) return true;
      return /\bfit_predict\b/.test(name) && targetInstances.some((instance) => normalized.includes(normalizeConceptTerm(instance)));
    }
    if (targetConcept === "fcm") return /\bcmeans\b/i.test(name) || /fuzz\.cluster\.cmeans|skfuzzy.*cmeans/i.test(name);
    if (targetConcept === "svm") return /\b(SVC|LinearSVC)\b/.test(name) || (/\b(fit|predict|predict_proba)\b/.test(normalized) && /\b(svm|svc|linearsvc)\b/i.test(snippet));
    if (targetConcept === "shap") return /\b(KernelExplainer|shap_values|TreeExplainer|Explainer)\b/i.test(name) || /^shap\./i.test(name);
    if (targetConcept === "sarima") return /\b(SARIMAX?|ARIMA)\b/i.test(name) || (/\b(fit|forecast|predict)\b/.test(normalized) && /\b(SARIMAX?|ARIMA|model_result)\b/i.test(snippet));
    return aliasesForConcept(targetConcept).some((alias) => normalized === alias || normalized.endsWith(`.${alias}`));
  });
  return uniqueCalls(direct);
}

function canonicalActionForEvidence(targetConcept: string, snippet: string, calls: Array<{ name: string; arguments: string[] }>, role: SourceRole, ownerSymbol: string) {
  const direct = directTargetCalls(targetConcept, snippet, calls);
  if (direct.length) {
    if (targetConcept === "dbscan" && (/\bDBSCAN\s*\([^)]*\)\s*\.\s*fit_predict\s*\(/s.test(snippet) || direct.some((call) => /\bfit_predict\b/.test(call.name)))) return "DBSCAN.fit_predict";
    if (targetConcept === "fcm") return "fuzz.cluster.cmeans";
    if (targetConcept === "svm") return direct.some((call) => /\b(SVC|LinearSVC)\b/.test(call.name)) ? "SVC" : direct[0]?.name ?? targetConcept;
    return direct[0]?.name ?? targetConcept;
  }
  const wrapper = calls.find((call) => isWrapperCall(call.name, targetConcept));
  if (wrapper) return `wrapper:${wrapper.name}`;
  if (role === "artifact_preparation") return `artifact:${ownerSymbol}`;
  if (role === "downstream_stage") {
    const downstream = calls.find((call) => /\b(cmeans|fit_fcm|train|predict|svm|shap)\b/i.test(call.name));
    return `downstream:${downstream?.name ?? ownerSymbol}`;
  }
  return `${role}:${ownerSymbol}`;
}

function outputNamesForEvidence(targetConcept: string, assignments: Array<{ name: string; expression: string }>, returns: string[], role: SourceRole) {
  if (role !== "implementation") return [];
  const targetAssignments = assignments.filter((assignment) => directTargetCalls(targetConcept, assignment.expression, extractCalls(assignment.expression)).length > 0);
  const names = targetAssignments.flatMap((assignment) => cleanOutputNames(assignment.name));
  const derived = [...names];
  for (const assignment of assignments) {
    const expression = normalizeConceptTerm(assignment.expression);
    if (derived.some((name) => expression.includes(normalizeConceptTerm(name)))) {
      derived.push(...cleanOutputNames(assignment.name));
    }
  }
  return uniqueStrings(derived.length ? derived : returns.flatMap(cleanOutputNames));
}

function targetInstanceNames(targetConcept: string, snippet: string) {
  const constructors: Record<string, RegExp[]> = {
    dbscan: [/\b([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*DBSCAN\s*\(/g],
    svm: [/\b([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(?:SVC|LinearSVC)\s*\(/g],
    sarima: [/\b([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(?:SARIMAX?|ARIMA)\s*\(/g]
  };
  const names = constructors[targetConcept]?.flatMap((pattern) =>
    Array.from(snippet.matchAll(pattern)).map((match) => match[1] ?? "")
  ) ?? [];
  if (targetConcept === "dbscan") names.push("dbscan_model", "self.dbscan_model");
  if (targetConcept === "svm") names.push("svm", "svm_model", "self.svm_model");
  return uniqueStrings(names.filter(Boolean));
}

function routeSnippetSupportsTarget(snippet: string, targetConcept: string, calls: Array<{ name: string; arguments: string[] }>) {
  const text = normalizeConceptTerm(snippet);
  const callNames = calls.map((call) => normalizeConceptTerm(call.name));
  if (aliasesForConcept(targetConcept).some((alias) => text.includes(alias))) return true;
  if (targetConcept === "dbscan") return callNames.some((name) => /\b(fit dbscan|build customer segments|cluster|segment)\b/i.test(name));
  if (targetConcept === "fcm") return callNames.some((name) => /\b(fit fcm|build customer segments|cmeans|cluster|segment)\b/i.test(name));
  if (targetConcept === "svm") return callNames.some((name) => /\b(train svm|predict customer state|svm)\b/i.test(name));
  return false;
}

function ownerMetadata(lines: string[], blockStartIndex: number) {
  let ownerSymbol = "";
  let ownerStartLine = blockStartIndex + 1;
  let ownerIndent = Number.POSITIVE_INFINITY;
  for (let cursor = blockStartIndex; cursor >= 0; cursor -= 1) {
    const line = lines[cursor] ?? "";
    const match = line.match(/^\s*(def|class|function|export\s+function|const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (!match) continue;
    ownerSymbol = match[2] ?? ownerSymbol;
    ownerStartLine = cursor + 1;
    ownerIndent = leadingSpaces(line);
    break;
  }
  for (let cursor = ownerStartLine - 2; cursor >= 0; cursor -= 1) {
    const line = lines[cursor] ?? "";
    const classMatch = line.match(/^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (classMatch && leadingSpaces(line) < ownerIndent) {
      ownerSymbol = `${classMatch[1]}.${ownerSymbol}`;
      break;
    }
  }
  return { ownerSymbol: ownerSymbol || `line_${blockStartIndex + 1}`, ownerStartLine };
}

function findTargetCallLine(lines: string[], blockStartIndex: number, targetConcept: string) {
  for (let cursor = blockStartIndex; cursor < Math.min(lines.length, blockStartIndex + 40); cursor += 1) {
    const line = lines[cursor] ?? "";
    if (directTargetCalls(targetConcept, line, extractCalls(line)).length) return cursor + 1;
  }
  return undefined;
}

function enclosingCodeBlock(lines: string[], index: number) {
  let start = Math.max(0, index - 2);
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    if (/^\s*(def|class|function|export\s+function|const|let|var)\s+[A-Za-z_][A-Za-z0-9_]*/.test(lines[cursor] ?? "")) {
      start = cursor;
      break;
    }
  }
  let end = Math.min(lines.length, index + 10);
  const baseIndent = leadingSpaces(lines[start] ?? "");
  for (let cursor = index + 1; cursor < Math.min(lines.length, index + 30); cursor += 1) {
    const line = lines[cursor] ?? "";
    if (cursor > index + 1 && line.trim() && leadingSpaces(line) <= baseIndent && /^\s*(def|class|function|export\s+function|const|let|var|@)/.test(line)) {
      end = cursor;
      break;
    }
    end = cursor + 1;
  }
  return { startLine: start + 1, lines: lines.slice(start, end) };
}

function leadingSpaces(value: string) {
  return value.match(/^\s*/)?.[0].length ?? 0;
}

function extractSymbols(snippet: string) {
  return uniqueStrings([
    ...Array.from(snippet.matchAll(/\b(?:def|class|function)\s+([A-Za-z_][A-Za-z0-9_]*)/g)).map((match) => match[1] ?? ""),
    ...Array.from(snippet.matchAll(/\b(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)/g)).map((match) => match[1] ?? ""),
    ...Array.from(snippet.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*=/g)).map((match) => match[1] ?? "")
  ]).slice(0, 12);
}

function extractCalls(snippet: string) {
  const calls: Array<{ name: string; arguments: string[] }> = [];
  for (const match of snippet.matchAll(/\b([A-Za-z_][A-Za-z0-9_.]*)\s*\(([^()\n]*)\)/g)) {
    const name = match[1] ?? "";
    if (!name || ["if", "for", "while", "return"].includes(name)) continue;
    calls.push({
      name,
      arguments: splitArguments(match[2] ?? "")
    });
  }
  const seenNames = new Set(calls.map((call) => call.name));
  for (const match of snippet.matchAll(/\b([A-Za-z_][A-Za-z0-9_.]*)\s*\(/g)) {
    const name = match[1] ?? "";
    if (!name || seenNames.has(name) || ["if", "for", "while", "return"].includes(name)) continue;
    calls.push({ name, arguments: [] });
    seenNames.add(name);
  }
  return calls.slice(0, 16);
}

function splitArguments(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean).slice(0, 12);
}

function cleanOutputNames(value: string) {
  return uniqueStrings(value
    .replace(/[\[\](){}]/g, " ")
    .split(/[,\n;]/)
    .map((item) => item.replace(/^\*+/, "").trim())
    .filter((item) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(item))
    .filter(isCleanOutput));
}

function extractAssignments(snippet: string) {
  return Array.from(snippet.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*=\s*(.+)$/gm))
    .map((match) => ({ name: (match[1] ?? "").trim(), expression: (match[2] ?? "").trim() }))
    .slice(0, 10);
}

function extractReturns(snippet: string) {
  return Array.from(snippet.matchAll(/^\s*return\s+(.+)$/gm)).map((match) => (match[1] ?? "").trim()).slice(0, 6);
}

function extractUpstreamReferences(snippet: string) {
  return uniqueStrings(Array.from(snippet.matchAll(/\b(features|labels|payload|background|memberships|density_clusters|fcm_labels)\b/g)).map((match) => match[1] ?? ""));
}

function extractDownstreamReferences(snippet: string) {
  return uniqueStrings([
    ...Array.from(snippet.matchAll(/\b(train_[A-Za-z0-9_]+|predict_[A-Za-z0-9_]+|build_[A-Za-z0-9_]+|explain_[A-Za-z0-9_]+|fit_fcm|cmeans|joblib\.(?:dump|load))\b/g)).map((match) => match[1] ?? ""),
    ...Array.from(snippet.matchAll(/\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g)).map((match) => match[1] ?? ""),
    ...Array.from(snippet.matchAll(/\b(X_clean|feature_frame|dbscan_labels|fcm_labels|memberships|noise_mask)\b/g)).map((match) => match[1] ?? "")
  ]);
}

function mergeImplementationEvidence(items: ImplementationEvidence[]) {
  const grouped = new Map<string, ImplementationEvidence>();
  for (const item of items) {
    const key = evidenceGroupKey(item);
    const existing = grouped.get(key);
    if (!existing || implementationScore(item, item.canonicalAction) > implementationScore(existing, existing.canonicalAction)) {
      grouped.set(key, item);
    }
  }
  return Array.from(grouped.values());
}

function evidenceGroupKey(item: ImplementationEvidence) {
  return [
    item.path,
    item.ownerSymbol,
    item.canonicalAction,
    item.semanticRole
  ].map(normalizeConceptTerm).join("|");
}

function evidenceGroups(items: ImplementationEvidence[]): EvidenceGroup[] {
  const groups = new Map<string, EvidenceGroup>();
  for (const item of items) {
    const key = evidenceGroupKey(item);
    const existing = groups.get(key);
    if (existing) {
      existing.refs.push(item.ref);
    } else {
      groups.set(key, {
        key,
        keptRef: item.ref,
        refs: [item.ref],
        semanticRole: item.semanticRole,
        ownerSymbol: item.ownerSymbol,
        canonicalAction: item.canonicalAction
      });
    }
  }
  return Array.from(groups.values());
}

function findDuplicateActions(steps: ConceptFlowStep[]) {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const step of steps) {
    const key = `${step.ownerSymbol}:${step.canonicalAction}`;
    if (seen.has(key)) duplicates.push(key);
    seen.add(key);
  }
  return duplicates;
}

function uniqueCalls(calls: Array<{ name: string; arguments: string[] }>) {
  const seen = new Set<string>();
  const result: Array<{ name: string; arguments: string[] }> = [];
  for (const call of calls) {
    const key = `${call.name}(${call.arguments.join(",")})`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(call);
  }
  return result;
}

function implementationScore(item: ImplementationEvidence, targetConcept: string) {
  const text = normalizeConceptTerm(`${item.path}\n${item.snippet}`);
  return (item.semanticRole === "implementation" ? 260 : item.semanticRole === "orchestration" ? 140 : item.semanticRole === "artifact_preparation" ? 120 : item.semanticRole === "downstream_stage" ? 100 : item.semanticRole === "visualization" ? -80 : item.semanticRole === "test" ? 20 : item.semanticRole === "documentation" ? 10 : -120)
    + (aliasesForConcept(targetConcept).some((alias) => text.includes(alias)) ? 100 : 0)
    + (item.calls.length * 10)
    + (item.outputNames.length * 14)
    + (item.assignments.length * 6)
    + (item.returns.length * 6);
}

function isCleanOutput(value: string) {
  const compact = value.trim();
  if (!compact || compact.length > 160) return false;
  if (/^[{};,\s]+$/.test(compact)) return false;
  if (/(?:\{\s*;){1,}|\{\s*,|\[\s*,/.test(compact)) return false;
  if (!/[A-Za-z0-9_]/.test(compact)) return false;
  return true;
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function link(path: string, line: number) {
  return `[${path}:${line}](hivo-file:${encodeURIComponent(path)}:${line})`;
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}
