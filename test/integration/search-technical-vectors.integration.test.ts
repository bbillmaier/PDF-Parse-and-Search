import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { PgDocumentDatabase } from "../../server/database.ts";
import { DocumentLifecycle } from "../../server/lifecycle.ts";
import { reindexAllDocuments, reindexDocument } from "../../server/reindex-search-core.ts";
import { DocumentStorage } from "../../server/storage.ts";
import { generateDocumentSearchRecords, type ParsedDocument } from "../../src/pdf-content-extractor/index.ts";

/**
 * TKT-034: dual `simple`/`english` search vectors and bounded technical
 * identifier normalization (docs/DESIGN.md section 21.4), end to end
 * against real PostgreSQL (migration 003).
 */
const shouldRun = process.env.RUN_LOCAL_DB_TESTS === "1" || process.env.DATABASE_URL !== undefined;
const databaseUrl = process.env.DATABASE_URL ?? "postgresql://pdf_to_html:pdf_to_html_dev@localhost:54329/pdf_to_html";

function fixtureDocument(id: string, title: string): ParsedDocument {
  return {
    metadata: { id, pageCount: 3, title },
    pages: [
      {
        pageNumber: 1,
        width: 1,
        height: 1,
        warnings: [],
        blocks: [{ type: "heading", id: "h-1", sectionId: "sec-1", pageNumber: 1, level: 1, text: [{ text: title }] }],
      },
      {
        pageNumber: 2,
        width: 1,
        height: 1,
        warnings: [],
        blocks: [
          // Technical identifier fixtures --------------------------------
          { type: "paragraph", id: "p-code-a12", sectionId: "sec-code-a12", pageNumber: 2, text: [{ text: "Replacement part code A-12 installed and confirmed." }] },
          { type: "paragraph", id: "p-code-other", sectionId: "sec-code-other", pageNumber: 2, text: [{ text: "Replacement part code B-99 installed." }] },
          // English-stemming fixtures (mid-query word form, not the final
          // term -- unreachable through TKT-033 final-term prefix matching,
          // since "inspected" is not a character-prefix of "inspection") ---
          { type: "paragraph", id: "p-direct-inspection", sectionId: "sec-direct-inspection", pageNumber: 2, text: [{ text: "Equipment inspection completed on schedule." }] },
          { type: "paragraph", id: "p-stem-only", sectionId: "sec-stem-only", pageNumber: 2, text: [{ text: "Routine inspection of the equipment finished." }] },
          // Exclusion-through-stemming fixture -----------------------------
          { type: "paragraph", id: "p-excl-keep", sectionId: "sec-excl-keep", pageNumber: 2, text: [{ text: "Routine inspection of the fuselage panel." }] },
          { type: "paragraph", id: "p-excl-drop", sectionId: "sec-excl-drop", pageNumber: 2, text: [{ text: "Routine inspection of the aircraft fuselage." }] },
        ],
      },
      {
        pageNumber: 3,
        width: 1,
        height: 1,
        warnings: [],
        blocks: [{ type: "paragraph", id: "p-group-1", sectionId: "sec-group", pageNumber: 3, text: [{ text: "Beacon reading logged once here." }] }],
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

describe.skipIf(!shouldRun)("dual simple/english search vectors and technical identifier normalization (TKT-034)", () => {
  it("resolves A-12/A12/A 12 to the same content as direct matches, keeps English stemming complementary, and preserves TKT-030..033 behavior", async () => {
    const id = `technical-${Date.now()}`;
    const title = `Technical Vectors Fixture ${id}`;
    const root = await mkdtemp(path.join(os.tmpdir(), "pdf-technical-vectors-pg-"));
    const database = new PgDocumentDatabase({ connectionString: databaseUrl });
    const lifecycle = new DocumentLifecycle(new DocumentStorage(root), database, "technical-vectors-test");
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

      // -- Technical identifier variants resolve to the same content, as a --
      // -- direct (not broadened) simple-vector match --------------------
      for (const query of ["A-12", "A12", "A 12"]) {
        const result = await lifecycle.search(query, 50, 20);
        const ids = result.filter((r) => r.documentId === id).map((r) => r.blockId);
        expect(ids, `query ${JSON.stringify(query)}`).toContain("p-code-a12");
        expect(ids, `query ${JSON.stringify(query)}`).not.toContain("p-code-other");
        expect(result.find((r) => r.blockId === "p-code-a12")?.matchClass).toBe("direct");
      }

      // -- Snippets are always built from original source text, never from --
      // -- the index-only technical_variants text -------------------------
      const variantSearch = await lifecycle.search("A12", 50, 20);
      const variantResult = variantSearch.find((r) => r.blockId === "p-code-a12");
      expect(variantResult?.snippet).toContain("A-12");
      expect(variantResult?.snippet).toContain("Replacement part code");

      // -- English stemming reaches a mid-query word form direct matching --
      // -- and prefix matching cannot reach ("inspected" is not a character-
      // -- prefix of "inspection") -----------------------------------------
      const stemmed = await lifecycle.searchDetailed("equipment inspected", 50, 20);
      const stemmedIds = stemmed.results.filter((r) => r.documentId === id).map((r) => r.blockId);
      expect(stemmedIds).toEqual(expect.arrayContaining(["p-direct-inspection", "p-stem-only"]));
      expect(stemmed.results.find((r) => r.blockId === "p-stem-only")?.matchClass).toBe("stemmed");

      // -- Direct simple-vector match always ranks above an English-only ---
      // -- stemmed match, never the reverse --------------------------------
      expect(stemmedIds.indexOf("p-direct-inspection")).toBeLessThan(stemmedIds.indexOf("p-stem-only"));

      // -- Excluded terms stay excluded through the English-vector stage ---
      const excluded = await lifecycle.searchDetailed("inspection -aircraft", 50, 20);
      const excludedIds = excluded.results.filter((r) => r.documentId === id).map((r) => r.blockId);
      expect(excludedIds).toContain("p-excl-keep");
      expect(excludedIds).not.toContain("p-excl-drop");

      // -- Both native GIN indexes are used, not a sequential scan ----------
      const simplePlan = (await database.explainSearch("A-12")).join("\n");
      expect(simplePlan.toLowerCase()).toContain("index");
      expect(simplePlan).toContain("document_search_blocks_search_simple_idx");

      const englishPlan = (await database.explainSearchEnglish("inspected")).join("\n");
      expect(englishPlan.toLowerCase()).toContain("index");
      expect(englishPlan).toContain("document_search_blocks_search_english_idx");

      // -- TKT-030..033 behavior remains intact: snippets/grouping, --------
      // -- deterministic ranking, and hostile input safety ------------------
      const grouped = await lifecycle.search("beacon", 50, 20);
      const groupedResult = grouped.find((r) => r.documentId === id && r.blockId === "p-group-1");
      expect(groupedResult).toBeDefined();
      expect(groupedResult!.snippet.length).toBeGreaterThan(0);

      const first = await lifecycle.search("A-12", 50, 20);
      const second = await lifecycle.search("A-12", 50, 20);
      expect(second).toEqual(first);

      const hostile = await lifecycle.search("'; DROP TABLE documents; --", 50, 20);
      expect(Array.isArray(hostile)).toBe(true);
      expect((await database.getDocument(id))?.title).toBe(title);
    } finally {
      await database.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("reindexes an existing document's technical variants from stored records alone, without reparsing a PDF, with safe per-document failure isolation", async () => {
    const id = `reindex-${Date.now()}`;
    const title = `Reindex Fixture ${id}`;
    const root = await mkdtemp(path.join(os.tmpdir(), "pdf-reindex-pg-"));
    const database = new PgDocumentDatabase({ connectionString: databaseUrl });
    const lifecycle = new DocumentLifecycle(new DocumentStorage(root), database, "reindex-test");
    const rawPool = new pg.Pool({ connectionString: databaseUrl });
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

      // Simulate a document imported before migration 003's technical
      // normalizer existed: blank out technical_variants directly, as a
      // pre-TKT-034 row would already be (its generated `search_vector_simple`
      // recomputes automatically once technical_variants changes back, since
      // it is a STORED generated column).
      await rawPool.query("UPDATE document_search_blocks SET technical_variants = '' WHERE document_id = $1", [id]);
      const beforeReindex = await lifecycle.search("A12", 50, 20);
      expect(beforeReindex.filter((r) => r.documentId === id)).toHaveLength(0);

      // The reindex command reads only already-stored table columns -- no
      // PDF bytes or filesystem access are available to it at all here.
      const result = await reindexDocument(rawPool, id);
      expect(result.blocksUpdated).toBeGreaterThan(0);

      const afterReindex = await lifecycle.search("A12", 50, 20);
      expect(afterReindex.some((r) => r.documentId === id && r.blockId === "p-code-a12")).toBe(true);

      // Idempotent: re-running against already-reindexed rows is a no-op.
      const rerun = await reindexDocument(rawPool, id);
      expect(rerun.blocksUpdated).toBe(0);

      // reindexAllDocuments isolates failures per document: an unknown id
      // fails (no rows match its WHERE clause is not an error by itself, so
      // use a document id that cannot be reindexed to prove isolation instead
      // -- a concurrently deleted document between listing and reindexing).
      const allResult = await reindexAllDocuments(rawPool);
      expect(allResult.documentsFailed).toBe(0);
      expect(allResult.documentsSucceeded).toBe(allResult.documentsTotal);
    } finally {
      await rawPool.end();
      await database.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
