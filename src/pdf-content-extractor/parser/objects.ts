/**
 * PDF value parsing (TKT-004): turns a token stream into the PDF object
 * model (null, boolean, number, name, string, array, dictionary, indirect
 * reference) plus the "N G obj ... endobj" wrapper and raw stream-byte-range
 * extraction used by TKT-005/TKT-007. Nothing here resolves indirect
 * references, decompresses streams, or looks anything up in an xref table —
 * that is the document layer's job.
 */

import { PdfParseError } from "../errors.ts";
import type { SafetyLimits } from "../types.ts";
import { ByteCursor, isWhitespaceByte, matchesKeywordAt } from "./bytes.ts";
import { Lexer, type Token } from "./lexer.ts";

// ---------------------------------------------------------------------------
// PDF value model
// ---------------------------------------------------------------------------

export interface PdfName {
  readonly kind: "name";
  readonly name: string;
}

export interface PdfString {
  readonly kind: "string";
  readonly bytes: Uint8Array;
}

export interface PdfRef {
  readonly kind: "ref";
  readonly num: number;
  readonly gen: number;
}

export interface PdfArray {
  readonly kind: "array";
  readonly items: PdfValue[];
}

export interface PdfDict {
  readonly kind: "dict";
  readonly map: Map<string, PdfValue>;
}

export interface PdfStream {
  readonly kind: "stream";
  readonly dict: PdfDict;
  /** Absolute byte offsets of the still-encoded stream data in the document buffer. */
  readonly start: number;
  readonly end: number;
}

export type PdfValue = null | boolean | number | PdfName | PdfString | PdfArray | PdfDict | PdfRef | PdfStream;

export function isName(value: PdfValue | undefined): value is PdfName {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "name";
}
export function isPdfString(value: PdfValue | undefined): value is PdfString {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "string";
}
export function isRef(value: PdfValue | undefined): value is PdfRef {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "ref";
}
export function isArrayValue(value: PdfValue | undefined): value is PdfArray {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "array";
}
export function isDict(value: PdfValue | undefined): value is PdfDict {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "dict";
}
export function isStream(value: PdfValue | undefined): value is PdfStream {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "stream";
}

export function makeName(name: string): PdfName {
  return { kind: "name", name };
}
export function makeDict(entries?: Iterable<[string, PdfValue]>): PdfDict {
  return { kind: "dict", map: new Map(entries) };
}

/** Convenience getter: `undefined` if the key is absent (never throws). */
export function dictGet(dict: PdfDict, key: string): PdfValue | undefined {
  return dict.map.get(key);
}

// ---------------------------------------------------------------------------
// Value parsing
// ---------------------------------------------------------------------------

function nestingLimitExceeded(offset: number, limit: number): never {
  throw new PdfParseError(
    "limit-exceeded",
    `PDF value nesting exceeded the configured maximum depth of ${limit}.`,
    `offset=${offset}`,
  );
}

function unexpectedToken(token: Token, context: string): never {
  throw new PdfParseError(
    "corrupt-structure",
    `Unexpected token while parsing ${context}.`,
    `offset=${token.offset} tokenType=${token.type} text=${token.textValue ?? ""}`,
  );
}

export function parseValue(lexer: Lexer, limits: Pick<SafetyLimits, "maxNestingDepth">, depth = 0): PdfValue {
  if (depth > limits.maxNestingDepth) nestingLimitExceeded(lexer.offset, limits.maxNestingDepth);

  const token = lexer.nextToken();
  switch (token.type) {
    case "number":
      return maybeReadReference(lexer, token);
    case "name":
      return makeName(token.textValue!);
    case "literal-string":
    case "hex-string":
      return { kind: "string", bytes: token.bytesValue! };
    case "array-start":
      return parseArray(lexer, limits, depth + 1);
    case "dict-start":
      return parseDict(lexer, limits, depth + 1);
    case "keyword":
      if (token.textValue === "true") return true;
      if (token.textValue === "false") return false;
      if (token.textValue === "null") return null;
      return unexpectedToken(token, "a value");
    default:
      return unexpectedToken(token, "a value");
  }
}

function isNonNegativeInt(token: Token): boolean {
  return token.type === "number" && token.isInt === true && (token.numberValue ?? -1) >= 0;
}

/** After a number token, look ahead for `gen R` to disambiguate a reference from two plain numbers. */
function maybeReadReference(lexer: Lexer, first: Token): PdfValue {
  if (!isNonNegativeInt(first)) return first.numberValue!;
  const afterFirst = lexer.mark();
  const second = lexer.nextToken();
  if (isNonNegativeInt(second)) {
    const third = lexer.nextToken();
    if (third.type === "keyword" && third.textValue === "R") {
      return { kind: "ref", num: first.numberValue!, gen: second.numberValue! };
    }
  }
  lexer.reset(afterFirst);
  return first.numberValue!;
}

function parseArray(lexer: Lexer, limits: Pick<SafetyLimits, "maxNestingDepth">, depth: number): PdfArray {
  const items: PdfValue[] = [];
  for (;;) {
    const mark = lexer.mark();
    const token = lexer.nextToken();
    if (token.type === "array-end") return { kind: "array", items };
    if (token.type === "eof") {
      throw new PdfParseError("corrupt-structure", "Unterminated array.", `offset=${mark}`);
    }
    lexer.reset(mark);
    items.push(parseValue(lexer, limits, depth));
  }
}

