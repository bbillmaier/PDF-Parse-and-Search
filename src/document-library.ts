import type { DocumentAsset, ParsedDocument, SearchableBlockType } from "./pdf-content-extractor/index.ts";

export type SearchResultBlockType = SearchableBlockType | "document-title";

export interface DocumentListItem {
  id: string;
  title: string;
  originalFilename: string;
  pageCount: number;
  createdAt: string;
}

export interface SearchMatchRange {
  start: number;
  end: number;
}

/**
 * Directness of a search match. "direct" is an ordinary indexed-term match
 * against the `simple` vector; "prefix" and "partial" are the TKT-033
 * broadening stages, still against the `simple` vector. "stemmed" (TKT-034)
 * is a match found only through the complementary `english` vector -- an
 * ordinary-language word form PostgreSQL's English stemmer related to a
 * query term (e.g. "inspected" / "inspection") with no equivalent match in
 * the exact-vocabulary `simple` vector. "synonym" (TKT-035) is a match found
 * only through a configured domain-synonym expansion of a query term (e.g.
 * "flu" also matching "influenza"). "corrected" (TKT-035) is a match found
 * only by substituting a close, known vocabulary term for a misspelled query
 * term (e.g. "inspeciton" -> "inspection"). Both are strictly looser than
 * every match class above them (see MATCH_CLASS_TIER), so ranking always
 * keeps a direct match above a synonym-only match, and a synonym match above
 * a corrected-spelling match.
 */
export type MatchClass = "direct" | "prefix" | "stemmed" | "synonym" | "partial" | "corrected";

/**
 * TKT-033: which broadening stage contributed results to a search response,
 * so the UI can explain when it showed more than a strict match. "strict"
 * means every returned result came from the primary strict query; "prefix"
 * means the final-term prefix pass contributed at least one visible result;
 * "stemmed" (TKT-034) means the complementary English-vector pass did;
 * "synonym" (TKT-035) means the domain-synonym expansion pass did;
 * "partial" means the bounded partial-term fallback did; "corrected"
 * (TKT-035) means the query needed a bounded, vocabulary-based spelling
 * correction to find anything. This reflects the broadest stage visible in
 * the *final, capped* result set, not merely which stages were attempted.
 */
export type SearchStrategy = "strict" | "prefix" | "stemmed" | "synonym" | "partial" | "corrected";

/** TKT-035: one misspelled query term and the vocabulary term substituted
 *  for it in an executed corrected search, plus the (already computed and
 *  bounded) runner-up suggestions -- enough for the UI to render either a
 *  "did you mean" suggestion or a clearly labeled corrected search. Shared
 *  between server/lifecycle.ts (produces it) and src/main.tsx (renders it). */
export interface SpellingCorrection {
  originalTerm: string;
  correctedTerm: string;
  distance: number;
  /** Other candidates within the bounded edit distance, best first,
   *  excluding `correctedTerm` itself -- never used to build a query,
   *  informational only. */
  alternatives: string[];
}

/** TKT-035: which query terms a domain-synonym rule widened a search to,
 *  and what they were widened to -- development-diagnostics-only (see
 *  server/lifecycle.ts's `includeDiagnostics`), so it is typed here for any
 *  UI that wants to render it while developing, without being a required
 *  part of the always-present response shape. */
export interface SynonymExpansion {
  term: string;
  expandedTerms: string[];
}

/**
 * Ties `SearchStrategy` values to the `MatchClass` values that justify them,
 * in ascending broadening order -- shared by server/lifecycle.ts (deciding
 * the response-level strategy) and the tier comparator below (guaranteeing a
 * stricter match class always outranks a looser one, regardless of score).
 *
 * `stemmed` sits below `prefix` (still the exact-vocabulary `simple` vector,
 * just an incomplete final word) but above `partial` (which drops the
 * requirement that a row contain every query term at all) -- an
 * English-stemmed match answers the same query more completely than a
 * partial one, so it should outrank it, while a direct or prefix `simple`
 * match -- TKT-034's own acceptance criterion -- must always outrank it.
 */
export const MATCH_CLASS_TIER: Record<MatchClass, number> = {
  direct: 0,
  prefix: 1,
  stemmed: 2,
  synonym: 3,
  partial: 4,
  corrected: 5,
};

/**
 * Development-only breakdown of how a result's score was composed. Weights
 * and the composition logic live in server/ranking.ts; this is just the
 * response shape both the server and (optionally) the UI can read. Omitted
 * from responses in production (see DocumentLifecycle.search).
 */
