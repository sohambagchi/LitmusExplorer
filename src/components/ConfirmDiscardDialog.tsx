import { useEffect } from "react";

const ConfirmDiscardDialog = ({
  open,
  title,
  description,
  confirmLabel = "Discard",
  cancelLabel = "Cancel",
  onCancel,
  onConfirm,
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
   * Supporting text describing what will be discarded.
   */
  description: string;
  /**
   * Primary action label.
   */
  confirmLabel?: string;
  /**
   * Secondary action label.
   */
  cancelLabel?: string;
  /**
   * Called when the user dismisses the modal.
   */
  onCancel: () => void;
  /**
   * Called when the user confirms discarding changes.
   */
  onConfirm: () => void;
}) => {
  useEffect(() => {
    if (!open) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel, open]);

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
          onCancel();
        }
      }}
    >
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" />
      <div className="relative w-full max-w-md rounded-xl border border-slate-200 bg-white p-4 shadow-xl ring-1 ring-slate-900/10">
        <div className="text-sm font-semibold text-slate-900">{title}</div>
        <div className="mt-2 text-sm text-slate-600">{description}</div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            className="rounded border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className="rounded bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfirmDiscardDialog;

