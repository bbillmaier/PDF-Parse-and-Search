import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PgDocumentDatabase } from "../../server/database.ts";
import { DocumentLifecycle } from "../../server/lifecycle.ts";
import { DocumentStorage } from "../../server/storage.ts";
import { generateDocumentSearchRecords, type ParsedDocument } from "../../src/pdf-content-extractor/index.ts";

/**
 * TKT-037: search filters compose safely with every supported query
 * strategy (strict, prefix, the english-stemmed pass, synonym expansion,
 * partial fallback, and typo-corrected search) and stay on indexed candidate
 * selection. Every strategy is engineered to be reachable *only* through its
 * own broadening stage for the filtered page under test (see the per-page
 * comments below), the same technique test/bench/search-bench.ts and
 * test/integration/search-ranking.integration.test.ts already use, so a
 * passing assertion proves the filter reached that specific strategy's
 * database call, not merely the strict pass.
 */
const shouldRun = process.env.RUN_LOCAL_DB_TESTS === "1" || process.env.DATABASE_URL !== undefined;
const databaseUrl = process.env.DATABASE_URL ?? "postgresql://pdf_to_html:pdf_to_html_dev@localhost:54329/pdf_to_html";

function primaryFixture(id: string, title: string): ParsedDocument {
  return {
    metadata: { id, pageCount: 10, title },
    pages: [
      { pageNumber: 1, width: 1, height: 1, warnings: [], blocks: [
        { type: "heading", id: "h-1", sectionId: "sec-h1", pageNumber: 1, level: 1, text: [{ text: "Filter Fixture Manual" }] },
      ] },
      { pageNumber: 2, width: 1, height: 1, warnings: [], blocks: [
        { type: "heading", id: "h-cal", sectionId: "sec-h-cal", pageNumber: 2, level: 2, text: [{ text: "Calibration Heading" }] },
        { type: "paragraph", id: "p-hydraulic", sectionId: "sec-p-hydraulic", pageNumber: 2, text: [{ text: "Hydraulic calibration performed successfully." }] },
        { type: "paragraph", id: "p-plain", sectionId: "sec-p-plain", pageNumber: 2, text: [{ text: "Calibration report filed for review." }] },
      ] },
      { pageNumber: 3, width: 1, height: 1, warnings: [], blocks: [
        // TKT-033 prefix stage only: contains "inspection", never "inspect".
        { type: "paragraph", id: "p-inspect", sectionId: "sec-inspect", pageNumber: 3, text: [{ text: "Scheduled inspection finished for the unit." }] },
      ] },
      { pageNumber: 4, width: 1, height: 1, warnings: [], blocks: [
        // Partial-fallback only: "pressure" and "audit" never co-occur in one block.
        { type: "paragraph", id: "p-pressure", sectionId: "sec-pressure", pageNumber: 4, text: [{ text: "Pressure levels noted separately today." }] },
        { type: "paragraph", id: "p-audit", sectionId: "sec-audit", pageNumber: 4, text: [{ text: "Audit occurred much later in a different context." }] },
      ] },
      { pageNumber: 5, width: 1, height: 1, warnings: [], blocks: [
        // English-stemmed only: contains "inspection" (not "inspected"); the
        // query below uses the complete word "inspected", which is not a
        // literal prefix of "inspection" (diverges after "inspect"), so the
        // TKT-033 prefix stage cannot reach it -- only english stemming can.
        { type: "paragraph", id: "p-stem", sectionId: "sec-stem", pageNumber: 5, text: [{ text: "Routine inspection logged for the record." }] },
      ] },
      { pageNumber: 6, width: 1, height: 1, warnings: [], blocks: [
        // Synonym only: contains "disinfectant"; query uses "sanitizer" (a
        // configured DOMAIN_SYNONYM_RULES entry), never literally present.
        { type: "paragraph", id: "p-syn", sectionId: "sec-syn", pageNumber: 6, text: [{ text: "Disinfectant supplies were restocked this week." }] },
      ] },
      { pageNumber: 7, width: 1, height: 1, warnings: [], blocks: [
        // Corrected-search only: contains "manual"; query uses "manaul", a
        // bounded-edit-distance misspelling with no configured synonym.
        { type: "paragraph", id: "p-corrected", sectionId: "sec-corrected", pageNumber: 7, text: [{ text: "Manual override procedure documented for reference." }] },
      ] },
      { pageNumber: 10, width: 1, height: 1, warnings: [], blocks: [
        // Decoy for the partial-fallback page filter: also contains
        // "pressure", on a page that must be excluded by a page=4 filter.
        { type: "paragraph", id: "p-pressure-other", sectionId: "sec-pressure-other", pageNumber: 10, text: [{ text: "Pressure inspection notes filed elsewhere entirely." }] },
      ] },
    ],
    outline: [],
    assets: [],
    warnings: [],
    timings: { totalMs: 0, phases: [], inputBytes: 0 },
  };
}

