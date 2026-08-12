/**
 * Epic C (TKT-009 through TKT-013) full-corpus integration test. Runs the
 * real content interpreter, font/CMap decoding, geometry reconstruction,
 * tagged-structure resolution, and semantic block/outline/link building
 * (`src/pdf-content-extractor/pipeline.ts`) against all three sample PDFs
 * directly — following the same pattern as `page-tree.integration.test.ts`
 * (TKT-008), calling the library modules directly rather than through the
 * not-yet-wired worker protocol (see `worker.ts`'s own doc comment).
 *
 * Assertions are golden/representative per docs/DESIGN.md 14.3: known
 * headings, tables, lists, and figures appear in the expected order and
 * place, the untagged sample falls back to geometry successfully, and the
 * outline resolves. Exact text values below were captured by first running
 * this pipeline against the real corpus and reading its output, then
 * asserting on it — the standard way to build a golden fixture from a real
 * input whose "expected" content is defined by the input itself.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openPdfDocument } from "../../src/pdf-content-extractor/parser/document.ts";
import { traversePageTree } from "../../src/pdf-content-extractor/parser/pages.ts";
import { createDocumentParseContext, parseDocumentOutline, parsePage } from "../../src/pdf-content-extractor/pipeline.ts";
import { parseStructTree } from "../../src/pdf-content-extractor/structure/tagged.ts";
import { checkSampleAvailability } from "../fixtures/sample-corpus.ts";
import type { DocumentBlock, FigureBlock, HeadingBlock, ListBlock, ParagraphBlock, TableBlock } from "../../src/pdf-content-extractor/types.ts";

function headingText(block: DocumentBlock): string {
  return block.type === "heading" ? block.text.map((r) => r.text).join("").trim() : "";
}

function blockText(block: DocumentBlock): string {
  return block.type === "heading" || block.type === "paragraph" ? block.text.map((r) => r.text).join("").trim() : "";
}

function collectBlockText(block: DocumentBlock): string[] {
  if (block.type === "heading" || block.type === "paragraph") return [blockText(block)];
  if (block.type === "list") return block.items.flatMap((item) => item.blocks.flatMap(collectBlockText));
  if (block.type === "table") return block.rows.flatMap((row) => row.cells.flatMap((cell) => cell.blocks.flatMap(collectBlockText)));
  if (block.type === "figure") return [block.altText ?? "", block.caption?.map((run) => run.text).join("").trim() ?? ""].filter(Boolean);
  return [];
}

function collectFirstListItemParagraphs(list: ListBlock): string[] {
  const texts: string[] = [];
  for (const item of list.items) {
    const firstParagraph = item.blocks.find((block): block is ParagraphBlock => block.type === "paragraph");
    if (firstParagraph) texts.push(blockText(firstParagraph));
    for (const nested of item.blocks) {
      if (nested.type === "list") texts.push(...collectFirstListItemParagraphs(nested));
    }
  }
  return texts;
}

describe("Epic C sample corpus", () => {
  const availability = new Map(checkSampleAvailability().map((entry) => [entry.fixture.name, entry]));

  const afqtp = availability.get("afqtp24-3-b192");
  const qtp = availability.get("qtp1s0x1-1");
  const releasability = availability.get("releasability_statement");

  if (!afqtp?.available || !qtp?.available || !releasability?.available) {
    it("BLOCKER: one or more canonical sample fixtures are missing; see docs/DESIGN.md section 4", () => {
      throw new Error("Expected all three sample PDFs in src/example_documents/ for the Epic C integration suite.");
    });
    return;
  }

  async function openAndParseAllPages(path: string) {
    const bytes = new Uint8Array(readFileSync(path));
    const doc = await openPdfDocument(bytes);
    const { pages } = await traversePageTree(doc, doc.limits);
    const ctx = await createDocumentParseContext(doc, pages);
    const documentPages = [];
    for (const page of pages) documentPages.push(await parsePage(doc, page, ctx));
    return { doc, pages, ctx, documentPages };
  }

  describe("afqtp24-3-b192.pdf (tagged, 38 pages)", () => {
    it("parses every page without a fatal error and produces non-empty content", async () => {
      const { documentPages } = await openAndParseAllPages(afqtp.fixture.path);
      expect(documentPages).toHaveLength(38);
      const totalBlocks = documentPages.reduce((sum, p) => sum + p.blocks.length, 0);
      expect(totalBlocks).toBeGreaterThan(100);
    });

    it("recovers tagged H1 section headings in document order (TKT-012/013)", async () => {
      const { documentPages } = await openAndParseAllPages(afqtp.fixture.path);
      const headings = documentPages.flatMap((p) => p.blocks.filter((b): b is HeadingBlock => b.type === "heading"));
      const titles = headings.map(headingText);
      expect(titles).toEqual([
        "Section 1—OVERVIEW",
        "Section 2—RESPONSIBILITIES",
        "Section 3—INTRODUCTION",
        "Section 4—TRAINEE PREPARATION",
        "Section 5—KNOWLEDGE LECTURE AND EVALUATION",
        "Section 6—EXPLANATION AND DEMONSTRATION",
        "Section 7—TRAINEE PERFORMANCE AND EVALUATION",
        "Attachment 1",
        "GLOSSARY OF REFERENCES AND SUPPORTING INFORMATION",
      ]);
      expect(headings.every((h) => h.level === 1)).toBe(true);
      // Stable, slug-derived, and unique across the document (TKT-013).
      expect(new Set(headings.map((h) => h.id)).size).toBe(headings.length);
    });

    it("recovers a tagged table with preserved rows and cells (TKT-013)", async () => {
      const { documentPages } = await openAndParseAllPages(afqtp.fixture.path);
      const page5Tables = documentPages[4].blocks.filter((b): b is TableBlock => b.type === "table");
      expect(page5Tables.length).toBeGreaterThan(0);
      const [table] = page5Tables;
      expect(table.rows.length).toBeGreaterThan(1);
      expect(table.rows[0].cells.length).toBeGreaterThan(0);
    });

    it("recovers figures with alt text extracted from the structure tree (TKT-013)", async () => {
      const { documentPages } = await openAndParseAllPages(afqtp.fixture.path);
      const page1Figures = documentPages[0].blocks.filter((b): b is FigureBlock => b.type === "figure");
      expect(page1Figures.length).toBeGreaterThanOrEqual(3);
      expect(page1Figures.some((f) => f.altText?.toLowerCase().includes("van"))).toBe(true);
      // Every figure ID is unique and non-empty even without real image bytes (Epic D).
      const ids = page1Figures.map((f) => f.imageId);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("resolves the document outline matching the tagged section headings", async () => {
      const { doc, ctx } = await openAndParseAllPages(afqtp.fixture.path);
      const outline = await parseDocumentOutline(doc, ctx);
      expect(outline).toHaveLength(9);
      expect(outline.slice(0, 3).map((o) => o.title)).toEqual([
        "Section 1—OVERVIEW",
        "Section 2—RESPONSIBILITIES",
        "Section 3—INTRODUCTION",
      ]);
      expect(outline.every((o) => o.target?.kind === "internal")).toBe(true);
    });

    it("groups list items under recognized L/LI structure (TKT-013)", async () => {
      const { documentPages } = await openAndParseAllPages(afqtp.fixture.path);
      const lists = documentPages.flatMap((p) => p.blocks.filter((b): b is ListBlock => b.type === "list"));
      expect(lists.length).toBeGreaterThan(0);
      expect(lists.every((l) => l.items.length > 0)).toBe(true);
    });

    it("normalizes Wingdings-derived private-use markers in the public semantic model (TKT-020)", async () => {
      const { documentPages } = await openAndParseAllPages(afqtp.fixture.path);
      const publicText = documentPages.flatMap((page) => page.blocks.flatMap(collectBlockText)).join("\n");

      expect(publicText).not.toContain("\uF0A7");
      expect(publicText).not.toContain("\uF0A8");
      expect(publicText).toContain("\u25AA");
      expect(publicText).toContain("\u2610");
    });

    it("sanitizes page-one figure alternate text without dropping its source description (TKT-020)", async () => {
      const { documentPages } = await openAndParseAllPages(afqtp.fixture.path);
      const page1FigureAltText = documentPages[0].blocks
        .filter((block): block is FigureBlock => block.type === "figure")
        .map((figure) => figure.altText)
        .filter((text): text is string => text !== undefined);

      expect(page1FigureAltText.length).toBeGreaterThan(0);
      expect(page1FigureAltText.every((text) => !text.includes("\u0000"))).toBe(true);
      expect(page1FigureAltText.some((text) => text.toLowerCase().includes("van"))).toBe(true);
    });

    it("removes literal lowercase o markers from unlabeled tagged list items (TKT-020)", async () => {
      const { documentPages } = await openAndParseAllPages(afqtp.fixture.path);
      const listItemParagraphs = documentPages
        .flatMap((page) => page.blocks.filter((block): block is ListBlock => block.type === "list"))
        .flatMap(collectFirstListItemParagraphs);

      expect(listItemParagraphs.length).toBeGreaterThan(0);
      expect(listItemParagraphs.filter((text) => /^o\s+/.test(text))).toEqual([]);
    });

    it("reconstructs split TOC page numbers from sibling marked-content spans", async () => {
      const { documentPages } = await openAndParseAllPages(afqtp.fixture.path);
      const page2Text = documentPages[1].blocks.map(blockText).filter(Boolean);
      expect(page2Text).toContain("Attachment 3—PERFORMANCE TEST 27");
      expect(page2Text).toContain("Attachment 4—SEVEN-STEP INSPECTION PROCESS 31");
      expect(page2Text).not.toContain("27");
      expect(page2Text).not.toContain("1");
    });

    it("collapses nested singleton list wrappers around numbered paragraphs", async () => {
      const { documentPages } = await openAndParseAllPages(afqtp.fixture.path);
      const page3 = documentPages[2];
      expect(page3.blocks.some((block) => block.type === "list")).toBe(false);
      expect(page3.blocks.map(blockText)).toContain("1.1.2.1.1.   Provide overview of training, Section 2 and Section 3.");
    });

    it("keeps separately numbered step labels as separate paragraphs inside a tagged table cell", async () => {
      const { documentPages } = await openAndParseAllPages(afqtp.fixture.path);
      const table = documentPages[32].blocks.find((block): block is TableBlock => block.type === "table");
      expect(table).toBeDefined();
      const numberedCell = table?.rows.flatMap((row) => row.cells).find((cell) =>
        cell.blocks.some((block) => blockText(block).startsWith("4.  Turn-off Engine")),
      );
      expect(numberedCell?.blocks.map(blockText).filter(Boolean)).toEqual([
        "4.  Turn-off Engine",
        "5.  Do Walk-Around Inspection",
      ]);
    });
  });

  describe("qtp1s0x1-1.pdf (tagged, 76 pages)", () => {
    it("parses every page without a fatal error", async () => {
      const { documentPages } = await openAndParseAllPages(qtp.fixture.path);
      expect(documentPages).toHaveLength(76);
    });

    it("recovers nested chapter (H1) and numbered-paragraph (H2) headings in order", async () => {
      const { documentPages } = await openAndParseAllPages(qtp.fixture.path);
      const page6Headings = documentPages[5].blocks.filter((b): b is HeadingBlock => b.type === "heading");
      expect(headingText(page6Headings[0])).toBe("Chapter 1");
      expect(page6Headings[0].level).toBe(1);
      expect(headingText(page6Headings[1])).toContain("1.1. Overview.");
      expect(page6Headings[1].level).toBe(2);
    });

    it("resolves a 31-entry outline of chapters", async () => {
      const { doc, ctx } = await openAndParseAllPages(qtp.fixture.path);
      const outline = await parseDocumentOutline(doc, ctx);
      expect(outline).toHaveLength(31);
      expect(outline.slice(0, 3).map((o) => o.title)).toEqual(["Chapter 1", "Chapter 2", "Chapter 3"]);
    });

    it("recovers tagged tables across multiple pages", async () => {
      const { documentPages } = await openAndParseAllPages(qtp.fixture.path);
      const tables = documentPages.flatMap((p) => p.blocks.filter((b): b is TableBlock => b.type === "table"));
      expect(tables.length).toBeGreaterThan(5);
    });
  });

  describe("releasability_statement.pdf (untagged, 1 page)", () => {
    it("has no structure tree and continues through the geometry fallback (TKT-011/012)", async () => {
      const bytes = new Uint8Array(readFileSync(releasability.fixture.path));
      const doc = await openPdfDocument(bytes);
      const { pages } = await traversePageTree(doc, doc.limits);
      const pageRefToNumber = new Map(pages.map((p) => [`${p.ref.num}:${p.ref.gen}`, p.pageNumber]));
      const structTree = await parseStructTree(doc, pageRefToNumber);
      expect(structTree).toBeUndefined();
    });

    it("produces readable paragraphs from geometry alone", async () => {
      const { documentPages } = await openAndParseAllPages(releasability.fixture.path);
      expect(documentPages).toHaveLength(1);
      const [page] = documentPages;
      expect(page.blocks.length).toBeGreaterThan(0);
      expect(page.blocks.every((b) => b.type === "paragraph" || b.type === "heading")).toBe(true);
      const combined = page.blocks.map(blockText).join(" ");
      expect(combined).toContain("CONTROLLED UNCLASSIFIED INFORMATION");
    });
  });

  describe("golden semantic snapshots (representative pages)", () => {
    it("matches a stable snapshot of afqtp24-3-b192.pdf page 3 (headings + lists)", async () => {
      const { documentPages } = await openAndParseAllPages(afqtp.fixture.path);
      expect(documentPages[2].blocks).toMatchSnapshot();
    });

    it("matches a stable snapshot of qtp1s0x1-1.pdf page 6 (nested headings)", async () => {
      const { documentPages } = await openAndParseAllPages(qtp.fixture.path);
      expect(documentPages[5].blocks).toMatchSnapshot();
    });

    it("matches a stable snapshot of the untagged releasability_statement.pdf page 1", async () => {
      const { documentPages } = await openAndParseAllPages(releasability.fixture.path);
      expect(documentPages[0].blocks).toMatchSnapshot();
    });
  });

  describe("safety and warnings", () => {
    it("never throws while collecting warnings across the full tagged corpus, and every warning carries a page number", async () => {
      const { documentPages } = await openAndParseAllPages(afqtp.fixture.path);
      const allWarnings = documentPages.flatMap((p) => p.warnings);
      expect(allWarnings.every((w) => typeof w.pageNumber === "number")).toBe(true);
    });

    it("paragraph and heading text never contains a raw undecoded byte marker beyond the documented U+FFFD fallback", async () => {
      const { documentPages } = await openAndParseAllPages(qtp.fixture.path);
      for (const page of documentPages) {
        for (const block of page.blocks) {
          if (block.type !== "paragraph" && block.type !== "heading") continue;
          for (const run of (block as ParagraphBlock | HeadingBlock).text) {
            expect(run.text).not.toMatch(/\0/);
          }
        }
      }
    });
  });
});
