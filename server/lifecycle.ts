import { createHash } from "node:crypto";
import type pg from "pg";
import type { DocumentSearchRecord, ParsedDocument, SearchableBlockType } from "../src/pdf-content-extractor/index.ts";
import { collectSemanticIds, isSafeSemanticId } from "../src/pdf-content-extractor/index.ts";
import {
  buildMatchSnippet,
  groupAndCapSearchResults,
  MATCH_CLASS_TIER,
  type MatchClass,
  type SearchResultCandidate,
  type SearchResultItem,
  type SearchStrategy,
  type SpellingCorrection,
  type SynonymExpansion,
} from "../src/document-library.ts";
import {
  buildPartialFallbackTsQuery,
  buildPrefixTsQuery,
  parseSearchQuery,
  type ParsedSearchQuery,
} from "../src/search-query.ts";
import { buildSynonymTsQuery } from "../src/search-synonyms.ts";
import {
  correctTerm,
  MAX_CANDIDATE_LENGTH_DELTA,
  MAX_CANDIDATES_EXAMINED_PER_TERM,
  MAX_TERMS_CORRECTED_PER_QUERY,
  MIN_CORRECTABLE_TERM_LENGTH,
} from "../src/search-typo.ts";
import { MIN_VOCABULARY_TERM_LENGTH } from "../src/search-vocabulary.ts";
import { HOST_TITLE_CONFIDENCE } from "../src/title-selection.ts";
import { parseSearchFilters, SEARCHABLE_BLOCK_TYPES, type RawSearchFilterInput, type SearchFilters } from "../src/search-filters.ts";
import {
  MAX_SUGGESTION_CANDIDATES_EXAMINED,
  parseSuggestionPrefix,
  rankAndDedupeSuggestions,
  type Suggestion,
  type SuggestionCandidateRow,
} from "../src/search-suggestions.ts";
import { computeSearchScore } from "./ranking.ts";
import { DocumentStorage, StorageConflictError, type DocumentAssetInput, type LoadedDocument } from "./storage.ts";
import type { PgDocumentDatabase, DocumentRow, DocumentRowInput, SearchResultRow } from "./database.ts";
import type { ReindexDocumentResult } from "./reindex-search-core.ts";

const ALLOWED_BLOCK_TYPES = new Set<SearchableBlockType>(SEARCHABLE_BLOCK_TYPES);
const MAX_RECORD_TEXT = 20_000;
const MAX_RESULT_LIMIT = 50;
const DEFAULT_PER_DOCUMENT_LIMIT = 5;
const MAX_PER_DOCUMENT_LIMIT = 20;
const CANDIDATE_MULTIPLIER = 8;
const MAX_SEARCH_CANDIDATES = 400;

/**
 * TKT-033: fewer than this many grouped, capped strict results is treated as
 * "not enough for the user to work with" and triggers the next broadening
 * stage (prefix, then partial fallback) -- see docs/DESIGN.md section 21.2's
 * fallback ladder. Chosen as a documented, small constant rather than zero
 * so a lone strict hit still gets useful company from a broadened search,
 * while a healthy page of strict results never gets diluted with looser
 * matches. Never checked against more than the caller's own requested
 * result limit (see `usefulResultThreshold` below), so asking for very few
 * results does not force broadening just to reach this number.
 */
export const MIN_USEFUL_RESULTS = 3;

/** Candidate row cap for the prefix pass, smaller than MAX_SEARCH_CANDIDATES
 *  because a prefix match fans out to more distinct lexemes than an exact
 *  term and only runs when the strict pass already came up short. */
const MAX_PREFIX_CANDIDATES = 150;

/** Candidate row cap for the TKT-034 complementary English-vector pass --
 *  bounded like every other broadening stage and only runs when the direct
 *  and prefix `simple`-vector passes together are still not useful enough
 *  (see MIN_USEFUL_RESULTS). */
const MAX_ENGLISH_CANDIDATES = 150;

/** Candidate row cap for the TKT-035 synonym-expansion pass -- bounded like
 *  every other broadening stage, and only runs when direct/prefix/stemmed
 *  together are still not useful enough (see MIN_USEFUL_RESULTS). */
const MAX_SYNONYM_CANDIDATES = 150;

/** Candidate row cap for the partial-fallback pass -- the broadest, most
 *  expensive stage, so it gets the tightest bound and only ever runs as a
 *  last resort (see MIN_USEFUL_RESULTS). */
