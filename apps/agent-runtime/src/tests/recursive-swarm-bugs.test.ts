import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { RecursiveTaskSplitter } from "../orchestration/RecursiveTaskSplitter.js";
import { HierarchicalCollector } from "../orchestration/HierarchicalCollector.js";
import { GoalKeeperAgent } from "../orchestration/GoalKeeperAgent.js";
import { bridgeEditIntents, collectIntentsFromTree } from "../orchestration/RecursiveEditIntentBridge.js";
import { RecursiveSwarmOrchestrator } from "../orchestration/RecursiveSwarmOrchestrator.js";
import { buildRecursiveCheckpointResumePrompt } from "../runtime/RuntimePendingActionService.js";
import {
  RECURSIVE_SWARM_SCHEMA_VERSION,
  DEFAULT_RECURSIVE_SWARM_OPTIONS,
  createGoalEnvelope
} from "../orchestration/RecursiveSwarmModels.js";
import type { RecursiveSwarmNode } from "../orchestration/RecursiveSwarmModels.js";
import type { LlmProvider, LlmRequest } from "../llm/LlmProvider.js";

// ============================================================
// Fixtures
// ============================================================

function makeTestNode(overrides: Partial<RecursiveSwarmNode> = {}): RecursiveSwarmNode {
  const goalEnvelope = createGoalEnvelope({
    originalGoal: "Test goal",
    workspaceIdentity: "test",
    localTask: overrides.taskPrompt ?? "Test task"
  });
  return {
    schema_version: RECURSIVE_SWARM_SCHEMA_VERSION,
    id: `node_${Math.random().toString(36).slice(2, 10)}`,
    parentId: undefined,
    runId: "test_run",
    kind: "task_agent",
    status: "created",
    name: "Test Node",
    role: "Task Agent",
    goalEnvelope,
    taskPrompt: "Test task",
    depth: 0,
    goalChecks: [],
    steeringQueue: [],
    children: [],
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  };
}

type AtomicityFixture = {
  isAtomic: boolean;
  score: number;
  rationale: string;
  failures: string[];
  recommendation?: "split" | "execute" | "block" | "escalate";
};

type SplitFixture = {
  rationale: string;
  subTasks: Array<{
    id?: string;
    title: string;
    taskPrompt: string;
    expectedOutput: string;
    dependencies: string[];
    responsibility?: import("../orchestration/RecursiveSwarmModels.js").WorkerResponsibility;
    canWrite?: boolean;
    sourceEvidenceRequirement?: {
      prerequisiteSubtaskId: string;
      sourcePath: string;
      evidenceType: "verified_workspace_source";
    };
  }>;
};

function recursiveProvider(input: {
  atomicity?: AtomicityFixture[];
  splitResults?: SplitFixture[];
  structuredNodeOutput?: (request: LlmRequest) => unknown;
} = {}): LlmProvider & { requests: LlmRequest[] } {
  const atomicity = [...(input.atomicity ?? [{ isAtomic: true, score: 2, rationale: "Atomic fixture.", failures: [] }])];
  const splitResults = [...(input.splitResults ?? [])];
  return {
    requests: [],
    async generateStructured<T>(request: LlmRequest, schema: unknown): Promise<T> {
      this.requests.push(request);
      const name = schema && typeof schema === "object" && "name" in schema
        ? String((schema as { name: unknown }).name)
        : "";
      if (name === "atomicity_assessment") {
        const next = atomicity.shift() ?? { isAtomic: true, score: 2, rationale: "Atomic fixture.", failures: [] };
        return next as T;
      }
      if (name === "expanded_goal_spec") {
        return {
          isAlreadyDetailed: true,
          expandedGoal: request.userPrompt,
          requirements: ["Preserve the original prompt", "Produce the requested deliverable"],
          acceptanceCriteria: ["The final output matches the user's deliverable contract"],
          deliverableContract: "Produce the requested artifact or report a blocker with evidence.",
          constraints: ["Do not summarize away the deliverable"],
          nonGoals: [],
          qualityBar: ["Complete, usable, and validated"]
        } as T;
      }
      if (name === "split_result") {
        return (splitResults.shift() ?? { subTasks: [], rationale: "No fixture split." }) as T;
      }
      if (name === "structured_node_output") {
        if (input.structuredNodeOutput) {
          return input.structuredNodeOutput(request) as T;
        }
        return {
          kind: "final_summary",
          summary: `Completed: ${request.userPrompt}`,
          blockers: [],
          edit_intents: [],
          validation_plans: [],
          confidence: 0.9
        } as T;
      }
      throw new Error(`Unexpected schema ${name}`);
    },
    async generateText(request: LlmRequest): Promise<string> {
      this.requests.push(request);
      return `Merged child results:\n${request.userPrompt.slice(0, 800)}`;
    }
  };
}

// ============================================================
// GoalKeeper provider authority
// ============================================================

test("GoalKeeperAgent reports unknown without provider instead of keyword fallback", async () => {
  const goalKeeper = new GoalKeeperAgent();
  const result = await goalKeeper.checkAlignment(makeTestNode({
    taskPrompt: "Fix the login button color"
  }));
  assert.equal(result.aligned, false);
  assert.equal(result.status, "unknown");
  assert.deepEqual(result.findings, ["provider_unavailable"]);
  assert.match(result.warnings.join("\n"), /configured provider/);
});

