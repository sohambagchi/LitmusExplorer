import { useMemo } from "react";

export type RelationDefinition = { name: string; fileName: string; body: string };

/**
 * Render relation definitions extracted from uploaded `.cat` files.
 *
 * Notes:
 * - Definitions are grouped by relation name, because `.cat` include chains can
 *   produce multiple definitions for the same relation (from different files).
 * - The UI is intentionally read-only: definitions are derived data from the
 *   store's analyzed `.cat` content.
 */
const RelationDefinitionsList = ({
  definitions,
  emptyState,
}: {
  definitions: RelationDefinition[];
  /**
   * Optional replacement text shown when there are no definitions.
   */
  emptyState?: string;
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

  if (grouped.length === 0) {
    return (
      <div className="text-sm text-slate-600">
        {emptyState ?? "Upload one or more `.cat` files to see definitions."}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {grouped.map(([name, items]) => (
        <div key={name} className="rounded-lg border border-slate-200 bg-white">
          <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
            <div className="font-mono text-xs font-semibold text-slate-900">
              {name}
            </div>
            <div className="text-[11px] text-slate-500">
              {items.length === 1 ? items[0]?.fileName : `${items.length} definitions`}
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
  );
};

export default RelationDefinitionsList;

