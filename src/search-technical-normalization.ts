/**
 * TKT-034: bounded, deterministic indexing-time normalizer for technical
 * identifiers (docs/DESIGN.md section 21.4), for example a part or figure
 * code written as `A-12`, `A12`, or `A 12` depending on which document (or
 * which page of the same document) wrote it.
 *
 * PostgreSQL's `simple` tokenizer treats these three spellings as unrelated
 * lexemes -- `to_tsvector('simple', 'A-12')` produces `'a':1 '-12':2` (the
 * hyphenated int-looking suffix is its own token), `'A12'` produces a single
 * `'a12':1` lexeme, and `'A 12'` produces `'a':1 '12':2`. None of the three
 * `@@` each other. This module scans a block's own source text (never
 * mutating it) for identifier-shaped substrings and returns the *other*
 * canonical spellings as short, deterministic index-only text so all three
 * forms become mutually searchable through the `simple` vector, regardless
 * of which one the source document happened to use.
 *
 * This is indexing input only. The returned text is stored in
 * `document_search_blocks.technical_variants` (migration 003) and folded
 * into `search_vector_simple` at the lowest weight ('D') -- never displayed,
 * never a snippet source (server/lifecycle.ts always builds snippets from
 * the original `content` column), and never capable of outranking a real
 * match on the block's own displayed text.
 */

/** A code must look like `LETTERS` + optional single `-`/space + `DIGITS`,
 *  anchored so it is never a partial match inside a longer alphanumeric run
 *  (so "AB12CD34" produces no match at all rather than an arbitrary partial
 *  one -- see "reject ambiguous expansion" below). Letters are restricted to
 *  an uppercase ASCII run: real technical codes/acronyms in source manuals
 *  are conventionally capitalized, and requiring uppercase is what keeps
 *  this from firing on ordinary lowercase prose like "in 2024". */
const IDENTIFIER_RE = /(?<![A-Za-z0-9])([A-Z]{1,4})[- ]?([0-9]{1,6})(?![A-Za-z0-9])/g;

/**
 * Reject ambiguous/unbounded expansion: at most this many *distinct*
 * identifiers contribute variants for one record, counted across all of its
 * fields combined (heading, table header, row header, content) in
 * first-occurrence order. A pathological block cannot make indexing cost or
 * stored variant text grow without bound -- extra identifiers beyond the cap
 * are simply not expanded, never truncated mid-identifier.
 */
export const MAX_TECHNICAL_IDENTIFIERS_PER_RECORD = 40;

/** Defensive hard cap on the final joined variant text, matching the
 *  `document_search_blocks_technical_variants_bounded` CHECK constraint
 *  (migration 003). With the identifier cap above and exactly 3 fixed forms
 *  per identifier, real output stays far under this (40 identifiers x 3
 *  short forms is at most a few hundred characters) -- this bound exists so
 *  a future change to either constant fails loudly in a unit test instead of
 *  silently violating the database constraint. */
export const MAX_TECHNICAL_VARIANTS_LENGTH = 4000;

export interface TechnicalIdentifierMatch {
  /** Canonical dedup key: uppercase letters immediately followed by digits,
   *  no separator (e.g. "A12"). Two source spellings of the same code always
   *  produce the same canonical key. */
  canonical: string;
  letters: string;
  digits: string;
}

/**
 * Finds identifier-shaped substrings in `text`, in first-occurrence order,
 * deduplicated by canonical key (a code repeated many times in one block
 * contributes variants once, not once per occurrence -- itself part of
 * keeping expansion bounded). Never throws; an absence of matches returns an
 * empty array. Pure and deterministic: identical input always returns an
 * identically ordered result.
 */
export function findTechnicalIdentifiers(text: string): TechnicalIdentifierMatch[] {
  const seen = new Set<string>();
  const matches: TechnicalIdentifierMatch[] = [];
  IDENTIFIER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IDENTIFIER_RE.exec(text)) !== null) {
    const letters = match[1];
    const digits = match[2];
    const canonical = `${letters}${digits}`;
    if (!seen.has(canonical)) {
      seen.add(canonical);
      matches.push({ canonical, letters, digits });
    }
  }
  return matches;
}

/** The fixed, bounded set of alternate spellings for one identifier --
 *  always exactly these three forms (deduplicated if two coincide), never a
 *  combinatorial or open-ended expansion. */
export function identifierVariantForms(match: TechnicalIdentifierMatch): string[] {
  const hyphenated = `${match.letters}-${match.digits}`;
  const concatenated = `${match.letters}${match.digits}`;
  const spaced = `${match.letters} ${match.digits}`;
  return [...new Set([hyphenated, concatenated, spaced])];
}

/**
 * Scans every given field (heading, table header, row header, content --
 * whichever a record has) for technical identifiers, deduplicates by
 * canonical key across all of them combined, caps at
 * `MAX_TECHNICAL_IDENTIFIERS_PER_RECORD`, and returns the space-joined
 * variant text to store in `technical_variants`. Field order matters only
 * for which identifiers survive the cap when a record has more than the cap
 * allows (first-occurrence order across the given fields, heading first) --
 * deterministic, not best-effort.
 *
 * Returns `""` (never `null`/`undefined`) when no field contains an
 * identifier, matching the column's `NOT NULL DEFAULT ''`.
 */
export function buildTechnicalVariants(fields: readonly (string | null | undefined)[]): string {
  const seen = new Set<string>();
  const variantTokens: string[] = [];
  let identifierCount = 0;

  for (const field of fields) {
    if (!field) continue;
    for (const found of findTechnicalIdentifiers(field)) {
      if (seen.has(found.canonical)) continue;
      if (identifierCount >= MAX_TECHNICAL_IDENTIFIERS_PER_RECORD) break;
      seen.add(found.canonical);
      identifierCount += 1;
      variantTokens.push(...identifierVariantForms(found));
    }
  }

  const joined = variantTokens.join(" ");
  return joined.length > MAX_TECHNICAL_VARIANTS_LENGTH ? joined.slice(0, MAX_TECHNICAL_VARIANTS_LENGTH) : joined;
}
