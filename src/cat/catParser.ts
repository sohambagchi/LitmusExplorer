const TOP_LEVEL_KEYWORD_RE =
  /^\s*(let|include|acyclic|irreflexive|empty|flag|show)\b/;

const INCLUDE_RE = /^\s*include\s+"([^"]+)"\s*$/;

const LET_RE =
  /^\s*let\s+(?:rec\s+)?([A-Za-z_][A-Za-z0-9_.-]*)(\s*\([^)]*\))?\s*=\s*(.*)$/;

const IDENT_RE = /[A-Za-z_][A-Za-z0-9_.-]*/g;

const KEYWORDS = new Set([
  "let",
  "rec",
  "include",
  "acyclic",
  "irreflexive",
  "empty",
  "flag",
  "show",
  "as",
  "with",
]);

const BUILTINS = new Set([
  // Common base relations (some may be provided by included libs).
  "po",
  "po-loc",
  "rf",
  "rfe",
  "rfi",
  "co",
  "coe",
  "coi",
  "fr",
  "fre",
  "fri",
  "rmw",
  // Common predicates / sets / helpers.
  "id",
  "loc",
  "int",
  "ext",
  "data",
  "addr",
  "ctrl",
  "fencerel",
]);

export type ParsedCatFile = {
  includes: string[];
  definedNames: string[];
  macroNames: string[];
  referencedNames: string[];
  shownNames: string[];
  definitions: CatDefinition[];
};

export type CatDefinition = {
  name: string;
  isMacro: boolean;
  body: string;
};

export type CatModelAnalysis = {
  includes: string[];
  missingIncludes: string[];
  definedNames: string[];
  macroNames: string[];
  referencedNames: string[];
  unresolvedNames: string[];
  shownNames: string[];
};

export const stripCatComments = (input: string) => {
  let output = "";
  let i = 0;
  let commentDepth = 0;
  let inString = false;

  while (i < input.length) {
    const ch = input[i] ?? "";
    const next = input[i + 1] ?? "";

    if (inString) {
      output += ch;
      if (ch === "\"" && input[i - 1] !== "\\") {
        inString = false;
      }
      i += 1;
      continue;
    }

    if (commentDepth > 0) {
      if (ch === "(" && next === "*") {
        commentDepth += 1;
        i += 2;
        continue;
      }
      if (ch === "*" && next === ")") {
        commentDepth -= 1;
        i += 2;
        continue;
      }
      if (ch === "\n") {
        output += "\n";
      }
      i += 1;
      continue;
    }

    if (ch === "\"" && commentDepth === 0) {
      inString = true;
      output += ch;
      i += 1;
      continue;
    }

    if (ch === "(" && next === "*") {
      commentDepth = 1;
      i += 2;
      continue;
    }

    output += ch;
    i += 1;
  }

  return output;
};

const normalizeCatLines = (input: string) =>
  stripCatComments(input)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && !line.trimStart().startsWith("#"));

