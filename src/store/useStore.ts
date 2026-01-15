import { create } from "zustand";
import {
  applyEdgeChanges,
  applyNodeChanges,
  type EdgeChange,
  type NodeChange,
} from "reactflow";
import type {
  ActiveBranch,
  BranchCondition,
  BranchGroupCondition,
  BranchRuleCondition,
  MemoryVariable,
  RelationEdge,
  SessionModelConfig,
  SessionSnapshot,
  TraceNode,
} from "../types";
import { checkEdgeConstraints } from "../utils/edgeConstraints";
import { DEFAULT_MODEL_CONFIG } from "../config/defaultModelConfig";
import { analyzeCatFiles, type CatModelAnalysis } from "../cat/catParser";
import { createSessionFingerprint } from "../session/sessionFingerprint";
import { createUuid } from "../utils/createUuid";

type NodesUpdater = TraceNode[] | ((nodes: TraceNode[]) => TraceNode[]);
type EdgesUpdater = RelationEdge[] | ((edges: RelationEdge[]) => RelationEdge[]);

const scrubBranchCondition = (
  condition: BranchCondition | undefined,
  deletedId: string
): BranchCondition | undefined => {
  if (!condition) {
    return condition;
  }

  if (condition.kind === "rule") {
    const next: BranchRuleCondition = { ...condition };
    if (next.lhsId === deletedId) {
      next.lhsId = undefined;
    }
    if (next.rhsId === deletedId) {
      next.rhsId = undefined;
    }
    return next;
  }

  const nextItems = condition.items.map((item) =>
    scrubBranchCondition(item, deletedId)
  ) as BranchCondition[];
  const next: BranchGroupCondition = { ...condition, items: nextItems };
  return next;
};

type StoreState = {
  sessionTitle: string;
  modelConfig: SessionModelConfig;
  nodes: TraceNode[];
  edges: RelationEdge[];
  memoryEnv: MemoryVariable[];
  /**
   * When enabled, the canvas forces every node visible regardless of branch evaluation.
   * This is a purely UI-level override and is intentionally not part of session snapshots.
   */
  showAllNodes: boolean;
  /**
   * Fingerprint of the last "saved" state (export/import/new).
   * Used by UI affordances that need to warn before discarding changes.
   */
  savedSessionFingerprint: string;
  selectedMemoryIds: string[];
  threads: string[];
  threadLabels: Record<string, string>;
  activeBranch: ActiveBranch | null;
  edgeLabelMode: "all" | "nonPo" | "off";
  focusedEdgeLabelId: string | null;
  catModel: {
    filesByName: Record<string, string>;
    analysis: CatModelAnalysis | null;
    definitions: Array<{ name: string; fileName: string; body: string }>;
    error: string | null;
  };
  /**
   * Toggles `showAllNodes` on/off.
   */
  toggleShowAllNodes: () => void;
  setSessionTitle: (title: string) => void;
  setModelConfig: (updates: Partial<SessionModelConfig>) => void;
  resetModelConfig: () => void;
  importCatFiles: (files: FileList | File[]) => Promise<void>;
  removeCatFile: (fileName: string) => void;
  setNodes: (updater: NodesUpdater) => void;
  setEdges: (updater: EdgesUpdater) => void;
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  deleteNode: (nodeId: string) => void;
  deleteThread: (threadId: string) => void;
  /**
   * Duplicate all nodes/edges belonging to a thread into a brand new thread.
   *
   * The new thread receives:
   * - cloned nodes with new ids and updated `threadId`
   * - cloned intra-thread edges (where both endpoints are in the duplicated set)
   *
   * Notes:
   * - cross-thread edges are intentionally not duplicated
   * - branch metadata (`branchId`) is remapped when it points at a duplicated node
   *
   * @param sourceThreadId - Thread id to duplicate.
   * @returns Newly created thread id.
   */
  duplicateThread: (sourceThreadId: string) => string;
  addMemoryVar: (variable: MemoryVariable) => void;
  updateMemoryVar: (id: string, updates: Partial<MemoryVariable>) => void;
  deleteMemoryVar: (id: string) => void;
  toggleMemorySelection: (id: string) => void;
  clearMemorySelection: () => void;
  groupSelectedIntoStruct: () => void;
  setThreads: (threads: string[]) => void;
  addThread: () => string;
  setThreadLabel: (threadId: string, label: string) => void;
  setActiveBranch: (branch: ActiveBranch | null) => void;
  cycleEdgeLabelMode: () => void;
  setFocusedEdgeLabelId: (edgeId: string | null) => void;
  /**
   * Marks the current session as "saved" by updating `savedSessionFingerprint`.
   * Intended to be called after successful Export / Share actions.
   */
  markSessionSaved: () => void;
  validateGraph: () => void;
  resetSession: () => void;
  importSession: (snapshot: SessionSnapshot) => void;
};

