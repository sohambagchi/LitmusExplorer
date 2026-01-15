import { useEffect, useId } from "react";
import { X } from "lucide-react";

type VisualKeyRelation = {
  relationType: "dd" | "ad" | "cd";
  label: string;
  description: string;
  color: string;
  strokeWidth: number;
  opacity: number;
};

const VISUAL_KEY_RELATIONS: VisualKeyRelation[] = [
  {
    relationType: "dd",
    label: "Data dependency",
    description: "Reads a value produced by another operation.",
    color: "#38bdf8",
    strokeWidth: 12,
    opacity: 0.22,
  },
  {
    relationType: "ad",
    label: "Address dependency",
    description: "Computes an address based on a value from another operation.",
    color: "#facc15",
    strokeWidth: 14,
    opacity: 0.25,
  },
  {
    relationType: "cd",
    label: "Control dependency",
    description: "Control flow depends on the outcome of another operation.",
    color: "#fb923c",
    strokeWidth: 12,
    opacity: 0.22,
  },
];

/**
 * Visual legend modal for dependency edges.
 *
 * Matches the canvas’ dependency rendering (thick translucent bands + arrowhead)
 * for `dd` (data), `ad` (address), and `cd` (control) dependencies.
 */
const VisualKeyDialog = ({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) => {
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" />
      <div className="relative w-full max-w-lg rounded-xl border border-slate-200 bg-white p-4 shadow-xl ring-1 ring-slate-900/10">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div
              id={titleId}
              className="text-sm font-semibold text-slate-900"
            >
              Visual key
            </div>
            <div id={descriptionId} className="mt-1 text-sm text-slate-600">
              Dependency edges render as thick translucent bands with arrowheads.
            </div>
          </div>
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-1"
            aria-label="Close visual key"
            onClick={onClose}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="mt-4 space-y-3">
          {VISUAL_KEY_RELATIONS.map((entry) => (
            <div
              key={entry.relationType}
              className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"
            >
              <svg
                width="84"
                height="28"
                viewBox="0 0 84 28"
                className="shrink-0"
                aria-hidden="true"
              >
                <line
                  x1="10"
                  y1="14"
                  x2="68"
                  y2="14"
                  stroke={entry.color}
                  strokeWidth={entry.strokeWidth}
                  strokeLinecap="round"
                  opacity={entry.opacity}
                />
                <polygon
                  points="68,7 80,14 68,21"
                  fill={entry.color}
                />
              </svg>

              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-slate-900">
                    {entry.label}
                  </span>
                  <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-700">
                    {entry.relationType}
                  </span>
                </div>
                <div className="mt-0.5 text-xs text-slate-600">
                  {entry.description}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-4 flex items-center justify-end">
          <button
            type="button"
            className="rounded border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default VisualKeyDialog;

