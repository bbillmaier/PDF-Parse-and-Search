/**
 * TKT-037: bounded indexed prefix suggestions (docs/DESIGN.md section 21.7).
 *
 * Autocomplete is limited to three sources -- document display titles,
 * section headings, and high-value technical identifiers -- and must never
 * scan full document body content on each keystroke. This module is pure
 * and deterministic like the other host-side content modules
 * (`search-vocabulary.ts`, `search-technical-normalization.ts`):
 *
 * - `buildSuggestionCandidates` computes the small, bounded set of complete
 *   suggestion strings one document contributes, from its own title and
 *   already-generated search records (or, for a reindex, already-stored
 *   `document_search_blocks` rows) -- never from body paragraph/list-item/
 *   figure-caption text.
 * - `normalizeSuggestionText` / `escapeLikePattern` support the indexed
 *   `LIKE`-prefix lookup server/database.ts runs (a plain built-in btree
 *   `text_pattern_ops` index, migration 005 -- no `pg_trgm` or other
 *   extension, the same approach migration 004 already uses for the
 *   typo-suggestion vocabulary).
 * - `rankAndDedupeSuggestions` turns raw candidate rows (which may repeat
 *   the same text across many documents, e.g. a common heading like
 *   "Introduction") into the final, capped, ranked, deduplicated list the
 *   API returns.
 *
 * Suggestions are always returned as plain text -- this module never
 * produces HTML, and the host/reference UI owns escaping and presentation.
 */
import { findTechnicalIdentifiers, identifierVariantForms } from "./search-technical-normalization.ts";
import type { DocumentSearchRecord } from "./pdf-content-extractor/index.ts";

export type SuggestionType = "title" | "heading" | "technical";

/** A prefix shorter than this is rejected before any query runs -- even an
 *  indexed `LIKE` lookup on a very short prefix can match a large fraction
 *  of the table, and a one- or two-character prefix is rarely a useful
 *  suggestion anchor. Documented, not just implied by an arbitrary default. */
export const MIN_SUGGESTION_PREFIX_LENGTH = 2;

/** A prefix longer than this is not "still being typed" in any useful
 *  autocomplete sense; bounds the size of the pattern text sent to SQL. */
export const MAX_SUGGESTION_PREFIX_LENGTH = 100;

/** Caps how many distinct suggestion candidates one document can contribute
 *  (title + headings + technical identifiers combined), regardless of how
 *  many headings or identifiers it has -- mirrors
 *  MAX_VOCABULARY_TERMS_PER_DOCUMENT's role in search-vocabulary.ts, keeping
 *  a single pathologically large document from making the shared suggestion
 *  table grow without bound. */
export const MAX_SUGGESTION_CANDIDATES_PER_DOCUMENT = 60;

/** A candidate text longer than this is not a useful autocomplete
 *  suggestion (it reads as a sentence, not a title/heading/code) and is
 *  dropped rather than stored -- matches the
 *  `search_suggestions_text_bounded` CHECK constraint (migration 005). */
export const MAX_SUGGESTION_TEXT_LENGTH = 200;

/** Hard cap on how many raw candidate rows server/lifecycle.ts ever reads
 *  from the database for one prefix, before ranking/dedup -- bounds query
 *  cost independently of how many documents happen to share a matching
 *  prefix. */
export const MAX_SUGGESTION_CANDIDATES_EXAMINED = 100;

/** Hard cap on how many suggestions are ever returned to a caller, after
 *  ranking and deduplication. */
export const MAX_SUGGESTIONS_RETURNED = 10;

/** Fixed priority order suggestion types rank by, independent of any
 *  per-row score: exact-prefix title and heading suggestions must always
 *  outrank an ordinary technical-term suggestion (docs/DESIGN.md 21.7 /
 *  TKT-037 acceptance). Title outranks heading because a document's own
 *  title is the strongest, most identifying label a user can be completing. */
export const SUGGESTION_TYPE_TIER: Record<SuggestionType, number> = {
  title: 0,
  heading: 1,
  technical: 2,
};

export interface SuggestionCandidate {
  type: SuggestionType;
  /** Original display text -- plain text, never HTML. */
  text: string;
}

function isUsableCandidateText(text: string): boolean {
  return text.length > 0 && text.length <= MAX_SUGGESTION_TEXT_LENGTH;
}

/** Collapses whitespace and lowercases -- the same normalization used both
 *  when a candidate is stored (`search_suggestions.normalized`) and when a
 *  user's typed prefix is matched against it, so "Hydraulic  Test" and a
 *  search for "hydraulic test" agree regardless of incidental whitespace
 *  differences in either source. */
