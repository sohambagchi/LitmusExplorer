import { useMemo } from "react";
import { X } from "lucide-react";

type RelationDefinition = { name: string; fileName: string; body: string };

const RelationDefinitionsDialog = ({
  open,
  definitions,
  onClose,
}: {
  open: boolean;
  definitions: RelationDefinition[];
  onClose: () => void;
}) => {
  const grouped = useMemo(() => {
    const byName = new Map<string, RelationDefinition[]>();
    for (const definition of definitions) {
      const current = byName.get(definition.name) ?? [];
      current.push(definition);
      byName.set(definition.name, current);
    }
    return Array.from(byName.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [definitions]);

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
          {grouped.length === 0 ? (
            <div className="text-sm text-slate-600">
              Upload one or more `.cat` files to see definitions.
            </div>
          ) : (
            <div className="space-y-4">
              {grouped.map(([name, items]) => (
                <div
                  key={name}
                  className="rounded-lg border border-slate-200 bg-white"
                >
                  <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
                    <div className="font-mono text-xs font-semibold text-slate-900">
                      {name}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      {items.length === 1
                        ? items[0]?.fileName
                        : `${items.length} definitions`}
                    </div>
                  </div>
                  <div className="space-y-3 p-3">
                    {items.map((definition, index) => (
                      <div key={`${definition.fileName}:${index}`} className="space-y-1">
                        {items.length > 1 ? (
                          <div className="text-[11px] font-semibold text-slate-600">
                            {definition.fileName}
                          </div>
                        ) : null}
                        <pre className="overflow-x-auto rounded bg-slate-50 p-2 text-[11px] leading-relaxed text-slate-900">
                          <code>{`let ${definition.name} = ${definition.body}`}</code>
                        </pre>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
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

