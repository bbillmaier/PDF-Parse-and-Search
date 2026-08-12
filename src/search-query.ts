/**
 * TKT-032: safe web-style search syntax and exact phrases.
 *
 * Parses and bounds untrusted user search text into a small, well-defined
 * subset of PostgreSQL's `websearch_to_tsquery` syntax (quoted phrases, `OR`,
 * and `-excluded` terms) *before* it ever reaches SQL. The output is always
 * built from a fixed safe character set ([a-z0-9-], literal double quotes
 * around phrase text, and the literal word "OR"), so it can be handed to
 * `websearch_to_tsquery('simple', $1)` as an ordinary bound parameter with no
 * risk of the reconstructed text carrying SQL metacharacters through, on top
 * of parameter binding already preventing SQL injection.
 *
 * This module never executes a query or touches the database -- it only
 * decides whether a query is usable and, if so, what to search for and how
 * to describe that search in diagnostics and snippets.
 */

/** Raw query text longer than this is rejected before any parsing work. */
export const MAX_QUERY_LENGTH = 256;

/**
 * Total distinct words across all terms, phrases, and exclusions. Bounds the
 * size of the tsquery PostgreSQL has to evaluate per search (DESIGN.md 21.8).
 */
export const MAX_QUERY_TERMS = 24;

const WORD_PATTERN = "[a-z0-9]+(?:-[a-z0-9]+)*";
const WORD_RE = new RegExp(WORD_PATTERN, "g");
const TOKEN_RE = new RegExp(`"([^"]*)"?|(-)?(${WORD_PATTERN})`, "g");

type Token = { type: "phrase"; words: string[] } | { type: "term"; word: string } | { type: "exclude"; word: string } | { type: "or" };

/** One positive (non-excluded) clause in original query order -- the
 *  ordered backbone TKT-033 builds prefix/partial-fallback `tsquery` text
 *  from, since `terms` alone is deduplicated and loses the "what was the
 *  literal last thing typed" position needed to find the final term. */
export type PositiveClause = { type: "term"; word: string } | { type: "phrase"; words: string[] };

export interface ParsedSearchQuery {
  /** Safe web-style text to pass to `websearch_to_tsquery('simple', $1)` --
   *  also the authoritative "what did we actually search for" value for
   *  diagnostics, since nothing downstream ever re-derives a query from raw
   *  user input again. */
  normalized: string;
  /** Deduplicated, lowercased positive words in first-occurrence order
   *  (phrase words included, excluded words omitted) -- used for snippet
   *  highlighting and ranking coverage, same role `termsFromQuery` played
   *  before this ticket. */
  terms: string[];
  /** Each explicitly quoted phrase, as an ordered list of words, so ranking
   *  can award the exact-phrase signal per phrase rather than only to a
   *  whole-query join. */
  phrases: string[][];
  /** Words the user excluded with a leading `-` (no space) -- informational;
   *  PostgreSQL's `!word` predicate already keeps matching rows from ever
   *  containing them. */
  excludedTerms: string[];
  hasOr: boolean;
  /** Positive (term/phrase) clauses in literal query order, not
   *  deduplicated -- TKT-033's prefix/partial `tsquery` builders below use
   *  this to find the literal final positive term. */
  positiveClauses: PositiveClause[];
  /** True when the literal last token the user typed was a `-excluded` term
   *  (e.g. `engine -inspect`) -- an earlier positive term must never be
   *  prefixed in its place just because it happens to be the last *positive*
   *  clause; see `selectPrefixTerm`. */
  endsWithExcludedTerm: boolean;
}

export interface SearchQueryRejection {
  ok: false;
  message: string;
}

export type SearchQueryResult = { ok: true; query: ParsedSearchQuery } | SearchQueryRejection;

/**
 * Parses already-trimmed query text. Returns `ok: false` with a user-facing
 * message for anything that would be an expensive or meaningless database
 * call: text over the length bound, text with more distinct words than the
 * term bound, or text with no searchable words at all (empty input,
 * punctuation-only input, lone/unmatched operators).
 */
