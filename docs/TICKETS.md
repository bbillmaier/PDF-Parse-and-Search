# PDF Content Extractor Delivery Tickets

**Status:** Ready for ticket creation  
**Design authority:** [`docs/DESIGN.md`](./DESIGN.md)  
**Last updated:** 2026-08-04

Search, PostgreSQL integration, the local document-library frontend, and the
main-app AI-agent handoff are defined in the follow-up backlog at
[`docs/SEARCH_TICKETS.md`](./SEARCH_TICKETS.md).

## 1. How to use this document

This document defines the implementation backlog for the dependency-free PDF content extraction library. A ticketing agent may copy these tickets into the team's issue tracker, but it must preserve the ticket IDs, dependencies, scope boundaries, and acceptance criteria.

The design document remains authoritative when a ticket is ambiguous. Ticket implementation must not introduce a third-party PDF library or application-specific rendering dependency.

## 2. Global definition of done

Unless a ticket explicitly says otherwise, every implementation ticket must:

- Use strict TypeScript and avoid untyped public APIs.
- Preserve the dependency direction defined in the design document.
- Add or update automated tests for its behavior.
- Include malformed or failure-path coverage where applicable.
- Avoid unrelated application UI work.
- Avoid third-party runtime dependencies.
- Keep expensive PDF work out of the browser main thread.
- Emit typed errors or recoverable warnings instead of silently dropping content.
- Pass the existing build, test, and lint/type-check commands that exist at implementation time.
- Update relevant internal documentation when public behavior changes.

Performance-sensitive tickets must also record before/after benchmark results for the supplied sample corpus.

## 3. Milestones and dependency map

```text
M1: Executable worker spine
  TKT-001 -> TKT-002 -> TKT-003

M2: Open and traverse the sample PDFs
  TKT-004 -> TKT-005 -> TKT-006 -> TKT-007 -> TKT-008

M3: Recover readable semantic text
  TKT-009 -> TKT-010 -> TKT-011 -> TKT-012 -> TKT-013

M4: Preserve assets and integrate
  TKT-014 -> TKT-015
  TKT-013 + TKT-014 -> TKT-016 -> TKT-017

M5: Production readiness
  TKT-018 -> TKT-019
```

Some tickets within a milestone may be implemented concurrently only after their stated dependencies are complete. The dev agent should not parallelize edits to shared parser primitives without explicit coordination.

---

## Epic A: Foundation and executable spine

### TKT-001 — Establish the portable library boundary and public types

**Goal:** Create the self-contained `pdf-content-extractor` source folder and define its stable public data contracts without implementing PDF parsing.

**Depends on:** None

**Scope:**

- Create the folder structure described in the design document.
- Define public types for parsed documents, pages, semantic blocks, text content, tables, figures, assets, outlines, progress, timings, warnings, fatal errors, parse options, and safety limits.
- Create the public `index.ts` export surface.
- Define internal boundaries that prevent parser modules from importing the demo application or React.
- Add initial module-level documentation explaining ownership of buffers and image assets.

**Out of scope:** Worker creation, PDF parsing, HTML rendering, and application UI.

**Acceptance criteria:**

- The library folder can be copied without importing anything from the demo application.
- Public modules compile under strict TypeScript.
- No public type exposes an accidental dependency on React or Vite.
- `ParsedDocument`, `DocumentPage`, `DocumentBlock`, `DocumentImage`, `ParseWarning`, `ParseProgress`, and `ParseTimings` are exported.
- A compile-time usage fixture demonstrates construction and narrowing of every block union member.

**Verification:** Type-check the application and run the public-type fixture.

---

### TKT-002 — Implement the worker protocol and lifecycle

**Goal:** Provide a functioning main-thread client and dedicated worker with typed messages, progress, cancellation, disposal, and transferable buffers.

**Depends on:** TKT-001

**Scope:**

- Define versioned request and response message unions.
- Implement worker creation behind `createPdfParser`.
- Transfer input `ArrayBuffer` ownership to the worker.
- Implement parse request IDs and isolation between sequential requests.
- Implement progress events, cancellation, successful completion, fatal errors, and disposal.
- Ensure late worker messages cannot settle an already cancelled or disposed request.
- Return a placeholder typed document result until parsing exists.

