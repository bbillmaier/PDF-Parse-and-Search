# Main-App AI Agent Integration Guide

This guide is for the AI development agent moving the tested local document-library capability into the main React/Node application. It covers every schema, API, configuration, UI, and reindexing obligation introduced by TKT-030 through TKT-037 (the full Epic H "robust lightweight search" milestone).

## Portable vs Reference Code

Copy only `src/pdf-content-extractor/` as the portable extractor. It has no React, Node, PostgreSQL, Docker, filesystem, or local styling dependency.

Use these files as reference examples only:

- `src/main.tsx`, `src/styles.css`, and `src/document-library.ts`: local React test harness and browser serialization helpers. **`src/main.tsx` is a reference test harness only** -- just enough local React behavior to exercise and verify the API surface (including the TKT-037 filter controls and suggestion dropdown). It establishes no styling or component requirements for the real main application; do not treat any of its markup, CSS classes, or component structure as a UI specification.
- `src/search-query.ts`, `src/search-synonyms.ts`, `src/search-vocabulary.ts`, `src/search-typo.ts`, `src/search-technical-normalization.ts`, `src/title-selection.ts`, `src/search-filters.ts`, `src/search-suggestions.ts`: small, dependency-free, host-shared content/validation modules. Portable in the sense that they have no React/Node/database dependency and can be copied close to verbatim, but deliberately **outside** `src/pdf-content-extractor/`, which has no concept of search, filters, suggestions, or title boilerplate.
- `server/`: reference Node API, storage lifecycle, and PostgreSQL adapter.
- `database/migrations/`: reference schema and indexes.
- `compose.yaml`, `.env.example`, `storage/`, and `test/`: local development/test infrastructure, not production configuration.

Do not copy local React styling, Docker credentials, test storage, or the reference PostgreSQL adapter blindly.

## Extractor Contract

Import public APIs only from `src/pdf-content-extractor/index.ts`.

Required public contracts:

- `createPdfParser()` constructs a Web Worker backed parser.
- `parser.parse(fileOrBlobOrArrayBuffer, { preserveImages, onProgress, onPage, signal })` returns `ParsedDocument`.
- `parser.dispose()` terminates the worker.
- `renderDocumentToHtml()` or app-owned rendering can render semantic blocks.
- `renderDocumentToDisposableHtml()` creates object URLs for image assets and returns `cleanup()`.
- `generateDocumentSearchRecords(document, { documentId, documentTitle })` returns JSON-serializable `DocumentSearchRecord[]`. If `documentTitle` is omitted it falls back to `document.metadata.displayTitle ?? document.metadata.title ?? "Untitled document"` -- pass `documentTitle` explicitly whenever you have a selected display title (see below).
- `htmlDestinationForBlock()` and `pdfPageDestinationForPage()` define navigation targets.

Worker construction in this Vite reference app is handled by the library client. If the main app uses another bundler, adapt only worker URL construction; do not move bundler code into the portable folder.

Asset ownership belongs to the host app after parsing. Revoke object URLs when a document is closed, replaced, or the component unmounts. Treat all extracted text as untrusted.

### Title and metadata contract (TKT-036)

`ParsedDocument.metadata` (`DocumentMetadata` in `src/pdf-content-extractor/types.ts`) separates raw PDF evidence from the selected display title:

- `title` -- the raw PDF `/Info` dictionary Title, exactly as extracted. Evidence only: it may be empty, or itself boilerplate (the sample corpus includes a real PDF whose `/Info` Title is literally `"BY ORDER OF THE"`). **Never overwrite this field** -- a host that clones `ParsedDocument` before persisting it (as the reference `src/main.tsx` used to, before TKT-036) must not replace `title` with a computed value, or the raw metadata is silently and permanently lost.
- `producer` -- also raw, unrelated to title selection.
- `displayTitle` -- the selected library/display title. This is what document listings, search results, and navigation should show.
- `titleSource` -- a `TitleSource` (`"host" | "pdf-metadata" | "first-page-heading" | "filename"`) recording which tier produced `displayTitle`.
- `titleConfidence` -- a number in the closed interval `[0, 1]`, fixed per tier (not a continuous score).

Title selection itself is **not** part of the portable extractor -- it lives in a small, host-shared, dependency-free module equivalent to `src/title-selection.ts`, reusing the same pattern as `src/search-synonyms.ts`/`src/search-vocabulary.ts` (portable, but deliberately outside `pdf-content-extractor/`, which has no concept of boilerplate rejection or host overrides). Reproduce:

