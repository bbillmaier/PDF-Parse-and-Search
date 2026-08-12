/**
 * TKT-010 — font-dictionary resolution, caching, and text decoding unit
 * tests. Builds small byte-exact font dictionaries (simple Type1 with
 * WinAnsi + /Differences, and Type0/Identity-H with a /ToUnicode CMap and a
 * /W CID width array) via the shared `PdfBuilder` fixture helper, matching
 * the pattern used by the Epic B object-engine tests.
 */
import { describe, expect, it } from "vitest";
import { openPdfDocument } from "../../../src/pdf-content-extractor/parser/document.ts";
import { traversePageTree } from "../../../src/pdf-content-extractor/parser/pages.ts";
import { PdfBuilder } from "../../fixtures/pdf-builder.ts";
import {
  computeStringAdvanceForFont,
  decodePageText,
  FontCache,
  glyphWidthOf,
  normalizeSubsetFontName,
  resolvePageFonts,
} from "../../../src/pdf-content-extractor/fonts/resolve.ts";
import type { TextShowFragment } from "../../../src/pdf-content-extractor/content/interpreter.ts";
import type { ParseWarning } from "../../../src/pdf-content-extractor/types.ts";

function bytesOf(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "latin1"));
}

async function buildFixturePdf(): Promise<Uint8Array> {
  const builder = new PdfBuilder();
  builder.addObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
  builder.addObject(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  builder.addObject(
    3,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 6 0 R /F3 9 0 R /F4 11 0 R >> >> >>",
  );
  builder.addObject(
    4,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /FirstChar 65 /LastChar 67 /Widths [722 667 611] " +
      "/Encoding << /BaseEncoding /WinAnsiEncoding /Differences [65 /bullet] >> /FontDescriptor 5 0 R >>",
  );
  builder.addObject(5, "<< /Type /FontDescriptor /MissingWidth 300 >>");
  builder.addObject(
    6,
    "<< /Type /Font /Subtype /Type0 /BaseFont /Foo /Encoding /Identity-H /DescendantFonts [7 0 R] /ToUnicode 8 0 R >>",
  );
  builder.addObject(7, "<< /Type /Font /Subtype /CIDFontType2 /DW 1000 /W [1 [500 600] 10 12 700] >>");
  const cmapBody = bytesOf(
    `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
2 beginbfchar
<0001> <0048>
<0002> <0069>
endbfchar
endcmap
end
end`,
  );
  builder.addStreamObject(8, "<<", cmapBody);
  builder.addObject(
    9,
    "<< /Type /Font /Subtype /Type1 /BaseFont /ABCDEF+Wingdings-Regular /FirstChar 65 /LastChar 67 /Widths [500 500 500] " +
      "/Encoding /WinAnsiEncoding /ToUnicode 10 0 R >>",
  );
  const wingdingsCmapBody = bytesOf(
    `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
1 begincodespacerange
<00> <FF>
endcodespacerange
3 beginbfchar
<41> <F0A7>
<42> <F0A8>
<43> <E000>
endbfchar
endcmap
end
end`,
  );
  builder.addStreamObject(10, "<<", wingdingsCmapBody);
  builder.addObject(
    11,
    "<< /Type /Font /Subtype /Type1 /BaseFont /ABCDEF+CustomSymbol /FirstChar 65 /LastChar 65 /Widths [500] " +
      "/Encoding /WinAnsiEncoding /ToUnicode 12 0 R >>",
  );
  const nonWingdingsCmapBody = bytesOf(
    `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
1 begincodespacerange
<00> <FF>
endcodespacerange
1 beginbfchar
<41> <F0A7>
endbfchar
endcmap
end
end`,
  );
  builder.addStreamObject(12, "<<", nonWingdingsCmapBody);
  const buffer = builder.finalizeTraditional([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], "/Size 13 /Root 1 0 R");
  return new Uint8Array(buffer);
}

async function openFixture() {
  const bytes = await buildFixturePdf();
  const doc = await openPdfDocument(bytes);
  const { pages } = await traversePageTree(doc, doc.limits);
  return { doc, page: pages[0] };
}

function fragment(overrides: Partial<TextShowFragment>): TextShowFragment {
  return {
    kind: "text",
    pageNumber: 1,
    bytes: new Uint8Array(),
    fontResourceName: "F1",
    fontSize: 12,
    charSpacing: 0,
    wordSpacing: 0,
    horizontalScaling: 1,
    leading: 0,
    rise: 0,
    matrix: [1, 0, 0, 1, 0, 0],
    endMatrix: [1, 0, 0, 1, 0, 0],
    mcid: undefined,
    tags: [],
    artifact: false,
    sourceOffset: 0,
    ...overrides,
  };
}

describe("resolvePageFonts: simple Type1 font (WinAnsi + Differences)", () => {
  it("resolves widths, missing width, and encoding differences", async () => {
    const { doc, page } = await openFixture();
    const warnings: ParseWarning[] = [];
    const fonts = await resolvePageFonts(doc, page, new FontCache(), warnings);
    const f1 = fonts.get("F1")!;
    expect(f1.subtype).toBe("Type1");
    expect(f1.isCID).toBe(false);
    expect(f1.codeByteLength).toBe(1);
    expect(glyphWidthOf(f1, 65)).toBe(722);
    expect(glyphWidthOf(f1, 67)).toBe(611);
    expect(glyphWidthOf(f1, 90)).toBe(300); // outside Widths range: FontDescriptor /MissingWidth
    expect(f1.simpleEncoding?.[65]).toBe("•"); // /Differences override
    expect(f1.simpleEncoding?.[66]).toBe("B"); // untouched: WinAnsi base
  });
});

describe("resolvePageFonts: Type0/Identity-H font with ToUnicode and /W", () => {
  it("resolves CID widths, DW fallback, and ToUnicode mappings", async () => {
    const { doc, page } = await openFixture();
    const warnings: ParseWarning[] = [];
    const fonts = await resolvePageFonts(doc, page, new FontCache(), warnings);
    const f2 = fonts.get("F2")!;
    expect(f2.subtype).toBe("Type0");
    expect(f2.isCID).toBe(true);
    expect(f2.codeByteLength).toBe(2);
    expect(glyphWidthOf(f2, 1)).toBe(500);
    expect(glyphWidthOf(f2, 2)).toBe(600);
    expect(glyphWidthOf(f2, 11)).toBe(700); // within the 10-12 range run
    expect(glyphWidthOf(f2, 999)).toBe(1000); // falls back to /DW
    expect(f2.toUnicode?.get(1)).toBe("H");
    expect(f2.toUnicode?.get(2)).toBe("i");
    expect(warnings.some((w) => w.code === "unknown-glyph")).toBe(false);
  });
});

describe("FontCache", () => {
  it("resolves a shared font reference exactly once across pages", async () => {
    const { doc, page } = await openFixture();
    const warnings: ParseWarning[] = [];
    const cache = new FontCache();
    await resolvePageFonts(doc, page, cache, warnings);
    await resolvePageFonts(doc, page, cache, warnings);
    expect(cache.size).toBe(4); // F1-F4, not re-resolved on the second call
  });
});

describe("Wingdings-derived font normalization", () => {
  it("normalizes six-letter subset prefixes from BaseFont names", () => {
    expect(normalizeSubsetFontName("ABCDEF+Wingdings-Regular")).toBe("Wingdings-Regular");
    expect(normalizeSubsetFontName("CustomSymbol")).toBe("CustomSymbol");
  });

  it("converts only the documented private-use glyphs when the font is Wingdings-derived", async () => {
    const { doc, page } = await openFixture();
    const warnings: ParseWarning[] = [];
    const fonts = await resolvePageFonts(doc, page, new FontCache(), warnings);
    const wingdings = fonts.get("F3")!;

    expect(wingdings.normalizedBaseFontName).toBe("Wingdings-Regular");
    expect(wingdings.isWingdingsDerived).toBe(true);

    const [decoded] = decodePageText([fragment({ fontResourceName: "F3", bytes: new Uint8Array([65, 66, 67]) })], fonts, warnings);
    expect(decoded.text).toBe("\u25AA\u2610\uE000");
  });

  it("leaves the same private-use glyphs untouched for non-Wingdings fonts", async () => {
    const { doc, page } = await openFixture();
    const warnings: ParseWarning[] = [];
    const fonts = await resolvePageFonts(doc, page, new FontCache(), warnings);

    const [decoded] = decodePageText([fragment({ fontResourceName: "F4", bytes: new Uint8Array([65]) })], fonts, warnings);
    expect(fonts.get("F4")?.isWingdingsDerived).toBe(false);
    expect(decoded.text).toBe("\uF0A7");
  });
});

describe("decodePageText", () => {
  it("decodes a simple-font fragment using /Differences + WinAnsi", async () => {
    const { doc, page } = await openFixture();
    const warnings: ParseWarning[] = [];
    const fonts = await resolvePageFonts(doc, page, new FontCache(), warnings);
    const [decoded] = decodePageText([fragment({ bytes: new Uint8Array([65, 66, 67]) })], fonts, warnings);
    expect(decoded.text).toBe("•BC");
    expect(decoded.unknownGlyphCount).toBe(0);
  });

  it("decodes a Type0/Identity-H fragment using the ToUnicode CMap", async () => {
    const { doc, page } = await openFixture();
    const warnings: ParseWarning[] = [];
    const fonts = await resolvePageFonts(doc, page, new FontCache(), warnings);
    const bytes = new Uint8Array([0x00, 0x01, 0x00, 0x02]); // CIDs 1, 2 -> "H", "i"
    const [decoded] = decodePageText([fragment({ fontResourceName: "F2", bytes })], fonts, warnings);
    expect(decoded.text).toBe("Hi");
  });

  it("emits an unknown-glyph marker and warning for an unmapped code", async () => {
    const { doc, page } = await openFixture();
    const warnings: ParseWarning[] = [];
    const fonts = await resolvePageFonts(doc, page, new FontCache(), warnings);
    // Byte 0x01 is a control code with no WinAnsi/StandardEncoding mapping and no /Differences override.
    const [decoded] = decodePageText([fragment({ bytes: new Uint8Array([0x01]) })], fonts, warnings);
    expect(decoded.text).toBe("�");
    expect(decoded.unknownGlyphCount).toBe(1);
    expect(warnings.some((w) => w.code === "unknown-glyph" && w.pageNumber === 1)).toBe(true);
  });

  it("never silently discards bytes for an unresolved font resource", async () => {
    const warnings: ParseWarning[] = [];
    const [decoded] = decodePageText(
      [fragment({ fontResourceName: "Missing", bytes: new Uint8Array([1, 2, 3]) })],
      new Map(),
      warnings,
    );
    expect(decoded.text).toBe("���");
    expect(decoded.unknownGlyphCount).toBe(3);
    expect(warnings.some((w) => w.message.includes("Missing"))).toBe(true);
  });
});

describe("computeStringAdvanceForFont", () => {
  it("sums per-code widths scaled by font size, char spacing, and horizontal scaling", async () => {
    const { doc, page } = await openFixture();
    const warnings: ParseWarning[] = [];
    const fonts = await resolvePageFonts(doc, page, new FontCache(), warnings);
    const f1 = fonts.get("F1")!;
    const tx = computeStringAdvanceForFont(f1, new Uint8Array([65, 66]), {
      fontSize: 10,
      charSpacing: 1,
      wordSpacing: 0,
      horizontalScaling: 1,
    });
    // 'A' width 722, 'B' width 667: (0.722*10+1) + (0.667*10+1) = 8.22 + 7.67 = 15.89
    expect(tx).toBeCloseTo(15.89, 6);
  });
});
