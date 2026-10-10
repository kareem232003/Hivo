import type { LlmProvider } from "../llm/LlmProvider.js";
import { invokeReasoningProviderText } from "../runtime/ReasoningKernel.js";
import type {
  CollectResult,
  MemoryEvidencePack,
  RecursiveSwarmNode,
  RecursiveNodeOutput,
  EvidenceReport,
  GeneratedArtifact,
  EditIntent,
  ValidationPlan,
  IntegrationSummary
} from "./RecursiveSwarmModels.js";

export type HierarchicalCollectorOptions = {
  provider?: LlmProvider;
  enableErrorRecovery?: boolean;
};

export class HierarchicalCollector {
  private readonly provider?: LlmProvider;
  private readonly enableErrorRecovery: boolean;

  constructor(options: HierarchicalCollectorOptions = {}) {
    this.provider = options.provider;
    this.enableErrorRecovery = options.enableErrorRecovery ?? true;
  }

  async collect(children: RecursiveSwarmNode[], parentGoal: string, opts?: { pack?: MemoryEvidencePack }): Promise<CollectResult> {
    const childResults: Record<string, string> = {};
    const errors: string[] = [];
    const resolvedErrors: string[] = [];
    const unresolvedErrors: string[] = [];

    // Collect structured outputs from children
    const evidenceReports: EvidenceReport[] = [];
    const generatedArtifacts: GeneratedArtifact[] = [];
    const editIntents: EditIntent[] = [];
    const validationPlans: ValidationPlan[] = [];
    const childOutputCount = children.filter((c) => c.structuredOutput || c.outputSummary).length;

    for (const child of children) {
      if (child.structuredOutput) {
        this.collectTypedOutput(child.structuredOutput, evidenceReports, generatedArtifacts, editIntents, validationPlans);
      }
      if (child.structuredOutput?.kind === "generated_artifact") {
        const artifact = child.structuredOutput;
        const excerpt = artifact.content.length > 500 ? artifact.content.slice(0, 500) + "... [truncated]" : artifact.content;
        childResults[child.id] = child.outputSummary
          ? `${child.outputSummary}\nArtifact Content (${artifact.path}):\n${excerpt}`
          : `Artifact (${artifact.path}):\n${excerpt}`;
      } else if (child.outputSummary) {
        childResults[child.id] = child.outputSummary;
      }
      if (child.errorSummary) {
        errors.push(`[${child.name}] ${child.errorSummary}`);
      }
      if (child.status === "failed") {
        errors.push(`[${child.name}] Failed with status: failed`);
      }
      if (child.collectResult?.unresolvedErrors) {
        unresolvedErrors.push(...child.collectResult.unresolvedErrors);
      }
    }

    for (const error of errors) {
      if (this.enableErrorRecovery) {
        const resolution = await this.tryResolveError(error, parentGoal);
        if (resolution) {
          resolvedErrors.push(`${error} -> ${resolution}`);
        } else {
          unresolvedErrors.push(error);
        }
      } else {
        unresolvedErrors.push(error);
      }
    }

    // Merge structured outputs into an auditable integration summary.
    const mergedFindings = this.mergeFindings(evidenceReports, generatedArtifacts, editIntents);

    // Build conflicts from edit intents that target the same file
    const conflicts = this.detectConflicts(editIntents);

    const integrationSummary: IntegrationSummary = {
      kind: "integration_summary",
      child_outputs_used: childOutputCount,
      conflicts,
      merged_findings: mergedFindings,
      unresolved_items: unresolvedErrors
    };

    let structuralTrace = this.formatStructuralCollectionTrace(integrationSummary, childResults);
    let mergedOutput = structuralTrace;
    if (childOutputCount > 0 || integrationSummary.conflicts.length > 0 || integrationSummary.merged_findings.length > 0) {
      if (!this.provider) {
        unresolvedErrors.push("provider_unavailable: hierarchical collection requires a configured provider for merged output; structural child facts were preserved only.");
        structuralTrace = this.formatStructuralCollectionTrace(integrationSummary, childResults);
        mergedOutput = structuralTrace;
      } else {
        try {
          mergedOutput = await this.mergeWithProvider(parentGoal, integrationSummary, childResults, opts?.pack);
        } catch (error) {
          unresolvedErrors.push(`provider_failed: hierarchical collection merge failed: ${formatError(error)}`);
          structuralTrace = this.formatStructuralCollectionTrace(integrationSummary, childResults);
          mergedOutput = structuralTrace;
        }
      }
    }

    const totalChildren = children.length;
    const successCount = children.filter(
      (child) => child.status === "succeeded" && !child.errorSummary
    ).length;

    return {
      childResults,
      mergedOutput,
      errors,
      resolvedErrors,
      unresolvedErrors,
      confidence: totalChildren > 0 ? successCount / totalChildren : 0
    };
  }

