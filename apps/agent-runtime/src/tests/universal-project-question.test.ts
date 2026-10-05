import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProjectMap } from "@hivo/protocol";
import type { LlmProvider, LlmRequest } from "../llm/LlmProvider.js";
import { classifyEvidenceSource } from "../runtime/EvidenceHygiene.js";
import { buildLargeProjectExplainReport } from "../runtime/LargeProjectContextBuilder.js";
import { answerUniversalProjectQuestion as answerUniversalProjectQuestionRaw } from "../runtime/UniversalProjectQuestionEngine.js";
import { inferWorkspaceIntent } from "../runtime/WorkspaceReasoningPipeline.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";

class ThrowingProvider implements LlmProvider {
  async generateStructured(): Promise<never> {
    throw new Error("provider unavailable");
  }

  async generateText(): Promise<string> {
    throw new Error("provider unavailable");
  }
}

class NotFoundProvider implements LlmProvider {
  constructor(private readonly refs: string[] = []) {}

  async generateStructured<T>(_input: LlmRequest, _schema: unknown): Promise<T> {
    return {
      answerMarkdown: "I could not find that concept in the project evidence, even after checking the supplied local reference. [src/analytics.ts:1](hivo-file:src%2Fanalytics.ts:1)",
      usedEvidenceRefs: this.refs,
      unsupportedOrUnclearParts: []
    } as T;
  }

  async generateText(): Promise<string> {
    throw new Error("not used");
  }
}

class GroundedProvider implements LlmProvider {
  constructor(private readonly answerMarkdown: string, private readonly refs: string[]) {}

  async generateStructured<T>(_input: LlmRequest, _schema: unknown): Promise<T> {
    return {
      answerMarkdown: this.answerMarkdown,
      usedEvidenceRefs: this.refs,
      unsupportedOrUnclearParts: []
    } as T;
  }

  async generateText(): Promise<string> {
    return this.answerMarkdown;
  }
}

class LineOneFlowProvider implements LlmProvider {
  constructor(private readonly plainOnly = false) {}

  async generateStructured<T>(): Promise<T> {
    return {
      answerMarkdown: this.answer(),
      usedEvidenceRefs: [
        "backend/main.py:1",
        "backend/routes.py:1",
        "frontend/app.js:1",
        "backend/services/action_executor.py:1",
        "backend/services/agents.py:1",
        "backend/services/arima_model.py:1"
      ],
      unsupportedOrUnclearParts: []
    } as T;
  }

  async generateText(): Promise<string> {
    return this.answer();
  }

  private answer() {
    if (this.plainOnly) {
      return [
        "The project flow starts in backend/main.py:1, which creates the backend app.",
        "backend/routes.py:1 exposes the API surface and delegates to services.",
        "frontend/app.js:1 is the browser entry script that calls the backend.",
        "backend/services/action_executor.py:1, backend/services/agents.py:1, and backend/services/arima_model.py:1 form the service layer."
      ].join("\n");
    }
    return [
      "The project flow starts in `backend/main.py`, which creates the FastAPI app and mounts the router. [backend/main.py:1](hivo-file:backend%2Fmain.py:1)",
      "",
      "`backend/routes.py` exposes the API surface and delegates work into service modules. [backend/routes.py:1](hivo-file:backend%2Froutes.py:1)",
      "",
      "`frontend/app.js` is the browser entry script that calls those API routes. [frontend/app.js:1](hivo-file:frontend%2Fapp.js:1)",
      "",
      "The backend service layer fans out through action execution, agent coordination, and forecasting helpers: [backend/services/action_executor.py:1](hivo-file:backend%2Fservices%2Faction_executor.py:1), [backend/services/agents.py:1](hivo-file:backend%2Fservices%2Fagents.py:1), [backend/services/arima_model.py:1](hivo-file:backend%2Fservices%2Farima_model.py:1)."
    ].join("\n");
  }
}

class ShortDetailedProvider implements LlmProvider {
  async generateStructured<T>(_input: LlmRequest, _schema: unknown): Promise<T> {
    return {
      answerMarkdown: "SVM is trained, then used for prediction. [backend/services/svm_model.py:1](hivo-file:backend%2Fservices%2Fsvm_model.py:1)",
      usedEvidenceRefs: ["backend/services/svm_model.py:1"],
      unsupportedOrUnclearParts: []
    } as T;
  }

  async generateText(): Promise<string> {
    throw new Error("not used");
  }
}

class GenericPipelineProvider implements LlmProvider {
  async generateStructured<T>(_input: LlmRequest, _schema: unknown): Promise<T> {
    return {
      answerMarkdown: [
        "The flow is upstream-clustering -> training -> prediction -> explainability -> usage.",
        "[backend/services/clustering.py:1](hivo-file:backend%2Fservices%2Fclustering.py:1)"
      ].join("\n"),
      usedEvidenceRefs: ["backend/services/clustering.py:1"],
      unsupportedOrUnclearParts: []
    } as T;
  }

  async generateText(): Promise<string> {
    throw new Error("not used");
  }
}

class UngroundedProvider implements LlmProvider {
  callCount = 0;

  async generateStructured<T>(_input: LlmRequest, _schema: unknown): Promise<T> {
    this.callCount += 1;
    return {
      answerMarkdown: "This is a natural provider answer, but it does not cite the workspace evidence or prove the requested mechanism.",
      usedEvidenceRefs: [],
      unsupportedOrUnclearParts: []
    } as T;
  }

  async generateText(): Promise<string> {
    throw new Error("not used");
  }
}

class NaturalUniversalProvider implements LlmProvider {
  structuredCalls = 0;
  textCalls = 0;

  async generateStructured(): Promise<never> {
    this.structuredCalls += 1;
    throw new Error("natural universal provider should not use structured project explain");
  }

  async generateText(input: LlmRequest): Promise<string> {
    this.textCalls += 1;
    const link = input.userPrompt.match(/\[[^\]]+\]\(hivo-file:[^)]+\)/)?.[0];
    if (!link) throw new Error("natural universal prompt did not include hivo-file evidence links");
    return [
      "The requested behavior is explained from the current project evidence, not from a canned local synthesis.",
      "",
      `The key code evidence is ${link}.`,
      "",
      "That cited evidence is enough for this concise project answer."
    ].join("\n");
  }
}

class NaturalDecisionPolicyProvider implements LlmProvider {
  structuredCalls = 0;
  textCalls = 0;

  async generateStructured(): Promise<never> {
    this.structuredCalls += 1;
    throw new Error("decision policy provider should use natural text project explain");
  }

  async generateText(input: LlmRequest): Promise<string> {
    this.textCalls += 1;
    const links = Array.from(input.userPrompt.matchAll(/\[[^\]]+\]\(hivo-file:[^)]+\)/g)).map((match) => match[0]);
    const agents = links.find((link) => link.includes("backend/services/agents.py")) ?? links[0];
    const orchestrator = links.find((link) => link.includes("backend/services/orchestrator.py")) ?? links[1] ?? agents;
    const routes = links.find((link) => link.includes("backend/routes.py")) ?? links[2] ?? agents;
    if (!agents || !orchestrator || !routes) {
      throw new Error("decision policy prompt did not include the expected evidence links");
    }
    return [
      "## \u062a\u0633\u0644\u0633\u0644 \u0627\u0644\u0642\u0631\u0627\u0631",
      "",
      `\u0627\u0644\u0646\u0638\u0627\u0645 \u0645\u0634 \u0628\u064a\u062e\u062a\u0627\u0631 \`Re-cluster\` \u0645\u0646 FCM \u0644\u0648\u062d\u062f\u0647. \u0627\u0644\u0642\u0627\u0639\u062f\u0629 \u0627\u0644\u0645\u0628\u0627\u0634\u0631\u0629 \u0641\u064a \`ClusterHealthAgent.recommend\`: \u064a\u0648\u0635\u064a \u0628\u0640 \`Re-cluster\` \u0641\u0642\u0637 \u0644\u0648 \`drift_detected\` \u0635\u062d \u0648 \`membership_strength < 0.50\`\u061b \u0648\u063a\u064a\u0631 \u0643\u062f\u0647 \u0627\u0644\u0640 agent \u064a\u0648\u0635\u064a \u0628\u0640 \`Offer\`. ${agents}`,
      "",
      `\u0628\u0639\u062f \u0643\u062f\u0647 \`process_customer\` \u0628\u062a\u062c\u0645\u0639 \`agent_recommendations\` \u0645\u0646 \u0643\u0644 \u0627\u0644\u0640 agents \u0648\u062a\u0628\u0639\u062a\u0647\u0627 \u0644\u0640 \`orchestrator.choose_route\`\u060c \u0641\u0635\u0648\u062a cluster-health \u0645\u0634 \u0647\u0648 \u0627\u0644\u0642\u0631\u0627\u0631 \u0627\u0644\u0646\u0647\u0627\u0626\u064a \u0644\u0648\u062d\u062f\u0647. ${routes}`,
      "",
      `\u0627\u0644\u0640 orchestrator \u0628\u064a\u0628\u0646\u064a \`weighted_votes\`\u060c \u064a\u062e\u062a\u0627\u0631 \`weighted_winner\`\u060c \u0648\u064a\u062d\u0633\u0628 \`agent_consensus\`. \u0648\u0645\u0645\u0643\u0646 \u0644\u0633\u0647 \u064a\u0631\u062c\u0639 \`No Action\` \u0623\u0648 \`Human Review\` \u0642\u0628\u0644 \u0645\u0627 \u064a\u0639\u0645\u0644 dispatch \u0644\u0644\u0623\u0643\u0634\u0646 \u0627\u0644\u0643\u0633\u0628\u0627\u0646. ${orchestrator}`,
      "",
      "\u0628\u0627\u0644\u062a\u0627\u0644\u064a: \u0627\u0644\u0646\u0638\u0627\u0645 \u064a\u0642\u0631\u0631 \`Re-cluster\` \u0644\u0648 \u0642\u0627\u0639\u062f\u0629 \u0635\u062d\u0629 \u0627\u0644\u0643\u0644\u0633\u062a\u0631 \u0635\u0648\u062a\u062a \u0644\u0647 \u0648\u0627\u0644\u0640 weighted routing \u0633\u0645\u062d \u0644\u0644\u0635\u0648\u062a \u062f\u0647 \u064a\u0643\u0633\u0628 \u0628\u0640 score/consensus \u0643\u0627\u0641\u064a. \u063a\u064a\u0631 \u0643\u062f\u0647 \u0645\u0645\u0643\u0646 \u064a\u0637\u0644\u0639 \`Offer\` \u0623\u0648 \`Strong Offer\` \u0623\u0648 \`Human Review\` \u0623\u0648 \`No Action\`."
    ].join("\n");
  }
}

class NaturalHumanReviewPolicyProvider implements LlmProvider {
  structuredCalls = 0;
  textCalls = 0;

  async generateStructured(): Promise<never> {
    this.structuredCalls += 1;
    throw new Error("human review policy provider should use natural text project explain");
  }

  async generateText(input: LlmRequest): Promise<string> {
    this.textCalls += 1;
    const links = Array.from(input.userPrompt.matchAll(/\[[^\]]+\]\(hivo-file:[^)]+\)/g)).map((match) => match[0]);
    const agents = links.find((link) => link.includes("backend/services/agents.py")) ?? links[0];
    const orchestrator = links.find((link) => link.includes("backend/services/orchestrator.py")) ?? links[1] ?? agents;
    const routes = links.find((link) => link.includes("backend/routes.py")) ?? links[2] ?? agents;
    const executor = links.find((link) => link.includes("backend/services/action_executor.py")) ?? links[3] ?? agents;
    if (!agents || !orchestrator || !routes || !executor) {
      throw new Error("human review policy prompt did not include the expected evidence links");
    }
    return [
      "## Routing policy",
      "",
      `The agents only propose actions: ` +
        "`ReliabilityAgent`, `ForecastAgent`, and `ClusterHealthAgent` return `recommended_action_name` values that become `agent_recommendations`. " +
        `${agents}`,
      "",
      `The orchestrator does the routing decision. It aggregates ` +
        "`weighted_votes`, chooses a `weighted_winner`, and computes `agent_consensus`; if the score is below `minimum_score` it rejects, and if `agent_consensus < 0.60` or the score is below `borderline_low` it returns `route_name: 'review'` with `selected_action_name: 'Human Review'`. " +
        `Only otherwise does it direct dispatch with ` +
        "`route_name: 'dispatch'` and the winning action. " +
        `${orchestrator}`,
      "",
      `The route wires that policy by building ` +
        "`agent_recommendations`, calling `orchestrator.choose_route`, and then passing `selected_action_name` to `ActionExecutor.execute`. " +
        `${routes} ${executor}`,
      "",
      "So Human Review is not an agent proposal being blindly executed; it is the orchestration gate for low consensus or borderline score. Direct dispatch happens only after the central route decision accepts the weighted winner."
    ].join("\n");
  }
}

class ArabicHumanReviewPolicyProvider implements LlmProvider {
  structuredCalls = 0;
  textCalls = 0;

  async generateStructured(): Promise<never> {
    this.structuredCalls += 1;
    throw new Error("arabic human review policy provider should use natural text project explain");
  }