export function parseSearchQuery(rawQuery: string): SearchQueryResult {
  if (rawQuery.length > MAX_QUERY_LENGTH) {
    return { ok: false, message: `Search query is too long (max ${MAX_QUERY_LENGTH} characters).` };
  }

  const tokens = dropUselessOrTokens(tokenize(rawQuery.toLowerCase()));
  const contentTokens = tokens.filter((token) => token.type !== "or");
  if (contentTokens.length === 0) {
    return {
      ok: false,
      message: "Search query has no searchable words. Use letters, numbers, or hyphenated codes -- quotes, OR, and - need a word to apply to.",
    };
  }
  // dropUselessOrTokens already strips any trailing "or", so the literal
  // last token here (if any) is always a term/phrase/exclude -- used by
  // selectPrefixTerm below to tell "engine" apart from "engine -inspect"
  // (whose last positive *clause* is still "engine", but whose last typed
  // *token* is an exclusion, which must never be silently reinterpreted as
  // "prefix the term before it instead").
  const endsWithExcludedTerm = tokens[tokens.length - 1]?.type === "exclude";

  const terms: string[] = [];
  const phrases: string[][] = [];
  const excludedTerms: string[] = [];
  const normalizedParts: string[] = [];
  const positiveClauses: PositiveClause[] = [];
  let hasOr = false;
  let positiveWordCount = 0;
  let totalWordCount = 0;

  for (const token of tokens) {
    switch (token.type) {
      case "term":
        totalWordCount += 1;
        positiveWordCount += 1;
        if (!terms.includes(token.word)) terms.push(token.word);
        normalizedParts.push(token.word);
        positiveClauses.push({ type: "term", word: token.word });
        break;
      case "phrase":
        totalWordCount += token.words.length;
        positiveWordCount += token.words.length;
        phrases.push(token.words);
        for (const word of token.words) if (!terms.includes(word)) terms.push(word);
        normalizedParts.push(`"${token.words.join(" ")}"`);
        positiveClauses.push({ type: "phrase", words: token.words });
        break;
      case "exclude":
        totalWordCount += 1;
        if (!excludedTerms.includes(token.word)) excludedTerms.push(token.word);
        normalizedParts.push(`-${token.word}`);
        break;
      case "or":
        hasOr = true;
        normalizedParts.push("OR");
        break;
    }
  }

  if (totalWordCount > MAX_QUERY_TERMS) {
    return { ok: false, message: `Search query has too many terms (max ${MAX_QUERY_TERMS}).` };
  }
  if (positiveWordCount === 0) {
    return { ok: false, message: "Search query only excludes terms. Add at least one term to search for." };
  }

  return {
    ok: true,
    query: { normalized: normalizedParts.join(" "), terms, phrases, excludedTerms, hasOr, positiveClauses, endsWithExcludedTerm },
  };
}

function tokenize(lowered: string): Token[] {
  const tokens: Token[] = [];
  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_RE.exec(lowered)) !== null) {
    const phraseContent = match[1];
    if (phraseContent !== undefined) {
      const words = phraseContent.match(WORD_RE) ?? [];
      if (words.length > 0) tokens.push({ type: "phrase", words });
      continue;
    }
    const word = match[3];
    if (match[2] === "-") {
      tokens.push({ type: "exclude", word });
    } else if (word === "or") {
      tokens.push({ type: "or" });
    } else {
      tokens.push({ type: "term", word });
    }
  }
  return tokens;
}

/** Drops leading, trailing, and repeated `OR` tokens -- an operator needs a
 *  term on both sides to mean anything, so a stray or doubled `OR` is
 *  discarded rather than silently becoming a literal search word "or". */
function dropUselessOrTokens(tokens: Token[]): Token[] {
  const kept: Token[] = [];
  for (const token of tokens) {
    if (token.type === "or") {
      const previous = kept[kept.length - 1];
      if (!previous || previous.type === "or") continue;
    }
    kept.push(token);
  }
  while (kept.length > 0 && kept[kept.length - 1].type === "or") kept.pop();
  return kept;
}

