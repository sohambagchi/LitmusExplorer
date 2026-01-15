import type { MemoryVariable, TraceNode } from "../types";
import { resolvePointerTargetById } from "./resolvePointers";

type NodeOrderKey = { sequenceIndex: number; id: string };

/**
 * Provides a stable within-thread program order for nodes.
 *
 * Notes:
 * - We primarily order by `sequenceIndex` (timeline order).
 * - `id` is used as a deterministic tiebreaker to keep behavior stable even if
 *   two nodes share the same sequence slot.
 */
const compareNodeOrder = (a: NodeOrderKey, b: NodeOrderKey) => {
  const delta = a.sequenceIndex - b.sequenceIndex;
  return delta !== 0 ? delta : a.id.localeCompare(b.id);
};

/**
 * Finds the last instruction (in the same thread) that wrote a particular register.
 *
 * We treat `LOAD` and `RMW` as producing `resultId`.
 *
 * @param nodes - All trace nodes in the session.
 * @param currentNode - Node before which the write must appear (strictly earlier in order).
 * @param registerId - Local register memory variable id to find a producer for.
 * @returns The last writer node, or `null` if none exists.
 */
export const findLastWriterNodeForRegister = ({
  nodes,
  currentNode,
  registerId,
}: {
  nodes: TraceNode[];
  currentNode: TraceNode;
  registerId: string;
}): TraceNode | null => {
  const threadId = currentNode.data.threadId;
  const currentKey: NodeOrderKey = {
    sequenceIndex: currentNode.data.sequenceIndex,
    id: currentNode.id,
  };

  let best: TraceNode | null = null;
  let bestKey: NodeOrderKey | null = null;

  for (const node of nodes) {
    if (node.data.threadId !== threadId) {
      continue;
    }

    const op = node.data.operation;
    if (op.type !== "LOAD" && op.type !== "RMW") {
      continue;
    }
    if (op.resultId !== registerId) {
      continue;
    }

    const key: NodeOrderKey = { sequenceIndex: node.data.sequenceIndex, id: node.id };
    if (compareNodeOrder(key, currentKey) >= 0) {
      continue;
    }

    if (!bestKey || compareNodeOrder(key, bestKey) > 0) {
      best = node;
      bestKey = key;
    }
  }

  return best;
};

/**
 * Attempts to infer the (symbolic) memory variable id a register should be treated as
 * pointing to, based on its last writer.
 *
 * This enables "typed dereference" UX flows such as:
 * - `r0 = LD(A[i])` where `A` is configured as an array-of-ptrs to a struct template.
 * - `r1 = LD(r0.val)` where `r0` is a local ptr register (without manual `pointsToId`).
 *
 * @param nodes - All trace nodes in the session.
 * @param currentNode - Node whose operation is reading `registerId` as an address.
 * @param registerId - Register id used as an address base.
 * @param memoryEnv - Flat memory environment.
 * @returns Inferred pointee id, or `null` when no inference is possible.
 */
export const inferPointerTargetIdForRegister = ({
  nodes,
  currentNode,
  registerId,
  memoryEnv,
}: {
  nodes: TraceNode[];
  currentNode: TraceNode;
  registerId: string;
  memoryEnv: MemoryVariable[];
}): string | null => {
  const memoryById = new Map(memoryEnv.map((item) => [item.id, item] as const));
  const writer = findLastWriterNodeForRegister({ nodes, currentNode, registerId });
  if (!writer) {
    return null;
  }

  const writerAddressId = writer.data.operation.addressId;
  const writerResolved = resolvePointerTargetById(writerAddressId, memoryById).resolved;
  if (!writerResolved) {
    return null;
  }

  if (writerResolved.type === "array") {
    if (writerResolved.elementType === "ptr" && writerResolved.elementPointsToId) {
      return writerResolved.elementPointsToId;
    }
    if (writerResolved.elementType === "struct" && writerResolved.elementStructId) {
      // Treat a load from an array-of-structs as producing a value whose "layout"
      // matches the array's struct template. This keeps member selection working
      // even when users model the element load directly.
      return writerResolved.elementStructId;
    }
    return null;
  }

  if (writerResolved.type === "ptr" && writerResolved.pointsToId) {
    return writerResolved.pointsToId;
  }

  if (writerResolved.type === "struct") {
    return writerResolved.id;
  }

  return null;
};