const applyUpdater = <T,>(current: T, updater: T | ((value: T) => T)) =>
  typeof updater === "function" ? (updater as (value: T) => T)(current) : updater;

const flattenMemorySnapshot = (snapshot: SessionSnapshot) => [
  ...snapshot.memory.constants,
  ...snapshot.memory.locals,
  ...snapshot.memory.shared,
];

const DEFAULT_MEMORY_ENV: MemoryVariable[] = [
  {
    id: "const-null",
    name: "NULL",
    type: "int",
    scope: "constants",
    value: "0",
  },
];

const createDefaultMemoryEnv = () =>
  DEFAULT_MEMORY_ENV.map((item) => ({
    ...item,
  }));

const createDefaultModelConfig = (): SessionModelConfig => ({
  relationTypes: [...DEFAULT_MODEL_CONFIG.relationTypes],
  memoryOrders: [...DEFAULT_MODEL_CONFIG.memoryOrders],
});

const createSavedFingerprint = ({
  title,
  modelConfig,
  memoryEnv,
  nodes,
  edges,
  threads,
  threadLabels,
  activeBranch,
}: {
  title: string;
  modelConfig: SessionModelConfig;
  memoryEnv: MemoryVariable[];
  nodes: TraceNode[];
  edges: RelationEdge[];
  threads: string[];
  threadLabels: Record<string, string>;
  activeBranch: ActiveBranch | null;
}) =>
  createSessionFingerprint({
    title,
    modelConfig,
    memoryEnv,
    nodes,
    edges,
    threads,
    threadLabels,
    activeBranch,
  });

const uniqueInOrder = (items: string[]) => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
};

const normalizeModelConfig = (config: SessionModelConfig): SessionModelConfig => ({
  relationTypes: uniqueInOrder(config.relationTypes),
  memoryOrders: uniqueInOrder(config.memoryOrders),
});

const getNextThreadId = (threads: string[]) => {
  const used = new Set(threads);
  let maxIndex = -1;

  for (const threadId of threads) {
    const match = /^T(\d+)$/.exec(threadId);
    if (!match) {
      continue;
    }
    const numericId = Number(match[1]);
    if (!Number.isNaN(numericId)) {
      maxIndex = Math.max(maxIndex, numericId);
    }
  }

  let nextIndex = maxIndex + 1;
  let candidate = `T${nextIndex}`;
  while (used.has(candidate)) {
    nextIndex += 1;
    candidate = `T${nextIndex}`;
  }

  return candidate;
};

/**
 * Create a globally-unique React Flow id with a stable prefix.
 *
 * @param prefix - Human-friendly id prefix (`node` / `edge`).
 * @param takenIds - Set of ids that are already used.
 */
const createUniqueReactFlowId = (
  prefix: "node" | "edge",
  takenIds: Set<string>
) => {
  let candidate = `${prefix}-${createUuid()}`;
  while (takenIds.has(candidate)) {
    candidate = `${prefix}-${createUuid()}`;
  }
  return candidate;
};

const LANE_WIDTH = 260;

/**
 * Returns the center X coordinate (in litmus space) for the given lane index.
 *
 * This must stay in sync with the lane layout logic in `src/components/EditorCanvas.tsx`.
 */
const getLaneX = (index: number) => index * LANE_WIDTH + LANE_WIDTH / 2;