test("orchestrator blocks goal checking when provider is unavailable", async () => {
  const orchestrator = new RecursiveSwarmOrchestrator({
    options: {
      maxDepth: 3,
      maxAgents: 10,
      enableGoalKeeper: true,
      enableParallelExecution: false,
      enableErrorRecovery: false
    }
  });
  const result = await orchestrator.run("Fix the login button color");
  const rootNode = result.runState.tree.nodes[result.runState.tree.rootId];
  assert.equal(rootNode.status, "blocked");
  assert.match(rootNode.errorSummary ?? "", /provider_unavailable/);
});

// ============================================================
// Bug 3 regression: provider-backed splitting must not self-split
// ============================================================

test("splitTask rejects missing provider instead of using local decomposition fallback", async () => {
  const splitter = new RecursiveTaskSplitter({ complexityThreshold: 4 });
  const node = makeTestNode({
    taskPrompt: "Implement a login form with validation and error handling"
  });
  await assert.rejects(
    () => splitter.splitTask(node, DEFAULT_RECURSIVE_SWARM_OPTIONS),
    /configured provider/
  );
});

test("splitTask preserves the full original goal in every child prompt", async () => {
  const originalGoal = [
    "Create a single-file self-contained 3D Crossy Road-style game using Three.js from CDN.",
    "The final game must be complete, playable, polished, visually rich, performant, and validated in browser."
  ].join("\n");
  const provider = recursiveProvider({
    splitResults: [{
      rationale: "Split into implementation work.",
      subTasks: [{
        title: "Implement lanes",
        taskPrompt: "Build road lanes and obstacle spawning.",
        expectedOutput: "Lane implementation details",
        dependencies: []
      }]
    }]
  });
  const splitter = new RecursiveTaskSplitter({ provider, complexityThreshold: 4 });
  const node = makeTestNode({
    taskPrompt: "Build the game from the detailed request.",
    goalEnvelope: createGoalEnvelope({
      originalGoal,
      workspaceIdentity: "test",
      localTask: "Build the game from the detailed request."
    })
  });

  const result = await splitter.splitTask(node, DEFAULT_RECURSIVE_SWARM_OPTIONS);
  assert.equal(result.subTasks.length, 1);
  assert.match(result.subTasks[0]!.taskPrompt, /ORIGINAL GOAL \(full, authoritative\):/);
  assert.match(result.subTasks[0]!.taskPrompt, /EXPANDED GOAL \/ SPEC:/);
  assert.match(result.subTasks[0]!.taskPrompt, /DELIVERABLE CONTRACT:/);
  assert.match(result.subTasks[0]!.taskPrompt, /PARENT TASK:/);
  assert.match(result.subTasks[0]!.taskPrompt, /CHILD TASK:/);
  assert.ok(result.subTasks[0]!.taskPrompt.includes(originalGoal));
  assert.ok(result.subTasks[0]!.taskPrompt.includes("Build road lanes and obstacle spawning."));
});

test("orchestrator clamps single-file 3D game splits to a sane per-parent budget", async () => {
  const manySubtasks = Array.from({ length: 24 }, (_, index) => ({
    title: `Game subtask ${index + 1}`,
    taskPrompt: `Implement concrete 3D game subsystem ${index + 1} with verifiable output.`,
    expectedOutput: `Concrete subsystem ${index + 1} result`,
    dependencies: []
  }));
  const orchestrator = new RecursiveSwarmOrchestrator({
    provider: recursiveProvider({
      atomicity: [
        { isAtomic: false, score: 6, rationale: "Large creative artifact needs decomposition.", failures: ["broad_scope"] }
      ],
      splitResults: [{
        rationale: "Provider proposed too many children.",
        subTasks: manySubtasks
      }]
    }),
    options: {
      maxDepth: 10,
      maxAgents: 300,
      enableGoalKeeper: false,
      enableParallelExecution: false,
      enableErrorRecovery: false
    }
  });
  const result = await orchestrator.run("Create a complete polished single-file 3D Crossy Road game using Three.js from CDN.");
  const rootChildren = Object.values(result.runState.tree.nodes)
    .filter((node) => node.parentId === result.runState.tree.rootId && node.kind === "task_agent");

  assert.equal(result.runState.budget?.taskClass, "large");
  assert.equal(result.runState.budget?.softMaxAgents, 48);
  assert.equal(result.runState.budget?.maxChildrenPerParent, 8);
  assert.equal(rootChildren.length, 8);
  assert.ok(result.runState.activityProjection?.durableRows.some((row) => row.title === "Budget gate"));
  assert.ok(result.runState.checkpoint?.resumable === false);
});

