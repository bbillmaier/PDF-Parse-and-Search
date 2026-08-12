/**
 * TKT-010 — glyph-width table and text-showing advance formula unit tests.
 */
import { describe, expect, it } from "vitest";
import {
  computeStringAdvance,
  DEFAULT_MISSING_WIDTH_PER_MILLE,
  parseCidWidths,
  parseSimpleFontWidths,
  splitCodes,
  widthForCid,
  widthForSimpleCode,
} from "../../../src/pdf-content-extractor/fonts/metrics.ts";

describe("simple-font widths", () => {
  it("looks up a width within the declared range", () => {
    const table = parseSimpleFontWidths(65, [722, 667, 611]); // widths for 'A', 'B', 'C'
    expect(widthForSimpleCode(table, 65)).toBe(722);
    expect(widthForSimpleCode(table, 67)).toBe(611);
  });

  it("falls back to missingWidth outside the declared range", () => {
    const table = parseSimpleFontWidths(65, [722], 250);
    expect(widthForSimpleCode(table, 90)).toBe(250);
  });

  it("falls back to the documented default when no missingWidth is declared", () => {
    const table = parseSimpleFontWidths(0, []);
    expect(widthForSimpleCode(table, 65)).toBe(DEFAULT_MISSING_WIDTH_PER_MILLE);
  });
});

describe("CID-font widths (/W array)", () => {
  it("parses the [c [w1 w2 ...]] consecutive form", () => {
    const table = parseCidWidths([1, [500, 600, 700]], 1000);
    expect(widthForCid(table, 1)).toBe(500);
    expect(widthForCid(table, 2)).toBe(600);
    expect(widthForCid(table, 3)).toBe(700);
    expect(widthForCid(table, 4)).toBe(1000); // falls back to DW
  });

  it("parses the [cFirst cLast w] range form", () => {
    const table = parseCidWidths([10, 20, 400], 1000);
    expect(widthForCid(table, 10)).toBe(400);
    expect(widthForCid(table, 15)).toBe(400);
    expect(widthForCid(table, 20)).toBe(400);
    expect(widthForCid(table, 21)).toBe(1000);
  });

  it("parses mixed runs in one array", () => {
    const table = parseCidWidths([1, [500], 10, 12, 600], 1000);
    expect(widthForCid(table, 1)).toBe(500);
    expect(widthForCid(table, 11)).toBe(600);
  });
});

describe("splitCodes", () => {
  it("splits into 1-byte codes", () => {
    expect(splitCodes(new Uint8Array([0x41, 0x42, 0x43]), 1)).toEqual([0x41, 0x42, 0x43]);
  });

  it("splits into 2-byte big-endian codes", () => {
    expect(splitCodes(new Uint8Array([0x00, 0x41, 0x00, 0x42]), 2)).toEqual([0x0041, 0x0042]);
  });

  it("zero-pads a malformed trailing partial code instead of dropping it", () => {
    expect(splitCodes(new Uint8Array([0x00, 0x41, 0x00]), 2)).toEqual([0x0041, 0x0000]);
  });
});

describe("computeStringAdvance", () => {
  it("applies the spec 9.4.3 formula: (w0*Tfs + Tc + Tw) * Th", () => {
    const tx = computeStringAdvance([65], 1, () => 500, {
      fontSize: 10,
      charSpacing: 1,
      wordSpacing: 0,
      horizontalScaling: 1,
    });
    // w0 = 0.5, w0*10 = 5, + Tc 1 = 6, * Th 1 = 6.
    expect(tx).toBeCloseTo(6, 10);
  });

  it("applies word spacing only to the single-byte code 32", () => {
    const codes = [0x41, 0x20]; // 'A', space
    const tx = computeStringAdvance(codes, 1, () => 500, {
      fontSize: 10,
      charSpacing: 0,
      wordSpacing: 2,
      horizontalScaling: 1,
    });
    // 'A': 0.5*10 = 5; space: 0.5*10 + 2(word spacing) = 7. Total 12.
    expect(tx).toBeCloseTo(12, 10);
  });

  it("does not apply word spacing to byte 0x20 inside a 2-byte CID code", () => {
    const codes = [0x0020]; // 2-byte code that happens to equal 32 numerically
    const tx = computeStringAdvance(codes, 2, () => 1000, {
      fontSize: 10,
      charSpacing: 0,
      wordSpacing: 5,
      horizontalScaling: 1,
    });
    expect(tx).toBeCloseTo(10, 10); // no word-spacing contribution
  });

  it("scales by horizontal scaling (Tz)", () => {
    const tx = computeStringAdvance([65], 1, () => 1000, {
      fontSize: 10,
      charSpacing: 0,
      wordSpacing: 0,
      horizontalScaling: 0.5,
    });
    expect(tx).toBeCloseTo(5, 10);
  });
});