/**
 * Ensures imported nodes are aligned to the lane centers dictated by the thread order.
 *
 * This prevents React Flow's layout normalization effects from immediately "dirtying"
 * freshly-imported sessions (fixtures, file imports, shared sessions).
 */
const normalizeImportedNodeLanes = ({
  nodes,
  threads,
}: {
  nodes: TraceNode[];
  threads: string[];
}) => {
  const threadSet = new Set(threads);
  const threadsForLayout = [...threads];

  for (const node of nodes) {
    const threadId = node.data.threadId;
    if (!threadSet.has(threadId)) {
      threadSet.add(threadId);
      threadsForLayout.push(threadId);
    }
  }

  const laneByThread = new Map(
    threadsForLayout.map((threadId, index) => [threadId, index] as const)
  );

  const normalizedNodes = nodes.map((node) => {
    const laneIndex = laneByThread.get(node.data.threadId) ?? 0;
    const laneCenter = getLaneX(laneIndex);
    if (node.position.y === laneCenter) {
      return node;
    }
    return {
      ...node,
      position: {
        ...node.position,
        y: laneCenter,
      },
    };
  });

  return { nodes: normalizedNodes, threadsForLayout };
};

export const useStore = create<StoreState>()((set, get) => ({
  sessionTitle: "",
  modelConfig: createDefaultModelConfig(),
  nodes: [],
  edges: [],
  memoryEnv: createDefaultMemoryEnv(),
  showAllNodes: false,
  savedSessionFingerprint: createSavedFingerprint({
    title: "",
    modelConfig: createDefaultModelConfig(),
    memoryEnv: createDefaultMemoryEnv(),
    nodes: [],
    edges: [],
    threads: ["T0"],
    threadLabels: {},
    activeBranch: null,
  }),
  selectedMemoryIds: [],
  threads: ["T0"],
  threadLabels: {},
  activeBranch: null,
  edgeLabelMode: "nonPo",
  focusedEdgeLabelId: null,
  catModel: { filesByName: {}, analysis: null, definitions: [], error: null },
  toggleShowAllNodes: () =>
    set((state) => ({
      showAllNodes: !state.showAllNodes,
    })),
  setSessionTitle: (title) => set({ sessionTitle: title }),
  setModelConfig: (updates) =>
    set((state) => ({
      modelConfig: normalizeModelConfig({ ...state.modelConfig, ...updates }),
    })),
  resetModelConfig: () =>
    set({
      modelConfig: createDefaultModelConfig(),
      catModel: { filesByName: {}, analysis: null, definitions: [], error: null },
    }),
  cycleEdgeLabelMode: () =>
    set((state) => {
      const next =
        state.edgeLabelMode === "all"
          ? "nonPo"
          : state.edgeLabelMode === "nonPo"
            ? "off"
            : "all";
      return { edgeLabelMode: next, focusedEdgeLabelId: null };
    }),
  setFocusedEdgeLabelId: (edgeId) => set({ focusedEdgeLabelId: edgeId }),
  markSessionSaved: () => {
    /**
     * This is used by UI actions that "save" without importing/resetting (e.g. Export).
     * For import/reset, the store directly writes a fresh `savedSessionFingerprint`.
     */
    const current = get();
    set({
      savedSessionFingerprint: createSavedFingerprint({
        title: current.sessionTitle,
        modelConfig: current.modelConfig,
        memoryEnv: current.memoryEnv,
        nodes: current.nodes,
        edges: current.edges,
        threads: current.threads,
        threadLabels: current.threadLabels,
        activeBranch: current.activeBranch,
      }),
    });
  },
  importCatFiles: async (files) => {
    const fileList = Array.isArray(files) ? files : Array.from(files);
    if (fileList.length === 0) {
      return;
    }

    try {
      const readResults = await Promise.all(
        fileList.map(async (file) => ({
          name: file.name,
          text: await file.text(),
        }))
      );

      set((state) => {
        const filesByName = { ...state.catModel.filesByName };
        for (const result of readResults) {
          filesByName[result.name] = result.text;
        }

        const { analysis, nonMacroDefined, nonMacroDefinitions } =
          analyzeCatFiles(filesByName);
        const relationTypes = uniqueInOrder([
          ...DEFAULT_MODEL_CONFIG.relationTypes,
          ...nonMacroDefined,
        ]);

        return {
          modelConfig: normalizeModelConfig({
            ...state.modelConfig,
            relationTypes,
          }),
          catModel: {
            filesByName,
            analysis,
            definitions: nonMacroDefinitions,
            error: null,
          },
        };
      });
    } catch (error) {
      set((state) => ({
        catModel: {
          ...state.catModel,
          error: error instanceof Error ? error.message : "Failed to read .cat file.",
        },
      }));
    }
  },
  removeCatFile: (fileName) => {
    set((state) => {
      if (!Object.prototype.hasOwnProperty.call(state.catModel.filesByName, fileName)) {
        return state;
      }
      const filesByName = { ...state.catModel.filesByName };
      delete filesByName[fileName];

      const { analysis, nonMacroDefined, nonMacroDefinitions } = analyzeCatFiles(filesByName);
      const relationTypes = uniqueInOrder([
        ...DEFAULT_MODEL_CONFIG.relationTypes,
        ...nonMacroDefined,
      ]);

      return {
        ...state,
        modelConfig: normalizeModelConfig({
          ...state.modelConfig,
          relationTypes,
        }),
        catModel: {
          filesByName,
          analysis,
          definitions: nonMacroDefinitions,
          error: null,
        },
      };
    });
  },
  setNodes: (updater) =>
    set((state) => ({ nodes: applyUpdater(state.nodes, updater) })),
  setEdges: (updater) =>
    set((state) => ({ edges: applyUpdater(state.edges, updater) })),
  onNodesChange: (changes) =>
    set((state) => ({ nodes: applyNodeChanges(changes, state.nodes) })),
  onEdgesChange: (changes) =>
    set((state) => ({ edges: applyEdgeChanges(changes, state.edges) })),
  deleteNode: (nodeId) => {
    const { nodes, edges, activeBranch } = get();
    const node = nodes.find((candidate) => candidate.id === nodeId);
    const isBranch = node?.data.operation.type === "BRANCH";

    const nextNodes = nodes
      .filter((candidate) => candidate.id !== nodeId)
      .map((candidate) => {
        if (!isBranch || candidate.data.branchId !== nodeId) {
          return candidate;
        }
        const nextData = { ...candidate.data };
        delete nextData.branchId;
        delete nextData.branchPath;
        return { ...candidate, data: nextData };
      });

    const nextEdges = edges.filter(
      (edge) => edge.source !== nodeId && edge.target !== nodeId
    );

    set({
      nodes: nextNodes,
      edges: nextEdges,
      activeBranch: activeBranch?.branchId === nodeId ? null : activeBranch,
    });

    get().validateGraph();
  },
  deleteThread: (threadId) => {
    const { nodes, edges, threads, threadLabels, activeBranch } = get();
    const nodeIdsToDelete = new Set(
      nodes.filter((node) => node.data.threadId === threadId).map((node) => node.id)
    );

    const nextNodes = nodes
      .filter((node) => !nodeIdsToDelete.has(node.id))
      .map((node) => {
        if (!node.data.branchId || !nodeIdsToDelete.has(node.data.branchId)) {
          return node;
        }
        const nextData = { ...node.data };
        delete nextData.branchId;
        delete nextData.branchPath;
        return { ...node, data: nextData };
      });
    const nextEdges = edges.filter(
      (edge) => !nodeIdsToDelete.has(edge.source) && !nodeIdsToDelete.has(edge.target)
    );

    const remainingThreads = threads.filter((id) => id !== threadId);
    const orderedThreadIds = [...remainingThreads];
    const seenThreadIds = new Set(orderedThreadIds);

    for (const node of nextNodes) {
      const id = node.data.threadId;
      if (!seenThreadIds.has(id)) {
        seenThreadIds.add(id);
        orderedThreadIds.push(id);
      }
    }

    const threadIdMap = new Map<string, string>();
    orderedThreadIds.forEach((id, index) => {
      threadIdMap.set(id, `T${index}`);
    });

    const normalizedNodes = nextNodes.map((node) => {
      const nextThreadId = threadIdMap.get(node.data.threadId);
      if (!nextThreadId || nextThreadId === node.data.threadId) {
        return node;
      }
      return {
        ...node,
        data: {
          ...node.data,
          threadId: nextThreadId,
        },
      };
    });

    const normalizedThreads = orderedThreadIds.map((_id, index) => `T${index}`);
    const normalizedThreadLabels: Record<string, string> = {};
    for (const [previousId, label] of Object.entries(threadLabels)) {
      if (previousId === threadId) {
        continue;
      }
      const nextId = threadIdMap.get(previousId);
      if (!nextId) {
        continue;
      }
      normalizedThreadLabels[nextId] = label;
    }

    set({
      nodes: normalizedNodes,
      edges: nextEdges,
      threads: normalizedThreads,
      threadLabels: normalizedThreadLabels,
      activeBranch: activeBranch && nodeIdsToDelete.has(activeBranch.branchId) ? null : activeBranch,
    });

    get().validateGraph();
  },
  duplicateThread: (sourceThreadId) => {
    const { nodes, edges, threads, threadLabels } = get();

    /**
     * Thread ids can originate from sessions (imports/shares) and may be present
     * on nodes even if the `threads` list is incomplete. Consider both sources
     * to ensure we always mint a truly new thread id.
     */
    const takenThreadIds = new Set<string>(threads);
    for (const node of nodes) {
      takenThreadIds.add(node.data.threadId);
    }
    const nextThreadId = getNextThreadId(Array.from(takenThreadIds));

    const sourceNodes = nodes.filter((node) => node.data.threadId === sourceThreadId);
    const sourceNodeIds = new Set(sourceNodes.map((node) => node.id));

    const takenNodeIds = new Set(nodes.map((node) => node.id));
    const idMap = new Map<string, string>();
    for (const sourceId of sourceNodeIds) {
      const nextId = createUniqueReactFlowId("node", takenNodeIds);
      takenNodeIds.add(nextId);
      idMap.set(sourceId, nextId);
    }

    // Append the new thread at the end of the explicit `threads` ordering.
    const laneCenter = getLaneX(threads.length);

    const duplicatedNodes: TraceNode[] = sourceNodes.map((node) => {
      const nextId = idMap.get(node.id)!;

      const nextBranchId =
        node.data.branchId && idMap.has(node.data.branchId)
          ? idMap.get(node.data.branchId)
          : node.data.branchId;

      return {
        ...node,
        id: nextId,
        selected: false,
        position: {
          ...node.position,
          y: laneCenter,
        },
        data: {
          ...node.data,
          threadId: nextThreadId,
          branchId: nextBranchId,
        },
      };
    });

    const takenEdgeIds = new Set(edges.map((edge) => edge.id));
    const duplicatedEdges: RelationEdge[] = edges
      .filter((edge) => sourceNodeIds.has(edge.source) && sourceNodeIds.has(edge.target))
      .map((edge) => {
        const nextSource = idMap.get(edge.source)!;
        const nextTarget = idMap.get(edge.target)!;

        const nextId = createUniqueReactFlowId("edge", takenEdgeIds);
        takenEdgeIds.add(nextId);

        return {
          ...edge,
          id: nextId,
          source: nextSource,
          target: nextTarget,
          selected: false,
        };
      });

    const sourceLabel = threadLabels[sourceThreadId]?.trim();
    const nextThreadLabels = { ...threadLabels };
    if (sourceLabel) {
      nextThreadLabels[nextThreadId] = `${sourceLabel} (copy)`;
    }

    set({
      threads: [...threads, nextThreadId],
      threadLabels: nextThreadLabels,
      nodes: [...nodes, ...duplicatedNodes],
      edges: [...edges, ...duplicatedEdges],
    });

    get().validateGraph();
    return nextThreadId;
  },
  addMemoryVar: (variable) =>
    set((state) => ({ memoryEnv: [...state.memoryEnv, variable] })),
  updateMemoryVar: (id, updates) =>
    set((state) => ({
      memoryEnv: state.memoryEnv.map((variable) =>
        variable.id === id ? { ...variable, ...updates } : variable
      ),
    })),
  deleteMemoryVar: (id) => {
    const { memoryEnv, nodes, selectedMemoryIds } = get();
    const deleting = memoryEnv.find((item) => item.id === id);
    if (!deleting) {
      return;
    }

    const nextMemoryEnv = memoryEnv
      .filter((item) => item.id !== id)
      .map((item) => {
        let next = item;

        if (next.parentId === id) {
          next = { ...next, parentId: undefined };
        }

        if (next.type === "ptr" && next.pointsToId === id) {
          // Avoid leaving dangling pointer targets after a delete.
          next = { ...next, pointsToId: undefined };
        }

        return next;
      });

    const scrubOperation = (op: TraceNode["data"]["operation"]) => {
      const next = { ...op };
      if (next.addressId === id) {
        next.addressId = undefined;
      }
      if (next.indexId === id) {
        next.indexId = undefined;
      }
      if (next.valueId === id) {
        next.valueId = undefined;
      }
      if (next.resultId === id) {
        next.resultId = undefined;
      }
      if (next.expectedValueId === id) {
        next.expectedValueId = undefined;
      }
      if (next.desiredValueId === id) {
        next.desiredValueId = undefined;
      }
      if (next.type === "BRANCH") {
        next.branchCondition = scrubBranchCondition(next.branchCondition, id) as
          | BranchGroupCondition
          | undefined;
      }
      return next;
    };

    const nextNodes = nodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        operation: scrubOperation(node.data.operation),
      },
    }));

    set({
      memoryEnv: nextMemoryEnv,
      nodes: nextNodes,
      selectedMemoryIds: selectedMemoryIds.filter((selectedId) => selectedId !== id),
    });
    get().validateGraph();
  },
  toggleMemorySelection: (id) =>
    set((state) => ({
      selectedMemoryIds: state.selectedMemoryIds.includes(id)
        ? state.selectedMemoryIds.filter((selectedId) => selectedId !== id)
        : [...state.selectedMemoryIds, id],
    })),
  clearMemorySelection: () => set({ selectedMemoryIds: [] }),
  groupSelectedIntoStruct: () => {
    const { memoryEnv, selectedMemoryIds } = get();
    const selectedItems = memoryEnv.filter(
      (item) =>
        selectedMemoryIds.includes(item.id) &&
        item.type !== "struct" &&
        !item.parentId
    );

    if (selectedItems.length < 2) {
      return;
    }

    const scopes = new Set(selectedItems.map((item) => item.scope));
    if (scopes.size !== 1) {
      return;
    }

    const structCount = memoryEnv.filter((item) => item.type === "struct").length;
    const structId = `struct-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;
    const structScope = selectedItems[0].scope;

    const structVariable: MemoryVariable = {
      id: structId,
      name: `struct_${structCount + 1}`,
      type: "struct",
      scope: structScope,
    };

    const updatedEnv = memoryEnv.map((item) =>
      selectedMemoryIds.includes(item.id)
        ? { ...item, parentId: structId }
        : item
    );

    set({
      memoryEnv: [...updatedEnv, structVariable],
      selectedMemoryIds: [],
    });
  },
  setThreads: (threads) =>
    set((state) => {
      const validThreads = new Set(threads);
      const nextLabels: Record<string, string> = {};
      for (const [threadId, label] of Object.entries(state.threadLabels)) {
        if (validThreads.has(threadId)) {
          nextLabels[threadId] = label;
        }
      }
      return { threads, threadLabels: nextLabels };
    }),
  addThread: () => {
    const currentThreads = get().threads;
    const nextId = getNextThreadId(currentThreads);
    set({ threads: [...currentThreads, nextId] });
    return nextId;
  },
  setThreadLabel: (threadId, label) =>
    set((state) => {
      const trimmed = label.trim();
      const nextLabels = { ...state.threadLabels };
      if (!trimmed) {
        if (!Object.prototype.hasOwnProperty.call(nextLabels, threadId)) {
          return state;
        }
        delete nextLabels[threadId];
        return { threadLabels: nextLabels };
      }
      if (nextLabels[threadId] === trimmed) {
        return state;
      }
      nextLabels[threadId] = trimmed;
      return { threadLabels: nextLabels };
    }),
  setActiveBranch: (branch) => set({ activeBranch: branch }),
  validateGraph: () => {
    // Flag read-from edges that point backward within a thread's sequence.
    const nodesById = new Map(get().nodes.map((node) => [node.id, node]));
    const memoryEnv = get().memoryEnv;
    const updatedEdges = get().edges.map((edge) => {
      const relationType = edge.data?.relationType ?? "po";

      const source = nodesById.get(edge.source);
      const target = nodesById.get(edge.target);
      if (!source || !target) {
        return {
          ...edge,
          data: { ...(edge.data ?? { relationType }), relationType, invalid: false },
        };
      }

      const constraint = checkEdgeConstraints({
        relationType,
        sourceNode: source,
        targetNode: target,
        memoryEnv,
      });

      const invalidByConstraint = !constraint.allowed;

      const invalidByRfOrder =
        relationType === "rf" &&
        source.data.threadId === target.data.threadId &&
        source.data.operation.type === "STORE" &&
        target.data.operation.type === "LOAD" &&
        source.data.sequenceIndex > target.data.sequenceIndex;

      return {
        ...edge,
        data: {
          ...(edge.data ?? { relationType }),
          relationType,
          invalid: invalidByConstraint || invalidByRfOrder,
        },
      };
    });

    set({ edges: updatedEdges });
  },
  resetSession: () =>
    set(() => {
      const modelConfig = createDefaultModelConfig();
      const memoryEnv = createDefaultMemoryEnv();
      const nodes: TraceNode[] = [];
      const edges: RelationEdge[] = [];
      const threads = ["T0"];
      const threadLabels: Record<string, string> = {};
      const activeBranch = null;
      const sessionTitle = "";

      return {
        sessionTitle,
        modelConfig,
        nodes,
        edges,
        memoryEnv,
        showAllNodes: false,
        savedSessionFingerprint: createSavedFingerprint({
          title: sessionTitle,
          modelConfig,
          memoryEnv,
          nodes,
          edges,
          threads,
          threadLabels,
          activeBranch,
        }),
        selectedMemoryIds: [],
        threads,
        threadLabels,
        activeBranch,
        catModel: { filesByName: {}, analysis: null, definitions: [], error: null },
      };
    }),
  importSession: (snapshot) => {
    const sessionTitle = snapshot.title ?? "";
    const modelConfig = normalizeModelConfig(
      snapshot.model ?? createDefaultModelConfig()
    );
    const nodes = snapshot.nodes.map((node) => ({ ...node, selected: false }));
    const edges = snapshot.edges.map((edge) => ({ ...edge, selected: false }));
    const memoryEnv = flattenMemorySnapshot(snapshot);
    const threads = snapshot.threads.length > 0 ? snapshot.threads : ["T0"];
    const threadLabels: Record<string, string> = {};
    for (const threadId of threads) {
      const label = snapshot.threadLabels?.[threadId]?.trim();
      if (label) {
        threadLabels[threadId] = label;
      }
    }
    const activeBranch = snapshot.activeBranch;

    const normalized = normalizeImportedNodeLanes({ nodes, threads });

    set({
      sessionTitle,
      modelConfig,
      nodes: normalized.nodes,
      edges,
      memoryEnv,
      showAllNodes: false,
      savedSessionFingerprint: createSavedFingerprint({
        title: sessionTitle,
        modelConfig,
        memoryEnv,
        nodes: normalized.nodes,
        edges,
        threads,
        threadLabels,
        activeBranch,
      }),
      selectedMemoryIds: [],
      threads,
      threadLabels,
      activeBranch,
      catModel: { filesByName: {}, analysis: null, definitions: [], error: null },
    });
  },
}));