  async generateText(input: LlmRequest): Promise<string> {
    this.textCalls += 1;
    const links = Array.from(input.userPrompt.matchAll(/\[[^\]]+\]\(hivo-file:[^)]+\)/g)).map((match) => match[0]);
    const agents = links.find((link) => link.includes("backend/services/agents.py")) ?? links[0];
    const orchestrator = links.find((link) => link.includes("backend/services/orchestrator.py")) ?? links[1] ?? agents;
    const routes = links.find((link) => link.includes("backend/routes.py")) ?? links[2] ?? agents;
    const executor = links.find((link) => link.includes("backend/services/action_executor.py")) ?? links[3] ?? agents;
    if (!agents || !orchestrator || !routes || !executor) {
      throw new Error("arabic human review policy prompt did not include the expected evidence links");
    }
    return [
      "## سياسة التوجيه",
      "",
      `الـ agents بتقترح إجراءات فقط، ونتائجها بتتجمع كـ \`agent_recommendations\`. ${agents}`,
      "",
      `الـ orchestrator هو اللي يقرر: لو \`agent_consensus\` قليل أو الـ score في المنطقة الحدية، يحول إلى المراجعة البشرية بدل التنفيذ المباشر. ${orchestrator}`,
      "",
      `لو القرار المركزي قبل الـ weighted winner، ساعتها يحصل التنفيذ المباشر ويُمرر \`selected_action_name\` إلى \`ActionExecutor.execute\`. ${routes} ${executor}`,
      "",
      "الخلاصة: المراجعة البشرية هي بوابة مراجعة عند ضعف الثقة أو الإجماع، أما التنفيذ المباشر فيحصل فقط بعد قبول قرار التوجيه المركزي."
    ].join("\n");
  }
}

class NaturalSourceFlowProvider implements LlmProvider {
  structuredCalls = 0;
  textCalls = 0;

  async generateStructured(): Promise<never> {
    this.structuredCalls += 1;
    throw new Error("source flow provider should use natural text project explain");
  }

  async generateText(input: LlmRequest): Promise<string> {
    this.textCalls += 1;
    const links = Array.from(input.userPrompt.matchAll(/\[[^\]]+\]\(hivo-file:[^)]+\)/g)).map((match) => match[0]);
    const main = links.find((link) => link.includes("backend/main.py")) ?? links[0];
    const routes = links.find((link) => link.includes("backend/routes.py")) ?? links[1] ?? main;
    const arima = links.find((link) => link.includes("backend/services/arima_model.py")) ?? links[2] ?? routes;
    const frontend = links.find((link) => link.includes("frontend/app.js")) ?? links[3] ?? routes;
    if (!main || !routes || !arima || !frontend) {
      throw new Error("source flow prompt did not include expected evidence links");
    }
    return [
      "## Backend to frontend flow",
      "",
      `The backend starts from ` +
        "`backend/main.py`, which imports or mounts the route layer so the FastAPI app has HTTP endpoints. " +
        `${main}`,
      "",
      `The route layer in ` +
        "`backend/routes.py` is the bridge from requests into services: it imports `forecast` from `backend/services/arima_model.py` and exposes the backend response shape. " +
        `${routes} ${arima}`,
      "",
      `The frontend in ` +
        "`frontend/app.js` calls the backend with `fetch('/api/forecast')`, receives JSON, and uses that response to drive the browser UI. " +
        `${frontend}`,
      "",
      "So the connection is: backend app startup -> route handler -> service function -> frontend fetch/render path."
    ].join("\n");
  }
}

class CapturingDeepQuestionProvider implements LlmProvider {
  structuredCalls = 0;
  textCalls = 0;
  requests: LlmRequest[] = [];

  async generateStructured(): Promise<never> {
    this.structuredCalls += 1;
    throw new Error("deep project question provider should use natural text project explain");
  }

  async generateText(input: LlmRequest): Promise<string> {
    this.textCalls += 1;
    this.requests.push(input);
    const links = Array.from(input.userPrompt.matchAll(/\[[^\]]+\]\(hivo-file:[^)]+\)/g)).map((match) => match[0]);
    const clustering = links.find((link) => link.includes("backend/services/clustering.py")) ?? links[0];
    const svm = links.find((link) => link.includes("backend/services/svm_model.py")) ?? clustering;
    const routes = links.find((link) => link.includes("backend/routes.py")) ?? clustering;
    if (!clustering) throw new Error("deep question prompt did not include clustering evidence");
    return [
      "DBSCAN is used first to separate obvious noise/outliers from the feature matrix: the code creates `dbscan_labels`, builds `noise_mask`, and passes only the cleaned `feature_frame` into the next clustering stage. " + clustering,
      "",
      "Fuzzy C-Means then runs `cmeans` on that cleaned frame and produces `memberships` plus `fcm_labels`; that is a membership-certainty signal, not the same thing as DBSCAN's outlier/noise decision. " + clustering,
      "",
      "The downstream decision path uses those labels for training and prediction: `train_svm_state_detector` trains from `fcm_labels`, and the route wires `build_customer_segments` into training, so the DBSCAN stage shapes what FCM and later SVM see. " + svm + " " + routes
    ].join("\n");
  }
}

class StaleOuterloopProvider implements LlmProvider {
  async generateStructured<T>(_input: LlmRequest, _schema: unknown): Promise<T> {
    return {
      answerMarkdown: [
        "## الخلاصة",
        "لقيت `outerloop` كدليل مباشر، وبنيت الشرح على الروابط المثبتة في الكود، مش على mentions عامة.",
        "",
        "## الفلو المثبت",
        "- جزئي: فيه مرحلة model/decision/action داخل النظام. [backend/services/action_executor.py:38](hivo-file:backend%2Fservices%2Faction_executor.py:38)",
        "- جزئي: فيه feedback/outcome stage تربط القرار بنتيجة لاحقة. [backend/routes.py:19](hivo-file:backend%2Froutes.py:19)",
        "",
        "## النواتج أو الحالات المثبتة",
        "- `ACTION_LOG_PATH`, `status`, `observed_outcome`."
      ].join("\n"),
      usedEvidenceRefs: ["backend/services/action_executor.py:38", "backend/routes.py:19"],
      unsupportedOrUnclearParts: []
    } as T;
  }

  async generateText(): Promise<string> {
    throw new Error("not used");
  }
}

const projectMap: ProjectMap = {
  stack: ["TypeScript"],
  packageManagers: ["npm"],
  testCommands: ["npm test"],
  entryPoints: ["src/index.ts"],
  importantFiles: ["package.json", "src/index.ts"]
};

const answerUniversalProjectQuestion = (
  input: Parameters<typeof answerUniversalProjectQuestionRaw>[0]
) => answerUniversalProjectQuestionRaw({
  ...input
});

