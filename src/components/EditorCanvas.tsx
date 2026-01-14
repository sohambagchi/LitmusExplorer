import {
  useCallback,
  useMemo,
  useRef,
  type DragEvent,
  type MouseEvent,
} from "react";
import ReactFlow, {
  addEdge,
  ConnectionLineType,
  Controls,
  MiniMap,
  PanOnScrollMode,
  type Connection,
  type ReactFlowInstance,
} from "reactflow";
import "reactflow/dist/style.css";
import type {
  MemoryScope,
  MemoryType,
  MemoryVariable,
  TraceNode,
} from "../types";
import { useStore } from "../store/useStore";
import BranchNode from "./BranchNode";
import OperationNode from "./OperationNode";
import RelationEdgeComponent from "./RelationEdge";

const LANE_HEIGHT = 120;
const LANE_PADDING = 30;
const GRID_X = 80;
const GRID_Y = 20;

const MEMORY_SECTIONS: { label: string; scope: MemoryScope }[] = [
  { label: "Constants", scope: "constants" },
  { label: "Locals", scope: "locals" },
  { label: "Shared", scope: "shared" },
];

const getLaneY = (index: number) => index * LANE_HEIGHT + LANE_PADDING;

const getLaneIndexFromY = (y: number, threads: string[]) => {
  if (threads.length === 0) {
    return 0;
  }
  const index = Math.round((y - LANE_PADDING) / LANE_HEIGHT);
  return Math.max(0, Math.min(index, threads.length - 1));
};

const getSequenceIndex = (x: number) => Math.max(0, Math.round(x / GRID_X));

