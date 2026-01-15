import { toPng } from "html-to-image";
import { getNodesBounds, getViewportForBounds, type Node } from "reactflow";

const downloadDataUrl = (dataUrl: string, filename: string) => {
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = filename;
  link.click();
};

/**
 * Exports a React Flow viewport element to a PNG and triggers a download.
 * @param viewportElement `.react-flow__viewport` element to render.
 * @param nodes Nodes currently rendered in the viewport (used for bounds).
 * @param filename Download filename (e.g. `my-session.png`).
 * @param nodeOrigin Node origin used by the canvas (must match `ReactFlow`'s `nodeOrigin`).
 * @param padding Extra padding around the exported content, in px.
 * @param backgroundColor Background color used for the export.
 * @param pixelRatio Device pixel ratio multiplier (higher = sharper, bigger file).
 */
export const exportReactFlowViewportToPng = async ({
  viewportElement,
  nodes,
  filename,
  nodeOrigin = [0, 0],
  padding = 48,
  backgroundColor = "#ffffff",
  pixelRatio = 2,
}: {
  viewportElement: HTMLElement;
  nodes: Node[];
  filename: string;
  nodeOrigin?: [number, number];
  padding?: number;
  backgroundColor?: string;
  pixelRatio?: number;
}) => {
  if (nodes.length === 0) {
    throw new Error("Nothing to export.");
  }

  // React Flow bounds calculations depend on the node origin. Our canvas uses a
  // top-aligned Y-origin (`nodeOrigin={[0.5, 0]}`), so we pass it through here
  // to avoid skewed exports (e.g. larger bottom padding than top).
  const bounds = getNodesBounds(nodes, nodeOrigin);
  const width = Math.max(1, Math.ceil(bounds.width + padding * 2));
  const height = Math.max(1, Math.ceil(bounds.height + padding * 2));
  const viewport = getViewportForBounds(bounds, width, height, 0.1, 2);

  const dataUrl = await toPng(viewportElement, {
    backgroundColor,
    width,
    height,
    pixelRatio,
    style: {
      width: `${width}px`,
      height: `${height}px`,
      transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
    },
  });

  downloadDataUrl(dataUrl, filename);
};
