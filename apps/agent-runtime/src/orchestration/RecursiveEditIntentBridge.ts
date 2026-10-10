import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PatchProposal, PatchRiskLevel, CommandRequest, CommandRisk } from "@hivo/protocol";
import type { EditIntent, GeneratedArtifact, ValidationPlan, RecursiveSwarmNode, MemoryEvidencePack, RecursiveNodeOutput } from "./RecursiveSwarmModels.js";
import { classifyCommandRisk } from "../tools/CommandPolicy.js";
import { buildSurgicalPatch, type SurgicalPatchInput } from "./SurgicalPatchBuilder.js";
import { evaluateEditIntentQuality, type EditIntentQualityResult } from "./EditIntentQualityGate.js";
import { expandEditIntent, type EvidenceExpansionResult } from "./EvidenceExpansionLoop.js";

export const MAX_EXPANSION_ATTEMPTS = 2;

// ── Types ───────────────────────────────────────────────────

export type BridgeEditIntent = {
  nodeId: string;
  intent: EditIntent;
};

export type BridgeGeneratedArtifact = {
  nodeId: string;
  artifact: GeneratedArtifact;
};

export type BlockedEditIntent = {
  nodeId: string;
  intent: EditIntent;
  reason: string;
};

export type NeedsGenerationIntent = {
  nodeId: string;
  intent: EditIntent;
  reason: string;
  requiredEvidence: string[];
};

export type BridgeResult = {
  patchCandidates: PatchProposal[];
  auxiliaryArtifacts?: Array<{ nodeId: string; artifact: GeneratedArtifact; reason: string }>;
  blockedIntents: BlockedEditIntent[];
  needsGenerationIntents: NeedsGenerationIntent[];
  diagnostics: string[];
  validationCommandRequests: CommandRequest[];
  summaryCounts: {
    realDiff: number;
    needsGeneration: number;
    blocked: number;
  };
  /** New quality/expansion metrics */
  qualityMetrics: {
    totalIntents: number;
    readyOnFirstPass: number;
    expandedSuccessfully: number;
    expansionFailed: number;
    blockedByQualityGate: number;
    blockedByPatchBuilder: number;
    topMissingFields: string[];
    contextSourceSummary: string;
  };
};

export type BridgeInput = {
  sessionId: string;
  workspacePath: string;
  intents: BridgeEditIntent[];
  generatedArtifacts?: BridgeGeneratedArtifact[];
  validationPlans: { nodeId: string; plan: ValidationPlan }[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  fileContents?: Record<string, string>;
  builderOverrides?: Record<string, Pick<SurgicalPatchInput, "exactOldText" | "replacementText" | "anchorLine" | "insertAfterAnchor" | "insertBeforeAnchor">>;
  evidencePacks?: Record<string, MemoryEvidencePack>;
  originalGoal?: string;
  deliverableContract?: string;
  isImplementation?: boolean;
};

// ── Helpers ─────────────────────────────────────────────────

function mapRisk(risk: EditIntent["risk"]): PatchRiskLevel {
  if (risk === "low") return "low";
  if (risk === "medium") return "medium";
  return "high";
}

function mapChangeType(operation: EditIntent["operation"]): "create" | "modify" | "delete" {
  if (operation === "create") return "create";
  if (operation === "delete") return "delete";
  return "modify";
}

function copyOverrides(src: BridgeInput["builderOverrides"] | undefined, file: string) {
  const o = src?.[file];
  return o ? { exactOldText: o.exactOldText, replacementText: o.replacementText, anchorLine: o.anchorLine, insertAfterAnchor: o.insertAfterAnchor, insertBeforeAnchor: o.insertBeforeAnchor } : undefined;
}

type GeneratedArtifactPatchResult = {
  proposal?: PatchProposal;
  blockedReason?: string;
  needsGenerationReason?: string;
  diagnostics: string[];
  isExisting?: boolean;
  targetPath?: string;
};

export type NormalizedExistingFilePatchResult = {
  valid: boolean;
  normalizedDiff?: string;
  reason?: string;
};

export function parseUnifiedDiffHunks(diff: string): {
  oldHeaderPath: string | null;
  newHeaderPath: string | null;
  hasGitHeader: boolean;
  hunks: Array<{ header: string; lines: string[] }>;
} {
  const lines = diff.split(/\r?\n/);
  let oldHeaderPath: string | null = null;
  let newHeaderPath: string | null = null;
  let hasGitHeader = false;

  const hunks: Array<{ header: string; lines: string[] }> = [];
  let currentHunk: { header: string; lines: string[] } | null = null;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      hasGitHeader = true;
      const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (match) {
        oldHeaderPath = match[1];
        newHeaderPath = match[2];
      }
      continue;
    }
    if (line.startsWith("--- ")) {
      const p = line.slice(4).trim();
      oldHeaderPath = p === "/dev/null" ? "/dev/null" : (p.startsWith("a/") ? p.slice(2) : p);
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      newHeaderPath = p === "/dev/null" ? "/dev/null" : (p.startsWith("b/") ? p.slice(2) : p);
      continue;
    }
    if (line.startsWith("@@")) {
      currentHunk = { header: line, lines: [] };
      hunks.push(currentHunk);
      continue;
    }
    if (currentHunk) {
      if (line.startsWith(" ") || line.startsWith("-") || line.startsWith("+") || line.startsWith("\\")) {
        currentHunk.lines.push(line);
      }
    }
  }

  return { oldHeaderPath, newHeaderPath, hasGitHeader, hunks };
}

