import {
  Archive,
  ArrowUp,
  Bot,
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  Diff,
  FileText,
  FolderOpen,
  FolderTree,
  GitBranch,
  Globe,
  Languages,
  LoaderCircle,
  MessageSquarePlus,
  PanelLeft,
  Pin,
  Play,
  RefreshCw,
  RotateCcw,
  Settings,
  ShieldCheck,
  TerminalSquare,
  ToggleLeft,
  ToggleRight,
  Trash2,
  Workflow,
  X
} from "lucide-react";
import type {
  AccessProfile,
  AgentRiskRef,
  AgentRuntimeSwarmNode,
  AgentRun,
  AppEvent,
  AgentWorkJournalEntry,
  AgentRuntimeSession,
  AgentWorkStatus,
  CommandRequest,
  CommandResult,
  DecisionRecord,
  EvidenceRef,
  FileEntry,
  GitStatus,
  ModelInfo,
  ModelProviderConfig,
  ModelProviderType,
  PatchChangeStats,
  RunMode,
  RunPhase,
  SafetySettings,
  WorkerSpec,
  WorkOrder,
  WorkspaceInfo
} from "@hivo/protocol";
import { accessProfileDefaults, defaultSafetySettings } from "@hivo/protocol";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import {
  approveRuntimePatch,
  assertRuntimeAvailable,
  checkRuntimeHealth,
  createRuntimeSession,
  decideRuntimeProductSpec,
  decideRuntimeTechnicalPlan,
  getRuntimeSession,
  rejectRuntimePatch,
  reportRuntimePatchApplyResult,
  RuntimeHttpError,
  type RuntimeEventSubscriptionState,
  RuntimeUnavailableError,
  runRuntimeTurn,
  startRuntimeRecursiveBranchExecution,
  subscribeRuntimeEvents
} from "../lib/agentRuntime";
import {
  clearModelProviderConfig,
  appendSessionEvent,
  applyRuntimePatch,
  createRuntimeRun,
  getCodeFreshnessStatus,
  getSavedRuntimeSession,
  getGitDiff,
  getGitStatus,
  getModelProviderConfig,
  listAvailableModels,
  listWorkspaceFiles,
  openWorkspace,
  openExternalTarget,
  pickWorkspaceDirectory,
  readWorkspaceFile,
  rejectRuntimePatchViaRust,
  restartWithLatestCode,
  runWorkspaceCommand,
  upsertAgentRun,
  upsertOrchestrationRun,
  saveModelProviderConfig,
  validateModelProvider,
  type CodeFreshnessStatus,
  type ModelProviderConfigInput
} from "../lib/tauri";
import { canAutoRunRuntimeCommand, executeRuntimeCommandRequest } from "../lib/terminalOrchestrator";
import { buildPrimaryActivityItems, describeCurrentStep, describeNextProgressStep, type ActivityStreamItem, type ActiveRuntimeCommand } from "./activityStream";
import { SwarmDock } from "./SwarmDock";

type ProviderPreset = {
  label: string;
  providerType: ModelProviderType;
  providerName: string;
  baseUrl: string;
};

type AccessOption = {
  value: AccessProfile;
  label: string;
  description: string;
};

type QueuedPrompt = {
  id: string;
  text: string;
  mode: "queued" | "steer";
};

type BottomView = "none" | "terminal" | "diff";

type RecentWorkspaceEntry = {
  path: string;
  name: string;
  lastOpenedAt: string;
  lastSessionId?: string;
};

type RecentSessionEntry = {
  id: string;
  workspacePath: string;
  workspaceName: string;
  title: string;
  status: string;
  updatedAt: string;
};

type FileReference = {
  path: string;
  line: number;
  lineEnd?: number;
};

type ActiveFileReference = FileReference & {
  content: string;
  status: "loading" | "ready" | "failed";
  error?: string;
};

type StoredSessionToken = {
  token: string;
  expiresAt: string;
};

type FileExplorerProject = {
  path: string;
  name: string;
};

type FileTreeNode = {
  key: string;
  name: string;
  path: string;
  isDir: boolean;
  children: FileTreeNode[];
};

const RECENT_WORKSPACES_KEY = "hivo.recentWorkspaces";
const RECENT_SESSIONS_KEY = "hivo.recentSessions";
const LAST_WORKSPACE_KEY = "hivo.lastWorkspace";
const PROMPT_HISTORY_KEY = "hivo.promptHistory";
const COMPOSER_SCALE_KEY = "hivo.composerScale";
const FULL_ACCESS_WARNING_KEY = "hivo.fullAccessAcknowledged";
const RTL_TEXT_MODE_KEY = "hivo.rtlTextMode";
const SIDEBAR_WIDTH_KEY = "hivo.sidebarWidth";
const SESSION_TOKENS_KEY = "hivo.sessionTokens";
const COLLAPSED_PROJECTS_KEY = "hivo.collapsedProjects";
const ARCHIVED_SESSIONS_KEY = "hivo.archivedSessions";
const PINNED_SESSIONS_KEY = "hivo.pinnedSessions";
const SESSION_TITLE_MIGRATION_KEY = "hivo.sessionTitleMigration.v1";
const PET_VISIBLE_KEY = "hivo.petVisible";
const AUTO_RESTART_ATTEMPT_KEY = "hivo.latestCodeAutoRestartAttempt";
const INITIAL_SSE_STATE: RuntimeEventSubscriptionState = {
  status: "disconnected",
  connected: false,
  disconnected: true,
  reconnecting: false,
  unauthorized: false,
  tokenExpired: false,
  retryAttempt: 0
};
const MIGRATED_STORAGE_KEYS = [
  RECENT_WORKSPACES_KEY,
  RECENT_SESSIONS_KEY,
  LAST_WORKSPACE_KEY,
  PROMPT_HISTORY_KEY,
  COMPOSER_SCALE_KEY,
  FULL_ACCESS_WARNING_KEY,
  RTL_TEXT_MODE_KEY,
  SIDEBAR_WIDTH_KEY,
  SESSION_TOKENS_KEY,
  COLLAPSED_PROJECTS_KEY,
  ARCHIVED_SESSIONS_KEY,
  PINNED_SESSIONS_KEY,
  SESSION_TITLE_MIGRATION_KEY
];
const MAX_RECENT_WORKSPACES = 8;
const MAX_RECENT_SESSIONS = 12;
const MAX_PROMPT_HISTORY = 50;
const MAX_SESSION_TITLE_WORDS = 4;
const MAX_VISIBLE_PROJECT_SESSIONS = 5;
const DEFAULT_COMPOSER_SCALE = 0.78;
const MIN_COMPOSER_SCALE = 0.55;
const MAX_COMPOSER_SCALE = 1.35;
const COMPOSER_SCALE_STEP = 0.1;
const DEFAULT_SIDEBAR_WIDTH = 320;
const MIN_SIDEBAR_WIDTH = 248;
const MAX_SIDEBAR_WIDTH = 520;
const COLLAPSED_SIDEBAR_WIDTH = 72;
const CODE_FRESHNESS_POLL_MS = 2_000;
const AUTO_RESTART_DEBOUNCE_MS = 1_500;

const providerPresets: ProviderPreset[] = [
  {
    label: "Ollama",
    providerType: "ollama",
    providerName: "Ollama",
    baseUrl: "http://localhost:11434"
  },
  {
    label: "OpenAI-compatible custom API",
    providerType: "openai_compatible",
    providerName: "OpenAI-compatible custom API",
    baseUrl: "https://api.openai.com"
  },
  {
    label: "OpenRouter-compatible custom API",
    providerType: "openai_compatible",
    providerName: "OpenRouter",
    baseUrl: "https://openrouter.ai/api"
  },
  {
    label: "Local/private OpenAI-compatible server",
    providerType: "openai_compatible",
    providerName: "Private OpenAI-compatible server",
    baseUrl: "http://localhost:8000"
  }
];

const defaultProviderForm: ModelProviderConfigInput = {
  id: "default",
  providerType: "ollama",
  providerName: "Ollama",
  baseUrl: "http://localhost:11434",
  selectedModel: "",
  routerModel: "",
  verifierModel: "",
  embeddingModel: "",
  apiKey: ""
};

const starterPrompts = [
  "Explain this project to me",
  "Analyze the workspace and suggest the safest first change"
];

const accessOptions: AccessOption[] = [
  {
    value: "full_access",
    label: "Full Access",
    description: "Trusted local mode: write files, apply validated patches, and run requested setup/dev/test commands automatically."
  },
  {
    value: "default_permissions",
    label: "Default",
    description: "Keep the guarded default workflow with manual review for anything beyond the safest commands."
  },
  {
    value: "bounded_autonomy",
    label: "Bounded",
    description: "Auto-run safe project commands inside the workspace. Risky, background, admin, or outside-workspace commands still need approval or stop safely."
  }
];

function isPreSessionErrorMessage(msg: string): boolean {
  if (!msg) return false;
  const lower = msg.toLowerCase();
  if (
    lower.startsWith("select a workspace") ||
    lower.startsWith("workspace open:") ||
    lower === "workspace selection canceled." ||
    lower === "input size reset." ||
    lower.startsWith("input size ") ||
    lower.startsWith("plan mode enabled") ||
    lower.startsWith("model provider saved") ||
    lower.startsWith("model provider configuration cleared") ||
    lower.startsWith("restarting hivo") ||
    lower.startsWith("new chat ready") ||
    lower.startsWith("restored session:") ||
    lower.startsWith("archived chat:") ||
    lower.startsWith("inspecting files in")
  ) {
    return false;
  }
  return (
    msg.startsWith("Error:") ||
    lower.includes("error") ||
    lower.includes("failed") ||
    lower.includes("unavailable") ||
    lower.includes("valid model provider") ||
    lower.includes("open a workspace before starting") ||
    lower.includes("write a task in the input area first")
  );
}

function cleanPreSessionErrorMessage(msg: string): string {
  return msg.replace(/^(?:Error|RuntimeHttpError):\s*/i, "");
}

