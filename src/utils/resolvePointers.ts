import type { MemoryVariable } from "../types";

export type ResolvedPointerTarget = {
  /**
   * The first variable referenced (before following any ptr indirections).
   */
  base: MemoryVariable | undefined;
  /**
   * The final resolved variable after following ptr chains.
   * Falls back to `base` if resolution fails or cycles.
   */
  resolved: MemoryVariable | undefined;
  /**
   * True if the `base` variable was a ptr.
   */
  viaPointer: boolean;
};

/**
 * Resolves a memory variable id through ptr indirections.
 *
 * This is used for:
 * - Displaying and constraining per-location relations (`rf`/`co`/`fr`) based on the
 *   effective memory location, not the intermediate pointer register.
 * - Detecting array addressing when an op uses a pointer-to-array as its base address.
 *
 * Safety:
 * - Cycles are allowed in the UI (e.g. a ptr can point to itself), so we cap traversal
 *   and stop on repeats to avoid infinite loops.
 *
 * @param id - Memory variable id to resolve.
 * @param memoryById - All memory variables indexed by id.
 * @returns The base variable + the resolved effective target.
 */
export const resolvePointerTargetById = (
  id: string | undefined,
  memoryById: Map<string, MemoryVariable>,
  { maxDepth = 16 }: { maxDepth?: number } = {}
): ResolvedPointerTarget => {
  const base = id ? memoryById.get(id) : undefined;
  if (!base) {
    return { base: undefined, resolved: undefined, viaPointer: false };
  }

  if (base.type !== "ptr") {
    return { base, resolved: base, viaPointer: false };
  }

  const visited = new Set<string>();
  let current: MemoryVariable | undefined = base;
  let depth = 0;

  while (current && current.type === "ptr") {
    if (visited.has(current.id)) {
      return { base, resolved: current, viaPointer: true };
    }
    visited.add(current.id);
    if (depth >= maxDepth) {
      return { base, resolved: current, viaPointer: true };
    }
    depth += 1;

    const nextId = current.pointsToId;
    if (!nextId) {
      return { base, resolved: current, viaPointer: true };
    }
    const next = memoryById.get(nextId);
    if (!next) {
      return { base, resolved: current, viaPointer: true };
    }
    current = next;
  }

  return { base, resolved: current, viaPointer: true };
};

