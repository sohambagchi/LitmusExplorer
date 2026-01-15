import type {
  BranchCondition,
  BranchGroupCondition,
  BranchRuleCondition,
  ComparisonOp,
  LogicalOp,
  RuleEvaluation,
} from "../types";
import { ChevronDown, ChevronUp, Trash2 } from "lucide-react";
import {
  createBranchGroupCondition,
  createBranchRuleCondition,
  createConditionId,
} from "../utils/branchConditionFactory";

type MemoryOption = {
  value: string;
  label: string;
};

const COMPARISON_OPS: { value: ComparisonOp; label: string }[] = [
  { value: "==", label: "==" },
  { value: "!=", label: "!=" },
  { value: "<", label: "<" },
  { value: "<=", label: "<=" },
  { value: ">", label: ">" },
  { value: ">=", label: ">=" },
];

const LOGICAL_OPS: { value: LogicalOp; label: string }[] = [
  { value: "&&", label: "&&" },
  { value: "||", label: "||" },
];

const EVALUATIONS: { value: RuleEvaluation; label: string }[] = [
  { value: "natural", label: "Natural" },
  { value: "true", label: "True" },
  { value: "false", label: "False" },
];

const ICON_BUTTON_CLASS =
  "inline-flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-1";

const ICON_DANGER_BUTTON_CLASS =
  "inline-flex h-7 w-7 items-center justify-center rounded border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400 focus-visible:ring-offset-1";

const updateGroupById = (
  root: BranchGroupCondition,
  groupId: string,
  updater: (group: BranchGroupCondition) => BranchGroupCondition
): BranchGroupCondition => {
  if (root.id === groupId) {
    return updater(root);
  }

  const nextItems = root.items.map((item) => {
    if (item.kind === "group") {
      return updateGroupById(item, groupId, updater);
    }
    return item;
  });

  return { ...root, items: nextItems };
};

const removeItemAt = <T,>(items: T[], index: number) => [
  ...items.slice(0, index),
  ...items.slice(index + 1),
];

const swapItems = <T,>(items: T[], a: number, b: number) => {
  const next = [...items];
  const temp = next[a];
  next[a] = next[b];
  next[b] = temp;
  return next;
};

const normalizeOperators = (items: BranchCondition[], operators: LogicalOp[]) => {
  const needed = Math.max(0, items.length - 1);
  const next = operators.slice(0, needed);
  while (next.length < needed) {
    next.push("&&");
  }
  return next;
};

const BranchConditionEditor = ({
  memoryOptions,
  value,
  onChange,
}: {
  memoryOptions: MemoryOption[];
  value: BranchGroupCondition | undefined;
  onChange: (next: BranchGroupCondition) => void;
}) => {
  if (!value) {
    return (
      <button
        type="button"
        className="w-full rounded bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white"
        onClick={() => onChange(createBranchGroupCondition())}
      >
        Add Rule
      </button>
    );
  }

  return (
    <GroupEditor
      memoryOptions={memoryOptions}
      root={value}
      group={value}
      depth={0}
      onChange={onChange}
    />
  );
};

