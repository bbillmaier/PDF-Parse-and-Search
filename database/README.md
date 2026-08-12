# Local PostgreSQL development database

This directory contains the database setup for testing document persistence
and full-text search locally. It is intentionally outside
`src/pdf-content-extractor/`; the portable PDF library has no database or
third-party runtime dependency.

## Prerequisite

Install Docker Desktop (with Docker Compose), then make sure Docker Desktop is
running. Alternatively, run PostgreSQL 17 yourself and apply the SQL migration
in `migrations/` manually.

## Start the database

The checked-in development defaults are safe only for local use:

```powershell
npm run db:up
npm run db:status
```

PostgreSQL is exposed at `localhost:54329` by default:

```text
postgresql://pdf_to_html:pdf_to_html_dev@localhost:54329/pdf_to_html
```

Copy `.env.example` to `.env` if the port or local credentials need to change.
Do not reuse these credentials outside local development.

The first startup applies every SQL file in `database/migrations/` in filename
order. The database data persists in the named Docker volume
`pdf-to-html-postgres-data` across normal container restarts.

## Inspect the schema

```powershell
npm run db:shell
```

Useful commands inside `psql`:

```text
\dt
\d documents
\d document_search_blocks
\q
```

## Apply migrations to an existing volume

Docker applies `database/migrations/*.sql` automatically only when the
PostgreSQL data volume is first created. For an existing local volume or an
application-owned migration step, run:

```powershell
npm run db:migrate
```

The runner records filenames in `schema_migrations`. If the baseline
`documents` table already exists from migration `001`, it marks `001` applied
and then applies later migrations in filename order. It does not embed
credentials; use `DATABASE_URL` to point at another database.

Run a repeatable smoke test with:

```powershell
npm run db:smoke
```

The smoke test inserts one temporary document and search block, verifies a
`simple` full-text query and a bounded technical-identifier variant match,
checks both GIN search-vector plans (`simple` and `english`), verifies an
`english` stemmed query, confirms the imported block's heading word populated
the typo-suggestion vocabulary and is queryable by bounded prefix, and
deletes the temporary row (confirming its vocabulary contribution cascades
away with it).

## Dual search vectors and technical identifier normalization (TKT-034)

Migration `003_dual_language_search_vectors.sql` replaces the single
generated `search_vector` column/index from migration `001` with two:

- `search_vector_simple` (GIN index `document_search_blocks_search_simple_idx`):
  exact technical vocabulary, codes, acronyms, and source word forms. This is
  the vector every strict, prefix, and partial-fallback query
  (`server/database.ts`) runs against, and it is always the strongest lexical
  match class -- see `MATCH_CLASS_TIER` in `src/document-library.ts`.
