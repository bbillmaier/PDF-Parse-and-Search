# PDF Content Extractor Design

**Status:** Accepted baseline  
**Last updated:** 2026-08-04  
**Project:** Dependency-free PDF-to-semantic-content library

## 1. Purpose

This project converts long, standardized workplace PDF documents into structured content that a host web application can render with its own HTML, components, and CSS.

The goal is content recovery, not visual reproduction. The library should make dense documents easier to read, navigate, search, and restyle while preserving meaningful document structure and embedded figures.

The implementation is also intended to be understandable and maintainable as a learning project. It will not use third-party PDF parsing or rendering libraries.

## 2. Goals

The library will:

- Run entirely in the browser without network or server-side processing.
- Have no third-party runtime dependencies.
- Be portable by copying one self-contained TypeScript folder into another application.
- Perform parsing and extraction in a Web Worker so the host application's main thread stays responsive.
- Accept `File`, `Blob`, and `ArrayBuffer` inputs.
- Support the family of standardized documents represented by the sample corpus, including variations produced by different departments.
- Extract semantic content such as headings, paragraphs, lists, tables, links, captions, and document outline entries.
- Preserve embedded raster images and charts when their PDF encoding is supported.
- Exclude pagination artifacts such as repeating headers, footers, and page numbers when the PDF identifies them.
- Return a host-neutral document model.
- Provide an optional semantic HTML renderer while allowing applications to render the model directly.
- Process and return long documents incrementally.
- Expose progress, cancellation, warnings, and timing information.
- Fail explicitly and safely when a feature or character cannot be decoded.
- Include integration documentation for copying the library into another TypeScript application.

## 3. Non-goals

The initial project will not:

- Reproduce the PDF's typography, font family, colors, or exact page layout.
- Produce pixel-perfect HTML matching the original PDF.
- Act as a universal implementation of the entire PDF specification.
- Perform OCR on scanned pages or text embedded only in image pixels.
- Infer the semantic meaning of arbitrary charts from their pixels.
- Support encrypted or password-protected PDFs.
- Execute JavaScript, actions, embedded files, or other active PDF content.
- Depend on a public package registry or require publishing the library.

Although fonts are not part of the output styling, PDF font encodings, Unicode maps, widths, and glyph positioning still must be parsed internally to recover correct text and spacing.

## 4. Target document profile

The initial corpus contains standardized, unencrypted technical documents from a common source. Departments may produce variations, so the implementation must not depend on one exact file template.

Observed characteristics include:

| Document | Pages | Approximate size | Relevant characteristics |
| --- | ---: | ---: | --- |
| `afqtp24-3-b192.pdf` | 38 | 0.8 MB | PDF 1.6, linearized, xref streams, compressed object streams, tagged content, lists, tables, TOC, links, five images |
| `qtp1s0x1-1.pdf` | 76 | 2.5 MB | PDF 1.6, linearized, xref streams, compressed object streams, tagged content, many lists/tables/links, 67 image objects |
| `releasability_statement.pdf` | 1 | 58 KB | PDF 1.7, traditional and stream xref data, untagged content, geometry fallback required |

The large samples contain real selectable text and do not require OCR. They frequently split words into small `Tj` and `TJ` operations with kerning adjustments. They also use subsetted TrueType and CID fonts, generally with `/ToUnicode` maps or standard encodings.

Many repeated page elements are marked `/Artifact`. The tagged samples contain marked-content IDs and structural roles for headings, paragraphs, lists, tables, figures, references, and tables of contents.

Most observed figures are raster image XObjects. They include directly reusable JPEG streams and Flate-compressed images, sometimes paired with masks or transparency data.

## 5. Design principles

### 5.1 Separate extraction from presentation

The parser returns a semantic document model. It does not decide the host application's CSS, component library, typography, or visual hierarchy.

### 5.2 Prefer explicit PDF structure

When a document has a valid structure tree, structural tags and marked-content IDs establish semantic relationships and reading order. Geometry remains necessary to order and combine text inside those elements.

When tagging is absent, invalid, or incomplete, the library falls back to geometry-based reconstruction.

### 5.3 Preserve information without pretending certainty

