# PDF to HTML

> New machine or demo setup: start with
> [`GETTING_STARTED.md`](GETTING_STARTED.md).

A React/Vite host application that will eventually convert long, standardized
workplace PDFs into structured, host-styleable content using a dependency-free
library. See [`docs/DESIGN.md`](docs/DESIGN.md) for the product and
architecture authority and [`docs/TICKETS.md`](docs/TICKETS.md) /
[`tickets/`](tickets/) for the delivery backlog.

The searchable document-library follow-up backlog is defined in
[`docs/SEARCH_TICKETS.md`](docs/SEARCH_TICKETS.md), including the PostgreSQL
and Node integration, local React test frontend, search UX, and main-app
AI-agent handoff.

Robust extension-free search improvements are specified in
[`docs/DESIGN.md`](docs/DESIGN.md#21-search-quality-design) and tracked as
Epic H, TKT-030 through TKT-037.

The library itself lives at
[`src/pdf-content-extractor/`](src/pdf-content-extractor/README.md) as a
single, self-contained, copyable TypeScript folder with no third-party
runtime dependencies. Read its README for what it is and how it is meant to
be integrated.

## App development

```
npm install
npm run dev      # start the Vite dev server
npm run server   # start the local document API on http://localhost:3001
npm run build    # tsc -b type-check + production build
npm run preview  # preview the production build
```

The React app is the Epic G local document-library harness: upload or
drag/drop PDFs, parse them through the public worker API, import artifacts
through the Node API, list persisted documents, switch between semantic HTML
and original PDF views, delete documents, and search title/body records with
direct HTML/PDF navigation.

## Complete Docker demo

The React app, Node API, migrations, PostgreSQL database, and persistent
document storage can run as one Docker Compose project:

```powershell
npm run demo:up
```

Then open <http://localhost:5173>. This is the recommended workflow on a demo
machine after cloning the GitHub repository. See
[`DOCKER_DEMO.md`](DOCKER_DEMO.md) for setup, persistence, logs, configurable
ports, and optional offline image export/import.

## Local PostgreSQL

The host test app has an isolated PostgreSQL service for the upcoming shared
document-search work. It stores document metadata and searchable semantic
blocks; original PDFs and semantic JSON remain in the ignored
`storage/documents/` folder.

```powershell
npm run db:up
npm run db:migrate
npm run db:smoke
npm run db:status
npm run db:shell
npm run db:down
```

Docker Desktop is the only local prerequisite and is not a dependency of the
portable extractor. See [`database/README.md`](database/README.md) for the
connection string, schema, storage layout, and migration behavior.

## Testing and benchmarking the library

Test and benchmark tooling lives under `test/`, outside the portable library
folder, so copying `src/pdf-content-extractor/` alone never pulls in test
dependencies.

| Command | What it runs |
| --- | --- |
| `npm run test:unit` | Fast unit tests (`test/unit/**`) — protocol, client/worker wiring, cancellation, disposal, error serialization, library boundary checks, main-thread responsiveness. No disk or PDF I/O. |
| `npm run test:integration` | `test/integration/**` — resolves the three sample PDFs from their single canonical location (`src/example_documents/`) and runs each through the real worker protocol end to end, the object engine directly (page-tree traversal), and the Epic C content/font/geometry/structure/block pipeline directly (`pipeline.ts`). Fails loudly, per file, if a canonical sample is missing. |
| `npm run bench` | `test/bench/run.ts`, executed via `vite-node` — reports worker/client round-trip timing, phase timings, transferred byte totals, and a main-thread responsiveness measurement, as JSON (`test/bench/results.json`) and a console table. |
| `npm run typecheck:test` | Type-checks `test/` and the library folder against `tsconfig.test.json` (kept separate from the app's `tsc -b` so Node-only types used by tests never leak into the browser library's type-checking scope). |
| `npm run typecheck:server` | Type-checks the local Node document lifecycle, storage, PostgreSQL adapter, migration runner, and API under `server/`. |

All three suites are implemented with [Vitest](https://vitest.dev), which
this project already depends on for `vite`-native TypeScript execution — no
separate test runner or transpilation step was introduced.

### Current status (Epic A through Epic F)

The foundation and worker protocol spine (Epic A), the PDF object engine
(Epic B — see [`tickets/epics/EPIC-B.md`](tickets/epics/EPIC-B.md)), and text
and semantic extraction (Epic C — see
[`tickets/epics/EPIC-C.md`](tickets/epics/EPIC-C.md)) are implemented.

- The object engine (`src/pdf-content-extractor/parser/`) can open a PDF,
  resolve indirect objects through traditional xref tables and xref streams
  (including compressed object streams and hybrid-reference files), decode
  Flate/predictor streams, and traverse the full page tree with inherited
  attributes — verified against all three sample documents, including their
  exact page counts (38, 76, 1).
- `content/`, `fonts/`, and `structure/` interpret a page's content stream
  into positioned text (graphics/text state, marked content, MCIDs,
  artifacts), decode it to Unicode (`/ToUnicode` CMaps, WinAnsi/PDFDocEncoding
  and `/Differences`, Identity-H CID fonts), reconstruct readable lines and
  paragraphs geometrically (page-rotation-aware), resolve the tagged
  structure tree and map MCIDs to it, and build the public semantic block
  model — headings, paragraphs, lists, tables, figures, an outline, and safe
  internal/external links. `pipeline.ts` composes all of it per page and per
  document. Verified against all three samples: real section/chapter
  headings, tagged tables and lists, figure alt text, and a resolved
  9/31-entry outline for the two tagged samples, plus a working geometry
  fallback for the untagged one-page sample.

`createPdfParser().parse()`'s public result is still unchanged from Epic A:
it resolves to a typed placeholder `ParsedDocument` (empty pages, a single
`not-implemented` warning), since `pipeline.ts` is deliberately not yet wired
into `worker.ts` — that final integration (plus image byte extraction, Epic
D) is later work, kept out of this Epic C slice on purpose. Integration and
benchmark output through the worker protocol reflect that honestly: page
counts are `0` and "decoded byte totals" are reported as the transferred
input byte count, not real decoded content. Real Epic C output is exercised
directly (not through the worker) by
`test/integration/epic-c-sample-corpus.integration.test.ts`, which
`npm run test:integration` already runs.

Current status: `createPdfParser().parse()` now runs the real worker pipeline
for object resolution, page traversal, semantic reconstruction, asset
extraction, incremental page delivery, progress, cancellation, warnings, and
timings.

Epic F adds the searchable semantic foundation: structural safe anchors,
`generateDocumentSearchRecords()`, host-side staged filesystem persistence
under `storage/documents/{documentId}/`, migration-backed PostgreSQL
documents/search blocks, and the reference Node import/list/load/delete/search
API in `server/`. PostgreSQL, filesystem, Docker, and API code remain outside
`src/pdf-content-extractor/`.

Epic G adds the local search experience and main-app handoff. Run
`npm run test:e2e` for the lifecycle/search regression slice; PostgreSQL
coverage inside that command runs when `RUN_LOCAL_DB_TESTS=1` or
`DATABASE_URL` is set. The dedicated AI-agent integration guide is
[`docs/MAIN_APP_AI_AGENT_INTEGRATION_GUIDE.md`](docs/MAIN_APP_AI_AGENT_INTEGRATION_GUIDE.md).
