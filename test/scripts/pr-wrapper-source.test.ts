import { globSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { copyPrWrapperSources } from "./pr-wrapper.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("includes every eager relative import in the extracted wrapper source closure", () => {
  const root = tempDirs.make("openclaw-pr-source-closure-");
  copyPrWrapperSources(root);
  const missing: string[] = [];
  // Check the extracted tree: the full checkout must not satisfy an omitted import.
  // Lazy application operations are outside the wrapper's startup closure.
  for (const file of globSync("**/*.{js,mjs,cjs,ts,mts,cts,tsx}", { cwd: root })) {
    const path = join(root, file);
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest);
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause;
        if (
          clause?.isTypeOnly ||
          (clause &&
            !clause.name &&
            clause.namedBindings &&
            ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.length > 0 &&
            clause.namedBindings.elements.every((element) => element.isTypeOnly))
        ) {
          continue;
        }
      } else if (ts.isExportDeclaration(statement)) {
        if (
          statement.isTypeOnly ||
          (statement.exportClause &&
            ts.isNamedExports(statement.exportClause) &&
            statement.exportClause.elements.length > 0 &&
            statement.exportClause.elements.every((element) => element.isTypeOnly))
        ) {
          continue;
        }
      } else {
        continue;
      }
      const specifier = statement.moduleSpecifier;
      if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith(".")) {
        continue;
      }
      const resolved = ts.resolveModuleName(
        specifier.text,
        path,
        {
          allowJs: true,
          resolveJsonModule: true,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
        },
        ts.sys,
      ).resolvedModule;
      if (!resolved || relative(root, resolved.resolvedFileName).startsWith("..")) {
        missing.push(`${file}: ${specifier.text}`);
      }
    }
  }
  expect(missing.toSorted()).toEqual([]);
});