const MAX_PARTIAL_CANDIDATES = 200;

/** Candidate row cap for the TKT-035 corrected-term pass -- runs at most
 *  once per search, as an ordinary strict (simple-vector) search against a
 *  corrected query, so it shares the strict pass's own cap rather than
 *  needing a separate large one. */
const MAX_CORRECTED_CANDIDATES = 200;

export interface ImportDocumentInput {
  documentId: string;
  title: string;
  originalFilename: string;
  originalPdf: Uint8Array;
  semanticDocument: ParsedDocument;
  assets: DocumentAssetInput[];
  searchRecords: DocumentSearchRecord[];
}

export interface ImportDocumentResult {
  document: DocumentRowInput;
  recordCount: number;
}

/** TKT-036: result of `DocumentLifecycle.overrideTitle`. `found: false`
 *  means no document matched `documentId` (the API maps this to 404,
 *  mirroring `deleteDocument`'s not-found reporting). `storageSynced: false`
 *  means the database and vocabulary updated successfully but the staged
 *  semantic-document.json publish failed -- a retryable partial failure,
 *  not an overall failure (see `overrideTitle`'s doc comment). */
export interface OverrideTitleResult {
  found: boolean;
  document?: DocumentRow;
  reindexed?: ReindexDocumentResult;
  storageSynced?: boolean;
  partialFailure?: string;
}

export interface DocumentDatabase {
  transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T>;
  insertDocument(client: pg.PoolClient, input: DocumentRowInput): Promise<void>;
  insertSearchRecords(client: pg.PoolClient, records: DocumentSearchRecord[]): Promise<void>;
  listDocuments(): Promise<DocumentRow[]>;
  getDocument(id: string): Promise<DocumentRow | undefined>;
  deleteDocument(id: string): Promise<boolean>;
  /** TKT-037: `filters` is always the already-validated output of
   *  `parseSearchFilters` -- see src/search-filters.ts -- and composes with
   *  every query strategy because every strategy funnels through this
   *  method, `searchByTsQuery`, or `searchEnglish`. */
  search(query: string, limit: number, filters?: SearchFilters): Promise<SearchResultRow[]>;
  /** TKT-033: candidate selection for a prefix or partial-fallback
   *  `tsquery` expression built by src/search-query.ts. Same indexed
   *  predicate shape as `search`, just against a different, still safely
   *  constructed, `tsquery` string. */
  searchByTsQuery(tsQuery: string, limit: number, filters?: SearchFilters): Promise<SearchResultRow[]>;
  /** TKT-034: candidate selection through the complementary `english`
   *  vector, for the same already-parsed, safe `normalized` query text
   *  `search` receives. */
  searchEnglish(query: string, limit: number, filters?: SearchFilters): Promise<SearchResultRow[]>;
  /** TKT-035: bounded, pre-filtered (length + prefix) vocabulary candidates
   *  for one misspelled term -- see src/search-typo.ts for the edit-distance
   *  scoring run over the result. */
  vocabularyCandidates(prefix: string, minLength: number, maxLength: number, limit: number): Promise<string[]>;
  /** TKT-035: true when `term` is already a known vocabulary word, so it is
   *  not attempted as a typo. */
  vocabularyHasTerm(term: string): Promise<boolean>;
  /** TKT-036: updates a document's display title in place, inside the
   *  caller's own transaction. Returns `false` (not a thrown error) when
   *  `documentId` matches no row; throws a `code: "23505"` error on a
   *  conflicting title, exactly like `insertDocument`. */
  updateDocumentTitle(client: pg.PoolClient, documentId: string, title: string): Promise<boolean>;
  /** TKT-036: rebuilds one document's search-support rows (technical
   *  identifier variants, typo-suggestion vocabulary, and TKT-037 autocomplete
   *  candidates) from its own already-stored blocks, inside the caller's own
   *  transaction -- never a PDF or the filesystem. Used by the title-override
   *  path so a changed title's words are reflected without a separate
   *  reindex step. */
  reindexDocumentVocabulary(client: pg.PoolClient, documentId: string): Promise<ReindexDocumentResult>;
  /** TKT-037: bounded indexed prefix lookup for autocomplete suggestions --
   *  `likePattern` is always an already-validated, already-escaped literal
   *  pattern built by `parseSuggestionPrefix` (src/search-suggestions.ts). */
  suggest(likePattern: string, limit: number): Promise<SuggestionCandidateRow[]>;
}

