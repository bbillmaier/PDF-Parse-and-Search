import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgDocumentDatabase } from "../../server/database.ts";
import { DocumentLifecycle } from "../../server/lifecycle.ts";
import { DocumentStorage } from "../../server/storage.ts";
import { collectSemanticIds, generateDocumentSearchRecords, type ParsedDocument } from "../../src/pdf-content-extractor/index.ts";

/**
 * TKT-037: deterministic search-quality regression suite (docs/DESIGN.md
 * section 21.10). One shared, deterministic fixture corpus imported once
 * (`beforeAll`) covers every required area -- title/heading weighting, exact
 * phrases, ordered-near matches, OR, exclusions, prefix, partial fallback,
 * technical identifier variants, English stemming, synonyms, typo
 * correction, snippet boundaries, grouping, every filter, and suggestion
 * ranking -- with each `it()` asserting expected top results and the
 * reported query strategy against real PostgreSQL. Hostile query, filter,
 * and extracted-text fixtures are included throughout rather than siloed
 * into one block, so each area's own hostile case sits next to the
 * well-formed case it contrasts with.
 *
 * This suite complements, and deliberately does not duplicate, the deep
 * per-mechanism coverage already in search-ranking / search-syntax /
 * search-prefix-fallback / search-technical-vectors / search-synonyms-typos
 * / search-filters / search-suggestions .integration.test.ts -- those prove
 * each mechanism's edge cases; this file proves the whole ladder produces
 * stable, expected top results and strategy labels for one deterministic
 * corpus, in one place, safe to run as a single regression gate.
 */
const shouldRun = process.env.RUN_LOCAL_DB_TESTS === "1" || process.env.DATABASE_URL !== undefined;
const databaseUrl = process.env.DATABASE_URL ?? "postgresql://pdf_to_html:pdf_to_html_dev@localhost:54329/pdf_to_html";

const HUGE_FILLER =
  "unrelated padding filler text goes on for quite a while before anything else appears in this block. ".repeat(20);

