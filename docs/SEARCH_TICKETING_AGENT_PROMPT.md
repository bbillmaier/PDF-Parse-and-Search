# Prompt for the search ticketing agent

```text
You are the ticketing/documentation agent for the project at E:\PDF_to_HTML.
Do not implement application, parser, database, API, or UI code in this task.

Read these files completely before making changes:

1. E:\PDF_to_HTML\docs\SEARCH_TICKETS.md
2. E:\PDF_to_HTML\docs\DESIGN.md
3. E:\PDF_to_HTML\docs\TICKETS.md
4. E:\PDF_to_HTML\tickets\README.md
5. One existing representative ticket, epic, and milestone file so your output
   matches the repository's established format.

Create the local ticketing artifacts for TKT-021 through TKT-029 exactly as
defined in docs/SEARCH_TICKETS.md.

Required output:

- One Markdown file per implementation ticket under tickets/.
- Epic F and Epic G index files under tickets/epics/.
- M6 and M7 milestone files under tickets/milestones/.
- Updated tickets/README.md counts and tables.
- Correct relative links among tickets, epics, milestones, DESIGN.md,
  TICKETS.md, and SEARCH_TICKETS.md.

Preserve each ticket's goal, dependencies, scope, out-of-scope section,
acceptance criteria, and verification requirements. You may adapt formatting
to match existing local ticket files, but you may not weaken, combine, or
reinterpret requirements.

Critical boundaries:

- TKT-026 (local document-library test interface) and TKT-027 (search result
  experience) must remain separate tickets.
- The portable dependency-free library remains src/pdf-content-extractor/.
- Node, PostgreSQL, filesystem storage, Docker, and local React integration are
  host/reference application concerns and must not be placed in the portable
  library.
- PostgreSQL extensions, external search services, document revisions, AI
  answers, embeddings, and fuzzy matching are out of scope.
- All documents are visible to all authenticated application users; do not
  invent document-level permission work.
- The existing compose.yaml, database migration 001, PostgreSQL 17 container,
  and storage/documents/ folder are the implementation baseline, not new work
  to recreate destructively.
- Future database corrections must use new numbered migrations rather than
  silently editing an already-applied migration.

Use dependency links exactly as defined in the authority document. Add concise
labels that match the existing repository convention and include epic and
milestone labels. Do not assign estimates or implementation agents.

After creating the artifacts, validate that:

- TKT-021 through TKT-029 each exist exactly once.
- Both epics and both milestones link to every appropriate ticket.
- The ticket count in tickets/README.md is correct.
- Every relative Markdown link you added resolves to an existing file.
- No source code or runtime configuration changed.

Finish with a compact report listing created/updated files, the dependency
chain, and the validation performed. Call out any ambiguity instead of making
new product decisions.
```