export function tryNormalizeExistingFilePatch(
  targetPath: string,
  currentContent: string,
  patchContent: string
): NormalizedExistingFilePatchResult {
  let trimmed = patchContent.trim();
  if (trimmed.startsWith("```")) {
    const firstNewline = trimmed.indexOf("\n");
    if (firstNewline !== -1) {
      trimmed = trimmed.slice(firstNewline + 1);
    }
    if (trimmed.endsWith("```")) {
      trimmed = trimmed.slice(0, trimmed.lastIndexOf("```")).trimEnd();
    }
  }

  // 1. Reject pseudo-patch syntax or conversational wrapper
  if (
    trimmed.includes("*** Begin Patch") ||
    trimmed.includes("*** Update File:") ||
    trimmed.includes("*** End Patch")
  ) {
    return { valid: false, reason: "Pseudo-patch syntax is not a standard unified diff" };
  }

  // 2. Reject potential secrets
  const lower = trimmed.toLowerCase();
  const secrets = [".env", ".pem", ".key", "password", "token", "credential"];
  if (secrets.some((s) => lower.includes(s) && !targetPath.toLowerCase().includes(s))) {
    return { valid: false, reason: "Patch contains potential secret content" };
  }

  // 3. Parse hunks and headers
  const parsed = parseUnifiedDiffHunks(trimmed);
  if (parsed.hunks.length === 0) {
    return { valid: false, reason: "No unified diff hunks found in artifact content (missing '@@')" };
  }

  // Reject /dev/null headers for an existing file
  if (parsed.oldHeaderPath === "/dev/null" || parsed.newHeaderPath === "/dev/null") {
    return { valid: false, reason: "Diff attempts to create or delete file from /dev/null on an existing file" };
  }

  // Validate header paths match targetPath if present
  if (parsed.oldHeaderPath && normalizeArtifactPath(parsed.oldHeaderPath) !== targetPath) {
    return { valid: false, reason: `Diff header path ${parsed.oldHeaderPath} does not match target file ${targetPath}` };
  }
  if (parsed.newHeaderPath && normalizeArtifactPath(parsed.newHeaderPath) !== targetPath) {
    return { valid: false, reason: `Diff header path ${parsed.newHeaderPath} does not match target file ${targetPath}` };
  }

  // 4. Validate and apply hunks against currentContent
  let normalizedContent = currentContent;
  if (normalizedContent.endsWith("\r\n")) {
    normalizedContent = normalizedContent.slice(0, -2);
  } else if (normalizedContent.endsWith("\n")) {
    normalizedContent = normalizedContent.slice(0, -1);
  }
  const fileLines = normalizedContent.length > 0 ? normalizedContent.split(/\r?\n/) : [];
  const updatedLines = [...fileLines];
  const normalizedHunks: Array<{ header: string; lines: string[] }> = [];
  let totalChangedLines = 0;
  let cumulativeDelta = 0;

  for (const hunk of parsed.hunks) {
    const oldSlice: string[] = [];
    const newSlice: string[] = [];
    let hunkChanged = false;

    for (const rawLine of hunk.lines) {
      if (rawLine.startsWith("\\")) {
        continue;
      }
      const prefix = rawLine[0];
      const text = rawLine.slice(1).replace(/\r$/, "");
      if (prefix === " ") {
        oldSlice.push(text);
        newSlice.push(text);
      } else if (prefix === "-") {
        oldSlice.push(text);
        hunkChanged = true;
        totalChangedLines++;
      } else if (prefix === "+") {
        newSlice.push(text);
        hunkChanged = true;
        totalChangedLines++;
      }
    }

    if (!hunkChanged) {
      return { valid: false, reason: "Diff hunk contains no added or removed lines" };
    }

    // Locate oldSlice in fileLines
    const matches: number[] = [];
    for (let i = 0; i <= fileLines.length - oldSlice.length; i++) {
      let match = true;
      for (let j = 0; j < oldSlice.length; j++) {
        if (fileLines[i + j] !== oldSlice[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        matches.push(i);
      }
    }

    let matchIdx = -1;
    if (matches.length === 1) {
      matchIdx = matches[0];
    } else if (matches.length > 1) {
      const headerMatch = hunk.header.match(/^@@ -(\d+)/);
      const hintedStart = headerMatch ? parseInt(headerMatch[1], 10) - 1 : null;
      if (hintedStart !== null && matches.includes(hintedStart)) {
        matchIdx = hintedStart;
      } else {
        return { valid: false, reason: "Ambiguous patch match: context matches multiple locations in target file" };
      }
    }

    if (matchIdx === -1) {
      return { valid: false, reason: "Hunk failed to apply: expected context or removed lines not found in target file" };
    }

    // Convert unchanged common leading/trailing lines between oldSlice and newSlice into context
    let commonLeading = 0;
    while (
      commonLeading < oldSlice.length &&
      commonLeading < newSlice.length &&
      oldSlice[commonLeading] === newSlice[commonLeading]
    ) {
      commonLeading++;
    }

    let commonTrailing = 0;
    while (
      commonTrailing < (oldSlice.length - commonLeading) &&
      commonTrailing < (newSlice.length - commonLeading) &&
      oldSlice[oldSlice.length - 1 - commonTrailing] === newSlice[newSlice.length - 1 - commonTrailing]
    ) {
      commonTrailing++;
    }

    const coreOld = oldSlice.slice(commonLeading, oldSlice.length - commonTrailing);
    const coreNew = newSlice.slice(commonLeading, newSlice.length - commonTrailing);

    if (coreOld.length === 0 && coreNew.length === 0) {
      return { valid: false, reason: "Diff hunk produces no net changes" };
    }

    const coreStartIdx = matchIdx + commonLeading;
    const coreEndIdx = matchIdx + oldSlice.length - commonTrailing;

    // Add up to 3 lines of surrounding context from authoritative current file
    const preStartIdx = Math.max(0, Math.min(matchIdx, coreStartIdx - 3));
    const postEndIdx = Math.min(fileLines.length, Math.max(matchIdx + oldSlice.length, coreEndIdx + 3));

    const preLines = fileLines.slice(preStartIdx, coreStartIdx);
    const postLines = fileLines.slice(coreEndIdx, postEndIdx);

    const hunkLines: string[] = [];
    for (const l of preLines) hunkLines.push(` ${l}`);
    for (const l of coreOld) hunkLines.push(`-${l}`);
    for (const l of coreNew) hunkLines.push(`+${l}`);
    for (const l of postLines) hunkLines.push(` ${l}`);

    const oldCount = preLines.length + coreOld.length + postLines.length;
    const newCount = preLines.length + coreNew.length + postLines.length;
    const oldStart = fileLines.length === 0 ? 0 : preStartIdx + 1;
    const newStart = fileLines.length === 0 ? (newCount === 0 ? 0 : 1) : preStartIdx + 1 + cumulativeDelta;

    normalizedHunks.push({
      header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
      lines: hunkLines
    });

    const updatedMatchIdx = matchIdx + cumulativeDelta;
    if (updatedMatchIdx >= 0 && updatedMatchIdx + oldSlice.length <= updatedLines.length) {
      updatedLines.splice(updatedMatchIdx, oldSlice.length, ...newSlice);
    }

    cumulativeDelta += (newCount - oldCount);
  }

  // 5. Whole-file rewrite check
  if (fileLines.length > 10 && totalChangedLines > fileLines.length * 0.8) {
    return { valid: false, reason: `Diff modifies ${totalChangedLines}/${fileLines.length} lines — near whole-file rewrite is not permitted` };
  }

  // 6. Net change check
  const updatedContent = updatedLines.join("\n");
  if (updatedContent === currentContent.split(/\r?\n/).join("\n")) {
    return { valid: false, reason: "Patch produces no net changes to target file" };
  }

  // 7. Assemble normalized unified diff
  const normalizedDiff = [
    `diff --git a/${targetPath} b/${targetPath}`,
    `--- a/${targetPath}`,
    `+++ b/${targetPath}`,
    ...normalizedHunks.flatMap((h) => [h.header, ...h.lines])
  ].join("\n") + "\n";

  return { valid: true, normalizedDiff };
}

export function isPatchArtifact(artifact: GeneratedArtifact): boolean {
  if (!artifact) return false;
  const rawPath = artifact.path ?? "";
  const lowerPath = rawPath.trim().toLowerCase();
  if (lowerPath.endsWith(".diff") || lowerPath.endsWith(".patch")) {
    return true;
  }
  let content = (artifact.content ?? "").trim();
  if (content.startsWith("```")) {
    const firstNewline = content.indexOf("\n");
    if (firstNewline !== -1) {
      content = content.slice(firstNewline + 1);
    }
    if (content.endsWith("```")) {
      content = content.slice(0, content.lastIndexOf("```")).trimEnd();
    }
    content = content.trim();
  }
  if (content.startsWith("diff --git ")) {
    return true;
  }
  if (
    (content.startsWith("--- a/") || content.startsWith("--- /dev/null") || content.startsWith("--- ")) &&
    (content.includes("\n+++ b/") || content.includes("\n+++ /dev/null") || content.includes("\n+++ ")) &&
    content.includes("\n@@")
  ) {
    return true;
  }
  return false;
}

export interface ParsedPatchArtifact {
  valid: boolean;
  blockedReason?: string;
  targetPath?: string;
  operation?: "modify" | "create" | "delete";
  oldHeaderPath?: string;
  newHeaderPath?: string;
  cleanDiff?: string;
  hunkCount?: number;
}

export interface ConvertedPseudoPatchResult {
  valid: boolean;
  convertedDiff?: string;
  targetPath?: string;
  blockedReason?: string;
}

export function tryConvertPseudoPatch(rawContent: string): ConvertedPseudoPatchResult {
  const trimmed = rawContent.trim();
  const beginIdx = trimmed.indexOf("*** Begin Patch");
  const endIdx = trimmed.indexOf("*** End Patch");
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) {
    return { valid: false, blockedReason: "Malformed pseudo-patch: missing Begin Patch or End Patch markers" };
  }

  let inner = trimmed.slice(beginIdx + "*** Begin Patch".length, endIdx).trim();
  if (inner.startsWith("```")) {
    const firstNl = inner.indexOf("\n");
    if (firstNl !== -1) inner = inner.slice(firstNl + 1);
    if (inner.endsWith("```")) inner = inner.slice(0, inner.lastIndexOf("```")).trimEnd();
    inner = inner.trim();
  }

  // Support single existing-file target with '*** Update File: <path>'
  const fileMatches = [...inner.matchAll(/\*\*\*\s*([A-Za-z]+)\s*File:\s*([^\r\n]+)/gi)];
  if (fileMatches.length === 0) {
    return { valid: false, blockedReason: "Malformed pseudo-patch: missing '*** Update File:' header" };
  }
  if (fileMatches.length > 1) {
    return { valid: false, blockedReason: "Multi-file diff artifacts are not supported: multiple file updates found in pseudo-patch" };
  }

  const opKind = fileMatches[0][1].toLowerCase();
  if (opKind !== "update") {
    return { valid: false, blockedReason: `Unsupported pseudo-patch operation '${fileMatches[0][1]} File': only single existing-file 'Update File' is supported` };
  }

  const rawTarget = fileMatches[0][2].trim();
  const targetPath = normalizeArtifactPath(rawTarget);
  if (!targetPath) {
    return { valid: false, blockedReason: `Pseudo-patch target path is invalid or outside workspace: ${rawTarget}` };
  }

  const hunkStartIdx = inner.indexOf("@@");
  if (hunkStartIdx === -1) {
    return { valid: false, blockedReason: "Malformed pseudo-patch: no diff hunks found (missing '@@')" };
  }

  const hunkContent = inner.slice(hunkStartIdx).trim();
  if (!hunkContent) {
    return { valid: false, blockedReason: "Malformed pseudo-patch: empty hunk content" };
  }

  const convertedDiff = `--- a/${targetPath}\n+++ b/${targetPath}\n${hunkContent}\n`;
  return { valid: true, convertedDiff, targetPath };
}

export function parsePatchArtifact(artifact: GeneratedArtifact): ParsedPatchArtifact {
  let trimmed = (artifact.content ?? "").trim();
  if (trimmed.startsWith("```")) {
    const firstNewline = trimmed.indexOf("\n");
    if (firstNewline !== -1) {
      trimmed = trimmed.slice(firstNewline + 1);
    }
    if (trimmed.endsWith("```")) {
      trimmed = trimmed.slice(0, trimmed.lastIndexOf("```")).trimEnd();
    }
    trimmed = trimmed.trim();
  }

  // 1. Check for unsupported binary diff
  if (
    trimmed.includes("GIT binary patch") ||
    trimmed.startsWith("Binary files ") ||
    trimmed.includes("\nBinary files ")
  ) {
    return { valid: false, blockedReason: "Unsupported binary diff in patch artifact" };
  }

  // 2. Check for pseudo-patch syntax
  const rawPath = (artifact.path ?? "").trim().toLowerCase();
  const isDiffOrPatchFile = rawPath.endsWith(".diff") || rawPath.endsWith(".patch");
  const hasPseudoPatchMarkers =
    trimmed.includes("*** Begin Patch") ||
    trimmed.includes("*** Update File:") ||
    trimmed.includes("*** End Patch");

  if (hasPseudoPatchMarkers) {
    if (!isDiffOrPatchFile) {
      return { valid: false, blockedReason: "Pseudo-patch syntax is not a standard unified diff" };
    }
    const converted = tryConvertPseudoPatch(trimmed);
    if (!converted.valid || !converted.convertedDiff) {
      return { valid: false, blockedReason: converted.blockedReason ?? "Malformed pseudo-patch" };
    }
    trimmed = converted.convertedDiff;
  }

  // 3. Parse headers and hunks
  const lines = trimmed.split(/\r?\n/);
  let oldHeaderPath: string | null = null;
  let newHeaderPath: string | null = null;
  let hasGitHeader = false;
  let seenFirstHunk = false;
  const hunks: Array<{ header: string; lines: string[] }> = [];
  let currentHunk: { header: string; lines: string[] } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("diff --git ")) {
      hasGitHeader = true;
      const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (match) {
        if (oldHeaderPath && oldHeaderPath !== match[1]) {
          return { valid: false, blockedReason: "Multi-file diff artifacts are not supported: found multiple diff targets" };
        }
        oldHeaderPath = match[1];
        newHeaderPath = match[2];
      }
      continue;
    }

    if (line.startsWith("--- ")) {
      if (seenFirstHunk) {
        if (i + 1 < lines.length && lines[i + 1].startsWith("+++ ")) {
          return { valid: false, blockedReason: "Multi-file diff artifacts are not supported: found multiple file diffs in artifact" };
        }
      }
      const p = line.slice(4).trim();
      oldHeaderPath = p === "/dev/null" ? "/dev/null" : (p.startsWith("a/") ? p.slice(2) : p);
      continue;
    }

    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      newHeaderPath = p === "/dev/null" ? "/dev/null" : (p.startsWith("b/") ? p.slice(2) : p);
      continue;
    }

    if (line.startsWith("@@")) {
      seenFirstHunk = true;
      currentHunk = { header: line, lines: [] };
      hunks.push(currentHunk);
      continue;
    }

    if (currentHunk) {
      if (line.startsWith(" ") || line.startsWith("-") || line.startsWith("+") || line.startsWith("\\")) {
        currentHunk.lines.push(line);
      }
    }
  }

  // 4. Validate headers exist
  if (!oldHeaderPath || !newHeaderPath) {
    return { valid: false, blockedReason: "Malformed unified diff: missing file headers (--- and +++)" };
  }

  // 5. Validate hunks exist
  if (hunks.length === 0) {
    return { valid: false, blockedReason: "No unified diff hunks found in patch artifact (missing '@@')" };
  }

  // 6. Determine operation
  let operation: "modify" | "create" | "delete";
  let rawTarget: string;

  if (oldHeaderPath === "/dev/null" && newHeaderPath === "/dev/null") {
    return { valid: false, blockedReason: "Malformed unified diff: both headers are /dev/null" };
  } else if (oldHeaderPath === "/dev/null") {
    operation = "create";
    rawTarget = newHeaderPath;
  } else if (newHeaderPath === "/dev/null") {
    operation = "delete";
    rawTarget = oldHeaderPath;
  } else {
    operation = "modify";
    const normOld = normalizeArtifactPath(oldHeaderPath);
    const normNew = normalizeArtifactPath(newHeaderPath);
    if (!normOld) {
      return {
        valid: false,
        blockedReason: `Patch target path is invalid or outside workspace: ${oldHeaderPath}`
      };
    }
    if (!normNew) {
      return {
        valid: false,
        blockedReason: `Patch target path is invalid or outside workspace: ${newHeaderPath}`
      };
    }
    if (normOld !== normNew) {
      return {
        valid: false,
        blockedReason: `Diff header path mismatch: --- a/${oldHeaderPath} vs +++ b/${newHeaderPath}`
      };
    }
    rawTarget = normNew;
  }

  // 7. Validate target path safety
  const targetPath = normalizeArtifactPath(rawTarget);
  if (!targetPath) {
    return {
      valid: false,
      blockedReason: `Patch target path is invalid or outside workspace: ${rawTarget}`
    };
  }

  // 8. Secret check
  const lower = trimmed.toLowerCase();
  const secrets = [".env", ".pem", ".key", "password", "token", "credential"];
  if (secrets.some((s) => lower.includes(s) && !targetPath.toLowerCase().includes(s))) {
    return {
      valid: false,
      targetPath,
      blockedReason: "Patch contains potential secret content"
    };
  }

  return {
    valid: true,
    targetPath,
    operation,
    oldHeaderPath,
    newHeaderPath,
    cleanDiff: trimmed,
    hunkCount: hunks.length
  };
}

