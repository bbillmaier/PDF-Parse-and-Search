/**
 * TKT-008 integration coverage: full-corpus page-tree traversal. Verifies
 * the sample page counts from docs/DESIGN.md section 4 (38, 76, 1) and that
 * every page carries usable effective dimensions and resolved content refs.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openPdfDocument } from "../../src/pdf-content-extractor/parser/document.ts";
import { traversePageTree } from "../../src/pdf-content-extractor/parser/pages.ts";
import { checkSampleAvailability } from "../fixtures/sample-corpus.ts";

describe("page tree integration", () => {
  const availability = checkSampleAvailability();

  for (const entry of availability) {
    const { fixture } = entry;

    if (!entry.available) {
      it(`BLOCKER: missing canonical sample fixture ${fixture.fileName}`, () => {
        throw new Error(`Expected sample PDF at ${fixture.path}; see docs/DESIGN.md section 4.`);
      });
      continue;
    }

    it(`traverses exactly ${fixture.expectedPageCount} pages, in order, for ${fixture.fileName}`, async () => {
      const bytes = new Uint8Array(readFileSync(fixture.path));
      const doc = await openPdfDocument(bytes);

      const progressCalls: number[] = [];
      const result = await traversePageTree(doc, doc.limits, (count) => progressCalls.push(count));

      expect(result.pages).toHaveLength(fixture.expectedPageCount);

      // Stable document order: page numbers are exactly 1..N with no gaps or repeats.
      expect(result.pages.map((p) => p.pageNumber)).toEqual(
        Array.from({ length: fixture.expectedPageCount }, (_, i) => i + 1),
      );

      // Progress was reported incrementally, once per page, matching the final count.
      expect(progressCalls).toEqual(Array.from({ length: fixture.expectedPageCount }, (_, i) => i + 1));

      for (const page of result.pages) {
        expect(page.effectiveWidth).toBeGreaterThan(0);
        expect(page.effectiveHeight).toBeGreaterThan(0);
        expect([0, 90, 180, 270]).toContain(page.rotate);
        // Every real page in this corpus has at least one content stream reference.
        expect(page.contentRefs.length).toBeGreaterThan(0);
      }

      // No unexplained /Count mismatch or duplicate/cycle warnings for these known-good samples.
      expect(result.warnings.filter((w) => w.code === "structure-inconsistency" && w.message.includes("/Count"))).toHaveLength(0);
    });
  }
});