test("UniversalProjectQuestionEngine defaults to notice-only after provider failure", async () => {
  const workspace = await createWorkspace("universal-default-provider-notice");
  try {
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await writeFile(path.join(workspace, "src", "payment.ts"), "export const rarePaymentGatewayAdapter = true;\n", "utf8");
    const tools = new ToolRegistry(workspace);
    const prompt = "Where is rarePaymentGatewayAdapter?";
    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: prompt,
      projectMap: { ...projectMap, importantFiles: ["src/payment.ts"], entryPoints: ["src/payment.ts"] }
    });

    const result = await answerUniversalProjectQuestionRaw({
      provider: new ThrowingProvider(),
      tools,
      userPrompt: prompt,
      explainReport: report
    });

    assert.equal(result.answerStrategy.strategy, "provider_failed_notice");
    assert.equal(result.answerStrategy.finalAnswerSource, "local_notice");
    assert.doesNotMatch(result.answerMarkdown, /hivo-file:src%2Fpayment\.ts|rarePaymentGatewayAdapter.*defined/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine notice-only accepts natural provider Markdown with citations", async () => {
  const workspace = await createWorkspace("universal-natural-provider-markdown");
  try {
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await writeFile(path.join(workspace, "src", "index.ts"), "export function startApp() { return 'ready'; }\n", "utf8");
    const tools = new ToolRegistry(workspace);
    const prompt = "explain this project";
    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: prompt,
      projectMap: { ...projectMap, importantFiles: ["src/index.ts"], entryPoints: ["src/index.ts"] }
    });
    const provider = new NaturalUniversalProvider();

    const result = await answerUniversalProjectQuestionRaw({
      provider,
      tools,
      userPrompt: prompt,
      explainReport: report
    });

    assert.equal(provider.structuredCalls <= 1, true);
    assert.ok(provider.textCalls >= 1);
    assert.equal(result.fallbackUsed, false);
    assert.equal(result.answerStrategy.finalAnswerSource, "provider");
    assert.match(result.answerMarkdown, /key code evidence|hivo-file/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine treats smoke entrypoint inventory as structural project context", async () => {
  const workspace = await createWorkspace("universal-entrypoint-inventory");
  try {
    await mkdir(path.join(workspace, "backend"), { recursive: true });
    await mkdir(path.join(workspace, "frontend"), { recursive: true });
    await writeFile(path.join(workspace, "backend", "main.py"), "from backend.routes import app\n", "utf8");
    await writeFile(path.join(workspace, "backend", "routes.py"), "app = object()\n", "utf8");
    await writeFile(path.join(workspace, "frontend", "app.js"), "export function boot() { return 'ui'; }\n", "utf8");
    const tools = new ToolRegistry(workspace);
    const prompt = "What are the main entrypoint files in this project? Use the detected candidates backend/main.py, backend/routes.py, frontend/app.js.";
    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: prompt,
      projectMap: {
        ...projectMap,
        stack: ["Python", "JavaScript"],
        importantFiles: ["backend/main.py", "backend/routes.py", "frontend/app.js"],
        entryPoints: ["backend/main.py", "backend/routes.py", "frontend/app.js"]
      }
    });
    const provider = new NaturalUniversalProvider();

    const result = await answerUniversalProjectQuestionRaw({
      provider,
      tools,
      userPrompt: prompt,
      explainReport: report
    });

    assert.equal(provider.structuredCalls <= 1, true);
    assert.ok(provider.textCalls >= 1);
    assert.equal(result.questionUnderstanding.targetConcept, "general");
    assert.equal(result.grounding.concept.specific, false);
    assert.equal(result.fallbackUsed, false, JSON.stringify({
      fallbackReason: result.fallbackReason,
      validationErrors: result.validationErrors,
      unsupportedOrUnclearParts: result.unsupportedOrUnclearParts,
      answerMarkdown: result.answerMarkdown
    }, null, 2));
    assert.equal(result.answerStrategy.strategy, "provider_final");
    assert.match(result.answerMarkdown, /backend\/main\.py|backend\/routes\.py|frontend\/app\.js|hivo-file/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine answers tech-stack inventory from structural manifest evidence", async () => {
  const workspace = await createWorkspace("universal-tech-stack");
  try {
    await mkdir(path.join(workspace, "apps", "desktop", "src-tauri"), { recursive: true });
    await writeFile(path.join(workspace, "package.json"), JSON.stringify({
      name: "stack-fixture",
      workspaces: ["apps/*"],
      dependencies: {
        fastify: "^5.2.1",
        react: "^19.0.0"
      },
      devDependencies: {
        typescript: "^5.8.3",
        vite: "^6.0.5"
      },
      scripts: {
        build: "tsc",
        test: "node --test"
      }
    }, null, 2), "utf8");
    await writeFile(path.join(workspace, "apps", "desktop", "src-tauri", "Cargo.toml"), [
      "[package]",
      "name = \"stack-fixture-desktop\"",
      "version = \"0.1.0\"",
      "",
      "[dependencies]",
      "rusqlite = \"0.32\"",
      "tauri = \"2\"",
      "tokio = \"1\""
    ].join("\n"), "utf8");
    const tools = new ToolRegistry(workspace);
    const prompt = "tell me the full tech stack";
    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: prompt,
      projectMap: {
        ...projectMap,
        stack: ["TypeScript", "Rust"],
        importantFiles: ["package.json", "apps/desktop/src-tauri/Cargo.toml"],
        entryPoints: []
      }
    });

    const provider = new GroundedProvider(
      [
        "## Full Tech Stack",
        "",
        "This workspace uses a mixed TypeScript, JavaScript, and Rust stack. The root package manifest declares React, Fastify, TypeScript, and Vite, which establishes the main JavaScript and TypeScript technologies present in the repository. React is present as a frontend dependency, Fastify is present as a server-side dependency, while TypeScript and Vite are declared as development tooling. [package.json:1](hivo-file:package.json:1)",
        "",
        "## Web and Application Layer",
        "",
        "The JavaScript ecosystem is defined from the root package manifest rather than inferred from filenames alone. React is explicitly declared in dependencies, and Fastify is also explicitly declared there. TypeScript and Vite appear in devDependencies, so the repository has direct manifest evidence for typed JavaScript development and Vite-based tooling. These claims come from the current workspace package.json and do not require assumptions about frameworks that are not listed. [package.json:1](hivo-file:package.json:1)",
        "",
        "## Desktop and Native Layer",
        "",
        "The desktop side uses Tauri with Rust and Cargo. The Cargo manifest under apps/desktop/src-tauri declares the Tauri crate directly, which provides current-workspace evidence for the native desktop layer. The same manifest also declares Tokio, showing that the Rust portion includes Tokio as a dependency. This section is based only on the dependencies recorded in the Cargo manifest. [apps/desktop/src-tauri/Cargo.toml:1](hivo-file:apps%2Fdesktop%2Fsrc-tauri%2FCargo.toml:1)",
        "",
        "## Storage",
        "",
        "SQLite support is represented through the Rust rusqlite dependency. The Cargo manifest explicitly declares rusqlite, so SQLite belongs in the confirmed technology inventory for this workspace. Taken together, the manifests prove a stack containing React, Fastify, TypeScript, Vite, Tauri, Rust / Cargo, Tokio, and SQLite through rusqlite. [apps/desktop/src-tauri/Cargo.toml:1](hivo-file:apps%2Fdesktop%2Fsrc-tauri%2FCargo.toml:1)"
      ].join("\n"),
      [
        "package.json:1",
        "apps/desktop/src-tauri/Cargo.toml:1"
      ]
    );

    const result = await answerUniversalProjectQuestion({
      provider,
      tools,
      userPrompt: prompt,
      explainReport: report
    });

    assert.equal(result.questionUnderstanding.targetConcept, "general");
    assert.equal(result.investigationConceptResolution.requestedConceptText, "tech stack");
    assert.equal(result.queryPlan.some((query) => query.query === "tell"), false);
    assert.match(result.answerMarkdown, /Full Tech Stack/);
    assert.match(result.answerMarkdown, /React|Vite/);
    assert.match(result.answerMarkdown, /Tauri|Rust \/ Cargo/);
    assert.match(result.answerMarkdown, /Fastify|SQLite/);
    assert.match(result.answerMarkdown, /hivo-file:package\.json:1/);
    assert.match(result.answerMarkdown, /hivo-file:apps%2Fdesktop%2Fsrc-tauri%2FCargo\.toml:1/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine does not reject general flow answers only for line-one citations", async () => {
  const workspace = await createWorkspace("universal-line-one-flow");
  try {
    await mkdir(path.join(workspace, "backend", "services"), { recursive: true });
    await mkdir(path.join(workspace, "frontend"), { recursive: true });
    await writeFile(path.join(workspace, "backend", "main.py"), "from backend.routes import router\napp = object()\n", "utf8");
    await writeFile(path.join(workspace, "backend", "routes.py"), "from backend.services.action_executor import execute_action\nrouter = object()\n", "utf8");
    await writeFile(path.join(workspace, "frontend", "app.js"), "export async function boot() { return fetch('/api/action'); }\n", "utf8");
    await writeFile(path.join(workspace, "backend", "services", "action_executor.py"), "def execute_action(payload):\n    return payload\n", "utf8");
    await writeFile(path.join(workspace, "backend", "services", "agents.py"), "def select_agent(task):\n    return task\n", "utf8");
    await writeFile(path.join(workspace, "backend", "services", "arima_model.py"), "def forecast(values):\n    return values\n", "utf8");
    const tools = new ToolRegistry(workspace);
    const prompt = "How do these detected source files connect the project flow? Use only project files such as backend/main.py, backend/routes.py, frontend/app.js, backend/services/action_executor.py, backend/services/agents.py, backend/services/arima_model.py.";
    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: prompt,
      projectMap: {
        ...projectMap,
        stack: ["Python", "JavaScript"],
        importantFiles: ["backend/main.py", "backend/routes.py", "frontend/app.js", "backend/services/action_executor.py", "backend/services/agents.py", "backend/services/arima_model.py"],
        entryPoints: ["backend/main.py", "backend/routes.py", "frontend/app.js"]
      }
    });

    const result = await answerUniversalProjectQuestionRaw({
      provider: new LineOneFlowProvider(),
      tools,
      userPrompt: prompt,
      explainReport: report
    });

    assert.equal(result.fallbackUsed, false, JSON.stringify(result.validationErrors));
    assert.equal(result.answerStrategy.strategy, "provider_final");
    assert.doesNotMatch(result.answerMarkdown, /provider_validation_notice|local synthesis was not used/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine accepts verified plain file refs when provider omits hivo links", async () => {
  const workspace = await createWorkspace("universal-plain-flow-refs");
  try {
    await mkdir(path.join(workspace, "backend", "services"), { recursive: true });
    await mkdir(path.join(workspace, "frontend"), { recursive: true });
    await writeFile(path.join(workspace, "backend", "main.py"), "from backend.routes import router\napp = object()\n", "utf8");
    await writeFile(path.join(workspace, "backend", "routes.py"), "from backend.services.action_executor import execute_action\nrouter = object()\n", "utf8");
    await writeFile(path.join(workspace, "frontend", "app.js"), "export async function boot() { return fetch('/api/action'); }\n", "utf8");
    await writeFile(path.join(workspace, "backend", "services", "action_executor.py"), "def execute_action(payload):\n    return payload\n", "utf8");
    await writeFile(path.join(workspace, "backend", "services", "agents.py"), "def select_agent(task):\n    return task\n", "utf8");
    await writeFile(path.join(workspace, "backend", "services", "arima_model.py"), "def forecast(values):\n    return values\n", "utf8");
    const tools = new ToolRegistry(workspace);
    const prompt = "How do these detected source files connect the project flow? Use only project files such as backend/main.py, backend/routes.py, frontend/app.js, backend/services/action_executor.py, backend/services/agents.py, backend/services/arima_model.py.";
    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: prompt,
      projectMap: {
        ...projectMap,
        stack: ["Python", "JavaScript"],
        importantFiles: ["backend/main.py", "backend/routes.py", "frontend/app.js", "backend/services/action_executor.py", "backend/services/agents.py", "backend/services/arima_model.py"],
        entryPoints: ["backend/main.py", "backend/routes.py", "frontend/app.js"]
      }
    });

    const result = await answerUniversalProjectQuestionRaw({
      provider: new LineOneFlowProvider(true),
      tools,
      userPrompt: prompt,
      explainReport: report
    });

    assert.equal(result.fallbackUsed, false, JSON.stringify(result.validationErrors));
    assert.equal(result.answerStrategy.strategy, "provider_final");
    assert.match(result.answerMarkdown, /backend\/main\.py:1|frontend\/app\.js:1/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine treats smoke backend/frontend flow prompt as structural context", async () => {
  const workspace = await createWorkspace("universal-source-flow");
  try {
    await mkdir(path.join(workspace, "backend", "services"), { recursive: true });
    await mkdir(path.join(workspace, "frontend"), { recursive: true });
    await writeFile(path.join(workspace, "backend", "__init__.py"), "", "utf8");
    await writeFile(path.join(workspace, "backend", "main.py"), "from backend.routes import app\n", "utf8");
    await writeFile(path.join(workspace, "backend", "routes.py"), "from backend.services.arima_model import forecast\napp = object()\n", "utf8");
    await writeFile(path.join(workspace, "backend", "services", "arima_model.py"), "def forecast(): return []\n", "utf8");
    await writeFile(path.join(workspace, "frontend", "app.js"), "fetch('/api/forecast').then(response => response.json())\n", "utf8");
    const tools = new ToolRegistry(workspace);
    const prompt = "How do the detected source files connect the backend and frontend flow? Use only project files such as backend/__init__.py, backend/main.py, backend/routes.py, backend/services/arima_model.py, frontend/app.js.";
    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: prompt,
      projectMap: {
        ...projectMap,
        stack: ["Python", "JavaScript"],
        importantFiles: ["backend/__init__.py", "backend/main.py", "backend/routes.py", "backend/services/arima_model.py", "frontend/app.js"],
        entryPoints: ["backend/main.py", "frontend/app.js"]
      }
    });
    const provider = new NaturalSourceFlowProvider();

    const result = await answerUniversalProjectQuestionRaw({
      provider,
      tools,
      userPrompt: prompt,
      explainReport: report
    });

    assert.equal(provider.structuredCalls <= 1, true);
    assert.ok(provider.textCalls >= 1);
    assert.equal(result.questionUnderstanding.targetConcept, "general");
    assert.equal(result.grounding.concept.specific, false);
    assert.equal(result.fallbackUsed, false, JSON.stringify({
      fallbackReason: result.fallbackReason,
      validationErrors: result.validationErrors,
      unsupportedOrUnclearParts: result.unsupportedOrUnclearParts,
      answerMarkdown: result.answerMarkdown
    }, null, 2));
    assert.equal(result.answerStrategy.strategy, "provider_final");
    assert.doesNotMatch(result.fallbackReason ?? "", /SARIMA|provider_answer_failed_local_validation/i);
    assert.match(result.answerMarkdown, /backend\/main\.py|backend\/routes\.py|frontend\/app\.js|hivo-file/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine cleans social preambles before evidence search", async () => {
  const workspace = await createWorkspace("universal-clean-social-preamble");
  try {
    await mkdir(path.join(workspace, "src"), { recursive: true });
    for (let index = 0; index < 9; index += 1) {
      await writeFile(path.join(workspace, "src", `chat-${index}.md`), "هاي فقط في ملف دردشة ولا علاقة له بالميزة.\n", "utf8");
    }
    await writeFile(
      path.join(workspace, "src", "feedback.ts"),
      [
        "export function submitFeedback(label: string) {",
        "  return fetch('/api/customer-feedback', { method: 'POST', body: JSON.stringify({ label }) });",
        "}"
      ].join("\n"),
      "utf8"
    );
    const tools = new ToolRegistry(workspace);
    const prompt = "هاي ازاي الfeedback بيتطبق؟";
    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: prompt,
      projectMap: {
        ...projectMap,
        stack: ["TypeScript"],
        importantFiles: ["src/feedback.ts"],
        entryPoints: ["src/feedback.ts"]
      }
    });

    const result = await answerUniversalProjectQuestion({
      provider: new ThrowingProvider(),
      tools,
      userPrompt: prompt,
      explainReport: report
    });

    assert.equal(result.intent.topicPhrase, "feedback");
    assert.equal(result.questionUnderstanding.targetConcept, "feedback");
    assert.equal(result.queryPlan.some((query) => query.query === "هاي"), false);
    assert.equal(result.positiveEvidence.some((item) => item.query === "هاي" || item.path.includes("chat-")), false);
    assert.ok(result.queryPlan.some((query) => /feedback/i.test(query.query)));
    assert.ok(result.positiveEvidence.some((item) => item.path === "src/feedback.ts"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function createWorkspace(prefix: string) {
  const workspace = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: prefix, scripts: { test: "echo ok" } }, null, 2), "utf8");
  return workspace;
}

async function createSvmWorkspace() {
  const workspace = await createWorkspace("universal-detailed-svm");
  await mkdir(path.join(workspace, "backend", "services"), { recursive: true });
  await writeFile(
    path.join(workspace, "backend", "services", "clustering.py"),
    [
      "from sklearn.cluster import DBSCAN",
      "import skfuzzy as fuzz",
      "import numpy as np",
      "",
      "class CustomerClusteringService:",
      "    \"\"\"Run the required DBSCAN -> FCM clustering pipeline.\"\"\"",
      "",
      "    def fit_dbscan(self, X):",
      "        dbscan_labels = DBSCAN(eps=0.35, min_samples=5).fit_predict(X)",
      "        noise_mask = dbscan_labels == -1",
      "        feature_frame = X[~noise_mask]",
      "        return dbscan_labels, feature_frame, noise_mask",
      "",
      "    def fit_fcm(self, feature_frame):",
      "        centers, memberships, *_ = fuzz.cluster.cmeans(feature_frame.T, c=4, m=2.0, error=0.005, maxiter=1000)",
      "        fcm_labels = memberships.argmax(axis=0)",
      "        return fcm_labels, memberships",
      "",
      "    def fit(self, X):",
      "        dbscan_labels, feature_frame, noise_mask = self.fit_dbscan(X)",
      "        fcm_labels, memberships = self.fit_fcm(feature_frame)",
      "        return dbscan_labels, fcm_labels, memberships, noise_mask",
      "",
      "def _training_dbscan_payload(dbscan_labels):",
      "    noise_mask = np.asarray(dbscan_labels) == -1",
      "    return {'dbscan_labels': np.asarray(dbscan_labels).tolist(), 'noise_mask': noise_mask.tolist()}",
      "",
      "def build_customer_segments(features):",
      "    service = CustomerClusteringService()",
      "    dbscan_labels, fcm_labels, memberships, noise_mask = service.fit(features)",
      "    _training_dbscan_payload(dbscan_labels)",
      "    return dbscan_labels, fcm_labels, memberships"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspace, "backend", "services", "svm_model.py"),
    [
      "from sklearn.svm import SVC",
      "import joblib",
      "",
      "def train_svm_state_detector(features, fcm_labels):",
      "    svm = SVC(probability=True, kernel='rbf')",
      "    svm.fit(features, fcm_labels)",
      "    joblib.dump(svm, 'artifacts/svm_state_detector.joblib')",
      "    return svm",
      "",
      "def load_svm_state_detector():",
      "    return joblib.load('artifacts/svm_state_detector.joblib')",
      "",
      "def predict_customer_state(features):",
      "    svm = load_svm_state_detector()",
      "    return svm.predict(features), svm.predict_proba(features).max(axis=1)"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspace, "backend", "services", "shap_explainer.py"),
    [
      "import shap",
      "from backend.services.svm_model import load_svm_state_detector",
      "",
      "def explain_svm_prediction(background, customer_features):",
      "    svm = load_svm_state_detector()",
      "    explainer = shap.KernelExplainer(svm.predict_proba, background)",
      "    return explainer.shap_values(customer_features)"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspace, "backend", "routes.py"),
    [
      "from fastapi import FastAPI",
      "from backend.services.clustering import build_customer_segments",
      "from backend.services.svm_model import train_svm_state_detector, predict_customer_state",
      "from backend.services.shap_explainer import explain_svm_prediction",
      "",
      "app = FastAPI()",
      "",
      "@app.post('/train')",
      "def train_pipeline(payload: dict):",
      "    _, fcm_labels, _ = build_customer_segments(payload['features'])",
      "    return {'svm': str(train_svm_state_detector(payload['features'], fcm_labels))}",
      "",
      "@app.post('/predict')",
      "def predict(payload: dict):",
      "    state, confidence = predict_customer_state(payload['features'])",
      "    shap_values = explain_svm_prediction(payload['background'], payload['features'])",
      "    return {'state': state.tolist(), 'confidence': confidence.tolist(), 'shap': str(shap_values)}"
    ].join("\n"),
    "utf8"
  );
  await mkdir(path.join(workspace, "frontend"), { recursive: true });
  await writeFile(
    path.join(workspace, "frontend", "ClusterChart.tsx"),
    [
      "export function ClusterChart({ dbscanLabels }: { dbscanLabels: number[] }) {",
      "  const color = rgba(Number(dbscanLabels[0] ?? 0), 120, 200, 0.4);",
      "  return <span>{color}</span>;",
      "}",
      "function rgba(r: number, g: number, b: number, a: number) {",
      "  return `rgba(${r}, ${g}, ${b}, ${a})`;",
      "}"
    ].join("\n"),
    "utf8"
  );
  return workspace;
}