export interface SearchResponse {
  results: SearchResultItem[];
  /** TKT-033: the broadest match-class stage that contributed to the
   *  results actually returned (after grouping and capping) -- "strict" if
   *  none of the broadening stages were needed. See MatchClass/SearchStrategy
   *  in src/document-library.ts for the full tier ordering. */
  strategy: SearchStrategy;
  /** TKT-035 development-only diagnostic (see `includeDiagnostics` below):
   *  which query terms were widened by the domain synonym configuration and
   *  what they were widened to. The always-present, production-safe signal
   *  that synonym expansion contributed to what is on screen is `strategy`
   *  being "synonym" -- this field is the detailed breakdown behind it. */
  synonymExpansions?: SynonymExpansion[];
  /** TKT-035: present (in every environment, not diagnostics-gated -- the
   *  same visibility as `strategy`) whenever the typo-correction stage
   *  substituted at least one term and ran a corrected search. The exact,
   *  safe, already-parsed query text that was actually searched, so the UI
   *  can label results "Showing results for: <correctedQuery>" without
   *  re-deriving it. */
  correctedQuery?: string;
  /** TKT-035: the original -> corrected term pairs behind `correctedQuery`,
   *  always present alongside it. */
  spellingCorrections?: SpellingCorrection[];
  /** TKT-037: the validated filters actually applied to this search (an
   *  empty object when none were supplied), echoed back in structured
   *  response metadata so the caller can confirm what was applied without
   *  re-deriving it from the request it sent. */
  filters: SearchFilters;
}

