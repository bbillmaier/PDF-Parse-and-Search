/**
 * TKT-005 — header validation, `startxref` location, and traditional
 * xref-table/trailer parsing unit tests.
 */
import { describe, expect, it } from "vitest";
import { findStartXref, parseTraditionalXrefSectionAt, validateHeader } from "../../../src/pdf-content-extractor/parser/xref.ts";
import { DEFAULT_SAFETY_LIMITS } from "../../../src/pdf-content-extractor/parser/limits.ts";
import { PdfParseError } from "../../../src/pdf-content-extractor/errors.ts";
import { PdfBuilder } from "../../fixtures/pdf-builder.ts";

function bytesOf(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "latin1"));
}

describe("validateHeader", () => {
  it("accepts a standard header", () => {
    const info = validateHeader(bytesOf("%PDF-1.7\n%binary\n"));
    expect(info.version).toBe("1.7");
    expect(info.headerOffset).toBe(0);
  });

  it("tolerates a header preceded by a small amount of leading garbage", () => {
    const info = validateHeader(bytesOf("\x00\x00%PDF-1.4\n"));
    expect(info.version).toBe("1.4");
    expect(info.headerOffset).toBe(2);
  });

  it("throws invalid-header when the signature is missing", () => {
    try {
      validateHeader(bytesOf("not a pdf file at all"));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PdfParseError);
      expect((error as PdfParseError).code).toBe("invalid-header");
    }
  });

  it("throws invalid-header when the version is malformed", () => {
    expect(() => validateHeader(bytesOf("%PDF-X.Y\n"))).toThrow(PdfParseError);
  });
});

describe("findStartXref", () => {
  it("locates the offset after the last startxref keyword", () => {
    const bytes = bytesOf("%PDF-1.7\n...\nstartxref\n9\n%%EOF");
    expect(findStartXref(bytes, DEFAULT_SAFETY_LIMITS)).toBe(9);
  });

  it("uses the LAST startxref when more than one appears in the tail window", () => {
    const bytes = bytesOf("startxref\n0\n%%EOF\nstartxref\n5\n%%EOF");
    expect(findStartXref(bytes, DEFAULT_SAFETY_LIMITS)).toBe(5);
  });

  it("throws when startxref is missing", () => {
    expect(() => findStartXref(bytesOf("%PDF-1.7\nno xref here"), DEFAULT_SAFETY_LIMITS)).toThrow(PdfParseError);
  });

  it("throws when the offset is out of file bounds", () => {
    const bytes = bytesOf("startxref\n999999\n%%EOF");
    expect(() => findStartXref(bytes, DEFAULT_SAFETY_LIMITS)).toThrow(PdfParseError);
  });

  it("throws when startxref is not followed by an integer", () => {
    const bytes = bytesOf("startxref\n/NotANumber\n%%EOF");
    expect(() => findStartXref(bytes, DEFAULT_SAFETY_LIMITS)).toThrow(PdfParseError);
  });
});

describe("parseTraditionalXrefSectionAt", () => {
  it("parses a minimal one-subsection table and trailer", () => {
    const builder = new PdfBuilder();
    builder.addObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
    builder.addObject(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
    const file = builder.finalizeTraditional([1, 2], "/Size 3 /Root 1 0 R");

    const startOffset = findStartXref(new Uint8Array(file), DEFAULT_SAFETY_LIMITS);
    const section = parseTraditionalXrefSectionAt(new Uint8Array(file), startOffset, DEFAULT_SAFETY_LIMITS);

    expect(section.entries.get(0)).toEqual({ type: "free" });
    const entry1 = section.entries.get(1);
    expect(entry1?.type).toBe("offset");
    if (entry1?.type === "offset") expect(entry1.offset).toBe(builder.getObjectOffset(1));
    expect(section.trailer.get("Size")).toBe(3);
    expect(section.prevOffset).toBeUndefined();
  });

  it("captures /Prev for incremental updates", () => {
    const builder = new PdfBuilder();
    builder.addObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
    const file = builder.finalizeTraditional([1], "/Size 2 /Root 1 0 R", { prevOffset: 999 });
    const startOffset = findStartXref(new Uint8Array(file), DEFAULT_SAFETY_LIMITS);
    const section = parseTraditionalXrefSectionAt(new Uint8Array(file), startOffset, DEFAULT_SAFETY_LIMITS);
    expect(section.prevOffset).toBe(999);
  });

  it("captures /XRefStm for hybrid-reference trailers", () => {
    const bytes = bytesOf(
      "xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 1 /Root 1 0 R /XRefStm 555 >>\nstartxref\n0\n%%EOF",
    );
    const section = parseTraditionalXrefSectionAt(bytes, 0, DEFAULT_SAFETY_LIMITS);
    expect(section.xrefStmOffset).toBe(555);
  });

  it("throws on a malformed entry (missing type flag)", () => {
    const bytes = bytesOf("xref\n0 1\n0000000000 65535\ntrailer\n<< /Size 1 >>\n");
    expect(() => parseTraditionalXrefSectionAt(bytes, 0, DEFAULT_SAFETY_LIMITS)).toThrow(PdfParseError);
  });

  it("throws on a truncated xref section with no trailer", () => {
    const bytes = bytesOf("xref\n0 1\n0000000000 65535 f \n");
    expect(() => parseTraditionalXrefSectionAt(bytes, 0, DEFAULT_SAFETY_LIMITS)).toThrow(PdfParseError);
  });

  it("throws when the section does not start with the 'xref' keyword", () => {
    const bytes = bytesOf("notxref\n0 1\n");
    expect(() => parseTraditionalXrefSectionAt(bytes, 0, DEFAULT_SAFETY_LIMITS)).toThrow(PdfParseError);
  });

  it("enforces maxObjectCount against the declared subsection size", () => {
    const bytes = bytesOf("xref\n0 1000000\n");
    const limits = { ...DEFAULT_SAFETY_LIMITS, maxObjectCount: 10 };
    expect(() => parseTraditionalXrefSectionAt(bytes, 0, limits)).toThrow(PdfParseError);
  });
});
