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
  const indexId = node.data.operation.indexId;
  if (addressId) {
    const item = memoryById.get(addressId);
    const baseLabel = item ? formatMemoryLabel(item, memoryById) : addressId;
    const resolvedIndexItem = indexId ? memoryById.get(indexId) : undefined;
    const resolvedIndex = resolvedIndexItem
      ? formatMemoryLabel(resolvedIndexItem, memoryById)
      : "";
    const indexLabel = resolvedIndex || node.data.operation.index?.trim() || "";
    if (indexLabel && (item?.type === "array" || indexId || node.data.operation.index)) {
      return `${baseLabel}[${indexLabel}]`;
    }
    return baseLabel;
  }
  const address = node.data.operation.address?.trim();
  if (!address) {
    return null;
  }
  const resolvedIndexItem = indexId ? memoryById.get(indexId) : undefined;
  const resolvedIndex = resolvedIndexItem
    ? formatMemoryLabel(resolvedIndexItem, memoryById)
    : "";
  const indexLabel = resolvedIndex || node.data.operation.index?.trim() || "";
  return indexLabel ? `${address}[${indexLabel}]` : address;
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

  if (relationType === "ad" && !sameThread) {
    return {
      allowed: false,
      reason: "Address-dependency edges must stay within a single thread.",
    };
  }

  if ((relationType === "cd" || relationType === "dd") && !sameThread) {
    return {
      allowed: false,
      reason: "Dependency edges must stay within a single thread.",
    };
  }

  if (sameThread) {
    return { allowed: true };
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