/**
 * TKT-033: safe final-term prefix matching and bounded partial-term
 * fallback.
 *
 * Both builders below produce PostgreSQL `tsquery` syntax (`&`, `|`, `!`,
 * `<->`, and the prefix suffix `:*`) as plain text, entirely from words this
 * module has already validated (see `WORD_PATTERN` above: `[a-z0-9]+(?:-
 * [a-z0-9]+)*`, the exact same safe character set `websearch_to_tsquery`
 * already receives from `parseSearchQuery`'s `normalized` output). The
 * result is always sent to `to_tsquery('simple', $1)` as one bound
 * parameter -- it is never concatenated into SQL, and no word in it can ever
 * come from anywhere except this module's own tokenizer output.
 */

/** A prefix shorter than this matches too much of the index to stay a
 *  targeted "complete my last word" broadening (e.g. `in:*` would match a
 *  large fraction of an English vocabulary); DESIGN.md 21.8 requires prefix
 *  expansion to be explicitly bounded, and this is the practical bound: it
 *  keeps the number of lexemes PostgreSQL has to fan out to small regardless
 *  of corpus size, without needing a database-side lexeme-count limit
 *  PostgreSQL does not expose. */
export const MIN_PREFIX_TERM_LENGTH = 3;
/** A term this long is not "a word being typed" and gains little from
 *  prefix matching (few, if any, longer completions exist); rejecting it
 *  keeps prefix eligibility a narrow, well-defined case rather than a second
 *  general-purpose match path. */
export const MAX_PREFIX_TERM_LENGTH = 40;

/** Distinct positive terms OR'd together in the partial-fallback tsquery.
 *  Bounds fallback query complexity independently of MAX_QUERY_TERMS (which
 *  bounds the *input*, not how much of it this specific broadening stage is
 *  willing to search across). */
export const MAX_PARTIAL_FALLBACK_TERMS = 8;

export const SAFE_LEXEME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Defense in depth: every caller here only ever passes words that already
 *  came from this module's own tokenizer, so this should never reject
 *  anything in practice -- but a `tsquery` builder is exactly the kind of
 *  code that must never trust its inputs by assumption alone. Throws rather
 *  than silently dropping a clause, since a silently dropped exclusion or
 *  prefix term would change search meaning without telling anyone. Exported
 *  so other bounded `tsquery` builders outside this module (TKT-035's
 *  synonym-expansion builder in src/search-synonyms.ts) validate words the
 *  same way instead of re-implementing the check. */
export function safeLexeme(word: string): string {
  if (!SAFE_LEXEME_RE.test(word)) {
    throw new Error(`Refusing to build a tsquery clause from an unsafe lexeme: ${JSON.stringify(word)}`);
  }
  return word;
}

/**
 * Picks the literal final positive term eligible for prefix matching, or
 * `null` when prefix matching does not apply to this query. Ambiguous-
 * behavior decisions (see docs/DESIGN.md section 21.2 and TKT-033):
 *
 * - Only the literal final token the user typed is ever prefixed (not just
 *   any short word anywhere in the query) -- prefix matching models "the
 *   word I am still typing," which is always the last one.
 * - A query ending inside a quoted phrase is never prefixed: a phrase is a
 *   deliberate request for exact adjacent words, and weakening its last word
 *   into a prefix would silently change what the user explicitly asked for.
 * - A query ending on an excluded (`-word`) term is never prefixed --
 *   exclusions are not "words to complete."
 * - A query containing `OR` never gets prefix matching. Replicating
 *   `websearch_to_tsquery`'s exact OR grouping by hand in a second,
 *   independently-built `tsquery` string risks a subtly wrong
 *   reimplementation; declining is the safe, documented choice, and OR
 *   queries can still fall through to partial fallback.
 * - The term must be within [MIN_PREFIX_TERM_LENGTH, MAX_PREFIX_TERM_LENGTH].
 */
