/**
 * What the harness checks that read the UI's sources (`ipc-names`, `ui-literals`) share:
 * which files are scripts and which are tests, parsing a script with a type checker so a
 * name resolves to the binding actually in scope (a parameter or an inner `const`
 * shadows an outer one), and blanking text while keeping its line breaks.
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

/** The declaration an identifier's binding comes from, shorthand `{ name }` included. */
export function declarationOf(
  checker: ts.TypeChecker,
  identifier: ts.Identifier,
): ts.Declaration | undefined {
  const symbol = ts.isShorthandPropertyAssignment(identifier.parent)
    ? checker.getShorthandAssignmentValueSymbol(identifier.parent)
    : checker.getSymbolAtLocation(identifier);
  return symbol?.declarations?.[0];
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
