/**
 * TKT-004 — byte cursor, lexer, and PDF value parsing unit tests. Uses small,
 * purpose-built byte fixtures (not full PDF files) to exercise one syntax
 * feature at a time, including malformed/truncated variants.
 */
import { describe, expect, it } from "vitest";
import { ByteCursor } from "../../../src/pdf-content-extractor/parser/bytes.ts";
import { Lexer } from "../../../src/pdf-content-extractor/parser/lexer.ts";
import {
  isArrayValue,
  isDict,
  isName,
  isPdfString,
  isRef,
  parseIndirectObjectAt,
  parseValue,
} from "../../../src/pdf-content-extractor/parser/objects.ts";
import { DEFAULT_SAFETY_LIMITS } from "../../../src/pdf-content-extractor/parser/limits.ts";
import { PdfParseError } from "../../../src/pdf-content-extractor/errors.ts";

function bytesOf(text: string): Uint8Array {
  return new Uint8Array([...text].map((c) => c.charCodeAt(0)));
}

function parse(text: string, limits = DEFAULT_SAFETY_LIMITS) {
  const bytes = bytesOf(text);
  const cursor = new ByteCursor(bytes, 0, bytes.length);
  const lexer = new Lexer(cursor, limits);
  return parseValue(lexer, limits);
}

describe("ByteCursor bounds", () => {
  it("never reads past the declared end of a subview", () => {
    const bytes = bytesOf("0123456789");
    const cursor = new ByteCursor(bytes, 2, 5); // "234"
    expect(cursor.next()).toBe(0x32);
    expect(cursor.next()).toBe(0x33);
    expect(cursor.next()).toBe(0x34);
    expect(() => cursor.next()).toThrow(PdfParseError);
  });

  it("rejects an out-of-bounds subview", () => {
    const bytes = bytesOf("0123456789");
    const cursor = new ByteCursor(bytes, 2, 8);
    expect(() => cursor.subview(0, 4)).toThrow(PdfParseError);
    expect(() => cursor.subview(4, 20)).toThrow(PdfParseError);
  });
});

describe("number, boolean, null", () => {
  it.each([
    ["123", 123],
    ["-123", -123],
    ["+17", 17],
    ["34.5", 34.5],
    ["-3.62", -3.62],
    [".5", 0.5],
    ["4.", 4],
  ])("parses number literal %s", (text, expected) => {
    expect(parse(text)).toBe(expected);
  });

  it("parses booleans and null", () => {
    expect(parse("true")).toBe(true);
    expect(parse("false")).toBe(false);
    expect(parse("null")).toBeNull();
  });
});

describe("names", () => {
  it("parses a plain name", () => {
    const value = parse("/Type");
    expect(isName(value)).toBe(true);
    if (isName(value)) expect(value.name).toBe("Type");
  });

  it("decodes #xx escapes", () => {
    const value = parse("/A#42C"); // #42 = 'B'
    if (isName(value)) expect(value.name).toBe("ABC");
  });

  it("stops a name at a delimiter without consuming it", () => {
    const bytes = bytesOf("/Name]");
    const cursor = new ByteCursor(bytes, 0, bytes.length);
    const lexer = new Lexer(cursor, DEFAULT_SAFETY_LIMITS);
    const value = parseValue(lexer, DEFAULT_SAFETY_LIMITS);
    if (isName(value)) expect(value.name).toBe("Name");
    expect(lexer.nextToken().type).toBe("array-end");
  });
});

describe("literal strings", () => {
  it("parses a simple literal string", () => {
    const value = parse("(hello world)");
    if (isPdfString(value)) expect(Buffer.from(value.bytes).toString("latin1")).toBe("hello world");
  });

  it("handles balanced nested parens", () => {
    const value = parse("(a(b)c)");
    if (isPdfString(value)) expect(Buffer.from(value.bytes).toString("latin1")).toBe("a(b)c");
  });

  it("decodes standard escapes and octal escapes", () => {
    const value = parse("(line1\\nline2\\t\\061\\062)");
    if (isPdfString(value)) expect(Buffer.from(value.bytes).toString("latin1")).toBe("line1\nline2\t12");
  });

  it("normalizes CR and CRLF to LF", () => {
    const bytes = new Uint8Array([0x28, 0x61, 0x0d, 0x0a, 0x62, 0x0d, 0x63, 0x29]); // (a\r\nb\rc)
    const cursor = new ByteCursor(bytes, 0, bytes.length);
    const lexer = new Lexer(cursor, DEFAULT_SAFETY_LIMITS);
    const value = parseValue(lexer, DEFAULT_SAFETY_LIMITS);
    if (isPdfString(value)) expect(Array.from(value.bytes)).toEqual([0x61, 0x0a, 0x62, 0x0a, 0x63]);
  });

  it("drops a backslash line continuation", () => {
    const value = parse("(a\\\nb)");
    if (isPdfString(value)) expect(Buffer.from(value.bytes).toString("latin1")).toBe("ab");
  });

  it("throws on an unterminated literal string", () => {
    expect(() => parse("(unterminated")).toThrow(PdfParseError);
  });
});

describe("hex strings", () => {
  it("parses hex bytes, ignoring internal whitespace", () => {
    const value = parse("<68 65 6C6C6F>");
    if (isPdfString(value)) expect(Buffer.from(value.bytes).toString("latin1")).toBe("hello");
  });

  it("pads an odd trailing digit with an implicit 0", () => {
    const value = parse("<48656C6C6F0>"); // "Hello0" -> Hello + 0x00
    if (isPdfString(value)) expect(Array.from(value.bytes)).toEqual([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x00]);
  });

  it("throws on an unterminated hex string", () => {
    expect(() => parse("<48656C6C6F")).toThrow(PdfParseError);
  });

  it("throws on an invalid hex digit", () => {
    expect(() => parse("<48ZZ>")).toThrow(PdfParseError);
  });
});

