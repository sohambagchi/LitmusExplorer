import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
  type WheelEvent,
} from "react";
import ReactFlow, {
  addEdge,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  ConnectionLineType,
  type NodeChange,
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
import { createBranchGroupCondition } from "../utils/branchConditionFactory";
import { evaluateBranchCondition } from "../utils/branchEvaluation";
import ConfirmDialog from "./ConfirmDialog";

const LANE_HEIGHT = 120;
const LANE_LABEL_WIDTH = 64;
const GRID_X = 80;
const MIN_SEQUENCE_INDEX = 1;
const MAX_CANVAS_X = 200_000;
const PAN_SPEED = 1;

const MEMORY_SECTIONS: { label: string; scope: MemoryScope }[] = [
  { label: "Constants", scope: "constants" },
  { label: "Locals", scope: "locals" },
  { label: "Shared", scope: "shared" },
];

const getLaneY = (index: number) => index * LANE_HEIGHT + LANE_HEIGHT / 2;

const getLaneIndexFromY = (y: number, laneCount: number) => {
  if (laneCount <= 0) {
    return 0;
  }
  const index = Math.floor(y / LANE_HEIGHT);
  return Math.max(0, Math.min(index, laneCount - 1));
};

const getSequenceIndex = (x: number) =>
  Math.max(MIN_SEQUENCE_INDEX, Math.round(x / GRID_X));

const getSequenceX = (sequenceIndex: number) => sequenceIndex * GRID_X;

const createMemoryId = () =>
  `mem-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const getThreadsForLayout = (threads: string[], nodes: TraceNode[]) => {
  const orderedThreads = threads.length > 0 ? threads : ["T0"];
  const threadSet = new Set(orderedThreads);
  const merged = [...orderedThreads];

  for (const node of nodes) {
    const threadId = node.data.threadId;
    if (!threadSet.has(threadId)) {
      threadSet.add(threadId);
      merged.push(threadId);
    }
  }

  return merged;
};

const LaneOverlay = ({
  threads,
  nextThreadId,
  nodeCountsByThread,
  onRequestDeleteThread,
}: {
  threads: string[];
  nextThreadId: string;
  nodeCountsByThread: Map<string, number>;
  onRequestDeleteThread: (threadId: string) => void;
}) => (
  <div className="pointer-events-none absolute inset-0 z-0">
    {threads.map((threadId, index) => (
      <div
        key={`${threadId}-${index}`}
        className={`relative border-b border-slate-200 ${
          index % 2 === 0 ? "bg-white" : "bg-slate-50"
        }`}
        style={{ height: LANE_HEIGHT }}
      >
        <div
          className="absolute inset-y-0 left-0 flex items-center justify-center border-r border-slate-200 bg-slate-100/85"
          style={{ width: LANE_LABEL_WIDTH }}
        >
          <div className="pointer-events-auto flex items-center gap-1 rounded bg-slate-900 px-2 py-1 text-[10px] font-semibold text-white">
            <span>{threadId}</span>
            <button
              type="button"
              className="rounded bg-white/10 px-1 py-0.5 text-[10px] font-semibold text-white hover:bg-white/20"
              onMouseDown={(event) => {
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.stopPropagation();
                onRequestDeleteThread(threadId);
              }}
              title={`Delete ${threadId} (${nodeCountsByThread.get(threadId) ?? 0} nodes)`}
              aria-label={`Delete ${threadId}`}
            >
              ✕
            </button>
          </div>
        </div>
      </div>
    ))}
    <div
      className="relative border-b border-dashed border-slate-300 bg-slate-200/40"
      style={{ height: LANE_HEIGHT }}
    >
      <div
        className="absolute inset-y-0 left-0 flex flex-col items-center justify-center gap-1 border-r border-dashed border-slate-300 bg-slate-100/85"
        style={{ width: LANE_LABEL_WIDTH }}
      >
        <div className="rounded bg-slate-700/80 px-2 py-1 text-[10px] font-semibold text-white/90">
          {nextThreadId}
        </div>
        <div className="text-[10px] font-medium text-slate-500">
          Drop to add
        </div>
      </div>
    </div>
  </div>
);

const EditorCanvas = () => {
  const nodes = useStore((state) => state.nodes);
  const edges = useStore((state) => state.edges);
  const memoryEnv = useStore((state) => state.memoryEnv);
  const selectedMemoryIds = useStore((state) => state.selectedMemoryIds);
  const threads = useStore((state) => state.threads);
  const setNodes = useStore((state) => state.setNodes);
  const onEdgesChange = useStore((state) => state.onEdgesChange);
  const setEdges = useStore((state) => state.setEdges);
  const addThread = useStore((state) => state.addThread);
  const deleteThread = useStore((state) => state.deleteThread);
  const addMemoryVar = useStore((state) => state.addMemoryVar);
  const updateMemoryVar = useStore((state) => state.updateMemoryVar);
  const validateGraph = useStore((state) => state.validateGraph);
  const toggleMemorySelection = useStore(
    (state) => state.toggleMemorySelection
  );
  const reactFlowInstance = useRef<ReactFlowInstance | null>(null);
  const idCounter = useRef(1);
  const [isLocked, setIsLocked] = useState(false);
  const [pendingThreadDelete, setPendingThreadDelete] = useState<{
    threadId: string;
    nodeCount: number;
  } | null>(null);

  const nodeTypes = useMemo(
    () => ({ operation: OperationNode, branch: BranchNode }),
    []
  );
  const edgeTypes = useMemo(() => ({ relation: RelationEdgeComponent }), []);

  const visibleNodes = useMemo(() => {
    const nodesById = new Map(nodes.map((node) => [node.id, node]));

    const poOutgoing = new Map<string, string[]>();
    for (const edge of edges) {
      const relationType = edge.data?.relationType ?? "po";
      if (relationType !== "po") {
        continue;
      }
      const current = poOutgoing.get(edge.source) ?? [];
      current.push(edge.target);
      poOutgoing.set(edge.source, current);
    }

    const followPo = (startIds: string[], bucket: Set<string>) => {
      const queue = [...startIds];
      while (queue.length > 0) {
        const nextId = queue.shift();
        if (!nextId || bucket.has(nextId) || !nodesById.has(nextId)) {
          continue;
        }
        bucket.add(nextId);
        const outgoing = poOutgoing.get(nextId) ?? [];
        for (const targetId of outgoing) {
          if (!bucket.has(targetId)) {
            queue.push(targetId);
          }
        }
      }
    };

    const hidden = new Set<string>();
    const branchNodes = nodes.filter(
      (node) => node.data.operation.type === "BRANCH"
    );

    for (const branchNode of branchNodes) {
      if (branchNode.data.operation.branchShowBothFutures) {
        continue;
      }
      const branchId = branchNode.id;
      const condition = branchNode.data.operation.branchCondition;
      if (!condition) {
        continue;
      }

      const thenSet = new Set<string>();
      const elseSet = new Set<string>();

      for (const node of nodes) {
        if (node.data.branchId !== branchId) {
          continue;
        }
        if (node.data.branchPath === "then") {
          thenSet.add(node.id);
        } else if (node.data.branchPath === "else") {
          elseSet.add(node.id);
        }
      }

      const thenStarts = edges
        .filter((edge) => edge.source === branchId && edge.sourceHandle === "then")
        .map((edge) => edge.target);
      const elseStarts = edges
        .filter((edge) => edge.source === branchId && edge.sourceHandle === "else")
        .map((edge) => edge.target);
      followPo(thenStarts, thenSet);
      followPo(elseStarts, elseSet);

      if (thenSet.size === 0 && elseSet.size === 0) {
        continue;
      }

      const thenExclusive = new Set(
        [...thenSet].filter((nodeId) => !elseSet.has(nodeId))
      );
      const elseExclusive = new Set(
        [...elseSet].filter((nodeId) => !thenSet.has(nodeId))
      );

      const outcome = evaluateBranchCondition(condition, memoryEnv);
      const toHide = outcome ? elseExclusive : thenExclusive;
      for (const nodeId of toHide) {
        hidden.add(nodeId);
      }
    }

    return nodes.filter((node) => !hidden.has(node.id));
  }, [edges, memoryEnv, nodes]);

  const visibleNodeIds = useMemo(
    () => new Set(visibleNodes.map((node) => node.id)),
    [visibleNodes]
  );

  const relationEdges = useMemo(
    () =>
      edges.map((edge) => ({
        ...edge,
        type: edge.type ?? "relation",
        data: { relationType: "po", ...(edge.data ?? {}) },
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

  const threadsForLayout = useMemo(
    () => getThreadsForLayout(threads, nodes),
    [nodes, threads]
  );

  const nodeCountsByThread = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of nodes) {
      counts.set(node.data.threadId, (counts.get(node.data.threadId) ?? 0) + 1);
    }
    for (const threadId of threadsForLayout) {
      if (!counts.has(threadId)) {
        counts.set(threadId, 0);
      }
    }
    return counts;
  }, [nodes, threadsForLayout]);

  const requestDeleteThread = useCallback(
    (threadId: string) => {
      const nodeCount = nodeCountsByThread.get(threadId) ?? 0;
      setPendingThreadDelete({ threadId, nodeCount });
    },
    [nodeCountsByThread]
  );

  const nextThreadId = useMemo(() => {
    const numericIds = threadsForLayout
      .map((threadId) => {
        const match = /^T(\d+)$/.exec(threadId);
        return match ? Number(match[1]) : null;
      })
      .filter((value): value is number => value !== null && !Number.isNaN(value));

    const maxIndex = numericIds.length > 0 ? Math.max(...numericIds) : -1;
    return `T${maxIndex + 1}`;
  }, [threadsForLayout]);

  const displayLaneCount = useMemo(
    () => threadsForLayout.length + 1,
    [threadsForLayout.length]
  );

  const canvasHeight = useMemo(
    () => Math.max(1, displayLaneCount) * LANE_HEIGHT,
    [displayLaneCount]
  );

  const translateExtent = useMemo<[[number, number], [number, number]]>(
    () => [
      [0, 0],
      [MAX_CANVAS_X, canvasHeight],
    ],
    [canvasHeight]
  );

  const handleWheelPan = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      const flow = reactFlowInstance.current;
      if (!flow) {
        return;
      }

      if (event.ctrlKey || event.metaKey) {
        return;
      }

      if (event.shiftKey) {
        return;
      }

      event.preventDefault();

      const viewport = flow.getViewport();
      const delta =
        Math.abs(event.deltaX) > Math.abs(event.deltaY)
          ? event.deltaX
          : event.deltaY;

      flow.setViewport({
        ...viewport,
        x: Math.min(0, viewport.x - delta * PAN_SPEED),
      });
    },
    []
  );

  const handleZoom = useCallback((delta: number) => {
    const flow = reactFlowInstance.current;
    if (!flow) {
      return;
    }
    const viewport = flow.getViewport();
    const nextZoom = Math.max(0.2, Math.min(2, viewport.zoom + delta));
    flow.setViewport({ ...viewport, zoom: nextZoom });
  }, []);

  const handleFitView = useCallback(() => {
    reactFlowInstance.current?.fitView();
  }, []);

  const handleAddThread = useCallback(() => {
    addThread();
  }, [addThread]);

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setNodes((current) => {
        const next = applyNodeChanges(changes, current);
        const yOverrides = new Map<string, number>();

        for (const change of changes) {
          if (change.type !== "position" || typeof change.position === "undefined") {
            continue;
          }
          const laneIndex = getLaneIndexFromY(change.position.y, displayLaneCount);
          yOverrides.set(change.id, getLaneY(laneIndex));
        }

        if (yOverrides.size === 0) {
          return next;
        }

        return next.map((node) => {
          const y = yOverrides.get(node.id);
          if (typeof y === "undefined") {
            return node;
          }
          return {
            ...node,
            position: {
              ...node.position,
              y,
            },
          };
        });
      });
    },
    [displayLaneCount, setNodes]
  );

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

      const id = createMemoryId();

      if (memoryType === "int") {
        addMemoryVar({
          id,
          name: "",
          type: "int",
          scope,
          value: "",
        });
        return;
      }

      if (memoryType === "array") {
        addMemoryVar({
          id,
          name: "",
          type: "array",
          scope,
        });
      }
    },
    [addMemoryVar]
  );

  const handleNodeDragStop = useCallback(
    (_event: MouseEvent, node: TraceNode) => {
      const laneIndex = getLaneIndexFromY(node.position.y, displayLaneCount);
      const isAddLane = laneIndex >= threadsForLayout.length;
      const threadId = isAddLane
        ? addThread()
        : (threadsForLayout[laneIndex] ?? node.data.threadId);
      setNodes((current) =>
        current.map((currentNode) => {
          if (currentNode.id !== node.id) {
            return currentNode;
          }

          const sequenceIndex = getSequenceIndex(node.position.x);

          return {
            ...currentNode,
            position: {
              x: getSequenceX(sequenceIndex),
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
    [addThread, displayLaneCount, setNodes, threadsForLayout]
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

      const laneIndex = getLaneIndexFromY(position.y, displayLaneCount);
      const isAddLane = laneIndex >= threadsForLayout.length;
      const threadId = isAddLane
        ? addThread()
        : (threadsForLayout[laneIndex] ?? "T0");
      const sequenceIndex = getSequenceIndex(position.x);

      const newNode: TraceNode = {
        id: `node-${idCounter.current++}`,
        type: nodeType as "operation" | "branch",
        position: {
          x: getSequenceX(sequenceIndex),
          y: getLaneY(laneIndex),
        },
        data: {
          threadId,
          sequenceIndex,
          operation: {
            type: operationType as TraceNode["data"]["operation"]["type"],
            ...(operationType === "BRANCH"
              ? { branchCondition: createBranchGroupCondition() }
              : null),
          },
        },
      };

      setNodes((current) => [...current, newNode]);
    },
    [addThread, displayLaneCount, setNodes, threadsForLayout]
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
            data: { relationType: "po" },
          },
          current
        )
      );
      validateGraph();
    },
    [setEdges, validateGraph]
  );

  useEffect(() => {
    if (nodes.length === 0) {
      return;
    }

    const laneByThread = new Map(
      threadsForLayout.map((threadId, index) => [threadId, index] as const)
    );

    let didChange = false;
    const normalized = nodes.map((node) => {
      const laneIndex = laneByThread.get(node.data.threadId) ?? 0;
      const nextY = getLaneY(laneIndex);
      if (node.position.y === nextY) {
        return node;
      }
      didChange = true;
      return {
        ...node,
        position: {
          ...node.position,
          y: nextY,
        },
      };
    });

    if (didChange) {
      setNodes(normalized);
    }
  }, [nodes.length, setNodes, threadsForLayout]);

  const renderMemoryAtom = (item: MemoryVariable, nested: boolean) => {
    if (item.type === "struct") {
      return null;
    }
    const isSelected = selectedMemoryIds.includes(item.id);
    const isArray = item.type === "array";

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
          {isArray ? (
            <input
              type="number"
              min={0}
              className="w-24 rounded border border-slate-300 px-2 py-1 text-xs"
              placeholder="size"
              value={item.size ?? ""}
              onChange={(event) => {
                const parsed =
                  event.target.value === "" ? undefined : Number(event.target.value);
                updateMemoryVar(item.id, {
                  size: typeof parsed === "number" && !Number.isNaN(parsed) ? parsed : undefined,
                });
              }}
            />
          ) : (
            <input
              className="w-24 rounded border border-slate-300 px-2 py-1 text-xs"
              placeholder="value"
              value={item.value ?? ""}
              onChange={(event) =>
                updateMemoryVar(item.id, { value: event.target.value })
              }
            />
          )}
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
      <div className="flex min-h-0 flex-1 flex-col bg-slate-100">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div
            className="relative w-full"
            style={{ height: canvasHeight }}
            onWheelCapture={handleWheelPan}
          >
            <LaneOverlay
              threads={threadsForLayout}
              nextThreadId={nextThreadId}
              nodeCountsByThread={nodeCountsByThread}
              onRequestDeleteThread={requestDeleteThread}
            />
            <ReactFlow
              nodes={visibleNodes}
              edges={edgesToRender}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              nodeOrigin={[0, 0.5]}
              connectionLineType={ConnectionLineType.Step}
              panOnDrag={false}
              zoomOnScroll={false}
              translateExtent={translateExtent}
              nodeExtent={translateExtent}
              snapToGrid={false}
              nodesDraggable={!isLocked}
              nodesConnectable={!isLocked}
              onNodesChange={handleNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeDragStop={handleNodeDragStop}
              onConnect={handleConnect}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onInit={(instance) => {
                reactFlowInstance.current = instance;
              }}
              deleteKeyCode={["Backspace", "Delete"]}
              className="relative z-10"
              style={{
                width: "100%",
                height: "100%",
                background: "transparent",
              }}
            >
              <Background
                id="timeline-grid"
                gap={[GRID_X, LANE_HEIGHT]}
                color="rgba(148, 163, 184, 0.35)"
                variant={BackgroundVariant.Lines}
              />
            </ReactFlow>
            <ConfirmDialog
              open={pendingThreadDelete !== null}
              title={
                pendingThreadDelete
                  ? `Delete ${pendingThreadDelete.threadId}?`
                  : "Delete thread?"
              }
              description={
                pendingThreadDelete
                  ? pendingThreadDelete.nodeCount > 0
                    ? `This will delete ${pendingThreadDelete.nodeCount} node(s) and all connected edges.`
                    : "This thread is empty."
                  : undefined
              }
              confirmLabel="Delete"
              cancelLabel="Cancel"
              tone="danger"
              onCancel={() => setPendingThreadDelete(null)}
              onConfirm={() => {
                if (!pendingThreadDelete) {
                  return;
                }
                deleteThread(pendingThreadDelete.threadId);
                setPendingThreadDelete(null);
              }}
            />
          </div>
        </div>
        <div className="flex items-center justify-between border-t border-slate-200 bg-white px-3 py-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-700"
              onClick={handleAddThread}
            >
              + Thread
            </button>
            <button
              type="button"
              aria-label="Zoom out"
              className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-sm font-semibold leading-none text-slate-700"
              onClick={() => handleZoom(-0.1)}
            >
              -
            </button>
            <button
              type="button"
              aria-label="Zoom in"
              className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-sm font-semibold leading-none text-slate-700"
              onClick={() => handleZoom(0.1)}
            >
              +
            </button>
            <button
              type="button"
              className="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-700"
              onClick={handleFitView}
            >
              Fit
            </button>
          </div>
          <button
            type="button"
            className={`rounded px-2 py-1 text-xs font-semibold ${
              isLocked
                ? "bg-slate-900 text-white"
                : "border border-slate-200 bg-white text-slate-700"
            }`}
            onClick={() => setIsLocked((current) => !current)}
          >
            {isLocked ? "Locked" : "Unlocked"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default EditorCanvas;
