# Search and Local Document Library Delivery Tickets

**Status:** Ready for ticket creation  
**Existing delivery authority:** [`docs/TICKETS.md`](./TICKETS.md)  
**Extractor design authority:** [`docs/DESIGN.md`](./DESIGN.md)  
**Last updated:** 2026-08-05

## 1. Purpose

This document defines the follow-up backlog for turning extracted semantic
documents into a centrally searchable document library. It covers portable
search-record generation, local filesystem persistence, PostgreSQL indexing,
the Node API, a local React test frontend, result navigation, and the handoff
guide for the main application's AI development agent.

A ticketing agent may create tracker tickets from this document, but it must
preserve ticket IDs, dependencies, scope boundaries, acceptance criteria, and
the locked decisions below.

A ready-to-use agent prompt is available at
[`docs/SEARCH_TICKETING_AGENT_PROMPT.md`](./SEARCH_TICKETING_AGENT_PROMPT.md).

## 2. Locked decisions

- Every authenticated user of the main application may access every document;
  search does not require per-document or per-user authorization filtering.
- The portable folder remains `src/pdf-content-extractor/` and must retain zero
  third-party runtime dependencies.
- PDF parsing and search-record construction run in a Web Worker. Database and
  filesystem work belongs to the Node host application.
- The browser sends the original PDF, semantic document, assets, document
  metadata, and search records to the Node API after extraction.
- The original PDF is stored in an application-managed folder, not PostgreSQL.
- The semantic document is stored as JSON in that folder. HTML is rendered
  from the semantic document and is not the source of truth.
- Documents are unique. Replacement is explicitly delete-then-reupload; there
  is no revision history or silent overwrite in this phase.
- PostgreSQL uses built-in full-text search with the `simple` configuration and
  GIN indexes. No PostgreSQL extensions may be assumed.
- Search indexes logical semantic blocks and retains document, section, heading,
  block type, and original PDF page context.
- Search results can open either the formatted HTML at a stable block anchor or
  the original PDF at the corresponding PDF page.
- The current project is the reference integration and local test harness. Its
  React UI, Node server, PostgreSQL adapter, and storage code are not copied as
  part of the portable extractor.
- The existing local PostgreSQL 17 Docker setup, migration `001`, port `54329`,
  and `storage/documents/` layout are the implementation starting point.
- Future schema changes use new numbered migrations. Do not silently rewrite a
  migration that may already have been applied to a persistent volume.

## 3. Global definition of done

Unless a ticket says otherwise, implementation must:

- Use strict TypeScript and typed boundaries.
- Add automated success, failure, and lifecycle coverage.
- Preserve the extractor's copy-folder installation boundary.
- Keep PDF work off the browser main thread.
- Treat extracted text as untrusted data and escape it before creating HTML.
- Use parameterized SQL; never interpolate search or document values into SQL.
- Leave the database and filesystem consistent after partial failures.
- Avoid PostgreSQL extensions and external search services.
- Pass unit tests, integration tests, test type-checking, and the production
  build that exist at implementation time.
- Update the relevant README when commands, schemas, APIs, or public contracts
  change.

## 4. Milestones and dependency map

```text
M6: Searchable semantic foundation
  TKT-021 -> TKT-022
  TKT-023 -> TKT-024
  TKT-022 + TKT-024 -> TKT-025

M7: Local search experience and handoff
  TKT-025 -> TKT-026 -> TKT-027
  TKT-027 -> TKT-028
  TKT-027 -> TKT-029
```

TKT-021 and TKT-023 may proceed concurrently because one changes the portable
semantic model and the other establishes host-side persistence conventions.

---

## Epic F: Searchable semantic foundation

### TKT-021 — Add stable semantic anchors and PDF-page navigation metadata

**Goal:** Give every searchable semantic location a stable identity that can
support HTML deep links and original-PDF page navigation.

**Depends on:** TKT-013, TKT-016, and TKT-020

**Scope:**

- Add typed document, section, and block identity fields to the public semantic
  model where they do not already exist.
- Define a deterministic ID strategy based on document identity and structural
  position, not mutable paragraph text.
- Retain the one-based original PDF page number for every searchable block.
- Render block IDs as safe HTML anchors and expose section/page metadata through
  safe `data-*` attributes where useful.
- Define helpers for an HTML destination and a PDF page destination.
- Keep identifiers stable across repeated parsing of identical bytes.

**Out of scope:** Database records, search ranking, URL routing, and frontend
search controls.

**Acceptance criteria:**

- Parsing identical input twice produces identical section and block IDs.
- Every heading, paragraph, list item, table cell, and figure caption that can
  become a search result has a block ID and PDF page number.
