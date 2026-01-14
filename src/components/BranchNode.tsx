import { useMemo, useState } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import type { BranchPath, TraceNodeData } from "../types";
import { useStore } from "../store/useStore";

const BranchNode = ({ id, data, selected }: NodeProps<TraceNodeData>) => {
  const [path, setPath] = useState<BranchPath>("then");
  const activeBranch = useStore((state) => state.activeBranch);
  const setActiveBranch = useStore((state) => state.setActiveBranch);

  const isActive = activeBranch?.branchId === id;
  const isCollapsed = isActive && activeBranch?.path === path;

  const label = useMemo(
    () => data.operation.text ?? "BRANCH",
    [data.operation.text]
  );

  const handleCollapse = () => {
    if (isCollapsed) {
      setActiveBranch(null);
      return;
    }

    setActiveBranch({ branchId: id, path });
  };

  return (
    <div className="flex flex-col items-center gap-1.5 text-[10px] text-slate-900">
      <div
        className={`relative h-14 w-14 rotate-45 rounded-md border border-slate-500 bg-amber-100 shadow-sm ${
          selected ? "ring-2 ring-slate-600" : ""
        }`}
      >
        <div className="absolute inset-0 flex -rotate-45 items-center justify-center text-[10px] font-semibold">
          {label}
        </div>
        <Handle
          type="target"
          position={Position.Left}
          className="!h-1.5 !w-1.5 !bg-slate-700"
        />
        <Handle
          type="source"
          position={Position.Right}
          className="!h-1.5 !w-1.5 !bg-slate-700"
        />
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          className={`rounded px-1.5 py-0.5 text-[9px] ${
            path === "then" ? "bg-slate-800 text-white" : "bg-slate-200"
          }`}
          onClick={() => setPath("then")}
        >
          Then
        </button>
        <button
          type="button"
          className={`rounded px-1.5 py-0.5 text-[9px] ${
            path === "else" ? "bg-slate-800 text-white" : "bg-slate-200"
          }`}
          onClick={() => setPath("else")}
        >
          Else
        </button>
        <button
          type="button"
          className={`rounded px-1.5 py-0.5 text-[9px] ${
            isCollapsed ? "bg-rose-500 text-white" : "bg-rose-100 text-rose-700"
          }`}
          onClick={handleCollapse}
        >
          {isCollapsed ? "Show All" : "Collapse"}
        </button>
      </div>
    </div>
  );
};

export default BranchNode;
