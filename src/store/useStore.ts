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
  /**
   * When enabled, highlight dependency edges/nodes that flow into the selected node.
   *
   * Notes:
   * - "Inbound" means following `ad`/`cd`/`dd` edges backward (target -> source).
   * - Highlighting is a UI-only affordance and does not affect exported sessions.
   */
  highlightInboundDependencies: boolean;
  /**
   * When enabled, highlight dependency edges/nodes that flow out of the selected node.
   *
   * Notes:
   * - "Outbound" means following `ad`/`cd`/`dd` edges forward (source -> target).
   * - Highlighting is a UI-only affordance and does not affect exported sessions.
   */
  highlightOutboundDependencies: boolean;
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
  /**
   * Updates the explicit thread ordering and realigns every node to the lane centers
   * implied by that ordering.
   *
   * Notes:
   * - Thread ids can originate from imported sessions; nodes may reference ids that
   *   are missing from the current `threads` list. This function appends any such
   *   thread ids (in deterministic discovery order) so lane math stays consistent.
   * - Reordering threads mutates node positions (litmus-space `position.y`) so the
   *   visual columns move with the thread id.
   *
   * @param threads - Ordered list of thread ids (e.g. `["T0", "T2", "T1"]`).
   */
  setThreads: (threads: string[]) => void;
  addThread: () => string;
  setThreadLabel: (threadId: string, label: string) => void;
  setActiveBranch: (branch: ActiveBranch | null) => void;
  cycleEdgeLabelMode: () => void;
  setFocusedEdgeLabelId: (edgeId: string | null) => void;
  setHighlightInboundDependencies: (enabled: boolean) => void;
  setHighlightOutboundDependencies: (enabled: boolean) => void;
  /**
   * Marks the current session as "saved" by updating `savedSessionFingerprint`.
   * Intended to be called after successful Export / Share actions.
   */
  markSessionSaved: () => void;
  validateGraph: () => void;
  resetSession: () => void;
  importSession: (snapshot: SessionSnapshot) => void;
  /**
   * Appends an imported snapshot into the current session instead of replacing it.
   *
   * Composition rules:
   * - Imported threads are remapped to new `T{n}` ids and appended after existing threads.
   * - Shared memory locations with the same name and type are merged.
   * - Constants with the same name, type, and value are merged; name/type conflicts
   *   with differing values are disambiguated with `_c`/`_i` suffixes.
   * - Local registers are preserved from the current session; imported `r{n}`/`p{n}`
   *   registers are re-numbered into gaps and then appended to avoid collisions.
   *
   * Notes:
   * - Only imported nodes/edges are rewritten (id remaps, thread remaps, register remaps).
   * - Current selection state is cleared so the combined graph starts "clean".
   *
   * @param snapshot - Parsed session snapshot to append.
   */
  appendSession: (snapshot: SessionSnapshot) => void;
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

/**
 * Create a globally-unique memory variable id.
 *
 * Memory ids are referenced by nodes/edges and must be collision-free across imports.
 *
 * @param takenIds - Set of ids that are already used.
 */
const createUniqueMemoryId = (takenIds: Set<string>) => {
  let candidate = `mem-${createUuid()}`;
  while (takenIds.has(candidate)) {
    candidate = `mem-${createUuid()}`;
  }
  return candidate;
};

/**
 * Parses a "register-style" local name into its kind + numeric index.
 *
 * We treat both integer registers (`r0`, `r1`, ...) and pointer registers (`p0`, `p1`, ...)
 * as members of a shared "numbered register" namespace for composition.
 *
 * @param name - Memory variable name.
 * @returns Parsed `{ prefix, index }` or `null` if not a numbered register.
 */
const parseNumberedRegisterName = (
  name: string
): { prefix: "r" | "p"; index: number } | null => {
  const match = /^(r|p)(\d+)$/.exec(name.trim());
  if (!match) {
    return null;
  }
  const prefix = match[1] as "r" | "p";
  const index = Number(match[2]);
  if (Number.isNaN(index)) {
    return null;
  }
  return { prefix, index };
};

