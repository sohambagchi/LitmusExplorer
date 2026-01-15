import type { Edge, Node } from "reactflow";

export type MemoryType = "int" | "array" | "struct";
export type MemoryScope = "constants" | "locals" | "shared";
export type ComparisonOp = "==" | "<" | ">" | "<=" | ">=" | "!=";
export type LogicalOp = "&&" | "||";
export type RuleEvaluation = "natural" | "true" | "false";

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

export const DEFAULT_MEMORY_ORDERS = [
  "Standard",
  "Relaxed",
  "Acquire",
  "Release",
  "Acq_Rel",
  "SC",
] as const;

export type DefaultMemoryOrder = (typeof DEFAULT_MEMORY_ORDERS)[number];
export type MemoryOrder = string;
export type BranchPath = "then" | "else";

export type ActiveBranch = {
  branchId: string;
  path: BranchPath;
};

export type BranchRuleCondition = {
  kind: "rule";
  id: string;
  lhsId?: string;
  rhsId?: string;
  op: ComparisonOp;
  evaluation: RuleEvaluation;
};

export type BranchGroupCondition = {
  kind: "group";
  id: string;
  items: BranchCondition[];
  operators: LogicalOp[];
};

export type BranchCondition = BranchRuleCondition | BranchGroupCondition;

export type Operation = {
  type: OperationType;
  addressId?: string;
  indexId?: string;
  resultId?: string;
  valueId?: string;
  expectedValueId?: string;
  desiredValueId?: string;
  address?: string;
  index?: string;
  value?: string | number;
  memoryOrder?: MemoryOrder;
  successMemoryOrder?: MemoryOrder;
  failureMemoryOrder?: MemoryOrder;
  branchCondition?: BranchGroupCondition;
  branchShowBothFutures?: boolean;
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

export const DEFAULT_RELATION_TYPES = ["rf", "co", "fr", "po", "ad", "cd", "dd"] as const;
export type DefaultRelationType = (typeof DEFAULT_RELATION_TYPES)[number];
export type RelationType = string;

export type RelationEdgeData = {
  relationType: RelationType;
  invalid?: boolean;
  generated?: boolean;
};

export type RelationEdge = Edge<RelationEdgeData>;

export type SessionMemorySnapshot = {
  constants: MemoryVariable[];
  locals: MemoryVariable[];
  shared: MemoryVariable[];
};

export type ThreadLabels = Record<string, string>;

export type SessionSnapshot = {
  title?: string;
  model?: SessionModelConfig;
  memory: SessionMemorySnapshot;
  nodes: TraceNode[];
  edges: RelationEdge[];
  threads: string[];
  threadLabels?: ThreadLabels;
  activeBranch: ActiveBranch | null;
  exportedAt?: string;
};

export type SessionModelConfig = {
  relationTypes: RelationType[];
  memoryOrders: MemoryOrder[];
};
