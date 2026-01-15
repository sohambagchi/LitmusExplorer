import type {
  BranchCondition,
  BranchGroupCondition,
  BranchRuleCondition,
  MemoryVariable,
} from "../types";
import { resolvePointerTargetById } from "./resolvePointers";

/**
 * Parses a branch-comparable value from a memory variable.
 *
 * Rules:
 * - `int` => numeric parse of `value`
 * - `array` => `size`
 * - `ptr` => the resolved target id (after following ptr chains)
 *
 * Branches in the UI support `==`, `!=`, and numeric comparisons. Pointer values
 * only participate in equality/inequality checks.
 */
const parseComparableValue = (
  variable: MemoryVariable | undefined,
  memoryById: Map<string, MemoryVariable>
): number | string | undefined => {
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
  if (variable.type === "ptr") {
    const resolved = resolvePointerTargetById(variable.id, memoryById).resolved;
    return resolved ? resolved.id : undefined;
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

  const lhs = parseComparableValue(
    rule.lhsId ? memoryById.get(rule.lhsId) : undefined,
    memoryById
  );
  const rhs = parseComparableValue(
    rule.rhsId ? memoryById.get(rule.rhsId) : undefined,
    memoryById
  );
  if (typeof lhs === "string" || typeof rhs === "string") {
    if (typeof lhs !== "string" || typeof rhs !== "string") {
      return false;
    }
    if (rule.op === "==") {
      return lhs === rhs;
    }
    if (rule.op === "!=") {
      return lhs !== rhs;
    }
    return false;
  }
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
