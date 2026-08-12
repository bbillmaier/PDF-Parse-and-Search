import { describe, expect, it } from "vitest";
import {
  buildSuggestionCandidates,
  escapeLikePattern,
  MAX_SUGGESTION_CANDIDATES_PER_DOCUMENT,
  MAX_SUGGESTION_TEXT_LENGTH,
  MAX_SUGGESTIONS_RETURNED,
  MIN_SUGGESTION_PREFIX_LENGTH,
  normalizeSuggestionText,
  parseSuggestionPrefix,
  rankAndDedupeSuggestions,
  type SuggestionCandidateRow,
} from "../../src/search-suggestions.ts";
import type { DocumentSearchRecord } from "../../src/pdf-content-extractor/index.ts";

function record(overrides: Partial<DocumentSearchRecord> & Pick<DocumentSearchRecord, "blockId" | "blockType" | "text">): DocumentSearchRecord {
  return {
    documentId: "doc-1",
    documentTitle: "Fixture",
    sectionId: overrides.blockId,
    heading: "",
    headingPath: [],
    pageNumber: 1,
    ...overrides,
  };
}

describe("normalizeSuggestionText", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normalizeSuggestionText("  Hydraulic   Test  Manual ")).toBe("hydraulic test manual");
  });
});

describe("escapeLikePattern", () => {
  it("escapes %, _, and backslash so they are treated literally", () => {
    expect(escapeLikePattern("100%_done\\path")).toBe("100\\%\\_done\\\\path");
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeLikePattern("hydraulic")).toBe("hydraulic");
  });
});

describe("buildSuggestionCandidates (TKT-037)", () => {
  it("includes the document title as a title candidate", () => {
    const candidates = buildSuggestionCandidates("Hydraulic Systems Manual", []);
    expect(candidates).toEqual([{ type: "title", text: "Hydraulic Systems Manual" }]);
  });

  it("includes heading-block records as heading candidates and never body-only text", () => {
    const records = [
      record({ blockId: "h-1", blockType: "heading", heading: "Engine Inspection", text: "Engine Inspection" }),
      record({ blockId: "p-1", blockType: "paragraph", heading: "Engine Inspection", text: "This body paragraph should never become a suggestion." }),
    ];
    const candidates = buildSuggestionCandidates("Manual", records);
    expect(candidates).toContainEqual({ type: "heading", text: "Engine Inspection" });
    expect(candidates.some((c) => c.text.includes("should never become"))).toBe(false);
  });

  it("finds technical identifiers across heading/table-header/row-header/text", () => {
    const records = [record({ blockId: "p-1", blockType: "paragraph", text: "Part A-12 replaced during service." })];
    const candidates = buildSuggestionCandidates("Manual", records);
    expect(candidates).toContainEqual({ type: "technical", text: "A-12" });
  });

  it("deduplicates the same text within one type", () => {
    const records = [
      record({ blockId: "h-1", blockType: "heading", heading: "Overview", text: "Overview" }),
      record({ blockId: "h-2", blockType: "heading", heading: "Overview", text: "Overview" }),
    ];
    const candidates = buildSuggestionCandidates("Manual", records);
    expect(candidates.filter((c) => c.type === "heading" && c.text === "Overview")).toHaveLength(1);
  });

  it("drops a candidate longer than MAX_SUGGESTION_TEXT_LENGTH", () => {
    const longHeading = "x".repeat(MAX_SUGGESTION_TEXT_LENGTH + 1);
    const records = [record({ blockId: "h-1", blockType: "heading", heading: longHeading, text: longHeading })];
    const candidates = buildSuggestionCandidates("Manual", records);
    expect(candidates.some((c) => c.text === longHeading)).toBe(false);
  });

  it(`caps total candidates at MAX_SUGGESTION_CANDIDATES_PER_DOCUMENT (${MAX_SUGGESTION_CANDIDATES_PER_DOCUMENT})`, () => {
    const records = Array.from({ length: MAX_SUGGESTION_CANDIDATES_PER_DOCUMENT + 50 }, (_, index) =>
      record({ blockId: `h-${index}`, blockType: "heading", heading: `Heading Number ${index}`, text: `Heading Number ${index}` }),
    );
    const candidates = buildSuggestionCandidates("Manual", records);
    expect(candidates.length).toBeLessThanOrEqual(MAX_SUGGESTION_CANDIDATES_PER_DOCUMENT);
  });

  it("is deterministic for the same input", () => {
    const records = [
      record({ blockId: "h-1", blockType: "heading", heading: "Alpha", text: "Alpha" }),
      record({ blockId: "p-1", blockType: "paragraph", text: "Code B-7 noted." }),
    ];
    expect(buildSuggestionCandidates("Manual", records)).toEqual(buildSuggestionCandidates("Manual", records));
  });
});