**Out of scope:** PDF interpretation and demo styling.

**Acceptance criteria:**

- A file buffer reaches the worker without structured-clone duplication.
- The client receives named progress phases.
- Cancellation rejects with a typed cancellation error and terminates bounded work promptly.
- `dispose()` terminates the worker and makes later calls fail predictably.
- Worker errors are serialized into stable public error types.
- The React main thread remains responsive during a synthetic worker CPU task.

**Verification:** Automated protocol tests plus a demo smoke test covering success, cancellation, worker failure, and disposal.

---

### TKT-003 — Add the fixture, regression, and performance harness

**Goal:** Establish reproducible correctness and performance measurement before parser implementation grows.

**Depends on:** TKT-002

**Scope:**

- Configure a dependency-free or existing-tool test path compatible with the project.
- Register the three sample PDFs as integration fixtures without duplicating their binary files.
- Add facilities for small purpose-built byte fixtures and expected semantic-model snapshots.
- Add worker benchmark reporting for startup, time to first page, total time, decoded byte totals, and phase timings.
- Add a main-thread responsiveness probe suitable for the demo environment.
- Document how to run unit, integration, and benchmark suites.

**Out of scope:** Setting final performance thresholds before baseline data exists.

**Acceptance criteria:**

- One command runs fast unit tests.
- One command runs sample-corpus integration tests.
- One command produces machine-readable and human-readable benchmark results.
- Tests resolve the existing sample files from a single canonical location.
- Benchmark output includes browser/runtime and document identifiers.

**Verification:** Run and capture all three commands on the current workspace.

---

## Epic B: PDF object engine

### TKT-004 — Implement bounded byte reading, lexing, and PDF values

**Goal:** Parse PDF syntax safely from byte ranges without converting the entire document to a string.

**Depends on:** TKT-003

**Scope:**

- Implement byte cursor primitives and bounded subviews.
- Parse whitespace, comments, numbers, booleans, null, names, literal strings, hexadecimal strings, arrays, dictionaries, indirect references, and object delimiters.
- Correctly handle name and string escapes.
- Retain byte offsets for diagnostics.
- Add configurable nesting and token-length limits.

**Out of scope:** Xref lookup, stream decompression, and semantic content operators.

**Acceptance criteria:**

- Supported PDF values parse from raw `Uint8Array` data.
- Parsing never reads beyond the declared byte range.
- Malformed delimiters, excessive nesting, and oversized tokens produce typed errors with offsets.
- Tests cover CR, LF, CRLF, comments, escaped names, nested values, and truncated inputs.

**Verification:** Unit tests using focused byte fixtures and malformed variants.

---

### TKT-005 — Parse indirect objects and traditional cross-reference tables

**Goal:** Resolve ordinary indirect objects through traditional xref tables and trailers.

**Depends on:** TKT-004

**Scope:**

- Validate the PDF header.
- Locate `startxref` safely from the file tail.
- Parse traditional xref subsections and trailers.
- Follow `/Prev` chains with cycle and depth protection.
- Resolve in-use indirect objects by object number and generation.
- Parse stream boundaries using direct and indirect `/Length` values.
- Cache resolved objects and expose diagnostic resolution information.

**Out of scope:** Xref streams and compressed object streams.

**Acceptance criteria:**

- Traditional-xref test PDFs resolve catalog, trailer, ordinary objects, and streams.
- Incrementally updated xref chains honor the newest valid entry.
- Invalid offsets, cycles, missing objects, and length mismatches produce typed failures or narrowly scoped recovery warnings.
- Resolution is indexed and does not scan the full document for every object.

**Verification:** Unit fixtures plus the traditional portions of `releasability_statement.pdf`.

---

### TKT-006 — Implement Flate stream decoding and predictor support

**Goal:** Decode the compression required by content streams, xref streams, object streams, and common raw images.

**Depends on:** TKT-005

**Scope:**

