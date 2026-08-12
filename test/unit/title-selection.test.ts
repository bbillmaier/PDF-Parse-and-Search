import { describe, expect, it } from "vitest";
import {
  applyTitleSelection,
  cleanFilenameForTitle,
  DEFAULT_TITLE_BOILERPLATE_RULES,
  FILENAME_TITLE_CONFIDENCE,
  FIRST_PAGE_HEADING_CONFIDENCE,
  HOST_TITLE_CONFIDENCE,
  isBoilerplateTitle,
  isWellFormedTitleCandidate,
  PDF_METADATA_TITLE_CONFIDENCE,
  selectDocumentTitle,
  type TitleSelectionInput,
} from "../../src/title-selection.ts";
import type { DocumentBlock, ParsedDocument } from "../../src/pdf-content-extractor/index.ts";

function heading(text: string, level: 1 | 2 = 1): DocumentBlock {
  return { type: "heading", id: "h-1", pageNumber: 1, level, text: [{ text }] };
}

function baseInput(overrides: Partial<TitleSelectionInput> = {}): TitleSelectionInput {
  return { firstPageBlocks: [], originalFilename: "qtp1s0x1-1.pdf", ...overrides };
}

describe("isBoilerplateTitle", () => {
  it("rejects the known BY ORDER OF THE cover-page boilerplate", () => {
    expect(isBoilerplateTitle("BY ORDER OF THE")).toBe(true);
    expect(isBoilerplateTitle("By Order of the Secretary of the Air Force")).toBe(true);
  });

  it("rejects other conservative boilerplate phrases", () => {
    expect(isBoilerplateTitle("COMPLIANCE WITH THIS PUBLICATION IS MANDATORY")).toBe(true);
    expect(isBoilerplateTitle("CONTROLLED UNCLASSIFIED INFORMATION (CUI)")).toBe(true);
    expect(isBoilerplateTitle("Table of Contents")).toBe(true);
  });

  it("does not reject an ordinary, non-boilerplate title", () => {
    expect(isBoilerplateTitle("Fall Protection")).toBe(false);
    expect(isBoilerplateTitle("Infection Prevention and Control Program")).toBe(false);
  });

  it("accepts a caller-supplied rule set instead of the default", () => {
    const customRules = [{ pattern: /^classified\b/i, description: "custom rule" }];
    expect(isBoilerplateTitle("Fall Protection", customRules)).toBe(false);
    expect(isBoilerplateTitle("Classified Briefing", customRules)).toBe(true);
    // The default-only rule no longer applies once a custom rule set is passed.
    expect(isBoilerplateTitle("BY ORDER OF THE", customRules)).toBe(false);
  });
});

describe("isWellFormedTitleCandidate", () => {
  it("rejects undefined, too-short, too-long, and boilerplate text", () => {
    expect(isWellFormedTitleCandidate(undefined)).toBe(false);
    expect(isWellFormedTitleCandidate("Hi")).toBe(false);
    expect(isWellFormedTitleCandidate("x".repeat(301))).toBe(false);
    expect(isWellFormedTitleCandidate("BY ORDER OF THE")).toBe(false);
  });

  it("accepts a normal title", () => {
    expect(isWellFormedTitleCandidate("Fall Protection")).toBe(true);
  });
});

describe("cleanFilenameForTitle", () => {
  it("strips the extension and title-cases underscore/hyphen-separated words", () => {
    expect(cleanFilenameForTitle("infection_prevention_and_control.pdf")).toBe("Infection Prevention And Control");
    expect(cleanFilenameForTitle("med_tech_program.pdf")).toBe("Med Tech Program");
  });

  it("preserves existing acronym casing instead of lowercasing it", () => {
    expect(cleanFilenameForTitle("afqtp24-3-b192.pdf")).toBe("Afqtp24 3 B192");
  });

  it("falls back to a generic label for a degenerate filename", () => {
    expect(cleanFilenameForTitle(".pdf")).toBe("Untitled document");
  });
});

