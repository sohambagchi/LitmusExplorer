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
type LogicalNode = Node<TraceNodeData> & {
  __render?: { top: number; bottom: number };
};

// NOTE: The canvas renders with time going down and threads left→right, but this
// edge router was originally written for a left→right time axis. We keep the
// routing logic stable by computing paths in a "logical" coordinate space where
// time is X and threads are Y, then transpose the result back to render space.
const LANE_HEIGHT = 260;
// Keep in sync with `GRID_Y` in `src/components/EditorCanvas.tsx`.
// This is the vertical spacing between operation rows in render space (time axis).
const SEQUENCE_STEP_PX = 80;
// Route inter-thread horizontal traversals through the empty space below nodes.
// This margin keeps the traversal away from the next row's node handles.
const ROW_TRAVERSAL_MARGIN_PX = 8;
// Height of the "row gap" band reserved for inter-thread horizontal traversals.
// Inter-thread edges with the same source/target rows will choose a deterministic
// X (time) offset within this band to reduce overlap.
const ROW_TRAVERSAL_BAND_PX = 14;
const CROSS_X_OFFSET_STEP_PX = 3;
const EXIT_FROM_SOURCE_PX = 5;
const EXIT_X_OFFSET_STEP_PX = 2;
const STRAIGHT_EPSILON_PX = 6;
const BUFFER_OFFSET_STEP_PX = 6;
const BUFFER_OFFSET_SLOTS = [0, 1, -1, 2, -2, 3, -3];
// Keep the final segment long enough to orient the marker, but short enough to
// avoid intruding into the left-side lane label gutter.
const ARROW_APPROACH_PX = 8;
const FALLBACK_NODE_SIZE_PX: Record<string, number> = {
  branch: 56,
  operation: 110,
};
const FALLBACK_RENDER_NODE_HEIGHT_PX: Record<string, number> = {
  branch: 56,
  operation: 56,
};

const transposePoint = (point: Point): Point => ({ x: point.y, y: point.x });

const transposePosition = (position: Position) => {
  switch (position) {
    case Position.Top:
      return Position.Left;
    case Position.Bottom:
      return Position.Right;
    case Position.Left:
      return Position.Top;
    case Position.Right:
      return Position.Bottom;
    default:
      return position;
  }
};

