import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import type {
  BranchCondition,
  BranchGroupCondition,
  MemoryOrder,
  MemoryType,
  MemoryVariable,
  OperationType,
  RelationType,
  SessionSnapshot,
} from "../types";
import { useStore } from "../store/useStore";
import { parseSessionSnapshot } from "../session/parseSessionSnapshot";
import { createSessionSnapshot } from "../session/createSessionSnapshot";
import { createSessionFingerprint } from "../session/sessionFingerprint";
import { checkEdgeConstraints } from "../utils/edgeConstraints";
import BranchConditionEditor from "./BranchConditionEditor";
import { evaluateBranchCondition } from "../utils/branchEvaluation";
import SessionTitleDialog from "./SessionTitleDialog";
import RelationDefinitionsDialog from "./RelationDefinitionsDialog";
import TutorialDialog from "./TutorialDialog";
import ConfirmDiscardDialog from "./ConfirmDiscardDialog";
import { ArrowRight, Trash2 } from "lucide-react";

type SidebarProps = {
  /**
   * Optional hook for parent components to run additional reset logic.
   * Used to clear any shared-session URL state before wiping the local graph.
   */
  onNewSession?: () => void;
};

type ToolboxItem = {
  label: string;
  type: OperationType;
  nodeType: "operation" | "branch";
};

const TOOLBOX_ITEMS: ToolboxItem[] = [
  { label: "Load", type: "LOAD", nodeType: "operation" },
  { label: "Store", type: "STORE", nodeType: "operation" },
  { label: "Fence", type: "FENCE", nodeType: "operation" },
  { label: "CAS", type: "RMW", nodeType: "operation" },
  { label: "Branch", type: "BRANCH", nodeType: "branch" },
];

const MEMORY_ITEMS: { label: string; type: MemoryType }[] = [
  { label: "int", type: "int" },
  { label: "array", type: "array" },
];

const formatRelationTypeLabel = (relationType: RelationType) => {
  switch (relationType) {
    case "rf":
      return "rf (read-from)";
    case "co":
      return "co (coherence)";
    case "fr":
      return "fr (from-read)";
    case "po":
      return "po (program order)";
    case "ad":
      return "ad (address dependency)";
    case "dd":
      return "dd (data dependency)";
    case "cd":
      return "cd (control dependency)";
    default:
      return relationType;
  }
};

const collectConditionVariableIds = (condition: BranchCondition | undefined) => {
  if (!condition) {
    return [];
  }

  if (condition.kind === "rule") {
    const ids: string[] = [];
    if (condition.lhsId) {
      ids.push(condition.lhsId);
    }
    if (condition.rhsId) {
      ids.push(condition.rhsId);
    }
    return ids;
  }

  const ids: string[] = [];
  for (const item of condition.items) {
    ids.push(...collectConditionVariableIds(item));
  }
  return ids;
};

const formatMemoryLabel = (
  item: MemoryVariable,
  memoryById: Map<string, MemoryVariable>
) => {
  const name = item.name.trim() || item.id;
  if (!item.parentId) {
    return name;
  }
  const parentName = memoryById.get(item.parentId)?.name.trim() || "struct";
  return `${parentName}.${name}`;
};

type BasicTestFixture = {
  id: string;
  title: string;
  snapshot: SessionSnapshot;
};

const BASIC_TEST_FIXTURES: BasicTestFixture[] = (() => {
  const modules = import.meta.glob("../../tests/basic/*.json", {
    eager: true,
  }) as Record<string, { default: unknown }>;

  const fixtures: BasicTestFixture[] = [];

  for (const [path, module] of Object.entries(modules)) {
    const fileName = path.split("/").pop() ?? path;
    const id = fileName.replace(/\.json$/i, "");
    try {
      const snapshot = parseSessionSnapshot(module.default);
      fixtures.push({
        id,
        title: snapshot.title ?? id,
        snapshot,
      });
    } catch {
      // Ignore invalid fixtures so the UI never crashes in production builds.
    }
  }

  fixtures.sort((a, b) => a.title.localeCompare(b.title));
  return fixtures;
})();

