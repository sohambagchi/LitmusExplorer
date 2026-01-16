import type { MemoryVariable, RelationEdge, TraceNode } from "../types";
import { evaluateBranchCondition } from "./branchEvaluation";

/**
 * Computes which trace nodes should be visible given BRANCH-node evaluation.
 *
 * Notes:
 * - This mirrors the canvas visibility behavior in `EditorCanvas` so exports and
 *   other derived views can respect the same "show both futures" semantics.
 * - Visibility is driven purely by the current memory environment and BRANCH
 *   node configuration; it does not inspect "rf/co/fr" style relations.
 *
 * @param args - Visibility inputs.
 * @param args.nodes - Full node list (including BRANCH and operation nodes).
 * @param args.edges - Full edge list (used only for `po` reachability).
 * @param args.memoryEnv - Current memory environment (used to evaluate branches).
 * @param args.showAllNodes - Global override to return all nodes.
 * @returns Filtered node list that should be rendered/exported.
 */
export const getVisibleTraceNodes = ({
  nodes,
  edges,
  memoryEnv,
  showAllNodes,
}: {
  nodes: TraceNode[];
  edges: RelationEdge[];
  memoryEnv: MemoryVariable[];
  showAllNodes: boolean;
}) => {
  /**
   * Global override: when enabled, we render every node regardless of the
   * evaluated outcome of any BRANCH node (and regardless of per-branch "Both").
   */
  if (showAllNodes) {
    return nodes;
  }

  const nodesById = new Map(nodes.map((node) => [node.id, node]));

  const poOutgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const relationType = edge.data?.relationType ?? "po";
    if (relationType !== "po") {
      continue;
    }
    const current = poOutgoing.get(edge.source) ?? [];
    current.push(edge.target);
    poOutgoing.set(edge.source, current);
  }

  /**
   * Follows per-thread program order edges to collect the full set of nodes
   * reachable from a starting set (used to include the whole branch future).
   */
  const followPo = (startIds: string[], bucket: Set<string>) => {
    const queue = [...startIds];
    while (queue.length > 0) {
      const nextId = queue.shift();
      if (!nextId || bucket.has(nextId) || !nodesById.has(nextId)) {
        continue;
      }
      bucket.add(nextId);
      const outgoing = poOutgoing.get(nextId) ?? [];
      for (const targetId of outgoing) {
        if (!bucket.has(targetId)) {
          queue.push(targetId);
        }
      }
    }
  };

  const hidden = new Set<string>();
  const branchNodes = nodes.filter((node) => node.data.operation.type === "BRANCH");

  for (const branchNode of branchNodes) {
    /**
     * Default behavior is to show both paths unless the user explicitly
     * disables it for a given branch.
     */
    if (branchNode.data.operation.branchShowBothFutures ?? true) {
      continue;
    }
    const branchId = branchNode.id;
    const condition = branchNode.data.operation.branchCondition;
    if (!condition) {
      continue;
    }

    const thenSet = new Set<string>();
    const elseSet = new Set<string>();

    for (const node of nodes) {
      if (node.data.branchId !== branchId) {
        continue;
      }
      if (node.data.branchPath === "then") {
        thenSet.add(node.id);
      } else if (node.data.branchPath === "else") {
        elseSet.add(node.id);
      }
    }

    const thenStarts = edges
      .filter((edge) => edge.source === branchId && edge.sourceHandle === "then")
      .map((edge) => edge.target);
    const elseStarts = edges
      .filter((edge) => edge.source === branchId && edge.sourceHandle === "else")
      .map((edge) => edge.target);
    followPo(thenStarts, thenSet);
    followPo(elseStarts, elseSet);

    if (thenSet.size === 0 && elseSet.size === 0) {
      continue;
    }

    const thenExclusive = new Set([...thenSet].filter((nodeId) => !elseSet.has(nodeId)));
    const elseExclusive = new Set([...elseSet].filter((nodeId) => !thenSet.has(nodeId)));

    const outcome = evaluateBranchCondition(condition, memoryEnv);
    const toHide = outcome ? elseExclusive : thenExclusive;
    for (const nodeId of toHide) {
      hidden.add(nodeId);
    }
  }

  return nodes.filter((node) => !hidden.has(node.id));
};

