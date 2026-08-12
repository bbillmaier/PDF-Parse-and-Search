/**
 * Header validation, `startxref` location, and traditional cross-reference
 * table + trailer parsing (TKT-005). Cross-reference *streams* and
 * compressed object streams are TKT-007's concern (`xref-stream.ts`); this
 * module only knows the classic `xref` / `trailer` keyword syntax.
 */

import { PdfParseError } from "../errors.ts";
import type { SafetyLimits } from "../types.ts";
import { ByteCursor, latin1 } from "./bytes.ts";
import { Lexer } from "./lexer.ts";
import { isDict, parseValue, type PdfValue } from "./objects.ts";

export interface HeaderInfo {
  version: string;
  /** Absolute offset of the '%PDF-' signature (normally 0; some producers prepend bytes). */
  headerOffset: number;
}

const HEADER_SEARCH_WINDOW = 1024;

export function validateHeader(bytes: Uint8Array): HeaderInfo {
  const windowLength = Math.min(bytes.length, HEADER_SEARCH_WINDOW);
  const text = latin1(bytes.subarray(0, windowLength));
  const idx = text.indexOf("%PDF-");
  if (idx === -1) {
    throw new PdfParseError(
      "invalid-header",
      "Missing '%PDF-' header signature within the first 1024 bytes.",
      `searchedBytes=${windowLength}`,
    );
  }
  const match = /^%PDF-(\d\.\d)/.exec(text.slice(idx));
  if (!match) {
    throw new PdfParseError("invalid-header", "Malformed PDF version in header signature.", `offset=${idx}`);
  }
  return { version: match[1], headerOffset: idx };
}

const STARTXREF_TAIL_WINDOW = 2048;

/** Locates the byte offset the last `startxref` keyword in the file points at, scanning only the file tail. */
export function findStartXref(bytes: Uint8Array, limits: Pick<SafetyLimits, "maxTokenLength">): number {
  const windowLength = Math.min(bytes.length, STARTXREF_TAIL_WINDOW);
  const tailStart = bytes.length - windowLength;
  const text = latin1(bytes.subarray(tailStart, bytes.length));
  const idx = text.lastIndexOf("startxref");
  if (idx === -1) {
    throw new PdfParseError(
      "corrupt-structure",
      "Could not locate 'startxref' keyword near the end of the file.",
      `tailWindow=${windowLength}`,
    );
  }
  const afterKeyword = tailStart + idx + "startxref".length;
  const cursor = new ByteCursor(bytes, afterKeyword, bytes.length);
  const lexer = new Lexer(cursor, limits);
  const token = lexer.nextToken();
  if (token.type !== "number" || token.isInt !== true) {
    throw new PdfParseError(
      "corrupt-structure",
      "'startxref' was not followed by an integer byte offset.",
      `offset=${afterKeyword}`,
    );
  }
  const offset = token.numberValue!;
  if (offset < 0 || offset >= bytes.length) {
    throw new PdfParseError(
      "corrupt-structure",
      "'startxref' offset is outside the bounds of the file.",
      `offset=${offset} fileLength=${bytes.length}`,
    );
  }
  return offset;
}

// ---------------------------------------------------------------------------
// Xref entries (shared shape with xref-stream.ts's type-0/1/2 entries)
// ---------------------------------------------------------------------------

export type XrefSectionKind = "table" | "stream";

export interface XrefSource {
  kind: XrefSectionKind;
  /** Absolute offset of the section (the `xref` keyword, or the stream object's `N G obj`). */
  sectionOffset: number;
}

export type XrefEntry =
  | { type: "free" }
  | { type: "offset"; offset: number; gen: number; source: XrefSource }
  | { type: "compressed"; streamObjNum: number; indexInStream: number; source: XrefSource };

export interface TraditionalXrefSection {
  entries: Map<number, XrefEntry>;
  trailer: Map<string, PdfValue>;
  prevOffset?: number;
  /** Hybrid-reference file: supplemental xref *stream* offset carrying compressed-object entries for this revision. */
  xrefStmOffset?: number;
}

function expectKeyword(lexer: Lexer, expected: string, contextOffset: number): void {
  const token = lexer.nextToken();
  if (token.type !== "keyword" || token.textValue !== expected) {
    throw new PdfParseError(
      "corrupt-structure",
      `Expected '${expected}' keyword.`,
      `offset=${contextOffset} found=${token.type}:${token.textValue ?? ""}`,
    );
  }
}

export function parseTraditionalXrefSectionAt(
  bytes: Uint8Array,
  offset: number,
  limits: Pick<SafetyLimits, "maxNestingDepth" | "maxTokenLength" | "maxObjectCount">,
): TraditionalXrefSection {
  const cursor = new ByteCursor(bytes, offset, bytes.length);
  const lexer = new Lexer(cursor, limits);
  expectKeyword(lexer, "xref", offset);

  const entries = new Map<number, XrefEntry>();
  let totalEntries = 0;

  for (;;) {
    const mark = lexer.mark();
    const token = lexer.nextToken();
    if (token.type === "keyword" && token.textValue === "trailer") break;
    if (token.type !== "number" || token.isInt !== true) {
      // No more subsections; tolerate a missing 'trailer' keyword by rewinding and
      // letting the caller's dictionary parse fail with a clear message instead.
      lexer.reset(mark);
      break;
    }
    const startObjNum = token.numberValue!;
    const countTok = lexer.nextToken();
    if (countTok.type !== "number" || countTok.isInt !== true) {
      throw new PdfParseError("corrupt-structure", "Expected xref subsection object count.", `offset=${lexer.offset}`);
    }
    const count = countTok.numberValue!;
    if (count < 0) {
      throw new PdfParseError("corrupt-structure", "Negative xref subsection count.", `offset=${countTok.offset}`);
    }
    totalEntries += count;
    if (totalEntries > limits.maxObjectCount) {
      throw new PdfParseError(
        "limit-exceeded",
        `Xref table declares more objects than the configured maxObjectCount (${limits.maxObjectCount}).`,
        `offset=${offset}`,
      );
    }

    for (let i = 0; i < count; i += 1) {
      const offTok = lexer.nextToken();
      const genTok = lexer.nextToken();
      const typeTok = lexer.nextToken();
      if (offTok.type !== "number" || genTok.type !== "number" || typeTok.type !== "keyword") {
        throw new PdfParseError(
          "corrupt-structure",
          `Malformed xref entry for object ${startObjNum + i}.`,
          `offset=${offTok.offset}`,
        );
      }
      const objNum = startObjNum + i;
      if (typeTok.textValue === "f") {
        entries.set(objNum, { type: "free" });
      } else if (typeTok.textValue === "n") {
        entries.set(objNum, {
          type: "offset",
          offset: offTok.numberValue!,
          gen: genTok.numberValue!,
          source: { kind: "table", sectionOffset: offset },
        });
      } else {
        throw new PdfParseError(
          "corrupt-structure",
          `Unrecognized xref entry type '${typeTok.textValue}'.`,
          `offset=${typeTok.offset}`,
        );
      }
    }
  }

  const trailerValue = parseValue(lexer, limits);
  if (!isDict(trailerValue)) {
    throw new PdfParseError("corrupt-structure", "Expected a trailer dictionary after xref subsections.", `offset=${lexer.offset}`);
  }

  const prevVal = trailerValue.map.get("Prev");
  const xrefStmVal = trailerValue.map.get("XRefStm");
  return {
    entries,
    trailer: trailerValue.map,
    prevOffset: typeof prevVal === "number" ? prevVal : undefined,
    xrefStmOffset: typeof xrefStmVal === "number" ? xrefStmVal : undefined,
  };
}
