import { describe, expect, it } from "vitest";
import {
  isEmptyFilters,
  MAX_FILTER_ID_LENGTH,
  MAX_FILTER_PAGE_NUMBER,
  MAX_FILTER_PAGE_RANGE_SPAN,
  parseSearchFilters,
  SEARCHABLE_BLOCK_TYPES,
} from "../../src/search-filters.ts";

describe("parseSearchFilters (TKT-037)", () => {
  it("returns an empty filter set for no input", () => {
    const result = parseSearchFilters({});
    expect(result.ok).toBe(true);
    if (result.ok) expect(isEmptyFilters(result.filters)).toBe(true);
  });

  it("accepts a valid documentId", () => {
    const result = parseSearchFilters({ documentId: "doc-1" });
    expect(result).toEqual({ ok: true, filters: { documentId: "doc-1" } });
  });

  it("rejects a documentId with unsafe characters", () => {
    const result = parseSearchFilters({ documentId: "doc-1; DROP TABLE documents;--" });
    expect(result.ok).toBe(false);
  });

  it("rejects a documentId that does not start with a lowercase letter", () => {
    const result = parseSearchFilters({ documentId: "1-doc" });
    expect(result.ok).toBe(false);
  });

  it(`rejects a documentId longer than ${MAX_FILTER_ID_LENGTH} characters`, () => {
    const result = parseSearchFilters({ documentId: `a${"b".repeat(MAX_FILTER_ID_LENGTH)}` });
    expect(result.ok).toBe(false);
  });

  it("accepts a valid sectionId", () => {
    const result = parseSearchFilters({ sectionId: "sec-1" });
    expect(result).toEqual({ ok: true, filters: { sectionId: "sec-1" } });
  });

  it("rejects an invalid sectionId", () => {
    const result = parseSearchFilters({ sectionId: "../etc/passwd" });
    expect(result.ok).toBe(false);
  });

  it("accepts a single valid page", () => {
    const result = parseSearchFilters({ page: "5" });
    expect(result).toEqual({ ok: true, filters: { page: 5 } });
  });

  it("rejects a non-numeric page", () => {
    expect(parseSearchFilters({ page: "abc" }).ok).toBe(false);
    expect(parseSearchFilters({ page: "-1" }).ok).toBe(false);
    expect(parseSearchFilters({ page: "0" }).ok).toBe(false);
    expect(parseSearchFilters({ page: "1.5" }).ok).toBe(false);
  });

  it(`rejects a page above MAX_FILTER_PAGE_NUMBER (${MAX_FILTER_PAGE_NUMBER})`, () => {
    expect(parseSearchFilters({ page: String(MAX_FILTER_PAGE_NUMBER + 1) }).ok).toBe(false);
    expect(parseSearchFilters({ page: "99999999999999999999" }).ok).toBe(false);
  });

  it("accepts a valid bounded page range", () => {
    const result = parseSearchFilters({ pageStart: "2", pageEnd: "10" });
    expect(result).toEqual({ ok: true, filters: { pageRange: { start: 2, end: 10 } } });
  });

  it("accepts an inclusive single-page range (start === end)", () => {
    const result = parseSearchFilters({ pageStart: "4", pageEnd: "4" });
    expect(result).toEqual({ ok: true, filters: { pageRange: { start: 4, end: 4 } } });
  });

  it("rejects a page range missing one bound", () => {
    expect(parseSearchFilters({ pageStart: "2" }).ok).toBe(false);
    expect(parseSearchFilters({ pageEnd: "10" }).ok).toBe(false);
  });

  it("rejects a page range where start > end", () => {
    expect(parseSearchFilters({ pageStart: "10", pageEnd: "2" }).ok).toBe(false);
  });

  it(`rejects a page range span exceeding MAX_FILTER_PAGE_RANGE_SPAN (${MAX_FILTER_PAGE_RANGE_SPAN})`, () => {
    expect(parseSearchFilters({ pageStart: "1", pageEnd: String(MAX_FILTER_PAGE_RANGE_SPAN + 2) }).ok).toBe(false);
    expect(parseSearchFilters({ pageStart: "1", pageEnd: String(MAX_FILTER_PAGE_RANGE_SPAN + 1) }).ok).toBe(true);
  });

  it("rejects specifying both a single page and a page range", () => {
    expect(parseSearchFilters({ page: "3", pageStart: "1", pageEnd: "10" }).ok).toBe(false);
  });

  it("accepts every allowed semantic block type", () => {
    for (const blockType of SEARCHABLE_BLOCK_TYPES) {
      const result = parseSearchFilters({ blockType });
      expect(result).toEqual({ ok: true, filters: { blockType } });
    }
  });

  it("rejects an unknown block type, including the synthetic document-title type", () => {
    expect(parseSearchFilters({ blockType: "document-title" }).ok).toBe(false);
    expect(parseSearchFilters({ blockType: "not-a-real-type" }).ok).toBe(false);
    expect(parseSearchFilters({ blockType: "'; DROP TABLE documents; --" }).ok).toBe(false);
  });

  it("composes multiple valid filters together", () => {
    const result = parseSearchFilters({ documentId: "doc-1", sectionId: "sec-1", blockType: "heading", pageStart: "1", pageEnd: "5" });
    expect(result).toEqual({
      ok: true,
      filters: { documentId: "doc-1", sectionId: "sec-1", blockType: "heading", pageRange: { start: 1, end: 5 } },
    });
  });

  it("treats empty strings the same as absent fields", () => {
    const result = parseSearchFilters({ documentId: "", page: "", sectionId: "", blockType: "" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(isEmptyFilters(result.filters)).toBe(true);
  });

  it("treats null the same as absent fields", () => {
    const result = parseSearchFilters({ documentId: null, page: null, pageStart: null, pageEnd: null, sectionId: null, blockType: null });
    expect(result.ok).toBe(true);
    if (result.ok) expect(isEmptyFilters(result.filters)).toBe(true);
  });
});
