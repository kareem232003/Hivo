import type { EditIntent, MemoryEvidencePack } from "./RecursiveSwarmModels.js";

export type EditIntentQualityStatus =
  | "ready_for_patch"
  | "needs_evidence_expansion"
  | "needs_user_or_planner_clarification"
  | "blocked";

export type EditIntentQualityResult = {
  status: EditIntentQualityStatus;
  editIntentId: string;
  score: number;
  missingFields: string[];
  risks: string[];
  requiredEvidence: string[];
  suggestedExpansionQueries: string[];
  diagnostics: string[];
};

export type QualityGateInput = {
  editIntent: EditIntent;
  evidencePack?: MemoryEvidencePack;
  allowedPaths: string[];
  forbiddenPaths: string[];
  builderOverrides?: {
    exactOldText?: string;
    replacementText?: string;
    anchorLine?: string;
    insertAfterAnchor?: boolean;
    insertBeforeAnchor?: boolean;
  };
  /** Overall context source (from the node's evidence pack if available) */
  contextSource?: "memory_evidence" | "partial_context" | "prompt_only_fallback";
};

function isPathAllowed(filePath: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  return allowed.some((p) => filePath.startsWith(p));
}

function isPathForbidden(filePath: string, forbidden: string[]): boolean {
  return forbidden.some((p) => filePath.startsWith(p));
}

function isSecretFile(filePath: string): boolean {
  const secrets = [".env", ".pem", ".key", ".cert", "credentials", "secrets/", "node_modules/"];
  return secrets.some((s) => filePath.includes(s));
}

function hasExactText(overrides?: QualityGateInput["builderOverrides"]): boolean {
  if (!overrides) return false;
  return !!overrides.exactOldText && overrides.replacementText !== undefined;
}

function hasAnchor(overrides?: QualityGateInput["builderOverrides"]): boolean {
  if (!overrides) return false;
  return !!overrides.anchorLine && (!!overrides.insertAfterAnchor || !!overrides.insertBeforeAnchor) && overrides.replacementText !== undefined;
}

function fileInRelevantFiles(filePath: string, pack?: MemoryEvidencePack): boolean {
  if (!pack) return true;
  if (pack.relevant_files.length === 0) return true;
  return pack.relevant_files.some((f) => f === filePath || filePath.startsWith(f.replace(/\/$/, "")));
}

