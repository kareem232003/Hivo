import type {
  CommandLifecycleEventType,
  CommandRequest,
  PatchLifecycleEventType,
  PatchProposal,
  PreviewRecommendation,
  SessionLifecycleEventType,
  ValidationTruthStatus,
  VerificationLifecycleEventType,
  WorkspaceInfo
} from "./models.js";
import type { AgentRun, WorkerOutput } from "./agents.js";
import type { RunTrustProfile, SafetySettings } from "./approvals.js";
import type { TaskGraph } from "./task-graph.js";

export type RuntimeExecutionMode = "auto_mode" | "simple_mode" | "orchestrated_mode" | "recursive_factory";

export type DelegationComplexity = "low" | "medium" | "high";

export type AgentRoleReason = {
  agentName: string;
  reason: string;
};

export type DelegationDecision = {
  resolvedMode: Exclude<RuntimeExecutionMode, "auto_mode">;
  explicitUserDirective?: string;
  requestedAgentCount?: number;
  selectedAgentCount: number;
  selectedAgentRoles: string[];
  agentRoleReasons: AgentRoleReason[];
  estimatedComplexity: DelegationComplexity;
  rationale: string;
};

export type WorkOrder = {
  id: string;
  sessionId: string;
  agentName: string;
  dynamicRole: string;
  objective: string;
  acceptanceCriteria: string[];
  requiredArtifacts: string[];
  allowedTools: string[];
  dependsOn: string[];
  intentFrame?: AgentIntentInputFrame;
};

export type WorkerCapabilityGrant = {
  id: string;
  workerId: string;
  sessionId: string;
  allowedPaths: string[];
  allowedTools: string[];
  allowedCommandRisks: Array<"safe" | "medium" | "dangerous">;
  canProposePatches: boolean;
  canRequestCommands: boolean;
  allowNetwork: boolean;
  expiresAt: string;
};

export type WorkerSpec = {
  id: string;
  sessionId: string;
  roleTitle: string;
  persona: string;
  objective: string;
  tasks: string[];
  acceptanceCriteria: string[];
  requiredArtifacts: string[];
  dependsOn: string[];
  targetFiles: string[];
  capabilityGrant: WorkerCapabilityGrant;
  intentFrame?: AgentIntentInputFrame;
};

export type ArtifactHandoff = {
  id: string;
  sessionId: string;
  workerId: string;
  roleTitle: string;
  summary: string;
  details: string[];
  patchProposalIds: string[];
  commandRequestIds: string[];
  validationNotes: string[];
  intentAlignment?: AgentIntentAlignment;
  intentHandoffGate?: IntentHandoffGateResult;
  createdAt: string;
};

export type ValidationGateResult = {
  id: string;
  sessionId: string;
  status: "passed" | "failed";
  blockingReasons: string[];
  notes: string[];
  createdAt: string;
};

export type AgentAssignmentPlan = {
  id: string;
  sessionId: string;
  trustProfile: RunTrustProfile;
  workerSpecs: WorkerSpec[];
  rationale: string;
  createdAt: string;
};

export type WorkerSelfCheck = {
  workOrderId: string;
  passedCriteria: string[];
  failedCriteria: string[];
  missingItems: string[];
  confidence: number;
};

export type QualityGateResult = {
  id: string;
  sessionId: string;
  gateName: "ReviewerGate" | "SecurityGate" | "TestGate";
  status: "passed" | "failed";
  blockingReasons: string[];
  reviewerNotes: string[];
  createdAt: string;
};

export type PatchChangeStats = {
  path: string;
  added?: number;
  removed?: number;
  changeType: "create" | "modify" | "delete";
};

export type RuntimeProgressStage =
  | "planning"
  | "inspecting"
  | "assigning"
  | "working"
  | "patching"
  | "reviewing"
  | "applying"
  | "completed"
  | "blocked";

export type RuntimeProgressStatus = "queued" | "running" | "completed" | "blocked" | "failed";

export type RuntimeProgressEvent = {
  id: string;
  sessionId: string;
  stage: RuntimeProgressStage;
  agentName?: string;
  role?: string;
  taskTitle?: string;
  summary: string;
  status: RuntimeProgressStatus;
  targetFiles: string[];
  patchStats?: PatchChangeStats[];
  createdAt: string;
};

