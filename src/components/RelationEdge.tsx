import {
  BaseEdge,
  EdgeLabelRenderer,
  Position,
  type EdgeProps,
  useReactFlow,
} from "reactflow";
import type { Node } from "reactflow";
import { useStore } from "../store/useStore";
import type { RelationEdgeData, RelationType, TraceNodeData } from "../types";

// Render a jagged path to emphasize invalid relations.
type Point = { x: number; y: number };

const LANE_HEIGHT = 120;
const STRAIGHT_EPSILON_PX = 6;
const BUFFER_Y_OFFSET_STEP_PX = 6;
const BUFFER_Y_OFFSET_SLOTS = [0, 1, -1, 2, -2, 3, -3];
const ARROW_APPROACH_PX = 14;
const FALLBACK_NODE_HEIGHT: Record<string, number> = {
  branch: 56,
  operation: 44,
};

const simplifyPoints = (points: Point[]) => {
  const compact: Point[] = [];

  for (const point of points) {
    const prev = compact[compact.length - 1];
    if (prev && prev.x === point.x && prev.y === point.y) {
      continue;
    }
    compact.push(point);
  }

  if (compact.length <= 2) {
    return compact;
  }

  const simplified: Point[] = [compact[0]];
  for (let i = 1; i < compact.length - 1; i += 1) {
    const prev = simplified[simplified.length - 1];
    const curr = compact[i];
    const next = compact[i + 1];
    if (!prev || !curr || !next) {
      continue;
    }
    const collinear =
      (prev.x === curr.x && curr.x === next.x) ||
      (prev.y === curr.y && curr.y === next.y);
    if (!collinear) {
      simplified.push(curr);
    }
  }
  simplified.push(compact[compact.length - 1]);

  return simplified;
};

const pointsToPath = (points: Point[]) => {
  if (points.length === 0) {
    return "";
  }
  const [start, ...rest] = points;
  if (!start) {
    return "";
  }
  let path = `M ${start.x} ${start.y}`;
  for (const point of rest) {
    path += ` L ${point.x} ${point.y}`;
  }
  return path;
};

/**
 * Ensure the edge path ends with a segment that points into the target handle.
 * React Flow orients arrow markers using the path tangent at the endpoint. Our
 * orthogonal routing often ends with a vertical segment at `targetX,targetY`,
 * which yields up/down arrowheads even when the handle is on the left/right.
 */
const adjustPointsForArrowhead = ({
  points,
  targetX,
  targetY,
  targetPosition,
}: {
  points: Point[];
  targetX: number;
  targetY: number;
  targetPosition: Position;
}) => {
  if (points.length < 2) {
    return points;
  }

  const desiredAxis =
    targetPosition === Position.Left || targetPosition === Position.Right
      ? "horizontal"
      : "vertical";
  const approach =
    desiredAxis === "horizontal"
      ? targetPosition === Position.Right
        ? { x: targetX + ARROW_APPROACH_PX, y: targetY }
        : { x: targetX - ARROW_APPROACH_PX, y: targetY }
      : targetPosition === Position.Bottom
        ? { x: targetX, y: targetY + ARROW_APPROACH_PX }
        : { x: targetX, y: targetY - ARROW_APPROACH_PX };

  const normalized = [...points];
  normalized[normalized.length - 1] = { x: targetX, y: targetY };

  const prev = normalized[normalized.length - 2];
  const last = normalized[normalized.length - 1];
  if (!prev || !last) {
    return normalized;
  }

  if (desiredAxis === "horizontal") {
    // If the last segment is vertical, shift the vertical drop slightly left/right
    // and finish with a short horizontal segment into the target handle.
    if (prev.x === targetX) {
      normalized[normalized.length - 2] = { x: approach.x, y: prev.y };
      if (prev.y !== targetY) {
        normalized.splice(normalized.length - 1, 0, {
          x: approach.x,
          y: targetY,
        });
      }
      return simplifyPoints(normalized);
    }

    // If the last segment isn't horizontal, insert a corner to make it so.
    if (prev.y !== targetY) {
      normalized.splice(normalized.length - 1, 0, { x: prev.x, y: targetY });
    }
    return simplifyPoints(normalized);
  }

  // Vertical target handle: ensure the last segment is vertical into the endpoint.
  if (prev.y === targetY) {
    normalized[normalized.length - 2] = { x: prev.x, y: approach.y };
    if (prev.x !== targetX) {
      normalized.splice(normalized.length - 1, 0, { x: targetX, y: approach.y });
    }
    return simplifyPoints(normalized);
  }

  if (prev.x !== targetX) {
    normalized.splice(normalized.length - 1, 0, { x: targetX, y: prev.y });
  }
  return simplifyPoints(normalized);
};

