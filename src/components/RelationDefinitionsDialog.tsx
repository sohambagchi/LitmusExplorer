import { X } from "lucide-react";
import RelationDefinitionsList, {
  type RelationDefinition,
} from "./RelationDefinitionsList";

const RelationDefinitionsDialog = ({
  open,
  definitions,
  onClose,
}: {
  open: boolean;
  definitions: RelationDefinition[];
  onClose: () => void;
}) => {
  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      role="dialog"
      aria-modal="true"
      aria-label="Relation definitions"
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
            <div className="text-sm font-semibold text-slate-900">
              Relation definitions
            </div>
            <div className="text-xs text-slate-500">
              {definitions.length} definition(s) from uploaded .cat files
            </div>
          </div>
          <button
            type="button"
            className="inline-flex items-center justify-center rounded border border-slate-200 bg-white p-2 text-slate-700 hover:bg-slate-50"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto p-4">
          <RelationDefinitionsList definitions={definitions} />
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

export default RelationDefinitionsDialog;
