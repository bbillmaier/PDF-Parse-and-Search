import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { PgDocumentDatabase } from "../../server/database.ts";
import { DocumentLifecycle } from "../../server/lifecycle.ts";
import { reindexDocument } from "../../server/reindex-search-core.ts";
import { DocumentStorage } from "../../server/storage.ts";
import { generateDocumentSearchRecords, type ParsedDocument } from "../../src/pdf-content-extractor/index.ts";

/**
 * TKT-035: bounded domain synonyms and vocabulary-based typo suggestions
 * (docs/DESIGN.md section 21.6), end to end against real PostgreSQL
 * (migration 004).
 */
const shouldRun = process.env.RUN_LOCAL_DB_TESTS === "1" || process.env.DATABASE_URL !== undefined;
const databaseUrl = process.env.DATABASE_URL ?? "postgresql://pdf_to_html:pdf_to_html_dev@localhost:54329/pdf_to_html";

function fixtureDocument(id: string, title: string): ParsedDocument {
  return {
    metadata: { id, pageCount: 2, title },
    pages: [
      {
        pageNumber: 1,
        width: 1,
        height: 1,
        warnings: [],
        blocks: [{ type: "heading", id: "h-1", sectionId: "sec-1", pageNumber: 1, level: 1, text: [{ text: "Respiratory Illness Guidance" }] }],
      },
      {
        pageNumber: 2,
        width: 1,
        height: 1,
        warnings: [],
        blocks: [
          // Synonym fixtures -- "covid"/"coronavirus" (not "flu"/
          // "influenza") deliberately, so the final-term *prefix* stage
          // (TKT-033) run just before the synonym stage in the fallback
          // ladder cannot pick up unrelated real words from other documents
          // already in this shared local database (a 3-character prefix
          // like "flu" also prefix-matches ordinary English words such as
          // "fluid"/"fluorescent" that may exist elsewhere in the corpus,
          // which would satisfy the useful-result threshold before the
          // synonym stage ever runs and make this fixture's synonym-only
          // block unreachable for reasons unrelated to the feature under
          // test).
          { type: "paragraph", id: "p-covid-direct", sectionId: "sec-covid", pageNumber: 2, text: [{ text: "Covid screening is administered every autumn." }] },
          // No literal "covid" -- only reachable via the configured synonym.
          { type: "paragraph", id: "p-coronavirus-only", sectionId: "sec-corona", pageNumber: 2, text: [{ text: "Coronavirus cases rose sharply this winter." }] },
          { type: "paragraph", id: "p-coronavirus-excluded", sectionId: "sec-excluded", pageNumber: 2, text: [{ text: "Coronavirus cases rose sharply this winter at the clinic." }] },
          // Vocabulary/typo fixtures -- "inspection" must come from a
          // heading (the vocabulary is built only from titles/headings/
          // table-row headers/technical identifiers, never ordinary body
          // text), matching a real manual's own section-heading structure.
          { type: "heading", id: "h-2", sectionId: "sec-2", pageNumber: 2, level: 2, text: [{ text: "Equipment Inspection Requirements" }] },
          { type: "paragraph", id: "p-inspection", sectionId: "sec-2", pageNumber: 2, text: [{ text: "Routine checks were completed on schedule." }] },
        ],
      },
    ],
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

describe.skipIf(!shouldRun)("bounded domain synonyms and typo suggestions (TKT-035)", () => {
  it("finds synonym-only content ranked below a direct match, preserves exclusions/OR/phrases, and never reverses an unconfigured direction", async () => {
    const id = `synonyms-${Date.now()}`;
    const title = `Synonyms Fixture ${id}`;
    const root = await mkdtemp(path.join(os.tmpdir(), "pdf-synonyms-pg-"));
    const database = new PgDocumentDatabase({ connectionString: databaseUrl });
    const lifecycle = new DocumentLifecycle(new DocumentStorage(root), database, "synonyms-test");
    cleanupDocumentIds.push(id);
    try {
      const doc = fixtureDocument(id, title);
      await lifecycle.importDocument({
        documentId: id,
        title,
        originalFilename: `${id}.pdf`,
        originalPdf: new TextEncoder().encode(`%PDF-${id}`),
        semanticDocument: doc,
        assets: [],
        searchRecords: generateDocumentSearchRecords(doc),
      });

      // -- A configured synonym finds the expected content, ranked below --
      // -- the direct match ------------------------------------------------
      const detailed = await lifecycle.searchDetailed("covid", 50, 20);
      const ids = detailed.results.filter((r) => r.documentId === id).map((r) => r.blockId);
      expect(ids).toEqual(expect.arrayContaining(["p-covid-direct", "p-coronavirus-only"]));
      expect(detailed.results.find((r) => r.blockId === "p-covid-direct")?.matchClass).toBe("direct");
      expect(detailed.results.find((r) => r.blockId === "p-coronavirus-only")?.matchClass).toBe("synonym");
      expect(ids.indexOf("p-covid-direct")).toBeLessThan(ids.indexOf("p-coronavirus-only"));

      // -- Directional: searching the target term does not expand back ----
      // -- to the source term ----------------------------------------------
      const reverse = await lifecycle.searchDetailed("coronavirus", 50, 20);
      const reverseCovidOnly = reverse.results.filter((r) => r.documentId === id && r.blockId === "p-covid-direct");
      expect(reverseCovidOnly).toHaveLength(0);

      // -- Excluded terms remain excluded after expansion ------------------
      const excluded = await lifecycle.searchDetailed("covid -clinic", 50, 20);
      const excludedIds = excluded.results.filter((r) => r.documentId === id).map((r) => r.blockId);
      expect(excludedIds).toContain("p-coronavirus-only");
      expect(excludedIds).not.toContain("p-coronavirus-excluded");

      // -- Quoted phrases are not silently expanded -------------------------
      const phrase = await lifecycle.searchDetailed('"covid screening"', 50, 20);
      const phraseIds = phrase.results.filter((r) => r.documentId === id).map((r) => r.blockId);
      expect(phraseIds).toContain("p-covid-direct");
      expect(phraseIds).not.toContain("p-coronavirus-only");

      // -- Explicit OR behavior is preserved (handled by the strict pass, --
      // -- never needs the synonym stage) -----------------------------------
      const orQuery = await lifecycle.searchDetailed("coronavirus OR inspection", 50, 20);
      const orIds = orQuery.results.filter((r) => r.documentId === id).map((r) => r.blockId);
      expect(orIds).toEqual(expect.arrayContaining(["p-coronavirus-only", "p-coronavirus-excluded", "p-inspection"]));

      // -- Development diagnostics expose the expansion; strategy metadata -
      // -- reports it even without diagnostics ------------------------------
      expect(detailed.synonymExpansions).toEqual(expect.arrayContaining([{ term: "covid", expandedTerms: ["coronavirus", "sars-cov-2"] }]));
      expect(detailed.strategy).toBe("synonym");
    } finally {
      await database.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("suggests and searches a corrected spelling only after normal search is weak, ranked below direct/synonym, and updates vocabulary through import/reindex/deletion", async () => {
    const id = `typos-${Date.now()}`;
    const title = `Typos Fixture ${id}`;
    const root = await mkdtemp(path.join(os.tmpdir(), "pdf-typos-pg-"));
    const database = new PgDocumentDatabase({ connectionString: databaseUrl });
    const lifecycle = new DocumentLifecycle(new DocumentStorage(root), database, "typos-test");
    cleanupDocumentIds.push(id);
    try {
      const doc = fixtureDocument(id, title);
      await lifecycle.importDocument({
        documentId: id,
        title,
        originalFilename: `${id}.pdf`,
        originalPdf: new TextEncoder().encode(`%PDF-${id}`),
        semanticDocument: doc,
        assets: [],
        searchRecords: generateDocumentSearchRecords(doc),
      });

      // -- Vocabulary updates after import: the heading word is queryable --
      expect(await database.vocabularyHasTerm("respiratory")).toBe(true);
      expect(await database.vocabularyHasTerm("illness")).toBe(true);

      // -- A misspelling suggests the vocabulary term after normal search --
      // -- fails, ranked as a "corrected" match --------------------------
      const corrected = await lifecycle.searchDetailed("inspeciton", 50, 20);
      const correctedIds = corrected.results.filter((r) => r.documentId === id).map((r) => r.blockId);
      expect(correctedIds).toContain("p-inspection");
      expect(corrected.results.find((r) => r.blockId === "p-inspection")?.matchClass).toBe("corrected");
      expect(corrected.correctedQuery).toBe("inspection");
      expect(corrected.spellingCorrections?.[0]).toMatchObject({ originalTerm: "inspeciton", correctedTerm: "inspection" });

      // -- A successful, correctly spelled query never pays the typo cost --
      const successful = await lifecycle.searchDetailed("inspection", 50, 20);
      expect(successful.strategy).not.toBe("corrected");
      expect(successful.correctedQuery).toBeUndefined();

      // -- Irrelevant terms do not produce arbitrary corrections -----------
      const irrelevant = await lifecycle.searchDetailed("zzznonexistentterm", 50, 20);
      expect(irrelevant.results.filter((r) => r.documentId === id)).toHaveLength(0);
      expect(irrelevant.correctedQuery).toBeUndefined();

      // -- Deletion cascades vocabulary cleanup -----------------------------
      await lifecycle.deleteDocument(id);
      expect(await database.vocabularyHasTerm("respiratory")).toBe(false);

      // -- Reimport, then simulate a pre-migration document (blanked --
      // -- vocabulary) and rebuild it via the repeatable reindex path, ------
      // -- without reparsing a PDF ------------------------------------------
      cleanupDocumentIds.push(id);
      await lifecycle.importDocument({
        documentId: id,
        title,
        originalFilename: `${id}.pdf`,
        originalPdf: new TextEncoder().encode(`%PDF-${id}`),
        semanticDocument: doc,
        assets: [],
        searchRecords: generateDocumentSearchRecords(doc),
      });
      const rawPool = new pg.Pool({ connectionString: databaseUrl });
      try {
        await rawPool.query("DELETE FROM search_vocabulary_terms WHERE document_id = $1", [id]);
        expect(await database.vocabularyHasTerm("respiratory")).toBe(false);
        const result = await reindexDocument(rawPool, id);
        expect(result.vocabularyTermsWritten).toBeGreaterThan(0);
        expect(await database.vocabularyHasTerm("respiratory")).toBe(true);
        // Idempotent: re-running recomputes the identical term set.
        const rerun = await reindexDocument(rawPool, id);
        expect(rerun.vocabularyTermsWritten).toBe(result.vocabularyTermsWritten);
      } finally {
        await rawPool.end();
      }
    } finally {
      await database.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("keeps snippets, HTML/PDF navigation identity, and deterministic ranking intact for synonym and corrected results", async () => {
    const id = `nav-${Date.now()}`;
    const title = `Navigation Fixture ${id}`;
    const root = await mkdtemp(path.join(os.tmpdir(), "pdf-nav-pg-"));
    const database = new PgDocumentDatabase({ connectionString: databaseUrl });
    const lifecycle = new DocumentLifecycle(new DocumentStorage(root), database, "nav-test");
    cleanupDocumentIds.push(id);
    try {
      const doc = fixtureDocument(id, title);
      await lifecycle.importDocument({
        documentId: id,
        title,
        originalFilename: `${id}.pdf`,
        originalPdf: new TextEncoder().encode(`%PDF-${id}`),
        semanticDocument: doc,
        assets: [],
        searchRecords: generateDocumentSearchRecords(doc),
      });

      const synonymResult = (await lifecycle.searchDetailed("covid", 50, 20)).results.find((r) => r.blockId === "p-coronavirus-only");
      expect(synonymResult?.snippet).toContain("Coronavirus");
      expect(synonymResult?.pageNumber).toBe(2);

      const correctedSearch = await lifecycle.searchDetailed("inspeciton", 50, 20);
      // p-inspection is only reachable through the corrected re-search (its
      // own body text never contains "inspection" -- only its ancestor
      // heading does), and its snippet always comes from that original body
      // text, never a rewritten/corrected version of it.
      const correctedResult = correctedSearch.results.find((r) => r.blockId === "p-inspection");
      expect(correctedResult?.snippet).toContain("Routine checks were completed");
      expect(correctedResult?.pageNumber).toBe(2);
      const headingResult = correctedSearch.results.find((r) => r.blockId === "h-2");
      expect(headingResult?.snippet).toContain("Inspection");
      expect(headingResult?.matchClass).toBe("corrected");

      const first = await lifecycle.searchDetailed("covid", 50, 20);
      const second = await lifecycle.searchDetailed("covid", 50, 20);
      expect(second.results).toEqual(first.results);
    } finally {
      await database.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