/** TKT-037: response shape for `DocumentLifecycle.suggest`. */
export interface SuggestResponse {
  suggestions: Suggestion[];
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class DocumentLifecycle {
  constructor(
    private readonly storage: DocumentStorage,
    private readonly database: DocumentDatabase | PgDocumentDatabase,
    private readonly extractorVersion = "local-epic-f",
  ) {}

  async importDocument(input: ImportDocumentInput): Promise<ImportDocumentResult> {
    validateImport(input);
    const contentSha256 = sha256Hex(input.originalPdf);
    let stored;
    try {
      stored = await this.storage.save(input);
    } catch (error) {
      if (error instanceof StorageConflictError) {
        throw new ConflictError("This document is already stored. Delete the existing document before re-uploading.");
      }
      throw error;
    }
    const documentRow: DocumentRowInput = {
      id: input.documentId,
      title: input.title,
      originalFilename: input.originalFilename,
      pdfStoragePath: stored.pdfStoragePath,
      semanticStoragePath: stored.semanticStoragePath,
      assetsStoragePath: `${input.documentId}/assets`,
      contentSha256,
      extractorVersion: this.extractorVersion,
      pageCount: input.semanticDocument.metadata.pageCount,
    };
    try {
      await this.database.transaction(async (client: pg.PoolClient) => {
        await this.database.insertDocument(client, documentRow);
        await this.database.insertSearchRecords(client, input.searchRecords);
      });
      return { document: documentRow, recordCount: input.searchRecords.length };
    } catch (error) {
      await this.storage.delete(input.documentId);
      if (isUniqueViolation(error)) throw new ConflictError("A document with this title or PDF hash already exists. Delete the existing document before re-uploading.");
      throw error;
    }
  }

  async listDocuments(): Promise<DocumentRow[]> {
    return this.database.listDocuments();
  }

  async loadDocument(documentId: string): Promise<{ document: DocumentRow; stored: LoadedDocument }> {
    if (!isSafeSemanticId(documentId)) throw new ValidationError("Invalid document id.");
    const document = await this.database.getDocument(documentId);
    if (!document) throw new ValidationError("Document not found.");
    return { document, stored: await this.storage.load(documentId) };
  }

  async deleteDocument(documentId: string): Promise<{ databaseDeleted: boolean; storageDeleted: boolean; partialFailure?: string }> {
    if (!isSafeSemanticId(documentId)) throw new ValidationError("Invalid document id.");
    const databaseDeleted = await this.database.deleteDocument(documentId);
    const storageResult = await this.storage.delete(documentId);
    return { databaseDeleted, storageDeleted: storageResult.deleted, partialFailure: storageResult.partialFailure };
  }

  /**
   * TKT-036: sets an explicit host/admin display title without reparsing
   * the PDF -- the extractor and the original PDF bytes are never touched.
   * Ordering is deliberately storage-then-database-then-publish, mirroring
   * `importDocument`'s own staged-write discipline, so a failure at any
   * point leaves a clearly attributable, non-silent state:
   *
   * 1. Stage the updated semantic-document.json (new `displayTitle`/
   *    `titleSource: "host"`/`titleConfidence`, raw `metadata.title`
   *    untouched) next to the live file, without publishing it. A staging
   *    failure (e.g. disk full) touches neither the database nor the live
   *    file -- fully consistent, nothing to compensate.
   * 2. Update `documents.title` and rebuild the document's search
   *    vocabulary in one database transaction. A conflicting title (the
   *    same `documents_title_unique` constraint `importDocument` relies on)
   *    or a missing document rolls the transaction back; the staged file is
   *    discarded and nothing changed -- still fully consistent.
   * 3. Only after the database transaction commits, publish the staged file
   *    over the live one. If this step fails, the database (and therefore
   *    search/listings/vocabulary) already reflects the new title
   *    correctly -- only the semantic JSON snapshot lags. This is reported
   *    as `storageSynced: false` with `partialFailure` rather than thrown,
   *    since the operation's user-visible effect (new title, searchable)
   *    already succeeded. It is safe to compensate by retrying the same
   *    override: staging and publishing the same title again is idempotent,
   *    and the database update is a same-value no-op that cannot re-trigger
   *    the unique-title conflict against itself.
   */
  async overrideTitle(documentId: string, rawTitle: string): Promise<OverrideTitleResult> {
    if (!isSafeSemanticId(documentId)) throw new ValidationError("Invalid document id.");
    const title = rawTitle.trim();
    if (title.length === 0 || title.length > 300) throw new ValidationError("Invalid document title.");

    const existing = await this.database.getDocument(documentId);
    if (!existing) return { found: false };

    const staged = await this.storage.stageTitleOverride(documentId, {
      displayTitle: title,
      titleSource: "host",
      titleConfidence: HOST_TITLE_CONFIDENCE,
    });

    let reindexed: ReindexDocumentResult;
    try {
      reindexed = await this.database.transaction(async (client: pg.PoolClient) => {
        const updated = await this.database.updateDocumentTitle(client, documentId, title);
        if (!updated) throw new ValidationError("Document not found.");
        return this.database.reindexDocumentVocabulary(client, documentId);
      });
    } catch (error) {
      await this.storage.discardStagedTitleOverride(staged);
      if (isUniqueViolation(error)) throw new ConflictError("A document with this title already exists.");
      throw error;
    }

    let storageSynced = true;
    let partialFailure: string | undefined;
    try {
      await this.storage.publishTitleOverride(staged);
    } catch (error) {
      storageSynced = false;
      partialFailure = error instanceof Error ? error.message : String(error);
    }

    const document = await this.database.getDocument(documentId);
    return { found: true, document, reindexed, storageSynced, partialFailure };
  }

  /** Plain array-returning entry point most callers/tests use. Equivalent to
   *  `(await this.searchDetailed(...)).results`. */
  async search(
    query: string,
    limit = 20,
    perDocumentLimit = DEFAULT_PER_DOCUMENT_LIMIT,
    rawFilters?: RawSearchFilterInput,
  ): Promise<SearchResultItem[]> {
    return (await this.searchDetailed(query, limit, perDocumentLimit, rawFilters)).results;
  }

  /**
   * Runs the fallback ladder from docs/DESIGN.md sections 21.2, 21.4, and
   * 21.6 -- strict first, then (only if strict alone is not useful enough)
   * safe final-term prefix matching, then the TKT-034 complementary
   * English-vector pass, then TKT-035 domain-synonym expansion, then bounded
   * partial-term fallback, then (only if the *entire* ladder above is still
   * empty or weak) a TKT-035 bounded typo correction -- each stage only
   * attempted once the previous ones together are still not useful enough
   * -- and reports which stage's results actually reached the response, so
   * the API/UI can explain broadened results. Every non-correction stage
   * runs through the same `parseSearchQuery` output; the prefix, partial,
   * and synonym `tsquery` expressions (src/search-query.ts,
   * src/search-synonyms.ts) and the English-vector query text are all built
   * purely from that already-validated output, never from raw user text.
   * The typo-correction stage is the one exception: it re-parses a new,
   * server-substituted query text built only from vocabulary terms already
   * validated by the `search_vocabulary_terms` schema, never from anything
   * the user typed directly.
   *
   * The English-vector, synonym, and partial passes sit strictly between
   * prefix and typo correction, not run unconditionally alongside strict:
   * each is a genuinely complementary/broadening path, so it only does work
   * once the stricter passes already came up short, keeping the common case
   * (strict alone is enough) to exactly one query, same as before TKT-034.
   *
   * TKT-037: `rawFilters` (document id, page or bounded page range, section
   * id, semantic block type) is validated here, once, via
   * `parseSearchFilters` (src/search-filters.ts) -- exactly like `query`
   * itself -- and the resulting safe `SearchFilters` is passed to every
   * database call below, so it composes with every strategy in the ladder
   * (strict, prefix, stemmed, synonym, partial, and corrected all narrow
   * through the same filter).
   */
  async searchDetailed(
    query: string,
    limit = 20,
    perDocumentLimit = DEFAULT_PER_DOCUMENT_LIMIT,
    rawFilters?: RawSearchFilterInput,
  ): Promise<SearchResponse> {
    const filterResult = parseSearchFilters(rawFilters ?? {});
    if (!filterResult.ok) throw new ValidationError(filterResult.message);
    const filters = filterResult.filters;

    const trimmed = query.replace(/\s+/g, " ").trim();
    if (trimmed.length === 0) return { results: [], strategy: "strict", filters };
    // TKT-032: parses and bounds web-style syntax (quoted phrases, OR,
    // -excluded terms) before any SQL runs, and rejects unusable queries
    // (too long, too many terms, or no searchable words) so punctuation-only
    // or empty-after-parsing input never reaches the database.
    const parsed = parseSearchQuery(trimmed);
    if (!parsed.ok) throw new ValidationError(parsed.message);
    const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), MAX_RESULT_LIMIT);
    const boundedPerDocumentLimit = Math.min(Math.max(Math.trunc(perDocumentLimit), 1), MAX_PER_DOCUMENT_LIMIT);
    const groupOptions = { perDocumentCap: boundedPerDocumentLimit, totalLimit: boundedLimit };
    // Never force broadening just to exceed what the caller actually asked for.
    // TKT-035: this is also the documented "weak result" threshold that gates
    // typo-correction fallback (docs/DESIGN.md 21.6) -- the same bar every
    // other broadening stage already uses, not a separate constant.
    const usefulResultThreshold = Math.min(MIN_USEFUL_RESULTS, boundedLimit);
    // Development-only score diagnostics (DESIGN.md 21.8): never exposed in
    // production, always available while developing or running tests.
    const includeDiagnostics = process.env.NODE_ENV !== "production";