const createMemoryId = () =>
  `mem-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const EditorCanvas = () => {
  const nodes = useStore((state) => state.nodes);
  const edges = useStore((state) => state.edges);
  const memoryEnv = useStore((state) => state.memoryEnv);
  const selectedMemoryIds = useStore((state) => state.selectedMemoryIds);
  const relationTypeDraft = useStore((state) => state.relationTypeDraft);
  const threads = useStore((state) => state.threads);
  const activeBranch = useStore((state) => state.activeBranch);
  const setNodes = useStore((state) => state.setNodes);
  const onNodesChange = useStore((state) => state.onNodesChange);
  const onEdgesChange = useStore((state) => state.onEdgesChange);
  const setEdges = useStore((state) => state.setEdges);
  const addMemoryVar = useStore((state) => state.addMemoryVar);
  const updateMemoryVar = useStore((state) => state.updateMemoryVar);
  const toggleMemorySelection = useStore(
    (state) => state.toggleMemorySelection
  );
  const reactFlowInstance = useRef<ReactFlowInstance | null>(null);
  const idCounter = useRef(1);

  const nodeTypes = useMemo(
    () => ({ operation: OperationNode, branch: BranchNode }),
    []
  );
  const edgeTypes = useMemo(() => ({ relation: RelationEdgeComponent }), []);

  const visibleNodes = useMemo(() => {
    if (!activeBranch) {
      return nodes;
    }

    return nodes.filter((node) => {
      if (!node.data.branchId) {
        return true;
      }

      if (node.data.branchId !== activeBranch.branchId) {
        return true;
      }

      return node.data.branchPath === activeBranch.path;
    });
  }, [activeBranch, nodes]);

  const visibleNodeIds = useMemo(
    () => new Set(visibleNodes.map((node) => node.id)),
    [visibleNodes]
  );

  const relationEdges = useMemo(
    () =>
      edges.map((edge) => ({
        ...edge,
        type: edge.type ?? "relation",
        data: { relationType: "rf", ...(edge.data ?? {}) },
      })),
    [edges]
  );
  const edgesToRender = useMemo(
    () =>
      relationEdges.filter(
        (edge) =>
          visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)
      ),
    [relationEdges, visibleNodeIds]
  );

  const laneBackground = useMemo(() => {
    const laneStripes = `repeating-linear-gradient(0deg, #f8fafc 0px, #f8fafc ${LANE_HEIGHT}px, #e2e8f0 ${LANE_HEIGHT}px, #e2e8f0 ${
      LANE_HEIGHT * 2
    }px)`;
    const verticalGrid = `repeating-linear-gradient(90deg, transparent 0px, transparent ${
      GRID_X - 1
    }px, rgba(148, 163, 184, 0.35) ${GRID_X - 1}px, rgba(148, 163, 184, 0.35) ${GRID_X}px)`;

    return `${verticalGrid}, ${laneStripes}`;
  }, []);

  const handleMemoryDragOver = useCallback((event: DragEvent) => {
    if (event.dataTransfer.types.includes("application/litmus-memory")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const handleMemoryDrop = useCallback(
    (event: DragEvent<HTMLDivElement>, scope: MemoryScope) => {
      event.preventDefault();
      const memoryType = event.dataTransfer.getData(
        "application/litmus-memory"
      ) as MemoryType;

      if (!memoryType) {
        return;
      }

      addMemoryVar({
        id: createMemoryId(),
        name: "",
        type: memoryType,
        scope,
        value: "",
      });
    },
    [addMemoryVar]
  );

  const handleNodeDrag = useCallback(
    (_event: MouseEvent, node: TraceNode) => {
      const laneIndex = getLaneIndexFromY(node.position.y, threads);
      const threadId = threads[laneIndex] ?? node.data.threadId;
      setNodes((current) =>
        current.map((currentNode) => {
          if (currentNode.id !== node.id) {
            return currentNode;
          }

          return {
            ...currentNode,
            position: {
              x: node.position.x,
              // Keep nodes locked to their thread lane while dragging.
              y: getLaneY(laneIndex),
            },
            data: {
              ...currentNode.data,
              threadId,
            },
          };
        })
      );
    },
    [setNodes, threads]
  );

  const handleNodeDragStop = useCallback(
    (_event: MouseEvent, node: TraceNode) => {
      const laneIndex = getLaneIndexFromY(node.position.y, threads);
      const threadId = threads[laneIndex] ?? node.data.threadId;
      setNodes((current) =>
        current.map((currentNode) => {
          if (currentNode.id !== node.id) {
            return currentNode;
          }

          const sequenceIndex = getSequenceIndex(node.position.x);

          return {
            ...currentNode,
            position: {
              x: sequenceIndex * GRID_X,
              y: getLaneY(laneIndex),
            },
            data: {
              ...currentNode.data,
              sequenceIndex,
              threadId,
            },
          };
        })
      );
    },
    [setNodes, threads]
  );

  const handleDragOver = useCallback((event: DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const nodeType = event.dataTransfer.getData("application/reactflow");
      const operationType = event.dataTransfer.getData(
        "application/litmus-operation"
      );

      if (!nodeType || !operationType) {
        return;
      }

      const bounds = event.currentTarget.getBoundingClientRect();
      const flow = reactFlowInstance.current;
      if (!flow) {
        return;
      }
      const position = flow.project({
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      });

      const laneIndex = getLaneIndexFromY(position.y, threads);
      const threadId = threads[laneIndex] ?? "T1";
      const sequenceIndex = getSequenceIndex(position.x);

      const newNode: TraceNode = {
        id: `node-${idCounter.current++}`,
        type: nodeType as "operation" | "branch",
        position: {
          x: sequenceIndex * GRID_X,
          y: getLaneY(laneIndex),
        },
        data: {
          threadId,
          sequenceIndex,
          operation: {
            type: operationType as TraceNode["data"]["operation"]["type"],
          },
        },
      };

      setNodes((current) => [...current, newNode]);
    },
    [setNodes, threads]
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) {
        return;
      }
      const edgeId = `edge-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      setEdges((current) =>
        addEdge(
          {
            ...connection,
            id: edgeId,
            type: "relation",
            data: { relationType: relationTypeDraft },
          },
          current
        )
      );
    },
    [relationTypeDraft, setEdges]
  );

  const renderMemoryAtom = (item: MemoryVariable, nested: boolean) => {
    const isSelected = selectedMemoryIds.includes(item.id);

    return (
      <div
        key={item.id}
        className={`rounded border ${
          nested
            ? "border-slate-200 bg-white px-2 py-1"
            : `border-slate-300 bg-slate-50 px-2 py-2 ${
                isSelected ? "ring-1 ring-slate-900" : ""
              }`
        }`}
      >
        <div className="flex items-center gap-2">
          {!nested ? (
            <input
              type="checkbox"
              className="mt-0.5"
              checked={isSelected}
              onChange={() => toggleMemorySelection(item.id)}
            />
          ) : null}
          <div className="rounded bg-slate-900 px-1 py-0.5 text-[9px] font-semibold uppercase text-white">
            {item.type}
          </div>
          <input
            className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1 text-xs"
            placeholder="name"
            value={item.name}
            onChange={(event) =>
              updateMemoryVar(item.id, { name: event.target.value })
            }
          />
          <input
            className="w-24 rounded border border-slate-300 px-2 py-1 text-xs"
            placeholder="value"
            value={item.value ?? ""}
            onChange={(event) =>
              updateMemoryVar(item.id, { value: event.target.value })
            }
          />
        </div>
      </div>
    );
  };

  const renderMemoryStruct = (item: MemoryVariable) => {
    const members = memoryEnv.filter((member) => member.parentId === item.id);

    return (
      <div
        key={item.id}
        className="rounded border border-slate-300 bg-white px-2 py-2"
      >
        <div className="flex items-center gap-2">
          <div className="rounded bg-slate-900 px-1 py-0.5 text-[9px] font-semibold uppercase text-white">
            struct
          </div>
          <input
            className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1 text-xs"
            placeholder="struct name"
            value={item.name}
            onChange={(event) =>
              updateMemoryVar(item.id, { name: event.target.value })
            }
          />
        </div>
        <div className="mt-2 space-y-1">
          {members.length > 0 ? (
            members.map((member) => renderMemoryAtom(member, true))
          ) : (
            <div className="text-xs text-slate-500">
              No members in this struct.
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="flex h-full w-full flex-col">
      <div className="border-b border-slate-200 bg-white px-4 py-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Memory
        </div>
        <div className="mt-3 grid grid-cols-3 gap-3">
          {MEMORY_SECTIONS.map((section) => {
            const sectionItems = memoryEnv.filter(
              (item) => item.scope === section.scope && !item.parentId
            );

            return (
              <div
                key={section.scope}
                className="rounded border border-slate-200 bg-slate-50 p-2"
                onDrop={(event) => handleMemoryDrop(event, section.scope)}
                onDragOver={handleMemoryDragOver}
              >
                <div className="mb-2 text-[11px] font-semibold uppercase text-slate-500">
                  {section.label}
                </div>
                <div className="space-y-2">
                  {sectionItems.length > 0 ? (
                    sectionItems.map((item) =>
                      item.type === "struct"
                        ? renderMemoryStruct(item)
                        : renderMemoryAtom(item, false)
                    )
                  ) : (
                    <div className="rounded border border-dashed border-slate-300 px-2 py-3 text-center text-xs text-slate-400">
                      Drop int or array here
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="min-h-0 flex-1" style={{ backgroundImage: laneBackground }}>
        <ReactFlow
          nodes={visibleNodes}
          edges={edgesToRender}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          connectionLineType={ConnectionLineType.Straight}
          panOnScroll
          panOnScrollMode={PanOnScrollMode.Horizontal}
          panOnDrag={false}
          zoomOnScroll={false}
          snapToGrid
          snapGrid={[GRID_X, GRID_Y]}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDrag={handleNodeDrag}
          onNodeDragStop={handleNodeDragStop}
          onConnect={handleConnect}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onInit={(instance) => {
            reactFlowInstance.current = instance;
          }}
          fitView
        >
          <Controls />
          <MiniMap />
        </ReactFlow>
      </div>
    </div>
  );
};

export default EditorCanvas;
