/**
 * Content-stream tokenizer (TKT-009). Content-stream syntax reuses the same
 * primitive PDF value grammar as object syntax (numbers, names, strings,
 * arrays, dictionaries) but has no `obj`/`endobj`/indirect-reference
 * concepts and instead ends each operand run with a bare operator keyword
 * (`Tj`, `re`, `Do`, ...). It also has one construct general PDF object
 * syntax cannot tokenize at all: inline images (`BI` ... `ID` <raw binary>
 * `EI`), whose data is not delimited by any lexeme and must be scanned for
 * byte-for-byte. This module is deliberately independent from
 * `parser/objects.ts`'s indirect-object/stream handling — it only reuses the
 * shared byte-level `Lexer` and `parseValue` for operand values.
 */

import type { SafetyLimits } from "../types.ts";
import { ByteCursor, isDelimiterByte, isWhitespaceByte } from "../parser/bytes.ts";
import { Lexer } from "../parser/lexer.ts";
import { parseValue, type PdfValue } from "../parser/objects.ts";

export interface OperatorToken {
  kind: "operator";
  operator: string;
  operands: PdfValue[];
  /** Absolute offset of the operator keyword, for diagnostics. */
  offset: number;
}

export interface InlineImageToken {
  kind: "inline-image";
  /** Absolute offset of the `BI` keyword. */
  offset: number;
  /** Absolute offset right after the closing `EI` (or end of buffer if unterminated). */
  endOffset: number;
  terminated: boolean;
}

export type ContentToken = OperatorToken | InlineImageToken;

type ContentLimits = Pick<SafetyLimits, "maxNestingDepth" | "maxTokenLength">;

/** Tokenizes one decoded page content stream into an operator/inline-image sequence. */
export class ContentTokenizer {
  private readonly lexer: Lexer;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array, private readonly limits: ContentLimits) {
    this.bytes = bytes;
    this.lexer = new Lexer(new ByteCursor(bytes, 0, bytes.length), limits);
  }

  /** Returns the next operator or inline-image token, or `null` at end of stream. */
  next(): ContentToken | null {
    const operands: PdfValue[] = [];

    for (;;) {
      const mark = this.lexer.mark();
      const token = this.lexer.nextToken();

      if (token.type === "eof") {
        if (operands.length === 0) return null;
        // Trailing operands with no operator: not a valid operator call: drop them silently.
        return null;
      }

      if (
        token.type === "number" ||
        token.type === "name" ||
        token.type === "literal-string" ||
        token.type === "hex-string" ||
        token.type === "array-start" ||
        token.type === "dict-start"
      ) {
        this.lexer.reset(mark);
        operands.push(parseValue(this.lexer, this.limits));
        continue;
      }

      if (token.type === "array-end" || token.type === "dict-end") {
        // Stray closing delimiter: not valid at operand-stack level. Skip defensively.
        continue;
      }

      // token.type === "keyword"
      const text = token.textValue ?? "";
      if (text === "true" || text === "false" || text === "null") {
        this.lexer.reset(mark);
        operands.push(parseValue(this.lexer, this.limits));
        continue;
      }
      if (text === "BI") {
        return this.readInlineImage(token.offset);
      }
      return { kind: "operator", operator: text, operands, offset: token.offset };
    }
  }

  private readInlineImage(startOffset: number): InlineImageToken {
    // Consume the image-dictionary key/value pairs up to (and including) `ID`.
    for (;;) {
      const mark = this.lexer.mark();
      const token = this.lexer.nextToken();
      if (token.type === "eof") {
        return { kind: "inline-image", offset: startOffset, endOffset: this.bytes.length, terminated: false };
      }
      if (token.type === "keyword" && token.textValue === "ID") break;
      this.lexer.reset(mark);
      // One name/value pair per PDF spec 8.9.7 (abbreviated dictionary entries).
      parseValue(this.lexer, this.limits);
    }

    // Exactly one whitespace byte separates `ID` from the raw image data (spec 8.9.7).
    let dataStart = this.lexer.offset;
    if (dataStart < this.bytes.length && isWhitespaceByte(this.bytes[dataStart])) dataStart += 1;

    const end = this.findInlineImageDataEnd(dataStart);
    this.lexer.reset(end.resumeAt);
    return { kind: "inline-image", offset: startOffset, endOffset: end.resumeAt, terminated: end.terminated };
  }

  /** Heuristic scan for the `EI` terminator: whitespace-bounded `EI`, per common PDF-producer convention. */
  private findInlineImageDataEnd(start: number): { resumeAt: number; terminated: boolean } {
    const bytes = this.bytes;
    for (let i = start; i < bytes.length - 1; i += 1) {
      if (bytes[i] !== 0x45 /* E */ || bytes[i + 1] !== 0x49 /* I */) continue;
      const beforeOk = i === start || isWhitespaceByte(bytes[i - 1]);
      const afterIdx = i + 2;
      const afterOk = afterIdx >= bytes.length || isWhitespaceByte(bytes[afterIdx]) || isDelimiterByte(bytes[afterIdx]);
      if (beforeOk && afterOk) return { resumeAt: afterIdx, terminated: true };
    }
    return { resumeAt: bytes.length, terminated: false };
  }
}