async function createInvestigationWorkspace() {
  const workspace = await createSvmWorkspace();
  await mkdir(path.join(workspace, "frontend"), { recursive: true });
  await writeFile(
    path.join(workspace, "frontend", "CustomerFeedbackPanel.tsx"),
    [
      "import { useState } from 'react';",
      "",
      "export function CustomerFeedbackPanel() {",
      "  const [feedback, setFeedback] = useState({ submitting: false, label: 'neutral', message: '' });",
      "  async function submitFeedback(label: 'positive' | 'negative' | 'neutral') {",
      "    setFeedback((state) => ({ ...state, submitting: true, label }));",
      "    await fetch('/api/customer-feedback', { method: 'POST', body: JSON.stringify({ label, message: feedback.message }) });",
      "  }",
      "  return <form onSubmit={() => submitFeedback(feedback.label as any)}><textarea value={feedback.message} /><button>Send feedback</button></form>;",
      "}"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspace, "backend", "services", "action_executor.py"),
    [
      "class ActionExecutor:",
      "    def execute(self, prediction):",
      "        low_gap = prediction.get('probability_gap', 0.0) < 0.12",
      "        if low_gap:",
      "            return {'status': 'review', 'selected_action_name': 'Human Review', 'action_type': 'manual_review', 'observed_outcome': 'awaiting_feedback'}",
      "        return {'status': 'pass', 'selected_action_name': 'Strong Offer', 'action_type': 'retention_offer', 'observed_outcome': 'awaiting_feedback'}"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspace, "backend", "services", "retraining.py"),
    [
      "import csv",
      "RETRAINING_LOG_PATH = 'logs/retraining_log.csv'",
      "",
      "def record_retraining_candidate(customer_id, feedback_label, model_state):",
      "    with open(RETRAINING_LOG_PATH, 'a', newline='') as handle:",
      "        writer = csv.DictWriter(handle, fieldnames=['customer_id', 'feedback_label', 'model_state'])",
      "        writer.writerow({'customer_id': customer_id, 'feedback_label': feedback_label, 'model_state': model_state})",
      "    return {'queued_for_retraining': True}"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspace, "backend", "routes.py"),
    [
      "from fastapi import FastAPI",
      "import csv",
      "from backend.services.clustering import build_customer_segments",
      "from backend.services.svm_model import train_svm_state_detector, predict_customer_state",
      "from backend.services.action_executor import ActionExecutor",
      "from backend.services.retraining import record_retraining_candidate",
      "",
      "app = FastAPI()",
      "CUSTOMER_FEEDBACK_LOG_PATH = 'logs/customer_feedback_log.csv'",
      "",
      "@app.post('/train')",
      "def train_pipeline(payload: dict):",
      "    _, fcm_labels, _ = build_customer_segments(payload['features'])",
      "    return {'trained': str(train_svm_state_detector(payload['features'], fcm_labels))}",
      "",
      "@app.post('/predict')",
      "def predict(payload: dict):",
      "    state, confidence = predict_customer_state(payload['features'])",
      "    action = ActionExecutor().execute({'probability_gap': payload.get('probability_gap', 0.0)})",
      "    return {'state': state.tolist(), 'confidence': confidence.tolist(), 'action': action}",
      "",
      "@app.post('/api/customer-feedback')",
      "def receive_customer_feedback(payload: dict):",
      "    label = payload.get('label')",
      "    if label not in {'positive', 'negative', 'neutral'}:",
      "        return {'status': 'rejected'}",
      "    with open(CUSTOMER_FEEDBACK_LOG_PATH, 'a', newline='') as handle:",
      "        writer = csv.DictWriter(handle, fieldnames=['label', 'message'])",
      "        writer.writerow({'label': label, 'message': payload.get('message', '')})",
      "    retraining = record_retraining_candidate(payload.get('customer_id'), label, payload.get('model_state'))",
      "    return {'status': 'accepted', 'feedback_label': label, 'retraining': retraining}"
    ].join("\n"),
    "utf8"
  );
  await mkdir(path.join(workspace, "tests"), { recursive: true });
  await writeFile(
    path.join(workspace, "tests", "test_feedback.py"),
    [
      "def test_customer_feedback_endpoint_rejects_invalid_label(client):",
      "    response = client.post('/api/customer-feedback', json={'label': 'invalid'})",
      "    assert response.status_code in (200, 422)"
    ].join("\n"),
    "utf8"
  );
  return workspace;
}

async function createMultiAgentDecisionWorkspace() {
  const workspace = await createWorkspace("universal-multi-agent-decision");
  await mkdir(path.join(workspace, "backend", "services"), { recursive: true });
  await writeFile(
    path.join(workspace, "backend", "services", "agents.py"),
    [
      "class BaseAgent:",
      "    agent_name = 'base'",
      "    vote_weight = 1.0",
      "",
      "    def _response(self, action_name, reasoning):",
      "        return {",
      "            'agent_name': self.agent_name,",
      "            'recommended_action_name': action_name,",
      "            'reasoning': reasoning,",
      "            'vote_weight': self.vote_weight,",
      "        }",
      "",
      "class ReliabilityAgent(BaseAgent):",
      "    agent_name = 'reliability'",
      "    vote_weight = 1.4",
      "",
      "    def recommend(self, context):",
      "        if context.get('shap_cosine', 1.0) < 0.60 or context.get('probability_gap', 1.0) < 0.18:",
      "            return self._response('Human Review', 'low confidence or weak SHAP agreement')",
      "        return self._response('Offer', 'reliable enough to automate')",
      "",
      "class ForecastAgent(BaseAgent):",
      "    agent_name = 'forecast'",
      "    vote_weight = 1.1",
      "",
      "    def recommend(self, context):",
      "        if context.get('trend_multiplier', 1.0) < 1.0:",
      "            return self._response('Human Review', 'forecast trend is cooling down')",
      "        if context.get('severity', 0.0) >= 0.75:",
      "            return self._response('Strong Offer', 'high severity with rising trend')",
      "        return self._response('Offer', 'normal churn-risk trend')",
      "",
      "class ClusterHealthAgent(BaseAgent):",
      "    agent_name = 'cluster_health'",
      "    vote_weight = 1.0",
      "",
      "    def recommend(self, context):",
      "        if context.get('drift_detected') and context.get('membership_strength', 1.0) < 0.50:",
      "            return self._response('Re-cluster', 'cluster drift with weak membership')",
      "        return self._response('Offer', 'cluster looks stable')",
      "",
      "def build_default_agents():",
      "    return [ReliabilityAgent(), ForecastAgent(), ClusterHealthAgent()]"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspace, "backend", "services", "orchestrator.py"),
    [
      "from collections import defaultdict",
      "",
      "class ReActOrchestrator:",
      "    def __init__(self):",
      "        self.minimum_score = 0.32",
      "        self.borderline_low = 0.55",
      "        self.direct_dispatch_score = 0.82",
      "",
      "    def choose_route(self, context, retrieval_summary, agent_recommendations):",
      "        weighted_votes = defaultdict(float)",
      "        for recommendation in agent_recommendations:",
      "            weighted_votes[recommendation['recommended_action_name']] += recommendation.get('vote_weight', 1.0)",
      "        weighted_winner = max(weighted_votes, key=weighted_votes.get)",
      "        agent_consensus = weighted_votes[weighted_winner] / max(sum(weighted_votes.values()), 1.0)",
      "        if context.get('score', 0.0) < self.minimum_score:",
      "            return {'route_name': 'reject', 'selected_action_name': 'No Action', 'agent_consensus': agent_consensus}",
      "        if agent_consensus < 0.60 or context.get('score', 0.0) < self.borderline_low:",
      "            return {'route_name': 'review', 'selected_action_name': 'Human Review', 'agent_consensus': agent_consensus}",
      "        return {'route_name': 'dispatch', 'selected_action_name': weighted_winner, 'agent_consensus': agent_consensus}"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspace, "backend", "services", "action_executor.py"),
    [
      "class ActionExecutor:",
      "    def execute(self, selected_action_name, context):",
      "        return {'status': 'executed', 'selected_action_name': selected_action_name, 'customer_id': context.get('customer_id')}"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspace, "backend", "routes.py"),
    [
      "from backend.services.action_executor import ActionExecutor",
      "from backend.services.agents import build_default_agents",
      "from backend.services.orchestrator import ReActOrchestrator",
      "",
      "SYSTEM_STATE = {}",
      "",
      "def startup():",
      "    action_executor = ActionExecutor()",
      "    agents = build_default_agents()",
      "    orchestrator = ReActOrchestrator()",
      "    SYSTEM_STATE['action_executor'] = action_executor",
      "    SYSTEM_STATE['agents'] = agents",
      "    SYSTEM_STATE['orchestrator'] = orchestrator",
      "",
      "def process_customer(model_context, retrieval_summary):",
      "    action_executor = SYSTEM_STATE['action_executor']",
      "    agents = SYSTEM_STATE['agents']",
      "    orchestrator = SYSTEM_STATE['orchestrator']",
      "    agent_recommendations = [agent.recommend(model_context) for agent in agents]",
      "    route_result = orchestrator.choose_route(model_context, retrieval_summary, agent_recommendations)",
      "    execution = action_executor.execute(route_result['selected_action_name'], model_context)",
      "    return {",
      "        'route_name': route_result['route_name'],",
      "        'agent_consensus': route_result['agent_consensus'],",
      "        'agent_recommendations': agent_recommendations,",
      "        'orchestrator_snapshot': route_result,",
      "        'execution': execution,",
      "    }"
    ].join("\n"),
    "utf8"
  );
  return workspace;
}