export type AgentWorkStatus = {
  agentName: string;
  role: string;
  taskTitle: string;
  objective: string;
  status: RuntimeProgressStatus;
  targetFiles: string[];
  summary?: string;
  selfCheck?: WorkerSelfCheck;
  updatedAt: string;
};

export type RunSummary = {
  status: "pending" | "completed" | "blocked" | "failed";
  summary: string;
  filesChanged: PatchChangeStats[];
  appliedPatchIds: string[];
  proposedPatchIds: string[];
  commandResults: string[];
  commandTruth?: Array<{
    command: string;
    status: string;
    risk: string;
    approvalRequired: boolean;
    blockedReason?: string;
    stdoutSummary: string;
    stderrSummary: string;
  }>;
  gates: Array<{
    name: string;
    status: "passed" | "failed" | "blocked";
    notes: string[];
  }>;
  nextAction?: string;
  createdAt: string;
};

export type ProductBrief = {
  goal: string;
  userIntent:
    | "new_project"
    | "modify_existing_project"
    | "bug_fix"
    | "refactor"
    | "add_feature"
    | "write_tests"
    | "explain_code";
  scope: string[];
  constraints: string[];
  successCriteria: string[];
  clarifyingQuestions: string[];
  assumptions: string[];
};

export type IntentContractStatus =
  | "ready"
  | "needs_clarification"
  | "provider_unavailable"
  | "invalid";

export type IntentContractRunKind = "core" | "swarm" | "runtime_session";

export type IntentContractPriorityKey =
  | "speed"
  | "quality"
  | "realism"
  | "fun"
  | "security"
  | "cost";

export type IntentContractPriority = {
  score: number;
  rationale: string;
};

export type IntentContractQuestion = {
  question: string;
  reason: string;
  blocking: boolean;
};

export type IntentContractTradeoff = {
  name: string;
  options: string[];
  preferred?: string;
  rationale?: string;
};

export type IntentContract = {
  schema_version: number;
  contract_id: string;
  run_id: string;
  run_kind: IntentContractRunKind;
  revision: number;
  original_user_request: string;
  precise_rewrite: string;
  assumptions: string[];
  missing_questions: IntentContractQuestion[];
  tradeoffs: IntentContractTradeoff[];
  priorities: Record<IntentContractPriorityKey, IntentContractPriority>;
  definition_of_done: string[];
  non_goals: string[];
  conflict_rules: string[];
  status: IntentContractStatus;
  created_at: string;
  artifact_ref?: string;
  summary_ref?: string;
  metadata_json: Record<string, unknown>;
};

export type AgentIntentLayer =
  | "core"
  | "swarm"
  | "legacy_orchestrated"
  | "runtime_delegation";

export type AgentIntentLockedDefinition = {
  term: string;
  definition: string;
  revision?: number;
  source?: string;
  artifact_ref?: string;
};

export type AgentIntentTaskSlice = {
  task_slice_id: string;
  task_id: string;
  parent_task_id?: string;
  layer: AgentIntentLayer;
  role: string;
  objective: string;
  task_title?: string;
  task_type?: string;
  slice_summary: string;
  read_files: string[];
  write_files: string[];
  allowed_files: string[];
  forbidden_files: string[];
  dependencies: string[];
  expected_output_schema: string;
  validation_requirements: string[];
  context_refs: string[];
  risk_level?: string;
  metadata_json: Record<string, unknown>;
};

export type AgentIntentInputFrame = {
  schema_version: number;
  frame_id: string;
  run_id: string;
  run_kind: IntentContractRunKind;
  layer: AgentIntentLayer;
  original_user_request: string;
  original_request_hash: string;
  original_request_ref?: string;
  intent_contract: IntentContract;
  intent_contract_ref?: string;
  intent_contract_status: IntentContractStatus;
  intent_ledger_refs: string[];
  locked_intent_definitions: AgentIntentLockedDefinition[];
  current_task_slice: AgentIntentTaskSlice;
  created_at: string;
  metadata_json: Record<string, unknown>;
};

export type AgentIntentAlignment = {
  schema_version: number;
  alignment_id?: string;
  run_id?: string;
  task_id?: string;
  original_request_hash: string;
  intent_contract_ref?: string;
  intent_contract_revision?: number;
  task_slice_id?: string;
  task_understanding: string;
  original_goal_contribution: string;
  possible_intent_conflicts: string[];
  assumptions_used: string[];
  evidence_refs: string[];
};