export interface SearchScoreComponents {
  /** The safe web-style query text actually sent to websearch_to_tsquery
   *  (src/search-query.ts) -- the normalized representation this ticket
   *  preserves for diagnostics, identical across every result of one search.
   *  Set by server/lifecycle.ts, not by computeSearchScore itself. */
  normalizedQuery?: string;
  blockType: SearchResultBlockType;
  structuralWeight: number;
  matchClass: MatchClass;
  matchClassMultiplier: number;
  distinctTermsMatched: number;
  distinctTermsTotal: number;
  coverageRatio: number;
  coverageBonus: number;
  exactPhraseMatch: boolean;
  phraseBonus: number;
  orderedNearMatch: boolean;
  orderedNearBonus: number;
  contentLength: number;
  lengthNormalizationFactor: number;
  rawScore: number;
  finalScore: number;
}

export interface SearchResultMatch {
  blockId: string;
  pageNumber: number;
  blockType: SearchResultBlockType;
  snippet: string;
  matches: SearchMatchRange[];
  rank: number;
  /** How this specific row was found (TKT-033). Always populated by the
   *  server in real responses (unlike `scoreComponents`, this is not a
   *  development-only diagnostic -- the UI needs it to explain broadened
   *  results). Optional here only so existing test fixtures that predate
   *  TKT-033 keep constructing candidates without it; absence is treated as
   *  "direct". */
  matchClass?: MatchClass;
  scoreComponents?: SearchScoreComponents;
}

export interface SearchResultItem extends SearchResultMatch {
  documentId: string;
  documentTitle: string;
  sectionId: string;
  heading: string;
  headingPath: string[];
  additionalMatches: SearchResultMatch[];
}

export type SearchResultCandidate = Omit<SearchResultItem, "additionalMatches">;

export interface LoadedDocumentResponse {
  document: DocumentListItem;
  stored: {
    semanticDocument: ParsedDocument;
    originalPdfBase64: string;
    assets: { name: string; bytesBase64: string }[];
  };
}

export function slugifyDocumentId(filename: string, hashHex: string): string {
  const base = filename
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  const safeBase = /^[a-z]/.test(base) ? base : `document-${base || "pdf"}`;
  return `${safeBase}-${hashHex.slice(0, 12)}`;
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice(0));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function assetFileName(asset: DocumentAsset): string {
  const suffix = asset.mimeType === "image/png" ? "png" : "jpg";
  return `${asset.id}.${suffix}`;
}

export function restoreDocumentAssets(document: ParsedDocument, storedAssets: { name: string; bytesBase64: string }[]): ParsedDocument {
  const assetsById = new Map(storedAssets.map((asset) => [asset.name.replace(/\.(png|jpg|jpeg)$/i, ""), asset.bytesBase64]));
  return {
    ...document,
    assets: document.assets.map((asset) => {
      const bytesBase64 = assetsById.get(asset.id);
      return bytesBase64 ? { ...asset, bytes: base64ToBytes(bytesBase64) } : asset;
    }),
  };
}

export function termsFromQuery(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[a-z0-9-]+/g) ?? [])].filter((term) => term.length > 0);
}

/**
 * Builds a bounded, match-centered plain-text excerpt from a (potentially
 * multi-thousand-character) block. Display whitespace is normalized, but the
 * caller's source content is never mutated. Returns match ranges relative to
 * the returned snippet, not the original content.
 */
export function buildMatchSnippet(content: string, terms: string[], radius = 96): { snippet: string; matches: SearchMatchRange[] } {
  const normalized = content.replace(/\s+/g, " ").trim();
  const lower = normalized.toLowerCase();
  const allMatches = terms.length === 0 ? [] : findTermMatches(lower, terms);
  if (allMatches.length === 0) {
    if (normalized.length <= radius * 2) return { snippet: normalized, matches: [] };
    return { snippet: `${normalized.slice(0, radius * 2).trimEnd()} ...`, matches: [] };
  }
  const anchor = bestAnchor(allMatches, radius);
  const start = Math.max(0, anchor.start - radius);
  const end = Math.min(normalized.length, anchor.end + radius);
  const prefix = start > 0 ? "... " : "";
  const suffix = end < normalized.length ? " ..." : "";
  const windowOffset = prefix.length - start;
  const matches = allMatches
    .filter((match) => match.start >= start && match.end <= end)
    .map((match) => ({ start: match.start + windowOffset, end: match.end + windowOffset }));
  return { snippet: `${prefix}${normalized.slice(start, end)}${suffix}`, matches };
}

function findTermMatches(lowerText: string, terms: string[]): SearchMatchRange[] {
  const pattern = new RegExp(terms.map(escapeRegExp).join("|"), "g");
  const matches: SearchMatchRange[] = [];
  for (const match of lowerText.matchAll(pattern)) {
    if (match.index === undefined || match[0].length === 0) continue;
    matches.push({ start: match.index, end: match.index + match[0].length });
  }
  return matches;
}

