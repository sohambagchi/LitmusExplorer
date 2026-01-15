import type { MemoryVariable } from "../types";
import { resolvePointerTargetById } from "./resolvePointers";

export type StructMemberContext = {
  /**
   * The struct id whose members should be used for selection.
   *
   * This may be either:
   * - A concrete struct variable id (direct struct access / pointer-to-struct), or
   * - A struct template id referenced by an array-of-struct variable.
   */
  structId: string;
  /**
   * Non-struct member variables that belong to `structId`.
   */
  members: MemoryVariable[];
};

/**
 * Builds a struct-member context from a struct id.
 *
 * @param structId - Struct variable id whose members should be returned.
 * @param memoryEnv - Flat memory environment.
 * @returns Struct-member context, or `null` when the struct has no members.
 */
export const getStructMemberContextByStructId = ({
  structId,
  memoryEnv,
}: {
  structId: string;
  memoryEnv: MemoryVariable[];
}): StructMemberContext | null => {
  const members = memoryEnv.filter(
    (item) => item.parentId === structId && item.type !== "struct"
  );
  return members.length > 0 ? { structId, members } : null;
};

/**
 * Resolves the struct-member context for an addressed location.
 *
 * Supported cases:
 * - Direct struct access: `addressId` is a `struct` variable id.
 * - Pointer-to-struct access: `addressId` is a `ptr` resolving to a `struct`.
 * - Array-of-struct access: `addressId` resolves to an `array` configured with
 *   `elementType: "struct"` and a valid `elementStructId`.
 *
 * @param addressId - Operation address variable id (may be a ptr).
 * @param memoryEnv - Flat memory environment.
 * @param memoryById - Memory environment indexed by id.
 * @returns Struct-member context used for UI + label formatting, or `null` when
 *          the addressed location does not support struct members.
 */
export const resolveStructMemberContext = ({
  addressId,
  memoryEnv,
  memoryById,
}: {
  addressId: string | undefined;
  memoryEnv: MemoryVariable[];
  memoryById: Map<string, MemoryVariable>;
}): StructMemberContext | null => {
  if (!addressId) {
    return null;
  }

  const resolved = resolvePointerTargetById(addressId, memoryById).resolved;
  if (!resolved) {
    return null;
  }

  if (resolved.type === "struct") {
    return getStructMemberContextByStructId({ structId: resolved.id, memoryEnv });
  }

  if (
    resolved.type === "array" &&
    resolved.elementType === "struct" &&
    typeof resolved.elementStructId === "string" &&
    resolved.elementStructId.length > 0
  ) {
    return getStructMemberContextByStructId({
      structId: resolved.elementStructId,
      memoryEnv,
    });
  }

  return null;
};

/**
 * Formats the short (suffix) label for a struct member, suitable for appending
 * to an addressed base.
 *
 * Example: member `{ name: "next", id: "r0_next" }` -> `"next"`
 *
 * @param member - Struct member variable.
 * @returns Display label for the member.
 */
export const formatStructMemberName = (member: MemoryVariable): string => {
  const trimmed = member.name.trim();
  return trimmed ? trimmed : member.id;
};
