import { randomUUID } from "node:crypto";
import type { LlmProvider } from "../llm/LlmProvider.js";
import { invokeReasoningProviderStructured } from "../runtime/ReasoningKernel.js";
import type {
  SplitResult,
  SplitSubTask,
  MemoryEvidencePack,
  RecursiveSwarmNode,
  RecursiveSwarmRunOptions,
  WorkerResponsibility
} from "./RecursiveSwarmModels.js";
import {
  DEFAULT_COMPLEXITY_THRESHOLD,
  classifyWorkerResponsibility,
  extractLocalTaskObjective,
  isImplementationGoal
} from "./RecursiveSwarmModels.js";

export type RecursiveTaskSplitterOptions = {
  provider?: LlmProvider;
  complexityThreshold?: number;
};

const SPLIT_SYSTEM_PROMPT = `You are a Recursive Swarm Task Decomposition Specialist.
Your job is to split a complex task into smaller, independent sub-tasks that can be executed in parallel or sequence.

Each sub-task should:
- Be small enough to be handled by a single agent
- Have a clear, unambiguous objective
- Specify its expected output as ONE single deliverable
- Declare an explicit responsibility: "INSPECT", "IMPLEMENT", "VERIFY", or "INTEGRATE"
- Declare dependencies on other sub-tasks (by index)
- For implementation tasks requiring verified source, declare sourceEvidenceRequirement with the prerequisite sub-task ID, workspace-relative source path (or the prerequisite artifact name that will specify it), and evidenceType "verified_workspace_source". Never write natural-language placeholders like "<to be filled>".
- Preserve the original user goal and deliverable contract
- Produce a concrete artifact, patch intent, validation result, review decision, evidence report, or merge decision

CRITICAL CONSTRAINTS:
- Single Deliverable Protocol: Each sub-task must produce exactly ONE structured deliverable. Never ask a single sub-task to produce multiple top-level artifacts (e.g., do NOT ask for both code_patch.diff and commit_message.txt).
- No Direct Mutation or Commit Authority: Sub-tasks only propose changes. Never ask sub-tasks or workers to directly apply patches, run git apply, or execute git commit. The approved runtime and Tauri/Rust pipeline owns all workspace mutation and Git commands.
- Diagnostic vs Implementation: A diagnostic/inspection child (e.g. running tests, investigating errors, gathering evidence) has responsibility "INSPECT" and must not be asked to return code patches. An implementation child has responsibility "IMPLEMENT" and must return a concrete code deliverable.

Do not split just to retrieve/search/check again unless that child has a concrete output.
Respond with JSON:
{
  "shouldSplit": boolean,
  "desiredChildCount": number,
  "splitReason": string,
  "subTasks": [{ "id": string, "title": string, "taskPrompt": string, "expectedOutput": string, "dependencies": string[], "sourceEvidenceRequirement"?: { "prerequisiteSubtaskId": string, "sourcePath": string, "evidenceType": "verified_workspace_source" }, "canWrite": boolean, "responsibility": "INSPECT" | "IMPLEMENT" | "VERIFY" | "INTEGRATE", "acceptanceCriteria": string[] }],
  "stopConditions": string[],
  "rationale": string
}`;

export class RecursiveTaskSplitter {
  private readonly provider?: LlmProvider;
  private readonly complexityThreshold: number;

  constructor(options: RecursiveTaskSplitterOptions = {}) {
    this.provider = options.provider;
    this.complexityThreshold = options.complexityThreshold ?? DEFAULT_COMPLEXITY_THRESHOLD;
  }

  async splitTask(node: RecursiveSwarmNode, runOptions: RecursiveSwarmRunOptions, opts?: { pack?: MemoryEvidencePack }): Promise<SplitResult> {
    if (!this.provider) {
      throw new Error("Recursive task splitting requires a configured provider; deterministic local decomposition is not a runtime fallback.");
    }
    return this.providerSplit(node, runOptions, opts?.pack);
  }

