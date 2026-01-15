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

/**
 * Returns a stable hex color for a memory-order label.
 * Used for CAS/RMW nodes where we split the background into two halves.
 */
const getOrderColorHex = (order: string | undefined) => {
  switch (order) {
    case "Acquire":
      return "#fecaca"; // tailwind red-200
    case "Release":
      return "#bfdbfe"; // tailwind blue-200
    case "Relaxed":
      return "#a7f3d0"; // tailwind emerald-200
    case "Acq_Rel":
      return "#e9d5ff"; // tailwind purple-200
    case "SC":
      return "#fde68a"; // tailwind amber-200
    case "Standard":
      return "#e2e8f0"; // tailwind slate-200
    default:
      return "#e2e8f0"; // tailwind slate-200
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
    const baseAddressLabel = resolvedAddress || op.address || "";
    const isArrayAddress = op.addressId
      ? memoryById.get(op.addressId)?.type === "array"
      : false;
    const resolvedIndex = op.indexId
      ? formatMemoryLabel(memoryById.get(op.indexId), memoryById)
      : "";
    const indexLabel = resolvedIndex || op.index || "";
    const addressLabel =
      isArrayAddress && baseAddressLabel && indexLabel
        ? `${baseAddressLabel}[${indexLabel}]`
        : baseAddressLabel;
    const baseOrder = op.memoryOrder ? ` (${getOrderShort(op.memoryOrder)})` : "";

    if (op.text) {
      return op.text;
    }

    if (op.type === "FENCE") {
      return `${opLabel}${baseOrder}`;
    }

    if (op.type === "LOAD") {
      const address = addressLabel ? ` ${addressLabel}` : "";
      const resolvedResult = op.resultId
        ? formatMemoryLabel(memoryById.get(op.resultId), memoryById)
        : "";
      const resultLabel = resolvedResult || "";
      return resultLabel
        ? `${resultLabel} = ${opLabel}${address}${baseOrder}`
        : `${opLabel}${address}${baseOrder}`;
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
      const resolvedResult = op.resultId
        ? formatMemoryLabel(memoryById.get(op.resultId), memoryById)
        : "";
      const resultLabel = resolvedResult || "";
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

      return resultLabel
        ? `${resultLabel} = CAS${address}${casValues}${casOrders}`
        : `CAS${address}${casValues}${casOrders}`;
    }

    const address = addressLabel ? ` ${addressLabel}` : "";
    return `${opLabel}${address}${baseOrder}`;
  }, [data.operation, memoryById]);

  const casBackgroundStyle =
    data.operation.type === "RMW"
      ? {
          backgroundImage: `linear-gradient(90deg, ${getOrderColorHex(
            data.operation.successMemoryOrder
          )} 0%, ${getOrderColorHex(
            data.operation.successMemoryOrder
          )} 50%, ${getOrderColorHex(
            data.operation.failureMemoryOrder
          )} 50%, ${getOrderColorHex(data.operation.failureMemoryOrder)} 100%)`,
        }
      : undefined;
  const colorClass = getOrderColorClass(data.operation.memoryOrder);

  return (
    <div
      style={casBackgroundStyle}
      className={`min-w-[110px] rounded-md border border-slate-400 px-2 py-1.5 text-[11px] text-slate-900 shadow-sm ${colorClass} ${
        selected ? "ring-2 ring-slate-600" : ""
      }`}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!h-1.5 !w-1.5 !bg-slate-700"
      />
      <div className="font-semibold">{label}</div>
      <div className="text-[9px] uppercase text-slate-600">
        Thread {data.threadId} | Seq {data.sequenceIndex}
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        className="!h-1.5 !w-1.5 !bg-slate-700"
      />
    </div>
  );
};

export default OperationNode;
