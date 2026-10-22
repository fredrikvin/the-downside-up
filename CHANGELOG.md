# Changelog

## 0.43.4

- Preserve clicked source-item highlights through intermediate and delayed
  editor selection events. Cancel queued preview scroll/reveal feedback when
  clicking an item, and avoid rebuilding the preview on same-document focus.
- Keep keyboard focus in the preview when selecting ordinary-file source
  items. Explicit code-editor mouse/keyboard input resumes cursor following.

## 0.43.3

- Keep the preview at its current scroll offset while flowcharts redraw, then
  restore its reading anchor after layout. This prevents a brief jump when
  the next function is visible below a tall flowchart.

## 0.43.0

- Organize native diff explanations into Added, Changed, Removed, and Other
  changes. Classify exact snapshots locally, including signature-only changes
  and nested functions, without guessing renames or ambiguous duplicates.
  Incomplete discovery falls back to a clearly limited textual comparison.
- Include short Added/Removed summaries in the single comparison request;
  request normal function details only through each card's explicit Explain
  action. Historical details use isolated snapshot context/caching without
  current callers, dependencies, or repository overviews.
- Reuse normal explanation tabs, linked-item masks, pseudocode layout and
  highlighting; source items reveal their own side of the existing native
  diff without opening a new file tab. Review/prefetch request counts remain
  one comparison per file, with no background function-card details.
- Validate required summary coverage and function-bounded evidence. Bump
  comparison/function prompt versions and add catalogue version 1 without
  changing repository cache schema 2 or saved consent. Recheck cancellation
  and source freshness before the persistence commit point.

## 0.42.0

- Highlight plain-language pseudocode locally in ordinary and paired-diff
  views, with light/dark/high-contrast colours for control words, literals,
  numbers, and code names. Keep generated content text-only and preserve
  source navigation and indentation; no extra dependency or AI request.
- Draw flowchart decisions as diamonds sized around their labels and source
  captions, including nested and paired charts. Retain rounded start/end nodes,
  source links, responsive layout, and connectors at the diamond vertices.
  Both display changes apply to saved results without regeneration.

## 0.41.1

- Simplify paired comparison responses: define each operation and source span
  once, then construct the Steps, Pseudocode, and Flowchart presentation objects
  locally. Keep both snapshots and all formats in one request, with explicit
  source ordering, control-flow edges, and cross-side matches.
- Distinguish incomplete-looking JSON, malformed JSON, and schema failures
  with content-free diagnostics and the received character count. Do not
  introduce automatic repair requests, retries, or model fallbacks.

## 0.39.2

- Remove the repeated help footer from all preview pages. Contextual notices,
  sharing-consent controls, model attribution, and result limitations remain.

## 0.39.0

- Explain what a change does. With the preview open, a native VS Code diff of
  local Git changes shows a change view: an explicit **Explain changes** sends
  both versions of that one file and saves a before/after explanation, with
  links to the lines on either side. Opening or switching to a diff only looks
  up a saved explanation. Added, deleted, and renamed files and changes outside
  functions are covered; binary, oversized, excluded, and identical files are
  reported instead.
- **Review Changes…** now prepares changed files rather than changed functions:
  it confirms the number of file comparisons, keeps each as confirmed (marking
  it as changed since when either version changes), and opens the native diff
  that shows the same saved explanation. **Show Changed Functions** is now
  **Show Changed Files**.

## 0.38.0

- Show SQL schema objects and queries in the default concise preview.
  Tables have column/type/required/default cards, generated expressions, keys,
  and clickable column/foreign-key references. Associate same-file PostgreSQL
  `ALTER TABLE` constraints/defaults and indexes with their table; show enum
  values and sequence definitions.
- Add explicit explanations for tables, types, indexes, sequences, and
  standalone queries. Use sqlc query names and result modes where present;
  show positional/named inputs and referenced relations locally.
- Include table constraints and indexes in query explanation context and
  freshness tracking. Keep schema/query previews local and SQL unexecuted;
  AI generation still follows explicit actions or existing opt-in prefetch.

## 0.37.0

- Add bundled SQL discovery for functions, procedures, triggers, views, and
  materialized views, with local outlines for tables, columns, types, and indexes.
  The bounded lexer recognizes common PostgreSQL dollar bodies, MySQL
  delimiters, T-SQL batches, and SQLite trigger blocks without a language server.
- Resolve SQL object dependencies across eligible repository files for
  explanation context and freshness, and provide name-based routine caller
  lookup. Honor exclusions, unsaved buffers, item/byte/time limits, and the
  existing explicit-generation and consent rules.
