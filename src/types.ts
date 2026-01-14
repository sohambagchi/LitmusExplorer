import type { Edge, Node } from "reactflow";

export type MemoryType = "int" | "array" | "struct";
export type MemoryScope = "constants" | "locals" | "shared";

type MemoryVariableBase = {
  id: string;
  name: string;
  scope: MemoryScope;
  parentId?: string;
};

export type IntMemoryVariable = MemoryVariableBase & {
  type: "int";
  value?: string;
};

export type ArrayMemoryVariable = MemoryVariableBase & {
  type: "array";
  size?: number;
};

export type StructMemoryVariable = MemoryVariableBase & {
  type: "struct";
};

export type MemoryVariable =
  | IntMemoryVariable
  | ArrayMemoryVariable
  | StructMemoryVariable;

export type OperationType = "LOAD" | "STORE" | "RMW" | "FENCE" | "BRANCH";
export type MemoryOrder = "Relaxed" | "Acquire" | "Release" | "SC";
export type BranchPath = "then" | "else";

export type ActiveBranch = {
  branchId: string;
  path: BranchPath;
};

export type Operation = {
  type: OperationType;
  addressId?: string;
  valueId?: string;
  address?: string;
  value?: string | number;
  memoryOrder?: MemoryOrder;
  text?: string;
};

export type TraceNodeData = {
  threadId: string;
  sequenceIndex: number;
  operation: Operation;
  branchId?: string;
  branchPath?: BranchPath;
};

export type TraceNode = Node<TraceNodeData>;

export type RelationType = "rf" | "co" | "fr" | "po";

export type RelationEdgeData = {
  relationType: RelationType;
  invalid?: boolean;
};

export type RelationEdge = Edge<RelationEdgeData>;

export type SessionMemorySnapshot = {
  constants: MemoryVariable[];
  locals: MemoryVariable[];
  shared: MemoryVariable[];
};

export type SessionSnapshot = {
  memory: SessionMemorySnapshot;
  nodes: TraceNode[];
  edges: RelationEdge[];
  threads: string[];
  activeBranch: ActiveBranch | null;
  exportedAt?: string;
};