export const parseCatFileText = (text: string): ParsedCatFile => {
  const lines = normalizeCatLines(text);
  const includes = new Set<string>();
  const definedNames = new Set<string>();
  const macroNames = new Set<string>();
  const referencedNames = new Set<string>();
  const shownNames = new Set<string>();

  const letBodies: CatDefinition[] = [];
  let currentLet: { name: string; isMacro: boolean; bodyLines: string[] } | null =
    null;

  const flushLet = () => {
    if (!currentLet) {
      return;
    }
    letBodies.push({
      name: currentLet.name,
      isMacro: currentLet.isMacro,
      body: currentLet.bodyLines.join("\n").trim(),
    });
    currentLet = null;
  };

  for (const line of lines) {
    const includeMatch = INCLUDE_RE.exec(line);
    if (includeMatch) {
      flushLet();
      includes.add(includeMatch[1] ?? "");
      continue;
    }

    if (/^\s*show\b/.test(line)) {
      flushLet();
      const showRhs = line.replace(/^\s*show\b/, " ").trim();
      const tokens = showRhs.match(IDENT_RE) ?? [];
      tokens.forEach((token) => shownNames.add(token));
      continue;
    }

    const letMatch = LET_RE.exec(line);
    if (letMatch) {
      flushLet();
      const name = letMatch[1] ?? "";
      const args = letMatch[2];
      const isMacro = Boolean(args && args.trim().startsWith("("));
      const rhs = letMatch[3] ?? "";
      definedNames.add(name);
      if (isMacro) {
        macroNames.add(name);
      }
      currentLet = { name, isMacro, bodyLines: [rhs] };
      continue;
    }

    if (TOP_LEVEL_KEYWORD_RE.test(line)) {
      flushLet();
      continue;
    }

    if (currentLet) {
      currentLet.bodyLines.push(line);
    }
  }

  flushLet();

  for (const def of letBodies) {
    const tokens = def.body.match(IDENT_RE) ?? [];
    for (const token of tokens) {
      if (token === def.name) {
        continue;
      }
      if (KEYWORDS.has(token)) {
        continue;
      }
      if (BUILTINS.has(token)) {
        continue;
      }
      if (/^[A-Z0-9_-]+$/.test(token)) {
        continue;
      }
      referencedNames.add(token);
    }
  }

  return {
    includes: Array.from(includes).filter(Boolean),
    definedNames: Array.from(definedNames),
    macroNames: Array.from(macroNames),
    referencedNames: Array.from(referencedNames),
    shownNames: Array.from(shownNames),
    definitions: letBodies,
  };
};

const uniqueInOrder = (items: string[]) => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
};

export const analyzeCatFiles = (filesByName: Record<string, string>) => {
  const parsedByName = Object.entries(filesByName).map(([name, text]) => ({
    name,
    parsed: parseCatFileText(text),
  }));

  const includes = uniqueInOrder(
    parsedByName.flatMap(({ parsed }) => parsed.includes)
  );
  const definedNames = uniqueInOrder(
    parsedByName.flatMap(({ parsed }) => parsed.definedNames)
  );
  const macroNames = uniqueInOrder(
    parsedByName.flatMap(({ parsed }) => parsed.macroNames)
  );
  const referencedNames = uniqueInOrder(
    parsedByName.flatMap(({ parsed }) => parsed.referencedNames)
  );
  const shownNames = uniqueInOrder(
    parsedByName.flatMap(({ parsed }) => parsed.shownNames)
  );
  const definitions = parsedByName.flatMap(({ name, parsed }) =>
    parsed.definitions.map((definition) => ({ ...definition, fileName: name }))
  );

  const availableFiles = new Set(Object.keys(filesByName));
  const missingIncludes = includes.filter((includeName) => !availableFiles.has(includeName));

  const defined = new Set(definedNames);
  const unresolvedNames = referencedNames
    .filter((name) => !defined.has(name))
    .filter((name) => !BUILTINS.has(name));

  const nonMacroDefined = definedNames.filter((name) => !macroNames.includes(name));

  const analysis: CatModelAnalysis = {
    includes,
    missingIncludes,
    definedNames,
    macroNames,
    referencedNames,
    unresolvedNames: uniqueInOrder(unresolvedNames).sort((a, b) => a.localeCompare(b)),
    shownNames: uniqueInOrder(shownNames).sort((a, b) => a.localeCompare(b)),
  };

  const nonMacroDefinitions = definitions
    .filter((definition) => !definition.isMacro)
    .map((definition) => ({
      name: definition.name,
      fileName: definition.fileName,
      body: definition.body,
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.fileName.localeCompare(b.fileName));

  return {
    analysis,
    nonMacroDefined: nonMacroDefined.sort((a, b) => a.localeCompare(b)),
    nonMacroDefinitions,
  };
};
