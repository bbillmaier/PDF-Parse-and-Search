import { describe, expect, it } from "vitest";
import {
  collectSemanticIds,
  generateDocumentSearchRecords,
  htmlDestinationForBlock,
  pdfPageDestinationForPage,
  renderDocumentToHtml,
  type ParsedDocument,
} from "../../src/pdf-content-extractor/index.ts";

function document(): ParsedDocument {
  return {
    metadata: { id: "doc-1", pageCount: 1, title: "Manual <One>" },
    pages: [
      {
        pageNumber: 1,
        width: 612,
        height: 792,
        warnings: [],
        blocks: [
          { type: "heading", id: "h-1", pageNumber: 1, level: 1, text: [{ text: "Section <A>" }] },
          { type: "paragraph", id: "p-1", pageNumber: 1, text: [{ text: "Inspect pump code A-12." }] },
          {
            type: "list",
            id: "list-1",
            pageNumber: 1,
            ordered: true,
            items: [{ id: "li-1", blocks: [{ type: "paragraph", id: "p-2", pageNumber: 1, text: [{ text: "1. Tighten bolts." }] }] }],
          },
          {
            type: "table",
            id: "table-1",
            pageNumber: 1,
            rows: [
              { cells: [{ id: "th-1", pageNumber: 1, isHeader: true, colSpan: 1, rowSpan: 1, blocks: [{ type: "paragraph", id: "p-3", pageNumber: 1, text: [{ text: "Tool" }] }] }] },
              { cells: [{ id: "td-1", pageNumber: 1, isHeader: false, colSpan: 1, rowSpan: 1, blocks: [{ type: "paragraph", id: "p-4", pageNumber: 1, text: [{ text: "Wrench" }] }] }] },
            ],
          },
          { type: "figure", id: "fig-1", pageNumber: 1, imageId: "image-1", caption: [{ text: "Figure 1. Pump." }] },
        ],
      },
    ],
    outline: [],
    assets: [],
    warnings: [],
    timings: { totalMs: 0, phases: [], inputBytes: 0 },
  };
}

describe("Epic F semantic anchors and search records", () => {
  it("collects safe unique ids and exposes HTML/PDF destinations", () => {
    const doc = document();
    const ids = collectSemanticIds(doc);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^[a-z][a-z0-9-]*$/.test(id))).toBe(true);
    expect(htmlDestinationForBlock(doc.pages[0].blocks[1])).toEqual({ anchor: "#p-1" });
    expect(pdfPageDestinationForPage(3)).toEqual({ pageNumber: 3, fragment: "#page=3" });
  });

  it("renders safe anchors and escapes hostile extracted text", () => {
    const html = renderDocumentToHtml(document(), { renderUnsupportedImages: true });
    expect(html).toContain("id=\"p-1\"");
    expect(html).toContain("data-page=\"1\"");
    expect(html).toContain("&lt;A&gt;");
    expect(html).not.toContain("<A>");
  });

  it("generates deterministic JSON-serializable records with table context", () => {
    const records = generateDocumentSearchRecords(document());
    expect(records.map((record) => record.blockType)).toEqual([
      "heading",
      "paragraph",
      "list-item",
      "table-cell",
      "table-cell",
      "figure-caption",
    ]);
    expect(records.find((record) => record.blockId === "td-1")?.tableHeader).toBe("Tool");
    expect(JSON.parse(JSON.stringify(records))).toEqual(records);
    expect(JSON.stringify(generateDocumentSearchRecords(document()))).toBe(JSON.stringify(records));
  });

  it("rejects hostile document or block identifiers before records can be indexed", () => {
    const doc = document();
    doc.metadata.id = "../bad";
    expect(() => generateDocumentSearchRecords(doc)).toThrow(/Invalid document id/);
  });
});