    const seenBlocks = new Set<string>();
    const candidates: SearchResultCandidate[] = [];
    let synonymExpansions: SynonymExpansion[] | undefined;

    const strictCandidateLimit = Math.min(MAX_SEARCH_CANDIDATES, boundedLimit * CANDIDATE_MULTIPLIER);
    const strictRows = await this.database.search(parsed.query.normalized, strictCandidateLimit, filters);
    addRows(candidates, seenBlocks, strictRows, parsed.query, "direct", includeDiagnostics);

    if (groupAndCapSearchResults(candidates, groupOptions).length < usefulResultThreshold) {
      const prefix = buildPrefixTsQuery(parsed.query);
      if (prefix) {
        const prefixCandidateLimit = Math.min(MAX_PREFIX_CANDIDATES, boundedLimit * CANDIDATE_MULTIPLIER);
        const prefixRows = await this.database.searchByTsQuery(prefix.tsQuery, prefixCandidateLimit, filters);
        addRows(candidates, seenBlocks, prefixRows, parsed.query, "prefix", includeDiagnostics);
      }

      if (groupAndCapSearchResults(candidates, groupOptions).length < usefulResultThreshold) {
        // TKT-034: the complementary `english` vector -- ordinary-language
        // stemmed forms (e.g. "inspected" matching "inspection") that the
        // exact-vocabulary `simple` vector (direct/prefix above) does not
        // relate. Reuses the same safe, already-parsed `normalized` query
        // text `search` sends to the strict pass; websearch_to_tsquery does
        // its own parsing entirely inside PostgreSQL for this pass too.
        const englishCandidateLimit = Math.min(MAX_ENGLISH_CANDIDATES, boundedLimit * CANDIDATE_MULTIPLIER);
        const englishRows = await this.database.searchEnglish(parsed.query.normalized, englishCandidateLimit, filters);
        addRows(candidates, seenBlocks, englishRows, parsed.query, "stemmed", includeDiagnostics);
      }

      if (groupAndCapSearchResults(candidates, groupOptions).length < usefulResultThreshold) {
        // TKT-035: domain-synonym expansion (docs/DESIGN.md 21.6). Declines
        // (`null`) for an OR query or a query with no configured expansion
        // -- see buildSynonymTsQuery -- so this only ever runs an extra query
        // when it can actually widen something.
        const synonym = buildSynonymTsQuery(parsed.query);
        if (synonym) {
          const synonymCandidateLimit = Math.min(MAX_SYNONYM_CANDIDATES, boundedLimit * CANDIDATE_MULTIPLIER);
          const synonymRows = await this.database.searchByTsQuery(synonym.tsQuery, synonymCandidateLimit, filters);
          addRows(candidates, seenBlocks, synonymRows, parsed.query, "synonym", includeDiagnostics);
          synonymExpansions = synonym.expansions;
        }
      }

      if (groupAndCapSearchResults(candidates, groupOptions).length < usefulResultThreshold) {
        const partial = buildPartialFallbackTsQuery(parsed.query);
        if (partial) {
          const partialCandidateLimit = Math.min(MAX_PARTIAL_CANDIDATES, boundedLimit * CANDIDATE_MULTIPLIER);
          const partialRows = await this.database.searchByTsQuery(partial.tsQuery, partialCandidateLimit, filters);
          addRows(candidates, seenBlocks, partialRows, parsed.query, "partial", includeDiagnostics);
        }
      }
    }