export type IntentHandoffGateResult = {
  schema_version: number;
  gate_id: string;
  run_id: string;
  task_id: string;
  layer: AgentIntentLayer;
  passed: boolean;
  status: "passed" | "blocked";
  deterministic_errors: string[];
  provider_used: boolean;
  provider_status?: "aligned" | "possible_drift" | "drift_detected" | "insufficient_context";
  reviewed_artifact_refs: string[];
  frame_ref?: string;
  output_ref?: string;
  artifact_ref?: string;
  alignment?: AgentIntentAlignment;
  created_at: string;
  metadata_json: Record<string, unknown>;
};

export type SemanticConflictPhase =
  | "planning"
  | "review"
  | "integration"
  | "post_integration"
  | "finalization";

export type SemanticConflictSeverity = "info" | "warning" | "blocking";

export type SemanticConflictDecisionStatus =
  | "resolved"
  | "requires_user_approval"
  | "blocked"
  | "provider_unavailable";

export type SemanticConflictDecision = {
  schema_version: number;
  decision_id: string;
  batch_id?: string;
  run_id: string;
  phase: SemanticConflictPhase;
  conflict: string;
  source_a: string;
  source_b: string;
  root_intent: string;
  decision: string;
  reason: string;
  requires_user_approval: boolean;
  severity: SemanticConflictSeverity;
  status: SemanticConflictDecisionStatus;
  question?: string;
  options: string[];
  source_refs: string[];
  evidence_refs: string[];
  intent_contract_ref?: string;
  project_goal_spec_ref?: string;
  artifact_ref?: string;
  summary_ref?: string;
  created_at: string;
  resolved_at?: string;
  metadata_json: Record<string, unknown>;
};

export type SemanticConflictResolutionBatchStatus =
  | "resolved"
  | "requires_user_approval"
  | "blocked"
  | "provider_unavailable"
  | "empty";

export type SemanticConflictResolutionBatch = {
  schema_version: number;
  batch_id: string;
  run_id: string;
  phase: SemanticConflictPhase;
  status: SemanticConflictResolutionBatchStatus;
  root_intent: string;
  decision_ids: string[];
  decisions: SemanticConflictDecision[];
  unresolved_decision_ids: string[];
  provider_used: boolean;
  artifact_ref?: string;
  summary_ref?: string;
  created_at: string;
  metadata_json: Record<string, unknown>;
};

export type FactoryArtifactStatus = "proposed" | "approved" | "rejected" | "changes_requested";

export type ProductSpecification = {
  id: string;
  sessionId: string;
  revision: number;
  status: FactoryArtifactStatus;
  userGoal: string;
  clarifiedAssumptions: string[];
  targetUsers: string[];
  expectedBehavior: string[];
  acceptanceCriteria: string[];
  nonGoals: string[];
  openQuestions: string[];
  risks: string[];
  createdAt: string;
  updatedAt: string;
};

export type BusinessBrief = {
  mvpScope: string[];
  outOfScope: string[];
  userValue: string;
  businessRisks: string[];
  acceptanceCriteria: string[];
  priority: "low" | "medium" | "high";
  releaseNotesDraft: string;
};

export type TechnicalPlan = {
  id?: string;
  sessionId?: string;
  revision?: number;
  status?: FactoryArtifactStatus;
  summary: string;
  architectureImpact: string;
  affectedAreas: string[];
  projectAreasAffected?: string[];
  filesLikelyTouched?: string[];
  implementationStrategy?: string[];
  testStrategy: string[];
  validationCommands?: string[];
  expectedPatchGroups?: string[];
  rollbackNotes?: string[];
  riskLevel: "low" | "medium" | "high";
  taskGraph: TaskGraph;
  createdAt?: string;
  updatedAt?: string;
};

export type RecursiveBranchStatus =
  | "planned"
  | "waiting_on_dependency"
  | "ready"
  | "running"
  | "patch_proposed"
  | "reviewing"
  | "validation_pending"
  | "blocked"
  | "blocked_conflict"
  | "blocked_failed_dependency"
  | "completed"
  | "failed"
  | "skipped"
  | "planned_only";

export type RecursiveGraphStatus = "proposed" | "ready" | "blocked";

export type RecursiveGraphBlockReason =
  | "branch_scope_conflict"
  | "unsafe_parallel_write_scope"
  | "missing_file_scope"
  | "unresolved_dependency";

