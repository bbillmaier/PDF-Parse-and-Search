/**
 * TKT-010 — WinAnsiEncoding and /Differences resolution unit tests.
 * Curly-punctuation, symbol, and bullet coverage satisfies the ticket's
 * "curly punctuation, symbols, and bullet glyph behavior" acceptance item.
 */
import { describe, expect, it } from "vitest";
import {
  glyphNameToUnicode,
  resolveSimpleFontEncoding,
  WIN_ANSI_ENCODING,
} from "../../../src/pdf-content-extractor/fonts/encodings.ts";

describe("WinAnsiEncoding", () => {
  it("maps ASCII printable codes directly", () => {
    expect(WIN_ANSI_ENCODING[0x41]).toBe("A");
    expect(WIN_ANSI_ENCODING[0x7a]).toBe("z");
    expect(WIN_ANSI_ENCODING[0x20]).toBe(" ");
  });

  it("maps curly quotes, bullet, and dashes in the CP1252 special row", () => {
    expect(WIN_ANSI_ENCODING[0x91]).toBe("‘"); // left single quote
    expect(WIN_ANSI_ENCODING[0x92]).toBe("’"); // right single quote
    expect(WIN_ANSI_ENCODING[0x93]).toBe("“"); // left double quote
    expect(WIN_ANSI_ENCODING[0x94]).toBe("”"); // right double quote
    expect(WIN_ANSI_ENCODING[0x95]).toBe("•"); // bullet
    expect(WIN_ANSI_ENCODING[0x96]).toBe("–"); // en dash
    expect(WIN_ANSI_ENCODING[0x97]).toBe("—"); // em dash
    expect(WIN_ANSI_ENCODING[0x85]).toBe("…"); // ellipsis
  });

  it("leaves genuinely undefined WinAnsi codes unmapped", () => {
    expect(WIN_ANSI_ENCODING[0x81]).toBeUndefined();
    expect(WIN_ANSI_ENCODING[0x8d]).toBeUndefined();
  });

  it("maps the Latin-1 supplement range directly, with the 0xAD hyphen quirk", () => {
    expect(WIN_ANSI_ENCODING[0xe9]).toBe("é"); // eacute
    expect(WIN_ANSI_ENCODING[0xad]).toBe("-"); // spec quirk: not U+00AD
  });
});

describe("glyphNameToUnicode", () => {
  it("resolves standard AGL names", () => {
    expect(glyphNameToUnicode("bullet")).toBe("•");
    expect(glyphNameToUnicode("quotedblleft")).toBe("“");
    expect(glyphNameToUnicode("emdash")).toBe("—");
  });

  it("resolves uniXXXX escapes", () => {
    expect(glyphNameToUnicode("uni2022")).toBe("•");
    expect(glyphNameToUnicode("uni0041")).toBe("A");
  });

  it("returns undefined for an unrecognized glyph name", () => {
    expect(glyphNameToUnicode("totallyMadeUpGlyphName")).toBeUndefined();
  });
});

describe("resolveSimpleFontEncoding", () => {
  it("defaults to WinAnsiEncoding when no base encoding is declared", () => {
    const { table, unsupportedBaseEncoding } = resolveSimpleFontEncoding(undefined, []);
    expect(table[0x95]).toBe("•");
    expect(unsupportedBaseEncoding).toBeUndefined();
  });

  it("applies /Differences overrides on top of the base encoding", () => {
    const { table } = resolveSimpleFontEncoding("WinAnsiEncoding", [
      { code: 0x41, name: "bullet" },
      { code: 0x42, name: "uni2019" },
    ]);
    expect(table[0x41]).toBe("•");
    expect(table[0x42]).toBe("’");
    expect(table[0x43]).toBe("C"); // untouched codes keep the base mapping
  });

  it("falls back to WinAnsiEncoding for an unsupported base encoding and reports it", () => {
    const { table, unsupportedBaseEncoding } = resolveSimpleFontEncoding("MacRomanEncoding", []);
    expect(unsupportedBaseEncoding).toBe("MacRomanEncoding");
    expect(table[0x41]).toBe("A");
  });

  it("StandardEncoding maps 0x27/0x60 to curly quotes rather than straight ones", () => {
    const { table } = resolveSimpleFontEncoding("StandardEncoding", []);
    expect(table[0x27]).toBe("’");
    expect(table[0x60]).toBe("‘");
  });
});