    let correctedQuery: string | undefined;
    let spellingCorrections: SpellingCorrection[] | undefined;
    if (groupAndCapSearchResults(candidates, groupOptions).length < usefulResultThreshold) {
      // TKT-035: bounded, vocabulary-based typo correction (docs/DESIGN.md
      // 21.6) -- the last, loosest stage, attempted only once every stage
      // above (direct through partial) together still leaves the query
      // empty or weak, never for an already-successful search.
      const correction = await this.attemptTypoCorrection(parsed.query);
      if (correction) {
        const correctedCandidateLimit = Math.min(MAX_CORRECTED_CANDIDATES, boundedLimit * CANDIDATE_MULTIPLIER);
        const correctedRows = await this.database.search(correction.correctedParsed.normalized, correctedCandidateLimit, filters);
        addRows(candidates, seenBlocks, correctedRows, correction.correctedParsed, "corrected", includeDiagnostics);
        correctedQuery = correction.correctedParsed.normalized;
        spellingCorrections = correction.corrections;
      }
    }

    const results = groupAndCapSearchResults(candidates, groupOptions);
    // Reflect only the results actually visible after grouping/capping -- a
    // broadened row that got crowded out should not claim credit for the
    // strategy/diagnostics reported to the UI.
    const visibleClasses = new Set(results.map((result) => result.matchClass ?? "direct"));
    return {
      results,
      strategy: strategyFromResults(results),
      filters,
      ...(includeDiagnostics && synonymExpansions && synonymExpansions.length > 0 && visibleClasses.has("synonym")
        ? { synonymExpansions }
        : {}),
      ...(correctedQuery !== undefined && visibleClasses.has("corrected") ? { correctedQuery, spellingCorrections } : {}),
    };
  }

  /**
   * TKT-037: bounded indexed prefix suggestions for autocomplete (docs/
   * DESIGN.md section 21.7). Validates the raw prefix (minimum length,
   * maximum length) before any query runs -- a too-short prefix returns an
   * empty list rather than ever reaching the database, which is what keeps
   * this from scanning on every keystroke. Reads at most
   * MAX_SUGGESTION_CANDIDATES_EXAMINED already-indexed candidate rows, then
   * ranks/dedupes/caps them (src/search-suggestions.ts) so exact-prefix
   * title and heading suggestions always sort ahead of technical-term
   * suggestions, and the same suggestion contributed by many documents
   * appears once.
   */
  async suggest(rawPrefix: string): Promise<SuggestResponse> {
    const parsed = parseSuggestionPrefix(rawPrefix);
    if (!parsed.ok) return { suggestions: [] };
    const rows = await this.database.suggest(parsed.likePattern, MAX_SUGGESTION_CANDIDATES_EXAMINED);
    return { suggestions: rankAndDedupeSuggestions(rows) };
  }

  /**
   * TKT-035: tries to substitute a close, known vocabulary term for each
   * plain (non-phrase, non-excluded) positive query term that is not itself
   * already a known vocabulary word, bounded to
   * MAX_TERMS_CORRECTED_PER_QUERY terms considered and
   * MAX_CANDIDATES_EXAMINED_PER_TERM vocabulary candidates examined per
   * term. Declines entirely (`null`) for an OR query (same documented
   * reason as buildPrefixTsQuery/buildSynonymTsQuery), for a query with no
   * plain term at least MIN_CORRECTABLE_TERM_LENGTH long, or when nothing
   * substitutable was found -- a term already in the vocabulary is treated
   * as correctly spelled and never "corrected" into something else, and a
   * term with no sufficiently close vocabulary neighbor gets no invented
   * suggestion.
   */
  private async attemptTypoCorrection(
    parsed: ParsedSearchQuery,
  ): Promise<{ correctedParsed: ParsedSearchQuery; corrections: SpellingCorrection[] } | null> {
    if (parsed.hasOr) return null;

    const correctableClauses = parsed.positiveClauses
      .filter((clause): clause is { type: "term"; word: string } => clause.type === "term" && clause.word.length >= MIN_CORRECTABLE_TERM_LENGTH)
      .slice(0, MAX_TERMS_CORRECTED_PER_QUERY);

    const replacements = new Map<string, string>();
    const corrections: SpellingCorrection[] = [];
    for (const clause of correctableClauses) {
      const word = clause.word;
      if (replacements.has(word)) continue;
      // Already a known vocabulary word -- not a typo, never "corrected"
      // into a different real word just because one happens to be nearby.
      if (await this.database.vocabularyHasTerm(word)) continue;
      const prefixLength = Math.min(2, word.length);
      const prefix = word.slice(0, prefixLength);
      const minLength = Math.max(MIN_VOCABULARY_TERM_LENGTH, word.length - MAX_CANDIDATE_LENGTH_DELTA);
      const maxLength = word.length + MAX_CANDIDATE_LENGTH_DELTA;
      const vocabularyCandidates = await this.database.vocabularyCandidates(prefix, minLength, maxLength, MAX_CANDIDATES_EXAMINED_PER_TERM);
      const correction = correctTerm(word, vocabularyCandidates);
      if (!correction) continue;
      const [best, ...rest] = correction.suggestions;
      replacements.set(word, best.candidate);
      corrections.push({ originalTerm: word, correctedTerm: best.candidate, distance: best.distance, alternatives: rest.map((entry) => entry.candidate) });
    }

    if (replacements.size === 0) return null;

    const correctedParts = [
      ...parsed.positiveClauses.map((clause) => (clause.type === "phrase" ? `"${clause.words.join(" ")}"` : replacements.get(clause.word) ?? clause.word)),
      ...parsed.excludedTerms.map((word) => `-${word}`),
    ];
    const correctedResult = parseSearchQuery(correctedParts.join(" "));
    if (!correctedResult.ok) return null;
    return { correctedParsed: correctedResult.query, corrections };
  }
}

