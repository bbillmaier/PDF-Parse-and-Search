/**
 * TKT-037: search filters (docs/DESIGN.md section 21.7).
 *
 * Pure, dependency-free validation for the four supported search filters --
 * document id, PDF page or bounded page range, section id, and semantic
 * block type -- kept outside `src/pdf-content-extractor/` alongside the
 * other host-only search modules (`search-query.ts`, `search-synonyms.ts`)
 * that both the reference server and its tests import. This module only
 * decides whether raw, untrusted filter input (always strings, since it
 * always arrives as URL query parameters) is safe and well-formed; building
 * SQL predicates from validated filters lives in server/database.ts, and
 * deciding when to apply them lives in server/lifecycle.ts.
 *
 * Every filter composes with every query strategy (strict, phrase/OR/
 * exclusion, prefix, partial fallback, the english-stemmed pass, synonym
 * expansion, and corrected search) because all of those strategies funnel
 * through the same three PgDocumentDatabase methods (`search`,
 * `searchByTsQuery`, `searchEnglish`), and this ticket adds filter support to
 * exactly those three -- see server/database.ts.
 */
import { isSafeSemanticId, type SearchableBlockType } from "./pdf-content-extractor/index.ts";

/** Matches the `documents.id` / `document_search_blocks.block_id` /
 *  `document_search_blocks.section_id` column bound (migration 002:
 *  `^[a-z][a-z0-9-]{0,127}$`) -- `isSafeSemanticId` alone has no length
 *  ceiling, so this module enforces the same bound the database schema
 *  already does before a filter value ever reaches SQL. */
export const MAX_FILTER_ID_LENGTH = 128;

/** The only semantic block types a filter may name -- exactly the
 *  `SearchableBlockType` union (docs/DESIGN.md section 21.7's "semantic
 *  block type"), never the synthetic `"document-title"` result type a title
 *  match reports: a title match is not a semantic block in any document, so
 *  it is not a value a caller can filter *for*. Shared with
 *  server/lifecycle.ts's import-time `ALLOWED_BLOCK_TYPES` so the two lists
 *  can never silently drift apart. */
export const SEARCHABLE_BLOCK_TYPES: readonly SearchableBlockType[] = [
  "heading",
  "paragraph",
  "list-item",
  "table-cell",
  "figure-caption",
];

const SEARCHABLE_BLOCK_TYPE_SET = new Set<string>(SEARCHABLE_BLOCK_TYPES);

/** A page number filter (single page or either end of a range) must fall
 *  within this bound -- generous enough for any real PDF, small enough to
 *  reject an obviously bogus or hostile value (e.g. `9e300`) before it
 *  reaches a parameterized query. */
export const MAX_FILTER_PAGE_NUMBER = 100_000;

/** A page range wider than this is rejected as an "excessive filter value"
 *  (docs/DESIGN.md 21.8's bounding requirement extended to filters by this
 *  ticket) -- a range this wide is not a targeted filter, and an unbounded
 *  range provides no meaningful candidate-selection benefit over no filter
 *  at all. */
export const MAX_FILTER_PAGE_RANGE_SPAN = 2_000;

export interface PageRangeFilter {
  start: number;
  end: number;
}

/** The validated, safe-to-use shape every query strategy accepts. Every
 *  field is independently optional; an empty object means "no filtering." */
export interface SearchFilters {
  documentId?: string;
  /** Mutually exclusive with `pageRange` -- a single-page filter. */
  page?: number;
  /** Mutually exclusive with `page` -- an inclusive, bounded page range. */
  pageRange?: PageRangeFilter;
  sectionId?: string;
  blockType?: SearchableBlockType;
}

/** Raw filter input as it arrives from an HTTP query string -- every field
 *  is a string (or absent/empty), never pre-parsed, so this module is the
 *  single place that turns untrusted text into a safe, typed filter. */
export interface RawSearchFilterInput {
  documentId?: string | null;
  page?: string | null;
  pageStart?: string | null;
  pageEnd?: string | null;
  sectionId?: string | null;
  blockType?: string | null;
}

