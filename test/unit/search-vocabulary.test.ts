import { describe, expect, it } from "vitest";
import {
  buildVocabularyTerms,
  MAX_VOCABULARY_TERMS_PER_DOCUMENT,
  MAX_VOCABULARY_TERM_LENGTH,
  MIN_VOCABULARY_TERM_LENGTH,
  type VocabularySourceRecord,
} from "../../src/search-vocabulary.ts";

function record(overrides: Partial<VocabularySourceRecord> = {}): VocabularySourceRecord {
  return { heading: "", tableHeader: undefined, rowHeader: undefined, text: "", ...overrides };
}

describe("buildVocabularyTerms (TKT-035)", () => {
  it("includes title, heading, table/row header words, deduplicated and lowercased", () => {
    const terms = buildVocabularyTerms("Hydraulic Manual", [
      record({ heading: "Hydraulic Checkout", tableHeader: "Torque", rowHeader: "Bolt" }),
      record({ heading: "Hydraulic Checkout" }), // duplicate heading -- no new terms
    ]);
    expect(terms).toEqual(["hydraulic", "manual", "checkout", "torque", "bolt"]);
  });

  it("never includes ordinary body text -- only heading/table/row-header labels and technical identifiers", () => {
    const terms = buildVocabularyTerms("Manual", [record({ text: "The nominal reading confirms everything is fine." })]);
    expect(terms).toEqual(["manual"]);
  });

  it("adds the canonical (no-separator, lowercase) form of a technical identifier found anywhere in body text", () => {
    const terms = buildVocabularyTerms("Manual", [record({ text: "Replacement part code A-12 installed." })]);
    expect(terms).toContain("a12");
  });

  it("excludes terms shorter than MIN_VOCABULARY_TERM_LENGTH or longer than MAX_VOCABULARY_TERM_LENGTH", () => {
    const tooLong = "x".repeat(MAX_VOCABULARY_TERM_LENGTH + 1);
    const terms = buildVocabularyTerms("", [record({ heading: `a to ${tooLong} yes` })]);
    expect(terms.every((term) => term.length >= MIN_VOCABULARY_TERM_LENGTH && term.length <= MAX_VOCABULARY_TERM_LENGTH)).toBe(true);
    expect(terms).not.toContain(tooLong);
    expect(terms).toContain("yes");
  });

  it("is deterministic: identical input always produces the identical term list", () => {
    const records = [record({ heading: "Section One", tableHeader: "Value" }), record({ heading: "Section Two" })];
    expect(buildVocabularyTerms("Title", records)).toEqual(buildVocabularyTerms("Title", records));
  });

  it("caps total terms per document at MAX_VOCABULARY_TERMS_PER_DOCUMENT", () => {
    const records = Array.from({ length: MAX_VOCABULARY_TERMS_PER_DOCUMENT + 50 }, (_, i) => record({ heading: `unique${i}` }));
    const terms = buildVocabularyTerms("", records);
    expect(terms.length).toBeLessThanOrEqual(MAX_VOCABULARY_TERMS_PER_DOCUMENT);
  });
});
