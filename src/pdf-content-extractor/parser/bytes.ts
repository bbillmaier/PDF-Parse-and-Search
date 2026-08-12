/**
 * Byte cursor primitives (TKT-004). A `ByteCursor` never reads outside the
 * `[start, end)` range it was constructed with, and every error it raises
 * carries the absolute byte offset (against the full underlying buffer, not
 * the subview) so diagnostics stay meaningful after slicing.
 *
 * These primitives operate on raw `Uint8Array` data only; nothing in this
 * module converts the whole document to a string.
 */

import { PdfParseError } from "../errors.ts";

/** PDF whitespace bytes (spec 7.2.2, table 1): NUL, TAB, LF, FF, CR, SP. */
export function isWhitespaceByte(byte: number): boolean {
  return byte === 0x00 || byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d || byte === 0x20;
}

/** PDF delimiter bytes (spec 7.2.2, table 2): ( ) < > [ ] { } / %. */
export function isDelimiterByte(byte: number): boolean {
  return (
    byte === 0x28 || // (
    byte === 0x29 || // )
    byte === 0x3c || // <
    byte === 0x3e || // >
    byte === 0x5b || // [
    byte === 0x5d || // ]
    byte === 0x7b || // {
    byte === 0x7d || // }
    byte === 0x2f || // /
    byte === 0x25 // %
  );
}

export function isRegularByte(byte: number): boolean {
  return byte >= 0 && !isWhitespaceByte(byte) && !isDelimiterByte(byte);
}

export function isDigitByte(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x39;
}

/** Bounded, offset-tracking view over a shared `Uint8Array`. Never copies. */
export class ByteCursor {
  readonly bytes: Uint8Array;
  readonly start: number;
  readonly end: number;
  pos: number;

  constructor(bytes: Uint8Array, start = 0, end: number = bytes.length) {
    if (start < 0 || end > bytes.length || start > end) {
      throw new PdfParseError(
        "corrupt-structure",
        "Invalid byte range for ByteCursor.",
        `start=${start} end=${end} bufferLength=${bytes.length}`,
      );
    }
    this.bytes = bytes;
    this.start = start;
    this.end = end;
    this.pos = start;
  }

  get remaining(): number {
    return this.end - this.pos;
  }

  atEnd(): boolean {
    return this.pos >= this.end;
  }

  /** Byte at `pos + lookahead`, or -1 if that offset is outside `[start, end)`. */
  peek(lookahead = 0): number {
    const i = this.pos + lookahead;
    return i >= this.start && i < this.end ? this.bytes[i] : -1;
  }

  next(): number {
    if (this.atEnd()) {
      throw new PdfParseError(
        "corrupt-structure",
        "Unexpected end of input while reading a byte.",
        `offset=${this.pos}`,
      );
    }
    return this.bytes[this.pos++];
  }

  /** A bounded subview sharing the same backing buffer; no bytes are copied. */
  subview(start: number, end: number): ByteCursor {
    if (start < this.start || end > this.end || start > end) {
      throw new PdfParseError(
        "corrupt-structure",
        "Subview out of bounds of parent byte range.",
        `start=${start} end=${end} parentStart=${this.start} parentEnd=${this.end}`,
      );
    }
    return new ByteCursor(this.bytes, start, end);
  }

  /** A copy-free slice of the underlying buffer, bounds-checked against this cursor's range. */
  slice(start: number, end: number): Uint8Array {
    if (start < this.start || end > this.end || start > end) {
      throw new PdfParseError(
        "corrupt-structure",
        "Slice out of bounds of parent byte range.",
        `start=${start} end=${end} parentStart=${this.start} parentEnd=${this.end}`,
      );
    }
    return this.bytes.subarray(start, end);
  }
}

/** Decodes a byte range as Latin-1 (code point == byte value) for ASCII-only structural scanning (header, startxref). */
export function latin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: false });

/** Decodes bytes as UTF-8 with replacement on invalid sequences (used for PDF name/string text). */
export function utf8(bytes: Uint8Array): string {
  return utf8Decoder.decode(bytes);
}

/** Concatenates byte chunks into one buffer without intermediate array copies beyond the final allocation. */
export function concatBytes(chunks: Uint8Array[], totalLength: number): Uint8Array {
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Checks whether `keyword` (ASCII) occurs at `offset`, without consuming. */
export function matchesKeywordAt(bytes: Uint8Array, offset: number, keyword: string): boolean {
  if (offset < 0 || offset + keyword.length > bytes.length) return false;
  for (let i = 0; i < keyword.length; i += 1) {
    if (bytes[offset + i] !== keyword.charCodeAt(i)) return false;
  }
  return true;
}
