import type { EditIntent, MemoryEvidencePack } from "./RecursiveSwarmModels.js";

export type EvidenceExpansionResult = {
  status: "expanded" | "not_found" | "blocked";
  refinedEditIntent: EditIntent;
  builderOverrides?: {
    exactOldText: string | undefined;
    replacementText: string | undefined;
    anchorLine: string | undefined;
    insertAfterAnchor: boolean | undefined;
    insertBeforeAnchor: boolean | undefined;
  };
  addedEvidenceRefs: string[];
  filesRead: string[];
  rangesRead: string[];
  diagnostics: string[];
};

export type ExpansionInput = {
  editIntent: EditIntent;
  evidencePack?: MemoryEvidencePack;
  workspacePath: string;
  allowedPaths: string[];
  forbiddenPaths: string[];
  /** Current file content map (read by caller, keyed by absolute or relative path) */
  fileContents?: Record<string, string>;
  /** Existing builder overrides from caller */
  existingOverrides?: {
    exactOldText: string | undefined;
    replacementText: string | undefined;
    anchorLine: string | undefined;
    insertAfterAnchor: boolean | undefined;
    insertBeforeAnchor: boolean | undefined;
  };
};

const MAX_CANDIDATE_FILES = 5;

export function expandEditIntent(input: ExpansionInput): EvidenceExpansionResult {
  const { editIntent, evidencePack, allowedPaths, forbiddenPaths, fileContents, existingOverrides } = input;
  const addedEvidenceRefs: string[] = [];
  const filesRead: string[] = [];
  const rangesRead: string[] = [];
  const diagnostics: string[] = [];

  let refinedTargetFile = editIntent.target_file;
  let refinedSymbol: string | undefined = editIntent.target_symbol_or_range || undefined;
  let refinedOldText = existingOverrides?.exactOldText;
  let refinedReplacementText = existingOverrides?.replacementText;
  let refinedAnchorLine = existingOverrides?.anchorLine;
  let refinedInsertAfter = existingOverrides?.insertAfterAnchor;
  let refinedInsertBefore = existingOverrides?.insertBeforeAnchor;
  let refinedEvidenceRefs = [...(editIntent.evidence_refs ?? [])];

  // 1. Try to fill target_file from evidence pack
  if (!refinedTargetFile || refinedTargetFile.trim() === "") {
    if (evidencePack && evidencePack.relevant_files.length > 0) {
      const candidates = evidencePack.relevant_files.slice(0, MAX_CANDIDATE_FILES);
      diagnostics.push(`Expansion: inferred target_file from evidence pack candidates: ${candidates.join(", ")}`);
      // Use the first relevant file as the best guess
      refinedTargetFile = candidates[0];
      addedEvidenceRefs.push(`ev_pack:${evidencePack.pack_id}`);
    } else {
    return {
      status: "not_found",
      refinedEditIntent: editIntent,
      addedEvidenceRefs: [],
      filesRead: [],
      rangesRead: [],
      diagnostics: ["Expansion: no target_file and no evidence pack candidates"]
    };
    }
  }

  // 2. Check path safety on refined target
  if (isPathForbidden(refinedTargetFile, forbiddenPaths)) {
    return {
      status: "blocked",
      refinedEditIntent: { ...editIntent, target_file: refinedTargetFile },
      addedEvidenceRefs: [],
      filesRead: [],
      rangesRead: [],
      diagnostics: [`Expansion blocked: ${refinedTargetFile} in forbidden paths`]
    };
  }
  if (!isPathAllowed(refinedTargetFile, allowedPaths) && allowedPaths.length > 0) {
    return {
      status: "blocked",
      refinedEditIntent: { ...editIntent, target_file: refinedTargetFile },
      addedEvidenceRefs: [],
      filesRead: [],
      rangesRead: [],
      diagnostics: [`Expansion blocked: ${refinedTargetFile} not in allowed paths`]
    };
  }

  // 3. Try to fill target_symbol_or_range from evidence pack symbols
  if (!refinedSymbol && evidencePack && evidencePack.symbols.length > 0) {
    const matchingSymbols = evidencePack.symbols.filter((s) =>
      editIntent.reason.toLowerCase().includes(s.toLowerCase()) ||
      editIntent.expected_behavior.toLowerCase().includes(s.toLowerCase())
    );
    if (matchingSymbols.length > 0) {
      refinedSymbol = matchingSymbols[0];
      diagnostics.push(`Expansion: inferred symbol "${refinedSymbol}" from evidence pack symbols`);
      addedEvidenceRefs.push(`ev_pack:${evidencePack.pack_id}`);
    } else if (evidencePack.symbols.length > 0) {
      diagnostics.push("Expansion: no matching symbols in evidence pack");
    }
  }

  // 4. Try to fill exactOldText from file content if file is available
  if (!refinedOldText && !refinedAnchorLine && fileContents?.[refinedTargetFile]) {
    const content = fileContents[refinedTargetFile];
    const lines = content.split("\n");
    filesRead.push(refinedTargetFile);

    // Try to find a line matching the symbol
    if (refinedSymbol) {
      const symbolLine = lines.findIndex((l) => l.includes(refinedSymbol!));
      if (symbolLine >= 0) {
        const start = Math.max(0, symbolLine - 1);
        const end = Math.min(lines.length, symbolLine + 4);
        refinedOldText = lines.slice(start, end).join("\n");
        rangesRead.push(`${refinedTargetFile}:${start + 1}-${end}`);
        diagnostics.push(`Expansion: extracted context around symbol "${refinedSymbol}" from ${refinedTargetFile}:${start + 1}`);
        addedEvidenceRefs.push(`file_content:${refinedTargetFile}`);
      }
    } else {
      // No symbol — try to find a unique line related to the reason
      const reasonWords = editIntent.reason.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
      if (reasonWords.length > 0) {
        const matchingLine = lines.findIndex((l) =>
          reasonWords.some((w) => l.toLowerCase().includes(w))
        );
        if (matchingLine >= 0) {
          refinedAnchorLine = lines[matchingLine].trim();
          refinedInsertAfter = true;
          diagnostics.push(`Expansion: found anchor line matching reason: "${refinedAnchorLine.slice(0, 60)}"`);
          addedEvidenceRefs.push(`file_content:${refinedTargetFile}`);
        }
      }
    }
  }

  // 5. Try to fill evidence refs from pack
  if (refinedEvidenceRefs.length === 0 && evidencePack) {
    if (evidencePack.evidence_refs.length > 0) {
      refinedEvidenceRefs.push(...evidencePack.evidence_refs.slice(0, 5));
      addedEvidenceRefs.push(...evidencePack.evidence_refs.slice(0, 5));
      diagnostics.push(`Expansion: added ${evidencePack.evidence_refs.slice(0, 5).length} evidence refs from pack`);
    }
  }

  // Build result
  const refinedEditIntent: EditIntent = {
    ...editIntent,
    target_file: refinedTargetFile,
    target_symbol_or_range: refinedSymbol ?? editIntent.target_symbol_or_range,
    evidence_refs: refinedEvidenceRefs
  };

  const hasNewInfo = addedEvidenceRefs.length > 0 || filesRead.length > 0;
  const hasConcreteInfo = !!refinedOldText || !!refinedAnchorLine || !!refinedSymbol;

  if (hasNewInfo && hasConcreteInfo) {
    return {
      status: "expanded",
      refinedEditIntent,
      builderOverrides: {
        exactOldText: refinedOldText,
        replacementText: refinedReplacementText,
        anchorLine: refinedAnchorLine,
        insertAfterAnchor: refinedInsertAfter,
        insertBeforeAnchor: refinedInsertBefore
      },
      addedEvidenceRefs,
      filesRead,
      rangesRead,
      diagnostics: [...diagnostics, "Expansion: successfully enriched edit intent"]
    };
  }

  if (hasNewInfo && !hasConcreteInfo) {
    return {
      status: "not_found",
      refinedEditIntent,
      addedEvidenceRefs,
      filesRead,
      rangesRead,
      diagnostics: [...diagnostics, "Expansion: added evidence but could not find concrete edit information"]
    };
  }

  return {
    status: "not_found",
    refinedEditIntent,
    addedEvidenceRefs: [],
    filesRead: [],
    rangesRead: [],
    diagnostics: [...diagnostics, "Expansion: no improvement possible from available evidence"]
  };
}

function isPathAllowed(filePath: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  return allowed.some((p) => filePath.startsWith(p));
}

function isPathForbidden(filePath: string, forbidden: string[]): boolean {
  return forbidden.some((p) => filePath.startsWith(p));
}
