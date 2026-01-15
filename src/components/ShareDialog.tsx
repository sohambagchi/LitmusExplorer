import { useEffect, useId, useRef, useState } from "react";
import { Copy } from "lucide-react";

const ShareDialog = ({
  open,
  shareId,
  shareUrl,
  onClose,
}: {
  open: boolean;
  shareId: string;
  shareUrl: string;
  onClose: () => void;
}) => {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    setCopied(false);
    const handle = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(handle);
  }, [open, shareUrl]);

  if (!open) {
    return null;
  }

  const copy = async () => {
    setCopied(false);
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
    } catch {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      role="dialog"
      aria-modal="true"
      aria-label="Share session"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" />
      <div className="relative w-full max-w-lg rounded-xl border border-slate-200 bg-white p-4 shadow-xl ring-1 ring-slate-900/10">
        <div className="text-sm font-semibold text-slate-900">Share session</div>
        <div className="mt-2 text-sm text-slate-600">
          Share this link. Opening it will load this session into Litmus Explorer.
        </div>
        <div className="mt-4 space-y-1.5">
          <label
            htmlFor={inputId}
            className="text-xs font-semibold text-slate-700"
          >
            Share link
          </label>
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              id={inputId}
              type="text"
              readOnly
              value={shareUrl}
              className="w-full rounded border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-900/10"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  onClose();
                }
              }}
            />
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded bg-slate-900 px-3 py-2 text-xs font-semibold text-white"
              onClick={copy}
            >
              <Copy className="h-4 w-4" aria-hidden="true" />
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <div className="text-xs text-slate-500">
            UUID: <span className="font-mono text-slate-700">{shareId}</span>
          </div>
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <a
            className="rounded border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700"
            href={shareUrl}
            target="_blank"
            rel="noreferrer"
          >
            Open
          </a>
          <button
            type="button"
            className="rounded bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white"
            onClick={onClose}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};

export default ShareDialog;