export type BranchScopeConflict = {
  id: string;
  sessionId: string;
  branchIds: string[];
  filePath?: string;
  semanticScope?: string;
  code: RecursiveGraphBlockReason;
  severity: "info" | "warning" | "blocking";
  reason: string;
  requiresOrdering: boolean;
  sharedLockScope?: string;
  createdAt: string;
};

export type BranchOrchestratorRecord = {
  branchId: string;
  sessionId: string;
  graphId: string;
  title: string;
  objective: string;
  ownerRole: string;
  inputContextRequirements: string[];
  fileScopes: string[];
  semanticScopes: string[];
  lockScopes: string[];
  dependencies: string[];
  expectedOutputs: string[];
  reviewerRequirements: string[];
  testerRequirements: string[];
  status: RecursiveBranchStatus;
  risks: string[];
  validationStrategy: string[];
  expectedIntegrationPoints: string[];
  createdAt: string;
  updatedAt: string;
};

export type RecursiveBranchReviewStatus = "not_started" | "pending" | "approved" | "needs_changes" | "blocked";

export type RecursiveBranchExecutionContext = {
  branchObjective: string;
  approvedProductSpecSummary: string;
  approvedTechnicalPlanSummary: string;
  fileScopes: string[];
  semanticScopes: string[];
  lockScopes: string[];
  dependencies: string[];
  evidenceContextPack: string[];
};

