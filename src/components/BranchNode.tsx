import { useMemo } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import type {
  BranchCondition,
  BranchPath,
  BranchRuleCondition,
  MemoryVariable,
  TraceNodeData,
} from "../types";
import { useStore } from "../store/useStore";
import { evaluateBranchCondition } from "../utils/branchEvaluation";

/**
 * Formats a memory variable label for display in compact UI surfaces.
 *
 * @param item - Memory variable to format.
 * @param memoryById - Lookup map of variables by id.
 */
const formatMemoryLabel = (
  item: MemoryVariable | undefined,
  memoryById: Map<string, MemoryVariable>
) => {
  if (!item) {
    return "?";
  }
  const name = item.name.trim() || item.id;
  if (!item.parentId) {
    return name;
  }
  const parentName = memoryById.get(item.parentId)?.name.trim() || "struct";
  return `${parentName}.${name}`;
};

/**
 * Returns the single leaf rule if (and only if) the condition tree contains
 * exactly one rule; otherwise returns null.
 *
 * @param condition - Branch condition tree (root group or nested).
 */
const getSingleLeafRule = (condition: BranchCondition | undefined) => {
  if (!condition) {
    return null;
  }

  let found: BranchRuleCondition | null = null;
  const visit = (node: BranchCondition): boolean => {
    if (node.kind === "rule") {
      if (found) {
        return false;
      }
      found = node;
      return true;
    }

    for (const item of node.items) {
      if (!visit(item)) {
        return false;
      }
    }

    return true;
  };

  return visit(condition) ? found : null;
};

/**
 * Formats a single branch rule into a compact inline label suitable for the
 * branch-node diamond.
 *
 * @param rule - Rule to format.
 * @param memoryById - Lookup map of variables by id.
 */
const formatBranchRuleLabel = (
  rule: BranchRuleCondition,
  memoryById: Map<string, MemoryVariable>
) => {
  if (rule.evaluation === "true") {
    return "True";
  }
  if (rule.evaluation === "false") {
    return "False";
  }

  const lhs = rule.lhsId ? formatMemoryLabel(memoryById.get(rule.lhsId), memoryById) : "?";
  const rhs = rule.rhsId ? formatMemoryLabel(memoryById.get(rule.rhsId), memoryById) : "?";
  return `${lhs}${rule.op}${rhs}`;
};

const BranchNode = ({ id, data, selected }: NodeProps<TraceNodeData>) => {
  const memoryEnv = useStore((state) => state.memoryEnv);
  const setNodes = useStore((state) => state.setNodes);
  const showAllNodes = useStore((state) => state.showAllNodes);
  const memoryById = useMemo(
    () => new Map(memoryEnv.map((item) => [item.id, item])),
    [memoryEnv]
  );

  const condition = data.operation.branchCondition;
  const evaluatedPath = useMemo<BranchPath>(() => {
    if (!condition) {
      return "then";
    }
    return evaluateBranchCondition(condition, memoryEnv) ? "then" : "else";
  }, [condition, memoryEnv]);

  const label = useMemo(() => {
    if (data.operation.text) {
      return data.operation.text;
    }

    const singleRule = getSingleLeafRule(condition);
    return singleRule ? formatBranchRuleLabel(singleRule, memoryById) : "BRANCH";
  }, [condition, data.operation.text, memoryById]);

  /**
   * "Both" defaults to enabled to avoid surprising disappearing nodes.
   * Users can explicitly disable it per branch when they want evaluation-driven visibility.
   */
  const showBothFutures = data.operation.branchShowBothFutures ?? true;

  return (
    <div className="relative h-14 w-14 text-[10px] text-slate-900">
      <div
        className={`absolute inset-0 rotate-45 rounded-md border border-slate-500 bg-amber-100 shadow-sm ${
          selected ? "ring-2 ring-slate-600" : ""
        }`}
      >
        <div
          className="absolute inset-0 flex -rotate-45 items-center justify-center px-1 text-center text-[10px] font-semibold"
          title={label}
        >
          {label}
        </div>
      </div>
      <Handle
        type="target"
        position={Position.Top}
        className="!h-1.5 !w-1.5 !bg-slate-700"
        style={{
          left: "50%",
          top: "-20.7107%",
          transform: "translate(-50%, -50%)",
        }}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className="!h-2 !w-2 !bg-emerald-600"
        id="then"
        style={{
          bottom: "auto",
          left: "14.6447%",
          top: "85.3553%",
          transform: "translate(-50%, -50%)",
        }}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className="!h-2 !w-2 !bg-rose-600"
        id="else"
        style={{
          bottom: "auto",
          left: "85.3553%",
          top: "85.3553%",
          transform: "translate(-50%, -50%)",
        }}
      />
      <div className="absolute left-full top-1/2 ml-2 flex -translate-y-1/2 items-center gap-1">
        <div
          className={`rounded px-1.5 py-0.5 text-[9px] font-semibold ${
            evaluatedPath === "then"
              ? "bg-emerald-200 text-emerald-900"
              : "bg-rose-200 text-rose-900"
          }`}
        >
          {evaluatedPath === "then" ? "True" : "False"}
        </div>
        <button
          type="button"
          className={`rounded px-1.5 py-0.5 text-[9px] font-semibold disabled:cursor-not-allowed disabled:opacity-60 ${
            showBothFutures
              ? "bg-slate-800 text-white"
              : "bg-slate-200 text-slate-800"
          }`}
          onClick={(event) => {
            event.stopPropagation();
            if (showAllNodes) {
              return;
            }
            setNodes((current) =>
              current.map((node) => {
                if (node.id !== id) {
                  return node;
                }
                return {
                  ...node,
                  data: {
                    ...node.data,
                    operation: {
                      ...node.data.operation,
                      branchShowBothFutures: !showBothFutures,
                    },
                  },
                };
              })
            );
          }}
          disabled={showAllNodes}
          title={
            showAllNodes
              ? "Disabled while Show all is enabled"
              : "Show both futures"
          }
        >
          Both
        </button>
      </div>
    </div>
  );
};

export default BranchNode;
