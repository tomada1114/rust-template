/**
 * What the harness checks that read the UI's sources (`ipc-names`, `ui-literals`) share:
 * which files are scripts and which are tests, parsing scripts with a type checker so a
 * name resolves to the binding actually in scope (a parameter or an inner `const`
 * shadows an outer one), across the files' relative imports of each other, and blanking
 * text while keeping its line breaks.
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

/** One script of a {@link parseScripts} program: its path under the root, and its text. */
export interface ScriptSource {
  readonly path: string;
  readonly source: string;
}

/** Scripts parsed together, keyed by the path each was given, and one checker over all. */
export interface ParsedScripts {
  readonly files: ReadonlyMap<string, ts.SourceFile>;
  readonly checker: ts.TypeChecker;
  /** The syntax errors the parser reported in one of the files, by its given path. */
  readonly syntaxErrors: (path: string) => readonly ts.DiagnosticWithLocation[];
}

/**
 * Parse several scripts as one program whose checker follows a relative import from one
 * to another (as `moduleResolution: "bundler"` does), so an imported name resolves to
 * the declaration it names in the file it comes from; see {@link bindingOf}. A relative
 * specifier is followed, with or without its extension (`./c`, `./c.ts`, `./c.js`, a
 * directory's `index`). Nothing else is: a root-absolute `/src/…` path, a bundler alias
 * such as Vite's `resolve.alias`, a package, a JSON module, or a file not given resolves
 * to nothing. Every file is a module, so two files' top-level names never merge.
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
  const syntaxErrors = (path: string): readonly ts.DiagnosticWithLocation[] => {
    const file = files.get(path);
    return file === undefined ? [] : program.getSyntacticDiagnostics(file);
  };
  return { files, checker: program.getTypeChecker(), syntaxErrors };
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

/** A variable, or a module's default export, and every expression it can hold. */
export interface Binding {
  /** The declaration: one key per binding, however many names reach it. */
  readonly declaration: ts.VariableDeclaration | ts.ExportAssignment;
  readonly values: readonly ts.Expression[];
}

/**
 * The binding an identifier names and every expression it can hold: a `const`'s
 * initializer; a `let` or `var`'s initializer and the right-hand side of each `=`, `+=`,
 * `||=`, `??=`, or `&&=` to it in its file; and, through an import the program resolves,
 * the same for the binding the other module exports (an `export default` expression
 * included). Undefined for a parameter, a function, a destructured name, or a name bound
 * nowhere.
 */
export function bindingOf(checker: ts.TypeChecker, identifier: ts.Identifier): Binding | undefined {
  let symbol = symbolOf(checker, identifier);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  const declaration = symbol?.declarations?.[0];
  if (symbol === undefined || declaration === undefined) return undefined;
  if (ts.isExportAssignment(declaration)) return { declaration, values: [declaration.expression] };
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name))
    return undefined;
  const initial = declaration.initializer === undefined ? [] : [declaration.initializer];
  if ((ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0)
    return { declaration, values: initial };
  const later = assignmentsIn(checker, declaration.getSourceFile()).get(symbol) ?? [];
  return { declaration, values: [...initial, ...later] };
}

/** The expressions {@link bindingOf} finds for an identifier; empty when it finds none. */
export function bindingValues(checker: ts.TypeChecker, identifier: ts.Identifier): ts.Expression[] {
  return [...(bindingOf(checker, identifier)?.values ?? [])];
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

/** An export of a module the program does not hold: its specifier, and the export's name. */
export interface ModuleOrigin {
  readonly module: string;
  /** The export's name: `default` for a default import, `*` for the module's namespace. */
  readonly name: string;
}

/** What a value can be: an export of a module outside the program, or a program file's namespace. */
type Origin = ModuleOrigin | { readonly namespace: ts.Symbol; readonly file: ts.SourceFile };

/** `node` without the parentheses, type assertions, and `!` around it, which change no value. */
export function withoutWrappers(node: ts.Expression): ts.Expression {
  let inner = node;
  while (
    ts.isParenthesizedExpression(inner) ||
    ts.isAsExpression(inner) ||
    ts.isSatisfiesExpression(inner) ||
    ts.isTypeAssertionExpression(inner) ||
    ts.isNonNullExpression(inner)
  ) {
    inner = inner.expression;
  }
  return inner;
}

/** The member a `.name` or `["name"]` access reads, when it is fixed in the source. */
export function memberName(node: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)
    ? node.argumentExpression.text
    : undefined;
}