export function extractPatchArtifactTargetPath(artifact?: GeneratedArtifact): string | null {
  if (!artifact) return null;
  if (!isPatchArtifact(artifact)) return null;
  const parsed = parsePatchArtifact(artifact);
  return parsed.valid && parsed.targetPath ? parsed.targetPath : null;
}

function extractAddedLinesFromHunks(diffContent: string): string[] {
  const parsed = parseUnifiedDiffHunks(diffContent);
  const lines: string[] = [];
  for (const hunk of parsed.hunks) {
    for (const rawLine of hunk.lines) {
      if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
        lines.push(rawLine.slice(1));
      }
    }
  }
  return lines;
}

function areDiffsEquivalent(diff1: string, diff2: string): boolean {
  if (diff1.trim() === diff2.trim()) return true;
  const norm1 = diff1.replace(/\r\n/g, "\n").replace(/^diff --git .*\n/m, "").trim();
  const norm2 = diff2.replace(/\r\n/g, "\n").replace(/^diff --git .*\n/m, "").trim();
  return norm1 === norm2;
}

function buildGeneratedArtifactPatch(input: {
  sessionId: string;
  workspacePath: string;
  nodeId: string;
  artifact: GeneratedArtifact;
  allowedPaths: string[];
  forbiddenPaths: string[];
  existingContent?: string;
  fileContents?: Record<string, string>;
}): GeneratedArtifactPatchResult {
  const diagnostics: string[] = [];
  const content = input.artifact.content;
  if (!content || !content.trim()) {
    return {
      needsGenerationReason: `Generated artifact ${input.artifact.path} has empty content`,
      diagnostics: [`Generated artifact needs generation: ${input.artifact.path} empty content`]
    };
  }
  if (Buffer.byteLength(content, "utf8") > 1_000_000) {
    return {
      needsGenerationReason: `Generated artifact ${input.artifact.path} is too large to propose safely`,
      diagnostics: [`Generated artifact needs generation: ${input.artifact.path} too large`]
    };
  }

  // ── Patch artifact handling ──────────────────────────────────
  if (isPatchArtifact(input.artifact)) {
    const parsed = parsePatchArtifact(input.artifact);
    if (!parsed.valid || !parsed.targetPath) {
      return {
        blockedReason: parsed.blockedReason ?? "Malformed patch artifact",
        diagnostics: [`Patch artifact blocked: ${parsed.blockedReason ?? "malformed patch artifact"}`],
        targetPath: parsed.targetPath
      };
    }

    const targetPath = parsed.targetPath;
    const isGenericPatchFile = input.artifact.path.toLowerCase().endsWith(".diff") || input.artifact.path.toLowerCase().endsWith(".patch");
    if (!isGenericPatchFile) {
      const explicitTarget = normalizeArtifactPath(input.artifact.path);
      if (explicitTarget && explicitTarget !== targetPath) {
        return {
          blockedReason: `Diff header path ${parsed.oldHeaderPath ?? targetPath} does not match target file ${explicitTarget}`,
          diagnostics: [`Patch artifact blocked: diff header does not match target file ${explicitTarget}`],
          targetPath: explicitTarget,
          isExisting: true
        };
      }
    }
    if (!isGeneratedPathAllowed(targetPath, input.allowedPaths)) {
      return {
        blockedReason: `Patch target path is not in allowed paths: ${targetPath}`,
        diagnostics: [`Patch artifact blocked: ${targetPath} not allowed`],
        targetPath
      };
    }
    if (isGeneratedPathForbidden(targetPath, input.forbiddenPaths) || isGeneratedSecretPath(targetPath)) {
      return {
        blockedReason: `Patch target path is forbidden or sensitive: ${targetPath}`,
        diagnostics: [`Patch artifact blocked: ${targetPath} forbidden/sensitive`],
        targetPath
      };
    }
    const workspaceRoot = path.resolve(input.workspacePath || ".");
    const resolvedTarget = path.resolve(workspaceRoot, targetPath);
    if (resolvedTarget !== workspaceRoot && !resolvedTarget.startsWith(`${workspaceRoot}${path.sep}`)) {
      return {
        blockedReason: `Patch target escapes workspace: ${targetPath}`,
        diagnostics: [`Patch artifact blocked: ${targetPath} escapes workspace`],
        targetPath
      };
    }

    if (parsed.operation === "create") {
      const fileExistsOnDisk = existsSync(resolvedTarget);
      const fileInContents = input.fileContents?.[targetPath];
      if (fileExistsOnDisk || (fileInContents && fileInContents.trim().length > 0)) {
        return {
          blockedReason: `Patch attempts to create ${targetPath} from /dev/null, but file already exists`,
          diagnostics: [`Patch artifact blocked: ${targetPath} already exists for create patch`],
          targetPath
        };
      }
      const lines = extractAddedLinesFromHunks(parsed.cleanDiff ?? content);
      const unifiedDiff = [
        `diff --git a/${targetPath} b/${targetPath}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${targetPath}`,
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((l) => `+${l}`)
      ].join("\n") + "\n";
      const now = new Date().toISOString();
      const proposal: PatchProposal = {
        id: `rs_artifact_${randomUUID().slice(0, 8)}`,
        sessionId: input.sessionId,
        title: `create ${targetPath}`,
        summary: `Generated patch artifact from recursive swarm node ${input.nodeId} creating ${targetPath}: ${input.artifact.description.slice(0, 220)}`,
        riskLevel: input.artifact.confidence >= 0.75 ? "medium" : "high",
        filesChanged: [{
          path: targetPath,
          changeType: "create",
          explanation: input.artifact.description.slice(0, 220)
        }],
        artifacts: [
          { path: targetPath, content: lines.join("\n") },
          { path: "_generated_artifact_node", content: input.nodeId },
          { path: "_generated_artifact_source_path", content: input.artifact.path },
          { path: "_generated_artifact_validation", content: input.artifact.validation_steps.join("\n") },
          { path: "_generated_artifact_notes", content: input.artifact.completeness_notes.join("\n") }
        ],
        unifiedDiff,
        requiresApproval: true,
        status: "proposed",
        createdAt: now
      };
      diagnostics.push(`Generated patch artifact proposed creating ${targetPath}`);
      return { proposal, diagnostics, targetPath, isExisting: false };
    }

    if (parsed.operation === "delete") {
      const fileExistsOnDisk = existsSync(resolvedTarget);
      const fileInContents = input.fileContents?.[targetPath];
      if (!fileExistsOnDisk && !fileInContents) {
        return {
          blockedReason: `Patch attempts to delete ${targetPath}, but file does not exist`,
          diagnostics: [`Patch artifact blocked: ${targetPath} does not exist for delete patch`],
          targetPath
        };
      }
      const existingFileContent = fileInContents ?? (fileExistsOnDisk ? readFileSync(resolvedTarget, "utf8") : "");
      const lines = existingFileContent.split(/\r?\n/);
      const unifiedDiff = [
        `diff --git a/${targetPath} b/${targetPath}`,
        "deleted file mode 100644",
        `--- a/${targetPath}`,
        "+++ /dev/null",
        `@@ -1,${lines.length} +0,0 @@`,
        ...lines.map((l) => `-${l}`)
      ].join("\n") + "\n";
      const now = new Date().toISOString();
      const proposal: PatchProposal = {
        id: `rs_artifact_${randomUUID().slice(0, 8)}`,
        sessionId: input.sessionId,
        title: `delete ${targetPath}`,
        summary: `Generated patch artifact from recursive swarm node ${input.nodeId} deleting ${targetPath}: ${input.artifact.description.slice(0, 220)}`,
        riskLevel: "high",
        filesChanged: [{
          path: targetPath,
          changeType: "delete",
          explanation: input.artifact.description.slice(0, 220)
        }],
        artifacts: [
          { path: targetPath, content: "" },
          { path: "_generated_artifact_node", content: input.nodeId },
          { path: "_generated_artifact_source_path", content: input.artifact.path }
        ],
        unifiedDiff,
        requiresApproval: true,
        status: "proposed",
        createdAt: now
      };
      diagnostics.push(`Generated patch artifact proposed deleting ${targetPath}`);
      return { proposal, diagnostics, targetPath, isExisting: true };
    }

    // Default: parsed.operation === "modify"
    let existingFileContent = input.fileContents?.[targetPath] ?? (targetPath === input.artifact.path ? input.existingContent : undefined);
    const fileExistsOnDisk = existsSync(resolvedTarget);

    if (existingFileContent === undefined && fileExistsOnDisk) {
      try {
        existingFileContent = readFileSync(resolvedTarget, "utf8");
      } catch {
        return {
          blockedReason: `Failed to read existing file: ${targetPath}`,
          diagnostics: [`Generated patch artifact blocked: could not read ${targetPath}`],
          targetPath,
          isExisting: true
        };
      }
    }

    if (existingFileContent === undefined) {
      return {
        blockedReason: `Target file does not exist for patch: ${targetPath}`,
        diagnostics: [`Generated patch artifact blocked: target file ${targetPath} not found`],
        targetPath,
        isExisting: true
      };
    }

    const normResult = tryNormalizeExistingFilePatch(targetPath, existingFileContent, parsed.cleanDiff ?? content);
    if (!normResult.valid || !normResult.normalizedDiff) {
      return {
        blockedReason: `Patch artifact failed to apply to ${targetPath}: ${normResult.reason ?? "malformed diff"}`,
        diagnostics: [`Patch artifact blocked: ${targetPath} patch invalid (${normResult.reason ?? "malformed diff"})`],
        targetPath,
        isExisting: true
      };
    }

    const now = new Date().toISOString();
    const proposal: PatchProposal = {
      id: `rs_artifact_${randomUUID().slice(0, 8)}`,
      sessionId: input.sessionId,
      title: `modify ${targetPath}`,
      summary: `Generated artifact patch from recursive swarm node ${input.nodeId}: ${input.artifact.description.slice(0, 220)}`,
      riskLevel: input.artifact.confidence >= 0.75 ? "medium" : "high",
      filesChanged: [{
        path: targetPath,
        changeType: "modify",
        explanation: input.artifact.description.slice(0, 220)
      }],
      artifacts: [
        { path: targetPath, content: normResult.normalizedDiff },
        { path: "_generated_artifact_node", content: input.nodeId },
        { path: "_generated_artifact_source_path", content: input.artifact.path },
        { path: "_generated_artifact_validation", content: input.artifact.validation_steps.join("\n") },
        { path: "_generated_artifact_notes", content: input.artifact.completeness_notes.join("\n") }
      ],
      unifiedDiff: normResult.normalizedDiff,
      requiresApproval: true,
      status: "proposed",
      createdAt: now
    };
    diagnostics.push(`Generated artifact patch proposed for existing file ${targetPath}`);
    return { proposal, diagnostics, targetPath, isExisting: true };
  }

  // ── Normal generated file handling (preserves original behavior) ──
  const targetPath = normalizeArtifactPath(input.artifact.path);
  if (!targetPath) {
    return { blockedReason: `Generated artifact path is unsafe: ${input.artifact.path}`, diagnostics: ["Generated artifact blocked: unsafe path"] };
  }
  if (!isGeneratedPathAllowed(targetPath, input.allowedPaths)) {
    return { blockedReason: `Generated artifact path is not in allowed paths: ${targetPath}`, diagnostics: [`Generated artifact blocked: ${targetPath} not allowed`] };
  }
  if (isGeneratedPathForbidden(targetPath, input.forbiddenPaths) || isGeneratedSecretPath(targetPath)) {
    return { blockedReason: `Generated artifact path is forbidden or sensitive: ${targetPath}`, diagnostics: [`Generated artifact blocked: ${targetPath} forbidden/sensitive`] };
  }
  const workspaceRoot = path.resolve(input.workspacePath || ".");
  const resolvedTarget = path.resolve(workspaceRoot, targetPath);
  if (resolvedTarget !== workspaceRoot && !resolvedTarget.startsWith(`${workspaceRoot}${path.sep}`)) {
    return { blockedReason: `Generated artifact escapes workspace: ${targetPath}`, diagnostics: [`Generated artifact blocked: ${targetPath} escapes workspace`] };
  }

  const knownExistingContent = input.existingContent ?? input.fileContents?.[targetPath] ?? "";
  const fileExistsOnDisk = existsSync(resolvedTarget);
  const isExisting = knownExistingContent.trim().length > 0 || fileExistsOnDisk;

  if (isExisting) {
    let existingFileContent = input.existingContent ?? input.fileContents?.[targetPath];
    if (!existingFileContent?.trim() && fileExistsOnDisk) {
      try {
        existingFileContent = readFileSync(resolvedTarget, "utf8");
      } catch {
        return {
          blockedReason: `Failed to read existing file: ${targetPath}`,
          diagnostics: [`Generated artifact blocked: could not read ${targetPath}`],
          isExisting: true
        };
      }
    }

    const normResult = tryNormalizeExistingFilePatch(targetPath, existingFileContent ?? "", content);
    if (!normResult.valid || !normResult.normalizedDiff) {
      return {
        blockedReason: `Generated artifact is not a valid existing-file patch: ${normResult.reason ?? "malformed diff"}`,
        diagnostics: [`Generated artifact blocked: ${targetPath} existing file patch invalid (${normResult.reason ?? "malformed diff"})`],
        isExisting: true
      };
    }

    const now = new Date().toISOString();
    const proposal: PatchProposal = {
      id: `rs_artifact_${randomUUID().slice(0, 8)}`,
      sessionId: input.sessionId,
      title: `modify ${targetPath}`,
      summary: `Generated artifact patch from recursive swarm node ${input.nodeId}: ${input.artifact.description.slice(0, 220)}`,
      riskLevel: input.artifact.confidence >= 0.75 ? "medium" : "high",
      filesChanged: [{
        path: targetPath,
        changeType: "modify",
        explanation: input.artifact.description.slice(0, 220)
      }],
      artifacts: [
        { path: targetPath, content: normResult.normalizedDiff },
        { path: "_generated_artifact_node", content: input.nodeId },
        { path: "_generated_artifact_validation", content: input.artifact.validation_steps.join("\n") },
        { path: "_generated_artifact_notes", content: input.artifact.completeness_notes.join("\n") }
      ],
      unifiedDiff: normResult.normalizedDiff,
      requiresApproval: true,
      status: "proposed",
      createdAt: now
    };
    diagnostics.push(`Generated artifact patch proposed for existing file ${targetPath}`);
    return { proposal, diagnostics, isExisting: true };
  }

  // Genuinely new file
  const lines = content.split("\n");
  const unifiedDiff = [
    `diff --git a/${targetPath} b/${targetPath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${targetPath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`)
  ].join("\n") + "\n";
  const now = new Date().toISOString();
  const proposal: PatchProposal = {
    id: `rs_artifact_${randomUUID().slice(0, 8)}`,
    sessionId: input.sessionId,
    title: `create ${targetPath}`,
    summary: `Generated artifact from recursive swarm node ${input.nodeId}: ${input.artifact.description.slice(0, 220)}`,
    riskLevel: input.artifact.confidence >= 0.75 ? "medium" : "high",
    filesChanged: [{
      path: targetPath,
      changeType: "create",
      explanation: input.artifact.description.slice(0, 220)
    }],
    artifacts: [
      { path: targetPath, content },
      { path: "_generated_artifact_node", content: input.nodeId },
      { path: "_generated_artifact_validation", content: input.artifact.validation_steps.join("\n") },
      { path: "_generated_artifact_notes", content: input.artifact.completeness_notes.join("\n") }
    ],
    unifiedDiff,
    requiresApproval: true,
    status: "proposed",
    createdAt: now
  };
  diagnostics.push(`Generated artifact patch proposed for ${targetPath} (${content.length} character(s), ${lines.length} line(s))`);
  return { proposal, diagnostics, isExisting: false };
}

