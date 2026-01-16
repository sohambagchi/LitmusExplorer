import { useEffect, useRef } from "react";
import { X } from "lucide-react";

const TutorialDialog = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const restoreOverflowRef = useRef<string | null>(null);

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
    const handle = window.setTimeout(() => closeButtonRef.current?.focus(), 0);

    const { overflow } = document.body.style;
    restoreOverflowRef.current = overflow;
    document.body.style.overflow = "hidden";

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.clearTimeout(handle);
      document.body.style.overflow = restoreOverflowRef.current ?? "";
      restoreOverflowRef.current = null;
    };
  }, [onClose, open]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      role="dialog"
      aria-modal="true"
      aria-label="Litmus Explorer tutorial"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" />
      <div className="relative w-full max-w-3xl rounded-xl border border-slate-200 bg-white shadow-xl ring-1 ring-slate-900/10">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div>
            <div className="text-sm font-semibold text-slate-900">Help</div>
            <div className="text-xs text-slate-500">
              Quick tutorial for building and sharing litmus graphs.
            </div>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="inline-flex items-center justify-center rounded border border-slate-200 bg-white p-2 text-slate-700 hover:bg-slate-50"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto p-4">
          <div className="space-y-6 text-sm text-slate-700">
            <section className="space-y-2">
              <div className="text-sm font-semibold text-slate-900">
                1) The Memory (constants, locals, shared)
              </div>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  Use the <span className="font-semibold">+</span> buttons in each memory section
                  to add values/registers (int, ptr, array).
                </li>
                <li>
                  Use <span className="font-semibold">Constants</span> for fixed values,{" "}
                  <span className="font-semibold">Local Registers</span> for per-thread
                  temporaries, and <span className="font-semibold">Shared</span> for shared memory.
                </li>
                <li>
                  Select two or more items (same scope) and use{" "}
                  <span className="font-mono">{"{}"}</span> to group them into a{" "}
                  <span className="font-semibold">struct</span>.
                </li>
                <li>
                  Rename items to keep operations readable (arrays/structs can be nested; names
                  resolve as <span className="font-mono">parent.child</span>).
                </li>
              </ul>
            </section>

            <section className="space-y-2">
              <div className="text-sm font-semibold text-slate-900">
                2) Uploading <span className="font-mono">.cat</span> files (nested resolution)
              </div>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  In the right-hand <span className="font-semibold">Model</span> sidebar, upload one
                  or more <span className="font-mono">.cat</span> files.
                </li>
                <li>
                  Relation definitions are shown inline in the sidebar after upload (the{" "}
                  <span className="font-semibold">View Relation Definitions</span> button opens a
                  larger view).
                </li>
                <li>
                  Litmus Explorer resolves <span className="font-mono">include</span> chains; if a
                  file is missing you’ll see a warning for missing includes.
                </li>
              </ul>
            </section>

            <section className="space-y-2">
              <div className="text-sm font-semibold text-slate-900">
                3) Drag &amp; drop operation nodes (CAS and Branch tips)
              </div>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  Drag operations from the <span className="font-semibold">Toolbox</span> onto a
                  thread lane.
                </li>
                <li>
                  <span className="font-semibold">CAS</span> uses address + expected + desired
                  values and can optionally write a result register.
                </li>
                <li>
                  <span className="font-semibold">Branch</span> nodes can be collapsed/expanded;
                  set the branch condition in <span className="font-semibold">Properties</span>.
                </li>
              </ul>
            </section>

            <section className="space-y-2">
              <div className="text-sm font-semibold text-slate-900">
                4) Drawing edges and labeling relations
              </div>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  Draw an edge by dragging from a node handle to another node.
                </li>
                <li>
                  Select an edge, then choose its relation type in{" "}
                  <span className="font-semibold">Properties</span> (e.g.{" "}
                  <span className="font-mono">rf</span>, <span className="font-mono">co</span>,{" "}
                  <span className="font-mono">po</span>).
                </li>
                <li>
                  Use <span className="font-semibold">Validate Graph</span> to catch invalid or
                  disallowed relation combinations.
                </li>
              </ul>
            </section>

            <section className="space-y-2">
              <div className="text-sm font-semibold text-slate-900">
                5) Labels, export PNG, and sharing
              </div>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  Toggle <span className="font-semibold">Labels</span> in the canvas toolbar to
                  show all edges, only non-<span className="font-mono">po</span> relations, or
                  hide labels.
                </li>
                <li>
                  Use <span className="font-semibold">Export PNG</span> to download an image of the
                  current viewport (handy for papers and slides).
                </li>
                <li>
                  Use <span className="font-semibold">Share</span> in the top bar to generate a
                  link others can open to load the session.
                </li>
              </ul>
            </section>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-4 py-3">
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

export default TutorialDialog;
