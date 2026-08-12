/**
 * Full-corpus integration test (TKT-003). Resolves the three sample PDFs
 * from their single canonical location (`src/example_documents/`) and runs
 * them through the real client/worker protocol end to end.
 *
 * Epic A ships no PDF parsing (that begins in Epic B, TKT-004+), so this
 * test cannot yet assert the page counts from docs/DESIGN.md section 4 —
 * `sampleCorpus[].expectedPageCount` is recorded for later tickets to
 * assert against once traversal exists (see TKT-008). What this test does
 * verify now: every sample file is resolvable from disk, transfers through
 * the worker protocol as its full byte length, and comes back as a valid
 * (placeholder) ParsedDocument with no fatal error.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createPdfParser } from "../../src/pdf-content-extractor/client.ts";
import { createWorkerHandler } from "../../src/pdf-content-extractor/worker.ts";
import { checkSampleAvailability } from "../fixtures/sample-corpus.ts";
import { createChannelWorkerPair } from "../fixtures/message-channel-worker.ts";
import { toSemanticSnapshot } from "../fixtures/semantic-snapshot.ts";
import { isBoilerplateTitle, selectDocumentTitle } from "../../src/title-selection.ts";

describe("sample corpus integration", () => {
  const availability = checkSampleAvailability();

  for (const entry of availability) {
    const { fixture } = entry;

    if (!entry.available) {
      it(`BLOCKER: missing canonical sample fixture ${fixture.fileName} at ${fixture.path}`, () => {
        throw new Error(
          `Expected sample PDF at canonical path ${fixture.path} but it was not found. ` +
            "Add the file to src/example_documents/ (see docs/DESIGN.md section 4) before running integration tests.",
        );
      });
      continue;
    }

    it(`parses ${fixture.fileName} through the real worker protocol without a fatal error`, async () => {
      const bytes = readFileSync(fixture.path);
      const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

      const pair = createChannelWorkerPair();
      createWorkerHandler(pair.workerScope);
      const parser = createPdfParser({ workerFactory: () => pair.client });

      const phases: string[] = [];
      const document = await parser.parse(arrayBuffer, {
        onProgress: (progress) => phases.push(progress.phase),
      });

      expect(document.timings.inputBytes).toBe(bytes.byteLength);
      expect(document.metadata.pageCount).toBe(fixture.expectedPageCount);
      expect(document.pages).toHaveLength(fixture.expectedPageCount);
      expect([...new Set(phases)]).toEqual(["initializing", "reading-input", "parsing", "finalizing"]);
      expect(document.warnings.some((warning) => warning.code === "not-implemented")).toBe(false);

      expect(toSemanticSnapshot(document)).toMatchSnapshot();

      parser.dispose();
    });
  }

  // TKT-036: real-corpus assertions for title selection (docs/DESIGN.md
  // section 21.7). qtp1s0x1-1.pdf is the documented `BY ORDER OF THE`
  // failure -- its PDF `/Info` Title metadata is literally that boilerplate
  // string (see test/integration/__snapshots__/sample-corpus.integration.
  // test.ts.snap), and its cover page has no heading-type block, so
  // selection must fall all the way through to the cleaned filename rather
  // than surface the boilerplate.
  describe("title selection over the real corpus", () => {
    for (const entry of availability) {
      if (!entry.available) continue;
      const { fixture } = entry;

      it(`selects a stable, non-boilerplate title for ${fixture.fileName}`, async () => {
        const bytes = readFileSync(fixture.path);
        const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        const pair = createChannelWorkerPair();
        createWorkerHandler(pair.workerScope);
        const parser = createPdfParser({ workerFactory: () => pair.client });
        const document = await parser.parse(arrayBuffer, {});
        parser.dispose();

        const selection = selectDocumentTitle({
          pdfMetadataTitle: document.metadata.title,
          firstPageBlocks: document.pages[0]?.blocks ?? [],
          originalFilename: fixture.fileName,
        });

        // Never known standalone boilerplate, regardless of which tier won.
        expect(isBoilerplateTitle(selection.title)).toBe(false);
        expect(selection.title.length).toBeGreaterThan(0);
        expect(["pdf-metadata", "first-page-heading", "filename"]).toContain(selection.source);

        // Repeated selection over the same extracted data is deterministic.
        const repeated = selectDocumentTitle({
          pdfMetadataTitle: document.metadata.title,
          firstPageBlocks: document.pages[0]?.blocks ?? [],
          originalFilename: fixture.fileName,
        });
        expect(repeated).toEqual(selection);
      });
    }

    it("rejects qtp1s0x1-1.pdf's literal 'BY ORDER OF THE' PDF metadata title and falls back to the filename", async () => {
      const fixture = availability.find((entry) => entry.fixture.fileName === "qtp1s0x1-1.pdf");
      if (!fixture?.available) return;
      const bytes = readFileSync(fixture.fixture.path);
      const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const pair = createChannelWorkerPair();
      createWorkerHandler(pair.workerScope);
      const parser = createPdfParser({ workerFactory: () => pair.client });
      const document = await parser.parse(arrayBuffer, {});
      parser.dispose();

      // Confirms the documented failure condition still exists in the
      // sample: raw PDF metadata really is the boilerplate string.
      expect(document.metadata.title).toBe("BY ORDER OF THE");

      const selection = selectDocumentTitle({
        pdfMetadataTitle: document.metadata.title,
        firstPageBlocks: document.pages[0]?.blocks ?? [],
        originalFilename: "qtp1s0x1-1.pdf",
      });
      expect(selection.source).not.toBe("pdf-metadata");
      expect(selection.title).not.toMatch(/by order of the/i);
      expect(selection.title).toBe("Qtp1s0x1 1");
      expect(selection.source).toBe("filename");
    });
  });
});
