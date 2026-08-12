import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import {
  createPdfParser,
  generateDocumentSearchRecords,
  renderDocumentToDisposableHtml,
  type ParsedDocument,
  type PdfParser,
  type ParseProgress,
} from "./pdf-content-extractor/index.ts";
import {
  assetFileName,
  base64ToBytes,
  bytesToBase64,
  highlightedSnippetParts,
  LatestRequestGuard,
  restoreDocumentAssets,
  sha256Hex,
  slugifyDocumentId,
  type DocumentListItem,
  type LoadedDocumentResponse,
  type SearchResultItem,
  type SearchStrategy,
  type SpellingCorrection,
} from "./document-library.ts";
import { applyTitleSelection, selectDocumentTitle } from "./title-selection.ts";
import { SEARCHABLE_BLOCK_TYPES } from "./search-filters.ts";
import { MIN_SUGGESTION_PREFIX_LENGTH, type Suggestion } from "./search-suggestions.ts";

/**
 * TKT-037: this is a reference test harness only -- just enough local React
 * behavior to exercise and verify the filter/suggestion API surface. It does
 * not establish styling or component requirements for a real main
 * application; see docs/MAIN_APP_AI_AGENT_INTEGRATION_GUIDE.md.
 */
interface SearchFilterFormState {
  documentId: string;
  page: string;
  pageStart: string;
  pageEnd: string;
  sectionId: string;
  blockType: string;
}

const EMPTY_FILTER_FORM: SearchFilterFormState = { documentId: "", page: "", pageStart: "", pageEnd: "", sectionId: "", blockType: "" };

const API_BASE = import.meta.env.VITE_DOCUMENT_API_BASE ?? "http://localhost:3001";

type UploadState = "idle" | "extracting" | "importing" | "done" | "cancelled" | "conflict" | "error";
type ViewMode = "html" | "pdf";
type SearchState = "idle" | "short" | "loading" | "done" | "empty" | "error";

/** TKT-033/TKT-034/TKT-035: a short, concrete explanation per broadening
 *  strategy -- shown only once results are on screen, so it reads as
 *  "here's why you're seeing this" rather than a generic disclaimer. */
const SEARCH_STRATEGY_NOTE: Record<Exclude<SearchStrategy, "strict">, string> = {
  prefix: "Showing results that complete your last word (exact matches were limited).",
  stemmed: "Showing results matching a related word form (exact matches were limited).",
  synonym: "Showing results that also match a related domain term (exact matches were limited).",
  partial: "Showing broader results matching some, not all, of your search terms.",
  corrected: "Showing results for a corrected spelling (exact matches were limited).",
};