const Sidebar = ({ onNewSession }: SidebarProps) => {
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    if (typeof window === "undefined") {
      return 520;
    }
    const stored = window.localStorage.getItem("litmus.sidebarWidth");
    const parsed = stored ? Number(stored) : NaN;
    return Number.isFinite(parsed) ? parsed : 520;
  });
  const resizeState = useRef<{
    startX: number;
    startWidth: number;
    pointerId: number;
  } | null>(null);

  const setNodes = useStore((state) => state.setNodes);
  const nodes = useStore((state) => state.nodes);
  const edges = useStore((state) => state.edges);
  const setEdges = useStore((state) => state.setEdges);
  const threads = useStore((state) => state.threads);
  const threadLabels = useStore((state) => state.threadLabels);
  const memoryEnv = useStore((state) => state.memoryEnv);
  const activeBranch = useStore((state) => state.activeBranch);
  const deleteNode = useStore((state) => state.deleteNode);
  const resetSession = useStore((state) => state.resetSession);
  const importSession = useStore((state) => state.importSession);
  const validateGraph = useStore((state) => state.validateGraph);
  const sessionTitle = useStore((state) => state.sessionTitle);
  const setSessionTitle = useStore((state) => state.setSessionTitle);
  const savedSessionFingerprint = useStore(
    (state) => state.savedSessionFingerprint
  );
  const markSessionSaved = useStore((state) => state.markSessionSaved);
  const modelConfig = useStore((state) => state.modelConfig);
  const resetModelConfig = useStore((state) => state.resetModelConfig);
  const importCatFiles = useStore((state) => state.importCatFiles);
  const removeCatFile = useStore((state) => state.removeCatFile);
  const catModel = useStore((state) => state.catModel);
  const selectedMemoryIds = useStore((state) => state.selectedMemoryIds);
  const groupSelectedIntoStruct = useStore(
    (state) => state.groupSelectedIntoStruct
  );
  const sessionFileInputRef = useRef<HTMLInputElement | null>(null);
  const catFileInputRef = useRef<HTMLInputElement | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [relationDialogOpen, setRelationDialogOpen] = useState(false);
  const [tutorialDialogOpen, setTutorialDialogOpen] = useState(false);
  const basicTestSelectId = useId();
  const [selectedBasicTestId, setSelectedBasicTestId] = useState(() => {
    return BASIC_TEST_FIXTURES[0]?.id ?? "";
  });
  const [discardBasicLoadOpen, setDiscardBasicLoadOpen] = useState(false);

  /**
   * Starts a blank session and lets the parent clear any UUID from the URL.
   * Order matters: clear URL/shared-session state first, then wipe the store.
   */
  const handleNewSession = useCallback(() => {
    onNewSession?.();
    resetSession();
  }, [onNewSession, resetSession]);

  const selectedNode = useMemo(
    () => nodes.find((node) => node.selected),
    [nodes]
  );

  const selectedEdge = useMemo(() => edges.find((edge) => edge.selected), [edges]);

  const onDragStart = (event: DragEvent<HTMLDivElement>, item: ToolboxItem) => {
    event.dataTransfer.setData("application/reactflow", item.nodeType);
    event.dataTransfer.setData("application/litmus-operation", item.type);
    event.dataTransfer.effectAllowed = "move";
  };

  const updateSelectedOperation = (updates: {
    addressId?: string;
    indexId?: string;
    resultId?: string;
    valueId?: string;
    expectedValueId?: string;
    desiredValueId?: string;
    address?: string;
    value?: string | number;
    memoryOrder?: MemoryOrder;
    successMemoryOrder?: MemoryOrder;
    failureMemoryOrder?: MemoryOrder;
    branchCondition?: BranchGroupCondition;
  }) => {
    if (!selectedNode) {
      return;
    }

    setNodes((current) =>
      current.map((node) => {
        if (node.id !== selectedNode.id) {
          return node;
        }

        const normalizedUpdates: typeof updates = { ...updates };
        if (Object.prototype.hasOwnProperty.call(updates, "addressId")) {
          normalizedUpdates.address = undefined;
        }
        if (Object.prototype.hasOwnProperty.call(updates, "valueId")) {
          normalizedUpdates.value = undefined;
        }
        if (Object.prototype.hasOwnProperty.call(updates, "value")) {
          normalizedUpdates.valueId = undefined;
        }

        return {
          ...node,
          data: {
            ...node.data,
            operation: {
              ...node.data.operation,
              ...normalizedUpdates,
            },
          },
        };
      })
    );
    validateGraph();
  };

  const updateSelectedEdge = (updates: { relationType?: RelationType }) => {
    if (!selectedEdge) {
      return;
    }

    setEdges((current) =>
      current.map((edge) => {
        if (edge.id !== selectedEdge.id) {
          return edge;
        }

        return {
          ...edge,
          data: {
            ...(edge.data ?? { relationType: "po" }),
            ...updates,
          },
        };
      })
    );
    validateGraph();
  };

  const deleteSelectedEdge = () => {
    if (!selectedEdge) {
      return;
    }

    setEdges((current) => current.filter((edge) => edge.id !== selectedEdge.id));
  };

  const deleteSelectedNode = () => {
    if (!selectedNode) {
      return;
    }
    deleteNode(selectedNode.id);
  };

  const handleMemoryDragStart = (
    event: DragEvent<HTMLDivElement>,
    type: MemoryType
  ) => {
    event.dataTransfer.setData("application/litmus-memory", type);
    event.dataTransfer.effectAllowed = "copy";
  };

  const exportSession = useCallback(
    (title: string) => {
      const normalizedTitle = title.trim();
      setSessionTitle(normalizedTitle);

      const safeFilename = normalizedTitle
        .replace(/[\\/:*?"<>|]+/g, "-")
        .replace(/\s+/g, " ")
        .trim();

      const snapshot = createSessionSnapshot({
        title: normalizedTitle,
        modelConfig,
        memoryEnv,
        nodes,
        edges,
        threads,
        threadLabels,
        activeBranch,
      });
      const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = safeFilename
        ? `${safeFilename}.json`
        : "litmus-session.json";
      link.click();
      URL.revokeObjectURL(url);

      // Export is treated as a "save" for purposes of discard confirmation prompts.
      markSessionSaved();
    },
    [
      activeBranch,
      edges,
      memoryEnv,
      markSessionSaved,
      modelConfig,
      nodes,
      setSessionTitle,
      threadLabels,
      threads,
    ]
  );

  const handleExportSession = useCallback(() => {
    setExportDialogOpen(true);
  }, []);

  const handleImportSessionFile = useCallback(
    async (file: File) => {
      setImportError(null);
      try {
        const rawText = await file.text();
        const parsed = JSON.parse(rawText) as unknown;
        const snapshot = parseSessionSnapshot(parsed);
        const fileTitle = file.name.replace(/\.json$/i, "").trim();
        const snapshotWithTitle =
          snapshot.title || !fileTitle || fileTitle === "litmus-session"
            ? snapshot
            : { ...snapshot, title: fileTitle };
        onNewSession?.();
        importSession(snapshotWithTitle);
      } catch (error) {
        setImportError(
          error instanceof Error ? error.message : "Failed to import session."
        );
      }
    },
    [importSession, onNewSession]
  );

  const currentSessionFingerprint = useMemo(
    () =>
      createSessionFingerprint({
        title: sessionTitle,
        modelConfig,
        memoryEnv,
        nodes,
        edges,
        threads,
        threadLabels,
        activeBranch,
      }),
    [
      activeBranch,
      edges,
      memoryEnv,
      modelConfig,
      nodes,
      sessionTitle,
      threadLabels,
      threads,
    ]
  );
  const hasUnsavedChanges = savedSessionFingerprint !== currentSessionFingerprint;

  const selectedBasicFixture = useMemo(() => {
    if (!selectedBasicTestId) {
      return null;
    }
    return (
      BASIC_TEST_FIXTURES.find((fixture) => fixture.id === selectedBasicTestId) ??
      null
    );
  }, [selectedBasicTestId]);

  /**
   * Loads a basic fixture into the editor, replacing the current session.
   */
  const loadBasicFixture = useCallback(
    (fixture: BasicTestFixture) => {
      setImportError(null);
      onNewSession?.();
      importSession(fixture.snapshot);
    },
    [importSession, onNewSession]
  );

  const requestLoadBasicFixture = useCallback(() => {
    if (!selectedBasicFixture) {
      return;
    }
    if (hasUnsavedChanges) {
      setDiscardBasicLoadOpen(true);
      return;
    }
    loadBasicFixture(selectedBasicFixture);
  }, [hasUnsavedChanges, loadBasicFixture, selectedBasicFixture]);

  const handleImportCatFiles = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) {
        return;
      }
      await importCatFiles(fileList);
      if (catFileInputRef.current) {
        catFileInputRef.current.value = "";
      }
    },
    [importCatFiles]
  );

  const selectedMemoryItems = useMemo(
    () =>
      memoryEnv.filter(
        (item) =>
          selectedMemoryIds.includes(item.id) &&
          item.type !== "struct" &&
          !item.parentId
      ),
    [memoryEnv, selectedMemoryIds]
  );
  const canGroupStruct = useMemo(() => {
    if (selectedMemoryItems.length < 2) {
      return false;
    }
    return new Set(selectedMemoryItems.map((item) => item.scope)).size === 1;
  }, [selectedMemoryItems]);

  const memoryOptions = useMemo(() => {
    const memoryById = new Map(memoryEnv.map((item) => [item.id, item]));

    return memoryEnv
      .filter((item) => item.type !== "struct")
      .map((item) => ({ value: item.id, label: formatMemoryLabel(item, memoryById) }))
      .filter((option) => option.label);
  }, [memoryEnv]);

  const intOptions = useMemo(() => {
    const memoryById = new Map(memoryEnv.map((item) => [item.id, item]));
    return memoryEnv
      .filter((item) => item.type === "int")
      .map((item) => ({ value: item.id, label: formatMemoryLabel(item, memoryById) }))
      .filter((option) => option.label);
  }, [memoryEnv]);

  const localIntOptions = useMemo(() => {
    const memoryById = new Map(memoryEnv.map((item) => [item.id, item]));
    return memoryEnv
      .filter((item) => item.type === "int" && item.scope === "locals")
      .map((item) => ({ value: item.id, label: formatMemoryLabel(item, memoryById) }))
      .filter((option) => option.label);
  }, [memoryEnv]);

  const memoryTypeById = useMemo(
    () => new Map(memoryEnv.map((item) => [item.id, item.type] as const)),
    [memoryEnv]
  );

  const memoryScopeById = useMemo(
    () => new Map(memoryEnv.map((item) => [item.id, item.scope] as const)),
    [memoryEnv]
  );

  const localOwners = useMemo(() => {
    const localIds = new Set(
      memoryEnv.filter((item) => item.scope === "locals").map((item) => item.id)
    );
    const usageById = new Map<string, Set<string>>();

    const addUsage = (id: string | undefined, threadId: string) => {
      if (!id || !localIds.has(id)) {
        return;
      }
      const current = usageById.get(id) ?? new Set<string>();
      current.add(threadId);
      usageById.set(id, current);
    };

    for (const node of nodes) {
      const threadId = node.data.threadId;
      const operation = node.data.operation;
      addUsage(operation.addressId, threadId);
      addUsage(operation.indexId, threadId);
      addUsage(operation.valueId, threadId);
      addUsage(operation.resultId, threadId);
      addUsage(operation.expectedValueId, threadId);
      addUsage(operation.desiredValueId, threadId);
      if (operation.type === "BRANCH") {
        for (const id of collectConditionVariableIds(operation.branchCondition)) {
          addUsage(id, threadId);
        }
      }
    }

    const ownerById = new Map<string, string>();
    for (const [id, threads] of usageById) {
      const sorted = Array.from(threads).sort((a, b) => a.localeCompare(b));
      const owner = sorted[0];
      if (owner) {
        ownerById.set(id, owner);
      }
    }

    return { ownerById };
  }, [memoryEnv, nodes]);

  const allowLocalForThread = useCallback(
    (id: string | undefined, threadId: string | null) => {
      if (!id || !threadId) {
        return true;
      }
      if (memoryScopeById.get(id) !== "locals") {
        return true;
      }
      const owner = localOwners.ownerById.get(id);
      if (!owner) {
        return true;
      }
      return owner === threadId;
    },
    [localOwners.ownerById, memoryScopeById]
  );

  const filterOptionsForThread = useCallback(
    <T extends { value: string }>(options: T[], threadId: string | null) =>
      options.filter((option) => allowLocalForThread(option.value, threadId)),
    [allowLocalForThread]
  );

  const normalizeSelectionValue = useCallback(
    (id: string | undefined, threadId: string | null) =>
      allowLocalForThread(id, threadId) ? id ?? "" : "",
    [allowLocalForThread]
  );

  useEffect(() => {
    if (!selectedNode) {
      return;
    }
    const threadId = selectedNode.data.threadId;
    const operation = selectedNode.data.operation;

    const maybeClearLocal = (id: string | undefined) => {
      if (!id) {
        return false;
      }
      if (memoryScopeById.get(id) !== "locals") {
        return false;
      }
      const owner = localOwners.ownerById.get(id);
      return !!owner && owner !== threadId;
    };

    const updates: {
      addressId?: string;
      indexId?: string;
      resultId?: string;
      valueId?: string;
      expectedValueId?: string;
      desiredValueId?: string;
    } = {};

    if (maybeClearLocal(operation.addressId)) updates.addressId = undefined;
    if (maybeClearLocal(operation.indexId)) updates.indexId = undefined;
    if (maybeClearLocal(operation.resultId)) updates.resultId = undefined;
    if (maybeClearLocal(operation.valueId)) updates.valueId = undefined;
    if (maybeClearLocal(operation.expectedValueId)) updates.expectedValueId = undefined;
    if (maybeClearLocal(operation.desiredValueId)) updates.desiredValueId = undefined;

    if (Object.keys(updates).length > 0) {
      updateSelectedOperation(updates);
    }
  }, [localOwners.ownerById, memoryScopeById, selectedNode, updateSelectedOperation]);

  const selectedEdgeContext = useMemo(() => {
    if (!selectedEdge) {
      return null;
    }

    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    const sourceNode = nodesById.get(selectedEdge.source);
    const targetNode = nodesById.get(selectedEdge.target);
    const relationType = selectedEdge.data?.relationType ?? "po";
    const constraint = checkEdgeConstraints({
      relationType,
      sourceNode,
      targetNode,
      memoryEnv,
    });

    return { sourceNode, targetNode, relationType, constraint };
  }, [memoryEnv, nodes, selectedEdge]);

  const selectedBranchOutcome = useMemo(() => {
    if (!selectedNode || selectedNode.data.operation.type !== "BRANCH") {
      return null;
    }
    const condition = selectedNode.data.operation.branchCondition;
    if (!condition) {
      return null;
    }
    return evaluateBranchCondition(condition, memoryEnv);
  }, [memoryEnv, selectedNode]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem("litmus.sidebarWidth", String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const state = resizeState.current;
      if (!state || event.pointerId !== state.pointerId) {
        return;
      }

      const minWidth = 320;
      const maxWidth = Math.min(900, Math.max(minWidth, window.innerWidth * 0.75));
      const delta = event.clientX - state.startX;
      setSidebarWidth(Math.max(minWidth, Math.min(maxWidth, state.startWidth + delta)));
    };

    const handlePointerUp = (event: PointerEvent) => {
      const state = resizeState.current;
      if (!state || event.pointerId !== state.pointerId) {
        return;
      }
      resizeState.current = null;
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, []);

  return (
    <aside
      className="relative flex h-full flex-none flex-col gap-6 overflow-y-auto border-r border-slate-200 bg-white p-4 text-sm text-slate-900"
      style={{ width: sidebarWidth }}
    >
      <div
        className="absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize"
        role="separator"
        aria-label="Resize sidebar"
        onPointerDown={(event) => {
          event.preventDefault();
          resizeState.current = {
            startX: event.clientX,
            startWidth: sidebarWidth,
            pointerId: event.pointerId,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
      >
        <div className="absolute inset-y-0 right-0 w-px bg-slate-200" />
        <div className="absolute right-0 top-1/2 h-10 w-1 -translate-y-1/2 rounded bg-slate-200 opacity-0 transition-opacity hover:opacity-100" />
      </div>

      <button
        type="button"
        className="w-full rounded bg-slate-900 px-3 py-2 text-xs font-semibold text-white"
        onClick={() => setTutorialDialogOpen(true)}
      >
        Help
      </button>

      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Session
        </h2>
        <div className="space-y-2">
          <button
            type="button"
            className="w-full rounded border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-800"
            onClick={handleNewSession}
          >
            New Session
          </button>
          <button
            type="button"
            className="w-full rounded bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white"
            onClick={handleExportSession}
          >
            Export Session
          </button>
          <button
            type="button"
            className="w-full rounded border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-800"
            onClick={() => sessionFileInputRef.current?.click()}
          >
            Import Session
          </button>
          <input
            ref={sessionFileInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) {
                return;
              }
              void handleImportSessionFile(file);
            }}
          />
          {BASIC_TEST_FIXTURES.length ? (
            <div className="flex w-full items-stretch gap-2">
              <label htmlFor={basicTestSelectId} className="sr-only">
                Basic tests
              </label>
              <select
                id={basicTestSelectId}
                className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-800"
                value={selectedBasicTestId}
                onChange={(event) => setSelectedBasicTestId(event.target.value)}
              >
                {BASIC_TEST_FIXTURES.map((fixture) => (
                  <option key={fixture.id} value={fixture.id}>
                    {fixture.title}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="inline-flex h-8 w-8 flex-none items-center justify-center rounded border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                aria-label={
                  selectedBasicFixture
                    ? `Load ${selectedBasicFixture.title}`
                    : "Load basic test"
                }
                disabled={!selectedBasicFixture}
                onClick={requestLoadBasicFixture}
              >
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          ) : null}
          {importError ? (
            <div className="text-xs text-red-600">{importError}</div>
          ) : null}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Model
        </h2>
        <div className="space-y-2">
          <div className="rounded border border-slate-200 bg-slate-50 px-2 py-2 text-xs text-slate-700">
            <div className="font-semibold">Relations</div>
            <div className="text-slate-500">
              {modelConfig.relationTypes.length} type(s)
            </div>
          </div>
          <button
            type="button"
            className="w-full rounded border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-800"
            onClick={() => catFileInputRef.current?.click()}
          >
            Upload .cat File(s)
          </button>
          <input
            ref={catFileInputRef}
            type="file"
            accept=".cat"
            multiple
            className="hidden"
            onChange={(event) => void handleImportCatFiles(event.target.files)}
          />
          {Object.keys(catModel.filesByName).length ? (
            <div className="rounded border border-slate-200 bg-white">
              <div className="border-b border-slate-200 px-2 py-1.5 text-[11px] font-semibold text-slate-600">
                Loaded .cat files
              </div>
              <div className="divide-y divide-slate-100">
                {Object.keys(catModel.filesByName)
                  .slice()
                  .sort((a, b) => a.localeCompare(b))
                  .map((fileName) => (
                    <div
                      key={fileName}
                      className="flex items-center justify-between gap-2 px-2 py-1.5"
                    >
                      <div className="min-w-0 truncate text-xs text-slate-800">
                        {fileName}
                      </div>
                      <button
                        type="button"
                        className="inline-flex items-center justify-center rounded border border-slate-200 bg-white p-1.5 text-slate-700 hover:bg-slate-50"
                        aria-label={`Remove ${fileName}`}
                        onClick={() => removeCatFile(fileName)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
              </div>
            </div>
          ) : null}
          {catModel.analysis?.missingIncludes.length ? (
            <div className="rounded border border-amber-200 bg-amber-50 px-2 py-2 text-xs text-amber-800">
              Missing include file(s):{" "}
              {catModel.analysis.missingIncludes.join(", ")}
            </div>
          ) : null}
          {catModel.analysis?.unresolvedNames.length ? (
            <div className="rounded border border-amber-200 bg-amber-50 px-2 py-2 text-xs text-amber-800">
              Unresolved name(s):{" "}
              {catModel.analysis.unresolvedNames.slice(0, 12).join(", ")}
              {catModel.analysis.unresolvedNames.length > 12 ? "…" : ""}
            </div>
          ) : null}
          {catModel.error ? (
            <div className="text-xs text-red-600">{catModel.error}</div>
          ) : null}
          <button
            type="button"
            className="w-full rounded bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white"
            onClick={() => setRelationDialogOpen(true)}
          >
            View Relation Definitions
          </button>
          <button
            type="button"
            className="w-full rounded border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-800"
            onClick={resetModelConfig}
          >
            Reset Model Config
          </button>
        </div>
      </section>

      <SessionTitleDialog
        open={exportDialogOpen}
        initialValue={sessionTitle}
        onCancel={() => setExportDialogOpen(false)}
        onConfirm={(title) => {
          setExportDialogOpen(false);
          exportSession(title);
        }}
      />

      <ConfirmDiscardDialog
        open={discardBasicLoadOpen}
        title="Discard current session?"
        description={
          selectedBasicFixture
            ? `You have unsaved changes. Loading "${selectedBasicFixture.title}" will replace the current canvas.`
            : "You have unsaved changes. Loading a basic test will replace the current canvas."
        }
        confirmLabel="Discard & load"
        onCancel={() => setDiscardBasicLoadOpen(false)}
        onConfirm={() => {
          setDiscardBasicLoadOpen(false);
          if (selectedBasicFixture) {
            loadBasicFixture(selectedBasicFixture);
          }
        }}
      />

      <RelationDefinitionsDialog
        open={relationDialogOpen}
        definitions={catModel.definitions}
        onClose={() => setRelationDialogOpen(false)}
      />

      <TutorialDialog
        open={tutorialDialogOpen}
        onClose={() => setTutorialDialogOpen(false)}
      />

      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Memory Definition
        </h2>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            {MEMORY_ITEMS.map((item) => (
              <div
                key={item.type}
                className="cursor-grab rounded border border-slate-200 bg-slate-50 px-2 py-2 text-center text-xs font-semibold text-slate-700"
                draggable
                onDragStart={(event) =>
                  handleMemoryDragStart(event, item.type)
                }
              >
                {item.label}
              </div>
            ))}
          </div>
          <button
            type="button"
            className={`w-full rounded px-3 py-1.5 text-xs font-semibold ${
              canGroupStruct
                ? "bg-slate-900 text-white"
                : "bg-slate-200 text-slate-500"
            }`}
            onClick={groupSelectedIntoStruct}
            disabled={!canGroupStruct}
          >
            Struct
          </button>
          <div className="text-xs text-slate-500">
            Drag ints or arrays into Constants/Shared. Use + in Local Registers.
            Select multiple items to enable Struct.
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Toolbox
        </h2>
        <div className="grid grid-cols-2 gap-2">
          {TOOLBOX_ITEMS.map((item) => (
            <div
              key={item.type}
              className="cursor-grab rounded border border-slate-200 bg-slate-50 px-2 py-2 text-center text-xs font-semibold text-slate-700"
              draggable
              onDragStart={(event) => onDragStart(event, item)}
            >
              {item.label}
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Properties
        </h2>
        {selectedEdge && selectedEdgeContext ? (
          <div className="space-y-2">
            <div className="text-xs text-slate-500">Edge {selectedEdge.id}</div>
            <div className="text-xs text-slate-500">
              {selectedEdge.source} → {selectedEdge.target}
            </div>
            <select
              className="w-full rounded border border-slate-300 px-2 py-1 text-xs"
              value={selectedEdgeContext.relationType}
              onChange={(event) =>
                updateSelectedEdge({
                  relationType: event.target.value,
                })
              }
            >
              {modelConfig.relationTypes.map((relationType) => (
                <option key={relationType} value={relationType}>
                  {formatRelationTypeLabel(relationType)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="w-full rounded bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white"
              onClick={deleteSelectedEdge}
            >
              Delete Edge
            </button>
            {!selectedEdgeContext.constraint.allowed ? (
              <div className="rounded border border-rose-200 bg-rose-50 px-2 py-1 text-xs text-rose-700">
                {selectedEdgeContext.constraint.reason}
              </div>
            ) : null}
          </div>
        ) : selectedNode ? (
          <div className="space-y-2">
            <div className="text-xs text-slate-500">
              Node {selectedNode.id}
            </div>
            {selectedNode.data.operation.type === "BRANCH" ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-semibold text-slate-700">
                    Branch Outcome
                  </div>
                  <div
                    className={`rounded px-2 py-0.5 text-[10px] font-semibold ${
                      selectedBranchOutcome ? "bg-emerald-200" : "bg-rose-200"
                    }`}
                  >
                    {(selectedBranchOutcome ?? false) ? "True" : "False"}
                  </div>
                </div>
                <BranchConditionEditor
                  memoryOptions={filterOptionsForThread(
                    memoryOptions,
                    selectedNode.data.threadId
                  )}
                  value={selectedNode.data.operation.branchCondition}
                  onChange={(nextCondition) =>
                    updateSelectedOperation({ branchCondition: nextCondition })
                  }
                />
              </div>
            ) : (
              <>
                {selectedNode.data.operation.type === "LOAD" ||
                selectedNode.data.operation.type === "STORE" ||
	                selectedNode.data.operation.type === "RMW" ? (
	                  <select
	                    className="w-full rounded border border-slate-300 px-2 py-1"
	                    value={normalizeSelectionValue(
	                      selectedNode.data.operation.addressId,
	                      selectedNode.data.threadId
	                    )}
	                    onChange={(event) =>
	                      updateSelectedOperation({
	                        addressId: event.target.value || undefined,
	                        indexId:
                          event.target.value &&
                          memoryTypeById.get(event.target.value) === "array"
                            ? selectedNode.data.operation.indexId
                            : undefined,
                      })
                    }
	                  >
	                    <option value="">Variable</option>
	                    {filterOptionsForThread(
	                      memoryOptions,
	                      selectedNode.data.threadId
	                    ).map((option) => (
	                      <option key={option.value} value={option.value}>
	                        {option.label}
	                      </option>
	                    ))}
	                  </select>
	                ) : null}

                {selectedNode.data.operation.type === "LOAD" ? (
                  <select
                    className="w-full rounded border border-slate-300 px-2 py-1"
                    value={normalizeSelectionValue(
                      selectedNode.data.operation.resultId,
                      selectedNode.data.threadId
                    )}
                    onChange={(event) =>
                      updateSelectedOperation({
                        resultId: event.target.value || undefined,
                      })
                    }
                  >
                    <option value="">Result variable</option>
                    {filterOptionsForThread(
                      localIntOptions,
                      selectedNode.data.threadId
                    ).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : null}

                {selectedNode.data.operation.type === "RMW" ? (
                  <select
                    className="w-full rounded border border-slate-300 px-2 py-1"
                    value={normalizeSelectionValue(
                      selectedNode.data.operation.resultId,
                      selectedNode.data.threadId
                    )}
                    onChange={(event) =>
                      updateSelectedOperation({
                        resultId: event.target.value || undefined,
                      })
                    }
                  >
                    <option value="">Result variable</option>
                    {filterOptionsForThread(
                      localIntOptions,
                      selectedNode.data.threadId
                    ).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : null}

                {selectedNode.data.operation.type === "LOAD" ||
                selectedNode.data.operation.type === "STORE" ? (
                  selectedNode.data.operation.addressId &&
                  memoryTypeById.get(selectedNode.data.operation.addressId) ===
                    "array" ? (
	                    <select
	                      className="w-full rounded border border-slate-300 px-2 py-1"
	                      value={normalizeSelectionValue(
	                        selectedNode.data.operation.indexId,
	                        selectedNode.data.threadId
	                      )}
	                      onChange={(event) =>
	                        updateSelectedOperation({
	                          indexId: event.target.value || undefined,
	                        })
	                      }
	                    >
	                      <option value="">Index variable</option>
	                      {filterOptionsForThread(
	                        intOptions,
	                        selectedNode.data.threadId
	                      ).map((option) => (
	                        <option key={option.value} value={option.value}>
	                          {option.label}
	                        </option>
	                      ))}
	                    </select>
                  ) : null
                ) : null}

                {selectedNode.data.operation.type === "STORE" ? (
                  <>
	                    <select
	                      className="w-full rounded border border-slate-300 px-2 py-1"
	                      value={normalizeSelectionValue(
	                        selectedNode.data.operation.valueId,
	                        selectedNode.data.threadId
	                      )}
	                      onChange={(event) =>
	                        updateSelectedOperation({
	                          valueId: event.target.value || undefined,
	                        })
	                      }
	                    >
	                      <option value="">Value variable</option>
	                      {filterOptionsForThread(
	                        intOptions,
	                        selectedNode.data.threadId
	                      ).map((option) => (
	                        <option key={option.value} value={option.value}>
	                          {option.label}
	                        </option>
	                      ))}
	                    </select>
                    <input
                      className="w-full rounded border border-slate-300 px-2 py-1 text-xs"
                      placeholder="Value"
                      value={
                        selectedNode.data.operation.value !== undefined
                          ? String(selectedNode.data.operation.value)
                          : ""
                      }
                      onChange={(event) =>
                        updateSelectedOperation({ value: event.target.value })
                      }
                    />
                  </>
                ) : null}

                {selectedNode.data.operation.type === "RMW" ? (
                  <>
	                    <select
	                      className="w-full rounded border border-slate-300 px-2 py-1"
	                      value={normalizeSelectionValue(
	                        selectedNode.data.operation.expectedValueId,
	                        selectedNode.data.threadId
	                      )}
	                      onChange={(event) =>
	                        updateSelectedOperation({
	                          expectedValueId: event.target.value || undefined,
	                        })
	                      }
	                    >
	                      <option value="">Expected Value</option>
	                      {filterOptionsForThread(
	                        memoryOptions,
	                        selectedNode.data.threadId
	                      ).map((option) => (
	                        <option key={option.value} value={option.value}>
	                          {option.label}
	                        </option>
	                      ))}
	                    </select>
	                    <select
	                      className="w-full rounded border border-slate-300 px-2 py-1"
	                      value={normalizeSelectionValue(
	                        selectedNode.data.operation.desiredValueId,
	                        selectedNode.data.threadId
	                      )}
	                      onChange={(event) =>
	                        updateSelectedOperation({
	                          desiredValueId: event.target.value || undefined,
	                        })
	                      }
	                    >
	                      <option value="">Desired Value</option>
	                      {filterOptionsForThread(
	                        memoryOptions,
	                        selectedNode.data.threadId
	                      ).map((option) => (
	                        <option key={option.value} value={option.value}>
	                          {option.label}
	                        </option>
	                      ))}
	                    </select>
                    <select
                      className="w-full rounded border border-slate-300 px-2 py-1"
                      value={selectedNode.data.operation.successMemoryOrder ?? ""}
                      onChange={(event) =>
                        updateSelectedOperation({
                          successMemoryOrder: event.target.value
                            ? event.target.value
                            : undefined,
                        })
                      }
                    >
                      <option value="">Success Memory Order</option>
                      {modelConfig.memoryOrders.map((order) => (
                        <option key={order} value={order}>
                          {order}
                        </option>
                      ))}
                    </select>
                    <select
                      className="w-full rounded border border-slate-300 px-2 py-1"
                      value={selectedNode.data.operation.failureMemoryOrder ?? ""}
                      onChange={(event) =>
                        updateSelectedOperation({
                          failureMemoryOrder: event.target.value
                            ? event.target.value
                            : undefined,
                        })
                      }
                    >
                      <option value="">Failure Memory Order</option>
                      {modelConfig.memoryOrders.map((order) => (
                        <option key={order} value={order}>
                          {order}
                        </option>
                      ))}
                    </select>
                  </>
                ) : null}

                {selectedNode.data.operation.type === "LOAD" ||
                selectedNode.data.operation.type === "STORE" ||
                selectedNode.data.operation.type === "FENCE" ? (
                  <select
                    className="w-full rounded border border-slate-300 px-2 py-1"
                    value={selectedNode.data.operation.memoryOrder ?? ""}
                    onChange={(event) =>
                      updateSelectedOperation({
                        memoryOrder: event.target.value
                          ? event.target.value
                          : undefined,
                      })
                    }
                  >
                    <option value="">Memory Order</option>
                    {modelConfig.memoryOrders.map((order) => (
                      <option key={order} value={order}>
                        {order}
                      </option>
                    ))}
                  </select>
                ) : null}
              </>
            )}
            <button
              type="button"
              className="w-full rounded bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white"
              onClick={deleteSelectedNode}
            >
              Delete Node
            </button>
          </div>
        ) : (
          <div className="text-xs text-slate-500">
            Select a node to edit its operation fields.
          </div>
        )}
      </section>
    </aside>
  );
};

export default Sidebar;
