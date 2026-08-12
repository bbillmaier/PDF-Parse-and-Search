import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PgDocumentDatabase } from "../../server/database.ts";
import { DocumentLifecycle } from "../../server/lifecycle.ts";
import { DocumentStorage } from "../../server/storage.ts";
import { buildPartialFallbackTsQuery, buildPrefixTsQuery, parseSearchQuery } from "../../src/search-query.ts";
import { generateDocumentSearchRecords, type ParsedDocument } from "../../src/pdf-content-extractor/index.ts";

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
        blocks: [{ type: "heading", id: "h-1", sectionId: "sec-1", pageNumber: 1, level: 1, text: [{ text: title }] }],
      },
      {
        pageNumber: 2,
        width: 1,
        height: 1,
        warnings: [],
        blocks: [
          // -- Prefix scenario: "inspect" should find "inspection" content --
          // Three rows (one strict, two prefix-only) so the prefix stage
          // alone already reaches the useful-result threshold and partial
          // fallback never needs to run for this query -- keeps this
          // scenario's `strategy` assertion independent of "inspect"
          // mentions in other concurrently-running integration test files
          // (searches are global, not scoped to one document).
          { type: "paragraph", id: "p-insp-direct", sectionId: "sec-insp-direct", pageNumber: 2, text: [{ text: "Turbine inspect record filed." }] },
          { type: "paragraph", id: "p-insp-prefix", sectionId: "sec-insp-prefix", pageNumber: 2, text: [{ text: "Turbine inspection record filed." }] },
          { type: "paragraph", id: "p-insp-prefix-2", sectionId: "sec-insp-prefix-2", pageNumber: 2, text: [{ text: "Turbine inspection checklist filed." }] },
          // -- Partial-fallback scenario: no row has both distinct terms --
          { type: "paragraph", id: "p-partial-reservoir", sectionId: "sec-partial-reservoir", pageNumber: 2, text: [{ text: "Reservoir pressure checked today." }] },
          { type: "paragraph", id: "p-partial-manifold", sectionId: "sec-partial-manifold", pageNumber: 2, text: [{ text: "Manifold schedule posted today." }] },
          // -- Exclusion-during-fallback scenario --
          { type: "paragraph", id: "p-excl-keep", sectionId: "sec-excl-keep", pageNumber: 2, text: [{ text: "Coolant system checked today." }] },
          { type: "paragraph", id: "p-excl-drop", sectionId: "sec-excl-drop", pageNumber: 2, text: [{ text: "Coolant leak detected today." }] },
          // -- Quoted-phrase-not-weakened scenario --
          { type: "paragraph", id: "p-phrase-adjacent", sectionId: "sec-phrase-adjacent", pageNumber: 2, text: [{ text: "Throttle assembly gauge reading logged." }] },
          {
            type: "paragraph",
            id: "p-phrase-scattered",
            sectionId: "sec-phrase-scattered",
            pageNumber: 2,
            text: [{ text: "Throttle overhaul completed; assembly inspected separately." }],
          },
          { type: "paragraph", id: "p-phrase-gauge-only", sectionId: "sec-phrase-gauge-only", pageNumber: 2, text: [{ text: "Gauge calibration mentioned alone here." }] },
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

describe.skipIf(!shouldRun)("prefix matching and partial-result fallback against PostgreSQL (TKT-033)", () => {
  it("finds inspection content from 'inspect' through an indexed prefix path, ranks strict above prefix, keeps exclusions through fallback, and never weakens a quoted phrase", async () => {
    const id = `prefix-fallback-${Date.now()}`;
    const title = `Prefix Fallback Fixture ${id}`;
    const root = await mkdtemp(path.join(os.tmpdir(), "pdf-prefix-fallback-pg-"));
    const database = new PgDocumentDatabase({ connectionString: databaseUrl });
    const lifecycle = new DocumentLifecycle(new DocumentStorage(root), database, "prefix-fallback-test");
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

      // -- Acceptance criterion: "inspect" reaches "inspection" content ------
      const insp = await lifecycle.searchDetailed("turbine inspect", 50, 20);
      const inspIds = insp.results.filter((r) => r.documentId === id).map((r) => r.blockId);
      expect(inspIds).toEqual(expect.arrayContaining(["p-insp-direct", "p-insp-prefix", "p-insp-prefix-2"]));

      // -- Strict always ranks above prefix, never the reverse ---------------
      expect(inspIds.indexOf("p-insp-direct")).toBeLessThan(inspIds.indexOf("p-insp-prefix"));
      expect(inspIds.indexOf("p-insp-direct")).toBeLessThan(inspIds.indexOf("p-insp-prefix-2"));
      const direct = insp.results.find((r) => r.blockId === "p-insp-direct");
      const prefixed = insp.results.find((r) => r.blockId === "p-insp-prefix");
      expect(direct?.matchClass).toBe("direct");
      expect(prefixed?.matchClass).toBe("prefix");
      expect(insp.results.find((r) => r.blockId === "p-insp-prefix-2")?.matchClass).toBe("prefix");
      expect(insp.strategy).toBe("prefix");

      // -- Partial fallback: neither row alone has both distinct terms, but --
      // -- both are still useful, lower-ranked, coverage-scored results ------
      const partial = await lifecycle.searchDetailed("reservoir manifold", 50, 20);
      const partialIds = partial.results.filter((r) => r.documentId === id).map((r) => r.blockId);
      expect(partialIds).toEqual(expect.arrayContaining(["p-partial-reservoir", "p-partial-manifold"]));
      expect(partial.strategy).toBe("partial");
      for (const blockId of ["p-partial-reservoir", "p-partial-manifold"]) {
        const row = partial.results.find((r) => r.blockId === blockId);
        expect(row?.matchClass).toBe("partial");
        expect(row?.scoreComponents?.coverageRatio).toBeLessThan(1);
      }

      // -- Excluded terms stay excluded through every broadening stage -------
      const excluded = await lifecycle.searchDetailed("coolant -leak", 50, 20);
      const excludedIds = excluded.results.filter((r) => r.documentId === id).map((r) => r.blockId);
      expect(excludedIds).toContain("p-excl-keep");
      expect(excludedIds).not.toContain("p-excl-drop");

      // -- A quoted phrase is never satisfied by scattered, non-adjacent -----
      // -- words, even from the broadest (partial) fallback stage ------------
      const phrase = await lifecycle.searchDetailed('"throttle assembly" gauge', 50, 20);
      const phraseIds = phrase.results.filter((r) => r.documentId === id).map((r) => r.blockId);
      expect(phraseIds).toContain("p-phrase-adjacent");
      expect(phraseIds).not.toContain("p-phrase-scattered");
      expect(phraseIds).toContain("p-phrase-gauge-only");
      expect(phrase.results.find((r) => r.blockId === "p-phrase-adjacent")?.matchClass).toBe("direct");
      expect(phrase.results.find((r) => r.blockId === "p-phrase-gauge-only")?.matchClass).toBe("partial");

      // -- Every response carries the API-contract strategy field ------------
      expect(["strict", "prefix", "partial"]).toContain(insp.strategy);

      // -- PostgreSQL uses the same GIN index for prefix and partial passes --
      const inspParsed = parseSearchQuery("turbine inspect");
      if (!inspParsed.ok) throw new Error("expected ok");
      const prefixTsQuery = buildPrefixTsQuery(inspParsed.query);
      expect(prefixTsQuery).not.toBeNull();
      const prefixPlan = (await database.explainSearchByTsQuery(prefixTsQuery!.tsQuery)).join("\n");
      expect(prefixPlan.toLowerCase()).toContain("index");
      expect(prefixPlan).toContain("document_search_blocks_search_simple_idx");

      const partialParsed = parseSearchQuery("reservoir manifold");
      if (!partialParsed.ok) throw new Error("expected ok");
      const partialTsQuery = buildPartialFallbackTsQuery(partialParsed.query);
      expect(partialTsQuery).not.toBeNull();
      const partialPlan = (await database.explainSearchByTsQuery(partialTsQuery!.tsQuery)).join("\n");
      expect(partialPlan.toLowerCase()).toContain("index");
      expect(partialPlan).toContain("document_search_blocks_search_simple_idx");

      // -- Hostile input stays safely parameterized through the full ladder --
      const hostile = await lifecycle.searchDetailed("'; DROP TABLE documents; --", 50, 20);
      expect(Array.isArray(hostile.results)).toBe(true);
      expect((await database.getDocument(id))?.title).toBe(title);

      // -- Snippets, grouping, highlighting inputs, and navigation fields ----
      // -- remain intact on a broadened (prefix) result -----------------------
      expect(prefixed?.snippet.length).toBeGreaterThan(0);
      expect(prefixed?.matches.length).toBeGreaterThan(0);
      expect(prefixed?.pageNumber).toBe(2);
      expect(prefixed?.sectionId).toBe("sec-insp-prefix");
    } finally {
      await database.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