  private async providerSplit(node: RecursiveSwarmNode, runOptions: RecursiveSwarmRunOptions, pack?: MemoryEvidencePack): Promise<SplitResult> {
    if (!this.provider) throw new Error("Recursive task splitting provider is not configured.");
    const ctxBlock = this.formatPackForSplit(pack);
    try {
      const response = await invokeReasoningProviderStructured(
        this.provider,
        {
          purpose: "reason",
          reasoningStage: "reason",
          systemPrompt: SPLIT_SYSTEM_PROMPT + (ctxBlock ? `\n\n${ctxBlock}` : ""),
          userPrompt: `Split the following task into smaller, executable sub-tasks.

TASK: ${node.taskPrompt}
ORIGINAL GOAL: ${node.goalEnvelope.originalGoal}
EXPANDED GOAL: ${node.goalEnvelope.expandedGoal ?? node.goalEnvelope.originalGoal}
DELIVERABLE CONTRACT: ${node.goalEnvelope.expandedGoalSpec?.deliverableContract ?? "Not specified"}
RUN BUDGET:
- hardMaxAgents: ${runOptions.maxAgents}
- softMaxAgents: ${runOptions.softMaxAgents ?? "not provided"}
- maxChildrenPerParent: ${runOptions.maxChildrenPerParent ?? "not provided"}
- maxDepth: ${runOptions.maxDepth}

Each sub-task must include the original goal context so agents don't lose sight of the objective.
Use "dependencies" to reference other sub-tasks by their index (e.g., ["0"] means depends on first sub-task).
Leave dependencies empty [] for tasks that can run in parallel.
When a sourceEvidenceRequirement is present, provide stable "id" values for the referenced prerequisite and dependent sub-tasks; prerequisiteSubtaskId must match the prerequisite's id.
For single-file games or generated artifacts, include final assembly and validation tasks rather than many vague exploratory tasks.`,
          responseFormat: "json",
          maxOutputTokens: 4096
        },
        {
          name: "split_result",
          type: "object",
          additionalProperties: false,
          required: ["subTasks", "rationale"],
          properties: {
            shouldSplit: { type: "boolean" },
            desiredChildCount: { type: "number" },
            splitReason: { type: "string" },
            subTasks: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["title", "taskPrompt", "expectedOutput", "dependencies"],
                properties: {
                  id: { type: "string" },
                  title: { type: "string" },
                  taskPrompt: { type: "string" },
                  expectedOutput: { type: "string" },
                  dependencies: { type: "array", items: { type: "string" } },
                  sourceEvidenceRequirement: {
                    type: "object",
                    additionalProperties: false,
                    required: ["prerequisiteSubtaskId", "sourcePath", "evidenceType"],
                    properties: {
                      prerequisiteSubtaskId: { type: "string" },
                      sourcePath: { type: "string" },
                      evidenceType: { type: "string", enum: ["verified_workspace_source"] }
                    }
                  },
                  canWrite: { type: "boolean" },
                  responsibility: { type: "string", enum: ["INSPECT", "IMPLEMENT", "VERIFY", "INTEGRATE"] },
                  acceptanceCriteria: { type: "array", items: { type: "string" } }
                }
              }
            },
            stopConditions: { type: "array", items: { type: "string" } },
            rationale: { type: "string" }
          }
        }
      );

      const parsed = typeof response === "string"
        ? JSON.parse(response)
        : response;

      const rootRequiresImplementation = isImplementationGoal(node.goalEnvelope.originalGoal);

      const subTasks: SplitSubTask[] = (Array.isArray(parsed.subTasks) ? parsed.subTasks : []).map(
        (sub: Record<string, unknown>, index: number) => {
          const rawChildPrompt = String(sub.taskPrompt ?? sub.title ?? "");
          const title = String(sub.title ?? `Sub-task ${index + 1}`);
          const expectedOutput = String(sub.expectedOutput ?? "Completed work");
          const canWrite = sub.canWrite === true;
          const explicitResp = typeof sub.responsibility === "string" && ["INSPECT", "IMPLEMENT", "VERIFY", "INTEGRATE"].includes(sub.responsibility)
            ? (sub.responsibility as WorkerResponsibility)
            : undefined;

          const responsibility = classifyWorkerResponsibility({
            title,
            localObjective: extractLocalTaskObjective(rawChildPrompt, title),
            expectedOutput,
            canWrite,
            parentResponsibility: node.contract?.responsibility,
            isRootGoalImplementation: rootRequiresImplementation,
            explicitResponsibility: explicitResp
          });

          return {
            id: typeof sub.id === "string" && sub.id.length > 0
              ? sub.id
              : `subtask_${randomUUID().slice(0, 8)}`,
            title,
            taskPrompt: buildChildTaskPrompt({
              originalGoal: node.goalEnvelope.originalGoal,
              expandedGoal: node.goalEnvelope.expandedGoal ?? node.goalEnvelope.originalGoal,
              deliverableContract: node.goalEnvelope.expandedGoalSpec?.deliverableContract ?? "",
              parentTask: node.taskPrompt,
              childTask: rawChildPrompt,
              expectedOutput,
              acceptanceCriteria: Array.isArray(sub.acceptanceCriteria)
                ? sub.acceptanceCriteria.map((item: unknown) => String(item))
                : []
            }),
            expectedOutput,
            dependencies: Array.isArray(sub.dependencies)
              ? sub.dependencies.map((dep: unknown) => String(dep))
              : [],
            sourceEvidenceRequirement: isSourceEvidenceRequirement(sub.sourceEvidenceRequirement)
              ? sub.sourceEvidenceRequirement
              : undefined,
            canWrite: responsibility === "IMPLEMENT" ? true : canWrite,
            responsibility,
            acceptanceCriteria: Array.isArray(sub.acceptanceCriteria)
              ? sub.acceptanceCriteria.map((item: unknown) => String(item))
              : []
          };
        }
      );

