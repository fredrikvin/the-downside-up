# Changelog

## 0.56.2

- Remove duplicate file lists beneath the review-summary chart; use its
  clickable nodes and file picker to navigate instead.

## 0.56.1

- Add public source-code and issue-tracker links to the README and extension
  metadata.

## 0.56.0

- Make multi-file nodes in the review-summary chart clickable, with a picker
  for their confirmed diffs.
- Open or focus the source beside file previews requested from Explorer;
  never reuse a closed editor when opening a preview without a file target.

## 0.55.0

- Paired Changed views (Steps, Pseudocode, Flowchart) now follow the cursor or
  selection in either side of the diff editor, highlighting that side's items.

## 0.54.4

- Replace outdated-state text buttons (Explain again, Regenerate) with a refresh
  icon beside the outdated item's heading: changed-file names, function
  headings, Main flows, and folder summaries. Tooltips explain cost and sharing.

## 0.54.3

- Keep chart edge labels readable: long labels sit beside their line within
  the visible chart, and are shortened with a tooltip when space runs out.

## 0.54.2

- Open the Review Changes picker immediately while model availability and
  comparison bases are checked, instead of appearing to do nothing on slow
  connections.

## 0.54.1

- Fix graph diff routing while the preview retains focus, and avoid leaving
  review while a newly selected comparison is still resolving.
- Reconnect equivalent graph diffs to confirmed working-review comparisons by
  checking both complete file versions, including rewritten commit identities.

## 0.54.0

- Preload the review summary asynchronously when starting a review, reusing
  current saved results and showing a skeleton without blocking file preparation.
- Keep review association and navigation when native diffs switch between
  side-by-side and inline layouts, including automatic narrow-window collapse.

## 0.53.0

- Replace the review summary status button with a header refresh icon shown
  only for outdated summaries, with an explanatory tooltip.
- Make review summaries concise and holistic, focusing on behavioral or contract
  changes, with an optional source-grounded affected-parts chart.

## 0.52.1

- Ground review summaries in actual confirmed diffs and bounded surrounding
  source rather than saved AI explanations. Summaries no longer wait for file
  explanations, and disclose source coverage and omitted context.

## 0.52.0

- Add a Review summary landing page for working and commit reviews, with
  explicit Overview-model synthesis of saved file comparisons, coverage,
  cached results, and host-validated links to confirmed diffs.
- Include Review summary first in the file picker and before the first file
  in Previous/Next navigation. Opening or returning never generates a summary.

## 0.51.0

- Add independent user controls for diff Added/Removed function-detail prefetch
  (off by default) and Changed comparison prefetch (on under master prefetch).
  Opted-in details work for the shown review diff using existing consent only.
- Keep or restore working-review context when selecting a confirmed file in
  Source Control's Changes list, reopening its original review comparison
  rather than replacing the review base with HEAD or the index.
- Share the selected Steps, Pseudocode, or Flowchart view across ordinary
  previews and all review functions, retaining it when navigating files.
  Switching views never starts generation.

## 0.50.1

- Reject flowcharts that continue after an end node, keeping the textual
  explanation and disclosing omitted visuals. Strengthen decision-polarity
  and early-return instructions for function and comparison flowcharts.

## 0.50.0

- Keep decision outcomes on distinct connector exits when flowchart targets
  stack vertically, so yes/no labels do not share a downward branch.
- Restore the most recent review's navigation when returning to an exact
  matching native diff after exploring another file. Select the returned file
  without restarting unfinished preparation or generating explanations.

## 0.49.0

- Replace production mock responses with welcome/setup in the existing preview:
  **Choose model** and **OpenAI setup**, with local outlines still available.
  Legacy mock settings require setup; configured real providers are preserved.
- Choosing a model sends no code and starts no generation, mapping or prefetch
  requests. Gate every generation API until configured; hide old mock content
  without rewriting caches. Mocks require explicit development/test-host opt-in.
- Refresh the README for production setup, current diff/review features,
  model roles, and request-size controls.

