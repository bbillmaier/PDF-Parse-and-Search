/**
 * Enforces the design's "keep the core independent" boundary (docs/DESIGN.md
 * section 5.5) automatically, since the project has no lint tooling wired up
 * yet: no file under the portable library folder may import React, ReactDOM,
 * or reference Vite-only globals, and none may be a `.tsx` file.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const LIBRARY_ROOT = resolve(here, "../../src/pdf-content-extractor");

function listSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

const FORBIDDEN_IMPORT_PATTERN = /from\s+["'](react|react-dom)(\/|["'])/;
const FORBIDDEN_GLOBAL_PATTERN = /import\.meta\.env/;

describe("pdf-content-extractor boundary", () => {
  const files = listSourceFiles(LIBRARY_ROOT);

  it("contains source files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("has no .tsx files (no JSX in the library folder)", () => {
    const tsxFiles = files.filter((file) => file.endsWith(".tsx"));
    expect(tsxFiles).toEqual([]);
  });

  it("never imports react or react-dom", () => {
    const offenders = files.filter((file) => FORBIDDEN_IMPORT_PATTERN.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("never references Vite-only env globals", () => {
    const offenders = files.filter((file) => FORBIDDEN_GLOBAL_PATTERN.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
});
