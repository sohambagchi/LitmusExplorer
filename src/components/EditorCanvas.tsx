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
  MarkerType,
  type NodeChange,
  type Connection,
  type ReactFlowInstance,
} from "reactflow";
import "reactflow/dist/style.css";
import type {
  ArrayElementType,
  BranchCondition,
  MemoryScope,
  MemoryType,
  MemoryVariable,
  RelationEdge,
  TraceNode,
} from "../types";
import { useStore } from "../store/useStore";
import BranchNode from "./BranchNode";
import OperationNode from "./OperationNode";
import RelationEdgeComponent from "./RelationEdge";
import { createBranchGroupCondition } from "../utils/branchConditionFactory";
import { evaluateBranchCondition } from "../utils/branchEvaluation";
import ConfirmDialog from "./ConfirmDialog";
import { exportReactFlowViewportToPng } from "../utils/exportReactFlowPng";
import { Trash2 } from "lucide-react";
import { createUuid } from "../utils/createUuid";
import { resolvePointerTargetById } from "../utils/resolvePointers";

const LANE_WIDTH = 260;
const LANE_LABEL_HEIGHT = 80;
const GRID_Y = 80;
// Keep the header row clear of the first operation row (seq 1 renders at `GRID_Y`).
// Shift the React Flow content down so edges/nodes don't render underneath the
// header overlay, with a bit of extra clearance for orthogonal edge turns.
const CANVAS_HEADER_CLEARANCE = 20;
const CANVAS_CONTENT_TOP_OFFSET = Math.max(
  0,
  LANE_LABEL_HEIGHT - GRID_Y + CANVAS_HEADER_CLEARANCE
);
const MIN_SEQUENCE_INDEX = 1;
const MAX_CANVAS_Y = 200_000;
const PAN_SPEED = 1;
const CANVAS_NODE_ORIGIN: [number, number] = [0.5, 0];

const DEFAULT_EDGE_ARROW_COLOR = "#0f172a";
const DEFAULT_EDGE_ARROW_SIZE = 20;

const coreRelationColors: Record<string, string> = {
  rf: "#0f172a",
  co: "#0284c7",
  fr: "#f97316",
  po: "#94a3b8",
  ad: "#facc15",
  dd: "#38bdf8",
  cd: "#fb923c",
};

/**
 * Deterministically hash a string into an unsigned 32-bit integer.
 * Used to assign stable fallback colors to custom relation types.
 */
const hashString = (value: string) => {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
};

/**
 * Resolve a relation type to its display color.
 * Falls back to a stable HSL color when the type isn't one of the built-ins.
 */
const getRelationColor = (relationType: string) => {
  const core = coreRelationColors[relationType];
  if (core) {
    return core;
  }
  const hue = hashString(relationType) % 360;
  return `hsl(${hue} 65% 42%)`;
};

const sanitizeFilename = (raw: string) =>
  raw
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();

const formatTimestampForFilename = (date: Date) => {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate()
  )}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
};

const MEMORY_SECTIONS: { label: string; scope: MemoryScope }[] = [
  { label: "Constants", scope: "constants" },
  { label: "Local Registers", scope: "locals" },
  { label: "Shared", scope: "shared" },
];

const getLaneX = (index: number) => index * LANE_WIDTH + LANE_WIDTH / 2;

const getLaneIndexFromX = (x: number, laneCount: number) => {
  if (laneCount <= 0) {
    return 0;
  }
  const index = Math.floor(x / LANE_WIDTH);
  return Math.max(0, Math.min(index, laneCount - 1));
};

const getSequenceIndex = (y: number) =>
  Math.max(MIN_SEQUENCE_INDEX, Math.round(y / GRID_Y));

const getSequenceY = (sequenceIndex: number) => sequenceIndex * GRID_Y;

/**
 * The store persists node positions in "litmus space":
 * - `position.x`: time (sequence axis)
 * - `position.y`: thread lane center
 *
 * The canvas renders with time increasing downward, so React Flow receives
 * transposed positions at the boundary:
 * - render `x` = store `y` (threads left→right)
 * - render `y` = store `x` (time top→bottom)
 */
const transposeXY = ({ x, y }: { x: number; y: number }) => ({ x: y, y: x });

/**
 * Create a unique node id for React Flow.
 *
 * Why this exists:
 * - Sessions can be imported with arbitrary node ids (including `node-1`, `node-2`, ...).
 * - Using a local counter risks collisions across imports/resets/remounts.
 * - An id collision makes an existing node appear to "vanish" and causes edges
 *   to seemingly remap because they still point at the colliding id.
 */