- IDs are unique within a document and safe in an HTML `id` attribute.
- Rendered HTML contains a target for every searchable block.
- A small text correction does not renumber unrelated earlier blocks when the
  underlying structural position is unchanged.
- The portable library remains free of application and database imports.

**Verification:** Unit tests for determinism, uniqueness, hostile metadata,
HTML anchors, and representative corpus page mappings.

---

### TKT-022 — Generate portable search records from semantic documents

**Goal:** Convert a semantic document into plain, serializable search records
without coupling the extractor to PostgreSQL or the host application.

**Depends on:** TKT-021

**Scope:**

- Define and export `DocumentSearchRecord` and related public types.
- Produce records for headings, paragraphs, list items, table cells, and figure
  captions.
- Include document ID/title, section ID, block ID, heading, heading path, page
  number, block type, searchable text, table header, and row header when known.
- Preserve enough table context for a result to make sense without rendering
  the entire table.
- Exclude empty, artifact-only, and non-searchable blocks.
- Keep output deterministic, structured-cloneable, and JSON-serializable.
- Decide and document whether records are returned with parse results or built
  through a public pure helper; do not expose library internals either way.

**Out of scope:** Stemming, SQL, ranking, snippets, database writes, and UI.

**Acceptance criteria:**

- Every record resolves to an existing semantic block and rendered anchor.
- Heading paths accurately describe nested section context.
- Table records contain available row/column context without duplicating an
  entire table into each cell.
- Repeated extraction produces byte-equivalent JSON records.
- Corpus tests demonstrate useful records from prose, lists, and tables.
- Record generation adds no third-party runtime dependency.

**Verification:** Pure unit tests, JSON round-trip tests, and full-corpus
integration snapshots.

---

### TKT-023 — Establish reference document persistence and storage lifecycle

**Goal:** Provide a safe local host-side storage layer for original PDFs,
semantic JSON, and extracted assets.

**Depends on:** None

**Scope:**

- Treat the checked-in `storage/documents/` layout as the reference root.
- Store each document under `storage/documents/{documentId}/` with
  `original.pdf`, `semantic-document.json`, and an `assets/` directory.
- Validate document IDs and asset names before resolving paths; no user input
  may escape the configured storage root.
- Write uploads through a staging directory and use recoverable/compensating
  cleanup when a database or filesystem step fails.
- Add typed Node interfaces for save, load, list metadata, and delete behavior.
- Keep runtime document contents ignored by version control.
- Make the storage root configurable without changing extractor code.

**Out of scope:** PostgreSQL queries, search ranking, cloud/object storage, and
revision history.

**Acceptance criteria:**

- A stored document can reload its original PDF, semantic JSON, and assets.
- Traversal attempts, invalid IDs, and duplicate paths are rejected.
- Failed imports do not leave a published partial document folder.
- Delete behavior reports partial failure and supports cleanup/retry.
- Tests use temporary directories and never delete outside their resolved test
  root.

**Verification:** Node integration tests for save/load/delete, malformed paths,
duplicate storage, simulated write failure, and cleanup.

---

### TKT-024 — Finalize PostgreSQL document and search-index migrations

**Goal:** Establish a migration-backed database schema for unique documents and
native full-text search without PostgreSQL extensions.

**Depends on:** TKT-023

**Scope:**

- Review the existing `001_initial_document_search.sql` migration as the
  baseline and add new numbered migrations for required corrections.
- Maintain `documents` metadata for title, original filename, storage paths,
  SHA-256 content hash, extractor version, page count, and timestamps.
- Maintain `document_search_blocks` with document/section/block identity,
  headings, heading path, page, block type, content, table context, and a
  generated weighted `tsvector`.
- Enforce unique document title and content hash for the no-duplicates policy.
- Preserve `ON DELETE CASCADE` from documents to search blocks.
- Use `simple` text-search configuration and built-in GIN indexes.
- Add a repeatable database smoke-test command suitable for local development
  and CI environments that provide `DATABASE_URL`.
- Document migration application for both Docker initialization and an existing
  application's migration runner.

**Out of scope:** PostgreSQL extensions, fuzzy matching, document revisions,
and production credentials.

**Acceptance criteria:**

- A clean database applies every migration in order.
- Duplicate title and duplicate content-hash inserts fail clearly.
- Deleting a document removes its search blocks.
- A representative block query uses the GIN-backed search vector and returns
  expected matches for technical terms and codes.
- No migration embeds a real secret or assumes the Docker-only connection.

**Verification:** Clean-volume migration test, schema assertions, constraint
tests, cascade test, and `EXPLAIN` review of a representative search.

