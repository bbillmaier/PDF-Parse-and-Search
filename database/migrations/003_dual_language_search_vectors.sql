BEGIN;

-- TKT-034: dual `simple`/`english` search vectors and bounded technical
-- identifier normalization (docs/DESIGN.md section 21.4).
--
-- `technical_variants` is a plain (non-generated) column populated by
-- application code (src/search-technical-normalization.ts), never by SQL:
-- it holds a small, deterministic, bounded set of alternate spellings for
-- technical identifiers already present in the block's own heading/content/
-- table_header/row_header text (for example "A-12" also indexed as "A12"
-- and "A 12"). It is index-only -- never displayed and never the source of
-- a snippet -- and is included in the `simple` vector only, at the lowest
-- weight, so it can only ever help exact technical-vocabulary recall, never
-- outrank a real 'A'/'B'/'C'-weighted match on the block's own text.
--
-- The previous single generated `search_vector` column/index (migration
-- 001) is dropped and replaced by two generated, stored vectors so both a
-- `simple` (exact technical vocabulary, codes, acronyms, source word forms)
-- and an `english` (ordinary-language stemming) index exist side by side,
-- each with its own GIN index. This is a schema change, not a data change:
-- PostgreSQL recomputes both generated columns for every existing row from
-- data already stored in this table, so no PDF is reparsed and no row is
-- ever without a working `simple`-vector match during the migration.
-- `technical_variants` itself starts empty for existing rows (its DEFAULT)
-- and is backfilled by the repeatable `npm run db:reindex-search` command
-- (server/reindex-search.ts) after this migration applies -- see
-- database/README.md.

ALTER TABLE document_search_blocks
    ADD COLUMN IF NOT EXISTS technical_variants TEXT NOT NULL DEFAULT '';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'document_search_blocks_technical_variants_bounded'
    ) THEN
        ALTER TABLE document_search_blocks
            ADD CONSTRAINT document_search_blocks_technical_variants_bounded
                CHECK (char_length(technical_variants) <= 4000);
    END IF;
END $$;

ALTER TABLE document_search_blocks DROP COLUMN IF EXISTS search_vector;

ALTER TABLE document_search_blocks
    ADD COLUMN IF NOT EXISTS search_vector_simple TSVECTOR GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', coalesce(heading, '')), 'A') ||
        setweight(to_tsvector('simple', coalesce(table_header, '')), 'B') ||
        setweight(to_tsvector('simple', coalesce(row_header, '')), 'B') ||
        setweight(to_tsvector('simple', coalesce(content, '')), 'C') ||
        setweight(to_tsvector('simple', coalesce(technical_variants, '')), 'D')
    ) STORED;

ALTER TABLE document_search_blocks
    ADD COLUMN IF NOT EXISTS search_vector_english TSVECTOR GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(heading, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(table_header, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(row_header, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(content, '')), 'C')
    ) STORED;

CREATE INDEX IF NOT EXISTS document_search_blocks_search_simple_idx
    ON document_search_blocks
    USING GIN (search_vector_simple);

CREATE INDEX IF NOT EXISTS document_search_blocks_search_english_idx
    ON document_search_blocks
    USING GIN (search_vector_english);

COMMIT;
