/**
 * TKT-007 — cross-reference stream parsing (`/W`, `/Index`, type 0/1/2
 * entries), compressed object-stream resolution (`/ObjStm`, `/N`,
 * `/First`), hybrid traditional+stream merging, and related failure paths.
 */
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { openPdfDocument } from "../../../src/pdf-content-extractor/parser/document.ts";
import { parseXrefStreamSectionAt } from "../../../src/pdf-content-extractor/parser/xref-stream.ts";
import { dictGet, isDict } from "../../../src/pdf-content-extractor/parser/objects.ts";
import { DEFAULT_SAFETY_LIMITS } from "../../../src/pdf-content-extractor/parser/limits.ts";
import { PdfParseError } from "../../../src/pdf-content-extractor/errors.ts";
import { PdfBuilder, buildObjectStreamBody } from "../../fixtures/pdf-builder.ts";

function packEntries(entries: [number, number, number][], w: [number, number, number]): Uint8Array {
  const [w1, w2, w3] = w;
  const bytes: number[] = [];
  for (const [type, f2, f3] of entries) {
    writeBE(bytes, type, w1);
    writeBE(bytes, f2, w2);
    writeBE(bytes, f3, w3);
  }
  return Uint8Array.from(bytes);
}
function writeBE(out: number[], value: number, width: number): void {
  for (let i = width - 1; i >= 0; i -= 1) out.push((value >> (8 * i)) & 0xff);
}

describe("parseXrefStreamSectionAt", () => {
  it("parses type 0/1/2 entries using /W and /Index", async () => {
    const w: [number, number, number] = [1, 2, 1];
    const raw = packEntries(
      [
        [0, 0, 0], // obj 0: free
        [1, 50, 0], // obj 1: in-use at offset 50
        [2, 7, 3], // obj 2: compressed, in obj stream 7 at index 3
      ],
      w,
    );
    const compressed = deflateSync(Buffer.from(raw));

    const builder = new PdfBuilder();
    builder.addStreamObject(
      9,
      `<< /Type /XRef /W [${w.join(" ")}] /Index [0 3] /Size 3 /Root 1 0 R /Filter /FlateDecode`,
      new Uint8Array(compressed),
    );
    const fileSoFar = builder.toBufferSoFar();
    const offset = builder.getObjectOffset(9);

    const section = await parseXrefStreamSectionAt(new Uint8Array(fileSoFar), offset, DEFAULT_SAFETY_LIMITS);
    expect(section.entries.get(0)).toEqual({ type: "free" });
    expect(section.entries.get(1)).toMatchObject({ type: "offset", offset: 50, gen: 0 });
    expect(section.entries.get(2)).toMatchObject({ type: "compressed", streamObjNum: 7, indexInStream: 3 });
    expect(section.trailer.get("Size")).toBe(3);
  });

  it("throws when /W is not exactly 3 integers", async () => {
    const builder = new PdfBuilder();
    builder.addStreamObject(9, `<< /Type /XRef /W [1 2] /Index [0 1] /Root 1 0 R`, new Uint8Array(deflateSync(Buffer.from([0, 0, 0]))));
    const fileSoFar = builder.toBufferSoFar();
    await expect(
      parseXrefStreamSectionAt(new Uint8Array(fileSoFar), builder.getObjectOffset(9), DEFAULT_SAFETY_LIMITS),
    ).rejects.toThrow(PdfParseError);
  });

  it("throws when the decoded stream is truncated relative to /Index and /W", async () => {
    const w: [number, number, number] = [1, 2, 1];
    const raw = packEntries([[1, 1, 0]], w); // only 1 entry's worth of bytes
    const compressed = deflateSync(Buffer.from(raw));
    const builder = new PdfBuilder();
    builder.addStreamObject(
      9,
      `<< /Type /XRef /W [${w.join(" ")}] /Index [0 5] /Root 1 0 R /Filter /FlateDecode`, // declares 5 entries, only 1 present
      new Uint8Array(compressed),
    );
    const fileSoFar = builder.toBufferSoFar();
    await expect(
      parseXrefStreamSectionAt(new Uint8Array(fileSoFar), builder.getObjectOffset(9), DEFAULT_SAFETY_LIMITS),
    ).rejects.toThrow(PdfParseError);
  });
});

