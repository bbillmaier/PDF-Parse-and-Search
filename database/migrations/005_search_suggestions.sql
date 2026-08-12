BEGIN;

-- TKT-037: bounded indexed prefix suggestions (docs/DESIGN.md section 21.7).
--
-- Autocomplete is limited to three sources -- document display titles,
-- section headings, and high-value technical identifiers -- and must never
-- scan full document body content on each keystroke. This table holds one
-- row per (document, suggestion type, normalized text) triple, populated by
-- application code (src/search-suggestions.ts / server/database.ts) at
-- import time and rebuilt by the same repeatable reindex step migration 004
-- already added for the typo-suggestion vocabulary
-- (server/reindex-search-core.ts) -- never derived from a PDF or the
-- filesystem, and never itself a display or ranking artifact for ordinary
-- search results.
--
-- `text` is the original display string (plain text -- the host/reference UI
-- owns escaping); `normalized` is the lowercased, whitespace-collapsed form
-- used for prefix matching and deduplication, mirroring the
-- store-both-forms approach `document_search_blocks.technical_variants`
-- already established for index-only text. One row per (term, document)
-- rather than a single global row lets `ON DELETE CASCADE` remove exactly
-- one document's contribution with no separate application-level
-- bookkeeping, and lets a per-document reindex safely delete-and-reinsert
-- just its own rows (`ON CONFLICT DO NOTHING` makes a retried insert or a
-- routine idempotent reindex a no-op), exactly like migration 004's
-- `search_vocabulary_terms`.
CREATE TABLE IF NOT EXISTS search_suggestions (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_id         TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    suggestion_type     TEXT NOT NULL
        CHECK (suggestion_type IN ('title', 'heading', 'technical')),
    text                TEXT NOT NULL
        CHECK (char_length(text) BETWEEN 1 AND 200),
    normalized          TEXT NOT NULL
        CHECK (normalized = lower(normalized) AND char_length(normalized) BETWEEN 1 AND 200),

    CONSTRAINT search_suggestions_unique
        UNIQUE (document_id, suggestion_type, normalized)
);

-- Supports the bounded prefix filter server/database.ts's `suggest` query
-- applies (`normalized LIKE $1 ESCAPE '\'` with a literal, non-wildcard-
-- prefixed pattern) using a plain built-in btree opclass -- no `pg_trgm` or
-- other extension, the same approach migration 004 uses for
-- `search_vocabulary_terms`.
CREATE INDEX IF NOT EXISTS search_suggestions_prefix_idx
    ON search_suggestions (normalized text_pattern_ops);

COMMIT;