describe("selectDocumentTitle priority order", () => {
  it("prefers an explicit host title over everything else, without a boilerplate check", () => {
    const selection = selectDocumentTitle(baseInput({
      hostTitle: "BY ORDER OF THE", // deliberate human choice; never rejected
      pdfMetadataTitle: "Fall Protection",
      firstPageBlocks: [heading("Some Heading")],
    }));
    expect(selection).toEqual({ title: "BY ORDER OF THE", source: "host", confidence: HOST_TITLE_CONFIDENCE });
  });

  it("rejects BY ORDER OF THE PDF metadata and falls through to a first-page heading", () => {
    const selection = selectDocumentTitle(baseInput({
      pdfMetadataTitle: "BY ORDER OF THE",
      firstPageBlocks: [heading("Fall Protection")],
    }));
    expect(selection).toEqual({ title: "Fall Protection", source: "first-page-heading", confidence: FIRST_PAGE_HEADING_CONFIDENCE });
  });

  it("rejects BY ORDER OF THE PDF metadata and falls through to the filename when no first-page heading exists", () => {
    // Matches the real qtp1s0x1-1.pdf sample: metadata.title is literally
    // "BY ORDER OF THE" and its cover page has no heading-type block.
    const selection = selectDocumentTitle(baseInput({
      pdfMetadataTitle: "BY ORDER OF THE",
      firstPageBlocks: [],
      originalFilename: "qtp1s0x1-1.pdf",
    }));
    expect(selection).toEqual({ title: "Qtp1s0x1 1", source: "filename", confidence: FILENAME_TITLE_CONFIDENCE });
  });

  it("prefers credible PDF metadata over a first-page heading", () => {
    const selection = selectDocumentTitle(baseInput({
      pdfMetadataTitle: "Hydraulic Systems Maintenance Manual",
      firstPageBlocks: [heading("A Different Heading")],
    }));
    expect(selection).toEqual({ title: "Hydraulic Systems Maintenance Manual", source: "pdf-metadata", confidence: PDF_METADATA_TITLE_CONFIDENCE });
  });

  it("prefers a strong first-page heading over the filename fallback when metadata is absent", () => {
    const selection = selectDocumentTitle(baseInput({
      firstPageBlocks: [heading("Fall Protection")],
      originalFilename: "qtp1s0x1-1.pdf",
    }));
    expect(selection).toEqual({ title: "Fall Protection", source: "first-page-heading", confidence: FIRST_PAGE_HEADING_CONFIDENCE });
  });

  it("falls back to the cleaned filename when the first-page heading is weak or ambiguous", () => {
    // A level-2 heading is not eligible as a title candidate at all.
    const level2 = selectDocumentTitle(baseInput({ firstPageBlocks: [heading("Overview", 2)] }));
    expect(level2).toMatchObject({ source: "filename", confidence: FILENAME_TITLE_CONFIDENCE });

    // A too-short level-1 heading is also rejected as ambiguous.
    const tooShort = selectDocumentTitle(baseInput({ firstPageBlocks: [heading("QTP", 1)] }));
    expect(tooShort).toMatchObject({ source: "filename", confidence: FILENAME_TITLE_CONFIDENCE });

    // A boilerplate level-1 heading is rejected the same as boilerplate metadata.
    const boilerplateHeading = selectDocumentTitle(baseInput({ firstPageBlocks: [heading("Table of Contents", 1)] }));
    expect(boilerplateHeading).toMatchObject({ source: "filename", confidence: FILENAME_TITLE_CONFIDENCE });
  });

  it("falls back to the cleaned filename when neither metadata nor a heading is usable", () => {
    const selection = selectDocumentTitle(baseInput({ originalFilename: "afqtp24-3-b192.pdf" }));
    expect(selection).toEqual({ title: "Afqtp24 3 B192", source: "filename", confidence: FILENAME_TITLE_CONFIDENCE });
  });

  it("is deterministic across repeated calls with identical input", () => {
    const input = baseInput({
      pdfMetadataTitle: "BY ORDER OF THE",
      firstPageBlocks: [heading("Fall Protection")],
      originalFilename: "qtp1s0x1-1.pdf",
    });
    const first = selectDocumentTitle(input);
    const second = selectDocumentTitle(structuredClone(input));
    expect(second).toEqual(first);
  });

  it("keeps confidence tiers strictly ordered host > pdf-metadata > first-page-heading > filename", () => {
    expect(HOST_TITLE_CONFIDENCE).toBeGreaterThan(PDF_METADATA_TITLE_CONFIDENCE);
    expect(PDF_METADATA_TITLE_CONFIDENCE).toBeGreaterThan(FIRST_PAGE_HEADING_CONFIDENCE);
    expect(FIRST_PAGE_HEADING_CONFIDENCE).toBeGreaterThan(FILENAME_TITLE_CONFIDENCE);
    for (const confidence of [HOST_TITLE_CONFIDENCE, PDF_METADATA_TITLE_CONFIDENCE, FIRST_PAGE_HEADING_CONFIDENCE, FILENAME_TITLE_CONFIDENCE]) {
      expect(confidence).toBeGreaterThanOrEqual(0);
      expect(confidence).toBeLessThanOrEqual(1);
    }
  });

  it("exposes the default boilerplate rule set for host configuration/testing", () => {
    expect(DEFAULT_TITLE_BOILERPLATE_RULES.length).toBeGreaterThan(0);
    for (const rule of DEFAULT_TITLE_BOILERPLATE_RULES) {
      expect(rule.pattern).toBeInstanceOf(RegExp);
      expect(typeof rule.description).toBe("string");
    }
  });
});