const toLogicalNode = (
  node: Node<TraceNodeData> | undefined
): LogicalNode | undefined => {
  if (!node) {
    return undefined;
  }

  const width =
    node.width ??
    (node.type ? FALLBACK_NODE_SIZE_PX[node.type] : undefined) ??
    110;
  const renderHeight =
    node.height ??
    (node.type ? FALLBACK_RENDER_NODE_HEIGHT_PX[node.type] : undefined) ??
    56;
  const renderTop = node.position.y;

  return {
    ...node,
    position: { x: node.position.y, y: node.position.x },
    // `buildOrthogonalPoints` uses `node.height` as the node size within a lane.
    // After transposing coordinates, the lane axis becomes the render X-axis, so
    // the relevant node size is its measured width.
    height: width,
    __render: {
      top: renderTop,
      bottom: renderTop + renderHeight,
    },
  };
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

/**
 * Pick a time coordinate (logical X) for the inter-thread lane crossing.
 *
 * In render space, inter-thread lane crossings are horizontal segments. If they
 * occur at a row's node Y coordinate, they can cut through operation nodes.
 *
 * We instead route the crossing through the empty band just below the earlier
 * operation row (i.e. right before the next `GRID_Y` multiple), which tends to
 * stay clear of node rectangles while remaining compact.
 */
const getInterThreadCrossX = ({
  sourceX,
  targetX,
  sourceNode,
  targetNode,
  edgeCrossOffsetPx,
  rowMaxNodeBottomX,
}: {
  sourceX: number;
  targetX: number;
  sourceNode: LogicalNode | undefined;
  targetNode: LogicalNode | undefined;
  edgeCrossOffsetPx?: number;
  rowMaxNodeBottomX?: number;
}) => {
  const sourceSeq = sourceNode?.data?.sequenceIndex;
  const targetSeq = targetNode?.data?.sequenceIndex;

  const sourceRowTop =
    typeof sourceSeq === "number"
      ? sourceSeq * SEQUENCE_STEP_PX
      : sourceNode?.__render?.top ?? sourceX;
  const targetRowTop =
    typeof targetSeq === "number"
      ? targetSeq * SEQUENCE_STEP_PX
      : targetNode?.__render?.top ?? targetX;

  const earlierRowTop = Math.min(sourceRowTop, targetRowTop);
  const earlierNode =
    sourceRowTop <= targetRowTop ? sourceNode : targetNode;
  const earlierNodeBottom = earlierNode?.__render?.bottom ?? earlierRowTop;
  const requiredBottom = Math.max(
    earlierNodeBottom,
    typeof rowMaxNodeBottomX === "number" ? rowMaxNodeBottomX : -Infinity
  );

  // Compute a safe band that stays below the earlier row's node and above the
  // next row's top handle region.
  const bandUpper = earlierRowTop + SEQUENCE_STEP_PX - ROW_TRAVERSAL_MARGIN_PX;
  const bandLower = Math.min(
    bandUpper,
    Math.max(requiredBottom + ROW_TRAVERSAL_MARGIN_PX, bandUpper - ROW_TRAVERSAL_BAND_PX)
  );

  const bandMax = bandUpper;
  const bandMin = bandLower;
  const base = (bandMin + bandMax) / 2;

  // Prefer keeping the crossing time between the endpoints (prevents "backtracking"
  // along the time axis when one endpoint is on a bottom handle).
  const minEndpoint = Math.min(sourceX, targetX) + ROW_TRAVERSAL_MARGIN_PX;
  const maxEndpoint = Math.max(sourceX, targetX) - ROW_TRAVERSAL_MARGIN_PX;

  const desired = base + (edgeCrossOffsetPx ?? 0);
  if (maxEndpoint <= minEndpoint) {
    return (sourceX + targetX) / 2;
  }

  const minAllowed = Math.max(bandMin, minEndpoint);
  const maxAllowed = Math.min(bandMax, maxEndpoint);
  if (maxAllowed > minAllowed) {
    return Math.max(minAllowed, Math.min(maxAllowed, desired));
  }

  return Math.max(minEndpoint, Math.min(maxEndpoint, desired));
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
  edgeCrossOffsetPx,
  rowMaxNodeBottomX,
  rowMaxSourceNodeBottomX,
  edgeExitOffsetPx,
}: {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourceNode: LogicalNode | undefined;
  targetNode: LogicalNode | undefined;
  sourceHandleId?: string | null;
  edgeYOffsetPx?: number;
  edgeCrossOffsetPx?: number;
  rowMaxNodeBottomX?: number;
  rowMaxSourceNodeBottomX?: number;
  edgeExitOffsetPx?: number;
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
    (node?.type ? FALLBACK_NODE_SIZE_PX[node.type] : undefined) ??
    110;

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

  const sourceSeq = sourceNode?.data?.sequenceIndex;
  const targetSeq = targetNode?.data?.sequenceIndex;
  const earlierSeq =
    typeof sourceSeq === "number" && typeof targetSeq === "number"
      ? Math.min(sourceSeq, targetSeq)
      : undefined;

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

  // Buffer-channel router (inter-thread):
  // 1) Drop into the row gap (time axis) by ~5px.
  // 2) Move laterally into the nearest vertical buffer (lane axis).
  // 3) If needed, travel north/south within the vertical buffer to the crossing row gap.
  // 4) Traverse across lanes within the row gap.
  // 5) Travel north/south in the target lane buffer into the destination handle.
  const sourceRowTopX =
    typeof sourceSeq === "number"
      ? sourceSeq * SEQUENCE_STEP_PX
      : sourceNode?.__render?.top ?? sourceX;
  const { bandMin: sourceBandMin, bandMax: sourceBandMax } =
    getRowGapBandForRowTop({
      rowTopX: sourceRowTopX,
      rowMaxNodeBottomX: rowMaxSourceNodeBottomX,
    });
  const useCrossOffsetForExit =
    typeof earlierSeq === "number" &&
    typeof sourceSeq === "number" &&
    sourceSeq === earlierSeq;
  const desiredExitX =
    sourceX +
    EXIT_FROM_SOURCE_PX +
    (useCrossOffsetForExit ? (edgeCrossOffsetPx ?? 0) : (edgeExitOffsetPx ?? 0));
  const startGapX = Math.max(
    sourceX + EXIT_FROM_SOURCE_PX,
    Math.max(sourceBandMin, Math.min(sourceBandMax, desiredExitX))
  );

  const crossX = useCrossOffsetForExit
    ? startGapX
    : getInterThreadCrossX({
        sourceX,
        targetX,
        sourceNode,
        targetNode,
        edgeCrossOffsetPx,
        rowMaxNodeBottomX,
      });
  return simplifyPoints([
    { x: sourceX, y: sourceY },
    { x: startGapX, y: sourceY },
    { x: startGapX, y: clampedSourceRouteY },
    { x: crossX, y: clampedSourceRouteY },
    { x: crossX, y: clampedTargetRouteY },
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

const getBufferEdgeOffsetPx = (edgeId: string) => {
  const slot =
    BUFFER_OFFSET_SLOTS[hashString(edgeId) % BUFFER_OFFSET_SLOTS.length];
  return slot ? slot * BUFFER_OFFSET_STEP_PX : 0;
};

/**
 * Deterministic time-axis (logical X) offset used to spread inter-thread lane
 * crossings within a row gap band.
 *
 * @param edgeId React Flow edge ID (must be stable).
 */
const getCrossEdgeOffsetPx = (edgeId: string) => {
  const slot =
    BUFFER_OFFSET_SLOTS[
      hashString(`${edgeId}-cross-x`) % BUFFER_OFFSET_SLOTS.length
    ];
  return slot ? slot * CROSS_X_OFFSET_STEP_PX : 0;
};

/**
 * Small deterministic offset for the initial "drop into the row gap" step.
 * Keeps the drop near ~5px while still helping reduce overlap.
 */
const getExitEdgeOffsetPx = (edgeId: string) => {
  const slot =
    BUFFER_OFFSET_SLOTS[
      hashString(`${edgeId}-exit-x`) % BUFFER_OFFSET_SLOTS.length
    ];
  return slot ? slot * EXIT_X_OFFSET_STEP_PX : 0;
};

type Rect = { left: number; top: number; right: number; bottom: number };

/**
 * Compute a render-space bounding box for a React Flow node.
 *
 * React Flow uses `nodeOrigin={[0.5, 0]}` in this app, so:
 * - `position.x` is centered horizontally
 * - `position.y` is the top edge
 */
const getRenderNodeRect = (node: Node<TraceNodeData>): Rect => {
  const width =
    node.width ??
    (node.type ? FALLBACK_NODE_SIZE_PX[node.type] : undefined) ??
    110;
  const height =
    node.height ??
    (node.type ? FALLBACK_RENDER_NODE_HEIGHT_PX[node.type] : undefined) ??
    56;

  const left = node.position.x - width / 2;
  const top = node.position.y;

  return { left, top, right: left + width, bottom: top + height };
};

const expandRect = (rect: Rect, padding: { x: number; y: number }): Rect => ({
  left: rect.left - padding.x,
  right: rect.right + padding.x,
  top: rect.top - padding.y,
  bottom: rect.bottom + padding.y,
});

const pointDistanceToRect = (point: Point, rect: Rect) => {
  const dx =
    point.x < rect.left
      ? rect.left - point.x
      : point.x > rect.right
        ? point.x - rect.right
        : 0;
  const dy =
    point.y < rect.top
      ? rect.top - point.y
      : point.y > rect.bottom
        ? point.y - rect.bottom
        : 0;
  return Math.hypot(dx, dy);
};

const getApproxLabelPadding = (relationType: string) => {
  const textWidth = Math.max(10, relationType.length * 6);
  const width = 22 + textWidth;
  const height = 18;
  return { x: width / 2 + 6, y: height / 2 + 6 };
};

const hashToUnitInterval = (value: string) => {
  // `hashString` is uint32; normalize to [0,1).
  return hashString(value) / 2 ** 32;
};

/**
 * Pick a stable parameter along a segment to spread label placements.
 *
 * Midpoints tend to collide when many edges share a long trunk segment, so we
 * use a per-edge parameter to distribute labels along the segment length.
 */
const getEdgeLabelT = (edgeId: string) => {
  const unit = hashToUnitInterval(`${edgeId}-label-t`);
  return 0.22 + unit * 0.56;
};

/**
 * Small perpendicular offset applied when anchoring labels in buffer bands.
 */
const getEdgeLabelPerpOffsetPx = (edgeId: string) => {
  const unit = hashToUnitInterval(`${edgeId}-label-perp`);
  const signed = unit * 2 - 1; // [-1, 1)
  return Math.round(signed * 6);
};

const clampToRowGapBand = (y: number) => {
  const rowTop = Math.floor(y / SEQUENCE_STEP_PX) * SEQUENCE_STEP_PX;
  const bandMax = rowTop + SEQUENCE_STEP_PX - ROW_TRAVERSAL_MARGIN_PX;
  const bandMin = bandMax - ROW_TRAVERSAL_BAND_PX;
  return Math.max(bandMin, Math.min(bandMax, y));
};

const getRowGapBandForRowTop = ({
  rowTopX,
  rowMaxNodeBottomX,
}: {
  rowTopX: number;
  rowMaxNodeBottomX?: number;
}) => {
  const bandMax = rowTopX + SEQUENCE_STEP_PX - ROW_TRAVERSAL_MARGIN_PX;
  const requiredBottom =
    typeof rowMaxNodeBottomX === "number" ? rowMaxNodeBottomX : rowTopX;
  const bandMin = Math.min(
    bandMax,
    Math.max(requiredBottom + ROW_TRAVERSAL_MARGIN_PX, bandMax - ROW_TRAVERSAL_BAND_PX)
  );
  return { bandMin, bandMax };
};

const isInRowGapBand = (y: number) => {
  const rowTop = Math.floor(y / SEQUENCE_STEP_PX) * SEQUENCE_STEP_PX;
  const withinRow = y - rowTop;
  const bandStart =
    SEQUENCE_STEP_PX - ROW_TRAVERSAL_MARGIN_PX - ROW_TRAVERSAL_BAND_PX - 2;
  const bandEnd = SEQUENCE_STEP_PX - ROW_TRAVERSAL_MARGIN_PX + 2;
  return withinRow >= bandStart && withinRow <= bandEnd;
};

const isInLaneSideBuffer = (x: number) => {
  const laneCenter =
    Math.round((x - LANE_HEIGHT / 2) / LANE_HEIGHT) * LANE_HEIGHT +
    LANE_HEIGHT / 2;
  return Math.abs(x - laneCenter) >= 60;
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
  const { getNode, getNodes } = useReactFlow<TraceNodeData, RelationEdgeData>();
  const sourceNode = toLogicalNode(source ? getNode(source) : undefined);
  const targetNode = toLogicalNode(target ? getNode(target) : undefined);
  const nodes = getNodes();

  const invalid = data?.invalid ?? false;
  const relationType = data?.relationType ?? "po";
  const isDependencyBand =
    relationType === "ad" || relationType === "cd" || relationType === "dd";
  const isGenerated = data?.generated ?? false;
  const edgeLabelMode = useStore((state) => state.edgeLabelMode);
  const focusedEdgeLabelId = useStore((state) => state.focusedEdgeLabelId);
  const edgeOffsetPx = getBufferEdgeOffsetPx(id);
  const edgeCrossOffsetPx = getCrossEdgeOffsetPx(id);
  const edgeExitOffsetPx = getExitEdgeOffsetPx(id);
  const edgeLabelT = getEdgeLabelT(id);
  const edgeLabelPerpOffsetPx = getEdgeLabelPerpOffsetPx(id);

  const getRowMaxNodeBottomX = (sequenceIndex: number) => {
    let maxBottom = -Infinity;

    for (const node of nodes) {
      const nodeData = node.data as TraceNodeData | undefined;
      if (nodeData?.sequenceIndex !== sequenceIndex) {
        continue;
      }
      const rect = getRenderNodeRect(node as Node<TraceNodeData>);
      maxBottom = Math.max(maxBottom, rect.bottom);
    }

    return Number.isFinite(maxBottom) ? maxBottom : undefined;
  };

  const rowMaxNodeBottomX = (() => {
    const sourceSeq = sourceNode?.data?.sequenceIndex;
    const targetSeq = targetNode?.data?.sequenceIndex;
    if (typeof sourceSeq !== "number" || typeof targetSeq !== "number") {
      return undefined;
    }
    const earlierSeq = Math.min(sourceSeq, targetSeq);
    return getRowMaxNodeBottomX(earlierSeq);
  })();
  const rowMaxSourceNodeBottomX = (() => {
    const sourceSeq = sourceNode?.data?.sequenceIndex;
    if (typeof sourceSeq !== "number") {
      return undefined;
    }
    return getRowMaxNodeBottomX(sourceSeq);
  })();

  // Transpose edge coordinates to the logical routing space (time=X, lane=Y).
  const logicalSourceX = sourceY;
  const logicalSourceY = sourceX;
  const logicalTargetX = targetY;
  const logicalTargetY = targetX;

  const points = buildOrthogonalPoints({
    sourceX: logicalSourceX,
    sourceY: logicalSourceY,
    targetX: logicalTargetX,
    targetY: logicalTargetY,
    sourceNode,
    targetNode,
    sourceHandleId,
    edgeYOffsetPx: edgeOffsetPx,
    edgeCrossOffsetPx,
    rowMaxNodeBottomX,
    rowMaxSourceNodeBottomX,
    edgeExitOffsetPx,
  });
  const pointsWithArrow = adjustPointsForArrowhead({
    points,
    targetX: logicalTargetX,
    targetY: logicalTargetY,
    targetPosition: transposePosition(targetPosition),
  });
  const renderPoints = pointsWithArrow.map(transposePoint);
  const edgePath = invalid
    ? buildJaggedOrthogonalPath(renderPoints)
    : pointsToPath(renderPoints);

  const stroke = (style?.stroke as string) ?? getRelationColor(relationType);
  const isSelected = selected ?? false;
  const bandStrokeWidth =
    relationType === "ad" ? 14 : relationType === "cd" ? 12 : 12;
  const bandOpacity = relationType === "ad" ? 0.25 : 0.22;
  const labelAnchor = (() => {
    const labelPadding = getApproxLabelPadding(relationType);
    const avoidRects = nodes.map((node) =>
      expandRect(getRenderNodeRect(node as Node<TraceNodeData>), labelPadding)
    );

    let best: { x: number; y: number; score: number } | null = null;

    for (let i = 0; i < renderPoints.length - 1; i += 1) {
      const start = renderPoints[i];
      const end = renderPoints[i + 1];
      if (!start || !end) {
        continue;
      }

      const isHorizontal = start.y === end.y && start.x !== end.x;
      const isVertical = start.x === end.x && start.y !== end.y;
      if (!isHorizontal && !isVertical) {
        continue;
      }

      const length = Math.hypot(end.x - start.x, end.y - start.y);
      const t = edgeLabelT;
      const anchor = isHorizontal
        ? { x: start.x + (end.x - start.x) * t, y: start.y }
        : { x: start.x, y: start.y + (end.y - start.y) * t };

      // If we're anchoring inside a buffer band, allow a small perpendicular
      // adjustment to reduce label-on-label overlap.
      const inRowGap = isHorizontal && isInRowGapBand(anchor.y);
      const inLaneBuffer = isVertical && isInLaneSideBuffer(anchor.x);
      const adjusted = (() => {
        if (inRowGap) {
          return {
            x: anchor.x,
            y: clampToRowGapBand(anchor.y + edgeLabelPerpOffsetPx),
          };
        }
        if (inLaneBuffer) {
          return { x: anchor.x + edgeLabelPerpOffsetPx, y: anchor.y };
        }
        return anchor;
      })();

      let minClearance = Infinity;
      for (const rect of avoidRects) {
        const clearance = pointDistanceToRect(adjusted, rect);
        minClearance = Math.min(minClearance, clearance);
        if (minClearance === 0) {
          break;
        }
      }

      if (minClearance === 0) {
        continue;
      }

      const zoneBonus = inRowGap ? 220 : inLaneBuffer ? 160 : 0;
      const jitter = (hashString(`${id}-seg-${i}`) % 31) / 31;

      const score =
        zoneBonus +
        Math.min(600, length) +
        Math.min(250, minClearance) * 9 +
        jitter;
      if (!best || score > best.score) {
        best = { x: adjusted.x, y: adjusted.y, score };
      }
    }

    return best ? { x: best.x, y: best.y } : null;
  })();
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
            className="nodrag nopan relative z-10 inline-flex w-max items-center rounded-full border bg-white px-2 py-0.5 text-[10px] font-semibold shadow-md"
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