/** Appends rows not already represented by an earlier (stricter) stage --
 *  the prefix and partial passes are strict supersets of what came before,
 *  so without this a block found by the strict pass would also come back
 *  from the prefix/partial passes and could otherwise be double-counted or
 *  have its match class incorrectly loosened. First stage to surface a
 *  block wins its match class, which is always the tightest one it
 *  qualified for. */
function addRows(
  candidates: SearchResultCandidate[],
  seenBlocks: Set<string>,
  rows: SearchResultRow[],
  parsed: ParsedSearchQuery,
  matchClass: MatchClass,
  includeDiagnostics: boolean,
): void {
  for (const row of rows) {
    const key = `${row.documentId}::${row.blockId}`;
    if (seenBlocks.has(key)) continue;
    seenBlocks.add(key);
    candidates.push(rowToCandidate(row, parsed, matchClass, includeDiagnostics));
  }
}

/** Maps every produced match class to the strategy label the UI shows for
 *  it -- "direct" reports as "strict" (no broadening happened), every other
 *  class reports as itself. Kept as an explicit table rather than a type
 *  cast so adding a match class that has no strategy meaning is a
 *  compile error here, not a silent mismatch. */
const SEARCH_STRATEGY_FOR_MATCH_CLASS: Record<MatchClass, SearchStrategy> = {
  direct: "strict",
  prefix: "prefix",
  stemmed: "stemmed",
  synonym: "synonym",
  partial: "partial",
  corrected: "corrected",
};