test("UniversalProjectQuestionEngine finds evidence beyond the old searchCode file cap", async () => {
  const workspace = await createWorkspace("universal-search-cap");
  try {
    await mkdir(path.join(workspace, "aaa"), { recursive: true });
    await mkdir(path.join(workspace, "zzz", "deep"), { recursive: true });
    for (let index = 0; index < 650; index += 1) {
      await writeFile(path.join(workspace, "aaa", `filler-${index}.ts`), `export const filler${index} = ${index};\n`, "utf8");
    }
    await writeFile(
      path.join(workspace, "zzz", "deep", "payment.ts"),
      [
        "export function rarePaymentGatewayAdapter(payload: unknown) {",
        "  return { provider: 'stripe', payload };",
        "}"
      ].join("\n"),
      "utf8"
    );

    const tools = new ToolRegistry(workspace);
    assert.equal(tools.workspace.searchCode("rarePaymentGatewayAdapter", 10).length, 0);

    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: "Where is rarePaymentGatewayAdapter?",
      projectMap
    });
    const result = await answerUniversalProjectQuestion({
      provider: new ThrowingProvider(),
      tools,
      userPrompt: "Where is rarePaymentGatewayAdapter?",
      explainReport: report
    });

    assert.match(result.answerMarkdown, /rarePaymentGatewayAdapter|payment\.ts/);
    assert.match(result.answerMarkdown, /hivo-file:/);
    assert.ok(result.positiveEvidence.some((item) => item.path === "zzz/deep/payment.ts"));
    assert.ok(result.openedFiles.includes("zzz/deep/payment.ts"));
    assert.equal(result.fallbackUsed, true);
    assert.equal(result.answerStrategy.strategy, "local_synthesis_after_provider_failure");
    assert.equal(result.answerStrategy.finalAnswerSource, "local_evidence_synthesis");
    assert.equal(result.answerStrategy.providerDraftStatus, "failed");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine treats provider text as draft, not final authority", async () => {
  const workspace = await createWorkspace("universal-provider-draft-not-authority");
  try {
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await writeFile(
      path.join(workspace, "src", "feedback.ts"),
      [
        "export function submitFeedback(label: 'positive' | 'negative' | 'neutral') {",
        "  return fetch('/api/customer-feedback', { method: 'POST', body: JSON.stringify({ label }) });",
        "}"
      ].join("\n"),
      "utf8"
    );
    const tools = new ToolRegistry(workspace);
    const prompt = "How is feedback applied here?";
    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: prompt,
      projectMap: {
        ...projectMap,
        stack: ["TypeScript"],
        entryPoints: ["src/feedback.ts"],
        importantFiles: ["src/feedback.ts"]
      }
    });
    const provider = new UngroundedProvider();
    const result = await answerUniversalProjectQuestion({
      provider,
      tools,
      userPrompt: prompt,
      explainReport: report
    });

    assert.ok(provider.callCount >= 1);
    assert.equal(result.fallbackUsed, true);
    assert.equal(result.answerStrategy.strategy, "local_synthesis_after_provider_validation_failure");
    assert.equal(result.answerStrategy.finalAnswerSource, "local_evidence_synthesis");
    assert.equal(result.answerStrategy.providerDraftStatus, "failed_local_validation");
    assert.match(result.fallbackReason ?? "", /local_validation_failed|provider_answer_failed_local_validation/i);
    assert.doesNotMatch(result.answerMarkdown, /natural provider answer/i);
    assert.match(result.answerMarkdown, /feedback|customer-feedback|src\/feedback\.ts/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine marks accepted provider answers as provider_final", async () => {
  const workspace = await createWorkspace("universal-provider-final-strategy");
  try {
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await writeFile(
      path.join(workspace, "src", "payment.ts"),
      [
        "export function rarePaymentGatewayAdapter(payload: unknown) {",
        "  return { provider: 'stripe', payload };",
        "}"
      ].join("\n"),
      "utf8"
    );
    const tools = new ToolRegistry(workspace);
    const prompt = "Where is rarePaymentGatewayAdapter?";
    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: prompt,
      projectMap: {
        ...projectMap,
        stack: ["TypeScript"],
        entryPoints: ["src/payment.ts"],
        importantFiles: ["src/payment.ts"]
      }
    });
    const result = await answerUniversalProjectQuestion({
      provider: new GroundedProvider(
        "`rarePaymentGatewayAdapter` is defined in `src/payment.ts`; it returns a Stripe-tagged payload wrapper. [src/payment.ts:1](hivo-file:src%2Fpayment.ts:1)",
        ["src/payment.ts:1"]
      ),
      tools,
      userPrompt: prompt,
      explainReport: report
    });

    assert.equal(result.fallbackUsed, false);
    assert.equal(result.answerStrategy.strategy, "provider_final");
    assert.equal(result.answerStrategy.finalAnswerSource, "provider");
    assert.equal(result.answerStrategy.providerDraftStatus, "accepted_first");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine notice-only mode does not let forced agentic kernel replace provider final", async () => {
  const workspace = await createWorkspace("universal-provider-final-no-agentic-replace");
  const previousMode = process.env.HIVO_AGENTIC_TASK_KERNEL_MODE;
  const previousUse = process.env.HIVO_PROJECT_EXPLAIN_USE_AGENTIC_KERNEL;
  process.env.HIVO_AGENTIC_TASK_KERNEL_MODE = "force";
  process.env.HIVO_PROJECT_EXPLAIN_USE_AGENTIC_KERNEL = "1";
  try {
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await writeFile(
      path.join(workspace, "src", "payment.ts"),
      [
        "export function rarePaymentGatewayAdapter(payload: unknown) {",
        "  return { provider: 'stripe', payload };",
        "}"
      ].join("\n"),
      "utf8"
    );
    const tools = new ToolRegistry(workspace);
    const prompt = "Where is rarePaymentGatewayAdapter?";
    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: prompt,
      projectMap: {
        ...projectMap,
        stack: ["TypeScript"],
        entryPoints: ["src/payment.ts"],
        importantFiles: ["src/payment.ts"]
      }
    });
    const result = await answerUniversalProjectQuestionRaw({
      provider: new GroundedProvider(
        "`rarePaymentGatewayAdapter` is defined in `src/payment.ts`; it returns a Stripe-tagged payload wrapper. [src/payment.ts:1](hivo-file:src%2Fpayment.ts:1)",
        ["src/payment.ts:1"]
      ),
      tools,
      userPrompt: prompt,
      explainReport: report
    });

    assert.equal(result.answerStrategy.strategy, "provider_final");
    assert.equal(result.answerStrategy.finalAnswerSource, "provider");
    assert.notEqual(result.answerStrategy.strategy, "agentic_kernel_after_provider_fallback");
  } finally {
    if (previousMode === undefined) delete process.env.HIVO_AGENTIC_TASK_KERNEL_MODE;
    else process.env.HIVO_AGENTIC_TASK_KERNEL_MODE = previousMode;
    if (previousUse === undefined) delete process.env.HIVO_PROJECT_EXPLAIN_USE_AGENTIC_KERNEL;
    else process.env.HIVO_PROJECT_EXPLAIN_USE_AGENTIC_KERNEL = previousUse;
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine stops weak local synthesis instead of inventing a confident fallback", async () => {
  const workspace = await createWorkspace("universal-weak-evidence-notice");
  try {
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await writeFile(path.join(workspace, "src", "index.ts"), "export const appName = 'ordinary-app';\n", "utf8");
    const tools = new ToolRegistry(workspace);
    const prompt = "How is neuralRewardEngine applied here?";
    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: prompt,
      projectMap: {
        ...projectMap,
        stack: ["TypeScript"],
        entryPoints: ["src/index.ts"],
        importantFiles: ["src/index.ts"]
      }
    });
    const result = await answerUniversalProjectQuestion({
      provider: new ThrowingProvider(),
      tools,
      userPrompt: prompt,
      explainReport: report
    });

    assert.equal(result.fallbackUsed, true);
    assert.equal(result.answerStrategy.strategy, "insufficient_evidence_notice");
    assert.equal(result.answerStrategy.finalAnswerSource, "local_notice");
    assert.match(result.answerMarkdown, /will not synthesize|weak evidence/i);
    assert.doesNotMatch(result.answerMarkdown, /strongest local evidence|I searched for `neuralRewardEngine`/i);
    assert.equal(result.evidenceRefs.length, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine refuses judgment questions from documentation-only name matches", async () => {
  const workspace = await createWorkspace("universal-judgment-weak-evidence");
  try {
    await mkdir(path.join(workspace, "docs"), { recursive: true });
    await writeFile(
      path.join(workspace, "docs", "notes.md"),
      [
        "# Reward Notes",
        "",
        "The reward logic is planned for a future experiment.",
        "A future reward score may compare suggested actions.",
        "No implementation is included here."
      ].join("\n"),
      "utf8"
    );
    const tools = new ToolRegistry(workspace);
    const prompt = "Is the reward logic correct or wrong?";
    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: prompt,
      projectMap: {
        ...projectMap,
        stack: ["Markdown"],
        entryPoints: ["docs/notes.md"],
        importantFiles: ["docs/notes.md"]
      }
    });
    const result = await answerUniversalProjectQuestion({
      provider: new ThrowingProvider(),
      tools,
      userPrompt: prompt,
      explainReport: report
    });

    assert.equal(result.questionUnderstanding.wantsJudgment, true);
    assert.equal(result.fallbackUsed, true);
    assert.equal(result.answerStrategy.strategy, "insufficient_evidence_notice");
    assert.equal(result.answerStrategy.finalAnswerSource, "local_notice");
    assert.match(result.answerMarkdown, /will not synthesize|weak evidence|not enough/i);
    assert.doesNotMatch(result.answerMarkdown, /strongest local evidence|wrong because|the logic is correct|the logic is wrong/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine labels fixture-generated paths and does not cite them as production evidence", async () => {
  const workspace = await createWorkspace("universal-provenance-fixture-paths");
  try {
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await writeFile(
      path.join(workspace, "src", "orchestrator.ts"),
      [
        "export function runOuterLoop(decision: string, feedback: string) {",
        "  const action = decision === 'review' ? 'human_review' : 'apply_patch';",
        "  return { action, feedback, nextDecision: feedback ? 'retry' : 'done' };",
        "}"
      ].join("\n"),
      "utf8"
    );
    await mkdir(path.join(workspace, "tests"), { recursive: true });
    await writeFile(
      path.join(workspace, "tests", "universal-project-question.test.ts"),
      [
        "import { writeFile } from 'node:fs/promises';",
        "import path from 'node:path';",
        "test('fixture mock outerloop', async () => {",
        "  await writeFile(path.join(workspace, 'backend', 'services', 'action_executor.py'), 'outerloop mock');",
        "});"
      ].join("\n"),
      "utf8"
    );
    const tools = new ToolRegistry(workspace);
    const prompt = "How is outerloop implemented here? Explain in detail.";
    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: prompt,
      projectMap: {
        ...projectMap,
        stack: ["TypeScript"],
        entryPoints: ["src/orchestrator.ts"],
        importantFiles: ["src/orchestrator.ts"]
      }
    });
    const result = await answerUniversalProjectQuestion({
      provider: new ThrowingProvider(),
      tools,
      userPrompt: prompt,
      explainReport: report
    });

    assert.equal(result.conceptResolution.resolutionStatus, "direct_found");
    assert.ok(result.positiveEvidence.some((item) => item.path === "src/orchestrator.ts" && item.provenance?.sourceType === "production_source"));
    assert.ok(result.evidenceReport.rejectedEvidence?.some((item) => item.sourceFile === "tests/universal-project-question.test.ts" && item.sourceType === "fixture_generated_path"));
    assert.doesNotMatch(result.answerMarkdown, /backend\/services\/action_executor\.py/);
    assert.equal(result.evidenceReport.finalEvidenceFilesActuallyUsed.includes("backend/services/action_executor.py"), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Project Investigation Kernel v1 resolves DBSCAN, feedback, outerloop, and feedback-change prompts", async () => {
  const workspace = await createInvestigationWorkspace();
  try {
    const tools = new ToolRegistry(workspace);
    const reportFor = (message: string) => buildLargeProjectExplainReport({
      workspacePath: workspace,
      message,
      projectMap: {
        ...projectMap,
        stack: ["Python", "React"],
        entryPoints: ["backend/routes.py", "frontend/CustomerFeedbackPanel.tsx"],
        importantFiles: [
          "backend/routes.py",
          "backend/services/clustering.py",
          "backend/services/action_executor.py",
          "backend/services/retraining.py",
          "frontend/CustomerFeedbackPanel.tsx"
        ]
      }
    });
    const ask = (message: string) => answerUniversalProjectQuestion({
      provider: new ThrowingProvider(),
      tools,
      userPrompt: message,
      explainReport: reportFor(message)
    });

    const dbscan = await ask("ازاي الDBSCAN بيتطبق هنا؟ اشرح بالتفصيل");
    assert.equal(dbscan.intent.actionMode, "answer_only");
    assert.equal(dbscan.questionUnderstanding.targetConcept, "dbscan");
    assert.equal(dbscan.conceptResolution.resolutionStatus, "direct_found");
    assert.ok(dbscan.conceptFlow.steps.some((step) => step.outputNames.includes("dbscan_labels")));
    assert.ok(dbscan.conceptFlow.steps.some((step) => step.nextConsumers.includes("fit_fcm") || step.nextConsumers.includes("X_clean")));
    assert.doesNotMatch(dbscan.answerMarkdown, /No local matches for query/i);

    const feedback = await ask("ازاي الfeedback بيتطبق هنا؟ اشرح بالتفصيل");
    assert.equal(feedback.intent.actionMode, "answer_only");
    assert.equal(feedback.questionUnderstanding.targetConcept, "feedback");
    assert.equal(feedback.mechanismChain.status, "confirmed");
    assert.ok(feedback.mechanismChain.steps.some((step) => step.relation === "frontend_to_api" && step.to === "/api/customer-feedback"));
    assert.ok(feedback.mechanismChain.steps.some((step) => step.relation === "api_to_backend" && step.from === "/api/customer-feedback"));
    assert.ok(feedback.mechanismChain.steps.every((step) => step.relation !== "api_to_backend" || step.from !== "/train"));
    assert.ok(feedback.testEndpointExpectations.some((item) => item.endpoint === "/api/customer-feedback"));
    assert.equal(feedback.mechanismEvidence.apiLinkEvidence.some((item) => /tests\//.test(item.path)), false);
    assert.ok(feedback.targetScopedStorageEvidence.some((item) => item.storageTarget === "CUSTOMER_FEEDBACK_LOG_PATH" && (item.role === "log_append" || item.role === "storage_write")));
    assert.ok(feedback.mechanismChain.steps.every((step) => step.status === "proven" || step.status === "partial" || step.status === "unproven"));
    assert.doesNotMatch(feedback.answerMarkdown, /No local matches for query|ui_state|backend_route|mechanismCoverageValidation/i);

    const outerloop = await ask("ازاي الouterloop بيتطبق هنا؟ اشرح بالتفصيل");
    assert.equal(outerloop.questionUnderstanding.targetConcept, "outerloop");
    assert.notEqual(outerloop.conceptResolution.resolutionStatus, "not_found");
    assert.ok(outerloop.conceptResolution.inferredPatternName);
    assert.ok(outerloop.mechanismChain.steps.some((step) => step.relation === "decision_action_stage"));
    assert.ok(outerloop.mechanismChain.steps.some((step) => step.relation === "feedback_or_outcome_stage"));
    assert.doesNotMatch(outerloop.answerMarkdown, /upstream-clustering\s*->\s*training\s*->\s*prediction/i);
    assert.doesNotMatch(outerloop.answerMarkdown, /No local matches for query/i);
    assert.doesNotMatch(outerloop.answerMarkdown, /لقيت `outerloop` كدليل مباشر/);
    assert.match(outerloop.answerMarkdown, /مسار الحلقة من الأدلة/);
    assert.match(outerloop.answerMarkdown, /حدود الثقة/);

    const stalePrompt = "\u0627\u0632\u0627\u064a \u0627\u0644outerloop \u0628\u064a\u062a\u0637\u0628\u0642 \u0647\u0646\u0627 \u061f \u0627\u0634\u0631\u062d \u0628\u0627\u0644\u062a\u0641\u0635\u064a\u0644";
    const staleProviderOuterloop = await answerUniversalProjectQuestion({
      provider: new StaleOuterloopProvider(),
      tools,
      userPrompt: stalePrompt,
      explainReport: reportFor(stalePrompt)
    });
    assert.equal(staleProviderOuterloop.fallbackUsed, true);
    assert.doesNotMatch(staleProviderOuterloop.answerMarkdown, /model\/decision\/action/);
    assert.match(staleProviderOuterloop.answerMarkdown, /model\/score\/context|source=`production_source`/);

    const innerOuter = await ask("هل فيه inner loop و outer loop هنا؟ الفرق بينهم ايه؟");
    assert.equal(innerOuter.questionUnderstanding.targetConcept, "inner_outer_loop");
    assert.notEqual(innerOuter.conceptResolution.resolutionStatus, "not_found");
    assert.ok(innerOuter.mechanismChain.steps.some((step) => step.relation === "decision_action_stage" || step.relation === "inner_model_decision"));
    assert.doesNotMatch(innerOuter.answerMarkdown, /No local matches for query/i);

    const feedbackChangesPrompt = "الفيدباك بيغير ايه في السيستم بعد ما اليوزر يبعت positive او negative او neutral؟";
    const feedbackIntent = inferWorkspaceIntent(feedbackChangesPrompt);
    assert.equal(feedbackIntent.actionMode, "answer_only");
    const feedbackChanges = await ask(feedbackChangesPrompt);
    assert.equal(feedbackChanges.intent.actionMode, "answer_only");
    assert.equal(feedbackChanges.questionUnderstanding.targetConcept, "feedback");
    assert.ok(feedbackChanges.conceptResolution.labelsOrModifiers.includes("positive"));
    assert.ok(feedbackChanges.conceptResolution.labelsOrModifiers.includes("negative"));
    assert.ok(feedbackChanges.conceptResolution.labelsOrModifiers.includes("neutral"));
    assert.ok(feedbackChanges.mechanismChain.steps.some((step) => step.relation === "backend_to_storage"));
    assert.doesNotMatch(feedbackChanges.answerMarkdown, /No local matches for query|positive` كدليل مستقل|target concept.*positive/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine explains Arabic multi-agent architecture from actual agents and orchestrator wiring", async () => {
  const workspace = await createMultiAgentDecisionWorkspace();
  try {
    const tools = new ToolRegistry(workspace);
    const prompt = "ازاي الmulti agentic system هنا بيتطبق وهل دا المنطقي ولا هو متطبق ب شكل غلط ؟";
    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: prompt,
      projectMap: {
        ...projectMap,
        stack: ["Python"],
        entryPoints: ["backend/routes.py"],
        importantFiles: [
          "backend/routes.py",
          "backend/services/agents.py",
          "backend/services/orchestrator.py",
          "backend/services/action_executor.py"
        ]
      }
    });
    const result = await answerUniversalProjectQuestion({
      provider: new ThrowingProvider(),
      tools,
      userPrompt: prompt,
      explainReport: report
    });

    assert.equal(result.intent.actionMode, "answer_only");
    assert.equal(result.questionUnderstanding.targetConcept, "multi_agent_system");
    assert.equal(result.answerShapeValidation.valid, true);
    assert.match(result.answerMarkdown, /build_default_agents|ReActOrchestrator|orchestrator\.choose_route|agent_recommendations|agent_consensus|ActionExecutor/);
    assert.match(result.answerMarkdown, /multi-agentic|orchestrator|agents/);
    assert.match(result.answerMarkdown, /منطقي|مقبول|استشار|خفيف/);
    assert.doesNotMatch(result.answerMarkdown, /multi implementation|The implementation applies multi|The implementation applies multi_agent_system/i);
    assert.doesNotMatch(result.answerMarkdown, /backend\/routes\.py:1\b/);
    assert.doesNotMatch(result.answerMarkdown, /ط§|ظ„|ظ…/);
    assert.ok(result.positiveEvidence.some((item) => item.path === "backend/services/agents.py" && /build_default_agents|ReliabilityAgent|ForecastAgent|ClusterHealthAgent/.test(item.snippet ?? "")));
    assert.ok(result.positiveEvidence.some((item) => item.path === "backend/services/orchestrator.py" && /choose_route|weighted_votes/.test(item.snippet ?? "")));
    assert.ok(result.positiveEvidence.some((item) => item.path === "backend/routes.py" && /agent_recommendations|orchestrator\.choose_route/.test(item.snippet ?? "")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine accepts provider decision-policy answers without forecasting validation", async () => {
  const workspace = await createMultiAgentDecisionWorkspace();
  const provider = new NaturalDecisionPolicyProvider();
  try {
    const tools = new ToolRegistry(workspace);
    const prompt = "\u0627\u0645\u062a\u0649 \u0627\u0644\u0646\u0638\u0627\u0645 \u064a\u0642\u0631\u0631 Re-cluster \u0628\u062f\u0644 \u0645\u0627 \u064a\u0628\u0639\u062a offer\u061f \u0627\u0631\u0628\u0637 \u0625\u062c\u0627\u0628\u062a\u0643 \u0628\u064a\u0646 drift detection \u0648 FCM membership \u0648 orchestrator rules.";
    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: prompt,
      projectMap: {
        ...projectMap,
        stack: ["Python"],
        entryPoints: ["backend/routes.py"],
        importantFiles: [
          "backend/routes.py",
          "backend/services/agents.py",
          "backend/services/orchestrator.py",
          "backend/services/action_executor.py"
        ]
      }
    });
    const result = await answerUniversalProjectQuestionRaw({
      provider,
      tools,
      userPrompt: prompt,
      explainReport: report,
    });

    assert.equal(provider.structuredCalls <= 1, true);
    assert.ok(provider.textCalls >= 1);
    assert.equal(result.grounding.questionKind, "decision_policy");
    assert.equal(result.fallbackUsed, false, JSON.stringify({
      fallbackReason: result.fallbackReason,
      validationErrors: result.validationErrors,
      unsupportedOrUnclearParts: result.unsupportedOrUnclearParts,
      answerShapeValidation: result.answerShapeValidation,
      targetConcept: result.questionUnderstanding.targetConcept,
      answerMarkdown: result.answerMarkdown
    }, null, 2));
    assert.equal(result.answerStrategy.strategy, "provider_final");
    assert.equal(result.answerStrategy.finalAnswerSource, "provider");
    assert.equal(result.answerShapeValidation.valid, true);
    assert.doesNotMatch(result.fallbackReason ?? "", /Forecasting answer|Downstream stage/i);
    assert.match(result.answerMarkdown, /drift_detected|membership_strength|ClusterHealthAgent|Re-cluster|Offer|agent_recommendations|weighted_votes|agent_consensus|choose_route/);
    assert.match(result.answerMarkdown, /backend\/services\/agents\.py|backend\/services\/orchestrator\.py|backend\/routes\.py/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine accepts human review policy answers using aliases instead of internal concept keys", async () => {
  const workspace = await createMultiAgentDecisionWorkspace();
  const provider = new NaturalHumanReviewPolicyProvider();
  try {
    const tools = new ToolRegistry(workspace);
    const prompt = "When does the orchestrator direct dispatch, and when does it send Human Review even if agents propose an action?";
    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: prompt,
      projectMap: {
        ...projectMap,
        stack: ["Python"],
        entryPoints: ["backend/routes.py"],
        importantFiles: [
          "backend/routes.py",
          "backend/services/agents.py",
          "backend/services/orchestrator.py",
          "backend/services/action_executor.py"
        ]
      }
    });
    const result = await answerUniversalProjectQuestionRaw({
      provider,
      tools,
      userPrompt: prompt,
      explainReport: report,
    });

    assert.equal(provider.structuredCalls <= 1, true);
    assert.ok(provider.textCalls >= 1);
    assert.equal(result.questionUnderstanding.targetConcept, "human_review_loop");
    assert.equal(result.fallbackUsed, false, JSON.stringify({
      fallbackReason: result.fallbackReason,
      validationErrors: result.validationErrors,
      unsupportedOrUnclearParts: result.unsupportedOrUnclearParts,
      answerMarkdown: result.answerMarkdown
    }, null, 2));
    assert.equal(result.answerStrategy.strategy, "provider_final");
    assert.equal(result.answerStrategy.finalAnswerSource, "provider");
    assert.equal(result.answerShapeValidation.valid, true);
    assert.equal(result.coverageValidation.valid, true);
    assert.doesNotMatch(result.answerMarkdown, /human_review_loop/);
    assert.match(result.answerMarkdown, /Human Review|route_name: 'review'|agent_consensus|direct dispatch|ActionExecutor/);
    assert.match(result.answerMarkdown, /backend\/services\/agents\.py|backend\/services\/orchestrator\.py|backend\/routes\.py/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine accepts Arabic human-review policy wording without memorized fallback", async () => {
  const workspace = await createMultiAgentDecisionWorkspace();
  const provider = new ArabicHumanReviewPolicyProvider();
  try {
    const tools = new ToolRegistry(workspace);
    const prompt = "امتى الـ orchestrator يعمل direct dispatch؟ وامتى يحوّل لـ human review حتى لو فيه agents بتقترح action؟";
    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: prompt,
      projectMap: {
        ...projectMap,
        stack: ["Python"],
        entryPoints: ["backend/routes.py"],
        importantFiles: [
          "backend/routes.py",
          "backend/services/agents.py",
          "backend/services/orchestrator.py",
          "backend/services/action_executor.py"
        ]
      }
    });
    const result = await answerUniversalProjectQuestionRaw({
      provider,
      tools,
      userPrompt: prompt,
      explainReport: report,
    });

    assert.equal(provider.structuredCalls <= 1, true);
    assert.ok(provider.textCalls >= 1);
    assert.equal(result.questionUnderstanding.targetConcept, "human_review_loop");
    assert.equal(result.fallbackUsed, false, JSON.stringify({
      fallbackReason: result.fallbackReason,
      validationErrors: result.validationErrors,
      unsupportedOrUnclearParts: result.unsupportedOrUnclearParts,
      answerMarkdown: result.answerMarkdown
    }, null, 2));
    assert.equal(result.answerStrategy.strategy, "provider_final");
    assert.equal(result.answerStrategy.finalAnswerSource, "provider");
    assert.equal(result.answerShapeValidation.valid, true);
    assert.equal(result.coverageValidation.valid, true);
    assert.doesNotMatch(result.answerMarkdown, /local synthesis was not used|provider_validation_notice|human_review_loop/i);
    assert.match(result.answerMarkdown, /المراجعة البشرية|التنفيذ المباشر|agent_consensus|ActionExecutor/);
    assert.match(result.answerMarkdown, /backend\/services\/agents\.py|backend\/services\/orchestrator\.py|backend\/routes\.py/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine rejects not-found provider text when local evidence exists", async () => {
  const workspace = await createWorkspace("universal-not-found-override");
  try {
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await writeFile(
      path.join(workspace, "src", "analytics.ts"),
      [
        "export class CustomerRiskScorer {",
        "  score(customer: { churnRisk: number }) {",
        "    return customer.churnRisk;",
        "  }",
        "}"
      ].join("\n"),
      "utf8"
    );

    const tools = new ToolRegistry(workspace);
    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: "Where is CustomerRiskScorer?",
      projectMap
    });
    const result = await answerUniversalProjectQuestion({
      provider: new NotFoundProvider(["src/analytics.ts:1"]),
      tools,
      userPrompt: "Where is CustomerRiskScorer?",
      explainReport: report
    });

    assert.match(result.answerMarkdown, /CustomerRiskScorer|analytics\.ts/);
    assert.match(result.answerMarkdown, /hivo-file:/);
    assert.ok(result.validationErrors.length > 0);
    assert.doesNotMatch(result.answerMarkdown, /could not find/i);
    assert.equal(result.fallbackUsed, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine expands detailed SVM flow instead of accepting shallow bullets", async () => {
  const workspace = await createSvmWorkspace();
  try {
    const tools = new ToolRegistry(workspace);
    const detailedPrompt = "How is SVM applied here? Explain in detail with code snippets.";
    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: detailedPrompt,
      projectMap: {
        ...projectMap,
        stack: ["Python"],
        entryPoints: ["backend/routes.py"],
        importantFiles: ["backend/routes.py", "backend/services/svm_model.py", "backend/services/clustering.py", "backend/services/shap_explainer.py"]
      }
    });
    const result = await answerUniversalProjectQuestion({
      provider: new ShortDetailedProvider(),
      tools,
      userPrompt: detailedPrompt,
      explainReport: report
    });

    assert.equal(result.questionUnderstanding.detailLevel, "detailed");
    assert.equal(result.questionUnderstanding.wantsCodeExamples, true);
    assert.equal(result.answerShapeValidation.valid, true);
    assert.equal(result.answerShapeValidation.tooShallow, false);
    assert.ok(result.answerShapeValidation.repairedFrom?.some((error) => /too shallow|too few sections/i.test(error)));
    assert.ok(result.answerMarkdown.length >= 900);
    assert.ok(result.answerShapeValidation.sectionCount >= 3);
    assert.match(result.answerMarkdown, /## Summary|## الخلاصة/);
    assert.match(result.answerMarkdown, /training|SVC|fit|labels/i);
    assert.match(result.answerMarkdown, /prediction|predict|predict_proba/i);
    assert.match(result.answerMarkdown, /SHAP|KernelExplainer|explainability/i);
    assert.match(result.answerMarkdown, /API|route|service flow|\/predict/i);
    assert.match(result.answerMarkdown, /joblib|persistence|load_svm_state_detector/i);
    assert.match(result.answerMarkdown, /```/);
    assert.match(result.answerMarkdown, /hivo-file:/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine explains feedback UI-only evidence without inventing backend wiring", async () => {
  const workspace = await createWorkspace("universal-feedback-ui-only");
  try {
    await mkdir(path.join(workspace, "frontend"), { recursive: true });
    await writeFile(
      path.join(workspace, "frontend", "CustomerFeedbackPanel.tsx"),
      [
        "import { useState } from 'react';",
        "",
        "export function CustomerFeedbackPanel() {",
        "  const [feedback, setFeedback] = useState({ submitting: false, message: '' });",
        "  return <form><textarea value={feedback.message} /></form>;",
        "}"
      ].join("\n"),
      "utf8"
    );
    const tools = new ToolRegistry(workspace);
    const prompt = "ازاي feedback بيتطبق هنا؟ اشرح بالتفصيل";
    const report = buildLargeProjectExplainReport({ workspacePath: workspace, message: prompt, projectMap });
    const result = await answerUniversalProjectQuestion({
      provider: new ThrowingProvider(),
      tools,
      userPrompt: prompt,
      explainReport: report
    });

    assert.equal(result.questionUnderstanding.targetConcept, "feedback");
    assert.equal(result.mechanismChain.status, "partial");
    assert.ok(result.missingMechanismLinks.includes("frontend_to_backend_request"));
    assert.match(result.answerMarkdown, /الواجهة|state|واجهة/);
    assert.match(result.answerMarkdown, /لم أجد.*request|لم أجد.*backend|غير مثبت/);
    assert.doesNotMatch(result.answerMarkdown, /Action|Testing|section|lede|Tracks|how/);
    assert.doesNotMatch(result.answerMarkdown, /\bui_state\b|\bbackend_route\b|directMechanismEvidence/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine does not treat feedback endpoint tests as frontend flow", async () => {
  const workspace = await createWorkspace("universal-feedback-test-only");
  try {
    await mkdir(path.join(workspace, "tests"), { recursive: true });
    await writeFile(
      path.join(workspace, "tests", "test_feedback.py"),
      [
        "def test_customer_feedback_endpoint_rejects_invalid_label(client):",
        "    response = client.post('/api/customer-feedback', json={'label': 'invalid'})",
        "    assert response.status_code == 422"
      ].join("\n"),
      "utf8"
    );
    const tools = new ToolRegistry(workspace);
    const prompt = "ازاي feedback بيتطبق هنا؟ اشرح بالتفصيل";
    const report = buildLargeProjectExplainReport({ workspacePath: workspace, message: prompt, projectMap });
    const result = await answerUniversalProjectQuestion({
      provider: new ThrowingProvider(),
      tools,
      userPrompt: prompt,
      explainReport: report
    });

    assert.equal(result.mechanismChain.status, "partial");
    assert.ok(result.testEndpointExpectations.some((item) => item.endpoint === "/api/customer-feedback"));
    assert.equal(result.mechanismEvidence.apiLinkEvidence.length, 0);
    assert.match(result.answerMarkdown, /الاختبارات|endpoint متوقع|لا تثبت أن الواجهة/);
    assert.doesNotMatch(result.answerMarkdown, /حلقة الربط التي تثبت أن الكود يحاول إرسال البيانات خارج الواجهة/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine rejects general storage as feedback log evidence", async () => {
  const workspace = await createWorkspace("universal-feedback-general-storage");
  try {
    await mkdir(path.join(workspace, "backend", "services"), { recursive: true });
    await writeFile(
      path.join(workspace, "backend", "services", "data_generator.py"),
      [
        "CUSTOMERS_PATH = 'data/generated_customers.csv'",
        "",
        "def save_dataset(customers_df):",
        "    output_path = CUSTOMERS_PATH",
        "    customers_df.to_csv(output_path, index=False)",
        "    return output_path"
      ].join("\n"),
      "utf8"
    );
    const tools = new ToolRegistry(workspace);
    const prompt = "ازاي feedback بيتطبق هنا؟ اشرح بالتفصيل";
    const report = buildLargeProjectExplainReport({ workspacePath: workspace, message: prompt, projectMap });
    const result = await answerUniversalProjectQuestion({
      provider: new ThrowingProvider(),
      tools,
      userPrompt: prompt,
      explainReport: report
    });

    assert.notEqual(result.mechanismChain.status, "confirmed");
    assert.ok(result.generalStorageEvidence.some((item) => item.storageTarget === "CUSTOMERS_PATH"));
    assert.equal(result.targetScopedStorageEvidence.some((item) => item.storageTarget === "CUSTOMERS_PATH"), false);
    assert.doesNotMatch(result.answerMarkdown, /CUSTOMERS_PATH.*يثبت|save_dataset.*feedback storage|to_csv.*feedback/);
    assert.match(result.answerMarkdown, /تخزينًا عامًا|غير مربوط/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine narrates confirmed feedback frontend API backend log flow", async () => {
  const workspace = await createWorkspace("universal-feedback-full-flow");
  try {
    await mkdir(path.join(workspace, "frontend"), { recursive: true });
    await mkdir(path.join(workspace, "backend"), { recursive: true });
    await writeFile(
      path.join(workspace, "frontend", "CustomerFeedbackPanel.tsx"),
      [
        "import { useState } from 'react';",
        "",
        "export function CustomerFeedbackPanel() {",
        "  const [feedback, setFeedback] = useState({ submitting: false, message: '' });",
        "  async function submitFeedback() {",
        "    await fetch('/api/customer-feedback', { method: 'POST', body: JSON.stringify(feedback) });",
        "  }",
        "  return <form onSubmit={submitFeedback}><textarea value={feedback.message} /></form>;",
        "}"
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(workspace, "backend", "routes.py"),
      [
        "from fastapi import FastAPI",
        "import csv",
        "",
        "app = FastAPI()",
        "CUSTOMER_FEEDBACK_LOG_PATH = 'logs/customer_feedback_log.csv'",
        "",
        "@app.post('/api/customer-feedback')",
        "def receive_customer_feedback(payload: dict):",
        "    with open(CUSTOMER_FEEDBACK_LOG_PATH, 'a', newline='') as handle:",
        "        writer = csv.DictWriter(handle, fieldnames=['message'])",
        "        writer.writerow({'message': payload.get('message', '')})",
        "    return {'ok': True}"
      ].join("\n"),
      "utf8"
    );
    const tools = new ToolRegistry(workspace);
    const prompt = "ازاي feedback بيتطبق هنا؟ اشرح بالتفصيل";
    const report = buildLargeProjectExplainReport({ workspacePath: workspace, message: prompt, projectMap });
    const result = await answerUniversalProjectQuestion({
      provider: new ThrowingProvider(),
      tools,
      userPrompt: prompt,
      explainReport: report
    });

    assert.equal(result.mechanismChain.status, "confirmed");
    assert.match(result.answerMarkdown, /\/api\/customer-feedback/);
    assert.match(result.answerMarkdown, /CUSTOMER_FEEDBACK_LOG_PATH|customer_feedback_log/);
    assert.match(result.answerMarkdown, /الواجهة/);
    assert.match(result.answerMarkdown, /backend|الـ backend/);
    assert.doesNotMatch(result.answerMarkdown, /\bui_state\b|\bbackend_route\b|mechanismCoverageValidation/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine follows apiPost feedback helper and backend log helper flow", async () => {
  const workspace = await createWorkspace("universal-feedback-apipost-helper-flow");
  try {
    await mkdir(path.join(workspace, "frontend"), { recursive: true });
    await mkdir(path.join(workspace, "backend"), { recursive: true });
    await writeFile(
      path.join(workspace, "frontend", "app.js"),
      [
        "const stateStore = { apiBase: '/api', feedback: { submitting: false, latest: null } };",
        "",
        "async function apiPost(path, payload = {}) {",
        "  return fetch(`${stateStore.apiBase}${path}`, {",
        "    method: 'POST',",
        "    headers: { 'Content-Type': 'application/json' },",
        "    body: JSON.stringify(payload),",
        "  });",
        "}",
        "",
        ...Array.from({ length: 2200 }, (_, index) => `const fillerLine${index} = 'large frontend file padding ${index}';`),
        "",
        "async function submitCustomerFeedback(responseLabel) {",
        "  stateStore.feedback.submitting = true;",
        "  return apiPost('/customer-feedback', { customer_id: 100001, response_label: responseLabel });",
        "}"
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(workspace, "backend", "main.py"),
      [
        "from fastapi import FastAPI",
        "from backend.routes import router",
        "app = FastAPI()",
        "app.include_router(router, prefix='/api')"
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(workspace, "backend", "routes.py"),
      [
        "from fastapi import APIRouter",
        "router = APIRouter()",
        "CUSTOMER_FEEDBACK_LOG_PATH = 'data/customer_feedback_log.csv'",
        "",
        "def _append_customer_feedback_log(payload):",
        "    payload.to_csv(CUSTOMER_FEEDBACK_LOG_PATH, mode='a')",
        "",
        "def submit_customer_feedback(payload):",
        "    feedback_event = {'response_label': payload.response_label, 'should_trigger_outer_loop': False}",
        "    _append_customer_feedback_log(feedback_event)",
        "    if payload.response_label == 'negative':",
        "        feedback_event['should_trigger_outer_loop'] = True",
        "        retrain_with_rollback('customer feedback negative')",
        "    return {'status': 'recorded', 'feedback': feedback_event}",
        "",
        "@router.post('/customer-feedback')",
        "def customer_feedback_endpoint(payload):",
        "    return submit_customer_feedback(payload)"
      ].join("\n"),
      "utf8"
    );

    const tools = new ToolRegistry(workspace);
    const prompt = "How is feedback applied here, and is it logical or wired incorrectly?";
    const report = buildLargeProjectExplainReport({ workspacePath: workspace, message: prompt, projectMap });
    const result = await answerUniversalProjectQuestion({
      provider: new ThrowingProvider(),
      tools,
      userPrompt: prompt,
      explainReport: report
    });

    assert.equal(result.questionUnderstanding.targetConcept, "feedback");
    assert.equal(result.mechanismChain.status, "confirmed");
    assert.ok(result.mechanismChain.steps.some((step) => step.relation === "frontend_to_api" && step.status === "proven"));
    assert.ok(result.mechanismChain.steps.some((step) => step.relation === "api_to_backend" && step.status === "proven"));
    assert.ok(result.mechanismChain.steps.some((step) => step.relation === "backend_to_storage" && step.status === "proven"));
    assert.equal(result.missingMechanismLinks.includes("frontend_to_backend_request"), false);
    assert.equal(result.missingMechanismLinks.includes("backend_feedback_handler"), false);
    assert.equal(result.missingMechanismLinks.includes("feedback_storage_or_log_usage"), false);
    assert.match(result.answerMarkdown, /\/customer-feedback|customer_feedback_log|CUSTOMER_FEEDBACK_LOG_PATH/);
    assert.doesNotMatch(result.answerMarkdown, /frontend_to_backend_request|backend_feedback_handler|feedback_storage_or_log_usage|not proven.*backend|no matching route/i);

    const negativePrompt = "If feedback is negative, is it only logged or does it actually trigger retraining?";
    const negativeReport = buildLargeProjectExplainReport({ workspacePath: workspace, message: negativePrompt, projectMap });
    const negativeResult = await answerUniversalProjectQuestion({
      provider: new ThrowingProvider(),
      tools,
      userPrompt: negativePrompt,
      explainReport: negativeReport
    });
    assert.equal(negativeResult.questionUnderstanding.targetConcept, "feedback");
    assert.equal(negativeResult.conceptResolution.labelsOrModifiers.includes("negative"), true);
    assert.equal(negativeResult.conceptResolution.secondaryConcepts.includes("retraining_loop"), true);
    assert.match(negativeResult.answerMarkdown, /negative|سلبي|should_trigger_outer_loop|retrain_with_rollback|retraining/i);
    assert.doesNotMatch(negativeResult.answerMarkdown, /`retraining_loop` here appears|الـ `retraining_loop` هنا/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine keeps detailed DBSCAN answers centered on DBSCAN implementation", async () => {
  const workspace = await createSvmWorkspace();
  try {
    const tools = new ToolRegistry(workspace);
    const prompt = "ازاي الdbscan بيتطبق هنا؟ اشرح بالتفصيل";
    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: prompt,
      projectMap: {
        ...projectMap,
        stack: ["Python"],
        entryPoints: ["backend/routes.py"],
        importantFiles: ["backend/routes.py", "backend/services/clustering.py", "backend/services/svm_model.py"]
      }
    });
    const result = await answerUniversalProjectQuestion({
      provider: new GenericPipelineProvider(),
      tools,
      userPrompt: prompt,
      explainReport: report
    });

    assert.equal(result.questionUnderstanding.targetConcept, "dbscan");
    assert.ok(result.questionUnderstanding.requestedFacets.includes("parameters"));
    assert.ok(result.implementationEvidence.some((item) => item.path === "backend/services/clustering.py" && item.semanticRole === "implementation"));
    assert.ok(result.implementationEvidence.some((item) => item.ownerSymbol === "CustomerClusteringService.fit_dbscan" && item.callKind === "direct_algorithm_call"));
    assert.ok(result.implementationEvidence.some((item) => item.semanticRole === "orchestration" && /self\.fit_dbscan/.test(item.snippet)));
    assert.ok(result.implementationEvidence.some((item) => item.semanticRole === "artifact_preparation" && /_training_dbscan_payload/.test(item.snippet)));
    assert.ok(result.implementationEvidence.some((item) => item.path === "frontend/ClusterChart.tsx" && item.semanticRole === "visualization"));
    assert.ok(result.suppressedEvidence.some((item) => item.semanticRole === "visualization"));
    assert.ok(result.conceptFlow.steps.some((step) => /DBSCAN|dbscan/i.test(step.whatHappens)));
    assert.equal(result.conceptFlow.steps.filter((step) => step.ownerSymbol.includes("fit_dbscan")).length, 1);
    assert.ok(result.conceptFlow.steps.every((step) => step.callKind === "direct_algorithm_call"));
    assert.ok(result.artifactPreparationEvidence.some((item) => /_training_dbscan_payload/.test(item.snippet)));
    assert.equal(result.dedupeValidation.valid, true);
    assert.equal(result.outputCleanupValidation.valid, true);
    assert.equal(result.coverageValidation.valid, true);
    assert.equal(result.roleClassificationValidation.valid, true);
    assert.match(result.answerMarkdown, /DBSCAN|dbscan/);
    assert.match(result.answerMarkdown, /backend\/services\/clustering\.py/);
    assert.match(result.answerMarkdown, /features|X/);
    assert.match(result.answerMarkdown, /eps\s*=\s*0\.35|min_samples\s*=\s*5/);
    assert.match(result.answerMarkdown, /dbscan_labels|fit_predict|clusters/i);
    assert.match(result.answerMarkdown, /cmeans|Fuzzy|FCM|memberships|fcm_labels/i);
    assert.match(result.answerMarkdown, /train_svm_state_detector|svm|SVM|\/train/i);
    assert.doesNotMatch(result.answerMarkdown, /dbscan call:.*cmeans/i);
    assert.doesNotMatch(result.answerMarkdown, /self\.fit_dbscan\(X\).*تنفيذ مباشر|self\.fit_dbscan\(X\).*implementation/i);
    assert.doesNotMatch(result.answerMarkdown, /_training_dbscan_payload.*تنفيذ مباشر|_training_dbscan_payload.*implementation/i);
    assert.doesNotMatch(result.answerMarkdown, /rgba|Number|ClusterChart/);
    assert.doesNotMatch(result.answerMarkdown, /\{\s*;\s*\{/);
    assert.doesNotMatch(result.answerMarkdown, /feature_frame,\s*\n\s*noise_mask/);
    assert.doesNotMatch(result.answerMarkdown, /upstream-clustering\s*->\s*training\s*->\s*prediction\s*->\s*explainability\s*->\s*usage/i);
    assert.doesNotMatch(result.answerMarkdown, /No local matches for query/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine feeds agentic relationship-model evidence to provider for deep project questions", async () => {
  const workspace = await createSvmWorkspace();
  const previousMode = process.env.HIVO_AGENTIC_TASK_KERNEL_MODE;
  const previousUse = process.env.HIVO_PROJECT_EXPLAIN_USE_AGENTIC_KERNEL;
  process.env.HIVO_AGENTIC_TASK_KERNEL_MODE = "force";
  process.env.HIVO_PROJECT_EXPLAIN_USE_AGENTIC_KERNEL = "1";
  const provider = new CapturingDeepQuestionProvider();
  try {
    const tools = new ToolRegistry(workspace);
    const prompt = "Why does the project use DBSCAN followed by Fuzzy C-Means? Compare noise/outliers with membership certainty in the final decision.";
    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: prompt,
      projectMap: {
        ...projectMap,
        stack: ["Python"],
        entryPoints: ["backend/routes.py"],
        importantFiles: ["backend/routes.py", "backend/services/clustering.py", "backend/services/svm_model.py"]
      }
    });
    const result = await answerUniversalProjectQuestionRaw({
      provider,
      tools,
      userPrompt: prompt,
      explainReport: report,
    });

    assert.equal(provider.structuredCalls <= 1, true);
    assert.ok(provider.textCalls >= 1);
    assert.notEqual(result.grounding.questionKind, "decision_policy");
    assert.equal(result.fallbackUsed, false, JSON.stringify({
      fallbackReason: result.fallbackReason,
      validationErrors: result.validationErrors,
      answerMarkdown: result.answerMarkdown
    }, null, 2));
    assert.equal(result.answerStrategy.finalAnswerSource, "provider");
    assert.ok(result.augmentedReport.evidence.some((item) => /Agentic relationship-model evidence/.test(item.reason)));
    assert.ok(result.augmentedReport.risksAndUnknowns.some((item) => /Agentic mental model confidence/.test(item)));
    const providerPrompt = provider.requests.map((request) => request.userPrompt).join("\n\n--- revision ---\n\n");
    assert.match(providerPrompt, /Agentic relationship-model evidence/);
    assert.match(providerPrompt, /Relationships followed|Data\/control flow|Agentic mental model confidence/);
    assert.match(result.answerMarkdown, /DBSCAN|noise_mask|Fuzzy C-Means|memberships|fcm_labels|train_svm_state_detector/);
  } finally {
    if (previousMode === undefined) delete process.env.HIVO_AGENTIC_TASK_KERNEL_MODE;
    else process.env.HIVO_AGENTIC_TASK_KERNEL_MODE = previousMode;
    if (previousUse === undefined) delete process.env.HIVO_PROJECT_EXPLAIN_USE_AGENTIC_KERNEL;
    else process.env.HIVO_PROJECT_EXPLAIN_USE_AGENTIC_KERNEL = previousUse;
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine treats paraphrased cross-file model questions as relationship-model work", async () => {
  const workspace = await createSvmWorkspace();
  const previousMode = process.env.HIVO_AGENTIC_TASK_KERNEL_MODE;
  const previousUse = process.env.HIVO_PROJECT_EXPLAIN_USE_AGENTIC_KERNEL;
  process.env.HIVO_AGENTIC_TASK_KERNEL_MODE = "force";
  process.env.HIVO_PROJECT_EXPLAIN_USE_AGENTIC_KERNEL = "1";
  const provider = new CapturingDeepQuestionProvider();
  try {
    const tools = new ToolRegistry(workspace);
    const prompt = "Explain the chain from density filtering into soft cluster confidence and then into the trained state model. What does each stage prove?";
    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: prompt,
      projectMap: {
        ...projectMap,
        stack: ["Python"],
        entryPoints: ["backend/routes.py"],
        importantFiles: ["backend/routes.py", "backend/services/clustering.py", "backend/services/svm_model.py"]
      }
    });

    const result = await answerUniversalProjectQuestionRaw({
      provider,
      tools,
      userPrompt: prompt,
      explainReport: report,
    });

    assert.equal(provider.structuredCalls <= 1, true);
    assert.ok(provider.textCalls >= 1);
    assert.equal(result.fallbackUsed, false, JSON.stringify({
      fallbackReason: result.fallbackReason,
      validationErrors: result.validationErrors,
      answerMarkdown: result.answerMarkdown
    }, null, 2));
    assert.equal(result.answerStrategy.finalAnswerSource, "provider");
    assert.ok(result.augmentedReport.evidence.some((item) => /Agentic relationship-model evidence/.test(item.reason)));
    const providerPrompt = provider.requests.map((request) => request.userPrompt).join("\n\n--- revision ---\n\n");
    assert.match(providerPrompt, /Agentic relationship-model evidence/);
    assert.match(providerPrompt, /backend\/services\/clustering\.py|backend\/services\/svm_model\.py|backend\/routes\.py/);
    assert.match(result.answerMarkdown, /DBSCAN|noise_mask|Fuzzy C-Means|memberships|fcm_labels|train_svm_state_detector/);
  } finally {
    if (previousMode === undefined) delete process.env.HIVO_AGENTIC_TASK_KERNEL_MODE;
    else process.env.HIVO_AGENTIC_TASK_KERNEL_MODE = previousMode;
    if (previousUse === undefined) delete process.env.HIVO_PROJECT_EXPLAIN_USE_AGENTIC_KERNEL;
    else process.env.HIVO_PROJECT_EXPLAIN_USE_AGENTIC_KERNEL = previousUse;
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine resolves DBSCAN instance calls, outputs, and downstream orchestration", async () => {
  const workspace = await createWorkspace("universal-dbscan-instance");
  try {
    await mkdir(path.join(workspace, "backend", "services"), { recursive: true });
    await writeFile(
      path.join(workspace, "backend", "services", "clustering.py"),
      [
        "from sklearn.cluster import DBSCAN",
        "import skfuzzy as fuzz",
        "",
        "class CustomerClusteringService:",
        "    def __init__(self):",
        "        self.dbscan_model = DBSCAN(eps=0.42, min_samples=7)",
        "",
        "    def fit_dbscan(self, X, scaler):",
        "        X_scaled = scaler.transform(X)",
        "        dbscan_labels = self.dbscan_model.fit_predict(X_scaled)",
        "        clean_mask = dbscan_labels != -1",
        "        X_clean = X_scaled[clean_mask]",
        "        return {'dbscan_labels': dbscan_labels, 'X_clean': X_clean, 'clean_mask': clean_mask}",
        "",
        "    def fit_fcm(self, X_clean):",
        "        centers, memberships, *_ = fuzz.cluster.cmeans(X_clean.T, c=3, m=2.0, error=0.005, maxiter=1000)",
        "        fcm_labels = memberships.argmax(axis=0)",
        "        return {'fcm_labels': fcm_labels, 'memberships': memberships}",
        "",
        "    def fit(self, X, scaler):",
        "        dbscan_result = self.fit_dbscan(X, scaler)",
        "        fcm_result = self.fit_fcm(dbscan_result['X_clean'])",
        "        return dbscan_result, fcm_result"
      ].join("\n"),
      "utf8"
    );
    const tools = new ToolRegistry(workspace);
    const prompt = "How is DBSCAN applied here? Explain in detail.";
    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: prompt,
      projectMap: { ...projectMap, stack: ["Python"], importantFiles: ["backend/services/clustering.py"] }
    });
    const result = await answerUniversalProjectQuestion({
      provider: new GenericPipelineProvider(),
      tools,
      userPrompt: prompt,
      explainReport: report
    });

    assert.equal(result.conceptResolution.resolutionStatus, "direct_found");
    assert.ok(result.implementationEvidence.some((item) => item.semanticRole === "implementation" && /self\.dbscan_model\.fit_predict/.test(item.snippet)));
    assert.ok(result.conceptFlow.steps.some((step) => step.outputNames.includes("dbscan_labels")));
    assert.ok(result.conceptFlow.steps.some((step) => step.outputNames.includes("clean_mask")));
    assert.ok(result.conceptFlow.steps.some((step) => step.outputNames.includes("X_clean")));
    assert.ok(result.conceptFlow.steps.some((step) => step.nextConsumers.includes("fit_fcm") || step.nextConsumers.includes("X_clean")));
    assert.doesNotMatch(result.answerMarkdown, /outputs? are not explicit|outputs? are not clear/i);
    assert.doesNotMatch(result.answerMarkdown, /downstream consumers are not explicit/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine keeps unknown target concepts separate from general ML evidence", async () => {
  const workspace = await createSvmWorkspace();
  try {
    const tools = new ToolRegistry(workspace);
    const prompt = "How is outerloop applied here? Explain in detail.";
    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: prompt,
      projectMap: {
        ...projectMap,
        stack: ["Python"],
        entryPoints: ["backend/routes.py"],
        importantFiles: ["backend/routes.py", "backend/services/clustering.py", "backend/services/svm_model.py"]
      }
    });
    const result = await answerUniversalProjectQuestion({
      provider: new GenericPipelineProvider(),
      tools,
      userPrompt: prompt,
      explainReport: report
    });

    assert.equal(result.questionUnderstanding.targetConcept, "outerloop");
    assert.equal(result.conceptResolution.resolutionStatus, "not_found");
    assert.equal(result.positiveEvidence.length, 0);
    assert.ok(result.conceptResolution.generalProjectEvidence.length > 0);
    assert.match(result.answerMarkdown, /could not prove|not prove|No direct, alias, behavioral, or architectural-pattern evidence/i);
    assert.doesNotMatch(result.answerMarkdown, /upstream-clustering\s*->\s*training\s*->\s*prediction\s*->\s*explainability\s*->\s*usage/i);
    assert.doesNotMatch(result.answerMarkdown, /No local matches for query "(interface|def|export|import|function|class|type)"/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine excludes persisted runtime sessions from project explain evidence", async () => {
  const workspace = await createWorkspace("universal-runtime-state-contamination");
  try {
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await writeFile(path.join(workspace, "src", "index.ts"), "export const appName = 'real-app';\n", "utf8");
    await mkdir(path.join(workspace, ".orchcode-agent-runtime"), { recursive: true });
    await writeFile(
      path.join(workspace, ".orchcode-agent-runtime", "sessions.json"),
      JSON.stringify({
        sessions: [{
          messages: [{
            role: "assistant",
            content: [
              "## Summary",
              "I found direct outerloop evidence.",
              "backend/services/action_executor.py:38",
              "backend/routes.py:19",
              "frontend/index.html:72",
              "ACTION_LOG_PATH, FORECAST_STATE_PATH, STREAMING_LOG_PATH, FAISS_INDEX_PATH"
            ].join("\n")
          }]
        }]
      }),
      "utf8"
    );
    const tools = new ToolRegistry(workspace);
    const prompt = "How is outerloop implemented here? Explain in detail.";
    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: prompt,
      projectMap: {
        ...projectMap,
        importantFiles: ["src/index.ts"],
        entryPoints: ["src/index.ts"]
      }
    });
    const result = await answerUniversalProjectQuestion({
      provider: new ThrowingProvider(),
      tools,
      userPrompt: prompt,
      explainReport: report
    });

    assert.equal(classifyEvidenceSource(".orchcode-agent-runtime/sessions.json"), "runtime_state");
    assert.ok(result.candidateFiles.every((file) => !file.includes(".orchcode-agent-runtime")));
    assert.ok(result.openedFiles.every((file) => !file.includes(".orchcode-agent-runtime")));
    assert.doesNotMatch(result.answerMarkdown, /backend\/services\/action_executor\.py|backend\/routes\.py|frontend\/index\.html/);
    assert.doesNotMatch(result.answerMarkdown, /ACTION_LOG_PATH|FORECAST_STATE_PATH|STREAMING_LOG_PATH|FAISS_INDEX_PATH/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine keeps FCM detail focused on cmeans and memberships", async () => {
  const workspace = await createSvmWorkspace();
  try {
    const tools = new ToolRegistry(workspace);
    const prompt = "How is Fuzzy C-Means applied here? Explain in detail.";
    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: prompt,
      projectMap: {
        ...projectMap,
        stack: ["Python"],
        entryPoints: ["backend/routes.py"],
        importantFiles: ["backend/routes.py", "backend/services/clustering.py", "backend/services/svm_model.py"]
      }
    });
    const result = await answerUniversalProjectQuestion({
      provider: new GenericPipelineProvider(),
      tools,
      userPrompt: prompt,
      explainReport: report
    });

    assert.equal(result.questionUnderstanding.targetConcept, "fcm");
    assert.equal(result.coverageValidation.valid, true);
    assert.ok(result.conceptFlow.steps.every((step) => step.semanticRole === "implementation"));
    assert.match(result.answerMarkdown, /cmeans|Fuzzy C-Means|FCM/i);
    assert.match(result.answerMarkdown, /memberships|fcm_labels|argmax/i);
    assert.match(result.answerMarkdown, /features\.T|c=4|m=2\.0|error=0\.005|maxiter=1000/);
    assert.doesNotMatch(result.answerMarkdown, /fcm call:.*DBSCAN/i);
    assert.doesNotMatch(result.answerMarkdown, /upstream-clustering\s*->\s*training\s*->\s*prediction\s*->\s*explainability\s*->\s*usage/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine preserves Arabic in concept-centric fallback", async () => {
  const workspace = await createSvmWorkspace();
  try {
    const tools = new ToolRegistry(workspace);
    const prompt = "ازاي الdbscan بيتطبق هنا؟ اشرح بالتفصيل";
    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: prompt,
      projectMap: {
        ...projectMap,
        stack: ["Python"],
        entryPoints: ["backend/routes.py"],
        importantFiles: ["backend/routes.py", "backend/services/clustering.py", "backend/services/svm_model.py"]
      }
    });
    const result = await answerUniversalProjectQuestion({
      provider: new GenericPipelineProvider(),
      tools,
      userPrompt: prompt,
      explainReport: report
    });

    assert.equal(result.questionUnderstanding.targetConcept, "dbscan");
    assert.equal(result.languageValidation.valid, true);
    assert.match(result.answerMarkdown, /الخلاصة|تسلسل التنفيذ|إجابات مباشرة|مقتطفات مهمة/);
    assert.match(result.answerMarkdown, /DBSCAN/);
    assert.match(result.answerMarkdown, /هنا الكود بيشغل DBSCAN فعليًا|تنفيذ مباشر/);
    assert.doesNotMatch(result.answerMarkdown, /^## Summary/m);
    assert.doesNotMatch(result.answerMarkdown, /The code applies DBSCAN through/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
