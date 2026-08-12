# pdf-content-extractor

Dependency-free, browser-side PDF-to-semantic-content library. Copy this whole
folder into a TypeScript application and import only from `index.ts`.

The library has no third-party runtime dependencies and no React dependency.
Parsing runs in a dedicated Web Worker through `createPdfParser()`.

## Requirements

- Modern browser worker support for module workers.
- `ArrayBuffer`, `Blob`, `URL`, `ReadableStream`, `DecompressionStream`, and
  `CompressionStream`.
- TypeScript with DOM library types enabled.
- A bundler that can construct a worker from a module URL. This repository uses
  Vite:

```ts
new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
```

Other bundlers may require a worker-loader entry, emitted worker URL, or a
different import convention. Keep that bundler-specific code in `client.ts` or
inject a `workerFactory`; do not add host application code elsewhere in this
folder.

## Install By Copying

1. Copy `src/pdf-content-extractor/` into the host app, preserving the folder
   structure.
2. Import public APIs from `./pdf-content-extractor/index.ts`.
3. Confirm the host bundler supports `new Worker(new URL("./worker.ts",
   import.meta.url), { type: "module" })`.
4. Run the host app's type-check and production build.

To upgrade, replace the copied folder as a unit. Keep host-specific UI,
styles, and app adapters outside the folder so upgrades do not require merging
application code into parser code.

## Parse A PDF

```ts
import { createPdfParser } from "./pdf-content-extractor/index.ts";

const parser = createPdfParser();

const result = await parser.parse(file, {
  preserveImages: true,
  onProgress(progress) {
    console.log(progress.phase, progress.pagesCompleted, progress.totalPages);
  },
  onPage(page) {
    console.log("incremental page", page.pageNumber, page.blocks.length);
  },
});

parser.dispose();
```

`parse()` accepts `File`, `Blob`, or `ArrayBuffer`. Input buffers are
transferred to the worker. Do not reuse an `ArrayBuffer` after passing it to
`parse()`.

## Cancellation And Disposal

```ts
const controller = new AbortController();
const promise = parser.parse(file, { signal: controller.signal });
controller.abort();
await promise; // rejects with PdfParseCancelledError

parser.dispose(); // terminates the worker
```

Create a fresh parser after disposal.

## Rendering

Applications may render `ParsedDocument.pages[].blocks` directly. The optional
safe HTML renderer emits semantic markup without PDF font-family styling or
source layout CSS:

```ts
import {
  createObjectUrlResolver,
  renderDocumentToHtml,
} from "./pdf-content-extractor/index.ts";

const urls = createObjectUrlResolver(result.assets);
const html = renderDocumentToHtml(result, {
  resolveAssetUrl: urls.resolveAssetUrl,
  renderUnsupportedImages: true,
});

container.innerHTML = html;
urls.cleanup();
```

`renderDocumentToHtml()` escapes all text and attributes. External links are
restricted to `http:`, `https:`, and `mailto:` by default; unsafe links render
as plain text. Internal links render as page anchors.

Object URLs are owned by the resolver or host application. Always call
`cleanup()` when a result is replaced or a component unmounts.

## Stable Anchors And Search Records

Every emitted semantic block ID is deterministic, safe for an HTML `id`
attribute, and based on structural emission order rather than extracted text.
Rendered HTML includes anchors plus `data-page` and, when known,
`data-section` metadata for searchable locations. Table cells also receive
stable cell IDs so search results can navigate directly to a cell.

Build portable search records with the pure helper after parsing:

```ts
import { generateDocumentSearchRecords } from "./pdf-content-extractor/index.ts";

const records = generateDocumentSearchRecords(result, {
  documentId: "doc-1",
  documentTitle: result.metadata.title ?? "Untitled document",
});
```

`DocumentSearchRecord` values are deterministic, JSON-serializable, and
structured-cloneable. They include document title, section/block IDs, heading
path, one-based PDF page number, block type, searchable text, and table
row/column context when available. The helper performs no SQL, ranking,
stemming, snippets, embeddings, or host application work.

## Supported PDF Features

- Traditional xref tables, xref streams, compressed object streams, and linked
  xref sections.
- Page-tree traversal with inherited resources.
- Flate content streams and supported PDF PNG/TIFF predictors.
- Unicode text extraction through supported font encodings and ToUnicode CMaps.
- Tagged headings, paragraphs, lists, tables, figures, captions, outline, and
  safe links, with geometry fallback for untagged pages.
- Image XObjects referenced by `Do` events:
  - Direct `DCTDecode` JPEG pass-through.
  - DeviceGray and DeviceRGB Flate images with 8-bit components.
  - Common soft-mask alpha images when dimensions and bit depth match.

Unsupported image encodings, color spaces, bit depths, masks, or missing
browser compression APIs produce recoverable warnings and keep document text.

## Warnings, Limits, And Timings

Recoverable issues appear in `ParsedDocument.warnings` and per-page
`DocumentPage.warnings`. Fatal structural failures reject `parse()` with
`PdfParseError`.

Safety limits are configurable:

```ts
await parser.parse(file, {
  limits: {
    maxImageDimensionPx: 12000,
    maxImagePixelCount: 24000000,
  },
});
```

`ParsedDocument.timings` includes total time, phase timings, input bytes,
image bytes, JPEG pass-through time, Flate image decode time, and PNG encode
time. Detailed phase timings may include xref/object resolution, page-tree
traversal, page content decoding, font decoding, page content interpretation,
structure reconstruction, image extraction, message transfer, and rendering.
`largeBufferBytes` and `transferredAssetBytes` report the large buffers observed
by the worker result path.

## Performance Baselines

Run the supplied corpus benchmark with:

```sh
npm run bench
```

The harness runs each available sample three times by default and writes
`test/bench/results.json` with runtime details, time to first page, total time,
phase timings, transferred asset bytes, large-buffer totals, and responsiveness
probe results. Use `PDF_BENCH_RUNS=5 npm run bench` for a longer local sample.

Representative work hardware, target browsers, and final product performance
budgets are still host-application inputs. Until those are supplied, use the
current-machine baseline mode for regression checks:

```sh
Copy-Item test/bench/results.json test/bench/results.baseline.json
$env:PDF_BENCH_COMPARE_BASELINE='1'; npm run bench
```

When comparison is enabled, a sample fails clearly if its `maxTotalMs` exceeds
175% of the recorded current-machine baseline. Replace that tolerance with
agreed product budgets once representative hardware and browser targets are
known.

## Keep The Boundary Clean

This folder is portable library code. It should not import React, app CSS,
demo components, or host-specific services. Keep demo and application rendering
outside this folder, importing only from `index.ts`.