describe("parseSuggestionPrefix (TKT-037)", () => {
  it(`rejects a prefix shorter than MIN_SUGGESTION_PREFIX_LENGTH (${MIN_SUGGESTION_PREFIX_LENGTH})`, () => {
    const result = parseSuggestionPrefix("a");
    expect(result.ok).toBe(false);
  });

  it("rejects an empty prefix", () => {
    expect(parseSuggestionPrefix("").ok).toBe(false);
    expect(parseSuggestionPrefix("   ").ok).toBe(false);
  });

  it("accepts and normalizes a valid prefix", () => {
    const result = parseSuggestionPrefix("  Hydr  ");
    expect(result).toEqual({ ok: true, prefix: "hydr", likePattern: "hydr%" });
  });

  it("escapes LIKE metacharacters in the built pattern", () => {
    const result = parseSuggestionPrefix("100%");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.likePattern).toBe("100\\%%");
  });

  it("rejects an excessively long prefix", () => {
    expect(parseSuggestionPrefix("x".repeat(200)).ok).toBe(false);
  });
});

function candidateRow(overrides: Partial<SuggestionCandidateRow> & Pick<SuggestionCandidateRow, "type" | "text">): SuggestionCandidateRow {
  return { documentId: "doc-1", ...overrides };
}

describe("rankAndDedupeSuggestions (TKT-037)", () => {
  it("ranks title and heading suggestions above technical suggestions for the same prefix", () => {
    const ranked = rankAndDedupeSuggestions([
      candidateRow({ type: "technical", text: "HY-100" }),
      candidateRow({ type: "heading", text: "Hydraulic Overview" }),
      candidateRow({ type: "title", text: "Hydraulic Systems Manual" }),
    ]);
    expect(ranked.map((s) => s.type)).toEqual(["title", "heading", "technical"]);
  });

  it("deduplicates the same normalized text across documents, keeping the strictest type", () => {
    const ranked = rankAndDedupeSuggestions([
      candidateRow({ documentId: "doc-1", type: "technical", text: "Overview" }),
      candidateRow({ documentId: "doc-2", type: "heading", text: "overview" }),
    ]);
    expect(ranked).toEqual([{ text: "overview", type: "heading" }]);
  });

  it(`caps the returned list at MAX_SUGGESTIONS_RETURNED (${MAX_SUGGESTIONS_RETURNED})`, () => {
    const rows = Array.from({ length: MAX_SUGGESTIONS_RETURNED + 20 }, (_, index) => candidateRow({ type: "technical", text: `CODE-${index}` }));
    expect(rankAndDedupeSuggestions(rows)).toHaveLength(MAX_SUGGESTIONS_RETURNED);
  });

  it("produces a stable order across repeated calls against the same input", () => {
    const rows = [
      candidateRow({ type: "heading", text: "Beta" }),
      candidateRow({ type: "title", text: "Alpha Manual" }),
      candidateRow({ type: "technical", text: "A-1" }),
    ];
    expect(rankAndDedupeSuggestions(rows)).toEqual(rankAndDedupeSuggestions(rows));
  });

  it("passes candidate text through unescaped -- this module never produces HTML, escaping is the host's responsibility", () => {
    const ranked = rankAndDedupeSuggestions([candidateRow({ type: "heading", text: "<img src=x onerror=alert(1)>" })]);
    expect(ranked[0].text).toBe("<img src=x onerror=alert(1)>");
  });
});
