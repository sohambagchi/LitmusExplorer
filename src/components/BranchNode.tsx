import { useMemo } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import type { BranchPath, TraceNodeData } from "../types";
import { useStore } from "../store/useStore";
import { evaluateBranchCondition } from "../utils/branchEvaluation";

const BranchNode = ({ id, data, selected }: NodeProps<TraceNodeData>) => {
  const memoryEnv = useStore((state) => state.memoryEnv);
  const setNodes = useStore((state) => state.setNodes);

  const condition = data.operation.branchCondition;
  const evaluatedPath = useMemo<BranchPath>(() => {
    if (!condition) {
      return "then";
    }
    return evaluateBranchCondition(condition, memoryEnv) ? "then" : "else";
  }, [condition, memoryEnv]);

  const label = useMemo(
    () => data.operation.text ?? "BRANCH",
    [data.operation.text]
  );

  const showBothFutures = data.operation.branchShowBothFutures ?? false;

  return (
    <div className="relative h-14 w-14 text-[10px] text-slate-900">
      <div
        className={`absolute inset-0 rotate-45 rounded-md border border-slate-500 bg-amber-100 shadow-sm ${
          selected ? "ring-2 ring-slate-600" : ""
        }`}
      >
        <div className="absolute inset-0 flex -rotate-45 items-center justify-center text-[10px] font-semibold">
          {label}
        </div>
      </div>
      <Handle
        type="target"
        position={Position.Left}
        className="!h-1.5 !w-1.5 !bg-slate-700"
        style={{
          left: "-20.7107%",
          top: "50%",
          transform: "translate(-50%, -50%)",
        }}
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2 !w-2 !bg-emerald-600"
        id="then"
        style={{
          left: "85.3553%",
          right: "auto",
          top: "14.6447%",
          transform: "translate(-50%, -50%)",
        }}
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2 !w-2 !bg-rose-600"
        id="else"
        style={{
          left: "85.3553%",
          right: "auto",
          top: "85.3553%",
          transform: "translate(-50%, -50%)",
        }}
      />
      <div className="absolute left-1/2 top-full mt-1.5 flex -translate-x-1/2 items-center gap-1">
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
          className={`rounded px-1.5 py-0.5 text-[9px] font-semibold ${
            showBothFutures ? "bg-slate-800 text-white" : "bg-slate-200 text-slate-800"
          }`}
          onClick={(event) => {
            event.stopPropagation();
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
          title="Show both futures"
        >
          Both
        </button>
      </div>
    </div>
  );
};

export default BranchNode;
