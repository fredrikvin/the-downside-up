# Native diff change view: implementation plan

Status: implemented in 0.39.0 (individual native diffs and batch review), with the fixes from `docs/diff-view-fixes-handover.md` applied afterwards (batch review now lives in `src/review.ts`). Graphical flow comparison and cross-file change stories remain future work.
Recorded: 2026-10-20.

This is a handoff for implementation after switching models. Read
`.github/copilot-instructions.md`, `docs/prototype.md`, and the
`vscode-extension-development` skill before changing product behavior.
The implementation details below are proposed defaults, not existing features.

## Agreed product direction

Downside Up should explain what changed, rather than only explain the current
versions of changed functions. This is another preview view, like the existing
file and project/folder views, exclusive to native VS Code diff editors:

- Project or folder: existing overview view.
- Ordinary source editor: existing file view.
- Native text diff editor: new change view.

Use the existing Downside Up panel, not a replacement diff editor, a second
review tool, or another permanent panel. There is no Changes tab on ordinary
file previews and no manual review-view toggle to remember to switch off.
When the preview is open, the source editor being viewed determines its view.
Opening a diff alone does not force a closed preview to open.

The change view explains the exact original and modified documents displayed
by that diff, not an assumed HEAD-to-working-tree comparison. Staged,
unstaged, and branch/commit comparisons must remain distinct.

Present:

1. A concise file-level behavioral summary, not a list of textual edits.
2. Before/after explanations for meaningful changes, including the conditions
   under which behavior differs and host-validated links to either side.
3. Changes in flow: added decisions, removed paths, earlier exits, reordered
   operations, and different failure handling.

Cover added and deleted functions/files and changes outside functions.
Distinguish source-supported behavior from possible consequences dependent on
unseen callers or runtime conditions. Do not infer author intent or present
this as an automated correctness/security review.

Example:

> Validation now happens before saving. Previously, invalid input could be
> written before an error was returned. Now it exits immediately; only valid
> input reaches the save step.
>
> Before: Save -> Validate -> Success or error
>
> After: Validate -> Invalid: error / Valid: save -> success

## Scope and delivery order

First deliver the file summary, before/after behavior, textual changes in
flow, and linked evidence. Graphical before/after flow highlighting is a
follow-on, not a prerequisite for the first usable version.

Review Changes should subsequently prepare a confirmed set of these
comparisons, and its navigation should open the corresponding native diffs.
An individual diff must also be explainable without starting a batch.
Do not silently replace the existing batch command before this path works
end to end; ship its migration with updated confirmation, progress, and docs.