function originsOfModule(
  checker: ts.TypeChecker,
  specifier: ts.Expression | undefined,
  name: string,
  seen: ReadonlySet<ts.Node>,
): Origin[] {
  if (specifier === undefined || !ts.isStringLiteral(specifier)) return [];
  const namespace = checker.getSymbolAtLocation(specifier);
  const file = namespace?.declarations?.[0];
  if (namespace === undefined || file === undefined || !ts.isSourceFile(file)) {
    return [{ module: specifier.text, name }];
  }
  return name === "*"
    ? [{ namespace, file }]
    : originsOfExport(checker, { namespace, file }, name, seen);
}

/**
 * What a program file's export `name` can be. An `export * from` a module outside the
 * program hides which names it supplies, so a name the file does not declare is looked
 * up in each such module.
 */
function originsOfExport(
  checker: ts.TypeChecker,
  module: { readonly namespace: ts.Symbol; readonly file: ts.SourceFile },
  name: string,
  seen: ReadonlySet<ts.Node>,
): Origin[] {
  const exported = checker.getExportsOfModule(module.namespace).find((s) => s.name === name);
  if (exported !== undefined) return originsOfSymbol(checker, exported, seen);
  return module.file.statements.flatMap((statement) =>
    ts.isExportDeclaration(statement) &&
    statement.exportClause === undefined &&
    !seen.has(statement)
      ? originsOfModule(checker, statement.moduleSpecifier, name, new Set([...seen, statement]))
      : [],
  );
}

function originsOfSymbol(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  seen: ReadonlySet<ts.Node>,
): Origin[] {
  const declaration = symbol.declarations?.[0];
  if (declaration === undefined || seen.has(declaration)) return [];
  const next = new Set([...seen, declaration]);
  if (ts.isImportSpecifier(declaration)) {
    const name = (declaration.propertyName ?? declaration.name).text;
    return originsOfModule(checker, declaration.parent.parent.parent.moduleSpecifier, name, next);
  }
  if (ts.isNamespaceImport(declaration)) {
    return originsOfModule(checker, declaration.parent.parent.moduleSpecifier, "*", next);
  }
  if (ts.isImportClause(declaration)) {
    return originsOfModule(checker, declaration.parent.moduleSpecifier, "default", next);
  }
  if (ts.isNamespaceExport(declaration)) {
    return originsOfModule(checker, declaration.parent.moduleSpecifier, "*", next);
  }
  if (ts.isExportSpecifier(declaration)) {
    const from = declaration.parent.parent.moduleSpecifier;
    if (from !== undefined) {
      return originsOfModule(
        checker,
        from,
        (declaration.propertyName ?? declaration.name).text,
        next,
      );
    }
    const local = checker.getExportSpecifierLocalTargetSymbol(declaration);
    return local === undefined ? [] : originsOfSymbol(checker, local, next);
  }
  if (ts.isExportAssignment(declaration)) {
    return originsOfExpression(checker, declaration.expression, next);
  }
  return ts.isVariableDeclaration(declaration) &&
    ts.isIdentifier(declaration.name) &&
    declaration.initializer !== undefined &&
    (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0
    ? originsOfExpression(checker, declaration.initializer, next)
    : [];
}

function originsOfExpression(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  seen: ReadonlySet<ts.Node>,
): Origin[] {
  const node = withoutWrappers(expression);
  if (ts.isIdentifier(node)) {
    const symbol = checker.getSymbolAtLocation(node);
    return symbol === undefined ? [] : originsOfSymbol(checker, symbol, seen);
  }
  const member = memberName(node);
  if (
    member === undefined ||
    !(ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
  ) {
    return [];
  }
  return originsOfExpression(checker, node.expression, seen).flatMap((origin): Origin[] => {
    if ("file" in origin) return originsOfExport(checker, origin, member, seen);
    return origin.name === "*" ? [{ module: origin.module, name: member }] : [];
  });
}

/**
 * The exports of modules outside the program that `expression` can be. An identifier
 * imported from one (by any local name; a default or namespace import too) is, and so is
 * one that reaches it through the program's own modules: a re-export
 * (`export { x } from`, `export { local as x }`, `export * from`, `export * as ns from`,
 * `export default x`), or a `const` that aliases it. So is a member read from such a
 * namespace (`core.invoke`, `core["invoke"]`). A value the program declares itself — a
 * function, a parameter, a `let`, a call's result — is none. An `export *` from several
 * outside modules gives one origin per module, since any of them may supply the name.
 */
export function moduleOrigins(checker: ts.TypeChecker, expression: ts.Expression): ModuleOrigin[] {
  return originsOfExpression(checker, expression, new Set()).filter(
    (origin): origin is ModuleOrigin => "module" in origin,
  );
}
