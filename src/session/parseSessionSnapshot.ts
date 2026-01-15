import type {
  ActiveBranch,
  MemoryVariable,
  MemoryScope,
  RelationEdge,
  RelationType,
  SessionModelConfig,
  SessionMemorySnapshot,
  SessionSnapshot,
  TraceNode,
} from "../types";

const allowedOperationTypes = new Set(["LOAD", "STORE", "RMW", "FENCE", "BRANCH"]);
const allowedMemoryTypes = new Set(["int", "array", "struct"]);
const allowedMemoryScopes = new Set(["constants", "locals", "shared"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseString = (value: unknown, label: string) => {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  return value;
};

const parseNumber = (value: unknown, label: string) => {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`${label} must be a number.`);
  }
  return value;
};

const parseOptionalSize = (value: unknown, label: string) => {
  if (typeof value === "undefined") {
    return undefined;
  }
  if (typeof value === "number") {
    if (Number.isNaN(value)) {
      throw new Error(`${label} must be a number.`);
    }
    return value;
  }
  if (typeof value === "string") {
    if (!value.trim()) {
      return undefined;
    }
    const parsed = Number(value);
    if (Number.isNaN(parsed)) {
      throw new Error(`${label} must be a number.`);
    }
    return parsed;
  }
  throw new Error(`${label} must be a number.`);
};

const parseStringArray = (value: unknown, label: string) => {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  value.forEach((item, index) => {
    if (typeof item !== "string") {
      throw new Error(`${label}[${index}] must be a string.`);
    }
  });
  return value as string[];
};

const parseThreadLabels = (
  value: unknown,
  threads: string[]
): Record<string, string> | undefined => {
  if (typeof value === "undefined") {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`threadLabels must be an object.`);
  }

  const validThreadIds = new Set(threads);
  const out: Record<string, string> = {};
  for (const [threadId, label] of Object.entries(value)) {
    if (!validThreadIds.has(threadId)) {
      continue;
    }
    if (typeof label !== "string") {
      throw new Error(`threadLabels.${threadId} must be a string.`);
    }
    const trimmed = label.trim();
    if (trimmed) {
      out[threadId] = trimmed;
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
};

const parseIdentifier = (value: unknown, label: string) => {
  const raw = parseString(value, label).trim();
  if (!raw) {
    throw new Error(`${label} cannot be empty.`);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(raw)) {
    throw new Error(`${label} must be an identifier (letters, numbers, "_", "-", ".").`);
  }
  return raw;
};

const parseIdentifierArray = (value: unknown, label: string) =>
  parseStringArray(value, label).map((item, index) =>
    parseIdentifier(item, `${label}[${index}]`)
  );

const parseModelConfig = (value: unknown): SessionModelConfig => {
  if (!isRecord(value)) {
    throw new Error(`model must be an object.`);
  }

  const relationTypes = parseIdentifierArray(
    value.relationTypes ?? [],
    "model.relationTypes"
  );
  const memoryOrders = parseIdentifierArray(
    value.memoryOrders ?? [],
    "model.memoryOrders"
  );

  if (relationTypes.length === 0) {
    throw new Error(`model.relationTypes must include at least one item.`);
  }

  if (memoryOrders.length === 0) {
    throw new Error(`model.memoryOrders must include at least one item.`);
  }

  return { relationTypes, memoryOrders };
};

const parseNodes = (value: unknown): TraceNode[] => {
  if (!Array.isArray(value)) {
    throw new Error(`nodes must be an array.`);
  }

  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`nodes[${index}] must be an object.`);
    }

    const id = parseString(item.id, `nodes[${index}].id`);
    const rawType = item.type;
    const position = item.position;
    if (!isRecord(position)) {
      throw new Error(`nodes[${index}].position must be an object.`);
    }
    const x = parseNumber(position.x, `nodes[${index}].position.x`);
    const y = parseNumber(position.y, `nodes[${index}].position.y`);

    const data = item.data;
    if (!isRecord(data)) {
      throw new Error(`nodes[${index}].data must be an object.`);
    }

    const threadId = parseString(data.threadId, `nodes[${index}].data.threadId`);
    const sequenceIndex = parseNumber(
      data.sequenceIndex,
      `nodes[${index}].data.sequenceIndex`
    );

    const operation = data.operation;
    if (!isRecord(operation)) {
      throw new Error(`nodes[${index}].data.operation must be an object.`);
    }
    const operationType = parseString(
      operation.type,
      `nodes[${index}].data.operation.type`
    );
    if (!allowedOperationTypes.has(operationType)) {
      throw new Error(
        `nodes[${index}].data.operation.type must be a valid operation type.`
      );
    }

    const inferredNodeType =
      operationType === "BRANCH" ? "branch" : "operation";
    const nodeType =
      typeof rawType === "string" && rawType.length > 0
        ? (rawType as "operation" | "branch")
        : inferredNodeType;

    return {
      ...(item as TraceNode),
      id,
      type: nodeType,
      position: { x, y },
      data: {
        ...(data as TraceNode["data"]),
        threadId,
        sequenceIndex,
        operation: operation as TraceNode["data"]["operation"],
      },
    };
  });
};

