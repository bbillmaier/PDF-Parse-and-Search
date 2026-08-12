BEGIN;

CREATE TABLE documents (
    id                      TEXT PRIMARY KEY,
    title                   TEXT NOT NULL,
    original_filename       TEXT NOT NULL,
    pdf_storage_path        TEXT NOT NULL,
    semantic_storage_path   TEXT NOT NULL,
    content_sha256          CHAR(64) NOT NULL,
    extractor_version       TEXT NOT NULL,
    page_count              INTEGER NOT NULL CHECK (page_count >= 0),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT documents_title_unique UNIQUE (title),
    CONSTRAINT documents_content_sha256_unique UNIQUE (content_sha256),
    CONSTRAINT documents_content_sha256_format
        CHECK (content_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE TABLE document_search_blocks (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    block_id        TEXT NOT NULL,
    section_id      TEXT NOT NULL,
    heading         TEXT NOT NULL DEFAULT '',
    heading_path    JSONB NOT NULL DEFAULT '[]'::JSONB,
    page_number     INTEGER NOT NULL CHECK (page_number > 0),
    block_type      TEXT NOT NULL,
    content         TEXT NOT NULL,
    table_header    TEXT,
    row_header      TEXT,
    search_vector   TSVECTOR GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', coalesce(heading, '')), 'A') ||
        setweight(to_tsvector('simple', coalesce(table_header, '')), 'B') ||
        setweight(to_tsvector('simple', coalesce(row_header, '')), 'B') ||
        setweight(to_tsvector('simple', coalesce(content, '')), 'C')
    ) STORED,

    CONSTRAINT document_search_blocks_identity_unique
        UNIQUE (document_id, block_id),
    CONSTRAINT document_search_blocks_heading_path_array
        CHECK (jsonb_typeof(heading_path) = 'array'),
    CONSTRAINT document_search_blocks_type
        CHECK (block_type IN (
            'heading',
            'paragraph',
            'list-item',
            'table-cell',
            'figure-caption'
        ))
);

CREATE INDEX documents_title_search_idx
    ON documents
    USING GIN (to_tsvector('simple', title));

CREATE INDEX document_search_blocks_search_idx
    ON document_search_blocks
    USING GIN (search_vector);

CREATE INDEX document_search_blocks_document_section_idx
    ON document_search_blocks (document_id, section_id);

CREATE INDEX document_search_blocks_document_page_idx
    ON document_search_blocks (document_id, page_number);

COMMIT;