export function selectPrefixTerm(parsed: ParsedSearchQuery): string | null {
  if (parsed.hasOr || parsed.endsWithExcludedTerm) return null;
  const last = parsed.positiveClauses[parsed.positiveClauses.length - 1];
  if (!last || last.type !== "term") return null;
  if (last.word.length < MIN_PREFIX_TERM_LENGTH || last.word.length > MAX_PREFIX_TERM_LENGTH) return null;
  return last.word;
}

export interface PrefixTsQuery {
  /** Safe `to_tsquery('simple', $1)` text. */
  tsQuery: string;
  /** The literal final term this query prefix-matches, for diagnostics. */
  prefixTerm: string;
}

/**
 * Builds a safe `to_tsquery` expression identical in meaning to the strict
 * AND query except the final positive term is turned into a prefix match
 * (`term:*`), so an incomplete final word like `inspect` can reach indexed
 * `inspection` content. Returns `null` when `selectPrefixTerm` finds no
 * eligible final term.
 */
export function buildPrefixTsQuery(parsed: ParsedSearchQuery): PrefixTsQuery | null {
  const prefixTerm = selectPrefixTerm(parsed);
  if (prefixTerm === null) return null;

  const lastIndex = parsed.positiveClauses.length - 1;
  const positiveExpr = parsed.positiveClauses
    .map((clause, index) => {
      if (clause.type === "phrase") return `(${clause.words.map(safeLexeme).join("<->")})`;
      const word = safeLexeme(clause.word);
      return index === lastIndex ? `${word}:*` : word;
    })
    .join(" & ");
  const excludeExpr = parsed.excludedTerms.map((word) => `!${safeLexeme(word)}`).join(" & ");
  return { tsQuery: excludeExpr ? `${positiveExpr} & ${excludeExpr}` : positiveExpr, prefixTerm };
}

export interface PartialFallbackTsQuery {
  /** Safe `to_tsquery('simple', $1)` text. */
  tsQuery: string;
  /** How many positive clauses were OR'd together (bounded by
   *  MAX_PARTIAL_FALLBACK_TERMS), for diagnostics. */
  termCount: number;
}

/**
 * Builds a safe, bounded `to_tsquery` expression matching ANY of up to
 * MAX_PARTIAL_FALLBACK_TERMS positive query clauses, while still excluding
 * every excluded term. This is the broadest stage -- ordinary terms no
 * longer all need to be present at once -- but a quoted phrase clause stays
 * one atomic `<->`-adjacent unit rather than being split into independent
 * OR'd words: fallback is allowed to drop a phrase requirement entirely (it
 * is just one of several OR alternatives), but never allowed to silently
 * satisfy it with a scattered, non-adjacent match, which would make
 * `"engine inspection" other-term` fall back to matching text where
 * "engine" and "inspection" merely both appear somewhere unrelated. Coverage
 * of the matched rows is scored afterward from `parsed.terms` (the
 * flattened, deduplicated word list) in server/ranking.ts regardless of
 * clause shape, so a row answering more of the query still ranks above one
 * answering less of it. Returns `null` only if the query somehow has no
 * positive clauses at all (parseSearchQuery already rejects that case, so
 * this is defensive).
 */
export function buildPartialFallbackTsQuery(parsed: ParsedSearchQuery): PartialFallbackTsQuery | null {
  const clauses = parsed.positiveClauses.slice(0, MAX_PARTIAL_FALLBACK_TERMS);
  if (clauses.length === 0) return null;
  const positiveExpr = clauses
    .map((clause) => (clause.type === "phrase" ? `(${clause.words.map(safeLexeme).join("<->")})` : safeLexeme(clause.word)))
    .join(" | ");
  const excludeExpr = parsed.excludedTerms.map((word) => `!${safeLexeme(word)}`).join(" & ");
  return {
    tsQuery: excludeExpr ? `(${positiveExpr}) & ${excludeExpr}` : positiveExpr,
    termCount: clauses.length,
  };
}