- Add the stream-filter pipeline abstraction.
- Implement `FlateDecode` through browser-native worker capabilities supported by the target baseline.
- Implement PNG predictor reversal required by supported streams.
- Enforce decoded-size and compression-ratio limits.
- Retain filter metadata and timing diagnostics.
- Produce a typed unsupported-filter warning/error for filters outside the current contract.

**Out of scope:** JPEG pixel decoding, image colorspaces, and chained filters not present in the initial compatibility contract.

**Acceptance criteria:**

- Known Flate fixtures decode byte-for-byte.
- Predictor fixtures decode byte-for-byte for supported predictor modes.
- Decompression bombs are stopped by configured limits.
- Truncated or corrupt streams fail without crashing the worker.
- Feature detection produces a clear compatibility error if required browser decompression is unavailable.

**Verification:** Unit fixtures and successful decoding of representative sample streams.

---

### TKT-007 — Support cross-reference streams and compressed object streams

**Goal:** Resolve the modern PDF storage formats used by both large sample documents.

**Depends on:** TKT-006

**Scope:**

- Parse `/Type /XRef` streams using `/W` and `/Index`.
- Merge hybrid/traditional and streamed xref sections correctly.
- Resolve type-2 entries from `/ObjStm` streams using `/N` and `/First`.
- Cache decoded object streams.
- Support linked sections and linearized files without assuming the first xref is the only xref.
- Add cycle, object-count, and expanded-object-stream limits.

**Out of scope:** Page interpretation and damaged-file repair scanning.

**Acceptance criteria:**

- Catalog and representative compressed objects resolve from both large sample PDFs.
- Mixed xref sources apply correct precedence.
- Each object stream is decompressed at most once per parse.
- Invalid widths, indexes, offsets, and object-stream headers produce typed failures.
- Resolution diagnostics identify the source xref section and storage type.

**Verification:** Focused unit fixtures plus integration assertions against both large samples.

---

### TKT-008 — Traverse the catalog, page tree, and inherited resources

**Goal:** Enumerate pages and their effective resources in stable document order.

**Depends on:** TKT-007

**Scope:**

- Resolve the catalog and `/Pages` root.
- Walk multi-level page trees iteratively or with bounded depth.
- Apply inherited media boxes, crop boxes, rotation, and resources.
- Resolve page content references without decoding them yet.
- Create internal page descriptors and emit page-count progress.
- Detect cycles, duplicate page references, and inconsistent `/Count` values.

**Out of scope:** Text extraction and semantic reconstruction.

**Acceptance criteria:**

- The samples enumerate exactly 38, 76, and 1 pages in order.
- Effective page dimensions and rotations are available.
- Fonts and XObjects inherited from ancestor page nodes are visible to a page descriptor.
- Page-tree corruption is bounded and reported clearly.
- The worker can deliver document metadata and page descriptors without locking the main thread.

**Verification:** Full-corpus traversal integration test and malformed page-tree unit tests.

---

## Epic C: Text and semantic extraction

### TKT-009 — Interpret page content streams and graphics/text state

**Goal:** Convert page drawing operations into positioned raw text fragments and placed-XObject events.

**Depends on:** TKT-008

**Scope:**

- Tokenize content streams independently from general PDF object syntax where appropriate.
- Implement graphics-state save/restore and transformation matrices.
- Implement the text state and operators listed in the design document.
- Parse `Tj` and `TJ` without treating string fragments as words.
- Track `BDC`, `BMC`, and `EMC`, including MCIDs and artifacts.
- Emit `Do` events with the active transformation matrix.
- Enforce operation-count and nesting limits per page.

**Out of scope:** Unicode decoding, final spaces, semantic blocks, and image pixel extraction.

**Acceptance criteria:**

- Representative sample content produces ordered raw text events and XObject placements.
- Text and graphics matrices match focused numeric fixtures within documented tolerances.
- `TJ` numeric adjustments affect advances correctly.
- Marked-content context and artifact state are attached to emitted events.
- Unknown operators are skipped safely when their operands are syntactically valid and are recorded in diagnostics.

**Verification:** Operator-level unit tests plus representative page event snapshots.

---

### TKT-010 — Decode font encodings and Unicode CMaps

**Goal:** Convert strings from the sample fonts into Unicode and provide glyph advances needed for spacing.

