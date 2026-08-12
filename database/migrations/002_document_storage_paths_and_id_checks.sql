BEGIN;

ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS assets_storage_path TEXT NOT NULL DEFAULT '';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_id_safe') THEN
        ALTER TABLE documents
            ADD CONSTRAINT documents_id_safe
                CHECK (id ~ '^[a-z][a-z0-9-]{0,127}$');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_search_blocks_block_id_safe') THEN
        ALTER TABLE document_search_blocks
            ADD CONSTRAINT document_search_blocks_block_id_safe
                CHECK (block_id ~ '^[a-z][a-z0-9-]{0,127}$');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_search_blocks_section_id_safe') THEN
        ALTER TABLE document_search_blocks
            ADD CONSTRAINT document_search_blocks_section_id_safe
                CHECK (section_id ~ '^[a-z][a-z0-9-]{0,127}$');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_search_blocks_content_bounded') THEN
        ALTER TABLE document_search_blocks
            ADD CONSTRAINT document_search_blocks_content_bounded
                CHECK (char_length(content) <= 20000);
    END IF;
END $$;

COMMIT;