function primaryFixture(id: string, title: string): ParsedDocument {
  return {
    metadata: { id, pageCount: 14, title },
    pages: [
      { pageNumber: 1, width: 1, height: 1, warnings: [], blocks: [
        { type: "heading", id: "h-cover", sectionId: "sec-cover", pageNumber: 1, level: 1, text: [{ text: "Regression Suite Overview" }] },
      ] },
      // -- Title/heading weighting ------------------------------------------
      { pageNumber: 2, width: 1, height: 1, warnings: [], blocks: [
        { type: "heading", id: "h-weight", sectionId: "sec-weight", pageNumber: 2, level: 1, text: [{ text: "Weighting Priority Term" }] },
        { type: "paragraph", id: "p-weight", sectionId: "sec-weight-body", pageNumber: 2, text: [{ text: "Priority is only mentioned in ordinary body text here." }] },
      ] },
      // -- Exact phrase vs scattered occurrences ----------------------------
      { pageNumber: 3, width: 1, height: 1, warnings: [], blocks: [
        { type: "paragraph", id: "p-phrase", sectionId: "sec-phrase", pageNumber: 3, text: [{ text: "Regression testing completed successfully." }] },
        { type: "paragraph", id: "p-scattered", sectionId: "sec-scattered", pageNumber: 3, text: [{ text: "Testing happened well before the regression was later fully addressed." }] },
      ] },
      // -- Ordered-near vs reversed order -----------------------------------
      { pageNumber: 4, width: 1, height: 1, warnings: [], blocks: [
        { type: "paragraph", id: "p-ordered", sectionId: "sec-ordered", pageNumber: 4, text: [{ text: "Alpha module engaged, and shortly after that the beta module activated." }] },
        { type: "paragraph", id: "p-reversed", sectionId: "sec-reversed", pageNumber: 4, text: [{ text: "Beta module activated first, and only afterward did the alpha module engage." }] },
      ] },
      // -- OR and exclusion ---------------------------------------------------
      { pageNumber: 5, width: 1, height: 1, warnings: [], blocks: [
        { type: "paragraph", id: "p-widget", sectionId: "sec-widget", pageNumber: 5, text: [{ text: "Widget component installed and verified." }] },
        { type: "paragraph", id: "p-gadget", sectionId: "sec-gadget", pageNumber: 5, text: [{ text: "Gadget component installed and verified." }] },
        { type: "paragraph", id: "p-neither", sectionId: "sec-neither", pageNumber: 5, text: [{ text: "Neither of those search terms appears anywhere in this block." }] },
      ] },
      // -- Prefix search only (contains "inspection", never "inspect") -----
      { pageNumber: 6, width: 1, height: 1, warnings: [], blocks: [
        { type: "paragraph", id: "p-prefix", sectionId: "sec-prefix", pageNumber: 6, text: [{ text: "Calibration inspection finished for the cycle." }] },
      ] },
      // -- Partial fallback only: terms never co-occur in one block ---------
      { pageNumber: 7, width: 1, height: 1, warnings: [], blocks: [
        { type: "paragraph", id: "p-torque", sectionId: "sec-torque", pageNumber: 7, text: [{ text: "Torque measurement recorded today." }] },
        { type: "paragraph", id: "p-vibration", sectionId: "sec-vibration", pageNumber: 7, text: [{ text: "Vibration readings logged separately in a different context." }] },
      ] },
      // -- Technical identifier variants -------------------------------------
      { pageNumber: 8, width: 1, height: 1, warnings: [], blocks: [
        { type: "paragraph", id: "p-technical", sectionId: "sec-technical", pageNumber: 8, text: [{ text: "Assembly code A-12 replaces the earlier unit." }] },
      ] },
      // -- English stemming only: contains "inspection", query "inspected" ---
      { pageNumber: 9, width: 1, height: 1, warnings: [], blocks: [
        { type: "paragraph", id: "p-stemmed", sectionId: "sec-stemmed", pageNumber: 9, text: [{ text: "Routine inspection logged for the record." }] },
      ] },
      // -- Synonym expansion only ----------------------------------------------
      { pageNumber: 10, width: 1, height: 1, warnings: [], blocks: [
        { type: "paragraph", id: "p-synonym", sectionId: "sec-synonym", pageNumber: 10, text: [{ text: "Disinfectant supplies were restocked this week." }] },
      ] },
      // -- Typo correction only: vocabulary word from a heading, never body -
      { pageNumber: 11, width: 1, height: 1, warnings: [], blocks: [
        { type: "heading", id: "h-typo", sectionId: "sec-typo", pageNumber: 11, level: 2, text: [{ text: "Vwxregress Standard Reference" }] },
        { type: "paragraph", id: "p-typo", sectionId: "sec-typo", pageNumber: 11, text: [{ text: "Vwxregress procedure applies here for reference." }] },
      ] },
      // -- Hostile extracted text -----------------------------------------------
      { pageNumber: 12, width: 1, height: 1, warnings: [], blocks: [
        { type: "paragraph", id: "p-hostile", sectionId: "sec-hostile", pageNumber: 12, text: [
          { text: "<script>alert(1)</script> unique-hostile-term-8675309 injection' OR '1'='1" },
        ] },
      ] },
      // -- Grouping: adjacent same-section matches ------------------------------
      { pageNumber: 13, width: 1, height: 1, warnings: [], blocks: [
        { type: "paragraph", id: "p-group-1", sectionId: "sec-group", pageNumber: 13, text: [{ text: "Grouped beacon note one appears here." }] },
        { type: "paragraph", id: "p-group-2", sectionId: "sec-group", pageNumber: 13, text: [{ text: "Grouped beacon note two appears here." }] },
      ] },
      // -- Snippet boundaries: one very large block -----------------------------
      { pageNumber: 14, width: 1, height: 1, warnings: [], blocks: [
        { type: "paragraph", id: "p-huge", sectionId: "sec-huge", pageNumber: 14, text: [{ text: `${HUGE_FILLER}beacon-anchor-term appears exactly once here.${HUGE_FILLER}` }] },
        // -- Suggestion ranking: heading vs technical sharing one prefix -----
        { type: "heading", id: "h-suggest", sectionId: "sec-suggest", pageNumber: 14, level: 2, text: [{ text: "Rgqf Heading Sample" }] },
        { type: "paragraph", id: "p-suggest-tech", sectionId: "sec-suggest", pageNumber: 14, text: [{ text: "Reference component RGQF-55 documented for suggestions." }] },
      ] },
    ],
    outline: [],
    assets: [],
    warnings: [],
    timings: { totalMs: 0, phases: [], inputBytes: 0 },
  };
}

