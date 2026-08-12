/**
 * TKT-034/TKT-035: core reindex logic, split out from server/reindex-
 * search.ts (the CLI entry point) so it can be imported and exercised
 * directly by tests (see
 * test/integration/search-technical-vectors.integration.test.ts and
 * test/integration/search-synonyms-typos.integration.test.ts) without
 * triggering a real database connection or run as a side effect of
 * importing the module -- unlike a plain top-level script, importing this
 * file only defines functions.
 *
 * Backfills two things for documents that already existed before their
 * supporting schema/table shipped, both computed from already-stored
 * `documents`/`document_search_blocks` rows alone, never a PDF or the
 * filesystem:
 *
 * - `document_search_blocks.technical_variants` (migration 003, TKT-034),
 *   via src/search-technical-normalization.ts -- the exact same function
 *   server/database.ts uses on new imports.
 * - `search_vocabulary_terms` (migration 004, TKT-035), via
 *   src/search-vocabulary.ts -- the same compact typo-suggestion vocabulary
 *   new imports populate, replaced wholesale for the document (not merely
 *   added to) so a term no longer present in its current headings/technical
 *   identifiers does not linger from a stale prior computation.
 *
 * Safe failure behavior: each document's blocks (and vocabulary) are updated
 * inside their own transaction, so a failure or interruption mid-run can
 * never leave one document partially reindexed -- a document is either fully
 * reindexed or left exactly as it was (still fully searchable through its
 * original vectors either way; only the extra technical-variant/vocabulary
 * recall is pending). A failed document is reported and skipped, not fatal
 * to the whole run, so one bad row cannot block every other document. The
 * command is idempotent: both technical_variants and the vocabulary term set
 * are pure functions of each document's own stored text, so re-running it (to
 * retry a failure, or as a routine no-op check) recomputes identical values
 * for already-reindexed documents.
 */
import type pg from "pg";
import type { SearchableBlockType } from "../src/pdf-content-extractor/index.ts";
import { buildTechnicalVariants } from "../src/search-technical-normalization.ts";
import { buildVocabularyTerms, type VocabularySourceRecord } from "../src/search-vocabulary.ts";
import { buildSuggestionCandidates, normalizeSuggestionText, type SuggestionCandidate } from "../src/search-suggestions.ts";

interface BlockRow {
  id: string;
  heading: string;
  table_header: string | null;
  row_header: string | null;
  content: string;
  technical_variants: string;
  block_type: SearchableBlockType;
}

export interface ReindexDocumentResult {
  blocksSeen: number;
  blocksUpdated: number;
  vocabularyTermsWritten: number;
  /** TKT-037: distinct suggestion candidates (title/heading/technical)
   *  written for this document -- see src/search-suggestions.ts. */
  suggestionsWritten: number;
}

/**
 * TKT-036: the per-document reindex body, scoped to an already-open
 * transaction client rather than owning its own BEGIN/COMMIT. Shared by
 * `reindexDocument` below (the `db:reindex-search` CLI path, which owns its
 * own transaction) and by `server/lifecycle.ts`'s title-override path
 * (which runs this inside the same transaction as the title update itself,
 * so the vocabulary rebuild sees the just-updated title without a second
 * round trip). Recomputes `technical_variants` too -- harmless and
 * idempotent when nothing changed -- rather than adding a title-only
 * variant, keeping one source of truth for "rebuild this document's search
 * support from its own stored rows."
 */
