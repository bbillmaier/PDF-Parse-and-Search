import { describe, expect, it } from "vitest";
import { parseSearchQuery } from "../../src/search-query.ts";
import {
  buildSynonymTsQuery,
  DOMAIN_SYNONYM_RULES,
  MAX_SYNONYM_EXPANSIONS_PER_TERM,
  MAX_TOTAL_SYNONYM_TERMS,
  type SynonymRule,
} from "../../src/search-synonyms.ts";

function parsed(query: string) {
  const result = parseSearchQuery(query);
  if (!result.ok) throw new Error(`Expected ok parse for ${JSON.stringify(query)}: ${result.message}`);
  return result.query;
}

describe("DOMAIN_SYNONYM_RULES configuration (TKT-035)", () => {
  it("contains at least one one-directional pair and one explicit bidirectional pair", () => {
    const flu = DOMAIN_SYNONYM_RULES.find((rule) => rule.from === "flu");
    expect(flu?.to).toContain("influenza");
    expect(DOMAIN_SYNONYM_RULES.some((rule) => rule.from === "influenza" && rule.to.includes("flu"))).toBe(false);

    expect(DOMAIN_SYNONYM_RULES.find((rule) => rule.from === "mask")?.to).toContain("respirator");
    expect(DOMAIN_SYNONYM_RULES.find((rule) => rule.from === "respirator")?.to).toContain("mask");
  });

  it("every configured word is a safe lexeme (matches the same shape websearch_to_tsquery text uses)", () => {
    const safe = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    for (const rule of DOMAIN_SYNONYM_RULES) {
      expect(rule.from).toMatch(safe);
      for (const word of rule.to) expect(word).toMatch(safe);
    }
  });
});

describe("buildSynonymTsQuery (TKT-035)", () => {
  it("a configured synonym widens a plain term into an OR group including the original term", () => {
    const result = buildSynonymTsQuery(parsed("flu"));
    expect(result).not.toBeNull();
    expect(result!.tsQuery).toBe("(flu | influenza)");
    expect(result!.expansions).toEqual([{ term: "flu", expandedTerms: ["influenza"] }]);
  });

  it("directional: the reverse term does not expand unless a reverse rule is configured", () => {
    const result = buildSynonymTsQuery(parsed("influenza"));
    expect(result).toBeNull();
  });

  it("an explicitly bidirectional pair expands in both directions", () => {
    expect(buildSynonymTsQuery(parsed("mask"))!.tsQuery).toBe("(mask | respirator)");
    expect(buildSynonymTsQuery(parsed("respirator"))!.tsQuery).toBe("(respirator | mask)");
  });

  it("returns null for a query with no configured expansion", () => {
    expect(buildSynonymTsQuery(parsed("engine inspection"))).toBeNull();
  });

  it("declines expansion entirely for a query using explicit OR, preserving OR behavior for the strict pass", () => {
    expect(buildSynonymTsQuery(parsed("flu OR headache"))).toBeNull();
  });

  it("never expands words inside a quoted phrase", () => {
    const result = buildSynonymTsQuery(parsed('"flu season" covid'));
    expect(result).not.toBeNull();
    // The phrase clause stays an unmodified adjacency group; only the plain
    // "covid" term gets an OR group.
    expect(result!.tsQuery).toBe("(flu<->season) & (covid | coronavirus | sars-cov-2)");
    expect(result!.expansions).toEqual([{ term: "covid", expandedTerms: ["coronavirus", "sars-cov-2"] }]);
  });

  it("keeps excluded terms excluded, appended unchanged after the widened positive expression", () => {
    const result = buildSynonymTsQuery(parsed("flu -contagious"));
    expect(result!.tsQuery).toBe("(flu | influenza) & !contagious");
  });

  it("does not add a synonym term already present elsewhere in the query (deduplicated)", () => {
    // "influenza" is already a query term, so expanding "flu" must not add it again.
    const result = buildSynonymTsQuery(parsed("flu influenza"));
    expect(result).toBeNull();
  });

  it("caps expansions per term at MAX_SYNONYM_EXPANSIONS_PER_TERM and the query total at MAX_TOTAL_SYNONYM_TERMS", () => {
    const manyRules: SynonymRule[] = [
      { from: "alpha", to: ["a1", "a2", "a3", "a4", "a5"] },
      { from: "bravo", to: ["b1", "b2", "b3", "b4", "b5"] },
    ];
    const result = buildSynonymTsQuery(parsed("alpha bravo"), manyRules);
    expect(result).not.toBeNull();
    const alphaExpansion = result!.expansions.find((e) => e.term === "alpha")!;
    const bravoExpansion = result!.expansions.find((e) => e.term === "bravo")!;
    expect(alphaExpansion.expandedTerms.length).toBeLessThanOrEqual(MAX_SYNONYM_EXPANSIONS_PER_TERM);
    const totalExpanded = alphaExpansion.expandedTerms.length + bravoExpansion.expandedTerms.length;
    expect(totalExpanded).toBeLessThanOrEqual(MAX_TOTAL_SYNONYM_TERMS);
    expect(totalExpanded).toBe(MAX_TOTAL_SYNONYM_TERMS);
  });
});
