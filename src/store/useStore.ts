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
  RelationType,
  RelationEdge,
  SessionSnapshot,
  TraceNode,
} from "../types";

type NodesUpdater = TraceNode[] | ((nodes: TraceNode[]) => TraceNode[]);
type EdgesUpdater = RelationEdge[] | ((edges: RelationEdge[]) => RelationEdge[]);

type StoreState = {
  nodes: TraceNode[];
  edges: RelationEdge[];
  memoryEnv: MemoryVariable[];
  selectedMemoryIds: string[];
  relationTypeDraft: RelationType;
  threads: string[];
  activeBranch: ActiveBranch | null;
  setNodes: (updater: NodesUpdater) => void;
  setEdges: (updater: EdgesUpdater) => void;
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  addMemoryVar: (variable: MemoryVariable) => void;
  updateMemoryVar: (id: string, updates: Partial<MemoryVariable>) => void;
  toggleMemorySelection: (id: string) => void;
  clearMemorySelection: () => void;
  groupSelectedIntoStruct: () => void;
  setRelationTypeDraft: (relationType: RelationType) => void;
  setThreads: (threads: string[]) => void;
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

export const useStore = create<StoreState>()((set, get) => ({
  nodes: [],
  edges: [],
  memoryEnv: createDefaultMemoryEnv(),
  selectedMemoryIds: [],
  relationTypeDraft: "rf",
  threads: ["T1"],
  activeBranch: null,
  setNodes: (updater) =>
    set((state) => ({ nodes: applyUpdater(state.nodes, updater) })),
  setEdges: (updater) =>
    set((state) => ({ edges: applyUpdater(state.edges, updater) })),
  onNodesChange: (changes) =>
    set((state) => ({ nodes: applyNodeChanges(changes, state.nodes) })),
  onEdgesChange: (changes) =>
    set((state) => ({ edges: applyEdgeChanges(changes, state.edges) })),
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
  setRelationTypeDraft: (relationType) => set({ relationTypeDraft: relationType }),
  setThreads: (threads) => set({ threads }),
  setActiveBranch: (branch) => set({ activeBranch: branch }),
  validateGraph: () => {
    // Flag read-from edges that point backward within a thread's sequence.
    const nodesById = new Map(get().nodes.map((node) => [node.id, node]));
    const updatedEdges = get().edges.map((edge) => {
      if (edge.data?.relationType !== "rf") {
        return edge;
      }

      const source = nodesById.get(edge.source);
      const target = nodesById.get(edge.target);
      if (!source || !target) {
        return { ...edge, data: { ...edge.data, invalid: false } };
      }

      const isStore = source.data.operation.type === "STORE";
      const isLoad = target.data.operation.type === "LOAD";
      const invalid =
        isStore && isLoad && source.data.sequenceIndex > target.data.sequenceIndex;

      return { ...edge, data: { ...edge.data, invalid } };
    });

    set({ edges: updatedEdges });
  },
  resetSession: () =>
    set({
      nodes: [],
      edges: [],
      memoryEnv: createDefaultMemoryEnv(),
      selectedMemoryIds: [],
      relationTypeDraft: "rf",
      threads: ["T1"],
      activeBranch: null,
    }),
  importSession: (snapshot) => {
    const relationTypeDraft = get().relationTypeDraft;
    set({
      nodes: snapshot.nodes.map((node) => ({ ...node, selected: false })),
      edges: snapshot.edges.map((edge) => ({ ...edge, selected: false })),
      memoryEnv: flattenMemorySnapshot(snapshot),
      selectedMemoryIds: [],
      relationTypeDraft,
      threads: snapshot.threads.length > 0 ? snapshot.threads : ["T1"],
      activeBranch: snapshot.activeBranch,
    });
  },
}));
