import type {
  BranchCondition,
  BranchGroupCondition,
  IntMemoryVariable,
  MemoryVariable,
  OperationType,
  RelationEdge,
  TraceNode,
} from "../types";
import { getVisibleTraceNodes } from "../utils/getVisibleTraceNodes";

type HerdLitmusExport = {
  title: string;
  nodes: TraceNode[];
  edges: RelationEdge[];
  threads: string[];
  memoryEnv: MemoryVariable[];
  showAllNodes: boolean;
};

type LitmusExportDialect = "lkmm" | "c11";

type LitmusExportOptions = {
  /**
   * Output dialect for the `.litmus` file.
   *
   * - `lkmm`: Linux-flavored C using READ_ONCE/WRITE_ONCE and `smp_*` helpers.
   * - `c11`: C11-flavored C using `atomic_*_explicit` primitives.
   */
  dialect?: LitmusExportDialect;
};

/**
 * Normalizes a session title into a herdtools header-friendly name.
 *
 * @param raw - Raw user-provided title.
 * @returns Trimmed, single-spaced title.
 */
const toSafeTitle = (raw: string) => raw.trim().replace(/\s+/g, " ");

/**
 * Formats a memory variable label, including parents for struct members.
 *
 * Examples:
 * - `x` => `x`
 * - member `next` with parent `node` => `node.next`
 *
 * @param variable - Memory variable to format.
 * @param memoryById - Memory environment index.
 * @returns Label string.
 */
const formatMemoryLabel = (
  variable: MemoryVariable,
  memoryById: Map<string, MemoryVariable>
): string => {
  const name = variable.name.trim() || variable.id;
  if (!variable.parentId) {
    return name;
  }
  const parent = memoryById.get(variable.parentId);
  if (!parent) {
    return `${variable.parentId}.${name}`;
  }
  return `${formatMemoryLabel(parent, memoryById)}.${name}`;
};

/**
 * Coerces an arbitrary user name into a valid C identifier and returns a best-effort
 * unique variant when necessary.
 *
 * @param raw - Raw user-facing name.
 * @param used - Set of already-used identifiers in the same namespace.
 * @returns Unique C identifier.
 */
const toCIdentifier = (raw: string, used: Set<string>) => {
  const base = raw
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9_]+/g, "_");
  const candidate0 = /^[A-Za-z_]/.test(base) ? base : `v_${base || "x"}`;

  let candidate = candidate0;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${candidate0}_${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
};

/**
 * Returns the relation type for an edge, defaulting to `po` when unspecified.
 *
 * @param edge - React Flow edge.
 * @returns Relation type string.
 */
const getRelationType = (edge: RelationEdge) => edge.data?.relationType ?? "po";

/**
 * Normalizes a memory order string for comparisons.
 *
 * @param raw - Raw memory order label.
 * @returns Trimmed memory order label (defaults to `"Standard"`).
 */
const normalizeMemoryOrder = (raw: string | undefined) => (raw ?? "Standard").trim();

/**
 * Maps Litmus Explorer memory orders to C11 `memory_order_*` tokens understood by herdtools7.
 *
 * Notes:
 * - Litmus Explorer allows any label; this mapping is intentionally forgiving.
 * - C11 has constraints (e.g. CAS failure order cannot be Release/Acq_Rel). For export we
 *   degrade such cases to `memory_order_relaxed` so the file remains parseable.
 *
 * @param raw - Raw memory order label (may be undefined).
 * @param kind - Which context uses this order (load/store/rmw_success/rmw_failure/fence).
 * @returns `memory_order_*` token.
 */
const toC11MemoryOrder = (
  raw: string | undefined,
  kind: "load" | "store" | "rmw_success" | "rmw_failure" | "fence"
): string => {
  const order = normalizeMemoryOrder(raw);

  const relaxed = "memory_order_relaxed";
  const acquire = "memory_order_acquire";
  const release = "memory_order_release";
  const acqRel = "memory_order_acq_rel";
  const seqCst = "memory_order_seq_cst";

  switch (order) {
    case "SC":
      return seqCst;
    case "Acquire":
      return kind === "store" ? relaxed : acquire;
    case "Release":
      return kind === "load" ? relaxed : release;
    case "Acq_Rel":
      if (kind === "load") return acquire;
      if (kind === "store") return release;
      if (kind === "rmw_failure") return relaxed;
      return acqRel;
    case "Relaxed":
    case "Standard":
    default:
      return relaxed;
  }
};

/**
 * Type guard for integer variables (constants/locals/shared).
 *
 * @param variable - Candidate memory variable.
 * @returns True when the variable is an `int`.
 */
const isIntMemoryVariable = (variable: MemoryVariable): variable is IntMemoryVariable =>
  variable.type === "int";

/**
 * Whether an operation node should terminate a thread when exported to C.
 *
 * Notes:
 * - Litmus Explorer has editor-only "meta" operations used to model control flow.
 * - The herdtools C format expects valid C; the simplest conservative mapping is to
 *   end the thread early with `return;`.
 *
 * @param type - Operation type.
 * @returns True when the exporter should emit a `return;` statement.
 */
const isReturnLikeOperation = (type: OperationType) =>
  type === "RETRY" || type === "RETURN_FALSE" || type === "RETURN_TRUE";

/**
 * Supported Litmus Explorer operation types for `.litmus` export.
 *
 * @param type - Operation type.
 * @returns True when supported.
 */
const isSupportedExportOperationType = (type: OperationType) =>
  type === "LOAD" ||
  type === "STORE" ||
  type === "FENCE" ||
  type === "BRANCH" ||
  type === "RMW" ||
  isReturnLikeOperation(type);

/**
 * Collects every memory variable id referenced by a branch condition tree.
 *
 * @param condition - Branch condition tree.
 * @returns List of referenced ids (may include duplicates).
 */
const collectBranchConditionIds = (condition: BranchCondition): string[] => {
  if (condition.kind === "rule") {
    return [condition.lhsId, condition.rhsId].filter(
      (id): id is string => typeof id === "string" && id.trim().length > 0
    );
  }

  const out: string[] = [];
  for (const item of condition.items) {
    out.push(...collectBranchConditionIds(item));
  }
  return out;
};

/**
 * Converts a Litmus Explorer branch condition tree into a C boolean expression.
 *
 * Notes:
 * - Shared-memory operands become `READ_ONCE(*x)` expressions.
 * - Local register operands become their C identifier (e.g. `r0`).
 * - Constants become their numeric literal value.
 *
 * @param args - Conversion inputs.
 * @param args.root - Root condition group.
 * @param args.memoryById - Memory variables by id.
 * @param args.localNameById - Local register names by id.
 * @param args.sharedValueExprById - Shared location value expressions by id.
 * @returns C expression string.
 */