## 0.48.2

- Match Changed headers to Added/Removed cards with kind labels, prominent
  monospace names, sticky headings, and clickable names that reveal the modified
  function. Source links are disabled for outdated comparisons and rechecked
  on click.
- Put behavior titles underneath and add whitespace between behavioral changes,
  evidence, and paired views. Saved comparisons gain the styling without
  regeneration.

## 0.48.0

- Add user-only **Max Project Context Request Size**, defaulting to 256 KiB
  and adjustable from 128 KiB to 1 MiB, without expanding repository scanning
  or invalidating saved results.
- Rebuild oversized repository-context reviews from current bounded evidence
  instead of failing. Fit serialized priming inputs within the budget and
  disclose rebuilding or truncation in the overview's limitations.

## 0.47.1

- While the next diff is read, show a placeholder shaped like a change
  explanation instead of an almost empty page. This keeps the page's height
  and stops the bottom review band jumping.

## 0.47.0

- Opening a file outside the confirmed review ends review mode:
  - A finished or stopped review ends quietly; its explanations stay saved.
  - A review still preparing explanations first asks, once per review, whether
    to end it.
  - After it ends, the preview behaves normally again, including opt-in
    prefetching.
- Show review progress only on files that are part of the review.

## 0.46.2

- Keep the cache statistics row visible, dimmed, while the next page or diff
  is read, instead of hiding it and reflowing the preview.

## 0.46.1

- Keep both review bands visible while the next diff loads, with the file's
  name shown and all controls disabled, instead of hiding them and reflowing.
- Place the Next chevron after its label, and put review progress above the
  navigation buttons.

## 0.46.0

- Starting **Review Changes…** or **Prepare Commit Explanations…** now opens
  the first confirmed file's native diff in the first editor column with the
  preview beside it. The active editor's file is used if it is in the review,
  otherwise the first file by path. Focus stays on the diff, and opening it
  starts no provider request.
- Move review navigation into a band above the file header:
  - chevron Previous and Next buttons;
  - the filename and position in the middle, which open the changed-files
    picker.
- Repeat the navigation band below a divider at the bottom of the preview.
- Compact progress with Stop moves from the header into the top band, and now
  also appears for working reviews (**Review: 3/8 ready**).

## 0.45.0

- Add Previous/Next review navigation to a native diff preview only when the
  exact repository, side identities/revisions, and both paths belong to the
  active confirmed review. Files follow stable path order; boundary buttons do
  not wrap, and filename/position opens the existing changed-files picker.
- Bind navigation messages to opaque session/pair authority and route stepping
  through the existing native diff opener. Navigation only reprioritizes the
  confirmed queue; it does not start provider requests or expose model paths.

## 0.44.1

- Fix closing a commit-preparation preview leaving a disposed webview attached
  to the extension, causing later review commands and preview updates to fail
  until the window was reloaded. Detach the panel before cancellation callbacks
  run, and ignore late messages and navigation handlers after disposal.

## 0.44.0

- Add **Prepare Commit Explanations…**: confirm a bounded immutable commit vs
  parent scope, then reuse Review's scheduler, consent, exclusions and cache.
  Root commits use the empty tree; merges require an explicit parent choice.
- Keep Source Control Graph's file tree as the navigator. Native revision diffs
  reuse prepared comparisons, additions/deletions bind their historical
  documents within the confirmed session, and visible comparisons refresh when
  background preparation finishes. Added/Removed details are never prepared.
- Show compact **Commit: ready/total · preparing** progress with Stop in the
  preview. Do not expand scope on opening/cache misses; changing models or
  sharing exclusions cancels the confirmed run.
- Use the command palette on stable VS Code: its graph commit context menu
  remains proposed-only. No engine bump, rejected menu contribution, or
  proposed-API release requirement is introduced.

## 0.43.5

- Restore current cached Added/Removed function explanations expanded when
  returning to a diff. Cache misses remain behind Explain without provider
  requests; obsolete lookups cannot attach details after leaving the diff.

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