// Picks the match surrounded by the most other matches within one snippet radius,
// so the excerpt centers on the densest, most relevant occurrence.
function bestAnchor(matches: SearchMatchRange[], radius: number): SearchMatchRange {
  let best = matches[0];
  let bestScore = -1;
  for (const candidate of matches) {
    const score = matches.filter((other) => Math.abs(other.start - candidate.start) <= radius).length;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

/** Splits already-bounded snippet text into safe parts for React to render; never produces HTML. */
export function highlightedSnippetParts(snippet: string, matches: SearchMatchRange[]): { text: string; highlighted: boolean }[] {
  if (matches.length === 0) return snippet ? [{ text: snippet, highlighted: false }] : [];
  const sorted = [...matches].sort((a, b) => a.start - b.start);
  const parts: { text: string; highlighted: boolean }[] = [];
  let cursor = 0;
  for (const match of sorted) {
    const start = Math.max(0, Math.min(match.start, snippet.length), cursor);
    const end = Math.max(start, Math.min(match.end, snippet.length));
    if (start > cursor) parts.push({ text: snippet.slice(cursor, start), highlighted: false });
    if (end > start) parts.push({ text: snippet.slice(start, end), highlighted: true });
    cursor = Math.max(cursor, end);
  }
  if (cursor < snippet.length) parts.push({ text: snippet.slice(cursor), highlighted: false });
  return parts.filter((part) => part.text.length > 0);
}

export interface SearchResultCapOptions {
  perDocumentCap: number;
  totalLimit: number;
}

/**
 * Groups candidate matches from the same document section and block type into
 * one result (the highest-ranked member as primary, the rest as
 * additionalMatches so distinct matches stay visible) and enforces a
 * per-document result cap so a single long document cannot crowd every other
 * matching document out. Block type is part of the grouping key so a table
 * cell, a heading, and a paragraph in the same section are never folded
 * together as if they were the same answer context.
 */
export function groupAndCapSearchResults(candidates: SearchResultCandidate[], options: SearchResultCapOptions): SearchResultItem[] {
  const groups = new Map<string, SearchResultCandidate[]>();
  const order: string[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.documentId}::${candidate.sectionId}::${candidate.blockType}`;
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(candidate);
    } else {
      groups.set(key, [candidate]);
      order.push(key);
    }
  }

  const items: SearchResultItem[] = order.map((key) => {
    const members = [...groups.get(key)!].sort(compareCandidates);
    const [primary, ...rest] = members;
    return {
      ...primary,
      additionalMatches: rest.map((member) => ({
        blockId: member.blockId,
        pageNumber: member.pageNumber,
        blockType: member.blockType,
        snippet: member.snippet,
        matches: member.matches,
        rank: member.rank,
        matchClass: member.matchClass,
        scoreComponents: member.scoreComponents,
      })),
    };
  });

  items.sort(compareCandidates);

  const perDocumentCount = new Map<string, number>();
  const capped: SearchResultItem[] = [];
  for (const item of items) {
    const count = perDocumentCount.get(item.documentId) ?? 0;
    if (count >= options.perDocumentCap) continue;
    perDocumentCount.set(item.documentId, count + 1);
    capped.push(item);
    if (capped.length >= options.totalLimit) break;
  }
  return capped;
}

/**
 * TKT-033: a stricter match class always outranks a looser one, regardless
 * of either candidate's numeric score -- a strong "prefix" heading match
 * could otherwise out-score a weak "direct" body match (see
 * server/ranking.ts's per-class multiplier, which shifts score but cannot
 * guarantee tier separation on its own). Comparing by tier first turns
 * "direct always ranks above prefix, which always ranks above partial" into
 * a structural guarantee instead of a usually-true side effect of weights.
 */
function compareCandidates(a: SearchResultCandidate, b: SearchResultCandidate): number {
  const tierDelta = MATCH_CLASS_TIER[a.matchClass ?? "direct"] - MATCH_CLASS_TIER[b.matchClass ?? "direct"];
  if (tierDelta !== 0) return tierDelta;
  return b.rank - a.rank || a.documentTitle.localeCompare(b.documentTitle) || a.pageNumber - b.pageNumber || a.blockId.localeCompare(b.blockId);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * TKT-033: tracks which search request is the most recent one so a slower
 * earlier response can never overwrite a faster later one during rapid
 * typing. Deliberately framework-free (no React, no fetch, no timers) so it
 * is trivial to unit test in isolation; `src/main.tsx` pairs one instance
 * with an `AbortController` per request -- the controller cancels the
 * network request itself where possible, and this guard is the backstop
 * that also covers a response that was already in flight when a newer
 * request started.
 */
export class LatestRequestGuard {
  private latestId = 0;

  /** Call when starting a new request; use the returned id when the
   *  response comes back. */
  begin(): number {
    this.latestId += 1;
    return this.latestId;
  }

  /** True only if `id` is still the most recently started request -- false
   *  for any response that arrives after a newer request has begun. */
  isCurrent(id: number): boolean {
    return id === this.latestId;
  }
}