/**
 * Computes the lowest available numbered register name for a given prefix.
 *
 * "Available" means:
 * - the numeric slot is not currently used, and
 * - the resulting name does not collide with any other local variable name.
 *
 * @param prefix - Register prefix (`r` / `p`).
 * @param usedIndices - Indices already taken by existing locals.
 * @param usedNames - Local names already taken by existing locals.
 * @param startIndex - Starting index to consider.
 */
const allocateNextRegisterName = ({
  prefix,
  usedIndices,
  usedNames,
  startIndex,
}: {
  prefix: "r" | "p";
  usedIndices: Set<number>;
  usedNames: Set<string>;
  startIndex: number;
}) => {
  let index = startIndex;
  let candidate = `${prefix}${index}`;
  while (usedIndices.has(index) || usedNames.has(candidate)) {
    index += 1;
    candidate = `${prefix}${index}`;
  }
  usedIndices.add(index);
  usedNames.add(candidate);
  return { name: candidate, nextIndex: index + 1 };
};

/**
 * Returns a deterministic "path key" for a memory variable, including its parent chain.
 *
 * This is used to merge shared memory variables by their "qualified name" and type,
 * while still distinguishing similarly named members under different parent structs.
 *
 * @param id - Memory variable id to key.
 * @param memoryById - Memory environment indexed by id.
 */
const createQualifiedMemoryKey = (
  id: string,
  memoryById: Map<string, MemoryVariable>
) => {
  const parts: string[] = [];
  const visited = new Set<string>();
  let cursor: MemoryVariable | undefined = memoryById.get(id);

  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    const label = cursor.name.trim() || cursor.id;
    parts.push(`${label}#${cursor.type}`);
    cursor = cursor.parentId ? memoryById.get(cursor.parentId) : undefined;
  }

  return parts.reverse().join(".");
};

/**
 * Deeply remaps a branch-condition tree by rewriting referenced memory ids.
 *
 * @param condition - Condition tree to remap.
 * @param memoryIdMap - Old-to-new memory id map.
 */
const remapBranchConditionMemoryIds = (
  condition: BranchCondition | undefined,
  memoryIdMap: Map<string, string>
): BranchCondition | undefined => {
  if (!condition) {
    return condition;
  }

  if (condition.kind === "rule") {
    return {
      ...condition,
      lhsId: condition.lhsId ? (memoryIdMap.get(condition.lhsId) ?? condition.lhsId) : undefined,
      rhsId: condition.rhsId ? (memoryIdMap.get(condition.rhsId) ?? condition.rhsId) : undefined,
    };
  }

  return {
    ...condition,
    items: condition.items.map((item) =>
      remapBranchConditionMemoryIds(item, memoryIdMap)
    ) as BranchCondition[],
  };
};

/**
 * Remaps all memory-variable-id fields inside an operation.
 *
 * @param operation - Operation to rewrite.
 * @param memoryIdMap - Old-to-new memory id map.
 */
