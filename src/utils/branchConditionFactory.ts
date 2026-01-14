import type { BranchGroupCondition, BranchRuleCondition } from "../types";

export const createConditionId = (prefix: "rule" | "group") =>
  `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

export const createBranchRuleCondition = (): BranchRuleCondition => ({
  kind: "rule",
  id: createConditionId("rule"),
  op: "==",
  evaluation: "natural",
});

export const createBranchGroupCondition = (): BranchGroupCondition => ({
  kind: "group",
  id: createConditionId("group"),
  items: [createBranchRuleCondition()],
  operators: [],
});