Cross-file change stories ("introduced here, passed through here, changes
execution here") are a future direction, outside this implementation.
Do not add whole-program analysis, a custom diff editor, or automatic bug
findings as part of this work.

## Current implementation and integration points

- `src/context/changes.ts`: Git base choices and changed new-side line ranges.
  `parseChangedLines` discards deleted files and retains no original source.
  These ranges are not sufficient input for a behavioral comparison.
- `src/extension.ts`: `PreviewFile`, `FolderPreview`, `previewDocument`,
  `onActiveEditorChange`, and panel rendering manage existing views.
  `previewDocument` currently accepts only `file` documents. Active-editor
  tracking does not establish a native diff's original/modified pair.
- `src/extension.ts`: `ReviewItem`, `ReviewSession`, `startReview`, `runReview`,
  and `showChangedFunctionsCommand` select changed working-tree functions
  and send them through ordinary function explanation generation.
- `src/presentation/panel.ts`: view/action types and webview presentation.
  Reuse existing loading, cancellation, failure, stale, and usage patterns.
- `src/controller.ts`, `src/core/types.ts`, `src/core/fingerprint.ts`,
  `src/cache/store.ts`, and `src/cache/freshness.ts`: generation orchestration,
  persisted data, identity, and freshness conventions.
- `src/generation/{provider,prompts,schema,mock,languageModel,openai}.ts`:
  provider interface, structured output, and all provider implementations.
- `src/presentation/requestScheduler.ts` and `prefetch.ts`: scheduling and
  reader-priority patterns; reuse rather than creating another request queue.
- `package.json`: commands, editor-title contributions, activation, scripts,
  and VS Code engine `^1.90.0`.
- Relevant existing tests: `test/changes.test.ts`, `panel.test.ts`,
  `panelActions.test.ts`, `provider.test.ts`, `languageModel.test.ts`,
  `service.test.ts`, `prefetch.test.ts`, and `test/extensionHost/runner.ts`.

Recheck the current source before editing; these are starting points, not
instructions to perform a broad refactor.

## Non-negotiable behavior

- View switching, opening a diff, scrolling, cursor movement, edits, and
  cache misses do not initiate generation. Show a current cached comparison
  or an explicit Explain changes action. A confirmed review batch may prepare
  only its accepted set; reader movement may reorder it, never expand it.
  Do not implicitly extend ordinary file prefetch settings to diff generation.
- External sharing requires workspace trust and existing per-repository,
  per-model consent rules. A batch may not repeatedly prompt in the background.
- Apply sharing exclusions to both sides, including historical paths,
  renames, and deleted files. An old revision or virtual URI must not bypass
  exclusions. Stay within the supported local repository boundary.
- Bound all reads, Git output, source/context size, and batch discovery.
  Mark unsupported, excluded, binary, oversized, or omitted input explicitly.
  Treat repository text as untrusted data, not instructions.
- Never substitute working-tree content for an unreadable original/index
  document. Handle true additions/deletions as an explicitly absent side;
  distinguish absence from a read failure.
- Use the actual document text, including an unsaved modified buffer where
  that is what the native diff shows. Immutable historical revisions remain
  immutable; mutable index/working-tree sides require freshness checks.
- Generate from both source snapshots, not two generated explanations.
  Additional context, if used, must be bounded and revision-correct; do not
  describe a historical comparison using current dependencies as if unchanged.
- Cache comparisons separately from normal explanations. Identity/freshness
  must cover repository, both side identities/paths and source fingerprints,
  actual tracked context, provider/model, configuration, and prompt/schema
  versions. Reject results when relevant inputs change in flight.
- Invalidation never silently regenerates. Navigation away must not let a
  late result overwrite a different preview. Preserve cancellation semantics.
- Render generated content as text under the existing restrictive CSP.
  Navigation uses host-owned references containing side and checked ranges,
  never model-provided paths or executable links.
- Keep language-specific discovery in `src/languages/<language>/` behind
  `LanguageSupport`. Do not require unbundled language servers to compare
  source; handle uncertain symbol matching conservatively.

## Implementation sequence

### 1. Establish native diff identity and source snapshots

- [ ] Inspect stable `TabInputTextDiff` and tab/editor events available in
  VS Code 1.90. Resolve original and modified URIs from the native diff tab,
  not from whichever side last became the active text editor.
- [ ] Introduce a small typed comparison/snapshot model with explicit side,
  repository-relative path, presence, document/revision identity, source
  fingerprint, comparison labels, and limitations.
- [ ] Support ordinary local Git text diffs first: staged, unstaged, and
  explicit revision comparisons. Verify actual built-in Git URI behavior.
  Other URI providers must be validated explicitly or reported unsupported;
  do not promise universal virtual-document or merge/multi-diff support.
- [ ] Preserve both paths on renames and both old/new hunk ranges. Keep
  non-function and deletion changes even if symbol matching is unavailable.
  Prefer bounded file comparisons over mandatory perfect symbol pairing.
- [ ] Add exclusion, missing-side, dirty-buffer, and snapshot identity tests.

### 2. Add comparison generation and caching

- [ ] Define a structured comparison response: summary, meaningful changes
  with before/after behavior, flow effects, side-specific evidence, and
  limitations. Keep observed behavior distinct from inferred consequences.
- [ ] Use the Functions model by default, consistent with file summaries;
  do not introduce another model setting for the initial version.
- [ ] Start with one bounded comparison request per file rather than two
  function explanations or a mandatory request for every changed function.
  Surface truncation or unsupported size instead of claiming full coverage.
- [ ] Extend all providers, mock output, schemas, and prompts consistently.
  Include numbered original and modified source with explicit boundaries.
- [ ] Integrate scheduling, consent, cancellation, usage, cache storage,
  versioning, and in-flight input validation using existing patterns.
- [ ] Validate evidence against the exact side snapshot. Invalid references
  must not become clickable or silently point at a different line/file.

### 3. Render and route the new preview view

- [ ] Extend panel state/actions with a distinct diff view without rewriting
  unrelated file/folder behavior.
- [ ] Route an open preview from the active native diff pair. Clicking
  between sides or focusing the preview must not change its comparison.
  Switching to an ordinary editor restores the normal file view.
- [ ] Adapt Open Preview to the Side and editor-title availability so they
  work from either diff side. In a diff, opening the view is cache-only even
  with selected text; do not inherit selection-triggered Explain behavior.
- [ ] Render comparison labels, summary, before/after changes, textual flow
  effects, evidence links, and explicit loading/current/outdated/error states.
- [ ] Navigate to validated original or modified ranges without replacing
  the comparison or falling back to the ordinary file preview. Prioritize
  reliable click navigation; complex two-sided scroll sync can follow.
- [ ] Ensure file explanation/prefetch handlers do not accidentally generate
  ordinary explanations while the diff view is being used.

### 4. Migrate batch review to comparison preparation

- [ ] Preserve Git base selection while retaining the resolved comparison
  identity, not just its human-readable label.
- [ ] Discover a bounded set of file comparisons, including additions,
  deletions, renames, and non-function changes. Confirm its scope and request
  count explicitly before generation.
- [ ] Reuse the comparison pipeline and cache from individual native diffs.
  Batch entries and the diffs they open must describe the same snapshots.
  If mutable inputs change after confirmation, mark the entry outdated and
  require a fresh explicit action instead of expanding/reinterpreting scope.
- [ ] Preserve reader prioritization, request-slot limits, cancellation,
  consent behavior, failure reporting, and bounded retries.
- [ ] Update progress and navigation to describe changed comparisons, not
  functions explained. Review navigation opens the native diff.
  Update directly dependent commands/contributions and their tests together.

### 5. Verify, document, and package

- [ ] Unit-test exact pair identity, comparison cache isolation/freshness,
  both-side edits, model/settings/version changes, and late/cancelled results.
- [ ] Test no requests on opening/switching/scrolling/editing/cache misses;
  test explicit individual and confirmed-batch requests separately.
- [ ] Cover added/deleted files and functions, renames, changes outside
  functions, identical inputs, missing historical content, exclusions,
  oversized content, invalid evidence, and absent language tooling.
- [ ] Extension-host test real native diffs, both-side focus, selection on
  opening, preview focus, switching back to files/folders, staged versus
  unstaged content, unsaved edits, navigation, and cancellation.
- [ ] Manually inspect the native diff plus preview at narrow widths and with
  removed-side evidence. Automated DOM tests alone do not establish VS Code
  focus/layout behavior or semantic quality of live model output.
- [ ] Update `README.md`, `docs/prototype.md`, `docs/configuration.md`, and
  related release notes to reflect shipped scope and limitations.
- [ ] Run `npm test` (includes typecheck) and `npm run test:extension`;
  `npm run lint` is also the TypeScript check. Resolve relevant failures.
- [ ] For an installable build, follow repository release rules: commit
  feature changes first; choose the next unused minor version using
  `npm version <x.y.z> --no-git-tag-version`, update README's install line,
  run `npm run package`, inspect VSIX contents, and commit only the three
  version/install files separately as `Release <x.y.z>`. Never rebuild an
  already packaged version. Follow the required commit trailer convention.

## Follow-on: graphical flow changes

After the textual comparison is reliable, add an annotated flow view that
distinguishes unchanged, added, changed, and removed behavior. Ground nodes
and edges in the appropriate source side, use accessible labels rather than
color alone, and do not mechanically diff two independently generated charts.
Decide the exact graph schema and layout in that follow-on implementation.

## Resume instruction

Implement this plan starting with native diff snapshot/routing support and
the individual comparison MVP, then migrate batch review. Keep changes
surgical and verify each layer. Do not implement graphical flow comparison
or cross-file change stories in the initial delivery.
