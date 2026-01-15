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
  selectedMemoryIds: string[];
  threads: string[];
  activeBranch: ActiveBranch | null;
  edgeLabelMode: "all" | "nonPo" | "off";
  focusedEdgeLabelId: string | null;
  catModel: {
    filesByName: Record<string, string>;
    analysis: CatModelAnalysis | null;
    definitions: Array<{ name: string; fileName: string; body: string }>;
    error: string | null;
  };
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
  addMemoryVar: (variable: MemoryVariable) => void;
  updateMemoryVar: (id: string, updates: Partial<MemoryVariable>) => void;
  deleteMemoryVar: (id: string) => void;
  toggleMemorySelection: (id: string) => void;
  clearMemorySelection: () => void;
  groupSelectedIntoStruct: () => void;
  setThreads: (threads: string[]) => void;
  addThread: () => string;
  setActiveBranch: (branch: ActiveBranch | null) => void;
  cycleEdgeLabelMode: () => void;
  setFocusedEdgeLabelId: (edgeId: string | null) => void;
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

export const useStore = create<StoreState>()((set, get) => ({
  sessionTitle: "",
  modelConfig: createDefaultModelConfig(),
  nodes: [],
  edges: [],
  memoryEnv: createDefaultMemoryEnv(),
  selectedMemoryIds: [],
  threads: ["T0"],
  activeBranch: null,
  edgeLabelMode: "nonPo",
  focusedEdgeLabelId: null,
  catModel: { filesByName: {}, analysis: null, definitions: [], error: null },
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
    const { nodes, edges, threads, activeBranch } = get();
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

    set({
      nodes: normalizedNodes,
      edges: nextEdges,
      threads: normalizedThreads,
      activeBranch: activeBranch && nodeIdsToDelete.has(activeBranch.branchId) ? null : activeBranch,
    });

    get().validateGraph();
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
        if (item.parentId !== id) {
          return item;
        }
        return { ...item, parentId: undefined };
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
  setThreads: (threads) => set({ threads }),
  addThread: () => {
    const currentThreads = get().threads;
    const nextId = getNextThreadId(currentThreads);
    set({ threads: [...currentThreads, nextId] });
    return nextId;
  },
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
    set({
      sessionTitle: "",
      modelConfig: createDefaultModelConfig(),
      nodes: [],
      edges: [],
      memoryEnv: createDefaultMemoryEnv(),
      selectedMemoryIds: [],
      threads: ["T0"],
      activeBranch: null,
      catModel: { filesByName: {}, analysis: null, definitions: [], error: null },
    }),
  importSession: (snapshot) => {
    set({
      sessionTitle: snapshot.title ?? "",
      modelConfig: normalizeModelConfig(snapshot.model ?? createDefaultModelConfig()),
      nodes: snapshot.nodes.map((node) => ({ ...node, selected: false })),
      edges: snapshot.edges.map((edge) => ({ ...edge, selected: false })),
      memoryEnv: flattenMemorySnapshot(snapshot),
      selectedMemoryIds: [],
      threads: snapshot.threads.length > 0 ? snapshot.threads : ["T0"],
      activeBranch: snapshot.activeBranch,
      catModel: { filesByName: {}, analysis: null, definitions: [], error: null },
    });
  },
}));