function generatedArtifactToIntent(
  artifact: GeneratedArtifact,
  operation: "create" | "modify" = "create",
  targetFile?: string
): EditIntent {
  return {
    kind: "edit_intent",
    target_file: targetFile ?? normalizeArtifactPath(artifact.path) ?? artifact.path,
    target_symbol_or_range: operation === "modify" ? "patch" : "full file",
    operation,
    reason: artifact.description,
    expected_behavior: artifact.completeness_notes.join("; "),
    risk: artifact.confidence >= 0.75 ? "medium" : "high",
    evidence_refs: []
  };
}

function normalizeArtifactPath(value: string): string | null {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || path.isAbsolute(normalized) || normalized.startsWith("/") || normalized.split("/").includes("..")) return null;
  return normalized;
}

function isGeneratedPathAllowed(filePath: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  return allowed.some((prefix) => filePath.startsWith(prefix));
}

function isGeneratedPathForbidden(filePath: string, forbidden: string[]): boolean {
  return forbidden.some((prefix) => filePath.startsWith(prefix));
}

function isGeneratedSecretPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return [".env", ".pem", ".key", ".cert", "credentials", "secrets/", "node_modules/"]
    .some((secret) => lower.includes(secret));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isExplicitlyRequestedDeliverable(
  filePath: string,
  originalGoal?: string,
  deliverableContract?: string
): boolean {
  if (!originalGoal && !deliverableContract) return false;
  const combined = `${originalGoal ?? ""} ${deliverableContract ?? ""}`.toLowerCase();
  const normalized = filePath.toLowerCase().replace(/^[./\\]+/, "");
  const baseName = path.basename(filePath).toLowerCase();

  const creationPattern = new RegExp(
    `\\b(create|write|generate|add|save|output|produce|deliverable|file|in)\\s+[^\\n.,;]*?\\b${escapeRegex(baseName)}\\b`,
    "i"
  );
  if (creationPattern.test(combined)) {
    return true;
  }

  if (normalized.includes("/") && combined.includes(normalized)) {
    return true;
  }

  const fileWithExtPattern = new RegExp(`\\b${escapeRegex(baseName)}\\b`, "i");
  if (baseName.includes(".") && fileWithExtPattern.test(combined)) {
    return true;
  }

  return false;
}

