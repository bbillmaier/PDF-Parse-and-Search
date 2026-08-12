import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import type { DocumentSearchRecord, SearchableBlockType } from "../src/pdf-content-extractor/index.ts";
import type { SearchFilters } from "../src/search-filters.ts";
import { buildTechnicalVariants } from "../src/search-technical-normalization.ts";
import { buildVocabularyTerms } from "../src/search-vocabulary.ts";
import { buildSuggestionCandidates, normalizeSuggestionText, type SuggestionCandidate, type SuggestionCandidateRow, type SuggestionType } from "../src/search-suggestions.ts";
import { reindexDocumentWithClient, type ReindexDocumentResult } from "./reindex-search-core.ts";

const { Pool } = pg;

export interface DatabaseConfig {
  connectionString: string;
}

export interface DocumentRowInput {
  id: string;
  title: string;
  originalFilename: string;
  pdfStoragePath: string;
  semanticStoragePath: string;
  assetsStoragePath: string;
  contentSha256: string;
  extractorVersion: string;
  pageCount: number;
}

export interface DocumentRow extends DocumentRowInput {
  createdAt: string;
  updatedAt: string;
}

export interface SearchResultRow {
  documentId: string;
  documentTitle: string;
  blockId: string;
  sectionId: string;
  heading: string;
  headingPath: string[];
  pageNumber: number;
  blockType: SearchableBlockType | "document-title";
  snippetSource: string;
  rank: number;
}

export class PgDocumentDatabase {
  private readonly pool: pg.Pool;

