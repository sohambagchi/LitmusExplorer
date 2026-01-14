import { useCallback, useMemo, type DragEvent } from "react";
import type {
  MemoryOrder,
  MemoryType,
  MemoryVariable,
  OperationType,
  RelationType,
} from "../types";
import { useStore } from "../store/useStore";

type ToolboxItem = {
  label: string;
  type: OperationType;
  nodeType: "operation" | "branch";
};

const TOOLBOX_ITEMS: ToolboxItem[] = [
  { label: "Load", type: "LOAD", nodeType: "operation" },
  { label: "Store", type: "STORE", nodeType: "operation" },
  { label: "Fence", type: "FENCE", nodeType: "operation" },
  { label: "CAS", type: "RMW", nodeType: "operation" },
  { label: "Branch", type: "BRANCH", nodeType: "branch" },
];

const MEMORY_ORDERS: MemoryOrder[] = ["Relaxed", "Acquire", "Release", "SC"];
const MEMORY_ITEMS: { label: string; type: MemoryType }[] = [
  { label: "int", type: "int" },
  { label: "array", type: "array" },
];

const formatMemoryLabel = (
  item: MemoryVariable,
  memoryById: Map<string, MemoryVariable>
) => {
  const name = item.name.trim();
  if (!name) {
    return "";
  }
  if (!item.parentId) {
    return name;
  }
  const parentName = memoryById.get(item.parentId)?.name.trim() || "struct";
  return `${parentName}.${name}`;
};