describe("openPdfDocument (pure xref-stream file)", () => {
  it("resolves the catalog and a compressed object-stream entry", async () => {
    const builder = new PdfBuilder();
    // Object 4 lives compressed inside object stream 3, at index 0.
    const objStmBody = buildObjectStreamBody([{ num: 4, value: "<< /Marker (from-objstm) >>" }]);
    builder.addStreamObject(3, `<< /Type /ObjStm /N ${objStmBody.n} /First ${objStmBody.first} /Filter /FlateDecode`, new Uint8Array(deflateSync(Buffer.from(objStmBody.bytes))));

    builder.addObject(1, "<< /Type /Catalog /Pages 2 0 R /Extra 4 0 R >>");
    builder.addObject(2, "<< /Type /Pages /Kids [] /Count 0 >>");

    const w: [number, number, number] = [1, 4, 2];
    const entries: [number, number, number][] = [
      [0, 0, 0], // 0: free
      [1, builder.getObjectOffset(1), 0], // 1: catalog
      [1, builder.getObjectOffset(2), 0], // 2: pages
      [1, builder.getObjectOffset(3), 0], // 3: object stream itself
      [2, 3, 0], // 4: compressed, inside obj stream 3 at index 0
    ];
    const raw = packEntries(entries, w);
    const compressed = deflateSync(Buffer.from(raw));
    builder.addStreamObject(
      5,
      `<< /Type /XRef /W [${w.join(" ")}] /Index [0 5] /Size 5 /Root 1 0 R /Filter /FlateDecode`,
      new Uint8Array(compressed),
    );

    const xrefOffset = builder.getObjectOffset(5);
    builder.write(`startxref\n${xrefOffset}\n%%EOF\n`);
    const file = builder.toBufferSoFar();

    const doc = await openPdfDocument(new Uint8Array(file));
    const catalog = await doc.resolve(doc.trailer.get("Root"));
    expect(isDict(catalog)).toBe(true);

    const extra = await doc.resolve({ kind: "ref", num: 4, gen: 0 });
    expect(isDict(extra)).toBe(true);
    if (isDict(extra)) {
      const marker = dictGet(extra, "Marker");
      expect(marker && isDict(marker) === false).toBeTruthy();
    }

    const diagnostics = doc.getDiagnostics();
    const objStmResolution = diagnostics.resolutions.find((r) => r.num === 4);
    expect(objStmResolution?.status).toBe("resolved-compressed");
  });

  it("decompresses each object stream at most once even when multiple of its objects are resolved", async () => {
    const builder = new PdfBuilder();
    const objStmBody = buildObjectStreamBody([
      { num: 4, value: "<< /A 1 >>" },
      { num: 5, value: "<< /B 2 >>" },
    ]);
    builder.addStreamObject(
      3,
      `<< /Type /ObjStm /N ${objStmBody.n} /First ${objStmBody.first} /Filter /FlateDecode`,
      new Uint8Array(deflateSync(Buffer.from(objStmBody.bytes))),
    );
    builder.addObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
    builder.addObject(2, "<< /Type /Pages /Kids [] /Count 0 >>");

    const w: [number, number, number] = [1, 4, 2];
    const entries: [number, number, number][] = [
      [0, 0, 0],
      [1, builder.getObjectOffset(1), 0],
      [1, builder.getObjectOffset(2), 0],
      [1, builder.getObjectOffset(3), 0],
      [2, 3, 0],
      [2, 3, 1],
    ];
    const raw = packEntries(entries, w);
    const compressed = deflateSync(Buffer.from(raw));
    builder.addStreamObject(
      6,
      `<< /Type /XRef /W [${w.join(" ")}] /Index [0 6] /Size 6 /Root 1 0 R /Filter /FlateDecode`,
      new Uint8Array(compressed),
    );
    builder.write(`startxref\n${builder.getObjectOffset(6)}\n%%EOF\n`);
    const file = builder.toBufferSoFar();

    const doc = await openPdfDocument(new Uint8Array(file));
    await doc.resolve({ kind: "ref", num: 4, gen: 0 });
    await doc.resolve({ kind: "ref", num: 5, gen: 0 });

    // The object stream (object 3) must only be Flate-decoded once, however many of its
    // entries get resolved.
    const diagnostics = doc.getDiagnostics();
    expect(diagnostics.objectStreamLoads.filter((num) => num === 3)).toHaveLength(1);
  });
});

describe("hybrid-reference files (traditional table + /XRefStm)", () => {
  it("merges traditional in-use entries with compressed entries from the supplemental stream", async () => {
    const builder = new PdfBuilder();
    const objStmBody = buildObjectStreamBody([{ num: 4, value: "<< /Marker (hybrid) >>" }]);
    builder.addStreamObject(
      3,
      `<< /Type /ObjStm /N ${objStmBody.n} /First ${objStmBody.first} /Filter /FlateDecode`,
      new Uint8Array(deflateSync(Buffer.from(objStmBody.bytes))),
    );
    builder.addObject(1, "<< /Type /Catalog /Pages 2 0 R /Extra 4 0 R >>");
    builder.addObject(2, "<< /Type /Pages /Kids [] /Count 0 >>");

    // Supplemental xref STREAM covers only the compressed entry (object 4) plus the object
    // stream itself, as a real hybrid writer would.
    const w: [number, number, number] = [1, 4, 2];
    const streamEntries: [number, number, number][] = [
      [1, builder.getObjectOffset(3), 0], // object 3 (index base must match /Index start)
      [2, 3, 0], // object 4
    ];
    const raw = packEntries(streamEntries, w);
    const compressed = deflateSync(Buffer.from(raw));
    builder.addStreamObject(
      5,
      `<< /Type /XRef /W [${w.join(" ")}] /Index [3 2] /Size 6 /Filter /FlateDecode`,
      new Uint8Array(compressed),
    );
    const xrefStmOffset = builder.getObjectOffset(5);

    const file = builder.finalizeTraditional([1, 2], `/Size 6 /Root 1 0 R /XRefStm ${xrefStmOffset}`);

    const doc = await openPdfDocument(new Uint8Array(file));
    const extra = await doc.resolve({ kind: "ref", num: 4, gen: 0 });
    expect(isDict(extra)).toBe(true);
    if (isDict(extra)) {
      const marker = dictGet(extra, "Marker");
      expect(marker).toBeTruthy();
    }
    const diagnostics = doc.getDiagnostics();
    expect(diagnostics.xrefSections.some((s) => s.note?.includes("hybrid"))).toBe(true);
  });
});