describe("applyTitleSelection", () => {
  function sampleDocument(): ParsedDocument {
    return {
      metadata: { pageCount: 1, title: "BY ORDER OF THE", producer: "Adobe PDF Library" },
      pages: [{ pageNumber: 1, width: 1, height: 1, warnings: [], blocks: [] }],
      outline: [],
      assets: [],
      warnings: [],
      timings: { totalMs: 0, phases: [], inputBytes: 0 },
    };
  }

  it("preserves the raw PDF metadata title even when it is rejected as the display title", () => {
    const document = sampleDocument();
    const selection = selectDocumentTitle({
      pdfMetadataTitle: document.metadata.title,
      firstPageBlocks: document.pages[0].blocks,
      originalFilename: "qtp1s0x1-1.pdf",
    });
    const stored = applyTitleSelection(document, "qtp1s0x1-1-abc123", selection);

    // Raw metadata is never silently destroyed.
    expect(stored.metadata.title).toBe("BY ORDER OF THE");
    // The selected display title is recorded separately.
    expect(stored.metadata.displayTitle).toBe("Qtp1s0x1 1");
    expect(stored.metadata.titleSource).toBe("filename");
    expect(stored.metadata.titleConfidence).toBe(FILENAME_TITLE_CONFIDENCE);
    expect(stored.metadata.id).toBe("qtp1s0x1-1-abc123");
    // Producer and other raw metadata fields are untouched.
    expect(stored.metadata.producer).toBe("Adobe PDF Library");
  });

  it("clears asset bytes without mutating the original document object", () => {
    const document: ParsedDocument = {
      ...sampleDocument(),
      assets: [{ id: "img-1", pageNumber: 1, width: 1, height: 1, mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]), placements: [] }],
    };
    const stored = applyTitleSelection(document, "doc-1", { title: "Doc", source: "filename", confidence: FILENAME_TITLE_CONFIDENCE });
    expect(stored.assets[0].bytes.byteLength).toBe(0);
    expect(document.assets[0].bytes.byteLength).toBe(3);
  });
});
