/**
 * TKT-010 — /ToUnicode CMap parsing unit tests: bfchar, bfrange (both the
 * single-destination and array-destination forms), codespacerange-derived
 * code width, and safety-limit behavior.
 */
import { describe, expect, it } from "vitest";
import { parseToUnicodeCMap } from "../../../src/pdf-content-extractor/fonts/cmap.ts";
import { DEFAULT_SAFETY_LIMITS } from "../../../src/pdf-content-extractor/parser/limits.ts";
import { PdfParseError } from "../../../src/pdf-content-extractor/errors.ts";

function bytesOf(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "latin1"));
}

const CMAP_HEADER = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
`;
const CMAP_FOOTER = `
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;

function wrap(body: string): Uint8Array {
  return bytesOf(CMAP_HEADER + body + CMAP_FOOTER);
}

describe("parseToUnicodeCMap: bfchar", () => {
  it("parses single-code mappings", () => {
    const bytes = wrap(`1 begincodespacerange
<0000> <FFFF>
endcodespacerange
2 beginbfchar
<0003> <0020>
<0004> <0041>
endbfchar
`);
    const result = parseToUnicodeCMap(bytes, DEFAULT_SAFETY_LIMITS);
    expect(result.codeByteLength).toBe(2);
    expect(result.toUnicode.get(0x0003)).toBe(" ");
    expect(result.toUnicode.get(0x0004)).toBe("A");
  });

  it("infers a 1-byte codespace from a single-byte hex range", () => {
    const bytes = wrap(`1 begincodespacerange
<00> <FF>
endcodespacerange
1 beginbfchar
<41> <0041>
endbfchar
`);
    const result = parseToUnicodeCMap(bytes, DEFAULT_SAFETY_LIMITS);
    expect(result.codeByteLength).toBe(1);
  });

  it("defaults codeByteLength to 2 when no codespacerange is present", () => {
    const bytes = wrap(`1 beginbfchar
<0041> <0041>
endbfchar
`);
    const result = parseToUnicodeCMap(bytes, DEFAULT_SAFETY_LIMITS);
    expect(result.codeByteLength).toBe(2);
  });
});

describe("parseToUnicodeCMap: bfrange", () => {
  it("expands a single-destination range", () => {
    const bytes = wrap(`1 beginbfrange
<0020> <0024> <0041>
endbfrange
`);
    const result = parseToUnicodeCMap(bytes, DEFAULT_SAFETY_LIMITS);
    expect(result.toUnicode.get(0x0020)).toBe("A");
    expect(result.toUnicode.get(0x0021)).toBe("B");
    expect(result.toUnicode.get(0x0024)).toBe("E");
  });

  it("expands an array-destination range", () => {
    const bytes = wrap(`1 beginbfrange
<0005> <0007> [<0061> <0062> <2022>]
endbfrange
`);
    const result = parseToUnicodeCMap(bytes, DEFAULT_SAFETY_LIMITS);
    expect(result.toUnicode.get(0x0005)).toBe("a");
    expect(result.toUnicode.get(0x0006)).toBe("b");
    expect(result.toUnicode.get(0x0007)).toBe("•");
  });

  it("decodes a multi-character bfchar destination (ligature expansion)", () => {
    const bytes = wrap(`1 beginbfchar
<0009> <00660069>
endbfchar
`);
    const result = parseToUnicodeCMap(bytes, DEFAULT_SAFETY_LIMITS);
    expect(result.toUnicode.get(0x0009)).toBe("fi");
  });
});

describe("parseToUnicodeCMap: safety limits", () => {
  it("throws when the CMap stream exceeds maxCMapBytes", () => {
    const limits = { ...DEFAULT_SAFETY_LIMITS, maxCMapBytes: 4 };
    expect(() => parseToUnicodeCMap(wrap("1 beginbfchar <01> <0041> endbfchar"), limits)).toThrow(PdfParseError);
  });

  it("throws when the mapping count exceeds maxCMapMappingCount", () => {
    const limits = { ...DEFAULT_SAFETY_LIMITS, maxCMapMappingCount: 2 };
    const bytes = wrap(`1 beginbfrange
<0000> <0010> <0041>
endbfrange
`);
    expect(() => parseToUnicodeCMap(bytes, limits)).toThrow(PdfParseError);
  });
});
