import { randomUUID } from "node:crypto";
import type { EditIntent, MemoryEvidencePack } from "./RecursiveSwarmModels.js";

export const MAX_DIFF_LINES = 80;
export const MAX_FILE_SIZE_BYTES = 256_000;

export type SurgicalPatchBuildResult =
  | {
      status: "real_diff";
      patchCandidateId: string;
      targetFile: string;
      unifiedDiff: string;
      summary: string;
      evidenceRefs: string[];
      risk: "low" | "medium" | "high";
      diagnostics: string[];
    }
  | {
      status: "needs_patch_generation";
      editIntentId: string;
      reason: string;
      diagnostics: string[];
      requiredEvidence: string[];
    }
  | {
      status: "blocked";
      editIntentId: string;
      reason: string;
      diagnostics: string[];
    };

export type SurgicalPatchInput = {
  editIntent: EditIntent;
  evidencePack?: MemoryEvidencePack;
  workspacePath: string;
  currentFileContent: string;
  allowedPaths: string[];
  forbiddenPaths: string[];
  /** Deterministic: exact old text to replace */
  exactOldText?: string;
  /** Deterministic: replacement text */
  replacementText?: string;
  /** Deterministic: anchor line to locate insertion point */
  anchorLine?: string;
  /** Deterministic: insert replacementText after the anchor line */
  insertAfterAnchor?: boolean;
  /** Deterministic: insert replacementText before the anchor line */
  insertBeforeAnchor?: boolean;
  /** Gated provider-suggested unified diff (post-checked) */
  providerSuggestedDiff?: string;
};

// ── Safety helpers ──────────────────────────────────────────

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

function countLines(s: string): number {
  if (!s) return 0;
  return s.split("\n").length;
}