Unsupported images, unknown glyphs, damaged structures, and uncertain reading order produce warnings and placeholders. The library must not silently drop content or emit plausible but incorrect text.

### 5.4 Optimize the complete pipeline

Responsiveness includes time to first useful page, total conversion time, memory use, and main-thread work. The library should stream usable page results instead of waiting for the entire document.

### 5.5 Keep the core independent

PDF parsing, content interpretation, reconstruction, and rendering are separate modules. The core parser must not import React or application-specific code.

## 6. High-level architecture

```text
Host application
    |
    | File/Blob/ArrayBuffer + options
    v
Worker client
    |
    | transferable input buffer
    v
Parser worker
    +-- header, xref, trailer, and object resolution
    +-- stream and object-stream decoding
    +-- catalog and page-tree traversal
    +-- resource, font, CMap, and image caches
    +-- content-stream interpretation
    +-- structure-tree and MCID resolution
    +-- geometry fallback and semantic reconstruction
    +-- incremental page and asset results
    |
    | progress, page batches, warnings, timings
    v
Host renderer
    +-- optional library HTML renderer
    +-- or application-specific React/components
```

## 7. Proposed portable folder

```text
pdf-content-extractor/
  index.ts
  client.ts
  worker.ts
  protocol.ts
  types.ts
  parser/
    bytes.ts
    lexer.ts
    objects.ts
    xref.ts
    document.ts
    pages.ts
    streams.ts
  content/
    lexer.ts
    graphics-state.ts
    text-state.ts
    interpreter.ts
  fonts/
    encodings.ts
    cmap.ts
    metrics.ts
  images/
    extract.ts
    colorspaces.ts
    predictors.ts
    masks.ts
  structure/
    tagged.ts
    geometry.ts
    blocks.ts
    tables.ts
  renderers/
    html.ts
  errors.ts
  README.md
```

Module names may change during implementation, but the dependency direction is fixed: lower-level parsing modules cannot depend on semantic reconstruction, rendering, React, or the demo application.

## 8. Processing pipeline

### 8.1 Input and validation

1. Validate the PDF header and input size.
2. Transfer an `ArrayBuffer` to the worker rather than cloning it.
3. Apply configurable safety limits before recursively resolving objects or decoding streams.

### 8.2 Object resolution

The first supported parser version must handle:

- Traditional cross-reference tables.
- Cross-reference streams.
- Compressed object streams.
- Linked xref sections through `/Prev`.
- Linearized documents.
- Indirect references and indirect stream lengths.
- Multi-level page trees.
- Flate-compressed streams.

Objects are resolved by xref lookup. The implementation must not repeatedly scan the entire file for individual objects.

### 8.3 Page and resource processing

Page resources inherit through the page tree. Fonts, CMaps, color spaces, and image assets are cached by indirect reference and shared across pages.

Only objects reachable from the catalog and requested pages are decoded.

### 8.4 Text interpretation

The content interpreter maintains the graphics state, current transformation matrix, text matrix, line matrix, font, font size, character spacing, word spacing, horizontal scaling, leading, and text rise.

Initial text operators include:

- `BT`, `ET`
- `Tf`
- `Tm`, `Td`, `TD`, `T*`
- `Tj`, `TJ`, `'`, `"`
- `Tc`, `Tw`, `Tz`, `TL`, `Ts`
- `q`, `Q`, `cm`
- `BDC`, `BMC`, `EMC`
- `Do` for placed XObjects

Text strings are decoded using this priority:

1. A font's `/ToUnicode` CMap.
2. Declared standard encoding and encoding differences.
3. Supported CID mapping behavior.
4. An explicit unknown-glyph marker and warning.

Text fragments retain coordinates, advances, page number, source reference, marked-content ID, and enough font metrics to reconstruct spaces and lines. Output styling does not retain the source font family.

### 8.5 Semantic reconstruction

For tagged PDFs:

1. Resolve the structure tree and parent tree.
2. Map marked-content IDs to extracted page content.
3. Use tags for headings, paragraphs, lists, list items, tables, cells, figures, captions, references, and TOC entries.
4. Use geometry to order and combine fragments within each semantic element.
5. Exclude content marked as pagination artifacts unless explicitly requested.