export async function reindexDocumentWithClient(client: pg.PoolClient, documentId: string): Promise<ReindexDocumentResult> {
  const documentResult = await client.query<{ title: string }>("SELECT title FROM documents WHERE id = $1 FOR UPDATE", [documentId]);
  const title = documentResult.rows[0]?.title ?? "";
  const { rows } = await client.query<BlockRow>(
    `SELECT id, heading, table_header, row_header, content, technical_variants, block_type
     FROM document_search_blocks
     WHERE document_id = $1
     ORDER BY id ASC
     FOR UPDATE`,
    [documentId],
  );
  let blocksUpdated = 0;
  for (const row of rows) {
    const nextVariants = buildTechnicalVariants([row.heading, row.table_header, row.row_header, row.content]);
    if (nextVariants === row.technical_variants) continue;
    await client.query("UPDATE document_search_blocks SET technical_variants = $1 WHERE id = $2", [nextVariants, row.id]);
    blocksUpdated += 1;
  }

  const vocabularySource: VocabularySourceRecord[] = rows.map((row) => ({
    heading: row.heading,
    tableHeader: row.table_header ?? undefined,
    rowHeader: row.row_header ?? undefined,
    text: row.content,
  }));
  const vocabularyTerms = buildVocabularyTerms(title, vocabularySource);
  await client.query("DELETE FROM search_vocabulary_terms WHERE document_id = $1", [documentId]);
  if (vocabularyTerms.length > 0) {
    const values = vocabularyTerms.map((_, index) => `($${index * 2 + 1}, $${index * 2 + 2})`).join(", ");
    const params = vocabularyTerms.flatMap((term) => [term, documentId]);
    await client.query(`INSERT INTO search_vocabulary_terms (term, document_id) VALUES ${values} ON CONFLICT DO NOTHING`, params);
  }

  // TKT-037: rebuilds this document's suggestion candidates (title, heading,
  // technical identifiers) the same "replace wholesale from already-stored
  // rows" way the vocabulary rebuild above does, so a title change or a
  // heading dropped/added since the last reindex is reflected here too --
  // no separate "on title change" or "on reindex" suggestion hook, just this
  // same shared rebuild (server/lifecycle.ts's title-override path and the
  // db:reindex-search CLI both call this one function).
  const suggestionCandidates: SuggestionCandidate[] = buildSuggestionCandidates(
    title,
    rows.map((row) => ({ heading: row.heading, tableHeader: row.table_header ?? undefined, rowHeader: row.row_header ?? undefined, text: row.content, blockType: row.block_type })),
  );
  await client.query("DELETE FROM search_suggestions WHERE document_id = $1", [documentId]);
  if (suggestionCandidates.length > 0) {
    const values = suggestionCandidates.map((_, index) => `($${index * 4 + 1}, $${index * 4 + 2}, $${index * 4 + 3}, $${index * 4 + 4})`).join(", ");
    const params = suggestionCandidates.flatMap((candidate) => [documentId, candidate.type, candidate.text, normalizeSuggestionText(candidate.text)]);
    await client.query(`INSERT INTO search_suggestions (document_id, suggestion_type, text, normalized) VALUES ${values} ON CONFLICT DO NOTHING`, params);
  }

  return { blocksSeen: rows.length, blocksUpdated, vocabularyTermsWritten: vocabularyTerms.length, suggestionsWritten: suggestionCandidates.length };
}

/** Reindexes one document's blocks and vocabulary inside a single, owned
 *  transaction: either every block/vocabulary row that needs a new value
 *  gets it, or (on any error) none do. */
export async function reindexDocument(pool: pg.Pool, documentId: string): Promise<ReindexDocumentResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await reindexDocumentWithClient(client, documentId);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export interface ReindexAllResult {
  documentsTotal: number;
  documentsSucceeded: number;
  documentsFailed: number;
  blocksSeen: number;
  blocksUpdated: number;
  vocabularyTermsWritten: number;
  suggestionsWritten: number;
  durationMs: number;
  failures: { documentId: string; message: string }[];
}

/** Reindexes every document, one independent transaction each (see
 *  file-level comment for the failure-isolation contract). Never throws for
 *  a per-document failure -- failures are collected and reported in the
 *  result so the CLI entry point can set a non-zero exit code while still
 *  finishing the run. */
export async function reindexAllDocuments(pool: pg.Pool, onProgress?: (line: string) => void): Promise<ReindexAllResult> {
  const start = performance.now();
  const { rows: documents } = await pool.query<{ id: string }>("SELECT id FROM documents ORDER BY id ASC");
  onProgress?.(`Reindexing technical identifier variants and vocabulary for ${documents.length} document(s)...`);

  const result: ReindexAllResult = {
    documentsTotal: documents.length,
    documentsSucceeded: 0,
    documentsFailed: 0,
    blocksSeen: 0,
    blocksUpdated: 0,
    vocabularyTermsWritten: 0,
    suggestionsWritten: 0,
    durationMs: 0,
    failures: [],
  };

  for (const { id } of documents) {
    try {
      const documentResult = await reindexDocument(pool, id);
      result.documentsSucceeded += 1;
      result.blocksSeen += documentResult.blocksSeen;
      result.blocksUpdated += documentResult.blocksUpdated;
      result.vocabularyTermsWritten += documentResult.vocabularyTermsWritten;
      result.suggestionsWritten += documentResult.suggestionsWritten;
      if (documentResult.blocksUpdated > 0) {
        onProgress?.(
          `  ${id}: updated ${documentResult.blocksUpdated}/${documentResult.blocksSeen} block(s), ` +
            `${documentResult.vocabularyTermsWritten} vocabulary term(s), ${documentResult.suggestionsWritten} suggestion candidate(s)`,
        );
      }
    } catch (error) {
      result.documentsFailed += 1;
      const message = error instanceof Error ? error.message : String(error);
      result.failures.push({ documentId: id, message });
      onProgress?.(`  ${id}: FAILED -- ${message}`);
    }
  }

  result.durationMs = performance.now() - start;
  return result;
}