const parseEdges = (value: unknown) => {
  if (!Array.isArray(value)) {
    throw new Error(`edges must be an array.`);
  }

  return value.map((item, index): RelationEdge => {
    if (!isRecord(item)) {
      throw new Error(`edges[${index}] must be an object.`);
    }
    const id = parseString(item.id, `edges[${index}].id`);
    const source = parseString(item.source, `edges[${index}].source`);
    const target = parseString(item.target, `edges[${index}].target`);
    const type =
      typeof item.type === "string" && item.type.length > 0
        ? item.type
        : "relation";
    const data = isRecord(item.data) ? item.data : {};
    const relationType =
      typeof data.relationType === "string"
        ? (parseIdentifier(data.relationType, `edges[${index}].data.relationType`) as RelationType)
        : ("po" as const);

    return {
      ...(item as RelationEdge),
      id,
      source,
      target,
      type,
      data: { ...data, relationType } as RelationEdge["data"],
    };
  });
};

const parseMemorySection = (
  value: unknown,
  scope: MemoryScope,
  label: string
): MemoryVariable[] => {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }

  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`${label}[${index}] must be an object.`);
    }
    const id = parseString(item.id, `${label}[${index}].id`);
    const name = typeof item.name === "string" ? item.name : "";
    const type = typeof item.type === "string" ? item.type : "";
    if (!allowedMemoryTypes.has(type)) {
      throw new Error(`${label}[${index}].type must be a valid memory type.`);
    }

    const parentId =
      typeof item.parentId === "string" ? item.parentId : undefined;
    const baseVariable = {
      id,
      name,
      scope,
      parentId,
    };

    if (type === "int") {
      const value =
        typeof item.value === "string"
          ? item.value
          : typeof item.value === "number"
            ? String(item.value)
            : undefined;
      return { ...baseVariable, type: "int" as const, value };
    }

    if (type === "array") {
      const size = parseOptionalSize(
        typeof item.size !== "undefined" ? item.size : item.value,
        `${label}[${index}].size`
      );
      return { ...baseVariable, type: "array" as const, size };
    }

    return { ...baseVariable, type: "struct" as const };
  });
};

const parseMemorySnapshot = (value: unknown): SessionMemorySnapshot => {
  if (!isRecord(value)) {
    throw new Error("memory must be an object.");
  }

  const constants = parseMemorySection(
    value.constants ?? [],
    "constants",
    "memory.constants"
  );
  const locals = parseMemorySection(value.locals ?? [], "locals", "memory.locals");
  const shared = parseMemorySection(value.shared ?? [], "shared", "memory.shared");

  return { constants, locals, shared };
};

export const flattenSessionMemory = (memory: SessionMemorySnapshot) => [
  ...memory.constants,
  ...memory.locals,
  ...memory.shared,
];

