BEGIN;

-- TKT-035: compact vocabulary for bounded typo-suggestion candidate lookup
-- (docs/DESIGN.md section 21.6). Populated at indexing time by application
-- code (src/search-vocabulary.ts / server/database.ts) from document
-- titles, section headings, table/row headers, and technical identifiers
-- already recognized by src/search-technical-normalization.ts -- never full
-- document body content, so this table stays small and cheap to query
-- regardless of corpus size. It is index-only -- never displayed and never
-- itself the source of a snippet.
--
-- One row per (term, document) rather than a single global term/count row:
-- `ON DELETE CASCADE` then makes document deletion remove exactly that
-- document's contribution with no separate application-level bookkeeping,
-- and a per-document reindex (server/reindex-search-core.ts) can safely
-- delete-and-reinsert just its own rows without disturbing any other
-- document's terms. `ON CONFLICT DO NOTHING` on insert makes a re-run of
-- either path (retry after interruption, or a routine idempotent reindex)
-- safe: inserting an already-present (term, document_id) pair is a no-op.
CREATE TABLE IF NOT EXISTS search_vocabulary_terms (
    term            TEXT NOT NULL
        CHECK (term ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(term) BETWEEN 2 AND 40),
    document_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,

    CONSTRAINT search_vocabulary_terms_pkey PRIMARY KEY (term, document_id)
);

-- Supports the bounded prefix filter server/database.ts's
-- `vocabularyCandidates` applies before any edit-distance work runs
-- (`term LIKE $1` with a literal, non-wildcard-prefixed pattern) using a
-- plain built-in btree opclass -- no `pg_trgm` or other extension.
CREATE INDEX IF NOT EXISTS search_vocabulary_terms_prefix_idx
    ON search_vocabulary_terms (term text_pattern_ops);

COMMIT;