export function isAuxiliaryReportArtifact(
  artifact: GeneratedArtifact,
  context: {
    isImplementation: boolean;
    originalGoal?: string;
    deliverableContract?: string;
    workspacePath?: string;
  }
): boolean {
  if (!artifact) return false;

  if (isPatchArtifact(artifact)) {
    return false;
  }

  const normPath = normalizeArtifactPath(artifact.path);
  if (normPath && context.workspacePath) {
    const resolved = path.resolve(context.workspacePath, normPath);
    if (existsSync(resolved)) {
      return false;
    }
  }

  if (isExplicitlyRequestedDeliverable(artifact.path, context.originalGoal, context.deliverableContract)) {
    return false;
  }

  if (!context.isImplementation) {
    return true;
  }

  const baseName = path.basename(artifact.path || "").toLowerCase();
  const isDiagnosticName =
    /\b(root[-_]?cause|failing[-_]?test|failure[-_]?(source|info|details)?|test[-_]?(output|result|results|run)|modification[-_]?applied|modifications[-_]?applied|change[-_]?(summary|list|details)?|changes[-_]?made|applied[-_]?change|diagnosis|diagnostic|diagnostics|investigation|debug[-_]?info|source[-_]?path|explanation|reasoning)\b/i.test(
      baseName
    );
  if (isDiagnosticName) {
    return true;
  }

  const desc = (artifact.description || "").toLowerCase();
  const isDiagnosticDesc =
    /\b(root cause|failing test|test output|diagnostic|stack trace|failure info|diff applied|modification applied|change summary|source path)\b/i.test(
      desc
    );
  if (isDiagnosticDesc) {
    return true;
  }

  const ext = path.extname(baseName).toLowerCase();
  if (ext === ".md" || ext === ".txt" || ext === ".json" || ext === ".log") {
    return true;
  }

  return false;
}