test("continue and Arabic كمل build a recursive checkpoint resume prompt", () => {
  const session = {
    id: "session_resume",
    userPrompt: "Build the game",
    recursiveSwarmRunState: {
      checkpoint: {
        sessionId: "session_resume",
        runId: "recursive_swarm_test",
        originalPrompt: "Build a polished 3D Crossy Road game",
        expandedGoalSpec: {
          originalPrompt: "Build a polished 3D Crossy Road game",
          originalPromptHash: "hash",
          isAlreadyDetailed: false,
          expandedGoal: "Build a complete playable Three.js game.",
          requirements: ["playable"],
          acceptanceCriteria: ["complete"],
          deliverableContract: "single-file index.html",
          constraints: [],
          nonGoals: [],
          qualityBar: ["polished"],
          generatedBy: "provider",
          warnings: []
        },
        budget: {
          hardMaxAgents: 300,
          softMaxAgents: 48,
          maxDepth: 6,
          maxChildrenPerParent: 8,
          maxWriteExecutors: 6,
          reason: "large artifact",
          taskClass: "large"
        },
        nodes: [],
        pendingQueue: ["node_pending"],
        completedNodeIds: ["node_done"],
        failedNodeIds: [],
        generatedArtifacts: [],
        durableActivityRows: [{
          id: "row_1",
          kind: "split",
          title: "Split into 8 child task(s)",
          summary: "Root split recorded.",
          status: "completed",
          createdAt: new Date().toISOString()
        }],
        lastStablePhase: "post_split:root",
        resumable: true,
        createdAt: new Date().toISOString()
      }
    }
  } as unknown as import("@hivo/protocol").AgentRuntimeSession;

  const english = buildRecursiveCheckpointResumePrompt(session, "continue");
  const arabic = buildRecursiveCheckpointResumePrompt(session, "كمل");

  assert.match(english ?? "", /Resume the previous recursive swarm run/);
  assert.match(english ?? "", /node_pending/);
  assert.match(arabic ?? "", /Build a polished 3D Crossy Road game/);
});

test("generated artifact outputs become real create-file patch proposals", () => {
  const html = "<!doctype html>\n<html><body><canvas id=\"game\"></canvas><script type=\"module\">console.log('playable');</script></body></html>\n";
  const targetPath = `tmp/recursive-generated-artifact-${Date.now()}.html`;
  const node = makeTestNode({
    id: "artifact_node",
    structuredOutput: {
      kind: "generated_artifact",
      path: targetPath,
      content: html,
      artifact_type: "html",
      description: "Complete self-contained Three.js game HTML.",
      validation_steps: ["Open crossy-road.html in a browser."],
      completeness_notes: ["Contains HTML and module script in one file."],
      confidence: 0.9
    }
  });

  const collected = collectIntentsFromTree({ [node.id]: node });
  assert.equal(collected.generatedArtifacts.length, 1);

  const bridged = bridgeEditIntents({
    sessionId: "session_artifact",
    workspacePath: process.cwd(),
    intents: collected.intents,
    generatedArtifacts: collected.generatedArtifacts,
    validationPlans: collected.validationPlans,
    allowedPaths: [],
    forbiddenPaths: [],
    fileContents: { [targetPath]: "" }
  });

  assert.equal(bridged.summaryCounts.realDiff, 1);
  assert.equal(bridged.summaryCounts.needsGeneration, 0);
  assert.equal(bridged.patchCandidates[0]?.filesChanged[0]?.path, targetPath);
  assert.ok(bridged.patchCandidates[0]?.unifiedDiff.includes("+<!doctype html>"));
  assert.equal(bridged.patchCandidates[0]?.artifacts?.find((artifact) => artifact.path === targetPath)?.content, html);
});

test("orchestrator self-similar provider split detection executes atomically", async () => {
  const orchestrator = new RecursiveSwarmOrchestrator({
    provider: recursiveProvider({
      atomicity: [{ isAtomic: false, score: 6, rationale: "Provider requests split.", failures: ["broad_scope"] }],
      splitResults: [{ subTasks: [], rationale: "Provider found no meaningful split." }]
    }),
    options: {
      maxDepth: 3,
      maxAgents: 10,
      enableGoalKeeper: false,
      enableParallelExecution: true,
      enableErrorRecovery: false
    }
  });
  const result = await orchestrator.run("Fix the button color");
  assert.ok(result.runState.tree.maxDepth <= 1,
    `maxDepth should be <=1 (was ${result.runState.tree.maxDepth}) -- no recursive split loop`);
  assert.ok(result.finalOutput.length > 0,
    "finalOutput should be non-empty with provider-backed execution");
  assert.equal(result.runState.tree.status, "succeeded",
    "tree status should be succeeded, not blocked from maxDepth recursion");
});

// ============================================================
// Bug 1 regression: child results must appear in collection
// ============================================================

test("collect reads fresh child nodes from tree by parentId", async () => {
  const collector = new HierarchicalCollector({ enableErrorRecovery: false });
  const goal = "Build a simple UI";

  const child1 = makeTestNode({
    id: "child_1",
    parentId: "parent_1",
    name: "Child1",
    status: "succeeded",
    outputSummary: "Created button component",
    taskPrompt: "Create button",
    children: []
  });
  const child2 = makeTestNode({
    id: "child_2",
    parentId: "parent_1",
    name: "Child2",
    status: "succeeded",
    outputSummary: "Created input component",
    taskPrompt: "Create input",
    children: []
  });

  const children = [child1, child2];
  const result = await collector.collect(children, goal);

  // Both outputs must be present in childResults
  assert.ok(result.childResults["child_1"], "child1 result should be present");
  assert.ok(result.childResults["child_2"], "child2 result should be present");
  assert.equal(result.childResults["child_1"], "Created button component");
  assert.equal(result.childResults["child_2"], "Created input component");

  // Merged output should combine both
  assert.ok(result.mergedOutput.length > 0, "merged output should not be empty");
  assert.notEqual(result.mergedOutput, "No child results to merge.",
    "should not say 'No child results to merge' when children have outputs");
  assert.notEqual(result.mergedOutput, "No results to merge.",
    "should not say 'No results to merge' when children have outputs");
  assert.ok(result.unresolvedErrors.some((error) => error.includes("provider_unavailable")),
    "collector should not treat local merge formatting as provider-authored success");
});

