/**
 * TKT-013 — document outline (bookmarks) and safe link-target resolution
 * unit tests: explicit-array and named destinations, URI/GoTo actions,
 * protocol allowlisting, and rejection of unsafe/unsupported action types
 * (JavaScript, GoToR) so they never become active public links.
 */
import { describe, expect, it } from "vitest";
import { openPdfDocument } from "../../../src/pdf-content-extractor/parser/document.ts";
import { traversePageTree } from "../../../src/pdf-content-extractor/parser/pages.ts";
import { PdfBuilder } from "../../fixtures/pdf-builder.ts";
import { isDict } from "../../../src/pdf-content-extractor/parser/objects.ts";
import {
  resolveAction,
  resolveLinkTarget,
  resolveOutline,
  sanitizeExternalHref,
} from "../../../src/pdf-content-extractor/structure/outline.ts";

async function buildFixturePdf(): Promise<Uint8Array> {
  const b = new PdfBuilder();
  b.addObject(1, "<< /Type /Catalog /Pages 2 0 R /Outlines 5 0 R /Names << /Dests 10 0 R >> >>");
  b.addObject(2, "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>");
  b.addObject(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>");
  b.addObject(4, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>");
  b.addObject(5, "<< /Type /Outlines /First 6 0 R /Last 8 0 R /Count 3 >>");
  b.addObject(
    6,
    "<< /Title (Chapter 1) /Parent 5 0 R /Dest [3 0 R /XYZ 0 792 0] /Next 7 0 R /First 9 0 R /Last 9 0 R /Count 1 >>",
  );
  b.addObject(7, "<< /Title (Chapter 2 External Link) /Parent 5 0 R /A << /S /URI /URI (https://example.com/doc) >> /Next 8 0 R >>");
  b.addObject(8, "<< /Title (Chapter 3 Named Dest) /Parent 5 0 R /Dest (chapter3) >>");
  b.addObject(9, "<< /Title (Section 1.1) /Parent 6 0 R /Dest [3 0 R /XYZ 0 700 0] >>");
  b.addObject(10, "<< /Names [(chapter3) [4 0 R /XYZ 0 0 0]] >>");
  b.addObject(11, "<< /S /JavaScript /JS (alert) >>");
  b.addObject(12, "<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] /A << /S /URI /URI (https://example.com/annot) >> >>");
  b.addObject(13, "<< /S /GoToR /F (other.pdf) /D [0 /Fit] >>");
  const buffer = b.finalizeTraditional([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], "/Size 14 /Root 1 0 R");
  return new Uint8Array(buffer);
}

async function openFixture() {
  const bytes = await buildFixturePdf();
  const doc = await openPdfDocument(bytes);
  const { pages } = await traversePageTree(doc, doc.limits);
  const pageRefToNumber = new Map(pages.map((p) => [`${p.ref.num}:${p.ref.gen}`, p.pageNumber]));
  return { doc, pageRefToNumber };
}

describe("sanitizeExternalHref", () => {
  it("allows http, https, and mailto", () => {
    expect(sanitizeExternalHref("https://example.com")).toBe("https://example.com");
    expect(sanitizeExternalHref("http://example.com")).toBe("http://example.com");
    expect(sanitizeExternalHref("mailto:a@b.com")).toBe("mailto:a@b.com");
  });

  it("trims surrounding whitespace on an otherwise-safe href", () => {
    expect(sanitizeExternalHref("  https://example.com  ")).toBe("https://example.com");
  });

  it("rejects javascript:, data:, and other unsafe protocols", () => {
    expect(sanitizeExternalHref("javascript:alert(1)")).toBeUndefined();
    expect(sanitizeExternalHref("data:text/html,<script>1</script>")).toBeUndefined();
    expect(sanitizeExternalHref("file:///etc/passwd")).toBeUndefined();
  });
});

describe("resolveOutline", () => {
  it("resolves nested bookmarks with explicit-array and named destinations, plus a URI action", async () => {
    const { doc, pageRefToNumber } = await openFixture();
    const outline = await resolveOutline(doc, pageRefToNumber);

    expect(outline).toHaveLength(3);
    expect(outline.map((item) => item.title)).toEqual(["Chapter 1", "Chapter 2 External Link", "Chapter 3 Named Dest"]);
    expect(outline.every((item) => item.level === 1)).toBe(true);

    expect(outline[0].target).toEqual({ kind: "internal", pageNumber: 1 });
    expect(outline[0].children).toHaveLength(1);
    expect(outline[0].children[0]).toMatchObject({ title: "Section 1.1", level: 2, target: { kind: "internal", pageNumber: 1 } });

    expect(outline[1].target).toEqual({ kind: "external", href: "https://example.com/doc" });

    expect(outline[2].target).toEqual({ kind: "internal", pageNumber: 2 }); // resolved via /Names /Dests
  });

  it("returns an empty array when the document has no /Outlines", async () => {
    const b = new PdfBuilder();
    b.addObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
    b.addObject(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
    b.addObject(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>");
    const buffer = b.finalizeTraditional([1, 2, 3], "/Size 4 /Root 1 0 R");
    const doc = await openPdfDocument(new Uint8Array(buffer));
    const outline = await resolveOutline(doc, new Map());
    expect(outline).toEqual([]);
  });
});

describe("resolveAction: unsafe/unsupported action types are never exposed", () => {
  it("returns undefined for a JavaScript action", async () => {
    const { doc, pageRefToNumber } = await openFixture();
    const target = await resolveAction(doc, { kind: "ref", num: 11, gen: 0 }, pageRefToNumber, undefined);
    expect(target).toBeUndefined();
  });

  it("returns undefined for a GoToR (remote go-to) action", async () => {
    const { doc, pageRefToNumber } = await openFixture();
    const target = await resolveAction(doc, { kind: "ref", num: 13, gen: 0 }, pageRefToNumber, undefined);
    expect(target).toBeUndefined();
  });
});

describe("resolveLinkTarget", () => {
  it("resolves a Link annotation's /A URI action to an external target", async () => {
    const { doc, pageRefToNumber } = await openFixture();
    const annot = await doc.resolve({ kind: "ref", num: 12, gen: 0 });
    if (!isDict(annot)) throw new Error("expected annotation dict");
    const target = await resolveLinkTarget(doc, annot, pageRefToNumber, undefined);
    expect(target).toEqual({ kind: "external", href: "https://example.com/annot" });
  });
});