export function isActionableImplementationProposal(
  proposal: PatchProposal,
  context?: {
    isImplementation: boolean;
    originalGoal?: string;
    deliverableContract?: string;
  }
): boolean {
  if (!proposal) return false;
  if (!context?.isImplementation) return true;

  const hasModifyOrDelete = proposal.filesChanged.some(
    (f) => f.changeType === "modify" || f.changeType === "delete"
  );
  if (hasModifyOrDelete) return true;

  const createdFiles = proposal.filesChanged.filter((f) => f.changeType === "create");
  if (createdFiles.length === 0) return false;

  const allAuxiliary = createdFiles.every((f) => {
    if (isExplicitlyRequestedDeliverable(f.path, context.originalGoal, context.deliverableContract)) {
      return false;
    }
    const base = path.basename(f.path).toLowerCase();
    const isAuxName =
      /\b(root[-_]?cause|failing[-_]?test|failure[-_]?(source|info|details)?|test[-_]?(output|result|results|run)|modification[-_]?applied|modifications[-_]?applied|change[-_]?(summary|list|details)?|changes[-_]?made|applied[-_]?change|diagnosis|diagnostic|diagnostics|investigation|debug[-_]?info|source[-_]?path|explanation|reasoning)\b/i.test(
        base
      );
    if (isAuxName) return true;
    const ext = path.extname(base);
    if (ext === ".md" || ext === ".txt" || ext === ".json" || ext === ".log") return true;
    return false;
  });

  return !allAuxiliary;
}

export type PatchReadinessStatus = "patch_ready" | "needs_generation" | "blocked" | "not_implementation";

export type PatchReadinessAssessment = {
  status: PatchReadinessStatus;
  isPatchReady: boolean;
  isCandidate: boolean;
  reason?: string;
  missingRequirement?: string;
  targetFile?: string;
};

function makeAssessment(raw: {
  status: PatchReadinessStatus;
  isPatchReady: boolean;
  reason?: string;
  missingRequirement?: string;
  targetFile?: string;
}): PatchReadinessAssessment {
  return {
    ...raw,
    isCandidate: raw.status !== "not_implementation"
  };
}

export function isCandidateImplementationOutput(
  output?: RecursiveNodeOutput,
  context?: {
    originalGoal?: string;
    deliverableContract?: string;
    workspacePath?: string;
  }
): boolean {
  if (!output) return false;
  if (output.kind === "edit_intent") {
    return true;
  }
  if (output.kind === "final_summary") {
    return Array.isArray(output.edit_intents) && output.edit_intents.length > 0;
  }
  if (output.kind === "generated_artifact") {
    return !isAuxiliaryReportArtifact(output as GeneratedArtifact, {
      isImplementation: true,
      originalGoal: context?.originalGoal,
      deliverableContract: context?.deliverableContract,
      workspacePath: context?.workspacePath
    });
  }
  return false;
}

export function assessImplementationPatchReadiness(
  output?: RecursiveNodeOutput,
  context?: {
    originalGoal?: string;
    deliverableContract?: string;
    workspacePath?: string;
    fileContents?: Record<string, string>;
    allowedPaths?: string[];
    forbiddenPaths?: string[];
    builderOverrides?: Record<string, Pick<SurgicalPatchInput, "exactOldText" | "replacementText" | "anchorLine" | "insertAfterAnchor" | "insertBeforeAnchor">>;
  }
): PatchReadinessAssessment {
  if (!output) {
    return makeAssessment({
      status: "not_implementation",
      isPatchReady: false,
      reason: "No output produced"
    });
  }

  if (
    output.kind === "evidence_report" ||
    output.kind === "task_plan" ||
    output.kind === "validation_plan" ||
    output.kind === "review_decision" ||
    output.kind === "integration_summary"
  ) {
    return makeAssessment({
      status: "not_implementation",
      isPatchReady: false,
      reason: `Output of kind '${output.kind}' is diagnostic/planning evidence, not an implementation deliverable`
    });
  }

  if (output.kind === "final_summary") {
    if (!Array.isArray(output.edit_intents) || output.edit_intents.length === 0) {
      return makeAssessment({
        status: "not_implementation",
        isPatchReady: false,
        reason: "Final summary contains no edit intents"
      });
    }
    for (const intent of output.edit_intents) {
      const sub = assessImplementationPatchReadiness(intent, context);
      if (sub.isPatchReady) return sub;
    }
    return makeAssessment({
      status: "needs_generation",
      isPatchReady: false,
      reason: "Final summary edit intents lack concrete patch specifications",
      missingRequirement: "At least one edit_intent must specify concrete code changes or a valid unified diff"
    });
  }

  if (output.kind === "generated_artifact") {
    const artifact = output as GeneratedArtifact;
    if (isAuxiliaryReportArtifact(artifact, {
      isImplementation: true,
      originalGoal: context?.originalGoal,
      deliverableContract: context?.deliverableContract,
      workspacePath: context?.workspacePath
    })) {
      return makeAssessment({
        status: "not_implementation",
        isPatchReady: false,
        reason: `Artifact ${artifact.path} is an auxiliary report/diagnostic file, not an implementation deliverable`
      });
    }

    if (isPatchArtifact(artifact)) {
      const parsed = parsePatchArtifact(artifact);
      if (!parsed.valid || !parsed.targetPath) {
        return makeAssessment({
          status: "blocked",
          isPatchReady: false,
          reason: parsed.blockedReason || "Malformed unified diff in patch artifact",
          missingRequirement: `The supplied patch artifact contains an invalid or malformed unified diff (${parsed.blockedReason ?? "missing headers or hunks"}). Return a valid unified diff with --- a/<path>, +++ b/<path>, and @@ context hunks.`
        });
      }

      if (parsed.operation === "modify") {
        const fileContent = context?.fileContents?.[parsed.targetPath];
        if (fileContent !== undefined) {
          const normResult = tryNormalizeExistingFilePatch(parsed.targetPath, fileContent, parsed.cleanDiff ?? artifact.content);
          if (!normResult.valid) {
            return makeAssessment({
              status: "needs_generation",
              isPatchReady: false,
              reason: normResult.reason || "Patch hunks failed to match target file content",
              missingRequirement: `Patch failed to apply to ${parsed.targetPath}: ${normResult.reason}. Return a patch with accurate context lines matching the target file.`
            });
          }
        }
      }

      return makeAssessment({
        status: "patch_ready",
        isPatchReady: true,
        targetFile: parsed.targetPath
      });
    }

    const targetPath = normalizeArtifactPath(artifact.path);
    if (!targetPath) {
      return makeAssessment({
        status: "blocked",
        isPatchReady: false,
        reason: `Generated artifact path is invalid: ${artifact.path}`
      });
    }

    const existingContent = context?.fileContents?.[targetPath];
    if (existingContent && existingContent.trim().length > 0) {
      const normResult = tryNormalizeExistingFilePatch(targetPath, existingContent, artifact.content);
      if (!normResult.valid) {
        return makeAssessment({
          status: "needs_generation",
          isPatchReady: false,
          reason: `Generated artifact targeting existing file ${targetPath} is not a valid patch: ${normResult.reason}`,
          missingRequirement: `Existing file ${targetPath} requires a unified diff patch or concrete replacement, not pseudo-patch or full-file text.`
        });
      }
    }

    return makeAssessment({
      status: "patch_ready",
      isPatchReady: true,
      targetFile: targetPath
    });
  }

  if (output.kind === "edit_intent") {
    const intent = output as EditIntent;
    const targetFile = intent.target_file;
    if (!targetFile || targetFile === "unknown" || targetFile.trim() === "") {
      return makeAssessment({
        status: "needs_generation",
        isPatchReady: false,
        reason: "Edit intent missing target_file",
        missingRequirement: "The edit intent must specify a valid target_file within the workspace."
      });
    }

    if (intent.operation === "delete") {
      return makeAssessment({
        status: "patch_ready",
        isPatchReady: true,
        targetFile
      });
    }

    const overrides = context?.builderOverrides?.[targetFile];
    const anyIntent = intent as Record<string, unknown>;
    const hasInlineText = typeof anyIntent.replacement_text === "string" && (anyIntent.replacement_text as string).length > 0;
    const hasOverrides = overrides && ((overrides.exactOldText && overrides.replacementText !== undefined) || (overrides.anchorLine && overrides.replacementText !== undefined));
    const hasDiff = typeof anyIntent.unified_diff === "string" && (anyIntent.unified_diff as string).includes("@@");

    if (intent.operation === "create") {
      if (overrides?.replacementText !== undefined || hasInlineText) {
        return makeAssessment({
          status: "patch_ready",
          isPatchReady: true,
          targetFile
        });
      }
      return makeAssessment({
        status: "needs_generation",
        isPatchReady: false,
        reason: "Create edit intent missing file content",
        missingRequirement: "Create operation requires concrete file content or replacement text."
      });
    }

    if (hasOverrides || (typeof anyIntent.exact_old_text === "string" && hasInlineText) || hasDiff) {
      return makeAssessment({
        status: "patch_ready",
        isPatchReady: true,
        targetFile
      });
    }

    return makeAssessment({
      status: "needs_generation",
      isPatchReady: false,
      reason: `Edit intent for ${targetFile} identifies a target (${intent.target_symbol_or_range || "unspecified symbol"}) but contains no usable concrete edit specification`,
      missingRequirement: `Your IMPLEMENT contract requires a concrete patch proposal. The supplied edit intent identifies target '${targetFile}' (${intent.operation}) but contains no usable edit specification (missing exact old text and replacement text, or unified diff). Return one valid structured implementation output with a concrete unified diff or replacement text.`
    });
  }

  return makeAssessment({
    status: "not_implementation",
    isPatchReady: false,
    reason: "Unrecognized output kind"
  });
}

