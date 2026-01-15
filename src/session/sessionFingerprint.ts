import type {
  ActiveBranch,
  MemoryVariable,
  RelationEdge,
  SessionModelConfig,
  TraceNode,
  ThreadLabels,
} from "../types";

type SessionFingerprintInput = {
  /**
   * Current session title as displayed in the UI.
   * This is treated as part of the session "content" for dirty-checking purposes.
   */
  title: string;
  /**
   * Current relation types + memory order config.
   */
  modelConfig: SessionModelConfig;
  /**
   * Flattened memory environment (constants + locals + shared + structs).
   */
  memoryEnv: MemoryVariable[];
  /**
   * React Flow nodes representing the litmus trace.
   */
  nodes: TraceNode[];
  /**
   * React Flow edges representing relations between operations.
   */
  edges: RelationEdge[];
  /**
   * Ordered thread IDs shown in the editor.
   */
  threads: string[];
  /**
   * Friendly labels for thread lanes, keyed by thread ID.
   */
  threadLabels: ThreadLabels;
  /**
   * Active branch selection, if any.
   */
  activeBranch: ActiveBranch | null;
};

const normalizeNodeForFingerprint = (node: TraceNode) => ({
  id: node.id,
  type: node.type,
  position: node.position,
  data: node.data,
  parentNode: node.parentNode,
});

const normalizeEdgeForFingerprint = (edge: RelationEdge) => ({
  id: edge.id,
  type: edge.type,
  source: edge.source,
  target: edge.target,
  sourceHandle: edge.sourceHandle,
  targetHandle: edge.targetHandle,
  data: edge.data,
});

/**
 * Creates a stable string fingerprint for the current session state.
 *
 * Used to determine whether the user has "unsaved changes" when switching sessions.
 * Intentionally ignores ephemeral UI fields like `selected` on nodes/edges.
 */
export const createSessionFingerprint = ({
  title,
  modelConfig,
  memoryEnv,
  nodes,
  edges,
  threads,
  threadLabels,
  activeBranch,
}: SessionFingerprintInput) =>
  JSON.stringify({
    title,
    modelConfig,
    memoryEnv,
    nodes: nodes.map(normalizeNodeForFingerprint),
    edges: edges.map(normalizeEdgeForFingerprint),
    threads,
    threadLabels,
    activeBranch,
  });
