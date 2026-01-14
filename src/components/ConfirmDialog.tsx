type ConfirmDialogTone = "default" | "danger";

const toneStyles: Record<ConfirmDialogTone, { button: string; ring: string }> = {
  default: {
    button: "bg-slate-900 text-white",
    ring: "ring-slate-900/10",
  },
  danger: {
    button: "bg-rose-600 text-white",
    ring: "ring-rose-600/10",
  },
};

const ConfirmDialog = ({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  tone = "default",
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmDialogTone;
  onConfirm: () => void;
  onCancel: () => void;
}) => {
  if (!open) {
    return null;
  }

  const styles = toneStyles[tone];

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
      <div
        className={`relative w-full max-w-md rounded-xl border border-slate-200 bg-white p-4 shadow-xl ring-1 ${styles.ring}`}
      >
        <div className="text-sm font-semibold text-slate-900">{title}</div>
        {description ? (
          <div className="mt-2 text-sm text-slate-600">{description}</div>
        ) : null}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            className="rounded border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700"
            onClick={onCancel}
          >
            {cancelLabel ?? "Cancel"}
          </button>
          <button
            type="button"
            className={`rounded px-3 py-1.5 text-xs font-semibold ${styles.button}`}
            onClick={onConfirm}
          >
            {confirmLabel ?? "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfirmDialog;

