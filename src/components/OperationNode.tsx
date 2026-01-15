import { useMemo } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import { useStore } from "../store/useStore";
import { resolvePointerTargetById } from "../utils/resolvePointers";
import { formatStructMemberName } from "../utils/structMembers";
import type {
  MemoryVariable,
  OperationType,
  TraceNodeData,
} from "../types";

type MetaOperationStyle = {
  backgroundClass: string;
  borderClass: string;
};

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
 * Returns the special styling used by editor-only meta nodes.
 *
 * @param operationType - Canonical operation type for the node.
 * @returns Tailwind class names for meta nodes, or `null` when not a meta node.
 */
const getMetaOperationStyle = (
  operationType: OperationType
): MetaOperationStyle | null => {
  switch (operationType) {
    case "RETRY":
      return {
        backgroundClass: "bg-gradient-to-br from-cyan-200 to-sky-200",
        borderClass: "border-cyan-400",
      };
    case "RETURN_FALSE":
      return {
        backgroundClass: "bg-gradient-to-br from-pink-200 to-fuchsia-200",
        borderClass: "border-pink-400",
      };
    case "RETURN_TRUE":
      return {
        backgroundClass: "bg-gradient-to-br from-lime-200 to-emerald-200",
        borderClass: "border-lime-400",
      };
    default:
      return null;
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
  RETRY: "Retry",
  RETURN_FALSE: "Return False",
  RETURN_TRUE: "Return True",
};

/**
 * Returns the canonical short token used in operation labels for a memory order.
 *
 * @param order - Memory-order string as stored in the session/model config.
 * @returns Canonical short token (e.g. `Acq`, `Rel`, `Rlx`, `Acq_Rel`, `SC`).
 */
const getOrderToken = (order: string) => {
  switch (order) {
    case "Acquire":
      return "Acq";
    case "Release":
      return "Rel";
    case "Relaxed":
      return "Rlx";
    case "Acq_Rel":
      return "Acq_Rel";
    case "SC":
      return "SC";
    case "Standard":
      return "";
    default:
      return order;
  }
};

/**
 * Formats a memory order as a dotted suffix for uniform node labels.
 *
 * Examples:
 * - `Acquire` -> `.Acq`
 * - `Standard`/`undefined` -> ``
 */
const formatOrderSuffix = (order: string | undefined) => {
  if (!order) {
    return "";
  }
  const token = getOrderToken(order);
  return token ? `.${token}` : "";
};

/**
 * Formats a CAS/RMW order pair as a dotted suffix.
 *
 * Example: (`Release`, `Relaxed`) -> `.Rel.Rlx`
 */
const formatCasOrderSuffix = (
  successOrder: string | undefined,
  failureOrder: string | undefined
) => {
  if (!successOrder && !failureOrder) {
    return "";
  }
  const successToken = successOrder ? getOrderToken(successOrder) : "?";
  const failureToken = failureOrder ? getOrderToken(failureOrder) : "?";
  return `.${successToken || "?"}.${failureToken || "?"}`;
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

    /**
     * Meta operations are editor-only control flow helpers that should render as
     * plain labels (not parameterized memory operations).
     */
    if (op.type === "RETRY" || op.type === "RETURN_FALSE" || op.type === "RETURN_TRUE") {
      return opLabels[op.type];
    }

    const opLabel = opLabels[op.type];
    const baseAddressVar = op.addressId ? memoryById.get(op.addressId) : undefined;
    const resolvedAddressVar = op.addressId
      ? resolvePointerTargetById(op.addressId, memoryById).resolved
      : undefined;
    const baseAddressLabel =
      baseAddressVar?.type === "ptr"
        ? formatMemoryLabel(baseAddressVar, memoryById)
        : resolvedAddressVar
          ? formatMemoryLabel(resolvedAddressVar, memoryById)
          : op.address || "";
    const isArrayAddress = resolvedAddressVar?.type === "array";
    const resolvedIndex = op.indexId
      ? formatMemoryLabel(memoryById.get(op.indexId), memoryById)
      : "";
    const indexLabel = resolvedIndex || op.index || "";
    const addressLabel =
      isArrayAddress && baseAddressLabel && indexLabel
        ? `${baseAddressLabel}[${indexLabel}]`
        : baseAddressLabel;
    const memberSuffix = op.memberId
      ? (() => {
          const member = memoryById.get(op.memberId);
          if (!member) {
            return "";
          }
          return `.${formatStructMemberName(member)}`;
        })()
      : "";
    const addressWithMember = addressLabel ? `${addressLabel}${memberSuffix}` : "";
    const baseOrderSuffix = formatOrderSuffix(op.memoryOrder);

    if (op.text) {
      return op.text;
    }

    if (op.type === "FENCE") {
      return `${opLabel}${baseOrderSuffix}`;
    }

    if (op.type === "LOAD") {
      const resolvedResult = op.resultId
        ? formatMemoryLabel(memoryById.get(op.resultId), memoryById)
        : "";
      const resultLabel = resolvedResult || "";
      const address = addressWithMember || addressLabel || "?";
      const expression = `${opLabel}${baseOrderSuffix}(${address})`;
      return resultLabel
        ? `${resultLabel} = ${expression}`
        : expression;
    }

    if (op.type === "STORE") {
      const resolvedValue = op.valueId
        ? formatMemoryLabel(memoryById.get(op.valueId), memoryById)
        : "";
      const valueLabel =
        resolvedValue ||
        (op.value !== undefined ? String(op.value) : "");
      const address = addressWithMember || addressLabel || "?";
      const value = valueLabel || "?";
      return `${opLabel}${baseOrderSuffix}(${address}, ${value})`;
    }

    if (op.type === "RMW") {
      const resolvedResult = op.resultId
        ? formatMemoryLabel(memoryById.get(op.resultId), memoryById)
        : "";
      const resultLabel = resolvedResult || "";
      const address = addressWithMember || addressLabel || "?";
      const expected = op.expectedValueId
        ? formatMemoryLabel(memoryById.get(op.expectedValueId), memoryById)
        : "";
      const desired = op.desiredValueId
        ? formatMemoryLabel(memoryById.get(op.desiredValueId), memoryById)
        : "";
      const casOrderSuffix = formatCasOrderSuffix(
        op.successMemoryOrder,
        op.failureMemoryOrder
      );
      const casValues = `${address}, ${expected || "?"}, ${desired || "?"}`;
      const expression = `CAS${casOrderSuffix}(${casValues})`;

      return resultLabel
        ? `${resultLabel} = ${expression}`
        : expression;
    }

    const address = addressWithMember || addressLabel || "?";
    return `${opLabel}${baseOrderSuffix}(${address})`;
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
  const metaStyle = getMetaOperationStyle(data.operation.type);
  const colorClass = metaStyle
    ? metaStyle.backgroundClass
    : getOrderColorClass(data.operation.memoryOrder);
  const borderClass = metaStyle ? metaStyle.borderClass : "border-slate-400";

  return (
    <div
      style={casBackgroundStyle}
      className={`min-w-[110px] rounded-md border px-2 py-1.5 text-[11px] text-slate-900 shadow-sm ${borderClass} ${colorClass} ${
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