const buildOrthogonalPoints = ({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourceNode,
  targetNode,
  sourceHandleId,
  edgeYOffsetPx,
}: {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourceNode: Node<TraceNodeData> | undefined;
  targetNode: Node<TraceNodeData> | undefined;
  sourceHandleId?: string | null;
  edgeYOffsetPx?: number;
}) => {
  if (Math.abs(sourceY - targetY) <= STRAIGHT_EPSILON_PX) {
    return simplifyPoints([
      { x: sourceX, y: sourceY },
      { x: targetX, y: targetY },
    ]);
  }

  const sourceThreadId = sourceNode?.data?.threadId;
  const targetThreadId = targetNode?.data?.threadId;
  const sameThread =
    sourceThreadId !== undefined &&
    targetThreadId !== undefined &&
    sourceThreadId === targetThreadId;

  const getCenterY = (node: Node<TraceNodeData> | undefined, y: number) =>
    node?.position?.y ?? y;
  const getHeight = (node: Node<TraceNodeData> | undefined) =>
    node?.height ??
    (node?.type ? FALLBACK_NODE_HEIGHT[node.type] : undefined) ??
    44;

  const getMetrics = (
    node: Node<TraceNodeData> | undefined,
    fallbackCenterY: number
  ) => {
    const centerY = getCenterY(node, fallbackCenterY);
    const nodeHeight = getHeight(node);
    const laneTop = centerY - LANE_HEIGHT / 2;
    const laneBottom = centerY + LANE_HEIGHT / 2;
    const nodeTop = centerY - nodeHeight / 2;
    const nodeBottom = centerY + nodeHeight / 2;

    return {
      centerY,
      laneTop,
      laneBottom,
      nodeTop,
      nodeBottom,
      nodeHeight,
    };
  };

  const sourceMetrics = getMetrics(sourceNode, sourceY);
  const targetMetrics = getMetrics(targetNode, targetY);
  const sourceLaneCenterY = sourceMetrics.centerY;
  const targetLaneCenterY = targetMetrics.centerY;
  const goingDown = targetLaneCenterY > sourceLaneCenterY;

  const sourcePref = (() => {
    if (sourceNode?.type === "branch" && (sourceHandleId === "then" || sourceHandleId === "else")) {
      return sourceHandleId === "then" ? "top" : "bottom";
    }
    if (sameThread) {
      return sourceY < sourceLaneCenterY ? "top" : "bottom";
    }
    return goingDown ? "bottom" : "top";
  })();

  const targetPref = (() => {
    if (sameThread) {
      return targetY < targetLaneCenterY ? "top" : "bottom";
    }
    return goingDown ? "top" : "bottom";
  })();

  const clampToLane = (y: number, laneTop: number, laneBottom: number) =>
    Math.max(laneTop + 2, Math.min(laneBottom - 2, y));
  const clampToRange = (y: number, min: number, max: number) => Math.max(min, Math.min(max, y));
  const localYOffset = edgeYOffsetPx ?? 0;

  if (sameThread) {
    const laneTop = (sourceMetrics.laneTop + targetMetrics.laneTop) / 2;
    const laneBottom = (sourceMetrics.laneBottom + targetMetrics.laneBottom) / 2;

    const routeY =
      sourcePref === "top"
        ? (laneTop + Math.min(sourceMetrics.nodeTop, targetMetrics.nodeTop)) / 2
        : (Math.max(sourceMetrics.nodeBottom, targetMetrics.nodeBottom) + laneBottom) /
          2;

    const laneClamped = clampToLane(routeY + localYOffset, laneTop, laneBottom);
    const maxNodeTop = Math.min(sourceMetrics.nodeTop, targetMetrics.nodeTop) - 2;
    const minNodeBottom = Math.max(sourceMetrics.nodeBottom, targetMetrics.nodeBottom) + 2;
    const clampedRouteY =
      sourcePref === "top"
        ? maxNodeTop > laneTop + 2
          ? clampToRange(laneClamped, laneTop + 2, maxNodeTop)
          : laneClamped
        : minNodeBottom < laneBottom - 2
          ? clampToRange(laneClamped, minNodeBottom, laneBottom - 2)
          : laneClamped;

    return simplifyPoints([
      { x: sourceX, y: sourceY },
      { x: sourceX, y: clampedRouteY },
      { x: targetX, y: clampedRouteY },
      { x: targetX, y: targetY },
    ]);
  }

  const sourceBuffer = Math.max(0, (LANE_HEIGHT - sourceMetrics.nodeHeight) / 2);
  const targetBuffer = Math.max(0, (LANE_HEIGHT - targetMetrics.nodeHeight) / 2);
  const sourceRouteY =
    sourcePref === "top"
      ? sourceMetrics.nodeTop - sourceBuffer / 2
      : sourceMetrics.nodeBottom + sourceBuffer / 2;
  const targetRouteY =
    targetPref === "top"
      ? targetMetrics.nodeTop - targetBuffer / 2
      : targetMetrics.nodeBottom + targetBuffer / 2;

  const clampedSourceLane = clampToLane(
    sourceRouteY + localYOffset,
    sourceMetrics.laneTop,
    sourceMetrics.laneBottom
  );
  const clampedTargetLane = clampToLane(
    targetRouteY + localYOffset,
    targetMetrics.laneTop,
    targetMetrics.laneBottom
  );
  const clampedSourceRouteY =
    sourcePref === "top"
      ? sourceMetrics.nodeTop - 2 > sourceMetrics.laneTop + 2
        ? clampToRange(clampedSourceLane, sourceMetrics.laneTop + 2, sourceMetrics.nodeTop - 2)
        : clampedSourceLane
      : sourceMetrics.nodeBottom + 2 < sourceMetrics.laneBottom - 2
        ? clampToRange(
            clampedSourceLane,
            sourceMetrics.nodeBottom + 2,
            sourceMetrics.laneBottom - 2
          )
        : clampedSourceLane;
  const clampedTargetRouteY =
    targetPref === "top"
      ? targetMetrics.nodeTop - 2 > targetMetrics.laneTop + 2
        ? clampToRange(clampedTargetLane, targetMetrics.laneTop + 2, targetMetrics.nodeTop - 2)
        : clampedTargetLane
      : targetMetrics.nodeBottom + 2 < targetMetrics.laneBottom - 2
        ? clampToRange(
            clampedTargetLane,
            targetMetrics.nodeBottom + 2,
            targetMetrics.laneBottom - 2
          )
        : clampedTargetLane;

  const midX = (sourceX + targetX) / 2;
  return simplifyPoints([
    { x: sourceX, y: sourceY },
    { x: sourceX, y: clampedSourceRouteY },
    { x: midX, y: clampedSourceRouteY },
    { x: midX, y: clampedTargetRouteY },
    { x: targetX, y: clampedTargetRouteY },
    { x: targetX, y: targetY },
  ]);
};