export function App() {
  const workspaceInputRef = useRef<HTMLInputElement | null>(null);
  const promptTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const queueIdRef = useRef(0);
  const runtimeEventUnsubscribeRef = useRef<(() => void) | null>(null);
  const autoRunningCommandIdsRef = useRef<Set<string>>(new Set());
  const autoApplyingPatchIdsRef = useRef<Set<string>>(new Set());
  const baselineContinuationTriggeredRef = useRef<Set<string>>(new Set());
  const lastCommandCountRef = useRef(0);
  const lastPreviewTargetRef = useRef("");
  const suppressPreviewOpenRef = useRef(false);
  const startupWorkspaceRestoreRef = useRef(false);
  const [workspacePath, setWorkspacePath] = useState("");
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [diffText, setDiffText] = useState("");
  const [terminalCommand, setTerminalCommand] = useState("git status");
  const [terminalResult, setTerminalResult] = useState<CommandResult | null>(null);
  const [prompt, setPrompt] = useState("");
  const [runtimeSession, setRuntimeSession] = useState<AgentRuntimeSession | null>(null);
  const [runtimeSessionToken, setRuntimeSessionToken] = useState("");
  const [restartingApp, setRestartingApp] = useState(false);
  const [codeFreshness, setCodeFreshness] = useState<CodeFreshnessStatus | null>(null);
  const [thinkFirst, setThinkFirst] = useState(false);
  const [accessProfile, setAccessProfile] = useState<AccessProfile>("full_access");
  const [accessMenuOpen, setAccessMenuOpen] = useState(false);
  const [safetySettings, setSafetySettings] = useState<SafetySettings>({
    ...defaultSafetySettings,
    ...accessProfileDefaults("full_access")
  });
  const [providerConfig, setProviderConfig] = useState<ModelProviderConfig | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [message, setMessage] = useState("Select a workspace and start from the composer.");
  const [agentBusy, setAgentBusy] = useState(false);
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedPrompt[]>([]);
  const [activityOpen, setActivityOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [bottomView, setBottomView] = useState<BottomView>("none");
  const [recentWorkspaces, setRecentWorkspaces] = useState<RecentWorkspaceEntry[]>([]);
  const [recentSessions, setRecentSessions] = useState<RecentSessionEntry[]>([]);
  const [promptHistory, setPromptHistory] = useState<string[]>([]);
  const [promptHistoryIndex, setPromptHistoryIndex] = useState<number | null>(null);
  const [promptDraftBeforeHistory, setPromptDraftBeforeHistory] = useState("");
  const [composerScale, setComposerScale] = useState(DEFAULT_COMPOSER_SCALE);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [sessionTokens, setSessionTokens] = useState<Record<string, StoredSessionToken>>({});
  const [collapsedProjectPaths, setCollapsedProjectPaths] = useState<string[]>([]);
  const [archivedSessionIds, setArchivedSessionIds] = useState<string[]>([]);
  const [pinnedSessionIds, setPinnedSessionIds] = useState<string[]>([]);
  const [expandedSessionProjectPaths, setExpandedSessionProjectPaths] = useState<string[]>([]);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [runtimeConnectionState, setRuntimeConnectionState] = useState<"connected" | "disconnected">("connected");
  const [sseConnectionState, setSseConnectionState] = useState<RuntimeEventSubscriptionState>(INITIAL_SSE_STATE);
  const [activeRuntimeCommand, setActiveRuntimeCommand] = useState<ActiveRuntimeCommand | null>(null);
  const [showFullAccessBanner, setShowFullAccessBanner] = useState(false);
  const [progressRailOpen, setProgressRailOpen] = useState(false);
  const [agentPanelOpen, setAgentPanelOpen] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [activeFileReference, setActiveFileReference] = useState<ActiveFileReference | null>(null);
  const [fileExplorerProject, setFileExplorerProject] = useState<FileExplorerProject | null>(null);
  const [fileExplorerFilter, setFileExplorerFilter] = useState("");
  const [expandedExplorerDirs, setExpandedExplorerDirs] = useState<string[]>([]);
  const [rtlTextMode, setRtlTextMode] = useState(false);
  const [hivoPetVisible, setHivoPetVisible] = useState(true);
  const [bootstrapped, setBootstrapped] = useState(false);
  const progressRailCloseTimerRef = useRef<number | null>(null);
  const autoRestartTimerRef = useRef<number | null>(null);
  const autoRestartAttemptRef = useRef("");
  const titleMigrationStartedRef = useRef(false);
  const accessMenuShellRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void (async () => {
      migrateLegacyStorageKeys();
      try {
        setProviderConfig(await getModelProviderConfig());
      } catch {
        setProviderConfig(null);
      }
      const storedWorkspaces = readStoredJson<RecentWorkspaceEntry[]>(RECENT_WORKSPACES_KEY, []);
      const storedSessions = readStoredJson<RecentSessionEntry[]>(RECENT_SESSIONS_KEY, []);
      const storedPromptHistory = readStoredJson<string[]>(PROMPT_HISTORY_KEY, []);
      const storedComposerScale = Number(localStorage.getItem(COMPOSER_SCALE_KEY));
      const storedSidebarWidth = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
      const storedSessionTokens = pruneExpiredSessionTokens(readStoredJson<Record<string, StoredSessionToken>>(SESSION_TOKENS_KEY, {}));
      const storedCollapsedProjects = readStoredJson<string[]>(COLLAPSED_PROJECTS_KEY, []);
      const storedArchivedSessions = readStoredJson<string[]>(ARCHIVED_SESSIONS_KEY, []);
      const storedPinnedSessions = readStoredJson<string[]>(PINNED_SESSIONS_KEY, []);
      const storedRtlTextMode = localStorage.getItem(RTL_TEXT_MODE_KEY) === "true";
      const storedPetVisible = localStorage.getItem(PET_VISIBLE_KEY);
      setRecentWorkspaces(storedWorkspaces.map((entry) => ({ ...entry, path: normalizeWorkspacePath(entry.path) })));
      setRecentSessions(storedSessions);
      setPromptHistory(storedPromptHistory);
      setSessionTokens(storedSessionTokens);
      setCollapsedProjectPaths(storedCollapsedProjects.map(normalizeWorkspacePath));
      setArchivedSessionIds([...new Set(storedArchivedSessions.filter(Boolean))]);
      setPinnedSessionIds([...new Set(storedPinnedSessions.filter(Boolean))]);
      setRtlTextMode(storedRtlTextMode);
      setHivoPetVisible(storedPetVisible !== "false");
      if (Number.isFinite(storedComposerScale)) {
        setComposerScale(clampComposerScale(storedComposerScale));
      }
      if (Number.isFinite(storedSidebarWidth)) {
        setSidebarWidth(clampSidebarWidth(storedSidebarWidth));
      }
      const lastWorkspacePath = localStorage.getItem(LAST_WORKSPACE_KEY);
      if (lastWorkspacePath) {
        setWorkspacePath(normalizeWorkspacePath(lastWorkspacePath));
      }
      setShowFullAccessBanner(localStorage.getItem(FULL_ACCESS_WARNING_KEY) !== "true");
      setBootstrapped(true);
    })();
    return () => runtimeEventUnsubscribeRef.current?.();
  }, []);

  useEffect(() => {
    return () => {
      if (progressRailCloseTimerRef.current !== null) {
        window.clearTimeout(progressRailCloseTimerRef.current);
      }
      if (autoRestartTimerRef.current !== null) {
        window.clearTimeout(autoRestartTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refreshCodeFreshness = async () => {
      try {
        const health = await checkRuntimeHealth();
        const freshness = await getCodeFreshnessStatus(health.startedAt);
        if (!cancelled) setCodeFreshness(freshness);
      } catch (error) {
        if (!cancelled) {
          const reason = String(error);
          const legacyRuntimeSurface = isTauriDesktopRuntime()
            && /valid start timestamp|get_code_freshness_status/i.test(reason);
          setCodeFreshness({
            status: legacyRuntimeSurface ? "stale" : "unknown",
            desktopStartedAt: "",
            latestSourceModifiedAt: legacyRuntimeSurface ? `legacy-contract:${reason}` : undefined,
            staleFiles: legacyRuntimeSurface ? ["running development services use the previous freshness contract"] : [],
            reason
          });
        }
      }
    };
    void refreshCodeFreshness();
    const interval = window.setInterval(() => void refreshCodeFreshness(), CODE_FRESHNESS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (codeFreshness?.status !== "stale" || restartingApp) {
      if (codeFreshness?.status === "fresh") {
        autoRestartAttemptRef.current = "";
        localStorage.removeItem(AUTO_RESTART_ATTEMPT_KEY);
      }
      if (autoRestartTimerRef.current !== null) {
        window.clearTimeout(autoRestartTimerRef.current);
        autoRestartTimerRef.current = null;
      }
      return;
    }
    const signature = codeFreshness.latestSourceModifiedAt ?? codeFreshness.staleFiles.join("|");
    const storedAttempt = localStorage.getItem(AUTO_RESTART_ATTEMPT_KEY) ?? "";
    if (!signature || autoRestartAttemptRef.current === signature || storedAttempt === signature) return;
    autoRestartTimerRef.current = window.setTimeout(() => {
      autoRestartTimerRef.current = null;
      autoRestartAttemptRef.current = signature;
      localStorage.setItem(AUTO_RESTART_ATTEMPT_KEY, signature);
      void handleRestartWithLatestCode();
    }, AUTO_RESTART_DEBOUNCE_MS);
    return () => {
      if (autoRestartTimerRef.current !== null) {
        window.clearTimeout(autoRestartTimerRef.current);
        autoRestartTimerRef.current = null;
      }
    };
  }, [codeFreshness, restartingApp]);

  useEffect(() => {
    const textarea = promptTextareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const minHeight = Math.round((prompt.trim() ? 46 : 40) * composerScale);
    const maxHeight = Math.round(190 * composerScale);
    const nextHeight = Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [prompt, composerScale]);

  useEffect(() => {
    if (!fileExplorerProject) return;
    setExpandedExplorerDirs((current) => (current.length ? current : defaultExpandedExplorerDirs(files)));
  }, [fileExplorerProject, files]);

  useEffect(() => {
    setSafetySettings((current) => ({
      ...accessProfileDefaults(accessProfile),
      maxParallelAgents: current.maxParallelAgents
    }));
  }, [accessProfile]);

  useEffect(() => {
    localStorage.setItem(RTL_TEXT_MODE_KEY, rtlTextMode ? "true" : "false");
  }, [rtlTextMode]);

  useEffect(() => {
    localStorage.setItem(PET_VISIBLE_KEY, hivoPetVisible ? "true" : "false");
  }, [hivoPetVisible]);

  useEffect(() => {
    if (!accessMenuOpen) return;

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && accessMenuShellRef.current?.contains(target)) return;
      setAccessMenuOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setAccessMenuOpen(false);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [accessMenuOpen]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clampSidebarWidth(sidebarWidth)));
  }, [sidebarWidth]);

  useEffect(() => {
    if (!bootstrapped) return;
    localStorage.setItem(SESSION_TOKENS_KEY, JSON.stringify(pruneExpiredSessionTokens(sessionTokens)));
  }, [bootstrapped, sessionTokens]);

  useEffect(() => {
    localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify(collapsedProjectPaths));
  }, [collapsedProjectPaths]);

  useEffect(() => {
    localStorage.setItem(ARCHIVED_SESSIONS_KEY, JSON.stringify(archivedSessionIds));
  }, [archivedSessionIds]);

  useEffect(() => {
    localStorage.setItem(PINNED_SESSIONS_KEY, JSON.stringify(pinnedSessionIds));
  }, [pinnedSessionIds]);

  useEffect(() => {
    if (!recentSessions.length) return;
    if (titleMigrationStartedRef.current) return;
    if (localStorage.getItem(SESSION_TITLE_MIGRATION_KEY) === "true") return;
    titleMigrationStartedRef.current = true;
    let cancelled = false;
    void (async () => {
      const migratedEntries = await Promise.all(
        recentSessions.map(async (entry) => {
          if (!shouldBackfillSessionTitle(entry.title)) return entry;
          try {
            const savedSession = await getSavedRuntimeSession(entry.id);
            const nextTitle = deriveDisplaySessionTitle(savedSession, entry.title);
            return nextTitle ? { ...entry, title: nextTitle } : entry;
          } catch {
            return entry;
          }
        })
      );
      if (cancelled) return;
      setRecentSessions(migratedEntries);
      persistRecentSessions(migratedEntries);
      localStorage.setItem(SESSION_TITLE_MIGRATION_KEY, "true");
    })();
    return () => {
      cancelled = true;
    };
  }, [recentSessions]);

  function rememberPersistedSessionToken(sessionId: string, token: string, expiresAt: string) {
    setSessionTokens((current) => ({
      ...pruneExpiredSessionTokens(current),
      [sessionId]: { token, expiresAt }
    }));
  }

  function forgetPersistedSessionToken(sessionId: string) {
    setSessionTokens((current) => {
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
  }

  function expandProjectPath(projectPath: string) {
    const normalizedPath = normalizeWorkspacePath(projectPath);
    setCollapsedProjectPaths((current) => current.filter((entry) => entry !== normalizedPath));
  }

  useEffect(() => {
    if (agentBusy || queuedPrompts.length === 0) return;
    const [next, ...rest] = queuedPrompts;
    if (!next) return;
    setQueuedPrompts(rest);
    void submitPrompt(next.text, next.mode);
  }, [agentBusy, queuedPrompts]);

  useEffect(() => {
    if (!runtimeSession) {
      lastCommandCountRef.current = 0;
      return;
    }
    const count = runtimeSession.commandExecutions.length;
    if (count > lastCommandCountRef.current) {
      const latestExecution = runtimeSession.commandExecutions.at(-1);
      if (latestExecution) {
        setTerminalCommand(latestExecution.command);
        setTerminalResult({
          command: latestExecution.command,
          cwd: latestExecution.cwd,
          risk: latestExecution.risk,
          status: latestExecution.status,
          exitCode: latestExecution.exitCode,
          stdout: latestExecution.stdout,
          stderr: latestExecution.stderr,
          message: latestExecution.message,
          diagnosis: latestExecution.diagnosis
        });
      }
      setBottomView("terminal");
    }
    lastCommandCountRef.current = count;
  }, [runtimeSession]);

  useEffect(() => {
    if (!runtimeSession?.nextAction || runtimeSession.nextAction.kind !== "preview_ready") return;
    const target = `${runtimeSession.id}:${runtimeSession.nextAction.preview.type}:${runtimeSession.nextAction.preview.target}`;
    if (lastPreviewTargetRef.current === target) return;
    if (suppressPreviewOpenRef.current) {
      lastPreviewTargetRef.current = target;
      suppressPreviewOpenRef.current = false;
      return;
    }
    lastPreviewTargetRef.current = target;
    void handleOpenPreview(runtimeSession.nextAction.preview);
  }, [runtimeSession]);

  useEffect(() => {
    if (!runtimeSession) return;
    const runnable = runtimeSession.commandRequests.filter((request) =>
      canAutoRunRuntimeCommand(runtimeSession, request, safetySettings)
      && !autoRunningCommandIdsRef.current.has(request.id)
    );
    if (!runnable.length) return;

    let cancelled = false;
    void (async () => {
      for (const request of runnable) {
        if (cancelled) return;
        autoRunningCommandIdsRef.current.add(request.id);
        try {
          setTerminalCommand(request.command);
          const result = await runCommandRequest(runtimeSession, request, true);
          if (cancelled) return;
          setTerminalResult(result);
          setMessage(result.diagnosis?.summary ?? result.message ?? `Policy-classified auto-run completed: ${request.command}`);
          await refreshWorkspaceState();
        } catch (error) {
          if (!cancelled) {
            setMessage(String(error));
          }
        } finally {
          autoRunningCommandIdsRef.current.delete(request.id);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [runtimeSession, safetySettings]);

  useEffect(() => {
    if (!runtimeSession || !safetySettings.autoApplyValidatedPatches) return;
    const candidate = runtimeSession.patchProposals.find((patch) =>
      (patch.status === "proposed" || patch.status === "approved")
      && !autoApplyingPatchIdsRef.current.has(patch.id)
    );
    if (!candidate) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        autoApplyingPatchIdsRef.current.add(candidate.id);
        try {
          setMessage(`Full Access applying ${candidate.title}...`);
          if (candidate.status === "proposed") {
            const approval = await approveRuntimePatch(runtimeSession.id, candidate.id, runtimeSessionToken || undefined);
            await persistPatchApprovalForRust(runtimeSession.id, approval.proposal);
          } else {
            await persistPatchApprovalForRust(runtimeSession.id, candidate);
          }
          await reportRuntimePatchApplyResult(
            runtimeSession.id,
            candidate.id,
            { status: "apply_started", message: "Rust patch apply requested." },
            runtimeSessionToken || undefined
          );
          const applied = await applyRuntimePatchWithRetry(runtimeSession.id, candidate.id);
          if (cancelled) return;
          const updated = await reportRuntimePatchApplyResult(
            runtimeSession.id,
            candidate.id,
            {
              status: "applied",
              message: applied.message,
              reconciliationSnapshot:
                applied.beforeSnapshot || applied.afterSnapshot
                  ? {
                    before: applied.beforeSnapshot,
                    after: applied.afterSnapshot
                  }
                  : undefined
            },
            runtimeSessionToken || undefined
          );
          if (cancelled) return;
          applyCanonicalRuntimeSession(updated);
          setMessage(applied.message);
          await reconcileRuntimeSession(runtimeSession.id, runtimeSessionToken || undefined, "patch_apply_result");
          await refreshWorkspaceState();
        } catch (error) {
          if (!cancelled) {
            try {
              const updated = await reportRuntimePatchApplyResult(
                runtimeSession.id,
                candidate.id,
                { status: "failed", message: String(error) },
                runtimeSessionToken || undefined
              );
              applyCanonicalRuntimeSession(updated);
              await reconcileRuntimeSession(runtimeSession.id, runtimeSessionToken || undefined, "patch_apply_failed_result");
            } catch {
              // Keep the original apply error visible.
            }
            setMessage(String(error));
          }
        } finally {
          autoApplyingPatchIdsRef.current.delete(candidate.id);
        }
      })();
    }, 150);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [runtimeSession, runtimeSessionToken, safetySettings.autoApplyValidatedPatches]);

  useEffect(() => {
    if (!workspace) return;
    const matchingSessionId =
      runtimeSession && normalizeWorkspacePath(runtimeSession.workspacePath) === normalizeWorkspacePath(workspace.path)
        ? runtimeSession.id
        : undefined;
    setRecentWorkspaces((current) => {
      const next = upsertRecentWorkspace(current, workspace, matchingSessionId);
      persistRecentWorkspaces(next);
      return next;
    });
    localStorage.setItem(LAST_WORKSPACE_KEY, workspace.path);
  }, [workspace, runtimeSession?.id, runtimeSession?.workspacePath]);

  useEffect(() => {
    if (!runtimeSession || !workspace) return;
    if (normalizeWorkspacePath(runtimeSession.workspacePath) !== normalizeWorkspacePath(workspace.path)) return;
    setRecentSessions((current) => {
      const next = upsertRecentSession(current, runtimeSession, workspace);
      persistRecentSessions(next);
      return next;
    });
    setRecentWorkspaces((current) => {
      const next = current.map((entry) =>
        entry.path === workspace.path ? { ...entry, lastSessionId: runtimeSession.id, lastOpenedAt: new Date().toISOString() } : entry
      );
      persistRecentWorkspaces(next);
      return next;
    });
  }, [runtimeSession, workspace]);

  const sessionTitle = runtimeSession ? deriveSessionTitle(runtimeSession) : "Hivo";
  const hasSessionView = Boolean(runtimeSession);
  const agentPanel = runtimeSession ? buildAgentSidePanel(runtimeSession) : { agents: [], backgroundJobs: [] };
  const hasAgentSidePanel = agentPanel.agents.length > 0;
  const showRightPanel = activityOpen;
  const effectiveSidebarWidth = sidebarCollapsed ? COLLAPSED_SIDEBAR_WIDTH : clampSidebarWidth(sidebarWidth);
  const shellLayoutStyle: CSSProperties = {
    gridTemplateColumns: `${effectiveSidebarWidth}px ${sidebarCollapsed ? "0px" : "10px"} minmax(0, 1fr) ${showRightPanel ? "minmax(0, 390px)" : "0px"}`
  };
  const archivedSessionIdSet = new Set(archivedSessionIds);
  const pinnedSessionIdSet = new Set(pinnedSessionIds);
  const visibleRecentSessions = recentSessions.filter((entry) => !archivedSessionIdSet.has(entry.id));
  const archivedSessions = recentSessions
    .filter((entry) => archivedSessionIdSet.has(entry.id))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const visibleRuntimeSession =
    runtimeSession && !archivedSessionIdSet.has(runtimeSession.id)
      ? runtimeSession
      : null;
  const liveConnectionState: "connected" | "disconnected" = sseConnectionState.connected ? "connected" : "disconnected";
  const sidebarProjects = buildSidebarProjects({
    workspace,
    runtimeSession: visibleRuntimeSession,
    recentWorkspaces,
    recentSessions: visibleRecentSessions,
    pinnedSessionIds,
    agentBusy,
    runtimeConnectionState: liveConnectionState
  });
  const allProjectsCollapsed =
    sidebarProjects.length > 0 &&
    sidebarProjects.every((project) => collapsedProjectPaths.includes(normalizeWorkspacePath(project.path)));

  const sessionSummary = runtimeSession
    ? humanSessionStatus(runtimeSession, agentBusy, liveConnectionState)
    : workspace
      ? `Connected to ${workspace.name}`
      : "Open a workspace to begin";
  const railActivityItems = runtimeSession ? buildPrimaryActivityItems(runtimeSession, activeRuntimeCommand) : [];
  const railCurrentStep = runtimeSession ? describeCurrentStep(runtimeSession, liveConnectionState, activeRuntimeCommand) : null;
  const showProgressRail = Boolean(runtimeSession && (railCurrentStep || railActivityItems.length));
  const hasPromptDraft = prompt.trim().length > 0;
  const sendButtonDisabled = !workspace || !hasPromptDraft;
  const preSessionErrorMessage =
    !runtimeSession && isPreSessionErrorMessage(message) ? cleanPreSessionErrorMessage(message) : null;
  const fileExplorerTree = buildFileExplorerTree(files, fileExplorerFilter);
  const planModeSuggestionVisible = shouldSuggestPlanMode(prompt, thinkFirst);

  useEffect(() => {
    if (!agentPanel.agents.length) {
      setSelectedAgentId("");
      setAgentPanelOpen(false);
      return;
    }
    if (!selectedAgentId || !agentPanel.agents.some((agent) => agent.id === selectedAgentId)) {
      setSelectedAgentId(agentPanel.agents[0]!.id);
    }
  }, [agentPanel.agents, selectedAgentId]);

  async function refreshWorkspaceState(nextWorkspace?: WorkspaceInfo) {
    const activeWorkspace = nextWorkspace ?? workspace;
    if (!activeWorkspace) return;
    const [nextFiles, nextStatus, nextDiff] = await Promise.all([
      listWorkspaceFiles(),
      getGitStatus(),
      getGitDiff()
    ]);
    setFiles(nextFiles);
    setGitStatus(nextStatus);
    setDiffText(nextDiff.trim() ? nextDiff : "No git diff available.");
  }

  async function activateWorkspace(
    nextPath: string,
    options?: { restoreSession?: boolean; silent?: boolean; recentWorkspaceEntries?: RecentWorkspaceEntry[] }
  ) {
    const trimmed = nextPath.trim();
    if (!trimmed) return;
    const normalizedPath = normalizeWorkspacePath(trimmed);
    runtimeEventUnsubscribeRef.current?.();
    runtimeEventUnsubscribeRef.current = null;
    setRuntimeSession(null);
    setRuntimeSessionToken("");
    setRuntimeConnectionState("connected");
    setSseConnectionState(INITIAL_SSE_STATE);
    setThinkFirst(false);
    const nextWorkspace = await openWorkspace(normalizedPath);
    setWorkspacePath(normalizedPath);
    setWorkspace(nextWorkspace);
    if (!options?.silent) {
      setMessage(`Workspace open: ${nextWorkspace.name}`);
    }
    await refreshWorkspaceState(nextWorkspace);

    if (!options?.restoreSession) return;
    const workspaceEntry = (options?.recentWorkspaceEntries ?? recentWorkspaces).find((entry) => normalizeWorkspacePath(entry.path) === normalizedPath);
    const recentSessionId = workspaceEntry?.lastSessionId;
    if (!recentSessionId) return;
    try {
      await restoreRecentSessionById(recentSessionId, nextWorkspace.path);
    } catch {
      setRecentSessions((current) => {
        const next = current.filter((entry) => entry.id !== recentSessionId);
        persistRecentSessions(next);
        return next;
      });
    }
  }

  useEffect(() => {
    if (!bootstrapped || workspace || !workspacePath || startupWorkspaceRestoreRef.current) return;
    startupWorkspaceRestoreRef.current = true;
    void activateWorkspace(workspacePath, {
      restoreSession: false,
      silent: true
    }).catch(() => {
      startupWorkspaceRestoreRef.current = false;
    });
  }, [bootstrapped, workspace, workspacePath]);

  async function handleOpenWorkspace() {
    try {
      await activateWorkspace(workspacePath, { restoreSession: false });
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function handlePickWorkspace() {
    try {
      const selected = await pickWorkspaceDirectory();
      if (!selected) {
        setMessage("Workspace selection canceled.");
        return;
      }
      await activateWorkspace(selected, { restoreSession: false });
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function handleRestartWithLatestCode() {
    if (restartingApp) return;
    setRestartingApp(true);
    setMessage("Restarting Hivo with the latest local code...");
    try {
      await restartWithLatestCode();
    } catch (error) {
      setRestartingApp(false);
      setMessage(String(error));
    }
  }

  const latestCodeButtonState = restartingApp
    ? {
      label: "Updating...",
      className: "updating",
      title: "Restarting the desktop, runtime, and dev server with the latest local code."
    }
    : codeFreshness?.status === "stale"
      ? {
        label: "Update Required",
        className: "stale",
        title: codeFreshness.staleFiles.length
          ? `Restart required for: ${codeFreshness.staleFiles.join(", ")}`
          : "Local runtime code changed after this app started."
      }
      : !codeFreshness || codeFreshness.status === "unknown"
        ? {
          label: "Latest Unknown",
          className: "unknown",
          title: codeFreshness?.reason ?? "Could not prove that every running component uses the latest code."
        }
        : {
          label: "Restart Latest",
          className: "fresh",
          title: "All running components use the latest detected local code. Click to force a fresh restart."
        };

  async function handleRunCommand() {
    try {
      const result = await runWorkspaceCommand(terminalCommand, commandSafetySettings(safetySettings));
      setTerminalResult(result);
      setMessage(result.diagnosis?.summary ?? result.message ?? `Command ${result.status}.`);
      if (terminalCommand.trim().startsWith("git ")) {
        await refreshWorkspaceState();
      }
    } catch (error) {
      setMessage(String(error));
    }
  }

  function subscribeToRuntimeSession(sessionId: string, sessionToken?: string) {
    runtimeEventUnsubscribeRef.current?.();
    setRuntimeConnectionState("connected");
    setSseConnectionState({ ...INITIAL_SSE_STATE, status: "connecting", disconnected: false });
    runtimeEventUnsubscribeRef.current = subscribeRuntimeEvents(sessionId, sessionToken, {
      onSession: (session) => {
        setRuntimeConnectionState("connected");
        applyCanonicalRuntimeSession(session);
      },
      onEvent: (event: AppEvent) => {
        setRuntimeConnectionState("connected");
        void appendSessionEvent("sessionId" in event ? event.sessionId : sessionId, event.type, event as unknown as Record<string, unknown>);
        if (event.type === "runtime.progress.updated") {
          setMessage(event.progress.summary);
        }
        if (event.type === "runtime.run.completed") {
          setMessage(event.summary.nextAction ?? event.summary.summary);
        }
      },
      onStateChange: (state) => {
        setSseConnectionState(state);
        if (state.connected) {
          setRuntimeConnectionState("connected");
        }
        if (state.tokenExpired || state.unauthorized) {
          forgetPersistedSessionToken(sessionId);
          setRuntimeSessionToken("");
        }
      },
      onReconnect: () => {
        void reconcileRuntimeSession(sessionId, sessionToken, "sse_reconnect");
      },
      onError: (state) => {
        if (state.tokenExpired) {
          setMessage("Session token expired. Live updates stopped; open a new chat or restore with a fresh token.");
          void reconcileRuntimeSession(sessionId, sessionToken, "token_expired");
          return;
        }
        if (state.unauthorized) {
          setMessage("Session event stream is unauthorized. Live updates stopped for this chat.");
          void reconcileRuntimeSession(sessionId, sessionToken, "unauthorized");
          return;
        }
        setMessage(state.reconnecting ? "Live updates reconnecting; canonical session will be refreshed when the stream returns." : "Live updates disconnected. Session state may be stale until the next refresh.");
      }
    });
  }

  function applyCanonicalRuntimeSession(session: AgentRuntimeSession) {
    const merged = mergeRuntimeSessionState(runtimeSession, session);
    setRuntimeSession((current) => mergeRuntimeSessionState(current, session));
    mirrorRuntimeSession(merged);
    if (typeof session.thinkFirst === "boolean") {
      setThinkFirst(session.thinkFirst);
    }
    if (isTerminalOrOperatorHeldSession(merged)) {
      setAgentBusy(false);
    }
    return merged;
  }

  async function reconcileRuntimeSession(sessionId: string, sessionToken: string | undefined, reason: string) {
    try {
      const canonical = await getRuntimeSession(sessionId, sessionToken);
      applyCanonicalRuntimeSession(canonical);
      setRuntimeConnectionState("connected");
      return canonical;
    } catch (error) {
      if (error instanceof RuntimeHttpError && error.status === 401) {
        const tokenExpired = error.code === "token_expired";
        setSseConnectionState((current) => ({
          ...current,
          status: tokenExpired ? "token_expired" : "unauthorized",
          connected: false,
          disconnected: true,
          reconnecting: false,
          unauthorized: !tokenExpired,
          tokenExpired,
          lastError: error.message
        }));
        forgetPersistedSessionToken(sessionId);
        setRuntimeSessionToken("");
        setMessage(tokenExpired ? "Session token expired. Start a new chat to continue." : "Session token is unauthorized. Start a new chat to continue.");
        return null;
      }
      if (error instanceof RuntimeUnavailableError) {
        setRuntimeConnectionState("disconnected");
        setMessage(error.message);
        return null;
      }
      setMessage(`Session reconciliation failed after ${reason}: ${String(error)}`);
      return null;
    }
  }

  async function mirrorRuntimeSession(session: AgentRuntimeSession) {
    try {
      await upsertOrchestrationRun(session);
      for (const run of session.orchestration?.agentRuns ?? []) {
        await upsertAgentRun(session.id, {
          agentId: run.id,
          roleTitle: run.roleTitle ?? run.role ?? run.agentName,
          lifecycleStage: run.lifecycleStage ?? session.lifecycleStage,
          artifactJson: run.artifactJson,
          status: run.status
        });
      }
    } catch {
      // Runtime remains live even if local mirroring has a transient SQLite failure.
    }
  }

  async function handleSelectRecentWorkspace(entry: RecentWorkspaceEntry) {
    try {
      await activateWorkspace(entry.path, { restoreSession: false });
      expandProjectPath(entry.path);
      setSidebarCollapsed(false);
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function handleRestoreRecentSession(entry: RecentSessionEntry) {
    try {
      await restoreRecentSessionById(entry.id, entry.workspacePath);
      expandProjectPath(entry.workspacePath);
      setSidebarCollapsed(false);
      setMessage(`Restored session: ${entry.title}`);
    } catch (error) {
      setMessage(String(error));
    }
  }

  function handleArchiveSession(entry: RecentSessionEntry) {
    setArchivedSessionIds((current) => current.includes(entry.id) ? current : [entry.id, ...current]);
    if (runtimeSession?.id === entry.id) {
      runtimeEventUnsubscribeRef.current?.();
      runtimeEventUnsubscribeRef.current = null;
      setRuntimeSession(null);
      setRuntimeSessionToken("");
      setRuntimeConnectionState("connected");
      setThinkFirst(false);
    }
    setActivityOpen(false);
    setMessage(`Archived chat: ${entry.title}`);
  }

  function handleTogglePinnedSession(entry: RecentSessionEntry) {
    setPinnedSessionIds((current) =>
      current.includes(entry.id)
        ? current.filter((id) => id !== entry.id)
        : [entry.id, ...current]
    );
  }

  function handleToggleProjectSessionsExpanded(projectPath: string) {
    const normalizedPath = normalizeWorkspacePath(projectPath);
    setExpandedSessionProjectPaths((current) =>
      current.includes(normalizedPath)
        ? current.filter((entry) => entry !== normalizedPath)
        : [...current, normalizedPath]
    );
  }

  async function handleRestoreArchivedSession(entry: RecentSessionEntry) {
    setArchivedSessionIds((current) => current.filter((id) => id !== entry.id));
    setArchiveOpen(false);
    await handleRestoreRecentSession(entry);
  }

  async function restoreRecentSessionById(sessionId: string, workspacePathForSession: string) {
    await activateWorkspace(workspacePathForSession, { restoreSession: false, silent: true });
    suppressPreviewOpenRef.current = true;
    const persistedToken = getPersistedSessionToken(sessionTokens, sessionId);
    if (persistedToken) {
      try {
        subscribeToRuntimeSession(sessionId, persistedToken.token);
        const restoredSession = await getRuntimeSession(sessionId, persistedToken.token);
        setRuntimeSessionToken(persistedToken.token);
        applyCanonicalRuntimeSession(restoredSession);
        setRuntimeConnectionState("connected");
        return restoredSession;
      } catch {
        forgetPersistedSessionToken(sessionId);
      }
    }
    const savedSession = await getSavedRuntimeSession(sessionId);
    setRuntimeSessionToken("");
    setRuntimeConnectionState("disconnected");
    applyCanonicalRuntimeSession(savedSession);
    return savedSession;
  }

  async function submitPrompt(nextPrompt?: string, queuedMode?: QueuedPrompt["mode"]) {
    const input = nextPrompt ?? prompt;
    if (!workspace) {
      setMessage("Open a workspace before starting an agent session.");
      return;
    }
    if (!input.trim()) {
      setMessage("Write a task in the input area first.");
      return;
    }

    const normalizedInput = input.trim();
    if (containsArabic(normalizedInput)) {
      setRtlTextMode(true);
    }
    if (normalizedInput !== "resume_baseline_planning") {
      setPromptHistory((current) => {
        const next = [normalizedInput, ...current.filter((entry) => entry !== normalizedInput)].slice(0, MAX_PROMPT_HISTORY);
        localStorage.setItem(PROMPT_HISTORY_KEY, JSON.stringify(next));
        return next;
      });
    }
    setPromptHistoryIndex(null);
    setPromptDraftBeforeHistory("");

    setAgentBusy(true);
    setActivityOpen(false);
    setBottomView("none");
    let activeSessionIdForReconcile: string | undefined;
    let activeSessionTokenForReconcile: string | undefined;
    try {
      const canReuseSession =
        runtimeSession &&
        workspace &&
        normalizeWorkspacePath(runtimeSession.workspacePath) === normalizeWorkspacePath(workspace.path) &&
        Boolean(runtimeSessionToken || getPersistedSessionToken(sessionTokens, runtimeSession.id)?.token);
      let sessionToken = runtimeSession
        ? runtimeSessionToken || getPersistedSessionToken(sessionTokens, runtimeSession.id)?.token
        : undefined;
      let sessionTokenExpiresAt: string | undefined;
      const sessionId = canReuseSession
        ? runtimeSession.id
        : await (async () => {
          await assertRuntimeAvailable();
          setRuntimeConnectionState("connected");
          const trustProfile = accessProfile === "auto_review" || accessProfile === "bounded_autonomy" || accessProfile === "full_access" ? "trusted_internal" : "strict_gated";
          const rustRun = await createRuntimeRun(input, trustProfile);
          sessionToken = rustRun.sessionToken;
          sessionTokenExpiresAt = rustRun.sessionTokenExpiresAt;
          setRuntimeSessionToken(rustRun.sessionToken);
          const sanitizedProvider =
            providerConfig
              ? {
                providerType: providerConfig.providerType,
                providerName: providerConfig.providerName,
                baseUrl: providerConfig.baseUrl,
                selectedModel: providerConfig.selectedModel,
                routerModel: providerConfig.routerModel,
                verifierModel: providerConfig.verifierModel,
                embeddingModel: providerConfig.embeddingModel,
                isValid: providerConfig.isValid,
                apiKeyConfigured: providerConfig.apiKeyConfigured
              }
              : undefined;
          if (!sanitizedProvider?.isValid) {
            throw new Error("Configure a valid model provider before starting a coding run.");
          }
          return (
            await createRuntimeSession({
              workspacePath: workspace.path,
              trustProfile,
              providerConfig: sanitizedProvider,
              activeProviderSource: "desktop_saved_provider",
              sessionToken: rustRun.sessionToken,
              sessionTokenExpiresAt: rustRun.sessionTokenExpiresAt,
              executionMode: "auto_mode",
              accessProfile,
              thinkFirst,
              safetySettings,
              userPrompt: input
            })
          ).sessionId;
        })();
      activeSessionIdForReconcile = sessionId;
      activeSessionTokenForReconcile = sessionToken;
      if (sessionToken && sessionTokenExpiresAt) {
        rememberPersistedSessionToken(sessionId, sessionToken, sessionTokenExpiresAt);
      }
      subscribeToRuntimeSession(sessionId, sessionToken);
      await reconcileRuntimeSession(sessionId, sessionToken, "session_created");
      setPrompt("");
      await runRuntimeTurn(sessionId, input, sessionToken, { thinkFirst });
      const nextSession = await reconcileRuntimeSession(sessionId, sessionToken, "turn_completed");
      if (nextSession && typeof nextSession.thinkFirst === "boolean") {
        setThinkFirst(nextSession.thinkFirst);
      }
      await refreshWorkspaceState();
      setMessage(
        queuedMode === "steer"
          ? "Steer request completed."
          : nextSession?.nextAction?.message ??
          (nextSession?.status === "needs_approval" ? "Session is waiting for operator review." : "Session updated.")
      );
    } catch (error) {
      if (error instanceof RuntimeUnavailableError) {
        setRuntimeConnectionState("disconnected");
        setMessage(error.message);
      } else {
        const sessionIdForError = activeSessionIdForReconcile ?? runtimeSession?.id;
        if (sessionIdForError) {
          void reconcileRuntimeSession(sessionIdForError, activeSessionTokenForReconcile, "runtime_session_error");
        }
        setMessage(String(error));
      }
    } finally {
      setAgentBusy(false);
    }
  }

  async function handleRunAgent() {
    if (agentBusy) {
      enqueuePrompt("queued");
      return;
    }
    await submitPrompt();
  }

  async function refreshRuntimeSession() {
    if (!runtimeSession) return;
    try {
      const activeToken = runtimeSessionToken || getPersistedSessionToken(sessionTokens, runtimeSession.id)?.token;
      if (!activeToken) {
        applyCanonicalRuntimeSession(await getSavedRuntimeSession(runtimeSession.id));
        setRuntimeConnectionState("disconnected");
        return;
      }
      await reconcileRuntimeSession(runtimeSession.id, activeToken, "manual_refresh");
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function handleApprovePatch(patchId: string) {
    if (!runtimeSession) return;
    let rustApplyResult: Awaited<ReturnType<typeof applyRuntimePatch>> | undefined;
    try {
      const result = await approveRuntimePatch(runtimeSession.id, patchId, runtimeSessionToken || undefined);
      await persistPatchApprovalForRust(runtimeSession.id, result.proposal);
      const applying = await reportRuntimePatchApplyResult(
        runtimeSession.id,
        patchId,
        { status: "apply_started", message: "Rust patch apply requested." },
        runtimeSessionToken || undefined
      );
      applyCanonicalRuntimeSession(applying);
      const applied = await applyRuntimePatchWithRetry(runtimeSession.id, patchId);
      rustApplyResult = applied;
      const updated = await reportRuntimePatchApplyResult(
        runtimeSession.id,
        patchId,
        {
          status: "applied",
          message: applied.message,
          reconciliationSnapshot:
            applied.beforeSnapshot || applied.afterSnapshot
              ? {
                before: applied.beforeSnapshot,
                after: applied.afterSnapshot
              }
              : undefined
        },
        runtimeSessionToken || undefined
      );
      applyCanonicalRuntimeSession(updated);
      setMessage(applied.message);
      await reconcileRuntimeSession(runtimeSession.id, runtimeSessionToken || undefined, "patch_apply_result");
      await refreshWorkspaceState();
    } catch (error) {
      if (rustApplyResult?.status === "applied") {
        await refreshRuntimeSession();
        setMessage(`Rust applied the patch, but a later UI refresh/reporting step failed: ${String(error)}`);
        return;
      }
      try {
        const updated = await reportRuntimePatchApplyResult(
          runtimeSession.id,
          patchId,
          { status: "failed", message: String(error) },
          runtimeSessionToken || undefined
        );
        applyCanonicalRuntimeSession(updated);
        await reconcileRuntimeSession(runtimeSession.id, runtimeSessionToken || undefined, "patch_apply_failed_result");
      } catch {
        // Keep the original approval/apply error visible.
      }
      setMessage(String(error));
    }
  }

  async function handleFactoryDecision(
    target: "product_spec" | "technical_plan",
    decision: "approved" | "rejected" | "changes_requested"
  ) {
    if (!runtimeSession) return;
    const feedback = decision === "approved"
      ? undefined
      : window.prompt(decision === "changes_requested" ? "Describe the requested changes." : "Why are you rejecting this artifact?")?.trim();
    if (decision !== "approved" && !feedback) return;
    try {
      const activeToken = runtimeSessionToken || getPersistedSessionToken(sessionTokens, runtimeSession.id)?.token;
      const updated = target === "product_spec"
        ? await decideRuntimeProductSpec(runtimeSession.id, { decision, feedback }, activeToken)
        : await decideRuntimeTechnicalPlan(runtimeSession.id, { decision, feedback }, activeToken);
      applyCanonicalRuntimeSession(updated);
      setMessage(updated.nextAction?.message ?? "Recursive Factory planning approval updated.");
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function handleStartRecursiveBranchExecution() {
    if (!runtimeSession) return;
    try {
      const activeToken = runtimeSessionToken || getPersistedSessionToken(sessionTokens, runtimeSession.id)?.token;
      const updated = await startRuntimeRecursiveBranchExecution(runtimeSession.id, { approved: true }, activeToken);
      applyCanonicalRuntimeSession(updated);
      setMessage(updated.nextAction?.message ?? "Recursive branch execution started with patch proposal authority only.");
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function handleApplyPatch(patchId: string) {
    if (!runtimeSession) return;
    let rustApplyResult: Awaited<ReturnType<typeof applyRuntimePatch>> | undefined;
    try {
      const proposal = runtimeSession.patchProposals.find((candidate) => candidate.id === patchId);
      if (!proposal || proposal.status !== "approved") {
        throw new Error("Patch apply requires an approved proposal.");
      }
      await persistPatchApprovalForRust(runtimeSession.id, proposal);
      const applying = await reportRuntimePatchApplyResult(
        runtimeSession.id,
        patchId,
        { status: "apply_started", message: "Rust patch apply requested." },
        runtimeSessionToken || undefined
      );
      applyCanonicalRuntimeSession(applying);
      const applied = await applyRuntimePatchWithRetry(runtimeSession.id, patchId);
      rustApplyResult = applied;
      const updated = await reportRuntimePatchApplyResult(
        runtimeSession.id,
        patchId,
        {
          status: "applied",
          message: applied.message,
          reconciliationSnapshot:
            applied.beforeSnapshot || applied.afterSnapshot
              ? {
                before: applied.beforeSnapshot,
                after: applied.afterSnapshot
              }
              : undefined
        },
        runtimeSessionToken || undefined
      );
      applyCanonicalRuntimeSession(updated);
      setMessage(applied.message);
      await reconcileRuntimeSession(runtimeSession.id, runtimeSessionToken || undefined, "patch_apply_result");
      await refreshWorkspaceState();
    } catch (error) {
      if (rustApplyResult?.status === "applied") {
        await refreshRuntimeSession();
        setMessage(`Rust applied the patch, but a later UI refresh/reporting step failed: ${String(error)}`);
        return;
      }
      try {
        const updated = await reportRuntimePatchApplyResult(
          runtimeSession.id,
          patchId,
          { status: "failed", message: String(error) },
          runtimeSessionToken || undefined
        );
        applyCanonicalRuntimeSession(updated);
        await reconcileRuntimeSession(runtimeSession.id, runtimeSessionToken || undefined, "patch_apply_failed_result");
      } catch {
        // Keep the original apply error visible even if runtime reporting also fails.
      }
      await refreshRuntimeSession();
      setMessage(String(error));
    }
  }

  async function handleRejectPatch(patchId: string) {
    if (!runtimeSession) return;
    try {
      const rustResult = await rejectRuntimePatchViaRust(runtimeSession.id, patchId);
      const result = await rejectRuntimePatch(runtimeSession.id, patchId, runtimeSessionToken || undefined);
      setMessage(result.message || rustResult.message);
      await refreshRuntimeSession();
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function runCommandRequest(session: AgentRuntimeSession, request: CommandRequest, autoRun = false) {
    try {
      setActiveRuntimeCommand({
        sessionId: session.id,
        requestId: request.id,
        command: request.command,
        cwd: request.cwd,
        autoRun
      });
      const execution = await executeRuntimeCommandRequest({
        session,
        request,
        autoRun,
        safetySettings: commandSafetySettings(safetySettings),
        sessionToken: runtimeSessionToken || undefined
      });
      applyCanonicalRuntimeSession(execution.updatedSession);
      const canonical = await reconcileRuntimeSession(session.id, runtimeSessionToken || undefined, "command_result");
      if (
        canonical &&
        canonical.nextAction?.kind === "await_baseline_command" &&
        canonical.nextAction.commandRequestId === request.id &&
        !baselineContinuationTriggeredRef.current.has(request.id)
      ) {
        const result = execution.result;
        const hasValidEvidence =
          result.status !== "blocked" &&
          typeof result.exitCode === "number" &&
          ((result.stdout?.length ?? 0) > 0 || (result.stderr?.length ?? 0) > 0) &&
          result.diagnosis?.category !== "command_not_found";

        if (hasValidEvidence) {
          baselineContinuationTriggeredRef.current.add(request.id);
          void submitPrompt("resume_baseline_planning");
        }
      }
      return execution.result;
    } catch (error) {
      await refreshRuntimeSession();
      throw error;
    } finally {
      setActiveRuntimeCommand((current) => current?.requestId === request.id ? null : current);
    }
  }

  async function handleRunPendingCommands() {
    if (!runtimeSession) return;
    const runnable = runtimeSession.commandRequests.filter((request) => request.status === "requested" || request.status === "approved");
    if (!runnable.length) {
      setMessage("No pending command requests.");
      return;
    }
    setBottomView("terminal");
    try {
      for (const request of runnable) {
        setTerminalCommand(request.command);
        const result = await runCommandRequest(runtimeSession, request);
        setTerminalResult(result);
      }
      setMessage("Pending commands were sent through Rust.");
      await refreshWorkspaceState();
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function handleRunSuggestedCommand(command: string, requestId?: string) {
    setTerminalCommand(command);
    setBottomView("terminal");
    try {
      const request = runtimeSession?.commandRequests.find((item) => item.id === requestId);
      const result = runtimeSession && request
        ? await runCommandRequest(runtimeSession, request)
        : await runWorkspaceCommand(command, commandSafetySettings(safetySettings));
      setTerminalResult(result);
      setMessage(result.diagnosis?.summary ?? result.message ?? `Command ${result.status}.`);
      await refreshWorkspaceState();
    } catch (error) {
      setMessage(String(error));
    }
  }

  function toggleBottomView(nextView: Exclude<BottomView, "none">) {
    setBottomView((current) => (current === nextView ? "none" : nextView));
  }

  function resetForNewChat(statusMessage: string) {
    runtimeEventUnsubscribeRef.current?.();
    runtimeEventUnsubscribeRef.current = null;
    baselineContinuationTriggeredRef.current.clear();
    setPrompt("");
    setRuntimeSession(null);
    setRuntimeSessionToken("");
    setActivityOpen(false);
    setThinkFirst(false);
    setQueuedPrompts([]);
    setBottomView("none");
    setTerminalResult(null);
    setRuntimeConnectionState("connected");
    setSseConnectionState(INITIAL_SSE_STATE);
    setMessage(statusMessage);
  }

  function handleNewChat() {
    resetForNewChat("Select a workspace and start from the composer.");
  }

  async function handleNewChatForProject(projectPath: string) {
    try {
      const normalizedPath = normalizeWorkspacePath(projectPath);
      if (!workspace || normalizeWorkspacePath(workspace.path) !== normalizedPath) {
        await activateWorkspace(normalizedPath, { restoreSession: false, silent: true });
      }
      expandProjectPath(normalizedPath);
      setSidebarCollapsed(false);
      resetForNewChat(`New chat ready in ${pathBasename(normalizedPath)}.`);
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function handleOpenProjectExplorer(project: FileExplorerProject) {
    try {
      const normalizedPath = normalizeWorkspacePath(project.path);
      if (!workspace || normalizeWorkspacePath(workspace.path) !== normalizedPath) {
        await activateWorkspace(normalizedPath, { restoreSession: false, silent: true });
      }
      setFileExplorerProject({ path: normalizedPath, name: project.name });
      setFileExplorerFilter("");
      setExpandedExplorerDirs([]);
      expandProjectPath(normalizedPath);
      setSidebarCollapsed(false);
      setMessage(`Inspecting files in ${project.name}.`);
    } catch (error) {
      setMessage(String(error));
    }
  }

  function handleWorkspaceButton() {
    setSidebarCollapsed(false);
    if (workspacePath.trim()) {
      void handleOpenWorkspace();
      return;
    }
    void handlePickWorkspace();
  }

  function openProgressRail() {
    if (progressRailCloseTimerRef.current !== null) {
      window.clearTimeout(progressRailCloseTimerRef.current);
      progressRailCloseTimerRef.current = null;
    }
    setProgressRailOpen(true);
  }

  function closeProgressRailSoon() {
    if (progressRailCloseTimerRef.current !== null) {
      window.clearTimeout(progressRailCloseTimerRef.current);
    }
    progressRailCloseTimerRef.current = window.setTimeout(() => {
      setProgressRailOpen(false);
      progressRailCloseTimerRef.current = null;
    }, 180);
  }

  function handleSelectAccessProfile(option: AccessOption) {
    if (option.value === "full_access") {
      const confirmed = window.confirm(
        "Full Access can write files, apply generated patches, and run setup/dev/test/network/background commands automatically. Use it only in a workspace you trust."
      );
      if (!confirmed) return;
      localStorage.setItem(FULL_ACCESS_WARNING_KEY, "true");
      setShowFullAccessBanner(true);
    }
    setAccessProfile(option.value);
    setAccessMenuOpen(false);
    setMessage(option.description);
  }

  function handleProjectClick() {
    setSidebarCollapsed(false);
    setActivityOpen(false);
    setBottomView("none");
    setMessage(workspace ? `Workspace selected: ${workspace.name}` : "Open a workspace first.");
  }

  async function handleProjectGroupClick(project: {
    path: string;
    name: string;
    lastOpenedAt: string;
    isActive: boolean;
    sessions: RecentSessionEntry[];
  }) {
    const normalizedPath = normalizeWorkspacePath(project.path);
    setCollapsedProjectPaths((current) =>
      current.includes(normalizedPath)
        ? current.filter((entry) => entry !== normalizedPath)
        : [...current, normalizedPath]
    );
  }

  function handleToggleAllProjects() {
    const projectPaths = sidebarProjects.map((project) => normalizeWorkspacePath(project.path));
    const allCollapsed = projectPaths.length > 0 && projectPaths.every((path) => collapsedProjectPaths.includes(path));
    setCollapsedProjectPaths(allCollapsed ? [] : projectPaths);
  }

  function enqueuePrompt(mode: QueuedPrompt["mode"]) {
    const text = prompt.trim();
    if (!text) {
      setMessage("Write a follow-up message first.");
      return;
    }
    const entry: QueuedPrompt = {
      id: `queued_${queueIdRef.current += 1}`,
      text,
      mode
    };
    setQueuedPrompts((current) => (mode === "steer" ? [entry, ...current] : [...current, entry]));
    setPrompt("");
    setPromptHistoryIndex(null);
    setPromptDraftBeforeHistory("");
    setMessage(mode === "steer" ? "Added as steer. It will run next." : "Added to queue. It will run after the current task.");
  }

  function handlePromptKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      if (event.key === "=" || event.key === "+") {
        event.preventDefault();
        updateComposerScale(COMPOSER_SCALE_STEP);
        return;
      }
      if (event.key === "-") {
        event.preventDefault();
        updateComposerScale(-COMPOSER_SCALE_STEP);
        return;
      }
      if (event.key === "0") {
        event.preventDefault();
        setComposerScaleValue(DEFAULT_COMPOSER_SCALE);
        setMessage("Input size reset.");
        return;
      }
    }

    if (event.key === "Enter" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      void handleRunAgent();
      return;
    }

    if (event.key === "ArrowUp" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
      const target = event.currentTarget;
      const isCollapsed = target.selectionStart === target.selectionEnd;
      const isAtTop = target.selectionStart === 0;
      if (!isCollapsed || (!isAtTop && prompt.trim())) return;
      event.preventDefault();
      if (!promptHistory.length) return;
      setPromptHistoryIndex((current) => {
        const nextIndex = current === null ? 0 : Math.min(current + 1, promptHistory.length - 1);
        if (current === null) {
          setPromptDraftBeforeHistory(prompt);
        }
        setPrompt(promptHistory[nextIndex] ?? "");
        return nextIndex;
      });
      return;
    }

    if (event.key === "ArrowDown" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
      if (promptHistoryIndex === null) return;
      event.preventDefault();
      setPromptHistoryIndex((current) => {
        if (current === null) return null;
        const nextIndex = current - 1;
        if (nextIndex < 0) {
          setPrompt(promptDraftBeforeHistory);
          return null;
        }
        setPrompt(promptHistory[nextIndex] ?? "");
        return nextIndex;
      });
    }
  }

  function handleSidebarResizeStart(event: React.PointerEvent<HTMLButtonElement>) {
    if (sidebarCollapsed) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    document.body.classList.add("resizing-sidebar");

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const nextWidth = clampSidebarWidth(startWidth + (moveEvent.clientX - startX));
      setSidebarWidth(nextWidth);
    };

    const handlePointerUp = () => {
      document.body.classList.remove("resizing-sidebar");
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
    window.addEventListener("pointercancel", handlePointerUp, { once: true });
  }

  function updateComposerScale(delta: number) {
    const next = clampComposerScale(composerScale + delta);
    setComposerScaleValue(next);
    setMessage(`Input size ${Math.round(next * 100)}%. Use Ctrl/Cmd 0 to reset.`);
  }

  function setComposerScaleValue(next: number) {
    const normalized = clampComposerScale(next);
    setComposerScale(normalized);
    localStorage.setItem(COMPOSER_SCALE_KEY, String(normalized));
  }

  async function handleOpenPreview(preview?: AgentRuntimeSession["previewRecommendation"]) {
    preview ??= runtimeSession?.previewRecommendation;
    if (!preview || !workspace) return;
    const target =
      preview.type === "url"
        ? preview.target
        : `file:///${`${workspace.path}\\${preview.target}`.replaceAll("\\", "/")}`;
    try {
      await openExternalTarget(target);
    } catch (error) {
      setMessage(`Preview open failed: ${String(error)}`);
    }
  }

  async function handleOpenFileReference(reference: FileReference) {
    if (!workspace) {
      setMessage("Open a workspace before opening file references.");
      return;
    }
    if (!isSafeRelativeFilePath(reference.path)) {
      setActiveFileReference({
        ...reference,
        content: "",
        status: "failed",
        error: "This file reference is outside the active workspace."
      });
      setMessage("File reference blocked because it points outside the workspace.");
      return;
    }

    const normalizedReference = {
      ...reference,
      line: Math.max(1, Math.floor(reference.line)),
      lineEnd: reference.lineEnd ? Math.max(reference.line, Math.floor(reference.lineEnd)) : undefined
    };
    setActiveFileReference({ ...normalizedReference, content: "", status: "loading" });

    try {
      const content = await readWorkspaceFile(normalizedReference.path);
      setActiveFileReference({ ...normalizedReference, content, status: "ready" });
      setMessage(`Opened ${normalizedReference.path}:${normalizedReference.line}`);
    } catch (error) {
      setActiveFileReference({
        ...normalizedReference,
        content: "",
        status: "failed",
        error: String(error)
      });
      setMessage(`File preview failed: ${String(error)}`);
    }
  }

  async function handleCopyText(text: string, label = "Copied output.") {
    try {
      await navigator.clipboard.writeText(text);
      setMessage(label);
    } catch (error) {
      setMessage(`Copy failed: ${String(error)}`);
    }
  }

  return (
    <div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${showRightPanel ? "activity-open" : ""}`}>
      <header className="frame-bar">
        <div className="frame-bar-left">
          <button className="frame-icon-button" onClick={() => setSidebarCollapsed((current) => !current)} title="Toggle sidebar">
            <PanelLeft size={16} />
          </button>
          <img className="app-brand-mark" src="/hivo-icon.png" alt="Hivo Studio" />
        </div>

        <div className="frame-bar-right">
          <button
            className={`toolbar-button latest-code-button ${latestCodeButtonState.className}`}
            onClick={handleRestartWithLatestCode}
            disabled={restartingApp}
            title={latestCodeButtonState.title}
          >
            <RefreshCw size={15} className={restartingApp ? "spin-icon" : undefined} />
            <span>{latestCodeButtonState.label}</span>
          </button>
          <button className="toolbar-button" onClick={() => setSettingsOpen(true)}>
            <Settings size={15} />
            <span>Settings</span>
          </button>
        </div>
      </header>

      <div className="shell-layout" style={shellLayoutStyle}>
        <aside className="project-sidebar">
          <div className="sidebar-top">
            <button className="sidebar-link" onClick={handleNewChat} title="Start a new chat" type="button">
              <MessageSquarePlus size={17} />
              <span>New chat</span>
            </button>
          </div>

          <section className="sidebar-section">
            <div className="workspace-open-row">
              <input
                ref={workspaceInputRef}
                value={workspacePath}
                onChange={(event) => setWorkspacePath(event.target.value)}
                placeholder="D:\\projects\\my-app"
              />
              <button className="frame-icon-button" onClick={handlePickWorkspace} title="Pick workspace folder">
                <FolderOpen size={16} />
              </button>
            </div>
            <div className="sidebar-section-header">
              <span>Projects</span>
              <div className="sidebar-section-actions">
                <button
                  className="frame-icon-button"
                  onClick={handleToggleAllProjects}
                  title={allProjectsCollapsed ? "Expand all projects" : "Collapse all projects"}
                  type="button"
                >
                  {allProjectsCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                </button>
                <button className="frame-icon-button" onClick={handleNewChat} title="Start a new chat" type="button">
                  <MessageSquarePlus size={14} />
                </button>
              </div>
            </div>

            {sidebarProjects.length ? (
              <div className="project-groups">
                {sidebarProjects.map((project) => {
                  const normalizedProjectPath = normalizeWorkspacePath(project.path);
                  const isCollapsed = collapsedProjectPaths.includes(normalizedProjectPath);
                  const sessionsExpanded = expandedSessionProjectPaths.includes(normalizedProjectPath);
                  const hiddenSessionCount = Math.max(0, project.sessions.length - MAX_VISIBLE_PROJECT_SESSIONS);
                  const displayedSessions = sessionsExpanded
                    ? project.sessions
                    : project.sessions.slice(0, MAX_VISIBLE_PROJECT_SESSIONS);
                  return (
                    <section
                      key={project.path}
                      className={`project-group ${project.isActive ? "active-project-group" : ""} ${isCollapsed ? "collapsed-project-group" : ""}`}
                    >
                      <div className="project-group-header" title={project.path}>
                        <button
                          className="project-group-main"
                          onClick={() => void handleProjectGroupClick(project)}
                          type="button"
                        >
                          <div className="project-group-title">
                            {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                            <FolderOpen size={15} />
                            <strong>{project.name}</strong>
                          </div>
                          <small>{project.isActive ? gitStatus?.branch ?? "active" : formatRelativeDate(project.lastOpenedAt)}</small>
                        </button>
                        <div className="project-group-actions">
                          <button
                            className="frame-icon-button"
                            onClick={() => void handleOpenProjectExplorer({ path: project.path, name: project.name })}
                            title={`Explore files in ${project.name}`}
                            type="button"
                          >
                            <FolderTree size={14} />
                          </button>
                          <button
                            className="frame-icon-button"
                            onClick={() => void handleNewChatForProject(project.path)}
                            title={`New chat in ${project.name}`}
                            type="button"
                          >
                            <MessageSquarePlus size={14} />
                          </button>
                        </div>
                      </div>

                      {!isCollapsed && project.sessions.length ? (
                        <div className="project-session-list">
                          {displayedSessions.map((entry) => {
                            const isActiveSession = entry.id === runtimeSession?.id;
                            const isPinnedSession = pinnedSessionIdSet.has(entry.id);
                            return (
                              <div
                                key={entry.id}
                                className={[
                                  "project-session-item",
                                  isActiveSession ? "active-session-item" : "",
                                  isPinnedSession ? "pinned-session-item" : ""
                                ].filter(Boolean).join(" ")}
                              >
                                <button
                                  className="project-session-main"
                                  onClick={() =>
                                    isActiveSession
                                      ? setActivityOpen(true)
                                      : void handleRestoreRecentSession(entry)
                                  }
                                  title={
                                    isActiveSession
                                      ? `Open current session in ${entry.workspacePath}`
                                      : getPersistedSessionToken(sessionTokens, entry.id)
                                        ? `Reopen chat in ${entry.workspacePath}`
                                        : `Open saved chat history from ${entry.workspacePath}`
                                  }
                                  type="button"
                                >
                                  <span className="project-session-title-wrap">
                                    <span className="project-session-title">{entry.title}</span>
                                    <small className="project-session-workspace">{entry.workspaceName || pathBasename(entry.workspacePath)}</small>
                                  </span>
                                </button>
                                <button
                                  className="project-session-pin"
                                  onClick={() => handleTogglePinnedSession(entry)}
                                  title={isPinnedSession ? "Unpin chat" : "Pin chat"}
                                  type="button"
                                  aria-pressed={isPinnedSession}
                                >
                                  <Pin size={13} />
                                </button>
                                <button
                                  className="project-session-archive"
                                  onClick={() => handleArchiveSession(entry)}
                                  title="Archive chat"
                                  type="button"
                                >
                                  <Trash2 size={13} />
                                </button>
                                <small className="project-session-age">{formatRelativeDate(entry.updatedAt)}</small>
                              </div>
                            );
                          })}
                          {hiddenSessionCount ? (
                            <button
                              className="project-session-show-more"
                              onClick={() => handleToggleProjectSessionsExpanded(project.path)}
                              type="button"
                            >
                              {sessionsExpanded ? "Show less" : "Show more"}
                            </button>
                          ) : null}
                        </div>
                      ) : !isCollapsed ? (
                        <div className="sidebar-empty">No chats yet for this project.</div>
                      ) : null}
                    </section>
                  );
                })}
              </div>
            ) : (
              <div className="sidebar-empty">Your active workspace will appear here.</div>
            )}
          </section>

          <div className="sidebar-bottom">
            <button className="sidebar-settings" onClick={() => setArchiveOpen((current) => !current)} title="Archived chats" type="button">
              <Archive size={16} />
              <span>Archive</span>
              {archivedSessions.length ? <small>{archivedSessions.length}</small> : null}
            </button>
            {archiveOpen ? (
              <div className="archive-panel">
                {archivedSessions.length ? (
                  archivedSessions.map((entry) => (
                    <div className="archive-session-row" key={entry.id}>
                      <button
                        className="archive-session-main"
                        onClick={() => void handleRestoreArchivedSession(entry)}
                        title="Restore and open archived chat"
                        type="button"
                      >
                        <span>{entry.title}</span>
                        <small>{entry.workspaceName} · {formatRelativeDate(entry.updatedAt)}</small>
                      </button>
                      <button
                        className="frame-icon-button archive-restore-button"
                        onClick={() => void handleRestoreArchivedSession(entry)}
                        title="Restore chat"
                        type="button"
                      >
                        <RotateCcw size={13} />
                      </button>
                    </div>
                  ))
                ) : (
                  <div className="sidebar-empty archive-empty">No archived chats.</div>
                )}
              </div>
            ) : null}
            <button className="sidebar-settings" onClick={() => setSettingsOpen(true)} title="Settings" type="button">
              <Settings size={16} />
              <span>Settings</span>
            </button>
          </div>
        </aside>

        <button
          className="sidebar-resizer"
          onPointerDown={handleSidebarResizeStart}
          type="button"
          aria-label="Resize sidebar"
          title="Drag to resize sidebar"
          tabIndex={sidebarCollapsed ? -1 : 0}
        />

        <main className="workspace-canvas">
          <div className="canvas-toolbar">
            <div className="toolbar-group">
              <button className="toolbar-button primary-toolbar" onClick={handleWorkspaceButton}>
                <Code2 size={16} />
                <span>{workspace?.name ?? "Select workspace"}</span>
                <ChevronDown size={14} />
              </button>
            </div>

            <div className="toolbar-group">
              {runtimeSession?.swarmState && (runtimeSession.swarmState.nodes.length > 0) ? (
                <SwarmDock
                  session={runtimeSession}
                  sessionToken={runtimeSessionToken || (getPersistedSessionToken(sessionTokens, runtimeSession.id)?.token ?? "")}
                  onSessionUpdate={applyCanonicalRuntimeSession}
                  onSelectAgent={(agentId) => {
                    if (agentPanel.agents.some((agent) => agent.id === agentId)) {
                      setSelectedAgentId(agentId);
                      setAgentPanelOpen(true);
                    }
                  }}
                />
              ) : hasAgentSidePanel ? (
                <AgentIconRow
                  agents={agentPanel.agents}
                  selectedAgentId={selectedAgentId}
                  panelOpen={agentPanelOpen}
                  onSelectAgent={(agentId) => {
                    setSelectedAgentId(agentId);
                    setAgentPanelOpen(true);
                  }}
                />
              ) : null}
              <button
                className={`frame-icon-button ${activityOpen ? "active-toggle" : ""}`}
                onClick={() => setActivityOpen((current) => !current)}
                title="Toggle details panel"
              >
                <Bot size={16} />
              </button>
              <button
                className={`frame-icon-button ${bottomView === "diff" ? "active-toggle" : ""}`}
                onClick={() => toggleBottomView("diff")}
                title="Toggle diff panel"
              >
                <Diff size={16} />
              </button>
              <button
                className={`frame-icon-button ${bottomView === "terminal" ? "active-toggle" : ""}`}
                onClick={() => toggleBottomView("terminal")}
                title="Toggle terminal"
              >
                <TerminalSquare size={16} />
              </button>
              <button
                className={`frame-icon-button ${fileExplorerProject ? "active-toggle" : ""}`}
                onClick={() =>
                  workspace
                    ? void handleOpenProjectExplorer({ path: workspace.path, name: workspace.name })
                    : undefined
                }
                title="Explore workspace files"
                disabled={!workspace}
              >
                <FolderTree size={16} />
              </button>
            </div>
          </div>

          <section className={`hero-panel ${hasSessionView ? "session-active" : ""}`}>
            <div className="hero-copy">
              <p className="hero-eyebrow">{sessionSummary}</p>
              {!runtimeSession ? (
                <>
                  <img className="hero-brand-mark" src="/hivo-icon.png" alt="" aria-hidden="true" />
                  <h1>Hivo Studio</h1>
                  <p className="hero-slogan">stop paying, stop thinking, stop prompting</p>
                </>
              ) : null}
            </div>

            {runtimeSession ? (
              <ThreadFeed
                session={runtimeSession}
                connectionState={liveConnectionState}
                sseState={sseConnectionState}
                canReconnect={Boolean(runtimeSessionToken || getPersistedSessionToken(sessionTokens, runtimeSession.id)?.token)}
                activeRuntimeCommand={activeRuntimeCommand}
                agentBusy={agentBusy}
                onOpenActivity={() => setActivityOpen(true)}
                onOpenDiff={() => setBottomView("diff")}
                onQuickReply={submitPrompt}
                onOpenPreview={() => void handleOpenPreview()}
                onRunPendingCommands={() => void handleRunPendingCommands()}
                onOpenFileReference={handleOpenFileReference}
                activeWorkspacePath={workspace?.path}
                rtlTextMode={rtlTextMode}
              />
            ) : null}

            <div className={`composer-shell ${rtlTextMode ? "rtl-text-mode" : ""}`} style={{ "--composer-scale": String(composerScale) } as CSSProperties}>
              <div className={`composer-input-frame ${agentBusy ? "is-thinking" : ""}`}>
                <textarea
                  ref={promptTextareaRef}
                  value={prompt}
                  onChange={(event) => {
                    setPrompt(event.target.value);
                    if (promptHistoryIndex !== null) {
                      setPromptHistoryIndex(null);
                    }
                    if (isPreSessionErrorMessage(message)) {
                      setMessage("");
                    }
                  }}
                  onKeyDown={handlePromptKeyDown}
                  placeholder="Ask Hivo to create or edit a project with Ollama..."
                  rows={1}
                  dir={rtlTextMode ? "rtl" : "auto"}
                />
                <div className="composer-input-actions">
                  <div className="composer-input-left">
                    <div className="access-menu-shell" ref={accessMenuShellRef}>
                      <button
                        className={`composer-chip access-chip ${accessProfile === "full_access" ? "danger-access-chip" : ""}`}
                        onClick={() => setAccessMenuOpen((current) => !current)}
                        type="button"
                      >
                        <ShieldCheck size={14} />
                        <span>{accessProfileLabel(accessProfile)}</span>
                        <ChevronDown size={14} />
                      </button>
                      {accessMenuOpen ? (
                        <div className="access-menu">
                          {accessOptions.map((option) => (
                            <button
                              key={option.value}
                              className={`access-option ${isAccessOptionSelected(accessProfile, option.value) ? "selected" : ""}`}
                              onClick={() => handleSelectAccessProfile(option)}
                              type="button"
                            >
                              <strong>{option.label}</strong>
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <div className="composer-input-right">
                    <button
                      className={`composer-chip ${rtlTextMode ? "active-toggle" : ""}`}
                      onClick={() => setRtlTextMode((current) => !current)}
                      type="button"
                      title="Toggle RTL for Arabic text in the composer and chat messages"
                      aria-pressed={rtlTextMode}
                    >
                      <Languages size={15} />
                      <span>RTL</span>
                    </button>
                    {agentBusy && prompt.trim() ? (
                      <button className="composer-chip" onClick={() => enqueuePrompt("steer")} type="button">
                        <Workflow size={14} />
                        <span>Steer</span>
                      </button>
                    ) : null}
                    <button
                      className={`send-button ${hasPromptDraft ? "has-draft" : ""} ${agentBusy ? "is-busy" : ""}`}
                      disabled={sendButtonDisabled}
                      onClick={handleRunAgent}
                      title={agentBusy ? "Working on your request" : hasPromptDraft ? "Send message" : "Write a message first"}
                      type="button"
                    >
                      {agentBusy ? <LoaderCircle size={16} className="spin-icon" /> : hasPromptDraft ? <ArrowUp size={16} /> : <Play size={16} />}
                    </button>
                  </div>
                </div>
              </div>

              <div className="composer-footer">
                <button className="footer-pill" onClick={handlePickWorkspace}>
                  <FolderOpen size={14} />
                  <span>{workspace?.name ?? "Open workspace"}</span>
                </button>
                <button className="footer-pill" onClick={() => setActivityOpen(true)}>
                  <GitBranch size={14} />
                  <span>Details</span>
                </button>
                <button
                  className={`footer-pill plan-mode-chip ${thinkFirst ? "active-toggle" : ""}`}
                  onClick={() => setThinkFirst((current) => !current)}
                  type="button"
                >
                  {thinkFirst ? <ToggleRight size={16} /> : <ToggleLeft size={16} />}
                  <span>Plan mode</span>
                </button>
              </div>

              {planModeSuggestionVisible ? (
                <div className="plan-mode-suggestion-row">
                  <button
                    className="plan-mode-suggestion"
                    onClick={() => {
                      setThinkFirst(true);
                      setMessage("Plan mode enabled. I will read first, ask only when needed, and stop before any edits.");
                    }}
                    type="button"
                  >
                    <Workflow size={14} />
                    <span>Use plan mode</span>
                  </button>
                </div>
              ) : null}

              {accessProfile === "full_access" && showFullAccessBanner ? (
                <div className="full-access-banner">
                  <div>
                    <strong>Full Access is on</strong>
                    <span>Validated file changes apply automatically, and requested setup/dev/test/network/background commands can run without another prompt.</span>
                  </div>
                  <button className="frame-icon-button" onClick={() => setShowFullAccessBanner(false)} title="Dismiss full access notice">
                    <X size={14} />
                  </button>
                </div>
              ) : null}

              {preSessionErrorMessage ? (
                <div
                  className="full-access-banner pre-session-error-banner"
                  style={{
                    borderColor: "rgba(239, 68, 68, 0.35)",
                    background: "rgba(239, 68, 68, 0.08)"
                  }}
                >
                  <div style={{ display: "grid", gap: "4px" }}>
                    <strong style={{ color: "#fca5a5" }}>Unable to start session</strong>
                    <span style={{ color: "#fecaca" }}>{preSessionErrorMessage}</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    {!providerConfig?.isValid ? (
                      <button
                        className="composer-chip"
                        onClick={() => setSettingsOpen(true)}
                        type="button"
                        style={{ height: "26px", fontSize: "12px", padding: "0 8px" }}
                      >
                        Settings
                      </button>
                    ) : null}
                    <button
                      className="frame-icon-button"
                      onClick={() => setMessage("")}
                      title="Dismiss error notice"
                      type="button"
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
              ) : null}

              {agentBusy || queuedPrompts.length ? (
                <div className="queue-strip">
                  {agentBusy ? <span className="queue-pill">Working now</span> : null}
                  {queuedPrompts.length ? (
                    <span className="queue-pill">
                      {queuedPrompts.length} queued
                      {queuedPrompts[0] ? ` | ${queuedPrompts[0].mode === "steer" ? "steer next" : "next in queue"}` : ""}
                    </span>
                  ) : null}
                  {queuedPrompts[0] ? <span className="queue-preview">{summarizeLatestQueueEntry(queuedPrompts[0])}</span> : null}
                </div>
              ) : null}
            </div>

            {!runtimeSession ? (
              <div className="starter-list">
                {starterPrompts.map((starter) => (
                  <button
                    key={starter}
                    className="starter-row"
                    onClick={() => {
                      setPrompt(starter);
                      if (isPreSessionErrorMessage(message)) {
                        setMessage("");
                      }
                    }}
                  >
                    <Workflow size={15} />
                    <span>{starter}</span>
                  </button>
                ))}
              </div>
            ) : null}

          </section>

          {bottomView !== "none" ? (
            <section className="bottom-drawer">
              <div className="drawer-header">
                <div>
                  <strong>{bottomView === "terminal" ? "Terminal" : "Code review"}</strong>
                  <span>{bottomView === "terminal" ? "Run policy-classified commands when you need them." : "Compare generated changes with the live git diff."}</span>
                </div>
                <button className="frame-icon-button" onClick={() => setBottomView("none")} title="Close drawer">
                  <X size={16} />
                </button>
              </div>

              {bottomView === "terminal" ? (
                <div className="terminal-drawer">
                  <div className="terminal-controls">
                    <input value={terminalCommand} onChange={(event) => setTerminalCommand(event.target.value)} />
                    <button onClick={handleRunCommand}>Run classified command</button>
                    {terminalResult ? (
                      <button
                        onClick={() =>
                          void handleCopyText(formatTerminalResult(terminalResult), "Copied terminal output.")
                        }
                      >
                        <Copy size={14} />
                        Copy
                      </button>
                    ) : null}
                  </div>
                  <pre>
                    {terminalResult ? formatTerminalResult(terminalResult) : "Manual console for commands that current policy heuristics may allow. Medium-risk runtime commands pause for approval. Dangerous commands still stop safely."}
                  </pre>
                </div>
              ) : (
                <div className="diff-drawer">
                  <div className="diff-column">
                    <h3>Proposed diff</h3>
                    <pre>{runtimeSession?.patchProposals[0]?.unifiedDiff || "No patch proposal yet."}</pre>
                  </div>
                  <div className="diff-column">
                    <div className="diff-column-header">
                      <h3>Git diff</h3>
                      <button onClick={() => refreshWorkspaceState()}>Refresh</button>
                    </div>
                    <pre>{diffText || "Open a git workspace to show diff text."}</pre>
                  </div>
                </div>
              )}
            </section>
          ) : null}
        </main>

        {agentPanelOpen && hasAgentSidePanel ? (
          <AgentPanelOverlay
            agents={agentPanel.agents}
            backgroundJobs={agentPanel.backgroundJobs}
            selectedAgentId={selectedAgentId}
            onSelectAgent={setSelectedAgentId}
            onOpenDiff={() => setBottomView("diff")}
            onClose={() => setAgentPanelOpen(false)}
          />
        ) : null}

        {activeFileReference ? (
          <FileReferencePanel
            reference={activeFileReference}
            workspacePath={workspace?.path ?? ""}
            onClose={() => setActiveFileReference(null)}
          />
        ) : null}

        {fileExplorerProject ? (
          <FileExplorerPanel
            project={fileExplorerProject}
            filter={fileExplorerFilter}
            onFilterChange={setFileExplorerFilter}
            tree={fileExplorerTree}
            expandedDirs={expandedExplorerDirs}
            onToggleDir={(targetPath) =>
              setExpandedExplorerDirs((current) =>
                current.includes(targetPath)
                  ? current.filter((entry) => entry !== targetPath)
                  : [...current, targetPath]
              )
            }
            onOpenFile={(targetPath) => void handleOpenFileReference({ path: targetPath, line: 1 })}
            onClose={() => {
              setFileExplorerProject(null);
              setFileExplorerFilter("");
              setExpandedExplorerDirs([]);
            }}
          />
        ) : null}

        {showRightPanel ? (
          <aside className="activity-drawer">
            <div className="drawer-header">
              <div>
                <strong>Activity</strong>
                <span>Open details only when you need them.</span>
              </div>
              <button className="frame-icon-button" onClick={() => setActivityOpen(false)} title="Close activity panel">
                <X size={16} />
              </button>
            </div>

            <DrawerSection title="Live Progress">
              {runtimeSession ? (
                <LiveProgressDrawer session={runtimeSession} />
              ) : (
                <p className="muted">No active run progress yet.</p>
              )}
            </DrawerSection>

            <DrawerSection title="Session">
              {runtimeSession ? (
                <dl className="session-details">
                  <dt>ID</dt>
                  <dd>{runtimeSession.id}</dd>
                  <dt>Status</dt>
                  <dd>{humanizeRuntimeStatus(runtimeSession.status)}</dd>
                  <dt>Stage</dt>
                  <dd>{humanizeLifecycleStage(runtimeSession.lifecycleStage)}</dd>
                  <dt>Runtime</dt>
                  <dd>{runtimeConnectionState}</dd>
                  <dt>SSE</dt>
                  <dd>{describeSseState(sseConnectionState, Boolean(runtimeSessionToken || getPersistedSessionToken(sessionTokens, runtimeSession.id)?.token))}</dd>
                  <dt>Last Event</dt>
                  <dd>{formatOptionalTimestamp(sseConnectionState.lastEventAt)}</dd>
                  <dt>Auth</dt>
                  <dd>{sseConnectionState.tokenExpired ? "token_expired" : sseConnectionState.unauthorized ? "unauthorized" : "ok"}</dd>
                  <dt>Provider Source</dt>
                  <dd>{runtimeSession.providerTelemetry?.activeProviderSource ?? runtimeSession.activeProviderSource ?? "unknown"}</dd>
                  <dt>Author Model</dt>
                  <dd>{getProviderCertification(runtimeSession.providerTelemetry).authorModel}</dd>
                  <dt>Router Model</dt>
                  <dd>{getProviderCertification(runtimeSession.providerTelemetry).routerModel}</dd>
                  <dt>Verifier Model</dt>
                  <dd>{getProviderCertification(runtimeSession.providerTelemetry).verifierModel}</dd>
                  <dt>Certification</dt>
                  <dd title={getProviderCertification(runtimeSession.providerTelemetry).reason}>
                    {getProviderCertification(runtimeSession.providerTelemetry).status}
                  </dd>
                  <dt>Certified Gates</dt>
                  <dd>{getProviderCertification(runtimeSession.providerTelemetry).certifiedGates.join(", ") || "none"}</dd>
                  <dt>Reasoning Attempts</dt>
                  <dd>{runtimeSession.providerTelemetry?.reasoningAttempts ?? 0}</dd>
                  <dt>Repair Attempts</dt>
                  <dd>{runtimeSession.providerTelemetry?.repairAttempts ?? 0}</dd>
                  <dt>Tool Rounds</dt>
                  <dd>{runtimeSession.latestDecisionPipeline?.reasoningTrace?.toolRounds ?? 0}</dd>
                  <dt>Evidence</dt>
                  <dd>{getReasoningTraceSummary(runtimeSession).evidenceCount}</dd>
                  <dt>Information Gain</dt>
                  <dd>{getReasoningTraceSummary(runtimeSession).informationGain}</dd>
                  <dt>Stagnant Rounds</dt>
                  <dd>{getReasoningTraceSummary(runtimeSession).stagnantRounds}</dd>
                  <dt>Index Readiness</dt>
                  <dd>{getReasoningTraceSummary(runtimeSession).indexReadiness}</dd>
                  <dt>Context Omissions</dt>
                  <dd>{getReasoningTraceSummary(runtimeSession).contextOmissions}</dd>
                  <dt>Verifier Verdict</dt>
                  <dd>{getReasoningTraceSummary(runtimeSession).verifierVerdict}</dd>
                  <dt>Reasoning Budget</dt>
                  <dd>{getReasoningTraceSummary(runtimeSession).budgetLabel}</dd>
                  <dt>Final Source</dt>
                  <dd>{runtimeSession.providerTelemetry?.finalResponseSource ?? "none"}</dd>
                  <dt>Request Count</dt>
                  <dd>{runtimeSession.providerTelemetry?.providerRequestCount ?? 0}</dd>
                  <dt>Planning Provider</dt>
                  <dd>{describePlanningProviderRequest(runtimeSession)}</dd>
                  <dt>Prompt Chars</dt>
                  <dd>{formatCount(runtimeSession.providerTelemetry?.totalProviderPromptChars ?? 0)}</dd>
                  <dt>Context Chars</dt>
                  <dd>{formatCount(runtimeSession.providerTelemetry?.totalProviderContextChars ?? 0)}</dd>
                  <dt>Response Chars</dt>
                  <dd>{formatCount(runtimeSession.providerTelemetry?.totalProviderResponseChars ?? 0)}</dd>
                  <dt>Last Error</dt>
                  <dd>{runtimeSession.providerTelemetry?.lastError ?? sseConnectionState.lastError ?? "none"}</dd>
                  <dt>Terminal Failure</dt>
                  <dd>{runtimeSession.latestDecisionPipeline?.terminalFailure ?? runtimeSession.providerTelemetry?.terminalFailure ?? "none"}</dd>
                  <dt>Restore</dt>
                  <dd>{runtimeSessionToken || (runtimeSession && getPersistedSessionToken(sessionTokens, runtimeSession.id)?.token) ? "This app session can still attempt reconnects." : "This chat is open from saved local history."}</dd>
                </dl>
              ) : (
                <p className="muted">No active session.</p>
              )}
            </DrawerSection>

            <DrawerSection title="Plan">
              {runtimeSession?.plan ? (
                <>
                  <p className="muted">{runtimeSession.plan.summary}</p>
                  {runtimeSession.plan.steps.map((step) => (
                    <StatusRow key={step.id} label={step.title} status={step.status} detail={step.detail} />
                  ))}
                </>
              ) : runtimeSession?.orchestration?.technicalPlan ? (
                <p className="muted">{runtimeSession.orchestration.technicalPlan.summary}</p>
              ) : (
                <p className="muted">No plan yet.</p>
              )}
            </DrawerSection>

            <DrawerSection title="Project Knowledge Tree">
              {runtimeSession?.projectKnowledgeTree ? (
                <ProjectKnowledgeTreePanel session={runtimeSession} />
              ) : (
                <p className="muted">No Project Knowledge Tree has been built for this session yet.</p>
              )}
            </DrawerSection>

            <DrawerSection title="Recursive Factory approvals">
              {runtimeSession?.recursiveFactory?.productSpec ? (
                <FactoryApprovalCard
                  title="Product Specification"
                  status={runtimeSession.recursiveFactory.productSpec.status}
                  revision={runtimeSession.recursiveFactory.productSpec.revision}
                  summary={runtimeSession.recursiveFactory.productSpec.userGoal}
                  onApprove={() => void handleFactoryDecision("product_spec", "approved")}
                  onReject={() => void handleFactoryDecision("product_spec", "rejected")}
                  onRequestChanges={() => void handleFactoryDecision("product_spec", "changes_requested")}
                />
              ) : (
                <p className="muted">No Product Specification proposed.</p>
              )}
              {runtimeSession?.recursiveFactory?.technicalPlan ? (
                <FactoryApprovalCard
                  title="Technical Plan"
                  status={runtimeSession.recursiveFactory.technicalPlan.status ?? "proposed"}
                  revision={runtimeSession.recursiveFactory.technicalPlan.revision ?? 1}
                  summary={runtimeSession.recursiveFactory.technicalPlan.summary}
                  onApprove={() => void handleFactoryDecision("technical_plan", "approved")}
                  onReject={() => void handleFactoryDecision("technical_plan", "rejected")}
                  onRequestChanges={() => void handleFactoryDecision("technical_plan", "changes_requested")}
                />
              ) : (
                <p className="muted">Technical planning remains blocked until Product Specification approval.</p>
              )}
              {runtimeSession?.recursiveFactory?.phase === "approved_to_execute" ? (
                <p className="muted">Both planning gates approved. Execution has not started.</p>
              ) : null}
              {runtimeSession?.recursiveFactory?.phase === "recursive_graph_ready" && !runtimeSession.recursiveFactory.executionStarted ? (
                <div className="proposal-actions">
                  <button
                    onClick={() => void handleStartRecursiveBranchExecution()}
                    disabled={runtimeSession.recursiveFactory.graphReadiness?.status !== "ready"}
                  >
                    Approve start branch execution
                  </button>
                </div>
              ) : null}
            </DrawerSection>

            <DrawerSection title="Recursive graph">
              {runtimeSession?.recursiveFactory?.recursiveGraph ? (
                <RecursiveGraphCard session={runtimeSession} />
              ) : (
                <p className="muted">No recursive graph yet. It appears only after Product Specification and Technical Plan approval.</p>
              )}
            </DrawerSection>

            <DrawerSection title="Tasks">
              {!runtimeSession?.tasks.length ? (
                <p className="muted">No tasks yet.</p>
              ) : (
                runtimeSession.tasks.map((task) => (
                  <StatusRow key={task.id} label={task.title} status={task.status} detail={task.agentRole} />
                ))
              )}
            </DrawerSection>

            <DrawerSection title="Code changes">
              {!runtimeSession?.patchProposals.length ? (
                <p className="muted">No code changes yet.</p>
              ) : (
                runtimeSession.patchProposals.map((proposal) => (
                  <div className="proposal-card" key={proposal.id}>
                    <strong>{proposal.title}</strong>
                    <span>{humanizePatchStatus(proposal.status)} | {proposal.riskLevel} risk</span>
                    <p>{proposal.summary}</p>
                    <div className="proposal-actions">
                      <button onClick={() => handleApprovePatch(proposal.id)} disabled={proposal.status !== "proposed"}>
                        Approve patch write
                      </button>
                      <button onClick={() => handleApplyPatch(proposal.id)} disabled={proposal.status !== "approved"}>
                        Apply approved patch
                      </button>
                      <button onClick={() => handleRejectPatch(proposal.id)} disabled={proposal.status !== "proposed"}>
                        Reject
                      </button>
                    </div>
                  </div>
                ))
              )}
            </DrawerSection>

            <DrawerSection title="Suggested actions">
              {!runtimeSession?.commandRequests.length ? (
                <p className="muted">No suggested actions yet.</p>
              ) : (
                runtimeSession.commandRequests.map((request) => (
                  <div className="proposal-card" key={request.id}>
                    <strong>{request.command}</strong>
                    <span>{request.risk} | {humanizeCommandRequestStatus(request.status)}</span>
                    <p>{request.reason}</p>
                    <p className="muted">{describeCommandRequestProvenance(runtimeSession, request)}</p>
                    {request.status === "executed" ? (
                      <button disabled>Executed by Rust</button>
                    ) : request.status === "executing" || request.status === "running" ? (
                      <button disabled>Background tracking limited</button>
                    ) : request.status === "blocked" ? (
                      <button disabled>Needs attention</button>
                    ) : request.status === "denied" || request.status === "rejected" ? (
                      <button disabled>Denied</button>
                    ) : (
                      <button
                        onClick={() => handleRunSuggestedCommand(request.command, request.id)}
                        disabled={request.risk !== "safe"}
                      >
                        Run with Rust
                      </button>
                    )}
                  </div>
                ))
              )}
            </DrawerSection>

            <DrawerSection title="Reviews">
              {!runtimeSession?.orchestration?.securityReviews.length && !runtimeSession?.orchestration?.reviewerSummaries.length ? (
                <p className="muted">No review notes yet.</p>
              ) : (
                [...(runtimeSession.orchestration?.securityReviews ?? []), ...(runtimeSession.orchestration?.reviewerSummaries ?? [])].map((review) => (
                  <StatusRow key={review.id} label={review.reviewer} status={review.status} detail={review.summary} />
                ))
              )}
            </DrawerSection>

            <DrawerSection title="Timeline">
              {!runtimeSession?.orchestration?.orchestrationEvents.length ? (
                <p className="muted">No orchestration events yet.</p>
              ) : (
                runtimeSession.orchestration.orchestrationEvents.slice(-12).map((event) => (
                  <StatusRow key={event.id} label={event.type} status={event.agentName ?? "system"} detail={event.message} />
                ))
              )}
            </DrawerSection>

            <DrawerSection title="Workspace files">
              {!files.length ? (
                <p className="muted">Open a workspace to inspect files.</p>
              ) : (
                files.slice(0, 40).map((file) => (
                  <div className="file-row compact" key={file.path}>
                    <FileText size={14} />
                    <span>{file.path}</span>
                    {file.isSecretCandidate ? <span className="secret-tag">secret</span> : null}
                  </div>
                ))
              )}
            </DrawerSection>

            <DrawerSection title="Status">
              <div className="sidebar-meta">
                <div>
                  <strong>Git</strong>
                  <span>{gitStatus?.statusText || "No git status loaded."}</span>
                </div>
                <div>
                  <strong>Max parallel agents</strong>
                  <span>{String(safetySettings.maxParallelAgents)}</span>
                </div>
                <div>
                  <strong>Patch approval</strong>
                  <span>{safetySettings.requireApprovalForPatches ? "Required" : "Runtime review can proceed, but Rust still gates file writes"}</span>
                </div>
              </div>
            </DrawerSection>
          </aside>
        ) : null}
      </div>

      {showProgressRail && railCurrentStep ? (
        <ProgressHoverRail
          open={progressRailOpen}
          currentStep={railCurrentStep}
          items={railActivityItems}
          session={runtimeSession}
          onMouseEnter={openProgressRail}
          onMouseLeave={closeProgressRailSoon}
          onOpenPreview={() => void handleOpenPreview()}
          onOpenActivity={() => setActivityOpen(true)}
          onRunPendingCommands={() => void handleRunPendingCommands()}
        />
      ) : null}

      <HivoMascot visible={hivoPetVisible} raised={bottomView !== "none"} />

      {settingsOpen ? (
        <SettingsDialog
          currentConfig={providerConfig}
          hivoPetVisible={hivoPetVisible}
          onHivoPetVisibleChange={setHivoPetVisible}
          onClose={() => setSettingsOpen(false)}
          onSaved={(config) => {
            setProviderConfig(config);
            setMessage(config.isValid ? "Model provider saved." : config.lastValidationError ?? "Model provider saved as invalid.");
          }}
          onCleared={() => {
            setProviderConfig(null);
            setMessage("Model provider configuration cleared.");
          }}
        />
      ) : null}
    </div>
  );
}

function DrawerSection({
  title,
  children
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="drawer-section">
      <div className="drawer-section-title">{title}</div>
      {children}
    </section>
  );
}

function FactoryApprovalCard({
  title,
  status,
  revision,
  summary,
  onApprove,
  onReject,
  onRequestChanges
}: {
  title: string;
  status: "proposed" | "approved" | "rejected" | "changes_requested";
  revision: number;
  summary: string;
  onApprove: () => void;
  onReject: () => void;
  onRequestChanges: () => void;
}) {
  const pending = status !== "approved";
  return (
    <div className="proposal-card">
      <strong>{title}</strong>
      <span>revision {revision} | {status.replaceAll("_", " ")}</span>
      <p>{summary}</p>
      <div className="proposal-actions">
        <button onClick={onApprove} disabled={!pending}>Approve</button>
        <button onClick={onRequestChanges} disabled={!pending}>Request changes</button>
        <button onClick={onReject} disabled={!pending}>Reject</button>
      </div>
    </div>
  );
}


function RecursiveGraphCard({ session }: { session: AgentRuntimeSession }) {
  const graph = session.recursiveFactory?.recursiveGraph;
  const branchExecutions = session.recursiveFactory?.branchExecutions ?? [];
  const finalReport = session.recursiveFactory?.finalReport;
  const integrationSummary = session.recursiveFactory?.integrationSummary;
  if (!graph) return null;
  return (
    <div className="proposal-card">
      <strong>{graph.rootNode.title}</strong>
      <span>{graph.status} | {graph.branches.length} branch(es) | {graph.conflicts.length} conflict(s)</span>
      <p>{graph.rootGoal}</p>
      <p className="muted">
        {session.recursiveFactory?.executionStarted
          ? "Branch execution has started. Runtime branches may only propose patches; Rust remains apply authority."
          : "Execution has not started. This is a planned recursive graph."}
      </p>
      <dl className="session-details">
        <dt>Readiness</dt>
        <dd>{graph.readiness.summary}</dd>
        <dt>Dependencies</dt>
        <dd>{graph.dependencies.length ? graph.dependencies.map((edge) => `${edge.from} -> ${edge.to}`).join(", ") : "none"}</dd>
        <dt>Active branch</dt>
        <dd>{session.recursiveFactory?.activeBranchId ?? "none"}</dd>
      </dl>
      {branchExecutions.length ? (
        <>
          <strong>Branch execution tree</strong>
          {branchExecutions.map((branch) => (
            <div className="proposal-card nested-card" key={`execution-${branch.branchId}`}>
              <strong>{branch.title}</strong>
              <span>{branch.status} | review {branch.reviewStatus} | validation {branch.validationStatus}</span>
              <p>{branch.executionContext.branchObjective}</p>
              <p className="muted">Patch: {branch.proposedPatchId ?? "none"} | Applied by Rust: {branch.patchApplied ? "yes" : "no"}</p>
              <p className="muted">Files: {branch.executionContext.fileScopes.join(", ") || "none"}</p>
              <p className="muted">Locks: {branch.executionContext.lockScopes.join(", ") || "none"}</p>
              {branch.blockedReason ? <p className="muted">Reason: {branch.blockedReason}</p> : null}
              {branch.conflictReason ? <p className="muted">Conflict: {branch.conflictReason}</p> : null}
              {branch.nestedSubtasks?.length ? (
                <div className="nested-card">
                  <strong>Nested subtasks (depth {branch.nestedDepth ?? 1}, max 1)</strong>
                  {branch.nestedSubtasks.map((subtask) => (
                    <div className="proposal-card nested-card" key={subtask.subtaskId}>
                      <strong>{subtask.objective}</strong>
                      <span>{subtask.status} | validation {subtask.validationStatus}</span>
                      <p className="muted">Patch: {subtask.proposedPatchId ?? "none"} | Applied by Rust: {subtask.patchApplied ? "yes" : "no"}</p>
                      <p className="muted">Files: {subtask.fileScopes.join(", ") || "none"} | Dependencies: {subtask.dependencies.join(", ") || "none"}</p>
                      {subtask.blockedReason ? <p className="muted">Reason: {subtask.blockedReason}</p> : null}
                    </div>
                  ))}
                  {branch.nestedRollup ? (
                    <p className="muted">
                      Parent rollup: completed {branch.nestedRollup.completedSubtasks.length}, failed {branch.nestedRollup.failedSubtasks.length}, blocked {branch.nestedRollup.blockedSubtasks.length}, validation {branch.nestedRollup.validationState}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
        </>
      ) : null}
      {finalReport ? (
        <div className="proposal-card nested-card">
          <strong>Final recursive execution status</strong>
          <span>{finalReport.finalStatus} | final validation {finalReport.finalValidationState}</span>
          <p>{finalReport.recommendedNextStep}</p>
          <p className="muted">Applied patches: {finalReport.patchApplyTruth.filter((patch) => patch.status === "applied").map((patch) => patch.patchId).join(", ") || "none"}</p>
          <p className="muted">
            Unverified validation: {finalReport.validationHierarchy.filter((entry) => entry.status === "unverified").map((entry) => `${entry.level}${entry.branchId ? `:${entry.branchId}` : ""}=${entry.truthStatus}`).join(", ") || "none"}
          </p>
          {finalReport.validationDiscovery ? (
            <>
              <p className="muted">
                Discovered validation: {finalReport.validationDiscovery.discoveredCommands.map((command) => `${command.classification}:${command.command}`).join(", ") || "none"}
              </p>
              <p className="muted">
                Chosen strategy: {finalReport.validationDiscovery.chosenStrategy.kind} | {finalReport.validationDiscovery.chosenStrategy.classification} | {finalReport.validationDiscovery.chosenStrategy.reason}
              </p>
              <p className="muted">
                Evidence: {finalReport.validationDiscovery.evidence.map((entry) => [
                  entry.kind,
                  entry.truthStatus,
                  entry.policyResult ? `policy ${entry.policyResult}` : undefined,
                  typeof entry.exitCode === "number" ? `exit ${entry.exitCode}` : undefined,
                  entry.stdoutSummary ? `stdout ${entry.stdoutSummary}` : undefined,
                  entry.stderrSummary ? `stderr ${entry.stderrSummary}` : undefined,
                  entry.files?.length ? `files ${entry.files.join(", ")}` : undefined
                ].filter(Boolean).join(" / ")).join("; ") || "none"}
              </p>
              <p className="muted">Validation reason: {finalReport.validationDiscovery.statusReason}</p>
            </>
          ) : null}
          {finalReport.repair ? (
            <>
              <p className="muted">
                First validation failure: {finalReport.repair.diagnosis.command} | exit {finalReport.repair.diagnosis.exitCode ?? "unknown"} | {finalReport.repair.diagnosis.summary}
              </p>
              <p className="muted">
                Diagnosis: tests {finalReport.repair.diagnosis.failingTests.join("; ") || "none"} | errors {finalReport.repair.diagnosis.errors.slice(0, 3).join("; ") || "none"} | files {finalReport.repair.diagnosis.likelyFiles.join(", ") || "none"}
              </p>
              <p className="muted">
                Attribution: {finalReport.repair.diagnosis.attribution.confidence} | patches {finalReport.repair.diagnosis.attribution.relatedPatchIds.join(", ") || "none"} | branches {finalReport.repair.diagnosis.attribution.relatedBranchIds.join(", ") || "none"} | {finalReport.repair.diagnosis.attribution.reason}
              </p>
              <p className="muted">
                Attribution evidence: {finalReport.repair.diagnosis.attribution.evidence.join("; ") || "none"}
              </p>
              <p className="muted">
                Repair eligibility: {finalReport.repair.eligibility.status} | attempts {finalReport.repair.eligibility.attemptCount}/{finalReport.repair.eligibility.maxAttempts} | {finalReport.repair.eligibility.reasons.join("; ")}
              </p>
              <p className="muted">
                Repair patch: {finalReport.repair.repairPatchId ?? "none"} | status {finalReport.repair.repairPatchStatus ?? finalReport.repair.status}
              </p>
              <p className="muted">
                Validation attempts: {finalReport.repair.validationAttempts.map((attempt) => [
                  `#${attempt.attemptNumber}`,
                  attempt.role,
                  attempt.truthStatus,
                  typeof attempt.exitCode === "number" ? `exit ${attempt.exitCode}` : undefined,
                  attempt.stdoutSummary ? `stdout ${attempt.stdoutSummary}` : undefined,
                  attempt.stderrSummary ? `stderr ${attempt.stderrSummary}` : undefined
                ].filter(Boolean).join(" / ")).join("; ") || "none"}
              </p>
              <p className="muted">Repair outcome: {finalReport.repair.summary}</p>
            </>
          ) : null}
          <p className="muted">Final report: {finalReport.productGoal}</p>
          {finalReport.knownLimitations.length ? <p className="muted">Limitations: {finalReport.knownLimitations.join("; ")}</p> : null}
        </div>
      ) : integrationSummary ? (
        <div className="proposal-card nested-card">
          <strong>Recursive fan-in</strong>
          <span>{integrationSummary.validation.status} | {integrationSummary.validation.truthStatus}</span>
          <p>{integrationSummary.validation.summary}</p>
        </div>
      ) : null}
      {graph.branches.map((branch) => (
        <div className="proposal-card nested-card" key={branch.branchId}>
          <strong>{branch.title}</strong>
          <span>{branch.ownerRole} | {branch.status}</span>
          <p>{branch.objective}</p>
          <p className="muted">Files: {branch.fileScopes.join(", ") || "none"}</p>
          <p className="muted">Locks: {branch.lockScopes.join(", ") || "none"}</p>
        </div>
      ))}
      {graph.conflicts.length ? (
        graph.conflicts.map((conflict) => (
          <p className="muted" key={conflict.id}>{conflict.code}: {conflict.reason}</p>
        ))
      ) : (
        <p className="muted">No branch scope conflicts detected.</p>
      )}
    </div>
  );
}

function SessionTruthStrip({
  session,
  connectionState,
  sseState,
  canReconnect
}: {
  session: AgentRuntimeSession;
  connectionState: "connected" | "disconnected";
  sseState: RuntimeEventSubscriptionState;
  canReconnect: boolean;
}) {
  const provider = session.providerTelemetry;
  const certification = getProviderCertification(provider);
  const reasoning = getReasoningTraceSummary(session);
  const status = sessionStatusTruth(session);
  return (
    <section className={`thread-status-row ${status.kind}`}>
      <div className="thread-status-head">
        <div className={`thread-status-dot ${status.kind}`} />
        <div>
          <strong>{status.label}</strong>
          <span>{describeSseState(sseState, canReconnect)}</span>
        </div>
      </div>
      <div className="thread-status-meta">
        <span>Runtime {connectionState === "connected" ? "connected" : "disconnected"}</span>
        <span>SSE {humanizeRuntimeStatus(sseState.status)}</span>
        <span>Last event {formatOptionalTimestamp(sseState.lastEventAt)}</span>
        <span title={session.workspacePath}>Workspace {pathBasename(session.workspacePath)}</span>
        {sseState.tokenExpired ? <span>token_expired</span> : null}
        {sseState.unauthorized ? <span>unauthorized</span> : null}
        <span>Provider {provider?.activeProviderSource ?? session.activeProviderSource ?? "unknown"}</span>
        <span>Model {certification.authorModel}</span>
        <span>Router {certification.routerModel}</span>
        <span>Certification {certification.status}</span>
        <span>Gates {certification.certifiedGates.join(", ") || "none"}</span>
        <span>Requests {provider?.providerRequestCount ?? 0}</span>
        <span>Reasoning {provider?.reasoningAttempts ?? 0}</span>
        <span>Repairs {provider?.repairAttempts ?? 0}</span>
        <span>Tools {reasoning.toolRounds}</span>
        <span>Evidence {reasoning.evidenceCount}</span>
        <span>Gain {reasoning.informationGain}</span>
        <span>Stagnant {reasoning.stagnantRounds}</span>
        <span>Omitted {reasoning.contextOmissions}</span>
        <span>Verifier {reasoning.verifierVerdict}</span>
        <span>Final {provider?.finalResponseSource ?? "none"}</span>
        {provider?.lastError ? <span>Error {truncateLabel(provider.lastError, 64)}</span> : null}
      </div>
    </section>
  );
}

function ThreadFeed({
  session,
  connectionState,
  sseState,
  canReconnect,
  activeRuntimeCommand,
  agentBusy,
  onOpenActivity,
  onOpenDiff,
  onQuickReply,
  onOpenPreview,
  onRunPendingCommands,
  onOpenFileReference,
  activeWorkspacePath,
  rtlTextMode
}: {
  session: AgentRuntimeSession;
  connectionState: "connected" | "disconnected";
  sseState: RuntimeEventSubscriptionState;
  canReconnect: boolean;
  activeRuntimeCommand: ActiveRuntimeCommand | null;
  agentBusy: boolean;
  onOpenActivity: () => void;
  onOpenDiff: () => void;
  onQuickReply: (message: string) => void | Promise<void>;
  onOpenPreview: () => void;
  onRunPendingCommands: () => void;
  onOpenFileReference: (reference: FileReference) => void | Promise<void>;
  activeWorkspacePath?: string;
  rtlTextMode: boolean;
}) {
  const isExplainOnly = session.runMode === "inspect_only";
  const lastUserMessageIndex = findLastMessageIndex(session.messages, "user");
  const lastAssistantMessageIndex = findLastMessageIndex(session.messages, "assistant");
  const latestAssistantMessageId =
    lastAssistantMessageIndex >= 0 ? session.messages[lastAssistantMessageIndex]?.id ?? "" : "";
  const waitingForAssistant = agentBusy && lastUserMessageIndex > lastAssistantMessageIndex;
  const currentActivityStep = describeCurrentStep(session, connectionState, activeRuntimeCommand);
  const workspaceMismatch = Boolean(
    activeWorkspacePath
    && normalizeWorkspacePath(activeWorkspacePath) !== normalizeWorkspacePath(session.workspacePath)
  );
  const animatedAssistantMessageIdsRef = useRef<Set<string>>(new Set());
  const threadFeedRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const currentIds = new Set(session.messages.map((message) => message.id));
    for (const id of animatedAssistantMessageIdsRef.current) {
      if (!currentIds.has(id)) animatedAssistantMessageIdsRef.current.delete(id);
    }
    for (const message of session.messages) {
      if (message.role !== "assistant") continue;
      const isLatestFreshAssistant =
        message.id === latestAssistantMessageId
        && agentBusy
        && isFreshMessage(message.createdAt);
      if (!isLatestFreshAssistant) {
        animatedAssistantMessageIdsRef.current.add(message.id);
      }
    }
  }, [agentBusy, latestAssistantMessageId, session.id, session.messages]);

  useEffect(() => {
    const feed = threadFeedRef.current;
    if (!feed) return;
    const scrollToLatest = () => {
      feed.scrollTop = feed.scrollHeight;
    };
    scrollToLatest();
    const observer = new MutationObserver(scrollToLatest);
    observer.observe(feed, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [session.id]);

  return (
    <div ref={threadFeedRef} className={`thread-feed ${rtlTextMode ? "rtl-text-mode" : ""}`}>
      <SessionTruthStrip session={session} connectionState={connectionState} sseState={sseState} canReconnect={canReconnect} />
      {workspaceMismatch ? (
        <section className="workspace-mismatch-banner">
          <strong>Different workspace chat</strong>
          <span>
            This chat belongs to {pathBasename(session.workspacePath)}. Active workspace is {pathBasename(activeWorkspacePath ?? "")}.
          </span>
          <small title={session.workspacePath}>{session.workspacePath}</small>
        </section>
      ) : null}
      <RecursiveThoughtChain session={session} onOpenActivity={onOpenActivity} />
      {session.messages.map((message) => {
        const isUserMessage = message.role === "user";
        const shouldAnimateAssistantMessage =
          message.role === "assistant"
          && message.id === latestAssistantMessageId
          && agentBusy
          && isFreshMessage(message.createdAt)
          && !animatedAssistantMessageIdsRef.current.has(message.id);
        return (
          <div key={message.id} className={`thread-entry ${message.role}`}>
            {!isUserMessage ? (
              <div className="thread-entry-header">
                <div className="thread-entry-label">{message.role === "assistant" ? session.agentName : "System"}</div>
              </div>
            ) : null}
            {isUserMessage ? (
              <div className="thread-entry-bubble user-bubble">
                <MessageMarkdown text={message.content} workspacePath={session.workspacePath} onOpenFileReference={onOpenFileReference} />
              </div>
            ) : (
              <AnimatedMessageMarkdown
                text={message.content}
                workspacePath={session.workspacePath}
                onOpenFileReference={onOpenFileReference}
                animate={shouldAnimateAssistantMessage}
                onAnimationComplete={() => {
                  animatedAssistantMessageIdsRef.current.add(message.id);
                }}
              />
            )}
            <div className="thread-entry-footer">
              <span>{formatMessageTime(message.createdAt)}</span>
              <CopyMessageButton text={message.content} />
            </div>
          </div>
        );
      })}

      {waitingForAssistant ? (
        <div className="thread-entry assistant pending-assistant-entry">
          <div className="thread-entry-header">
            <div className="thread-entry-label">{session.agentName}</div>
          </div>
          <LiveRunStatus item={currentActivityStep} onOpenActivity={onOpenActivity} />
        </div>
      ) : null}

      {!isExplainOnly ? (
        <>
          <PrimaryActionCard
            session={session}
            onOpenActivity={onOpenActivity}
            onOpenPreview={onOpenPreview}
            onQuickReply={onQuickReply}
            onRunPendingCommands={onRunPendingCommands}
          />
          <CompactPatchCallout session={session} onOpenDiff={onOpenDiff} />
          <CompactCommandCallout session={session} onOpenActivity={onOpenActivity} />
          <CompactOutcomeCallout session={session} onOpenPreview={onOpenPreview} onOpenFileReference={onOpenFileReference} />
        </>
      ) : null}
      {connectionState === "disconnected" && !isExplainOnly ? (
        <CurrentStepCard session={session} currentStep={describeCurrentStep(session, connectionState, activeRuntimeCommand)} canReconnect={canReconnect} onOpenActivity={onOpenActivity} />
      ) : null}
    </div>
  );
}

function findLastMessageIndex(messages: AgentRuntimeSession["messages"], role: "user" | "assistant") {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === role) return index;
  }
  return -1;
}

function isFreshMessage(createdAt: string) {
  const ageMs = Date.now() - Date.parse(createdAt);
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 5_000;
}

function CopyMessageButton({ text }: { text: string }) {
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Ignore copy failures in passive message actions.
    }
  }

  return (
    <button className="thread-copy-button" onClick={() => void handleCopy()} title="Copy message">
      <Copy size={14} />
    </button>
  );
}

type MarkdownBlock =
  | { type: "code"; language: string; content: string }
  | { type: "text"; lines: string[] };

function AnimatedMessageMarkdown({
  text,
  workspacePath,
  onOpenFileReference,
  animate,
  onAnimationComplete
}: {
  text: string;
  workspacePath: string;
  onOpenFileReference: (reference: FileReference) => void | Promise<void>;
  animate: boolean;
  onAnimationComplete?: () => void;
}) {
  const [displayText, setDisplayText] = useState(animate ? "" : text);

  useEffect(() => {
    if (!animate) {
      setDisplayText(text);
      return;
    }
    if (!text) {
      setDisplayText("");
      return;
    }

    const tokens = tokenizeForReveal(text);
    let cancelled = false;
    let cursor = 0;
    let timer: number | undefined;

    setDisplayText("");

    const step = () => {
      if (cancelled) return;
      cursor = Math.min(tokens.length, cursor + revealBatchSize(cursor, tokens.length));
      setDisplayText(tokens.slice(0, cursor).join(""));
      if (cursor < tokens.length) {
        timer = window.setTimeout(step, cursor < 24 ? 18 : 26);
      }
    };

    step();

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [animate, text]);

  const stillTyping = animate && displayText !== text;

  useEffect(() => {
    if (animate && text && displayText === text) {
      onAnimationComplete?.();
    }
  }, [animate, displayText, text]);

  return (
    <div className={`animated-markdown ${stillTyping ? "is-streaming" : ""}`}>
      {stillTyping ? (
        <div className="thread-entry-body markdown-message streaming-message-body">
          <div className="streaming-message-text">{sanitizeStreamingMarkdownText(displayText)}</div>
        </div>
      ) : (
        <MessageMarkdown text={text} workspacePath={workspacePath} onOpenFileReference={onOpenFileReference} />
      )}
      {stillTyping ? <span className="message-typing-cursor" aria-hidden="true" /> : null}
    </div>
  );
}

function LiveRunStatus({
  item,
  onOpenActivity
}: {
  item: ActivityStreamItem;
  onOpenActivity: () => void;
}) {
  const summary = item.summary || "Starting local run...";
  const displayableSummary = stripProgressRationalePrefix(summary);
  const [displaySummary, setDisplaySummary] = useState(displayableSummary);
  const targetFiles = item.targetFiles?.slice(0, 3) ?? [];
  const extraFileCount = Math.max(0, (item.targetFiles?.length ?? 0) - targetFiles.length);

  useEffect(() => {
    const tokens = tokenizeForReveal(displayableSummary);
    let cancelled = false;
    let cursor = 0;
    let timer: number | undefined;

    setDisplaySummary("");

    const step = () => {
      if (cancelled) return;
      cursor = Math.min(tokens.length, cursor + 1);
      setDisplaySummary(tokens.slice(0, cursor).join(""));
      if (cursor < tokens.length) {
        timer = window.setTimeout(step, cursor < 18 ? 22 : 34);
      }
    };

    step();

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [displayableSummary, item.id]);

  return (
    <div
      className={`live-run-status ${item.status}`}
      aria-label="Show live progress details"
      aria-live="polite"
      onClick={onOpenActivity}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpenActivity();
        }
      }}
      role="button"
      tabIndex={0}
    >
      <div className="live-run-status-top">
        <span className={`live-run-status-dot ${item.status}`} />
        <strong>{item.title || "Starting local run"}</strong>
        {item.stage ? <small>{item.stage}</small> : null}
      </div>
      {item.rationaleLabel ? <div className="live-run-reason-label">{item.rationaleLabel}</div> : null}
      <div className="live-run-status-copy" key={item.id}>
        {displaySummary}
        {displaySummary !== displayableSummary ? <span className="message-typing-cursor" aria-hidden="true" /> : null}
      </div>
      <div className="live-run-status-bottom">
        {item.nextStepTitle ? (
          <span className="live-run-next-step">{item.nextLabel ?? "Next"}: {item.nextStepTitle}</span>
        ) : targetFiles.length ? (
          <div className="live-run-file-row" aria-label="Target files">
            {targetFiles.map((file) => (
              <span key={file}>{file}</span>
            ))}
            {extraFileCount ? <span>+{extraFileCount}</span> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function stripProgressRationalePrefix(text: string) {
  return text.replace(/^(Why this step|ليه الخطوة دي)\s*:\s*/i, "");
}

function tokenizeForReveal(text: string) {
  return text.split(/(\s+)/).filter((token) => token.length > 0);
}

function revealBatchSize(cursor: number, total: number) {
  const remaining = total - cursor;
  if (remaining > 240) return 6;
  if (remaining > 120) return 4;
  return 2;
}

function sanitizeStreamingMarkdownText(text: string) {
  return text.replace(/\*\*([^*\n]+)\*\*/g, "$1");
}

function MessageMarkdown({
  text,
  workspacePath,
  onOpenFileReference
}: {
  text: string;
  workspacePath: string;
  onOpenFileReference: (reference: FileReference) => void | Promise<void>;
}) {
  const blocks = parseMarkdownBlocks(text);
  return (
    <div className="thread-entry-body markdown-message">
      {blocks.map((block, index) =>
        block.type === "code"
          ? (
            <div className="message-code-block" key={`code-${index}`}>
              {block.language ? <div className="message-code-language">{block.language}</div> : null}
              <pre><code>{block.content}</code></pre>
            </div>
          )
          : <MarkdownTextBlock block={block} key={`text-${index}`} workspacePath={workspacePath} onOpenFileReference={onOpenFileReference} />
      )}
    </div>
  );
}

function MarkdownTextBlock({
  block,
  workspacePath,
  onOpenFileReference
}: {
  block: Extract<MarkdownBlock, { type: "text" }>;
  workspacePath: string;
  onOpenFileReference: (reference: FileReference) => void | Promise<void>;
}) {
  const nodes: ReactNode[] = [];
  let index = 0;
  while (index < block.lines.length) {
    const line = block.lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (/^\|.+\|$/.test(line) && block.lines[index + 1]?.includes("---")) {
      const tableLines: string[] = [];
      while (index < block.lines.length && /^\|.+\|$/.test(block.lines[index] ?? "")) {
        tableLines.push(block.lines[index] ?? "");
        index += 1;
      }
      nodes.push(renderMarkdownTable(tableLines, nodes.length, workspacePath, onOpenFileReference));
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = heading[1]!.length;
      const content = renderInlineMarkdown(heading[2]!, workspacePath, onOpenFileReference);
      nodes.push(level <= 2 ? <h3 key={nodes.length}>{content}</h3> : <h4 key={nodes.length}>{content}</h4>);
      index += 1;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < block.lines.length && /^\s*[-*]\s+/.test(block.lines[index] ?? "")) {
        items.push((block.lines[index] ?? "").replace(/^\s*[-*]\s+/, ""));
        index += 1;
      }
      nodes.push(
        <ul key={nodes.length}>
          {items.map((item, itemIndex) => <li key={`${itemIndex}-${item}`}>{renderInlineMarkdown(item, workspacePath, onOpenFileReference)}</li>)}
        </ul>
      );
      continue;
    }
    const paragraph: string[] = [];
    while (
      index < block.lines.length &&
      block.lines[index]?.trim() &&
      !/^(#{1,4})\s+/.test(block.lines[index] ?? "") &&
      !/^\s*[-*]\s+/.test(block.lines[index] ?? "") &&
      !(/^\|.+\|$/.test(block.lines[index] ?? "") && block.lines[index + 1]?.includes("---"))
    ) {
      paragraph.push(block.lines[index] ?? "");
      index += 1;
    }
    nodes.push(<p key={nodes.length}>{renderInlineMarkdown(paragraph.join(" "), workspacePath, onOpenFileReference)}</p>);
  }
  return <>{nodes}</>;
}

function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: MarkdownBlock[] = [];
  let textLines: string[] = [];
  let codeLanguage = "";
  let codeLines: string[] | null = null;
  const flushText = () => {
    if (textLines.length) {
      blocks.push({ type: "text", lines: textLines });
      textLines = [];
    }
  };
  for (const line of lines) {
    const fence = line.match(/^```(\w+)?\s*$/);
    if (fence) {
      if (codeLines) {
        blocks.push({ type: "code", language: codeLanguage, content: codeLines.join("\n") });
        codeLines = null;
        codeLanguage = "";
      } else {
        flushText();
        codeLanguage = fence[1] ?? "";
        codeLines = [];
      }
      continue;
    }
    if (codeLines) {
      codeLines.push(line);
    } else {
      textLines.push(line);
    }
  }
  if (codeLines) blocks.push({ type: "code", language: codeLanguage, content: codeLines.join("\n") });
  flushText();
  return blocks;
}

function renderInlineMarkdown(
  text: string,
  workspacePath: string,
  onOpenFileReference: (reference: FileReference) => void | Promise<void>
): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\[((?:[A-Za-z]:)?[^:[\]\n]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?\]|\*\*([^*\n]+)\*\*|((?:(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+|[A-Za-z0-9_.-]+\.(?:tsx?|jsx?|mjs|cjs|json|md|css|scss|html|py|rs|go|java|cs|cpp|c|h|sql|yaml|yml|toml|sh|ps1)))(?::(\d+)(?:-(\d+))?)?)/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined) continue;
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    if (match[4]) {
      const inlineFileRef = parseWorkspaceFileHref(match[4], workspacePath);
      nodes.push(
        inlineFileRef
          ? (
            <code key={`code-file-ref-${match.index}`}>
              <MarkdownLink
                href={`hivo-file:${encodeURIComponent(inlineFileRef.path)}:${inlineFileRef.line}${inlineFileRef.lineEnd ? `-${inlineFileRef.lineEnd}` : ""}`}
                label={match[4]}
                workspacePath={workspacePath}
                onOpenFileReference={onOpenFileReference}
              />
            </code>
          )
          : <code key={`code-${match.index}`}>{match[4]}</code>
      );
    } else if (match[5] && match[6]) {
      const reference = {
        path: match[5].trim(),
        line: Number.parseInt(match[6], 10),
        lineEnd: match[7] ? Number.parseInt(match[7], 10) : undefined
      };
      nodes.push(
        <MarkdownLink
          href={`hivo-file:${encodeURIComponent(reference.path)}:${reference.line}${reference.lineEnd ? `-${reference.lineEnd}` : ""}`}
          label={`${reference.path}:${reference.line}${reference.lineEnd ? `-${reference.lineEnd}` : ""}`}
          workspacePath={workspacePath}
          onOpenFileReference={onOpenFileReference}
          key={`file-ref-${match.index}`}
        />
      );
    } else if (match[8]) {
      nodes.push(<strong key={`strong-${match.index}`}>{match[8]}</strong>);
    } else if (match[9]) {
      const reference = {
        path: match[9].replaceAll("\\", "/"),
        line: match[10] ? Number.parseInt(match[10], 10) : 1,
        lineEnd: match[11] ? Number.parseInt(match[11], 10) : undefined
      };
      nodes.push(
        <MarkdownLink
          href={`hivo-file:${encodeURIComponent(reference.path)}:${reference.line}${reference.lineEnd ? `-${reference.lineEnd}` : ""}`}
          label={`${reference.path}${match[10] ? `:${reference.line}${reference.lineEnd ? `-${reference.lineEnd}` : ""}` : ""}`}
          workspacePath={workspacePath}
          onOpenFileReference={onOpenFileReference}
          key={`plain-file-ref-${match.index}`}
        />
      );
    } else {
      const label = match[2] ?? "";
      const href = match[3] ?? "";
      nodes.push(<MarkdownLink href={href} label={label} workspacePath={workspacePath} onOpenFileReference={onOpenFileReference} key={`link-${match.index}`} />);
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function MarkdownLink({
  href,
  label,
  workspacePath,
  onOpenFileReference
}: {
  href: string;
  label: string;
  workspacePath: string;
  onOpenFileReference: (reference: FileReference) => void | Promise<void>;
}) {
  const fileRef = parseFileRef(href) ?? parseWorkspaceFileHref(href, workspacePath);
  async function handleClick(event: MouseEvent) {
    event.preventDefault();
    try {
      if (fileRef) {
        await onOpenFileReference(fileRef);
      } else {
        await openExternalTarget(href);
      }
    } catch {
      if (fileRef) {
        await navigator.clipboard.writeText(`${fileRef.path}:${fileRef.line}`);
      }
    }
  }
  return (
    <a href={href} onClick={(event) => void handleClick(event)} className={fileRef ? "message-file-ref" : undefined}>
      {label}
    </a>
  );
}

function renderMarkdownTable(
  lines: string[],
  key: number,
  workspacePath: string,
  onOpenFileReference: (reference: FileReference) => void | Promise<void>
) {
  const rows = lines
    .filter((line) => !/^\|\s*-+/.test(line))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
  const [header, ...body] = rows;
  return (
    <div className="message-table-wrap" key={`table-${key}`}>
      <table>
        {header ? <thead><tr>{header.map((cell) => <th key={cell}>{renderInlineMarkdown(cell, workspacePath, onOpenFileReference)}</th>)}</tr></thead> : null}
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={`${rowIndex}-${row.join("|")}`}>
              {row.map((cell, cellIndex) => <td key={`${cellIndex}-${cell}`}>{renderInlineMarkdown(cell, workspacePath, onOpenFileReference)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function parseFileRef(href: string) {
  const scheme = href.startsWith("hivo-file:")
    ? "hivo-file:"
    : href.startsWith("orchcode-file:")
      ? "orchcode-file:"
      : "";
  if (!scheme) return null;
  const rest = href.slice(scheme.length);
  const separator = rest.lastIndexOf(":");
  if (separator <= 0) return null;
  const pathPart = rest.slice(0, separator);
  const linePart = rest.slice(separator + 1);
  const [lineValue, lineEndValue] = linePart.split("-");
  const line = Number.parseInt(lineValue ?? "", 10);
  const lineEnd = lineEndValue ? Number.parseInt(lineEndValue, 10) : undefined;
  if (!Number.isFinite(line)) return null;
  return { path: decodeURIComponent(pathPart), line, lineEnd: Number.isFinite(lineEnd) ? lineEnd : undefined };
}

function parseWorkspaceFileHref(href: string, workspacePath: string): FileReference | null {
  if (/^(?:https?|mailto|tel):/i.test(href)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(href);
  } catch {
    decoded = href;
  }
  const match = decoded.trim().match(/^(.+?)(?::(\d+)(?:-(\d+))?|#L(\d+)(?:-L?(\d+))?)?$/);
  if (!match) return null;
  let path = (match[1] ?? "").replaceAll("\\", "/").replace(/^\.\//, "");
  const normalizedWorkspace = normalizeWorkspacePath(workspacePath).replaceAll("\\", "/").replace(/\/+$/, "");
  if (path.toLowerCase().startsWith(`${normalizedWorkspace.toLowerCase()}/`)) {
    path = path.slice(normalizedWorkspace.length + 1);
  }
  if (!isSafeRelativeFilePath(path) || !looksLikeFilePath(path)) return null;
  const line = Number.parseInt(match[2] ?? match[4] ?? "1", 10);
  const lineEndValue = match[3] ?? match[5];
  const lineEnd = lineEndValue ? Number.parseInt(lineEndValue, 10) : undefined;
  return { path, line, lineEnd };
}

function looksLikeFilePath(targetPath: string) {
  return /(?:^|\/)[A-Za-z0-9_.-]+\.[A-Za-z0-9]+$/.test(targetPath);
}

function FileReferencePanel({
  reference,
  workspacePath,
  onClose
}: {
  reference: ActiveFileReference;
  workspacePath: string;
  onClose: () => void;
}) {
  const lineRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const lines = reference.content.split(/\r?\n/);
  const lineEnd = reference.lineEnd ?? reference.line;
  useEffect(() => {
    const target = lineRefs.current.get(reference.line);
    target?.scrollIntoView({ block: "center" });
  }, [reference.path, reference.line, reference.status]);

  async function handleOpenInVsCode() {
    if (!workspacePath) return;
    const workspaceRoot = workspacePath.replaceAll("\\", "/").replace(/\/$/, "");
    const absolutePath = `${workspaceRoot}/${reference.path}`;
    try {
      await openExternalTarget(`vscode://file/${encodeURI(absolutePath)}:${reference.line}`);
    } catch {
      await navigator.clipboard.writeText(`${reference.path}:${reference.line}`);
    }
  }

  return (
    <aside className="file-reference-panel">
      <div className="file-reference-backdrop" onClick={onClose} />
      <section className="file-reference-drawer">
        <div className="drawer-header">
          <div>
            <strong>{reference.path}</strong>
            <span>
              {reference.status === "ready"
                ? `Line ${reference.line}${reference.lineEnd ? `-${reference.lineEnd}` : ""}`
                : reference.status === "loading"
                  ? "Loading file preview..."
                  : "Preview failed"}
            </span>
          </div>
          <div className="file-reference-actions">
            <button
              className="vscode-open-button"
              onClick={() => void handleOpenInVsCode()}
              title="Open this file in Visual Studio Code"
              type="button"
            >
              <Code2 size={15} />
              <span>VS Code</span>
            </button>
            <button className="frame-icon-button" onClick={onClose} title="Close file preview">
              <X size={16} />
            </button>
          </div>
        </div>

        {reference.status === "failed" ? (
          <div className="file-reference-error">{reference.error ?? "Could not open this file reference."}</div>
        ) : reference.status === "loading" ? (
          <div className="file-reference-loading">Opening file inside Hivo...</div>
        ) : (
          <div className="file-reference-code" role="region" aria-label={`${reference.path} preview`}>
            {lines.map((line, index) => {
              const lineNumber = index + 1;
              const highlighted = lineNumber >= reference.line && lineNumber <= lineEnd;
              return (
                <div
                  key={`${reference.path}-${lineNumber}`}
                  ref={(node) => {
                    if (node) lineRefs.current.set(lineNumber, node);
                    else lineRefs.current.delete(lineNumber);
                  }}
                  className={`file-reference-line ${highlighted ? "highlighted" : ""}`}
                >
                  <span className="file-reference-line-number">{lineNumber}</span>
                  <code>{line || " "}</code>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </aside>
  );
}

function FileExplorerPanel({
  project,
  filter,
  onFilterChange,
  tree,
  expandedDirs,
  onToggleDir,
  onOpenFile,
  onClose
}: {
  project: FileExplorerProject;
  filter: string;
  onFilterChange: (value: string) => void;
  tree: FileTreeNode[];
  expandedDirs: string[];
  onToggleDir: (targetPath: string) => void;
  onOpenFile: (targetPath: string) => void;
  onClose: () => void;
}) {
  return (
    <aside className="file-reference-panel">
      <div className="file-reference-backdrop" onClick={onClose} />
      <section className="file-reference-drawer file-explorer-drawer">
        <div className="drawer-header">
          <div>
            <strong>{project.name}</strong>
            <span>{project.path}</span>
          </div>
          <div className="file-reference-actions">
            <button className="frame-icon-button" onClick={onClose} title="Close file explorer" type="button">
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="file-explorer-toolbar">
          <input
            value={filter}
            onChange={(event) => onFilterChange(event.target.value)}
            placeholder="Filter files..."
          />
        </div>

        <div className="file-explorer-tree" role="tree" aria-label={`${project.name} files`}>
          {tree.length ? (
            tree.map((node) => (
              <FileTreeNodeRow
                key={node.key}
                node={node}
                depth={0}
                expandedDirs={expandedDirs}
                onToggleDir={onToggleDir}
                onOpenFile={onOpenFile}
              />
            ))
          ) : (
            <div className="file-reference-loading">No files match this filter.</div>
          )}
        </div>
      </section>
    </aside>
  );
}

function FileTreeNodeRow({
  node,
  depth,
  expandedDirs,
  onToggleDir,
  onOpenFile
}: {
  node: FileTreeNode;
  depth: number;
  expandedDirs: string[];
  onToggleDir: (targetPath: string) => void;
  onOpenFile: (targetPath: string) => void;
}) {
  const expanded = node.isDir && expandedDirs.includes(node.path);
  return (
    <div className="file-tree-node">
      <button
        className={`file-tree-row ${node.isDir ? "is-directory" : "is-file"}`}
        style={{ paddingLeft: `${12 + depth * 18}px` }}
        onClick={() => (node.isDir ? onToggleDir(node.path) : onOpenFile(node.path))}
        title={node.path}
        type="button"
      >
        {node.isDir ? (expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : <span className="file-tree-spacer" />}
        {node.isDir ? <FolderOpen size={14} /> : <FileText size={14} />}
        <span>{node.name}</span>
      </button>
      {node.isDir && expanded
        ? node.children.map((child) => (
          <FileTreeNodeRow
            key={child.key}
            node={child}
            depth={depth + 1}
            expandedDirs={expandedDirs}
            onToggleDir={onToggleDir}
            onOpenFile={onOpenFile}
          />
        ))
        : null}
    </div>
  );
}

function CurrentStepCard({
  session,
  currentStep,
  canReconnect,
  onOpenActivity
}: {
  session: AgentRuntimeSession;
  currentStep: ActivityStreamItem;
  canReconnect: boolean;
  onOpenActivity: () => void;
}) {
  return (
    <section className={`thread-status-row ${currentStep.status}`}>
      <div className="thread-status-head">
        <div className={`thread-status-dot ${currentStep.status}`} />
        <div>
          <strong>{currentStep.title}</strong>
          <span>{currentStep.summary}</span>
        </div>
      </div>
      <div className="thread-status-meta">
        <span>{humanizeRuntimeStatus(session.status)}</span>
        <span>{humanizeLifecycleStage(session.lifecycleStage)}</span>
        <span>{humanizeRunMode(session.runMode)}</span>
        <span>{describeVerificationState(session)}</span>
      </div>
      <div className="command-actions">
        <button onClick={onOpenActivity}>{canReconnect ? "Open details" : "Show details"}</button>
      </div>
    </section>
  );
}

function PrimaryActionCard({
  session,
  onOpenActivity,
  onOpenPreview,
  onQuickReply,
  onRunPendingCommands
}: {
  session: AgentRuntimeSession;
  onOpenActivity: () => void;
  onOpenPreview: () => void;
  onQuickReply: (message: string) => void | Promise<void>;
  onRunPendingCommands: () => void;
}) {
  if (session.nextAction?.kind === "clarify_plan") {
    return (
      <PlanClarificationCard
        message={session.nextAction.message}
        options={session.nextAction.options}
        allowCustom={session.nextAction.allowCustom}
        onQuickReply={onQuickReply}
      />
    );
  }

  if (session.nextAction?.kind === "confirm_plan") {
    return (
      <ActionCard
        title="Plan mode ready"
        message={session.nextAction.message}
        actions={
          <>
            <button onClick={() => void onQuickReply("Proceed with implementation.")}>Implement plan</button>
            <button onClick={() => void onQuickReply("Hold the plan for now.")}>Dismiss</button>
            <button onClick={onOpenActivity}>Review plan</button>
          </>
        }
      />
    );
  }

  if (session.nextAction?.kind === "confirm_preview") {
    return (
      <ActionCard
        title="Preview launch still pending"
        message={`${session.nextAction.message} Nothing has been launched yet.`}
        actions={
          <>
            <button onClick={() => void onQuickReply("Run it now.")}>Run it now</button>
            <button onClick={() => void onQuickReply("Show me the results first.")}>Show results</button>
            <button onClick={onOpenActivity}>Details</button>
          </>
        }
      />
    );
  }

  if (session.nextAction?.kind === "preview_ready") {
    return (
      <ActionCard
        title="Preview available"
        message={`${session.nextAction.message} Opening it remains an explicit operator action.`}
        actions={
          <>
            <button onClick={onOpenPreview}>
              <Globe size={14} />
              Open preview
            </button>
            <button onClick={onOpenActivity}>Details</button>
          </>
        }
      />
    );
  }

  if (session.nextAction?.kind === "approve_commands") {
    return (
      <ActionCard
        title="Run command"
        message={`${session.nextAction.message} Command output will stream back into the run state after Rust execution.`}
        actions={
          <>
            <button onClick={onRunPendingCommands}>
              <Play size={14} />
              Run in Rust
            </button>
            <button onClick={onOpenActivity}>Details</button>
          </>
        }
      />
    );
  }

  if (session.nextAction?.kind === "await_baseline_command") {
    return (
      <ActionCard
        title="Baseline test command"
        message={session.nextAction.message}
        actions={
          <>
            <button onClick={onRunPendingCommands}>
              <Play size={14} />
              Run in Rust
            </button>
            <button onClick={onOpenActivity}>Details</button>
          </>
        }
      />
    );
  }

  return null;
}

function PlanClarificationCard({
  message,
  options,
  allowCustom,
  onQuickReply
}: {
  message: string;
  options: Array<{ id: string; label: string; prompt: string }>;
  allowCustom?: boolean;
  onQuickReply: (message: string) => void | Promise<void>;
}) {
  const [customValue, setCustomValue] = useState("");
  return (
    <ActionCard
      title="Plan mode question"
      message={message}
      actions={
        <div className="plan-clarification-actions">
          {options.map((option) => (
            <button key={option.id} onClick={() => void onQuickReply(option.prompt)}>
              {option.label}
            </button>
          ))}
          {allowCustom ? (
            <div className="plan-clarification-custom">
              <input
                value={customValue}
                onChange={(event) => setCustomValue(event.target.value)}
                placeholder="Write your own direction..."
              />
              <button
                onClick={() => {
                  if (!customValue.trim()) return;
                  void onQuickReply(customValue.trim());
                  setCustomValue("");
                }}
              >
                Send
              </button>
            </div>
          ) : null}
        </div>
      }
    />
  );
}

type ThoughtChainStatus = AgentRuntimeSwarmNode["status"];

type ThoughtChainRow = {
  id: string;
  title: string;
  subtitle: string;
  summary: string;
  prompt?: string;
  status: ThoughtChainStatus;
  thoughtCount: number;
  fileNames: string[];
  commandCount: number;
  children: ThoughtChainRow[];
};

function RecursiveThoughtChain({
  session,
  onOpenActivity
}: {
  session: AgentRuntimeSession;
  onOpenActivity: () => void;
}) {
  const activityProjection = getRunActivityProjection(session);
  const rows = useMemo(() => buildThoughtChainRows(session), [
    session.commandExecutions,
    session.commandRequests,
    session.id,
    session.progressEvents,
    session.recursiveSwarmRunState,
    session.status,
    session.swarmState
  ]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  if (!rows.length) return null;

  const active = Boolean(activityProjection?.ephemeralStatus)
    || session.status === "running"
    || hasActiveThoughtRows(rows);
  const visibleRows = flattenThoughtRows(rows, expandedIds).slice(0, 14);
  const hiddenCount = Math.max(0, countThoughtRows(rows, 96) - visibleRows.length);
  const liveLabel = activityProjection?.ephemeralStatus?.text ?? (active ? "Thinking..." : "Chain settled.");

  function toggleRow(rowId: string) {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  }

  return (
    <section className="thought-chain-panel" aria-label="Recursive thought and action chain">
      <div className="thought-chain-header">
        <div>
          <strong>Thought chain</strong>
          <span>Recursive parent agents add child tasks, prompts, and actions as they run.</span>
        </div>
        <button className="activity-link" onClick={onOpenActivity} type="button">Details</button>
      </div>
      <div className="thought-chain-list">
        {visibleRows.map(({ row, depth }) => {
          const expanded = expandedIds.has(row.id);
          const hasChildren = row.children.length > 0;
          return (
            <div
              key={row.id}
              className={`thought-chain-node ${row.status}`}
              style={{ "--thought-depth": depth } as CSSProperties}
            >
              <button
                className="thought-chain-row"
                onClick={() => hasChildren ? toggleRow(row.id) : undefined}
                type="button"
                aria-expanded={hasChildren ? expanded : undefined}
              >
                {hasChildren ? (
                  expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />
                ) : (
                  <span className="thought-chain-spacer" />
                )}
                <span className={`thought-chain-status ${row.status}`} />
                <span className="thought-chain-copy">
                  <strong>{formatThoughtMetricLabel(row)}</strong>
                  <small>{row.subtitle}</small>
                </span>
              </button>
              {expanded ? (
                <div className="thought-chain-detail">
                  <p>{row.summary}</p>
                  {row.prompt ? <pre>{truncateThoughtText(row.prompt, 900)}</pre> : null}
                  <div className="thought-chain-tags">
                    {row.fileNames.slice(0, 4).map((file) => <span key={file}>{file}</span>)}
                    {row.fileNames.length > 4 ? <span>+{row.fileNames.length - 4} file(s)</span> : null}
                    {row.children.length ? <span>{row.children.length} child node(s)</span> : null}
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
        {hiddenCount ? <div className="thought-chain-more">+{hiddenCount} more node(s) in the tree</div> : null}
        <div className={`thought-chain-live-row ${active ? "running" : "completed"}`}>
          <span><Bot size={14} /></span>
          <small>{liveLabel}</small>
        </div>
      </div>
    </section>
  );
}

function buildThoughtChainRows(session: AgentRuntimeSession): ThoughtChainRow[] {
  const activityProjection = getRunActivityProjection(session);
  if (activityProjection?.durableRows.length) {
    return activityProjection.durableRows.slice(-12).map((row) => ({
      id: `activity:${row.id}`,
      title: row.title,
      subtitle: row.kind.replaceAll("_", " "),
      summary: row.summary,
      status: mapActivityStatusToThoughtStatus(row.status),
      thoughtCount: row.kind === "thought" || row.kind === "split" ? 1 : 0,
      fileNames: [],
      commandCount: row.kind === "command" ? 1 : 0,
      children: []
    }));
  }
  const recursiveTree = session.recursiveSwarmRunState?.tree;
  if (recursiveTree?.nodes?.length) {
    if (recursiveTree.nodes.length > 80) {
      return buildCompactThoughtRowsFromNodes(session, recursiveTree.nodes);
    }
    const byParent = new Map<string, AgentRuntimeSwarmNode[]>();
    const byId = new Map(recursiveTree.nodes.map((node) => [node.id, node]));
    for (const node of recursiveTree.nodes) {
      if (!node.parentId) continue;
      const children = byParent.get(node.parentId) ?? [];
      children.push(node);
      byParent.set(node.parentId, children);
    }
    for (const children of byParent.values()) {
      children.sort(compareThoughtNodes);
    }
    const root = byId.get(recursiveTree.rootId) ?? recursiveTree.nodes[0];
    if (root) {
      return [buildThoughtRowFromNode(session, root, byParent, new Set(), true)];
    }
  }
  const swarm = session.swarmState;
  if (swarm?.nodes.length) {
    if (swarm.nodes.length > 80) {
      return buildCompactThoughtRowsFromNodes(session, swarm.nodes);
    }
    const byParent = new Map<string, AgentRuntimeSwarmNode[]>();
    const byId = new Map(swarm.nodes.map((node) => [node.id, node]));
    for (const node of swarm.nodes) {
      if (!node.parentId) continue;
      const children = byParent.get(node.parentId) ?? [];
      children.push(node);
      byParent.set(node.parentId, children);
    }
    for (const children of byParent.values()) {
      children.sort(compareThoughtNodes);
    }
    const root = byId.get(swarm.rootId) ?? swarm.nodes[0];
    if (root) {
      return [buildThoughtRowFromNode(session, root, byParent, new Set(), true)];
    }
  }
  return session.progressEvents.slice(-8).map((event) => ({
    id: `progress:${event.id}`,
    title: event.taskTitle ?? event.stage.replaceAll("_", " "),
    subtitle: event.agentName ? `${event.agentName} | ${event.stage}` : event.stage.replaceAll("_", " "),
    summary: event.summary,
    status: mapProgressStatusToThoughtStatus(event.status),
    thoughtCount: 1,
    fileNames: event.targetFiles,
    commandCount: /command/i.test(`${event.taskTitle ?? ""} ${event.summary}`) ? 1 : 0,
    children: []
  }));
}

function buildThoughtRowFromNode(
  session: AgentRuntimeSession,
  node: AgentRuntimeSwarmNode,
  byParent: Map<string, AgentRuntimeSwarmNode[]>,
  seen: Set<string>,
  root = false
): ThoughtChainRow {
  if (seen.has(node.id)) {
    return {
      id: node.id,
      title: node.name,
      subtitle: `${node.name} | ${node.role}`,
      summary: "Cycle detected while projecting the recursive chain.",
      status: "blocked",
      thoughtCount: 1,
      fileNames: [],
      commandCount: 0,
      children: []
    };
  }
  const nextSeen = new Set(seen);
  nextSeen.add(node.id);
  const childNodes = byParent.get(node.id) ?? [];
  const children = childNodes.map((child) => buildThoughtRowFromNode(session, child, byParent, nextSeen));
  const descendantRows = collectThoughtDescendants(children);
  const fileNames = uniqueThoughtValues([
    ...node.targetFiles,
    ...node.changedFiles,
    ...node.ownedPaths,
    ...descendantRows.flatMap((row) => row.fileNames)
  ]);
  const directThoughtCount = isThoughtAgentNode(node) ? 1 : 0;
  const thoughtCount = Math.max(1, directThoughtCount + descendantRows.filter((row) => row.thoughtCount > 0).length);
  const commandCount = root ? session.commandRequests.length + session.commandExecutions.length : commandCountForNode(session, node);
  return {
    id: node.id,
    title: node.name,
    subtitle: `${node.name} | ${node.role} | ${humanizeSwarmNodeStatus(node.status)}`,
    summary: node.currentAction ?? node.summary ?? node.objective,
    prompt: node.taskPrompt ?? node.prompt,
    status: node.status,
    thoughtCount,
    fileNames,
    commandCount,
    children
  };
}

function flattenThoughtRows(rows: ThoughtChainRow[], expandedIds: Set<string>, depth = 0): Array<{ row: ThoughtChainRow; depth: number }> {
  const result: Array<{ row: ThoughtChainRow; depth: number }> = [];
  for (const row of rows) {
    result.push({ row, depth });
    if (expandedIds.has(row.id)) {
      result.push(...flattenThoughtRows(row.children, expandedIds, depth + 1));
    }
  }
  return result;
}

function collectThoughtDescendants(rows: ThoughtChainRow[]): ThoughtChainRow[] {
  return rows.flatMap((row) => [row, ...collectThoughtDescendants(row.children)]);
}

function countThoughtRows(rows: ThoughtChainRow[], cap = Number.POSITIVE_INFINITY): number {
  let count = 0;
  const stack = [...rows];
  while (stack.length && count < cap) {
    const row = stack.pop()!;
    count += 1;
    stack.push(...row.children);
  }
  return count;
}

function formatThoughtMetricLabel(row: ThoughtChainRow) {
  const parts = [`Thought ${Math.max(1, row.thoughtCount)} time(s)`];
  if (row.fileNames.length) parts.push(`Viewed ${row.fileNames.length} file(s)`);
  if (row.commandCount) parts.push(`Ran ${row.commandCount} command(s)`);
  return parts.join(", ");
}

function compareThoughtNodes(left: AgentRuntimeSwarmNode, right: AgentRuntimeSwarmNode) {
  return thoughtStatusRank(left.status) - thoughtStatusRank(right.status)
    || thoughtKindRank(left.kind) - thoughtKindRank(right.kind)
    || left.name.localeCompare(right.name)
    || left.id.localeCompare(right.id);
}

function thoughtStatusRank(status: ThoughtChainStatus) {
  if (status === "running") return 0;
  if (status === "queued") return 1;
  if (status === "blocked" || status === "failed") return 2;
  if (status === "idle") return 3;
  return 4;
}

function thoughtKindRank(kind: AgentRuntimeSwarmNode["kind"]) {
  if (kind === "root") return 0;
  if (kind === "group") return 1;
  if (kind === "coordinator" || kind === "splitter") return 2;
  if (kind === "worker" || kind === "specialist" || kind === "executor" || kind === "task_agent") return 3;
  if (kind === "collector" || kind === "aggregator") return 4;
  if (kind === "gate" || kind === "goal_keeper") return 5;
  return 6;
}

function isThoughtAgentNode(node: AgentRuntimeSwarmNode) {
  return node.kind !== "group" && node.kind !== "work_item" && node.kind !== "gate";
}

function commandCountForNode(session: AgentRuntimeSession, node: AgentRuntimeSwarmNode) {
  const needles = [node.id, node.name, node.role, ...node.workItemRefs].filter(Boolean).map((value) => value.toLowerCase());
  if (!needles.length) return 0;
  const records = [...session.commandRequests, ...session.commandExecutions];
  return records.filter((record) => {
    const haystack = [
      "command" in record ? String(record.command) : "",
      "reason" in record ? String(record.reason) : "",
      "message" in record ? String(record.message ?? "") : ""
    ].join(" ").toLowerCase();
    return needles.some((needle) => haystack.includes(needle));
  }).length;
}

function mapProgressStatusToThoughtStatus(status: AgentRuntimeSession["progressEvents"][number]["status"]): ThoughtChainStatus {
  if (status === "completed") return "completed";
  if (status === "blocked") return "blocked";
  if (status === "failed") return "failed";
  if (status === "queued") return "queued";
  return "running";
}

function mapActivityStatusToThoughtStatus(status: NonNullable<NonNullable<AgentRuntimeSession["swarmState"]>["activityProjection"]>["durableRows"][number]["status"]): ThoughtChainStatus {
  if (status === "completed") return "completed";
  if (status === "blocked") return "blocked";
  if (status === "failed") return "failed";
  if (status === "queued") return "queued";
  return "running";
}

function getRunActivityProjection(session: AgentRuntimeSession) {
  return session.swarmState?.activityProjection ?? session.recursiveSwarmRunState?.activityProjection;
}

function hasActiveThoughtRows(rows: ThoughtChainRow[]) {
  const stack = [...rows];
  let visited = 0;
  while (stack.length && visited < 80) {
    const row = stack.pop()!;
    visited += 1;
    if (row.status === "queued" || row.status === "running" || row.status === "idle") return true;
    stack.push(...row.children);
  }
  return false;
}

function buildCompactThoughtRowsFromNodes(session: AgentRuntimeSession, nodes: AgentRuntimeSwarmNode[]): ThoughtChainRow[] {
  const ranked = [...nodes]
    .sort(compareThoughtNodes)
    .slice(0, 12);
  const totalFiles = uniqueThoughtValues(nodes.flatMap((node) => [...node.targetFiles, ...node.changedFiles, ...node.ownedPaths]));
  return ranked.map((node, index) => ({
    id: `compact:${node.id}`,
    title: node.name,
    subtitle: `${node.name} | ${node.role} | ${humanizeSwarmNodeStatus(node.status)}`,
    summary: node.currentAction ?? node.summary ?? node.objective,
    prompt: node.taskPrompt ?? node.prompt,
    status: node.status,
    thoughtCount: index === 0 ? Math.max(1, nodes.filter(isThoughtAgentNode).length) : 1,
    fileNames: index === 0 ? totalFiles : uniqueThoughtValues([...node.targetFiles, ...node.changedFiles, ...node.ownedPaths]),
    commandCount: index === 0 ? session.commandRequests.length + session.commandExecutions.length : commandCountForNode(session, node),
    children: []
  }));
}

function humanizeSwarmNodeStatus(status: ThoughtChainStatus) {
  if (status === "completed") return "Done";
  return status.replaceAll("_", " ");
}

function truncateThoughtText(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max - 3).trimEnd()}...` : value;
}

function uniqueThoughtValues(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function InlineAgentOverview({
  agents,
  onOpenActivity
}: {
  agents: AgentSidePanelAgentView[];
  onOpenActivity: () => void;
}) {
  const visibleAgents = agents.slice(0, 4);
  const extraCount = Math.max(0, agents.length - visibleAgents.length);
  return (
    <section className="inline-agent-overview">
      <div className="inline-agent-overview-header">
        <strong>Working team</strong>
        <button className="activity-link" onClick={onOpenActivity}>Open side panel</button>
      </div>
      <div className="inline-agent-chip-row">
        {visibleAgents.map((agent) => (
          <div key={agent.id} className={`inline-agent-chip ${agent.status}`}>
            <div className="inline-agent-chip-top">
              <strong>{agent.name}</strong>
              <span>{humanizeAgentStatus(agent.status)}</span>
            </div>
            <small>{agent.currentAction}</small>
          </div>
        ))}
        {extraCount > 0 ? <div className="inline-agent-chip more">+{extraCount} more</div> : null}
      </div>
    </section>
  );
}

function InlineActivityFeed({ items }: { items: ActivityStreamItem[] }) {
  if (!items.length) return null;
  return (
    <section className="inline-activity-feed">
      {items.map((item) => (
        <div key={item.id} className={`inline-activity-row ${item.status}`}>
          <div className={`inline-activity-dot ${item.status}`} />
          <div>
            <strong>{item.title}</strong>
            <span>{item.summary}</span>
          </div>
        </div>
      ))}
    </section>
  );
}

function CompactPatchCallout({
  session,
  onOpenDiff
}: {
  session: AgentRuntimeSession;
  onOpenDiff: () => void;
}) {
  const proposal = session.patchProposals.at(-1);
  if (!proposal) return null;
  return (
    <section className="compact-review-bar">
      <div>
        <strong>{proposal.filesChanged.length} file {proposal.status === "applied" ? "changed" : "proposed"}</strong>
        <span>{formatPatchTotalsLabel(proposal.filesChanged.length)} | {humanizePatchStatus(proposal.status)}</span>
      </div>
      <button onClick={onOpenDiff}>Review changes</button>
    </section>
  );
}

function CompactCommandCallout({
  session,
  onOpenActivity
}: {
  session: AgentRuntimeSession;
  onOpenActivity: () => void;
}) {
  const latestExecution = session.commandExecutions.at(-1);
  const pendingRequest = !latestExecution ? session.commandRequests.at(-1) : null;
  if (!latestExecution && !pendingRequest) return null;

  if (latestExecution) {
    return (
      <section className={`thread-callout ${latestExecution.status === "failed" ? "failed" : "completed"}`}>
        <div className="thread-callout-header">
          <strong>{latestExecution.command}</strong>
          <span>{humanizeCommandResultStatus(latestExecution.status)}{typeof latestExecution.exitCode === "number" ? ` | exit ${latestExecution.exitCode}` : ""}</span>
        </div>
        <p>{latestExecution.diagnosis?.summary ?? latestExecution.message ?? describeCommandExecutionProvenance(latestExecution)}</p>
        {latestExecution.diagnosis?.nextStep ? <small>{latestExecution.diagnosis.nextStep}</small> : null}
      </section>
    );
  }

  return (
    <section className="thread-callout running">
      <div className="thread-callout-header">
        <strong>{pendingRequest?.command}</strong>
        <span>{humanizeCommandRequestStatus(pendingRequest?.status ?? "requested")}</span>
      </div>
      <p>{pendingRequest?.reason}</p>
      <div className="command-actions">
        <button onClick={onOpenActivity}>Show command details</button>
      </div>
    </section>
  );
}

function CompactOutcomeCallout({
  session,
  onOpenPreview,
  onOpenFileReference
}: {
  session: AgentRuntimeSession;
  onOpenPreview: () => void;
  onOpenFileReference: (reference: FileReference) => void | Promise<void>;
}) {
  if (session.nextAction?.kind === "preview_ready") {
    return (
      <section className="thread-callout completed">
        <div className="thread-callout-header">
          <strong>Preview available</strong>
          <span>{session.previewRecommendation?.target ?? "Static preview"}</span>
        </div>
        <p>{session.nextAction.message}</p>
        <div className="command-actions">
          <button onClick={onOpenPreview}>Open preview</button>
        </div>
      </section>
    );
  }

  if (session.status === "completed" && session.runSummary?.summary) {
    const latestAssistantMessage = [...session.messages].reverse().find((message) => message.role === "assistant")?.content ?? "";
    if (isProbablyDuplicateOutcomeSummary(session.runSummary.summary, latestAssistantMessage)) {
      return null;
    }
    return (
      <section className="thread-callout completed">
        <div className="thread-callout-header">
          <strong>Completed</strong>
          <span>{describeVerificationState(session)}</span>
        </div>
        <MessageMarkdown text={session.runSummary.summary} workspacePath={session.workspacePath} onOpenFileReference={onOpenFileReference} />
      </section>
    );
  }

  if ((session.status === "blocked" || session.status === "failed") && session.runSummary?.summary) {
    return (
      <section className={`thread-callout ${session.status === "failed" ? "failed" : "blocked"}`}>
        <div className="thread-callout-header">
          <strong>{session.status === "failed" ? "Needs review" : "Needs attention"}</strong>
          <span>{humanizeRuntimeStatus(session.status)}</span>
        </div>
        <p>{session.runSummary.summary}</p>
      </section>
    );
  }

  return null;
}

function isProbablyDuplicateOutcomeSummary(summary: string, latestAssistantMessage: string) {
  const left = normalizeOutcomeSummaryText(summary);
  const right = normalizeOutcomeSummaryText(latestAssistantMessage);
  if (!left || !right) return false;
  if (left === right) return true;
  const sharedPrefixLength = Math.min(180, left.length, right.length);
  if (sharedPrefixLength < 80) return false;
  const leftPrefix = left.slice(0, sharedPrefixLength);
  const rightPrefix = right.slice(0, sharedPrefixLength);
  return left.includes(rightPrefix) || right.includes(leftPrefix);
}

function normalizeOutcomeSummaryText(value: string) {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_#|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function ProgressHoverRail({
  open,
  currentStep,
  items,
  session,
  onMouseEnter,
  onMouseLeave,
  onOpenPreview,
  onOpenActivity,
  onRunPendingCommands
}: {
  open: boolean;
  currentStep: ActivityStreamItem;
  items: ActivityStreamItem[];
  session: AgentRuntimeSession | null;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onOpenPreview: () => void;
  onOpenActivity: () => void;
  onRunPendingCommands: () => void;
}) {
  const title = currentStep.status === "completed" ? "Finished" : "Working now";
  const visibleItems = [...items].reverse();
  const nextStep = session ? describeNextProgressStep(session, currentStep) : currentStep.nextStepTitle;
  return (
    <div className="progress-rail-shell">
      <div className="progress-rail-hotzone" aria-hidden="true" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} />
      <aside className={`progress-rail ${open ? "open" : ""}`} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
        <div className="progress-rail-header">
          <strong>{title}</strong>
          <span>{currentStep.title}</span>
        </div>
        <p className="progress-rail-summary">{currentStep.summary}</p>
        {nextStep ? <p className="progress-rail-next">{currentStep.nextLabel ?? "Next"}: {nextStep}</p> : null}
        <div className="progress-rail-list">
          {visibleItems.map((item) => (
            <div key={item.id} className={`progress-rail-item ${item.status}`}>
              <span className={`progress-rail-icon ${item.status}`} />
              <div>
                <strong>{item.title}</strong>
                <span>{item.summary}</span>
                {item.targetFiles?.length ? <small>{item.targetFiles.slice(0, 3).join(", ")}</small> : null}
              </div>
            </div>
          ))}
        </div>
        <div className="progress-rail-actions">
          {session?.nextAction?.kind === "preview_ready" ? (
            <button onClick={onOpenPreview}>Open preview</button>
          ) : session?.nextAction?.kind === "approve_commands" ? (
            <button onClick={onRunPendingCommands}>Approve</button>
          ) : null}
          <button onClick={onOpenActivity}>Show details</button>
        </div>
      </aside>
    </div>
  );
}

function LiveProgressDrawer({ session }: { session: AgentRuntimeSession }) {
  const events = session.progressEvents;
  if (!events.length) {
    return (
      <div className="timeline-list drawer-progress-list">
        <div className="timeline-item running">
          <span className="timeline-dot" />
          <div>
            <strong>Starting local run</strong>
            <span>Starting local run...</span>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="timeline-list drawer-progress-list">
      {events.map((event) => (
        <div key={event.id} className={`timeline-item ${event.status}`}>
          <span className="timeline-dot" />
          <div>
            <strong>{event.taskTitle ?? event.stage}</strong>
            <span>
              {event.agentName ? `${event.agentName} | ` : ""}
              {event.summary}
            </span>
            <small>
              {event.stage}
              {event.targetFiles.length ? ` | ${event.targetFiles.slice(0, 4).join(", ")}` : ""}
            </small>
          </div>
        </div>
      ))}
    </div>
  );
}

function AgentIconRow({
  agents,
  selectedAgentId,
  panelOpen,
  onSelectAgent
}: {
  agents: AgentSidePanelAgentView[];
  selectedAgentId: string;
  panelOpen: boolean;
  onSelectAgent: (agentId: string) => void;
}) {
  return (
    <div className="agent-icon-row">
      {agents.map((agent) => (
        <button
          key={agent.id}
          className={`agent-icon-button ${panelOpen && selectedAgentId === agent.id ? "selected" : ""} ${agent.status}`}
          onClick={() => onSelectAgent(agent.id)}
          title={`${agent.name} | ${agent.role} | ${humanizeAgentStatus(agent.status)}`}
          type="button"
        >
          <span className="agent-icon-ring" style={{ "--agent-color": agent.color } as CSSProperties}>
            <Bot size={13} />
          </span>
        </button>
      ))}
    </div>
  );
}

function AgentPanelOverlay({
  agents,
  backgroundJobs,
  selectedAgentId,
  onSelectAgent,
  onOpenDiff,
  onClose
}: {
  agents: AgentSidePanelAgentView[];
  backgroundJobs: AgentRuntimeSession["backgroundJobs"];
  selectedAgentId: string;
  onSelectAgent: (agentId: string) => void;
  onOpenDiff: () => void;
  onClose: () => void;
}) {
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? agents[0];
  const updates = selectedAgent ? buildAgentPanelUpdates(selectedAgent) : [];
  return (
    <aside className="agent-panel-overlay">
      <div className="agent-panel-backdrop" onClick={onClose} />
      <section className="activity-drawer agent-side-panel">
        <div className="agent-side-panel-header">
          <div>
            <strong>Agents</strong>
            <span>{agents.length} active worker{agents.length === 1 ? "" : "s"}</span>
          </div>
          <div className="agent-side-panel-actions">
            <button className="activity-link" onClick={onOpenDiff}>Review changes</button>
            <button className="frame-icon-button" onClick={onClose} title="Close agent panel">
              <X size={15} />
            </button>
          </div>
        </div>

        <div className="agent-side-tab-row">
          {agents.map((agent) => (
            <button
              key={agent.id}
              className={`agent-side-tab ${selectedAgent?.id === agent.id ? "selected" : ""} ${agent.status}`}
              onClick={() => onSelectAgent(agent.id)}
              type="button"
              title={`${agent.name} | ${humanizeAgentStatus(agent.status)}`}
            >
              <span className="agent-side-color" style={{ "--agent-color": agent.color } as CSSProperties} />
              <strong>{agent.name}</strong>
            </button>
          ))}
        </div>

        {selectedAgent ? (
          <div className="agent-side-thread">
            <div className="agent-side-summary">
              <strong>{selectedAgent.name}</strong>
              <span>{selectedAgent.role} | {selectedAgent.currentAction}</span>
            </div>
            <div className="agent-side-update-list">
              {updates.map((update) => (
                <div key={update.id} className={`agent-side-update ${update.status}`}>
                  <div className={`agent-side-status ${update.status}`} />
                  <div>
                    <strong>{update.title}</strong>
                    <span>{update.summary}</span>
                    {update.meta ? <small>{update.meta}</small> : null}
                  </div>
                </div>
              ))}
            </div>

            <div className="agent-side-footer">
              <span>{selectedAgent.diffLabel}</span>
              <span>{selectedAgent.commandsRun.length ? `Ran ${selectedAgent.commandsRun.length} command(s)` : "No commands yet"}</span>
            </div>

            <details className="agent-side-details">
              <summary>Show more</summary>
              <div className="agent-side-details-grid">
                <div>
                  <strong>Objective</strong>
                  <span>{selectedAgent.objective}</span>
                </div>
                <div>
                  <strong>Agent trace</strong>
                  <span>{selectedAgent.assignedPrompt ?? "Assigned prompt is not reported yet."}</span>
                </div>
                <div>
                  <strong>Tasks</strong>
                  <span>{selectedAgent.tasks.length ? selectedAgent.tasks.join(" | ") : "Not reported yet."}</span>
                </div>
                <div>
                  <strong>Target files</strong>
                  <span>{selectedAgent.targetFiles.length ? selectedAgent.targetFiles.join(", ") : "Not reported yet."}</span>
                </div>
                <div>
                  <strong>Changed files</strong>
                  <span>{selectedAgent.changedFiles.length ? selectedAgent.changedFiles.join(", ") : "Not reported yet."}</span>
                </div>
                <div>
                  <strong>Recent actions</strong>
                  <span>{selectedAgent.recentActions.length ? selectedAgent.recentActions.join(" | ") : "Not reported yet."}</span>
                </div>
              </div>
            </details>
          </div>
        ) : null}

        {backgroundJobs?.length ? (
          <section className="agent-background-jobs">
            <div className="drawer-section-title">Background jobs</div>
            {backgroundJobs.slice(-4).map((job) => (
              <div key={job.jobId} className="agent-side-update running">
                <div className="agent-side-status running" />
                <div>
                  <strong>{job.command}</strong>
                  <span>{job.status} | {job.cwd}</span>
                </div>
              </div>
            ))}
          </section>
        ) : null}
      </section>
    </aside>
  );
}

function RunHeaderCard({
  session,
  patchStats
}: {
  session: AgentRuntimeSession;
  patchStats: PatchChangeStats[];
}) {
  const totals = patchStats.reduce(
    (acc, file) => ({
      files: acc.files + 1,
      additions: acc.additions + (file.added ?? 0),
      deletions: acc.deletions + (file.removed ?? 0)
    }),
    { files: 0, additions: 0, deletions: 0 }
  );
  return (
    <section className="run-card run-header-card">
      <div className="run-card-header">
        <div>
          <strong>Run objective</strong>
          <span>{session.userPrompt}</span>
        </div>
      </div>
      <div className="header-metric-grid">
        <div><strong>Mode</strong><span>{humanizeRunMode(session.runMode)}</span></div>
        <div><strong>Lifecycle</strong><span>{humanizeLifecycleStage(session.lifecycleStage)}</span></div>
        <div><strong>Risk</strong><span>{inferSessionRisk(session)}</span></div>
        <div><strong>Changed</strong><span>{formatPatchTotalsLabel(totals.files, totals.additions, totals.deletions)}</span></div>
        <div><strong>Verification</strong><span>{describeVerificationState(session)}</span></div>
        <div><strong>Review</strong><span>{describeReviewReadiness(session)}</span></div>
      </div>
    </section>
  );
}

function ProgressChecklistCard({ session }: { session: AgentRuntimeSession }) {
  const phases = getDisplayRunPhases(session);
  return (
    <section className="run-card timeline-card">
      <div className="run-card-header">
        <div>
          <strong>Run checklist</strong>
          <span>Deep local work is shown as explicit phases instead of hidden turns.</span>
        </div>
      </div>
      <div className="timeline-list">
        {phases.map((phase) => (
          <div key={phase.id} className={`timeline-item ${phase.status === "active" ? "running" : phase.status}`}>
            <span className="timeline-dot" />
            <div>
              <strong>{humanizeRunPhase(phase.id)}</strong>
              <span>{phase.summary}</span>
              {typeof phase.evidenceCount === "number" ? <small>{phase.evidenceCount} evidence item(s)</small> : null}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function AgentStripCard({
  agents,
  selectedAgentId,
  onSelectAgent
}: {
  agents: AgentContractView[];
  selectedAgentId: string;
  onSelectAgent: (agentId: string) => void;
}) {
  if (!agents.length) return null;
  return (
    <section className="run-card">
      <div className="run-card-header">
        <div>
          <strong>Agent strip</strong>
          <span>Each chip reflects a real reported agent or the current local coordinator.</span>
        </div>
      </div>
      <div className="agent-strip">
        {agents.map((agent) => (
          <button
            key={agent.id}
            className={`agent-chip ${selectedAgentId === agent.id ? "selected" : ""} ${agent.status}`}
            onClick={() => onSelectAgent(agent.id)}
          >
            <strong>{agent.name}</strong>
            <span>{agent.role}</span>
            <small>{humanizeAgentStatus(agent.status)} | {agent.currentAction}</small>
            <small>{agent.diffLabel}</small>
          </button>
        ))}
      </div>
    </section>
  );
}

function AgentDetailCard({ agent }: { agent?: AgentContractView }) {
  if (!agent) return null;
  return (
    <section className="run-card">
      <div className="run-card-header">
        <div>
          <strong>{agent.name}</strong>
          <span>{agent.role}</span>
        </div>
      </div>
      <div className="agent-detail-grid">
        <div><strong>Objective</strong><span>{agent.objective}</span></div>
        <div><strong>Current action</strong><span>{agent.currentAction}</span></div>
        <div><strong>Owned paths</strong><span>{agent.ownedPaths.length ? agent.ownedPaths.join(", ") : "Not reported yet."}</span></div>
        <div><strong>Forbidden paths</strong><span>{agent.forbiddenPaths.length ? agent.forbiddenPaths.join(", ") : "Not reported yet."}</span></div>
        <div><strong>Allowed actions</strong><span>{agent.allowedActions.length ? agent.allowedActions.join(", ") : "Not reported yet."}</span></div>
        <div><strong>Stop conditions</strong><span>{agent.stopConditions.length ? agent.stopConditions.join(" | ") : "Not reported yet."}</span></div>
        <div><strong>Integration notes</strong><span>{agent.integrationNotes.length ? agent.integrationNotes.join(" | ") : "Not reported yet."}</span></div>
        <div><strong>Changed files</strong><span>{agent.changedFiles.length ? agent.changedFiles.join(", ") : "Not reported yet."}</span></div>
        <div><strong>Commands</strong><span>{agent.commandsRun.length ? agent.commandsRun.join(", ") : "Not reported yet."}</span></div>
        <div><strong>Tests run</strong><span>{agent.testsRun.length ? agent.testsRun.join(", ") : "Not reported yet."}</span></div>
        <div><strong>Decision refs</strong><span>{agent.decisionsMade.length ? agent.decisionsMade.join(", ") : "Not reported yet."}</span></div>
        <div><strong>Evidence refs</strong><span>{agent.evidenceRefs.length ? describeEvidenceRefs(agent.evidenceRefs) : "Not reported yet."}</span></div>
        <div><strong>Risk refs</strong><span>{agent.riskRefs.length ? describeRiskRefs(agent.riskRefs) : "Not reported yet."}</span></div>
        <div><strong>Risk</strong><span>{agent.riskLevel}</span></div>
        <div><strong>Blockers</strong><span>{agent.blockers.length ? agent.blockers.join(", ") : "None reported."}</span></div>
      </div>
      <div className="timeline-list compact-list">
        {agent.workJournal.length ? agent.workJournal.slice(-8).map((entry) => (
          <div className={`timeline-item ${mapJournalStatus(entry.status)}`} key={entry.id}>
            <span className="timeline-dot" />
            <div>
              <strong>{entry.title}</strong>
              <span>{entry.summary}</span>
              <small>{humanizeJournalKind(entry.kind)}{entry.filePath ? ` | ${entry.filePath}` : entry.command ? ` | ${entry.command}` : ""}</small>
            </div>
          </div>
        )) : (
          <div className="timeline-item running">
            <span className="timeline-dot" />
            <div><span>Not reported yet.</span></div>
          </div>
        )}
      </div>
    </section>
  );
}

function EvidenceLedgerCard({ records }: { records: DecisionRecord[] }) {
  if (!records.length) return null;
  return (
    <section className="run-card timeline-card">
      <div className="run-card-header">
        <div>
          <strong>Evidence ledger</strong>
          <span>Findings, decisions, and uncertainty are visible without exposing hidden chain-of-thought.</span>
        </div>
      </div>
      <div className="timeline-list">
        {records.slice(-8).map((record) => (
          <div className="timeline-item completed" key={record.id}>
            <span className="timeline-dot" />
            <div>
              <strong>{humanizeDecisionCategory(record.category)} | {record.createdByAgent}</strong>
              <span>{record.finding}</span>
              <small>Decision: {record.decision}</small>
              {record.createdByAgentId || record.linkedAgentIds?.length ? <small>Agent links: {[record.createdByAgentId, ...(record.linkedAgentIds ?? [])].filter(Boolean).join(", ")}</small> : null}
              <small>Evidence: {describeEvidenceRefs(record.evidenceRefs)} | Files: {record.linkedFiles.length ? record.linkedFiles.join(", ") : "none"}</small>
              {record.uncertainty ? <small>Uncertainty: {record.uncertainty}</small> : null}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ReviewGateCard({ session }: { session: AgentRuntimeSession }) {
  const gate = session.reviewGate;
  if (!gate) return null;
  return (
    <section className="run-card summary-card">
      <div className="run-card-header">
        <div>
          <strong>Review gate</strong>
          <span>{gate.summary}</span>
        </div>
      </div>
      <div className="summary-list">
        <div className="summary-line compact">Total diff: {formatPatchTotalsLabel(gate.totalFilesChanged, gate.totalAdditions, gate.totalDeletions)}</div>
        <div className="summary-line compact">Diff source: {humanizeDiffSource(gate.globalDiff?.source)}</div>
        <div className="summary-line compact">Reconciliation: {describeReconciliation(gate.reconciliation)}</div>
        <div className="summary-line compact">Recommendation: {humanizeReviewRecommendation(gate.recommendation)}</div>
        <div className="summary-line compact">Risky areas: {gate.riskyAreas.length ? gate.riskyAreas.join(", ") : "None reported."}</div>
        <div className="summary-line compact">Unresolved blockers: {gate.unresolvedBlockers.length ? gate.unresolvedBlockers.join(" | ") : "None."}</div>
        {gate.changesByAgent.length ? gate.changesByAgent.map((entry) => (
          <div className="summary-line compact" key={entry.agentName}>
            {entry.agentName}: {formatPatchTotalsLabel(entry.fileCount, entry.additions, entry.deletions)} | confidence: {humanizeAttributionConfidence(entry.confidence)}
          </div>
        )) : (
          <div className="summary-line compact">Agent attribution: Not reported yet.</div>
        )}
        {gate.sharedFiles?.length ? <div className="summary-line compact">Shared files: {gate.sharedFiles.map((file) => file.path).join(", ")}</div> : null}
        {gate.unattributedFiles?.length ? <div className="summary-line compact">Unattributed files: {gate.unattributedFiles.map((file) => file.path).join(", ")}</div> : null}
        {gate.reconciliation?.missingFiles.length ? <div className="summary-line compact">Missing after apply: {gate.reconciliation.missingFiles.join(", ")}</div> : null}
        {gate.reconciliation?.extraFiles.length ? <div className="summary-line compact">Extra after apply: {gate.reconciliation.extraFiles.join(", ")}</div> : null}
        {gate.reconciliation?.changedFilesWithDifferentStats.length ? <div className="summary-line compact">Different stats: {gate.reconciliation.changedFilesWithDifferentStats.map((file) => file.path).join(", ")}</div> : null}
        {gate.remainingUnknowns?.length ? <div className="summary-line compact">Unknowns: {gate.remainingUnknowns.join(" | ")}</div> : null}
        {gate.verificationChecks.length ? gate.verificationChecks.map((check) => (
          <div className="summary-line compact" key={`verification-${check.name}`}>
            {check.label ?? check.name}: {humanizeVerificationCheckStatus(check.status)}{check.command ? ` | ${check.command}` : ""}
          </div>
        )) : null}
        {gate.risksByAgent?.length ? gate.risksByAgent.map((entry) => (
          <div className="summary-line compact" key={`risk-${entry.agentName}`}>
            Risks for {entry.agentName}: {entry.count} item(s)
          </div>
        )) : null}
        {gate.decisionsByAgent?.length ? gate.decisionsByAgent.map((entry) => (
          <div className="summary-line compact" key={`decision-${entry.agentName}`}>
            Decisions for {entry.agentName}: {entry.count} linked record(s)
          </div>
        )) : null}
      </div>
    </section>
  );
}

function ProgressTimeline({ session }: { session: AgentRuntimeSession }) {
  const events = session.progressEvents;
  if (!events.length && session.status !== "running") return null;
  return (
    <section className="run-card timeline-card">
      <div className="run-card-header">
        <div>
          <strong>Current work</strong>
          <span>{events.at(-1)?.summary ?? "Starting the run and preparing the plan."}</span>
        </div>
      </div>
      <div className="timeline-list">
        {(events.length ? events : []).map((event) => (
          <div key={event.id} className={`timeline-item ${event.status}`}>
            <span className="timeline-dot" />
            <div>
              <strong>{event.taskTitle ?? event.stage}</strong>
              <span>
                {event.agentName ? `${event.agentName} | ` : ""}
                {event.summary}
              </span>
              {event.targetFiles.length ? <small>{event.targetFiles.slice(0, 4).join(", ")}</small> : null}
            </div>
          </div>
        ))}
        {!events.length ? (
          <div className="timeline-item running">
            <span className="timeline-dot" />
            <div>
              <strong>Preparing</strong>
              <span>The agent is starting your request.</span>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ReasoningSummaryCard({ session }: { session: AgentRuntimeSession }) {
  const summaries = [
    session.plan?.summary ? `Plan: ${session.plan.summary}` : "",
    ...(session.reasoningSummaries ?? []),
    session.verificationResult?.summary ? `Verification: ${session.verificationResult.summary}` : ""
  ].filter(Boolean).slice(-5);
  if (!summaries.length) return null;
  return (
    <section className="run-card timeline-card reasoning-card">
      <div className="run-card-header">
        <div>
          <strong>Reasoning summary</strong>
          <span>Visible rationale, decisions, and verification notes without hidden chain-of-thought.</span>
        </div>
      </div>
      <div className="timeline-list">
        {summaries.map((summary, index) => (
          <div className="timeline-item completed" key={`${index}-${summary}`}>
            <span className="timeline-dot" />
            <div>
              <strong>Step {index + 1}</strong>
              <span>{summary}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ToolIntentCard({ session }: { session: AgentRuntimeSession }) {
  const intents = (session.toolIntents ?? []).slice(-8);
  if (!intents.length) return null;
  return (
    <section className="run-card timeline-card">
      <div className="run-card-header">
        <div>
          <strong>Tool intents</strong>
          <span>Reviewable actions before Rust changes anything.</span>
        </div>
      </div>
      <div className="timeline-list">
        {intents.map((intent) => (
          <div className={`timeline-item ${intent.status}`} key={intent.id}>
            <span className="timeline-dot" />
            <div>
              <strong>{intent.title}</strong>
              <span>{intent.summary}</span>
              <small>{intent.type} | {intent.status}</small>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function OperatorStateCard({
  session,
  connectionState,
  canReconnect
}: {
  session: AgentRuntimeSession;
  connectionState: "connected" | "disconnected";
  canReconnect: boolean;
}) {
  return (
    <section className="run-card summary-card">
      <div className="run-card-header">
        <div>
          <strong>Operator state</strong>
          <span>{describeOperatorHeadline(session, connectionState)}</span>
        </div>
      </div>
      <div className="summary-list">
        <div className="summary-line compact">Connection: {connectionState === "connected" ? "Live updates connected." : "Live updates disconnected; visible state may lag until refresh."}</div>
        <div className="summary-line compact">Restore: {describeRestoreTruth(session, canReconnect)}</div>
        <div className="summary-line compact">Write state: {describePatchState(session)}</div>
        <div className="summary-line compact">Command state: {describeCommandState(session)}</div>
        <div className="summary-line compact">Verification: {describeVerificationState(session)}</div>
        <div className="summary-line compact">Provider: {describeProviderTruth(session)}</div>
        <div className="summary-line compact">Evidence: {describeEvidenceTruth(session)}</div>
        <div className="summary-line compact">Audit trail: {describeAuditTrail(session)}</div>
      </div>
    </section>
  );
}

function ArtifactCard({
  session,
  onOpenDiff,
  onOpenPreview
}: {
  session: AgentRuntimeSession;
  onOpenDiff: () => void;
  onOpenPreview: () => void;
}) {
  const artifacts = (session.artifacts ?? []).slice(-6);
  if (!artifacts.length) return null;
  return (
    <section className="run-card">
      <div className="run-card-header">
        <div>
          <strong>Artifacts</strong>
          <span>Audit trail of plans, diffs, command results, previews, and verification records.</span>
        </div>
      </div>
      <div className="artifact-grid">
        {artifacts.map((artifact) => (
          <div className="artifact-tile" key={artifact.id}>
            <div className="artifact-title">
              <FileText size={15} />
              <strong>{artifact.title}</strong>
              <span>{artifact.type}</span>
            </div>
            <p>{artifact.summary}</p>
            {artifact.type === "diff" ? <button onClick={onOpenDiff}>Review diff record</button> : null}
            {artifact.type === "preview" ? <button onClick={() => onOpenPreview()}>Open preview target</button> : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function ProjectKnowledgeTreePanel({ session }: { session: AgentRuntimeSession }) {
  const tree = session.projectKnowledgeTree;
  if (!tree) return null;
  const route = session.latestKnowledgeRoute?.route;
  const plan = session.latestKnowledgeRoute?.plan;
  const nodeById = new Map(tree.nodes.map((node) => [node.nodeId, node]));
  const primaryNode = route ? nodeById.get(route.primaryNode) : undefined;
  const affectedNodes = route?.affectedNodeIds.map((nodeId) => nodeById.get(nodeId)?.scope ?? nodeId).slice(0, 8) ?? [];
  const reviewerNodes = route?.reviewerNodes.map((nodeId) => nodeById.get(nodeId)?.scope ?? nodeId).slice(0, 8) ?? [];
  const rootNode = tree.nodes.find((node) => node.nodeId === tree.rootNodeId);
  const rootChildren = (rootNode?.children ?? []).map((nodeId) => nodeById.get(nodeId)?.scope ?? nodeId).slice(0, 8);
  const targetOwnership = (route?.likelyFiles ?? [])
    .map((file) => tree.ownershipMap?.[file] ?? tree.fileOwnership.find((owner) => owner.path === file))
    .filter((owner): owner is NonNullable<typeof owner> => Boolean(owner))
    .slice(0, 6);
  const reviewChain = session.latestKnowledgeRoute?.reviewChain ?? plan?.requiredReviewChain;
  const branchTargets = session.latestKnowledgeBranchTargets ?? session.latestKnowledgeRoute?.knowledgeBranchTargets ?? plan?.knowledgeBranchTargets ?? [];
  return (
    <div className="proposal-card">
      <strong>{rootNode?.scope ?? "Project Knowledge Tree"}</strong>
      <span>{tree.nodes.length} node(s) | {tree.fileOwnership.length} owned file(s) | memory {tree.memoryFreshness.status}</span>
      <p>{rootNode?.summary}</p>
      <div className="summary-list">
        <div className="summary-line compact">Root children: {rootChildren.join(", ") || "none"}</div>
        <div className="summary-line compact">Tree readiness: {tree.completeness?.status ?? "unknown"}</div>
        <div className="summary-line compact">Orphaned files: {tree.orphanedFiles?.length ? tree.orphanedFiles.slice(0, 4).map((file) => file.path).join(", ") : "none reported"}</div>
      </div>
      {route ? (
        <>
          <div className="summary-list">
            <div className="summary-line compact">Selected node: {primaryNode?.scope ?? route.primaryNode}</div>
            <div className="summary-line compact">Affected nodes: {affectedNodes.join(", ") || "none"}</div>
            <div className="summary-line compact">Reviewer nodes: {reviewerNodes.join(", ") || "root"}</div>
            <div className="summary-line compact">Target files: {route.likelyFiles.slice(0, 8).join(", ") || "none selected"}</div>
            <div className="summary-line compact">Files not to touch: {plan?.filesNotToTouch.slice(0, 8).join(", ") || "none selected"}</div>
            <div className="summary-line compact">Confidence: {Math.round(route.confidence * 100)}% ({route.confidenceLevel ?? "unknown"})</div>
            <div className="summary-line compact">Evidence used: {(session.latestKnowledgeRoute?.evidenceUsed ?? route.evidenceUsed ?? []).slice(0, 4).join("; ") || "none reported"}</div>
            <div className="summary-line compact">State: {plan?.executionState ?? "Execution has not started."}</div>
          </div>
          {reviewChain ? (
            <div className="summary-list">
              <div className="summary-line compact">Leaf review: {reviewChain.leafReview.join(", ") || "none"}</div>
              <div className="summary-line compact">Parent scope review: {reviewChain.parentScopeReview.join(", ") || "root"}</div>
              <div className="summary-line compact">Sibling affected-node review: {reviewChain.siblingAffectedNodeReview.join(", ") || "none"}</div>
              <div className="summary-line compact">Root integration review: {reviewChain.rootIntegrationReview.join(", ") || tree.rootNodeId}</div>
            </div>
          ) : null}
          {route.risks.length ? <p className="muted">Risks: {route.risks.slice(0, 4).join("; ")}</p> : null}
          {branchTargets.length ? (
            <div className="summary-list">
              <div className="summary-line compact">Generated branch targets: {branchTargets.length}</div>
              <div className="summary-line compact">Execution has not started.</div>
              {branchTargets.slice(0, 4).map((target) => (
                <div className="summary-line compact" key={target.targetId}>
                  {target.scope}: {target.status} | owner {nodeById.get(target.primaryOwnerNodeId)?.scope ?? target.primaryOwnerNodeId} | allowed {target.filesAllowed.slice(0, 3).join(", ") || "none"} | forbidden {target.filesForbidden.slice(0, 3).join(", ") || "none"} | reviewers {target.reviewerNodeIds.slice(0, 4).join(", ") || "none"} | blocked {target.blockedReasons.join(", ") || "none"} | confidence {Math.round(target.confidence * 100)}%
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <p className="muted">No edit route selected yet.</p>
      )}
      <div className="artifact-grid">
        {(targetOwnership.length ? targetOwnership : tree.fileOwnership.slice(0, 6)).map((owner) => (
          <div className="artifact-tile" key={owner.path}>
            <div className="artifact-title">
              <FileText size={15} />
              <strong>{owner.path}</strong>
              <span>{nodeById.get(owner.primaryOwnerNodeId)?.scope ?? owner.primaryOwnerNodeId}</span>
            </div>
            <p>Reviewers: {owner.reviewerNodeIds.map((nodeId) => nodeById.get(nodeId)?.scope ?? nodeId).join(", ") || "root"}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function RunResultCard({
  session,
  onOpenPreview
}: {
  session: AgentRuntimeSession;
  onOpenPreview: () => void;
}) {
  const latestExecution = session.commandExecutions.at(-1);
  if (!latestExecution && !session.previewRecommendation) return null;
  return (
    <section className="run-card summary-card">
      <div className="run-card-header">
        <div>
          <strong>Run result</strong>
          <span>
            {latestExecution
              ? `${latestExecution.command} | ${humanizeCommandResultStatus(latestExecution.status)}`
              : session.previewRecommendation?.description ?? "Preview prepared"}
          </span>
        </div>
      </div>
      <div className="summary-list">
        {latestExecution ? (
          <>
            <div className="summary-line compact">Command: {latestExecution.command}</div>
            <div className="summary-line compact">Cwd: {latestExecution.cwd}</div>
            <div className="summary-line compact">Mode: {latestExecution.provenance?.background || latestExecution.backgroundJob ? "Background" : shouldDescribeBackground(latestExecution.command) ? "Background" : "Foreground"}</div>
            <div className="summary-line compact">Status: {humanizeCommandResultStatus(latestExecution.status)}</div>
            {typeof latestExecution.exitCode === "number" ? <div className="summary-line compact">Exit code: {latestExecution.exitCode}</div> : null}
            <div className="summary-line compact">{describeCommandExecutionProvenance(latestExecution)}</div>
            {latestExecution.diagnosis ? <div className="summary-line compact">Diagnosis: {latestExecution.diagnosis.summary}</div> : null}
            {latestExecution.diagnosis?.nextStep ? <div className="summary-line compact">Next step: {latestExecution.diagnosis.nextStep}</div> : null}
            {latestExecution.backgroundJob ? <div className="summary-line compact">Background tracking limited: {latestExecution.backgroundJob.status}</div> : null}
            {latestExecution.message ? <div className="summary-line compact">{latestExecution.message}</div> : null}
          </>
        ) : null}
        {session.previewRecommendation ? (
          <>
            <div className="summary-line compact">Preview target: {session.previewRecommendation.target}</div>
            <div className="summary-line compact">Preview state: Prepared for review only. It does not open until you choose to launch it.</div>
            <div className="command-actions">
              <button onClick={() => onOpenPreview()}>
                <Globe size={14} />
                Open preview
              </button>
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}

function WorkingTeamCard({
  session,
  onOpenActivity
}: {
  session: AgentRuntimeSession;
  onOpenActivity: () => void;
}) {
  const statuses: AgentWorkStatus[] = session.agentWorkStatuses.length
    ? session.agentWorkStatuses
    : (session.orchestration?.workOrders ?? []).map((order) => ({
      agentName: order.agentName,
      role: order.dynamicRole,
      taskTitle: order.objective,
      objective: order.objective,
      status: "queued" as const,
      targetFiles: order.requiredArtifacts,
      updatedAt: new Date().toISOString()
    }));
  if (!statuses.length) return null;
  return (
    <section className="run-card">
      <div className="run-card-header">
        <div>
          <strong>Working team</strong>
          <span>{session.delegationDecision?.rationale ?? "Specialists are selected from the task requirements."}</span>
        </div>
        <button className="activity-link" onClick={onOpenActivity}>Details</button>
      </div>
      <div className="work-team-grid">
        {statuses.map((status) => (
          <div className={`work-agent ${status.status}`} key={status.agentName}>
            <div className="work-agent-title">
              <strong>{prettyAgentName(status.agentName)}</strong>
              <span>{status.status}</span>
            </div>
            <p>{status.objective || status.taskTitle}</p>
            {status.targetFiles.length ? <small>{status.targetFiles.slice(0, 3).join(", ")}</small> : null}
            {status.selfCheck ? (
              <small>
                Self-check: {status.selfCheck.failedCriteria.length || status.selfCheck.missingItems.length ? "needs work" : "passed"}
              </small>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function CodeChangesCard({
  session,
  patchStats,
  onOpenActivity,
  onOpenDiff
}: {
  session: AgentRuntimeSession;
  patchStats: PatchChangeStats[];
  onOpenActivity: () => void;
  onOpenDiff: () => void;
}) {
  if (!session.patchProposals.length && !patchStats.length) return null;
  return (
    <section className="run-card code-changes-card">
      <div className="run-card-header">
        <div>
          <strong>Code changes</strong>
          <span>
            {session.patchProposals.length} proposal(s) | {patchStats.length} file(s) touched
          </span>
        </div>
        <div className="command-actions">
          <button onClick={onOpenDiff}>Review changes</button>
          <button onClick={onOpenActivity}>Open file list</button>
        </div>
      </div>
      <div className="changed-file-list">
        {patchStats.map((file) => (
          <div className="changed-file-row" key={file.path}>
            <span>{file.path}</span>
            <strong>
              +{file.added} -{file.removed}
            </strong>
          </div>
        ))}
      </div>
      <div className="patch-status-line">
        {session.patchProposals.map((proposal) => (
          <span key={proposal.id}>
            {proposal.title}: {humanizePatchStatus(proposal.status)}
          </span>
        ))}
      </div>
    </section>
  );
}

function RunSummaryCard({ session }: { session: AgentRuntimeSession }) {
  if (!session.runSummary) return null;
  return (
    <section className="run-card summary-card">
      <div className="run-card-header">
        <div>
          <strong>Result</strong>
          <span>{session.runSummary.summary}</span>
        </div>
      </div>
      <div className="summary-list">
        {session.runSummary.gates.map((gate) => (
          <div className="summary-line compact" key={gate.name}>
            {gate.name}: {gate.status}
          </div>
        ))}
        {session.runSummary.nextAction ? <div className="summary-line compact">{session.runSummary.nextAction}</div> : null}
      </div>
    </section>
  );
}

function CompactNote({
  title,
  action,
  children
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="compact-note">
      <div className="compact-note-header">
        <strong>{title}</strong>
        {action}
      </div>
      <div className="compact-note-body">{children}</div>
    </div>
  );
}

function ActionCard({
  title,
  message,
  actions
}: {
  title: string;
  message: string;
  actions: React.ReactNode;
}) {
  return (
    <div className="action-card">
      <strong>{title}</strong>
      <div className="thread-entry-body">{message}</div>
      <div className="command-actions">{actions}</div>
    </div>
  );
}

function ActivityCard({
  title,
  subtitle,
  action,
  children
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="activity-card">
      <div className="activity-card-header">
        <div>
          <strong>{title}</strong>
          {subtitle ? <span>{subtitle}</span> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function StatusRow({ label, status, detail }: { label: string; status: string; detail?: string }) {
  const iconClass =
    status === "done" || status === "completed"
      ? "done-icon"
      : status === "blocked" || status === "failed" || status === "error"
        ? "blocked-icon"
        : "pending-icon";
  return (
    <div className="status-row">
      <Bot size={15} className={iconClass} />
      <div>
        <strong>{label}</strong>
        <span>
          {humanizeUiStatus(status)}
          {detail ? ` | ${detail}` : ""}
        </span>
      </div>
    </div>
  );
}

function getSessionPatchStats(session: AgentRuntimeSession): PatchChangeStats[] {
  if (session.runSummary?.filesChanged.length) return session.runSummary.filesChanged;
  const progressStats = session.progressEvents.flatMap((event) => event.patchStats ?? []);
  if (progressStats.length) return mergePatchStats(progressStats);
  return mergePatchStats(session.patchProposals.flatMap((proposal) => computePatchStats(proposal.unifiedDiff, proposal.filesChanged)));
}

function computePatchStats(
  unifiedDiff: string,
  filesChanged: Array<{ path: string; changeType: PatchChangeStats["changeType"] }>
): PatchChangeStats[] {
  const stats = new Map<string, PatchChangeStats>();
  for (const file of filesChanged) {
    stats.set(file.path, { path: file.path, added: 0, removed: 0, changeType: file.changeType });
  }
  let currentPath = filesChanged[0]?.path;
  for (const line of unifiedDiff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      currentPath = match?.[2] ?? currentPath;
      if (currentPath && !stats.has(currentPath)) {
        stats.set(currentPath, { path: currentPath, added: 0, removed: 0, changeType: "modify" });
      }
      continue;
    }
    if (line.startsWith("+++ b/")) {
      currentPath = line.slice("+++ b/".length);
      if (!stats.has(currentPath)) {
        stats.set(currentPath, { path: currentPath, added: 0, removed: 0, changeType: "modify" });
      }
      continue;
    }
    if (!currentPath) continue;
    const target = stats.get(currentPath) ?? { path: currentPath, added: 0, removed: 0, changeType: "modify" as const };
    if (line.startsWith("+") && !line.startsWith("+++")) target.added = (target.added ?? 0) + 1;
    if (line.startsWith("-") && !line.startsWith("---")) target.removed = (target.removed ?? 0) + 1;
    stats.set(currentPath, target);
  }
  return [...stats.values()];
}

function mergePatchStats(stats: PatchChangeStats[]) {
  const merged = new Map<string, PatchChangeStats>();
  for (const stat of stats) {
    const current = merged.get(stat.path);
    merged.set(stat.path, {
      path: stat.path,
      changeType: stat.changeType,
      added: typeof stat.added === "number" || typeof current?.added === "number" ? (current?.added ?? 0) + (stat.added ?? 0) : undefined,
      removed: typeof stat.removed === "number" || typeof current?.removed === "number" ? (current?.removed ?? 0) + (stat.removed ?? 0) : undefined
    });
  }
  return [...merged.values()];
}

type AgentContractView = {
  id: string;
  name: string;
  role: string;
  status: "idle" | "running" | "completed" | "blocked" | "failed";
  objective: string;
  currentAction: string;
  ownedPaths: string[];
  forbiddenPaths: string[];
  allowedActions: string[];
  stopConditions: string[];
  integrationNotes: string[];
  recentActions: string[];
  changedFiles: string[];
  commandsRun: string[];
  testsRun: string[];
  decisionsMade: string[];
  evidenceRefs: EvidenceRef[];
  riskRefs: AgentRiskRef[];
  workJournal: AgentWorkJournalEntry[];
  riskLevel: "low" | "medium" | "high";
  blockers: string[];
  diffLabel: string;
};

type AgentSidePanelAgentView = {
  id: string;
  name: string;
  role: string;
  color: string;
  status: AgentContractView["status"];
  currentAction: string;
  diffLabel: string;
  updatedAt?: string;
  changedFiles: string[];
  commandsRun: string[];
  recentActions: string[];
  workJournal: AgentWorkJournalEntry[];
  objective: string;
  assignedPrompt?: string;
  tasks: string[];
  targetFiles: string[];
  traceEntries: Array<{
    id: string;
    title: string;
    summary: string;
    meta?: string;
    status: "running" | "completed" | "blocked" | "failed";
  }>;
};

type AgentSidePanelModel = {
  agents: AgentSidePanelAgentView[];
  backgroundJobs: AgentRuntimeSession["backgroundJobs"];
};

function getDisplayRunPhases(session: AgentRuntimeSession): RunPhase[] {
  if (session.runPhases?.length) return session.runPhases;
  const pending = (id: RunPhase["id"], summary: string): RunPhase => ({ id, status: "pending", summary });
  return [
    pending("inspect_workspace", "Workspace inspection has not been reported yet."),
    pending("build_repo_map", "Repo map has not been reported yet."),
    pending("split_agents", "Agent planning has not been reported yet."),
    pending("agents_running", "Execution has not been reported yet."),
    pending("integrate_changes", "No integrated diff has been reported yet."),
    pending("run_verification", session.verificationResult?.summary ?? "Verification has not been reported yet."),
    pending("review_final_diff", session.runSummary?.nextAction ?? "Review gate is not ready yet."),
    pending("final_report", session.runSummary?.summary ?? "Final report is not ready yet.")
  ];
}

function buildAgentSidePanel(session: AgentRuntimeSession): AgentSidePanelModel {
  const workerSpecs = session.orchestration?.assignmentPlan?.workerSpecs ?? [];
  const workOrders = session.orchestration?.workOrders ?? [];
  const artifactHandoffs = session.orchestration?.artifactHandoffs ?? [];
  const contracts = getAgentContracts(session)
    .filter((agent) => agent.status !== "idle")
    .filter((agent) => !isCoordinatorLikeAgent(agent.name, agent.role));
  const workersOnly = contracts.filter((agent) => {
    if (session.delegationDecision?.selectedAgentCount && session.delegationDecision.selectedAgentCount > 1) {
      return true;
    }
    return !isCoordinatorLikeAgent(agent.name, agent.role);
  });
  const agents = workersOnly.map((agent) => {
    const workerSpec = workerSpecs.find((spec) =>
      spec.roleTitle === agent.role
      || spec.objective === agent.objective
      || spec.id === agent.id
    );
    const workOrder = workOrders.find((order) =>
      order.agentName === agent.name
      || order.dynamicRole === agent.role
      || order.objective === agent.objective
    );
    const handoffs = artifactHandoffs.filter((handoff) =>
      handoff.roleTitle === agent.role
      || handoff.workerId === workerSpec?.id
      || handoff.summary === agent.objective
    );
    return {
      id: agent.id,
      name: prettyAgentName(agent.name),
      role: agent.role,
      color: colorForAgent(agent.id),
      status: agent.status,
      currentAction: agent.currentAction,
      diffLabel: agent.diffLabel,
      updatedAt: agent.workJournal.at(-1)?.timestamp,
      changedFiles: agent.changedFiles,
      commandsRun: agent.commandsRun,
      recentActions: agent.recentActions,
      workJournal: agent.workJournal,
      objective: workOrder?.objective ?? workerSpec?.objective ?? agent.objective,
      assignedPrompt: buildAssignedPrompt(workerSpec, workOrder),
      tasks: workerSpec?.tasks ?? (workOrder ? [workOrder.objective, ...workOrder.acceptanceCriteria] : []),
      targetFiles: workerSpec?.targetFiles ?? workOrder?.requiredArtifacts ?? agent.changedFiles,
      traceEntries: buildAgentTraceEntries(agent, handoffs)
    };
  });
  return {
    agents: agents.length > 1 ? agents : [],
    backgroundJobs: session.backgroundJobs ?? []
  };
}

function getAgentContracts(session: AgentRuntimeSession): AgentContractView[] {
  const agentRuns = session.orchestration?.agentRuns ?? [];
  if (agentRuns.length) {
    return agentRuns.map((agent) => ({
      id: agent.id,
      name: agent.displayName ?? agent.agentName,
      role: agent.roleTitle ?? agent.role,
      status: agent.status,
      objective: agent.objective ?? session.userPrompt,
      currentAction: agent.currentAction ?? agent.currentTask ?? "Not reported yet.",
      ownedPaths: agent.ownedPaths ?? [],
      forbiddenPaths: agent.forbiddenPaths ?? [],
      allowedActions: agent.allowedActions ?? [],
      stopConditions: agent.stopConditions ?? [],
      integrationNotes: agent.integrationNotes ?? [],
      recentActions: agent.recentActions ?? (agent.lastEvent ? [agent.lastEvent] : []),
      changedFiles: agent.changedFiles ?? [],
      commandsRun: agent.commandsRun ?? [],
      testsRun: agent.testsRun ?? [],
      decisionsMade: agent.decisionsMade ?? [],
      evidenceRefs: agent.evidenceRefs ?? [],
      riskRefs: agent.riskRefs ?? [],
      workJournal: agent.workJournal ?? [],
      riskLevel: agent.riskLevel ?? "medium",
      blockers: agent.blockers ?? [],
      diffLabel: formatPatchTotalsLabel(agent.diffStats?.fileCount, agent.diffStats?.additions, agent.diffStats?.deletions)
    }));
  }

  return (session.agentWorkStatuses ?? []).map((status, index) => ({
    id: `${status.agentName}-${index}`,
    name: status.agentName,
    role: status.role,
    status: mapProgressStatusToAgentStatus(status.status),
    objective: status.objective,
    currentAction: status.summary ?? status.taskTitle,
    ownedPaths: [],
    forbiddenPaths: [],
    allowedActions: [],
    stopConditions: [],
    integrationNotes: [],
    recentActions: [status.taskTitle],
    changedFiles: status.targetFiles,
    commandsRun: [],
    testsRun: [],
    decisionsMade: [],
    evidenceRefs: [],
    riskRefs: [],
    workJournal: [],
    riskLevel: "medium",
    blockers: [],
    diffLabel: formatPatchTotalsLabel(status.targetFiles.length)
  }));
}

function prettyAgentName(name: string) {
  return name.replace(/Agent$/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
}

function mapProgressStatusToAgentStatus(status: AgentWorkStatus["status"]): AgentContractView["status"] {
  if (status === "failed") return "failed";
  if (status === "blocked") return "blocked";
  if (status === "completed") return "completed";
  if (status === "running") return "running";
  return "idle";
}

function humanizeRunMode(mode: RunMode | undefined) {
  switch (mode) {
    case "quick_fix":
      return "Quick fix";
    case "normal_run":
      return "Normal run";
    case "inspect_only":
      return "Explain only";
    case "deep_audit":
      return "Deep local run";
    case "soak_mode":
      return "Soak mode";
    case "paranoid_mode":
      return "Paranoid mode";
    default:
      return "Local run";
  }
}

function humanizeRunPhase(phase: RunPhase["id"]) {
  return phase
    .replaceAll("_", " ")
    .replace(/\b\w/g, (value) => value.toUpperCase());
}

function inferSessionRisk(session: AgentRuntimeSession) {
  if (session.reviewGate?.recommendation === "do_not_apply") return "High";
  if (session.patchProposals.some((proposal) => proposal.riskLevel === "high")) return "High";
  if (session.patchProposals.some((proposal) => proposal.riskLevel === "medium")) return "Medium";
  return "Low";
}

function describeReviewReadiness(session: AgentRuntimeSession) {
  if (session.reviewGate) return humanizeReviewRecommendation(session.reviewGate.recommendation);
  if (session.status === "needs_approval") return "Review required";
  if (session.status === "completed") return "Ready";
  return "Not ready";
}

function humanizeReviewRecommendation(recommendation: NonNullable<AgentRuntimeSession["reviewGate"]>["recommendation"]) {
  switch (recommendation) {
    case "ready":
      return "Ready for apply review";
    case "caution":
      return "Caution";
    case "do_not_apply":
      return "Do not apply";
  }
}

function humanizeDecisionCategory(category: DecisionRecord["category"]) {
  return category.replace("_", " ");
}

function humanizeAgentStatus(status: AgentContractView["status"]) {
  switch (status) {
    case "idle":
      return "Idle";
    case "running":
      return "Running";
    case "completed":
      return "Done";
    case "blocked":
      return "Needs attention";
    case "failed":
      return "Failed";
  }
}

function buildAgentPanelUpdates(agent: AgentSidePanelAgentView) {
  if (agent.traceEntries.length) {
    return agent.traceEntries.slice(-8).reverse();
  }
  if (agent.workJournal.length) {
    return agent.workJournal.slice(-6).reverse().map((entry) => ({
      id: entry.id,
      title: entry.title,
      summary: entry.summary,
      meta: entry.filePath ? entry.filePath : entry.command ? entry.command : undefined,
      status: mapJournalStatus(entry.status)
    }));
  }

  return agent.recentActions.slice(-4).reverse().map((action, index) => ({
    id: `${agent.id}-recent-${index}`,
    title: action,
    summary: agent.currentAction,
    meta: agent.updatedAt ? formatRelativeDate(agent.updatedAt) : undefined,
    status: agent.status === "failed" ? "failed" : agent.status === "blocked" ? "blocked" : agent.status === "completed" ? "completed" : "running"
  }));
}

function buildAssignedPrompt(workerSpec: WorkerSpec | undefined, workOrder: WorkOrder | undefined) {
  if (!workerSpec && !workOrder) return undefined;
  const parts = [
    workerSpec?.persona,
    workerSpec?.objective,
    ...(workerSpec?.tasks ?? []),
    ...(workOrder?.acceptanceCriteria ?? [])
  ].filter(Boolean);
  return parts.join(" | ");
}

function buildAgentTraceEntries(
  agent: AgentContractView,
  handoffs: Array<NonNullable<NonNullable<AgentRuntimeSession["orchestration"]>["artifactHandoffs"]>[number]>
) {
  const journalEntries = agent.workJournal.map((entry) => ({
    id: entry.id,
    title: entry.title,
    summary: entry.summary,
    meta: entry.filePath ? entry.filePath : entry.command ? entry.command : undefined,
    status: mapJournalStatus(entry.status) as "running" | "completed" | "blocked" | "failed"
  }));
  const handoffEntries = handoffs.flatMap((handoff) =>
    handoff.details.map((detail, index) => ({
      id: `${handoff.id}-${index}`,
      title: handoff.summary,
      summary: detail,
      meta: handoff.patchProposalIds[0] ?? handoff.commandRequestIds[0],
      status: "completed" as const
    }))
  );
  return [...journalEntries, ...handoffEntries];
}

function isCoordinatorLikeAgent(name: string, role: string) {
  return /local run|coordinator|product orchestrator|business orchestrator|engineering orchestrator/i.test(name)
    || /senior coding agent|coordinator|product orchestrator|business orchestrator|engineering orchestrator/i.test(role);
}

function colorForAgent(agentId: string) {
  const palette = ["#5ea2ff", "#ff8a4c", "#67d58c", "#b27dff", "#ff6b6b", "#ffd166", "#6dd3ce"];
  let hash = 0;
  for (const char of agentId) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return palette[hash % palette.length]!;
}

function describeEvidenceRefs(evidenceRefs: EvidenceRef[]) {
  if (!evidenceRefs.length) return "None recorded";
  const hasLineOrSymbolRef = evidenceRefs.some((ref) => ref.type === "file" && (ref.lineHint || ref.lineStart || ref.lineEnd || ref.symbol || ref.componentName));
  const hasNonFileRef = evidenceRefs.some((ref) => ref.type !== "file");
  const notes = [hasLineOrSymbolRef ? "line or symbol refs included" : "line or symbol refs not reported yet"];
  if (hasNonFileRef) notes.push("command, test, or artifact refs included");
  return `${evidenceRefs.length} item(s); ${notes.join("; ")}`;
}

function describeRiskRefs(riskRefs: AgentRiskRef[]) {
  if (!riskRefs.length) return "None recorded";
  const severities = uniqueLabels(riskRefs.map((risk) => risk.severity));
  const lifecycleAreas = uniqueLabels(riskRefs.map((risk) => risk.lifecycleArea ?? ""));
  return `${riskRefs.length} item(s); severities: ${severities.join(", ")}${lifecycleAreas.length ? `; areas: ${lifecycleAreas.join(", ")}` : ""}`;
}

function humanizeAttributionConfidence(confidence: NonNullable<AgentRuntimeSession["reviewGate"]>["changesByAgent"][number]["confidence"] | undefined) {
  return confidence ? confidence.replaceAll("_", " ") : "Not reported yet.";
}

function humanizeDiffSource(source: "patch_unified_diff" | "run_summary" | "unknown" | undefined) {
  if (!source) return "Not reported yet.";
  if (source === "patch_unified_diff") return "Patch unified diff";
  if (source === "run_summary") return "Run summary";
  return "Unknown";
}

function humanizeJournalKind(kind: AgentWorkJournalEntry["kind"]) {
  return kind.replaceAll("_", " ");
}

function humanizeVerificationCheckStatus(status: AgentRuntimeSession["verificationResult"] extends infer T ? T extends { checks: Array<infer C> } ? C extends { status: infer S } ? S : never : never : never) {
  return humanizeUiStatus(String(status));
}

function describeReconciliation(report: AgentRuntimeSession["reconciliationReport"]) {
  if (!report) return "Not run yet.";
  const source =
    report.evidenceSource === "rust_git_snapshot"
      ? "rust git snapshot"
      : report.evidenceSource === "desktop_git_snapshot_bridge"
        ? "desktop git snapshot bridge"
        : report.evidenceSource === "unavailable"
          ? "git evidence unavailable"
          : "reconciliation source unknown";
  return `${report.status.replaceAll("_", " ")} | ${report.confidence} confidence | ${source}`;
}

function mapJournalStatus(status: AgentWorkJournalEntry["status"] | undefined) {
  if (status === "blocked") return "blocked";
  if (status === "failed") return "failed";
  if (status === "completed") return "completed";
  return "running";
}

function uniqueLabels(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function formatPatchTotalsLabel(fileCount?: number, additions?: number, deletions?: number) {
  const filesLabel = typeof fileCount === "number" ? `${fileCount} file(s)` : "File count not reported yet.";
  if (typeof additions === "number" && typeof deletions === "number") {
    return `${filesLabel}, +${additions} -${deletions}`;
  }
  return `${filesLabel}, line diff not reported yet.`;
}

function clampComposerScale(value: number) {
  return Math.min(MAX_COMPOSER_SCALE, Math.max(MIN_COMPOSER_SCALE, Number(value.toFixed(2))));
}

function clampSidebarWidth(value: number) {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(value)));
}

function isTauriDesktopRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

function getProviderCertification(provider: AgentRuntimeSession["providerTelemetry"]) {
  const fallbackModel = provider?.modelName ?? "unknown";
  const certification = provider?.modelCertification;
  const authorModel = certification?.authorModel ?? fallbackModel;
  return {
    authorModel,
    routerModel: certification?.routerModel ?? authorModel,
    verifierModel: certification?.verifierModel ?? fallbackModel,
    status: certification?.status ?? "uncertified",
    reason: certification?.reason,
    certifiedGates: certification?.certifiedGates ?? []
  };
}

function getReasoningTraceSummary(session: AgentRuntimeSession) {
  const trace = session.latestDecisionPipeline?.reasoningTrace;
  const progress = trace?.progress ?? [];
  const contextOmissions = trace?.contextOmissions ?? [];
  const verificationResults = trace?.verificationResults ?? [];
  const indexReadiness = trace?.indexReadiness
    ? `${trace.indexReadiness.before} -> ${trace.indexReadiness.after}`
    : "not checked";
  const budgetLabel = trace?.budget
    ? `${trace.budget.profile}: ${trace.providerCalls}/${trace.budget.maxProviderCalls} calls`
    : "none";
  return {
    toolRounds: trace?.toolRounds ?? 0,
    evidenceCount: trace?.evidenceRefs?.length ?? 0,
    informationGain: progress.reduce((total, entry) => total + (entry.informationGain ?? 0), 0),
    stagnantRounds: progress.filter((entry) => entry.stagnant).length,
    contextOmissions: contextOmissions.reduce((total, entry) => total + (entry.omittedEvidenceIds?.length ?? 0), 0),
    verifierVerdict: verificationResults.at(-1)?.verdict ?? "none",
    indexReadiness,
    budgetLabel
  };
}

function accessProfileLabel(profile: AccessProfile) {
  if (profile === "full_access") return "Full Access";
  if (profile === "bounded_autonomy" || profile === "auto_review") return "Bounded";
  return "Default";
}

function isAccessOptionSelected(profile: AccessProfile, option: AccessProfile) {
  if (option === "bounded_autonomy") return profile === "bounded_autonomy" || profile === "auto_review";
  if (option === "full_access") return profile === "full_access";
  return profile === "default_permissions" || profile === "custom_config";
}

export function mergeRuntimeSessionState(
  _current: AgentRuntimeSession | null,
  canonical: AgentRuntimeSession
): AgentRuntimeSession {
  return {
    ...canonical,
    messages: dedupeRuntimeRecords(canonical.messages ?? []),
    tasks: dedupeRuntimeRecords(canonical.tasks ?? []),
    toolCalls: dedupeRuntimeRecords(canonical.toolCalls ?? []),
    toolIntents: dedupeRuntimeRecords(canonical.toolIntents ?? []),
    artifacts: dedupeRuntimeRecords(canonical.artifacts ?? []),
    patchProposals: dedupeRuntimeRecords(canonical.patchProposals ?? []),
    commandRequests: dedupeRuntimeRecords(canonical.commandRequests ?? []),
    commandExecutions: dedupeRuntimeRecords(canonical.commandExecutions ?? []),
    backgroundJobs: dedupeRuntimeRecordsBy(canonical.backgroundJobs ?? [], (record) => record.jobId),
    progressEvents: dedupeRuntimeRecords(canonical.progressEvents ?? []),
    agentWorkStatuses: dedupeRuntimeRecordsBy(
      canonical.agentWorkStatuses ?? [],
      (record) => `${record.agentName}:${record.role}:${record.taskTitle}:${record.updatedAt}`
    )
  };
}

export function isTerminalOrOperatorHeldSession(session: Pick<AgentRuntimeSession, "status" | "lifecycleStage">) {
  return session.status === "completed"
    || session.status === "failed"
    || session.status === "failed_provider"
    || session.status === "blocked"
    || session.status === "needs_approval"
    || session.status === "expired"
    || session.lifecycleStage === "BLOCKED"
    || session.lifecycleStage === "FAILED"
    || session.lifecycleStage === "DONE";
}

function dedupeRuntimeRecords<T extends { id: string }>(records: T[]): T[] {
  return dedupeRuntimeRecordsBy(records, (record) => record.id);
}

function dedupeRuntimeRecordsBy<T>(records: T[], getKey: (record: T) => string): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const record of records) {
    const key = getKey(record);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(record);
  }
  return deduped;
}

function humanSessionStatus(
  session: AgentRuntimeSession | null,
  agentBusy = false,
  connectionState: "connected" | "disconnected" = "connected"
) {
  if (!session) return "Open a workspace to begin";
  if (connectionState === "disconnected" && session.status === "running") return "Live updates disconnected";
  if (agentBusy && !isTerminalOrOperatorHeldSession(session)) return "Working on your request";

  switch (session.nextAction?.kind) {
    case "clarify_plan":
      return "Plan clarification needed";
    case "confirm_plan":
      return "Plan review required";
    case "confirm_preview":
      return "Preview launch pending";
    case "preview_ready":
      return "Preview available";
    case "approve_commands":
      return "Waiting on command approval";
    case "await_baseline_command":
      return "Waiting on baseline command";
    default:
      break;
  }

  const restoreDisposition = session.taskState?.restoreState?.disposition;
  if (restoreDisposition === "corrupt") return "Restore history is corrupt";
  if (restoreDisposition === "non_restorable") return "Restore unavailable";
  if (restoreDisposition === "reconciliation_required") return "Manual inspection required";
  if (restoreDisposition === "expired") return "Expired";
  if (session.status === "expired") return "Expired";
  if (session.status === "blocked" || session.lifecycleStage === "BLOCKED") {
    return "Needs attention";
  }
  if (session.status === "needs_approval") return "Waiting for operator review";
  if (session.status === "completed") return "Done";
  if (session.status === "running") return "Working on your request";
  if (session.status === "failed_provider") return "Provider failed";
  if (session.status === "failed") return "Run failed";
  return "Session active";
}

function describeOperatorHeadline(session: AgentRuntimeSession, connectionState: "connected" | "disconnected") {
  if (connectionState === "disconnected" && session.status === "running") {
    return "The run may still be active, but the live event stream is disconnected.";
  }
  if (session.nextAction?.kind === "clarify_plan") {
    return "Plan mode needs one clarification before it locks the plan.";
  }
  if (session.nextAction?.kind === "approve_commands") {
    return "Runtime commands are queued and waiting for operator execution.";
  }
  if (session.nextAction?.kind === "await_baseline_command") {
    return "A baseline test command must run to ground planning evidence.";
  }
  if (session.status === "blocked" || session.lifecycleStage === "BLOCKED") {
    return session.runToGreen?.blockerReason ?? "The run needs attention before it can continue.";
  }
  if (session.status === "failed_provider") {
    return "The real provider failed or was unavailable, and no mock response was used.";
  }
  if (session.patchProposals.some((proposal) => proposal.status === "approved")) {
    return "A reviewed patch is waiting for explicit apply.";
  }
  if (session.patchProposals.some((proposal) => proposal.status === "apply_started")) {
    return "Rust patch apply has started; no applied claim is available yet.";
  }
  if (session.patchProposals.some((proposal) => proposal.status === "proposed")) {
    return "Code changes are proposed but not written yet.";
  }
  if (session.verificationResult?.status === "pending" || session.verificationResult?.status === "running") {
    return "Writes may be complete, but verification is still pending.";
  }
  if (session.reconciliationReport?.status === "diverged") {
    return "The patch was applied, but post-apply reconciliation diverged from the reviewed patch.";
  }
  if (session.reconciliationReport?.status === "unavailable") {
    return "The patch was applied, but reconciliation evidence is unavailable and needs manual inspection.";
  }
  return "This card summarizes what has happened, what is still pending, and what the UI can safely promise.";
}

function describeRestoreTruth(session: AgentRuntimeSession, canReconnect: boolean) {
  const restoreState = session.taskState?.restoreState;
  if (restoreState?.source === "event_replayed") {
    if (restoreState.disposition === "reconciliation_required") {
      return "Restored from durable events, but manual inspection is still required before trusting the run.";
    }
    if (restoreState.disposition === "corrupt" || restoreState.disposition === "non_restorable") {
      return "Durable event replay found this session, but it is not safely restorable as an active run.";
    }
    return "Restored from durable runtime events.";
  }
  if (restoreState?.source === "snapshot_restored") {
    return "Restored from sessions.json snapshot fallback; not event-replay authoritative yet.";
  }
  return canReconnect
    ? "This app session can still try a live reconnect while the runtime token remains valid."
    : "Saved sessions are history only after restart; no guaranteed live restore path.";
}

function describePatchState(session: AgentRuntimeSession) {
  if (session.patchProposals.some((proposal) => proposal.status === "proposed")) {
    return "Patch review required before any write occurs.";
  }
  if (session.patchProposals.some((proposal) => proposal.status === "approved")) {
    return "Patch approved, but Rust apply has not happened yet.";
  }
  if (session.patchProposals.some((proposal) => proposal.status === "apply_started")) {
    return "Rust patch apply is in progress; files are not reported as applied yet.";
  }
  if (session.patchProposals.some((proposal) => proposal.status === "apply_failed")) {
    return "A patch apply attempt failed; inspect the summary artifacts before retrying.";
  }
  if (session.patchProposals.some((proposal) => proposal.status === "applied")) {
    return "At least one patch was applied through Rust.";
  }
  return "No patch write is pending.";
}

function describeCommandState(session: AgentRuntimeSession) {
  if (session.runToGreen?.status === "blocked" && !session.commandExecutions.length) {
    return session.previewRecommendation
      ? "No grounded command was selected, but a preview is available."
      : "No grounded command was selected, so there is nothing safe to run automatically yet.";
  }
  if (session.commandRequests.some((request) => request.status === "requested" || request.status === "approved" || request.status === "executing" || request.status === "running")) {
    return "One or more runtime commands are waiting for approval or execution.";
  }
  const latestExecution = session.commandExecutions.at(-1);
  if (latestExecution) {
    return `Latest runtime command is recorded as ${humanizeCommandResultStatus(latestExecution.status)}.`;
  }
  return "No runtime command is pending.";
}

function describeVerificationState(session: AgentRuntimeSession) {
  if (!session.verificationResult) return "No verification record yet.";
  if (session.verificationResult.truthStatus && session.verificationResult.truthStatus !== "verified_passed") {
    const labels = {
      verified_failed: "Verification failed after an executed command.",
      unverified: "Unverified: no completed validation command proves success.",
      not_run_blocked_by_policy: "Unverified: validation was blocked by command policy.",
      not_run_needs_approval: "Unverified: validation needs approval and did not run.",
      not_run_runtime_error: "Unverified: validation did not run because of a runtime error.",
      not_run_missing_command: "Unverified: no validation command was selected."
    } as const;
    return labels[session.verificationResult.truthStatus];
  }
  if (session.verificationResult.truthStatus === "verified_passed") return "Verification passed after an executed validation command.";
  if (session.runToGreen?.status === "blocked" && (session.verificationResult.status === "unavailable" || session.verificationResult.status === "skipped")) {
    return session.runToGreen.blockerReason
      ? `Verification was not started yet: ${session.runToGreen.blockerReason}`
      : "Verification was not started because the run could not continue automatically.";
  }
  if (session.verificationResult.status === "pending" || session.verificationResult.status === "running") return "Verification is still pending.";
  if (session.verificationResult.status === "failed") return "Verification failed; inspect the checks before trusting the output.";
  if (session.verificationResult.status === "unavailable") return "Verification evidence is unavailable; manual inspection is still required.";
  if (session.verificationResult.status === "skipped") return "Verification was skipped; review the reconciliation and diff before trusting the output.";
  return "Verification passed for the recorded checks.";
}

function describeProviderTruth(session: AgentRuntimeSession) {
  const truth = session.providerTelemetry;
  if (!truth) return "No provider telemetry recorded yet.";
  return `provider | ${truth.providerName}${truth.modelName ? `/${truth.modelName}` : ""} | calls ${truth.providerRequestCount}/${truth.providerResponseCount}/${truth.providerFailureCount}/${truth.providerTimeoutCount} req/res/err/timeout | reasoning ${truth.reasoningAttempts} | repairs ${truth.repairAttempts} | final ${truth.finalResponseSource} | prompt ${formatCount(truth.totalProviderPromptChars ?? 0)} chars | response ${formatCount(truth.totalProviderResponseChars ?? 0)} chars`;
}

function describePlanningProviderRequest(session: AgentRuntimeSession) {
  const gate = session.runSummary?.gates.find((item) => item.name === "Planning provider request");
  if (gate) {
    const note = gate.notes[0] ? `: ${gate.notes[0]}` : "";
    if (/operator-supplied implementation plan/i.test(gate.notes.join(" "))) return `skipped, operator-supplied plan used${note}`;
    if (gate.status === "blocked") return `not attempted${note}`;
    if (gate.status === "failed") return `attempted, ${gate.status}${note}`;
    return `${gate.status}${note}`;
  }
  const requestCount = session.providerTelemetry?.providerRequestCount;
  if (requestCount === undefined) return "not recorded yet";
  return requestCount > 0 ? `attempted (${requestCount})` : "not attempted";
}

function describeSseState(state: RuntimeEventSubscriptionState, canReconnect: boolean) {
  if (state.tokenExpired) return "token_expired";
  if (state.unauthorized) return "unauthorized";
  if (state.connected) return `connected${state.lastEventAt ? `, last event ${formatOptionalTimestamp(state.lastEventAt)}` : ""}`;
  if (state.reconnecting) return canReconnect ? `reconnecting${state.nextRetryAt ? `, next ${formatOptionalTimestamp(state.nextRetryAt)}` : ""}` : "disconnected, no reconnect token";
  if (state.status === "connecting") return "connecting";
  return canReconnect ? "disconnected" : "disconnected, no reconnect token";
}

function formatOptionalTimestamp(value: string | undefined) {
  if (!value) return "never";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  });
}

function formatCount(value: number) {
  return new Intl.NumberFormat().format(value);
}

function sessionStatusTruth(session: AgentRuntimeSession): { label: string; kind: "running" | "completed" | "blocked" | "failed" } {
  if (session.status === "completed") return { label: "Session completed", kind: "completed" };
  if (session.status === "failed_provider") return { label: "Provider failed", kind: "failed" };
  if (session.status === "failed") return { label: "Session failed", kind: "failed" };
  if (session.status === "expired") return { label: "Session expired", kind: "failed" };
  if (session.status === "blocked") return { label: "Session blocked", kind: "blocked" };
  if (session.status === "needs_approval") return { label: "Review required", kind: "blocked" };
  if (session.status === "running") return { label: "Session running", kind: "running" };
  return { label: `Session ${humanizeRuntimeStatus(session.status)}`, kind: "running" };
}

function describeEvidenceTruth(session: AgentRuntimeSession) {
  const report = session.evidenceReport;
  if (!report) return "No inspect evidence report recorded yet.";
  const used = report.finalEvidenceFilesActuallyUsed.slice(0, 3).join(", ");
  return `${report.finalEvidenceFilesActuallyUsed.length} file(s) used${used ? `: ${used}` : ""}; ${report.generatedEvidenceExcludedCount} generated/runtime candidate(s) excluded.`;
}

function describeAuditTrail(session: AgentRuntimeSession) {
  const previewArtifacts = session.artifacts.filter((artifact) => artifact.type === "preview").length;
  const verificationArtifacts = session.artifacts.filter((artifact) => artifact.type === "verification").length;
  const commandArtifacts = session.artifacts.filter((artifact) => artifact.type === "command_result").length;
  return `${session.artifacts.length} artifact record(s), ${commandArtifacts} command result(s), ${verificationArtifacts} verification record(s), ${previewArtifacts} preview record(s).`;
}

function humanizeRuntimeStatus(status: string) {
  switch (status) {
    case "blocked":
      return "needs attention";
    case "failed_provider":
      return "provider failed";
    case "needs_approval":
      return "waiting for review";
    case "completed":
      return "completed";
    case "running":
      return "running";
    case "failed":
      return "failed";
    case "expired":
      return "expired";
    case "token_expired":
      return "token expired";
    case "unauthorized":
      return "unauthorized";
    case "reconnecting":
      return "reconnecting";
    case "disconnected":
      return "disconnected";
    case "connected":
      return "connected";
    case "created":
      return "created";
    default:
      return humanizeUiStatus(status);
  }
}

function humanizeLifecycleStage(stage: string) {
  return stage.toLowerCase().replaceAll("_", " ");
}

function humanizePatchStatus(status: string) {
  return status.replaceAll("_", " ");
}

function humanizeCommandRequestStatus(status: string) {
  if (status === "requested") return "requested, not executed";
  if (status === "executing") return "running";
  return humanizeUiStatus(status);
}

function humanizeCommandResultStatus(status: string) {
  return status === "approval_required" ? "approval required" : humanizeUiStatus(status);
}

function humanizeUiStatus(status: string) {
  if (status === "blocked") return "needs attention";
  return status.replaceAll("_", " ");
}

function describeCommandRequestProvenance(session: AgentRuntimeSession, request: CommandRequest) {
  const latestExecution = session.commandExecutions.find((candidate) => candidate.requestId === request.id);
  const approval = latestExecution?.provenance?.approvalSource ?? request.provenance?.approvalSource ?? "unknown";
  const policy = latestExecution?.provenance?.policyDecision ?? request.provenance?.policyDecision ?? "unknown";
  const background = latestExecution?.provenance?.background ?? request.provenance?.background;
  return `approval: ${approval.replaceAll("_", " ")} | policy: ${policy.replaceAll("_", " ")}${background ? " | background tracking limited" : ""}`;
}

function describeCommandExecutionProvenance(execution: AgentRuntimeSession["commandExecutions"][number]) {
  const approval = execution.provenance?.approvalSource ?? "unknown";
  const policy = execution.provenance?.policyDecision ?? "unknown";
  const detection = execution.provenance?.detectionSource ?? "unknown";
  return `approval: ${approval.replaceAll("_", " ")} | policy: ${policy.replaceAll("_", " ")} | detection: ${detection.replaceAll("_", " ")} | cwd: ${execution.cwd}`;
}

function summarizeLatestQueueEntry(entry: QueuedPrompt | undefined) {
  if (!entry) return "";
  const compact = entry.text.replace(/\s+/g, " ").trim();
  return compact.length > 58 ? `${compact.slice(0, 58)}...` : compact;
}

function formatTerminalResult(result: CommandResult) {
  return [
    `$ ${result.command}`,
    `cwd: ${result.cwd}`,
    `risk: ${result.risk} status: ${result.status}${typeof result.exitCode === "number" ? ` exit=${result.exitCode}` : ""}`,
    result.provenance
      ? `approval: ${(result.provenance.approvalSource ?? "unknown").replaceAll("_", " ")} | policy: ${(result.provenance.policyDecision ?? "unknown").replaceAll("_", " ")} | detection: ${(result.provenance.detectionSource ?? "unknown").replaceAll("_", " ")}`
      : "",
    result.diagnosis ? `diagnosis: ${result.diagnosis.category} | ${result.diagnosis.summary}` : "",
    result.diagnosis?.nextStep ? `next: ${result.diagnosis.nextStep}` : "",
    result.backgroundJob ? `background job: ${result.backgroundJob.status}${result.backgroundJob.processId ? ` pid=${result.backgroundJob.processId}` : ""}` : "",
    normalizeTerminalText(result.message ?? ""),
    normalizeTerminalText(result.stdout),
    normalizeTerminalText(result.stderr)
  ]
    .filter(Boolean)
    .join("\n");
}

function commandSafetySettings(settings: SafetySettings) {
  return {
    blockDangerousCommands: settings.blockDangerousCommands,
    redactSecrets: settings.redactSecrets,
    allowNetworkCommands: settings.allowNetworkCommands,
    autoRunMediumCommands: settings.autoRunMediumCommands,
    autoRunBackgroundCommands: settings.autoRunBackgroundCommands,
    autoRunNetworkCommands: settings.autoRunNetworkCommands
  };
}

async function applyRuntimePatchWithRetry(sessionId: string, patchId: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await applyRuntimePatch(sessionId, patchId);
    } catch (error) {
      lastError = error;
      if (!/proposal_not_found|Patch proposal not found/i.test(String(error))) break;
      await new Promise((resolve) => window.setTimeout(resolve, 150));
    }
  }
  throw lastError;
}

async function persistPatchApprovalForRust(sessionId: string, proposal: AgentRuntimeSession["patchProposals"][number]) {
  try {
    await appendSessionEvent(sessionId, "runtime.patch.proposed", {
      type: "runtime.patch.proposed",
      sessionId,
      proposal: { ...proposal, status: "proposed" }
    });
  } catch {
    // Session might not be mirrored to Rust yet; non-critical projection will retry.
  }
  try {
    await appendSessionEvent(sessionId, "runtime.patch.approved", {
      type: "runtime.patch.approved",
      sessionId,
      proposal: { ...proposal, status: "approved" }
    });
  } catch {
    // Session might not be mirrored to Rust yet; non-critical projection will retry.
  }
}

function normalizeTerminalText(text: string) {
  if (!text) return "";
  return text.replace(
    /Serving HTTP on :: port (\d+) \(http:\/\/\[\:\:\]:(\d+)\/\) \.\.\./g,
    (_match, shownPort, urlPort) =>
      `Serving HTTP on port ${shownPort}.\nLocal preview: http://127.0.0.1:${urlPort}/\nOriginal server output: http://[::]:${urlPort}/`
  );
}

function shouldDescribeBackground(command: string) {
  return /\b(dev|serve|http\.server|vite|next dev|react-scripts start)\b/i.test(command);
}

function readStoredJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function legacyStorageKey(key: string) {
  return key.replace(/^hivo\./, "orchcode.");
}

function migrateLegacyStorageKeys() {
  for (const key of MIGRATED_STORAGE_KEYS) {
    if (localStorage.getItem(key) !== null) continue;
    const legacyValue = localStorage.getItem(legacyStorageKey(key));
    if (legacyValue !== null) {
      localStorage.setItem(key, legacyValue);
    }
  }
}

function pruneExpiredSessionTokens(tokens: Record<string, StoredSessionToken>) {
  const now = Date.now();
  return Object.fromEntries(
    Object.entries(tokens).filter(([, value]) => {
      const expiresAt = Date.parse(value.expiresAt);
      return Number.isFinite(expiresAt) && expiresAt > now;
    })
  );
}

function getPersistedSessionToken(tokens: Record<string, StoredSessionToken>, sessionId: string) {
  const record = tokens[sessionId];
  if (!record) return undefined;
  const expiresAt = Date.parse(record.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return undefined;
  return record;
}

function HivoMascot({ visible, raised }: { visible: boolean; raised: boolean }) {
  if (!visible) return null;
  return (
    <div className={`hivo-mascot ${raised ? "raised" : ""}`} aria-hidden="true">
      <img src="/hivo-icon.png" alt="" />
    </div>
  );
}

function persistRecentWorkspaces(entries: RecentWorkspaceEntry[]) {
  localStorage.setItem(RECENT_WORKSPACES_KEY, JSON.stringify(entries));
}

function persistRecentSessions(entries: RecentSessionEntry[]) {
  localStorage.setItem(RECENT_SESSIONS_KEY, JSON.stringify(entries));
}

function upsertRecentWorkspace(
  current: RecentWorkspaceEntry[],
  workspace: WorkspaceInfo,
  sessionId?: string
) {
  const nextEntry: RecentWorkspaceEntry = {
    path: workspace.path,
    name: workspace.name,
    lastOpenedAt: new Date().toISOString(),
    lastSessionId: sessionId
  };
  return [nextEntry, ...current.filter((entry) => entry.path !== workspace.path)].slice(0, MAX_RECENT_WORKSPACES);
}

function upsertRecentSession(
  current: RecentSessionEntry[],
  session: AgentRuntimeSession,
  workspace: WorkspaceInfo
) {
  const existingEntry = current.find((entry) => entry.id === session.id);
  const derivedTitle = deriveDisplaySessionTitle(session, existingEntry?.title);
  if (!derivedTitle) {
    return current.filter((entry) => entry.id !== session.id).slice(0, MAX_RECENT_SESSIONS);
  }
  const nextEntry: RecentSessionEntry = {
    id: session.id,
    workspacePath: workspace.path,
    workspaceName: workspace.name,
    title: derivedTitle,
    status: humanSessionStatus(session, false),
    updatedAt: session.updatedAt
  };
  return [nextEntry, ...current.filter((entry) => entry.id !== session.id)].slice(0, MAX_RECENT_SESSIONS);
}

function deriveSessionTitle(session: AgentRuntimeSession, fallbackTitle?: string) {
  const displayTitle = deriveDisplaySessionTitle(session, fallbackTitle);
  return truncateSessionLabel(displayTitle || "Hivo", 42);
}

function deriveDisplaySessionTitle(session: AgentRuntimeSession, fallbackTitle?: string) {
  const assistantLine = session.messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.content.split("\n"))
    .map((line) => normalizeSessionTitleCandidate(line))
    .find((line) => line.length > 0 && !isLowSignalSessionTitleCandidate(line));
  const candidates = [
    assistantLine,
    session.runSummary?.summary,
    session.plan?.summary,
    fallbackTitle
  ]
    .map((value) => normalizeSessionTitleCandidate(value))
    .filter(Boolean);
  const preferredCandidate = candidates.find((value) => !isLowSignalSessionTitleCandidate(value)) ?? "";
  return preferredCandidate ? truncateSessionLabel(preferredCandidate, 42) : "";
}

function normalizeSessionTitleCandidate(value: string | null | undefined) {
  return (value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^#+\s*/, "")
    .replace(/^[-*]\s*/, "")
    .replace(/^(chat|session)?\s*title\s*[:：-]\s*/i, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim() ?? "";
}

function isLowSignalSessionTitleCandidate(value: string) {
  if (!value) return true;
  return [
    /^use a deterministic\b/i,
    /^working on your request\b/i,
    /^completed\b/i,
    /^reload\b/i,
    /^reloaded\b/i,
    /^hot reload\b/i,
    /^verification passed\b/i,
    /^preview available\b/i,
    /^explain\b/i,
    /^analyze\b/i,
    /^fix\b/i,
    /^edit\b/i,
    /^update\b/i,
    /^اشرح\b/i,
    /^حلل\b/i,
    /^صلح\b/i,
    /^عدل\b/i,
    /^i (inspected|selected|prepared|could not)\b/i,
    /^select a workspace\b/i,
    /^workspace open\b/i,
    /^full access\b/i,
    /\bappears to be a\b.*\bworkspace\b/i,
    /\bworkspace with \d+ scanned file\(s\)\b/i,
    /\bmain areas:\b/i
  ].some((pattern) => pattern.test(value));
}

function shouldBackfillSessionTitle(value: string) {
  return !value || value === "Hivo" || isLowSignalSessionTitleCandidate(value);
}

function truncateSessionLabel(value: string, max = 42) {
  const wordLimitedValue = limitSessionTitleWords(value);
  return wordLimitedValue.length > max ? `${wordLimitedValue.slice(0, max - 3).trimEnd()}...` : wordLimitedValue;
}

function limitSessionTitleWords(value: string, maxWords = MAX_SESSION_TITLE_WORDS) {
  const words = value.trim().split(/\s+/).filter(Boolean);
  return words.length > maxWords ? words.slice(0, maxWords).join(" ") : value.trim();
}

function truncateLabel(value: string, max = 42) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function pathBasename(targetPath: string) {
  const compact = normalizeWorkspacePath(targetPath).replaceAll("\\", "/").replace(/\/$/, "");
  return compact.split("/").pop() || compact;
}

function buildFileExplorerTree(files: FileEntry[], filter: string) {
  const normalizedFilter = filter.trim().toLowerCase();
  const root: FileTreeNode = {
    key: ".",
    name: ".",
    path: ".",
    isDir: true,
    children: []
  };
  const nodeMap = new Map<string, FileTreeNode>([[".", root]]);

  const relevantFiles = files
    .filter((entry) => (normalizedFilter ? entry.path.toLowerCase().includes(normalizedFilter) : true))
    .sort((left, right) => left.path.localeCompare(right.path));

  for (const entry of relevantFiles) {
    const parts = entry.path.split("/").filter(Boolean);
    if (!parts.length) continue;
    let currentPath = ".";
    let parent = root;
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index]!;
      const nextPath = currentPath === "." ? name : `${currentPath}/${name}`;
      const isLeaf = index === parts.length - 1;
      let node = nodeMap.get(nextPath);
      if (!node) {
        node = {
          key: nextPath,
          name,
          path: nextPath,
          isDir: isLeaf ? entry.isDir : true,
          children: []
        };
        nodeMap.set(nextPath, node);
        parent.children.push(node);
      }
      if (!isLeaf) node.isDir = true;
      parent = node;
      currentPath = nextPath;
    }
  }

  const sortChildren = (nodes: FileTreeNode[]) => {
    nodes.sort((left, right) => {
      if (left.isDir && !right.isDir) return -1;
      if (!left.isDir && right.isDir) return 1;
      return left.name.localeCompare(right.name);
    });
    for (const node of nodes) {
      if (node.children.length) sortChildren(node.children);
    }
  };

  sortChildren(root.children);
  return root.children;
}

function defaultExpandedExplorerDirs(files: FileEntry[]) {
  const expanded = new Set<string>();
  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    if (parts.length > 1) {
      expanded.add(parts[0]!);
    }
    if (parts.length > 2) {
      expanded.add(`${parts[0]!}/${parts[1]!}`);
    }
  }
  return [...expanded];
}

function containsArabic(value: string) {
  return /[\u0600-\u06FF]/.test(value);
}

function shouldSuggestPlanMode(prompt: string, planModeEnabled: boolean) {
  if (planModeEnabled) return false;
  const compact = prompt.trim();
  if (!compact) return false;
  if (compact.length >= 160) return true;
  return /\b(plan|review|analyze|understand|architecture|approach)\b/i.test(compact)
    || /(خطة|حلل|راجع|افهم|معمارية|اقترح)/.test(compact);
}

function buildSidebarProjects(input: {
  workspace: WorkspaceInfo | null;
  runtimeSession: AgentRuntimeSession | null;
  recentWorkspaces: RecentWorkspaceEntry[];
  recentSessions: RecentSessionEntry[];
  pinnedSessionIds: string[];
  agentBusy: boolean;
  runtimeConnectionState: "connected" | "disconnected";
}) {
  const pinnedSessionIdSet = new Set(input.pinnedSessionIds);
  const grouped = new Map<string, {
    path: string;
    name: string;
    lastOpenedAt: string;
    isActive: boolean;
    sessions: RecentSessionEntry[];
  }>();

  for (const workspaceEntry of input.recentWorkspaces) {
    grouped.set(workspaceEntry.path, {
      path: workspaceEntry.path,
      name: workspaceEntry.name,
      lastOpenedAt: workspaceEntry.lastOpenedAt,
      isActive: workspaceEntry.path === input.workspace?.path,
      sessions: []
    });
  }

  if (input.workspace) {
    grouped.set(input.workspace.path, {
      path: input.workspace.path,
      name: input.workspace.name,
      lastOpenedAt: new Date().toISOString(),
      isActive: true,
      sessions: grouped.get(input.workspace.path)?.sessions ?? []
    });
  }

  for (const sessionEntry of input.recentSessions) {
    const sidebarSessionEntry = {
      ...sessionEntry,
      title: truncateSessionLabel(sessionEntry.title)
    };
    const existing = grouped.get(sessionEntry.workspacePath);
    if (existing) {
      existing.sessions.push(sidebarSessionEntry);
      existing.lastOpenedAt = existing.lastOpenedAt > sessionEntry.updatedAt ? existing.lastOpenedAt : sessionEntry.updatedAt;
    } else {
      grouped.set(sessionEntry.workspacePath, {
        path: sessionEntry.workspacePath,
        name: sessionEntry.workspaceName,
        lastOpenedAt: sessionEntry.updatedAt,
        isActive: sessionEntry.workspacePath === input.workspace?.path,
        sessions: [sidebarSessionEntry]
      });
    }
  }

  if (input.runtimeSession && input.workspace) {
    const existingActiveEntry = grouped.get(input.workspace.path)?.sessions.find((entry) => entry.id === input.runtimeSession?.id);
    const activeTitle = deriveDisplaySessionTitle(input.runtimeSession, existingActiveEntry?.title);
    const activeEntry: RecentSessionEntry = {
      id: input.runtimeSession.id,
      workspacePath: input.workspace.path,
      workspaceName: input.workspace.name,
      title: activeTitle || "Hivo",
      status: humanSessionStatus(input.runtimeSession, input.agentBusy, input.runtimeConnectionState),
      updatedAt: input.runtimeSession.updatedAt
    };
    const project = grouped.get(input.workspace.path);
    if (project && activeTitle) {
      project.sessions = [activeEntry, ...project.sessions.filter((entry) => entry.id !== activeEntry.id)];
      project.isActive = true;
      project.lastOpenedAt = activeEntry.updatedAt;
    }
  }

  return [...grouped.values()]
    .map((project) => ({
      ...project,
      sessions: project.sessions
        .filter((entry, index, array) => array.findIndex((candidate) => candidate.id === entry.id) === index)
        .sort((left, right) => {
          const leftPinned = pinnedSessionIdSet.has(left.id);
          const rightPinned = pinnedSessionIdSet.has(right.id);
          if (leftPinned && !rightPinned) return -1;
          if (!leftPinned && rightPinned) return 1;
          return right.updatedAt.localeCompare(left.updatedAt);
        })
    }))
    .sort((left, right) => {
      if (left.isActive && !right.isActive) return -1;
      if (!left.isActive && right.isActive) return 1;
      return right.lastOpenedAt.localeCompare(left.lastOpenedAt);
    });
}

function formatRelativeDate(value: string) {
  const delta = Date.now() - Date.parse(value);
  if (!Number.isFinite(delta)) return "";
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
}

function formatMessageTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit"
  });
}

function shortenPath(targetPath: string) {
  const compact = targetPath.replaceAll("\\", "/");
  return compact.length > 28 ? `...${compact.slice(-28)}` : compact;
}

function normalizeWorkspacePath(targetPath: string) {
  return targetPath.startsWith("\\\\?\\") ? targetPath.slice(4) : targetPath;
}

function isSafeRelativeFilePath(targetPath: string) {
  const normalized = targetPath.replaceAll("\\", "/");
  return Boolean(normalized)
    && !normalized.startsWith("/")
    && !/^[A-Za-z]:/.test(normalized)
    && !normalized.split("/").some((part) => part === ".." || part === "");
}

function SettingsDialog({
  currentConfig,
  hivoPetVisible,
  onHivoPetVisibleChange,
  onClose,
  onSaved,
  onCleared
}: {
  currentConfig: ModelProviderConfig | null;
  hivoPetVisible: boolean;
  onHivoPetVisibleChange: (visible: boolean) => void;
  onClose: () => void;
  onSaved: (config: ModelProviderConfig) => void;
  onCleared: () => void;
}) {
  const [form, setForm] = useState<ModelProviderConfigInput>(() =>
    currentConfig
      ? {
        id: currentConfig.id,
        providerType: currentConfig.providerType,
        providerName: currentConfig.providerName,
        baseUrl: currentConfig.baseUrl,
        selectedModel: currentConfig.selectedModel,
        routerModel: currentConfig.routerModel ?? "",
        verifierModel: currentConfig.verifierModel ?? "",
        embeddingModel: currentConfig.embeddingModel ?? "",
        apiKey: ""
      }
      : defaultProviderForm
  );
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [status, setStatus] = useState<ModelProviderConfig | null>(currentConfig);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function applyPreset(preset: ProviderPreset) {
    setForm((current) => ({
      ...current,
      providerType: preset.providerType,
      providerName: preset.providerName,
      baseUrl: preset.baseUrl,
      selectedModel: preset.providerType === "ollama" ? "" : current.selectedModel
    }));
    setModels([]);
    setError("");
  }

  async function refreshModels() {
    setBusy(true);
    setError("");
    try {
      const nextModels = await listAvailableModels(form);
      setModels(nextModels);
      if (nextModels.length === 0) {
        setError("No models were returned by the provider.");
      } else if (!form.selectedModel) {
        setForm((current) => ({ ...current, selectedModel: nextModels[0]?.name ?? "" }));
      }
    } catch (refreshError) {
      setError(String(refreshError));
    } finally {
      setBusy(false);
    }
  }

  async function validate() {
    setBusy(true);
    setError("");
    try {
      const result = await validateModelProvider(form);
      setStatus(result);
      if (!result.isValid) {
        setError(result.lastValidationError ?? "Provider is invalid.");
      }
    } catch (validationError) {
      setError(String(validationError));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setError("");
    try {
      const result = await saveModelProviderConfig(form);
      setStatus(result);
      onSaved(result);
      if (!result.isValid) {
        setError(result.lastValidationError ?? "Provider saved but is invalid.");
      }
    } catch (saveError) {
      setError(String(saveError));
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    try {
      await clearModelProviderConfig();
      setStatus(null);
      setForm(defaultProviderForm);
      setModels([]);
      onCleared();
    } catch (clearError) {
      setError(String(clearError));
    } finally {
      setBusy(false);
    }
  }

  const isOllama = form.providerType === "ollama";

  return (
    <div className="modal-backdrop">
      <div className="settings-modal">
        <div className="modal-title">
          <div>
            <h2>Model Provider Settings</h2>
            <p>Use local Ollama for real coding runs. Recommended models: qwen2.5-coder:7b, llama3:8b, or your saved custom Ollama model.</p>
          </div>
          <button className="frame-icon-button" title="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <section className="settings-preferences">
          <h3>Hivo</h3>
          <label className="toggle-setting">
            <span>Show Hivo pet</span>
            <input
              type="checkbox"
              checked={hivoPetVisible}
              onChange={(event) => onHivoPetVisibleChange(event.target.checked)}
            />
          </label>
        </section>

        <div className="preset-grid">
          {providerPresets.map((preset) => (
            <button key={preset.label} onClick={() => applyPreset(preset)}>
              {preset.label}
            </button>
          ))}
        </div>

        <div className="settings-grid">
          <label>
            Provider type
            <select
              value={form.providerType}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  providerType: event.target.value as ModelProviderType
                }))
              }
            >
              <option value="ollama">Ollama local provider</option>
              <option value="openai_compatible">OpenAI-compatible cloud/private provider</option>
            </select>
          </label>

          <label>
            Provider name
            <input
              value={form.providerName}
              onChange={(event) => setForm((current) => ({ ...current, providerName: event.target.value }))}
            />
          </label>

          <label>
            Base URL
            <input
              value={form.baseUrl}
              onChange={(event) => setForm((current) => ({ ...current, baseUrl: event.target.value }))}
            />
          </label>

          {!isOllama ? (
            <label>
              API key
              <input
                type="password"
                value={form.apiKey ?? ""}
                onChange={(event) => setForm((current) => ({ ...current, apiKey: event.target.value }))}
                placeholder="Stored securely in a future module"
              />
            </label>
          ) : null}

          <label>
            Selected model
            {models.length > 0 ? (
              <select
                value={form.selectedModel}
                onChange={(event) => setForm((current) => ({ ...current, selectedModel: event.target.value }))}
              >
                {models.map((model) => (
                  <option key={model.id} value={model.name}>
                    {model.name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={form.selectedModel}
                onChange={(event) => setForm((current) => ({ ...current, selectedModel: event.target.value }))}
                placeholder={isOllama ? "qwen2.5-coder:7b or llama3:8b" : "OpenAI-compatible execution is not available yet"}
              />
            )}
          </label>

          <label>
            Router model
            <input
              value={form.routerModel ?? ""}
              onChange={(event) => setForm((current) => ({ ...current, routerModel: event.target.value }))}
              placeholder="Defaults to selected model"
            />
            <small>Optional fast model for turn understanding and route decisions.</small>
          </label>

          <label>
            Verifier model
            <input
              value={form.verifierModel ?? ""}
              onChange={(event) => setForm((current) => ({ ...current, verifierModel: event.target.value }))}
              placeholder="Defaults to selected model"
            />
            <small>Optional independent model for claim and evidence verification.</small>
          </label>

          <label>
            Embedding model
            <input
              value={form.embeddingModel ?? ""}
              onChange={(event) => setForm((current) => ({ ...current, embeddingModel: event.target.value }))}
              placeholder={isOllama ? "nomic-embed-text" : "text-embedding-3-small"}
            />
            <small>Required only for deep project-understanding questions.</small>
          </label>
        </div>

        <div className="settings-actions">
          <button onClick={refreshModels} disabled={busy}>
            <RefreshCw size={15} />
            {isOllama ? "Refresh Ollama Models" : "Refresh Models"}
          </button>
          <button onClick={validate} disabled={busy}>
            Validate
          </button>
          <button className="primary-button" onClick={save} disabled={busy}>
            Save
          </button>
          <button className="danger-button" onClick={clear} disabled={busy}>
            <Trash2 size={15} />
            Clear
          </button>
        </div>

        <div className={status?.isValid ? "connection-status valid" : "connection-status invalid"}>
          {status?.isValid ? "Valid" : status ? "Invalid" : "Not configured"}
          {status?.lastValidatedAt ? <span>Last checked: {status.lastValidatedAt}</span> : null}
        </div>
        {error ? <div className="settings-error">{error}</div> : null}
      </div>
    </div>
  );
}
