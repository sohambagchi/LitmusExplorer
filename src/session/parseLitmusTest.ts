import type {
  BranchCondition,
  BranchGroupCondition,
  BranchRuleCondition,
  ComparisonOp,
  LogicalOp,
  MemoryVariable,
  Operation,
  RelationEdge,
  TraceNode,
} from "../types";
import { DEFAULT_MODEL_CONFIG } from "../config/defaultModelConfig";
import { createSessionSnapshot } from "./createSessionSnapshot";
import { createConditionId } from "../utils/branchConditionFactory";

const LANE_WIDTH = 260;
const GRID_Y = 80;
const DEFAULT_MEMORY_VALUE = "0";

/**
 * Litmus tests in herdtools7 generally encode thread code as a pipe-delimited table
 * with headers like `P0 | P1`.
 *
 * This importer aims to:
 * - detect threads and instruction sequences
 * - detect shared memory locations (e.g. `[x]`) and registers (e.g. `EAX`)
 * - translate basic loads/stores/fences into a Litmus Explorer session snapshot
 *
 * Notes:
 * - The full herdtools grammar is quite large (multiple architectures + macros).
 * - This parser is intentionally heuristic-based: it covers common patterns and
 *   falls back to rendering instructions as text when it cannot infer semantics.
 */

type LitmusParseOptions = {
  /**
   * Optional title to use when the litmus header is missing or unhelpful.
   */
  fallbackTitle?: string;
};

type LitmusHeader = {
  arch: string;
  name: string;
};

type ThreadColumn = {
  threadIndex: number;
  threadId: string;
  label: string;
};

type ParsedInstruction = {
  operation: Operation;
  memoryLocations: string[];
  registers: string[];
  /**
   * Destination register name for load-like instructions (e.g. `MOV EAX,[x]`).
   * Used later to resolve `operation.resultId` once locals are created.
   */
  loadResultRegister?: string;
  /**
   * Source register name for store-like instructions (e.g. `MOV [x],EAX`).
   * Used later to resolve `operation.valueId` once locals are created.
   */
  storeValueRegister?: string;
  /**
   * Raw condition text for C/LKMM-style `if (...)` statements.
   *
   * The parser defers building a `branchCondition` until after it has created
   * memory ids for locals/constants.
   */
  branchConditionText?: string;
  /**
   * When present, marks this instruction as belonging to a branch path.
   *
   * Notes:
   * - `branchSequenceIndex` refers to the `sequenceIndex` of the BRANCH node.
   * - This is used to populate `TraceNodeData.branchId`/`branchPath` so the UI
   *   can selectively show/hide nodes under a branch.
   */
  branchContext?: { branchSequenceIndex: number; path: "then" | "else" };
};

/**
 * Returns the center X coordinate (in litmus-space) for the given lane index.
 *
 * This must stay in sync with the lane layout logic in:
 * - `src/components/EditorCanvas.tsx`
 * - `src/store/useStore.ts`
 */
const getLaneX = (index: number) => index * LANE_WIDTH + LANE_WIDTH / 2;

/**
 * Remove the most common multi-line comment style used in herdtools litmus tests: `(* ... *)`.
 *
 * @param input - Raw file content.
 * @returns Text with block comments removed.
 */
const stripBlockComments = (input: string) => input.replace(/\(\*[\s\S]*?\*\)/g, "");

/**
 * Strips single-line comments while avoiding immediate syntaxes like `#1` used by some ISAs.
 *
 * Currently removes:
 * - `// ...`
 *
 * @param line - Source line.
 * @returns Line with comments removed.
 */
const stripLineComments = (line: string) => line.replace(/\/\/.*$/g, "");

/**
 * Removes a trailing semicolon used by many catalogue tests to terminate table rows.
 *
 * @param value - Raw cell or line content.
 * @returns Trimmed string with a single trailing `;` removed.
 */
const stripTrailingSemicolon = (value: string) => value.replace(/;\s*$/g, "").trim();

/**
 * Splits a thread table row by `|` and trims each cell.
 *
 * @param line - Raw row line.
 * @returns Array of trimmed cell strings.
 */
const splitPipeRow = (line: string) =>
  stripTrailingSemicolon(line)
    .split("|")
    .map((cell) => cell.trim());

/**
 * Attempts to parse the header line `<ARCH> <NAME>`.
 *
 * Example: `X86 MP`
 *
 * @param line - First non-empty line of the file.
 * @returns Parsed header info.
 */