function lineCountInDiff(diff: string): number {
  // Count added/removed lines in a unified diff (lines starting with + or - excluding +++/---)
  return diff.split("\n").filter((l) => (l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---")).length;
}

// ── Unified diff builder ────────────────────────────────────

function splitFileLines(content: string): string[] {
  let normalized = content;
  if (normalized.endsWith("\r\n")) {
    normalized = normalized.slice(0, -2);
  } else if (normalized.endsWith("\n")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized.length > 0 ? normalized.split(/\r?\n/) : [];
}

function buildUnifiedDiff(
  filePath: string,
  fileLines: string[],
  oldLines: string[],
  newLines: string[],
  matchIdx: number,
  contextLines = 3
): string {
  let commonLeading = 0;
  while (
    commonLeading < oldLines.length &&
    commonLeading < newLines.length &&
    oldLines[commonLeading] === newLines[commonLeading]
  ) {
    commonLeading++;
  }

  let commonTrailing = 0;
  while (
    commonTrailing < (oldLines.length - commonLeading) &&
    commonTrailing < (newLines.length - commonLeading) &&
    oldLines[oldLines.length - 1 - commonTrailing] === newLines[newLines.length - 1 - commonTrailing]
  ) {
    commonTrailing++;
  }

  const coreOld = oldLines.slice(commonLeading, oldLines.length - commonTrailing);
  const coreNew = newLines.slice(commonLeading, newLines.length - commonTrailing);
  const coreStartIdx = matchIdx + commonLeading;
  const coreEndIdx = matchIdx + oldLines.length - commonTrailing;

  const preStart = Math.max(0, Math.min(matchIdx, coreStartIdx - contextLines));
  const postEnd = Math.min(fileLines.length, Math.max(matchIdx + oldLines.length, coreEndIdx + contextLines));

  const preContext = fileLines.slice(preStart, coreStartIdx);
  const postContext = fileLines.slice(coreEndIdx, postEnd);

  const oldStart = fileLines.length === 0 ? 0 : preStart + 1;
  const oldCount = preContext.length + coreOld.length + postContext.length;
  const newStart = fileLines.length === 0 ? (newLines.length === 0 ? 0 : 1) : preStart + 1;
  const newCount = preContext.length + coreNew.length + postContext.length;

  const lines: string[] = [];
  lines.push(`diff --git a/${filePath} b/${filePath}`);
  lines.push(`--- a/${filePath}`);
  lines.push(`+++ b/${filePath}`);
  lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);

  for (const l of preContext) lines.push(` ${l}`);
  for (const l of coreOld) lines.push(`-${l}`);
  for (const l of coreNew) lines.push(`+${l}`);
  for (const l of postContext) lines.push(` ${l}`);

  return lines.join("\n") + "\n";
}

// ── Strategy: exact text replacement ─────────────────────────

function tryExactReplacement(
  input: SurgicalPatchInput
): SurgicalPatchBuildResult | null {
  const { editIntent, currentFileContent, exactOldText, replacementText } = input;
  if (!exactOldText || replacementText === undefined) return null;

  const fileLines = splitFileLines(currentFileContent);
  const oldLines = exactOldText.split(/\r?\n/);
  const newLines = replacementText.split(/\r?\n/);

  if (oldLines.length === 0) return null;

  // Find the exact match in file
  let matchIdx = -1;
  for (let i = 0; i <= fileLines.length - oldLines.length; i++) {
    let match = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (fileLines[i + j] !== oldLines[j]) { match = false; break; }
    }
    if (match) { matchIdx = i; break; }
  }
  if (matchIdx === -1) return null;

  const totalChanged = countLines(replacementText);
  if (totalChanged > MAX_DIFF_LINES) return null;

  const diff = buildUnifiedDiff(editIntent.target_file, fileLines, oldLines, newLines, matchIdx);
  const summary = `Exact replacement in ${editIntent.target_file}:${matchIdx + 1}`;

  return {
    status: "real_diff",
    patchCandidateId: `spb_${randomUUID().slice(0, 8)}`,
    targetFile: editIntent.target_file,
    unifiedDiff: diff,
    summary,
    evidenceRefs: editIntent.evidence_refs,
    risk: editIntent.risk,
    diagnostics: [`Exact text replacement at line ${matchIdx + 1} (${oldLines.length} line(s) → ${newLines.length} line(s))`]
  };
}

// ── Strategy: anchor-based insert ────────────────────────────

function tryAnchorInsert(
  input: SurgicalPatchInput
): SurgicalPatchBuildResult | null {
  const { editIntent, currentFileContent, anchorLine, insertAfterAnchor, insertBeforeAnchor, replacementText } = input;
  if (!anchorLine || !replacementText) return null;
  if (!insertAfterAnchor && !insertBeforeAnchor) return null;

  const fileLines = splitFileLines(currentFileContent);
  const newLines = replacementText.split(/\r?\n/);
  if (newLines.length > MAX_DIFF_LINES) return null;

  // Find anchor line
  const anchorIdx = fileLines.findIndex((l) => l.includes(anchorLine));
  if (anchorIdx === -1) return null;

  let insertIdx: number;
  if (insertAfterAnchor) {
    insertIdx = anchorIdx + 1;
  } else {
    insertIdx = anchorIdx;
  }

  const oldBlock: string[] = [];
  const diff = buildUnifiedDiff(editIntent.target_file, fileLines, oldBlock, newLines, insertIdx);

  return {
    status: "real_diff",
    patchCandidateId: `spb_${randomUUID().slice(0, 8)}`,
    targetFile: editIntent.target_file,
    unifiedDiff: diff,
    summary: `Insert ${newLines.length} line(s) ${insertAfterAnchor ? "after" : "before"} anchor "${anchorLine}"`,
    evidenceRefs: editIntent.evidence_refs,
    risk: editIntent.risk,
    diagnostics: [`Anchor insert at line ${insertIdx + 1} (${newLines.length} line(s))`]
  };
}

// ── Strategy: new file create ────────────────────────────────

function tryNewFileCreate(
  input: SurgicalPatchInput
): SurgicalPatchBuildResult | null {
  const { editIntent, currentFileContent, replacementText } = input;
  if (editIntent.operation !== "create") return null;
  if (!replacementText) return null;

  // File must not exist (current file content is empty)
  if (currentFileContent.trim().length > 0) return null;

  const newLines = replacementText.split("\n");
  if (newLines.length > MAX_DIFF_LINES) return null;

  // Unified diff for a new file: /dev/null → a/file
  const diff = [
    `diff --git a/${editIntent.target_file} b/${editIntent.target_file}`,
    `new file mode 100644`,
    `--- /dev/null`,
    `+++ b/${editIntent.target_file}`,
    `@@ -0,0 +1,${newLines.length} @@`,
    ...newLines.map((l) => `+${l}`)
  ].join("\n") + "\n";

  return {
    status: "real_diff",
    patchCandidateId: `spb_${randomUUID().slice(0, 8)}`,
    targetFile: editIntent.target_file,
    unifiedDiff: diff,
    summary: `Create new file ${editIntent.target_file} (${newLines.length} line(s))`,
    evidenceRefs: editIntent.evidence_refs,
    risk: editIntent.risk,
    diagnostics: [`New file create: ${newLines.length} line(s)`]
  };
}

// ── Strategy: file delete ────────────────────────────────────

function tryFileDelete(
  input: SurgicalPatchInput
): SurgicalPatchBuildResult | null {
  const { editIntent, currentFileContent } = input;
  if (editIntent.operation !== "delete") return null;

  const fileLines = currentFileContent.split("\n");
  if (fileLines.length > MAX_DIFF_LINES) {
    return {
      status: "needs_patch_generation",
      editIntentId: editIntent.target_file,
      reason: `Delete of large file (${fileLines.length} lines) requires explicit confirmation`,
      diagnostics: [`Delete blocked: file too large (${fileLines.length} lines > ${MAX_DIFF_LINES})`],
      requiredEvidence: ["operator_confirmation", "delete_approved"]
    };
  }

  const diff = [
    `diff --git a/${editIntent.target_file} b/${editIntent.target_file}`,
    `deleted file mode 100644`,
    `--- a/${editIntent.target_file}`,
    `+++ /dev/null`,
    `@@ -1,${fileLines.length} +0,0 @@`,
    ...fileLines.map((l) => `-${l}`)
  ].join("\n") + "\n";

  return {
    status: "real_diff",
    patchCandidateId: `spb_${randomUUID().slice(0, 8)}`,
    targetFile: editIntent.target_file,
    unifiedDiff: diff,
    summary: `Delete file ${editIntent.target_file}`,
    evidenceRefs: editIntent.evidence_refs,
    risk: editIntent.risk,
    diagnostics: [`File delete: ${fileLines.length} line(s) removed`]
  };
}

// ── Gated provider diff check ────────────────────────────────

function tryProviderDiff(
  input: SurgicalPatchInput
): SurgicalPatchBuildResult | null {
  const { editIntent, providerSuggestedDiff, currentFileContent } = input;
  if (!providerSuggestedDiff) return null;

  // Parse and validate the provider-suggested diff
  const lines = providerSuggestedDiff.split("\n");
  const diffLines = lines.filter((l) => (l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---"));

  // Size check
  if (diffLines.length > MAX_DIFF_LINES) {
    return {
      status: "needs_patch_generation",
      editIntentId: editIntent.target_file,
      reason: `Provider diff too large (${diffLines.length} changed lines > ${MAX_DIFF_LINES})`,
      diagnostics: [`Provider diff rejected: ${diffLines.length} changed lines exceeds limit`],
      requiredEvidence: []
    };
  }

  // Verify it has proper unified diff markers
  if (!lines[0]?.startsWith("--- ") || !lines[1]?.startsWith("+++ ") || !lines[2]?.startsWith("@@ ")) {
    return {
      status: "blocked",
      editIntentId: editIntent.target_file,
      reason: "Provider diff missing unified diff headers (---/+++/@@)",
      diagnostics: ["Provider diff rejected: malformed headers"]
    };
  }

  // Verify it targets the correct file
  const targetLine = lines.find((l) => l.startsWith("+++ b/"));
  if (!targetLine) {
    return {
      status: "blocked",
      editIntentId: editIntent.target_file,
      reason: "Provider diff missing +++ b/ target line",
      diagnostics: ["Provider diff rejected: missing target file"]
    };
  }

  const diffTargetFile = targetLine.slice(6);
  if (diffTargetFile !== editIntent.target_file) {
    return {
      status: "blocked",
      editIntentId: editIntent.target_file,
      reason: `Provider diff targets ${diffTargetFile}, but edit intent targets ${editIntent.target_file}`,
      diagnostics: ["Provider diff rejected: file mismatch"]
    };
  }

  // Verify no secret content
  const secrets = [".env", ".pem", ".key", "password", "token", "secret", "credential"];
  const hasSecret = secrets.some((s) => providerSuggestedDiff.toLowerCase().includes(s));
  if (hasSecret) {
    return {
      status: "blocked",
      editIntentId: editIntent.target_file,
      reason: "Provider diff contains potential secret content",
      diagnostics: ["Provider diff rejected: contains secrets"]
    };
  }

  // Verify no whole-file rewrite (diff modifies most lines)
  const fileLineCount = currentFileContent.split("\n").length;
  if (fileLineCount > 10 && diffLines.length > fileLineCount * 0.8) {
    return {
      status: "needs_patch_generation",
      editIntentId: editIntent.target_file,
      reason: `Provider diff modifies ${diffLines.length}/${fileLineCount} lines — near whole-file rewrite`,
      diagnostics: ["Provider diff rejected: near whole-file rewrite"],
      requiredEvidence: ["explicit_operator_approval"]
    };
  }

  return {
    status: "real_diff",
    patchCandidateId: `spb_${randomUUID().slice(0, 8)}`,
    targetFile: editIntent.target_file,
    unifiedDiff: providerSuggestedDiff,
    summary: `Provider-suggested patch for ${editIntent.target_file} (${diffLines.length} changed line(s))`,
    evidenceRefs: editIntent.evidence_refs,
    risk: editIntent.risk,
    diagnostics: [`Provider diff accepted: ${diffLines.length} changed line(s)`]
  };
}

// ── Public entry point ───────────────────────────────────────

export function buildSurgicalPatch(input: SurgicalPatchInput): SurgicalPatchBuildResult {
  const { editIntent, allowedPaths, forbiddenPaths, evidencePack, currentFileContent } = input;
  const diagnostics: string[] = [];

  // 1. Path safety
  if (isPathForbidden(editIntent.target_file, forbiddenPaths)) {
    return {
      status: "blocked",
      editIntentId: editIntent.target_file,
      reason: `Target file is in forbidden paths: ${editIntent.target_file}`,
      diagnostics: [`Blocked: ${editIntent.target_file} (forbidden path)`]
    };
  }

  if (!isPathAllowed(editIntent.target_file, allowedPaths)) {
    return {
      status: "blocked",
      editIntentId: editIntent.target_file,
      reason: `Target file is not in allowed paths: ${editIntent.target_file}`,
      diagnostics: [`Blocked: ${editIntent.target_file} (not in allowed paths)`]
    };
  }

  if (isSecretFile(editIntent.target_file)) {
    return {
      status: "blocked",
      editIntentId: editIntent.target_file,
      reason: `Target file appears to be a secret/config file: ${editIntent.target_file}`,
      diagnostics: [`Blocked: ${editIntent.target_file} (secret file)`]
    };
  }

  // 2. Missing file check (non-create operations need an existing file)
  if (currentFileContent.length === 0 && editIntent.operation !== "create") {
    return {
      status: "blocked",
      editIntentId: editIntent.target_file,
      reason: `Target file appears to be empty or non-existent: ${editIntent.target_file}`,
      diagnostics: [`Blocked: ${editIntent.target_file} (empty/non-existent file for non-create operation)`]
    };
  }

  // 3. File size safety
  if (currentFileContent.length > MAX_FILE_SIZE_BYTES) {
    return {
      status: "blocked",
      editIntentId: editIntent.target_file,
      reason: `Target file too large (${currentFileContent.length} bytes > ${MAX_FILE_SIZE_BYTES} max)`,
      diagnostics: [`Blocked: ${editIntent.target_file} too large (${currentFileContent.length} bytes)`]
    };
  }

  // 3. Evidence/risk check
  const hasEvidence = (editIntent.evidence_refs?.length ?? 0) > 0 || (evidencePack?.evidence_refs?.length ?? 0) > 0;
  if (!hasEvidence && (editIntent.risk === "medium" || editIntent.risk === "high")) {
    return {
      status: "needs_patch_generation",
      editIntentId: editIntent.target_file,
      reason: `Missing evidence for ${editIntent.risk} risk edit intent`,
      diagnostics: [`Needs patch generation: missing evidence (risk=${editIntent.risk})`],
      requiredEvidence: ["file_content_snapshot", editIntent.target_file]
    };
  }

  // 4. Broad refactor check
  if (editIntent.operation === "refactor" && !input.exactOldText) {
    return {
      status: "needs_patch_generation",
      editIntentId: editIntent.target_file,
      reason: "Broad refactor without exact old text — cannot generate safe diff deterministically",
      diagnostics: ["Needs patch generation: broad refactor without exact old text"],
      requiredEvidence: [editIntent.target_file, ...editIntent.evidence_refs]
    };
  }

  // 5. Try deterministic strategies in order
  const strategies: Array<(i: SurgicalPatchInput) => SurgicalPatchBuildResult | null> = [
    // Provider diff first (if given, gated by checks)
    (i) => tryProviderDiff(i),
    // Exact text replacement
    (i) => tryExactReplacement(i),
    // Anchor insert
    (i) => tryAnchorInsert(i),
    // New file create
    (i) => tryNewFileCreate(i),
    // File delete
    (i) => tryFileDelete(i)
  ];

  for (const strategy of strategies) {
    const result = strategy(input);
    if (result) return result;
  }

  // 6. No strategy could produce a diff
  return {
    status: "needs_patch_generation",
    editIntentId: editIntent.target_file,
    reason: `No deterministic strategy could produce a diff for ${editIntent.operation} on ${editIntent.target_file}`,
    diagnostics: ["Needs patch generation: no strategy matched"],
    requiredEvidence: [editIntent.target_file, ...editIntent.evidence_refs]
  };
}