**Depends on:** TKT-009

**Scope:**

- Resolve page font resources and font descriptors required for text extraction.
- Parse `/ToUnicode` CMaps, including `bfchar` and `bfrange` mappings used by the samples.
- Support WinAnsi encoding and encoding differences.
- Support the necessary Type0/CID behavior and Identity-H mappings.
- Read applicable width data and provide normalized advances.
- Cache font decoders by indirect reference.
- Emit unknown-glyph markers and warnings with font and page context.

**Out of scope:** Preserving source font family or generating CSS from PDF fonts.

**Acceptance criteria:**

- Known headings and body text from all three samples decode to expected Unicode.
- Curly punctuation, symbols, and bullet glyph behavior are covered by fixtures.
- Repeated use of a font reuses one decoder instance.
- Missing or invalid mappings never silently discard bytes.
- Font output contains only extraction metrics and no presentation dependency.

**Verification:** CMap/encoding unit tests and sample text assertions.

---

### TKT-011 — Reconstruct lines, spaces, and paragraphs geometrically

**Goal:** Turn positioned decoded fragments into readable text lines and conservative paragraph blocks.

**Depends on:** TKT-010

**Scope:**

- Normalize coordinates for page rotation and transformations.
- Group fragments by compatible baselines.
- Infer spaces from advances, glyph metrics, and horizontal gaps.
- Join fragmented `Tj`/`TJ` strings without creating false spaces.
- Detect line boundaries, indentation, and paragraph separation.
- Retain source coordinates and confidence diagnostics internally.
- Provide fallback reading order for untagged pages.

**Out of scope:** Tagged structure, table reconstruction, and application styling.

**Acceptance criteria:**

- Representative fragmented sample phrases reconstruct exactly.
- Words split across multiple operations do not gain artificial spaces.
- Separate columns or distant fragments are not merged into one line by default.
- The untagged one-page sample produces readable paragraphs in expected order.
- Thresholds are centralized, documented, and covered by geometry fixtures.

**Verification:** Golden line/paragraph tests and selected sample-page snapshots.

---

### TKT-012 — Resolve tagged structure, MCIDs, and pagination artifacts

**Goal:** Use the tagged PDFs' explicit semantic structure and remove marked page artifacts.

**Depends on:** TKT-011

**Scope:**

- Parse the structure tree root, parent tree, structure elements, kids, and marked-content references.
- Map page MCIDs to extracted content.
- Preserve structure order while using geometry inside an element.
- Recognize standard roles needed by the samples.
- Exclude `/Artifact` content by default, with an option to retain it for diagnostics.
- Fall back locally when tags are missing, duplicated, or invalid.

**Out of scope:** Final table/list model construction and arbitrary custom role maps not found in the corpus.

**Acceptance criteria:**

- Representative H1/H2, paragraph, list, table, figure, reference, and TOC elements map to page content.
- Repeating headers, footers, and page numbers marked as artifacts are absent from default body output.
- Invalid MCID references produce warnings without discarding unrelated page content.
- Tagged order wins over raw content-stream order when the two differ.
- The untagged sample continues through the geometry fallback.

**Verification:** Tagged-structure unit fixtures and sample semantic snapshots.

---

### TKT-013 — Build semantic headings, lists, tables, figures, outlines, and links

**Goal:** Produce the public semantic block model from tagged and fallback content.

**Depends on:** TKT-012

**Scope:**

- Map recognized structure roles into public block types.
- Preserve heading levels and generate stable in-document identifiers.
- Preserve list nesting, labels, and list-item bodies.
- Preserve tagged table rows, header cells, data cells, and simple spans when declared.
- Attach captions and alternative text to figure blocks when available.
- Resolve document outlines and safe internal/external link targets.
- Add conservative fallback behavior for untagged headings and tables.
- Attach warnings when a structure must be flattened or approximated.

**Out of scope:** Image byte decoding and HTML markup generation.

**Acceptance criteria:**

- Known sample headings, lists, tables, TOC entries, figures, and links appear in semantic order.
- Table cells retain row/header relationships rather than being flattened into unrelated paragraphs.
- Unsafe external protocols are not exposed as active public links.
- Duplicate or malformed identifiers are normalized deterministically.
- Semantic snapshots are stable across repeated runs.