const parseHeaderLine = (line: string): LitmusHeader => {
  const trimmed = line.trim();
  const match = /^(\S+)\s+(.+)$/.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid litmus header line: expected "<ARCH> <NAME>".`);
  }
  return { arch: match[1].trim(), name: match[2].trim() };
};

/**
 * Extract the first `{ ... }` block from the file, returning the raw contents and the index
 * of the line where the block ends.
 *
 * Notes:
 * - herdtools tests often have an empty block: `{ }` or `{\\n}`.
 * - We only extract the first top-level block; it conventionally holds initial values.
 *
 * @param lines - Preprocessed file lines.
 * @param startIndex - Line index to begin searching from.
 * @returns Block content and ending line index.
 */
const extractBraceBlock = (lines: string[], startIndex: number) => {
  let depth = 0;
  let started = false;
  let content = "";

  for (let i = startIndex; i < lines.length; i += 1) {
    const line = lines[i];
    for (let j = 0; j < line.length; j += 1) {
      const char = line[j];
      if (char === "{") {
        depth += 1;
        if (!started) {
          started = true;
          continue;
        }
      }
      if (char === "}") {
        depth -= 1;
        if (started && depth === 0) {
          return { content, endIndex: i };
        }
      }
      if (started && depth >= 1) {
        content += char;
      }
    }
    if (started) {
      content += "\n";
    }
  }

  throw new Error(`Missing closing '}' for initial-state block.`);
};

/**
 * Parses initial values declared inside the `{ ... }` block.
 *
 * Supported patterns (heuristic):
 * - `x=0`
 * - `int x=0`
 * - `0:EAX=0` (thread-scoped register init)
 *
 * @param block - Contents of the initial-state block.
 * @returns Maps of initial values for shared locations and per-thread registers.
 */
const parseInitBlock = (block: string) => {
  const shared = new Map<string, string>();
  const localsByThread = new Map<number, Map<string, string>>();

  const statements = block
    .split(/[\n;]/)
    .map((item) => item.trim())
    .filter(Boolean);

  for (const statement of statements) {
    const threadScoped = /^(\d+)\s*:\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.+)$/.exec(
      statement
    );
    if (threadScoped) {
      const threadIndex = Number(threadScoped[1]);
      const name = threadScoped[2].trim();
      const value = threadScoped[3].trim();
      if (!localsByThread.has(threadIndex)) {
        localsByThread.set(threadIndex, new Map());
      }
      localsByThread.get(threadIndex)?.set(name, value);
      continue;
    }

    const genericAssign = /([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.+)$/.exec(statement);
    if (!genericAssign) {
      continue;
    }
    const name = genericAssign[1].trim();
    const value = genericAssign[2].trim();
    shared.set(name, value);
  }

  return { shared, localsByThread };
};

/**
 * Parses a `locations [...]` line (when present).
 *
 * Example: `locations [x; y]`
 *
 * @param line - Raw line.
 * @returns Array of location names, or empty when the line doesn't match.
 */
const parseLocationsLine = (line: string) => {
  const match = /^\s*locations\s*\[(.+)\]\s*$/i.exec(stripTrailingSemicolon(line));
  if (!match) {
    return [];
  }
  return match[1]
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
};

/**
 * Extracts symbolic memory locations that appear within `[...]`.
 *
 * In catalogue tests, shared memory locations are typically written as `[x]`, `[y]`, etc.
 *
 * @param value - Raw instruction string.
 * @returns Normalized list of identifiers extracted from bracket contents.
 */
const extractBracketLocations = (value: string) => {
  const matches = [...value.matchAll(/\[([^\]]+)\]/g)];
  const out: string[] = [];
  for (const match of matches) {
    const inside = match[1].trim();
    const idMatch = /[A-Za-z_][A-Za-z0-9_.-]*/.exec(inside);
    if (idMatch) {
      out.push(idMatch[0]);
    }
  }
  return out;
};

/**
 * Parses a literal immediate value.
 *
 * Supports common syntaxes:
 * - `$1` (x86 herdtools style)
 * - `#1` (ARM-ish)
 * - `0x10`
 * - `42`
 *
 * @param value - Raw token.
 * @returns Parsed integer value, or `null` when not a simple integer.
 */
const parseImmediateInt = (value: string) => {
  const trimmed = value.trim().replace(/^[$#]/, "");
  if (/^-?\d+$/.test(trimmed)) {
    const parsed = Number(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (/^0x[0-9a-f]+$/i.test(trimmed)) {
    const parsed = Number.parseInt(trimmed, 16);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

/**
 * Token type used for parsing C-like boolean expressions inside `if (...)`.
 */
type ConditionToken =
  | { kind: "ident"; value: string }
  | { kind: "number"; value: string }
  | { kind: "op"; value: string }
  | { kind: "paren"; value: "(" | ")" };

type ConditionAst =
  | { kind: "ident"; name: string }
  | { kind: "number"; value: string }
  | { kind: "unary"; op: "!"; expr: ConditionAst }
  | {
      kind: "binary";
      op: "&&" | "||" | "==" | "!=" | "<" | "<=" | ">" | ">=";
      left: ConditionAst;
      right: ConditionAst;
    };

/**
 * Tokenize a minimal subset of C boolean expressions used in LKMM litmus tests.
 *
 * Supported tokens:
 * - identifiers: `r0`, `EAX`, `x`
 * - integers: `0`, `-1`, `0x10`
 * - operators: `==`, `!=`, `<`, `<=`, `>`, `>=`, `&&`, `||`, `!`
 * - parentheses: `(`, `)`
 *
 * @param input - Condition expression text.
 * @returns Token list.
 */
const tokenizeCondition = (input: string): ConditionToken[] => {
  const tokens: ConditionToken[] = [];
  let i = 0;

  const isIdentStart = (ch: string) => /[A-Za-z_]/.test(ch);
  const isIdent = (ch: string) => /[A-Za-z0-9_]/.test(ch);
  const isDigit = (ch: string) => /[0-9]/.test(ch);

  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    if (ch === "(" || ch === ")") {
      tokens.push({ kind: "paren", value: ch });
      i += 1;
      continue;
    }

    const two = input.slice(i, i + 2);
    if (two === "&&" || two === "||" || two === "==" || two === "!=" || two === "<=" || two === ">=") {
      tokens.push({ kind: "op", value: two });
      i += 2;
      continue;
    }

    if (ch === "<" || ch === ">" || ch === "!") {
      tokens.push({ kind: "op", value: ch });
      i += 1;
      continue;
    }

    // Numbers (supports leading '-' and hex `0x..`).
    if (ch === "-" || isDigit(ch)) {
      let start = i;
      if (ch === "-") {
        i += 1;
      }
      if (input.slice(i, i + 2).toLowerCase() === "0x") {
        i += 2;
        while (i < input.length && /[0-9a-f]/i.test(input[i])) {
          i += 1;
        }
        tokens.push({ kind: "number", value: input.slice(start, i) });
        continue;
      }
      while (i < input.length && isDigit(input[i])) {
        i += 1;
      }
      tokens.push({ kind: "number", value: input.slice(start, i) });
      continue;
    }

    if (isIdentStart(ch)) {
      const start = i;
      i += 1;
      while (i < input.length && isIdent(input[i])) {
        i += 1;
      }
      tokens.push({ kind: "ident", value: input.slice(start, i) });
      continue;
    }

    // Skip unrecognized characters (keeps the parser robust to odd spacing/macros).
    i += 1;
  }

  return tokens;
};

/**
 * Recursive-descent parser for the minimal condition grammar.
 */
const parseConditionAst = (tokens: ConditionToken[]): ConditionAst => {
  let index = 0;

  const peek = () => tokens[index];
  const consume = () => tokens[index++];

  const parsePrimary = (): ConditionAst => {
    const token = peek();
    if (!token) {
      return { kind: "number", value: "0" };
    }
    if (token.kind === "op" && token.value === "!") {
      consume();
      return { kind: "unary", op: "!", expr: parsePrimary() };
    }
    if (token.kind === "paren" && token.value === "(") {
      consume();
      const expr = parseOr();
      const closing = peek();
      if (closing?.kind === "paren" && closing.value === ")") {
        consume();
      }
      return expr;
    }
    if (token.kind === "ident") {
      consume();
      return { kind: "ident", name: token.value };
    }
    if (token.kind === "number") {
      consume();
      return { kind: "number", value: token.value };
    }
    consume();
    return { kind: "number", value: "0" };
  };

  const parseComparison = (): ConditionAst => {
    const left = parsePrimary();
    const token = peek();
    if (token?.kind === "op") {
      const op = token.value;
      if (op === "==" || op === "!=" || op === "<" || op === "<=" || op === ">" || op === ">=") {
        consume();
        const right = parsePrimary();
        return {
          kind: "binary",
          op: op as "==" | "!=" | "<" | "<=" | ">" | ">=",
          left,
          right,
        };
      }
    }
    return left;
  };

  const parseAnd = (): ConditionAst => {
    let node = parseComparison();
    while (true) {
      const token = peek();
      if (token?.kind === "op" && token.value === "&&") {
        consume();
        const rhs = parseComparison();
        node = { kind: "binary", op: "&&", left: node, right: rhs };
        continue;
      }
      break;
    }
    return node;
  };

  const parseOr = (): ConditionAst => {
    let node = parseAnd();
    while (true) {
      const token = peek();
      if (token?.kind === "op" && token.value === "||") {
        consume();
        const rhs = parseAnd();
        node = { kind: "binary", op: "||", left: node, right: rhs };
        continue;
      }
      break;
    }
    return node;
  };

  const result = parseOr();
  // Ignore trailing tokens (best-effort parsing).
  void index;
  return result;
};

/**
 * Converts a parsed condition AST into a BranchCondition tree.
 *
 * The mapping is best-effort:
 * - comparisons become leaf rules
 * - `&&`/`||` become groups
 * - bare identifiers become `ident != 0` (C truthiness)
 * - unary `!ident` becomes `ident == 0`
 */
const buildBranchConditionFromAst = ({
  ast,
  resolveOperandId,
  ensureConstantIntId,
}: {
  ast: ConditionAst;
  resolveOperandId: (operand: ConditionAst) => string | undefined;
  ensureConstantIntId: (literal: string) => string;
}): BranchCondition => {
  const createRule = ({
    lhs,
    rhs,
    op,
  }: {
    lhs: string | undefined;
    rhs: string | undefined;
    op: ComparisonOp;
  }): BranchRuleCondition => ({
    kind: "rule",
    id: createConditionId("rule"),
    lhsId: lhs,
    rhsId: rhs,
    op,
    evaluation: "natural",
  });

  const createGroup = ({
    items,
    operators,
  }: {
    items: BranchCondition[];
    operators: LogicalOp[];
  }): BranchGroupCondition => ({
    kind: "group",
    id: createConditionId("group"),
    items,
    operators,
  });

  if (ast.kind === "binary") {
    if (ast.op === "&&" || ast.op === "||") {
      const op = ast.op as LogicalOp;
      const flatten = (node: ConditionAst): ConditionAst[] => {
        if (node.kind === "binary" && node.op === ast.op) {
          return [...flatten(node.left), ...flatten(node.right)];
        }
        return [node];
      };
      const parts = flatten(ast);
      return createGroup({
        items: parts.map((part) =>
          buildBranchConditionFromAst({ ast: part, resolveOperandId, ensureConstantIntId })
        ),
        operators: Array.from({ length: Math.max(0, parts.length - 1) }, () => op),
      });
    }

    const lhsId = resolveOperandId(ast.left);
    const rhsId = resolveOperandId(ast.right);
    return createRule({ lhs: lhsId, rhs: rhsId, op: ast.op as ComparisonOp });
  }

  if (ast.kind === "unary" && ast.op === "!") {
    // Support `!ident` as `ident == 0`.
    if (ast.expr.kind === "ident") {
      const lhsId = resolveOperandId(ast.expr);
      const rhsId = ensureConstantIntId("0");
      return createRule({ lhs: lhsId, rhs: rhsId, op: "==" });
    }
    return buildBranchConditionFromAst({ ast: ast.expr, resolveOperandId, ensureConstantIntId });
  }

  if (ast.kind === "ident") {
    const lhsId = resolveOperandId(ast);
    const rhsId = ensureConstantIntId("0");
    return createRule({ lhs: lhsId, rhs: rhsId, op: "!=" });
  }

  if (ast.kind === "number") {
    const lhsId = ensureConstantIntId(ast.value);
    const rhsId = ensureConstantIntId("0");
    return createRule({ lhs: lhsId, rhs: rhsId, op: "!=" });
  }

  const fallbackZero = ensureConstantIntId("0");
  return createRule({ lhs: fallbackZero, rhs: fallbackZero, op: "==" });
};

/**
 * Normalizes an identifier into a stable id suffix.
 *
 * @param raw - Raw token.
 * @returns Lowercased, id-safe suffix.
 */
const toIdToken = (raw: string) => raw.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");

/**
 * Parses a single instruction cell into a Litmus Explorer `Operation`.
 *
 * This is heuristic-based and currently recognizes:
 * - x86 `MOV [x],$1` (store)
 * - x86 `MOV EAX,[y]` (load)
 * - `MFENCE`/`LFENCE`/`SFENCE` (fence)
 * - herdtools pseudo ops like `W[x]=1` and `R[x]=r0`
 *
 * When parsing fails, returns a `FENCE` operation with `text` set to the raw instruction
 * (so the UI still renders something meaningful).
 *
 * @param cell - Instruction text for a single thread.
 * @returns Parsed operation plus referenced locations/registers.
 */
const parseInstructionCell = (cell: string): ParsedInstruction => {
  const raw = stripTrailingSemicolon(stripLineComments(cell));
  const text = raw.trim();
  if (!text) {
    return { operation: { type: "FENCE" }, memoryLocations: [], registers: [] };
  }

  const upper = text.toUpperCase();
  if (/^(MFENCE|LFENCE|SFENCE|DMB|DSB|ISB|SYNC|FENCE|MEMBAR)\b/.test(upper)) {
    return { operation: { type: "FENCE", text }, memoryLocations: [], registers: [] };
  }

  // x86: MOV [x],$1  => STORE(x, 1)
  const movStore = /^MOV\s+\[([^\]]+)\]\s*,\s*(.+)$/i.exec(text);
  if (movStore) {
    const location = extractBracketLocations(`[${movStore[1]}]`)[0];
    const valueToken = movStore[2].trim();
    const immediate = parseImmediateInt(valueToken);
    const registers: string[] = [];
    const storeValueRegister =
      immediate === null && /^[A-Za-z_][A-Za-z0-9_]*$/.test(valueToken)
        ? valueToken
        : undefined;
    const operation: Operation = {
      type: "STORE",
      address: location,
      value: immediate ?? valueToken.replace(/^[$#]/, ""),
      memoryOrder: "Standard",
    };
    if (storeValueRegister) {
      registers.push(valueToken);
    }
    return {
      operation,
      memoryLocations: location ? [location] : [],
      registers,
      storeValueRegister,
    };
  }

  // x86: MOV EAX,[y] => LOAD(y) -> EAX
  const movLoad = /^MOV\s+([A-Za-z_][A-Za-z0-9_]*)\s*,\s*\[([^\]]+)\]\s*$/i.exec(
    text
  );
  if (movLoad) {
    const dest = movLoad[1].trim();
    const location = extractBracketLocations(`[${movLoad[2]}]`)[0];
    return {
      operation: {
        type: "LOAD",
        address: location,
        memoryOrder: "Standard",
      },
      memoryLocations: location ? [location] : [],
      registers: [dest],
      loadResultRegister: dest,
    };
  }

  // Herdtools pseudo op: W[x]=1
  const pseudoStore = /^(?:W|ST|STORE)\s*\[?([A-Za-z_][A-Za-z0-9_.-]*)\]?\s*=\s*(.+)$/i.exec(
    text
  );
  if (pseudoStore) {
    const location = pseudoStore[1].trim();
    const rhs = pseudoStore[2].trim();
    const immediate = parseImmediateInt(rhs);
    const storeValueRegister =
      immediate === null && /^[A-Za-z_][A-Za-z0-9_]*$/.test(rhs) ? rhs : undefined;
    return {
      operation: {
        type: "STORE",
        address: location,
        value: immediate ?? rhs.replace(/^[$#]/, ""),
        memoryOrder: "Standard",
      },
      memoryLocations: [location],
      registers: storeValueRegister ? [storeValueRegister] : [],
      storeValueRegister,
    };
  }

  // Herdtools pseudo op: R[x]=r0  (treat RHS as destination register)
  const pseudoLoad = /^(?:R|LD|LOAD)\s*\[?([A-Za-z_][A-Za-z0-9_.-]*)\]?\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/i.exec(
    text
  );
  if (pseudoLoad) {
    const location = pseudoLoad[1].trim();
    const dest = pseudoLoad[2].trim();
    return {
      operation: {
        type: "LOAD",
        address: location,
        memoryOrder: "Standard",
      },
      memoryLocations: [location],
      registers: [dest],
      loadResultRegister: dest,
    };
  }

  // Assignment form: r0 = R[x]
  const assignLoad = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*R\[\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\]\s*$/i.exec(
    text
  );
  if (assignLoad) {
    const dest = assignLoad[1].trim();
    const location = assignLoad[2].trim();
    return {
      operation: {
        type: "LOAD",
        address: location,
        memoryOrder: "Standard",
      },
      memoryLocations: [location],
      registers: [dest],
      loadResultRegister: dest,
    };
  }

  // Last-resort heuristic: if an instruction contains `[x]` and starts with LD*/ST*.
  const bracketLocations = extractBracketLocations(text);
  if (bracketLocations.length > 0) {
    const opcode = text.trim().split(/\s+/)[0]?.toUpperCase() ?? "";
    if (opcode.startsWith("LD") || opcode.startsWith("LDR")) {
      const operands = text.slice(opcode.length).trim();
      const firstOperand = operands.split(",")[0]?.trim() ?? "";
      const destReg = firstOperand.replace(/\s+/g, "");
      return {
        operation: {
          type: "LOAD",
          address: bracketLocations[0],
          memoryOrder: "Standard",
          text,
        },
        memoryLocations: [bracketLocations[0]],
        registers: destReg ? [destReg] : [],
        loadResultRegister: destReg || undefined,
      };
    }
    if (opcode.startsWith("ST") || opcode.startsWith("STR")) {
      const operands = text.slice(opcode.length).trim();
      const firstOperand = operands.split(",")[0]?.trim() ?? "";
      const srcReg = firstOperand.replace(/\s+/g, "");
      return {
        operation: {
          type: "STORE",
          address: bracketLocations[0],
          memoryOrder: "Standard",
          text,
        },
        memoryLocations: [bracketLocations[0]],
        registers: srcReg ? [srcReg] : [],
        storeValueRegister: srcReg || undefined,
      };
    }
  }

  // Fallback: keep the instruction visible even when we can't infer semantics.
  return { operation: { type: "FENCE", text }, memoryLocations: [], registers: [] };
};

/**
 * Parses the thread header row and returns thread metadata for each column.
 *
 * Example: `P0 | P1` => two columns (T0, T1), labels (P0, P1)
 *
 * @param line - Raw header line.
 * @returns Parsed thread columns, or `null` when the line isn't a header row.
 */
const parseThreadHeaderRow = (line: string): ThreadColumn[] | null => {
  const trimmed = stripTrailingSemicolon(line);
  // LKMM tests use C thread signatures like `P0(int *x, int *y)` which must not be
  // interpreted as a pipe-table header.
  if (/[()]/.test(trimmed)) {
    return null;
  }
  if (!/P\d+/i.test(trimmed)) {
    return null;
  }
  const cells = trimmed.includes("|") ? splitPipeRow(trimmed) : [trimmed.trim()];
  if (cells.length === 0) {
    return null;
  }

  const columns: ThreadColumn[] = [];
  for (const cell of cells) {
    const match = /^\s*P(\d+)\b(.*)$/.exec(cell);
    if (!match) {
      return null;
    }
    // Table headers are expected to be bare `P0`, `P1`, ... (optionally with whitespace).
    // If the header contains punctuation beyond whitespace, treat it as not-a-header.
    if (/[^\s]/.test(match[2] ?? "")) {
      return null;
    }
    const threadIndex = Number(match[1]);
    if (Number.isNaN(threadIndex)) {
      return null;
    }
    columns.push({
      threadIndex,
      threadId: `T${threadIndex}`,
      label: cell.trim(),
    });
  }

  return columns;
};

/**
 * Parses register references in a postcondition line (after `exists`/`forall`).
 *
 * Example: `(1:EAX=1 /\\ 1:EBX=0)` => thread 1 registers EAX, EBX
 *
 * @param line - Raw postcondition line.
 * @returns Array of tuples: `[threadIndex, registerName]`.
 */
const parsePostconditionRegisters = (line: string): Array<[number, string]> => {
  const matches = [...line.matchAll(/(\d+)\s*:\s*([A-Za-z_][A-Za-z0-9_]*)/g)];
  const out: Array<[number, string]> = [];
  for (const match of matches) {
    const threadIndex = Number(match[1]);
    const register = match[2].trim();
    if (Number.isNaN(threadIndex) || !register) {
      continue;
    }
    out.push([threadIndex, register]);
  }
  return out;
};

/**
 * Attempts to parse a C/LKMM thread signature line.
 *
 * Example: `P0(int *x, int *y)`
 *
 * @param line - Raw signature line.
 * @returns Thread descriptor, or `null` if the line isn't a signature.
 */
const parseCThreadSignature = (line: string) => {
  const trimmed = line.trim();
  const match = /^P(\d+)\s*\((.*)\)\s*$/.exec(trimmed);
  if (!match) {
    return null;
  }
  const threadIndex = Number(match[1]);
  if (Number.isNaN(threadIndex)) {
    return null;
  }

  const argList = match[2].trim();
  const args = argList
    ? argList
        .split(",")
        .map((arg) => arg.trim())
        .filter(Boolean)
    : [];

  const argNames: string[] = [];
  for (const arg of args) {
    // Heuristic: argument name is the last identifier in the declaration.
    const nameMatch = /([A-Za-z_][A-Za-z0-9_.-]*)\s*$/.exec(arg);
    if (nameMatch) {
      argNames.push(nameMatch[1]);
    }
  }

  return {
    threadIndex,
    label: trimmed,
    argNames,
  };
};

/**
 * Parses a simple C variable declaration.
 *
 * Supports:
 * - `int r0;`
 * - `int r1 = -1;`
 *
 * @param line - Raw line.
 * @returns Declaration info or `null` when not a supported declaration.
 */
const parseCLocalDeclaration = (line: string) => {
  const trimmed = stripLineComments(line).trim();
  const match =
    /^(?:int|long|short|char|unsigned|signed)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:=\s*([^;]+))?;\s*$/.exec(
      trimmed
    );
  if (!match) {
    return null;
  }
  const name = match[1].trim();
  const value = typeof match[2] === "string" ? match[2].trim() : undefined;
  return { name, value };
};

/**
 * Parses a C/LKMM statement line into a ParsedInstruction, or returns null when the line
 * does not correspond to a memory operation.
 *
 * Recognizes common LKMM macros:
 * - `WRITE_ONCE(*x, 1);` (Relaxed store)
 * - `READ_ONCE(*x)` (Relaxed load)
 * - `smp_store_release(y, 1);` (Release store)
 * - `smp_load_acquire(y)` (Acquire load)
 *
 * @param line - Raw source line.
 * @returns Parsed instruction, or `null` when the line should not emit a node.
 */
const parseCStatementLine = (line: string): ParsedInstruction | null => {
  const trimmed = stripLineComments(line).trim();
  if (!trimmed || trimmed === "{" || trimmed === "}") {
    return null;
  }

  // `if`/`else` are handled structurally in `parseCThreadBlocks` so they can become BRANCH nodes.
  if (/^if\s*\(/.test(trimmed) || /^}\s*else\b/.test(trimmed) || /^else\b/.test(trimmed)) {
    return null;
  }

  // r0 = smp_load_acquire(y);
  const loadAcquire =
    /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*smp_load_acquire\s*\(\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\)\s*;\s*$/.exec(
      trimmed
    );
  if (loadAcquire) {
    const dest = loadAcquire[1].trim();
    const location = loadAcquire[2].trim();
    return {
      operation: {
        type: "LOAD",
        address: location,
        memoryOrder: "Acquire",
      },
      memoryLocations: [location],
      registers: [dest],
      loadResultRegister: dest,
    };
  }

  // r1 = READ_ONCE(*x);
  const readOnceAssign =
    /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*READ_ONCE\s*\(\s*\*?\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\)\s*;\s*$/.exec(
      trimmed
    );
  if (readOnceAssign) {
    const dest = readOnceAssign[1].trim();
    const location = readOnceAssign[2].trim();
    return {
      operation: {
        type: "LOAD",
        address: location,
        memoryOrder: "Relaxed",
      },
      memoryLocations: [location],
      registers: [dest],
      loadResultRegister: dest,
    };
  }

  // WRITE_ONCE(*x, 1);
  const writeOnce =
    /^WRITE_ONCE\s*\(\s*\*?\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*,\s*(.+)\)\s*;\s*$/.exec(
      trimmed
    );
  if (writeOnce) {
    const location = writeOnce[1].trim();
    const rhs = writeOnce[2].trim();
    const immediate = parseImmediateInt(rhs);
    const storeValueRegister =
      immediate === null && /^[A-Za-z_][A-Za-z0-9_]*$/.test(rhs) ? rhs : undefined;
    return {
      operation: {
        type: "STORE",
        address: location,
        value: immediate ?? rhs.replace(/^[$#]/, ""),
        memoryOrder: "Relaxed",
      },
      memoryLocations: [location],
      registers: storeValueRegister ? [storeValueRegister] : [],
      storeValueRegister,
    };
  }

  // smp_store_release(y, 1);
  const storeRelease =
    /^smp_store_release\s*\(\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*,\s*(.+)\)\s*;\s*$/.exec(
      trimmed
    );
  if (storeRelease) {
    const location = storeRelease[1].trim();
    const rhs = storeRelease[2].trim();
    const immediate = parseImmediateInt(rhs);
    const storeValueRegister =
      immediate === null && /^[A-Za-z_][A-Za-z0-9_]*$/.test(rhs) ? rhs : undefined;
    return {
      operation: {
        type: "STORE",
        address: location,
        value: immediate ?? rhs.replace(/^[$#]/, ""),
        memoryOrder: "Release",
      },
      memoryLocations: [location],
      registers: storeValueRegister ? [storeValueRegister] : [],
      storeValueRegister,
    };
  }

  // Common LKMM fences/barriers.
  if (/^smp_(mb|rmb|wmb)\s*\(\s*\)\s*;\s*$/.test(trimmed)) {
    return {
      operation: { type: "FENCE", text: trimmed.replace(/;\s*$/, "") },
      memoryLocations: [],
      registers: [],
    };
  }

  // Plain register assignment is local computation; ignore.
  if (/^[A-Za-z_][A-Za-z0-9_]*\s*=\s*[^;]+;\s*$/.test(trimmed)) {
    return null;
  }

  // Fallback: keep unknown statements visible.
  return {
    operation: { type: "FENCE", text: trimmed.replace(/;\s*$/, "") },
    memoryLocations: [],
    registers: [],
  };
};

/**
 * Parses LKMM-style C thread blocks (`P0(...) { ... }`) from the source.
 *
 * @param lines - Preprocessed file lines.
 * @param startIndex - Index to start scanning from.
 * @returns Thread columns, parsed instructions, and discovered memory/register inits.
 */
const parseCThreadBlocks = (lines: string[], startIndex: number) => {
  const columnsByIndex = new Map<number, ThreadColumn>();
  const opsByThread = new Map<
    string,
    Array<{ sequenceIndex: number; parsed: ParsedInstruction }>
  >();
  const discoveredSharedLocations = new Set<string>();
  const discoveredRegistersByThread = new Map<number, Set<string>>();
  const localInitsByThread = new Map<number, Map<string, string>>();

  let i = startIndex;
  while (i < lines.length) {
    const line = lines[i].trim();
    const signature = parseCThreadSignature(line);
    if (!signature) {
      i += 1;
      continue;
    }

    const threadIndex = signature.threadIndex;
    const threadId = `T${threadIndex}`;
    columnsByIndex.set(threadIndex, {
      threadIndex,
      threadId,
      label: signature.label,
    });
    if (!opsByThread.has(threadId)) {
      opsByThread.set(threadId, []);
    }
    if (!discoveredRegistersByThread.has(threadIndex)) {
      discoveredRegistersByThread.set(threadIndex, new Set());
    }
    if (!localInitsByThread.has(threadIndex)) {
      localInitsByThread.set(threadIndex, new Map());
    }

    for (const argName of signature.argNames) {
      discoveredSharedLocations.add(argName);
    }

    // Find the opening brace for the function body.
    let bodyStart = i + 1;
    if (line.includes("{")) {
      bodyStart = i;
    } else {
      while (bodyStart < lines.length && !lines[bodyStart].includes("{")) {
        bodyStart += 1;
      }
    }
    if (bodyStart >= lines.length) {
      throw new Error(`Thread ${signature.label} is missing an opening '{'.`);
    }

    // Consume until the matching closing brace of the thread body.
    let depth = 0;
    let started = false;
    let sequenceIndex = (opsByThread.get(threadId)?.length ?? 0) + 1;
    const branchStack: Array<{
      branchSequenceIndex: number;
      conditionText: string;
      thenDepth: number | null;
      pendingSingleStatement: boolean;
    }> = [];

    for (let j = bodyStart; j < lines.length; j += 1) {
      const currentLine = lines[j];
      const depthBefore = depth;
      let delta = 0;
      for (const char of currentLine) {
        if (char === "{") {
          delta += 1;
          started = true;
        } else if (char === "}") {
          delta -= 1;
        }
      }
      depth += delta;

      if (!started) {
        continue;
      }

      // Skip the signature line itself (it might contain `{`).
      if (j === i) {
        continue;
      }

      const decl = parseCLocalDeclaration(currentLine);
      if (decl) {
        discoveredRegistersByThread.get(threadIndex)?.add(decl.name);
        if (typeof decl.value === "string") {
          localInitsByThread.get(threadIndex)?.set(decl.name, decl.value);
        }
        continue;
      }

      // Convert `if (...)` lines into BRANCH nodes.
      const ifMatch = /^\s*if\s*\((.+)\)\s*(\{)?\s*$/.exec(currentLine);
      if (ifMatch) {
        const conditionText = ifMatch[1].trim();
        const hasBrace = Boolean(ifMatch[2]) || currentLine.includes("{");

        const branchSequenceIndex = sequenceIndex;
        opsByThread.get(threadId)?.push({
          sequenceIndex,
          parsed: {
            operation: {
              type: "BRANCH",
              branchShowBothFutures: true,
              text: `if (${conditionText})`,
            },
            memoryLocations: [],
            registers: [],
            branchConditionText: conditionText,
          },
        });
        sequenceIndex += 1;

        branchStack.push({
          branchSequenceIndex,
          conditionText,
          thenDepth: hasBrace ? depth : null,
          pendingSingleStatement: !hasBrace,
        });
        continue;
      }

      const parsed = parseCStatementLine(currentLine);
      if (parsed) {
        for (const location of parsed.memoryLocations) {
          discoveredSharedLocations.add(location);
        }
        for (const register of parsed.registers) {
          discoveredRegistersByThread.get(threadIndex)?.add(register);
        }

        // If we are currently inside an `if` then-block, tag the instruction so it can be
        // associated with the BRANCH node at snapshot build time.
        const activeBranch = branchStack[branchStack.length - 1];
        if (activeBranch) {
          const isInsideThen =
            activeBranch.pendingSingleStatement ||
            (activeBranch.thenDepth !== null && depthBefore >= activeBranch.thenDepth);
          if (isInsideThen) {
            parsed.branchContext = {
              branchSequenceIndex: activeBranch.branchSequenceIndex,
              path: "then",
            };

            if (activeBranch.pendingSingleStatement) {
              branchStack.pop();
            }
          }
        }

        opsByThread.get(threadId)?.push({ sequenceIndex, parsed });
        sequenceIndex += 1;
      }

      // If a braced then-block ended on this line, pop it so following statements are not tagged.
      while (branchStack.length > 0) {
        const candidate = branchStack[branchStack.length - 1];
        if (candidate.pendingSingleStatement) {
          break;
        }
        if (candidate.thenDepth !== null && depth < candidate.thenDepth) {
          branchStack.pop();
          continue;
        }
        break;
      }

      if (started && depth === 0) {
        i = j + 1;
        break;
      }
      if (j === lines.length - 1) {
        throw new Error(`Thread ${signature.label} is missing a closing '}'.`);
      }
    }
  }

  const columns = [...columnsByIndex.values()].sort((a, b) => a.threadIndex - b.threadIndex);
  const threadLabels: Record<string, string> = {};
  const threads = columns.map((col) => col.threadId);
  for (const col of columns) {
    threadLabels[col.threadId] = col.label;
  }

  return {
    columns,
    threads,
    threadLabels,
    opsByThread,
    discoveredSharedLocations,
    discoveredRegistersByThread,
    localInitsByThread,
  };
};

/**
 * Converts a herdtools `.litmus` file into a Litmus Explorer session snapshot.
 *
 * @param text - Raw `.litmus` file contents.
 * @param options - Parsing options.
 * @returns Session snapshot suitable for `importSession`.
 */
export const parseLitmusTestToSessionSnapshot = (
  text: string,
  options: LitmusParseOptions = {}
) => {
  const sanitized = stripBlockComments(text).replace(/\r\n/g, "\n");
  const lines = sanitized
    .split("\n")
    .map((line) => stripLineComments(line))
    .map((line) => line.replace(/\t/g, "  "));

  const firstNonEmpty = lines.find((line) => line.trim().length > 0);
  if (!firstNonEmpty) {
    throw new Error("Litmus file is empty.");
  }
  const header = parseHeaderLine(firstNonEmpty);

  const headerTitle = options.fallbackTitle?.trim()
    ? options.fallbackTitle.trim()
    : header.name;
  const title = headerTitle || `${header.arch} litmus test`;

  const headerIndex = lines.findIndex((line) => line === firstNonEmpty);
  const { content: initContent, endIndex: initEndIndex } = extractBraceBlock(
    lines,
    headerIndex
  );
  const init = parseInitBlock(initContent);

  const sharedLocations = new Set<string>(init.shared.keys());
  const registersByThread = new Map<number, Set<string>>();
  for (const [threadIndex, locals] of init.localsByThread.entries()) {
    registersByThread.set(threadIndex, new Set(locals.keys()));
  }
  const localInitsFromDeclarations = new Map<number, Map<string, string>>();

  // Identify the thread header row (P0|P1) following the init block (table-style tests).
  let threadHeaderIndex = -1;
  let columns: ThreadColumn[] | null = null;
  for (let i = initEndIndex + 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }
    const parsed = parseThreadHeaderRow(line);
    if (parsed) {
      threadHeaderIndex = i;
      columns = parsed;
      break;
    }
  }

  let threads: string[] = [];
  let threadLabels: Record<string, string> = {};
  let opsByThread = new Map<string, Array<{ sequenceIndex: number; parsed: ParsedInstruction }>>();

  if (columns && threadHeaderIndex !== -1) {
    threads = columns.map((col) => col.threadId);
    threadLabels = {};
    for (const col of columns) {
      threadLabels[col.threadId] = col.label;
    }

    // Build per-thread operation lists; sequenceIndex increments only when a thread has an op.
    opsByThread = new Map();
    const nextSequenceByThread = new Map<string, number>();
    for (const threadId of threads) {
      opsByThread.set(threadId, []);
      nextSequenceByThread.set(threadId, 1);
    }

    // Parse the instruction table until the postcondition section.
    for (let i = threadHeaderIndex + 1; i < lines.length; i += 1) {
      const rawLine = lines[i];
      const trimmed = rawLine.trim();
      if (!trimmed) {
        continue;
      }

      if (/^(exists|forall|filter)\b/i.test(trimmed)) {
        // Parse registers mentioned in the postcondition so we create locals even if the code
        // didn't explicitly name them (some tests constrain registers only in the exists clause).
        for (const [threadIndex, register] of parsePostconditionRegisters(trimmed)) {
          if (!registersByThread.has(threadIndex)) {
            registersByThread.set(threadIndex, new Set());
          }
          registersByThread.get(threadIndex)?.add(register);
        }
        for (let j = i + 1; j < lines.length; j += 1) {
          const postLine = lines[j].trim();
          if (!postLine) {
            continue;
          }
          for (const [threadIndex, register] of parsePostconditionRegisters(postLine)) {
            if (!registersByThread.has(threadIndex)) {
              registersByThread.set(threadIndex, new Set());
            }
            registersByThread.get(threadIndex)?.add(register);
          }
        }
        break;
      }

      const declaredLocations = parseLocationsLine(trimmed);
      if (declaredLocations.length > 0) {
        for (const location of declaredLocations) {
          sharedLocations.add(location);
        }
        continue;
      }

      const rowCells = trimmed.includes("|")
        ? splitPipeRow(trimmed)
        : [stripTrailingSemicolon(trimmed)];

      for (let colIndex = 0; colIndex < columns.length; colIndex += 1) {
        const cell = rowCells[colIndex] ?? "";
        if (!cell.trim()) {
          continue;
        }
        const col = columns[colIndex];
        const parsed = parseInstructionCell(cell);
        for (const location of parsed.memoryLocations) {
          sharedLocations.add(location);
        }
        for (const register of parsed.registers) {
          if (!registersByThread.has(col.threadIndex)) {
            registersByThread.set(col.threadIndex, new Set());
          }
          registersByThread.get(col.threadIndex)?.add(register);
        }

        const threadId = col.threadId;
        const sequenceIndex = nextSequenceByThread.get(threadId) ?? 1;
        nextSequenceByThread.set(threadId, sequenceIndex + 1);
        opsByThread.get(threadId)?.push({ sequenceIndex, parsed });
      }
    }
  } else {
    // LKMM tests use C-style thread blocks: `P0(int *x, int *y) { ... }`.
    const parsed = parseCThreadBlocks(lines, initEndIndex + 1);
    columns = parsed.columns;
    threads = parsed.threads;
    threadLabels = parsed.threadLabels;
    opsByThread = parsed.opsByThread;

    for (const location of parsed.discoveredSharedLocations) {
      sharedLocations.add(location);
    }
    for (const [threadIndex, registers] of parsed.discoveredRegistersByThread.entries()) {
      if (!registersByThread.has(threadIndex)) {
        registersByThread.set(threadIndex, new Set());
      }
      const set = registersByThread.get(threadIndex);
      for (const reg of registers) {
        set?.add(reg);
      }
    }
    for (const [threadIndex, inits] of parsed.localInitsByThread.entries()) {
      if (!localInitsFromDeclarations.has(threadIndex)) {
        localInitsFromDeclarations.set(threadIndex, new Map());
      }
      const target = localInitsFromDeclarations.get(threadIndex);
      for (const [name, value] of inits.entries()) {
        target?.set(name, value);
      }
    }

    // Postcondition registers appear after the thread blocks; add them too.
    for (const line of lines) {
      for (const [threadIndex, register] of parsePostconditionRegisters(line)) {
        if (!registersByThread.has(threadIndex)) {
          registersByThread.set(threadIndex, new Set());
        }
        registersByThread.get(threadIndex)?.add(register);
      }
    }
  }

  if (!columns || threads.length === 0) {
    throw new Error(`Failed to locate threads (pipe table or C thread blocks).`);
  }

  // Construct the memory environment.
  const memoryEnv: MemoryVariable[] = [
    {
      id: "const-null",
      name: "NULL",
      type: "int",
      scope: "constants",
      value: "0",
    },
  ];

  const memoryIdByLocation = new Map<string, string>();
  for (const location of [...sharedLocations].sort((a, b) => a.localeCompare(b))) {
    const id = `mem-${toIdToken(location)}`;
    memoryIdByLocation.set(location, id);
    memoryEnv.push({
      id,
      name: location,
      type: "int",
      scope: "shared",
      value: init.shared.get(location) ?? DEFAULT_MEMORY_VALUE,
    });
  }

  const pendingConstantInts: MemoryVariable[] = [];
  const constantIntIdByValue = new Map<string, string>();

  /**
   * Ensures a numeric constant exists in the constants memory section.
   *
   * This is primarily used to translate `if (r0 != 0)` style branch conditions into
   * the editor's id-referenced BranchRuleCondition format.
   *
   * @param literal - Numeric literal string (e.g. `0`, `-1`, `0x10`).
   * @returns The memory variable id for the constant.
   */
  const ensureConstantIntId = (literal: string) => {
    const normalized = literal.trim();
    if (!normalized) {
      return "const-null";
    }
    const existing = constantIntIdByValue.get(normalized);
    if (existing) {
      return existing;
    }

    const id = `const-int-${toIdToken(normalized)}`;
    constantIntIdByValue.set(normalized, id);
    pendingConstantInts.push({
      id,
      name: normalized,
      type: "int",
      scope: "constants",
      value: normalized,
    });
    return id;
  };

  const localIdByThreadAndName = new Map<string, string>();
  for (const col of columns) {
    const threadIndex = col.threadIndex;
    const threadId = col.threadId;
    const registers = registersByThread.get(threadIndex);
    if (!registers || registers.size === 0) {
      continue;
    }

    const initLocals = init.localsByThread.get(threadIndex);
    const declaredInits = localInitsFromDeclarations.get(threadIndex);
    for (const register of [...registers].sort((a, b) => a.localeCompare(b))) {
      const id = `local-${threadId.toLowerCase()}-${toIdToken(register)}`;
      localIdByThreadAndName.set(`${threadId}:${register}`, id);
      memoryEnv.push({
        id,
        name: register,
        type: "int",
        scope: "locals",
        value: initLocals?.get(register) ?? declaredInits?.get(register) ?? "",
      });
    }
  }

  // Build nodes and add program-order edges for each thread.
  const nodes: TraceNode[] = [];
  const edges: RelationEdge[] = [];
  let edgeCounter = 0;

  for (let laneIndex = 0; laneIndex < columns.length; laneIndex += 1) {
    const col = columns[laneIndex];
    const threadId = col.threadId;
    const laneCenter = getLaneX(laneIndex);
    const ops = opsByThread.get(threadId) ?? [];

    const nodeIdBySeq = new Map<number, string>();
    const thenRangeByBranchSeq = new Map<
      number,
      { thenStartSeq?: number; thenEndSeq?: number }
    >();

    for (const entry of ops) {
      if (entry.parsed.operation.type === "BRANCH") {
        thenRangeByBranchSeq.set(entry.sequenceIndex, {});
      }
      const context = entry.parsed.branchContext;
      if (!context || context.path !== "then") {
        continue;
      }
      const range = thenRangeByBranchSeq.get(context.branchSequenceIndex) ?? {};
      if (typeof range.thenStartSeq === "undefined") {
        range.thenStartSeq = entry.sequenceIndex;
      }
      range.thenEndSeq = entry.sequenceIndex;
      thenRangeByBranchSeq.set(context.branchSequenceIndex, range);
    }

    const joinByBranchSeq = new Map<number, number>();
    for (const [branchSeq, range] of thenRangeByBranchSeq.entries()) {
      if (typeof range.thenEndSeq === "undefined") {
        continue;
      }
      const endIndex = ops.findIndex((entry) => entry.sequenceIndex === range.thenEndSeq);
      if (endIndex === -1) {
        continue;
      }
      const candidate = ops[endIndex + 1];
      if (!candidate) {
        continue;
      }
      const context = candidate.parsed.branchContext;
      if (context && context.branchSequenceIndex === branchSeq) {
        continue;
      }
      joinByBranchSeq.set(branchSeq, candidate.sequenceIndex);
    }

    for (const entry of ops) {
      const nodeId = `node-${threadId.toLowerCase()}-op${entry.sequenceIndex}`;
      nodeIdBySeq.set(entry.sequenceIndex, nodeId);

      const operation = { ...entry.parsed.operation };

      // Crucial mapping step:
      // - The parser returns address/register names as strings (`address`, `registers`).
      // - The editor prefers stable ids (`addressId`, `resultId`, `valueId`) for references.
      if (operation.address && memoryIdByLocation.has(operation.address)) {
        operation.addressId = memoryIdByLocation.get(operation.address);
      }

      if (operation.type === "BRANCH" && entry.parsed.branchConditionText) {
        const ast = parseConditionAst(tokenizeCondition(entry.parsed.branchConditionText));
        const resolveOperandId = (operand: ConditionAst): string | undefined => {
          if (operand.kind === "ident") {
            const localId = localIdByThreadAndName.get(`${threadId}:${operand.name}`);
            if (localId) {
              return localId;
            }
            const sharedId = memoryIdByLocation.get(operand.name);
            if (sharedId) {
              return sharedId;
            }
            return undefined;
          }
          if (operand.kind === "number") {
            return ensureConstantIntId(operand.value);
          }
          return undefined;
        };

        const condition = buildBranchConditionFromAst({
          ast,
          resolveOperandId,
          ensureConstantIntId,
        });

        const root: BranchGroupCondition =
          condition.kind === "group"
            ? condition
            : {
                kind: "group",
                id: createConditionId("group"),
                items: [condition],
                operators: [],
              };

        operation.branchCondition = root;
        operation.branchShowBothFutures = operation.branchShowBothFutures ?? true;
      }

      // Best-effort register linkage:
      // - The parsing phase records registers to create locals.
      // - When a store/load token is a register name, link the node to the matching local id.
      if (operation.type === "LOAD") {
        const dest = entry.parsed.loadResultRegister;
        if (dest) {
          const localId = localIdByThreadAndName.get(`${threadId}:${dest}`);
          if (localId) {
            operation.resultId = localId;
          }
        }
      }
      if (operation.type === "STORE") {
        const src = entry.parsed.storeValueRegister;
        if (src) {
          const localId = localIdByThreadAndName.get(`${threadId}:${src}`);
          if (localId) {
            operation.valueId = localId;
            operation.value = undefined;
          }
        }
      }

      const branchContext = entry.parsed.branchContext;
      const branchId = branchContext
        ? `node-${threadId.toLowerCase()}-op${branchContext.branchSequenceIndex}`
        : undefined;

      nodes.push({
        id: nodeId,
        type: operation.type === "BRANCH" ? "branch" : "operation",
        position: { x: entry.sequenceIndex * GRID_Y, y: laneCenter },
        data: {
          threadId,
          sequenceIndex: entry.sequenceIndex,
          operation,
          ...(branchId
            ? { branchId, branchPath: branchContext?.path ?? "then" }
            : null),
        },
      });
    }

    for (let i = 0; i < ops.length - 1; i += 1) {
      const from = ops[i];
      const to = ops[i + 1];
      const source = nodeIdBySeq.get(from.sequenceIndex);
      const target = nodeIdBySeq.get(to.sequenceIndex);
      if (!source || !target) {
        continue;
      }
      const sourceHandle =
        from.parsed.operation.type === "BRANCH" ? "then" : undefined;

      edges.push({
        id: `edge-po-${edgeCounter}`,
        source,
        target,
        ...(sourceHandle ? { sourceHandle } : null),
        type: "relation",
        data: { relationType: "po", invalid: false },
      });
      edgeCounter += 1;
    }

    for (const [branchSeq, joinSeq] of joinByBranchSeq.entries()) {
      const source = nodeIdBySeq.get(branchSeq);
      const target = nodeIdBySeq.get(joinSeq);
      if (!source || !target) {
        continue;
      }
      edges.push({
        id: `edge-po-${edgeCounter}`,
        source,
        target,
        sourceHandle: "else",
        type: "relation",
        data: { relationType: "po", invalid: false },
      });
      edgeCounter += 1;
    }
  }

  if (pendingConstantInts.length > 0) {
    memoryEnv.push(...pendingConstantInts);
  }

  return createSessionSnapshot({
    title,
    modelConfig: { ...DEFAULT_MODEL_CONFIG },
    memoryEnv,
    nodes,
    edges,
    threads,
    threadLabels,
    activeBranch: null,
  });
};