  private collectTypedOutput(
    output: RecursiveNodeOutput,
    evidenceReports: EvidenceReport[],
    generatedArtifacts: GeneratedArtifact[],
    editIntents: EditIntent[],
    validationPlans: ValidationPlan[]
  ): void {
    switch (output.kind) {
      case "evidence_report":
        evidenceReports.push(output);
        break;
      case "edit_intent":
        editIntents.push(output);
        break;
      case "validation_plan":
        validationPlans.push(output);
        break;
      case "task_plan":
        // Task plans are informational — store as merged findings via summary
        break;
      case "generated_artifact":
        generatedArtifacts.push(output);
        break;
      case "review_decision":
        // Review decisions feed into integration but are tracked separately
        break;
      case "integration_summary":
        // Flatten nested integration summaries
        if (output.conflicts) evidenceReports.push({
          kind: "evidence_report",
          findings: output.conflicts,
          files: [],
          symbols: [],
          evidence_refs: [],
          unknowns: output.unresolved_items,
          confidence: 0.5
        });
        break;
      case "final_summary":
        // Flatten edit intents and validation plans from child final summaries
        for (const ei of output.edit_intents) editIntents.push(ei);
        for (const vp of output.validation_plans) validationPlans.push(vp);
        break;
    }
  }

  private mergeFindings(evidenceReports: EvidenceReport[], generatedArtifacts: GeneratedArtifact[], editIntents: EditIntent[]): string[] {
    const findings: string[] = [];
    for (const er of evidenceReports) {
      findings.push(...er.findings);
    }
    for (const artifact of generatedArtifacts) {
      const contentSnippet = artifact.content.length <= 200
        ? ` content: "${artifact.content.trim()}"`
        : ` excerpt: "${artifact.content.trim().slice(0, 200)}..."`;
      findings.push(`Generated artifact: ${artifact.path} (${artifact.content.length} character(s))${contentSnippet} - ${artifact.description.slice(0, 160)}`);
    }
    for (const ei of editIntents) {
      findings.push(`Edit intent: ${ei.operation} ${ei.target_file} (${ei.risk} risk) — ${ei.reason.slice(0, 120)}`);
    }
    return findings;
  }

  private detectConflicts(editIntents: EditIntent[]): string[] {
    const conflicts: string[] = [];
    const byFile = new Map<string, EditIntent[]>();
    for (const ei of editIntents) {
      const list = byFile.get(ei.target_file) ?? [];
      list.push(ei);
      byFile.set(ei.target_file, list);
    }
    for (const [file, intents] of byFile) {
      if (intents.length > 1) {
        const ops = intents.map((i) => i.operation).join(", ");
        conflicts.push(`Multiple intents for ${file}: ${ops}`);
      }
    }
    return conflicts;
  }

  private async mergeWithProvider(
    parentGoal: string,
    summary: IntegrationSummary,
    childResults: Record<string, string>,
    pack?: MemoryEvidencePack
  ): Promise<string> {
    if (!this.provider) {
      throw new Error("configured provider is required for hierarchical collection merge");
    }
    const text = await invokeReasoningProviderText(this.provider, {
      systemPrompt: `You are the collection merge agent for a recursive coding swarm.
Use only the provided child outputs and integration summary.
Do not invent files, commands, validation results, or completed work.
Surface conflicts and unresolved items clearly.`,
      userPrompt: JSON.stringify({
        parentGoal,
        integrationSummary: summary,
        childResults,
        evidencePack: pack ? {
          pack_id: pack.pack_id,
          node_id: pack.node_id,
          relevant_files: pack.relevant_files,
          file_ranges: pack.file_ranges,
          symbols: pack.symbols,
          evidence_refs: pack.evidence_refs,
          unknowns: pack.unknowns,
          warnings: pack.warnings,
          confidence: pack.confidence,
          freshness_status: pack.freshness_status
        } : undefined
      }, null, 2),
      maxOutputTokens: 768
    });
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("provider returned empty collection merge output");
    }
    return trimmed;
  }

  private formatStructuralCollectionTrace(summary: IntegrationSummary, childResults: Record<string, string>): string {
    return JSON.stringify({
      kind: "hierarchical_collection_trace",
      integrationSummary: summary,
      childResults
    }, null, 2);
  }

  private async tryResolveError(error: string, parentGoal: string): Promise<string | null> {
    if (!this.provider) {
      return null;
    }

    try {
      const text = await invokeReasoningProviderText(this.provider, {
        systemPrompt: `You are an Error Resolver for a multi-agent system.
Given an error from a sub-agent, determine if it can be safely ignored, worked around, or needs human intervention.
Respond with a resolution strategy.`,
        userPrompt: `Parent Goal: ${parentGoal}

Error: ${error}

Can this error be resolved automatically? If yes, describe the resolution. If not, say "UNRESOLVABLE".`,
        maxOutputTokens: 256
      });

      if (text.includes("UNRESOLVABLE")) return null;
      return text.slice(0, 200);
    } catch {
      return null;
    }
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