export function isPatchReadyImplementationOutput(
  output?: RecursiveNodeOutput,
  context?: {
    originalGoal?: string;
    deliverableContract?: string;
    workspacePath?: string;
    fileContents?: Record<string, string>;
    allowedPaths?: string[];
    forbiddenPaths?: string[];
    builderOverrides?: Record<string, Pick<SurgicalPatchInput, "exactOldText" | "replacementText" | "anchorLine" | "insertAfterAnchor" | "insertBeforeAnchor">>;
  }
): boolean {
  return assessImplementationPatchReadiness(output, context).isPatchReady;
}

export function isActionableImplementationOutput(
  output?: RecursiveNodeOutput,
  context?: {
    originalGoal?: string;
    deliverableContract?: string;
    workspacePath?: string;
    fileContents?: Record<string, string>;
    allowedPaths?: string[];
    forbiddenPaths?: string[];
    builderOverrides?: Record<string, Pick<SurgicalPatchInput, "exactOldText" | "replacementText" | "anchorLine" | "insertAfterAnchor" | "insertBeforeAnchor">>;
    requirePatchReady?: boolean;
  }
): boolean {
  if (!output) return false;
  if (context?.requirePatchReady === true) {
    return assessImplementationPatchReadiness(output, context).isPatchReady;
  }
  if (context && (context.workspacePath !== undefined || context.fileContents !== undefined || context.builderOverrides !== undefined)) {
    return assessImplementationPatchReadiness(output, context).isPatchReady;
  }
  return isCandidateImplementationOutput(output, context);
}

// ── Main bridge ─────────────────────────────────────────────