- `selectDocumentTitle({ hostTitle?, pdfMetadataTitle, firstPageBlocks, originalFilename })` implementing this priority order (docs/DESIGN.md section 21.7):
  1. `host` -- an explicit admin/host-supplied title, if present and non-empty. Never boilerplate-checked: a host operator's deliberate choice is not second-guessed.
  2. `pdf-metadata` -- the raw PDF Title, if it passes a conservative credibility check (bounded length, not known boilerplate).
  3. `first-page-heading` -- the first level-1 heading block on page 1, if any, subject to the same credibility check plus a stricter minimum length (a bare 3-4 character fragment is "weak or ambiguous" and should not become the title). A level-2+ heading is never eligible -- it is substructure, not the document's own title.
  4. `filename` -- the cleaned original filename (strip extension, replace `_`/`-` with spaces, capitalize each word's first letter only so existing acronym casing like `AFQTP` survives). Always succeeds, so this tier never fails to produce a title.
- A small, versioned, conservative boilerplate rule list (`DEFAULT_TITLE_BOILERPLATE_RULES`), each rule an anchored regex plus a human-readable description -- e.g. `BY ORDER OF THE` (issuing-authority attribution line), `COMPLIANCE WITH THIS PUBLICATION IS MANDATORY`, `CONTROLLED UNCLASSIFIED INFORMATION`, `TABLE OF CONTENTS`. Configurable: `selectDocumentTitle`/`isBoilerplateTitle` accept an optional rule-set override for tests or host-specific tuning, defaulting to the shipped list.
- `applyTitleSelection(document, id, selection)` -- sets `metadata.id`/`displayTitle`/`titleSource`/`titleConfidence` on a freshly parsed `ParsedDocument` before it is persisted, leaving `metadata.title` untouched. Call this (not manual object-spread) when assembling the document to send to `/api/documents/import`.

Confidence is a fixed value per tier, strictly ordered `host (1.0) > pdf-metadata (0.8) > first-page-heading (0.65) > filename (0.2)`, so a stricter tier's acceptance always outranks a looser one. Selection is deterministic: the same extracted data and filename always produce the same `{ title, source, confidence }`.

## Database

Use framework-native migrations equivalent to `database/migrations/001_initial_document_search.sql`, `002_document_storage_paths_and_id_checks.sql`, `003_dual_language_search_vectors.sql`, `004_search_vocabulary.sql`, and `005_search_suggestions.sql`. **Apply them in this exact numeric order** -- each later migration assumes the columns/tables the previous ones added (003 replaces 001's single `search_vector` with the `simple`/`english` pair; 004 and 005 both add new, independent, cascade-linked tables and do not touch existing columns). After 003/004/005 apply to a database that already has imported documents, run the reindex step described below once to backfill `technical_variants`, `search_vocabulary_terms`, and `search_suggestions` for those pre-existing rows -- none of the three migrations themselves backfill data, only schema.

Required tables:

- `documents`: id, unique title, original filename, PDF storage path, semantic JSON storage path, assets path, SHA-256 hash, extractor version, page count, timestamps.
- `document_search_blocks`: document id, block id, section id, heading, heading path JSON, page number, block type, content, table header, row header, a plain `technical_variants` text column, and two generated `tsvector` columns (`simple`- and `english`-configured).
- `search_vocabulary_terms` (TKT-035, migration 004): one row per `(term, document_id)` pair, `ON DELETE CASCADE` to `documents`, populated only from document titles, section headings, table/row headers, and technical identifiers -- never ordinary body text. This is a compact, index-only candidate pool for bounded typo suggestions, not a display or ranking artifact.
- `search_suggestions` (TKT-037, migration 005): one row per `(document_id, suggestion_type, normalized_text)` triple, `ON DELETE CASCADE` to `documents`. `suggestion_type` is `'title' | 'heading' | 'technical'`. `text` is the original display string (plain text); `normalized` is the lowercased, whitespace-collapsed form used for prefix matching and cross-document dedup. Populated only from document titles, section-heading blocks' own text, and technical identifiers (the same detector migration 003 uses) -- never ordinary body text, so it stays small regardless of corpus size. Index-only: never itself a display or ranking artifact for ordinary search results. Reference implementation: `src/search-suggestions.ts`.

Required indexes and constraints:

- Unique document title and content hash.
- `ON DELETE CASCADE` from search blocks, vocabulary terms, and suggestions to documents.
- GIN index on built-in PostgreSQL full-text search vectors using `simple` **and** a second GIN index on an `english`-configured vector (TKT-034, migration 003). The `simple` vector is exact technical vocabulary/codes/acronyms/source word forms and is always the strongest lexical match; the `english` vector is a complementary, lower-priority stemmed-language path, only queried when `simple` results are not useful enough, and never allowed to outrank a `simple`-vector match.
- Bounded technical-identifier normalization: at indexing time, scan each block's own heading/table header/row header/content for identifier-shaped substrings (e.g. `A-12`) and store the other canonical spellings (`A12`, `A 12`) as deterministic, capped index-only text in `technical_variants`, folded into the `simple` vector at the lowest weight. Never mutate the displayed source text, never derive snippets from `technical_variants`, cap identifiers per record, and never generate combinatorial/unbounded variants. Reference implementation: `src/search-technical-normalization.ts`.
- A built-in `text_pattern_ops` btree index on `search_vocabulary_terms.term` (TKT-035, migration 004) supporting a non-wildcard-prefixed `LIKE` predicate, so typo-candidate lookup stays indexed without `pg_trgm` or any other extension.
- A built-in `text_pattern_ops` btree index on `search_suggestions.normalized` (TKT-037, migration 005), same non-extension `LIKE`-prefix approach, supporting the autocomplete endpoint.
- Composite btree indexes on `document_search_blocks (document_id, section_id)` and `(document_id, page_number)` (migration 001) -- these, plus the plain `document_id`/`page_number`/`block_type` columns, are what let a TKT-037 search filter (see below) stay indexed even when the planner prefers them over the GIN index for a highly selective filter combination.
- Safe id checks and bounded content length.
- A repeatable, idempotent reindex step equivalent to `server/reindex-search-core.ts` for backfilling `technical_variants`, `search_vocabulary_terms`, and `search_suggestions` on documents imported before these schema changes existed, reading only already-stored table columns (never a PDF or the filesystem), with per-document transactional failure isolation. The vocabulary and suggestion sides both replace (not merge into) each document's own contribution, so they also self-correct after a title change or content edit -- there is no separate "on title change" hook, just re-running the same reindex step. Run it, in this order, after: (1) applying migrations 003/004/005 to a database with existing documents, (2) any bulk content edit outside the normal import/override path, and (3) recovering from an interrupted or failed reindex run (safe to re-run -- see below).

Do not add PostgreSQL extensions, external search services, embeddings, fuzzy matching, saved searches, analytics, revisions, or document-level permissions.

### Query strategies and ranking classes (TKT-031/032/033/034/035)

The server tries the least permissive useful query interpretation first, only broadening once the previous stage is not "useful enough" (fewer than a small documented threshold of grouped, capped results -- `MIN_USEFUL_RESULTS` in `server/lifecycle.ts`). Each stage produces a `MatchClass` (`direct | prefix | stemmed | synonym | partial | corrected`), and a stricter match class **always** outranks a looser one regardless of numeric score (`MATCH_CLASS_TIER` in `src/document-library.ts`) -- this is a structural tie-break, not a side effect of score weighting:

1. **strict** (`direct`) -- parameterized `websearch_to_tsquery('simple', ...)` against the `simple` vector; supports quoted phrases, `OR`, and `-excluded` terms (TKT-032, `src/search-query.ts`). Raw user text is never concatenated into SQL or `tsquery` syntax.
2. **prefix** (TKT-033) -- the literal final positive term (only if it is a plain word, 3-40 characters, and the query does not end in an exclusion or contain `OR`) becomes a `term:*` prefix match, built as safe `tsquery` text from already-tokenized words.
3. **stemmed** (TKT-034) -- the complementary `english`-configured vector, for ordinary-language word forms (e.g. "inspected"/"inspection") the exact `simple` vector does not relate.
4. **synonym** (TKT-035) -- a configured, directional, capped domain-synonym expansion (`src/search-synonyms.ts`); declines for `OR` queries or terms with no configured rule.
5. **partial** (TKT-033) -- a bounded `term1 | term2 | ...` fallback (up to `MAX_PARTIAL_FALLBACK_TERMS`) so rows answering only some of the query still surface, still excluding excluded terms.
6. **corrected** (TKT-035) -- only if every stage above is still empty/weak: a bounded, vocabulary-based spelling correction (`src/search-typo.ts`) substituted into a fresh strict search.

Ranking within a match class (`server/ranking.ts`, `RANKING_WEIGHTS`) combines: structural weight (title/heading > table context > body), a coverage bonus for distinct query terms matched, an exact-phrase boost, an ordered-near-but-not-contiguous boost, a per-match-class multiplier, and length normalization (so a long block cannot win purely by containing more matchable text). All ranking constants live in this one module, not scattered through SQL or UI code. Stable tie-breaking (score, then document title, then page, then block id) guarantees identical output for repeated identical searches.

`GET /api/search`'s `strategy` field reports the broadest match class actually visible in the final, capped result set -- the UI's job is to explain, not hide, a broadened search.

### Snippets and result grouping (TKT-030)

`server/lifecycle.ts` never returns a full block's text. `buildMatchSnippet` (`src/document-library.ts`) finds the best matching occurrence, includes bounded surrounding context (a fixed character radius), normalizes display whitespace without mutating stored content, and returns `{ snippet, matches }` where `matches` are character ranges *into the snippet*, not the original block. `groupAndCapSearchResults` then folds adjacent matches from the same document section and block type into one visible result (the top-ranked member primary, the rest as `additionalMatches`, never hidden) and enforces a per-document result cap (`perDocumentLimit`) so one long document cannot crowd every other matching document off the page. The frontend must never render snippet text as trusted HTML -- escape first, or build highlighted spans as text nodes (see `highlightedSnippetParts`).

## Search filters (TKT-037)

`GET /api/search` accepts four optional filters, validated server-side by `parseSearchFilters` (`src/search-filters.ts`) before any SQL runs, and composes them with **every** query strategy above (strict through corrected) because all six strategies funnel through the same three database methods (`search`/`searchByTsQuery`/`searchEnglish`), which all accept the same validated filter object:

| Query param | Meaning | Validation |
| --- | --- | --- |
| `documentId` | Restrict to one document | Must match the `documents.id` safe-id shape (`^[a-z][a-z0-9-]{0,128}$`, same bound as the schema's own id CHECK constraints) |
| `page` | Restrict to one PDF page | Integer, `1..100000` (`MAX_FILTER_PAGE_NUMBER`) |
| `pageStart` + `pageEnd` | Restrict to an inclusive page range | Both required together, `pageStart <= pageEnd`, span capped at `MAX_FILTER_PAGE_RANGE_SPAN` (2000 pages) -- mutually exclusive with `page` |
| `sectionId` | Restrict to one section | Same safe-id shape as `documentId` |
| `blockType` | Restrict to one semantic block type | Must be one of exactly `heading \| paragraph \| list-item \| table-cell \| figure-caption` (`SEARCHABLE_BLOCK_TYPES`) -- the synthetic `document-title` result type is never a valid filter *value*, since a title match is not a semantic block in any document |

An unknown block type, a malformed/oversized id, an invalid or excessive page range, or specifying both `page` and a range is rejected with `400` and a clear message -- never silently ignored or clamped. Filters are always parameterized (`server/database.ts`'s `buildFilterClause` builds six fixed `AND ($n::type IS NULL OR column = $n)` clauses, so the SQL text is identical whether or not a given filter is set, only the bound parameter values differ) and stay on indexed candidate selection: the GIN full-text predicate still selects candidates first, and a highly selective filter combination may lead the planner to prefer a composite btree index (`document_search_blocks (document_id, page_number)` / `(document_id, section_id)`) over the GIN index for that query -- both are legitimate indexed plans; the acceptance bar is "no sequential scan," not "always the GIN index by name."

The response always echoes the filters actually applied in a `filters` field (an empty object when none were supplied), so the caller can confirm what was applied without re-deriving it from the request it sent.

The reference React harness exposes these as plain form controls (document dropdown, page/range number inputs, section-id text input, block-type dropdown) sent as extra query params -- this is illustrative wiring only, not a UI requirement for the main application.

## Search suggestions (TKT-037)

`GET /api/search/suggestions?prefix=&limit=` returns bounded, indexed-prefix autocomplete suggestions from exactly three sources -- document display titles, section-heading blocks' own text, and high-value technical identifiers -- and **never** scans full document body content on any request. `DocumentLifecycle.suggest` (`server/lifecycle.ts`) rejects a prefix shorter than `MIN_SUGGESTION_PREFIX_LENGTH` (2 characters) before any query runs (returning an empty list, not an error, since a suggestion request firing while a user is mid-keystroke is expected, not erroneous), and longer than `MAX_SUGGESTION_PREFIX_LENGTH` (100).

Candidates are read from `search_suggestions` via a single indexed `normalized LIKE $1 ESCAPE '\'` btree lookup (`PgDocumentDatabase.suggest`), capped at `MAX_SUGGESTION_CANDIDATES_EXAMINED` (100) rows examined, then ranked and deduplicated (`rankAndDedupeSuggestions`, `src/search-suggestions.ts`) and capped again at `MAX_SUGGESTIONS_RETURNED` (10) in the response. Ranking is a fixed type-tier order -- `title` above `heading` above `technical` (`SUGGESTION_TYPE_TIER`) -- **not** a numeric score, so an exact-prefix title or heading suggestion always sorts ahead of a technical-term suggestion sharing the same prefix, deterministically. The same suggestion text contributed by multiple documents (e.g. a common heading like "Introduction") is deduplicated to one entry, keeping the strictest type it was seen with.

Suggestions are updated (via the same replace-wholesale-from-stored-data reindex logic `search_vocabulary_terms` already uses) on import, on document deletion (`ON DELETE CASCADE`, no application code needed), on a title override (part of the same transaction as the title update and vocabulary rebuild), and via the repeatable `db:reindex-search` CLI/migration-backfill path.

The response body is `{ suggestions: [{ text, type }] }` -- `text` is always plain text, never HTML; the host application owns escaping and presentation entirely, exactly like search snippets. The reference React harness debounces suggestion requests independently of (and faster than) the main search debounce, gates on the same minimum-prefix-length bound the server enforces, and cancels/ignores a stale in-flight request the same `LatestRequestGuard` + `AbortController` pattern search itself uses (a second, independent guard instance, since a suggestion request and a search request are logically separate request streams).

### Domain synonyms and typo suggestions (TKT-035)

Ship a small, versioned, hand-maintained domain-synonym configuration equivalent to `src/search-synonyms.ts` (`DOMAIN_SYNONYM_RULES`, bumping `SEARCH_SYNONYMS_CONFIG_VERSION` on any change). It lives in host/reference code, not `src/pdf-content-extractor/` -- the portable extractor has no concept of search or domain vocabulary. Expansion is directional (a rule's `from` term widens to its `to` terms; the reverse is not implied unless a separate rule says so), deduplicated, and capped both per-term and per-query. It must never touch quoted phrases, excluded terms, or explicit `OR` queries, and only runs as an extra broadening query when the strict/prefix/stemmed passes are not yet useful enough.

Maintain a compact typo-suggestion vocabulary equivalent to `src/search-vocabulary.ts`, built only from document titles, section headings, table/row headers, and technical identifiers -- never full document body text, so it stays small and cheap regardless of corpus size. Update it at import time, on reindex, and (via `ON DELETE CASCADE`) on document deletion. Run bounded edit-distance suggestions (`src/search-typo.ts`: banded Levenshtein, capped distance/candidates/corrections/terms-per-query) only when normal search (strict through partial fallback) is empty or below the documented weak-result threshold, after filtering candidates by length and prefix. Never silently rewrite a query that already found results; present a correction as a labeled "Showing results for X instead of Y" response, never a silent substitution.

Both synonym-only and corrected-term matches must rank strictly below every direct/prefix/stemmed match (see `MATCH_CLASS_TIER` in `src/document-library.ts`), and a corrected-term match ranks below a synonym-only match. Expose which terms were expanded via development-only response diagnostics, and always expose the broadest strategy stage and any corrected-query substitution in the response metadata, in every environment.

### Title override (TKT-036) -- no new schema required

A host/admin title override reuses existing schema: `documents.title` is already the selected display title (unique, indexed, joined into every search result and title match), and `search_vocabulary_terms` already supports a per-document delete-and-reinsert rebuild. No new column or migration is needed to support the override contract:

- `documents.title` is updated in place. The existing `documents_title_unique` constraint (migration 001) is what turns a conflicting override into a `23505` unique violation -- map it to the same 409 conflict response `POST /api/documents/import` already returns for a duplicate title.
- The document's vocabulary is rebuilt in the same database transaction as the title update, using the same per-document reindex logic the `db:reindex-search` CLI already uses (a client-scoped variant of it, reused rather than duplicated, so a title override and a routine reindex can never disagree). This recomputes `search_vocabulary_terms` for the document from its own already-stored `document_search_blocks` rows plus the new title -- never a PDF, never the filesystem.
- `document_search_blocks` itself has no title column (title is always joined from `documents.title` at query time), so no per-block update is needed for a title-only change.

If a host application's schema differs enough that `displayTitle`/`titleSource`/`titleConfidence` need their own columns (rather than living only in the stored semantic JSON, see above), add the next-numbered migration for that, backfill conservatively from already-stored `documents`/`document_search_blocks` rows (never a PDF), and keep the override transactionally atomic with the vocabulary rebuild exactly as described here.

## Storage And Lifecycle

Store each document under an app-managed root equivalent to:

```text
documents/{documentId}/
  original.pdf
  semantic-document.json
  assets/
```

Validate document IDs and asset names before path resolution. Resolve paths under the configured root and reject traversal. Write to staging first, then publish atomically where the platform allows it. If database import fails after storage publish, delete staged/published files. If delete storage cleanup fails after database deletion, return a retryable partial failure.

Duplicate behavior is explicit: reject same title or same PDF hash with a conflict response. Replacement is delete then re-upload.

### Title override staging (TKT-036)

A title override follows the same staged-write discipline as import, but for a single file rather than a whole directory, and in the opposite commit order (storage staged, then database committed, then storage published) so a failure at any point is either fully inert or a clearly reported, retryable partial state:

1. **Stage**: read the live `semantic-document.json`, write an updated copy (new `metadata.displayTitle`/`titleSource: "host"`/`titleConfidence`, raw `metadata.title` untouched) to a temp file next to it -- e.g. `.semantic-document.json.tmp-<uuid>` -- without touching the live file. A staging failure (disk full, permissions) touches neither the live file nor the database.
2. **Commit**: update `documents.title` and rebuild the vocabulary in one database transaction (see above). A conflicting title or a missing document rolls the transaction back; discard the staged temp file. Still fully consistent -- nothing changed.
3. **Publish**: only after the database transaction commits, atomically rename the staged file over the live one (reuse the same bounded Windows-antivirus/indexer retry `publishDirectory` already uses for import, since `rename()` replacing an existing destination file is already atomic on POSIX and Windows). If this step fails, the database (and therefore search/listings/vocabulary) is already correct -- only the semantic JSON snapshot lags. Report this as a retryable partial failure (`storageSynced: false`, `partialFailure: <message>`) rather than throwing, since the operation's user-visible effect already succeeded. Recovery is simply retrying the same override: staging and publishing the same title again is idempotent, and the database update is a same-value no-op that cannot re-trigger the unique-title conflict against itself.

## API Contract

Keep normal application authentication around these endpoints. All authenticated users can access all documents in this phase; do not add document-level authorization filtering.

Reference endpoints:

- `GET /api/documents`: list id, title, original filename, page count, created time.
- `POST /api/documents/import`: accept document id/title, original filename, original PDF bytes, semantic document, assets, and search records.
- `GET /api/documents/:id`: return metadata, semantic document, original PDF bytes, and assets.
- `DELETE /api/documents/:id`: delete database rows and stored files.
- `PATCH /api/documents/:id/title` (TKT-036): body `{ title: string }`. Sets an explicit host/admin display title without reparsing the PDF or resending any file. Responds `200` with `{ found: true, document, reindexed, storageSynced, partialFailure? }` on success (`document` is the updated row; `reindexed` reports the vocabulary rebuild's block/term counts; `storageSynced: false` with `partialFailure` means the database committed but the staged semantic-JSON publish failed -- retryable, see Storage And Lifecycle). Responds `404` with `{ found: false }` when `documentId` matches no document, and `400` for a missing/non-string `title`. Responds **`409`** when the new title conflicts with another document's title (the same `documents_title_unique` constraint import already enforces) -- database, storage, and search stay exactly as they were before the failed override.
- `GET /api/search?q=&limit=&perDocumentLimit=&documentId=&page=&pageStart=&pageEnd=&sectionId=&blockType=`: bounded ranked search over titles and semantic body records. Each result carries a bounded match-centered `snippet` plus `matches` (character ranges into that snippet, for highlighting) instead of the full block text, and `additionalMatches` for other matches grouped into the same document section and block type. `perDocumentLimit` caps how many results one document can contribute so a single long document cannot crowd out other matching documents. The response also carries `strategy` (the broadest match stage behind the visible results -- `strict`/`prefix`/`stemmed`/`synonym`/`partial`/`corrected`), development-only `synonymExpansions` (TKT-035), whenever a typo correction actually produced the results shown, `correctedQuery`/`spellingCorrections` (TKT-035) in every environment, and **`filters`** (TKT-037) -- the validated filters actually applied (an empty object when none were supplied), always present. The five filter query params are optional, validated server-side (see Search filters above), and return `400` for an invalid value rather than being silently ignored or clamped.
- `GET /api/search/suggestions?prefix=&limit=` (TKT-037): bounded indexed-prefix autocomplete. Body `{ suggestions: [{ text: string, type: "title" | "heading" | "technical" }] }`. A prefix shorter than the documented minimum (2 characters) returns `{ suggestions: [] }` with `200`, not an error. See Search suggestions above.

Use parameterized SQL. Enforce query length and result limits. Keep body search on PostgreSQL full-text search with `simple` as the primary vector and `english` as a complementary, lower-priority stemmed path (TKT-034) -- never let an `english`-only or synonym/corrected-only match outrank a `simple`-vector direct match.

## UI Obligations

Build the actual document-library workflow:

1. Select or drag/drop a PDF.
2. Parse through the public worker API.
3. Show extraction progress, cancellation, warnings, timings.
4. Import artifacts through the API and distinguish persistence/indexing progress.
5. List persisted documents.
6. Open semantic HTML and original PDF.
7. Switch HTML/PDF views while preserving useful page/location context.
8. Delete with confirmation and refresh state.
9. Search with debouncing or explicit submit.
10. Render ranked results with title, heading path, page, block type, and escaped highlighted snippets built from the returned bounded excerpt and match ranges; surface grouped `additionalMatches` rather than hiding them.
    - Explain broadened results using `strategy`, including a clearly labeled note when synonym expansion or a spelling correction contributed (TKT-035); render `spellingCorrections`/`correctedQuery` as a "Showing results for X instead of Y" style message, never a silent rewrite of what the user typed.
11. Navigate HTML results to stable anchors and visibly emphasize the target.
12. Navigate PDF results to `#page={oneBasedPage}`.
13. Provide previous/next match controls where practical.
14. Cover loading, empty, short query, no results, conflict, cancellation, server error, stale result, and missing file states.
15. Select the display title at import time with `selectDocumentTitle`/`applyTitleSelection` (never hand-roll `pdfTitle || filename`) and provide a host/admin rename control (`PATCH /api/documents/:id/title`) that refreshes the document list, the open document (if it is the one renamed), and any active search results on success; surface the `409` conflict and any `storageSynced: false` partial-failure response clearly rather than silently.
16. (TKT-037) Offer filter controls for document, page/page-range, section, and block type, sent as the `documentId`/`page`/`pageStart`+`pageEnd`/`sectionId`/`blockType` query params; surface the echoed `filters` field so the user can confirm what is actually narrowing their results, and surface a `400` validation error (e.g. an invalid page range) clearly rather than silently dropping the filter.
17. (TKT-037) Offer autocomplete suggestions from `GET /api/search/suggestions`, debounced independently of the main search debounce, gated on the same minimum-prefix-length the server enforces, and using a stale-request guard (cancel or ignore a response that is no longer for the latest keystroke) -- render `suggestion.text` as plain text with `suggestion.type` as a secondary label; selecting a suggestion should populate and run the main search, not itself constitute a separate feature.

Never render snippet text (or suggestion text) as trusted HTML. Escape before highlighting or construct highlighted snippets as text nodes.

**Reference harness boundary**: the exact form controls, layout, and component structure `src/main.tsx` uses for filters and suggestions are illustrative only -- add only enough UI to exercise and verify the API from the main application's own design system and UX conventions. Do not port `src/main.tsx`'s markup, CSS classes, or component boundaries into the main application as if they were a specification.

## Limits and Environment Configuration

Every bound below is a small, documented constant in the named source module -- reproduce equivalent bounds in the main application rather than leaving any of these unbounded:

| Constant | Value | Module |
| --- | --- | --- |
| `MAX_QUERY_LENGTH` | 256 chars | `src/search-query.ts` |
| `MAX_QUERY_TERMS` | 24 distinct words | `src/search-query.ts` |
| `MIN_PREFIX_TERM_LENGTH` / `MAX_PREFIX_TERM_LENGTH` | 3 / 40 chars | `src/search-query.ts` |
| `MAX_PARTIAL_FALLBACK_TERMS` | 8 clauses | `src/search-query.ts` |
| `MAX_SYNONYM_EXPANSIONS_PER_TERM` / `MAX_TOTAL_SYNONYM_TERMS` | 3 / 6 | `src/search-synonyms.ts` |
| `MAX_EDIT_DISTANCE` | 2 | `src/search-typo.ts` |
| `MAX_CANDIDATE_LENGTH_DELTA` | 2 chars | `src/search-typo.ts` |
| `MIN_CORRECTABLE_TERM_LENGTH` | 3 chars | `src/search-typo.ts` |
| `MAX_CANDIDATES_EXAMINED_PER_TERM` | 100 rows | `src/search-typo.ts` |
| `MAX_CORRECTIONS_PER_TERM` / `MAX_TERMS_CORRECTED_PER_QUERY` | 3 / 3 | `src/search-typo.ts` |
| `MAX_VOCABULARY_TERMS_PER_DOCUMENT` | 200 terms | `src/search-vocabulary.ts` |
| `MIN_VOCABULARY_TERM_LENGTH` / `MAX_VOCABULARY_TERM_LENGTH` | 3 / 40 chars | `src/search-vocabulary.ts` |
| `MAX_TECHNICAL_IDENTIFIERS_PER_RECORD` | 40 per record | `src/search-technical-normalization.ts` |
| `MAX_TECHNICAL_VARIANTS_LENGTH` | 4000 chars | `src/search-technical-normalization.ts` |
| `MAX_RESULT_LIMIT` / `MAX_PER_DOCUMENT_LIMIT` (default 5) | 50 / 20 | `server/lifecycle.ts` |
| `MIN_USEFUL_RESULTS` (broadening-ladder threshold) | 3 | `server/lifecycle.ts` |
| `MAX_SEARCH_CANDIDATES` / stage-specific candidate caps | 400 (strict), 150-200 per broadening stage | `server/lifecycle.ts` |
| `MAX_FILTER_ID_LENGTH` | 128 chars | `src/search-filters.ts` |
| `MAX_FILTER_PAGE_NUMBER` | 100,000 | `src/search-filters.ts` |
| `MAX_FILTER_PAGE_RANGE_SPAN` | 2,000 pages | `src/search-filters.ts` |
| `MIN_SUGGESTION_PREFIX_LENGTH` / `MAX_SUGGESTION_PREFIX_LENGTH` | 2 / 100 chars | `src/search-suggestions.ts` |
| `MAX_SUGGESTION_CANDIDATES_PER_DOCUMENT` | 60 | `src/search-suggestions.ts` |
| `MAX_SUGGESTION_TEXT_LENGTH` | 200 chars | `src/search-suggestions.ts` |
| `MAX_SUGGESTION_CANDIDATES_EXAMINED` | 100 rows | `src/search-suggestions.ts` |
| `MAX_SUGGESTIONS_RETURNED` | 10 | `src/search-suggestions.ts` |
| `MAX_TITLE_LENGTH` / `MIN_TITLE_LENGTH` / `MIN_HEADING_TITLE_LENGTH` | 300 / 3 / 4 chars | `src/title-selection.ts` |
| `MAX_IMPORT_BYTES` | 50 MiB | `server/api.ts` |

Environment variables the reference server/tests/benchmark read:

- `DATABASE_URL` -- PostgreSQL connection string; every DB-backed script/test defaults to `postgresql://pdf_to_html:pdf_to_html_dev@localhost:54329/pdf_to_html` (the local Docker Compose default) if unset.
- `NODE_ENV` -- when `"production"`, `server/lifecycle.ts` omits development-only `scoreComponents`/`synonymExpansions` diagnostics from the search response; every other environment includes them. `strategy`, `filters`, and `correctedQuery`/`spellingCorrections` are always present regardless.
- `RUN_LOCAL_DB_TESTS` -- set to `1` to opt real-PostgreSQL integration tests into a run (they otherwise `describe.skipIf` themselves out when neither this nor `DATABASE_URL` is set, so `npm run test:integration` stays fast and DB-independent by default).
- `SEARCH_BENCH_DOCS` -- synthetic document count for `npm run bench:search` (default 2000).
- `APPLY_MIGRATIONS` -- set to `1` to have `server/db-smoke.ts` apply migrations itself before running the smoke test.

## Verification Commands

Reference repository commands:

```powershell
npm run test:unit
npm run test:integration
npm run typecheck:test
npm run typecheck:server
npm run build
npm run db:up
npm run db:migrate
$env:RUN_LOCAL_DB_TESTS='1'; npm run test:integration
npm run bench:search
```

Required host-side tests (equivalent coverage in the main application's own test suite, not literally these files):

- Unit coverage for filter validation (`parseSearchFilters`) and suggestion candidate building/ranking (`buildSuggestionCandidates`, `rankAndDedupeSuggestions`) equivalent to `test/unit/search-filters.test.ts` and `test/unit/search-suggestions.test.ts`.
- Lifecycle-level orchestration tests (fast, no real database) proving a filter reaches every query strategy and that a too-short suggestion prefix never reaches the database, equivalent to `test/unit/lifecycle-filters.test.ts` and `test/unit/lifecycle-suggestions.test.ts`.
- Real-PostgreSQL integration tests proving filters compose with strict/prefix/stemmed/synonym/partial/corrected strategies, that `EXPLAIN` shows an indexed plan (never a sequential scan) for a filtered query and for the suggestion prefix lookup, and that suggestions update correctly through import/override/delete/reindex, equivalent to `test/integration/search-filters.integration.test.ts` and `test/integration/search-suggestions.integration.test.ts`.
- A deterministic relevance-regression suite asserting expected top results and reported `strategy` for representative fixtures covering every area in docs/DESIGN.md section 21.10, run twice to confirm stable ordering, equivalent to `test/integration/search-quality-regression.integration.test.ts`.
- A benchmark recording strict/phrase/prefix/partial/synonym/typo/filtered/suggestion/no-result query latency, `EXPLAIN` plans, and database/index/vocabulary/suggestion sizes against both the real corpus and a deterministic thousands-document synthetic dataset, with teardown removing only the data it created, equivalent to `test/bench/search-bench.ts` (`npm run bench:search`, `SEARCH_BENCH_DOCS` env var controls synthetic document count, default 2000).

Manual pass:

- Upload every PDF in `src/example_documents/`.
- Reload the page and reopen each persisted document.
- Search title, heading, body prose, list item, table value, and technical-code queries.
- Search a configured domain synonym term (e.g. one only present via its `to` expansion) and confirm the direct match still ranks first.
- Search a deliberate misspelling of a heading/title word (e.g. `inspeciton`) and confirm a clearly labeled corrected search appears only after normal search would otherwise be empty.
- Open at least one HTML result anchor and one PDF page result per sample.
- Rename a document via the override control, confirm the new title appears in the list, in search results, and (opening the document) in the stored semantic JSON's `displayTitle` (with `metadata.title` unchanged); confirm attempting to rename a second document to the same title is rejected with a clear conflict message and does not change either document.
- Delete each document and confirm it disappears from list, search, and the typo-suggestion vocabulary.
- Apply a document filter, a page filter, and a block-type filter to a search that would otherwise span multiple documents/pages/block types, and confirm results narrow correctly and the applied filters are visibly echoed; try an invalid filter value (e.g. a page range with `pageStart > pageEnd`) and confirm a clear `400`-driven error, not silent ignoring.
- Type a short prefix of a known document title or heading into search and confirm autocomplete suggestions appear (title/heading ranked above any technical-term suggestion sharing the prefix), update as you keep typing, and disappear below the minimum prefix length.

## Acceptance Matrix

| Area | Required report |
| --- | --- |
| Portable boundary | Files copied and confirmation no app code entered `pdf-content-extractor/` |
| Worker extraction | Progress, cancellation, warnings, timings, responsiveness |
| Storage lifecycle | Staging, duplicate rejection, import/delete compensation, title-override staged publish |
| Database | Tables, constraints, dual `simple`/`english` GIN indexes, bounded technical-identifier normalization, vocabulary table/index, suggestion table/index, reindex step (in migration order 001-005), query limits |
| API | Import/list/load/delete/search/suggestions behavior, auth wrapper, strategy/synonym/correction/filters metadata, title-override `200`/`404`/`409`/`400` behavior, filter `400` validation |
| Title selection | Priority order, boilerplate rejection (including the `BY ORDER OF THE` sample), raw-metadata preservation, deterministic source/confidence |
| Synonyms and typos | Directional expansion, dedup/cap, ranking below direct matches, bounded vocabulary-based corrections, weak-result gating |
| Filters | Every filter (document/page/range/section/block-type) composes with every query strategy, server-side validation rejects hostile/invalid/excessive values, indexed candidate selection retained, filters echoed in response |
| Suggestions | Indexed prefix lookup only (no body-content scan), minimum prefix length, dedup/cap, title/heading ranked above technical, updated on import/delete/override/reindex |
| Relevance regression | Deterministic fixture suite covering docs/DESIGN.md 21.10's full list, stable ordering across repeated runs |
| HTML navigation | Stable block anchors and visible destination highlight |
| PDF navigation | Original PDF opens on recorded one-based page |
| Security | Snippet/suggestion escaping, path safety, parameterized SQL (including filter predicates) |
| Performance | Benchmark results (strict/phrase/prefix/partial/synonym/typo/filtered/suggestion/no-result) and `EXPLAIN` plans against real and synthetic thousands-document corpora, database/index/vocabulary/suggestion sizes, machine configuration recorded |
| Coverage | Unit, UI/navigation, corpus, scale, failure recovery, build |

## Catalog Metadata Belongs To The Main Application

Tags, categories, free-text descriptions, department/team relevance, favorites/bookmarks, and any other organization-specific catalog metadata are **entirely out of scope** for this feature set and must not be added to the portable extractor, the reference database schema, or the reference API. `document_search_blocks.block_type` is a fixed, small, semantic enum (`heading | paragraph | list-item | table-cell | figure-caption`) describing document structure, not a taxonomy -- do not repurpose it, and do not add a parallel taxonomy column to `documents` or `document_search_blocks` in the portable schema. If the main application needs company-specific classification, build it as the main application's own tables/columns, joined against `documents.id` from the application side; never inside the tables this guide defines.

## Out Of Scope

AI answers, embeddings, automatic synonym discovery, unrestricted fuzzy matching, saved searches, analytics, revisions, production load testing, multi-region storage, OCR, document editing, per-document permissions, PostgreSQL extensions, external search services, personalized/behavioral ranking, and company-specific tags/categories/department taxonomy (see "Catalog Metadata Belongs To The Main Application" above).

## Paste-Ready Agent Prompt

```text
Implement the searchable document-library feature in the main application using this guide as authority.

Copy only src/pdf-content-extractor/ as portable extractor code. Keep React, Node, database, filesystem, Docker, and styling code in the main app. Use the public worker API for PDF extraction, generate search records with generateDocumentSearchRecords(), store original PDFs and semantic JSON in app-managed storage, and index semantic blocks in PostgreSQL full-text search using dual simple/english configurations and built-in GIN indexes only (simple as the primary, always-strongest vector; english as a complementary, lower-priority stemmed path). Apply the bounded technical-identifier normalizer (letters+digits codes such as A-12/A12/A 12) at indexing time, keep it index-only, and provide a repeatable reindex step for documents imported before this schema existed.

Add a small, versioned domain-synonym configuration (directional, deduplicated, capped) and a compact typo-suggestion vocabulary built only from titles/headings/table-row headers/technical identifiers, maintained through import, reindex, and deletion. Run bounded edit-distance suggestions only when normal search is empty or weak, after length/prefix candidate filtering. Rank direct matches above synonym-only matches, and synonym-only matches above corrected-term matches, never silently rewriting a successful query. Expose the broadening strategy and correction metadata in the search response, and synonym-expansion detail as a development-only diagnostic.

Build authenticated import/list/load/delete/search APIs, reject duplicate title/hash conflicts, use staged writes and compensating cleanup, and keep all documents globally visible to authenticated users. Build the UI for upload, progress, cancellation, warnings, persisted document list, HTML/PDF viewing, ranked search results, escaped snippets/highlights, HTML anchor navigation, PDF page navigation, previous/next matches, clearly labeled synonym/typo-correction messaging, and all loading/empty/error/stale states.

Select the display title at import time using the documented priority order (explicit host title, then credible PDF metadata, then a high-confidence first-page heading, then the cleaned filename), rejecting known standalone boilerplate (e.g. "BY ORDER OF THE") at every inferred tier. Preserve the raw PDF metadata title separately from the selected display title -- never overwrite it -- and record which tier was selected plus a bounded confidence value. Add a host/admin title-override endpoint that updates the display title and rebuilds the document's search vocabulary and suggestion candidates in one database transaction, without reparsing the PDF or resending any file; reject a conflicting title with a 409 and leave the database, storage, and search index exactly as they were on any failure; report a storage-publish failure after a successful database commit as a retryable partial failure, not a thrown error.

Add server-validated search filters -- document id, PDF page or a bounded page range, section id, and semantic block type -- that compose with every query strategy (strict, phrase/OR/exclusion, prefix, the english-stemmed pass, synonym expansion, partial fallback, and corrected search), because all of them funnel through the same underlying candidate-selection calls. Reject unknown block types, malformed/oversized ids, and invalid or excessive page ranges with a clear validation error before any query runs; never let a filter's absence versus presence change the SQL text, only the bound parameter values (so indexed candidate selection is retained either way); echo the filters actually applied in the response.

Add bounded, indexed-prefix autocomplete suggestions sourced only from document titles, section-heading text, and technical identifiers -- never a scan of full document body content on any request. Require a documented minimum prefix length (reject shorter prefixes without querying the database), normalize and deduplicate candidates, cap both examined candidates and returned suggestions, and rank exact-prefix title/heading suggestions above technical-term suggestions by a fixed type order, not a numeric score. Update suggestions through the same import/reindex/title-override/delete lifecycle the typo-suggestion vocabulary already uses. Return suggestion text as plain text only; the host owns escaping and presentation. In the reference UI, debounce suggestion requests independently of the main search debounce and cancel/ignore stale responses.

Keep the local React interface strictly a reference test harness -- add only enough behavior to exercise and verify the API, and do not treat its markup, styling, or component structure as a specification for the main application's real UI. Keep tags, categories, descriptions, department relevance, favorites, and all other catalog metadata entirely in the main application's own tables; do not add them to the portable extractor, the reference schema, or the reference API.

Do not add PostgreSQL extensions, external search services, embeddings, AI answers, automatic synonym discovery, unrestricted fuzzy matching, saved searches, analytics, revisions, personalized/behavioral ranking, or document-level permissions. Do not copy local styling, Docker credentials, test storage, or the reference PostgreSQL adapter blindly. Do not add runtime dependencies to the portable extractor.

Before reporting completion, run unit tests (including filter validation and suggestion ranking), UI/navigation tests, corpus end-to-end searches, isolated PostgreSQL lifecycle tests (filters composing with every strategy, suggestions updating through the full document lifecycle, `EXPLAIN`-confirmed indexed plans), a deterministic relevance-regression suite with stable repeated-run ordering, a benchmark against both the real corpus and a deterministic synthetic thousands-document dataset, type checking, production build, and a manual full-corpus HTML/PDF navigation pass including filter and suggestion interaction. Report results against the acceptance matrix.
```
