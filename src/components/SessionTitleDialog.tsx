import { useEffect, useId, useRef, useState } from "react";

const SessionTitleDialog = ({
  open,
  initialValue,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  initialValue: string;
  onCancel: () => void;
  onConfirm: (title: string) => void;
}) => {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState(initialValue);

  useEffect(() => {
    if (!open) {
      return;
    }
    setDraft(initialValue);
    const handle = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(handle);
  }, [initialValue, open]);

  if (!open) {
    return null;
  }

  const submit = () => onConfirm(draft);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      role="dialog"
      aria-modal="true"
      aria-label="Name session"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onCancel();
        }
      }}
    >
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" />
      <div className="relative w-full max-w-md rounded-xl border border-slate-200 bg-white p-4 shadow-xl ring-1 ring-slate-900/10">
        <div className="text-sm font-semibold text-slate-900">Name session</div>
        <div className="mt-2 text-sm text-slate-600">
          This name is saved in the exported JSON and shown after import.
        </div>
        <div className="mt-4 space-y-1.5">
          <label
            htmlFor={inputId}
            className="text-xs font-semibold text-slate-700"
          >
            Session name
          </label>
          <input
            ref={inputRef}
            id={inputId}
            type="text"
            value={draft}
            placeholder="Untitled"
            className="w-full rounded border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-900/10"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onCancel();
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            }}
          />
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            className="rounded border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white"
            onClick={submit}
          >
            Export
          </button>
        </div>
      </div>
    </div>
  );
};

export default SessionTitleDialog;

