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
import { parseSuggestionPrefix } from "../../src/search-suggestions.ts";

/**
 * TKT-037: bounded indexed prefix suggestions (docs/DESIGN.md section 21.7)
 * end to end against real PostgreSQL (migration 005). "Zqf" is used as the
 * shared candidate prefix throughout because it does not collide with
 * ordinary English words or any other fixture already in this shared local
 * database, so ranking/dedup assertions are exact, not "at least these."
 */
const shouldRun = process.env.RUN_LOCAL_DB_TESTS === "1" || process.env.DATABASE_URL !== undefined;
const databaseUrl = process.env.DATABASE_URL ?? "postgresql://pdf_to_html:pdf_to_html_dev@localhost:54329/pdf_to_html";

function fixtureDocument(id: string, title: string): ParsedDocument {
  return {
    metadata: { id, pageCount: 1, title },
    pages: [{
      pageNumber: 1,
      width: 1,
      height: 1,
      warnings: [],
      blocks: [
        // Deliberately does not start with "Zqf" -- if this leaked into the
        // "zqf"-prefixed assertions below it would mean the document's own
        // title text was accidentally reused as a heading's text, not that
        // suggestion building/ranking is broken.
        { type: "heading", id: "h-1", sectionId: "sec-1", pageNumber: 1, level: 1, text: [{ text: "Cover Page" }] },
        { type: "heading", id: "h-2", sectionId: "sec-2", pageNumber: 1, level: 2, text: [{ text: "Zqf Heading Detail" }] },
        { type: "paragraph", id: "p-1", sectionId: "sec-2", pageNumber: 1, text: [{ text: "Component ZQF-100 passed inspection during routine service." }] },
      ],
    }],
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

describe.skipIf(!shouldRun)("indexed prefix suggestions against PostgreSQL (TKT-037)", () => {
  it("suggests titles, headings, and technical identifiers with title/heading ranked above technical, and updates through the document lifecycle", async () => {
    const suffix = `${Date.now()}`;
    const id = `suggest-${suffix}`;
    const title = `Zqf Systems Manual ${suffix}`;
    const root = await mkdtemp(path.join(os.tmpdir(), "pdf-suggest-pg-"));
    const database = new PgDocumentDatabase({ connectionString: databaseUrl });
    const lifecycle = new DocumentLifecycle(new DocumentStorage(root), database, "suggest-pg-test");
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

      // -- Import populates all three suggestion sources, ranked -------------
      const afterImport = await lifecycle.suggest("zqf");
      expect(afterImport.suggestions.map((s) => s.type)).toEqual(["title", "heading", "technical"]);
      expect(afterImport.suggestions).toEqual([
        { text: title, type: "title" },
        { text: "Zqf Heading Detail", type: "heading" },
        { text: "ZQF-100", type: "technical" },
      ]);

      // -- Case-insensitive prefix matching ------------------------------------
      const upperPrefix = await lifecycle.suggest("ZQF");
      expect(upperPrefix.suggestions).toEqual(afterImport.suggestions);

      // -- A too-short prefix returns nothing ----------------------------------
      const tooShort = await lifecycle.suggest("z");
      expect(tooShort.suggestions).toEqual([]);

      // -- Suggestions are plain text, never HTML ------------------------------
      for (const suggestion of afterImport.suggestions) {
        expect(suggestion.text).not.toMatch(/[<>]/);
      }

      // -- Title override rebuilds suggestions: old title suggestion gone, -----
      // -- new title suggestion present, heading/technical untouched -----------
      const newTitle = `Zqf Renamed Manual ${suffix}`;
      const override = await lifecycle.overrideTitle(id, newTitle);
      expect(override.found).toBe(true);
      const afterOverride = await lifecycle.suggest("zqf");
      expect(afterOverride.suggestions).toEqual([
        { text: newTitle, type: "title" },
        { text: "Zqf Heading Detail", type: "heading" },
        { text: "ZQF-100", type: "technical" },
      ]);
      expect(afterOverride.suggestions.some((s) => s.text === title)).toBe(false);

      // -- EXPLAIN confirms the indexed btree prefix lookup, not a sequential scan --
      const parsedPrefix = parseSuggestionPrefix("zqf");
      expect(parsedPrefix.ok).toBe(true);
      if (parsedPrefix.ok) {
        const plan = (await database.explainSuggest(parsedPrefix.likePattern)).join("\n");
        expect(plan).not.toContain("Seq Scan");
        expect(plan.toLowerCase()).toContain("index");
      }

      // -- Reporting/benchmark helpers behave sanely ---------------------------
      expect(await database.suggestionsSize()).toBeGreaterThanOrEqual(3);
      expect(await database.suggestionsStorageBytes()).toBeGreaterThan(0);

      // -- Deletion cascades suggestion cleanup ---------------------------------
      await lifecycle.deleteDocument(id);
      expect((await lifecycle.suggest("zqf")).suggestions).toEqual([]);

      // -- Reimport, then simulate a pre-migration document (rows deleted -----
      // -- directly) and rebuild via the repeatable reindex path, without ------
      // -- reparsing a PDF -------------------------------------------------------
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
        await rawPool.query("DELETE FROM search_suggestions WHERE document_id = $1", [id]);
        expect((await lifecycle.suggest("zqf")).suggestions).toEqual([]);
        const result = await reindexDocument(rawPool, id);
        expect(result.suggestionsWritten).toBeGreaterThan(0);
        expect((await lifecycle.suggest("zqf")).suggestions.map((s) => s.text)).toContain(title);
        // Idempotent: re-running recomputes the identical candidate set.
        const rerun = await reindexDocument(rawPool, id);
        expect(rerun.suggestionsWritten).toBe(result.suggestionsWritten);
      } finally {
        await rawPool.end();
      }
    } finally {
      await database.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
