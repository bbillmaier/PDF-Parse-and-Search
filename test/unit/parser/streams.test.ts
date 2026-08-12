/**
 * TKT-006 — stream-filter pipeline, FlateDecode, and predictor unit tests.
 * Node's built-in `zlib` module is used only to *fabricate* zlib-compressed
 * fixtures for these tests; the library itself never imports it (FlateDecode
 * is implemented with the native `DecompressionStream` Web API — see
 * parser/streams.ts).
 */
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodeStream, flateDecode } from "../../../src/pdf-content-extractor/parser/streams.ts";
import { makeDict, makeName } from "../../../src/pdf-content-extractor/parser/objects.ts";
import { DEFAULT_SAFETY_LIMITS } from "../../../src/pdf-content-extractor/parser/limits.ts";
import { PdfParseError } from "../../../src/pdf-content-extractor/errors.ts";

function textBytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "utf8"));
}

describe("flateDecode", () => {
  it("decodes byte-for-byte for a known zlib fixture", async () => {
    const original = textBytes("The quick brown fox jumps over the lazy dog. ".repeat(20));
    const compressed = new Uint8Array(deflateSync(original));
    const decoded = await flateDecode(compressed, DEFAULT_SAFETY_LIMITS);
    expect(Buffer.from(decoded).equals(Buffer.from(original))).toBe(true);
  });

  it("returns an empty buffer for empty input", async () => {
    const decoded = await flateDecode(new Uint8Array(0), DEFAULT_SAFETY_LIMITS);
    expect(decoded.byteLength).toBe(0);
  });

  it("fails without crashing on truncated/corrupt zlib data", async () => {
    const original = textBytes("some data to compress ".repeat(50));
    const compressed = new Uint8Array(deflateSync(original));
    const truncated = compressed.subarray(0, compressed.byteLength - 5);
    await expect(flateDecode(truncated, DEFAULT_SAFETY_LIMITS)).rejects.toThrow(PdfParseError);
  });

  it("stops a decompression bomb via maxDecodedStreamBytes", async () => {
    const original = new Uint8Array(1_000_000).fill(0x41); // highly compressible
    const compressed = new Uint8Array(deflateSync(Buffer.from(original)));
    const limits = { ...DEFAULT_SAFETY_LIMITS, maxDecodedStreamBytes: 1000 };
    await expect(flateDecode(compressed, limits)).rejects.toThrow(PdfParseError);
  });

  it("stops a decompression bomb via maxCompressionRatio", async () => {
    const original = new Uint8Array(2_000_000).fill(0x42);
    const compressed = new Uint8Array(deflateSync(Buffer.from(original)));
    const limits = { ...DEFAULT_SAFETY_LIMITS, maxDecodedStreamBytes: 10_000_000, maxCompressionRatio: 10 };
    await expect(flateDecode(compressed, limits)).rejects.toThrow(PdfParseError);
  });
});

describe("decodeStream filter pipeline", () => {
  it("decodes a FlateDecode stream and records filter diagnostics", async () => {
    const original = textBytes("Hello, PDF streams!");
    const compressed = new Uint8Array(deflateSync(original));
    const dict = makeDict([["Filter", makeName("FlateDecode")]]);
    const result = await decodeStream(dict, compressed, DEFAULT_SAFETY_LIMITS);
    expect(Buffer.from(result.bytes).toString("utf8")).toBe("Hello, PDF streams!");
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].filterName).toBe("FlateDecode");
    expect(result.diagnostics[0].outputBytes).toBe(original.byteLength);
  });

  it("passes through streams with no /Filter unchanged", async () => {
    const raw = textBytes("raw bytes");
    const dict = makeDict();
    const result = await decodeStream(dict, raw, DEFAULT_SAFETY_LIMITS);
    expect(Buffer.from(result.bytes).equals(Buffer.from(raw))).toBe(true);
    expect(result.diagnostics).toHaveLength(0);
  });

  it("throws a typed unsupported-filter error for filters outside the contract", async () => {
    const dict = makeDict([["Filter", makeName("DCTDecode")]]);
    await expect(decodeStream(dict, new Uint8Array([1, 2, 3]), DEFAULT_SAFETY_LIMITS)).rejects.toMatchObject({
      code: "unsupported-feature",
    });
  });
});

