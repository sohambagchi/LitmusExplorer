import { BaseEdge, type EdgeProps, useReactFlow } from "reactflow";
import type { Node } from "reactflow";
import type { RelationEdgeData, RelationType, TraceNodeData } from "../types";

// Render a jagged path to emphasize invalid relations.
type Point = { x: number; y: number };

const LANE_HEIGHT = 120;
const STRAIGHT_EPSILON_PX = 6;
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

const buildOrthogonalPoints = ({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourceNode,
  targetNode,
  sourceHandleId,
}: {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourceNode: Node<TraceNodeData> | undefined;
  targetNode: Node<TraceNodeData> | undefined;
  sourceHandleId?: string | null;
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

  if (sameThread) {
    const laneTop = (sourceMetrics.laneTop + targetMetrics.laneTop) / 2;
    const laneBottom = (sourceMetrics.laneBottom + targetMetrics.laneBottom) / 2;

    const routeY =
      sourcePref === "top"
        ? (laneTop + Math.min(sourceMetrics.nodeTop, targetMetrics.nodeTop)) / 2
        : (Math.max(sourceMetrics.nodeBottom, targetMetrics.nodeBottom) + laneBottom) /
          2;

    const clampedRouteY = Math.max(laneTop + 2, Math.min(laneBottom - 2, routeY));

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

  const clampedSourceRouteY = Math.max(
    sourceMetrics.laneTop + 2,
    Math.min(sourceMetrics.laneBottom - 2, sourceRouteY)
  );
  const clampedTargetRouteY = Math.max(
    targetMetrics.laneTop + 2,
    Math.min(targetMetrics.laneBottom - 2, targetRouteY)
  );

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

const relationColors: Record<RelationType, string> = {
  rf: "#0f172a",
  co: "#0284c7",
  fr: "#f97316",
  po: "#94a3b8",
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
  const points = buildOrthogonalPoints({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourceNode,
    targetNode,
    sourceHandleId,
  });
  const edgePath = invalid
    ? buildJaggedOrthogonalPath(points)
    : pointsToPath(points);

  const stroke = (style?.stroke as string) ?? relationColors[relationType];
  const isSelected = selected ?? false;

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      markerEnd={markerEnd}
      interactionWidth={24}
      style={{
        ...style,
        stroke: invalid ? "#ef4444" : stroke,
        strokeWidth: invalid ? 2.5 : isSelected ? 2.75 : style?.strokeWidth ?? 1.75,
        strokeDasharray: isSelected ? "5 4" : style?.strokeDasharray,
      }}
    />
  );
};

export default RelationEdge;
