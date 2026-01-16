import { toPng } from "html-to-image";
import { getNodesBounds, getViewportForBounds, type Node } from "reactflow";

/**
 * Returns true when a DOM node is explicitly marked as "exclude from PNG export".
 *
 * We use this to omit interactive, on-canvas-only UI (e.g. small node controls)
 * from the exported image while keeping them visible during normal editing.
 *
 * @param node - DOM node visited by `html-to-image` while cloning the tree.
 */
const isPngExportExcludedNode = (node: globalThis.Node) => {
  if (!(node instanceof Element)) {
    return false;
  }
  return node.getAttribute("data-png-export-exclude") === "true";
};

/**
 * Triggers a client-side download for a data URL.
 * @param dataUrl Data URL (e.g. `data:image/png;base64,...`).
 * @param filename Download filename (e.g. `my-session.png`).
 */
const downloadDataUrl = (dataUrl: string, filename: string) => {
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = filename;
  link.click();
};

const THREAD_HEADER_PADDING_Y = 14;
const THREAD_HEADER_PILL_HEIGHT = 26;
const THREAD_HEADER_PILL_RADIUS = 13;
const THREAD_HEADER_FONT =
  '600 13px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial';

const WATERMARK_TEXT = "Litmus Explorer by Soham Bagchi";
const WATERMARK_FONT =
  '500 12px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial';
const WATERMARK_COLOR = "rgba(100, 116, 139, 0.22)";
const WATERMARK_MARGIN = 10;

/**
 * Loads a PNG data URL into an `HTMLImageElement`, ready for drawing to a canvas.
 * @param dataUrl `data:image/png;base64,...` URL from `html-to-image`.
 */
const loadPngDataUrl = async (dataUrl: string): Promise<HTMLImageElement> => {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  return image;
};

/**
 * Draws a rounded rectangle path into a 2D canvas context.
 * @param ctx Canvas 2D context.
 * @param x Left position (CSS pixels).
 * @param y Top position (CSS pixels).
 * @param width Rectangle width (CSS pixels).
 * @param height Rectangle height (CSS pixels).
 * @param radius Corner radius (CSS pixels).
 */
const drawRoundedRect = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) => {
  const cappedRadius = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + cappedRadius, y);
  ctx.arcTo(x + width, y, x + width, y + height, cappedRadius);
  ctx.arcTo(x + width, y + height, x, y + height, cappedRadius);
  ctx.arcTo(x, y + height, x, y, cappedRadius);
  ctx.arcTo(x, y, x + width, y, cappedRadius);
  ctx.closePath();
};

/**
 * Truncates a label so it fits within the available width (adds ellipsis when needed).
 * @param ctx Canvas 2D context configured with the desired font.
 * @param label Original label.
 * @param maxWidth Maximum label width in CSS pixels.
 */
const truncateTextToWidth = (
  ctx: CanvasRenderingContext2D,
  label: string,
  maxWidth: number
) => {
  const trimmed = label.trim();
  if (!trimmed) {
    return "";
  }
  if (maxWidth <= 0) {
    return "";
  }
  if (ctx.measureText(trimmed).width <= maxWidth) {
    return trimmed;
  }

  const ellipsis = "…";
  const ellipsisWidth = ctx.measureText(ellipsis).width;
  if (ellipsisWidth > maxWidth) {
    return "";
  }

  let low = 0;
  let high = trimmed.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = `${trimmed.slice(0, mid)}${ellipsis}`;
    if (ctx.measureText(candidate).width <= maxWidth) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return `${trimmed.slice(0, low)}${ellipsis}`;
};

/**
 * Draws a subtle watermark in the bottom-left corner of an exported PNG.
 * @param ctx Canvas 2D context (already scaled for `pixelRatio`).
 * @param width Export width in CSS pixels.
 * @param height Export height in CSS pixels.
 */
const drawExportWatermark = ({
  ctx,
  width,
  height,
}: {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
}) => {
  ctx.save();

  ctx.font = WATERMARK_FONT;
  ctx.fillStyle = WATERMARK_COLOR;
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";

  // Keep the watermark anchored to the final exported image bounds (not the viewport content),
  // so it appears consistently in every export regardless of padding or headers.
  const x = Math.max(WATERMARK_MARGIN, 0);
  const y = Math.max(height - WATERMARK_MARGIN, 0);
  ctx.fillText(WATERMARK_TEXT, x, y, Math.max(0, width - WATERMARK_MARGIN * 2));

  ctx.restore();
};

/**
 * Draws a thread header row at the top of the exported image, centered to each lane.
 * @param ctx Canvas 2D context (already scaled for `pixelRatio`).
 * @param width Export width in CSS pixels.
 * @param threads Thread IDs in display order.
 * @param threadLabels Optional user labels keyed by thread ID.
 * @param threadCenters Optional lane centers in React Flow coordinates (same space as `nodes`).
 * @param laneWidth Lane width in React Flow coordinates.
 * @param viewport Export viewport transform, matching the rendered PNG.
 */