export function normalizeSuggestionText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Escapes SQL `LIKE` metacharacters (`\`, `%`, `_`) in a user-supplied
 *  prefix so they are matched literally rather than as wildcards. This is a
 *  correctness measure, not an injection defense -- the escaped text is
 *  still always sent as a single bound parameter, never concatenated into
 *  SQL -- but without it, a user typing a literal `%` or `_` (plausible in a
 *  technical code) would get surprising, overly broad matches. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Builds the bounded, deduplicated set of suggestion candidates one document
 * contributes: its own title, each distinct heading block's own text, and
 * each technical identifier found in any record's heading/table-header/
 * row-header/text (reusing the same detector migration 003's
 * `technical_variants` normalizer uses, so a suggested code and a
 * search-indexed code are always the same identifiers). Order is
 * deterministic (title, then headings in record order, then technical
 * identifiers in first-occurrence order), so the same input always produces
 * the same candidate list -- safe to recompute at import, reindex, or a
 * title override, exactly like `buildVocabularyTerms`.
 */
export function buildSuggestionCandidates(
  documentTitle: string,
  records: readonly Pick<DocumentSearchRecord, "heading" | "tableHeader" | "rowHeader" | "text" | "blockType">[],
): SuggestionCandidate[] {
  const seen = new Set<string>();
  const candidates: SuggestionCandidate[] = [];

  const add = (type: SuggestionType, text: string): void => {
    if (candidates.length >= MAX_SUGGESTION_CANDIDATES_PER_DOCUMENT) return;
    const trimmed = text.replace(/\s+/g, " ").trim();
    if (!isUsableCandidateText(trimmed)) return;
    const key = `${type}::${normalizeSuggestionText(trimmed)}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ type, text: trimmed });
  };

  if (documentTitle) add("title", documentTitle);

  for (const record of records) {
    if (record.blockType === "heading" && record.heading) add("heading", record.heading);
  }

  for (const record of records) {
    for (const field of [record.heading, record.tableHeader, record.rowHeader, record.text]) {
      if (!field) continue;
      for (const identifier of findTechnicalIdentifiers(field)) {
        add("technical", identifierVariantForms(identifier)[0]);
      }
    }
  }

  return candidates;
}

export interface SuggestionCandidateRow extends SuggestionCandidate {
  documentId: string;
}

export interface Suggestion {
  text: string;
  type: SuggestionType;
}

/**
 * Ranks already length/prefix-filtered candidate rows (server/database.ts's
 * `suggest` query applies the indexed prefix predicate and
 * MAX_SUGGESTION_CANDIDATES_EXAMINED cap before this ever runs), deduplicates
 * by normalized text (the same heading or title contributed by many
 * documents becomes one suggestion), and returns at most
 * MAX_SUGGESTIONS_RETURNED entries ordered by SUGGESTION_TYPE_TIER first
 * (title/heading always above technical), then shorter and then
 * alphabetically for a stable, deterministic order across repeated calls
 * against unchanged data.
 */
export function rankAndDedupeSuggestions(rows: readonly SuggestionCandidateRow[]): Suggestion[] {
  const byNormalized = new Map<string, Suggestion>();
  for (const row of rows) {
    const key = normalizeSuggestionText(row.text);
    const existing = byNormalized.get(key);
    if (!existing || SUGGESTION_TYPE_TIER[row.type] < SUGGESTION_TYPE_TIER[existing.type]) {
      byNormalized.set(key, { text: row.text, type: row.type });
    }
  }
  return [...byNormalized.values()]
    .sort(
      (a, b) =>
        SUGGESTION_TYPE_TIER[a.type] - SUGGESTION_TYPE_TIER[b.type] ||
        a.text.length - b.text.length ||
        a.text.localeCompare(b.text),
    )
    .slice(0, MAX_SUGGESTIONS_RETURNED);
}

export interface SuggestionPrefixRejection {
  ok: false;
  message: string;
}

export type SuggestionPrefixResult = { ok: true; prefix: string; likePattern: string } | SuggestionPrefixRejection;

/**
 * Validates and normalizes a raw suggestion-request prefix. Returns `ok:
 * false` for a missing/too-short/too-long prefix so the caller never runs a
 * database query for input that cannot produce a useful bounded result --
 * this is what keeps suggestions from ever scanning on every keystroke (a
 * one-character prefix is rejected here, before any SQL runs).
 */
export function parseSuggestionPrefix(rawPrefix: string): SuggestionPrefixResult {
  const normalized = normalizeSuggestionText(rawPrefix);
  if (normalized.length < MIN_SUGGESTION_PREFIX_LENGTH) {
    return { ok: false, message: `Suggestion prefix must be at least ${MIN_SUGGESTION_PREFIX_LENGTH} characters.` };
  }
  if (normalized.length > MAX_SUGGESTION_PREFIX_LENGTH) {
    return { ok: false, message: `Suggestion prefix is too long (max ${MAX_SUGGESTION_PREFIX_LENGTH} characters).` };
  }
  return { ok: true, prefix: normalized, likePattern: `${escapeLikePattern(normalized)}%` };
}