**Verification:** Golden model tests for representative pages and full-document outline assertions.

---

## Epic D: Images, rendering, and integration

### TKT-014 — Extract JPEG assets and associate image placement

**Goal:** Preserve directly reusable JPEG image XObjects without unnecessary decode/re-encode work.

**Depends on:** TKT-009 and TKT-008

**Scope:**

- Resolve image XObjects referenced by `Do` events.
- Support direct `DCTDecode` JPEG extraction.
- Record source dimensions, page placement, active transformation, and reuse across pages.
- Transfer completed image buffers back to the client without avoidable cloning.
- Associate image assets with figure blocks when tagged relationships are available.
- Enforce encoded-size and dimension limits.

**Out of scope:** Flate pixel images, masks, and semantic chart interpretation.

**Acceptance criteria:**

- Representative JPEGs from both large samples open as valid browser JPEG blobs.
- A reused image is stored once and referenced by ID.
- Placement page and dimensions match the source XObject event.
- Oversized or damaged JPEG objects produce asset warnings without failing document text.
- Benchmark diagnostics separate JPEG pass-through time from general parsing.

**Verification:** Byte-signature tests, browser decode smoke tests, and sample asset-count assertions.

---

### TKT-015 — Decode prioritized Flate images, predictors, and masks

**Goal:** Preserve the remaining common raster figures used by the standardized document family.

**Depends on:** TKT-014 and TKT-006

**Scope:**

- Support the observed DeviceGray and DeviceRGB Flate image cases.
- Apply supported PNG predictors.
- Support common image masks and soft masks observed in the corpus.
- Convert decoded pixels to PNG using worker-compatible browser APIs when available.
- Preserve alpha and orientation correctly.
- Add explicit warnings for unsupported color spaces, bit depths, masks, or browser capabilities.

**Out of scope:** Full ICC color management, all PDF color spaces, OCR, JPX, JBIG2, and vector-to-SVG reconstruction.

**Acceptance criteria:**

- Prioritized Flate images from the samples produce viewable PNG assets.
- Paired masks produce expected transparency in fixture pixels.
- Pixel and allocation limits stop pathological images before excessive allocation.
- Unsupported encodings retain figure/caption placeholders and warnings.
- Image conversion stays in the worker.

**Verification:** Pixel fixtures, browser image-decode tests, sample visual spot checks, and memory/timing reports.

---

### TKT-016 — Implement the safe semantic HTML renderer

**Goal:** Convert the public document model into minimal, host-styleable semantic HTML without coupling to React.

**Depends on:** TKT-013 and TKT-014

**Scope:**

- Render articles, optional page sections, headings, paragraphs, nested lists, tables, figures, captions, and safe links.
- Escape all extracted text and attribute values.
- Provide hooks for class names, IDs, page-boundary behavior, and asset URL resolution.
- Define explicit ownership and cleanup for any object URLs created by renderer helpers.
- Optionally render unsupported-image placeholders.
- Avoid inline source typography and PDF layout styles.

**Out of scope:** Application theme CSS and React components.

**Acceptance criteria:**

- All public block variants render deterministically.
- Extracted markup-like text cannot inject HTML.
- Links use an allowlist and safe attributes.
- Tables and lists are valid semantic markup.
- The renderer emits no PDF font-family styling.
- Page boundaries and image placeholders are configurable.

**Verification:** DOM-based or string-structure unit tests including hostile text and URLs.

---

### TKT-017 — Integrate the real demo workflow and write the copy-folder README

**Goal:** Demonstrate the complete public API and document exactly how to move the library into the work application.

**Depends on:** TKT-015 and TKT-016

**Scope:**

- Replace the placeholder demo with PDF selection/drop, progress, cancellation, incremental page display, warnings, timings, and result cleanup.
- Render through only public library APIs.
- Keep demo-specific React and CSS outside the library folder.
- Write the library README required by the design document.
- Document worker construction for the current Vite environment and identify where another bundler may differ.
- Add an explicit copy-folder installation and upgrade procedure.

