import { describe, expect, it } from "vitest";
import {
  buildPartialFallbackTsQuery,
  buildPrefixTsQuery,
  MAX_PARTIAL_FALLBACK_TERMS,
  MAX_PREFIX_TERM_LENGTH,
  MIN_PREFIX_TERM_LENGTH,
  parseSearchQuery,
  selectPrefixTerm,
  type ParsedSearchQuery,
} from "../../src/search-query.ts";

function parsed(query: string): ParsedSearchQuery {
  const result = parseSearchQuery(query);
  if (!result.ok) throw new Error(`Expected ok result for ${JSON.stringify(query)}, got rejection: ${result.message}`);
  return result.query;
}

describe("selectPrefixTerm (TKT-033 prefix eligibility)", () => {
  it("selects the literal final bare term as the prefix candidate", () => {
    expect(selectPrefixTerm(parsed("engine inspect"))).toBe("inspect");
  });

  it("selects the sole term of a single-word query", () => {
    expect(selectPrefixTerm(parsed("inspect"))).toBe("inspect");
  });

  it("returns null when the query ends inside a quoted phrase", () => {
    expect(selectPrefixTerm(parsed('engine "inspection report"'))).toBeNull();
    expect(selectPrefixTerm(parsed('"inspect"'))).toBeNull();
  });

  it("returns null when the query ends on an excluded term", () => {
    expect(selectPrefixTerm(parsed("engine -inspect"))).toBeNull();
  });

  it("returns null when the query contains OR anywhere", () => {
    expect(selectPrefixTerm(parsed("engine OR inspect"))).toBeNull();
    expect(selectPrefixTerm(parsed("inspect OR engine"))).toBeNull();
  });

  it("returns null when the final term is shorter than the minimum prefix length", () => {
    const shortWord = "a".repeat(MIN_PREFIX_TERM_LENGTH - 1);
    expect(selectPrefixTerm(parsed(`engine ${shortWord}`))).toBeNull();
  });

  it("accepts a final term exactly at the minimum prefix length", () => {
    const word = "a".repeat(MIN_PREFIX_TERM_LENGTH);
    expect(selectPrefixTerm(parsed(`engine ${word}`))).toBe(word);
  });

  it("returns null when the final term is longer than the maximum prefix length", () => {
    const longWord = "a".repeat(MAX_PREFIX_TERM_LENGTH + 1);
    expect(selectPrefixTerm(parsed(`engine ${longWord}`))).toBeNull();
  });

  it("accepts a final term exactly at the maximum prefix length", () => {
    const word = "a".repeat(MAX_PREFIX_TERM_LENGTH);
    expect(selectPrefixTerm(parsed(`engine ${word}`))).toBe(word);
  });

  it("re-selects a term that also appears earlier in the query (dedup in `terms` does not hide it)", () => {
    // "terms" dedupes to ["engine", "inspect"], but the literal final typed
    // token is still "inspect" -- selection must use query order, not the
    // deduplicated terms list.
    expect(selectPrefixTerm(parsed("engine inspect engine inspect"))).toBe("inspect");
  });
});

describe("buildPrefixTsQuery (TKT-033 safe prefix tsquery construction)", () => {
  it("turns the final term into a prefix match, ANDed with earlier terms", () => {
    const result = buildPrefixTsQuery(parsed("engine inspect"));
    expect(result).toEqual({ tsQuery: "engine & inspect:*", prefixTerm: "inspect" });
  });

  it("prefixes a single-word query with no leading AND clause", () => {
    expect(buildPrefixTsQuery(parsed("inspect"))?.tsQuery).toBe("inspect:*");
  });

  it("keeps an earlier quoted phrase as an adjacency-required AND clause", () => {
    const result = buildPrefixTsQuery(parsed('"engine inspection" report inspect'));
    expect(result?.tsQuery).toBe("(engine<->inspection) & report & inspect:*");
  });

  it("ANDs in excluded terms as negated clauses", () => {
    const result = buildPrefixTsQuery(parsed("engine -aircraft inspect"));
    expect(result?.tsQuery).toBe("engine & inspect:* & !aircraft");
  });

  it("returns null for every case selectPrefixTerm rejects", () => {
    expect(buildPrefixTsQuery(parsed("engine OR inspect"))).toBeNull();
    expect(buildPrefixTsQuery(parsed('"inspect"'))).toBeNull();
    expect(buildPrefixTsQuery(parsed("engine -inspect"))).toBeNull();
  });

  it("only ever produces text from the safe [a-z0-9-] lexeme set plus fixed tsquery operators", () => {
    const result = buildPrefixTsQuery(parsed('"part-no-a-12" -x2 inspect'));
    expect(result?.tsQuery).toMatch(/^[a-z0-9()<>\-!:* &]+$/);
  });

  it("rejects (throws) rather than silently including a hand-crafted unsafe lexeme", () => {
    // parseSearchQuery can never actually produce a clause like this -- this
    // proves the builder does not blindly trust its input shape even so,
    // rather than relying entirely on upstream validation.
    const hostile: ParsedSearchQuery = {
      normalized: "engine",
      terms: ["engine"],
      phrases: [],
      excludedTerms: [],
      hasOr: false,
      positiveClauses: [{ type: "term", word: "engine; DROP TABLE documents; --" }],
      endsWithExcludedTerm: false,
    };
    expect(() => buildPrefixTsQuery(hostile)).toThrow(/unsafe lexeme/);
  });
});

describe("buildPartialFallbackTsQuery (TKT-033 bounded partial-term fallback)", () => {
  it("ORs distinct positive terms together", () => {
    const result = buildPartialFallbackTsQuery(parsed("hydraulic calibration zx-99"));
    expect(result).toEqual({ tsQuery: "hydraulic | calibration | zx-99", termCount: 3 });
  });

  it("keeps a quoted phrase as one atomic adjacency-required OR alternative, never split into independent words", () => {
    const result = buildPartialFallbackTsQuery(parsed('engine "inspection report"'));
    expect(result?.tsQuery).toBe("engine | (inspection<->report)");
  });

  it("ANDs excluded terms onto the OR'd positive expression", () => {
    const result = buildPartialFallbackTsQuery(parsed("engine motor -aircraft"));
    expect(result?.tsQuery).toBe("(engine | motor) & !aircraft");
  });

  it("bounds the number of OR'd clauses at MAX_PARTIAL_FALLBACK_TERMS", () => {
    const words = Array.from({ length: MAX_PARTIAL_FALLBACK_TERMS + 5 }, (_, index) => `word${index}`);
    const result = buildPartialFallbackTsQuery(parsed(words.join(" ")));
    expect(result?.termCount).toBe(MAX_PARTIAL_FALLBACK_TERMS);
    expect(result?.tsQuery.split(" | ")).toHaveLength(MAX_PARTIAL_FALLBACK_TERMS);
  });

  it("still applies to OR queries (unlike prefix matching, OR does not disable fallback)", () => {
    const result = buildPartialFallbackTsQuery(parsed("engine OR motor"));
    expect(result?.tsQuery).toBe("engine | motor");
  });

  it("rejects (throws) rather than silently including a hand-crafted unsafe lexeme", () => {
    const hostile: ParsedSearchQuery = {
      normalized: "engine",
      terms: ["engine); DROP TABLE documents; --"],
      phrases: [],
      excludedTerms: [],
      hasOr: false,
      positiveClauses: [{ type: "term", word: "engine); DROP TABLE documents; --" }],
      endsWithExcludedTerm: false,
    };
    expect(() => buildPartialFallbackTsQuery(hostile)).toThrow(/unsafe lexeme/);
  });
});