---

### TKT-025 — Implement the Node document lifecycle and search API

**Goal:** Connect browser extraction results to filesystem persistence and
PostgreSQL, and expose a safe API for document management and search.

**Depends on:** TKT-022 and TKT-024

**Scope:**

- Add a local Node server outside the portable extractor folder.
- Use the host application's normal PostgreSQL driver pattern; an app-side
  database dependency is allowed, but it must not enter the portable library.
- Implement endpoints to import, list, load, delete, and search documents.
- Accept the original PDF, semantic document, assets, metadata, and search
  records using a documented, bounded request contract.
- Recompute or verify SHA-256 server-side before publication.
- Validate that search records reference the submitted semantic document and
  contain allowed block types and bounded text lengths.
- Reject duplicate titles or hashes with HTTP 409; never silently overwrite.
- Coordinate database transactions and staged filesystem writes with explicit
  compensating cleanup.
- Return parameterized, bounded ranked search results with document, heading,
  page, block, and plain-text snippet source context.
- Keep ordinary application authentication around the API, while omitting
  document-level access filtering because every user may access every document.

**Out of scope:** Search UI, fuzzy matching, revisions, background queues, and
external search services.

**Acceptance criteria:**

- Import publishes a complete document and its search rows or publishes
  nothing.
- List/load responses provide enough paths and metadata for HTML/PDF switching.
- Delete removes database records and the corresponding storage folder, with a
  documented retry path for partial filesystem failure.
- Search uses parameterized PostgreSQL full-text queries and enforces query and
  result limits.
- Duplicate imports return a useful conflict response.
- Malformed payloads cannot write arbitrary files or inject SQL.

**Verification:** API integration tests against local PostgreSQL and temporary
storage, including import, search, load, delete, duplicates, malformed input,
and injected query strings.

---

## Epic G: Local search experience and main-app handoff

### TKT-026 — Build the local document-library test interface

**Goal:** Provide a React reference screen that exercises the full local upload,
extraction, persistence, viewing, and deletion workflow.

**Depends on:** TKT-025

**Scope:**

- Add a local document-library screen to the current React application.
- Support file selection and drag-and-drop PDF upload.
- Parse through the public extractor Web Worker API and show progress,
  cancellation, warnings, and timing information.
- Send completed artifacts to the Node import API and distinguish extraction
  progress from persistence/indexing progress.
- List stored documents with title, filename, page count, and creation time.
- Open a stored semantic document in the formatted HTML renderer.
- Open the stored original PDF and allow switching between HTML and PDF views.
- Delete with confirmation, then refresh the library state.
- Provide useful empty, loading, conflict, cancellation, and failure states.

**Out of scope:** Final work-application styling, search result ranking UI,
permissions, and document editing.

**Acceptance criteria:**

- A user can upload a sample, leave/reload the page, and open the persisted
  document again.
- The main thread remains responsive during extraction.
- Duplicate uploads explain that the admin must delete before re-uploading.
- HTML/PDF switching preserves useful page/location context where available.
- Delete removes the document from the list and makes it unavailable to load.
- The UI uses public extractor and API contracts, not parser internals.

**Verification:** Component tests plus a manual full-corpus workflow against the
local Node/PostgreSQL/filesystem stack.

---

### TKT-027 — Build ranked search results, snippets, and direct navigation

**Goal:** Let a user find specific information without knowing which document
contains it and navigate directly to the answer context.

**Depends on:** TKT-025 and TKT-026

**Scope:**

- Add a document-library search input with debouncing or explicit submission.
- Display ranked results with document title, heading path, page number, block
  type when useful, and a concise contextual snippet.
- Escape result text before highlighting matched terms; database text must never
  be treated as trusted HTML.
- Group or de-duplicate adjacent results when that improves readability without
  hiding distinct matches.
- Open formatted HTML at the stable block anchor and visibly emphasize the
  destination.
- Offer an original-PDF action that opens the corresponding PDF page.
- Add previous/next matches within an opened document where practical.
- Include loading, no-results, short/empty query, server-error, and stale-result
  states.
- Preserve existing title-search usefulness while adding body search.

**Out of scope:** Semantic/AI answers, embeddings, fuzzy matching, saved
searches, analytics, and final corporate styling.

**Acceptance criteria:**

- A query whose terms occur only in body text finds the correct document and
  section.
- Heading matches rank above ordinary body matches under equivalent conditions.
- Technical codes are searchable without English stemming changing them.
- HTML results scroll to and highlight the correct block.
- PDF results open on the recorded one-based page.
- Hostile extracted text cannot inject markup through snippets/highlights.
- Keyboard operation and basic accessible labels are present.

