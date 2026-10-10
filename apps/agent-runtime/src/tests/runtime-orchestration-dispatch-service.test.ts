import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRuntimeSession, ProjectMap } from "@hivo/protocol";
import {
  RuntimeOrchestrationDispatchService,
  type SimpleRuntimeDispatchOptions
} from "../runtime/RuntimeOrchestrationDispatchService.js";
import type { ConversationUnderstanding } from "../runtime/ConversationUnderstanding.js";
import { resolveRuntimeMode, type RuntimeModeResolution } from "../runtime/RuntimeOrchestrationPreludeService.js";
import { beginDecisionPipeline } from "../runtime/DecisionPipeline.js";
import type { LlmProvider, LlmRequest } from "../llm/LlmProvider.js";

test("runtime orchestration dispatch keeps recursive tree for unrouted orchestrated mode", async () => {
  const calls: string[] = [];
  const result = await new RuntimeOrchestrationDispatchService().dispatch({
    ...input("orchestrated_mode", "recursive_tree", calls)
  });

  assert.equal(result.branch, "recursive_swarm");
  assert.deepEqual(calls, ["recursive_swarm"]);
  assert.equal(result.session.agentName, "recursive_swarm");
});

test("runtime orchestration dispatch routes provider-authored read-only swarm before recursive tree", async () => {
  const calls: string[] = [];
  const result = await new RuntimeOrchestrationDispatchService().dispatch({
    ...input("orchestrated_mode", "recursive_tree", calls),
    conversationUnderstanding: routeUnderstanding("swarm_readonly")
  });

  assert.equal(result.branch, "provider_backed_swarm");
  assert.deepEqual(calls, ["provider_backed_swarm"]);
});

test("runtime orchestration dispatch routes orchestrated_run to recursive_swarm when swarmMode is recursive_tree", async () => {
  const calls: string[] = [];
  const result = await new RuntimeOrchestrationDispatchService().dispatch({
    ...input("orchestrated_mode", "recursive_tree", calls),
    prompt: "Fix the failing multiply test in calculator.ts",
    conversationUnderstanding: routeUnderstanding("orchestrated_run")
  });

  assert.equal(result.branch, "recursive_swarm");
  assert.deepEqual(calls, ["recursive_swarm"]);
});

test("runtime orchestration dispatch routes orchestrated_run to provider_backed_swarm when swarmMode is pipeline", async () => {
  const calls: string[] = [];
  const result = await new RuntimeOrchestrationDispatchService().dispatch({
    ...input("orchestrated_mode", "pipeline", calls),
    prompt: "Fix the failing multiply test in calculator.ts",
    conversationUnderstanding: routeUnderstanding("orchestrated_run")
  });

  assert.equal(result.branch, "provider_backed_swarm");
  assert.deepEqual(calls, ["provider_backed_swarm"]);
});

test("runtime orchestration dispatch routes explicit recursive child action to recursive swarm", async () => {
  const calls: string[] = [];
  const result = await new RuntimeOrchestrationDispatchService().dispatch({
    ...input("recursive_factory", "recursive_tree", calls),
    prompt: "Enable recursive adding new child agents where the parent LLM decides numbers, tasks, prompts, and action execution.",
    conversationUnderstanding: routeUnderstanding("recursive_factory")
  });

  assert.equal(result.branch, "recursive_swarm");
  assert.deepEqual(calls, ["recursive_swarm"]);
});

test("runtime orchestration dispatch routes provider-classified run requests to simple run-to-green", async () => {
  const calls: string[] = [];
  let observed: SimpleRuntimeDispatchOptions | undefined;
  const result = await new RuntimeOrchestrationDispatchService().dispatch({
    ...input("simple_mode", "recursive_tree", calls),
    conversationUnderstanding: runRequestUnderstanding,
    branches: {
      ...branches(calls),
      simple: async (options) => {
        calls.push("simple");
        observed = options;
        return session("simple");
      }
    }
  });

  assert.equal(result.branch, "simple");
  assert.deepEqual(calls, ["simple"]);
  assert.equal(observed?.conversationUnderstanding?.intentDecision.kind, "run_request");
});

test("runtime orchestration dispatch selects recursive factory when swarm is not recursive tree", async () => {
  const calls: string[] = [];
  const result = await new RuntimeOrchestrationDispatchService().dispatch({
    ...input("recursive_factory", "pipeline", calls)
  });

  assert.equal(result.branch, "recursive_factory");
  assert.deepEqual(calls, ["recursive_factory"]);
});

test("runtime orchestration dispatch selects provider-backed swarm for ordinary orchestrated mode", async () => {
  const calls: string[] = [];
  const result = await new RuntimeOrchestrationDispatchService().dispatch({
    ...input("orchestrated_mode", "pipeline", calls)
  });

  assert.equal(result.branch, "provider_backed_swarm");
  assert.deepEqual(calls, ["provider_backed_swarm"]);
});

test("runtime orchestration dispatch forwards simple run options", async () => {
  const calls: string[] = [];
  let observed: SimpleRuntimeDispatchOptions | undefined;
  const result = await new RuntimeOrchestrationDispatchService().dispatch({
    ...input("simple_mode", "pipeline", calls),
    thinkFirst: true,
    branches: {
      ...branches(calls),
      simple: async (options) => {
        calls.push("simple");
        observed = options;
        return session("simple");
      }
    }
  });

  assert.equal(result.branch, "simple");
  assert.deepEqual(calls, ["simple"]);
  assert.equal(observed?.resolvedMode, "simple_mode");
  assert.equal(observed?.thinkFirst, true);
  assert.deepEqual(observed?.projectMap.importantFiles, ["package.json"]);
});