const parseLegacyMemoryEnv = (value: unknown): SessionMemorySnapshot => {
  if (!Array.isArray(value)) {
    throw new Error(`memoryEnv must be an array.`);
  }

  const env = value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`memoryEnv[${index}] must be an object.`);
    }
    const id = parseString(item.id, `memoryEnv[${index}].id`);
    const name = typeof item.name === "string" ? item.name : "";
    const type = typeof item.type === "string" ? item.type : "";
    if (!allowedMemoryTypes.has(type)) {
      throw new Error(`memoryEnv[${index}].type must be a valid memory type.`);
    }
    const scope = typeof item.scope === "string" ? item.scope : "";
    if (!allowedMemoryScopes.has(scope)) {
      throw new Error(`memoryEnv[${index}].scope must be a valid scope.`);
    }

    const parentId =
      typeof item.parentId === "string" ? item.parentId : undefined;
    const baseVariable = {
      id,
      name,
      scope: scope as MemoryVariable["scope"],
      parentId,
    };

    if (type === "int") {
      const value =
        typeof item.value === "string"
          ? item.value
          : typeof item.value === "number"
            ? String(item.value)
            : undefined;
      return { ...baseVariable, type: "int" as const, value };
    }

    if (type === "array") {
      const size = parseOptionalSize(
        typeof item.size !== "undefined" ? item.size : item.value,
        `memoryEnv[${index}].size`
      );
      return { ...baseVariable, type: "array" as const, size };
    }

    return { ...baseVariable, type: "struct" as const };
  });

  return {
    constants: env.filter((item) => item.scope === "constants"),
    locals: env.filter((item) => item.scope === "locals"),
    shared: env.filter((item) => item.scope === "shared"),
  };
};

const parseActiveBranch = (value: unknown): ActiveBranch | null => {
  if (value === null || typeof value === "undefined") {
    return null;
  }
  if (!isRecord(value)) {
    throw new Error(`activeBranch must be an object or null.`);
  }
  const branchId = parseString(value.branchId, "activeBranch.branchId");
  const path = parseString(value.path, "activeBranch.path");
  if (path !== "then" && path !== "else") {
    throw new Error(`activeBranch.path must be "then" or "else".`);
  }
  return { branchId, path };
};

const extractThreadsFromNodes = (nodes: TraceNode[]) =>
  Array.from(new Set(nodes.map((node) => node.data.threadId)));

export const parseSessionSnapshot = (value: unknown): SessionSnapshot => {
  if (!isRecord(value)) {
    throw new Error("Session JSON must be an object.");
  }

  const title =
    typeof value.title === "undefined"
      ? undefined
      : parseString(value.title, "title").trim() || undefined;

  const memory =
    typeof value.memory !== "undefined"
      ? parseMemorySnapshot(value.memory)
      : typeof value.memoryEnv !== "undefined"
        ? parseLegacyMemoryEnv(value.memoryEnv)
        : null;

  if (!memory) {
    throw new Error(`Session JSON must include a "memory" section.`);
  }

  const model =
    typeof value.model === "undefined" ? undefined : parseModelConfig(value.model);

  const nodes =
    typeof value.nodes === "undefined" ? [] : parseNodes(value.nodes);
  const edges =
    typeof value.edges === "undefined" ? [] : parseEdges(value.edges);

  const threads =
    typeof value.threads === "undefined"
      ? extractThreadsFromNodes(nodes)
      : parseStringArray(value.threads, "threads");

  const threadsWithFallback = threads.length > 0 ? threads : ["T0"];
  const missingThreadIds = extractThreadsFromNodes(nodes).filter(
    (threadId) => !threadsWithFallback.includes(threadId)
  );
  const normalizedThreads = [...threadsWithFallback, ...missingThreadIds];
  const threadLabels = parseThreadLabels(value.threadLabels, normalizedThreads);

  const activeBranch = parseActiveBranch(value.activeBranch);
  const exportedAt =
    typeof value.exportedAt === "string" ? value.exportedAt : undefined;

  return {
    title,
    model,
    memory,
    nodes,
    edges,
    threads: normalizedThreads,
    threadLabels,
    activeBranch,
    exportedAt,
  };
};