export function bridgeEditIntents(input: BridgeInput): BridgeResult {
  const { sessionId, workspacePath, intents, generatedArtifacts = [], validationPlans, allowedPaths, forbiddenPaths, fileContents, builderOverrides, evidencePacks } = input;

  const patchCandidates: PatchProposal[] = [];
  const auxiliaryArtifacts: Array<{ nodeId: string; artifact: GeneratedArtifact; reason: string }> = [];
  const blockedIntents: BlockedEditIntent[] = [];
  const needsGenerationIntents: NeedsGenerationIntent[] = [];
  const diagnostics: string[] = [];
  const now = new Date().toISOString();

  // Quality/expansion metrics
  const metricAllMissingFields = new Map<string, number>();
  let metricReadyFirstPass = 0;
  let metricExpandedOk = 0;
  let metricExpandedFail = 0;
  let metricBlockedByQuality = 0;
  let metricBlockedByBuilder = 0;

  // Group intents by target file for conflict detection
  const fileIntentMap = new Map<string, BridgeEditIntent[]>();
  for (const item of intents) {
    const existing = fileIntentMap.get(item.intent.target_file) ?? [];
    existing.push(item);
    fileIntentMap.set(item.intent.target_file, existing);
  }

  // Detect same-file conflicts
  for (const [file, items] of fileIntentMap) {
    if (items.length > 1) {
      const ops = items.map((i) => i.intent.operation).join(", ");
      diagnostics.push(`Conflict detected on ${file}: ${items.length} intents (${ops}) — processing separately`);
    }
  }

  // Process each intent through quality gate → (optional expansion) → patch builder
  for (const [, items] of fileIntentMap) {
    for (const item of items) {
      let currentIntent = { ...item.intent };
      let currentOverrides = copyOverrides(builderOverrides, currentIntent.target_file);
      const anyIntent = currentIntent as Record<string, unknown>;
      if (!currentOverrides && typeof anyIntent.exact_old_text === "string" && typeof anyIntent.replacement_text === "string") {
        currentOverrides = {
          exactOldText: anyIntent.exact_old_text as string,
          replacementText: anyIntent.replacement_text as string,
          anchorLine: undefined,
          insertAfterAnchor: undefined,
          insertBeforeAnchor: undefined
        };
      }
      const nodeId = item.nodeId;
      const evidencePack = evidencePacks?.[nodeId];
      const contextSource = evidencePack?.context_source;

      let expansionAttempts = 0;
      let finalResult: "proposal" | "needs_generation" | "blocked" | null = null;

      while (finalResult === null && expansionAttempts <= MAX_EXPANSION_ATTEMPTS) {
        // Quality gate
        const qualityResult = evaluateEditIntentQuality({
          editIntent: currentIntent,
          evidencePack,
          allowedPaths,
          forbiddenPaths,
          builderOverrides: currentOverrides,
          contextSource
        });
        diagnostics.push(...qualityResult.diagnostics);
        for (const f of qualityResult.missingFields) {
          metricAllMissingFields.set(f, (metricAllMissingFields.get(f) ?? 0) + 1);
        }

        switch (qualityResult.status) {
          case "ready_for_patch": {
            if (expansionAttempts === 0) metricReadyFirstPass++;
            // Run SurgicalPatchBuilder
            const currentFileContent = fileContents?.[currentIntent.target_file] ?? "";
            const builderInput: SurgicalPatchInput = {
              editIntent: currentIntent,
              evidencePack,
              workspacePath,
              currentFileContent,
              allowedPaths,
              forbiddenPaths,
              exactOldText: currentOverrides?.exactOldText,
              replacementText: currentOverrides?.replacementText,
              anchorLine: currentOverrides?.anchorLine,
              insertAfterAnchor: currentOverrides?.insertAfterAnchor,
              insertBeforeAnchor: currentOverrides?.insertBeforeAnchor
            };
            const buildResult = buildSurgicalPatch(builderInput);
            diagnostics.push(...buildResult.diagnostics);

            if (buildResult.status === "real_diff") {
              const proposal: PatchProposal = {
                id: buildResult.patchCandidateId,
                sessionId,
                title: `${currentIntent.operation} ${currentIntent.target_file}`,
                summary: buildResult.summary,
                riskLevel: mapRisk(buildResult.risk),
                filesChanged: [{
                  path: currentIntent.target_file,
                  changeType: mapChangeType(currentIntent.operation),
                  explanation: currentIntent.reason.slice(0, 200)
                }],
                artifacts: [
                  { path: "_edit_intent_id", content: currentIntent.target_file },
                  { path: "_evidence_refs", content: (buildResult.evidenceRefs ?? []).join(", ") },
                  { path: "_builder_summary", content: buildResult.summary }
                ],
                unifiedDiff: buildResult.unifiedDiff,
                requiresApproval: true,
                status: "proposed",
                createdAt: now
              };
              patchCandidates.push(proposal);
              finalResult = "proposal";
            } else if (buildResult.status === "blocked") {
              metricBlockedByBuilder++;
              blockedIntents.push({ nodeId, intent: currentIntent, reason: buildResult.reason });
              finalResult = "blocked";
            } else {
              // needs_patch_generation from builder
              needsGenerationIntents.push({
                nodeId,
                intent: currentIntent,
                reason: buildResult.reason,
                requiredEvidence: buildResult.requiredEvidence
              });
              finalResult = "needs_generation";
            }
            break;
          }

          case "blocked": {
            metricBlockedByQuality++;
            blockedIntents.push({ nodeId, intent: currentIntent, reason: qualityResult.diagnostics.join("; ") });
            finalResult = "blocked";
            break;
          }

          case "needs_user_or_planner_clarification": {
            needsGenerationIntents.push({
              nodeId,
              intent: currentIntent,
              reason: qualityResult.diagnostics.join("; "),
              requiredEvidence: qualityResult.requiredEvidence
            });
            finalResult = "needs_generation";
            break;
          }

          case "needs_evidence_expansion": {
            if (expansionAttempts >= MAX_EXPANSION_ATTEMPTS) {
              metricExpandedFail++;
              needsGenerationIntents.push({
                nodeId,
                intent: currentIntent,
                reason: `Evidence expansion exhausted (${MAX_EXPANSION_ATTEMPTS} attempt(s)): ${qualityResult.diagnostics.join("; ")}`,
                requiredEvidence: qualityResult.requiredEvidence
              });
              finalResult = "needs_generation";
              break;
            }
            expansionAttempts++;

            const expansionResult = expandEditIntent({
              editIntent: currentIntent,
              evidencePack,
              workspacePath,
              allowedPaths,
              forbiddenPaths,
              fileContents,
              existingOverrides: currentOverrides
            });
            diagnostics.push(...expansionResult.diagnostics);

            if (expansionResult.status === "expanded") {
              metricExpandedOk++;
              currentIntent = expansionResult.refinedEditIntent;
              currentOverrides = expansionResult.builderOverrides;
              // Loop to re-check quality gate
            } else if (expansionResult.status === "blocked") {
              metricBlockedByQuality++;
              blockedIntents.push({
                nodeId,
                intent: currentIntent,
                reason: expansionResult.diagnostics.join("; ")
              });
              finalResult = "blocked";
            } else {
              metricExpandedFail++;
              needsGenerationIntents.push({
                nodeId,
                intent: currentIntent,
                reason: `Evidence expansion not found: ${expansionResult.diagnostics.join("; ")}`,
                requiredEvidence: qualityResult.requiredEvidence
              });
              finalResult = "needs_generation";
            }
            break;
          }
        }
      }
    }
  }

  for (const item of generatedArtifacts) {
    if (isAuxiliaryReportArtifact(item.artifact, {
      isImplementation: input.isImplementation ?? true,
      originalGoal: input.originalGoal,
      deliverableContract: input.deliverableContract,
      workspacePath: input.workspacePath
    })) {
      diagnostics.push(`Excluded auxiliary report artifact ${item.artifact.path} from workspace patch candidates`);
      auxiliaryArtifacts.push({
        nodeId: item.nodeId,
        artifact: item.artifact,
        reason: "Auxiliary report/diagnostic artifact excluded from workspace patch proposals."
      });
      continue;
    }

    const result = buildGeneratedArtifactPatch({
      sessionId,
      workspacePath,
      nodeId: item.nodeId,
      artifact: item.artifact,
      allowedPaths,
      forbiddenPaths,
      existingContent: fileContents?.[item.artifact.path],
      fileContents
    });
    diagnostics.push(...result.diagnostics);
    const op: "create" | "modify" = result.isExisting ? "modify" : "create";
    const effectiveTarget = result.targetPath ?? normalizeArtifactPath(item.artifact.path) ?? item.artifact.path;

    if (result.proposal) {
      const targetFilePath = result.proposal.filesChanged[0]?.path ?? effectiveTarget;
      const existingCandidate = patchCandidates.find((p) =>
        p.filesChanged.some((f) => f.path === targetFilePath)
      );

      if (existingCandidate) {
        if (areDiffsEquivalent(existingCandidate.unifiedDiff, result.proposal.unifiedDiff)) {
          diagnostics.push(`Deduplicating identical patch proposal for ${targetFilePath} from node ${item.nodeId}`);
        } else {
          diagnostics.push(`Conflict detected for ${targetFilePath}: patch proposal from node ${item.nodeId} conflicts with existing candidate`);
          blockedIntents.push({
            nodeId: item.nodeId,
            intent: generatedArtifactToIntent(item.artifact, op, targetFilePath),
            reason: `Conflicting patch proposal for ${targetFilePath}: already has a differing patch candidate`
          });
        }
      } else {
        patchCandidates.push(result.proposal);
      }
    } else if (result.blockedReason) {
      blockedIntents.push({
        nodeId: item.nodeId,
        intent: generatedArtifactToIntent(item.artifact, op, effectiveTarget),
        reason: result.blockedReason
      });
    } else {
      needsGenerationIntents.push({
        nodeId: item.nodeId,
        intent: generatedArtifactToIntent(item.artifact, op, effectiveTarget),
        reason: result.needsGenerationReason ?? "Generated artifact could not be converted to a patch.",
        requiredEvidence: [effectiveTarget]
      });
    }
  }

  // Handle validation commands
  const validationCommandRequests: CommandRequest[] = [];
  for (const vp of validationPlans) {
    for (const cmd of vp.plan.commands) {
      const risk: CommandRisk = classifyCommandRisk(cmd, workspacePath);
      const cmdReq: CommandRequest = {
        id: `rs_valcmd_${randomUUID().slice(0, 8)}`,
        sessionId,
        command: cmd,
        cwd: workspacePath,
        risk,
        reason: `Validation command from recursive swarm node ${vp.nodeId}: ${vp.plan.smoke_checks.join("; ").slice(0, 200)}`,
        status: "requested",
        createdAt: now
      };
      validationCommandRequests.push(cmdReq);
    }
    if (vp.plan.blockers.length > 0) {
      diagnostics.push(`Node ${vp.nodeId} has ${vp.plan.blockers.length} blockers: ${vp.plan.blockers.join("; ")}`);
    }
  }

  const summaryCounts = {
    realDiff: patchCandidates.length,
    needsGeneration: needsGenerationIntents.length,
    blocked: blockedIntents.length
  };

  // Top missing fields (sorted by frequency)
  const topMissingFields = [...metricAllMissingFields.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([field]) => field);

  // Context source summary
  const contextCounts: Record<string, number> = {};
  for (const item of intents) {
    const pack = evidencePacks?.[item.nodeId];
    const cs = pack?.context_source ?? "unknown";
    contextCounts[cs] = (contextCounts[cs] ?? 0) + 1;
  }
  const contextSourceSummary = Object.entries(contextCounts)
    .map(([k, v]) => `${v}×${k}`)
    .join(", ") || "unknown";

  const qualityMetrics = {
    totalIntents: intents.length,
    readyOnFirstPass: metricReadyFirstPass,
    expandedSuccessfully: metricExpandedOk,
    expansionFailed: metricExpandedFail,
    blockedByQualityGate: metricBlockedByQuality,
    blockedByPatchBuilder: metricBlockedByBuilder,
    topMissingFields,
    contextSourceSummary
  };

  diagnostics.push(
    `Bridge result: ${summaryCounts.realDiff} real diff(s), ` +
    `${summaryCounts.needsGeneration} need(s) generation, ` +
    `${summaryCounts.blocked} blocked, ` +
    `${validationCommandRequests.length} validation command(s). ` +
    `Quality: ${metricReadyFirstPass} ready, ${metricExpandedOk} expanded, ${metricExpandedFail} expansion fail.`
  );

  return { patchCandidates, auxiliaryArtifacts, blockedIntents, needsGenerationIntents, diagnostics, validationCommandRequests, summaryCounts, qualityMetrics };
}

/** Scan all nodes in a RecursiveSwarmTree for EditIntent and ValidationPlan outputs. */
export function collectIntentsFromTree(
  nodes: Record<string, Pick<RecursiveSwarmNode, "id" | "structuredOutput">>
): {
  intents: BridgeEditIntent[];
  generatedArtifacts: BridgeGeneratedArtifact[];
  validationPlans: { nodeId: string; plan: ValidationPlan }[];
} {
  const intents: BridgeEditIntent[] = [];
  const generatedArtifacts: BridgeGeneratedArtifact[] = [];
  const validationPlans: { nodeId: string; plan: ValidationPlan }[] = [];

  for (const node of Object.values(nodes)) {
    if (!node.structuredOutput) continue;
    const output = node.structuredOutput;
    if (output.kind === "edit_intent") {
      intents.push({ nodeId: node.id, intent: output as EditIntent });
    } else if (output.kind === "generated_artifact") {
      generatedArtifacts.push({ nodeId: node.id, artifact: output as GeneratedArtifact });
    } else if (output.kind === "validation_plan") {
      validationPlans.push({ nodeId: node.id, plan: output as ValidationPlan });
    } else if (output.kind === "final_summary") {
      const fs = output;
      for (const ei of fs.edit_intents) {
        intents.push({ nodeId: node.id, intent: ei });
      }
      for (const vp of fs.validation_plans) {
        validationPlans.push({ nodeId: node.id, plan: vp });
      }
    }
  }

  return { intents, generatedArtifacts, validationPlans };
}
