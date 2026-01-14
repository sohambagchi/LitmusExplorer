import { useMemo } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import { useStore } from "../store/useStore";
import type {
  MemoryOrder,
  MemoryVariable,
  OperationType,
  TraceNodeData,
} from "../types";

const orderColors: Record<MemoryOrder, string> = {
  Acquire: "bg-red-200",
  Release: "bg-blue-200",
  Relaxed: "bg-emerald-200",
  SC: "bg-amber-200",
};

const opLabels: Record<OperationType, string> = {
  LOAD: "LD",
  STORE: "ST",
  RMW: "RMW",
  FENCE: "FENCE",
  BRANCH: "BR",
};

const orderShort: Record<MemoryOrder, string> = {
  Acquire: "Acq",
  Release: "Rel",
  Relaxed: "Rlx",
  SC: "SC",
};

const formatMemoryLabel = (
  item: MemoryVariable | undefined,
  memoryById: Map<string, MemoryVariable>
) => {
  if (!item) {
    return "";
  }
  const name = item.name.trim() || item.id;
  if (!item.parentId) {
    return name;
  }
  const parentName = memoryById.get(item.parentId)?.name.trim() || "struct";
  return `${parentName}.${name}`;
};

const OperationNode = ({ data, selected }: NodeProps<TraceNodeData>) => {
  const memoryEnv = useStore((state) => state.memoryEnv);
  const memoryById = useMemo(
    () => new Map(memoryEnv.map((item) => [item.id, item])),
    [memoryEnv]
  );
  const resolvedAddress = data.operation.addressId
    ? formatMemoryLabel(memoryById.get(data.operation.addressId), memoryById)
    : "";
  const addressLabel = resolvedAddress || data.operation.address || "";
  const resolvedValue = data.operation.valueId
    ? formatMemoryLabel(memoryById.get(data.operation.valueId), memoryById)
    : "";
  const valueLabel =
    resolvedValue ||
    (data.operation.value !== undefined ? String(data.operation.value) : "");
  const label = useMemo(() => {
    const op = data.operation;
    const opLabel = opLabels[op.type];
    const address = addressLabel ? ` ${addressLabel}` : "";
    const value = valueLabel ? ` = ${valueLabel}` : "";
    const order = op.memoryOrder ? ` (${orderShort[op.memoryOrder]})` : "";

    return op.text ?? `${opLabel}${address}${value}${order}`;
  }, [addressLabel, data.operation, valueLabel]);

  const colorClass = data.operation.memoryOrder
    ? orderColors[data.operation.memoryOrder]
    : "bg-slate-200";

  return (
    <div
      className={`min-w-[110px] rounded-md border border-slate-400 px-2 py-1.5 text-[11px] text-slate-900 shadow-sm ${colorClass} ${
        selected ? "ring-2 ring-slate-600" : ""
      }`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!h-1.5 !w-1.5 !bg-slate-700"
      />
      <div className="font-semibold">{label}</div>
      <div className="text-[9px] uppercase text-slate-600">
        Thread {data.threadId} | Seq {data.sequenceIndex}
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className="!h-1.5 !w-1.5 !bg-slate-700"
      />
    </div>
  );
};

export default OperationNode;
