/**
 * TKT-035: compact typo-suggestion vocabulary (docs/DESIGN.md section 21.6),
 * built only from document titles, section headings, table/row headers, and
 * technical identifiers -- never ordinary paragraph, list-item, or
 * figure-caption body text. This keeps the vocabulary small and cheap
 * regardless of how much body prose a document has, and mirrors section
 * 21.7's autocomplete scope ("document titles, section headings, and
 * high-value technical terms").
 *
 * This module is pure and deterministic: the same title and search records
 * always produce the same term list, in the same order, so it can be
 * recomputed either at import time (server/database.ts) or later, from
 * already-stored `document_search_blocks` rows alone with no PDF involved
 * (server/reindex-search-core.ts) -- the same "recompute from stored data"
 * contract TKT-034's `technical_variants` already relies on.
 */
import { findTechnicalIdentifiers } from "./search-technical-normalization.ts";
import type { DocumentSearchRecord } from "./pdf-content-extractor/index.ts";

/** Caps how many distinct terms one document can contribute to the shared
 *  vocabulary table, regardless of how many headings/technical identifiers
 *  it has -- keeps a single pathologically large document from making the
 *  vocabulary (and therefore every future typo-candidate query) grow
 *  without bound. */
export const MAX_VOCABULARY_TERMS_PER_DOCUMENT = 200;

/** Below this length a term is too short to be a useful, specific
 *  correction target (and too likely to collide with unrelated short
 *  words), so it is never added to the vocabulary in the first place. */
export const MIN_VOCABULARY_TERM_LENGTH = 3;

/** Matches the `document_search_blocks_technical_variants_bounded`-style
 *  defensive ceiling used elsewhere in this codebase (TKT-034) -- a term
 *  this long is not the kind of short domain word/code the vocabulary is
 *  for. */
export const MAX_VOCABULARY_TERM_LENGTH = 40;

const WORD_RE = /[a-z0-9]+(?:-[a-z0-9]+)*/g;

function wordsOf(text: string | null | undefined): string[] {
  if (!text) return [];
  return text.toLowerCase().match(WORD_RE) ?? [];
}

function isValidVocabularyTerm(term: string): boolean {
  return term.length >= MIN_VOCABULARY_TERM_LENGTH && term.length <= MAX_VOCABULARY_TERM_LENGTH;
}

/** The subset of a search record's fields the vocabulary reads --
 *  deliberately excludes ordinary body `text` (see file-level comment: body
 *  content never contributes vocabulary terms directly). `heading` is every
 *  record's current section-heading label (generateDocumentSearchRecords
 *  sets it for every block type, not only heading blocks themselves -- and
 *  for a heading block, `heading` already equals that heading's own text),
 *  so reading it alone covers "section headings" without needing to special-
 *  case block type. Technical identifiers are the one exception that does
 *  scan `text`, since a part/figure code can appear in a table cell's own
 *  value, not just a header (see below). */
export type VocabularySourceRecord = Pick<DocumentSearchRecord, "heading" | "tableHeader" | "rowHeader" | "text">;

/**
 * Builds the bounded, deduplicated, deterministic vocabulary term list for
 * one document from its title and already-generated search records.
 * Order is title words first, then per-record in record order, so the terms
 * that survive `MAX_VOCABULARY_TERMS_PER_DOCUMENT` are always the same for
 * the same input.
 */
export function buildVocabularyTerms(documentTitle: string, records: readonly VocabularySourceRecord[]): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];

  const add = (word: string): void => {
    if (terms.length >= MAX_VOCABULARY_TERMS_PER_DOCUMENT) return;
    if (seen.has(word) || !isValidVocabularyTerm(word)) return;
    seen.add(word);
    terms.push(word);
  };

  for (const word of wordsOf(documentTitle)) add(word);

  for (const record of records) {
    for (const word of wordsOf(record.heading)) add(word);
    for (const word of wordsOf(record.tableHeader)) add(word);
    for (const word of wordsOf(record.rowHeader)) add(word);
    // Technical identifiers can appear inside a table cell's own value (a
    // part number is not always in a header), so this scans `text` for every
    // block type -- it is still bounded (findTechnicalIdentifiers caps
    // matches per call the same way src/search-technical-normalization.ts
    // already documents) and only ever adds the short canonical form, never
    // arbitrary body words.
    for (const identifier of findTechnicalIdentifiers(record.text)) add(identifier.canonical.toLowerCase());
  }

  return terms;
}
