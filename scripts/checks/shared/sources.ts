/**
 * What the harness checks that read the UI's sources (`ipc-names`, `ui-literals`) share:
 * which files are scripts and which are tests, parsing a script with a type checker so a
 * name resolves to the binding actually in scope (a parameter or an inner `const`
 * shadows an outer one) — one file alone, or several whose imports of each other resolve —
 * and blanking text while keeping its line breaks.
 */
import ts from "typescript";

/** A TypeScript or JavaScript file: `.ts`, `.tsx`, `.js`, `.jsx`, and the `.m`/`.c` forms. */
export const SCRIPT_FILE = /\.[cm]?[jt]sx?$/;

/** A test file, which never ships. */
export const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

/** `text` with every character but a newline replaced by a space, so offsets survive. */
export const blank = (text: string): string => text.replace(/[^\n]/g, " ");

const KINDS: readonly (readonly [RegExp, ts.ScriptKind])[] = [
  [/\.tsx$/, ts.ScriptKind.TSX],
  [/\.jsx$/, ts.ScriptKind.JSX],
  [/\.[cm]?js$/, ts.ScriptKind.JS],
];

/** A parsed script and a checker over it alone (no lib, no imports resolved). */
export interface ParsedScript {
  readonly file: ts.SourceFile;
  readonly checker: ts.TypeChecker;
}

/**
 * Parse `source` as the script kind its path names, with a checker whose symbol lookups
 * follow the file's own scopes. Imports are not resolved: an imported name resolves to
 * its import specifier, which {@link importOf} reads.
 */
export function parseScript(path: string, source: string): ParsedScript {
  const name = `/__check__/${path}`;
  const kind = KINDS.find(([pattern]) => pattern.test(path))?.[1] ?? ts.ScriptKind.TS;
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, kind);
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, allowJs: true, types: [] };
  const host = ts.createCompilerHost(options, true);
  host.getSourceFile = (requested) => (requested === name ? file : undefined);
  host.fileExists = (requested) => requested === name;
  host.readFile = (requested) => (requested === name ? source : undefined);
  const program = ts.createProgram({ rootNames: [name], options, host });
  return { file, checker: program.getTypeChecker() };
}

/** One script of a {@link parseScripts} program: its path under the root, and its text. */
export interface ScriptSource {
  readonly path: string;
  readonly source: string;
}

/** Scripts parsed together, keyed by the path each was given, and one checker over all. */
export interface ParsedScripts {
  readonly files: ReadonlyMap<string, ts.SourceFile>;
  readonly checker: ts.TypeChecker;
}

/**
 * Parse several scripts as one program whose checker follows a relative import from one
 * to another (as `moduleResolution: "bundler"` does), so an imported name resolves to
 * the declaration it names in the file it comes from; see {@link bindingValues}. Every
 * file is a module, so two files' top-level names never merge. A module outside the
 * given scripts (a package, a file not given) resolves to nothing.
 */
export function parseScripts(scripts: readonly ScriptSource[]): ParsedScripts {
  const byName = new Map(scripts.map((script) => [`/__check__/${script.path}`, script]));
  const directories = new Set<string>();
  for (const name of byName.keys()) {
    for (let at = name.lastIndexOf("/"); at > 0; at = name.lastIndexOf("/", at - 1)) {
      directories.add(name.slice(0, at));
    }
  }
  const options: ts.CompilerOptions = {
    noLib: true,
    allowJs: true,
    types: [],
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    moduleDetection: ts.ModuleDetectionKind.Force,
    allowImportingTsExtensions: true,
    jsx: ts.JsxEmit.Preserve,
    noEmit: true,
  };
  const host = ts.createCompilerHost(options, true);
  host.getSourceFile = (requested, languageVersionOrOptions) => {
    const script = byName.get(requested);
    if (script === undefined) return undefined;
    const kind = KINDS.find(([pattern]) => pattern.test(script.path))?.[1] ?? ts.ScriptKind.TS;
    return ts.createSourceFile(requested, script.source, languageVersionOrOptions, true, kind);
  };
  host.fileExists = (requested) => byName.has(requested);
  host.readFile = (requested) => byName.get(requested)?.source;
  host.directoryExists = (requested) => directories.has(requested.replace(/\/$/, ""));
  host.getDirectories = () => [];
  host.realpath = (requested) => requested;
  host.useCaseSensitiveFileNames = () => true;
  host.getCanonicalFileName = (requested) => requested;
  const program = ts.createProgram({ rootNames: [...byName.keys()], options, host });
  const files = new Map<string, ts.SourceFile>();
  for (const [name, script] of byName) {
    const file = program.getSourceFile(name);
    if (file !== undefined) files.set(script.path, file);
  }
  return { files, checker: program.getTypeChecker() };
}

