/**
 * PDF syntax lexer (TKT-004). Tokenizes directly from a `ByteCursor` without
 * ever materializing the whole document as a string. The lexer is stateless
 * beyond the cursor's position, so callers can backtrack with `mark()` /
 * `reset()` for the bounded lookahead the value parser needs to distinguish
 * `N G R` (an indirect reference) from two plain numbers.
 */

import { PdfParseError } from "../errors.ts";
import type { SafetyLimits } from "../types.ts";
import { ByteCursor, isDelimiterByte, isDigitByte, isWhitespaceByte, matchesKeywordAt, utf8 } from "./bytes.ts";

export type TokenType =
  | "number"
  | "name"
  | "literal-string"
  | "hex-string"
  | "array-start"
  | "array-end"
  | "dict-start"
  | "dict-end"
  | "keyword"
  | "eof";

export interface Token {
  type: TokenType;
  /** Absolute start offset of this token in the underlying buffer. */
  offset: number;
  /** Absolute end offset (exclusive). */
  end: number;
  numberValue?: number;
  /** True when a `number` token's source text had no `.` (eligible for use as an object/generation number). */
  isInt?: boolean;
  textValue?: string;
  bytesValue?: Uint8Array;
}

function tokenLimitExceeded(offset: number, limit: number): never {
  throw new PdfParseError(
    "limit-exceeded",
    `Lexer token exceeded the configured maximum length of ${limit} bytes.`,
    `offset=${offset}`,
  );
}

export class Lexer {
  constructor(
    private readonly cursor: ByteCursor,
    private readonly limits: Pick<SafetyLimits, "maxTokenLength">,
  ) {}

  mark(): number {
    return this.cursor.pos;
  }

  reset(pos: number): void {
    this.cursor.pos = pos;
  }

  get offset(): number {
    return this.cursor.pos;
  }

  private skipWhitespaceAndComments(): void {
    for (;;) {
      const b = this.cursor.peek();
      if (b === -1) return;
      if (isWhitespaceByte(b)) {
        this.cursor.next();
        continue;
      }
      if (b === 0x25 /* % */) {
        while (!this.cursor.atEnd()) {
          const c = this.cursor.next();
          if (c === 0x0a || c === 0x0d) break;
        }
        continue;
      }
      return;
    }
  }

  nextToken(): Token {
    this.skipWhitespaceAndComments();
    const start = this.cursor.pos;
    if (this.cursor.atEnd()) {
      return { type: "eof", offset: start, end: start };
    }

    const b = this.cursor.peek();

    if (b === 0x2f /* / */) return this.readName();
    if (b === 0x28 /* ( */) return this.readLiteralString();
    if (b === 0x3c /* < */) {
      if (this.cursor.peek(1) === 0x3c) {
        this.cursor.pos += 2;
        return { type: "dict-start", offset: start, end: this.cursor.pos };
      }
      return this.readHexString();
    }
    if (b === 0x3e /* > */) {
      if (this.cursor.peek(1) === 0x3e) {
        this.cursor.pos += 2;
        return { type: "dict-end", offset: start, end: this.cursor.pos };
      }
      throw new PdfParseError("corrupt-structure", "Unexpected lone '>' delimiter.", `offset=${start}`);
    }
    if (b === 0x5b /* [ */) {
      this.cursor.pos += 1;
      return { type: "array-start", offset: start, end: this.cursor.pos };
    }
    if (b === 0x5d /* ] */) {
      this.cursor.pos += 1;
      return { type: "array-end", offset: start, end: this.cursor.pos };
    }
    if (b === 0x29 /* ) */) {
      throw new PdfParseError("corrupt-structure", "Unexpected lone ')' delimiter.", `offset=${start}`);
    }
    if (isDigitByte(b) || b === 0x2b /* + */ || b === 0x2d /* - */ || b === 0x2e /* . */) {
      const numberToken = this.tryReadNumber();
      if (numberToken) return numberToken;
      // Fall through: a lone '+'/'-'/'.' with no digits is not a valid number; read it as a keyword run.
    }
    return this.readKeyword();
  }

  private readName(): Token {
    const start = this.cursor.pos;
    this.cursor.next(); // consume '/'
    const bytes: number[] = [];
    while (!this.cursor.atEnd()) {
      const b = this.cursor.peek();
      if (isWhitespaceByte(b) || isDelimiterByte(b)) break;
      this.cursor.next();
      if (b === 0x23 /* # */ && this.isHexDigit(this.cursor.peek()) && this.isHexDigit(this.cursor.peek(1))) {
        const hi = this.cursor.next();
        const lo = this.cursor.next();
        bytes.push(this.hexPairValue(hi, lo));
      } else {
        bytes.push(b);
      }
      if (bytes.length > this.limits.maxTokenLength) tokenLimitExceeded(start, this.limits.maxTokenLength);
    }
    const text = utf8(Uint8Array.from(bytes));
    return { type: "name", offset: start, end: this.cursor.pos, textValue: text };
  }

  private isHexDigit(b: number): boolean {
    return (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66);
  }

  private hexNibble(b: number): number {
    if (b >= 0x30 && b <= 0x39) return b - 0x30;
    if (b >= 0x41 && b <= 0x46) return b - 0x41 + 10;
    return b - 0x61 + 10;
  }

  private hexPairValue(hi: number, lo: number): number {
    return (this.hexNibble(hi) << 4) | this.hexNibble(lo);
  }