const Sidebar = () => {
  const setNodes = useStore((state) => state.setNodes);
  const nodes = useStore((state) => state.nodes);
  const edges = useStore((state) => state.edges);
  const threads = useStore((state) => state.threads);
  const memoryEnv = useStore((state) => state.memoryEnv);
  const activeBranch = useStore((state) => state.activeBranch);
  const resetSession = useStore((state) => state.resetSession);
  const selectedMemoryIds = useStore((state) => state.selectedMemoryIds);
  const relationTypeDraft = useStore((state) => state.relationTypeDraft);
  const setRelationTypeDraft = useStore((state) => state.setRelationTypeDraft);
  const groupSelectedIntoStruct = useStore(
    (state) => state.groupSelectedIntoStruct
  );

  const selectedNode = useMemo(
    () => nodes.find((node) => node.selected),
    [nodes]
  );

  const onDragStart = (event: DragEvent<HTMLDivElement>, item: ToolboxItem) => {
    event.dataTransfer.setData("application/reactflow", item.nodeType);
    event.dataTransfer.setData("application/litmus-operation", item.type);
    event.dataTransfer.effectAllowed = "move";
  };

  const updateSelectedOperation = (updates: {
    addressId?: string;
    valueId?: string;
    address?: string;
    value?: string | number;
    memoryOrder?: MemoryOrder;
  }) => {
    if (!selectedNode) {
      return;
    }

    setNodes((current) =>
      current.map((node) => {
        if (node.id !== selectedNode.id) {
          return node;
        }

        const normalizedUpdates = {
          ...updates,
          ...(Object.prototype.hasOwnProperty.call(updates, "addressId")
            ? { address: undefined }
            : null),
          ...(Object.prototype.hasOwnProperty.call(updates, "valueId")
            ? { value: undefined }
            : null),
        };

        return {
          ...node,
          data: {
            ...node.data,
            operation: {
              ...node.data.operation,
              ...normalizedUpdates,
            },
          },
        };
      })
    );
  };

  const handleMemoryDragStart = (
    event: DragEvent<HTMLDivElement>,
    type: MemoryType
  ) => {
    event.dataTransfer.setData("application/litmus-memory", type);
    event.dataTransfer.effectAllowed = "copy";
  };

  const handleExportSession = useCallback(() => {
    const snapshot = {
      nodes,
      edges,
      threads,
      memoryEnv,
      activeBranch,
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "litmus-session.json";
    link.click();
    URL.revokeObjectURL(url);
  }, [activeBranch, edges, memoryEnv, nodes, threads]);

  const selectedMemoryItems = useMemo(
    () =>
      memoryEnv.filter(
        (item) =>
          selectedMemoryIds.includes(item.id) &&
          item.type !== "struct" &&
          !item.parentId
      ),
    [memoryEnv, selectedMemoryIds]
  );
  const canGroupStruct = useMemo(() => {
    if (selectedMemoryItems.length < 2) {
      return false;
    }
    return new Set(selectedMemoryItems.map((item) => item.scope)).size === 1;
  }, [selectedMemoryItems]);

  const memoryOptions = useMemo(() => {
    const memoryById = new Map(memoryEnv.map((item) => [item.id, item]));

    return memoryEnv
      .map((item) => ({
        value: item.id,
        label: formatMemoryLabel(item, memoryById),
      }))
      .filter((option) => option.label);
  }, [memoryEnv]);

  return (
    <aside className="flex h-full w-72 flex-col gap-6 border-r border-slate-200 bg-white p-4 text-sm text-slate-900">
      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Session
        </h2>
        <div className="space-y-2">
          <button
            type="button"
            className="w-full rounded border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-800"
            onClick={resetSession}
          >
            New Session
          </button>
          <button
            type="button"
            className="w-full rounded bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white"
            onClick={handleExportSession}
          >
            Export Session
          </button>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Memory Definition
        </h2>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            {MEMORY_ITEMS.map((item) => (
              <div
                key={item.type}
                className="cursor-grab rounded border border-slate-200 bg-slate-50 px-2 py-2 text-center text-xs font-semibold text-slate-700"
                draggable
                onDragStart={(event) =>
                  handleMemoryDragStart(event, item.type)
                }
              >
                {item.label}
              </div>
            ))}
          </div>
          <button
            type="button"
            className={`w-full rounded px-3 py-1.5 text-xs font-semibold ${
              canGroupStruct
                ? "bg-slate-900 text-white"
                : "bg-slate-200 text-slate-500"
            }`}
            onClick={groupSelectedIntoStruct}
            disabled={!canGroupStruct}
          >
            Struct
          </button>
          <div className="text-xs text-slate-500">
            Drag ints or arrays into Memory sections, then name and value them.
            Select multiple items to enable Struct.
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Relations
        </h2>
        <select
          className="w-full rounded border border-slate-300 px-2 py-1 text-xs"
          value={relationTypeDraft}
          onChange={(event) =>
            setRelationTypeDraft(event.target.value as RelationType)
          }
        >
          <option value="rf">rf (read-from)</option>
          <option value="co">co (coherence)</option>
          <option value="fr">fr (from-read)</option>
          <option value="po">po (program order)</option>
        </select>
        <div className="text-xs text-slate-500">
          New edges use the selected relation type.
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Toolbox
        </h2>
        <div className="grid grid-cols-2 gap-2">
          {TOOLBOX_ITEMS.map((item) => (
            <div
              key={item.type}
              className="cursor-grab rounded border border-slate-200 bg-slate-50 px-2 py-2 text-center text-xs font-semibold text-slate-700"
              draggable
              onDragStart={(event) => onDragStart(event, item)}
            >
              {item.label}
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Properties
        </h2>
        {selectedNode ? (
          <div className="space-y-2">
            <div className="text-xs text-slate-500">
              Node {selectedNode.id}
            </div>
            <select
              className="w-full rounded border border-slate-300 px-2 py-1"
              value={selectedNode.data.operation.addressId ?? ""}
              onChange={(event) =>
                updateSelectedOperation({
                  addressId: event.target.value || undefined,
                })
              }
            >
              <option value="">Address</option>
              {memoryOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <select
              className="w-full rounded border border-slate-300 px-2 py-1"
              value={selectedNode.data.operation.valueId ?? ""}
              onChange={(event) =>
                updateSelectedOperation({
                  valueId: event.target.value || undefined,
                })
              }
            >
              <option value="">Value</option>
              {memoryOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <select
              className="w-full rounded border border-slate-300 px-2 py-1"
              value={selectedNode.data.operation.memoryOrder ?? ""}
              onChange={(event) =>
                updateSelectedOperation({
                  memoryOrder: event.target.value
                    ? (event.target.value as MemoryOrder)
                    : undefined,
                })
              }
            >
              <option value="">Memory Order</option>
              {MEMORY_ORDERS.map((order) => (
                <option key={order} value={order}>
                  {order}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div className="text-xs text-slate-500">
            Select a node to edit its operation fields.
          </div>
        )}
      </section>
    </aside>
  );
};

export default Sidebar;