**Verification:** UI tests for result states and navigation plus corpus-based
end-to-end searches across multiple documents.

---

### TKT-028 — Write the AI-agent main-application integration guide

**Goal:** Give the main application's AI development agent an unambiguous,
stepwise contract for moving the tested capabilities into the React/Node app.

**Depends on:** TKT-027

**Scope:**

- Create a dedicated Markdown guide addressed to an AI development agent.
- Identify exactly which extractor folder is copied and which reference files
  are examples only.
- Document public TypeScript contracts, Web Worker construction, asset ownership,
  cleanup, and semantic/search-record output.
- Describe required tables and indexes in framework-neutral terms and point to
  reference migrations without assuming the main app's migration syntax.
- Describe storage layout, path-safety rules, duplicate behavior, import/delete
  compensation, API contracts, query limits, and HTML/PDF navigation.
- Give an ordered implementation checklist and explicit out-of-scope list.
- Provide verification commands and an acceptance matrix the agent must report
  against.
- Warn the agent not to copy the local React styling, Docker credentials, test
  storage, or reference PostgreSQL adapter blindly.

**Out of scope:** Modifying the real work application or encoding its unknown
ORM/framework conventions.

**Acceptance criteria:**

- A developer unfamiliar with this repository can identify portable versus
  app-side code without guessing.
- The guide contains the complete database, storage, API, UI, and lifecycle
  obligations.
- The guide explains that all documents are globally visible but normal app
  authentication still surrounds the feature.
- The guide includes a paste-ready implementation-agent prompt.
- No local development secret is presented as production configuration.

**Verification:** Clean-context review: another agent summarizes the required
main-app changes and produces the expected file/change plan using only the guide.

---

### TKT-029 — Add end-to-end lifecycle, corpus, and scale regression coverage

**Goal:** Prove the reference system stays correct across real documents,
failure recovery, and a collection sized beyond the expected real deployment.

**Depends on:** TKT-027

**Scope:**

- Exercise upload through worker extraction, storage, database indexing, search,
  HTML navigation, PDF-page navigation, and deletion.
- Cover every supplied sample PDF and queries that match titles, headings, body
  prose, list items, tables, and technical codes.
- Add deterministic synthetic data representing thousands of documents without
  committing large generated artifacts.
- Measure index/import time and representative query latency, recording the
  machine and database configuration rather than imposing brittle universal
  thresholds.
- Simulate duplicate uploads, interrupted filesystem writes, database failure,
  stale search results, missing stored files, and deletion cleanup failure.
- Confirm the browser remains responsive while a long document is processed.

**Out of scope:** Production load testing, multi-region storage, and claims of
capacity beyond the measured environment.

**Acceptance criteria:**

- Real-corpus searches return the expected document, section, block, and page.
- Synthetic thousands-document tests complete and record reproducible timings.
- No partial import becomes visible after an injected failure.
- Deleted documents disappear from title and content search.
- Missing/corrupt storage produces a controlled error rather than a crash.
- Test teardown removes only its explicitly created database rows and temporary
  storage root.

**Verification:** Automated end-to-end suite against an isolated PostgreSQL
database plus a documented manual HTML/PDF navigation pass.

---

## 5. Ticket creation rules

- Preserve the `TKT-021` through `TKT-029` identifiers in ticket titles.
- Create Epic F and Epic G, plus milestones M6 and M7, if the destination
  tracker represents epics and milestones.
- Preserve dependency links and acceptance criteria verbatim.
- Link every ticket to this document and `docs/DESIGN.md`.
- Do not combine TKT-026 and TKT-027: the local document-library harness and
  search experience must remain independently demonstrable.
- Do not move Node, PostgreSQL, filesystem, or local React code into
  `src/pdf-content-extractor/`.
- Do not add PostgreSQL extensions or an external search service.
- Do not infer production credentials, ORM conventions, or private main-app
  paths that are not present in this repository.
- If a tracker ticket must be split, retain the parent ID with an alphabetical
  suffix and preserve a separately testable result.

## 6. Deferred enhancements

These are deliberately not part of TKT-021 through TKT-029:

- The extension-free search-quality improvements are now specified by
  `docs/DESIGN.md` section 21 and local tickets TKT-030 through TKT-037.
- Typo tolerance using `pg_trgm` if the real database permits the extension.
- AI-generated answers, embeddings, or semantic/vector search.
- Related-section recommendations.
- Saved searches, search analytics, and popularity ranking.
- Revision history and side-by-side document comparison.
- Per-document authorization if product access rules change.
