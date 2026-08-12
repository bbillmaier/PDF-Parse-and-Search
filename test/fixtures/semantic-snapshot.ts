/**
 * Normalizes a `ParsedDocument` into a deterministic shape suitable for
 * `expect(...).toMatchSnapshot()`, by replacing timing fields (which vary
 * run to run) with structural facts about them. Golden semantic-model tests
 * added in later epics should route their expected output through this
 * helper instead of snapshotting the raw document.
 */

import type { ParsedDocument } from "../../src/pdf-content-extractor/types.ts";

export interface SemanticSnapshot {
  metadata: ParsedDocument["metadata"];
  pages: ParsedDocument["pages"];
  outline: ParsedDocument["outline"];
  assetCount: number;
  warnings: ParsedDocument["warnings"];
  timings: { phases: string[]; hasTotal: boolean; inputBytes: number };
}

export function toSemanticSnapshot(document: ParsedDocument): SemanticSnapshot {
  return {
    metadata: document.metadata,
    pages: document.pages,
    outline: document.outline,
    assetCount: document.assets.length,
    warnings: document.warnings,
    timings: {
      phases: [...new Set(document.timings.phases.map((phase) => phase.phase))].sort(),
      hasTotal: document.timings.totalMs >= 0,
      inputBytes: document.timings.inputBytes,
    },
  };
}