const buildJaggedOrthogonalPath = (points: Point[]) => {
  if (points.length < 2) {
    return pointsToPath(points);
  }

  const jagged: Point[] = [points[0] as Point];

  for (let i = 0; i < points.length - 1; i += 1) {
    const start = points[i];
    const end = points[i + 1];
    if (!start || !end) {
      continue;
    }

    const dx = end.x - start.x;
    const dy = end.y - start.y;

    if (dx === 0 && dy === 0) {
      continue;
    }

    const isHorizontal = dy === 0;
    const length = Math.abs(isHorizontal ? dx : dy);
    const dir = (isHorizontal ? dx : dy) >= 0 ? 1 : -1;
    const tooth = Math.max(6, Math.min(12, length / 10));
    const amplitude = Math.min(10, tooth);

    let progressed = 0;
    let flip = false;

    while (progressed + tooth * 2 < length) {
      progressed += tooth;
      const offset = flip ? amplitude : -amplitude;

      if (isHorizontal) {
        const x1 = start.x + dir * progressed;
        jagged.push({ x: x1, y: start.y });
        jagged.push({ x: x1, y: start.y + offset });

        progressed += tooth;
        const x2 = start.x + dir * progressed;
        jagged.push({ x: x2, y: start.y + offset });
        jagged.push({ x: x2, y: start.y });
      } else {
        const y1 = start.y + dir * progressed;
        jagged.push({ x: start.x, y: y1 });
        jagged.push({ x: start.x + offset, y: y1 });

        progressed += tooth;
        const y2 = start.y + dir * progressed;
        jagged.push({ x: start.x + offset, y: y2 });
        jagged.push({ x: start.x, y: y2 });
      }

      flip = !flip;
    }

    jagged.push(end);
  }

  return pointsToPath(simplifyPoints(jagged));
};

