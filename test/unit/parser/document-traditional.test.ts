/**
 * TKT-005 — indirect object resolution through traditional xref tables:
 * catalog/trailer/ordinary-object/stream resolution, incremental-update
 * /Prev precedence, indexed (non-scanning) lookup, and malformed-input
 * failure paths.
 */
import { describe, expect, it } from "vitest";
import { openPdfDocument } from "../../../src/pdf-content-extractor/parser/document.ts";
import { dictGet, isDict, isName, isPdfString, isStream } from "../../../src/pdf-content-extractor/parser/objects.ts";
import { PdfParseError } from "../../../src/pdf-content-extractor/errors.ts";
import { PdfBuilder } from "../../fixtures/pdf-builder.ts";

describe("openPdfDocument (traditional xref)", () => {
  it("resolves the catalog, an ordinary object, and a stream by /Length", async () => {
    const builder = new PdfBuilder();
    builder.addObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
    builder.addObject(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
    builder.addObject(3, "<< /Type /Page /Parent 2 0 R >>");
    builder.addStreamObject(4, "<< /Type /Test", new Uint8Array(Buffer.from("hello stream")));
    const file = builder.finalizeTraditional([1, 2, 3, 4], "/Size 5 /Root 1 0 R");

    const doc = await openPdfDocument(new Uint8Array(file));
    expect(doc.header.version).toBe("1.7");

    const root = doc.trailer.get("Root");
    const catalog = await doc.resolve(root);
    expect(isDict(catalog)).toBe(true);
    if (isDict(catalog)) {
      const type = dictGet(catalog, "Type");
      expect(isName(type) && type.name).toBe("Catalog");
    }

    const streamObj = await doc.resolve({ kind: "ref", num: 4, gen: 0 });
    expect(isStream(streamObj)).toBe(true);
    if (isStream(streamObj)) {
      const raw = doc.bytes.subarray(streamObj.start, streamObj.end);
      expect(Buffer.from(raw).toString("latin1")).toBe("hello stream");
    }
  });

  it("caches resolved objects (repeated resolve() calls return the same value without re-parsing)", async () => {
    const builder = new PdfBuilder();
    builder.addObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
    builder.addObject(2, "<< /Type /Pages /Kids [] /Count 0 >>");
    const file = builder.finalizeTraditional([1, 2], "/Size 3 /Root 1 0 R");
    const doc = await openPdfDocument(new Uint8Array(file));

    const a = await doc.resolve({ kind: "ref", num: 2, gen: 0 });
    const b = await doc.resolve({ kind: "ref", num: 2, gen: 0 });
    expect(a).toBe(b); // same object identity => cache hit, not a fresh parse
  });

  it("does indexed lookup rather than a full-document scan (resolving an unrelated high object number is O(1) via xref)", async () => {
    const builder = new PdfBuilder();
    builder.addObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
    builder.addObject(2, "<< /Type /Pages /Kids [] /Count 0 >>");
    builder.addObject(3, "<< /Marker (findme) >>");
    const file = builder.finalizeTraditional([1, 2, 3], "/Size 4 /Root 1 0 R");
    const doc = await openPdfDocument(new Uint8Array(file));

    const entry = doc.getXrefEntry(3);
    expect(entry?.type).toBe("offset");
    if (entry?.type === "offset") expect(entry.offset).toBe(builder.getObjectOffset(3));
  });

  it("honors the newest entry across an incrementally updated /Prev chain", async () => {
    const builder = new PdfBuilder();
    builder.addObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
    builder.addObject(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
    builder.addObject(3, "<< /Type /Page /Marker (old) >>");
    const rev1XrefOffset = builder.offset; // finalizeTraditional writes its xref section starting here
    builder.finalizeTraditional([1, 2, 3], "/Size 4 /Root 1 0 R");

    // Incremental update: object 3 is replaced; the new xref section chains back via /Prev.
    builder.addObject(3, "<< /Type /Page /Marker (new) >>");
    const finalFile = builder.finalizeTraditional([1, 2, 3], "/Size 4 /Root 1 0 R", { prevOffset: rev1XrefOffset });

    const doc = await openPdfDocument(new Uint8Array(finalFile));
    const page = await doc.resolve({ kind: "ref", num: 3, gen: 0 });
    expect(isDict(page)).toBe(true);
    if (isDict(page)) {
      const marker = dictGet(page, "Marker");
      expect(isPdfString(marker) && Buffer.from(marker.bytes).toString("latin1")).toBe("new");
    }
    // Object 1 (untouched) still resolves, inherited from the base revision through /Prev.
    const catalog = await doc.resolve({ kind: "ref", num: 1, gen: 0 });
    expect(isDict(catalog)).toBe(true);
  });

  it("resolves a stream with an indirect /Length once the xref table exists", async () => {
    const builder = new PdfBuilder();
    builder.addObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
    builder.addObject(2, "<< /Type /Pages /Kids [] /Count 0 >>");
    builder.addObject(3, "5"); // the Length object
    builder.addObject(4, "<< /Length 3 0 R >>\nstream\nhello\nendstream"); // manual, since addStreamObject always writes direct Length
    // Rebuild 4 manually to use an indirect Length instead of the helper (which only supports direct).
    const file = builder.finalizeTraditional([1, 2, 3, 4], "/Size 5 /Root 1 0 R");

    const doc = await openPdfDocument(new Uint8Array(file));
    const streamObj = await doc.resolve({ kind: "ref", num: 4, gen: 0 });
    expect(isStream(streamObj)).toBe(true);
    if (isStream(streamObj)) {
      const raw = doc.bytes.subarray(streamObj.start, streamObj.end);
      expect(Buffer.from(raw).toString("latin1")).toBe("hello");
    }
  });

  it("falls back to scanning for 'endstream' when /Length is wrong", async () => {
    const builder = new PdfBuilder();
    builder.addObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
    builder.addObject(2, "<< /Type /Pages /Kids [] /Count 0 >>");
    builder.addObject(3, "<< /Length 999 >>\nstream\nshort\nendstream"); // Length is wrong on purpose
    const file = builder.finalizeTraditional([1, 2, 3], "/Size 4 /Root 1 0 R");

    const doc = await openPdfDocument(new Uint8Array(file));
    const streamObj = await doc.resolve({ kind: "ref", num: 3, gen: 0 });
    expect(isStream(streamObj)).toBe(true);
    if (isStream(streamObj)) {
      const raw = doc.bytes.subarray(streamObj.start, streamObj.end);
      expect(Buffer.from(raw).toString("latin1")).toBe("short");
    }
  });

  it("returns null for a reference to a missing object instead of throwing", async () => {
    const builder = new PdfBuilder();
    builder.addObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
    builder.addObject(2, "<< /Type /Pages /Kids [] /Count 0 >>");
    const file = builder.finalizeTraditional([1, 2], "/Size 3 /Root 1 0 R");
    const doc = await openPdfDocument(new Uint8Array(file));
    const missing = await doc.resolve({ kind: "ref", num: 99, gen: 0 });
    expect(missing).toBeNull();
    const diagnostics = doc.getDiagnostics();
    expect(diagnostics.resolutions.some((r) => r.num === 99 && r.status === "missing")).toBe(true);
  });

  it("rejects a file with no %PDF- header", async () => {
    await expect(openPdfDocument(new Uint8Array(Buffer.from("not a pdf")))).rejects.toMatchObject({ code: "invalid-header" });
  });

  it("rejects a trailer missing /Root", async () => {
    const bytes = Buffer.from("%PDF-1.7\nxref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 1 >>\nstartxref\n9\n%%EOF", "latin1");
    await expect(openPdfDocument(new Uint8Array(bytes))).rejects.toThrow(PdfParseError);
  });

  it("stops an xref /Prev cycle instead of looping forever", async () => {
    // Two sections whose /Prev point at each other. Both bodies must have the same byte
    // length regardless of the (6-digit, zero-padded) /Prev value so offsets don't shift
    // once the real cross-referenced offset is substituted in.
    const header = "%PDF-1.7\n";
    const section = (prev: number) =>
      `xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 1 /Root 1 0 R /Prev ${String(prev).padStart(6, "0")} >>\n`;

    const offsetA = Buffer.byteLength(header, "latin1");
    const offsetB = offsetA + Buffer.byteLength(section(0), "latin1");
    const sectionA = section(offsetB); // A -> B
    const sectionB = section(offsetA); // B -> A (cycle)
    const full = header + sectionA + sectionB + `startxref\n${offsetB}\n%%EOF`;

    const doc = await openPdfDocument(new Uint8Array(Buffer.from(full, "latin1")));
    const diagnostics = doc.getDiagnostics();
    expect(diagnostics.xrefSections.some((s) => s.note?.includes("cycle"))).toBe(true);
  });
});