const drawThreadHeaderAligned = ({
  ctx,
  width,
  threads,
  threadLabels,
  threadCenters,
  laneWidth,
  viewport,
}: {
  ctx: CanvasRenderingContext2D;
  width: number;
  threads: string[];
  threadLabels?: Record<string, string>;
  threadCenters?: Record<string, number>;
  laneWidth: number;
  viewport: { x: number; y: number; zoom: number };
}) => {
  const pillPaddingX = 12;
  const y = THREAD_HEADER_PADDING_Y;

  ctx.font = THREAD_HEADER_FONT;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";

  threads.forEach((threadId, index) => {
    const rawLabel = threadLabels?.[threadId]?.trim();
    const label = rawLabel ? rawLabel : threadId;

    const centerWorld =
      typeof threadCenters?.[threadId] === "number"
        ? threadCenters[threadId]
        : index * laneWidth + laneWidth / 2;
    const centerX = centerWorld * viewport.zoom + viewport.x;

    const laneWidthPx = laneWidth * viewport.zoom;
    const maxPillWidth = Math.max(48, laneWidthPx - 16);
    const maxTextWidth = Math.max(0, maxPillWidth - pillPaddingX * 2);
    const truncated = truncateTextToWidth(ctx, label, maxTextWidth);
    const measuredWidth = Math.ceil(ctx.measureText(truncated).width);
    const pillWidth = Math.min(maxPillWidth, measuredWidth + pillPaddingX * 2);

    const x = Math.max(6, Math.min(width - pillWidth - 6, centerX - pillWidth / 2));
    const textX = x + pillWidth / 2;

    ctx.fillStyle = "rgba(15, 23, 42, 0.92)";
    drawRoundedRect(
      ctx,
      x,
      y,
      pillWidth,
      THREAD_HEADER_PILL_HEIGHT,
      THREAD_HEADER_PILL_RADIUS
    );
    ctx.fill();

    ctx.fillStyle = "#ffffff";
    ctx.fillText(truncated, textX, y + THREAD_HEADER_PILL_HEIGHT / 2);
  });
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
 * @param threadHeader Optional header row listing threads at the top of the export.
 */
export const exportReactFlowViewportToPng = async ({
  viewportElement,
  nodes,
  filename,
  nodeOrigin = [0, 0],
  padding = 48,
  backgroundColor = "#ffffff",
  pixelRatio = 2,
  threadHeader,
}: {
  viewportElement: HTMLElement;
  nodes: Node[];
  filename: string;
  nodeOrigin?: [number, number];
  padding?: number;
  backgroundColor?: string;
  pixelRatio?: number;
  threadHeader?: {
    threads: string[];
    threadLabels?: Record<string, string>;
    threadCenters?: Record<string, number>;
    laneWidth?: number;
  };
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
    filter: (node) => !isPngExportExcludedNode(node),
    style: {
      width: `${width}px`,
      height: `${height}px`,
      transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
    },
  });

  if (!threadHeader || threadHeader.threads.length === 0) {
    const viewportImage = await loadPngDataUrl(dataUrl);
    const canvas = document.createElement("canvas");
    canvas.width = width * pixelRatio;
    canvas.height = height * pixelRatio;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      downloadDataUrl(dataUrl, filename);
      return;
    }

    ctx.scale(pixelRatio, pixelRatio);
    ctx.fillStyle = backgroundColor;
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(viewportImage, 0, 0, width, height);
    drawExportWatermark({ ctx, width, height });

    downloadDataUrl(canvas.toDataURL("image/png"), filename);
    return;
  }

  // Compose a final PNG with a thread header above the exported viewport.
  const viewportImage = await loadPngDataUrl(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = width * pixelRatio;
  const headerHeight = THREAD_HEADER_PADDING_Y * 2 + THREAD_HEADER_PILL_HEIGHT;
  canvas.height = (height + headerHeight) * pixelRatio;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    downloadDataUrl(dataUrl, filename);
    return;
  }

  ctx.scale(pixelRatio, pixelRatio);
  ctx.fillStyle = backgroundColor;
  ctx.fillRect(0, 0, width, height + headerHeight);

  drawThreadHeaderAligned({
    ctx,
    width,
    threads: threadHeader.threads,
    threadLabels: threadHeader.threadLabels,
    threadCenters: threadHeader.threadCenters,
    laneWidth: threadHeader.laneWidth ?? 260,
    viewport,
  });

  ctx.drawImage(viewportImage, 0, headerHeight, width, height);
  ctx.strokeStyle = "rgba(148, 163, 184, 0.7)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, headerHeight);
  ctx.lineTo(width, headerHeight);
  ctx.stroke();

  drawExportWatermark({ ctx, width, height: height + headerHeight });

  downloadDataUrl(canvas.toDataURL("image/png"), filename);
};