For untagged or partially tagged PDFs:

1. Group fragments into lines using baseline and font-metric tolerances.
2. Infer spaces from glyph advances and horizontal gaps.
3. Group lines using indentation, vertical spacing, and alignment.
4. Detect headings, paragraphs, lists, and tables using conservative heuristics.
5. Attach confidence and warnings when reading order is ambiguous.

### 8.6 Tables

Tables are preserved semantically as rows and cells. The host application owns all table styling.

Tagged table roles are preferred. Geometry-based detection is a fallback and should be conservative because incorrectly merging unrelated columns is worse than returning separate blocks.

### 8.7 Images and charts

Image placement is captured from the `Do` operator and active transformation matrix.

Initial image support will prioritize:

1. `DCTDecode` JPEG streams passed through without recompression.
2. Flate-compressed device-gray and RGB images.
3. PDF PNG predictors.
4. Image masks, soft masks, and common transparency cases.
5. Conversion of decoded pixels to PNG using worker-compatible browser APIs where supported.

The document model retains image bytes, dimensions, page placement, caption association, and available alternative text. Unsupported image encodings produce a placeholder and warning.

Vector graphics are not initially reconstructed as SVG. Text near or within vector artwork may still be extracted as text if it appears in the page content stream.

## 9. Public document model

The exact field set may evolve, but these are the intended public concepts:

```ts
export interface ParsedDocument {
  metadata: DocumentMetadata;
  pages: DocumentPage[];
  outline: OutlineItem[];
  assets: DocumentAsset[];
  warnings: ParseWarning[];
  timings: ParseTimings;
}

export interface DocumentPage {
  pageNumber: number;
  width: number;
  height: number;
  blocks: DocumentBlock[];
  warnings: ParseWarning[];
}

export type DocumentBlock =
  | HeadingBlock
  | ParagraphBlock
  | ListBlock
  | TableBlock
  | FigureBlock
  | UnknownBlock;

export interface DocumentImage {
  id: string;
  pageNumber: number;
  width: number;
  height: number;
  mimeType: "image/jpeg" | "image/png";
  bytes: Uint8Array;
  altText?: string;
  caption?: DocumentBlock[];
}
```

Public types should prefer stable semantic concepts over raw PDF implementation details. Diagnostic source information may be exposed through optional fields or a debug mode.

## 10. Public worker API

Proposed usage:

```ts
const parser = createPdfParser();

const result = await parser.parse(file, {
  preserveImages: true,
  onPage(page) {
    renderAvailablePage(page);
  },
  onProgress(progress) {
    updateProgress(progress);
  },
});

parser.dispose();
```

Required client behavior:

- Worker creation and disposal.
- Transferable input and asset buffers.
- Incremental page delivery.
- Progress events with named phases.
- Cooperative cancellation.
- Fatal errors separated from recoverable warnings.
- No React dependency.

The integration README will document the expected worker URL construction for the target bundler. The oldest supported browser and bundler used by the work application remain environment inputs to confirm.

## 11. Performance requirements

Performance is a product requirement, not a later optimization pass.

The implementation will:

- Keep parsing and image conversion off the main thread.
- Transfer rather than clone large buffers.
- Use indexed random access through xref data.
- Use `Uint8Array` views rather than copying byte ranges unnecessarily.
- Decode objects, streams, fonts, and images lazily.
- Cache shared resources by indirect reference.
- Return pages incrementally in small batches.
- Avoid duplicating document caches across multiple workers.
- Allow cancellation between bounded units of work.
- Record phase timings and peak-size diagnostics where practical.

Performance acceptance thresholds will be established from benchmarks on the three sample files and representative work hardware. At minimum, tests will measure:

- Worker startup time.
- Time to first parsed page.
- Total parse time.
- Image extraction time.
- Peak observed memory or large allocated-buffer totals.
- Main-thread responsiveness during conversion.

No fixed millisecond target is asserted until a reproducible benchmark harness and target hardware/browser baseline exist.

## 12. Safety and failure behavior

