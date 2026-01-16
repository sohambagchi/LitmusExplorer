import type { Edge, Node } from "reactflow";

export type MemoryType = "int" | "array" | "ptr" | "struct";
export type MemoryScope = "constants" | "locals" | "shared";
export type ComparisonOp = "==" | "<" | ">" | "<=" | ">=" | "!=";
export type LogicalOp = "&&" | "||";
export type RuleEvaluation = "natural" | "true" | "false";

export type ArrayElementType = "int" | "ptr" | "struct";

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
  /**
   * Element type for this array.
   *
   * Notes:
   * - This is editor metadata used to describe what an array holds.
   * - When `elementType` is `"struct"`, `elementStructId` may reference a struct
   *   variable whose members describe the element layout.
   */
  elementType?: ArrayElementType;
  /**
   * Optional struct variable id that represents the element layout when this
   * array is configured as an array of structs.
   */
  elementStructId?: string;
  /**
   * Optional pointee variable id when this array is configured as an array of pointers.
   *
   * Notes:
   * - This is editor metadata used to describe what `ptr` elements point to.
   * - This enables "typed dereference" UX for registers loaded from the array,
   *   without requiring users to manually configure every local ptr register.
   * - Currently intended primarily for pointers-to-struct templates.
   */
  elementPointsToId?: string;
};

export type PtrMemoryVariable = MemoryVariableBase & {
  type: "ptr";
  /**
   * ID of the memory variable this pointer currently targets.
   *
   * Notes:
   * - This is a symbolic "address" used by the editor; it may be self-referential
   *   (points to itself) and is allowed to chain through other pointers.
   * - The app resolves ptr chains defensively to avoid infinite loops.
   */
  pointsToId?: string;
};

export type StructMemoryVariable = MemoryVariableBase & {
  type: "struct";
};

export type MemoryVariable =
  | IntMemoryVariable
  | ArrayMemoryVariable
  | PtrMemoryVariable
  | StructMemoryVariable;

/**
 * Canonical operation types supported by the editor.
 *
 * Notes:
 * - "Meta" operations (Retry/Return True/Return False) are editor-only control
 *   flow helpers; they intentionally do not participate in memory-location logic.
 */
export type OperationType =
  | "LOAD"
  | "STORE"
  | "RMW"
  | "FENCE"
  | "BRANCH"
  | "RETRY"
  | "RETURN_FALSE"
  | "RETURN_TRUE";

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
  /**
   * Optional struct member id used when addressing a struct (or an array-of-struct element).
   *
   * Notes:
   * - When `addressId` resolves to a struct variable, `memberId` should reference
   *   one of that struct's member variables (`member.parentId === struct.id`).
   * - When `addressId` resolves to an array configured with `elementType: "struct"`,
   *   `memberId` should reference a member variable of the array's struct template
   *   (`member.parentId === array.elementStructId`).
   */
  memberId?: string;
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
  /**
   * UI-only highlight flag for render-time emphasis (e.g. when clicking a dependency edge).
   *
   * Notes:
   * - This is intentionally not required and should not be persisted in exported sessions.
   * - The canvas may set this field on a render-time copy of an edge.
   */
  highlighted?: boolean;
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
