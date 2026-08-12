/**
 * Compile-time usage fixture for `TitleSource` (TKT-036).
 *
 * `describeTitleSource`'s `switch` has no `default` case, so if a fifth
 * title source is ever added without updating every consumer, the
 * `assertNever` branch below fails to compile -- the same exhaustiveness
 * pattern `block-union.fixture.ts` uses for `DocumentBlock`.
 */

import type { DocumentMetadata, TitleSource } from "../types.ts";

function assertNever(value: never): never {
  throw new Error(`Unhandled TitleSource variant: ${JSON.stringify(value)}`);
}

export function describeTitleSource(source: TitleSource): string {
  switch (source) {
    case "host":
      return "explicit host/admin override";
    case "pdf-metadata":
      return "credible PDF metadata title";
    case "first-page-heading":
      return "high-confidence first-page semantic heading";
    case "filename":
      return "cleaned original filename";
    default:
      return assertNever(source);
  }
}

export const sampleTitledMetadata: DocumentMetadata = {
  pageCount: 1,
  title: "BY ORDER OF THE",
  displayTitle: "Fall Protection",
  titleSource: "first-page-heading",
  titleConfidence: 0.65,
};

export const describedTitleSources: string[] = (
  ["host", "pdf-metadata", "first-page-heading", "filename"] as const satisfies readonly TitleSource[]
).map(describeTitleSource);