function parseDict(lexer: Lexer, limits: Pick<SafetyLimits, "maxNestingDepth">, depth: number): PdfDict {
  const map = new Map<string, PdfValue>();
  for (;;) {
    const token = lexer.nextToken();
    if (token.type === "dict-end") return { kind: "dict", map };
    if (token.type === "eof") {
      throw new PdfParseError("corrupt-structure", "Unterminated dictionary.", `offset=${token.offset}`);
    }
    if (token.type !== "name") {
      return unexpectedToken(token, "a dictionary key");
    }
    const value = parseValue(lexer, limits, depth);
    map.set(token.textValue!, value);
  }
}

// ---------------------------------------------------------------------------
// Indirect objects ("N G obj ... endobj") and raw stream byte extraction
// ---------------------------------------------------------------------------

export interface ParsedIndirectObject {
  num: number;
  gen: number;
  value: PdfValue;
  /** Absolute offset right after `stream`'s required EOL, if this object is a stream. */
  streamDataStart?: number;
}

export function parseIndirectObjectAt(
  bytes: Uint8Array,
  offset: number,
  limits: Pick<SafetyLimits, "maxNestingDepth" | "maxTokenLength">,
): ParsedIndirectObject {
  const cursor = new ByteCursor(bytes, offset, bytes.length);
  const lexer = new Lexer(cursor, limits);

  const numTok = lexer.nextToken();
  const genTok = lexer.nextToken();
  const objTok = lexer.nextToken();
  if (!isNonNegativeInt(numTok) || !isNonNegativeInt(genTok) || objTok.type !== "keyword" || objTok.textValue !== "obj") {
    throw new PdfParseError(
      "corrupt-structure",
      "Expected 'N G obj' at indirect object start.",
      `offset=${offset}`,
    );
  }

  const value = parseValue(lexer, limits);

  const mark = lexer.mark();
  const next = lexer.nextToken();
  if (next.type === "keyword" && next.textValue === "stream") {
    const streamDataStart = consumeStreamKeywordEol(bytes, lexer.offset);
    return { num: numTok.numberValue!, gen: genTok.numberValue!, value, streamDataStart };
  }

  if (!(next.type === "keyword" && next.textValue === "endobj")) {
    lexer.reset(mark);
  }
  return { num: numTok.numberValue!, gen: genTok.numberValue!, value };
}

/** Per spec 7.3.8.1: `stream` is followed by CRLF or a bare LF (never a bare CR) before the raw data. */
function consumeStreamKeywordEol(bytes: Uint8Array, afterKeyword: number): number {
  let pos = afterKeyword;
  if (bytes[pos] === 0x0d) {
    pos += 1;
    if (bytes[pos] === 0x0a) pos += 1;
  } else if (bytes[pos] === 0x0a) {
    pos += 1;
  } else {
    // Tolerate producers that only pad with spaces before the newline.
    while (pos < bytes.length && bytes[pos] === 0x20) pos += 1;
    if (bytes[pos] === 0x0d) {
      pos += 1;
      if (bytes[pos] === 0x0a) pos += 1;
    } else if (bytes[pos] === 0x0a) {
      pos += 1;
    }
  }
  return pos;
}

export interface RawStreamRange {
  start: number;
  end: number;
  /** True when the declared/direct Length did not line up with `endstream` and a fallback scan was used. */
  usedFallbackScan: boolean;
}

/**
 * Determines the raw (still-encoded) byte range of a stream's data. `directLength`
 * is the resolved numeric `/Length` when known; pass `undefined` when `/Length`
 * is an indirect reference that cannot yet be resolved (e.g. during xref-stream
 * bootstrap, before any xref table exists) to force the fallback scan.
 */
export function extractRawStreamRange(
  bytes: Uint8Array,
  streamDataStart: number,
  directLength: number | undefined,
  limits: Pick<SafetyLimits, "maxDecodedStreamBytes">,
): RawStreamRange {
  if (directLength !== undefined && directLength >= 0 && streamDataStart + directLength <= bytes.length) {
    const candidateEnd = streamDataStart + directLength;
    if (verifyEndstreamNear(bytes, candidateEnd)) {
      return { start: streamDataStart, end: candidateEnd, usedFallbackScan: false };
    }
  }
  const end = scanForEndstream(bytes, streamDataStart, limits);
  return { start: streamDataStart, end, usedFallbackScan: true };
}

function verifyEndstreamNear(bytes: Uint8Array, candidateEnd: number): boolean {
  let i = candidateEnd;
  const limit = Math.min(bytes.length, candidateEnd + 2);
  while (i < limit && isWhitespaceByte(bytes[i])) i += 1;
  return matchesKeywordAt(bytes, i, "endstream");
}

function scanForEndstream(
  bytes: Uint8Array,
  start: number,
  limits: Pick<SafetyLimits, "maxDecodedStreamBytes">,
): number {
  const marker = "endstream";
  const maxScan = Math.min(bytes.length, start + limits.maxDecodedStreamBytes);
  for (let i = start; i <= maxScan - marker.length; i += 1) {
    if (matchesKeywordAt(bytes, i, marker)) {
      let end = i;
      // Trim a single trailing EOL that belongs to the stream-data terminator, not the data itself.
      if (end > start && bytes[end - 1] === 0x0a) {
        end -= 1;
        if (end > start && bytes[end - 1] === 0x0d) end -= 1;
      } else if (end > start && bytes[end - 1] === 0x0d) {
        end -= 1;
      }
      return end;
    }
  }
  throw new PdfParseError(
    "corrupt-structure",
    "Could not locate 'endstream' for a stream with an invalid or missing Length.",
    `start=${start}`,
  );
}
