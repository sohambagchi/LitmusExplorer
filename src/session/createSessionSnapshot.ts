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
  activeBranch,
}: {
  title?: string;
  modelConfig: SessionModelConfig;
  memoryEnv: MemoryVariable[];
  nodes: TraceNode[];
  edges: RelationEdge[];
  threads: string[];
  activeBranch: ActiveBranch | null;
}): SessionSnapshot => {
  const normalizedTitle = title?.trim();
  const memory = {
    constants: memoryEnv.filter((item) => item.scope === "constants"),
    locals: memoryEnv.filter((item) => item.scope === "locals"),
    shared: memoryEnv.filter((item) => item.scope === "shared"),
  };

  return {
    title: normalizedTitle ? normalizedTitle : undefined,
    model: modelConfig,
    memory,
    nodes,
    edges,
    threads,
    activeBranch,
    exportedAt: new Date().toISOString(),
  };
};

