import type { MatchClass, SearchResultBlockType, SearchScoreComponents } from "../src/document-library.ts";

/**
 * TKT-031: deterministic multi-signal search ranking.
 *
 * All ranking constants and score composition for search results live in
 * this module (see docs/DESIGN.md section 21.3) so weighting decisions are
 * documented and testable in one place instead of scattered through SQL and
 * UI code.
 *
 * Division of responsibility:
 * - PostgreSQL (server/database.ts) is responsible only for indexed
 *   candidate selection: the GIN-backed `search_vector @@ query` and title
 *   tsvector predicates decide which rows are eligible at all.
 * - Every row that clears that predicate is scored here, from its own
 *   displayed text, never from a database-side floating relevance number.
 *   Because the inputs (block type, text, query terms) are the only things
 *   that determine a score, the same data always produces the same score,
 *   and repeated searches produce the same order.
 */

export const RANKING_WEIGHTS = {
  /**
   * Base weight by structural role. A title/heading match always outweighs
   * a table-context match, which always outweighs ordinary body text --
   * the signal boosts below shift ranking within a tier, never across tiers,
   * because every additive bonus is itself a fraction of this base.
   */
  structural: {
    titleOrHeading: 100,
    tableContext: 60,
    body: 40,
  },
  /** Fraction of the structural weight added back per distinct query term
   *  matched in the candidate's own text, rewarding results that answer the
   *  whole query over ones that only answer part of it. */
  coverageWeight: 0.5,
  /** Fraction of the structural weight added when the full query (terms in
   *  order, single-spaced) appears as a literal contiguous phrase. */
  exactPhraseBoost: 0.75,
  /** Fraction of the structural weight added when every term is present in
   *  query order within `orderedNearWindow` characters but not contiguous
   *  (so it does not also qualify for the exact-phrase boost). */
  orderedNearBoost: 0.35,
  orderedNearWindow: 80,
  /**
   * Multiplier applied by match directness. "direct" (simple-vector exact
   * match), "prefix" and "partial" (TKT-033 simple-vector broadening),
   * "stemmed" (TKT-034 -- a match found only through the complementary
   * english vector), "synonym" (TKT-035 -- a match found only through a
   * configured domain-synonym expansion), and "corrected" (TKT-035 -- a
   * match found only through a bounded, vocabulary-based spelling
   * correction) are all produced by the current query pipeline. Values only
   * affect ordering *within* one match class -- src/document-library.ts's
   * MATCH_CLASS_TIER compares match class first and always wins ties, so no
   * multiplier here can let a looser class outrank a stricter one.
   */
  matchClassMultiplier: {
    direct: 1,
    prefix: 0.6,
    stemmed: 0.55,
    synonym: 0.5,
    partial: 0.35,
    corrected: 0.25,
  },
  /**
   * Length normalization. Content at or under `pivotLength` characters is
   * unaffected. Beyond it, the score decays by `decayPerDoubling` for every
   * doubling in length, so a large block cannot outrank a concise match
   * purely by being long -- note the model never rewards raw term
   * repetition in the first place (coverage is presence-based, not
   * frequency-based), so length normalization only has to counteract the
   * extra chance a long block has of containing *some* matchable text.
   */
  lengthNormalization: {
    pivotLength: 240,
    decayPerDoubling: 0.18,
  },
} as const;

function structuralWeight(blockType: SearchResultBlockType): number {
  switch (blockType) {
    case "document-title":
    case "heading":
      return RANKING_WEIGHTS.structural.titleOrHeading;
    case "table-cell":
      return RANKING_WEIGHTS.structural.tableContext;
    case "paragraph":
    case "list-item":
    case "figure-caption":
      return RANKING_WEIGHTS.structural.body;
  }
}