  constructor(config: DatabaseConfig) {
    this.pool = new Pool({ connectionString: config.connectionString });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async applyMigrations(migrationsDir = path.resolve("database", "migrations")): Promise<void> {
    const { readdir } = await import("node:fs/promises");
    const files = (await readdir(migrationsDir)).filter((file) => /^\d+_.*\.sql$/.test(file)).sort();
    for (const file of files) {
      const sql = await readFile(path.join(migrationsDir, file), "utf8");
      await this.pool.query(sql);
    }
  }

  async transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async insertDocument(client: pg.PoolClient, input: DocumentRowInput): Promise<void> {
    await client.query(
      `INSERT INTO documents (
        id, title, original_filename, pdf_storage_path, semantic_storage_path,
        assets_storage_path, content_sha256, extractor_version, page_count
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        input.id,
        input.title,
        input.originalFilename,
        input.pdfStoragePath,
        input.semanticStoragePath,
        input.assetsStoragePath,
        input.contentSha256,
        input.extractorVersion,
        input.pageCount,
      ],
    );
  }

  async insertSearchRecords(client: pg.PoolClient, records: DocumentSearchRecord[]): Promise<void> {
    for (const record of records) {
      // TKT-034: technical_variants is index-only, derived deterministically
      // from this same record's own text -- never from PDF bytes -- so both
      // fresh imports (here) and the reindex-only path (server/reindex-
      // search.ts, for documents imported before migration 003) compute it
      // the same way from the same inputs and agree.
      const technicalVariants = buildTechnicalVariants([record.heading, record.tableHeader, record.rowHeader, record.text]);
      await client.query(
        `INSERT INTO document_search_blocks (
          document_id, block_id, section_id, heading, heading_path, page_number,
          block_type, content, table_header, row_header, technical_variants
        ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11)`,
        [
          record.documentId,
          record.blockId,
          record.sectionId,
          record.heading,
          JSON.stringify(record.headingPath),
          record.pageNumber,
          record.blockType,
          record.text,
          record.tableHeader ?? null,
          record.rowHeader ?? null,
          technicalVariants,
        ],
      );
    }
    // TKT-035: same "derived deterministically from already-stored fields,
    // never from PDF bytes" contract as technical_variants above -- see
    // src/search-vocabulary.ts. Both a fresh import (here) and a later
    // reindex (server/reindex-search-core.ts, for documents imported before
    // migration 004) compute this from the same inputs and agree.
    if (records.length > 0) {
      await this.insertVocabularyTerms(client, records[0].documentId, buildVocabularyTerms(records[0].documentTitle, records));
      // TKT-037: same "derived deterministically from already-stored fields,
      // never from PDF bytes" contract as technical_variants/vocabulary
      // above -- see src/search-suggestions.ts.
      await this.insertSuggestionCandidates(client, records[0].documentId, buildSuggestionCandidates(records[0].documentTitle, records));
    }
  }

  /** TKT-035: idempotent -- `ON CONFLICT DO NOTHING` means re-inserting an
   *  already-present (term, document) pair (a retried import, or a reindex
   *  that recomputes the same terms) is a no-op, never a duplicate-key error. */
  async insertVocabularyTerms(client: pg.PoolClient, documentId: string, terms: readonly string[]): Promise<void> {
    if (terms.length === 0) return;
    const values = terms.map((_, index) => `($${index * 2 + 1}, $${index * 2 + 2})`).join(", ");
    const params = terms.flatMap((term) => [term, documentId]);
    await client.query(`INSERT INTO search_vocabulary_terms (term, document_id) VALUES ${values} ON CONFLICT DO NOTHING`, params);
  }

  /** TKT-035: replaces one document's vocabulary contribution atomically
   *  (used by the reindex path, where the full term set for a document is
   *  recomputed from stored data and should exactly replace what is there,
   *  not merely add to it -- a term dropped from a document's own headings
   *  since it was last indexed must not linger). Must run inside the
   *  caller's own transaction so a failure leaves the previous rows intact
   *  rather than deleting without replacing. */
  async replaceVocabularyTerms(client: pg.PoolClient, documentId: string, terms: readonly string[]): Promise<void> {
    await client.query("DELETE FROM search_vocabulary_terms WHERE document_id = $1", [documentId]);
    await this.insertVocabularyTerms(client, documentId, terms);
  }

  /**
   * TKT-035: bounded candidate lookup for typo suggestions -- length and
   * prefix filtering happen here, in SQL, before server/lifecycle.ts ever
   * computes an edit distance (src/search-typo.ts). `prefix` is always a
   * literal string built from a already-validated query term (never
   * concatenated into the query text), and the built-in `text_pattern_ops`
   * index (migration 004) makes the `LIKE` prefix predicate indexed without
   * `pg_trgm` or any other extension.
   */
  async vocabularyCandidates(prefix: string, minLength: number, maxLength: number, limit: number): Promise<string[]> {
    const result = await this.pool.query(
      `SELECT DISTINCT term FROM search_vocabulary_terms
       WHERE term LIKE $1 AND char_length(term) BETWEEN $2 AND $3
       LIMIT $4`,
      [`${prefix}%`, minLength, maxLength, limit],
    );
    return result.rows.map((row) => row.term as string);
  }

  /** TKT-035: true when `term` is already a known vocabulary word -- used to
   *  decide a term is not a typo (it already exists somewhere in the
   *  indexed title/heading/technical vocabulary) before spending an
   *  edit-distance pass on it. */
  async vocabularyHasTerm(term: string): Promise<boolean> {
    const result = await this.pool.query("SELECT 1 FROM search_vocabulary_terms WHERE term = $1 LIMIT 1", [term]);
    return (result.rowCount ?? 0) > 0;
  }

  /** TKT-035: reporting/benchmark helper -- the distinct term count, not the
   *  (term, document) row count, since the same term contributed by many
   *  documents is one vocabulary entry for candidate-lookup purposes. */
  async vocabularySize(): Promise<number> {
    const result = await this.pool.query("SELECT count(DISTINCT term)::int AS count FROM search_vocabulary_terms");
    return result.rows[0].count as number;
  }

  /** TKT-035: reporting/benchmark helper -- on-disk size (table + its
   *  indexes) of the vocabulary support added by migration 004, in bytes. */
  async vocabularyStorageBytes(): Promise<number> {
    const result = await this.pool.query("SELECT pg_total_relation_size('search_vocabulary_terms')::bigint AS bytes");
    return Number(result.rows[0].bytes);
  }

  /** TKT-037: idempotent -- `ON CONFLICT DO NOTHING` means re-inserting an
   *  already-present (document, type, normalized text) row (a retried
   *  import, or a reindex that recomputes the same candidates) is a no-op,
   *  never a duplicate-key error. Mirrors `insertVocabularyTerms`. */
  async insertSuggestionCandidates(client: pg.PoolClient, documentId: string, candidates: readonly SuggestionCandidate[]): Promise<void> {
    if (candidates.length === 0) return;
    const values = candidates.map((_, index) => `($${index * 4 + 1}, $${index * 4 + 2}, $${index * 4 + 3}, $${index * 4 + 4})`).join(", ");
    const params = candidates.flatMap((candidate) => [documentId, candidate.type, candidate.text, normalizeSuggestionText(candidate.text)]);
    await client.query(
      `INSERT INTO search_suggestions (document_id, suggestion_type, text, normalized) VALUES ${values} ON CONFLICT DO NOTHING`,
      params,
    );
  }

  /** TKT-037: replaces one document's suggestion contribution atomically --
   *  used by the reindex path and the title-override path, where the full
   *  candidate set for a document is recomputed from stored data and should
   *  exactly replace what is there, not merely add to it. Mirrors
   *  `replaceVocabularyTerms`. */
  async replaceSuggestionCandidates(client: pg.PoolClient, documentId: string, candidates: readonly SuggestionCandidate[]): Promise<void> {
    await client.query("DELETE FROM search_suggestions WHERE document_id = $1", [documentId]);
    await this.insertSuggestionCandidates(client, documentId, candidates);
  }

  /**
   * TKT-037: bounded indexed prefix lookup for autocomplete -- `likePattern`
   * is always an already-validated, already-escaped literal pattern built by
   * `parseSuggestionPrefix` (src/search-suggestions.ts), never raw user text
   * concatenated into SQL. The built-in `text_pattern_ops` index (migration
   * 005) makes the `LIKE` prefix predicate indexed without `pg_trgm` or any
   * other extension -- this never scans `document_search_blocks` or any
   * document body content. Type ordering (title, then heading, then
   * technical) is applied here so exact-prefix title/heading candidates sort
   * ahead of technical-term candidates before `src/search-suggestions.ts`'s
   * `rankAndDedupeSuggestions` does its final cross-document dedup.
   */
  async suggest(likePattern: string, limit: number): Promise<SuggestionCandidateRow[]> {
    const result = await this.pool.query(
      `SELECT document_id, suggestion_type, text
       FROM search_suggestions
       WHERE normalized LIKE $1 ESCAPE '\\'
       ORDER BY CASE suggestion_type WHEN 'title' THEN 0 WHEN 'heading' THEN 1 ELSE 2 END,
                char_length(normalized) ASC, normalized ASC
       LIMIT $2`,
      [likePattern, limit],
    );
    return result.rows.map((row) => ({
      documentId: row.document_id as string,
      type: row.suggestion_type as SuggestionType,
      text: row.text as string,
    }));
  }

  /** TKT-037: same EXPLAIN shape as `explainSearch`, confirming the
   *  suggestion prefix lookup also uses its own btree index rather than a
   *  sequential scan. */
  async explainSuggest(likePattern: string): Promise<string[]> {
    const client = await this.pool.connect();
    try {
      await client.query("SET enable_seqscan = off");
      const result = await client.query(`EXPLAIN SELECT id FROM search_suggestions WHERE normalized LIKE $1 ESCAPE '\\'`, [likePattern]);
      return result.rows.map((row) => row["QUERY PLAN"] as string);
    } finally {
      await client.query("RESET enable_seqscan");
      client.release();
    }
  }

  /** TKT-037: reporting/benchmark helper -- total suggestion candidate row
   *  count across every document. */
  async suggestionsSize(): Promise<number> {
    const result = await this.pool.query("SELECT count(*)::int AS count FROM search_suggestions");
    return result.rows[0].count as number;
  }

  /** TKT-037: reporting/benchmark helper -- on-disk size (table + its
   *  index) of the suggestion support added by migration 005, in bytes. */
  async suggestionsStorageBytes(): Promise<number> {
    const result = await this.pool.query("SELECT pg_total_relation_size('search_suggestions')::bigint AS bytes");
    return Number(result.rows[0].bytes);
  }

  /** TKT-037: reporting/benchmark helper -- total on-disk size of the
   *  connected database, in bytes (docs/DESIGN.md 21.8). */
  async databaseSizeBytes(): Promise<number> {
    const result = await this.pool.query("SELECT pg_database_size(current_database())::bigint AS bytes");
    return Number(result.rows[0].bytes);
  }

  /** TKT-037: reporting/benchmark helper -- on-disk size of every search-
   *  relevant index, by name, in bytes (docs/DESIGN.md 21.8: "Record
   *  database size, index sizes, vocabulary size, candidate limits"). */
  async searchIndexSizeBytes(): Promise<Record<string, number>> {
    const result = await this.pool.query<{ indexname: string; bytes: string }>(
      `SELECT indexname, pg_relation_size(indexname::regclass)::bigint AS bytes
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename IN ('documents', 'document_search_blocks', 'search_vocabulary_terms', 'search_suggestions')`,
    );
    return Object.fromEntries(result.rows.map((row) => [row.indexname, Number(row.bytes)]));
  }

  async listDocuments(): Promise<DocumentRow[]> {
    const result = await this.pool.query(
      `SELECT id, title, original_filename, pdf_storage_path, semantic_storage_path,
              assets_storage_path, content_sha256, extractor_version, page_count,
              created_at, updated_at
       FROM documents
       ORDER BY created_at DESC, id ASC`,
    );
    return result.rows.map(rowToDocument);
  }

  async getDocument(id: string): Promise<DocumentRow | undefined> {
    const result = await this.pool.query(
      `SELECT id, title, original_filename, pdf_storage_path, semantic_storage_path,
              assets_storage_path, content_sha256, extractor_version, page_count,
              created_at, updated_at
       FROM documents
       WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? rowToDocument(result.rows[0]) : undefined;
  }

  async deleteDocument(id: string): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM documents WHERE id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  }

  /** TKT-036: updates a document's display title in place -- the same
   *  `documents_title_unique` constraint enforced on import (migration 001)
   *  applies here too, so a conflicting title raises the same `23505` unique
   *  violation server/lifecycle.ts already maps to a 409 conflict for
   *  imports. Returns `false` (rather than throwing) when `id` does not
   *  match any row, so the caller can distinguish "not found" from "title
   *  conflict." Must run inside the caller's own transaction so the title
   *  change and the vocabulary rebuild below commit or roll back together. */
  async updateDocumentTitle(client: pg.PoolClient, documentId: string, title: string): Promise<boolean> {
    const result = await client.query("UPDATE documents SET title = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [title, documentId]);
    return (result.rowCount ?? 0) > 0;
  }

  /** TKT-036: rebuilds one document's `technical_variants` and
   *  `search_vocabulary_terms` from already-stored rows -- the exact same
   *  logic the `db:reindex-search` CLI uses (server/reindex-search-core.ts),
   *  reused here so a title override's vocabulary rebuild and a routine
   *  reindex can never disagree. Must run in the same transaction as
   *  `updateDocumentTitle` so the vocabulary rebuild reads the just-updated
   *  title (`FOR UPDATE` inside `reindexDocumentWithClient` sees it via the
   *  same client/transaction, not a separate connection). Never touches the
   *  filesystem or reparses a PDF. */
  async reindexDocumentVocabulary(client: pg.PoolClient, documentId: string): Promise<ReindexDocumentResult> {
    return reindexDocumentWithClient(client, documentId);
  }

  async search(query: string, limit: number, filters?: SearchFilters): Promise<SearchResultRow[]> {
    // `query` is never raw user input: server/lifecycle.ts runs it through
    // parseSearchQuery (src/search-query.ts) first, which bounds it and
    // rebuilds it from a fixed safe character set. websearch_to_tsquery
    // parses that text's quotes/OR/- syntax into a tsquery entirely inside
    // PostgreSQL -- this code never builds or concatenates tsquery syntax.
    // TKT-037: `filters` is likewise never raw user input by the time it
    // reaches here -- server/lifecycle.ts runs it through
    // parseSearchFilters (src/search-filters.ts) first.
    return this.runFullTextSearch("websearch_to_tsquery", query, limit, filters);
  }

  /**
   * TKT-034: the complementary `english` vector pass (docs/DESIGN.md section
   * 21.4). Same safe-input contract as `search` -- `query` is always
   * server/lifecycle.ts's already-parsed, bounded, safe-character-set
   * `parsed.query.normalized` text, run through `websearch_to_tsquery`, this
   * time against the `english`-configured `search_vector_english` column so
   * PostgreSQL's English stemmer can relate word forms (e.g. "inspected" /
   * "inspection") the exact-vocabulary `simple` vector never would. Only
   * document_search_blocks rows are searched here, not titles -- title
   * matching stays on the exact `simple` vector (see documents_title_search_idx),
   * since titles are short identifiers/names, not stemmable prose.
   */
  async searchEnglish(query: string, limit: number, filters?: SearchFilters): Promise<SearchResultRow[]> {
    const { clause, params: filterParams } = buildFilterClause(filters, 3);
    const result = await this.pool.query(
      `SELECT * FROM (
         SELECT d.id AS document_id, d.title AS document_title, b.block_id, b.section_id,
                b.heading, b.heading_path, b.page_number, b.block_type,
                b.content AS snippet_source,
                ts_rank_cd(b.search_vector_english, websearch_to_tsquery('english', $1)) AS rank
         FROM document_search_blocks b
         JOIN documents d ON d.id = b.document_id
         WHERE b.search_vector_english @@ websearch_to_tsquery('english', $1)
       ) results
       WHERE true${clause}
       ORDER BY rank DESC, document_title ASC, page_number ASC, block_id ASC
       LIMIT $2`,
      [query, limit, ...filterParams],
    );
    return result.rows.map(rowToSearchResult);
  }

  /**
   * TKT-033: runs the same indexed candidate selection as `search`, but
   * against a `tsquery` expression built by src/search-query.ts's
   * `buildPrefixTsQuery`/`buildPartialFallbackTsQuery` (final-term prefix
   * matching and bounded partial-term fallback). `tsQuery` is still never
   * raw user input -- it is PostgreSQL `tsquery` syntax assembled entirely
   * from already-validated, server-tokenized words -- and it still only
   * ever reaches the database as one bound parameter to `to_tsquery`, which
   * parses it, never as concatenated SQL.
   */
  async searchByTsQuery(tsQuery: string, limit: number, filters?: SearchFilters): Promise<SearchResultRow[]> {
    return this.runFullTextSearch("to_tsquery", tsQuery, limit, filters);
  }

  /**
   * Shared indexed candidate selection for both the strict and TKT-033
   * broadening passes: every branch filters through a GIN-backed tsvector
   * `@@` predicate (document_search_blocks_search_simple_idx /
   * documents_title_search_idx -- TKT-034 split the former single
   * `document_search_blocks_search_idx` into a `simple`- and an
   * `english`-configured vector/index pair; this method only ever queries
   * the `simple` one, matching its pre-TKT-034 behavior exactly).  `rank`
   * below is a cheap ts_rank_cd ordering used only to pick which rows
   * survive the LIMIT when candidates outnumber it; it is not the final
   * ranking. The deterministic multi-signal score that decides display
   * order (including the strict/prefix/stemmed/partial match-class
   * multiplier) is computed from these rows in server/ranking.ts, so no
   * ranking weight is hard-coded here.
   *
   * `tsQueryFn` is never derived from a request -- it is always one of the
   * two literal strings below, chosen by the caller's own code path -- so
   * interpolating it into the SQL text carries no injection risk; `$1` (the
   * text handed to that function) remains the only bound, untrusted-shaped
   * input.
   */
  private async runFullTextSearch(
    tsQueryFn: "websearch_to_tsquery" | "to_tsquery",
    queryText: string,
    limit: number,
    filters?: SearchFilters,
  ): Promise<SearchResultRow[]> {
    // TKT-037: filters are applied in the outer WHERE, against the same
    // output column names (document_id/page_number/section_id/block_type)
    // both branches of the UNION ALL already expose -- Postgres inlines a
    // non-recursive CTE referenced once (both `ranked_blocks` and
    // `title_matches` are), so these predicates push down to the underlying
    // `b.*`/`d.*` columns and can still use
    // document_search_blocks_document_section_idx /
    // document_search_blocks_document_page_idx alongside the GIN predicate
    // that already selects candidates -- filtering never replaces indexed
    // candidate selection with a sequential scan.
    const { clause, params: filterParams } = buildFilterClause(filters, 3);
    const result = await this.pool.query(
      `WITH q AS (SELECT ${tsQueryFn}('simple', $1) AS query),
       ranked_blocks AS (
         SELECT d.id AS document_id, d.title AS document_title, b.block_id, b.section_id,
                b.heading, b.heading_path, b.page_number, b.block_type,
                b.content AS snippet_source,
                ts_rank_cd(b.search_vector_simple, q.query) AS rank
         FROM document_search_blocks b
         JOIN documents d ON d.id = b.document_id
         CROSS JOIN q
         WHERE b.search_vector_simple @@ q.query
       ),
       title_matches AS (
         SELECT d.id AS document_id, d.title AS document_title, d.id AS block_id, d.id AS section_id,
                d.title AS heading, '[]'::jsonb AS heading_path, 1 AS page_number,
                'document-title'::text AS block_type, d.title AS snippet_source,
                ts_rank_cd(to_tsvector('simple', d.title), q.query) AS rank
         FROM documents d
         CROSS JOIN q
         WHERE to_tsvector('simple', d.title) @@ q.query
       )
       SELECT *
       FROM (
         SELECT * FROM ranked_blocks
         UNION ALL
         SELECT * FROM title_matches
       ) results
       WHERE true${clause}
       ORDER BY rank DESC, document_title ASC, page_number ASC, block_id ASC
       LIMIT $2`,
      [queryText, limit, ...filterParams],
    );
    return result.rows.map(rowToSearchResult);
  }

  async explainSearch(query: string, filters?: SearchFilters): Promise<string[]> {
    return this.runExplain("search_vector_simple", "websearch_to_tsquery", "simple", query, filters);
  }

  /** TKT-033: same EXPLAIN shape as `explainSearch`, for a prefix or
   *  partial-fallback `tsquery` expression, so tests can confirm those
   *  passes also use the GIN index rather than a sequential scan. */
  async explainSearchByTsQuery(tsQuery: string, filters?: SearchFilters): Promise<string[]> {
    return this.runExplain("search_vector_simple", "to_tsquery", "simple", tsQuery, filters);
  }

  /** TKT-034: same EXPLAIN shape as `explainSearch`, against the
   *  `english`-configured vector/index, so tests can confirm the
   *  complementary stemmed pass also uses its own GIN index. */
  async explainSearchEnglish(query: string, filters?: SearchFilters): Promise<string[]> {
    return this.runExplain("search_vector_english", "websearch_to_tsquery", "english", query, filters);
  }

  private async runExplain(
    column: "search_vector_simple" | "search_vector_english",
    tsQueryFn: "websearch_to_tsquery" | "to_tsquery",
    config: "simple" | "english",
    queryText: string,
    filters?: SearchFilters,
  ): Promise<string[]> {
    const client = await this.pool.connect();
    try {
      await client.query("SET enable_seqscan = off");
      // TKT-037: same filter predicate `runFullTextSearch` applies, here
      // referenced unqualified since `document_search_blocks` is the only
      // table in this EXPLAIN query and already has document_id/page_number/
      // section_id/block_type columns of those exact names.
      const { clause, params: filterParams } = buildFilterClause(filters, 2);
      const result = await client.query(
        `EXPLAIN SELECT b.id
         FROM document_search_blocks b
         WHERE b.${column} @@ ${tsQueryFn}('${config}', $1)${clause}`,
        [queryText, ...filterParams],
      );
      return result.rows.map((row) => row["QUERY PLAN"] as string);
    } finally {
      await client.query("RESET enable_seqscan");
      client.release();
    }
  }
}

/**
 * TKT-037: builds a safe, always-present filter predicate fragment (six
 * fixed `AND ($n::type IS NULL OR column = $n)` clauses starting at
 * `paramOffset`, one per filter field, in a fixed order) plus its six bound
 * parameters (`null` for any field the caller's filters do not set).
 * Producing the identical SQL text regardless of which filters are actually
 * active (only the parameter values differ) keeps every query strategy's
 * prepared-statement shape stable and lets an unfiltered call short-circuit
 * every clause via its own `IS NULL` branch rather than needing a separate
 * unfiltered code path. `filters` is always the already-validated output of
 * `parseSearchFilters` (src/search-filters.ts) by the time it reaches here
 * -- this function only assembles parameterized SQL, it never validates.
 */
function buildFilterClause(filters: SearchFilters | undefined, paramOffset: number): { clause: string; params: unknown[] } {
  const documentId = filters?.documentId ?? null;
  const page = filters?.page ?? null;
  const pageStart = filters?.pageRange?.start ?? null;
  const pageEnd = filters?.pageRange?.end ?? null;
  const sectionId = filters?.sectionId ?? null;
  const blockType = filters?.blockType ?? null;
  const p = (index: number): string => `$${paramOffset + index}`;
  const clause = `
    AND (${p(0)}::text IS NULL OR document_id = ${p(0)})
    AND (${p(1)}::int IS NULL OR page_number = ${p(1)})
    AND (${p(2)}::int IS NULL OR page_number >= ${p(2)})
    AND (${p(3)}::int IS NULL OR page_number <= ${p(3)})
    AND (${p(4)}::text IS NULL OR section_id = ${p(4)})
    AND (${p(5)}::text IS NULL OR block_type = ${p(5)})`;
  return { clause, params: [documentId, page, pageStart, pageEnd, sectionId, blockType] };
}

function rowToSearchResult(row: Record<string, unknown>): SearchResultRow {
  return {
    documentId: row.document_id as string,
    documentTitle: row.document_title as string,
    blockId: row.block_id as string,
    sectionId: row.section_id as string,
    heading: row.heading as string,
    headingPath: Array.isArray(row.heading_path) ? (row.heading_path as string[]) : [],
    pageNumber: row.page_number as number,
    blockType: row.block_type as SearchResultRow["blockType"],
    snippetSource: row.snippet_source as string,
    rank: Number(row.rank),
  };
}

function rowToDocument(row: Record<string, unknown>): DocumentRow {
  return {
    id: row.id as string,
    title: row.title as string,
    originalFilename: row.original_filename as string,
    pdfStoragePath: row.pdf_storage_path as string,
    semanticStoragePath: row.semantic_storage_path as string,
    assetsStoragePath: row.assets_storage_path as string,
    contentSha256: row.content_sha256 as string,
    extractorVersion: row.extractor_version as string,
    pageCount: row.page_count as number,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
