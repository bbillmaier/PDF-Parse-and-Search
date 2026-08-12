import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PgDocumentDatabase } from "../../server/database.ts";
import { DocumentLifecycle, ValidationError } from "../../server/lifecycle.ts";
import { DocumentStorage } from "../../server/storage.ts";
import { generateDocumentSearchRecords, type ParsedDocument } from "../../src/pdf-content-extractor/index.ts";

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
          // Exact-phrase adjacency fixtures --------------------------------
          { type: "paragraph", id: "p-phrase-adjacent", sectionId: "sec-adjacent", pageNumber: 2, text: [{ text: "Engine inspection completed successfully." }] },
          { type: "paragraph", id: "p-phrase-scattered", sectionId: "sec-scattered", pageNumber: 2, text: [{ text: "Inspection happened long after the engine was replaced entirely." }] },
          // OR fixtures ------------------------------------------------------
          { type: "paragraph", id: "p-or-engine", sectionId: "sec-or-engine", pageNumber: 2, text: [{ text: "The turbine engine passed its check." }] },
          { type: "paragraph", id: "p-or-motor", sectionId: "sec-or-motor", pageNumber: 2, text: [{ text: "The electric motor passed its check." }] },
          { type: "paragraph", id: "p-or-neither", sectionId: "sec-or-neither", pageNumber: 2, text: [{ text: "The wing flap passed its check." }] },
          // Exclusion fixtures -------------------------------------------
          { type: "paragraph", id: "p-exclude-keep", sectionId: "sec-exclude-keep", pageNumber: 2, text: [{ text: "Routine inspection of the fuselage panel." }] },
          { type: "paragraph", id: "p-exclude-drop", sectionId: "sec-exclude-drop", pageNumber: 2, text: [{ text: "Routine inspection of the aircraft fuselage." }] },
          // Ordinary multiword regression fixture --------------------------
          { type: "paragraph", id: "p-ordinary", sectionId: "sec-ordinary", pageNumber: 2, text: [{ text: "Hydraulic calibration confirmed nominal readings." }] },
          // Technical/hyphenated identifier fixtures -----------------------
          { type: "paragraph", id: "p-code-a12", sectionId: "sec-code-a12", pageNumber: 2, text: [{ text: "Replacement part code A-12 installed." }] },
          { type: "paragraph", id: "p-code-other", sectionId: "sec-code-other", pageNumber: 2, text: [{ text: "Replacement part code B-99 installed." }] },
        ],
      },
      {
        pageNumber: 3,
        width: 1,
        height: 1,
        warnings: [],
        blocks: [
          { type: "paragraph", id: "p-group-1", sectionId: "sec-group", pageNumber: 3, text: [{ text: "Beacon reading logged once here." }] },
          { type: "paragraph", id: "p-group-2", sectionId: "sec-group", pageNumber: 3, text: [{ text: "Beacon reading logged twice here." }] },
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

describe.skipIf(!shouldRun)("safe web-style search syntax against PostgreSQL (TKT-032)", () => {
  it("supports quoted exact phrases, OR, exclusion, ordinary multiword, and hyphenated codes end to end", async () => {
    const id = `syntax-${Date.now()}`;
    const title = `Search Syntax Fixture ${id}`;
    const root = await mkdtemp(path.join(os.tmpdir(), "pdf-search-syntax-pg-"));
    const database = new PgDocumentDatabase({ connectionString: databaseUrl });
    const lifecycle = new DocumentLifecycle(new DocumentStorage(root), database, "search-syntax-pg-test");
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

      // -- Ordinary multiword search remains supported (recall, not adjacency) --
      const ordinaryUnquoted = await lifecycle.search("engine inspection", 50, 20);
      const ordinaryIds = ordinaryUnquoted.filter((r) => r.documentId === id).map((r) => r.blockId);
      expect(ordinaryIds).toEqual(expect.arrayContaining(["p-phrase-adjacent", "p-phrase-scattered"]));

      // -- Quoted exact phrase requires adjacency at candidate selection --------
      const phrase = await lifecycle.search('"engine inspection"', 50, 20);
      const phraseIds = phrase.filter((r) => r.documentId === id).map((r) => r.blockId);
      expect(phraseIds).toContain("p-phrase-adjacent");
      expect(phraseIds).not.toContain("p-phrase-scattered");

      // -- Quoted phrase gets the TKT-031 exact-phrase ranking signal -----------
      const phraseResult = phrase.find((r) => r.blockId === "p-phrase-adjacent");
      expect(phraseResult?.scoreComponents?.exactPhraseMatch).toBe(true);

      // -- OR matches either alternative -----------------------------------------
      const orResults = await lifecycle.search("engine OR motor", 50, 20);
      const orIds = orResults.filter((r) => r.documentId === id).map((r) => r.blockId);
      expect(orIds).toEqual(expect.arrayContaining(["p-or-engine", "p-or-motor"]));
      expect(orIds).not.toContain("p-or-neither");

      // -- Exclusion removes matches containing the excluded term ----------------
      const excludeResults = await lifecycle.search("inspection -aircraft", 50, 20);
      const excludeIds = excludeResults.filter((r) => r.documentId === id).map((r) => r.blockId);
      expect(excludeIds).toContain("p-exclude-keep");
      expect(excludeIds).not.toContain("p-exclude-drop");

      // -- Ordinary multiword regression: still finds a plain two-word match ----
      const ordinaryPlain = await lifecycle.search("hydraulic calibration", 50, 20);
      expect(ordinaryPlain.some((r) => r.blockId === "p-ordinary")).toBe(true);

      // -- Hyphenated technical identifiers match predictably in their source form --
      const codeMatch = await lifecycle.search("A-12", 50, 20);
      const codeIds = codeMatch.filter((r) => r.documentId === id).map((r) => r.blockId);
      expect(codeIds).toContain("p-code-a12");
      expect(codeIds).not.toContain("p-code-other");

      // -- TKT-034: the bounded technical-identifier normalizer makes the
      // -- no-separator and space-separated spellings resolve to the same
      // -- content as the source "A-12" spelling, deterministically. --
      const codeNoHyphen = await lifecycle.search("A12", 50, 20);
      const codeNoHyphenIds = codeNoHyphen.filter((r) => r.documentId === id).map((r) => r.blockId);
      expect(codeNoHyphenIds).toContain("p-code-a12");
      expect(codeNoHyphenIds).not.toContain("p-code-other");
      const codeSpaced = await lifecycle.search("A 12", 50, 20);
      const codeSpacedIds = codeSpaced.filter((r) => r.documentId === id).map((r) => r.blockId);
      expect(codeSpacedIds).toContain("p-code-a12");
      expect(codeSpacedIds).not.toContain("p-code-other");
      // -- The variant is a direct simple-vector match, same class/priority
      // -- as the source spelling -- not a lesser broadened match class. --
      expect(codeNoHyphen.find((r) => r.blockId === "p-code-a12")?.matchClass).toBe("direct");

      // -- Snippets, grouping, and navigation remain intact for a phrase search --
      const grouped = await lifecycle.search("beacon", 50, 20);
      const groupedResult = grouped.find((r) => r.documentId === id && (r.blockId === "p-group-1" || r.blockId === "p-group-2"));
      expect(groupedResult).toBeDefined();
      expect(groupedResult!.pageNumber).toBe(3);
      expect(groupedResult!.snippet.length).toBeGreaterThan(0);
      expect(groupedResult!.matches.length).toBeGreaterThan(0);
      expect(groupedResult!.additionalMatches.length).toBeGreaterThanOrEqual(1);

      // -- Injection-looking input cannot alter SQL or escape parameter binding --
      const hostile = await lifecycle.search("'; DROP TABLE documents; --", 50, 20);
      expect(Array.isArray(hostile)).toBe(true);
      expect((await database.getDocument(id))?.title).toBe(title);

      // -- Empty/punctuation-only input never reaches the database ---------------
      await expect(lifecycle.search("!!!", 50, 20)).rejects.toBeInstanceOf(ValidationError);
      await expect(lifecycle.search("---", 50, 20)).rejects.toThrow(/no searchable words/);

      // -- Unmatched quotes and repeated operators get controlled behavior -------
      const unmatchedQuote = await lifecycle.search('"engine inspection', 50, 20);
      expect(unmatchedQuote.filter((r) => r.documentId === id).map((r) => r.blockId)).toContain("p-phrase-adjacent");
      const repeatedOr = await lifecycle.search("engine OR OR motor", 50, 20);
      const repeatedOrIds = repeatedOr.filter((r) => r.documentId === id).map((r) => r.blockId);
      expect(repeatedOrIds).toEqual(expect.arrayContaining(["p-or-engine", "p-or-motor"]));

      // -- PostgreSQL uses indexed candidate selection for phrase, OR, and exclusion queries --
      const phrasePlan = (await database.explainSearch('"engine inspection"')).join("\n");
      expect(phrasePlan.toLowerCase()).toContain("index");
      expect(phrasePlan).toContain("document_search_blocks_search_simple_idx");

      const orPlan = (await database.explainSearch("engine OR motor")).join("\n");
      expect(orPlan.toLowerCase()).toContain("index");

      const excludePlan = (await database.explainSearch("inspection -aircraft")).join("\n");
      expect(excludePlan.toLowerCase()).toContain("index");
    } finally {
      await database.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