function decoyFixture(id: string, title: string): ParsedDocument {
  return {
    metadata: { id, pageCount: 1, title },
    pages: [{ pageNumber: 1, width: 1, height: 1, warnings: [], blocks: [
      { type: "paragraph", id: "p-decoy-common", sectionId: "sec-decoy", pageNumber: 1, text: [{ text: "Widget component installed in a completely different document." }] },
    ] }],
    outline: [],
    assets: [],
    warnings: [],
    timings: { totalMs: 0, phases: [], inputBytes: 0 },
  };
}

describe.skipIf(!shouldRun)("search-quality regression suite (TKT-037)", () => {
  const suffix = `${Date.now()}`;
  const primaryId = `regress-primary-${suffix}`;
  const decoyId = `regress-decoy-${suffix}`;
  const primaryTitle = `Regression Suite Manual ${suffix}`;
  const decoyTitle = `Regression Suite Decoy ${suffix}`;
  let root: string;
  let database: PgDocumentDatabase;
  let lifecycle: DocumentLifecycle;
  let primaryDoc: ParsedDocument;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "pdf-quality-regression-"));
    database = new PgDocumentDatabase({ connectionString: databaseUrl });
    lifecycle = new DocumentLifecycle(new DocumentStorage(root), database, "quality-regression-test");
    primaryDoc = primaryFixture(primaryId, primaryTitle);
    await lifecycle.importDocument({
      documentId: primaryId,
      title: primaryTitle,
      originalFilename: `${primaryId}.pdf`,
      originalPdf: new TextEncoder().encode(`%PDF-${primaryId}`),
      semanticDocument: primaryDoc,
      assets: [],
      searchRecords: generateDocumentSearchRecords(primaryDoc),
    });
    const decoyDoc = decoyFixture(decoyId, decoyTitle);
    await lifecycle.importDocument({
      documentId: decoyId,
      title: decoyTitle,
      originalFilename: `${decoyId}.pdf`,
      originalPdf: new TextEncoder().encode(`%PDF-${decoyId}`),
      semanticDocument: decoyDoc,
      assets: [],
      searchRecords: generateDocumentSearchRecords(decoyDoc),
    });
  }, 30_000);

  afterAll(async () => {
    if (!shouldRun) return;
    await database.deleteDocument(primaryId);
    await database.deleteDocument(decoyId);
    await database.close();
    await rm(root, { recursive: true, force: true });
  });

  it("ranks a title/heading match above an equivalent body-only match", async () => {
    const results = (await lifecycle.searchDetailed("priority", 50, 20)).results.filter((r) => r.documentId === primaryId);
    const order = results.map((r) => r.blockId);
    expect(order.indexOf("h-weight")).toBeLessThan(order.indexOf("p-weight"));
  });

  it("ranks an exact phrase above the same terms scattered out of phrase", async () => {
    const results = (await lifecycle.searchDetailed("regression testing", 50, 20)).results.filter((r) => r.documentId === primaryId);
    const order = results.map((r) => r.blockId);
    expect(order.indexOf("p-phrase")).toBeLessThan(order.indexOf("p-scattered"));
  });

  it("ranks in-order nearby terms above the same terms in reversed order", async () => {
    const results = (await lifecycle.searchDetailed("alpha beta", 50, 20)).results.filter((r) => r.documentId === primaryId);
    const ordered = results.find((r) => r.blockId === "p-ordered");
    const reversed = results.find((r) => r.blockId === "p-reversed");
    expect(ordered?.scoreComponents?.orderedNearMatch).toBe(true);
    expect(reversed?.scoreComponents?.orderedNearMatch).toBe(false);
    expect(results.map((r) => r.blockId).indexOf("p-ordered")).toBeLessThan(results.map((r) => r.blockId).indexOf("p-reversed"));
  });

  it("supports OR alternatives", async () => {
    const results = (await lifecycle.searchDetailed("widget OR gadget", 50, 20, { documentId: primaryId })).results;
    const blockIds = results.map((r) => r.blockId);
    expect(blockIds).toContain("p-widget");
    expect(blockIds).toContain("p-gadget");
    expect(blockIds).not.toContain("p-neither");
  });

  it("supports excluded terms", async () => {
    const results = (await lifecycle.searchDetailed("component -widget", 50, 20, { documentId: primaryId })).results;
    const blockIds = results.map((r) => r.blockId);
    expect(blockIds).toContain("p-gadget");
    expect(blockIds).not.toContain("p-widget");
  });

  it("reaches an incomplete final word through the prefix strategy", async () => {
    const detailed = await lifecycle.searchDetailed("inspect", 50, 20, { documentId: primaryId, page: "6" });
    expect(detailed.results.map((r) => r.blockId)).toEqual(["p-prefix"]);
    expect(detailed.strategy).toBe("prefix");
  });

  it("reaches terms that never co-occur through bounded partial fallback", async () => {
    const detailed = await lifecycle.searchDetailed("torque vibration", 50, 20, { documentId: primaryId, page: "7" });
    expect(detailed.results.map((r) => r.blockId).sort()).toEqual(["p-torque", "p-vibration"]);
    expect(detailed.strategy).toBe("partial");
  });

  it("resolves technical identifier variants (A-12 / A12 / A 12) to the same content", async () => {
    for (const variant of ["A-12", "A12", "A 12"]) {
      const detailed = await lifecycle.searchDetailed(variant, 50, 20, { documentId: primaryId, page: "8" });
      expect(detailed.results.map((r) => r.blockId)).toEqual(["p-technical"]);
      expect(detailed.strategy).toBe("strict");
    }
  });

  it("relates English word forms through the complementary stemmed vector", async () => {
    const detailed = await lifecycle.searchDetailed("inspected", 50, 20, { documentId: primaryId, page: "9" });
    expect(detailed.results.map((r) => r.blockId)).toEqual(["p-stemmed"]);
    expect(detailed.strategy).toBe("stemmed");
  });

  it("expands a configured domain synonym", async () => {
    const detailed = await lifecycle.searchDetailed("sanitizer", 50, 20, { documentId: primaryId, page: "10" });
    expect(detailed.results.map((r) => r.blockId)).toEqual(["p-synonym"]);
    expect(detailed.strategy).toBe("synonym");
  });

  it("offers and searches a bounded typo correction from the vocabulary", async () => {
    const detailed = await lifecycle.searchDetailed("vwxregrses", 50, 20, { documentId: primaryId, page: "11" });
    expect(detailed.strategy).toBe("corrected");
    expect(detailed.correctedQuery).toBe("vwxregress");
    expect(detailed.results.map((r) => r.blockId).sort()).toEqual(["h-typo", "p-typo"]);
    expect(detailed.results[0].blockId).toBe("h-typo");
  });

  it("finds hostile extracted text safely and returns it as inert plain text", async () => {
    const detailed = await lifecycle.searchDetailed("unique-hostile-term-8675309", 50, 20, { documentId: primaryId });
    expect(detailed.results.map((r) => r.blockId)).toEqual(["p-hostile"]);
    expect(detailed.results[0].snippet).toContain("unique-hostile-term-8675309");
    // The snippet is plain text -- the raw markup survives untouched as
    // characters, never interpreted; escaping before rendering is the host
    // UI's job (see src/document-library.ts's highlightedSnippetParts).
    expect(detailed.results[0].snippet).toContain("<script>");
  });

  it("survives a hostile SQL-injection-shaped query without error or effect", async () => {
    const detailed = await lifecycle.searchDetailed("'; DROP TABLE documents; --", 50, 20);
    expect(Array.isArray(detailed.results)).toBe(true);
    expect((await database.getDocument(primaryId))?.title).toBe(primaryTitle);
  });

  it("rejects a hostile filter value server-side before any query runs", async () => {
    await expect(lifecycle.searchDetailed("widget", 50, 20, { documentId: "'; DROP TABLE documents; --" })).rejects.toThrow();
    await expect(lifecycle.searchDetailed("widget", 50, 20, { blockType: "<script>alert(1)</script>" })).rejects.toThrow();
  });

  it("produces a bounded, match-centered snippet for a very large block", async () => {
    const detailed = await lifecycle.searchDetailed("beacon-anchor-term", 50, 20, { documentId: primaryId, page: "14" });
    const result = detailed.results.find((r) => r.blockId === "p-huge");
    expect(result).toBeDefined();
    expect(result!.snippet.length).toBeLessThan(400);
    expect(result!.snippet).toContain("beacon-anchor-term");
    expect(result!.matches.length).toBeGreaterThan(0);
    const match = result!.matches[0];
    expect(result!.snippet.slice(match.start, match.end)).toBe("beacon-anchor-term");
  });

  it("groups adjacent same-section matches while keeping both visible", async () => {
    const detailed = await lifecycle.searchDetailed("beacon", 50, 20, { documentId: primaryId, page: "13" });
    const grouped = detailed.results.find((r) => r.blockId === "p-group-1" || r.blockId === "p-group-2");
    expect(grouped).toBeDefined();
    expect(grouped!.additionalMatches.length).toBeGreaterThanOrEqual(1);
    const allBlockIds = [grouped!.blockId, ...grouped!.additionalMatches.map((m) => m.blockId)];
    expect(allBlockIds.sort()).toEqual(["p-group-1", "p-group-2"]);
  });

  it("composes every supported filter (document, page, page range, section, block type)", async () => {
    const byDocument = await lifecycle.searchDetailed("widget", 50, 20, { documentId: primaryId });
    expect(byDocument.results.every((r) => r.documentId === primaryId)).toBe(true);
    const byPage = await lifecycle.searchDetailed("beacon", 50, 20, { documentId: primaryId, page: "13" });
    expect(byPage.results.every((r) => r.pageNumber === 13)).toBe(true);
    const byRange = await lifecycle.searchDetailed("inspection", 50, 20, { documentId: primaryId, pageStart: "6", pageEnd: "9" });
    expect(byRange.results.map((r) => r.blockId).sort()).toEqual(["p-prefix", "p-stemmed"]);
    const bySection = await lifecycle.searchDetailed("beacon", 50, 20, { documentId: primaryId, sectionId: "sec-group" });
    // Same-section, same-block-type matches are grouped into one visible
    // result (see "groups adjacent same-section matches" above) -- both
    // matches are still present, one as the primary result and one folded
    // into additionalMatches.
    const bySectionBlockIds = bySection.results.flatMap((r) => [r.blockId, ...r.additionalMatches.map((m) => m.blockId)]);
    expect(bySectionBlockIds.sort()).toEqual(["p-group-1", "p-group-2"]);
    const byBlockType = await lifecycle.searchDetailed("regression", 50, 20, { documentId: primaryId, blockType: "heading" });
    expect(byBlockType.results.every((r) => r.blockType === "heading")).toBe(true);
    expect(byBlockType.results.map((r) => r.blockId)).toContain("h-cover");
  });

  it("ranks a heading suggestion above a technical-term suggestion sharing the same prefix", async () => {
    const response = await lifecycle.suggest("rgqf");
    expect(response.suggestions).toEqual([
      { text: "Rgqf Heading Sample", type: "heading" },
      { text: "RGQF-55", type: "technical" },
    ]);
  });

  it("preserves HTML-block and PDF-page navigation identity for every top result", async () => {
    const semanticIds = new Set(collectSemanticIds(primaryDoc));
    const detailed = await lifecycle.searchDetailed("regression testing", 50, 20, { documentId: primaryId });
    for (const result of detailed.results) {
      // A "document-title" result (the title itself matched) navigates to
      // opening the document, not a specific block anchor -- its blockId is
      // the document id (src/main.tsx passes `undefined` as the block for
      // this case), so it is deliberately excluded from the semantic-id
      // block-anchor check below.
      if (result.blockType === "document-title") {
        expect(result.blockId).toBe(primaryId);
      } else {
        expect(semanticIds.has(result.blockId)).toBe(true);
      }
      expect(result.pageNumber).toBeGreaterThan(0);
    }
  });

  it("returns stable, deterministic ordering across repeated executions", async () => {
    const first = await lifecycle.searchDetailed("regression testing", 50, 20, { documentId: primaryId });
    const second = await lifecycle.searchDetailed("regression testing", 50, 20, { documentId: primaryId });
    expect(second.results).toEqual(first.results);
    expect(second.strategy).toBe(first.strategy);
  });
});
