import type {
  ActiveBranch,
  MemoryVariable,
  RelationEdge,
  SessionModelConfig,
  SessionSnapshot,
  TraceNode,
} from "../types";

export const createSessionSnapshot = ({
  title,
  modelConfig,
  memoryEnv,
  nodes,
  edges,
  threads,
  threadLabels,
  activeBranch,
}: {
  title?: string;
  modelConfig: SessionModelConfig;
  memoryEnv: MemoryVariable[];
  nodes: TraceNode[];
  edges: RelationEdge[];
  threads: string[];
  threadLabels?: Record<string, string>;
  activeBranch: ActiveBranch | null;
}): SessionSnapshot => {
  const normalizedTitle = title?.trim();
  const memory = {
    constants: memoryEnv.filter((item) => item.scope === "constants"),
    locals: memoryEnv.filter((item) => item.scope === "locals"),
    shared: memoryEnv.filter((item) => item.scope === "shared"),
  };

  const normalizedThreadLabels: Record<string, string> = {};
  for (const threadId of threads) {
    const label = threadLabels?.[threadId]?.trim();
    if (label) {
      normalizedThreadLabels[threadId] = label;
    }
  }

  return {
    title: normalizedTitle ? normalizedTitle : undefined,
    model: modelConfig,
    memory,
    nodes,
    edges,
    threads,
    threadLabels:
      Object.keys(normalizedThreadLabels).length > 0 ? normalizedThreadLabels : undefined,
    activeBranch,
    exportedAt: new Date().toISOString(),
  };
};
