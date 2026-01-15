import { useMemo } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import { useStore } from "../store/useStore";
import type {
  MemoryVariable,
  OperationType,
  TraceNodeData,
} from "../types";

const getOrderColorClass = (order: string | undefined) => {
  switch (order) {
    case "Acquire":
      return "bg-red-200";
    case "Release":
      return "bg-blue-200";
    case "Relaxed":
      return "bg-emerald-200";
    case "Acq_Rel":
      return "bg-purple-200";
    case "SC":
      return "bg-amber-200";
    case "Standard":
      return "bg-slate-200";
    default:
      return "bg-slate-200";
  }
};

const opLabels: Record<OperationType, string> = {
  LOAD: "LD",
  STORE: "ST",
  RMW: "RMW",
  FENCE: "FENCE",
  BRANCH: "BR",
};

const getOrderShort = (order: string) => {
  switch (order) {
    case "Acquire":
      return "Acq";
    case "Release":
      return "Rel";
    case "Relaxed":
      return "Rlx";
    case "Acq_Rel":
      return "AcqRel";
    case "SC":
      return "SC";
    case "Standard":
      return "Std";
    default:
      return order;
  }
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
  const label = useMemo(() => {
    const op = data.operation;
    const opLabel = opLabels[op.type];
    const resolvedAddress = op.addressId
      ? formatMemoryLabel(memoryById.get(op.addressId), memoryById)
      : "";
    const addressLabel = resolvedAddress || op.address || "";
    const baseOrder = op.memoryOrder ? ` (${getOrderShort(op.memoryOrder)})` : "";

    if (op.text) {
      return op.text;
    }

    if (op.type === "FENCE") {
      return `${opLabel}${baseOrder}`;
    }

    if (op.type === "LOAD") {
      const address = addressLabel ? ` ${addressLabel}` : "";
      return `${opLabel}${address}${baseOrder}`;
    }

    if (op.type === "STORE") {
      const address = addressLabel ? ` ${addressLabel}` : "";
      const resolvedValue = op.valueId
        ? formatMemoryLabel(memoryById.get(op.valueId), memoryById)
        : "";
      const valueLabel =
        resolvedValue ||
        (op.value !== undefined ? String(op.value) : "");
      const value = valueLabel ? ` = ${valueLabel}` : "";
      return `${opLabel}${address}${value}${baseOrder}`;
    }

    if (op.type === "RMW") {
      const address = addressLabel ? ` ${addressLabel}` : "";
      const expected = op.expectedValueId
        ? formatMemoryLabel(memoryById.get(op.expectedValueId), memoryById)
        : "";
      const desired = op.desiredValueId
        ? formatMemoryLabel(memoryById.get(op.desiredValueId), memoryById)
        : "";
      const casValues =
        expected || desired ? ` (${expected || "?"}→${desired || "?"})` : "";
      const successOrder = op.successMemoryOrder
        ? getOrderShort(op.successMemoryOrder)
        : "";
      const failureOrder = op.failureMemoryOrder
        ? getOrderShort(op.failureMemoryOrder)
        : "";
      const casOrders =
        successOrder || failureOrder
          ? ` [${successOrder || "?"}/${failureOrder || "?"}]`
          : "";

      return `CAS${address}${casValues}${casOrders}`;
    }

    const address = addressLabel ? ` ${addressLabel}` : "";
    return `${opLabel}${address}${baseOrder}`;
  }, [data.operation, memoryById]);

  const colorClass = getOrderColorClass(data.operation.memoryOrder);

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