const getHorizontalLabelAnchor = (points: Point[]) => {
  let best: { x1: number; x2: number; y: number; length: number } | null = null;

  for (let i = 0; i < points.length - 1; i += 1) {
    const start = points[i];
    const end = points[i + 1];
    if (!start || !end) {
      continue;
    }
    if (start.y !== end.y || start.x === end.x) {
      continue;
    }
    const length = Math.abs(end.x - start.x);
    if (!best || length > best.length) {
      best = { x1: start.x, x2: end.x, y: start.y, length };
    }
  }

  if (!best) {
    return null;
  }

  return { x: (best.x1 + best.x2) / 2, y: best.y };
};

const coreRelationColors: Record<string, string> = {
  rf: "#0f172a",
  co: "#0284c7",
  fr: "#f97316",
  po: "#94a3b8",
  ad: "#facc15",
  dd: "#38bdf8",
  cd: "#fb923c",
};

const hashString = (value: string) => {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
};

const getBufferEdgeYOffsetPx = (edgeId: string) => {
  const slot = BUFFER_Y_OFFSET_SLOTS[hashString(edgeId) % BUFFER_Y_OFFSET_SLOTS.length];
  return slot ? slot * BUFFER_Y_OFFSET_STEP_PX : 0;
};

const getRelationColor = (relationType: RelationType) => {
  const core = coreRelationColors[relationType];
  if (core) {
    return core;
  }
  const hue = hashString(relationType) % 360;
  return `hsl(${hue} 65% 42%)`;
};

const RelationEdge = ({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  source,
  target,
  sourceHandleId,
  targetPosition,
  selected,
  markerEnd,
  data,
  style,
}: EdgeProps<RelationEdgeData>) => {
  const { getNode } = useReactFlow<TraceNodeData, RelationEdgeData>();
  const sourceNode = source ? getNode(source) : undefined;
  const targetNode = target ? getNode(target) : undefined;

  const invalid = data?.invalid ?? false;
  const relationType = data?.relationType ?? "po";
  const isDependencyBand =
    relationType === "ad" || relationType === "cd" || relationType === "dd";
  const isGenerated = data?.generated ?? false;
  const edgeLabelMode = useStore((state) => state.edgeLabelMode);
  const focusedEdgeLabelId = useStore((state) => state.focusedEdgeLabelId);
  const edgeYOffsetPx = getBufferEdgeYOffsetPx(id);
  const points = buildOrthogonalPoints({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourceNode,
    targetNode,
    sourceHandleId,
    edgeYOffsetPx,
  });
  const pointsWithArrow = adjustPointsForArrowhead({
    points,
    targetX,
    targetY,
    targetPosition,
  });
  const edgePath = invalid
    ? buildJaggedOrthogonalPath(pointsWithArrow)
    : pointsToPath(pointsWithArrow);

  const stroke = (style?.stroke as string) ?? getRelationColor(relationType);
  const isSelected = selected ?? false;
  const bandStrokeWidth =
    relationType === "ad" ? 14 : relationType === "cd" ? 12 : 12;
  const bandOpacity = relationType === "ad" ? 0.25 : 0.22;
  const labelAnchor = getHorizontalLabelAnchor(pointsWithArrow);
  const isLabelEligible = !isGenerated && !isDependencyBand && !!labelAnchor;
  const shouldShowByMode =
    edgeLabelMode === "all"
      ? true
      : edgeLabelMode === "nonPo"
        ? relationType !== "po"
        : focusedEdgeLabelId === id;
  const showLabel = isLabelEligible && shouldShowByMode;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        interactionWidth={24}
        style={{
          ...style,
          stroke: invalid ? "#ef4444" : stroke,
          strokeWidth: isDependencyBand
            ? bandStrokeWidth
            : invalid
              ? 2.5
              : isSelected
                ? 2.75
                : style?.strokeWidth ?? 1.75,
          opacity: isDependencyBand ? bandOpacity : style?.opacity,
          strokeLinecap: isDependencyBand ? "round" : style?.strokeLinecap,
          strokeDasharray: isSelected
            ? "5 4"
            : isDependencyBand
              ? undefined
              : style?.strokeDasharray,
        }}
      />
      {showLabel && labelAnchor ? (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan relative z-10 max-w-[180px] truncate rounded-full border bg-white px-2 py-0.5 text-[10px] font-semibold shadow-md"
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelAnchor.x}px, ${labelAnchor.y}px)`,
              pointerEvents: "none",
              zIndex: 10,
              borderColor: invalid
                ? "#fecaca"
                : isSelected
                  ? "#0f172a"
                  : "rgba(226, 232, 240, 1)",
              color: invalid
                ? "#b91c1c"
                : isSelected
                  ? "#0f172a"
                  : "rgba(51, 65, 85, 1)",
            }}
            aria-hidden="true"
          >
            {relationType}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
};

export default RelationEdge;