test("Axios regression: provider inspect_explain for explicit bugfix and patch reaches recursive_swarm dispatch branch when swarmMode is recursive_tree", async () => {
  const axiosFixPrompt = [
    "Fix the following issue in this Axios repository.",
    "",
    "**Unexpected default maxBodyLength enforcement by follow-redirects**",
    "",
    "After an upgrade of follow-redirects, Axios began enforcing a default 10 MB request-body limit, even though its default behavior was intended to be unlimited.",
    "",
    "Investigate and fix the issue while preserving existing behavior and explicit body-size limits.",
    "",
    "Generate a reviewable patch, request approval before applying changes, and verify the result."
  ].join("\n");

  const stubbedProvider: LlmProvider = {
    async generateStructured<T>(_input: LlmRequest, schema: unknown): Promise<T> {
      const schemaName = typeof schema === "object" && schema && "name" in schema
        ? String((schema as { name: string }).name)
        : "";
      if (schemaName === "initial-reasoning-decision") {
        return {
          understanding: {
            originalRequest: axiosFixPrompt,
            cleanedRequest: "Locate and modify the Axios code that sets the default maxBodyLength (currently 10 MB after follow-redirects upgrade) so that the default is unlimited and behaves consistently regardless of maxRedirects. Produce a reviewable patch, ask for approval, then run the repository's Docker-based tests to confirm the fix.",
            language: "english",
            intentKind: "workspace_question",
            route: "inspect_explain",
            needsWorkspace: true,
            goal: "Identify the source handling of maxBodyLength default in the Axios codebase, adjust it to make the default unlimited, create a patch, seek approval, and verify that all tests pass.",
            ambiguities: [],
            requiredEvidence: ["Source file(s) where maxBodyLength default is defined"],
            risk: "medium",
            confidence: "high",
            rationale: "The user asks for a code change; the first step must be to investigate the existing implementation to understand where and how the default maxBodyLength is set before proposing a fix."
          },
          step: {
            id: "step_1",
            kind: "tool_batch",
            rationale: "Investigate before modifying.",
            toolRequests: [
              { id: "tool_1", kind: "repository_search", reason: "Locate code", query: "maxBodyLength" }
            ],
            missingFacts: [],
            successCriteria: ["Found files"]
          }
        } as T;
      }
      throw new Error(`Unexpected schema call: ${schemaName}`);
    },
    async generateText(): Promise<string> {
      throw new Error("Unexpected text call");
    }
  };

  const pipeline = await beginDecisionPipeline({
    message: axiosFixPrompt,
    provider: stubbedProvider
  });

  const calls: string[] = [];
  const result = await new RuntimeOrchestrationDispatchService().dispatch({
    sessionId: "session-axios-integration",
    prompt: axiosFixPrompt,
    projectMap,
    modeResolution: resolveRuntimeMode({
      sessionMode: "auto_mode",
      prompt: axiosFixPrompt,
      projectMap,
      conversationUnderstanding: pipeline.understanding
    }),
    swarmMode: "recursive_tree",
    thinkFirst: false,
    conversationUnderstanding: pipeline.understanding,
    branches: branches(calls)
  });

  assert.equal(result.branch, "recursive_swarm");
  assert.deepEqual(calls, ["recursive_swarm"]);
});


function input(
  mode: RuntimeModeResolution["mode"],
  swarmMode: "recursive_tree" | "pipeline",
  calls: string[]
) {
  return {
    sessionId: "session-dispatch",
    prompt: "Build a small feature",
    projectMap,
    modeResolution: modeResolution(mode),
    swarmMode,
    thinkFirst: false,
    branches: branches(calls)
  };
}

function branches(calls: string[]) {
  return {
    recursiveSwarm: async () => {
      calls.push("recursive_swarm");
      return session("recursive_swarm");
    },
    recursiveFactory: async () => {
      calls.push("recursive_factory");
      return session("recursive_factory");
    },
    providerBackedSwarm: async () => {
      calls.push("provider_backed_swarm");
      return session("provider_backed_swarm");
    },
    simple: async () => {
      calls.push("simple");
      return session("simple");
    }
  };
}

function modeResolution(mode: RuntimeModeResolution["mode"]): RuntimeModeResolution {
  return {
    mode,
    directive: {
      explicitMode: mode,
      thinkFirstRequested: false
    },
    complexity: "medium"
  };
}

const projectMap: ProjectMap = {
  stack: ["TypeScript"],
  packageManagers: ["npm"],
  testCommands: ["npm test"],
  entryPoints: [],
  importantFiles: ["package.json"]
};

const runRequestUnderstanding = {
  intentDecision: {
    kind: "run_request",
    language: "english",
    needsWorkspace: true,
    confidence: "high",
    rationale: "The provider classified this as a run request."
  },
  routeDecision: {
    route: "simple_run",
    confidence: "high",
    language: "english",
    normalizedPrompt: "run this project",
    workspacePrompt: "run this project",
    rationale: "The provider classified this as a run request."
  }
} as ConversationUnderstanding;

function routeUnderstanding(route: "swarm_readonly" | "orchestrated_run" | "recursive_factory") {
  return {
    intentDecision: {
      kind: route === "swarm_readonly" ? "workspace_question" : "workspace_action",
      language: "english",
      needsWorkspace: true,
      confidence: "high",
      rationale: "The provider selected a canonical orchestrated route."
    },
    routeDecision: {
      route,
      confidence: "high",
      language: "english",
      normalizedPrompt: "explain architecture",
      workspacePrompt: "explain architecture",
      rationale: "The provider selected a canonical orchestrated route."
    }
  } as ConversationUnderstanding;
}

function session(agentName: string): AgentRuntimeSession {
  return ({
    id: "session-dispatch",
    agentName,
    status: "completed"
  } as unknown) as AgentRuntimeSession;
}