interface OpenDocumentState {
  row: DocumentListItem;
  semanticDocument: ParsedDocument;
  html: string;
  cleanupHtml: () => void;
  pdfUrl: string;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(url, {
    ...init,
    headers,
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof json.error === "string" ? json.error : `Request failed with HTTP ${response.status}.`);
  return json as T;
}

function App() {
  const parserRef = useRef<PdfParser | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const openedRef = useRef<OpenDocumentState | null>(null);
  // TKT-033: guards against a slower earlier search response overwriting a
  // faster later one during rapid typing. searchAbortRef cancels the actual
  // in-flight network request where possible; searchRequestGuardRef is the
  // backstop that also covers a response already in flight when a newer
  // request started (see LatestRequestGuard in document-library.ts).
  const searchAbortRef = useRef<AbortController | null>(null);
  const searchRequestGuardRef = useRef(new LatestRequestGuard());
  // TKT-037: the same stale-response-guard pattern as search, but for the
  // autocomplete endpoint -- a suggestions request is fired on nearly every
  // keystroke, so cancelling/ignoring a stale response matters even more here.
  const suggestAbortRef = useRef<AbortController | null>(null);
  const suggestRequestGuardRef = useRef(new LatestRequestGuard());

  const [documents, setDocuments] = useState<DocumentListItem[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [uploadMessage, setUploadMessage] = useState("");
  const [progress, setProgress] = useState<ParseProgress | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [timingText, setTimingText] = useState("");
  const [opened, setOpened] = useState<OpenDocumentState | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("html");
  const [pdfPage, setPdfPage] = useState(1);
  const [activeBlockId, setActiveBlockId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [searchState, setSearchState] = useState<SearchState>("idle");
  const [searchError, setSearchError] = useState("");
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [searchStrategy, setSearchStrategy] = useState<SearchStrategy>("strict");
  // TKT-035: original -> corrected term pairs behind a "corrected" strategy
  // response, so the note can name what changed, not just that it changed.
  const [spellingCorrections, setSpellingCorrections] = useState<SpellingCorrection[]>([]);
  const [staleResult, setStaleResult] = useState("");
  // TKT-037: search filters (document, page/range, section, block type) and
  // autocomplete suggestions. Filters are plain form state sent as extra
  // query params; the server validates them (src/search-filters.ts) and
  // echoes back what was actually applied in `filters`.
  const [filterForm, setFilterForm] = useState<SearchFilterFormState>(EMPTY_FILTER_FORM);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);

  useEffect(() => {
    void refreshDocuments();
    return () => {
      abortRef.current?.abort();
      parserRef.current?.dispose();
      openedRef.current?.cleanupHtml();
      if (openedRef.current) URL.revokeObjectURL(openedRef.current.pdfUrl);
    };
  }, []);

  useEffect(() => {
    openedRef.current = opened;
  }, [opened]);

  useEffect(() => {
    if (!activeBlockId || viewMode !== "html") return;
    const handle = window.setTimeout(() => {
      document.getElementById(activeBlockId)?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 50);
    return () => window.clearTimeout(handle);
  }, [activeBlockId, opened?.html, viewMode]);

  useEffect(() => {
    const trimmed = query.trim();
    const handle = window.setTimeout(() => {
      if (trimmed === submittedQuery) return;
      void runSearch(trimmed);
    }, 350);
    return () => window.clearTimeout(handle);
  }, [query, submittedQuery]);

  // TKT-037: debounced autocomplete -- fires independently of (and faster
  // than) the search debounce above. Below MIN_SUGGESTION_PREFIX_LENGTH this
  // never calls the API at all (matches the server's own bound), so a user's
  // first keystroke or two never triggers a network request.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_SUGGESTION_PREFIX_LENGTH) {
      setSuggestions([]);
      setSuggestionsOpen(false);
      return;
    }
    const handle = window.setTimeout(() => void fetchSuggestions(trimmed), 150);
    return () => window.clearTimeout(handle);
  }, [query]);

  async function fetchSuggestions(prefix: string): Promise<void> {
    const requestId = suggestRequestGuardRef.current.begin();
    suggestAbortRef.current?.abort();
    const controller = new AbortController();
    suggestAbortRef.current = controller;
    try {
      const body = await fetchJson<{ suggestions: Suggestion[] }>(
        `${API_BASE}/api/search/suggestions?prefix=${encodeURIComponent(prefix)}`,
        { signal: controller.signal },
      );
      if (!suggestRequestGuardRef.current.isCurrent(requestId)) return;
      setSuggestions(body.suggestions);
      setSuggestionsOpen(body.suggestions.length > 0);
    } catch {
      // Suggestions are a non-essential enhancement -- a cancelled or failed
      // request silently leaves the previous (or empty) list rather than
      // surfacing an error state, unlike a failed search itself.
    }
  }

  function applySuggestion(suggestion: Suggestion): void {
    setSuggestionsOpen(false);
    setQuery(suggestion.text);
    void runSearch(suggestion.text);
  }

  function activeFilters(): Record<string, string> {
    const active: Record<string, string> = {};
    if (filterForm.documentId) active.documentId = filterForm.documentId;
    if (filterForm.page) active.page = filterForm.page;
    if (filterForm.pageStart) active.pageStart = filterForm.pageStart;
    if (filterForm.pageEnd) active.pageEnd = filterForm.pageEnd;
    if (filterForm.sectionId) active.sectionId = filterForm.sectionId;
    if (filterForm.blockType) active.blockType = filterForm.blockType;
    return active;
  }

  function getParser(): PdfParser {
    parserRef.current ??= createPdfParser();
    return parserRef.current;
  }

  async function refreshDocuments(): Promise<void> {
    setLibraryLoading(true);
    try {
      const body = await fetchJson<{ documents: DocumentListItem[] }>(`${API_BASE}/api/documents`);
      setDocuments(body.documents);
    } catch (error) {
      setUploadMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLibraryLoading(false);
    }
  }

