/**
 * TKT-036: display-title selection (docs/DESIGN.md section 21.7). Pure,
 * deterministic, and dependency-free like the other small host-side content
 * modules (src/search-synonyms.ts, src/search-vocabulary.ts) -- deliberately
 * kept out of `src/pdf-content-extractor/`, which has no concept of
 * boilerplate rejection, title credibility, or host overrides, only the
 * `DocumentMetadata.displayTitle`/`titleSource`/`titleConfidence` data
 * contract those types carry.
 *
 * Selection priority (highest first):
 *
 * 1. `host`             -- an explicit admin/host-supplied title.
 * 2. `pdf-metadata`      -- a credible PDF `/Info` Title.
 * 3. `first-page-heading` -- a high-confidence level-1 heading on page 1.
 * 4. `filename`          -- the cleaned original filename (always available,
 *                           so this function never fails to produce a title).
 *
 * Each tier is gated by `isWellFormedTitleCandidate`, which rejects known
 * standalone boilerplate (docs/DESIGN.md's `BY ORDER OF THE` example) and
 * degenerately short/long text -- never a partial or fuzzy match, so the
 * same input always produces the same accept/reject decision. Confidence is
 * a fixed value per tier (bounded to [0, 1]), not a continuous score, so
 * results stay simple to test and reason about.
 */
import type { DocumentBlock, DocumentMetadata, ParsedDocument, TextRun, TitleSource } from "./pdf-content-extractor/index.ts";

// ---------------------------------------------------------------------------
// Boilerplate configuration -- conservative, small, and versioned so a
// change to this list is a deliberate, reviewable, testable edit rather than
// an inferred heuristic. Every rule targets text that is *never* a real
// document title by itself: an issuing-authority attribution line, a
// standard compliance/markings notice, or a structural page label.
// ---------------------------------------------------------------------------

export interface TitleBoilerplateRule {
  pattern: RegExp;
  description: string;
}

export const DEFAULT_TITLE_BOILERPLATE_RULES: readonly TitleBoilerplateRule[] = [
  { pattern: /^by order of the\b/i, description: "issuing-authority attribution line" },
  { pattern: /^compliance with this publication is mandatory\.?$/i, description: "standard compliance notice" },
  { pattern: /^controlled unclassified information\b/i, description: "CUI marking" },
  { pattern: /^for official use only\.?$/i, description: "FOUO marking" },
  { pattern: /^table of contents$/i, description: "table-of-contents label" },
  { pattern: /^this page (is )?intentionally left blank\.?$/i, description: "blank-page notice" },
];

export function isBoilerplateTitle(
  candidate: string,
  rules: readonly TitleBoilerplateRule[] = DEFAULT_TITLE_BOILERPLATE_RULES,
): boolean {
  const normalized = normalizeTitleText(candidate);
  return rules.some((rule) => rule.pattern.test(normalized));
}

// ---------------------------------------------------------------------------
// Candidate credibility
// ---------------------------------------------------------------------------

/** Below this length a candidate is too short to be a specific title (a
 *  stray page number, an initial, a lone acronym fragment). */
export const MIN_TITLE_LENGTH = 3;

/** Above this length a candidate reads as a sentence/paragraph, not a title
 *  -- matches the `documents.title` column's practical bound (see
 *  server/lifecycle.ts's own 300-character import validation). */
export const MAX_TITLE_LENGTH = 300;

/** A first-page heading below level 1 is a subsection, not the document's
 *  own title -- only a level-1 heading is eligible as a title candidate. */
const TITLE_HEADING_LEVEL = 1;

export function normalizeTitleText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function isBoundedNonEmpty(text: string, minLength: number, maxLength: number): boolean {
  const normalized = normalizeTitleText(text);
  return normalized.length >= minLength && normalized.length <= maxLength;
}

/** Credibility gate for an *inferred* candidate (PDF metadata or a first-page
 *  heading) -- bounded length and not known boilerplate. Never applied to an
 *  explicit host title (see `selectDocumentTitle`): a host operator's
 *  deliberate choice is not second-guessed against the boilerplate list. */
export function isWellFormedTitleCandidate(
  candidate: string | undefined,
  rules: readonly TitleBoilerplateRule[] = DEFAULT_TITLE_BOILERPLATE_RULES,
): candidate is string {
  if (!candidate) return false;
  if (!isBoundedNonEmpty(candidate, MIN_TITLE_LENGTH, MAX_TITLE_LENGTH)) return false;
  return !isBoilerplateTitle(candidate, rules);
}

/** A first-page heading needs a stricter minimum length than PDF metadata or
 *  a host title: a bare 3-character fragment (an acronym stub, a form
 *  number) is exactly the kind of "weak or ambiguous" heading that should
 *  fall back to the filename rather than become the display title. */
export const MIN_HEADING_TITLE_LENGTH = 4;

function textFromRuns(runs: TextRun[] | undefined): string {
  return runs?.map((run) => run.text).join("").replace(/\s+/g, " ").trim() ?? "";
}

