import { describe, expect, it } from "vitest";
import { openPdfDocument } from "../../../src/pdf-content-extractor/parser/document.ts";
import { traversePageTree } from "../../../src/pdf-content-extractor/parser/pages.ts";
import {
  createDocumentParseContext,
  getDocumentAssets,
  parsePage,
} from "../../../src/pdf-content-extractor/pipeline.ts";
import { PdfBuilder } from "../../fixtures/pdf-builder.ts";

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  }).pipeThrough(new CompressionStream("deflate") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function buildPdf(imageDict: string, imageBytes: Uint8Array): Uint8Array {
  const content = new Uint8Array(Buffer.from("q 10 0 0 20 30 40 cm /Im1 Do Q", "latin1"));
  const pdf = new PdfBuilder();
  pdf.addObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
  pdf.addObject(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  pdf.addObject(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>");
  pdf.addStreamObject(4, "<<", content);
  pdf.addStreamObject(5, imageDict, imageBytes);
  return new Uint8Array(pdf.finalizeTraditional([1, 2, 3, 4, 5], "/Root 1 0 R"));
}

async function parseAssets(bytes: Uint8Array) {
  const doc = await openPdfDocument(bytes);
  const { pages } = await traversePageTree(doc, doc.limits);
  const ctx = await createDocumentParseContext(doc, pages);
  const page = await parsePage(doc, pages[0], ctx, { preserveImages: true });
  return { page, assets: getDocumentAssets(ctx), ctx };
}

describe("image XObject extraction", () => {
  it("passes DCTDecode JPEG bytes through and records placement", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0xff, 0xd9]);
    const { assets, ctx } = await parseAssets(buildPdf("<< /Type /XObject /Subtype /Image /Width 2 /Height 3 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode", jpeg));
    expect(assets).toHaveLength(1);
    expect(assets[0].mimeType).toBe("image/jpeg");
    expect([...assets[0].bytes]).toEqual([...jpeg]);
    expect(assets[0].placements[0]).toMatchObject({ pageNumber: 1, x: 30, y: 40, width: 10, height: 20, xObjectName: "Im1" });
    expect(ctx.imageTimings.jpegPassThroughMs).toBeGreaterThanOrEqual(0);
  });

  it("decodes an 8-bit DeviceRGB Flate image to PNG", async () => {
    const compressed = await deflate(new Uint8Array([255, 0, 0]));
    const { assets } = await parseAssets(buildPdf("<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode", compressed));
    expect(assets).toHaveLength(1);
    expect(assets[0].mimeType).toBe("image/png");
    expect([...assets[0].bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it("warns and keeps text parsing when image dimensions exceed limits", async () => {
    const bytes = buildPdf("<< /Type /XObject /Subtype /Image /Width 100 /Height 100 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode", new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    const doc = await openPdfDocument(bytes, { maxImagePixelCount: 10 });
    const { pages } = await traversePageTree(doc, doc.limits);
    const ctx = await createDocumentParseContext(doc, pages);
    const page = await parsePage(doc, pages[0], ctx, { preserveImages: true });
    expect(getDocumentAssets(ctx)).toHaveLength(0);
    expect(page.warnings.some((warning) => warning.code === "unsupported-image")).toBe(true);
  });
});
