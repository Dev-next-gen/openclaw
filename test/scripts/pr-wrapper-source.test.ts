import { spawnSync } from "node:child_process";
import { existsSync, globSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { resolve } from "import-meta-resolve";
import ts from "typescript";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { copyPrWrapperSources } from "./pr-wrapper.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("resolves every eager import in the extracted wrapper source closure", () => {
  const root = tempDirs.make("openclaw-pr-source-closure-");
  copyPrWrapperSources(root);
  const dependencies = spawnSync(
    process.execPath,
    [
      join(root, "scripts/pr-lib/materialize-dependencies.mjs"),
      join(process.cwd(), "node_modules"),
      join(root, "node_modules"),
    ],
    { encoding: "utf8" },
  );
  expect(dependencies.status, dependencies.stderr).toBe(0);
  const config = ts.getParsedCommandLineOfConfigFile(
    join(root, "tsconfig.json"),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
      },
    },
  );
  if (!config) {
    throw new Error("Missing archived tsconfig.json");
  }
  const missing: string[] = [];
  // Check the extracted tree: the full checkout must not satisfy an omitted import.
  // Lazy application operations are outside the wrapper's startup closure.
  for (const file of globSync("**/*.{js,mjs,cjs,ts,mts,cts,tsx}", {
    cwd: root,
    exclude: ["node_modules/**"],
  })) {
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
      if (!specifier || !ts.isStringLiteral(specifier) || isBuiltin(specifier.text)) {
        continue;
      }
      const resolved = ts.resolveModuleName(
        specifier.text,
        path,
        {
          ...config.options,
          allowJs: true,
          resolveJsonModule: true,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
        },
        ts.sys,
      ).resolvedModule;
      if (!specifier.text.startsWith(".") && (!resolved || resolved.isExternalLibraryImport)) {
        const packageName = specifier.text
          .split("/")
          .slice(0, specifier.text.startsWith("@") ? 2 : 1)
          .join("/");
        if (!existsSync(join(root, "node_modules", packageName, "package.json"))) {
          missing.push(`${file}: ${specifier.text}`);
          continue;
        }
        // Validate runtime package exports too; declaration resolution alone can
        // accept a subpath that the materialized Node process cannot import.
        try {
          resolve(specifier.text, pathToFileURL(path).href);
        } catch {
          missing.push(`${file}: ${specifier.text}`);
        }
        continue;
      }
      if (!resolved || relative(root, resolved.resolvedFileName).startsWith("..")) {
        missing.push(`${file}: ${specifier.text}`);
      }
    }
  }
  expect(missing.toSorted()).toEqual([]);
});
