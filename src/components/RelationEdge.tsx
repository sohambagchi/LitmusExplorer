import { BaseEdge, getStraightPath, type EdgeProps } from "reactflow";
import type { RelationEdgeData, RelationType } from "../types";

// Render a jagged path to emphasize invalid relations.
const buildJaggedPath = (
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number
) => {
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const length = Math.hypot(dx, dy) || 1;
  const steps = 6;
  const stepLength = length / steps;
  const unitX = dx / length;
  const unitY = dy / length;
  const perpX = -unitY;
  const perpY = unitX;
  const amplitude = Math.min(12, stepLength * 0.6);

  let path = `M ${sourceX} ${sourceY}`;
  for (let i = 1; i < steps; i += 1) {
    const offset = i % 2 === 0 ? -amplitude : amplitude;
    const x = sourceX + unitX * stepLength * i + perpX * offset;
    const y = sourceY + unitY * stepLength * i + perpY * offset;
    path += ` L ${x} ${y}`;
  }

  path += ` L ${targetX} ${targetY}`;
  return path;
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
  markerEnd,
  data,
  style,
}: EdgeProps<RelationEdgeData>) => {
  const invalid = data?.invalid ?? false;
  const relationType = data?.relationType ?? "rf";
  const [straightPath] = getStraightPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
  });
  const edgePath = invalid
    ? buildJaggedPath(sourceX, sourceY, targetX, targetY)
    : straightPath;

  const stroke = (style?.stroke as string) ?? relationColors[relationType];

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      markerEnd={markerEnd}
      style={{
        ...style,
        stroke: invalid ? "#ef4444" : stroke,
        strokeWidth: invalid ? 2.5 : style?.strokeWidth ?? 1.75,
      }}
    />
  );
};

export default RelationEdge;