- Normalize SQL whitespace, ordinary comments, and unquoted casing while
  preserving literals. Dynamic SQL, standalone queries, embedded SQL, complete
  dialect semantics, and actual migration ordering are outside this support.
  Overloads remain name-based candidates and ambiguity is disclosed.

## 0.36.0

- Add bundled Python function discovery and local file outlines without Pylance:
  functions, async functions, class methods, properties, nested functions,
  docstrings, imports, and values.
- Statically resolve Python helpers, repository imports, and same-class
  `self`/`cls` methods for explanation context, freshness, hovers, and prefetch.
  Syntax-aware fingerprints tolerate formatting while preserving indentation
  structure, literals, and comments.
- Add Python import diagrams and conservative module-level direct caller lookup,
  using the same bounded, exclusion-aware scan as Go/Rust. Dynamic dispatch,
  inheritance, star imports, and re-exports are not resolved.

## 0.35.1

- Make function names navigate to their source instead of requesting an
  explanation. Explain and Show callers remain separate actions.

## 0.35.0

- Add conservative bundled Go/Rust caller lookup when native incoming Call
  Hierarchy is unavailable. Bounded, cancellable scans find direct free-function
  calls without a language server or AI requests and disclose incomplete coverage.
- Replace the Show callers text button with a compact accessible icon beside
  each function name.

## 0.34.0

- Add Show callers to function headings for steps, pseudocode, and flowcharts,
  using native incoming Call Hierarchy when supported by a language extension.
- Navigate to eligible repository callers with normal cache and opt-in prefetch
  behavior; caller lookup itself does not generate explanations.

## 0.33.1

- Simplify the Marketplace README around installation, everyday usage, privacy,
  and limitations. Move detailed configuration and contributor instructions
  into separate guides included in the extension package.

## 0.33.0

- Offer a repository-wide Initialize project button when context is missing,
  including after Clear, without requiring navigation or a restart.
- Integrate architecture maps into the opening description, removing the
  redundant Map heading and explanatory paragraph; retain a provenance tooltip.

## 0.32.0

- Move refresh into the page heading, separate from repository-wide controls.
- Refresh only checked outdated items on the displayed page; separate project
  actions map a missing project or update a map made with different model/settings.
- Show known outdated state with an amber divider and contextual text, while
  active requests retain the animated blue divider.
- Remove persistent successful-refresh messages.

## 0.31.0

- Replace expanded cache statistics with a tokens-in-current-cache disclosure,
  including input/output totals and overview/functions breakdowns per model.
- Record usage alongside saved results; replaced records no longer contribute.
  Counts are recorded tokens, not lifetime usage or billing.
- Shorten project refresh confirmation and hide zero outdated counts.
- Bump the local cache schema for usage metadata; Clear is required for older caches.

## 0.30.2

- Animate the existing header divider during requests instead of a separate bar.
- Shorten toolbar labels to **Refresh** and **Clear**, retaining descriptive tooltips.
- Disable Clear while requests are active; Cancel remains available.

## 0.30.1

- Allow VS Code language-model requests up to ten minutes instead of 90 seconds,
  while preserving manual cancellation and no automatic retries.
- Show a sticky animated activity strip, current stage, and elapsed time during
  active requests. Replace the misleading one-to-two-minute mapping message.

## 0.30.0

- Enable pseudocode and flowchart views by default for new explanations.
  Existing saved explanations still require **Generate** for missing views.
- Background prefetching remains opt-in and requires existing sharing consent.
- Offer to enable prefetch once when the preview is first opened, with
  quota/billing and sharing-approval information. Existing user choices are respected.

## 0.29.4

Initial public release of **Downside Up**, published by **FredrikVinkvist**.

- Read plain-language function explanations beside the source, with linked
  steps, optional pseudocode and flowcharts, and synchronized navigation.
- Explore project architecture, folder summaries, and main flows.
- Review a confirmed set of changed functions against a branch or commit.
- Reuse locally cached explanations and summaries, with source freshness checks.
- Choose VS Code language models or OpenAI, or use the local mock provider.
- Control code sharing with per-repository and per-model consent, content
  exclusions, and optional background prefetching.
- Discover Rust, Go, JavaScript, and TypeScript functions with bundled parsers;
  use editor language tools for other languages.
- Configure content-exclusion policy files through a step-by-step setup panel.
- Licensed under the MIT License.

Earlier versions were local development builds.
