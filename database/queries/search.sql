-- Parameters:
--   $1 = the parsed/normalized query text (server/lifecycle.ts runs raw user
--        input through parseSearchQuery in src/search-query.ts first, which
--        bounds it and rebuilds it from a fixed safe character set -- this
--        is never raw user input)
--   $2 = maximum number of candidate rows
--
-- This reference query searches document titles and semantic blocks without
-- requiring PostgreSQL extensions. The Node API owns parameter binding.
--
-- TKT-032: websearch_to_tsquery interprets $1's web-style syntax (quoted
-- phrases, OR, -excluded terms) entirely inside PostgreSQL; this file never
-- builds or concatenates tsquery syntax itself.
--
-- Ranking note (TKT-031): this query performs indexed candidate selection
-- only -- both branches filter through a GIN-backed tsvector `@@` predicate
-- (documents_title_search_idx / document_search_blocks_search_simple_idx).
-- The `rank` column below is a cheap ts_rank_cd ordering used only to decide
-- which rows survive LIMIT $2 when candidates outnumber it; it is not the
-- final display order. The deterministic multi-signal score (structural
-- weight, exact-phrase/ordered-near boosts, distinct-term coverage, length
-- normalization, and match-class multiplier) is computed from these rows by
-- the documented server module in server/ranking.ts, so no ranking weight
-- is hard-coded into SQL.
--
-- Dual vectors (TKT-034, migration 003): this reference query only shows the
-- `simple`-vector path (exact technical vocabulary, codes, acronyms, and
-- source word forms, including migration 003's bounded technical-identifier
-- variants folded into `search_vector_simple` at weight 'D'). The
-- complementary `english` pass (ordinary-language stemming) is a separate
-- query against `search_vector_english` using the same shape, run only when
-- the `simple`-vector passes are not useful enough -- see
-- PgDocumentDatabase.searchEnglish in server/database.ts. A row found only
-- through it is ranked below every `simple`-vector match, never above.
WITH search_query AS (
    SELECT websearch_to_tsquery('simple', $1) AS query
),
ranked_blocks AS (
    SELECT
        d.id AS document_id,
        d.title AS document_title,
        b.block_id,
        b.section_id,
        b.heading,
        b.heading_path,
        b.page_number,
        b.block_type,
        b.content,
        ts_rank_cd(b.search_vector_simple, q.query) AS rank
    FROM document_search_blocks AS b
    JOIN documents AS d ON d.id = b.document_id
    CROSS JOIN search_query AS q
    WHERE b.search_vector_simple @@ q.query
),
title_matches AS (
    SELECT
        d.id AS document_id,
        d.title AS document_title,
        NULL::TEXT AS block_id,
        NULL::TEXT AS section_id,
        ''::TEXT AS heading,
        '[]'::JSONB AS heading_path,
        1 AS page_number,
        'document-title'::TEXT AS block_type,
        d.title AS content,
        ts_rank_cd(to_tsvector('simple', d.title), q.query) AS rank
    FROM documents AS d
    CROSS JOIN search_query AS q
    WHERE to_tsvector('simple', d.title) @@ q.query
)
SELECT *
FROM (
    SELECT * FROM ranked_blocks
    UNION ALL
    SELECT * FROM title_matches
) AS results
ORDER BY rank DESC, document_title, page_number
LIMIT $2;