const createTraceNodeId = (takenIds: Set<string>) => {
  let candidate = `node-${createUuid()}`;
  while (takenIds.has(candidate)) {
    candidate = `node-${createUuid()}`;
  }
  return candidate;
};

const createMemoryId = () =>
  `mem-${Date.now()}-${Math.random().toString(16).slice(2)}`;

/**
 * Returns a unique, human-friendly name for a new local register.
 *
 * - `int` registers default to `r0`, `r1`, ...
 * - `ptr` registers default to `p0`, `p1`, ...
 *
 * @param memoryEnv - Flattened memory environment.
 * @param kind - The register kind to generate a name for.
 */
const getNextLocalRegisterName = (
  memoryEnv: MemoryVariable[],
  kind: "int" | "ptr"
) => {
  const used = new Set<string>();
  let maxIndex = -1;
  const prefix = kind === "ptr" ? "p" : "r";
  const matcher = new RegExp(`^${prefix}(\\d+)$`);

  for (const item of memoryEnv) {
    if (item.scope !== "locals") {
      continue;
    }
    const name = item.name.trim();
    if (!name) {
      continue;
    }
    used.add(name);
    const match = matcher.exec(name);
    if (!match) {
      continue;
    }
    const index = Number(match[1]);
    if (!Number.isNaN(index)) {
      maxIndex = Math.max(maxIndex, index);
    }
  }

  let nextIndex = maxIndex + 1;
  let candidate = `${prefix}${nextIndex}`;
  while (used.has(candidate)) {
    nextIndex += 1;
    candidate = `${prefix}${nextIndex}`;
  }
  return candidate;
};

const collectConditionVariableIds = (condition: BranchCondition | undefined) => {
  if (!condition) {
    return [];
  }

  if (condition.kind === "rule") {
    const ids: string[] = [];
    if (condition.lhsId) {
      ids.push(condition.lhsId);
    }
    if (condition.rhsId) {
      ids.push(condition.rhsId);
    }
    return ids;
  }

  const ids: string[] = [];
  for (const item of condition.items) {
    ids.push(...collectConditionVariableIds(item));
  }
  return ids;
};