const branchConditionToCExpression = ({
  root,
  memoryById,
  localNameById,
  sharedValueExprById,
}: {
  root: BranchGroupCondition;
  memoryById: Map<string, MemoryVariable>;
  localNameById: Map<string, string>;
  sharedValueExprById: Map<string, string>;
}): string => {
  const operandExpr = (id: string | undefined) => {
    if (!id) {
      throw new Error(`Cannot export: BRANCH condition is missing an operand id.`);
    }
    const variable = memoryById.get(id);
    if (!variable) {
      throw new Error(`Cannot export: BRANCH condition references unknown id "${id}".`);
    }

    if (variable.scope === "locals") {
      const name = localNameById.get(id);
      if (!name) {
        throw new Error(
          `Cannot export: BRANCH condition references local register "${variable.name}" that is not declared in this thread.`
        );
      }
      return name;
    }

    if (variable.scope === "shared") {
      const expr = sharedValueExprById.get(id);
      if (!expr) {
        throw new Error(
          `Cannot export: BRANCH condition references shared variable "${variable.name}" but its C identifier could not be resolved.`
        );
      }
      return expr;
    }

    if (variable.scope === "constants") {
      if (!isIntMemoryVariable(variable)) {
        throw new Error(
          `Cannot export: BRANCH condition references a non-int constant "${variable.name}".`
        );
      }
      const raw = (variable.value ?? variable.name).trim();
      if (!raw) {
        throw new Error(
          `Cannot export: BRANCH condition references an empty constant "${variable.name}".`
        );
      }
      return raw;
    }

    throw new Error(
      `Cannot export: BRANCH condition references unsupported memory scope "${variable.scope}".`
    );
  };

  const emit = (condition: BranchCondition): string => {
    if (condition.kind === "rule") {
      if (condition.evaluation === "true") {
        return "1";
      }
      if (condition.evaluation === "false") {
        return "0";
      }

      const lhs = operandExpr(condition.lhsId);
      const rhs = operandExpr(condition.rhsId);
      return `(${lhs} ${condition.op} ${rhs})`;
    }

    if (condition.items.length === 0) {
      return "0";
    }

    let expr = emit(condition.items[0]);
    for (let index = 1; index < condition.items.length; index += 1) {
      const op = condition.operators[index - 1] ?? "&&";
      const next = emit(condition.items[index]);
      expr = `(${expr} ${op} ${next})`;
    }
    return expr;
  };

  return emit(root);
};

/**
 * Creates a herdtools7-compatible C litmus test (`.litmus`) from the current session.
 *
 * Supported operations:
 * - LOAD: emitted as `READ_ONCE` (Relaxed/Standard/SC) or `smp_load_acquire` (Acquire/Acq_Rel)
 * - STORE: emitted as `WRITE_ONCE` (Relaxed/Standard/SC/Acquire) or `smp_store_release` (Release/Acq_Rel)
 * - FENCE: emitted as `smp_mb()` (best-effort)
 * - BRANCH: emitted as an `if (...) { ... }` statement
 * - RETRY/RETURN_TRUE/RETURN_FALSE: emitted as `return;`
 * - RMW: emitted as a best-effort CAS expansion (see notes)
 *
 * Notes:
 * - RMW is not exported as an atomic primitive yet. It is expanded into a load plus
 *   a conditional store, which is NOT equivalent to a true atomic RMW on weak memory
 *   models. This is still useful for quickly prototyping herd inputs, but it may
 *   over-approximate behaviors.
 *
 * @param session - Session state required to emit a `.litmus` file.
 * @param options - Optional export configuration.
 * @returns `.litmus` file contents.
 */