- `search_vector_english` (GIN index `document_search_blocks_search_english_idx`):
  ordinary-language stemming (PostgreSQL's `english` configuration), so
  `inspect`/`inspected`/`inspection` are related where `simple` never would
  relate them. This is a complementary path only: `server/lifecycle.ts` only
  queries it once the `simple` vector's strict and prefix passes together are
  not useful enough, and a result found only this way is tagged match class
  `stemmed`, which can never outrank a `direct` or `prefix` (`simple`-vector)
  match, whatever its raw score.

The migration also adds `document_search_blocks.technical_variants`, a plain
text column (not generated) populated by
`src/search-technical-normalization.ts`. At indexing time it scans a block's
own heading/table header/row header/content for identifier-shaped substrings
(for example `A-12`) and adds the *other* canonical spellings (`A12`, `A 12`)
as bounded, deterministic index-only text -- capped at
`MAX_TECHNICAL_IDENTIFIERS_PER_RECORD` distinct identifiers per record and
exactly 3 fixed forms per identifier, never a combinatorial expansion. It is
folded into `search_vector_simple` at the lowest weight (`'D'`), so it can
only ever add exact-vocabulary recall, never outrank a real match on the
block's own displayed text. The original `content`/`heading` text is never
changed, and snippets are always built from that original text
(`server/lifecycle.ts`'s `buildMatchSnippet`), never from
`technical_variants`.

### Reindexing existing documents

Documents imported before migration `003` have `technical_variants = ''`
(the column default) until reindexed -- their `simple`/`english` vector
search still works immediately (the migration recomputes both generated
vectors for every existing row from data already in the table), they are
just missing the extra technical-identifier variant recall until backfilled.
Run the repeatable, idempotent reindex command:

```powershell
npm run db:reindex-search
```

This reads only already-stored `document_search_blocks` rows (never a PDF or
the filesystem) and recomputes `technical_variants` with the same
deterministic function new imports use. Each document's blocks update inside
one transaction, so an interruption or a failure on one document can never
leave it partially reindexed, and never blocks reindexing the rest -- failed
documents are reported with a non-zero exit code and the command is safe to
re-run (already-reindexed rows recompute to the same value, a no-op).

Main-app port note: this reindex step, and the underlying dual-vector schema
change, must be carried over by the host application's own migration
framework -- see
`docs/MAIN_APP_AI_AGENT_INTEGRATION_GUIDE.md`.

## Bounded domain synonyms and typo suggestions (TKT-035)

Migration `004_search_vocabulary.sql` adds `search_vocabulary_terms`, a
`(term, document_id)` table (primary key on the pair) with a plain built-in
btree index using the `text_pattern_ops` opclass (`search_vocabulary_terms_prefix_idx`)
for indexed `LIKE 'prefix%'` candidate lookups -- no `pg_trgm` or other
extension. `ON DELETE CASCADE` from `documents` means deleting a document
removes its vocabulary contribution automatically, with no separate
application-level bookkeeping.

**Domain synonyms** are a small, versioned, hand-maintained list
(`src/search-synonyms.ts`'s `DOMAIN_SYNONYM_RULES`), each rule a directional
`from -> to[]` pair (e.g. `flu -> influenza`, and an explicit `mask <->
respirator` pair to show direction is a configuration choice, not a
limitation). `server/lifecycle.ts` only runs the synonym-expansion stage once
direct/prefix/stemmed results together are not useful enough, tags any row
only reachable this way with match class `synonym`, and reports development
diagnostics (which terms were widened to what) plus a `strategy: "synonym"`
response field the UI can always show. A `synonym` match can never outrank a
`direct`, `prefix`, or `stemmed` match -- see `MATCH_CLASS_TIER` in
`src/document-library.ts`.

**Typo suggestions** come from a compact vocabulary built only from document
titles, section headings, table/row headers, and technical identifiers
(`src/search-vocabulary.ts`) -- never ordinary paragraph/list/caption body
text, so it stays small regardless of corpus size. It is populated at import
time (`server/database.ts`'s `insertSearchRecords`) and rebuilt (replaced,
not merely appended to) per document by the reindex command below. When
normal search is still empty or weak after every other stage,
`server/lifecycle.ts` tries to substitute a close vocabulary word (bounded
edit distance, candidates pre-filtered by length and prefix in SQL before any
distance is computed -- see `src/search-typo.ts`) for up to
`MAX_TERMS_CORRECTED_PER_QUERY` plain query terms, never a word already
known (not a typo) or inside a quoted phrase or exclusion, and re-runs an
ordinary strict search on the substituted query. A result found only this way
is tagged match class `corrected` -- the loosest class, ranked below
`synonym` and every stricter class -- and the substituted query text and
original/corrected term pairs are always exposed in the response (like
`strategy`, not diagnostics-gated), so the UI can label it.

### Reindexing vocabulary for existing documents

`npm run db:reindex-search` now backfills both `technical_variants` (TKT-034)
and `search_vocabulary_terms` (TKT-035) for documents imported before their
respective schema changes existed, reading only already-stored
`documents`/`document_search_blocks` rows -- never a PDF or the filesystem.
Each document's technical-variant and vocabulary updates share one
transaction, so an interruption can never leave a document with one updated
and not the other, and the command remains safe to re-run (idempotent: an
unchanged document's reindex recomputes to the same values, an explicit
delete-then-reinsert of its vocabulary rows that ends up identical).

## Stop the database

```powershell
npm run db:down
```

This stops and removes the container but preserves its data volume. Deleting
the volume is intentionally not wrapped in an npm command because it destroys
all local database contents.

## Migrations after initial startup

PostgreSQL's container initialization directory runs only when its data volume
is first created. New migrations must therefore also be applied by the future
Node application's migration runner. The SQL files here are the schema
authority for this test project, not a replacement for the main application's
existing migration conventions.

## Filesystem document storage

Runtime documents belong under `storage/documents/{documentId}/`:

```text
original.pdf
semantic-document.json
assets/
```

The directory contents are ignored by Git because they may contain workplace
documents. Only `.gitkeep` is committed. PostgreSQL stores paths and searchable
blocks; it does not store the PDF or semantic JSON bytes.

Deleting a row from `documents` cascades to `document_search_blocks`, but the
Node application is responsible for deleting the matching filesystem folder.

## Local browser origin

The reference Node API permits `http://localhost:5173` by default for local
React development. Override it with a comma-separated exact-origin list when
the frontend uses another port:

```powershell
$env:CORS_ALLOWED_ORIGINS="http://localhost:5173,http://127.0.0.1:5173"
npm run server
```

Do not use a wildcard origin when the API is integrated with authenticated
application routes.

## Local document API

Host-side code lives in `server/`, not in the portable extractor folder. Start
the reference API with:

```powershell
npm run server
```

The server uses `DATABASE_URL` and `DOCUMENT_STORAGE_ROOT` when provided,
defaulting locally to port `54329` and `storage/documents/`.

Endpoints:

- `POST /api/documents/import` accepts bounded JSON containing `documentId`,
  title, original filename, base64 PDF bytes, semantic document JSON, base64
  assets, and portable search records.
- `GET /api/documents` lists database metadata and storage paths.
- `GET /api/documents/{documentId}` loads metadata plus the stored semantic
  document, PDF bytes, and assets.
- `DELETE /api/documents/{documentId}` deletes the database row and then the
  storage folder; partial filesystem failures are reported for retry.
- `GET /api/search?q=...&limit=...` runs bounded parameterized PostgreSQL
  full-text search and returns document, heading path, page, block, rank, and
  plain snippet source text.

Duplicate title or SHA-256 imports return conflict behavior in the lifecycle
layer. Replacement remains explicitly delete-then-reupload; imports never
silently overwrite existing documents.