function siblingFixture(id: string, title: string): ParsedDocument {
  return {
    metadata: { id, pageCount: 2, title },
    pages: [{ pageNumber: 2, width: 1, height: 1, warnings: [], blocks: [
      { type: "paragraph", id: "p-hydraulic-sib", sectionId: "sec-sibling", pageNumber: 2, text: [{ text: "Hydraulic calibration performed successfully." }] },
    ] }],
    outline: [],
    assets: [],
    warnings: [],
    timings: { totalMs: 0, phases: [], inputBytes: 0 },
  };
}

const cleanupDocumentIds: string[] = [];

afterEach(async () => {
  if (!shouldRun || cleanupDocumentIds.length === 0) return;
  const database = new PgDocumentDatabase({ connectionString: databaseUrl });
  try {
    for (const id of cleanupDocumentIds.splice(0)) await database.deleteDocument(id);
  } finally {
    await database.close();
  }
});

describe.skipIf(!shouldRun)("search filters compose with every query strategy against PostgreSQL (TKT-037)", () => {
  it("filters by document id, page, page range, section id, and block type across every fallback strategy", async () => {
    const suffix = `${Date.now()}`;
    const primaryId = `filters-primary-${suffix}`;
    const siblingId = `filters-sibling-${suffix}`;
    const root = await mkdtemp(path.join(os.tmpdir(), "pdf-filters-pg-"));
    const database = new PgDocumentDatabase({ connectionString: databaseUrl });
    const lifecycle = new DocumentLifecycle(new DocumentStorage(root), database, "filters-pg-test");
    cleanupDocumentIds.push(primaryId, siblingId);
    try {
      const primaryDoc = primaryFixture(primaryId, `Filter Fixture Manual ${suffix}`);
      await lifecycle.importDocument({
        documentId: primaryId,
        title: primaryDoc.metadata.title!,
        originalFilename: `${primaryId}.pdf`,
        originalPdf: new TextEncoder().encode(`%PDF-${primaryId}`),
        semanticDocument: primaryDoc,
        assets: [],
        searchRecords: generateDocumentSearchRecords(primaryDoc),
      });
      const siblingDoc = siblingFixture(siblingId, `Filter Fixture Sibling ${suffix}`);
      await lifecycle.importDocument({
        documentId: siblingId,
        title: siblingDoc.metadata.title!,
        originalFilename: `${siblingId}.pdf`,
        originalPdf: new TextEncoder().encode(`%PDF-${siblingId}`),
        semanticDocument: siblingDoc,
        assets: [],
        searchRecords: generateDocumentSearchRecords(siblingDoc),
      });

      // -- documentId filter -------------------------------------------------
      const byDocument = await lifecycle.searchDetailed("calibration", 50, 20, { documentId: siblingId });
      expect(byDocument.results.every((r) => r.documentId === siblingId)).toBe(true);
      expect(byDocument.results.map((r) => r.blockId)).toContain("p-hydraulic-sib");
      expect(byDocument.filters).toEqual({ documentId: siblingId });

      // -- page filter ---------------------------------------------------------
      const byPage = await lifecycle.searchDetailed("calibration", 50, 20, { documentId: primaryId, page: "2" });
      expect(byPage.results.every((r) => r.pageNumber === 2)).toBe(true);
      expect(byPage.results.map((r) => r.blockId).sort()).toEqual(["h-cal", "p-hydraulic", "p-plain"]);

      // -- page range filter -----------------------------------------------------
      const byPageRange = await lifecycle.searchDetailed("inspection", 50, 20, { documentId: primaryId, pageStart: "3", pageEnd: "5" });
      expect(byPageRange.results.map((r) => r.blockId).sort()).toEqual(["p-inspect", "p-stem"]);
      expect(byPageRange.filters).toEqual({ documentId: primaryId, pageRange: { start: 3, end: 5 } });

      // -- section id filter -------------------------------------------------
      const bySection = await lifecycle.searchDetailed("calibration", 50, 20, { documentId: primaryId, sectionId: "sec-p-hydraulic" });
      expect(bySection.results.map((r) => r.blockId)).toEqual(["p-hydraulic"]);

      // -- block type filter -------------------------------------------------
      const byHeadingType = await lifecycle.searchDetailed("calibration", 50, 20, { documentId: primaryId, page: "2", blockType: "heading" });
      expect(byHeadingType.results.map((r) => r.blockId)).toEqual(["h-cal"]);
      const byParagraphType = await lifecycle.searchDetailed("calibration", 50, 20, { documentId: primaryId, page: "2", blockType: "paragraph" });
      expect(byParagraphType.results.map((r) => r.blockId).sort()).toEqual(["p-hydraulic", "p-plain"]);

      // -- filter composes with the TKT-033 prefix stage ------------------------
      const prefixFiltered = await lifecycle.searchDetailed("inspect", 50, 20, { documentId: primaryId, page: "3" });
      expect(prefixFiltered.results.map((r) => r.blockId)).toEqual(["p-inspect"]);
      expect(prefixFiltered.strategy).toBe("prefix");

      // -- filter composes with the TKT-033 partial-fallback stage, and
      //    excludes a decoy match on a page outside the filter -----------------
      const partialFiltered = await lifecycle.searchDetailed("pressure audit", 50, 20, { documentId: primaryId, page: "4" });
      expect(partialFiltered.results.map((r) => r.blockId).sort()).toEqual(["p-audit", "p-pressure"]);
      expect(partialFiltered.strategy).toBe("partial");
      expect(partialFiltered.results.some((r) => r.blockId === "p-pressure-other")).toBe(false);

      // -- filter composes with the TKT-034 english-stemmed stage ---------------
      const stemmedFiltered = await lifecycle.searchDetailed("inspected", 50, 20, { documentId: primaryId, page: "5" });
      expect(stemmedFiltered.results.map((r) => r.blockId)).toEqual(["p-stem"]);
      expect(stemmedFiltered.strategy).toBe("stemmed");

      // -- filter composes with the TKT-035 synonym-expansion stage -------------
      const synonymFiltered = await lifecycle.searchDetailed("sanitizer", 50, 20, { documentId: primaryId, page: "6" });
      expect(synonymFiltered.results.map((r) => r.blockId)).toEqual(["p-syn"]);
      expect(synonymFiltered.strategy).toBe("synonym");

      // -- filter composes with the TKT-035 corrected-search stage --------------
      const correctedFiltered = await lifecycle.searchDetailed("manaul", 50, 20, { documentId: primaryId, page: "7" });
      expect(correctedFiltered.results.map((r) => r.blockId)).toEqual(["p-corrected"]);
      expect(correctedFiltered.strategy).toBe("corrected");
      expect(correctedFiltered.correctedQuery).toBe("manual");

      // -- exact-phrase, OR, and exclusion syntax remain compatible with filters -
      const phraseFiltered = await lifecycle.searchDetailed('"hydraulic calibration"', 50, 20, { documentId: primaryId, page: "2" });
      expect(phraseFiltered.results.map((r) => r.blockId)).toEqual(["p-hydraulic"]);
      const exclusionFiltered = await lifecycle.searchDetailed("calibration -hydraulic", 50, 20, { documentId: primaryId, page: "2" });
      expect(exclusionFiltered.results.map((r) => r.blockId).sort()).toEqual(["h-cal", "p-plain"]);

      // -- hostile filter values are rejected server-side, never reaching SQL ---
      await expect(lifecycle.searchDetailed("calibration", 50, 20, { documentId: "'; DROP TABLE documents; --" })).rejects.toThrow();
      await expect(lifecycle.searchDetailed("calibration", 50, 20, { blockType: "document-title" })).rejects.toThrow();
      await expect(lifecycle.searchDetailed("calibration", 50, 20, { page: "-5" })).rejects.toThrow();
      await expect(lifecycle.searchDetailed("calibration", 50, 20, { pageStart: "1", pageEnd: "999999" })).rejects.toThrow();
      // A hostile-but-safely-parameterized filter value that passes format
      // validation (a well-formed but non-existent document id) must return
      // zero rows, not throw and not match anything real.
      const nonExistentDocument = await lifecycle.searchDetailed("calibration", 50, 20, { documentId: "does-not-exist" });
      expect(nonExistentDocument.results).toEqual([]);
      expect((await database.getDocument(primaryId))?.title).toBe(primaryDoc.metadata.title);

      // -- filtered queries retain indexed candidate selection ------------------
      // A highly selective documentId+page combination may lead the planner
      // to prefer the btree document_search_blocks_document_page_idx over
      // the GIN full-text index (applying search_vector_simple as a residual
      // Filter instead) -- both are legitimate indexed plans; the acceptance
      // requirement is "no sequential scan," not "always this specific
      // index." An unfiltered query (below) still confirms the GIN index by
      // name, matching the existing TKT-031/033/034 EXPLAIN assertions.
      const strictPlan = (await database.explainSearch("calibration", { documentId: primaryId, page: 2 })).join("\n");
      expect(strictPlan).not.toContain("Seq Scan");
      expect(strictPlan.toLowerCase()).toContain("index");
      const prefixPlan = (await database.explainSearchByTsQuery("inspect:*", { documentId: primaryId, page: 3 })).join("\n");
      expect(prefixPlan).not.toContain("Seq Scan");
      expect(prefixPlan.toLowerCase()).toContain("index");
      const unfilteredPlan = (await database.explainSearch("calibration")).join("\n");
      expect(unfilteredPlan).toContain("document_search_blocks_search_simple_idx");
    } finally {
      await database.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