/** The declaration an identifier's binding comes from, shorthand `{ name }` included. */
export function declarationOf(
  checker: ts.TypeChecker,
  identifier: ts.Identifier,
): ts.Declaration | undefined {
  return symbolOf(checker, identifier)?.declarations?.[0];
}

function symbolOf(checker: ts.TypeChecker, identifier: ts.Identifier): ts.Symbol | undefined {
  return ts.isShorthandPropertyAssignment(identifier.parent)
    ? checker.getShorthandAssignmentValueSymbol(identifier.parent)
    : checker.getSymbolAtLocation(identifier);
}

const ASSIGNMENTS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
]);

/** Per file, the right-hand sides assigned to each variable, found once. */
const assigned = new WeakMap<ts.SourceFile, Map<ts.Symbol, ts.Expression[]>>();

function assignmentsIn(
  checker: ts.TypeChecker,
  file: ts.SourceFile,
): Map<ts.Symbol, ts.Expression[]> {
  const known = assigned.get(file);
  if (known !== undefined) return known;
  const found = new Map<ts.Symbol, ts.Expression[]>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      ASSIGNMENTS.has(node.operatorToken.kind) &&
      ts.isIdentifier(node.left)
    ) {
      const symbol = checker.getSymbolAtLocation(node.left);
      if (symbol !== undefined) found.set(symbol, [...(found.get(symbol) ?? []), node.right]);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  assigned.set(file, found);
  return found;
}

/**
 * Every expression the binding an identifier names can hold: a `const`'s initializer; a
 * `let` or `var`'s initializer and the right-hand side of each `=`, `+=`, `||=`, `??=`,
 * or `&&=` to it in its file; and, through an import the program resolves, the same for
 * the binding the other module exports (an `export default` expression included).
 * Empty for a parameter, a function, a destructured name, or a name bound nowhere.
 */
export function bindingValues(checker: ts.TypeChecker, identifier: ts.Identifier): ts.Expression[] {
  let symbol = symbolOf(checker, identifier);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  const declaration = symbol?.declarations?.[0];
  if (symbol === undefined || declaration === undefined) return [];
  if (ts.isExportAssignment(declaration)) return [declaration.expression];
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return [];
  const initial = declaration.initializer === undefined ? [] : [declaration.initializer];
  if ((ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0) return initial;
  return [...initial, ...(assignmentsIn(checker, declaration.getSourceFile()).get(symbol) ?? [])];
}

/** The initializer of the `const` an identifier is bound to, if it is bound to one. */
export function constInitializer(
  checker: ts.TypeChecker,
  identifier: ts.Identifier,
): ts.Expression | undefined {
  const declaration = declarationOf(checker, identifier);
  return declaration !== undefined &&
    ts.isVariableDeclaration(declaration) &&
    ts.isIdentifier(declaration.name) &&
    (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0
    ? declaration.initializer
    : undefined;
}

/** Where an identifier's binding is imported from: the module, and the name it exports. */
export function importOf(
  checker: ts.TypeChecker,
  identifier: ts.Identifier,
): { readonly module: string; readonly name: string } | undefined {
  const declaration = declarationOf(checker, identifier);
  if (declaration === undefined) return undefined;
  let name: string;
  let clause: ts.Node;
  if (ts.isImportSpecifier(declaration)) {
    name = (declaration.propertyName ?? declaration.name).text;
    clause = declaration.parent.parent;
  } else if (ts.isNamespaceImport(declaration)) {
    name = "*";
    clause = declaration.parent;
  } else if (ts.isImportClause(declaration)) {
    name = "default";
    clause = declaration;
  } else {
    return undefined;
  }
  const specifier = ts.isImportClause(clause) ? clause.parent.moduleSpecifier : undefined;
  return specifier !== undefined && ts.isStringLiteral(specifier)
    ? { module: specifier.text, name }
    : undefined;
}