export interface SearchFilterRejection {
  ok: false;
  message: string;
}

export type SearchFilterResult = { ok: true; filters: SearchFilters } | SearchFilterRejection;

function present(value: string | null | undefined): value is string {
  return value !== undefined && value !== null && value !== "";
}

function validateSemanticIdFilter(value: string, label: string): string | SearchFilterRejection {
  if (value.length > MAX_FILTER_ID_LENGTH || !isSafeSemanticId(value)) {
    return { ok: false, message: `Invalid ${label} filter.` };
  }
  return value;
}

function parsePageNumber(raw: string): number | null {
  if (!/^[0-9]{1,10}$/.test(raw)) return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1 || value > MAX_FILTER_PAGE_NUMBER) return null;
  return value;
}

/**
 * Validates raw, untrusted filter input into a safe `SearchFilters` value.
 * Rejects unknown block types, malformed/out-of-bounds ids, invalid page
 * numbers, an invalid or excessive page range, and a request that supplies
 * both a single page and a page range (ambiguous -- callers must pick one).
 * Never throws; every rejection returns a user-facing message the API layer
 * can surface as a 400 response, the same pattern `parseSearchQuery` uses.
 */
export function parseSearchFilters(raw: RawSearchFilterInput): SearchFilterResult {
  const filters: SearchFilters = {};

  if (present(raw.documentId)) {
    const result = validateSemanticIdFilter(raw.documentId, "documentId");
    if (typeof result !== "string") return result;
    filters.documentId = result;
  }

  const hasPage = present(raw.page);
  const hasRangeStart = present(raw.pageStart);
  const hasRangeEnd = present(raw.pageEnd);
  if (hasPage && (hasRangeStart || hasRangeEnd)) {
    return { ok: false, message: "Specify either a page filter or a pageStart/pageEnd range, not both." };
  }

  if (hasPage) {
    const page = parsePageNumber(raw.page!);
    if (page === null) return { ok: false, message: `Invalid page filter (must be an integer between 1 and ${MAX_FILTER_PAGE_NUMBER}).` };
    filters.page = page;
  } else if (hasRangeStart || hasRangeEnd) {
    if (!hasRangeStart || !hasRangeEnd) {
      return { ok: false, message: "A page range filter requires both pageStart and pageEnd." };
    }
    const start = parsePageNumber(raw.pageStart!);
    const end = parsePageNumber(raw.pageEnd!);
    if (start === null || end === null) {
      return { ok: false, message: `Invalid page range filter (each bound must be an integer between 1 and ${MAX_FILTER_PAGE_NUMBER}).` };
    }
    if (start > end) return { ok: false, message: "pageStart must be less than or equal to pageEnd." };
    if (end - start > MAX_FILTER_PAGE_RANGE_SPAN) {
      return { ok: false, message: `Page range is too large (max span ${MAX_FILTER_PAGE_RANGE_SPAN} pages).` };
    }
    filters.pageRange = { start, end };
  }

  if (present(raw.sectionId)) {
    const result = validateSemanticIdFilter(raw.sectionId, "sectionId");
    if (typeof result !== "string") return result;
    filters.sectionId = result;
  }

  if (present(raw.blockType)) {
    if (!SEARCHABLE_BLOCK_TYPE_SET.has(raw.blockType)) {
      return { ok: false, message: `Invalid blockType filter. Allowed values: ${SEARCHABLE_BLOCK_TYPES.join(", ")}.` };
    }
    filters.blockType = raw.blockType as SearchableBlockType;
  }

  return { ok: true, filters };
}

/** True when no filter field is set -- callers use this to skip building any
 *  filter predicate at all for the common, unfiltered case. */
export function isEmptyFilters(filters: SearchFilters): boolean {
  return (
    filters.documentId === undefined &&
    filters.page === undefined &&
    filters.pageRange === undefined &&
    filters.sectionId === undefined &&
    filters.blockType === undefined
  );
}
