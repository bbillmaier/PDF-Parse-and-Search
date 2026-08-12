/**
 * Typed fatal errors for the PDF content extractor.
 *
 * Fatal structural failures reject a parse with one of these typed errors.
 * Local, recoverable failures (an unsupported image, an unknown glyph) are
 * represented as `ParseWarning` entries on the affected page or document
 * instead and never throw.
 */

export type ParseErrorCode =
  | "invalid-header"
  | "unsupported-encryption"
  | "corrupt-structure"
  | "limit-exceeded"
  | "cancelled"
  | "disposed"
  | "worker-failure"
  | "unsupported-feature"
  | "internal-error";

/** Plain, structured-clone-safe representation of a `PdfParseError`. */
export interface SerializedParseError {
  code: ParseErrorCode;
  message: string;
  detail?: string;
}

export class PdfParseError extends Error {
  readonly code: ParseErrorCode;
  readonly detail?: string;

  constructor(code: ParseErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "PdfParseError";
    this.code = code;
    this.detail = detail;
  }

  static fromSerialized(error: SerializedParseError): PdfParseError {
    return new PdfParseError(error.code, error.message, error.detail);
  }

  toSerialized(): SerializedParseError {
    return { code: this.code, message: this.message, detail: this.detail };
  }
}

export class PdfParseCancelledError extends PdfParseError {
  constructor(message = "The parse request was cancelled.") {
    super("cancelled", message);
    this.name = "PdfParseCancelledError";
  }
}

export class PdfParseDisposedError extends PdfParseError {
  constructor(message = "The parser has been disposed.") {
    super("disposed", message);
    this.name = "PdfParseDisposedError";
  }
}