  async function uploadPdf(file: File): Promise<void> {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setUploadState("extracting");
    setUploadMessage(`Extracting ${file.name}`);
    setWarnings([]);
    setTimingText("");
    setProgress(null);
    try {
      const originalPdf = new Uint8Array(await file.arrayBuffer());
      const hash = await sha256Hex(originalPdf.buffer.slice(0));
      const documentId = slugifyDocumentId(file.name, hash);
      const extracted = await getParser().parse(file, {
        preserveImages: true,
        signal: controller.signal,
        onProgress: setProgress,
      });
      // TKT-036: preserves the raw PDF metadata title (untouched in
      // metadata.title) and separately records the selected display title,
      // its source, and its confidence -- see src/title-selection.ts for
      // the priority order and boilerplate rejection (e.g. "BY ORDER OF THE").
      const selection = selectDocumentTitle({
        pdfMetadataTitle: extracted.metadata.title,
        firstPageBlocks: extracted.pages[0]?.blocks ?? [],
        originalFilename: file.name,
      });
      const semanticDocument = applyTitleSelection(extracted, documentId, selection);
      const title = selection.title;
      const searchRecords = generateDocumentSearchRecords(semanticDocument, { documentId, documentTitle: title });
      setUploadState("importing");
      setUploadMessage("Persisting files and indexing searchable blocks");
      await fetchJson(`${API_BASE}/api/documents/import`, {
        method: "POST",
        body: JSON.stringify({
          documentId,
          title,
          originalFilename: file.name,
          originalPdfBase64: bytesToBase64(originalPdf),
          semanticDocument,
          assets: extracted.assets.map((asset) => ({ name: assetFileName(asset), bytesBase64: bytesToBase64(asset.bytes) })),
          searchRecords,
        }),
      });
      setWarnings(extracted.warnings.map((warning) => warning.pageNumber ? `Page ${warning.pageNumber}: ${warning.message}` : warning.message));
      setTimingText(`${extracted.timings.totalMs.toFixed(0)} ms extraction, ${searchRecords.length} search blocks`);
      setUploadState("done");
      setUploadMessage("Document imported");
      await refreshDocuments();
      await openDocument(documentId);
    } catch (error) {
      if (controller.signal.aborted) {
        setUploadState("cancelled");
        setUploadMessage("Extraction cancelled.");
      } else {
        const message = error instanceof Error ? error.message : String(error);
        setUploadState(message.includes("already exists") ? "conflict" : "error");
        setUploadMessage(message);
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  async function openDocument(documentId: string, blockId?: string, pageNumber = 1, mode: ViewMode = "html"): Promise<void> {
    setStaleResult("");
    try {
      const loaded = await fetchJson<LoadedDocumentResponse>(`${API_BASE}/api/documents/${documentId}`);
      const semanticDocument = restoreDocumentAssets(loaded.stored.semanticDocument, loaded.stored.assets);
      const rendered = renderDocumentToDisposableHtml(semanticDocument, {
        renderUnsupportedImages: true,
        classes: {
          block: (block) => block.id === blockId ? "opened-match" : undefined,
        },
      });
      const pdfBytes = base64ToBytes(loaded.stored.originalPdfBase64);
      const pdfBuffer = pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength) as ArrayBuffer;
      const pdfUrl = URL.createObjectURL(new Blob([pdfBuffer], { type: "application/pdf" }));
      openedRef.current?.cleanupHtml();
      if (openedRef.current) URL.revokeObjectURL(openedRef.current.pdfUrl);
      const next = { row: loaded.document, semanticDocument, html: rendered.html, cleanupHtml: rendered.cleanup, pdfUrl };
      setOpened(next);
      setActiveBlockId(blockId ?? null);
      setPdfPage(pageNumber);
      setViewMode(mode);
    } catch (error) {
      setStaleResult(error instanceof Error ? error.message : String(error));
      await refreshDocuments();
    }
  }

  async function renameDocument(documentId: string, currentTitle: string): Promise<void> {
    const nextTitle = window.prompt("New title", currentTitle);
    if (nextTitle === null || nextTitle.trim() === currentTitle) return;
    try {
      // TKT-036: overrides the display title without reparsing the PDF --
      // the server updates documents.title and rebuilds the document's
      // search vocabulary in one transaction, then publishes the updated
      // semantic-document.json.
      await fetchJson<{ found: boolean; storageSynced?: boolean; partialFailure?: string }>(
        `${API_BASE}/api/documents/${documentId}/title`,
        { method: "PATCH", body: JSON.stringify({ title: nextTitle }) },
      );
      await refreshDocuments();
      if (opened?.row.id === documentId) await openDocument(documentId, activeBlockId ?? undefined, pdfPage, viewMode);
      if (submittedQuery) await runSearch(submittedQuery);
    } catch (error) {
      setStaleResult(error instanceof Error ? error.message : String(error));
    }
  }

  async function deleteDocument(documentId: string): Promise<void> {
    if (!window.confirm("Delete this document and its stored files?")) return;
    await fetchJson(`${API_BASE}/api/documents/${documentId}`, { method: "DELETE" });
    if (opened?.row.id === documentId) {
      opened.cleanupHtml();
      URL.revokeObjectURL(opened.pdfUrl);
      setOpened(null);
    }
    await refreshDocuments();
    if (submittedQuery) await runSearch(submittedQuery);
  }

  async function runSearch(nextQuery: string): Promise<void> {
    setSubmittedQuery(nextQuery);
    setSearchError("");
    setStaleResult("");
    setSuggestionsOpen(false);
    // TKT-033: every return path below invalidates any still-in-flight
    // request first (new guard token + abort the previous fetch), so a slow
    // earlier response -- even one already past the abort signal -- can
    // never overwrite what the user is now looking at.
    const requestId = searchRequestGuardRef.current.begin();
    searchAbortRef.current?.abort();
    if (nextQuery.trim().length === 0) {
      setResults([]);
      setSearchStrategy("strict");
      setSpellingCorrections([]);
      setSearchState("idle");
      return;
    }
    if (nextQuery.trim().length < 2) {
      setResults([]);
      setSearchStrategy("strict");
      setSpellingCorrections([]);
      setSearchState("short");
      return;
    }
    const controller = new AbortController();
    searchAbortRef.current = controller;
    setSearchState("loading");
    try {
      // TKT-037: active filters (document, page/range, section, block type)
      // are sent as extra query params; the server validates and echoes back
      // what was actually applied in `filters`.
      const params = new URLSearchParams({ q: nextQuery, limit: "25", ...activeFilters() });
      const body = await fetchJson<{ results: SearchResultItem[]; strategy: SearchStrategy; spellingCorrections?: SpellingCorrection[] }>(
        `${API_BASE}/api/search?${params.toString()}`,
        { signal: controller.signal },
      );
      if (!searchRequestGuardRef.current.isCurrent(requestId)) return;
      setResults(body.results);
      setSearchStrategy(body.strategy);
      setSpellingCorrections(body.spellingCorrections ?? []);
      setSearchState(body.results.length ? "done" : "empty");
    } catch (error) {
      if (controller.signal.aborted || !searchRequestGuardRef.current.isCurrent(requestId)) return;
      setSearchState("error");
      setSearchError(error instanceof Error ? error.message : String(error));
    }
  }

  const matchResultsForOpenDocument = useMemo(() => {
    if (!opened) return [];
    return results
      .filter((result) => result.documentId === opened.row.id)
      .flatMap((result) => [result, ...result.additionalMatches])
      .filter((match) => match.blockType !== "document-title")
      .sort((a, b) => a.pageNumber - b.pageNumber || a.blockId.localeCompare(b.blockId));
  }, [opened, results]);
  const activeMatchIndex = matchResultsForOpenDocument.findIndex((result) => result.blockId === activeBlockId);
  const totalPages = progress?.totalPages ?? opened?.row.pageCount ?? 0;
  const completedPages = progress?.pagesCompleted ?? 0;

  return (
    <main className="app">
      <section
        className="library-toolbar"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          const file = event.dataTransfer.files.item(0);
          if (file) void uploadPdf(file);
        }}
      >
        <div>
          <h1>Document Library</h1>
          <p>{uploadMessage || "Upload PDFs, persist semantic output, and search local indexed content."}</p>
        </div>
        <div className="actions">
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,.pdf"
            onChange={(event) => {
              const file = event.currentTarget.files?.item(0);
              if (file) void uploadPdf(file);
              event.currentTarget.value = "";
            }}
          />
          <button type="button" onClick={() => inputRef.current?.click()} disabled={uploadState === "extracting" || uploadState === "importing"}>Select PDF</button>
          <button type="button" onClick={() => abortRef.current?.abort()} disabled={uploadState !== "extracting"}>Cancel</button>
          <button type="button" onClick={() => void refreshDocuments()}>Refresh</button>
        </div>
      </section>

      <section className="status" aria-live="polite">
        <div><span>Upload</span><strong>{uploadState}</strong></div>
        <div><span>Extraction</span><strong>{totalPages ? `${completedPages}/${totalPages}` : progress?.phase ?? "ready"}</strong></div>
        <div><span>Documents</span><strong>{libraryLoading ? "loading" : documents.length}</strong></div>
        <div><span>Timing</span><strong>{timingText || "..."}</strong></div>
      </section>

      {uploadState === "conflict" ? <p className="error">Duplicate upload. Delete the existing document before re-uploading.</p> : null}
      {uploadState === "error" || staleResult ? <p className="error">{staleResult || uploadMessage}</p> : null}

      <form
        className="searchbar"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          void runSearch(query.trim());
        }}
      >
        <label htmlFor="library-search">Search documents</label>
        <div className="search-input-wrap">
          <input
            id="library-search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onFocus={() => setSuggestionsOpen(suggestions.length > 0)}
            onBlur={() => window.setTimeout(() => setSuggestionsOpen(false), 100)}
            placeholder="Title, heading, body text, table value, or code"
            aria-describedby="library-search-hint"
            autoComplete="off"
          />
          {suggestionsOpen ? (
            <ul className="suggestions" role="listbox" aria-label="Search suggestions">
              {suggestions.map((suggestion) => (
                <li key={`${suggestion.type}-${suggestion.text}`}>
                  {/* onMouseDown (not onClick) fires before the input's onBlur closes the list. */}
                  <button type="button" onMouseDown={() => applySuggestion(suggestion)}>
                    <span className="suggestion-text">{suggestion.text}</span>
                    <span className="suggestion-type">{suggestion.type}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <button type="submit">Search</button>
        <p className="search-hint" id="library-search-hint">
          Use <code>&quot;quotes&quot;</code> for an exact phrase, <code>OR</code> for alternatives, and <code>-word</code> to exclude a term.
        </p>

        <fieldset className="search-filters">
          <legend>Filters</legend>
          <label>
            Document
            <select value={filterForm.documentId} onChange={(event) => setFilterForm((form) => ({ ...form, documentId: event.currentTarget.value }))}>
              <option value="">Any document</option>
              {documents.map((doc) => <option key={doc.id} value={doc.id}>{doc.title}</option>)}
            </select>
          </label>
          <label>
            Page
            <input
              type="number"
              min={1}
              value={filterForm.page}
              onChange={(event) => setFilterForm((form) => ({ ...form, page: event.currentTarget.value, pageStart: "", pageEnd: "" }))}
              placeholder="e.g. 3"
            />
          </label>
          <label>
            Page from
            <input
              type="number"
              min={1}
              value={filterForm.pageStart}
              onChange={(event) => setFilterForm((form) => ({ ...form, pageStart: event.currentTarget.value, page: "" }))}
            />
          </label>
          <label>
            Page to
            <input
              type="number"
              min={1}
              value={filterForm.pageEnd}
              onChange={(event) => setFilterForm((form) => ({ ...form, pageEnd: event.currentTarget.value, page: "" }))}
            />
          </label>
          <label>
            Section id
            <input
              value={filterForm.sectionId}
              onChange={(event) => setFilterForm((form) => ({ ...form, sectionId: event.currentTarget.value }))}
              placeholder="e.g. h-3"
            />
          </label>
          <label>
            Block type
            <select value={filterForm.blockType} onChange={(event) => setFilterForm((form) => ({ ...form, blockType: event.currentTarget.value }))}>
              <option value="">Any block type</option>
              {SEARCHABLE_BLOCK_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
            </select>
          </label>
          <button type="button" onClick={() => setFilterForm(EMPTY_FILTER_FORM)}>Clear filters</button>
        </fieldset>
      </form>

      <section className="workspace">
        <aside className="sidebar" aria-label="Persisted documents and search results">
          <h2>Documents</h2>
          {documents.length === 0 ? <p>{libraryLoading ? "Loading documents." : "No persisted documents yet."}</p> : documents.map((doc) => (
            <div className="document-row" key={doc.id}>
              <button type="button" onClick={() => void openDocument(doc.id)} aria-label={`Open ${doc.title}`}>
                <strong>{doc.title}</strong>
                <span>{doc.originalFilename} · {doc.pageCount} pages · {new Date(doc.createdAt).toLocaleString()}</span>
              </button>
              <button type="button" onClick={() => void renameDocument(doc.id, doc.title)} aria-label={`Rename ${doc.title}`}>Rename</button>
              <button type="button" onClick={() => void deleteDocument(doc.id)} aria-label={`Delete ${doc.title}`}>Delete</button>
            </div>
          ))}

          <h2>Search Results</h2>
          {searchState === "idle" ? <p>Enter a query to search titles and document body content.</p> : null}
          {searchState === "short" ? <p>Use at least two characters.</p> : null}
          {searchState === "loading" ? <p>Searching.</p> : null}
          {searchState === "empty" ? <p>No results.</p> : null}
          {searchState === "error" ? <p className="inline-error">{searchError}</p> : null}
          {searchState === "done" && searchStrategy !== "strict" ? (
            <p className="search-strategy-note">{SEARCH_STRATEGY_NOTE[searchStrategy]}</p>
          ) : null}
          {searchStrategy === "corrected" && spellingCorrections.length > 0 ? (
            <p className="search-strategy-note">
              Searched for {spellingCorrections.map((correction) => `"${correction.correctedTerm}"`).join(", ")} instead of{" "}
              {spellingCorrections.map((correction) => `"${correction.originalTerm}"`).join(", ")}.
            </p>
          ) : null}
          {results.map((result) => (
            <article className="search-result" key={`${result.documentId}-${result.blockId}-${result.blockType}`}>
              <h3>{result.documentTitle}</h3>
              <p>{result.headingPath.length ? result.headingPath.join(" / ") : result.heading || "Document title"} · Page {result.pageNumber} · {result.blockType}</p>
              <p className="snippet">
                {highlightedSnippetParts(result.snippet, result.matches).map((part, index) => (
                  part.highlighted ? <mark key={`${part.text}-${index}`}>{part.text}</mark> : <span key={`${part.text}-${index}`}>{part.text}</span>
                ))}
              </p>
              <div className="result-actions">
                <button type="button" onClick={() => void openDocument(result.documentId, result.blockType === "document-title" ? undefined : result.blockId, result.pageNumber, "html")}>Open HTML</button>
                <button type="button" onClick={() => void openDocument(result.documentId, undefined, result.pageNumber, "pdf")}>Open PDF Page</button>
              </div>
              {result.additionalMatches.length > 0 ? (
                <ul className="grouped-matches" aria-label={`Additional matches in ${result.heading || result.documentTitle}`}>
                  {result.additionalMatches.map((match) => (
                    <li key={match.blockId}>
                      <button type="button" onClick={() => void openDocument(result.documentId, match.blockId, match.pageNumber, "html")}>
                        Also on page {match.pageNumber} ({match.blockType}):{" "}
                        {highlightedSnippetParts(match.snippet, match.matches).map((part, index) => (
                          part.highlighted ? <mark key={`${part.text}-${index}`}>{part.text}</mark> : <span key={`${part.text}-${index}`}>{part.text}</span>
                        ))}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </article>
          ))}
        </aside>

        <section className="viewer" aria-label="Document viewer">
          {opened ? (
            <>
              <div className="viewer-toolbar">
                <div>
                  <h2>{opened.row.title}</h2>
                  <p>{opened.row.originalFilename} · {opened.row.pageCount} pages</p>
                </div>
                <div className="actions">
                  <button type="button" className={viewMode === "html" ? "active" : ""} onClick={() => setViewMode("html")}>HTML</button>
                  <button type="button" className={viewMode === "pdf" ? "active" : ""} onClick={() => setViewMode("pdf")}>PDF</button>
                  <button
                    type="button"
                    disabled={activeMatchIndex <= 0}
                    onClick={() => {
                      const previous = matchResultsForOpenDocument[activeMatchIndex - 1];
                      if (previous) void openDocument(opened.row.id, previous.blockId, previous.pageNumber, "html");
                    }}
                  >Previous</button>
                  <button
                    type="button"
                    disabled={activeMatchIndex < 0 || activeMatchIndex >= matchResultsForOpenDocument.length - 1}
                    onClick={() => {
                      const next = matchResultsForOpenDocument[activeMatchIndex + 1];
                      if (next) void openDocument(opened.row.id, next.blockId, next.pageNumber, "html");
                    }}
                  >Next</button>
                </div>
              </div>
              {viewMode === "html" ? (
                <article className="output" dangerouslySetInnerHTML={{ __html: opened.html }} />
              ) : (
                <iframe title={`Original PDF for ${opened.row.title}`} className="pdf-frame" src={`${opened.pdfUrl}#page=${pdfPage}`} />
              )}
            </>
          ) : (
            <div className="empty-view">Select or upload a document.</div>
          )}
        </section>
      </section>

      {warnings.length ? (
        <section className="warnings">
          <h2>Extraction Warnings</h2>
          {warnings.slice(0, 30).map((warning, index) => <p key={`${warning}-${index}`}>{warning}</p>)}
        </section>
      ) : null}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