export const createHerdLitmusTest = (
  session: HerdLitmusExport,
  options?: LitmusExportOptions
) => {
  const dialect: LitmusExportDialect = options?.dialect ?? "lkmm";
  const memoryById = new Map(session.memoryEnv.map((item) => [item.id, item]));
  const visibleNodes = getVisibleTraceNodes({
    nodes: session.nodes,
    edges: session.edges,
    memoryEnv: session.memoryEnv,
    showAllNodes: session.showAllNodes,
  });

  /**
   * Visible node lookup and set membership.
   *
   * Notes:
   * - We intentionally infer the postcondition from the *visible* graph so
   *   branch-evaluation and "show both futures" match what the user sees.
   */
  const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
  const nodeById = new Map(visibleNodes.map((node) => [node.id, node]));

  const unsupported = visibleNodes.filter(
    (node) => !isSupportedExportOperationType(node.data.operation.type)
  );
  if (unsupported.length > 0) {
    const types = [...new Set(unsupported.map((node) => node.data.operation.type))].sort();
    throw new Error(
      `Cannot export .litmus yet: unsupported operation type(s): ${types.join(", ")}.`
    );
  }

  const orderedThreads = session.threads.slice();
  const seenThreads = new Set(orderedThreads);
  for (const node of visibleNodes) {
    if (!seenThreads.has(node.data.threadId)) {
      seenThreads.add(node.data.threadId);
      orderedThreads.push(node.data.threadId);
    }
  }

  const threadIndexById = new Map<string, number>();
  orderedThreads.forEach((threadId, index) => threadIndexById.set(threadId, index));

  /**
   * Formats a node reference in the compact `TX-SY` form requested by Litmus Explorer.
   *
   * Notes:
   * - X is the numeric thread index (based on export order).
   * - Y is the sequence index shown in the canvas.
   * - Avoids leaking internal UUIDs in user-facing errors.
   *
   * @param node - Trace node.
   * @returns `TX-SY` string.
   */
  const formatNodeRef = (node: TraceNode) => {
    const threadIndex = threadIndexById.get(node.data.threadId) ?? 0;
    return `T${threadIndex}-S${node.data.sequenceIndex}`;
  };

  /**
   * Best-effort node reference formatter for messages that only have a node id.
   *
   * @param nodeId - Trace node id.
   * @returns `TX-SY` when resolvable, otherwise `T?-S?`.
   */
  const formatNodeRefById = (nodeId: string) => {
    const node = nodeById.get(nodeId);
    return node ? formatNodeRef(node) : "T?-S?";
  };

  /**
   * Collect the shared locations that should appear in the C thread signatures.
   *
   * We include:
   * - any explicitly defined shared vars in the memory environment
   * - any additional addresses referenced directly by operations (by string)
   */
  const sharedEnvVars = session.memoryEnv.filter((item) => item.scope === "shared");
  const locationKeyToRawName = new Map<string, string>();
  for (const variable of sharedEnvVars) {
    locationKeyToRawName.set(variable.id, variable.name);
  }

  /**
   * C11 note: herdtools7 models `atomic_compare_exchange_*` with the "expected" argument
   * as a memory location (no `&local` syntax exists in the litmus C grammar). Litmus
   * Explorer's CAS nodes typically use a scalar register/constant as the expected value,
   * so we introduce a per-thread scratch location to bridge the gap.
   */
  const threadsNeedingCasExpectedScratch = new Set<string>();
  if (dialect === "c11") {
    for (const node of visibleNodes) {
      if (node.data.operation.type === "RMW") {
        threadsNeedingCasExpectedScratch.add(node.data.threadId);
      }
    }
    for (const threadId of threadsNeedingCasExpectedScratch) {
      locationKeyToRawName.set(`cas_expected:${threadId}`, `cas_expected_${threadId}`);
    }
  }

  const resolveLocationKeyAndName = (node: TraceNode) => {
    const op = node.data.operation;
    if (op.type !== "LOAD" && op.type !== "STORE" && op.type !== "RMW") {
      return null;
    }

    // Member addressing (`r0.next`, `head.val`, etc).
    // The editor's memory model currently treats struct members as their own symbolic
    // shared locations. For export, we model the access as an access to the member
    // location itself, ignoring the base address expression.
    if (op.memberId) {
      const member = memoryById.get(op.memberId);
      if (!member) {
        throw new Error(
          `Cannot export: ${op.type} node ${formatNodeRef(node)} references missing memberId ${op.memberId}.`
        );
      }
      if (member.scope !== "shared") {
        throw new Error(
          `Cannot export: ${op.type} node ${formatNodeRef(node)} references a non-shared member (${member.name}).`
        );
      }
      return { key: member.id, rawName: formatMemoryLabel(member, memoryById) };
    }

    // Indexed addressing: support only when the index is a numeric literal.
    if (op.indexId || op.index) {
      const baseId = op.addressId;
      if (!baseId) {
        throw new Error(
          `Cannot export: ${op.type} node ${formatNodeRef(node)} uses indexed addressing without a base address.`
        );
      }
      const base = memoryById.get(baseId);
      if (!base || base.scope !== "shared") {
        throw new Error(
          `Cannot export: ${op.type} node ${formatNodeRef(node)} uses indexed addressing on a non-shared base.`
        );
      }

      const indexFromId = (() => {
        if (!op.indexId) {
          return "";
        }
        const variable = memoryById.get(op.indexId);
        if (!variable || !isIntMemoryVariable(variable)) {
          return "";
        }
        return (variable.value ?? variable.name).trim();
      })();
      const index = (op.index ?? "").trim() || indexFromId;
      if (!/^-?(?:0x[0-9a-fA-F]+|\d+)$/.test(index)) {
        throw new Error(
          `Cannot export: ${op.type} node ${formatNodeRef(node)} uses a non-literal index (${index || "?"}).`
        );
      }

      const baseName = formatMemoryLabel(base, memoryById);
      const key = `idx:${base.id}[${index}]`;
      const rawName = `${baseName}[${index}]`;
      return { key, rawName };
    }

    if (op.addressId) {
      const variable = memoryById.get(op.addressId);
      if (variable && variable.scope !== "shared") {
        throw new Error(
          `Cannot export: ${op.type} node ${formatNodeRef(node)} targets ${variable.scope} memory (${variable.name}). Litmus locations must be shared.`
        );
      }
      if (variable) {
        return { key: variable.id, rawName: variable.name };
      }
    }
    const rawName = (op.address ?? "").trim();
    if (!rawName) {
      throw new Error(
        `Cannot export: ${op.type} node ${formatNodeRef(node)} is missing an address.`
      );
    }
    return { key: `addr:${rawName}`, rawName };
  };

  for (const node of visibleNodes) {
    const resolved = resolveLocationKeyAndName(node);
    if (!resolved) {
      continue;
    }
    if (!locationKeyToRawName.has(resolved.key)) {
      locationKeyToRawName.set(resolved.key, resolved.rawName);
    }
  }

  const usedLocationKeys = [...locationKeyToRawName.keys()];
  const usedLocationNames = new Set<string>();
  const locationKeyToCName = new Map<string, string>();
  for (const key of usedLocationKeys) {
    const rawName = locationKeyToRawName.get(key) ?? "x";
    const cName = toCIdentifier(rawName, usedLocationNames);
    locationKeyToCName.set(key, cName);
  }

  const resolveLocationCName = (node: TraceNode) => {
    const resolved = resolveLocationKeyAndName(node);
    if (!resolved) {
      return null;
    }
    const name = locationKeyToCName.get(resolved.key);
    if (!name) {
      throw new Error(
        `Cannot export: failed to resolve a stable C identifier for location "${resolved.rawName}".`
      );
    }
    return name;
  };

  const resolveValueExpr = (node: TraceNode, localNameById: Map<string, string>) => {
    const op = node.data.operation;
    if (op.type !== "STORE") {
      return "";
    }

    if (op.valueId) {
      const variable = memoryById.get(op.valueId);
      if (!variable) {
        throw new Error(
          `Cannot export: STORE node ${formatNodeRef(node)} valueId was not found.`
        );
      }
      if (variable.scope === "locals") {
        const name = localNameById.get(variable.id);
        if (!name) {
          throw new Error(
            `Cannot export: STORE node ${formatNodeRef(node)} references an undeclared local (${variable.name}).`
          );
        }
        if (dialect === "lkmm") {
          throw new Error(
            `Cannot export: STORE node ${formatNodeRef(node)} uses a local register (${name}) as its RHS. Exporting local computations is not supported yet; use an immediate or constant value instead.`
          );
        }
        return name;
      }
      if (variable.scope === "constants") {
        if (variable.type === "int" && (variable.value ?? "").trim()) {
          return (variable.value ?? "").trim();
        }
        return variable.name.trim() || "0";
      }
      if (dialect === "c11") {
        const expr = sharedValueExprById.get(variable.id);
        if (!expr) {
          throw new Error(
            `Cannot export: STORE node ${formatNodeRef(node)} uses shared value (${variable.name}) but its load expression could not be resolved.`
          );
        }
        return expr;
      }
      throw new Error(
        `Cannot export: STORE node ${formatNodeRef(node)} uses a shared value variable (${variable.name}) as its RHS, which is not supported.`
      );
    }

    if (typeof op.value === "number") {
      return String(op.value);
    }
    if (typeof op.value === "string" && op.value.trim()) {
      return op.value.trim();
    }
    throw new Error(`Cannot export: STORE node ${formatNodeRef(node)} is missing a value.`);
  };

  /**
   * Emit program text per thread in order.
   *
   * We build a per-thread namespace so locals never collide with parameter names.
   */
  const threadBlocks: string[] = [];

  /**
   * Infer the final-state value of a register-producing LOAD, based on the graph:
   * - Use `rf` when present (single incoming `rf` edge to the LOAD).
   * - Otherwise, allow "reads from init" only when it's unambiguous:
   *   - no stores to that location exist in the visible graph, OR
   *   - exactly one store to that location exists and the LOAD has `fr` to that store.
   *
   * This keeps exports faithful to the "witness" style edges users draw.
   */
  const storeNodesByLocationKey = new Map<string, TraceNode[]>();
  for (const node of visibleNodes) {
    const type = node.data.operation.type;
    if (type !== "STORE" && type !== "RMW") {
      continue;
    }
    const resolved = resolveLocationKeyAndName(node);
    if (!resolved) {
      continue;
    }
    const current = storeNodesByLocationKey.get(resolved.key) ?? [];
    current.push(node);
    storeNodesByLocationKey.set(resolved.key, current);
  }

  const rfSourceByLoadNodeId = new Map<string, string>();
  const frTargetsByLoadNodeId = new Map<string, Set<string>>();

  for (const edge of session.edges) {
    const relationType = getRelationType(edge);
    if (relationType !== "rf" && relationType !== "fr") {
      continue;
    }
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) {
      continue;
    }

    if (relationType === "rf") {
      const target = nodeById.get(edge.target);
      if (!target || target.data.operation.type !== "LOAD") {
        continue;
      }
      const existing = rfSourceByLoadNodeId.get(edge.target);
      if (existing && existing !== edge.source) {
        throw new Error(
          `Cannot export: LOAD node ${formatNodeRefById(edge.target)} has multiple incoming rf edges.`
        );
      }
      rfSourceByLoadNodeId.set(edge.target, edge.source);
      continue;
    }

    if (relationType === "fr") {
      const source = nodeById.get(edge.source);
      if (!source || source.data.operation.type !== "LOAD") {
        continue;
      }
      const set = frTargetsByLoadNodeId.get(edge.source) ?? new Set<string>();
      set.add(edge.target);
      frTargetsByLoadNodeId.set(edge.source, set);
    }
  }

  /**
   * Extracts a numeric literal from a node that performs a write.
   *
   * Supported sources:
   * - STORE: uses the immediate/constant RHS
   * - RMW: uses the desired-value (write) operand
   *
   * Notes:
   * - This is intentionally conservative: if a value comes from a local register,
   *   the exporter refuses to guess its value.
   *
   * @param writerNode - Node that writes a shared location (STORE/RMW).
   * @param localNameById - Local register name mapping for the writer's thread (used for errors).
   * @returns Numeric literal string.
   */
  const getWriteValueLiteral = (
    writerNode: TraceNode
  ): string | null => {
    const op = writerNode.data.operation;

    if (op.type === "RMW") {
      const desiredId = op.desiredValueId;
      if (!desiredId) {
        throw new Error(
          `Cannot export: RMW node ${formatNodeRef(writerNode)} is missing a desired value.`
        );
      }
      const variable = memoryById.get(desiredId);
      if (!variable) {
        throw new Error(
          `Cannot export: RMW node ${formatNodeRef(writerNode)} desiredValueId was not found.`
        );
      }
      if (variable.scope === "locals") {
        return null;
      }
      if (variable.scope === "constants" && isIntMemoryVariable(variable)) {
        const value = (variable.value ?? variable.name).trim();
        if (value) {
          return value;
        }
        throw new Error(
          `Cannot export: RMW node ${formatNodeRef(writerNode)} references an empty constant (${variable.name}).`
        );
      }
      throw new Error(
        `Cannot export: RMW node ${formatNodeRef(writerNode)} references a non-int constant (${variable.name}).`
      );
    }

    if (op.type !== "STORE") {
      throw new Error(
        `Cannot export: rf source ${writerNode.id} is not a supported writer (expected STORE/RMW).`
      );
    }

    if (op.valueId) {
      const variable = memoryById.get(op.valueId);
      if (!variable) {
        throw new Error(
          `Cannot export: STORE node ${formatNodeRef(writerNode)} valueId was not found.`
        );
      }
      if (variable.scope === "locals") {
        return null;
      }
      if (variable.scope === "constants" && isIntMemoryVariable(variable)) {
        const value = (variable.value ?? variable.name).trim();
        if (value) {
          return value;
        }
        throw new Error(
          `Cannot export: STORE node ${formatNodeRef(writerNode)} references an empty constant (${variable.name}).`
        );
      }
      throw new Error(
        `Cannot export: STORE node ${formatNodeRef(writerNode)} references a non-int constant (${variable.name}).`
      );
    }

    if (typeof op.value === "number") {
      return String(op.value);
    }
    if (typeof op.value === "string") {
      const raw = op.value.trim();
      if (!raw) {
        throw new Error(
          `Cannot export: STORE node ${formatNodeRef(writerNode)} is missing a value.`
        );
      }
      // Accept decimal/hex literals that herd's parsers commonly accept.
      if (/^-?(?:0x[0-9a-fA-F]+|\d+)$/.test(raw)) {
        return raw;
      }
      return null;
    }

    throw new Error(
      `Cannot export: STORE node ${formatNodeRef(writerNode)} is missing a value.`
    );
  };

  /**
   * Infers the final value for a register produced by a LOAD node.
   *
   * @param loadNode - LOAD node.
   * @param localNameById - Per-thread local register name mapping.
   * @returns Numeric literal string for use in the exists clause.
   */
  const inferLoadResultLiteral = (loadNode: TraceNode): string | null => {
    const rfSourceId = rfSourceByLoadNodeId.get(loadNode.id);
    if (rfSourceId) {
      const storeNode = nodeById.get(rfSourceId);
      if (!storeNode) {
        throw new Error(
          `Cannot export: LOAD node ${formatNodeRef(loadNode)} reads-from missing node ${formatNodeRefById(rfSourceId)}.`
        );
      }
      return getWriteValueLiteral(storeNode);
    }

    const resolved = resolveLocationKeyAndName(loadNode);
    if (!resolved) {
      throw new Error(
        `Cannot export: LOAD node ${formatNodeRef(loadNode)} is missing a resolvable address.`
      );
    }

    const stores = storeNodesByLocationKey.get(resolved.key) ?? [];
    if (stores.length === 0) {
      // Uncontended: read-from-init is the only possibility in this graph.
      const sharedVar = memoryById.get(resolved.key);
      return sharedVar && isIntMemoryVariable(sharedVar)
        ? (sharedVar.value ?? "0").trim() || "0"
        : "0";
    }

    if (stores.length === 1) {
      const frTargets = frTargetsByLoadNodeId.get(loadNode.id);
      const onlyStore = stores[0];
      if (frTargets?.has(onlyStore.id)) {
        // The load is ordered-before the only write, so it must read the initial value.
        const sharedVar = memoryById.get(resolved.key);
        return sharedVar && isIntMemoryVariable(sharedVar)
          ? (sharedVar.value ?? "0").trim() || "0"
          : "0";
      }
    }

    return null;
  };

  const sharedValueExprById = new Map<string, string>();
  for (const [key, cName] of locationKeyToCName.entries()) {
    const variable = memoryById.get(key);
    if (variable?.scope !== "shared") {
      continue;
    }
    sharedValueExprById.set(
      key,
      dialect === "c11"
        ? `atomic_load_explicit(${cName}, memory_order_relaxed)`
        : `READ_ONCE(*${cName})`
    );
  }

  const casExpectedScratchNameByThreadId = new Map<string, string>();
  if (dialect === "c11") {
    for (const threadId of threadsNeedingCasExpectedScratch) {
      const key = `cas_expected:${threadId}`;
      const name = locationKeyToCName.get(key);
      if (!name) {
        throw new Error(
          `Cannot export: failed to allocate a C identifier for CAS expected scratch in thread ${threadId}.`
        );
      }
      casExpectedScratchNameByThreadId.set(threadId, name);
    }
  }

  const expectedConjuncts: string[] = [];
  let hasAmbiguousBranches = false;
  let hasUninferrablePostcondition = false;

  for (const threadId of orderedThreads) {
    const threadIndex = threadIndexById.get(threadId) ?? 0;
    const threadNodesAll = session.nodes.filter((node) => node.data.threadId === threadId);
    const threadNodeById = new Map(threadNodesAll.map((node) => [node.id, node]));

    /**
     * Best-effort `TX-SY` formatter for any node id in this thread.
     *
     * @param nodeId - Trace node id.
     * @returns `TX-SY` when resolvable, otherwise `T${threadIndex}-S?`.
     */
    const formatThreadNodeRefById = (nodeId: string) => {
      const node = threadNodeById.get(nodeId);
      return node ? formatNodeRef(node) : `T${threadIndex}-S?`;
    };

    const reserved = new Set<string>();
    const argNames = [...locationKeyToCName.values()].sort((a, b) => a.localeCompare(b));
    for (const arg of argNames) {
      reserved.add(arg);
    }

    const localNameById = new Map<string, string>();
    const usedLocalNames = new Set<string>(reserved);

    /**
     * Derive local declarations from all referenced ids in this thread.
     *
     * Notes:
     * - Some local ids are referenced indirectly (e.g. in BRANCH conditions).
     * - Declaring extra locals is harmless and makes the exporter more robust.
     */
    const localIdsInThread = new Set<string>();
    for (const node of threadNodesAll) {
      const op = node.data.operation;
      if (op.type === "LOAD" && op.resultId) {
        localIdsInThread.add(op.resultId);
      }
      if (op.type === "STORE" && op.valueId) {
        const valueVar = memoryById.get(op.valueId);
        if (valueVar?.scope === "locals") {
          localIdsInThread.add(valueVar.id);
        }
      }
      if (op.type === "RMW" && op.resultId) {
        localIdsInThread.add(op.resultId);
      }
      if (op.type === "RMW") {
        const expectedId = op.expectedValueId;
        const desiredId = op.desiredValueId;
        if (expectedId) {
          const variable = memoryById.get(expectedId);
          if (variable?.scope === "locals") {
            localIdsInThread.add(expectedId);
          }
        }
        if (desiredId) {
          const variable = memoryById.get(desiredId);
          if (variable?.scope === "locals") {
            localIdsInThread.add(desiredId);
          }
        }
      }
      if (op.type === "BRANCH" && op.branchCondition) {
        for (const id of collectBranchConditionIds(op.branchCondition)) {
          const variable = memoryById.get(id);
          if (variable?.scope === "locals") {
            localIdsInThread.add(id);
          }
        }
      }
    }

    for (const id of localIdsInThread) {
      const variable = memoryById.get(id);
      const rawName = variable?.name ?? `r${id}`;
      localNameById.set(id, toCIdentifier(rawName, usedLocalNames));
    }

    const decls = [...localNameById.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    /**
     * Thread-local `po` graph index.
     *
     * - For BRANCH nodes, `sourceHandle` differentiates the `then` and `else` successor.
     * - For non-branch nodes, we expect at most one successor overall.
     */
    const poOutgoing = new Map<string, { then: string[]; else: string[]; next: string[] }>();
    const poIncomingCount = new Map<string, number>();
    let poEdgeCount = 0;

    const ensureBuckets = (nodeId: string) => {
      if (poOutgoing.has(nodeId)) {
        return;
      }
      poOutgoing.set(nodeId, { then: [], else: [], next: [] });
    };

    for (const node of threadNodesAll) {
      ensureBuckets(node.id);
      poIncomingCount.set(node.id, 0);
    }

    for (const edge of session.edges) {
      if (getRelationType(edge) !== "po") {
        continue;
      }
      const source = threadNodeById.get(edge.source);
      const target = threadNodeById.get(edge.target);
      if (!source || !target) {
        continue;
      }
      if (source.data.threadId !== threadId || target.data.threadId !== threadId) {
        continue;
      }

      const bucket =
        edge.sourceHandle === "then"
          ? "then"
          : edge.sourceHandle === "else"
            ? "else"
            : "next";

      ensureBuckets(edge.source);
      poOutgoing.get(edge.source)?.[bucket].push(edge.target);
      poIncomingCount.set(edge.target, (poIncomingCount.get(edge.target) ?? 0) + 1);
      poEdgeCount += 1;
    }

    if (poEdgeCount === 0) {
      // No explicit `po`: fall back to sequence index ordering.
      const ordered = threadNodesAll
        .slice()
        .sort(
          (a, b) =>
            a.data.sequenceIndex - b.data.sequenceIndex || a.id.localeCompare(b.id)
        );
      for (let index = 0; index < ordered.length - 1; index += 1) {
        const from = ordered[index];
        const to = ordered[index + 1];
        ensureBuckets(from.id);
        poOutgoing.get(from.id)?.next.push(to.id);
        poIncomingCount.set(to.id, (poIncomingCount.get(to.id) ?? 0) + 1);
      }
    }

    const getOutgoing = (nodeId: string) =>
      poOutgoing.get(nodeId) ?? { then: [], else: [], next: [] };

    const getAllSuccessors = (nodeId: string) => {
      const out = getOutgoing(nodeId);
      return [...out.then, ...out.else, ...out.next];
    };

    const getSingleSuccessor = (nodeId: string) => {
      const all = getAllSuccessors(nodeId);
      if (all.length === 0) {
        return null;
      }
      if (all.length === 1) {
        return all[0];
      }
      throw new Error(
        `Cannot export: node ${formatThreadNodeRefById(nodeId)} has multiple po successors.`
      );
    };

    const getBranchSuccessors = (nodeId: string) => {
      const out = getOutgoing(nodeId);
      const thenCandidate = out.then[0] ?? (out.next.length === 1 ? out.next[0] : undefined);
      const elseCandidate = out.else[0];

      if (out.then.length > 1 || out.else.length > 1 || out.next.length > 1) {
        throw new Error(
          `Cannot export: BRANCH node ${formatThreadNodeRefById(nodeId)} has too many outgoing po edges.`
        );
      }

      return { thenStartId: thenCandidate ?? null, elseStartId: elseCandidate ?? null };
    };

    /**
     * Finds the earliest join node reachable from both `then` and `else` starts.
     *
     * @param thenStartId - Then-start node id.
     * @param elseStartId - Else-start node id.
     * @returns Join node id, or null when none exists.
     */
    const findJoinId = (thenStartId: string, elseStartId: string) => {
      if (thenStartId === elseStartId) {
        return thenStartId;
      }

      const bfs = (startId: string) => {
        const dist = new Map<string, number>();
        const queue: string[] = [];
        dist.set(startId, 0);
        queue.push(startId);
        while (queue.length > 0) {
          const nextId = queue.shift();
          if (!nextId) {
            continue;
          }
          const nextDist = dist.get(nextId) ?? 0;
          for (const succ of getAllSuccessors(nextId)) {
            if (dist.has(succ)) {
              continue;
            }
            dist.set(succ, nextDist + 1);
            queue.push(succ);
          }
        }
        return dist;
      };

      const distThen = bfs(thenStartId);
      const distElse = bfs(elseStartId);

      let bestId: string | null = null;
      let bestKey: [number, number, number, string] | null = null;
      const isLexicographicallySmaller = (
        a: [number, number, number, string],
        b: [number, number, number, string]
      ) => {
        for (let index = 0; index < a.length; index += 1) {
          if (a[index] === b[index]) {
            continue;
          }
          return a[index] < b[index];
        }
        return false;
      };

      for (const [candidateId, dt] of distThen.entries()) {
        const de = distElse.get(candidateId);
        if (typeof de !== "number") {
          continue;
        }
        const node = threadNodeById.get(candidateId);
        const seq = node?.data.sequenceIndex ?? Number.MAX_SAFE_INTEGER;
        const key: [number, number, number, string] = [
          Math.max(dt, de),
          dt + de,
          seq,
          candidateId,
        ];
        if (!bestKey || isLexicographicallySmaller(key, bestKey)) {
          bestKey = key;
          bestId = candidateId;
        }
      }

      return bestId;
    };

    const emitIndent = (level: number) => "  ".repeat(level);

    const emitNodeStatement = (node: TraceNode, indentLevel: number) => {
      const op = node.data.operation;

      if (!visibleNodeIds.has(node.id)) {
        return [];
      }

      if (isReturnLikeOperation(op.type)) {
        return [`${emitIndent(indentLevel)}return;`];
      }

      if (op.type === "FENCE") {
        const text = (op.text ?? "").trim();
        if (dialect === "c11") {
          if (/^atomic_thread_fence\s*\(\s*memory_order_\w+\s*\)\s*$/.test(text)) {
            return [`${emitIndent(indentLevel)}${text};`];
          }
          return [`${emitIndent(indentLevel)}atomic_thread_fence(memory_order_seq_cst);`];
        }
        if (/^smp_(mb|rmb|wmb)\s*\(\s*\)\s*$/.test(text)) {
          return [`${emitIndent(indentLevel)}${text};`];
        }
        return [`${emitIndent(indentLevel)}smp_mb();`];
      }

      if (op.type === "LOAD") {
        const location = resolveLocationCName(node);
        if (!location) {
          throw new Error(
            `Cannot export: LOAD node ${formatNodeRef(node)} is missing an address.`
          );
        }

        const destId = op.resultId;
        if (!destId) {
          throw new Error(
            `Cannot export: LOAD node ${formatNodeRef(node)} is missing a destination register. Set a local register as the result.`
          );
        }
        const destVar = memoryById.get(destId);
        if (destVar && destVar.scope !== "locals") {
          throw new Error(
            `Cannot export: LOAD node ${formatNodeRef(node)} writes into ${destVar.scope} memory (${destVar.name}). Load results must be local registers.`
          );
        }
        const dest = localNameById.get(destId);
        if (!dest) {
          throw new Error(
            `Cannot export: LOAD node ${formatNodeRef(node)} destination register could not be resolved.`
          );
        }

        const order = normalizeMemoryOrder(op.memoryOrder);
        const stmt =
          dialect === "c11"
            ? `${dest} = atomic_load_explicit(${location}, ${toC11MemoryOrder(order, "load")});`
            : order === "Acquire" || order === "Acq_Rel"
              ? `${dest} = smp_load_acquire(${location});`
              : `${dest} = READ_ONCE(*${location});`;

        if (!hasAmbiguousBranches && !hasUninferrablePostcondition) {
          const expected = inferLoadResultLiteral(node);
          if (expected) {
            expectedConjuncts.push(`${threadIndex}:${dest}=${expected}`);
          } else {
            hasUninferrablePostcondition = true;
          }
        }
        return [`${emitIndent(indentLevel)}${stmt}`];
      }

      if (op.type === "STORE") {
        const location = resolveLocationCName(node);
        if (!location) {
          throw new Error(
            `Cannot export: STORE node ${formatNodeRef(node)} is missing an address.`
          );
        }
        const valueExpr = resolveValueExpr(node, localNameById);

        const order = normalizeMemoryOrder(op.memoryOrder);
        const stmt =
          dialect === "c11"
            ? `atomic_store_explicit(${location}, ${valueExpr}, ${toC11MemoryOrder(
                order,
                "store"
              )});`
            : order === "Release" || order === "Acq_Rel"
              ? `smp_store_release(${location}, ${valueExpr});`
              : `WRITE_ONCE(*${location}, ${valueExpr});`;

        return [`${emitIndent(indentLevel)}${stmt}`];
      }

      if (op.type === "RMW") {
        const location = resolveLocationCName(node);
        if (!location) {
          throw new Error(
            `Cannot export: RMW node ${formatNodeRef(node)} is missing an address.`
          );
        }
        const destId = op.resultId;
        const destVar = destId ? memoryById.get(destId) : null;
        if (destVar && destVar.scope !== "locals") {
          throw new Error(
            `Cannot export: RMW node ${formatNodeRef(node)} writes into ${destVar.scope} memory (${destVar.name}). RMW results must be local registers.`
          );
        }
        const dest = destId ? localNameById.get(destId) : null;
        if (destId && !dest) {
          throw new Error(
            `Cannot export: RMW node ${formatNodeRef(node)} destination register could not be resolved.`
          );
        }

        const expectedId = op.expectedValueId;
        const desiredId = op.desiredValueId;
        if (!expectedId || !desiredId) {
          throw new Error(
            `Cannot export: RMW node ${formatNodeRef(node)} is missing expected/desired values.`
          );
        }

        const valueIdToExpr = (valueId: string) => {
          const variable = memoryById.get(valueId);
          if (!variable) {
            throw new Error(
              `Cannot export: RMW node ${formatNodeRef(node)} references missing value id ${valueId}.`
            );
          }
          if (variable.scope === "locals") {
            const name = localNameById.get(valueId);
            if (!name) {
              throw new Error(
                `Cannot export: RMW node ${formatNodeRef(node)} references an undeclared local (${variable.name}).`
              );
            }
            return name;
          }
          if (variable.scope === "constants") {
            if (!isIntMemoryVariable(variable)) {
              throw new Error(
                `Cannot export: RMW node ${formatNodeRef(node)} references a non-int constant (${variable.name}).`
              );
            }
            const raw = (variable.value ?? variable.name).trim();
            if (!raw) {
              throw new Error(
                `Cannot export: RMW node ${formatNodeRef(node)} references an empty constant (${variable.name}).`
              );
            }
            return raw;
          }
          if (dialect === "c11" && variable.scope === "shared") {
            const expr = sharedValueExprById.get(variable.id);
            if (!expr) {
              throw new Error(
                `Cannot export: RMW node ${formatNodeRef(node)} references shared value (${variable.name}) but its load expression could not be resolved.`
              );
            }
            return expr;
          }
          throw new Error(
            `Cannot export: RMW node ${formatNodeRef(node)} uses a ${variable.scope} value operand (${variable.name}); only locals/constants are supported.`
          );
        };

        const expectedExpr = valueIdToExpr(expectedId);
        const desiredExpr = valueIdToExpr(desiredId);

        if (dialect === "c11") {
          const scratch = casExpectedScratchNameByThreadId.get(threadId);
          if (!scratch) {
            throw new Error(
              `Cannot export: RMW node ${formatNodeRef(node)} requires a CAS expected scratch location (thread ${threadId}).`
            );
          }

          const successOrder = toC11MemoryOrder(op.successMemoryOrder, "rmw_success");
          const failureOrder = toC11MemoryOrder(op.failureMemoryOrder, "rmw_failure");
          const casExpr = `atomic_compare_exchange_strong_explicit(${location}, ${scratch}, ${desiredExpr}, ${successOrder}, ${failureOrder})`;

          return [
            `${emitIndent(indentLevel)}/* NOTE: Litmus Explorer models CAS as returning the old value (cmpxchg-style). */`,
            `${emitIndent(indentLevel)}atomic_store_explicit(${scratch}, ${expectedExpr}, memory_order_relaxed);`,
            `${emitIndent(indentLevel)}(void)${casExpr};`,
            ...(dest
              ? [
                  `${emitIndent(indentLevel)}${dest} = atomic_load_explicit(${scratch}, memory_order_relaxed);`,
                ]
              : []),
          ];
        }

        const failureOrder = normalizeMemoryOrder(op.failureMemoryOrder);
        const successOrder = normalizeMemoryOrder(op.successMemoryOrder);

        const loadExpr =
          failureOrder === "Acquire" || failureOrder === "Acq_Rel"
            ? `smp_load_acquire(${location})`
            : `READ_ONCE(*${location})`;
        const storeStmt =
          successOrder === "Release" || successOrder === "Acq_Rel"
            ? `smp_store_release(${location}, ${desiredExpr});`
            : `WRITE_ONCE(*${location}, ${desiredExpr});`;

        const tmpName = dest ?? toCIdentifier(`rmw_${node.id}`, usedLocalNames);
        const loadStmt = dest ? `${tmpName} = ${loadExpr};` : `int ${tmpName} = ${loadExpr};`;

        return [
          `${emitIndent(indentLevel)}/* NOTE: CAS is exported as load + conditional store (not atomic). */`,
          `${emitIndent(indentLevel)}${loadStmt}`,
          `${emitIndent(indentLevel)}if (${tmpName} == ${expectedExpr}) {`,
          `${emitIndent(indentLevel + 1)}${storeStmt}`,
          `${emitIndent(indentLevel)}}`,
        ];
      }

      if (op.type === "BRANCH") {
        // BRANCH nodes are emitted structurally during traversal.
        return [];
      }

      throw new Error(
        `Cannot export: unsupported operation type ${op.type} on node ${formatNodeRef(node)}.`
      );
    };

    /**
     * Determines whether a `po` subgraph contains any visible node before reaching `stopId`.
     *
     * @param startId - Start node id.
     * @param stopId - Join/stop node id.
     * @returns True when the subgraph includes at least one visible node.
     */
    const hasVisibleNodeBeforeStop = (startId: string, stopId: string) => {
      const queue = [startId];
      const seen = new Set<string>();
      while (queue.length > 0) {
        const nextId = queue.shift();
        if (!nextId || nextId === stopId || seen.has(nextId)) {
          continue;
        }
        seen.add(nextId);
        if (visibleNodeIds.has(nextId)) {
          return true;
        }
        for (const succ of getAllSuccessors(nextId)) {
          queue.push(succ);
        }
      }
      return false;
    };

    /**
     * Emits a `po` path until `stopId` (exclusive), following BRANCH structure when encountered.
     *
     * @param startId - Start node id.
     * @param stopId - Stop node id.
     * @param indentLevel - Indentation level.
     * @param visited - Visited node accumulator (per thread).
     * @param lines - Output lines accumulator.
     */
    const emitPath = (
      startId: string,
      stopId: string,
      indentLevel: number,
      visited: Set<string>,
      lines: string[]
    ) => {
      let current: string | null = startId;
      while (current && current !== stopId) {
        if (visited.has(current)) {
          throw new Error(
            `Cannot export: cycle or re-visit detected at node ${formatThreadNodeRefById(
              current
            )}.`
          );
        }
        visited.add(current);
        const node = threadNodeById.get(current);
        if (!node) {
          break;
        }

        const op = node.data.operation;
        if (op.type === "BRANCH") {
          if (!op.branchCondition) {
            throw new Error(
              `Cannot export: BRANCH node ${formatNodeRef(node)} is missing a condition.`
            );
          }
          const { thenStartId, elseStartId } = getBranchSuccessors(node.id);
          if (!thenStartId && !elseStartId) {
            throw new Error(
              `Cannot export: BRANCH node ${formatNodeRef(node)} has no outgoing po edges.`
            );
          }

          const joinId =
            thenStartId && elseStartId ? findJoinId(thenStartId, elseStartId) : null;

          const terminalStopId = joinId ?? "__end__";
          const thenHasVisible = thenStartId
            ? hasVisibleNodeBeforeStop(thenStartId, terminalStopId)
            : false;
          const elseHasVisible = elseStartId
            ? hasVisibleNodeBeforeStop(elseStartId, terminalStopId)
            : false;
          if (thenHasVisible && elseHasVisible) {
            hasAmbiguousBranches = true;
          }

          const condition = branchConditionToCExpression({
            root: op.branchCondition,
            memoryById,
            localNameById,
            sharedValueExprById,
          });

          const emitConditionalBlocks = (stopAt: string) => {
            if (!thenHasVisible && !elseHasVisible) {
              throw new Error(
                `Cannot export: BRANCH node ${formatNodeRef(node)} has no visible operations in either future.`
              );
            }

            if (thenHasVisible && !elseHasVisible) {
              lines.push(`${emitIndent(indentLevel)}if (${condition}) {`);
              if (thenStartId) {
                emitPath(thenStartId, stopAt, indentLevel + 1, visited, lines);
              }
              lines.push(`${emitIndent(indentLevel)}}`);
              return;
            }

            if (!thenHasVisible && elseHasVisible) {
              lines.push(`${emitIndent(indentLevel)}if (!(${condition})) {`);
              if (elseStartId) {
                emitPath(elseStartId, stopAt, indentLevel + 1, visited, lines);
              }
              lines.push(`${emitIndent(indentLevel)}}`);
              return;
            }

            lines.push(`${emitIndent(indentLevel)}if (${condition}) {`);
            if (thenStartId) {
              emitPath(thenStartId, stopAt, indentLevel + 1, visited, lines);
            }
            lines.push(`${emitIndent(indentLevel)}} else {`);
            if (elseStartId) {
              emitPath(elseStartId, stopAt, indentLevel + 1, visited, lines);
            }
            lines.push(`${emitIndent(indentLevel)}}`);
          };

          if (joinId) {
            emitConditionalBlocks(joinId);
            current = joinId;
            continue;
          }

          // No reconvergence: inline each future until the end of the thread.
          emitConditionalBlocks("__end__");
          return;

        }

        const emitted = emitNodeStatement(node, indentLevel);
        lines.push(...emitted);

        if (isReturnLikeOperation(op.type)) {
          const succ = getSingleSuccessor(node.id);
          if (succ) {
            throw new Error(
              `Cannot export: ${op.type} node ${formatNodeRef(node)} has a po successor (${formatThreadNodeRefById(
                succ
              )}).`
            );
          }
          return;
        }

        current = getSingleSuccessor(node.id);
      }
    };

    const entryCandidates = threadNodesAll.filter(
      (node) => (poIncomingCount.get(node.id) ?? 0) === 0
    );

    const signature =
      argNames.length > 0
        ? `P${threadIndex}(${argNames
            .map((name) =>
              dialect === "c11" ? `atomic_int *${name}` : `volatile int *${name}`
            )
            .join(", ")})`
        : `P${threadIndex}()`;

    threadBlocks.push("");
    threadBlocks.push(`${signature} {`);

    for (const decl of decls) {
      const variable = memoryById.get(decl.id);
      const init =
        variable && variable.scope === "locals" && isIntMemoryVariable(variable)
          ? (variable.value ?? "").trim()
          : "";
      const initLiteral =
        init && /^-?(?:0x[0-9a-fA-F]+|\d+)$/.test(init) ? init : "";
      threadBlocks.push(
        initLiteral ? `  int ${decl.name} = ${initLiteral};` : `  int ${decl.name};`
      );
    }

    const visited = new Set<string>();
    const bodyLines: string[] = [];

    if (threadNodesAll.length > 0) {
      if (entryCandidates.length !== 1) {
        throw new Error(
          `Cannot export: thread ${threadId} must have exactly one entry node (found ${entryCandidates.length}).`
        );
      }
      emitPath(entryCandidates[0].id, "__end__", 1, visited, bodyLines);
    }

    // Emit thread body after local declarations.
    threadBlocks.push(...bodyLines.map((line) => line));
    threadBlocks.push("}");

    // Validate that every visible node in this thread is reachable by `po`.
    const visibleInThread = threadNodesAll
      .filter((node) => visibleNodeIds.has(node.id))
      .map((node) => node.id);
    const unreachable = visibleInThread.filter((id) => !visited.has(id));
    if (unreachable.length > 0) {
      throw new Error(
        `Cannot export: thread ${threadId} has visible nodes not reachable by po: ${unreachable
          .map((id) => formatThreadNodeRefById(id))
          .join(", ")}.`
      );
    }
  }

  const unique = [...new Set(expectedConjuncts)];
  const shouldUseInferredPostcondition =
    unique.length > 0 && !hasAmbiguousBranches && !hasUninferrablePostcondition;
  const condition = shouldUseInferredPostcondition ? unique.join(" /\\ ") : "0=0";
  const postconditionNote = shouldUseInferredPostcondition
    ? null
    : hasAmbiguousBranches
      ? "LitmusExplorer: exported multiple branch futures; edit the exists clause to match your intended outcome."
      : "LitmusExplorer: could not infer a register postcondition; edit the exists clause as needed.";

  const title = toSafeTitle(session.title) || "LitmusExplorer";

  // Use initial values from the shared memory environment when available.
  const sharedById = new Map(sharedEnvVars.map((item) => [item.id, item]));
  const initLines: string[] = [];
  for (const [key, cName] of [...locationKeyToCName.entries()].sort((a, b) =>
    a[1].localeCompare(b[1])
  )) {
    const envVar = sharedById.get(key);
    const rawValue =
      envVar && isIntMemoryVariable(envVar) ? (envVar.value ?? "").trim() : "";
    const normalized = rawValue || "0";
    if (dialect === "c11") {
      initLines.push(`[${cName}] = ${normalized};`);
      continue;
    }
    if (normalized !== "0") {
      initLines.push(`${cName}=${normalized};`);
    }
  }

  return [
    `C ${title}`,
    "",
    ...(postconditionNote
      ? ["(*", ` * ${postconditionNote}`, " *)", ""]
      : []),
    ...(dialect === "c11"
      ? [`{ ${initLines.join(" ")} }`]
      : initLines.length > 0
        ? ["{", ...initLines.map((line) => `  ${line}`), "}"]
        : ["{}"]),
    ...threadBlocks,
    "",
    `exists (${condition})`,
    "",
  ].join("\n");
};

/**
 * Creates a herdtools7-compatible C11 litmus test (`.litmus`) from the current session.
 *
 * Notes:
 * - Uses `atomic_*_explicit` primitives (load/store/fence/CAS).
 * - Adds a per-thread scratch location for the CAS expected operand to match herdtools7's
 *   C11 CAS semantics while preserving Litmus Explorer's "returns old value" behavior.
 *
 * @param session - Session state required to emit a `.litmus` file.
 * @returns `.litmus` file contents.
 */
export const createC11LitmusTest = (session: HerdLitmusExport) =>
  createHerdLitmusTest(session, { dialect: "c11" });