      // Root implementation obligation check:
      // If root goal requires implementation and this node is root (or an IMPLEMENT parent),
      // ensure at least one child preserves IMPLEMENT responsibility.
      if (rootRequiresImplementation && subTasks.length > 0 && (node.kind === "root" || node.contract?.responsibility === "IMPLEMENT")) {
        const hasImplementTask = subTasks.some((st) => st.responsibility === "IMPLEMENT");
        if (!hasImplementTask) {
          let targetIdx = subTasks.findIndex((st) =>
            /\b(fix|edit|modify|patch|repair|write|code|change|implement)\b/i.test(`${st.title} ${st.expectedOutput}`)
          );
          if (targetIdx === -1) {
            const nonVerifyIdx = subTasks.map((st, i) => ({ st, i })).reverse().find(({ st }) => st.responsibility !== "VERIFY")?.i;
            targetIdx = nonVerifyIdx ?? subTasks.length - 1;
          }
          if (targetIdx >= 0 && targetIdx < subTasks.length) {
            subTasks[targetIdx].responsibility = "IMPLEMENT";
            subTasks[targetIdx].canWrite = true;
          }
        }
      }

      return {
        subTasks,
        rationale: parsed.rationale ?? "Task split by provider.",
        desiredChildCount: Number.isFinite(Number(parsed.desiredChildCount)) ? Number(parsed.desiredChildCount) : subTasks.length,
        splitReason: typeof parsed.splitReason === "string" ? parsed.splitReason : parsed.rationale ?? "Task split by provider.",
        stopConditions: Array.isArray(parsed.stopConditions) ? parsed.stopConditions.map((item: unknown) => String(item)) : []
      };
    } catch (error) {
      throw new Error(`Provider-backed recursive split failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private formatPackForSplit(pack?: MemoryEvidencePack): string {
    if (!pack) return "";
    const lines: string[] = ["=== Memory Evidence Pack ==="];
    if (pack.relevant_files.length) lines.push(`Relevant files: ${pack.relevant_files.slice(0, 6).join(", ")}`);
    if (pack.symbols.length) lines.push(`Symbols: ${pack.symbols.slice(0, 4).join(", ")}`);
    if (pack.commands.length) lines.push(`Known commands: ${pack.commands.slice(0, 4).join(", ")}`);
    if (pack.unknowns.length) lines.push(`Unknowns: ${pack.unknowns.slice(0, 2).join("; ")}`);
    if (pack.warnings.length) lines.push(`Warnings: ${pack.warnings.slice(0, 2).join("; ")}`);
    lines.push(`Confidence: ${pack.confidence.toFixed(2)}, source: ${pack.context_source}`);
    return lines.join("\n");
  }

}

function isSourceEvidenceRequirement(value: unknown): value is NonNullable<SplitSubTask["sourceEvidenceRequirement"]> {
  if (!value || typeof value !== "object") return false;
  const requirement = value as Record<string, unknown>;
  return typeof requirement.prerequisiteSubtaskId === "string"
    && requirement.prerequisiteSubtaskId.length > 0
    && typeof requirement.sourcePath === "string"
    && requirement.sourcePath.length > 0
    && requirement.evidenceType === "verified_workspace_source";
}

function buildChildTaskPrompt(input: {
  originalGoal: string;
  expandedGoal: string;
  deliverableContract: string;
  parentTask: string;
  childTask: string;
  expectedOutput: string;
  acceptanceCriteria: string[];
}): string {
  return [
    "Execute this recursive child task without losing the original request.",
    "The original user goal is authoritative.",
    "Do not replace the deliverable with a short summary.",
    "If the contract requires code/artifact, produce code/artifact or a blocked result with evidence.",
    "",
    "ORIGINAL GOAL (full, authoritative):",
    input.originalGoal,
    "",
    "EXPANDED GOAL / SPEC:",
    input.expandedGoal,
    "",
    "DELIVERABLE CONTRACT:",
    input.deliverableContract || "Complete this child task with a concrete structured output.",
    "",
    "PARENT TASK:",
    stripRecursiveTaskFrame(input.parentTask),
    "",
    "CHILD TASK:",
    stripRecursiveTaskFrame(input.childTask),
    "",
    "EXPECTED OUTPUT:",
    input.expectedOutput,
    "",
    "ACCEPTANCE CRITERIA FOR THIS CHILD:",
    input.acceptanceCriteria.length ? input.acceptanceCriteria.map((item) => `- ${item}`).join("\n") : "- Concrete output is produced and traceable to the original goal."
  ].join("\n");
}

function stripRecursiveTaskFrame(value: string): string {
  const childMarker = "CHILD TASK:";
  const expectedMarker = "\nEXPECTED OUTPUT:";
  const childIndex = value.lastIndexOf(childMarker);
  if (childIndex === -1) return value.trim();
  const afterChild = value.slice(childIndex + childMarker.length);
  const expectedIndex = afterChild.indexOf(expectedMarker);
  return (expectedIndex === -1 ? afterChild : afterChild.slice(0, expectedIndex)).trim();
}