/** The loosest match class present among the final, visible top-level
 *  results (not `additionalMatches` -- those are secondary matches folded
 *  into an already-shown group, not a distinct visible result on their
 *  own), reported via SEARCH_STRATEGY_FOR_MATCH_CLASS. "Loosest" follows
 *  MATCH_CLASS_TIER (src/document-library.ts), the same ordering that
 *  guarantees a stricter match always ranks above a looser one regardless
 *  of score -- this function just reports which end of that ordering is
 *  visible, not which is "true," so a query that only ever needed the
 *  strict pass reports "strict" even if a looser stage also ran and found
 *  nothing that survived grouping/capping. */
function strategyFromResults(results: SearchResultItem[]): SearchStrategy {
  let strategy: SearchStrategy = "strict";
  let strategyTier = -1;
  for (const result of results) {
    const matchClass = result.matchClass ?? "direct";
    const tier = MATCH_CLASS_TIER[matchClass];
    if (tier > strategyTier) {
      strategyTier = tier;
      strategy = SEARCH_STRATEGY_FOR_MATCH_CLASS[matchClass];
    }
  }
  return strategy;
}

function rowToCandidate(
  row: SearchResultRow,
  parsed: ParsedSearchQuery,
  matchClass: MatchClass,
  includeDiagnostics: boolean,
): SearchResultCandidate {
  const { snippet, matches } = buildMatchSnippet(row.snippetSource, parsed.terms);
  // PostgreSQL only selected this row via an indexed predicate (see
  // server/database.ts); the deterministic multi-signal score that decides
  // its final position comes entirely from server/ranking.ts (TKT-031),
  // including the strict/prefix/partial match-class multiplier (TKT-033).
  const { score, components } = computeSearchScore({
    blockType: row.blockType,
    content: row.snippetSource,
    terms: parsed.terms,
    phrases: parsed.phrases,
    matchClass,
  });
  return {
    documentId: row.documentId,
    documentTitle: row.documentTitle,
    blockId: row.blockId,
    sectionId: row.sectionId,
    heading: row.heading,
    headingPath: row.headingPath,
    pageNumber: row.pageNumber,
    blockType: row.blockType,
    snippet,
    matches,
    rank: score,
    matchClass,
    ...(includeDiagnostics ? { scoreComponents: { ...components, normalizedQuery: parsed.normalized } } : {}),
  };
}

function validateImport(input: ImportDocumentInput): void {
  if (!isSafeSemanticId(input.documentId)) throw new ValidationError("Invalid document id.");
  if (input.title.trim().length === 0 || input.title.length > 300) throw new ValidationError("Invalid document title.");
  if (input.originalFilename.trim().length === 0 || input.originalFilename.length > 255) throw new ValidationError("Invalid original filename.");
  if (input.originalPdf.byteLength === 0) throw new ValidationError("Original PDF is empty.");
  const semanticIds = new Set(collectSemanticIds(input.semanticDocument));
  for (const record of input.searchRecords) {
    if (record.documentId !== input.documentId) throw new ValidationError("Search record document id mismatch.");
    if (!semanticIds.has(record.blockId)) throw new ValidationError(`Search record references unknown block id: ${record.blockId}`);
    if (!ALLOWED_BLOCK_TYPES.has(record.blockType)) throw new ValidationError("Search record block type is not allowed.");
    if (record.text.length === 0 || record.text.length > MAX_RECORD_TEXT) throw new ValidationError("Search record text length is invalid.");
    if (!isSafeSemanticId(record.sectionId) || !isSafeSemanticId(record.blockId)) throw new ValidationError("Search record contains an invalid id.");
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