/** The first level-1 heading on page 1, if any -- first-page blocks are
 *  already in reading order, so the first eligible heading is the most
 *  prominent one, with no separate ranking step needed. Only a level-1
 *  heading is eligible: a level-2+ heading is substructure, not the
 *  document's own title, and is treated as no candidate at all rather than
 *  a weak one. */
function firstPageHeadingCandidate(firstPageBlocks: readonly DocumentBlock[]): string | undefined {
  for (const block of firstPageBlocks) {
    if (block.type === "heading" && block.level === TITLE_HEADING_LEVEL) {
      return textFromRuns(block.text);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Filename cleanup -- the guaranteed last-resort candidate.
// ---------------------------------------------------------------------------

export function cleanFilenameForTitle(originalFilename: string): string {
  const withoutExtension = originalFilename.replace(/\.[^./\\]+$/, "");
  const spaced = withoutExtension.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (spaced.length === 0) return "Untitled document";
  // Capitalizes only the first letter of each token and leaves the rest of
  // each token untouched, so existing acronym casing (AFQTP, QTP) survives.
  return spaced.replace(/\S+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1));
}

// ---------------------------------------------------------------------------
// Confidence tiers -- fixed per source, bounded to [0, 1], and strictly
// ordered host > pdf-metadata > first-page-heading > filename so a stricter
// tier's acceptance always outranks a looser one regardless of any later
// scoring change.
// ---------------------------------------------------------------------------

export const HOST_TITLE_CONFIDENCE = 1;
export const PDF_METADATA_TITLE_CONFIDENCE = 0.8;
export const FIRST_PAGE_HEADING_CONFIDENCE = 0.65;
export const FILENAME_TITLE_CONFIDENCE = 0.2;

export interface TitleSelectionInput {
  /** An explicit admin/host-supplied title, if any -- always wins when
   *  present and non-empty, without a boilerplate check (see module doc). */
  hostTitle?: string;
  /** Raw PDF `/Info` dictionary Title (`ParsedDocument.metadata.title`). */
  pdfMetadataTitle?: string;
  /** `ParsedDocument.pages[0].blocks`, or an empty array if there is no
   *  page 1 (never undefined -- callers pass `[]` rather than omitting it,
   *  keeping this function's branching total). */
  firstPageBlocks: readonly DocumentBlock[];
  originalFilename: string;
}

export interface TitleSelection {
  title: string;
  source: TitleSource;
  confidence: number;
}

/**
 * Selects a display title following the priority order from
 * docs/DESIGN.md section 21.7. Deterministic: the same input always
 * produces the same `{ title, source, confidence }`, so re-running selection
 * against unchanged extracted data (no PDF reparsing involved) is safe and
 * repeatable.
 */
export function selectDocumentTitle(
  input: TitleSelectionInput,
  rules: readonly TitleBoilerplateRule[] = DEFAULT_TITLE_BOILERPLATE_RULES,
): TitleSelection {
  if (input.hostTitle && isBoundedNonEmpty(input.hostTitle, 1, MAX_TITLE_LENGTH)) {
    return { title: normalizeTitleText(input.hostTitle), source: "host", confidence: HOST_TITLE_CONFIDENCE };
  }

  if (isWellFormedTitleCandidate(input.pdfMetadataTitle, rules)) {
    return { title: normalizeTitleText(input.pdfMetadataTitle), source: "pdf-metadata", confidence: PDF_METADATA_TITLE_CONFIDENCE };
  }

  const heading = firstPageHeadingCandidate(input.firstPageBlocks);
  if (isWellFormedTitleCandidate(heading, rules) && normalizeTitleText(heading).length >= MIN_HEADING_TITLE_LENGTH) {
    return { title: normalizeTitleText(heading), source: "first-page-heading", confidence: FIRST_PAGE_HEADING_CONFIDENCE };
  }

  return { title: cleanFilenameForTitle(input.originalFilename), source: "filename", confidence: FILENAME_TITLE_CONFIDENCE };
}

/**
 * Applies a `TitleSelection` to a freshly extracted `ParsedDocument` before
 * it is persisted, setting `id` and the `displayTitle`/`titleSource`/
 * `titleConfidence` fields while leaving `metadata.title` (the raw PDF
 * `/Info` Title) exactly as extracted -- the "never discard raw metadata"
 * requirement from docs/DESIGN.md section 21.7. Asset bytes are cleared
 * (assets are transferred to storage separately; the persisted semantic JSON
 * never embeds asset bytes inline) the same way the previous host-local
 * `cloneForStorage` helper did.
 */
export function applyTitleSelection(document: ParsedDocument, id: string, selection: TitleSelection): ParsedDocument {
  const metadata: DocumentMetadata = {
    ...document.metadata,
    id,
    displayTitle: selection.title,
    titleSource: selection.source,
    titleConfidence: selection.confidence,
  };
  return {
    ...document,
    metadata,
    assets: document.assets.map((asset) => ({ ...asset, bytes: new Uint8Array() })),
  };
}
