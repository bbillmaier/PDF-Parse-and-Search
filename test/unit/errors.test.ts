import { describe, expect, it } from "vitest";
import {
  PdfParseCancelledError,
  PdfParseDisposedError,
  PdfParseError,
} from "../../src/pdf-content-extractor/errors.ts";

describe("PdfParseError", () => {
  it("round-trips through serialization", () => {
    const original = new PdfParseError("corrupt-structure", "bad xref", "offset 42");
    const serialized = original.toSerialized();
    expect(serialized).toEqual({ code: "corrupt-structure", message: "bad xref", detail: "offset 42" });

    const restored = PdfParseError.fromSerialized(serialized);
    expect(restored).toBeInstanceOf(PdfParseError);
    expect(restored.code).toBe("corrupt-structure");
    expect(restored.message).toBe("bad xref");
    expect(restored.detail).toBe("offset 42");
  });

  it("exposes distinct subclasses for cancellation and disposal", () => {
    const cancelled = new PdfParseCancelledError();
    expect(cancelled).toBeInstanceOf(PdfParseError);
    expect(cancelled.code).toBe("cancelled");

    const disposed = new PdfParseDisposedError();
    expect(disposed).toBeInstanceOf(PdfParseError);
    expect(disposed.code).toBe("disposed");
  });
});