  private readLiteralString(): Token {
    const start = this.cursor.pos;
    this.cursor.next(); // consume '('
    const bytes: number[] = [];
    let depth = 1;
    while (true) {
      if (this.cursor.atEnd()) {
        throw new PdfParseError("corrupt-structure", "Unterminated literal string.", `offset=${start}`);
      }
      const b = this.cursor.next();
      if (b === 0x5c /* backslash */) {
        this.readLiteralEscape(bytes);
      } else if (b === 0x28 /* ( */) {
        depth += 1;
        bytes.push(b);
      } else if (b === 0x29 /* ) */) {
        depth -= 1;
        if (depth === 0) break;
        bytes.push(b);
      } else if (b === 0x0d /* CR */) {
        if (this.cursor.peek() === 0x0a) this.cursor.next();
        bytes.push(0x0a);
      } else {
        bytes.push(b);
      }
      if (bytes.length > this.limits.maxTokenLength) tokenLimitExceeded(start, this.limits.maxTokenLength);
    }
    return { type: "literal-string", offset: start, end: this.cursor.pos, bytesValue: Uint8Array.from(bytes) };
  }

  private readLiteralEscape(bytes: number[]): void {
    if (this.cursor.atEnd()) {
      throw new PdfParseError("corrupt-structure", "Unterminated escape in literal string.", `offset=${this.cursor.pos}`);
    }
    const b = this.cursor.next();
    switch (b) {
      case 0x6e: // n
        bytes.push(0x0a);
        return;
      case 0x72: // r
        bytes.push(0x0d);
        return;
      case 0x74: // t
        bytes.push(0x09);
        return;
      case 0x62: // b
        bytes.push(0x08);
        return;
      case 0x66: // f
        bytes.push(0x0c);
        return;
      case 0x28: // (
      case 0x29: // )
      case 0x5c: // backslash
        bytes.push(b);
        return;
      case 0x0d: // CR — line continuation, no char emitted
        if (this.cursor.peek() === 0x0a) this.cursor.next();
        return;
      case 0x0a: // LF — line continuation, no char emitted
        return;
      default:
        if (b >= 0x30 && b <= 0x37) {
          let value = b - 0x30;
          for (let i = 0; i < 2; i += 1) {
            const d = this.cursor.peek();
            if (d < 0x30 || d > 0x37) break;
            value = value * 8 + (this.cursor.next() - 0x30);
          }
          bytes.push(value & 0xff);
          return;
        }
        // Per spec: backslash followed by any other char is that char, backslash ignored.
        bytes.push(b);
    }
  }

  private readHexString(): Token {
    const start = this.cursor.pos;
    this.cursor.next(); // consume '<'
    const bytes: number[] = [];
    let highNibble: number | undefined;
    while (true) {
      if (this.cursor.atEnd()) {
        throw new PdfParseError("corrupt-structure", "Unterminated hex string.", `offset=${start}`);
      }
      const b = this.cursor.next();
      if (b === 0x3e /* > */) break;
      if (isWhitespaceByte(b)) continue;
      if (!this.isHexDigit(b)) {
        throw new PdfParseError("corrupt-structure", "Invalid hex digit in hex string.", `offset=${this.cursor.pos - 1}`);
      }
      if (highNibble === undefined) {
        highNibble = this.hexNibble(b);
      } else {
        bytes.push((highNibble << 4) | this.hexNibble(b));
        highNibble = undefined;
      }
      if (bytes.length > this.limits.maxTokenLength) tokenLimitExceeded(start, this.limits.maxTokenLength);
    }
    if (highNibble !== undefined) bytes.push(highNibble << 4);
    return { type: "hex-string", offset: start, end: this.cursor.pos, bytesValue: Uint8Array.from(bytes) };
  }

  private tryReadNumber(): Token | null {
    const start = this.cursor.pos;
    let hasDigits = false;
    let hasDot = false;
    let i = 0;
    const first = this.cursor.peek(i);
    if (first === 0x2b || first === 0x2d) i += 1;
    while (true) {
      const b = this.cursor.peek(i);
      if (isDigitByte(b)) {
        hasDigits = true;
        i += 1;
        continue;
      }
      if (b === 0x2e && !hasDot) {
        hasDot = true;
        i += 1;
        continue;
      }
      break;
    }
    if (!hasDigits) return null;
    if (i > this.limits.maxTokenLength) tokenLimitExceeded(start, this.limits.maxTokenLength);
    this.cursor.pos = start + i;
    const text = latin1TextOf(this.cursor.bytes, start, this.cursor.pos);
    const value = Number.parseFloat(text);
    return { type: "number", offset: start, end: this.cursor.pos, numberValue: value, isInt: !hasDot };
  }

  private readKeyword(): Token {
    const start = this.cursor.pos;
    while (!this.cursor.atEnd()) {
      const b = this.cursor.peek();
      if (isWhitespaceByte(b) || isDelimiterByte(b)) break;
      this.cursor.next();
      if (this.cursor.pos - start > this.limits.maxTokenLength) tokenLimitExceeded(start, this.limits.maxTokenLength);
    }
    if (this.cursor.pos === start) {
      // A delimiter byte we don't otherwise recognize (e.g. stray '{'/'}').
      this.cursor.next();
    }
    const text = latin1TextOf(this.cursor.bytes, start, this.cursor.pos);
    return { type: "keyword", offset: start, end: this.cursor.pos, textValue: text };
  }

  /** True when `keyword` occurs at the cursor's current position (does not consume). */
  peekKeyword(keyword: string): boolean {
    return matchesKeywordAt(this.cursor.bytes, this.cursor.pos, keyword);
  }
}

function latin1TextOf(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
}
