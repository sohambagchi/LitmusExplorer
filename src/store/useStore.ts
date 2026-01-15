import { create } from "zustand";
import {
  applyEdgeChanges,
  applyNodeChanges,
  type EdgeChange,
  type NodeChange,
} from "reactflow";
import type {
  ActiveBranch,
  MemoryVariable,
  RelationEdge,
  SessionSnapshot,
  TraceNode,
} from "../types";
import { checkEdgeConstraints } from "../utils/edgeConstraints";

type NodesUpdater = TraceNode[] | ((nodes: TraceNode[]) => TraceNode[]);
type EdgesUpdater = RelationEdge[] | ((edges: RelationEdge[]) => RelationEdge[]);

type StoreState = {
  sessionTitle: string;
  nodes: TraceNode[];
  edges: RelationEdge[];
  memoryEnv: MemoryVariable[];
  selectedMemoryIds: string[];
  threads: string[];
  activeBranch: ActiveBranch | null;
  setSessionTitle: (title: string) => void;
  setNodes: (updater: NodesUpdater) => void;
  setEdges: (updater: EdgesUpdater) => void;
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  deleteNode: (nodeId: string) => void;
  deleteThread: (threadId: string) => void;
  addMemoryVar: (variable: MemoryVariable) => void;
  updateMemoryVar: (id: string, updates: Partial<MemoryVariable>) => void;
  toggleMemorySelection: (id: string) => void;
  clearMemorySelection: () => void;
  groupSelectedIntoStruct: () => void;
  setThreads: (threads: string[]) => void;
  addThread: () => string;
  setActiveBranch: (branch: ActiveBranch | null) => void;
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
  nodes: [],
  edges: [],
  memoryEnv: createDefaultMemoryEnv(),
  selectedMemoryIds: [],
  threads: ["T0"],
  activeBranch: null,
  setSessionTitle: (title) => set({ sessionTitle: title }),
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

    const nextNodes = nodes.filter((node) => !nodeIdsToDelete.has(node.id));
    const nextEdges = edges.filter(
      (edge) => !nodeIdsToDelete.has(edge.source) && !nodeIdsToDelete.has(edge.target)
    );

    const nextThreads = threads.filter((id) => id !== threadId);

    set({
      nodes: nextNodes,
      edges: nextEdges,
      threads: nextThreads.length > 0 ? nextThreads : ["T0"],
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
      nodes: [],
      edges: [],
      memoryEnv: createDefaultMemoryEnv(),
      selectedMemoryIds: [],
      threads: ["T0"],
      activeBranch: null,
    }),
  importSession: (snapshot) => {
    set({
      sessionTitle: snapshot.title ?? "",
      nodes: snapshot.nodes.map((node) => ({ ...node, selected: false })),
      edges: snapshot.edges.map((edge) => ({ ...edge, selected: false })),
      memoryEnv: flattenMemorySnapshot(snapshot),
      selectedMemoryIds: [],
      threads: snapshot.threads.length > 0 ? snapshot.threads : ["T0"],
      activeBranch: snapshot.activeBranch,
    });
  },
}));