test("orchestrator-filtered children by parentId are not stale", async () => {
  // Simulate the scenario: nodes are in a tree, a child gets updated via
  // emitNodeStatusChanged (which replaces the node copy), then the
  // orchestrator's old object-reference filter would miss it.
  // We verify that filtering by parentId finds all children.

  const tree = new Map<string, RecursiveSwarmNode>();
  const parentId = "parent_test";

  const childA = makeTestNode({ id: "child_A", parentId, outputSummary: "Output A" });
  const childB = makeTestNode({ id: "child_B", parentId, outputSummary: "Output B" });

  tree.set(childA.id, childA);
  tree.set(childB.id, childB);

  // Simulate emitNodeStatusChanged: replace with copy
  tree.set(childA.id, { ...tree.get(childA.id)!, status: "succeeded" });
  tree.set(childB.id, { ...tree.get(childB.id)!, status: "succeeded" });

  // Object reference filter (the BUG) would find nothing
  const originalRefs = [childA, childB];
  const byRef = [...tree.values()].filter((n) => originalRefs.includes(n));
  assert.equal(byRef.length, 0,
    "object reference filter returns empty after node replacement (BUG)");

  // parentId filter (the FIX) works correctly
  const byParent = [...tree.values()].filter((n) => n.parentId === parentId);
  assert.equal(byParent.length, 2,
    "parentId filter finds all children after node replacement (FIX)");
});

// ============================================================
// Bug 2 regression: dependency ordering
// ============================================================

test("executeChildren enforces dependency order with index refs", async () => {
  const orchestrator = new RecursiveSwarmOrchestrator({
    provider: recursiveProvider({
      atomicity: [
        { isAtomic: false, score: 6, rationale: "Root should split.", failures: ["multiple_goals"] },
        { isAtomic: true, score: 2, rationale: "Child is atomic.", failures: [] },
        { isAtomic: true, score: 2, rationale: "Child is atomic.", failures: [] },
        { isAtomic: true, score: 2, rationale: "Child is atomic.", failures: [] }
      ],
      splitResults: [{
        rationale: "Provider split into ordered work.",
        subTasks: [
          { title: "Create database schema", taskPrompt: "Create the database schema", expectedOutput: "Schema plan", dependencies: [] },
          { title: "Create API endpoints", taskPrompt: "Create the API endpoints", expectedOutput: "API plan", dependencies: ["0"] },
          { title: "Create UI pages", taskPrompt: "Create the UI pages", expectedOutput: "UI plan", dependencies: ["1"] }
        ]
      }]
    }),
    options: {
      maxDepth: 3,
      maxAgents: 10,
      enableGoalKeeper: false,
      enableParallelExecution: false,
      enableErrorRecovery: false
    }
  });
  const result = await orchestrator.run(
    "Create the database schema\nand create the API endpoints\nand create the UI pages"
  );
  // Tree must complete without blocking
  assert.equal(result.runState.tree.status, "succeeded",
    "tree should succeed with dependency-aware execution");
  // All nodes should be completed
  const allNodes = Object.values(result.runState.tree.nodes);
  const failedOrBlocked = allNodes.filter(
    (n) => n.status === "failed" || n.status === "blocked" || n.status === "escalated"
  );
  assert.equal(failedOrBlocked.length, 0,
    `no failed/blocked/escalated nodes (found ${failedOrBlocked.map((n) => `${n.name}:${n.status}`).join(", ")})`);
  // Must produce final output
  assert.ok(result.finalOutput.length > 0, "final output should be non-empty");
  // The root node should have collected child results
  const rootNode = result.runState.tree.nodes[result.runState.tree.rootId];
  if (rootNode.collectResult) {
    assert.ok(Object.keys(rootNode.collectResult.childResults).length > 0,
      "root collectResult should contain child results");
  }
});

