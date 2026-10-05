import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRuntimeSession, SanitizedProviderConfig } from "@hivo/protocol";
import { loadConfig } from "../src/config.js";
import { AgentRuntime } from "../src/runtime/AgentRuntime.js";
import { EventBus } from "../src/runtime/EventBus.js";
import { SessionManager } from "../src/runtime/SessionManager.js";
import { createRealProvider } from "../src/runtime/RuntimeProviderFactory.js";

async function main() {
  const fixture = await createFixture();
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const outputDir = path.join(repoRoot, "tmp", "inspect-provider-truth");
  await mkdir(outputDir, { recursive: true });
  try {
    const providerConfig = await resolveProviderConfig();
    assert.ok(providerConfig, "smoke:inspect-provider-truth requires OLLAMA_MODEL or HIVO_OLLAMA_MODEL with a reachable Ollama server.");
    const sessionManager = new SessionManager(fixture.storageDir, new EventBus());
    await sessionManager.load();
    const runtimeConfig = loadConfig();
    const runtime = new AgentRuntime(
      {
        ...runtimeConfig,
        storageDir: fixture.storageDir,
        defaultMode: "real_provider"
      },
      sessionManager,
      {
        providerFactory: () => createRealProvider(providerConfig, runtimeConfig.providerRequestTimeoutMs)
      }
    );
    const prompt = "How is DBSCAN applied here?";
    const created = await runtime.createSession({
      workspacePath: fixture.workspace,
      mode: "real_provider",
      providerConfig,
      activeProviderSource: "explicit_cli",
      accessProfile: "full_access",
      userPrompt: prompt
    });
    await runtime.runTurn(created.sessionId, prompt);
    const session = runtime.getSession(created.sessionId);
    assert.ok(session);
    const report = createReport(session, providerConfig);
    assertSmoke(report);
    const reportPath = path.join(outputDir, "inspect-provider-truth-report.json");
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ ok: true, reportPath, report }, null, 2));
  } finally {
    await fixture.close();
  }
}

function createReport(session: AgentRuntimeSession, providerConfig: SanitizedProviderConfig | undefined) {
  const answerArtifact = session.artifacts.find((artifact) => artifact.type === "project_explain_answer");
  return {
    sessionId: session.id,
    mode: session.mode,
    configuredProvider: providerConfig ?? null,
    providerTelemetry: session.providerTelemetry ?? null,
    evidenceReport: session.evidenceReport ?? null,
    answerContract: answerArtifact?.payload.answerContract ?? null,
    answerPreview: String(answerArtifact?.payload.answerMarkdown ?? "").slice(0, 1200),
    artifactTypes: session.artifacts.map((artifact) => artifact.type)
  };
}

function assertSmoke(report: ReturnType<typeof createReport>) {
  assert.ok(report.providerTelemetry, "provider telemetry must exist");
  assert.ok(report.evidenceReport, "evidence report must exist");
  assert.equal(report.evidenceReport.finalEvidenceFilesActuallyUsed.some((file) => file.includes("tmp/")), false, "tmp artifacts must not be used as final source proof");
  assert.equal(report.evidenceReport.evidenceFilesByTier.source_code.some((file) => file === "src/clustering.py"), true, "real source evidence should be used");
  assert.equal(report.evidenceReport.excludedEvidenceCandidates.some((file) => file.includes("tmp/root-cause-audit/explain-repro-results.json")), true, "generated audit artifact should be excluded");
  assert.equal(
    report.providerTelemetry.providerMode,
    "real_provider",
    "inspect-provider-truth smoke must use the real provider runtime mode"
  );
  assert.ok((report.providerTelemetry.realProviderRequestCount ?? 0) > 0, "inspect-provider-truth smoke must make real provider requests");
  assert.equal(report.providerTelemetry.finalResponseSource, "provider", "inspect-provider-truth smoke must finish with provider-authored output");
}

async function resolveProviderConfig(): Promise<SanitizedProviderConfig | undefined> {
  const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
  const model = process.env.OLLAMA_MODEL ?? process.env.HIVO_OLLAMA_MODEL;
  if (!model) return undefined;
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) return undefined;
    return {
      providerType: "ollama",
      providerName: "Ollama",
      baseUrl,
      selectedModel: model,
      isValid: true
    };
  } catch {
    return undefined;
  }
}

async function createFixture() {
  const workspace = path.join(os.tmpdir(), `hivo-inspect-provider-truth-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const storageDir = path.join(os.tmpdir(), `hivo-inspect-provider-truth-storage-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await mkdir(path.join(workspace, "tmp", "root-cause-audit"), { recursive: true });
  await mkdir(storageDir, { recursive: true });
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "inspect-provider-truth-smoke", private: true }, null, 2), "utf8");
  await writeFile(
    path.join(workspace, "src", "clustering.py"),
    [
      "from sklearn.cluster import DBSCAN",
      "",
      "def apply_dbscan(features):",
      "    labels = DBSCAN(eps=0.35, min_samples=5).fit_predict(features)",
      "    noise_mask = labels == -1",
      "    clean_features = features[~noise_mask]",
      "    return labels, clean_features, noise_mask"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspace, "tmp", "root-cause-audit", "explain-repro-results.json"),
    JSON.stringify({ generatedClaim: "DBSCAN proof from generated audit output must not count as source evidence" }, null, 2),
    "utf8"
  );
  return {
    workspace,
    storageDir,
    close: async () => {
      await rm(workspace, { recursive: true, force: true });
      await rm(storageDir, { recursive: true, force: true });
    }
  };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