const remapOperationMemoryIds = (
  operation: TraceNode["data"]["operation"],
  memoryIdMap: Map<string, string>
) => {
  const remap = (id: string | undefined) => (id ? memoryIdMap.get(id) ?? id : undefined);

  const next = {
    ...operation,
    addressId: remap(operation.addressId),
    indexId: remap(operation.indexId),
    memberId: remap(operation.memberId),
    resultId: remap(operation.resultId),
    valueId: remap(operation.valueId),
    expectedValueId: remap(operation.expectedValueId),
    desiredValueId: remap(operation.desiredValueId),
  };

  if (operation.type === "BRANCH") {
    return {
      ...next,
      branchCondition: remapBranchConditionMemoryIds(
        operation.branchCondition,
        memoryIdMap
      ) as BranchGroupCondition | undefined,
    };
  }

  return next;
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
  highlightInboundDependencies: false,
  highlightOutboundDependencies: false,
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
  setHighlightInboundDependencies: (enabled) =>
    set({ highlightInboundDependencies: enabled }),
  setHighlightOutboundDependencies: (enabled) =>
    set({ highlightOutboundDependencies: enabled }),
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

        if (next.type === "array" && next.elementPointsToId === id) {
          // Avoid leaving dangling array-of-ptr element targets after a delete.
          next = { ...next, elementPointsToId: undefined };
        }

        if (next.type === "array" && next.elementStructId === id) {
          // Avoid leaving dangling array-of-struct element templates after a delete.
          next = { ...next, elementStructId: undefined };
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
      if (next.memberId === id) {
        next.memberId = undefined;
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
      /**
       * Accept the requested order, but always include any thread ids referenced
       * by nodes. This avoids leaving nodes "orphaned" in a lane that no longer
       * has a corresponding header column.
       */
      const requestedOrder = uniqueInOrder(threads);
      const validThreads = new Set(requestedOrder);
      const completeOrder = [...requestedOrder];

      for (const node of state.nodes) {
        const threadId = node.data.threadId;
        if (!validThreads.has(threadId)) {
          validThreads.add(threadId);
          completeOrder.push(threadId);
        }
      }

      const laneCenterByThread = new Map(
        completeOrder.map((threadId, index) => [threadId, getLaneX(index)] as const)
      );

      const alignedNodes = state.nodes.map((node) => {
        const laneCenter = laneCenterByThread.get(node.data.threadId);
        if (typeof laneCenter === "undefined" || node.position.y === laneCenter) {
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

      const nextLabels: Record<string, string> = {};
      for (const [threadId, label] of Object.entries(state.threadLabels)) {
        if (validThreads.has(threadId)) {
          nextLabels[threadId] = label;
        }
      }
      return { threads: completeOrder, threadLabels: nextLabels, nodes: alignedNodes };
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
  appendSession: (snapshot) => {
    const current = get();

    const hasActiveGraph =
      current.nodes.length > 0 ||
      current.edges.length > 0 ||
      current.memoryEnv.some((item) => item.scope !== "constants" || item.id !== "const-null");

    if (!hasActiveGraph) {
      /**
       * Treat appending into an empty editor as a normal import so:
       * - titles/model config are sourced from the snapshot
       * - cat model state is reset consistently with other imports
       */
      current.importSession(snapshot);
      return;
    }

    const importedThreadsSeed =
      snapshot.threads.length > 0 ? snapshot.threads : ["T0"];
    const importedThreadOrder: string[] = [];
    const importedThreadSet = new Set<string>();
    for (const threadId of importedThreadsSeed) {
      if (!importedThreadSet.has(threadId)) {
        importedThreadSet.add(threadId);
        importedThreadOrder.push(threadId);
      }
    }
    for (const node of snapshot.nodes) {
      const threadId = node.data.threadId;
      if (!importedThreadSet.has(threadId)) {
        importedThreadSet.add(threadId);
        importedThreadOrder.push(threadId);
      }
    }

    /**
     * Remap imported thread ids onto fresh `T{n}` ids appended after the current threads.
     * We consider both the explicit thread ordering and any thread ids used by existing nodes.
     */
    const takenThreadIds = new Set<string>(current.threads);
    for (const node of current.nodes) {
      takenThreadIds.add(node.data.threadId);
    }
    const threadIdMap = new Map<string, string>();
    const appendedThreads: string[] = [];
    for (const importedThreadId of importedThreadOrder) {
      const nextThreadId = getNextThreadId(Array.from(takenThreadIds));
      takenThreadIds.add(nextThreadId);
      threadIdMap.set(importedThreadId, nextThreadId);
      appendedThreads.push(nextThreadId);
    }

    const nextThreads = [...current.threads, ...appendedThreads];
    const nextThreadLabels = { ...current.threadLabels };
    for (const importedThreadId of importedThreadOrder) {
      const mapped = threadIdMap.get(importedThreadId);
      if (!mapped) {
        continue;
      }
      const label = snapshot.threadLabels?.[importedThreadId]?.trim();
      if (label) {
        nextThreadLabels[mapped] = label;
      }
    }

    const takenMemoryIds = new Set(current.memoryEnv.map((item) => item.id));

    const currentMemoryEnv = current.memoryEnv.map((item) => ({ ...item }));
    const currentMemoryByIdOriginal = new Map(
      current.memoryEnv.map((item) => [item.id, item] as const)
    );

    const importedConstants = snapshot.memory.constants;
    const importedLocals = snapshot.memory.locals;
    const importedShared = snapshot.memory.shared;

    /**
     * Local variable conflicts (non-numbered names) are disambiguated by suffixing:
     * - current: `${name}_c`
     * - imported: `${name}_i`
     */
    const currentNonRegisterLocalNames = new Set<string>();
    for (const item of current.memoryEnv) {
      if (item.scope !== "locals") {
        continue;
      }
      const name = item.name.trim();
      if (!name) {
        continue;
      }
      if (parseNumberedRegisterName(name)) {
        continue;
      }
      currentNonRegisterLocalNames.add(name);
    }

    const importedNonRegisterLocalNames = new Set<string>();
    for (const item of importedLocals) {
      const name = item.name.trim();
      if (!name) {
        continue;
      }
      if (parseNumberedRegisterName(name)) {
        continue;
      }
      importedNonRegisterLocalNames.add(name);
    }

    const conflictingNonRegisterLocalNames = new Set<string>();
    for (const name of importedNonRegisterLocalNames) {
      if (currentNonRegisterLocalNames.has(name)) {
        conflictingNonRegisterLocalNames.add(name);
      }
    }

    const usedLocalNames = new Set<string>();
    const usedRegisterIndices = {
      r: new Set<number>(),
      p: new Set<number>(),
    };
    for (const item of currentMemoryEnv) {
      if (item.scope !== "locals") {
        continue;
      }
      const trimmed = item.name.trim();
      if (!trimmed) {
        continue;
      }
      usedLocalNames.add(trimmed);
      const reg = parseNumberedRegisterName(trimmed);
      if (reg) {
        usedRegisterIndices[reg.prefix].add(reg.index);
      }
    }

    for (const item of currentMemoryEnv) {
      if (item.scope !== "locals") {
        continue;
      }
      const name = item.name.trim();
      if (!name || parseNumberedRegisterName(name)) {
        continue;
      }
      if (!conflictingNonRegisterLocalNames.has(name)) {
        continue;
      }
      const preferred = `${name}_c`;
      let candidate = preferred;
      let counter = 1;
      while (usedLocalNames.has(candidate)) {
        candidate = `${preferred}_${counter}`;
        counter += 1;
      }
      usedLocalNames.add(candidate);
      item.name = candidate;
    }

    /**
     * Constants can be merged when name/type/value match; otherwise, name/type conflicts
     * are disambiguated by suffixing the current constant(s) with `_c` and importing
     * new constants with `_i`.
     */
    const normalizeConstantValue = (item: MemoryVariable) => {
      if (item.type !== "int") {
        return "";
      }
      return (item.value ?? "").toString().trim();
    };

    const constantNameTypeKey = (item: MemoryVariable) =>
      `${item.name.trim()}::${item.type}`;
    const constantMergeKey = (item: MemoryVariable) =>
      `${item.name.trim()}::${item.type}::${normalizeConstantValue(item)}`;

    const currentConstantsByMergeKey = new Map<string, string>();
    const currentConstantValueByNameType = new Map<string, Set<string>>();
    for (const item of current.memoryEnv) {
      if (item.scope !== "constants") {
        continue;
      }
      const mergeKey = constantMergeKey(item);
      if (!currentConstantsByMergeKey.has(mergeKey)) {
        currentConstantsByMergeKey.set(mergeKey, item.id);
      }

      const nameType = constantNameTypeKey(item);
      const set = currentConstantValueByNameType.get(nameType) ?? new Set<string>();
      set.add(normalizeConstantValue(item));
      currentConstantValueByNameType.set(nameType, set);
    }

    const importedConstantValueByNameType = new Map<string, Set<string>>();
    for (const item of importedConstants) {
      const nameType = constantNameTypeKey(item);
      const set = importedConstantValueByNameType.get(nameType) ?? new Set<string>();
      set.add(normalizeConstantValue(item));
      importedConstantValueByNameType.set(nameType, set);
    }

    const conflictingConstantNameTypes = new Set<string>();
    for (const [nameType, currentValues] of currentConstantValueByNameType) {
      const importedValues = importedConstantValueByNameType.get(nameType);
      if (!importedValues) {
        continue;
      }
      const union = new Set([...currentValues, ...importedValues]);
      if (union.size > 1) {
        conflictingConstantNameTypes.add(nameType);
      }
    }

    const usedConstantNames = new Set<string>();
    for (const item of currentMemoryEnv) {
      if (item.scope !== "constants") {
        continue;
      }
      const name = item.name.trim();
      if (name) {
        usedConstantNames.add(name);
      }
    }

    for (const item of currentMemoryEnv) {
      if (item.scope !== "constants") {
        continue;
      }
      const key = constantNameTypeKey(item);
      if (!conflictingConstantNameTypes.has(key)) {
        continue;
      }
      const baseName = item.name.trim();
      if (!baseName) {
        continue;
      }
      const preferred = `${baseName}_c`;
      let candidate = preferred;
      let counter = 1;
      while (usedConstantNames.has(candidate)) {
        candidate = `${preferred}_${counter}`;
        counter += 1;
      }
      usedConstantNames.add(candidate);
      item.name = candidate;
    }

    /**
     * Build an old->new memory id map for every imported memory variable.
     * This includes ids that are merged into existing memory variables.
     */
    const importedMemoryIdMap = new Map<string, string>();

    // Shared merge map (qualified name + type).
    const currentSharedIdByKey = new Map<string, string>();
    for (const item of current.memoryEnv) {
      if (item.scope !== "shared") {
        continue;
      }
      currentSharedIdByKey.set(
        createQualifiedMemoryKey(item.id, currentMemoryByIdOriginal),
        item.id
      );
    }
    const importedMemoryById = new Map(
      flattenMemorySnapshot(snapshot).map((item) => [item.id, item] as const)
    );
    for (const item of importedShared) {
      const key = createQualifiedMemoryKey(item.id, importedMemoryById);
      const existing = currentSharedIdByKey.get(key);
      if (existing) {
        importedMemoryIdMap.set(item.id, existing);
      } else {
        const nextId = createUniqueMemoryId(takenMemoryIds);
        takenMemoryIds.add(nextId);
        importedMemoryIdMap.set(item.id, nextId);
      }
    }

    // Locals always become new ids (with renaming rules applied below).
    for (const item of importedLocals) {
      const nextId = createUniqueMemoryId(takenMemoryIds);
      takenMemoryIds.add(nextId);
      importedMemoryIdMap.set(item.id, nextId);
    }

    // Constants can merge or create.
    for (const item of importedConstants) {
      const mergeKey = constantMergeKey(item);
      const existing = currentConstantsByMergeKey.get(mergeKey);
      if (existing) {
        importedMemoryIdMap.set(item.id, existing);
        continue;
      }
      const nextId = createUniqueMemoryId(takenMemoryIds);
      takenMemoryIds.add(nextId);
      importedMemoryIdMap.set(item.id, nextId);
    }

    /**
     * Second pass: create new MemoryVariable entries for imported items that did not merge.
     * While doing so, rewrite parent/ptr/array references through `importedMemoryIdMap`.
     */
    const remapMemoryId = (id: string | undefined) =>
      id ? importedMemoryIdMap.get(id) ?? id : undefined;

    const createdMemory: MemoryVariable[] = [];

    // Allocate imported numbered-register names into gaps, per prefix.
    const importedRegistersByPrefix: Record<"r" | "p", Array<{ id: string; index: number }>> = {
      r: [],
      p: [],
    };
    for (const item of importedLocals) {
      const parsed = parseNumberedRegisterName(item.name);
      if (!parsed) {
        continue;
      }
      importedRegistersByPrefix[parsed.prefix].push({ id: item.id, index: parsed.index });
    }
    importedRegistersByPrefix.r.sort((a, b) => a.index - b.index || a.id.localeCompare(b.id));
    importedRegistersByPrefix.p.sort((a, b) => a.index - b.index || a.id.localeCompare(b.id));

    const importedLocalNameById = new Map<string, string>();

    for (const prefix of ["r", "p"] as const) {
      let nextIndex = 0;
      for (const item of importedRegistersByPrefix[prefix]) {
        const allocation = allocateNextRegisterName({
          prefix,
          usedIndices: usedRegisterIndices[prefix],
          usedNames: usedLocalNames,
          startIndex: nextIndex,
        });
        nextIndex = allocation.nextIndex;
        importedLocalNameById.set(item.id, allocation.name);
      }
    }

    for (const item of importedLocals) {
      const mappedId = importedMemoryIdMap.get(item.id);
      if (!mappedId) {
        continue;
      }
      if (currentMemoryByIdOriginal.has(mappedId)) {
        // Imported locals never merge, but keep the guard symmetrical with other scopes.
        continue;
      }

      const baseName = item.name.trim();
      const registerName = importedLocalNameById.get(item.id);
      /**
       * For numbered registers (`r{n}`/`p{n}`), we rely on the allocator:
       * - It already avoids collisions with existing locals.
       * - It already reserves the chosen name so subsequent allocations can't reuse it.
       * Re-checking against `usedLocalNames` here would immediately collide with the
       * allocator's reservation and produce a spurious `r2_1` style suffix.
       */
      let nextName = registerName ?? baseName;

      if (!registerName) {
        if (baseName && conflictingNonRegisterLocalNames.has(baseName)) {
          nextName = `${baseName}_i`;
        }

        if (nextName) {
          let candidate = nextName;
          let counter = 1;
          while (usedLocalNames.has(candidate)) {
            candidate = `${nextName}_${counter}`;
            counter += 1;
          }
          usedLocalNames.add(candidate);
          nextName = candidate;
        }
      }

      const base: MemoryVariable = {
        ...item,
        id: mappedId,
        name: nextName,
        parentId: remapMemoryId(item.parentId),
      } as MemoryVariable;

      if (base.type === "ptr") {
        createdMemory.push({
          ...base,
          pointsToId: remapMemoryId(base.pointsToId),
        });
      } else if (base.type === "array") {
        createdMemory.push({
          ...base,
          elementStructId: remapMemoryId(base.elementStructId),
          elementPointsToId: remapMemoryId(base.elementPointsToId),
        });
      } else {
        createdMemory.push(base);
      }
    }

    for (const item of importedConstants) {
      const mappedId = importedMemoryIdMap.get(item.id);
      if (!mappedId) {
        continue;
      }
      if (currentMemoryByIdOriginal.has(mappedId)) {
        // Merged constant.
        continue;
      }

      const key = constantNameTypeKey(item);
      const baseName = item.name.trim();
      let nextName =
        baseName && conflictingConstantNameTypes.has(key) ? `${baseName}_i` : baseName;

      if (nextName) {
        let candidate = nextName;
        let counter = 1;
        while (usedConstantNames.has(candidate)) {
          candidate = `${nextName}_${counter}`;
          counter += 1;
        }
        usedConstantNames.add(candidate);
        nextName = candidate;
      }

      const base: MemoryVariable = {
        ...item,
        id: mappedId,
        name: nextName,
        parentId: remapMemoryId(item.parentId),
      } as MemoryVariable;

      if (base.type === "ptr") {
        createdMemory.push({
          ...base,
          pointsToId: remapMemoryId(base.pointsToId),
        });
      } else if (base.type === "array") {
        createdMemory.push({
          ...base,
          elementStructId: remapMemoryId(base.elementStructId),
          elementPointsToId: remapMemoryId(base.elementPointsToId),
        });
      } else {
        createdMemory.push(base);
      }
    }

    for (const item of importedShared) {
      const mappedId = importedMemoryIdMap.get(item.id);
      if (!mappedId) {
        continue;
      }
      if (currentMemoryByIdOriginal.has(mappedId)) {
        // Merged shared memory.
        continue;
      }

      const base: MemoryVariable = {
        ...item,
        id: mappedId,
        parentId: remapMemoryId(item.parentId),
      } as MemoryVariable;

      if (base.type === "ptr") {
        createdMemory.push({
          ...base,
          pointsToId: remapMemoryId(base.pointsToId),
        });
      } else if (base.type === "array") {
        createdMemory.push({
          ...base,
          elementStructId: remapMemoryId(base.elementStructId),
          elementPointsToId: remapMemoryId(base.elementPointsToId),
        });
      } else {
        createdMemory.push(base);
      }
    }

    const nextMemoryEnv = [...currentMemoryEnv, ...createdMemory];

    /**
     * Remap node/edge ids for the imported graph fragment so it can coexist
     * with the current React Flow graph.
     */
    const takenNodeIds = new Set(current.nodes.map((node) => node.id));
    const nodeIdMap = new Map<string, string>();
    for (const node of snapshot.nodes) {
      const nextId = createUniqueReactFlowId("node", takenNodeIds);
      takenNodeIds.add(nextId);
      nodeIdMap.set(node.id, nextId);
    }

    const remappedImportedNodes: TraceNode[] = snapshot.nodes.map((node) => {
      const nextId = nodeIdMap.get(node.id) ?? node.id;
      const mappedThreadId = threadIdMap.get(node.data.threadId) ?? node.data.threadId;
      const nextBranchId =
        node.data.branchId && nodeIdMap.has(node.data.branchId)
          ? nodeIdMap.get(node.data.branchId)
          : node.data.branchId;

      return {
        ...node,
        id: nextId,
        selected: false,
        data: {
          ...node.data,
          threadId: mappedThreadId,
          branchId: nextBranchId,
          operation: remapOperationMemoryIds(node.data.operation, importedMemoryIdMap),
        },
      };
    });

    const takenEdgeIds = new Set(current.edges.map((edge) => edge.id));
    const remappedImportedEdges: RelationEdge[] = snapshot.edges.map((edge) => {
      const nextId = createUniqueReactFlowId("edge", takenEdgeIds);
      takenEdgeIds.add(nextId);

      return {
        ...edge,
        id: nextId,
        selected: false,
        source: nodeIdMap.get(edge.source) ?? edge.source,
        target: nodeIdMap.get(edge.target) ?? edge.target,
      };
    });

    const currentNodesDeselected = current.nodes.map((node) => ({
      ...node,
      selected: false,
    }));
    const currentEdgesDeselected = current.edges.map((edge) => ({
      ...edge,
      selected: false,
    }));

    const combinedNodes = [...currentNodesDeselected, ...remappedImportedNodes];
    const combinedEdges = [...currentEdgesDeselected, ...remappedImportedEdges];

    // Merge model config options so imported relations/memory orders remain selectable.
    const importedModel = snapshot.model ?? createDefaultModelConfig();
    const nextModelConfig = normalizeModelConfig({
      relationTypes: uniqueInOrder([
        ...current.modelConfig.relationTypes,
        ...importedModel.relationTypes,
      ]),
      memoryOrders: uniqueInOrder([
        ...current.modelConfig.memoryOrders,
        ...importedModel.memoryOrders,
      ]),
    });

    const normalized = normalizeImportedNodeLanes({
      nodes: combinedNodes,
      threads: nextThreads,
    });

    set({
      sessionTitle: current.sessionTitle.trim()
        ? current.sessionTitle
        : snapshot.title ?? current.sessionTitle,
      modelConfig: nextModelConfig,
      memoryEnv: nextMemoryEnv,
      nodes: normalized.nodes,
      edges: combinedEdges,
      threads: normalized.threadsForLayout,
      threadLabels: nextThreadLabels,
      selectedMemoryIds: [],
      focusedEdgeLabelId: null,
      savedSessionFingerprint: createSavedFingerprint({
        title: current.sessionTitle.trim()
          ? current.sessionTitle
          : snapshot.title ?? current.sessionTitle,
        modelConfig: nextModelConfig,
        memoryEnv: nextMemoryEnv,
        nodes: normalized.nodes,
        edges: combinedEdges,
        threads: normalized.threadsForLayout,
        threadLabels: nextThreadLabels,
        activeBranch: current.activeBranch,
      }),
      activeBranch: current.activeBranch,
    });

    get().validateGraph();
  },
}));