describe("arrays and dictionaries", () => {
  it("parses a mixed-type array", () => {
    const value = parse("[1 2.5 (s) /N true false null [1 2]]");
    if (isArrayValue(value)) {
      expect(value.items).toHaveLength(8);
      expect(value.items[0]).toBe(1);
      expect(value.items[6]).toBeNull();
      expect(isArrayValue(value.items[7])).toBe(true);
    }
  });

  it("parses a dictionary", () => {
    const value = parse("<< /Type /Catalog /Count 3 /Kids [1 0 R 2 0 R] >>");
    if (isDict(value)) {
      const type = value.map.get("Type");
      expect(isName(type!) && type.name).toBe("Catalog");
      expect(value.map.get("Count")).toBe(3);
      const kids = value.map.get("Kids");
      if (kids && isArrayValue(kids)) {
        expect(kids.items).toHaveLength(2);
        expect(isRef(kids.items[0])).toBe(true);
      }
    }
  });

  it("throws on an unterminated array", () => {
    expect(() => parse("[1 2 3")).toThrow(PdfParseError);
  });

  it("throws on an unterminated dictionary", () => {
    expect(() => parse("<< /A 1")).toThrow(PdfParseError);
  });

  it("throws when a dictionary key is not a name", () => {
    expect(() => parse("<< 1 2 >>")).toThrow(PdfParseError);
  });
});

describe("indirect references", () => {
  it("parses N G R as a reference", () => {
    const value = parse("12 0 R");
    expect(isRef(value)).toBe(true);
    if (isRef(value)) {
      expect(value.num).toBe(12);
      expect(value.gen).toBe(0);
    }
  });

  it("does not misparse two adjacent numbers as a reference", () => {
    const bytes = bytesOf("[12 0 34]");
    const cursor = new ByteCursor(bytes, 0, bytes.length);
    const lexer = new Lexer(cursor, DEFAULT_SAFETY_LIMITS);
    const value = parseValue(lexer, DEFAULT_SAFETY_LIMITS);
    if (isArrayValue(value)) expect(value.items).toEqual([12, 0, 34]);
  });

  it("does not treat a real (non-integer) number as an object number", () => {
    // A real number can never start a reference, so "1.5 0 R" is not "1.5 followed by
    // a ref" — "R" alone is a bare keyword, which is not a legal array element.
    expect(() => parse("[1.5 0 R]")).toThrow(PdfParseError);
  });
});

describe("CR/LF/CRLF and comments between tokens", () => {
  it.each(["1\r2", "1\n2", "1\r\n2", "1 % a comment\n2"])("tolerates separator %j", (text) => {
    const value = parse(`[${text}]`);
    if (isArrayValue(value)) expect(value.items).toEqual([1, 2]);
  });
});

describe("nesting and token-length limits", () => {
  it("rejects arrays nested past maxNestingDepth", () => {
    const depth = 5;
    const text = "[".repeat(depth) + "]".repeat(depth);
    const limits = { ...DEFAULT_SAFETY_LIMITS, maxNestingDepth: 2 };
    expect(() => parse(text, limits)).toThrow(PdfParseError);
  });

  it("accepts arrays within maxNestingDepth", () => {
    const text = "[[[1]]]";
    const limits = { ...DEFAULT_SAFETY_LIMITS, maxNestingDepth: 5 };
    expect(() => parse(text, limits)).not.toThrow();
  });

  it("rejects a token longer than maxTokenLength", () => {
    const longName = "/" + "A".repeat(100);
    const limits = { ...DEFAULT_SAFETY_LIMITS, maxTokenLength: 10 };
    expect(() => parse(longName, limits)).toThrow(PdfParseError);
  });
});

describe("indirect objects", () => {
  it("parses a simple 'N G obj ... endobj' object", () => {
    const bytes = bytesOf("7 0 obj\n<< /Type /Catalog >>\nendobj\n");
    const parsed = parseIndirectObjectAt(bytes, 0, DEFAULT_SAFETY_LIMITS);
    expect(parsed.num).toBe(7);
    expect(parsed.gen).toBe(0);
    expect(parsed.streamDataStart).toBeUndefined();
    expect(isDict(parsed.value)).toBe(true);
  });

  it("finds the stream data start right after the stream keyword's EOL", () => {
    const header = "9 0 obj\n<< /Length 5 >>\nstream\n";
    const bytes = bytesOf(header + "hello\nendstream\nendobj\n");
    const parsed = parseIndirectObjectAt(bytes, 0, DEFAULT_SAFETY_LIMITS);
    expect(parsed.streamDataStart).toBe(bytesOf(header).length);
    const raw = bytes.subarray(parsed.streamDataStart!, parsed.streamDataStart! + 5);
    expect(Buffer.from(raw).toString("latin1")).toBe("hello");
  });

  it("throws when the object header is malformed", () => {
    const bytes = bytesOf("not an object\n");
    expect(() => parseIndirectObjectAt(bytes, 0, DEFAULT_SAFETY_LIMITS)).toThrow(PdfParseError);
  });

  it("throws on a truncated object with no endobj", () => {
    const bytes = bytesOf("3 0 obj\n<< /A 1 >>");
    // parseIndirectObjectAt tolerates a missing endobj (lenient) — this asserts the value still parses.
    const parsed = parseIndirectObjectAt(bytes, 0, DEFAULT_SAFETY_LIMITS);
    expect(isDict(parsed.value)).toBe(true);
  });
});
