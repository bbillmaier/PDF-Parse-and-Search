import { safeLexeme, type ParsedSearchQuery } from "./search-query.ts";
import type { SynonymExpansion } from "./document-library.ts";

/**
 * TKT-035: bounded domain-synonym configuration and query expansion
 * (docs/DESIGN.md section 21.6).
 *
 * The synonym list is a small, versioned, hand-maintained configuration --
 * never automatically discovered, never derived from user behavior, and
 * never touching stored document text. It lives outside
 * `src/pdf-content-extractor/` (the portable extractor has no concept of
 * search or domain vocabulary) alongside the other host-only, environment-
 * agnostic search modules (`search-query.ts`, `search-technical-
 * normalization.ts`) that both the reference server and its tests import.
 *
 * Expansion is directional: a rule's `from` term adds its `to` terms to the
 * search, but a `to` term does not automatically search for `from` unless a
 * separate rule says so. This models real domain usage, where an
 * abbreviation or common term should broaden to its formal/alternate forms,
 * but the reverse is not always desirable (e.g. "flu" should reach
 * "influenza" content; a document that only says "influenza" should not
 * necessarily be found by every unrelated use of "flu").
 */

/** Bump when `DOMAIN_SYNONYM_RULES` changes shape or meaning, so diagnostics
 *  and any future cached artifact can tell which configuration produced a
 *  given expansion. */
export const SEARCH_SYNONYMS_CONFIG_VERSION = 1;

/** Same safe lexeme shape `src/search-query.ts` already requires for every
 *  word it turns into `tsquery` text -- kept as a local literal (not
 *  imported) so this configuration file has zero runtime dependencies and
 *  can be read/edited in isolation; `buildSynonymTsQuery` below still
 *  re-validates every word through `safeLexeme` before it ever reaches SQL. */
const CONFIG_WORD_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface SynonymRule {
  /** A normalized (lowercase, safe-lexeme) query term. */
  from: string;
  /** Additional normalized terms to also search for when `from` appears as
   *  a plain (non-phrase) query term. Never mutated at runtime. */
  to: readonly string[];
}

/**
 * Small, bounded, versioned domain configuration. Add pairs deliberately;
 * this is not meant to grow into a general thesaurus. Each entry is
 * reviewed for the target document domain (workplace/compliance manuals
 * covering infection prevention, medical care management, and technical
 * program content), not synonyms in general.
 *
 * "mask" / "respirator" is intentionally bidirectional (two explicit rules)
 * to demonstrate that direction is a configuration choice, not a hard-coded
 * limitation -- contrast with "flu" -> "influenza", which is deliberately
 * one-directional.
 */
export const DOMAIN_SYNONYM_RULES: readonly SynonymRule[] = [
  { from: "flu", to: ["influenza"] },
  { from: "covid", to: ["coronavirus", "sars-cov-2"] },
  { from: "puncture", to: ["needlestick"] },
  { from: "sanitizer", to: ["disinfectant"] },
  { from: "isolation", to: ["quarantine"] },
  { from: "mask", to: ["respirator"] },
  { from: "respirator", to: ["mask"] },
];

for (const rule of DOMAIN_SYNONYM_RULES) {
  if (!CONFIG_WORD_RE.test(rule.from)) throw new Error(`Invalid synonym configuration: "from" term ${JSON.stringify(rule.from)} is not a safe lexeme.`);
  for (const word of rule.to) {
    if (!CONFIG_WORD_RE.test(word)) throw new Error(`Invalid synonym configuration: "to" term ${JSON.stringify(word)} for ${JSON.stringify(rule.from)} is not a safe lexeme.`);
  }
}

/** Per-term cap on how many synonym alternatives one query term can
 *  contribute, so one rule with a long `to` list cannot dominate a query. */
export const MAX_SYNONYM_EXPANSIONS_PER_TERM = 3;

/** Cap on the total number of distinct synonym terms added across an entire
 *  query, independent of how many terms have rules -- bounds tsquery
 *  complexity the same way MAX_QUERY_TERMS bounds raw input
 *  (src/search-query.ts). */
export const MAX_TOTAL_SYNONYM_TERMS = 6;

export interface SynonymTsQuery {
  /** Safe `to_tsquery('simple', $1)` text -- see buildSynonymTsQuery. */
  tsQuery: string;
  /** Every expansion that actually widened the query, for diagnostics
   *  (docs/DESIGN.md section 21.6/21.8) and for the "synonym" match class's
   *  ranking multiplier to apply to rows only reachable this way. */
  expansions: SynonymExpansion[];
}

/**
 * Builds a safe `to_tsquery` expression identical in meaning to the strict
 * AND query except that each plain (non-phrase) positive term with a
 * configured synonym rule becomes an OR group of itself plus its bounded,
 * deduplicated synonym terms: `(term | synonym1 | synonym2)`. Every other
 * clause -- quoted phrases and excluded terms -- passes through completely
 * unchanged, so a phrase the user explicitly quoted is never silently
 * widened and an excluded term stays excluded.
 *
 * Declines (`null`) for the same documented reason `buildPrefixTsQuery` does
 * for `hasOr` queries: replicating `websearch_to_tsquery`'s OR grouping by
 * hand risks a subtly wrong reimplementation, and an OR query already gets
 * its own safe handling from the strict `websearch_to_tsquery` pass, so
 * synonym broadening is not needed there. Also declines when no term in the
 * query actually has a configured, usable expansion, so callers can treat a
 * non-null return as "this is worth an extra query."
 *
 * Every word emitted, including each configured synonym, is re-validated
 * through `safeLexeme` before being joined into `tsQuery` text -- defense in
 * depth against a future configuration entry that is not a safe lexeme,
 * even though the module-load-time check in this file already rejects that.
 */
export function buildSynonymTsQuery(
  parsed: Pick<ParsedSearchQuery, "hasOr" | "positiveClauses" | "excludedTerms" | "terms">,
  rules: readonly SynonymRule[] = DOMAIN_SYNONYM_RULES,
): SynonymTsQuery | null {
  if (parsed.hasOr) return null;

  const expansions: SynonymExpansion[] = [];
  const alreadyAdded = new Set<string>();
  let totalAdded = 0;

  const clauseExprs = parsed.positiveClauses.map((clause) => {
    if (clause.type === "phrase") return `(${clause.words.map(safeLexeme).join("<->")})`;
    const word = safeLexeme(clause.word);
    const rule = rules.find((candidate) => candidate.from === word);
    if (!rule) return word;

    const added: string[] = [];
    for (const candidate of rule.to) {
      if (added.length >= MAX_SYNONYM_EXPANSIONS_PER_TERM || totalAdded >= MAX_TOTAL_SYNONYM_TERMS) break;
      if (candidate === word || parsed.terms.includes(candidate) || alreadyAdded.has(candidate)) continue;
      alreadyAdded.add(candidate);
      added.push(candidate);
      totalAdded += 1;
    }
    if (added.length === 0) return word;
    expansions.push({ term: word, expandedTerms: added });
    return `(${[word, ...added].map(safeLexeme).join(" | ")})`;
  });

  if (expansions.length === 0) return null;

  const positiveExpr = clauseExprs.join(" & ");
  const excludeExpr = parsed.excludedTerms.map((word) => `!${safeLexeme(word)}`).join(" & ");
  return { tsQuery: excludeExpr ? `${positiveExpr} & ${excludeExpr}` : positiveExpr, expansions };
}