test("implementation waits for verified source evidence from its declared prerequisite", async () => {
  const targetPath = "src/elements/element.bar.js";
  const implementationMarker = "IMPLEMENT_REQUIRES_VERIFIED_BAR_SOURCE";
  const workspacePath = mkdtempSync(path.join(tmpdir(), "hivo-source-evidence-missing-"));
  let implementationCalls = 0;
  let recoveryCalls = 0;
  const provider = recursiveProvider({
    atomicity: [
      { isAtomic: false, score: 6, rationale: "Root should split.", failures: ["multiple_goals"] },
      { isAtomic: true, score: 2, rationale: "Inspection task is atomic.", failures: [] },
      { isAtomic: true, score: 2, rationale: "Implementation task is atomic.", failures: [] },
      { isAtomic: true, score: 2, rationale: "Independent task is atomic.", failures: [] }
    ],
    splitResults: [{
      rationale: "Inspect source before implementing, with one independent task.",
      subTasks: [
        {
          id: "S0",
          title: "Inspect bar source evidence",
          taskPrompt: `Inspect ${targetPath} and return source evidence.`,
          expectedOutput: "Source evidence for the bar element",
          dependencies: []
        },
        {
          id: "S1",
          title: "Implement bar fix",
          taskPrompt: `${implementationMarker}: Do not implement unless verified source content for ${targetPath} is available.`,
          expectedOutput: `Patch grounded in verified ${targetPath} source`,
          dependencies: ["0"],
          sourceEvidenceRequirement: {
            prerequisiteSubtaskId: "0",
            sourcePath: targetPath,
            evidenceType: "verified_workspace_source"
          }
        },
        {
          title: "Independent documentation check",
          taskPrompt: "Perform this independent documentation check.",
          expectedOutput: "Documentation check result",
          dependencies: []
        }
      ]
    }],
    structuredNodeOutput: (request) => {
      if (request.userPrompt.includes(implementationMarker)) {
        implementationCalls++;
        if (request.userPrompt.includes("previous response was structurally valid")) recoveryCalls++;
      }
      if (request.userPrompt.includes(`Inspect ${targetPath} and return source evidence.`)) {
        return {
          kind: "evidence_report",
          findings: [`Inspected ${targetPath}`],
          files: [targetPath],
          symbols: ["BarElement"],
          evidence_refs: [`file:${targetPath}#1-100`],
          unknowns: [],
          confidence: 0.99
        };
      }
      return {
        kind: "final_summary",
        summary: "Task completed.",
        blockers: [],
        edit_intents: [],
        validation_plans: [],
        confidence: 0.9
      };
    }
  });
  const orchestrator = new RecursiveSwarmOrchestrator({
    provider,
    workspacePath,
    options: {
      maxDepth: 3,
      maxAgents: 10,
      enableGoalKeeper: false,
      enableParallelExecution: false,
      enableErrorRecovery: true
    }
  });

  try {
    const result = await orchestrator.run(
      `Investigate ${targetPath} and implement the grounded fix, with an independent documentation check.`
    );

    assert.deepEqual(
      { implementationCalls, recoveryCalls },
      { implementationCalls: 0, recoveryCalls: 0 },
      "Implementation and recovery must remain blocked when HIVO cannot independently verify the required workspace source"
    );
    const implementationNode = Object.values(result.runState.tree.nodes).find((node) =>
      node.name.includes("Implement bar fix")
    );
    assert.ok(implementationNode);
    assert.equal(implementationNode.status, "blocked");
    assert.match(implementationNode.errorSummary ?? "", /evidence/i);
    const independentNode = Object.values(result.runState.tree.nodes).find((node) =>
      node.name.includes("Independent documentation check")
    );
    assert.ok(independentNode);
    assert.equal(independentNode.status, "succeeded", "A missing evidence prerequisite must not block independent tasks");
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("verified workspace source allows implementation and is included in worker context", async () => {
  const targetPath = "src/elements/element.bar.js";
  const sourceExcerpt = "export function drawBar() {\n  return 'real workspace source';\n}";
  const implementationMarker = "IMPLEMENT_WITH_VERIFIED_BAR_SOURCE";
  const workspacePath = mkdtempSync(path.join(tmpdir(), "hivo-source-evidence-present-"));
  mkdirSync(path.dirname(path.join(workspacePath, targetPath)), { recursive: true });
  writeFileSync(path.join(workspacePath, targetPath), sourceExcerpt, "utf8");
  let implementationCalls = 0;
  const provider = recursiveProvider({
    atomicity: [
      { isAtomic: false, score: 6, rationale: "Root should split.", failures: ["multiple_goals"] },
      { isAtomic: true, score: 2, rationale: "Inspection task is atomic.", failures: [] },
      { isAtomic: true, score: 2, rationale: "Implementation task is atomic.", failures: [] }
    ],
    splitResults: [{
      rationale: "Verify source then implement.",
      subTasks: [
        {
          id: "inspect_bar_source",
          title: "Inspect bar source evidence",
          taskPrompt: `Inspect ${targetPath} and return source evidence.`,
          expectedOutput: "Source evidence for the bar element",
          dependencies: []
        },
        {
          id: "implement_bar_fix",
          title: "Implement bar fix",
          taskPrompt: `${implementationMarker}: implement the grounded change.`,
          expectedOutput: "Patch grounded in verified source",
          dependencies: ["0"],
          sourceEvidenceRequirement: {
            prerequisiteSubtaskId: "inspect_bar_source",
            sourcePath: targetPath,
            evidenceType: "verified_workspace_source"
          }
        }
      ]
    }],
    structuredNodeOutput: (request) => {
      if (request.userPrompt.includes(implementationMarker)) implementationCalls++;
      if (request.userPrompt.includes(`Inspect ${targetPath} and return source evidence.`)) {
        return {
          kind: "evidence_report",
          findings: ["Source inspection complete."],
          files: [targetPath],
          symbols: [],
          evidence_refs: ["worker-claim-only"],
          unknowns: [],
          confidence: 0.99
        };
      }
      return {
        kind: "final_summary",
        summary: "Task completed.",
        blockers: [],
        edit_intents: [],
        validation_plans: [],
        confidence: 0.9
      };
    }
  });
  const orchestrator = new RecursiveSwarmOrchestrator({
    provider,
    workspacePath,
    options: {
      maxDepth: 3,
      maxAgents: 10,
      enableGoalKeeper: false,
      enableParallelExecution: false,
      enableErrorRecovery: false
    }
  });

  try {
    const result = await orchestrator.run(`Inspect ${targetPath} and implement the source-grounded fix.`);
    const implementationNode = Object.values(result.runState.tree.nodes).find((node) =>
      node.name.includes("Implement bar fix")
    );
    assert.ok(implementationNode);
    assert.notEqual(implementationNode.status, "blocked");
    assert.ok(implementationCalls > 0, "verified source should permit implementation provider execution");
    const implementationRequests = provider.requests.filter((request) => request.userPrompt.includes(implementationMarker));
    assert.ok(implementationRequests.some((request) =>
      request.userPrompt.includes(sourceExcerpt)
      && request.userPrompt.includes("Independently Verified Workspace Source")
      && request.userPrompt.includes("SHA-256 of this bounded excerpt")
      && request.userPrompt.includes("Source: src/elements/element.bar.js (workspace-relative, lines 1-3)")
    ), "implementation context must contain actual source text and its verification provenance");
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("successful summary prerequisite permits implementation only with independently verified source", async () => {
  const targetPath = "src/elements/element.bar.js";
  const implementationMarker = "IMPLEMENT_WITHOUT_PREREQUISITE_EVIDENCE";
  const sourceExcerpt = "export const barSource = 'readable';";
  const workspacePath = mkdtempSync(path.join(tmpdir(), "hivo-source-evidence-false-ready-"));
  mkdirSync(path.dirname(path.join(workspacePath, targetPath)), { recursive: true });
  writeFileSync(path.join(workspacePath, targetPath), `${sourceExcerpt}\n`, "utf8");
  let implementationCalls = 0;
  const provider = recursiveProvider({
    atomicity: [
      { isAtomic: false, score: 6, rationale: "Root should split.", failures: ["multiple_goals"] },
      { isAtomic: true, score: 2, rationale: "Inspection task is atomic.", failures: [] },
      { isAtomic: true, score: 2, rationale: "Implementation task is atomic.", failures: [] },
      { isAtomic: true, score: 2, rationale: "Independent task is atomic.", failures: [] }
    ],
    splitResults: [{
      rationale: "Inspect before implementation, alongside independent work.",
      subTasks: [
        {
          id: "inspect_bar_source",
          title: "Inspect bar source",
          taskPrompt: `Inspect ${targetPath}.`,
          expectedOutput: "Inspection outcome",
          dependencies: []
        },
        {
          id: "implement_bar_fix",
          title: "Implement bar fix",
          taskPrompt: implementationMarker,
          expectedOutput: "Grounded implementation",
          dependencies: ["0"],
          sourceEvidenceRequirement: {
            prerequisiteSubtaskId: "inspect_bar_source",
            sourcePath: targetPath,
            evidenceType: "verified_workspace_source"
          }
        },
        {
          id: "independent_check",
          title: "Independent documentation check",
          taskPrompt: "Perform the independent documentation check.",
          expectedOutput: "Documentation check outcome",
          dependencies: []
        }
      ]
    }],
    structuredNodeOutput: (request) => {
      if (request.userPrompt.includes(implementationMarker)) {
        implementationCalls++;
      }
      if (request.userPrompt.includes(`Inspect ${targetPath}.`)) {
        return {
          kind: "final_summary",
          summary: "Inspection task completed without reading or reporting source evidence.",
          blockers: [],
          edit_intents: [],
          validation_plans: [],
          confidence: 0.9
        };
      }
      return {
        kind: "final_summary",
        summary: "Task completed.",
        blockers: [],
        edit_intents: [],
        validation_plans: [],
        confidence: 0.9
      };
    }
  });
  const orchestrator = new RecursiveSwarmOrchestrator({
    provider,
    workspacePath,
    options: {
      maxDepth: 3,
      maxAgents: 10,
      enableGoalKeeper: false,
      enableParallelExecution: false,
      enableErrorRecovery: true
    }
  });

  try {
    const result = await orchestrator.run(
      `Inspect ${targetPath}, implement only with prerequisite source evidence, and perform an independent documentation check.`
    );
    const inspectionNode = Object.values(result.runState.tree.nodes).find((node) =>
      node.name.includes("Inspect bar source")
    );
    assert.ok(inspectionNode);
    assert.equal(inspectionNode.status, "succeeded");
    const implementationNode = Object.values(result.runState.tree.nodes).find((node) =>
      node.name.includes("Implement bar fix")
    );
    assert.ok(implementationNode);
    assert.ok(implementationCalls > 0, "a successful prerequisite plus independently verified workspace source may permit implementation");
    assert.notEqual(implementationNode.status, "blocked");
    const implementationRequests = provider.requests.filter((request) =>
      request.userPrompt.includes(implementationMarker)
    );
    assert.ok(
      implementationRequests.some((request) =>
        request.userPrompt.includes(sourceExcerpt)
        && request.userPrompt.includes("Independently Verified Workspace Source")
        && request.userPrompt.includes("SHA-256 of this bounded excerpt")
        && request.userPrompt.includes("Source: src/elements/element.bar.js (workspace-relative, lines 1-2)")
      ),
      "implementation provider input must contain actual independently read source and provenance"
    );
    const independentNode = Object.values(result.runState.tree.nodes).find((node) =>
      node.name.includes("Independent documentation check")
    );
    assert.ok(independentNode);
    assert.equal(independentNode.status, "succeeded");
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("unresolved or undeclared source evidence prerequisites block implementation", async () => {
  const workspacePath = mkdtempSync(path.join(tmpdir(), "hivo-source-evidence-invalid-"));
  const unresolvedMarker = "IMPLEMENT_WITH_UNRESOLVED_PREREQUISITE";
  const mismatchedMarker = "IMPLEMENT_WITH_UNDECLARED_PREREQUISITE";
  let implementationCalls = 0;
  const provider = recursiveProvider({
    atomicity: [
      { isAtomic: false, score: 6, rationale: "Root should split.", failures: ["multiple_goals"] },
      { isAtomic: true, score: 2, rationale: "Inspection task is atomic.", failures: [] },
      { isAtomic: true, score: 2, rationale: "Unresolved task is atomic.", failures: [] },
      { isAtomic: true, score: 2, rationale: "Mismatched task is atomic.", failures: [] }
    ],
    splitResults: [{
      rationale: "Fixture for invalid evidence prerequisite references.",
      subTasks: [
        {
          id: "inspect_source",
          title: "Inspect source",
          taskPrompt: "Inspect source.",
          expectedOutput: "Source evidence",
          dependencies: []
        },
        {
          id: "unresolved_task",
          title: "Unresolved source task",
          taskPrompt: unresolvedMarker,
          expectedOutput: "Implementation",
          dependencies: ["0"],
          sourceEvidenceRequirement: {
            prerequisiteSubtaskId: "missing_subtask",
            sourcePath: "src/source.js",
            evidenceType: "verified_workspace_source"
          }
        },
        {
          id: "mismatched_task",
          title: "Undeclared source task",
          taskPrompt: mismatchedMarker,
          expectedOutput: "Implementation",
          dependencies: [],
          sourceEvidenceRequirement: {
            prerequisiteSubtaskId: "inspect_source",
            sourcePath: "src/source.js",
            evidenceType: "verified_workspace_source"
          }
        }
      ]
    }],
    structuredNodeOutput: (request) => {
      if (request.userPrompt.includes(unresolvedMarker) || request.userPrompt.includes(mismatchedMarker)) {
        implementationCalls++;
      }
      return {
        kind: "evidence_report",
        findings: [],
        files: [],
        symbols: [],
        evidence_refs: [],
        unknowns: [],
        confidence: 0.9
      };
    }
  });
  const orchestrator = new RecursiveSwarmOrchestrator({
    provider,
    workspacePath,
    options: {
      maxDepth: 3,
      maxAgents: 10,
      enableGoalKeeper: false,
      enableParallelExecution: false,
      enableErrorRecovery: false
    }
  });

  try {
    const result = await orchestrator.run("Implement tasks with verified source prerequisites.");
    assert.equal(implementationCalls, 0);
    for (const taskName of ["Unresolved source task", "Undeclared source task"]) {
      const node = Object.values(result.runState.tree.nodes).find((candidate) => candidate.name.includes(taskName));
      assert.ok(node);
      assert.equal(node.status, "blocked");
      assert.match(node.errorSummary ?? "", /prerequisite/i);
    }
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("splitter preserves a declared verified workspace source prerequisite", async () => {
  const targetPath = "src/elements/element.bar.js";
  const provider = recursiveProvider({
    splitResults: [{
      rationale: "Verify source before implementing.",
      subTasks: [
        {
          id: "inspect_bar_source",
          title: "Inspect bar source",
          taskPrompt: `Read ${targetPath} and return verified workspace source evidence.`,
          expectedOutput: "Verified source evidence",
          dependencies: []
        },
        {
          id: "implement_bar_fix",
          title: "Implement bar fix",
          taskPrompt: "Implement the fix using the prerequisite source evidence.",
          expectedOutput: "Grounded code patch",
          dependencies: ["0"],
          sourceEvidenceRequirement: {
            prerequisiteSubtaskId: "inspect_bar_source",
            sourcePath: targetPath,
            evidenceType: "verified_workspace_source"
          }
        }
      ]
    }]
  });
  const splitter = new RecursiveTaskSplitter({ provider });
  const split = await splitter.splitTask(makeTestNode(), {
    ...DEFAULT_RECURSIVE_SWARM_OPTIONS,
    maxDepth: 3
  });

  assert.deepEqual(split.subTasks[1].sourceEvidenceRequirement, {
    prerequisiteSubtaskId: "inspect_bar_source",
    sourcePath: targetPath,
    evidenceType: "verified_workspace_source"
  });
  assert.equal(split.subTasks[0].id, "inspect_bar_source");
});

test("deadlock detection blocks circular deps deterministically", async () => {
  const orchestrator = new RecursiveSwarmOrchestrator({
    provider: recursiveProvider({
      atomicity: [
        { isAtomic: false, score: 6, rationale: "Root should split.", failures: ["multiple_goals"] },
        { isAtomic: true, score: 2, rationale: "Child is atomic.", failures: [] },
        { isAtomic: true, score: 2, rationale: "Child is atomic.", failures: [] },
        { isAtomic: true, score: 2, rationale: "Child is atomic.", failures: [] }
      ],
      splitResults: [{
        rationale: "Provider split into ordered work.",
        subTasks: [
          { title: "Init project", taskPrompt: "Init the project", expectedOutput: "Project initialized", dependencies: [] },
          { title: "Add config", taskPrompt: "Add the config", expectedOutput: "Config added", dependencies: ["0"] },
          { title: "Write code", taskPrompt: "Write the code", expectedOutput: "Code written", dependencies: ["1"] }
        ]
      }]
    }),
    options: {
      maxDepth: 2,
      maxAgents: 10,
      enableGoalKeeper: false,
      enableParallelExecution: false,
      enableErrorRecovery: false
    }
  });
  const result = await orchestrator.run(
    "Init the project\nand add the config\nand write the code"
  );
  // If deadlock detection is wrong, some nodes would be blocked
  const blockedNodes = Object.values(result.runState.tree.nodes).filter(
    (n) => n.status === "blocked"
  );
  assert.equal(blockedNodes.length, 0,
    `no blocked nodes despite sequential dependencies (found ${blockedNodes.length})`);
});

test("orchestrator without provider blocks recursive semantic planning", async () => {
  const orchestrator = new RecursiveSwarmOrchestrator({
    options: {
      maxDepth: 3,
      maxAgents: 10,
      enableGoalKeeper: false,
      enableParallelExecution: false,
      enableErrorRecovery: false
    }
  });
  const result = await orchestrator.run("Create the config\nand set up logging\nand add metrics");
  const rootNode = result.runState.tree.nodes[result.runState.tree.rootId];
  assert.equal(rootNode.status, "blocked");
  assert.match(rootNode.errorSummary ?? "", /requires a configured provider/);
  assert.equal(result.runState.tree.status, "failed");
});

test("contradictory high-atomicity child executes without recursive split", async () => {
  const orchestrator = new RecursiveSwarmOrchestrator({
    provider: recursiveProvider({
      atomicity: [
        // Root: score=3, real failures, recommendation=split
        { isAtomic: false, score: 3, rationale: "Root task needs split.", failures: ["MULTIPLE_STEPS"], recommendation: "split" },
        // Child 0: score=9, failures=[], isAtomic=false, recommendation=split (contradictory model labels)
        { isAtomic: false, score: 9, rationale: "Run test suite satisfies all atomicity conditions.", failures: [], recommendation: "split" },
        // Child 1 (Implementation): score=9, failures=[], isAtomic=false, recommendation=split
        { isAtomic: false, score: 9, rationale: "Create minimal patch is atomic.", failures: [], recommendation: "split" }
      ],
      splitResults: [{
        rationale: "Decompose into test execution and implementation fix.",
        subTasks: [
          {
            id: "0",
            title: "Run test suite",
            taskPrompt: "Run test suite and capture failing test",
            expectedOutput: "test_report.txt",
            dependencies: [],
            responsibility: "INSPECT"
          },
          {
            id: "1",
            title: "Create minimal patch",
            taskPrompt: "Create minimal code patch to fix failing test",
            expectedOutput: "code_patch.diff",
            dependencies: ["0"],
            responsibility: "IMPLEMENT",
            canWrite: true
          }
        ]
      }],
      structuredNodeOutput: (request) => {
        if (request.userPrompt.includes("Create minimal code patch")) {
          return {
            kind: "generated_artifact",
            path: "code_patch.diff",
            content: "--- a/calc.ts\n+++ b/calc.ts\n@@ -1 +1 @@\n-return a + b;\n+return a * b;\n",
            artifact_type: "text",
            description: "Multiply fix",
            validation_steps: [],
            completeness_notes: [],
            confidence: 0.95
          };
        }
        return {
          kind: "generated_artifact",
          path: "test_report.txt",
          content: "FAIL: multiply test failed",
          artifact_type: "text",
          description: "Test run report",
          validation_steps: [],
          completeness_notes: [],
          confidence: 0.95
        };
      }
    }),
    options: {
      maxDepth: 3,
      maxAgents: 10,
      enableGoalKeeper: false,
      enableParallelExecution: false,
      enableErrorRecovery: false
    }
  });

  const result = await orchestrator.run(
    "Identify failing test and fix it"
  );

  const rootNode = result.runState.tree.nodes[result.runState.tree.rootId];
  // 1. Root decomposes
  assert.equal(rootNode.status, "succeeded");
  assert.equal(rootNode.children.length, 4); // GoalKeeper + 2 task children + 1 collector

  // 2. Contradictory high-atomicity child executes without another split
  const taskChildren = Object.values(result.runState.tree.nodes).filter(
    (n) => n.parentId === rootNode.id && n.kind === "task_agent"
  );
  assert.equal(taskChildren.length, 2);

  const testChild = taskChildren.find((n) => n.name.includes("Run test suite"));
  assert.ok(testChild, "Run test suite child exists");
  assert.equal(testChild.status, "succeeded");
  assert.equal(testChild.children.length, 0, "High-atomicity child did not split further");
  assert.equal(testChild.complexity?.isAtomic, true, "isAtomic corrected to true");
  assert.equal(testChild.complexity?.recommendation, "execute", "recommendation corrected to execute");

  // 3. Assigned task responsibility is preserved
  assert.equal(testChild.contract?.responsibility, "INSPECT");

  // 4. Genuine implementation workers remain reachable
  const implementChild = taskChildren.find((n) => n.name.includes("Create minimal patch"));
  assert.ok(implementChild, "Implementation child exists");
  assert.equal(implementChild.status, "succeeded");
  assert.equal(implementChild.contract?.responsibility, "IMPLEMENT");
  assert.equal(implementChild.children.length, 0, "Implementation child executed directly without splitting");

  // 5. No fabricated patch success: real artifact generated
  assert.equal(implementChild.structuredOutput?.kind, "generated_artifact");
  assert.equal(result.totalSplits, 1, "Only Root split (1 split total, no repeated splits to depth 4)");
  assert.equal(result.totalExecutions, 2, "Both children executed directly");
});

