import type { MemoryVariable, RelationType, TraceNode } from "../types";

export type EdgeConstraintResult = {
  allowed: boolean;
  reason?: string;
  sharedAddress?: string;
};

const perLocationRelations = new Set<RelationType>(["rf", "co", "fr"]);

const formatMemoryLabel = (
  item: MemoryVariable,
  memoryById: Map<string, MemoryVariable>
): string => {
  const name = item.name.trim() || item.id;
  if (!item.parentId) {
    return name;
  }
  const parent = memoryById.get(item.parentId);
  const parentName = parent ? formatMemoryLabel(parent, memoryById) : item.parentId;
  return `${parentName}.${name}`;
};

const resolveNodeAddressLabel = (
  node: TraceNode,
  memoryById: Map<string, MemoryVariable>
): string | null => {
  const addressId = node.data.operation.addressId;
  if (addressId) {
    const item = memoryById.get(addressId);
    if (item) {
      return formatMemoryLabel(item, memoryById);
    }
    return addressId;
  }
  const address = node.data.operation.address?.trim();
  return address ? address : null;
};

export const checkEdgeConstraints = ({
  relationType,
  sourceNode,
  targetNode,
  memoryEnv,
}: {
  relationType: RelationType;
  sourceNode: TraceNode | undefined;
  targetNode: TraceNode | undefined;
  memoryEnv: MemoryVariable[];
}): EdgeConstraintResult => {
  if (!sourceNode || !targetNode) {
    return { allowed: true };
  }

  const sameThread = sourceNode.data.threadId === targetNode.data.threadId;
  if (relationType === "po" && !sameThread) {
    return {
      allowed: false,
      reason: "Program-order edges must stay within a single thread.",
    };
  }

  if (!perLocationRelations.has(relationType)) {
    return { allowed: true };
  }

  const memoryById = new Map(memoryEnv.map((item) => [item.id, item]));
  const sourceAddress = resolveNodeAddressLabel(sourceNode, memoryById);
  const targetAddress = resolveNodeAddressLabel(targetNode, memoryById);

  if (!sourceAddress || !targetAddress) {
    return {
      allowed: false,
      reason: `A "${relationType}" edge requires both endpoints to reference the same memory location.`,
    };
  }

  if (sourceAddress !== targetAddress) {
    return {
      allowed: false,
      reason: `A "${relationType}" edge requires the same memory location ("${sourceAddress}" vs "${targetAddress}").`,
    };
  }

  return { allowed: true, sharedAddress: sourceAddress };
};
