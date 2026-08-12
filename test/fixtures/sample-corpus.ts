/**
 * Resolves the three sample PDFs from their single canonical location
 * (`src/example_documents/`) instead of duplicating the binaries anywhere
 * under `test/`. Page-count expectations come from docs/DESIGN.md section 4
 * and are not yet asserted against real parsing output (Epic A ships no
 * parser) — they exist so Epic B+ integration tests have somewhere to hang
 * real assertions without re-deriving this table.
 */

import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const CANONICAL_DIR = resolve(here, "../../src/example_documents");

export interface SampleDocumentFixture {
  name: string;
  fileName: string;
  path: string;
  expectedPageCount: number;
}

const SAMPLES: Omit<SampleDocumentFixture, "path">[] = [
  { name: "afqtp24-3-b192", fileName: "afqtp24-3-b192.pdf", expectedPageCount: 38 },
  { name: "qtp1s0x1-1", fileName: "qtp1s0x1-1.pdf", expectedPageCount: 76 },
  { name: "releasability_statement", fileName: "releasability_statement.pdf", expectedPageCount: 1 },
];

export const sampleCorpus: SampleDocumentFixture[] = SAMPLES.map((sample) => ({
  ...sample,
  path: resolve(CANONICAL_DIR, sample.fileName),
}));

export interface SampleAvailability {
  fixture: SampleDocumentFixture;
  available: boolean;
  byteLength?: number;
}

/** Reports which canonical sample files are actually present on disk, without throwing. */
export function checkSampleAvailability(): SampleAvailability[] {
  return sampleCorpus.map((fixture) => {
    if (!existsSync(fixture.path)) {
      return { fixture, available: false };
    }
    return { fixture, available: true, byteLength: statSync(fixture.path).size };
  });
}