describe("PNG predictor reversal", () => {
  it("reverses PNG 'None' (0) and 'Up' (2) filtered rows byte-for-byte", async () => {
    // 2 rows x 3 grayscale bytes/row, predictor 15 (PNG, optimal per-row filter type byte).
    const row0 = [10, 20, 30];
    const row1 = [11, 22, 33];
    // Filter type 0 = None for row0; type 2 = Up for row1 (row1[i] - row0[i]).
    const filteredRow0 = [0, ...row0];
    const filteredRow1 = [2, ...row1.map((v, i) => (v - row0[i]) & 0xff)];
    const filtered = new Uint8Array([...filteredRow0, ...filteredRow1]);
    const compressed = new Uint8Array(deflateSync(Buffer.from(filtered)));

    const parms = makeDict([
      ["Predictor", 15],
      ["Colors", 1],
      ["BitsPerComponent", 8],
      ["Columns", 3],
    ]);
    const dict = makeDict([
      ["Filter", makeName("FlateDecode")],
      ["DecodeParms", parms],
    ]);
    const result = await decodeStream(dict, compressed, DEFAULT_SAFETY_LIMITS);
    expect(Array.from(result.bytes)).toEqual([...row0, ...row1]);
  });

  it("reverses the Paeth (4) filter", async () => {
    const row0 = [100, 150, 200];
    const row1 = [90, 140, 210];
    const bpp = 1;
    function paeth(a: number, b: number, c: number): number {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      if (pa <= pb && pa <= pc) return a;
      if (pb <= pc) return b;
      return c;
    }
    const filteredRow0 = [0, ...row0];
    const filteredRow1 = [
      4,
      ...row1.map((v, i) => {
        const a = i >= bpp ? row1[i - bpp] : 0;
        const b = row0[i];
        const c = i >= bpp ? row0[i - bpp] : 0;
        return (v - paeth(a, b, c)) & 0xff;
      }),
    ];
    const filtered = new Uint8Array([...filteredRow0, ...filteredRow1]);
    const compressed = new Uint8Array(deflateSync(Buffer.from(filtered)));
    const parms = makeDict([
      ["Predictor", 15],
      ["Colors", 1],
      ["BitsPerComponent", 8],
      ["Columns", 3],
    ]);
    const dict = makeDict([
      ["Filter", makeName("FlateDecode")],
      ["DecodeParms", parms],
    ]);
    const result = await decodeStream(dict, compressed, DEFAULT_SAFETY_LIMITS);
    expect(Array.from(result.bytes)).toEqual([...row0, ...row1]);
  });
});

describe("TIFF predictor reversal", () => {
  it("reverses horizontal differencing for 8-bit components", async () => {
    const colors = 3;
    const columns = 2;
    const rowBytes = colors * columns;
    const row = [10, 20, 30, 15, 25, 35]; // 2 RGB pixels
    const encoded = row.slice();
    for (let i = colors; i < rowBytes; i += 1) {
      encoded[i] = (row[i] - row[i - colors]) & 0xff;
    }
    const compressed = new Uint8Array(deflateSync(Buffer.from(encoded)));
    const parms = makeDict([
      ["Predictor", 2],
      ["Colors", colors],
      ["BitsPerComponent", 8],
      ["Columns", columns],
    ]);
    const dict = makeDict([
      ["Filter", makeName("FlateDecode")],
      ["DecodeParms", parms],
    ]);
    const result = await decodeStream(dict, compressed, DEFAULT_SAFETY_LIMITS);
    expect(Array.from(result.bytes)).toEqual(row);
  });
});