PDFs are untrusted input even when they come from a standardized source.

The parser will impose configurable limits for:

- Input size.
- Object count.
- Object-stream expansion.
- Decoded stream size and compression ratio.
- Reference and page-tree depth.
- Content operation count per page.
- Image dimensions and decoded pixel count.
- CMap size and mapping count.

The parser will not evaluate actions or scripts. Text passed to the HTML renderer will be escaped, and link protocols will be allowlisted.

Fatal structural failures reject the parse with a typed error. Local failures, such as one unsupported image or glyph, remain page/document warnings and allow other content to continue.

## 13. HTML renderer

The optional renderer emits semantic, minimally decorated HTML such as:

```html
<article>
  <section data-page="1">
    <h1>Document title</h1>
    <p>Reconstructed content...</p>
    <table>
      <thead>...</thead>
      <tbody>...</tbody>
    </table>
    <figure>
      <img alt="...">
      <figcaption>...</figcaption>
    </figure>
  </section>
</article>
```

The renderer will not emit source font styles or application-specific class names by default. Renderer hooks or options may allow the host application to add classes, IDs, and asset URLs.

Image object URLs are owned by the host or by a disposable renderer result. Ownership and cleanup must be explicit to prevent memory leaks.

## 14. Testing strategy

### 14.1 Test layers

- Unit tests for byte reading, lexing, PDF values, xref formats, stream filters, CMaps, encodings, operators, and geometric grouping.
- Focused fixture PDFs constructed to exercise one feature at a time.
- Golden semantic-model tests for representative pages.
- Full-corpus integration tests for the supplied documents.
- Performance regression benchmarks.
- Malformed-input and safety-limit tests.

### 14.2 Corpus expectations

The three current samples are initial acceptance fixtures, not the complete compatibility contract. Additional department variants should be added as they become available, especially when they expose a new warning or failure.

Large binary PDFs should not be duplicated in multiple test locations.

### 14.3 Validation approach

Validation should compare semantic results rather than exact PDF drawing operations. Representative assertions include:

- Known headings and paragraphs appear once and in order.
- Repeating artifacts do not appear in body content.
- List nesting and table cell relationships are retained.
- Known images are extracted and attached to the correct page.
- Page processing continues after a recoverable asset error.
- Unknown glyphs and unsupported features produce warnings.

## 15. Observability and debugging

Development builds should support optional diagnostics for:

- Object and xref resolution.
- Page resource inheritance.
- Extracted text runs and coordinates.
- MCID and structure-element mappings.
- Geometry decisions and confidence.
- Image dictionaries and decoding stages.
- Per-phase and per-page timings.

Diagnostics must be disabled or inexpensive by default.

## 16. Integration documentation requirements

The library README must explain:

- Required browser and TypeScript capabilities.
- Copying the library folder into an application.
- Worker construction for the supported bundler.
- Parsing `File`, `Blob`, and `ArrayBuffer` inputs.
- Incremental rendering, progress, cancellation, and disposal.
- Rendering the semantic model directly.
- Using the optional HTML renderer.
- Creating and revoking image object URLs.
- Supported and unsupported PDF features.
- Error and warning handling.
- Safety-limit configuration.
- Performance guidance.
- Updating the copied library folder without mixing host-specific code into it.

## 17. Initial acceptance criteria

The first complete vertical slice is successful when it can:

1. Run through the public worker client without blocking the demo UI.
2. Parse both traditional xref tables and the xref/object streams in the supplied corpus.
3. Traverse every page in all three samples.
4. Decode representative text using the samples' Unicode maps and encodings.
5. Reconstruct readable lines and paragraphs from fragmented `Tj` and `TJ` operations.
6. Exclude marked pagination artifacts.
7. Recover tagged headings, lists, tables, and figures from representative pages.
8. Use geometric fallback for the untagged sample.
9. Extract directly reusable JPEG images and report unsupported image cases.
10. Deliver pages incrementally with progress, cancellation, warnings, and timings.
11. Render safe semantic HTML using host-independent markup.
12. Pass a reproducible benchmark without observable main-thread lockup.
13. Be usable after copying the library folder according to its README.

