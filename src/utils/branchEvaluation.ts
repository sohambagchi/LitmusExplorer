import type {
  BranchCondition,
  BranchGroupCondition,
  BranchRuleCondition,
  MemoryVariable,
} from "../types";

const parseMemoryNumericValue = (variable: MemoryVariable | undefined) => {
  if (!variable) {
    return undefined;
  }
  if (variable.type === "int") {
    const raw = variable.value ?? "";
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (variable.type === "array") {
    return typeof variable.size === "number" && Number.isFinite(variable.size)
      ? variable.size
      : undefined;
  }
  return undefined;
};

const evaluateRule = (
  rule: BranchRuleCondition,
  memoryById: Map<string, MemoryVariable>
) => {
  if (rule.evaluation === "true") {
    return true;
  }
  if (rule.evaluation === "false") {
    return false;
  }

  const lhs = parseMemoryNumericValue(
    rule.lhsId ? memoryById.get(rule.lhsId) : undefined
  );
  const rhs = parseMemoryNumericValue(
    rule.rhsId ? memoryById.get(rule.rhsId) : undefined
  );
  if (typeof lhs !== "number" || typeof rhs !== "number") {
    return false;
  }

  switch (rule.op) {
    case "==":
      return lhs === rhs;
    case "!=":
      return lhs !== rhs;
    case "<":
      return lhs < rhs;
    case "<=":
      return lhs <= rhs;
    case ">":
      return lhs > rhs;
    case ">=":
      return lhs >= rhs;
  }
};

const evaluateCondition = (
  condition: BranchCondition,
  memoryById: Map<string, MemoryVariable>
): boolean => {
  if (condition.kind === "rule") {
    return evaluateRule(condition, memoryById);
  }

  if (condition.items.length === 0) {
    return false;
  }

  let result = evaluateCondition(condition.items[0], memoryById);
  for (let index = 1; index < condition.items.length; index += 1) {
    const op = condition.operators[index - 1] ?? "&&";
    const next = evaluateCondition(condition.items[index], memoryById);

    if (op === "&&") {
      result = result && next;
      continue;
    }

    result = result || next;
  }

  return result;
};

export const evaluateBranchCondition = (
  root: BranchGroupCondition,
  memoryEnv: MemoryVariable[]
) => evaluateCondition(root, new Map(memoryEnv.map((item) => [item.id, item])));

