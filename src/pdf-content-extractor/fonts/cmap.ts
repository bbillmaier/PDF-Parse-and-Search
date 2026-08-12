/**
 * `/ToUnicode` CMap parsing (TKT-010): a bounded scanner over the
 * PostScript-like CMap token stream that extracts `begincodespacerange`,
 * `beginbfchar`, and `beginbfrange` sections. This is not a general
 * PostScript interpreter — CMaps in the wild are produced by a small set of
 * tools and never need arbitrary procedure evaluation for the mappings this
 * library cares about.
 */

import { PdfParseError } from "../errors.ts";
import type { SafetyLimits } from "../types.ts";
import { ByteCursor } from "../parser/bytes.ts";
import { Lexer, type Token } from "../parser/lexer.ts";

export interface ParsedCMap {
  /** Byte width of one character code, inferred from `codespacerange` (defaults to 2, the common case for embedded ToUnicode CMaps). */
  codeByteLength: number;
  /** Character code -> decoded Unicode text (usually one code point, occasionally a short ligature/expansion). */
  toUnicode: Map<number, string>;
  warnings: string[];
}

type CMapLimits = Pick<SafetyLimits, "maxCMapBytes" | "maxCMapMappingCount" | "maxTokenLength" | "maxNestingDepth">;

function hexBytesToCode(bytes: Uint8Array): number {
  let value = 0;
  for (const b of bytes) value = value * 256 + b;
  return value;
}

function hexBytesToUtf16BEString(bytes: Uint8Array): string {
  let out = "";
  const end = bytes.length - (bytes.length % 2);
  for (let i = 0; i < end; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  if (bytes.length % 2 === 1) out += String.fromCharCode(bytes[bytes.length - 1]);
  return out;
}

export function parseToUnicodeCMap(bytes: Uint8Array, limits: CMapLimits, isCancelled?: () => boolean): ParsedCMap {
  if (bytes.byteLength > limits.maxCMapBytes) {
    throw new PdfParseError(
      "limit-exceeded",
      `A /ToUnicode CMap stream exceeded the configured maxCMapBytes (${limits.maxCMapBytes}).`,
      "context=document font=/ToUnicode limit=maxCMapBytes",
    );
  }

  const lexer = new Lexer(new ByteCursor(bytes, 0, bytes.length), limits);
  const toUnicode = new Map<number, string>();
  const warnings: string[] = [];
  let codespaceByteLength: number | undefined;
  let mappingCount = 0;

  function addMapping(code: number, text: string): void {
    if (isCancelled?.()) throw new PdfParseError("cancelled", "The parse request was cancelled during /ToUnicode CMap parsing.");
    mappingCount += 1;
    if (mappingCount > limits.maxCMapMappingCount) {
      throw new PdfParseError(
        "limit-exceeded",
        `A /ToUnicode CMap exceeded the configured maxCMapMappingCount (${limits.maxCMapMappingCount}).`,
        "context=document font=/ToUnicode limit=maxCMapMappingCount",
      );
    }
    toUnicode.set(code, text);
  }

  function isHex(token: Token): boolean {
    return token.type === "hex-string";
  }

  function readCodespaceSection(): void {
    for (;;) {
      const mark = lexer.mark();
      const lo = lexer.nextToken();
      if (lo.type === "eof") return;
      if (lo.type === "keyword" && lo.textValue === "endcodespacerange") return;
      if (!isHex(lo)) {
        lexer.reset(mark);
        lexer.nextToken(); // skip one unrecognized token defensively
        continue;
      }
      const hi = lexer.nextToken();
      if (!isHex(hi)) continue;
      if (codespaceByteLength === undefined) codespaceByteLength = lo.bytesValue!.byteLength;
    }
  }

  function readBfCharSection(): void {
    for (;;) {
      const mark = lexer.mark();
      const src = lexer.nextToken();
      if (src.type === "eof") return;
      if (src.type === "keyword" && src.textValue === "endbfchar") return;
      if (!isHex(src)) {
        lexer.reset(mark);
        lexer.nextToken();
        continue;
      }
      const dst = lexer.nextToken();
      if (!isHex(dst)) continue;
      addMapping(hexBytesToCode(src.bytesValue!), hexBytesToUtf16BEString(dst.bytesValue!));
    }
  }

  const MAX_EXPANDED_RANGE = 65536;

  function readBfRangeSection(): void {
    for (;;) {
      const mark = lexer.mark();
      const loTok = lexer.nextToken();
      if (loTok.type === "eof") return;
      if (loTok.type === "keyword" && loTok.textValue === "endbfrange") return;
      if (!isHex(loTok)) {
        lexer.reset(mark);
        lexer.nextToken();
        continue;
      }
      const hiTok = lexer.nextToken();
      if (!isHex(hiTok)) continue;
      const lo = hexBytesToCode(loTok.bytesValue!);
      const hi = hexBytesToCode(hiTok.bytesValue!);

      const dstMark = lexer.mark();
      const dstTok = lexer.nextToken();
      if (dstTok.type === "array-start") {
        let code = lo;
        for (;;) {
          const itemMark = lexer.mark();
          const item = lexer.nextToken();
          if (item.type === "array-end" || item.type === "eof") break;
          if (!isHex(item)) {
            lexer.reset(itemMark);
            lexer.nextToken();
            continue;
          }
          if (code > hi) {
            warnings.push(`bfrange array at offset ${loTok.offset} has more entries than its declared code range.`);
            break;
          }
          addMapping(code, hexBytesToUtf16BEString(item.bytesValue!));
          code += 1;
        }
      } else if (isHex(dstTok)) {
        if (hi < lo || hi - lo + 1 > MAX_EXPANDED_RANGE) {
          warnings.push(`bfrange at offset ${loTok.offset} declares an implausible code range (lo=${lo} hi=${hi}); skipped.`);
        } else {
          const dstStart = hexBytesToCode(dstTok.bytesValue!);
          for (let code = lo; code <= hi; code += 1) {
            addMapping(code, String.fromCodePoint(dstStart + (code - lo)));
          }
        }
      } else {
        lexer.reset(dstMark);
      }
    }
  }

  for (;;) {
    if (mappingCount % 4096 === 0 && isCancelled?.()) {
      throw new PdfParseError("cancelled", "The parse request was cancelled during /ToUnicode CMap scanning.");
    }
    const token = lexer.nextToken();
    if (token.type === "eof") break;
    if (token.type !== "keyword") continue;
    switch (token.textValue) {
      case "begincodespacerange":
        readCodespaceSection();
        break;
      case "beginbfchar":
        readBfCharSection();
        break;
      case "beginbfrange":
        readBfRangeSection();
        break;
      default:
        break;
    }
  }

  return { codeByteLength: codespaceByteLength ?? 2, toUnicode, warnings };
}