export interface ComputeSearchScoreInput {
  blockType: SearchResultBlockType;
  /** The candidate's own displayed text -- the same text snippets are built
   *  from -- not ambient heading-path context carried from other fields. */
  content: string;
  /** Deduplicated, lowercased query terms in first-occurrence query order
   *  (see termsFromQuery in src/document-library.ts). */
  terms: string[];
  /** Explicitly quoted phrases from the query (src/search-query.ts), each an
   *  ordered list of words. A phrase typed by the user gets the exact-phrase
   *  boost when it appears contiguously, even if other terms, OR
   *  alternatives, or exclusions are also present in the same query --
   *  TKT-031's original whole-query-join check below still applies too, so
   *  plain unquoted multiword queries keep their existing behavior. */
  phrases?: string[][];
  /** Defaults to "direct"; see matchClassMultiplier above. */
  matchClass?: MatchClass;
}

export interface ComputeSearchScoreResult {
  score: number;
  components: SearchScoreComponents;
}

export function computeSearchScore(input: ComputeSearchScoreInput): ComputeSearchScoreResult {
  const matchClass = input.matchClass ?? "direct";
  const normalized = input.content.replace(/\s+/g, " ").trim();
  const lower = normalized.toLowerCase();
  const terms = input.terms;

  const base = structuralWeight(input.blockType);

  const termPositions = terms.map((term) => lower.indexOf(term));
  const matchedTermCount = termPositions.filter((position) => position !== -1).length;
  const coverageRatio = terms.length === 0 ? 0 : matchedTermCount / terms.length;
  const coverageBonus = base * RANKING_WEIGHTS.coverageWeight * coverageRatio;

  const wholeQueryPhraseMatch = terms.length > 0 && lower.includes(terms.join(" "));
  const explicitPhraseMatch = (input.phrases ?? []).some((phrase) => phrase.length > 0 && lower.includes(phrase.join(" ")));
  const exactPhraseMatch = wholeQueryPhraseMatch || explicitPhraseMatch;
  const orderedNearMatch = !exactPhraseMatch && isOrderedNear(termPositions, RANKING_WEIGHTS.orderedNearWindow);
  const phraseBonus = exactPhraseMatch ? base * RANKING_WEIGHTS.exactPhraseBoost : 0;
  const orderedNearBonus = orderedNearMatch ? base * RANKING_WEIGHTS.orderedNearBoost : 0;

  const matchClassMultiplier = RANKING_WEIGHTS.matchClassMultiplier[matchClass];
  const rawScore = (base + coverageBonus + phraseBonus + orderedNearBonus) * matchClassMultiplier;

  const { pivotLength, decayPerDoubling } = RANKING_WEIGHTS.lengthNormalization;
  const lengthNormalizationFactor =
    normalized.length <= pivotLength ? 1 : 1 + decayPerDoubling * Math.log2(normalized.length / pivotLength);

  const finalScore = round(rawScore / lengthNormalizationFactor);

  return {
    score: finalScore,
    components: {
      blockType: input.blockType,
      structuralWeight: base,
      matchClass,
      matchClassMultiplier,
      distinctTermsMatched: matchedTermCount,
      distinctTermsTotal: terms.length,
      coverageRatio: round(coverageRatio),
      coverageBonus: round(coverageBonus),
      exactPhraseMatch,
      phraseBonus: round(phraseBonus),
      orderedNearMatch,
      orderedNearBonus: round(orderedNearBonus),
      contentLength: normalized.length,
      lengthNormalizationFactor: round(lengthNormalizationFactor),
      rawScore: round(rawScore),
      finalScore,
    },
  };
}

/** True when every term was found and appears in query order within `window`
 *  characters of the first to the last match (but not already an exact
 *  contiguous phrase -- callers only call this after ruling that out). */
function isOrderedNear(positions: number[], window: number): boolean {
  if (positions.length < 2 || positions.some((position) => position === -1)) return false;
  for (let index = 1; index < positions.length; index += 1) {
    if (positions[index] < positions[index - 1]) return false;
  }
  return positions[positions.length - 1] - positions[0] <= window;
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
