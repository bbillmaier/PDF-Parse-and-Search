import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PgDocumentDatabase } from "../../server/database.ts";
import { DocumentLifecycle } from "../../server/lifecycle.ts";
import { DocumentStorage } from "../../server/storage.ts";
import { generateDocumentSearchRecords, type ParsedDocument } from "../../src/pdf-content-extractor/index.ts";

const shouldRun = process.env.RUN_LOCAL_DB_TESTS === "1" || process.env.DATABASE_URL !== undefined;
const databaseUrl = process.env.DATABASE_URL ?? "postgresql://pdf_to_html:pdf_to_html_dev@localhost:54329/pdf_to_html";

const huge =
  "beacon reading noted. ".repeat(40) +
  "unrelated filler text goes on for a while before anything else. ".repeat(60) +
  "calibration was mentioned separately much later in the same block.";

function fixtureDocument(id: string, title: string): ParsedDocument {
  return {
    metadata: { id, pageCount: 5, title },
    pages: [
      {
        pageNumber: 1,
        width: 1,
        height: 1,
        warnings: [],
        blocks: [{ type: "heading", id: "h-heading", sectionId: "sec-heading", pageNumber: 1, level: 1, text: [{ text: "Hydraulic Calibration" }] }],
      },
      {
        pageNumber: 2,
        width: 1,
        height: 1,
        warnings: [],
        blocks: [
          { type: "paragraph", id: "p-body", sectionId: "sec-body", pageNumber: 2, text: [{ text: "Hydraulic Calibration" }] },
          { type: "paragraph", id: "p-phrase", sectionId: "sec-phrase", pageNumber: 2, text: [{ text: "Engine inspection completed successfully." }] },
          {
            type: "paragraph",
            id: "p-scattered",
            sectionId: "sec-scattered",
            pageNumber: 2,
            text: [{ text: "Inspection happened long after the engine was replaced entirely with a new unit." }],
          },
          { type: "paragraph", id: "p-cov-full", sectionId: "sec-cov-full", pageNumber: 2, text: [{ text: "Hydraulic calibration summary confirmed today." }] },
          { type: "heading", id: "h-cov-partial", sectionId: "sec-cov-partial-heading", pageNumber: 2, level: 1, text: [{ text: "Summary Section" }] },
          {
            type: "paragraph",
            id: "p-cov-partial",
            sectionId: "sec-cov-partial",
            pageNumber: 2,
            text: [{ text: "Hydraulic system overview only, unrelated to calibration details." }],
          },
          { type: "paragraph", id: "p-concise", sectionId: "sec-concise", pageNumber: 2, text: [{ text: "Beacon calibration confirmed nominal." }] },
          { type: "paragraph", id: "p-huge", sectionId: "sec-huge", pageNumber: 2, text: [{ text: huge }] },
        ],
      },
      {
        pageNumber: 4,
        width: 1,
        height: 1,
        warnings: [],
        blocks: [
          { type: "paragraph", id: "p-group-1", sectionId: "sec-group-shared", pageNumber: 4, text: [{ text: "Beacon reading logged once here." }] },
          { type: "paragraph", id: "p-group-2", sectionId: "sec-group-shared", pageNumber: 4, text: [{ text: "Beacon reading logged twice here." }] },
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

describe.skipIf(!shouldRun)("deterministic multi-signal search ranking against PostgreSQL (TKT-031)", () => {
  it("ranks headings, phrases, coverage, and length correctly, deterministically, safely, and with indexed candidate selection", async () => {
    const id = `ranking-${Date.now()}`;
    const title = `Ranking Fixture ${id}`;
    const root = await mkdtemp(path.join(os.tmpdir(), "pdf-ranking-pg-"));
    const database = new PgDocumentDatabase({ connectionString: databaseUrl });
    const lifecycle = new DocumentLifecycle(new DocumentStorage(root), database, "ranking-pg-test");
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

      // -- Heading above equivalent body-only match --------------------------------
      const heading = await lifecycle.search("hydraulic calibration", 50, 20);
      const headingOrder = heading.filter((r) => r.documentId === id).map((r) => r.blockId);
      expect(headingOrder.indexOf("h-heading")).toBeLessThan(headingOrder.indexOf("p-body"));

      // -- Exact phrase above scattered/reversed occurrences ------------------------
      const phrase = await lifecycle.search("engine inspection", 50, 20);
      const phraseOrder = phrase.filter((r) => r.documentId === id).map((r) => r.blockId);
      expect(phraseOrder.indexOf("p-phrase")).toBeLessThan(phraseOrder.indexOf("p-scattered"));

      // -- Full distinct-term coverage above a partial match -------------------------
      // p-cov-partial only clears PostgreSQL's indexed predicate because "summary"
      // is in its ambient section heading, not its own text -- proving the
      // coverage signal (computed from the block's own text) demotes it correctly.
      const coverage = await lifecycle.search("hydraulic calibration summary", 50, 20);
      const coverageOrder = coverage.filter((r) => r.documentId === id).map((r) => r.blockId);
      expect(coverageOrder.indexOf("p-cov-full")).toBeLessThan(coverageOrder.indexOf("p-cov-partial"));
      const partialResult = coverage.find((r) => r.blockId === "p-cov-partial");
      expect(partialResult?.scoreComponents?.coverageRatio).toBeLessThan(1);

      // -- Concise strong match above a large paragraph that only repeats terms -----
      const concise = await lifecycle.search("beacon calibration", 50, 20);
      const conciseOrder = concise.filter((r) => r.documentId === id).map((r) => r.blockId);
      expect(conciseOrder.indexOf("p-concise")).toBeLessThan(conciseOrder.indexOf("p-huge"));

      // -- Deterministic ordering across repeated searches ---------------------------
      const first = await lifecycle.search("hydraulic calibration", 50, 20);
      const second = await lifecycle.search("hydraulic calibration", 50, 20);
      expect(second).toEqual(first);

      // -- Development score diagnostics explain the ranking -------------------------
      const headingResult = heading.find((r) => r.blockId === "h-heading");
      expect(headingResult?.scoreComponents?.structuralWeight).toBeGreaterThan(
        heading.find((r) => r.blockId === "p-body")!.scoreComponents!.structuralWeight,
      );

      // -- Snippets, grouping, and navigation remain intact ---------------------------
      const grouped = await lifecycle.search("beacon", 50, 20);
      const groupedResult = grouped.find((r) => r.blockId === "p-group-1" || r.blockId === "p-group-2");
      expect(groupedResult).toBeDefined();
      expect(groupedResult!.pageNumber).toBe(4);
      expect(groupedResult!.snippet.length).toBeGreaterThan(0);
      expect(groupedResult!.matches.length).toBeGreaterThan(0);
      expect(groupedResult!.additionalMatches.length).toBeGreaterThanOrEqual(1);

      // -- Hostile query text stays safely parameterized ------------------------------
      const hostile = await lifecycle.search("'; DROP TABLE documents; --", 50, 20);
      expect(Array.isArray(hostile)).toBe(true);
      expect((await database.getDocument(id))?.title).toBe(title);

      // -- PostgreSQL uses indexed candidate selection ---------------------------------
      const plan = (await database.explainSearch("hydraulic")).join("\n");
      expect(plan).toContain("document_search_blocks_search_simple_idx");
      expect(plan.toLowerCase()).toContain("index");
    } finally {
      await database.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