export type RecursiveBranchExecutionRecord = {
  branchId: string;
  sessionId: string;
  title: string;
  status: RecursiveBranchStatus;
  active: boolean;
  executionContext: RecursiveBranchExecutionContext;
  schedulerDecision: {
    maxActiveWriteBranches: number;
    writeBranch: boolean;
    blockedReason?: RecursiveGraphBlockReason | "execution_not_approved" | "dependency_waiting" | "failed_dependency";
    sequencingReason?: string;
  };
  plannedPatch?: {
    targetFile: string;
    replacementText: string;
  };
  plannedNestedPatches?: Array<{
    targetFile: string;
    replacementText: string;
    objective?: string;
  }>;
  proposedPatchId?: string;
  nestedDepth?: 0 | 1;
  nestedEligible?: boolean;
  nestedBlockedReason?: string;
  nestedSubtasks?: RecursiveNestedSubtaskRecord[];
  nestedRollup?: RecursiveNestedSubtaskRollup;
  reviewStatus: RecursiveBranchReviewStatus;
  validationStatus: ValidationTruthStatus;
  validationPlan: string[];
  blockedReason?: string;
  conflictReason?: string;
  patchApplied: boolean;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type RecursiveNestedSubtaskStatus =
  | "planned"
  | "waiting_on_dependency"
  | "ready"
  | "running"
  | "patch_proposed"
  | "reviewing"
  | "validation_pending"
  | "completed"
  | "failed"
  | "blocked"
  | "blocked_conflict";

export type RecursiveNestedSubtaskRecord = {
  subtaskId: string;
  sessionId: string;
  parentBranchId: string;
  depth: 1;
  objective: string;
  fileScopes: string[];
  dependencies: string[];
  expectedOutput: string;
  reviewerRequirement: string;
  validatorRequirement: string;
  status: RecursiveNestedSubtaskStatus;
  required: boolean;
  writeSubtask: boolean;
  plannedPatch?: {
    targetFile: string;
    replacementText: string;
  };
  proposedPatchId?: string;
  patchApplied: boolean;
  validationStatus: ValidationTruthStatus;
  blockedReason?: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type RecursiveNestedSubtaskRollup = {
  parentBranchId: string;
  completedSubtasks: string[];
  failedSubtasks: string[];
  blockedSubtasks: string[];
  appliedPatches: string[];
  validationState: ValidationTruthStatus;
  limitations: string[];
  updatedAt: string;
};

export type RecursiveValidationLevel = "branch_validation" | "integration_validation" | "final_validation";

export type RecursiveValidationCommandClassification =
  | "safe_auto"
  | "needs_approval"
  | "blocked"
  | "missing";

export type RecursiveDiscoveredValidationCommand = {
  command: string;
  cwd: string;
  kind: "test" | "lint" | "typecheck" | "build" | "smoke" | "unknown";
  source: string;
  classification: RecursiveValidationCommandClassification;
  risk?: "safe" | "medium" | "dangerous";
  reason: string;
};

export type RecursiveValidationStrategy = {
  kind: "command" | "patch_effect" | "missing";
  command?: string;
  cwd?: string;
  classification: RecursiveValidationCommandClassification;
  scope: "project" | "patch_effect" | "none";
  reason: string;
  source?: string;
};

export type RecursiveValidationEvidence = {
  kind: "command" | "patch_effect";
  truthStatus: ValidationTruthStatus;
  summary: string;
  command?: string;
  cwd?: string;
  requestId?: string;
  executionId?: string;
  exitCode?: number;
  policyResult?: string;
  stdoutSummary?: string;
  stderrSummary?: string;
  files?: string[];
  scope: "project" | "patch_effect";
};

export type RecursiveValidationRecord = {
  id: string;
  sessionId: string;
  level: RecursiveValidationLevel;
  branchId?: string;
  truthStatus: ValidationTruthStatus;
  status: "passed" | "failed" | "unverified";
  summary: string;
  blockingReasons: string[];
  evidenceRefs: string[];
  discoveredCommands?: RecursiveDiscoveredValidationCommand[];
  selectedStrategy?: RecursiveValidationStrategy;
  evidence?: RecursiveValidationEvidence[];
  createdAt: string;
  updatedAt: string;
};

export type RecursiveValidationAttempt = {
  attemptNumber: number;
  role: "initial" | "repair_revalidation";
  command: string;
  cwd: string;
  truthStatus: ValidationTruthStatus;
  status: string;
  exitCode?: number;
  stdoutSummary?: string;
  stderrSummary?: string;
  requestId?: string;
  executionId?: string;
  policyResult?: string;
  summary: string;
  createdAt: string;
};

export type RecursivePatchProvenance = {
  patchId: string;
  branchId?: string;
  subtaskId?: string;
  filesChanged: string[];
  diffHunks: Array<{
    filePath: string;
    header: string;
    addedLines: string[];
    removedLines: string[];
  }>;
  touchedSymbols: Array<{
    filePath: string;
    name: string;
    kind: "function" | "class" | "method" | "module" | "unknown";
  }>;
  fileHashes: Array<{
    path: string;
    beforeHash?: string;
    afterHash?: string;
  }>;
  rustApplyResultId?: string;
  validationAttemptId?: string;
};

export type RecursiveValidationFailureSignals = {
  commandType: "pytest" | "npm" | "cargo" | "other";
  failingTestFiles: string[];
  sourceFiles: string[];
  assertionMessages: string[];
  importModules: string[];
  stackFrames: Array<{
    filePath?: string;
    line?: number;
    functionName?: string;
    raw: string;
  }>;
  lineNumbers: Array<{
    filePath?: string;
    line: number;
  }>;
};

export type RecursiveFailurePatchAttribution = {
  relatedPatchIds: string[];
  relatedBranchIds: string[];
  confidence: "high" | "medium" | "low" | "none";
  evidence: string[];
  reason: string;
  memoryFreshness: "fresh" | "stale" | "unknown";
};

export type RecursiveValidationFailureDiagnosis = {
  id: string;
  sessionId: string;
  command: string;
  cwd: string;
  exitCode?: number;
  stdoutSummary?: string;
  stderrSummary?: string;
  failingTests: string[];
  errors: string[];
  likelyFiles: string[];
  branchIds: string[];
  patchIds: string[];
  failureSignals: RecursiveValidationFailureSignals;
  attribution: RecursiveFailurePatchAttribution;
  summary: string;
  createdAt: string;
};

export type RecursiveRepairEligibility = {
  status: "eligible" | "repair_not_attempted";
  reasons: string[];
  attemptCount: number;
  maxAttempts: number;
  relatedFiles: string[];
  relatedPatchIds: string[];
};

export type RecursiveRepairRecord = {
  id: string;
  sessionId: string;
  status:
    | "diagnosed"
    | "repair_not_attempted"
    | "patch_proposed"
    | "awaiting_rust_apply"
    | "applied"
    | "revalidation_requested"
    | "revalidated";
  attemptCount: number;
  maxAttempts: number;
  diagnosis: RecursiveValidationFailureDiagnosis;
  eligibility: RecursiveRepairEligibility;
  repairPatchId?: string;
  repairPatchStatus?: PatchProposal["status"];
  revalidationRequestId?: string;
  validationAttempts: RecursiveValidationAttempt[];
  finalOutcome?: ValidationTruthStatus;
  summary: string;
  createdAt: string;
  updatedAt: string;
};

export type RecursiveBranchResultRecord = {
  id: string;
  sessionId: string;
  branchId: string;
  objective: string;
  patchIds: string[];
  appliedState: "not_applied" | "partially_applied" | "applied" | "apply_failed";
  reviewResult: RecursiveBranchReviewStatus;
  validationState: ValidationTruthStatus;
  filesChanged: string[];
  nestedRollup?: RecursiveNestedSubtaskRollup;
  risksAndLimitations: string[];
  evidenceSummary: string[];
  createdAt: string;
  updatedAt: string;
};

export type RecursiveIntegrationNodeLevel = "local_team" | "area" | "domain" | "root";

export type RecursiveIntegrationNodeSummary = {
  id: string;
  sessionId: string;
  level: RecursiveIntegrationNodeLevel;
  title: string;
  parentNodeId?: string;
  childNodeIds: string[];
  branchIds: string[];
  integratedResultRefs: string[];
  conflictReportRefs: string[];
  validation: RecursiveValidationRecord;
  intentAlignmentScore: number;
  unresolvedDecisions: string[];
  conflictsResolved: string[];
  conflictsUnresolved: string[];
  integrationRisks: string[];
  remainingManualSteps: string[];
  createdAt: string;
  updatedAt: string;
  metadata_json: Record<string, unknown>;
};

export type RecursiveIntegrationSummary = {
  id: string;
  sessionId: string;
  completedBranches: string[];
  blockedBranches: string[];
  failedBranches: string[];
  unverifiedBranches: string[];
  conflictsResolved: string[];
  conflictsUnresolved: string[];
  integrationRisks: string[];
  remainingManualSteps: string[];
  validation: RecursiveValidationRecord;
  integrationHierarchy?: RecursiveIntegrationNodeSummary[];
  createdAt: string;
  updatedAt: string;
};

export type RecursiveFinalReport = {
  id: string;
  sessionId: string;
  productGoal: string;
  approvedTechnicalPlanSummary: string;
  graphSummary: string;
  branchOutcomes: RecursiveBranchResultRecord[];
  patchApplyTruth: Array<{
    patchId: string;
    status: PatchProposal["status"];
    filesChanged: string[];
  }>;
  patchProvenance: RecursivePatchProvenance[];
  validationHierarchy: RecursiveValidationRecord[];
  finalValidationState: ValidationTruthStatus;
  finalStatus: "passed" | "failed" | "unverified";
  validationDiscovery?: {
    discoveredCommands: RecursiveDiscoveredValidationCommand[];
    chosenStrategy: RecursiveValidationStrategy;
    evidence: RecursiveValidationEvidence[];
    statusReason: string;
  };
  repair?: RecursiveRepairRecord;
  knownLimitations: string[];
  recommendedNextStep: string;
  createdAt: string;
  updatedAt: string;
};

export type RecursiveGraphReadiness = {
  status: "ready" | "blocked";
  summary: string;
  blockedReasons: RecursiveGraphBlockReason[];
  checkedAt: string;
};

export type HierarchicalRecursiveGraph = {
  id: string;
  sessionId: string;
  technicalPlanId: string;
  status: RecursiveGraphStatus;
  rootGoal: string;
  rootNode: {
    id: string;
    title: string;
    objective: string;
  };
  branches: BranchOrchestratorRecord[];
  dependencies: Array<{
    from: string;
    to: string;
    reason: string;
  }>;
  conflicts: BranchScopeConflict[];
  readiness: RecursiveGraphReadiness;
  createdAt: string;
  updatedAt: string;
};

export type RecursiveFactoryState = {
  phase:
    | "clarification"
    | "product_spec_approval"
    | "technical_plan_approval"
    | "recursive_graph_ready"
    | "recursive_graph_blocked"
    | "approved_to_execute"
    | "branch_execution_ready"
    | "branch_execution_running"
    | "branch_execution_blocked"
    | "branch_execution_completed";
  productSpec?: ProductSpecification;
  technicalPlan?: TechnicalPlan;
  recursiveGraph?: HierarchicalRecursiveGraph;
  branchOrchestrators?: BranchOrchestratorRecord[];
  branchExecutions?: RecursiveBranchExecutionRecord[];
  branchResults?: RecursiveBranchResultRecord[];
  integrationSummary?: RecursiveIntegrationSummary;
  validationHierarchy?: RecursiveValidationRecord[];
  finalReport?: RecursiveFinalReport;
  repair?: RecursiveRepairRecord;
  branchScopeConflicts?: BranchScopeConflict[];
  semanticConflictBatches?: SemanticConflictResolutionBatch[];
  semanticConflictDecisions?: SemanticConflictDecision[];
  graphReadiness?: RecursiveGraphReadiness;
  activeBranchId?: string;
  executionStarted: boolean;
  updatedAt: string;
};

export type ProjectMap = {
  stack: string[];
  packageManagers: string[];
  testCommands: string[];
  entryPoints: string[];
  importantFiles: string[];
  projectKind?: import("./models.js").ProjectKind;
  intakeConfidence?: import("./models.js").ProjectIntakeConfidence;
  currentStateSummary?: string;
};

export type ReviewResult = {
  id: string;
  sessionId: string;
  reviewer: "SecurityAgent" | "ReviewerAgent";
  targetIds: string[];
  status: "passed" | "needs_changes" | "blocked";
  summary: string;
  findings: string[];
  createdAt: string;
};

export type OrchestrationEventType =
  | "orchestration.started"
  | "product_brief.created"
  | "business_brief.created"
  | "technical_plan.created"
  | "task.created"
  | "task.started"
  | "task.completed"
  | "task.failed"
  | "file_lock.acquired"
  | "file_lock.waiting"
  | "file_lock.conflict"
  | "file_lock.released"
  | "parallel_execution.active"
  | "lifecycle.stage.changed"
  | "validation.completed"
  | "agent.started"
  | "agent.completed"
  | PatchLifecycleEventType
  | "security.reviewed"
  | CommandLifecycleEventType
  | VerificationLifecycleEventType
  | SessionLifecycleEventType
  | "orchestration.completed"
  | "orchestration.failed";

export type OrchestrationEvent = {
  id: string;
  sessionId: string;
  type: OrchestrationEventType;
  message: string;
  agentName?: string;
  taskId?: string;
  createdAt: string;
};

export type OrchestrationState = {
  productBrief?: ProductBrief;
  businessBrief?: BusinessBrief;
  technicalPlan?: TechnicalPlan;
  assignmentPlan?: AgentAssignmentPlan;
  taskGraph?: TaskGraph;
  projectMap?: ProjectMap;
  agentRuns: AgentRun[];
  workerOutputs: WorkerOutput[];
  securityReviews: ReviewResult[];
  reviewerSummaries: ReviewResult[];
  orchestrationEvents: OrchestrationEvent[];
  approvalDecisions: import("./approvals.js").ApprovalRecord[];
  safetySettings: SafetySettings;
  lockedFiles: Record<string, string>;
  selectedWorkerAgents: string[];
  mandatoryGateAgents: string[];
  workOrders: WorkOrder[];
  qualityGateResults: QualityGateResult[];
  validationGateResult?: ValidationGateResult;
  artifactHandoffs?: ArtifactHandoff[];
  retryCount: number;
};

export type OrchestrationRunContext = {
  sessionId: string;
  userPrompt: string;
  workspacePath: string;
  workspaceInfo?: WorkspaceInfo;
  safetySettings: SafetySettings;
  patchProposals: PatchProposal[];
  commandRequests: CommandRequest[];
};

export type SessionNextAction =
  | {
      kind: "clarify_request";
      message: string;
      originalRequest: string;
      missingFacts: string[];
    }
  | {
      kind: "clarify_plan";
      message: string;
      options: Array<{
        id: string;
        label: string;
        prompt: string;
      }>;
      allowCustom?: boolean;
    }
  | {
      kind: "confirm_plan";
      message: string;
    }
  | {
      kind: "clarify_product_spec";
      message: string;
      questions: string[];
    }
  | {
      kind: "approve_product_spec";
      message: string;
      artifactId: string;
    }
  | {
      kind: "approve_technical_plan";
      message: string;
      artifactId: string;
    }
  | {
      kind: "approve_patch";
      message: string;
      patchId: string;
    }
  | {
      kind: "confirm_preview";
      message: string;
      preview: PreviewRecommendation;
    }
  | {
      kind: "approve_commands";
      message: string;
    }
  | {
      kind: "resolve_semantic_conflict";
      message: string;
      decisionId: string;
      question: string;
      options: string[];
      evidenceRefs: string[];
    }
  | {
      kind: "preview_ready";
      message: string;
      preview: PreviewRecommendation;
    }
  | {
      kind: "await_baseline_command";
      commandRequestId: string;
      command: string;
      originalPrompt: string;
      message: string;
    };