const GroupEditor = ({
  memoryOptions,
  root,
  group,
  depth,
  onChange,
}: {
  memoryOptions: MemoryOption[];
  root: BranchGroupCondition;
  group: BranchGroupCondition;
  depth: number;
  onChange: (next: BranchGroupCondition) => void;
}) => {
  const applyToGroup = (
    groupId: string,
    updater: (group: BranchGroupCondition) => BranchGroupCondition
  ) => onChange(updateGroupById(root, groupId, updater));

  const handleAddRule = (groupId: string) => {
    applyToGroup(groupId, (group) => {
      const nextItems = [...group.items, createBranchRuleCondition()];
      const nextOperators = normalizeOperators(nextItems, group.operators);
      return { ...group, items: nextItems, operators: nextOperators };
    });
  };

  const handleAddGroup = (groupId: string) => {
    applyToGroup(groupId, (group) => {
      const nextItems = [...group.items, createBranchGroupCondition()];
      const nextOperators = normalizeOperators(nextItems, group.operators);
      return { ...group, items: nextItems, operators: nextOperators };
    });
  };

  const handleDeleteItem = (groupId: string, itemIndex: number) => {
    applyToGroup(groupId, (group) => {
      const nextItems = removeItemAt(group.items, itemIndex);
      const nextOperators = normalizeOperators(nextItems, group.operators);
      return { ...group, items: nextItems, operators: nextOperators };
    });
  };

  const handleMoveItem = (groupId: string, itemIndex: number, delta: number) => {
    applyToGroup(groupId, (group) => {
      const nextIndex = itemIndex + delta;
      if (nextIndex < 0 || nextIndex >= group.items.length) {
        return group;
      }
      const nextItems = swapItems(group.items, itemIndex, nextIndex);
      return { ...group, items: nextItems };
    });
  };

  const handleUpdateOperator = (
    groupId: string,
    operatorIndex: number,
    nextValue: LogicalOp
  ) => {
    applyToGroup(groupId, (group) => {
      const nextOperators = [...group.operators];
      nextOperators[operatorIndex] = nextValue;
      return { ...group, operators: normalizeOperators(group.items, nextOperators) };
    });
  };

  const handleUpdateRule = (
    groupId: string,
    ruleIndex: number,
    updates: Partial<Omit<BranchRuleCondition, "kind" | "id">>
  ) => {
    applyToGroup(groupId, (group) => {
      const current = group.items[ruleIndex];
      if (!current || current.kind !== "rule") {
        return group;
      }

      const nextItems = [...group.items];
      nextItems[ruleIndex] = { ...current, ...updates };
      return { ...group, items: nextItems };
    });
  };

  const handleGroupPair = (groupId: string, operatorIndex: number) => {
    applyToGroup(groupId, (group) => {
      const leftIndex = operatorIndex;
      const rightIndex = operatorIndex + 1;
      const left = group.items[leftIndex];
      const right = group.items[rightIndex];
      const betweenOp = group.operators[operatorIndex] ?? "&&";
      if (!left || !right) {
        return group;
      }

      const wrapped: BranchGroupCondition = {
        kind: "group",
        id: createConditionId("group"),
        items: [left, right],
        operators: [betweenOp],
      };

      const nextItems = [
        ...group.items.slice(0, leftIndex),
        wrapped,
        ...group.items.slice(rightIndex + 1),
      ];
      const nextOperators = [
        ...group.operators.slice(0, operatorIndex),
        ...group.operators.slice(operatorIndex + 1),
      ];

      return {
        ...group,
        items: nextItems,
        operators: normalizeOperators(nextItems, nextOperators),
      };
    });
  };

  const handleUngroup = (groupId: string, itemIndex: number) => {
    applyToGroup(groupId, (group) => {
      const current = group.items[itemIndex];
      if (!current || current.kind !== "group") {
        return group;
      }

      const beforeItems = group.items.slice(0, itemIndex);
      const afterItems = group.items.slice(itemIndex + 1);
      const beforeOps = group.operators.slice(0, Math.max(0, itemIndex - 1));
      const opBefore =
        itemIndex > 0 ? group.operators[itemIndex - 1] ?? "&&" : null;
      const opAfter =
        itemIndex < group.operators.length ? group.operators[itemIndex] ?? "&&" : null;
      const afterOps = group.operators.slice(itemIndex + 1);

      const nextItems = [...beforeItems, ...current.items, ...afterItems];

      const nextOperators: LogicalOp[] = [...beforeOps];
      if (opBefore && current.items.length > 0) {
        nextOperators.push(opBefore);
      }
      nextOperators.push(...current.operators);
      if (opAfter && afterItems.length > 0 && current.items.length > 0) {
        nextOperators.push(opAfter);
      }
      nextOperators.push(...afterOps);

      return {
        ...group,
        items: nextItems,
        operators: normalizeOperators(nextItems, nextOperators),
      };
    });
  };

  const isRoot = depth === 0;

  return (
    <div
      className={
        isRoot ? "space-y-2" : "space-y-2 border-l-2 border-slate-200 pl-3"
      }
    >
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs font-semibold text-slate-700">
          {isRoot ? "Rules" : "Group"}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-800"
            onClick={() => handleAddRule(group.id)}
          >
            + Rule
          </button>
          <button
            type="button"
            className="rounded bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-800"
            onClick={() => handleAddGroup(group.id)}
          >
            + Group
          </button>
        </div>
      </div>

      <div className="min-w-0 space-y-2">
          {group.items.length === 0 ? (
            <div className="text-xs text-slate-500">No rules yet.</div>
          ) : null}

          {group.items.map((item, index) => {
            const operatorIndex = index - 1;

            return (
              <div key={item.id} className="space-y-2">
                {index > 0 ? (
                  <div className="flex items-center gap-2">
                    <select
                      className="w-24 rounded border border-slate-300 px-2 py-1 text-xs"
                      value={group.operators[operatorIndex] ?? "&&"}
                      onChange={(event) =>
                        handleUpdateOperator(
                          group.id,
                          operatorIndex,
                          event.target.value as LogicalOp
                        )
                      }
                    >
                      {LOGICAL_OPS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="rounded bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-800"
                      onClick={() => handleGroupPair(group.id, operatorIndex)}
                    >
                      ( )
                    </button>
                  </div>
                ) : null}

                <div className="space-y-2">
                  {item.kind === "rule" ? (
                    <div className="flex items-center gap-2 rounded border border-slate-200 bg-white p-2">
                      <select
                        className="w-48 min-w-0 rounded border border-slate-300 px-2 py-1 text-xs"
                        value={item.lhsId ?? ""}
                        onChange={(event) =>
                          handleUpdateRule(group.id, index, {
                            lhsId: event.target.value || undefined,
                          })
                        }
                      >
                        <option value="">LHS</option>
                        {memoryOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                      <select
                        className="w-20 rounded border border-slate-300 px-2 py-1 text-xs"
                        value={item.op}
                        onChange={(event) =>
                          handleUpdateRule(group.id, index, {
                            op: event.target.value as ComparisonOp,
                          })
                        }
                      >
                        {COMPARISON_OPS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                      <select
                        className="w-48 min-w-0 rounded border border-slate-300 px-2 py-1 text-xs"
                        value={item.rhsId ?? ""}
                        onChange={(event) =>
                          handleUpdateRule(group.id, index, {
                            rhsId: event.target.value || undefined,
                          })
                        }
                      >
                        <option value="">RHS</option>
                        {memoryOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                      <select
                        className="w-28 rounded border border-slate-300 px-2 py-1 text-xs"
                        value={item.evaluation}
                        onChange={(event) =>
                          handleUpdateRule(group.id, index, {
                            evaluation: event.target.value as RuleEvaluation,
                          })
                        }
                      >
                        {EVALUATIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          className={ICON_BUTTON_CLASS}
                          onClick={() => handleMoveItem(group.id, index, -1)}
                          disabled={index === 0}
                          aria-label="Move rule up"
                          title="Move up"
                        >
                          <ChevronUp className="h-4 w-4" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className={ICON_BUTTON_CLASS}
                          onClick={() => handleMoveItem(group.id, index, 1)}
                          disabled={index === group.items.length - 1}
                          aria-label="Move rule down"
                          title="Move down"
                        >
                          <ChevronDown className="h-4 w-4" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className={ICON_DANGER_BUTTON_CLASS}
                          onClick={() => handleDeleteItem(group.id, index)}
                          aria-label="Delete rule"
                          title="Delete"
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="rounded border border-slate-200 bg-white p-2">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <div className="text-xs font-semibold text-slate-700">
                          Group
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            className="rounded bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-800"
                            onClick={() => handleUngroup(group.id, index)}
                          >
                            Ungroup
                          </button>
                          <button
                            type="button"
                            className={ICON_BUTTON_CLASS}
                            onClick={() => handleMoveItem(group.id, index, -1)}
                            disabled={index === 0}
                            aria-label="Move group up"
                            title="Move up"
                          >
                            <ChevronUp className="h-4 w-4" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className={ICON_BUTTON_CLASS}
                            onClick={() => handleMoveItem(group.id, index, 1)}
                            disabled={index === group.items.length - 1}
                            aria-label="Move group down"
                            title="Move down"
                          >
                            <ChevronDown className="h-4 w-4" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className={ICON_DANGER_BUTTON_CLASS}
                            onClick={() => handleDeleteItem(group.id, index)}
                            aria-label="Delete group"
                            title="Delete"
                          >
                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                          </button>
                        </div>
                      </div>

                      <GroupEditor
                        memoryOptions={memoryOptions}
                        root={root}
                        group={item}
                        depth={depth + 1}
                        onChange={onChange}
                      />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );
};

export default BranchConditionEditor;
