/**
 * TKT-035: bounded, vocabulary-based typo suggestions (docs/DESIGN.md
 * section 21.6). Without `pg_trgm`, there is no full fuzzy scan of document
 * content -- instead, a compact vocabulary of high-value indexed terms
 * (built and maintained by src/search-vocabulary.ts) supplies a small,
 * pre-filtered candidate pool, and this module only ever computes edit
 * distance against that already-narrowed pool.
 *
 * This module is pure and has no database or Node dependency: candidate
 * fetching (SQL length/prefix filtering) lives in server/database.ts, and
 * the decision of *when* to call any of this (only for empty/weak normal
 * results) lives in server/lifecycle.ts. Keeping the algorithm here testable
 * in isolation, with no I/O, is what makes the bounds below easy to verify.
 */

/** A correction is only offered within this many edits -- large enough to
 *  catch common single-word typos (transposition, one wrong/missing/extra
 *  letter, and most two-mistake misspellings), small enough that an
 *  unrelated word essentially never qualifies by chance. */
export const MAX_EDIT_DISTANCE = 2;

/** Vocabulary candidates whose length differs from the misspelled term by
 *  more than this are never even considered -- a length-based filter this
 *  module and its caller can apply before doing any edit-distance work at
 *  all (server/database.ts's candidate query bounds length the same way). */
export const MAX_CANDIDATE_LENGTH_DELTA = 2;

/** A query term shorter than this is not attempted -- too many equally
 *  plausible vocabulary terms sit within MAX_EDIT_DISTANCE of a very short
 *  string for a correction to be meaningful rather than arbitrary. */
export const MIN_CORRECTABLE_TERM_LENGTH = 3;

/** Hard cap on how many pre-filtered vocabulary candidates this module will
 *  ever run edit distance against for one term, regardless of how many the
 *  caller's SQL filter returns -- bounds worst-case per-term work
 *  independently of vocabulary size. */
export const MAX_CANDIDATES_EXAMINED_PER_TERM = 100;

/** How many ranked suggestions `correctTerm` keeps per misspelled term. Only
 *  the single best (lowest distance, then alphabetical for determinism) is
 *  ever substituted into an executed corrected search; the rest are exposed
 *  as additional suggestions only. */
export const MAX_CORRECTIONS_PER_TERM = 3;

/** Bounds total fallback work across an entire query: at most this many
 *  distinct query terms are ever considered for correction, regardless of
 *  how many terms the query has. */
export const MAX_TERMS_CORRECTED_PER_QUERY = 3;

/**
 * Bounded (banded) Levenshtein edit distance. Unlike a plain O(n*m)
 * dynamic-program table, this only ever fills a diagonal band of width
 * `2 * maxDistance + 1`: any cell outside the band would require more than
 * `maxDistance` edits to reach, so it is left at +Infinity and never
 * computed. Returns `null` immediately if the two strings' length
 * difference alone already exceeds `maxDistance` (no edit sequence shorter
 * than that length difference can exist), and returns `null` instead of a
 * number whenever the true distance exceeds `maxDistance`, so a caller can
 * treat `null` as "not a candidate" without inspecting the value.
 */
export function boundedEditDistance(a: string, b: string, maxDistance: number): number | null {
  if (a === b) return 0;
  const lengthDelta = Math.abs(a.length - b.length);
  if (lengthDelta > maxDistance) return null;

  let previousRow = new Float64Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previousRow[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    const currentRow = new Float64Array(b.length + 1).fill(Infinity);
    const jStart = Math.max(1, i - maxDistance);
    const jEnd = Math.min(b.length, i + maxDistance);
    if (jStart === 1) currentRow[0] = i;
    for (let j = jStart; j <= jEnd; j += 1) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      const deletion = previousRow[j] + 1;
      const insertion = currentRow[j - 1] + 1;
      const substitution = previousRow[j - 1] + substitutionCost;
      currentRow[j] = Math.min(deletion, insertion, substitution);
    }
    previousRow = currentRow;
  }

  const distance = previousRow[b.length];
  return Number.isFinite(distance) && distance <= maxDistance ? distance : null;
}

export interface TermSuggestion {
  candidate: string;
  distance: number;
}

export interface TermCorrection {
  term: string;
  /** Ranked best-first (lowest distance, then alphabetical), capped at
   *  MAX_CORRECTIONS_PER_TERM. Never empty when this type is returned. */
  suggestions: TermSuggestion[];
}

/**
 * Scores an already length/prefix-filtered, already-capped candidate pool
 * (server/database.ts's vocabulary query applies both filters before this
 * ever runs) and returns the best bounded matches for one misspelled term,
 * or `null` if nothing in the pool is within MAX_EDIT_DISTANCE -- an
 * unrelated or genuinely novel term produces no manufactured correction.
 * `candidates` beyond MAX_CANDIDATES_EXAMINED_PER_TERM are never examined,
 * regardless of how many the caller passes in.
 */
export function correctTerm(term: string, candidates: readonly string[]): TermCorrection | null {
  const bounded = candidates.slice(0, MAX_CANDIDATES_EXAMINED_PER_TERM);
  const suggestions: TermSuggestion[] = [];
  for (const candidate of bounded) {
    if (candidate === term) continue;
    const distance = boundedEditDistance(term, candidate, MAX_EDIT_DISTANCE);
    if (distance === null || distance === 0) continue;
    suggestions.push({ candidate, distance });
  }
  if (suggestions.length === 0) return null;
  suggestions.sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate));
  return { term, suggestions: suggestions.slice(0, MAX_CORRECTIONS_PER_TERM) };
}