export function evaluateEditIntentQuality(input: QualityGateInput): EditIntentQualityResult {
  const { editIntent, evidencePack, allowedPaths, forbiddenPaths, builderOverrides, contextSource } = input;
  const missingFields: string[] = [];
  const risks: string[] = [];
  const requiredEvidence: string[] = [];
  const suggestedExpansionQueries: string[] = [];
  const diagnostics: string[] = [];

  // 1. target_file
  if (!editIntent.target_file || editIntent.target_file.trim() === "") {
    missingFields.push("target_file");
  } else {
    if (isPathForbidden(editIntent.target_file, forbiddenPaths)) {
      return {
        status: "blocked",
        editIntentId: editIntent.target_file,
        score: 0,
        missingFields,
        risks: [...risks, "Target file is in forbidden paths"],
        requiredEvidence: [],
        suggestedExpansionQueries: [],
        diagnostics: [`Blocked: ${editIntent.target_file} in forbidden paths`]
      };
    }
    if (!isPathAllowed(editIntent.target_file, allowedPaths)) {
      return {
        status: "blocked",
        editIntentId: editIntent.target_file,
        score: 0,
        missingFields,
        risks: [...risks, "Target file not in allowed paths"],
        requiredEvidence: [],
        suggestedExpansionQueries: [],
        diagnostics: [`Blocked: ${editIntent.target_file} not in allowed paths`]
      };
    }
    if (isSecretFile(editIntent.target_file)) {
      return {
        status: "blocked",
        editIntentId: editIntent.target_file,
        score: 0,
        missingFields,
        risks: [...risks, "Target file appears to be a secret file"],
        requiredEvidence: [],
        suggestedExpansionQueries: [],
        diagnostics: [`Blocked: ${editIntent.target_file} is a secret file`]
      };
    }
    if (!fileInRelevantFiles(editIntent.target_file, evidencePack)) {
      risks.push("Target file not in MemoryEvidencePack relevant files");
      diagnostics.push("Quality: target_file not found in evidence pack relevant_files");
    }
  }

  // 2. operation
  if (!editIntent.operation) {
    missingFields.push("operation");
  } else if (editIntent.operation === "refactor") {
    const hasExactScope = hasExactText(builderOverrides) || editIntent.target_symbol_or_range;
    if (!hasExactScope) {
      return {
        status: "needs_user_or_planner_clarification",
        editIntentId: editIntent.target_file,
        score: 0.1,
        missingFields: [...missingFields, "exact_scope_for_refactor"],
        risks: [...risks, "Broad refactor without exact scope — needs operator or planner clarification"],
        requiredEvidence: [editIntent.target_file],
        suggestedExpansionQueries: [`Find exact scope for refactoring ${editIntent.target_file}`],
        diagnostics: ["Quality: broad refactor without exact scope — clarification needed"]
      };
    }
  }

  // 3. Has some concrete edit info (symbol, exactOldText, or anchorLine)
  const hasSymbol = !!editIntent.target_symbol_or_range;
  const hasOldText = hasExactText(builderOverrides) || (typeof (editIntent as Record<string, unknown>).exact_old_text === "string" && ((editIntent as Record<string, unknown>).exact_old_text as string).length > 0);
  const hasAnchorText = hasAnchor(builderOverrides);
  if (!hasSymbol && !hasOldText && !hasAnchorText) {
    missingFields.push("target_symbol_or_range_or_exact_old_text_or_anchor");
    risks.push("No concrete edit information (symbol, old text, or anchor line)");
    diagnostics.push("Quality: missing concrete edit information");
  }

  // 4. Evidence refs for medium/high risk
  const hasEvidence = (editIntent.evidence_refs?.length ?? 0) > 0 || (evidencePack?.evidence_refs?.length ?? 0) > 0;
  if (!hasEvidence && (editIntent.risk === "medium" || editIntent.risk === "high")) {
    missingFields.push("evidence_refs");
    risks.push(`Missing evidence for ${editIntent.risk} risk`);
    requiredEvidence.push("file_content_snapshot", editIntent.target_file);
    diagnostics.push(`Quality: missing evidence for ${editIntent.risk} risk`);
  }

  // 5. Context source quality
  if (contextSource === "prompt_only_fallback" && (editIntent.risk === "medium" || editIntent.risk === "high")) {
    risks.push("Prompt-only context for medium/high risk edit");
    diagnostics.push("Quality: prompt-only context for risky edit");
  }

  // 6. Delete operations need strong evidence
  if (editIntent.operation === "delete") {
    if (!hasEvidence) {
      missingFields.push("evidence_for_delete");
      risks.push("Delete operation without sufficient evidence");
      requiredEvidence.push(editIntent.target_file, "operator_confirmation");
      diagnostics.push("Quality: delete without evidence");
    }
  }

  // 7. target_symbol_or_range exists but no file range check
  if (editIntent.target_file && !editIntent.target_symbol_or_range && !hasExactText(builderOverrides) && !hasAnchor(builderOverrides)) {
    suggestedExpansionQueries.push(`Find symbol or text in ${editIntent.target_file}`);
    requiredEvidence.push(editIntent.target_file);
  }

  // Compute score
  const totalChecks = 7;
  let passedChecks = totalChecks;
  if (missingFields.length > 0) passedChecks -= Math.min(missingFields.length, totalChecks);
  if (risks.length > 0) passedChecks -= Math.min(risks.length, 3);
  const score = Math.max(0, Math.min(1, passedChecks / totalChecks));

  // Determine status
  if (missingFields.length === 0 && risks.length === 0) {
    return {
      status: "ready_for_patch",
      editIntentId: editIntent.target_file,
      score,
      missingFields: [],
      risks: [],
      requiredEvidence: [],
      suggestedExpansionQueries: [],
      diagnostics: ["Quality: ready for patch builder"]
    };
  }

  const hasBlockingRisk = risks.some((r) =>
    r.includes("forbidden") || r.includes("secret")
  );
  if (hasBlockingRisk) {
    return {
      status: "blocked",
      editIntentId: editIntent.target_file,
      score,
      missingFields,
      risks,
      requiredEvidence,
      suggestedExpansionQueries,
      diagnostics
    };
  }

  // If we're missing concrete edit info or evidence for medium/high risk, suggests expansion
  // But if we also have clarification-level issues, prefer needs_user_or_planner_clarification
  const isClarification = missingFields.includes("exact_scope_for_refactor");
  if (isClarification) {
    return {
      status: "needs_user_or_planner_clarification",
      editIntentId: editIntent.target_file,
      score,
      missingFields,
      risks,
      requiredEvidence,
      suggestedExpansionQueries,
      diagnostics
    };
  }

  return {
    status: "needs_evidence_expansion",
    editIntentId: editIntent.target_file,
    score,
    missingFields,
    risks,
    requiredEvidence,
    suggestedExpansionQueries,
    diagnostics
  };
}