## 18. Delivery sequence

Implementation should proceed in vertical, testable layers:

1. Public types, worker protocol, cancellation, and benchmark harness.
2. Byte reader, lexer, PDF values, traditional xref, and object resolution.
3. Xref streams, object streams, Flate decoding, and linearized-document handling.
4. Catalog/page traversal and resource inheritance.
5. Content interpreter, text state, font encodings, and CMaps.
6. Text-run geometry and readable line/paragraph reconstruction.
7. Structure-tree/MCID mapping and artifact removal.
8. Lists, tables, figures, outline, and link semantics.
9. JPEG pass-through and remaining prioritized image decoding.
10. HTML renderer, integration README, safety hardening, and performance tuning.

This sequence is a design-level dependency order, not yet the final ticket plan. Tickets should be small enough for independent review while each milestone retains an executable test or observable outcome.

## 19. Open decisions

The following do not change the core design but must be confirmed before compatibility work is complete:

- Oldest browser versions supported by the work application.
- Bundler and worker-loading conventions in the work application.
- Whether the host wants source page boundaries visible or only retained as metadata.
- Whether unsupported images should be shown as placeholders by the default renderer.
- Desired handling of internal PDF links and external URLs.
- Concrete performance targets and representative work hardware.

## 20. Decision summary

- **Output:** Semantic document model first; optional HTML renderer second.
- **Styling:** Entirely owned by the host application.
- **Execution:** Browser-side dedicated Web Worker.
- **Dependencies:** No third-party runtime dependencies.
- **Distribution:** Copyable TypeScript folder with integration README.
- **Document scope:** Robust support for a standardized family, not every possible PDF.
- **Reading order:** Tagged structure first, geometry fallback second.
- **Tables:** Preserve semantic rows and cells.
- **Figures:** Preserve supported raster images and captions; warn on unsupported cases.
- **Performance:** Incremental, lazy, cached, transferable, benchmarked from the start.
- **Failure policy:** Typed fatal errors plus recoverable warnings; never silently discard uncertain content.
- **Search:** PostgreSQL-native lexical search with bounded query expansion, deterministic ranking, and no required extensions or external search service.

## 21. Search quality design

### 21.1 Objective and constraints

Search should help a user find specific information without already knowing
which document contains it. It does not attempt to reproduce Google or provide
AI-generated answers. The target is a strong, predictable document search that
remains inexpensive for tens of documents and continues to work well for
thousands.

The search implementation must:

- Use PostgreSQL's built-in full-text search and GIN indexes.
- Require no PostgreSQL extensions or external search service.
- Preserve technical codes, acronyms, hyphenated identifiers, and exact terms.
- Keep query work bounded by explicit input, expansion, candidate, and result
  limits.
- Return plain text and structured metadata; the frontend owns escaping and
  highlighting.
- Keep portable record generation independent of PostgreSQL and the Node host.

### 21.2 Query interpretation and fallback ladder

The server normalizes whitespace and Unicode consistently, then executes the
least permissive useful interpretation first:

1. Exact quoted phrases and safe web-style operators through parameterized
   `websearch_to_tsquery`.
2. All normalized terms, with phrase/proximity signals used for ranking.
3. Safe final-term prefix matching for incomplete words.
4. A bounded partial-match fallback when the strict query returns too few
   useful results.
5. Synonym expansion and typo suggestions only when ordinary matching is weak
   or empty.

Supported user syntax may include quoted phrases, `OR`, and excluded terms.
Raw user text must never be concatenated into SQL or raw `tsquery` syntax.
Prefix expressions are constructed only from server-tokenized, validated terms
and remain parameterized. Empty, excessively long, or expansion-heavy queries
are rejected or reduced safely.

### 21.3 Ranking

Ranking combines several deterministic lexical signals:

- Document title and current section heading: highest structural weight.
- Heading path, table header, and row header: strong contextual weight.
- List items, captions, and ordinary body text: normal content weight.
- Exact phrase and ordered-near matches: explicit boosts.
- Coverage of distinct query terms: favors results answering the complete
  query.
- Prefix, synonym, and partial matches: lower than direct matches.
- Length normalization: prevents very large paragraphs from dominating solely
  through repeated words.

