import { describe, expect, it, vi } from "vitest";
import {
  createObjectUrlResolver,
  renderDocumentToHtml,
  type ParsedDocument,
} from "../../../src/pdf-content-extractor/index.ts";

function doc(): ParsedDocument {
  return {
    metadata: { pageCount: 1 },
    pages: [
      {
        pageNumber: 1,
        width: 612,
        height: 792,
        warnings: [],
        blocks: [
          { type: "heading", id: "h-1", pageNumber: 1, level: 1, text: [{ text: "<Title>" }] },
          {
            type: "paragraph",
            id: "p-1",
            pageNumber: 1,
            text: [
              { text: "safe", link: { kind: "external", href: "https://example.test?q=<x>" } },
              { text: " unsafe", link: { kind: "external", href: "javascript:alert(1)" } },
            ],
          },
          {
            type: "list",
            id: "list-1",
            pageNumber: 1,
            ordered: false,
            items: [{ id: "li-1", blocks: [{ type: "paragraph", id: "p-2", pageNumber: 1, text: [{ text: "item" }] }] }],
          },
          {
            type: "table",
            id: "table-1",
            pageNumber: 1,
            rows: [{ cells: [{ id: "th-1", pageNumber: 1, isHeader: true, colSpan: 1, rowSpan: 1, blocks: [{ type: "paragraph", id: "p-3", pageNumber: 1, text: [{ text: "cell" }] }] }] }],
          },
          { type: "figure", id: "fig-1", pageNumber: 1, imageId: "missing", altText: "\"alt\"", caption: [{ text: "<caption>" }], unsupported: true },
        ],
      },
    ],
    outline: [],
    assets: [],
    warnings: [],
    timings: { totalMs: 0, phases: [], inputBytes: 0 },
  };
}

describe("safe semantic HTML renderer", () => {
  it("escapes text and attributes while rendering semantic structures", () => {
    const html = renderDocumentToHtml(doc(), { renderUnsupportedImages: true });
    expect(html).toContain("<h1 id=\"h-1\" data-page=\"1\">&lt;Title&gt;</h1>");
    expect(html).toContain("<ul id=\"list-1\" data-page=\"1\"><li id=\"li-1\" data-page=\"1\"><p id=\"p-2\" data-page=\"1\">item</p></li></ul>");
    expect(html).toContain("<table id=\"table-1\" data-page=\"1\"><tbody><tr><th id=\"th-1\" data-page=\"1\"><p id=\"p-3\" data-page=\"1\">cell</p></th></tr></tbody></table>");
    expect(html).toContain("<figcaption>&lt;caption&gt;</figcaption>");
    expect(html).not.toContain("<Title>");
  });

  it("allowlists links and renders unsafe links as text", () => {
    const html = renderDocumentToHtml(doc());
    expect(html).toContain("href=\"https://example.test/?q=%3Cx%3E\"");
    expect(html).toContain("rel=\"noopener noreferrer\"");
    expect(html).not.toContain("javascript:");
    expect(html).toContain(" unsafe");
  });

  it("creates and revokes object URLs explicitly", () => {
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const resolver = createObjectUrlResolver([
      {
        id: "img-1",
        pageNumber: 1,
        width: 1,
        height: 1,
        mimeType: "image/png",
        bytes: new Uint8Array([1, 2, 3]),
        placements: [],
      },
    ]);
    expect(resolver.resolveAssetUrl({
      id: "img-1",
      pageNumber: 1,
      width: 1,
      height: 1,
      mimeType: "image/png",
      bytes: new Uint8Array([1]),
      placements: [],
    })).toBe("blob:test");
    resolver.cleanup();
    expect(create).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith("blob:test");
    create.mockRestore();
    revoke.mockRestore();
  });
});