const getThreadsForLayout = (threads: string[], nodes: TraceNode[]) => {
  const orderedThreads = threads;
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

const LaneBackgroundOverlay = ({
  threads,
}: {
  threads: string[];
}) => (
  <div className="pointer-events-none absolute inset-0 z-0 flex">
    {threads.map((threadId, index) => (
      <div
        key={`${threadId}-${index}`}
        className={`relative border-r border-slate-200 ${
          index % 2 === 0 ? "bg-white" : "bg-slate-50"
        }`}
        style={{ width: LANE_WIDTH }}
      />
    ))}
    <div
      className="relative border-r border-dashed border-slate-300 bg-slate-200/40"
      style={{ width: LANE_WIDTH }}
    />
  </div>
);

const LaneLabelsOverlay = ({
  threads,
  nextThreadId,
  nodeCountsByThread,
  onRequestDeleteThread,
  threadLabels,
  onSetThreadLabel,
}: {
  threads: string[];
  nextThreadId: string;
  nodeCountsByThread: Map<string, number>;
  onRequestDeleteThread: (threadId: string) => void;
  threadLabels: Record<string, string>;
  onSetThreadLabel: (threadId: string, label: string) => void;
}) => (
  <div
    className="pointer-events-none absolute inset-x-0 top-0 z-20 flex border-b border-slate-200 bg-slate-100/85"
    style={{ height: LANE_LABEL_HEIGHT }}
  >
    {threads.map((threadId, index) => (
      <div
        key={`${threadId}-${index}`}
        className="relative flex items-start justify-center border-r border-slate-200 p-1.5"
        style={{ width: LANE_WIDTH }}
      >
        <div className="pointer-events-auto w-full max-w-[220px] rounded-md border border-slate-800 bg-slate-900/95 p-1 text-white shadow-sm">
          <div className="flex h-5 items-center justify-between gap-2">
            <div className="flex h-5 items-center rounded px-2 text-[11px] font-semibold leading-none text-white">
              {threadId}
            </div>
            <button
              type="button"
              className="flex h-5 w-5 items-center justify-center rounded border border-white/10 bg-white/5 text-[11px] font-semibold leading-none text-white hover:bg-white/10"
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
          <input
            value={threadLabels[threadId] ?? ""}
            placeholder="Label"
            className="mt-1.5 h-7 w-full rounded border border-white/10 bg-white/5 px-2 text-[13px] font-semibold text-white placeholder:text-white/50 focus:border-white/20 focus:outline-none"
            onMouseDown={(event) => {
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.stopPropagation();
            }}
            onChange={(event) => {
              onSetThreadLabel(threadId, event.target.value);
            }}
            aria-label={`Label for ${threadId}`}
          />
        </div>
      </div>
    ))}
    <div
      className="relative flex flex-col items-center justify-center gap-1 border-r border-dashed border-slate-300"
      style={{ width: LANE_WIDTH }}
    >
      <div className="rounded bg-slate-700/80 px-2 py-1 text-[10px] font-semibold text-white/90">
        {nextThreadId}
      </div>
      <div className="text-[10px] font-medium text-slate-500">Drop to add</div>
    </div>
  </div>
);

const EditorCanvas = () => {
  const nodes = useStore((state) => state.nodes);
  const edges = useStore((state) => state.edges);
  const memoryEnv = useStore((state) => state.memoryEnv);
  const selectedMemoryIds = useStore((state) => state.selectedMemoryIds);
  const threads = useStore((state) => state.threads);
  const threadLabels = useStore((state) => state.threadLabels);
  const setNodes = useStore((state) => state.setNodes);
  const onEdgesChange = useStore((state) => state.onEdgesChange);
  const setEdges = useStore((state) => state.setEdges);
  const addThread = useStore((state) => state.addThread);
  const deleteThread = useStore((state) => state.deleteThread);
  const setThreadLabel = useStore((state) => state.setThreadLabel);
  const addMemoryVar = useStore((state) => state.addMemoryVar);
  const updateMemoryVar = useStore((state) => state.updateMemoryVar);
  const deleteMemoryVar = useStore((state) => state.deleteMemoryVar);
  const validateGraph = useStore((state) => state.validateGraph);
  const edgeLabelMode = useStore((state) => state.edgeLabelMode);
  const focusedEdgeLabelId = useStore((state) => state.focusedEdgeLabelId);
  const cycleEdgeLabelMode = useStore((state) => state.cycleEdgeLabelMode);
  const setFocusedEdgeLabelId = useStore((state) => state.setFocusedEdgeLabelId);
  const toggleMemorySelection = useStore(
    (state) => state.toggleMemorySelection
  );
  const showAllNodes = useStore((state) => state.showAllNodes);
  const toggleShowAllNodes = useStore((state) => state.toggleShowAllNodes);
  const sessionTitle = useStore((state) => state.sessionTitle);
  const reactFlowInstance = useRef<ReactFlowInstance | null>(null);
  const reactFlowWrapperRef = useRef<HTMLDivElement | null>(null);
  const [isLocked, setIsLocked] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [pendingThreadDelete, setPendingThreadDelete] = useState<{
    threadId: string;
    nodeCount: number;
  } | null>(null);
  const [pendingMemoryDelete, setPendingMemoryDelete] = useState<{
    id: string;
    label: string;
    usageCount: number;
  } | null>(null);

  const nodeTypes = useMemo(
    () => ({ operation: OperationNode, branch: BranchNode }),
    []
  );
  const edgeTypes = useMemo(() => ({ relation: RelationEdgeComponent }), []);

  const visibleNodes = useMemo(() => {
    /**
     * Global override: when enabled, we render every node regardless of the
     * evaluated outcome of any BRANCH node (and regardless of per-branch "Both").
     */
    if (showAllNodes) {
      return nodes;
    }

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
      /**
       * Default behavior is to show both paths unless the user explicitly
       * disables it for a given branch.
       */
      if (branchNode.data.operation.branchShowBothFutures ?? true) {
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
  }, [edges, memoryEnv, nodes, showAllNodes]);

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

  const addressDependencyEdges = useMemo<RelationEdge[]>(() => {
    const memoryById = new Map(memoryEnv.map((item) => [item.id, item]));
    const dependencyTypes = new Set(["ad", "cd", "dd"]);
    const existingDependencyEdges = new Set(
      edges
        .filter((edge) => dependencyTypes.has(edge.data?.relationType ?? "po"))
        .map(
          (edge) =>
            `${edge.data?.relationType ?? "po"}:${edge.source}→${edge.target}`
        )
    );

    const nodesByThread = new Map<string, TraceNode[]>();
    for (const node of nodes) {
      const threadNodes = nodesByThread.get(node.data.threadId) ?? [];
      threadNodes.push(node);
      nodesByThread.set(node.data.threadId, threadNodes);
    }

    const derived: RelationEdge[] = [];

    for (const [, threadNodes] of nodesByThread) {
      const sorted = [...threadNodes].sort((a, b) => {
        const delta = a.data.sequenceIndex - b.data.sequenceIndex;
        return delta !== 0 ? delta : a.id.localeCompare(b.id);
      });

      const lastLoadByProducedId = new Map<string, TraceNode>();
      const lastLoadByAddressId = new Map<string, TraceNode>();

      const pushDerived = ({
        relationType,
        source,
        target,
      }: {
        relationType: "ad" | "cd" | "dd";
        source: TraceNode;
        target: TraceNode;
      }) => {
        const key = `${relationType}:${source.id}→${target.id}`;
        if (existingDependencyEdges.has(key)) {
          return;
        }
        existingDependencyEdges.add(key);
        derived.push({
          id: `edge-${relationType}-${source.id}-${target.id}`,
          type: "relation",
          source: source.id,
          target: target.id,
          focusable: false,
          interactionWidth: 0,
          deletable: false,
          zIndex: 0,
          style: { pointerEvents: "none" },
          data: { relationType, generated: true },
        });
      };

      for (const node of sorted) {
        const operation = node.data.operation;
        const indexId = operation.indexId;

        const resolvedAddress = resolvePointerTargetById(
          operation.addressId,
          memoryById
        ).resolved;
        const isArrayAccess =
          !!operation.addressId && resolvedAddress?.type === "array" && !!indexId;

        const needsAddressDependency =
          isArrayAccess &&
          (operation.type === "LOAD" ||
            operation.type === "STORE" ||
            operation.type === "RMW") &&
          !!indexId;

        if (needsAddressDependency) {
          const source =
            lastLoadByProducedId.get(indexId) ?? lastLoadByAddressId.get(indexId);
          if (source && source.data.sequenceIndex < node.data.sequenceIndex) {
            pushDerived({ relationType: "ad", source, target: node });
          }
        }

        const needsPointerAddressDependency =
          !!operation.addressId &&
          memoryById.get(operation.addressId)?.type === "ptr" &&
          (operation.type === "LOAD" ||
            operation.type === "STORE" ||
            operation.type === "RMW");

        if (needsPointerAddressDependency && operation.addressId) {
          const pointerId = operation.addressId;
          const source =
            lastLoadByProducedId.get(pointerId) ?? lastLoadByAddressId.get(pointerId);
          if (source && source.data.sequenceIndex < node.data.sequenceIndex) {
            // Pointer dereferences are address-dependent on the pointer value.
            pushDerived({ relationType: "ad", source, target: node });
          }
        }

        if (operation.type === "BRANCH") {
          const ids = new Set(
            collectConditionVariableIds(operation.branchCondition).filter(Boolean)
          );
          for (const id of ids) {
            const source =
              lastLoadByProducedId.get(id) ?? lastLoadByAddressId.get(id);
            if (source && source.data.sequenceIndex < node.data.sequenceIndex) {
              pushDerived({ relationType: "cd", source, target: node });
            }
          }
        }

        if (operation.type === "STORE") {
          const valueId = operation.valueId;
          if (valueId) {
            const source =
              lastLoadByProducedId.get(valueId) ?? lastLoadByAddressId.get(valueId);
            if (source && source.data.sequenceIndex < node.data.sequenceIndex) {
              pushDerived({ relationType: "dd", source, target: node });
            }
          }
        } else if (operation.type === "RMW") {
          const valueIds = [operation.expectedValueId, operation.desiredValueId].filter(
            (value): value is string => typeof value === "string" && value.length > 0
          );
          for (const valueId of valueIds) {
            const source =
              lastLoadByProducedId.get(valueId) ?? lastLoadByAddressId.get(valueId);
            if (source && source.data.sequenceIndex < node.data.sequenceIndex) {
              pushDerived({ relationType: "dd", source, target: node });
            }
          }
        }

        if (
          (operation.type === "LOAD" || operation.type === "RMW") &&
          operation.addressId
        ) {
          lastLoadByAddressId.set(operation.addressId, node);
          if (operation.resultId) {
            lastLoadByProducedId.set(operation.resultId, node);
          }
        }
      }
    }

    return derived;
  }, [edges, memoryEnv, nodes]);

  const edgesWithDerived = useMemo(() => {
    const dependencyTypes = new Set(["ad", "cd", "dd"]);
    const combined = [...addressDependencyEdges, ...relationEdges];
    const deps: typeof combined = [];
    const rest: typeof combined = [];

    for (const edge of combined) {
      const relationType = edge.data?.relationType ?? "po";
      if (dependencyTypes.has(relationType)) {
        deps.push(edge);
      } else {
        rest.push(edge);
      }
    }

    return [...deps, ...rest];
  }, [addressDependencyEdges, relationEdges]);
  const edgesToRender = useMemo(
    () =>
      edgesWithDerived.filter(
        (edge) =>
          visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)
      ),
    [edgesWithDerived, visibleNodeIds]
  );

  const edgesToRenderWithArrows = useMemo(() => {
    // Ensure every edge gets a visible arrowhead pointing at the dst/target handle.
    // We keep this as a render-time default so sessions don’t need to persist marker settings.
    return edgesToRender.map((edge) => {
      if (edge.markerEnd) {
        return edge;
      }

      const relationType = edge.data?.relationType ?? "po";
      const invalid = edge.data?.invalid ?? false;
      const styleStroke = edge.style?.stroke;
      const color =
        invalid
          ? "#ef4444"
          : typeof styleStroke === "string"
            ? styleStroke
            : getRelationColor(relationType) || DEFAULT_EDGE_ARROW_COLOR;

      return {
        ...edge,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color,
          width: DEFAULT_EDGE_ARROW_SIZE,
          height: DEFAULT_EDGE_ARROW_SIZE,
          markerUnits: "userSpaceOnUse",
        },
      };
    });
  }, [edgesToRender]);

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
      if (nodeCount === 0) {
        deleteThread(threadId);
        return;
      }
      setPendingThreadDelete({ threadId, nodeCount });
    },
    [deleteThread, nodeCountsByThread]
  );

  const formatMemoryLabel = useCallback(
    (item: MemoryVariable) => {
      const base = item.name.trim() || item.id;
      if (!item.parentId) {
        return base;
      }
      const parent = memoryEnv.find((candidate) => candidate.id === item.parentId);
      const parentLabel = parent ? parent.name.trim() || parent.id : "struct";
      return `${parentLabel}.${base}`;
    },
    [memoryEnv]
  );

  const countVariableUsages = useCallback(
    (id: string) => {
      let count = 0;
      for (const node of nodes) {
        const op = node.data.operation;
        if (op.addressId === id) count += 1;
        if (op.indexId === id) count += 1;
        if (op.valueId === id) count += 1;
        if (op.resultId === id) count += 1;
        if (op.expectedValueId === id) count += 1;
        if (op.desiredValueId === id) count += 1;
        if (op.type === "BRANCH") {
          for (const variableId of collectConditionVariableIds(op.branchCondition)) {
            if (variableId === id) {
              count += 1;
            }
          }
        }
      }
      for (const variable of memoryEnv) {
        if (variable.type === "ptr" && variable.pointsToId === id) {
          count += 1;
        }
      }
      return count;
    },
    [memoryEnv, nodes]
  );

  const requestDeleteMemory = useCallback(
    (item: MemoryVariable) => {
      const usageCount = countVariableUsages(item.id);
      if (usageCount <= 0) {
        deleteMemoryVar(item.id);
        return;
      }
      setPendingMemoryDelete({
        id: item.id,
        label: formatMemoryLabel(item),
        usageCount,
      });
    },
    [countVariableUsages, deleteMemoryVar, formatMemoryLabel]
  );

  const addLocalRegister = useCallback(() => {
    const id = createMemoryId();
    addMemoryVar({
      id,
      name: getNextLocalRegisterName(memoryEnv, "int"),
      type: "int",
      scope: "locals",
      value: "",
    });
  }, [addMemoryVar, memoryEnv]);

  const addLocalPointer = useCallback(() => {
    const id = createMemoryId();
    addMemoryVar({
      id,
      name: getNextLocalRegisterName(memoryEnv, "ptr"),
      type: "ptr",
      scope: "locals",
      pointsToId: id,
    });
  }, [addMemoryVar, memoryEnv]);

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

  const canvasWidth = useMemo(
    () => Math.max(1, displayLaneCount) * LANE_WIDTH,
    [displayLaneCount]
  );

  const translateExtent = useMemo<[[number, number], [number, number]]>(
    () => [
      [0, 0],
      [canvasWidth, MAX_CANVAS_Y],
    ],
    [canvasWidth]
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

      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
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
        y: Math.min(0, viewport.y - delta * PAN_SPEED),
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

  const handleExportPng = useCallback(async () => {
    const flow = reactFlowInstance.current;
    const wrapper = reactFlowWrapperRef.current;
    if (!flow || !wrapper) {
      return;
    }

    const viewportElement = wrapper.querySelector<HTMLElement>(
      ".react-flow__viewport"
    );
    if (!viewportElement) {
      return;
    }

    const safeTitle = sanitizeFilename(sessionTitle.trim());
    const filename = safeTitle
      ? `${safeTitle}.png`
      : `${formatTimestampForFilename(new Date())}.png`;

    setIsExporting(true);
    try {
      const nodesForExport = flow.getNodes();

      await exportReactFlowViewportToPng({
        viewportElement,
        nodes: nodesForExport,
        filename,
        nodeOrigin: CANVAS_NODE_ORIGIN,
        threadHeader: {
          threads: threadsForLayout,
          threadLabels,
          laneWidth: LANE_WIDTH,
        },
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to export image.";
      window.alert(message);
    } finally {
      setIsExporting(false);
    }
  }, [sessionTitle, threadLabels, threadsForLayout]);

  const handleAddThread = useCallback(() => {
    addThread();
  }, [addThread]);

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setNodes((current) => {
        const next = applyNodeChanges(
          changes.map((change) => {
            if (change.type !== "position" || typeof change.position === "undefined") {
              return change;
            }

            const laneIndex = getLaneIndexFromX(
              change.position.x,
              displayLaneCount
            );

            return {
              ...change,
              // Persist in litmus space by transposing render coordinates.
              position: transposeXY({
                x: getLaneX(laneIndex),
                y: change.position.y,
              }),
            };
          }),
          current
        );
        const laneOverrides = new Map<string, number>();

        for (const change of changes) {
          if (change.type !== "position" || typeof change.position === "undefined") {
            continue;
          }
          const laneIndex = getLaneIndexFromX(change.position.x, displayLaneCount);
          laneOverrides.set(change.id, getLaneX(laneIndex));
        }

        if (laneOverrides.size === 0) {
          return next;
        }

        return next.map((node) => {
          const lane = laneOverrides.get(node.id);
          if (typeof lane === "undefined") {
            return node;
          }
          return {
            ...node,
            position: {
              ...node.position,
              y: lane,
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
        const name =
          scope === "locals" ? getNextLocalRegisterName(memoryEnv, "int") : "";
        addMemoryVar({
          id,
          name,
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
          elementType: "int",
        });
        return;
      }

      if (memoryType === "ptr") {
        addMemoryVar({
          id,
          name: "",
          type: "ptr",
          scope,
          pointsToId: id,
        });
      }
    },
    [addMemoryVar, memoryEnv]
  );

  const handleNodeDragStop = useCallback(
    (_event: MouseEvent, node: TraceNode) => {
      const laneIndex = getLaneIndexFromX(node.position.x, displayLaneCount);
      const isAddLane = laneIndex >= threadsForLayout.length;
      const threadId = isAddLane
        ? addThread()
        : (threadsForLayout[laneIndex] ?? node.data.threadId);
      setNodes((current) =>
        current.map((currentNode) => {
          if (currentNode.id !== node.id) {
            return currentNode;
          }

          const sequenceIndex = getSequenceIndex(node.position.y);

          return {
            ...currentNode,
            position: {
              x: getSequenceY(sequenceIndex),
              y: getLaneX(laneIndex),
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

      const laneIndex = getLaneIndexFromX(position.x, displayLaneCount);
      const isAddLane = laneIndex >= threadsForLayout.length;
      const threadId = isAddLane
        ? addThread()
        : (threadsForLayout[laneIndex] ?? "T0");
      const sequenceIndex = getSequenceIndex(position.y);

      setNodes((current) => {
        const takenIds = new Set(current.map((node) => node.id));
        const id = createTraceNodeId(takenIds);

        const newNode: TraceNode = {
          id,
          type: nodeType as "operation" | "branch",
          position: {
            x: getSequenceY(sequenceIndex),
            y: getLaneX(laneIndex),
          },
          data: {
            threadId,
            sequenceIndex,
            operation: {
              type: operationType as TraceNode["data"]["operation"]["type"],
              ...(operationType === "BRANCH"
                ? {
                    branchCondition: createBranchGroupCondition(),
                    branchShowBothFutures: true,
                  }
                : null),
            },
          },
        };

        return [...current, newNode];
      });
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
      const nextLane = getLaneX(laneIndex);
      if (node.position.y === nextLane) {
        return node;
      }
      didChange = true;
      return {
        ...node,
        position: {
          ...node.position,
          y: nextLane,
        },
      };
    });

    if (didChange) {
      setNodes(normalized);
    }
  }, [nodes.length, setNodes, threadsForLayout]);

  const pointerTargetOptions = useMemo(() => {
    const memoryById = new Map(
      memoryEnv.map((candidate) => [candidate.id, candidate] as const)
    );

    const formatOptionLabel = (candidate: MemoryVariable): string => {
      const base = candidate.name.trim() || candidate.id;
      if (!candidate.parentId) {
        return base;
      }
      const parent = memoryById.get(candidate.parentId);
      const parentLabel = parent ? formatOptionLabel(parent) : candidate.parentId;
      return `${parentLabel}.${base}`;
    };

    return memoryEnv
      .map((candidate) => ({
        value: candidate.id,
        label: formatOptionLabel(candidate),
      }))
      .filter((candidate) => candidate.label);
  }, [memoryEnv]);

  const arrayStructTemplateOptions = useMemo(() => {
    const optionsByScope: Record<
      MemoryScope,
      Array<{ value: string; label: string }>
    > = {
      constants: [],
      locals: [],
      shared: [],
    };

    for (const variable of memoryEnv) {
      if (variable.type !== "struct" || variable.parentId) {
        continue;
      }

      const label = variable.name.trim() || variable.id;
      if (!label) {
        continue;
      }

      optionsByScope[variable.scope].push({ value: variable.id, label });
    }

    for (const scope of Object.keys(optionsByScope) as MemoryScope[]) {
      optionsByScope[scope].sort((a, b) => a.label.localeCompare(b.label));
    }

    return optionsByScope;
  }, [memoryEnv]);

  /**
   * Converts stored array element metadata into the `<select>` value used by the
   * memory editor UI.
   *
   * @param variable - Array variable from the memory environment.
   * @returns Encoded selection value (e.g. `"int"`, `"ptr"`, `"struct"`, `"struct:<id>"`).
   */
  const encodeArrayElementSelection = (variable: MemoryVariable): string => {
    if (variable.type !== "array") {
      return "int";
    }
    if (variable.elementType === "ptr") {
      return "ptr";
    }
    if (variable.elementType === "struct") {
      return variable.elementStructId
        ? `struct:${variable.elementStructId}`
        : "struct";
    }
    return "int";
  };

  /**
   * Parses a `<select>` value into array element metadata updates.
   *
   * @param selection - Encoded selection value from the UI.
   * @returns Partial updates suitable for `updateMemoryVar`.
   */
  const parseArrayElementSelection = (
    selection: string
  ): { elementType: ArrayElementType; elementStructId?: string } => {
    if (selection === "ptr") {
      return { elementType: "ptr", elementStructId: undefined };
    }
    if (selection === "struct") {
      return { elementType: "struct", elementStructId: undefined };
    }
    if (selection.startsWith("struct:")) {
      const structId = selection.slice("struct:".length).trim();
      return { elementType: "struct", elementStructId: structId || undefined };
    }
    return { elementType: "int", elementStructId: undefined };
  };

  const renderMemoryAtom = (item: MemoryVariable, nested: boolean) => {
    if (item.type === "struct") {
      return null;
    }
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
          <button
            type="button"
            className="inline-flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-1"
            aria-label={`Delete ${item.name.trim() || item.id}`}
            onClick={() => requestDeleteMemory(item)}
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </button>
          {item.type === "array" ? (
            <>
              <select
                className="w-24 rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                value={encodeArrayElementSelection(item)}
                onChange={(event) =>
                  updateMemoryVar(
                    item.id,
                    parseArrayElementSelection(event.target.value)
                  )
                }
              >
                <option value="int">int</option>
                <option value="ptr">ptr</option>
                <option value="struct">struct</option>
                {arrayStructTemplateOptions[item.scope].length > 0 ? (
                  <optgroup label="struct templates">
                    {arrayStructTemplateOptions[item.scope].map((option) => (
                      <option
                        key={option.value}
                        value={`struct:${option.value}`}
                      >
                        {option.label}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
              </select>
              <input
                type="number"
                min={0}
                className="w-24 rounded border border-slate-300 px-2 py-1 text-xs"
                placeholder="size"
                value={item.size ?? ""}
                onChange={(event) => {
                  const parsed =
                    event.target.value === ""
                      ? undefined
                      : Number(event.target.value);
                  updateMemoryVar(item.id, {
                    size:
                      typeof parsed === "number" && !Number.isNaN(parsed)
                        ? parsed
                        : undefined,
                  });
                }}
              />
            </>
          ) : item.type === "ptr" ? (
            <select
              className="w-44 rounded border border-slate-300 bg-white px-2 py-1 text-xs"
              value={item.pointsToId ?? ""}
              onChange={(event) =>
                updateMemoryVar(item.id, {
                  pointsToId: event.target.value ? event.target.value : undefined,
                })
              }
            >
              <option value="">Target…</option>
              {pointerTargetOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
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
          <button
            type="button"
            className="inline-flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-1"
            aria-label={`Delete ${item.name.trim() || item.id}`}
            onClick={() => requestDeleteMemory(item)}
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </button>
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
	            const isLocalRegisters = section.scope === "locals";

	            return (
	              <div
	                key={section.scope}
	                className="rounded border border-slate-200 bg-slate-50 p-2"
	                onDrop={
	                  isLocalRegisters
	                    ? undefined
	                    : (event) => handleMemoryDrop(event, section.scope)
	                }
	                onDragOver={isLocalRegisters ? undefined : handleMemoryDragOver}
	              >
	                <div className="mb-2 flex items-center justify-between text-[11px] font-semibold uppercase text-slate-500">
                  <span>{section.label}</span>
                  {isLocalRegisters ? (
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        className="rounded border border-slate-200 bg-white px-2 py-0.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                        onClick={addLocalRegister}
                        aria-label="Add int register"
                      >
                        +int
                      </button>
                      <button
                        type="button"
                        className="rounded border border-slate-200 bg-white px-2 py-0.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                        onClick={addLocalPointer}
                        aria-label="Add pointer register"
                      >
                        +ptr
                      </button>
                    </div>
                  ) : null}
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
                      {isLocalRegisters
                        ? "Use + to add registers"
                        : "Drop int, array, or ptr here"}
                    </div>
                  )}
                </div>
	              </div>
	            );
	          })}
	        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col bg-slate-100">
        <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
	          <div
	            className="relative h-full"
	            style={{ width: canvasWidth }}
	            onWheelCapture={handleWheelPan}
	            ref={reactFlowWrapperRef}
	          >
	            <div
	              className="absolute inset-x-0 bottom-0"
	              style={{ top: CANVAS_CONTENT_TOP_OFFSET }}
	            >
	              <div className="relative h-full">
	                <LaneBackgroundOverlay threads={threadsForLayout} />
	                <ReactFlow
	                  nodes={visibleNodes.map((node) => ({
	                    ...node,
	                    position: transposeXY(node.position),
	                  }))}
	                  edges={edgesToRenderWithArrows}
	                  nodeTypes={nodeTypes}
	                  edgeTypes={edgeTypes}
	                  nodeOrigin={CANVAS_NODE_ORIGIN}
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
	                  onEdgeClick={(_event, edge) => {
	                    if (edgeLabelMode !== "off") {
	                      return;
	                    }
	                    setFocusedEdgeLabelId(
	                      focusedEdgeLabelId === edge.id ? null : edge.id
	                    );
	                  }}
	                  onPaneClick={() => {
	                    if (edgeLabelMode !== "off") {
	                      return;
	                    }
	                    setFocusedEdgeLabelId(null);
	                  }}
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
	                    gap={[LANE_WIDTH, GRID_Y]}
	                    color="rgba(148, 163, 184, 0.35)"
	                    variant={BackgroundVariant.Lines}
	                  />
	                </ReactFlow>
	              </div>
	            </div>
	            <LaneLabelsOverlay
	              threads={threadsForLayout}
	              nextThreadId={nextThreadId}
	              nodeCountsByThread={nodeCountsByThread}
              onRequestDeleteThread={requestDeleteThread}
              threadLabels={threadLabels}
              onSetThreadLabel={setThreadLabel}
            />
            <ConfirmDialog
              open={pendingMemoryDelete !== null}
              title={
                pendingMemoryDelete
                  ? `Delete ${pendingMemoryDelete.label}?`
                  : "Delete variable?"
              }
              description={
                pendingMemoryDelete
                  ? `This variable is referenced ${pendingMemoryDelete.usageCount} time(s). Deleting it will clear those fields in the affected operations.`
                  : undefined
              }
              confirmLabel="Delete"
              cancelLabel="Cancel"
              tone="danger"
              onCancel={() => setPendingMemoryDelete(null)}
              onConfirm={() => {
                if (!pendingMemoryDelete) {
                  return;
                }
                deleteMemoryVar(pendingMemoryDelete.id);
                setPendingMemoryDelete(null);
              }}
            />
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
            <button
              type="button"
              className="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-700"
              onClick={cycleEdgeLabelMode}
              aria-label="Cycle edge label mode"
            >
              Labels:{" "}
              {edgeLabelMode === "all"
                ? "All"
                : edgeLabelMode === "nonPo"
                  ? "Relations"
                  : "Off"}
            </button>
            <button
              type="button"
              className={`rounded px-2 py-1 text-xs font-semibold ${
                showAllNodes
                  ? "bg-slate-900 text-white"
                  : "border border-slate-200 bg-white text-slate-700"
              }`}
              onClick={toggleShowAllNodes}
              aria-pressed={showAllNodes}
              title="Force all nodes visible (ignores branch evaluations)"
            >
              Show all
            </button>
            <button
              type="button"
              className="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
              onClick={handleExportPng}
              disabled={isExporting}
            >
              {isExporting ? "Exporting..." : "Export PNG"}
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