Results must use stable tie-breaking so the same index and query produce the
same order. Ranking constants live in one documented server module rather than
being scattered through SQL and UI code.

### 21.4 Dual native indexes and technical normalization

Two native PostgreSQL vectors provide complementary behavior:

- A `simple` vector preserves technical vocabulary, codes, and exact word forms.
- An `english` vector provides stemming for ordinary language, such as matching
  `inspect`, `inspected`, and `inspection` where PostgreSQL considers them
  related.

Both vectors use GIN indexes. Direct matches from the technical vector retain
priority over stemmed-only matches.

At indexing time, a bounded normalizer may add deterministic variants for
technical identifiers, for example `A-12`, `A12`, and `A 12`. It must not create
unbounded combinations or mutate the displayed source text. Normalized search
text is an indexing aid; snippets always come from the original semantic text.

### 21.5 Snippets and result grouping

The API returns a concise match-centered excerpt rather than an entire large
semantic block. Snippet generation finds the best matching occurrence, includes
bounded surrounding context, normalizes display whitespace, and returns plain
text plus matched terms or ranges. The frontend escapes all text before adding
highlight markup.

Adjacent matches from the same section may be grouped when they represent the
same answer context. Grouping must not hide materially different matches. A
single document receives a configurable per-document result cap so one long
document cannot crowd every other document out of the first page of results.

### 21.6 Synonyms and typo assistance

Domain synonyms are maintained in a small versioned configuration file. Query
expansion is directional, deduplicated, capped, and visible in diagnostics. An
exact/direct match always ranks above a synonym-only match.

Without `pg_trgm`, typo handling is suggestion-based rather than a full fuzzy
scan. A compact vocabulary of titles, headings, technical tokens, and useful
content terms is maintained during indexing. Bounded edit distance runs only
when normal search is empty or weak and considers candidates with compatible
length and prefix characteristics. The UI tells the user when it is suggesting
or searching for a corrected term.

### 21.7 Titles, metadata, filters, and suggestions

PDF metadata is evidence, not guaranteed display truth. Title selection uses a
document-family-aware priority order:

1. A valid explicit/admin title when supplied by the host.
2. A credible PDF metadata title.
3. A high-confidence first-page semantic heading.
4. A cleaned original filename.

Known boilerplate such as `BY ORDER OF THE` is not accepted as a high-confidence
display title by itself. The semantic model preserves raw metadata separately
from the chosen display title and records title source/confidence so the host may
override it without reparsing.

Search filters may include document, page, section, and semantic block type.
Autocomplete is limited to document titles, section headings, and high-value
technical terms. It uses indexed prefix lookup and never scans full document
content on each keystroke.

### 21.8 Performance, safety, and observability

- All normal search paths use indexed predicates.
- Query length, term count, prefix expansion, synonym expansion, typo candidates,
  per-document results, and total results have explicit limits.
- The UI debounces or explicitly submits searches and cancels stale requests.
- Search responses expose enough development diagnostics to explain match type
  and score components without exposing SQL or sensitive server details.
- Benchmarks record strict-query, phrase, prefix, fallback, and no-result latency
  against the real corpus and deterministic synthetic thousands-document data.
- Query caching is optional and must be justified by measurements; it is not a
  prerequisite for the expected collection size.

### 21.9 Deferred capabilities

The following remain out of scope unless the host application's constraints
change: `pg_trgm`, Elasticsearch/OpenSearch, embeddings, vector search,
AI-generated answers, relevance learning from user behavior, and unrestricted
fuzzy matching.

### 21.10 Search quality acceptance

The completed search-quality layer must demonstrate:

- Exact phrase, web-style, prefix, partial, technical-code, stemmed-language,
  synonym, and typo-suggestion behavior with deterministic ranking.
- Short safe snippets and useful grouping across multiple documents.
- Correct HTML-block and original-PDF page navigation from every result.
- A credible display title for each supplied sample or an explicit low-confidence
  filename fallback.
- Indexed query plans and recorded latency on a synthetic thousands-document
  collection without requiring PostgreSQL extensions.
