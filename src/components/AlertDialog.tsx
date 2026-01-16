import { useEffect } from "react";

const AlertDialog = ({
  open,
  title,
  description,
  closeLabel = "OK",
  onClose,
}: {
  /**
   * When false, renders nothing.
   */
  open: boolean;
  /**
   * Modal title shown at the top.
   */
  title: string;
  /**
   * Supporting text shown under the title.
   */
  description: string;
  /**
   * Close button label.
   */
  closeLabel?: string;
  /**
   * Called when the user dismisses the modal.
   */
  onClose: () => void;
}) => {
  useEffect(() => {
    if (!open) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
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
      aria-label={title}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" />
      <div className="relative w-full max-w-md rounded-xl border border-slate-200 bg-white p-4 shadow-xl ring-1 ring-slate-900/10">
        <div className="text-sm font-semibold text-slate-900">{title}</div>
        <div className="mt-2 whitespace-pre-wrap text-sm text-slate-600">
          {description}
        </div>
        <div className="mt-4 flex items-center justify-end">
          <button
            type="button"
            className="rounded bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white"
            onClick={onClose}
          >
            {closeLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AlertDialog;

