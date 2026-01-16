import { useCallback, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Trash2, X } from "lucide-react";
import { useStore } from "../store/useStore";
import { LKMM_CAT_FIXTURES } from "../cat/lkmmCatFixtures";
import RelationDefinitionsDialog from "./RelationDefinitionsDialog";
import RelationDefinitionsList from "./RelationDefinitionsList";

type ModelSidebarProps = {
  /**
   * Controls how the sidebar is laid out:
   * - `docked`: desktop layout inside the app shell.
   * - `drawer`: mobile off-canvas drawer (fixed width).
   */
  variant?: "docked" | "drawer";
  /**
   * Whether the sidebar is open (expanded).
   */
  open?: boolean;
  /**
   * Called to toggle the sidebar open/closed.
   */
  onToggleOpen?: () => void;
  /**
   * Called when the drawer should close (close button, Escape handlers upstream, etc.).
   * Only used when `variant="drawer"`.
   */
  onRequestClose?: () => void;
};

/**
 * Right-hand model configuration sidebar.
 *
 * Responsibilities:
 * - Upload and manage `.cat` model files in the store.
 * - Show the resolved relation definitions inline (always visible when expanded).
 * - Provide a full-screen dialog for definitions to preserve the existing affordance.
 */
const ModelSidebar = ({
  variant = "docked",
  open = true,
  onToggleOpen,
  onRequestClose,
}: ModelSidebarProps) => {
  const isDrawer = variant === "drawer";
  const [relationDialogOpen, setRelationDialogOpen] = useState(false);
  const catFileInputRef = useRef<HTMLInputElement | null>(null);

  const modelConfig = useStore((state) => state.modelConfig);
  const catModel = useStore((state) => state.catModel);
  const importCatFiles = useStore((state) => state.importCatFiles);
  const removeCatFile = useStore((state) => state.removeCatFile);
  const resetModelConfig = useStore((state) => state.resetModelConfig);

  /**
   * Imports user-chosen `.cat` files via the store so we can:
   * - analyze definitions and include resolution
   * - derive `modelConfig.relationTypes` from the uploaded model
   */
  const handleImportCatFiles = useCallback(
    async (files: FileList | File[] | null) => {
      if (!files || files.length === 0) {
        return;
      }
      await importCatFiles(files);
      if (catFileInputRef.current) {
        catFileInputRef.current.value = "";
      }
    },
    [importCatFiles]
  );

  /**
   * Loads the bundled LKMM `.cat` fixtures through the same import path as manual uploads.
   */
  const handleImportLkmmCats = useCallback(async () => {
    if (LKMM_CAT_FIXTURES.length === 0) {
      return;
    }

    const files = LKMM_CAT_FIXTURES.map(
      (fixture) => new File([fixture.text], fixture.name, { type: "text/plain" })
    );

    await handleImportCatFiles(files);
  }, [handleImportCatFiles]);

  const fileNames = Object.keys(catModel.filesByName)
    .slice()
    .sort((a, b) => a.localeCompare(b));

  return (
    <aside
      className={
        isDrawer
          ? `relative flex h-dvh w-[min(92vw,420px)] flex-col gap-4 overflow-y-auto border-l border-slate-200 bg-white p-3 text-sm text-slate-900 shadow-xl ring-1 ring-slate-900/10 transition-transform duration-200 sm:p-4 ${
              open ? "translate-x-0" : "translate-x-full pointer-events-none"
            }`
          : "relative flex h-full flex-none flex-col gap-4 overflow-hidden border-l border-slate-200 bg-white text-sm text-slate-900"
      }
      style={isDrawer ? undefined : { width: open ? 420 : 44 }}
      aria-hidden={isDrawer ? !open : undefined}
    >
      {open ? (
        <>
          <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-3 py-3 sm:px-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Model
            </div>
            <div className="flex items-center gap-2">
              {!isDrawer ? (
                <button
                  type="button"
                  className="inline-flex h-8 w-8 items-center justify-center rounded border border-slate-200 bg-white text-slate-700 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-1"
                  onClick={onToggleOpen}
                  aria-label="Collapse model sidebar"
                >
                  <ChevronRight className="h-4 w-4" aria-hidden="true" />
                </button>
              ) : (
                <button
                  type="button"
                  className="inline-flex h-8 w-8 items-center justify-center rounded border border-slate-200 bg-white text-slate-700 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-1"
                  onClick={onRequestClose}
                  aria-label="Close model sidebar"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              )}
            </div>
          </div>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 pb-4 sm:px-4">
            <div className="space-y-2">
              <div className="rounded border border-slate-200 bg-slate-50 px-2 py-2 text-xs text-slate-700">
                <div className="font-semibold">Relations</div>
                <div className="text-slate-500">
                  {modelConfig.relationTypes.length} type(s)
                </div>
              </div>

              <button
                type="button"
                className="w-full rounded border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-800"
                onClick={() => catFileInputRef.current?.click()}
              >
                Upload .cat File(s)
              </button>
              <input
                ref={catFileInputRef}
                type="file"
                accept=".cat"
                multiple
                className="hidden"
                onChange={(event) => void handleImportCatFiles(event.target.files)}
              />

              {fileNames.length ? (
                <div className="rounded border border-slate-200 bg-white">
                  <div className="border-b border-slate-200 px-2 py-1.5 text-[11px] font-semibold text-slate-600">
                    Loaded .cat files
                  </div>
                  <div className="divide-y divide-slate-100">
                    {fileNames.map((fileName) => (
                      <div
                        key={fileName}
                        className="flex items-center justify-between gap-2 px-2 py-1.5"
                      >
                        <div className="min-w-0 truncate text-xs text-slate-800">
                          {fileName}
                        </div>
                        <button
                          type="button"
                          className="inline-flex items-center justify-center rounded border border-slate-200 bg-white p-1.5 text-slate-700 hover:bg-slate-50"
                          aria-label={`Remove ${fileName}`}
                          onClick={() => removeCatFile(fileName)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {catModel.analysis?.missingIncludes.length ? (
                <div className="rounded border border-amber-200 bg-amber-50 px-2 py-2 text-xs text-amber-800">
                  Missing include file(s):{" "}
                  {catModel.analysis.missingIncludes.join(", ")}
                </div>
              ) : null}
              {catModel.analysis?.unresolvedNames.length ? (
                <div className="rounded border border-amber-200 bg-amber-50 px-2 py-2 text-xs text-amber-800">
                  Unresolved name(s):{" "}
                  {catModel.analysis.unresolvedNames.slice(0, 12).join(", ")}
                  {catModel.analysis.unresolvedNames.length > 12 ? "…" : ""}
                </div>
              ) : null}
              {catModel.error ? (
                <div className="text-xs text-red-600">{catModel.error}</div>
              ) : null}

              <button
                type="button"
                className="w-full rounded bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white"
                onClick={() => setRelationDialogOpen(true)}
              >
                View Relation Definitions
              </button>

              <div className="flex gap-2">
                <button
                  type="button"
                  className="flex-1 rounded border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-800"
                  onClick={resetModelConfig}
                >
                  Reset Model Config
                </button>
                <button
                  type="button"
                  className="flex-1 rounded border border-dashed border-slate-300 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={LKMM_CAT_FIXTURES.length === 0}
                  onClick={() => void handleImportLkmmCats()}
                >
                  LKMM
                </button>
              </div>
            </div>

            <div className="rounded border border-slate-200 bg-white">
              <div className="flex items-center justify-between border-b border-slate-200 px-2 py-1.5">
                <div className="text-[11px] font-semibold text-slate-600">
                  Relation definitions
                </div>
                <div className="text-[11px] text-slate-500">
                  {catModel.definitions.length} def(s)
                </div>
              </div>
              <div className="max-h-[45vh] overflow-y-auto p-2">
                <RelationDefinitionsList
                  definitions={catModel.definitions}
                  emptyState="Upload one or more `.cat` files to see definitions."
                />
              </div>
            </div>
          </div>

          <RelationDefinitionsDialog
            open={relationDialogOpen}
            definitions={catModel.definitions}
            onClose={() => setRelationDialogOpen(false)}
          />
        </>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-3">
          <button
            type="button"
            className="inline-flex h-9 w-9 items-center justify-center rounded border border-slate-200 bg-white text-slate-700 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-1"
            onClick={onToggleOpen}
            aria-label="Open model sidebar"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}
    </aside>
  );
};

export default ModelSidebar;