**Out of scope:** Matching the private work application's theme or adding a publishing workflow.

**Acceptance criteria:**

- A user can process all three samples through the demo without a main-thread lockup.
- Pages appear incrementally and the conversion can be cancelled.
- Images, warnings, and timings are visible.
- The demo imports no library internals.
- A clean test consumer can copy the folder and follow the README to parse a PDF.
- Object URLs, workers, and other resources are cleaned up when a result is replaced or the demo unmounts.

**Verification:** Production build, manual corpus run, cancellation test, and clean-consumer installation rehearsal.

---

## Epic E: Production readiness

### TKT-018 — Harden malformed-input handling and security limits

**Goal:** Ensure malformed or hostile PDFs cannot hang the worker, exhaust memory unchecked, or inject active content into the host.

**Depends on:** TKT-017

**Scope:**

- Audit every recursive structure and potentially expanding operation.
- Finalize configurable limits for objects, depth, streams, compression ratios, operations, CMaps, and image pixels.
- Add time/cancellation checkpoints to long loops.
- Fuzz focused syntax and stream boundaries with deterministic mutations.
- Verify actions, scripts, embedded files, and unsafe URLs are never executed.
- Review worker failure recovery and host cleanup.

**Out of scope:** Cryptographic validation and support for encrypted PDFs.

**Acceptance criteria:**

- The malformed fixture suite completes within bounded time and memory.
- Limit failures identify the applicable limit and document/page context.
- Cancellation interrupts every identified long-running phase.
- The client can create a fresh parser after a worker crashes or is terminated.
- No extracted string or PDF action becomes executable content through the default renderer.

**Verification:** Mutation suite, limit tests, cancellation matrix, and security-focused code review.

---

### TKT-019 — Establish performance baselines and optimize the full corpus

**Goal:** Meet documented responsiveness expectations on representative hardware without sacrificing correctness.

**Depends on:** TKT-018

**Scope:**

- Record reproducible baselines for all supplied PDFs.
- Profile worker startup, xref/object resolution, page parsing, font decoding, structure reconstruction, image extraction, message transfer, and rendering.
- Remove avoidable full-file scans, buffer copies, repeated decompression, and repeated resource parsing.
- Tune page-batch size for time to first useful content and total throughput.
- Establish agreed performance budgets using representative work hardware and target browsers.
- Add regression thresholds with enough tolerance to avoid flaky results.

**Out of scope:** Correctness shortcuts and undocumented browser-specific behavior.

**Acceptance criteria:**

- Benchmark results include time to first page, total time, phase timings, and large-buffer totals for each sample.
- The demo remains responsive throughout every sample conversion.
- Each decoded object stream, font map, and shared image is cached and processed no more than necessary.
- Agreed budgets and benchmark environment are recorded in the README or benchmark documentation.
- Performance regression checks fail clearly when a budget is exceeded.

**Verification:** Repeated benchmark runs on representative hardware plus a final full-corpus correctness run.

---

## 4. Ticket creation rules

When these items are entered into an issue tracker:

- Preserve each `TKT-###` identifier at the beginning of the title.
- Preserve dependency links.
- Add the relevant epic and milestone labels.
- Copy scope, out-of-scope, acceptance criteria, and verification sections into the ticket body.
- Link every ticket to `docs/DESIGN.md` and this backlog document.
- Do not replace acceptance criteria with a generic definition of done.
- Do not combine TKT-004 through TKT-013 into broad "build parser" tickets.
- If a ticket must be split, retain the parent ID and use suffixes such as `TKT-010A` and `TKT-010B`; preserve an independently testable outcome for each child.
- Do not assign estimates without the team's estimation convention.
- Mark TKT-006 compatibility work as blocked until the oldest supported browser baseline is known if native worker decompression support is uncertain.

## 5. Inputs still required from the host application

These details should become follow-up compatibility tickets or ticket comments when known:

- Oldest supported browser versions.
- Actual work-application bundler and worker URL conventions.
- Representative work hardware for performance budgets.
- Desired default visibility of PDF page boundaries.
- Default unsupported-image placeholder behavior.
- Internal-link and external-link product requirements.
