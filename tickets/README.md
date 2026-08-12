# Local Project Backlog

This directory is the local ticketing system for the PDF Content Extractor backlog. It was generated from the delivery authorities in [docs/TICKETS.md](../docs/TICKETS.md) and [docs/SEARCH_TICKETS.md](../docs/SEARCH_TICKETS.md), and links back to the design authority in [docs/DESIGN.md](../docs/DESIGN.md).

## Counts

- Epics: 8
- Implementation tickets: 37
- Milestones: 8

## Epics

- [Epic A: Foundation and executable spine](epics/EPIC-A.md)
- [Epic B: PDF object engine](epics/EPIC-B.md)
- [Epic C: Text and semantic extraction](epics/EPIC-C.md)
- [Epic D: Images, rendering, and integration](epics/EPIC-D.md)
- [Epic E: Production readiness](epics/EPIC-E.md)
- [Epic F: Searchable semantic foundation](epics/EPIC-F.md)
- [Epic G: Local search experience and main-app handoff](epics/EPIC-G.md)
- [Epic H: Robust lightweight search](epics/EPIC-H.md)

## Milestones

- [M1: Executable worker spine](milestones/M1.md)
- [M2: Open and traverse the sample PDFs](milestones/M2.md)
- [M3: Recover readable semantic text](milestones/M3.md)
- [M4: Preserve assets and integrate](milestones/M4.md)
- [M5: Production readiness](milestones/M5.md)
- [M6: Searchable semantic foundation](milestones/M6.md)
- [M7: Local search experience and handoff](milestones/M7.md)
- [M8: Robust lightweight search](milestones/M8.md)

## Tickets

| ID | Title | URL | Epic | Milestone | Dependencies |
| --- | --- | --- | --- | --- | --- |
| TKT-001 | Establish the portable library boundary and public types | [local ticket](TKT-001.md) | Epic A | M1 | None |
| TKT-002 | Implement the worker protocol and lifecycle | [local ticket](TKT-002.md) | Epic A | M1 | TKT-001 |
| TKT-003 | Add the fixture, regression, and performance harness | [local ticket](TKT-003.md) | Epic A | M1 | TKT-002 |
| TKT-004 | Implement bounded byte reading, lexing, and PDF values | [local ticket](TKT-004.md) | Epic B | M2 | TKT-003 |
| TKT-005 | Parse indirect objects and traditional cross-reference tables | [local ticket](TKT-005.md) | Epic B | M2 | TKT-004 |
| TKT-006 | Implement Flate stream decoding and predictor support | [local ticket](TKT-006.md) | Epic B | M2 | TKT-005 |
| TKT-007 | Support cross-reference streams and compressed object streams | [local ticket](TKT-007.md) | Epic B | M2 | TKT-006 |
| TKT-008 | Traverse the catalog, page tree, and inherited resources | [local ticket](TKT-008.md) | Epic B | M2 | TKT-007 |
| TKT-009 | Interpret page content streams and graphics/text state | [local ticket](TKT-009.md) | Epic C | M3 | TKT-008 |
| TKT-010 | Decode font encodings and Unicode CMaps | [local ticket](TKT-010.md) | Epic C | M3 | TKT-009 |
| TKT-011 | Reconstruct lines, spaces, and paragraphs geometrically | [local ticket](TKT-011.md) | Epic C | M3 | TKT-010 |
| TKT-012 | Resolve tagged structure, MCIDs, and pagination artifacts | [local ticket](TKT-012.md) | Epic C | M3 | TKT-011 |
| TKT-013 | Build semantic headings, lists, tables, figures, outlines, and links | [local ticket](TKT-013.md) | Epic C | M3 | TKT-012 |
| TKT-014 | Extract JPEG assets and associate image placement | [local ticket](TKT-014.md) | Epic D | M4 | TKT-009, TKT-008 |
| TKT-015 | Decode prioritized Flate images, predictors, and masks | [local ticket](TKT-015.md) | Epic D | M4 | TKT-014, TKT-006 |
| TKT-016 | Implement the safe semantic HTML renderer | [local ticket](TKT-016.md) | Epic D | M4 | TKT-013, TKT-014 |
| TKT-017 | Integrate the real demo workflow and write the copy-folder README | [local ticket](TKT-017.md) | Epic D | M4 | TKT-015, TKT-016 |
| TKT-018 | Harden malformed-input handling and security limits | [local ticket](TKT-018.md) | Epic E | M5 | TKT-017 |
| TKT-019 | Establish performance baselines and optimize the full corpus | [local ticket](TKT-019.md) | Epic E | M5 | TKT-018 |
| TKT-020 | Normalize document-family glyphs and list markers | [local ticket](TKT-020.md) | Epic C | M3 | TKT-010, TKT-013 |
| TKT-021 | Add stable semantic anchors and PDF-page navigation metadata | [local ticket](TKT-021.md) | Epic F | M6 | TKT-013, TKT-016, TKT-020 |
| TKT-022 | Generate portable search records from semantic documents | [local ticket](TKT-022.md) | Epic F | M6 | TKT-021 |
| TKT-023 | Establish reference document persistence and storage lifecycle | [local ticket](TKT-023.md) | Epic F | M6 | None |
| TKT-024 | Finalize PostgreSQL document and search-index migrations | [local ticket](TKT-024.md) | Epic F | M6 | TKT-023 |
| TKT-025 | Implement the Node document lifecycle and search API | [local ticket](TKT-025.md) | Epic F | M6 | TKT-022, TKT-024 |
| TKT-026 | Build the local document-library test interface | [local ticket](TKT-026.md) | Epic G | M7 | TKT-025 |
| TKT-027 | Build ranked search results, snippets, and direct navigation | [local ticket](TKT-027.md) | Epic G | M7 | TKT-025, TKT-026 |
| TKT-028 | Write the AI-agent main-application integration guide | [local ticket](TKT-028.md) | Epic G | M7 | TKT-027 |
| TKT-029 | Add end-to-end lifecycle, corpus, and scale regression coverage | [local ticket](TKT-029.md) | Epic G | M7 | TKT-027 |
| TKT-030 | Produce concise match-centered snippets and grouped results | [local ticket](TKT-030.md) | Epic H | M8 | TKT-027 |
| TKT-031 | Implement deterministic multi-signal search ranking | [local ticket](TKT-031.md) | Epic H | M8 | TKT-030 |
| TKT-032 | Support safe web-style search syntax and exact phrases | [local ticket](TKT-032.md) | Epic H | M8 | TKT-031 |
| TKT-033 | Add prefix matching and progressive partial-result fallback | [local ticket](TKT-033.md) | Epic H | M8 | TKT-032 |
| TKT-034 | Add dual language vectors and technical identifier normalization | [local ticket](TKT-034.md) | Epic H | M8 | TKT-033 |
| TKT-035 | Add bounded domain synonyms and typo suggestions | [local ticket](TKT-035.md) | Epic H | M8 | TKT-034 |
| TKT-036 | Improve display-title selection and searchable metadata | [local ticket](TKT-036.md) | Epic H | M8 | TKT-022 |
| TKT-037 | Add search filters, suggestions, and quality regression coverage | [local ticket](TKT-037.md) | Epic H | M8 | TKT-035, TKT-036 |

## Project-level Notes and Blockers

## 5. Inputs still required from the host application

These details should become follow-up compatibility tickets or ticket comments when known:

- Oldest supported browser versions.
- Actual work-application bundler and worker URL conventions.
- Representative work hardware for performance budgets.
- Desired default visibility of PDF page boundaries.
- Default unsupported-image placeholder behavior.
- Internal-link and external-link product requirements.
