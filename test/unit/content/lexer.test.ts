/**
 * TKT-009 — content-stream tokenizer unit tests. Verifies operand/operator
 * splitting and the inline-image (BI/ID/EI) skip heuristic in isolation
 * from the operator interpreter.
 */
import { describe, expect, it } from "vitest";
import { ContentTokenizer } from "../../../src/pdf-content-extractor/content/lexer.ts";
import { DEFAULT_SAFETY_LIMITS } from "../../../src/pdf-content-extractor/parser/limits.ts";
import { isName, isPdfString } from "../../../src/pdf-content-extractor/parser/objects.ts";

function bytesOf(text: string): Uint8Array {
  return new Uint8Array([...text].map((c) => c.charCodeAt(0)));
}

function tokenizeAll(text: string) {
  const tokenizer = new ContentTokenizer(bytesOf(text), DEFAULT_SAFETY_LIMITS);
  const tokens = [];
  for (;;) {
    const token = tokenizer.next();
    if (token === null) break;
    tokens.push(token);
  }
  return tokens;
}

describe("ContentTokenizer operators and operands", () => {
  it("splits operands from an operator keyword", () => {
    const tokens = tokenizeAll("1 0 0 1 72 720 cm");
    expect(tokens).toHaveLength(1);
    const [token] = tokens;
    if (token.kind !== "operator") throw new Error("expected operator token");
    expect(token.operator).toBe("cm");
    expect(token.operands).toEqual([1, 0, 0, 1, 72, 720]);
  });

  it("emits one operator token per operator in sequence", () => {
    const tokens = tokenizeAll("q 1 0 0 1 0 0 cm Q");
    expect(tokens.map((t) => (t.kind === "operator" ? t.operator : t.kind))).toEqual(["q", "cm", "Q"]);
  });

  it("parses string and array operands for Tj/TJ", () => {
    const tokens = tokenizeAll("(Hello) Tj [(A) -250 (B)] TJ");
    expect(tokens).toHaveLength(2);
    const [tj, tJ] = tokens;
    if (tj.kind !== "operator" || tJ.kind !== "operator") throw new Error("expected operator tokens");
    expect(tj.operator).toBe("Tj");
    expect(isPdfString(tj.operands[0]) && Buffer.from(tj.operands[0].bytes).toString("latin1")).toBe("Hello");
    expect(tJ.operator).toBe("TJ");
  });

  it("parses a name operand for Tf", () => {
    const tokens = tokenizeAll("/F1 12 Tf");
    const [token] = tokens;
    if (token.kind !== "operator") throw new Error("expected operator token");
    expect(isName(token.operands[0]) && token.operands[0].name).toBe("F1");
    expect(token.operands[1]).toBe(12);
  });

  it("parses a dict operand for BDC properties", () => {
    const tokens = tokenizeAll("/P <</MCID 3>> BDC");
    const [token] = tokens;
    if (token.kind !== "operator") throw new Error("expected operator token");
    expect(token.operator).toBe("BDC");
    expect(token.operands).toHaveLength(2);
  });

  it("reports the offset of the operator keyword", () => {
    const tokens = tokenizeAll("  1 2 Td");
    const [token] = tokens;
    if (token.kind !== "operator") throw new Error("expected operator token");
    expect(token.offset).toBe("  1 2 ".length);
  });
});

describe("ContentTokenizer inline images", () => {
  it("skips BI/ID/EI as one inline-image token and resumes tokenizing after it", () => {
    const bytes = Buffer.concat([
      Buffer.from("q BI /W 1 /H 1 /BPC 8 /CS /G ID ", "latin1"),
      Buffer.from([0xff, 0x01, 0x45, 0x49]), // raw pixel bytes that happen to contain "EI" without whitespace framing
      Buffer.from(" EI Q", "latin1"),
    ]);
    const tokenizer = new ContentTokenizer(new Uint8Array(bytes), DEFAULT_SAFETY_LIMITS);
    const tokens = [];
    for (;;) {
      const token = tokenizer.next();
      if (token === null) break;
      tokens.push(token);
    }
    expect(tokens.map((t) => (t.kind === "operator" ? t.operator : t.kind))).toEqual(["q", "inline-image", "Q"]);
    const inlineToken = tokens[1];
    if (inlineToken.kind !== "inline-image") throw new Error("expected inline-image token");
    expect(inlineToken.terminated).toBe(true);
  });

  it("marks an unterminated inline image and consumes to end of buffer", () => {
    const tokens = tokenizeAll("BI /W 1 ID \xff\xff\xff");
    expect(tokens).toHaveLength(1);
    const [token] = tokens;
    if (token.kind !== "inline-image") throw new Error("expected inline-image token");
    expect(token.terminated).toBe(false);
  });
});
