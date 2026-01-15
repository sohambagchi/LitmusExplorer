import { toPng } from "html-to-image";
import { getNodesBounds, getViewportForBounds, type Node } from "reactflow";

const downloadDataUrl = (dataUrl: string, filename: string) => {
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = filename;
  link.click();
};

export const exportReactFlowViewportToPng = async ({
  viewportElement,
  nodes,
  filename,
  padding = 48,
  backgroundColor = "#ffffff",
  pixelRatio = 2,
}: {
  viewportElement: HTMLElement;
  nodes: Node[];
  filename: string;
  padding?: number;
  backgroundColor?: string;
  pixelRatio?: number;
}) => {
  if (nodes.length === 0) {
    throw new Error("Nothing to export.");
  }

  const bounds = getNodesBounds(nodes);
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

