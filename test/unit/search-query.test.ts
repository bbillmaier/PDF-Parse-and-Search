import { describe, expect, it } from "vitest";
import { MAX_QUERY_LENGTH, MAX_QUERY_TERMS, parseSearchQuery } from "../../src/search-query.ts";

function ok(query: string) {
  const result = parseSearchQuery(query);
  if (!result.ok) throw new Error(`Expected ok result for ${JSON.stringify(query)}, got rejection: ${result.message}`);
  return result.query;
}

function rejected(query: string) {
  const result = parseSearchQuery(query);
  if (result.ok) throw new Error(`Expected rejection for ${JSON.stringify(query)}, got: ${JSON.stringify(result.query)}`);
  return result.message;
}

describe("parseSearchQuery (TKT-032 safe web-style search syntax)", () => {
  it("parses an ordinary multiword search as plain AND terms with no phrase", () => {
    const query = ok("engine inspection");
    expect(query.terms).toEqual(["engine", "inspection"]);
    expect(query.phrases).toEqual([]);
    expect(query.excludedTerms).toEqual([]);
    expect(query.hasOr).toBe(false);
    expect(query.normalized).toBe("engine inspection");
  });

  it("parses a quoted exact phrase, keeping its words for terms and as a phrase", () => {
    const query = ok('"engine inspection"');
    expect(query.phrases).toEqual([["engine", "inspection"]]);
    expect(query.terms).toEqual(["engine", "inspection"]);
    expect(query.normalized).toBe('"engine inspection"');
  });

  it("parses OR as an alternative, case-insensitively", () => {
    expect(ok("engine OR motor").normalized).toBe("engine OR motor");
    expect(ok("engine or motor").hasOr).toBe(true);
    expect(ok("engine Or motor").normalized).toBe("engine OR motor");
  });

  it("parses -word as an excluded term, omitted from positive terms", () => {
    const query = ok("inspection -aircraft");
    expect(query.terms).toEqual(["inspection"]);
    expect(query.excludedTerms).toEqual(["aircraft"]);
    expect(query.normalized).toBe("inspection -aircraft");
  });

  it("does not treat a space-separated dash as exclusion (minus must be attached to its word)", () => {
    const query = ok("inspection - aircraft");
    expect(query.excludedTerms).toEqual([]);
    expect(query.terms).toEqual(["inspection", "aircraft"]);
  });

  it("keeps a hyphenated technical identifier as one token, not split into pieces", () => {
    const query = ok("A-12 defect");
    expect(query.terms).toEqual(["a-12", "defect"]);
    expect(query.normalized).toBe("a-12 defect");
  });

  it("keeps a multi-hyphen identifier intact", () => {
    const query = ok("part-no-A-12-B");
    expect(query.terms).toEqual(["part-no-a-12-b"]);
  });

  it("auto-closes an unmatched quotation mark at end of input rather than erroring", () => {
    const query = ok('"unterminated phrase');
    expect(query.phrases).toEqual([["unterminated", "phrase"]]);
  });

  it("drops an empty quoted phrase instead of producing a meaningless phrase", () => {
    const query = ok('"" engine');
    expect(query.phrases).toEqual([]);
    expect(query.terms).toEqual(["engine"]);
  });

  it("rejects punctuation-only input without treating it as a usable query", () => {
    expect(rejected("!!!")).toMatch(/no searchable words/);
    expect(rejected("---")).toMatch(/no searchable words/);
    expect(rejected('""')).toMatch(/no searchable words/);
  });

  it("rejects empty input the same way as punctuation-only input", () => {
    expect(rejected("")).toMatch(/no searchable words/);
  });

  it("collapses repeated OR operators into one instead of treating the extra as a literal word", () => {
    const query = ok("engine OR OR motor");
    expect(query.hasOr).toBe(true);
    expect(query.normalized).toBe("engine OR motor");
    expect(query.terms).not.toContain("or");
  });

  it("drops a leading or trailing OR that has no term on both sides", () => {
    expect(ok("OR engine").normalized).toBe("engine");
    expect(ok("engine OR").normalized).toBe("engine");
  });

  it("drops a trailing lone dash with nothing to exclude", () => {
    const query = ok("engine -");
    expect(query.excludedTerms).toEqual([]);
    expect(query.terms).toEqual(["engine"]);
  });

  it("rejects a query made only of excluded terms", () => {
    expect(rejected("-aircraft")).toMatch(/only excludes terms/);
  });

  it("rejects queries over the length bound before parsing further", () => {
    const message = rejected("a".repeat(MAX_QUERY_LENGTH + 1));
    expect(message).toMatch(/too long/);
  });

  it("accepts a query exactly at the length bound", () => {
    expect(ok("a".repeat(MAX_QUERY_LENGTH)).terms).toEqual(["a".repeat(MAX_QUERY_LENGTH)]);
  });

  it("rejects a query with more distinct words than the term bound", () => {
    const words = Array.from({ length: MAX_QUERY_TERMS + 1 }, (_, index) => `word${index}`);
    expect(rejected(words.join(" "))).toMatch(/too many terms/);
  });

  it("accepts a query exactly at the term bound", () => {
    const words = Array.from({ length: MAX_QUERY_TERMS }, (_, index) => `word${index}`);
    expect(ok(words.join(" ")).terms).toHaveLength(MAX_QUERY_TERMS);
  });

  it("counts words inside phrases toward the term bound", () => {
    const phraseWords = Array.from({ length: MAX_QUERY_TERMS + 1 }, (_, index) => `word${index}`).join(" ");
    expect(rejected(`"${phraseWords}"`)).toMatch(/too many terms/);
  });

  it("keeps hostile SQL-looking input safely reduced to plain words, never carrying SQL syntax through", () => {
    const query = ok("'; DROP TABLE documents; --");
    expect(query.terms).toEqual(["drop", "table", "documents"]);
    expect(query.normalized).toBe("drop table documents");
    expect(query.normalized).not.toMatch(/[';]/);
  });

  it("never lets normalized output contain characters outside the safe set", () => {
    const hostile = [
      "'; DROP TABLE documents; --",
      "\" OR 1=1 --",
      "engine\\0inspection",
      "engine%27--",
      "<script>alert(1)</script>",
    ];
    for (const input of hostile) {
      const result = parseSearchQuery(input);
      if (result.ok) {
        expect(result.query.normalized).toMatch(/^[a-z0-9\- "]*$/);
      }
    }
  });

  it("combines phrase, OR, and exclusion in one query predictably", () => {
    const query = ok('engine "inspection report" -aircraft OR helicopter');
    expect(query.phrases).toEqual([["inspection", "report"]]);
    expect(query.excludedTerms).toEqual(["aircraft"]);
    expect(query.hasOr).toBe(true);
    expect(query.terms).toEqual(["engine", "inspection", "report", "helicopter"]);
    expect(query.normalized).toBe('engine "inspection report" -aircraft OR helicopter');
  });
});
