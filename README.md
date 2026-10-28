# The Downside Up

**Understand unfamiliar code beside the source.** Downside Up turns functions
into plain-language explanations, pseudocode, and flowcharts in a synchronized
VS Code preview. Explore the project's architecture or prepare explanations
for changed files before reviewing a branch.

The extension appears as **Downside Up** in Extensions, Settings, and commands.
Requires VS Code 1.90 or newer.

## Quick start

1. Install Downside Up and open a source file in your project.
2. Run **Downside Up: Open Preview to the Side**, or use the preview button in
   the editor title bar.
3. Click **Choose model** on the welcome screen, or use the **Functions**
   button at the top of the preview.
   For GitHub Copilot, sign in to Copilot in VS Code first. Other extensions
   that provide VS Code language models also work.
4. Click **Explain** beside a function. Review the repository/model sharing
   prompt before any code is sent.

Before a model is configured, the preview offers **Choose model** and
**OpenAI setup** instead of placeholder AI responses; local outlines remain
available. Choosing a model does not send code or generate explanations.
Requests use your provider's subscription and usage limits; they are not free
or unlimited. OpenAI API access is also supported with a separate key and
billing; see `docs/configuration.md` in the extension package.

## Read and explore

- **Explain functions.** Read purpose, inputs, results, and steps in plain
  language. Switch between **Steps**, **Pseudocode**, and **Flowchart**;
  the selected view applies across functions and files, including review
  comparisons, while the preview is open. Switching views never generates content.
  **More detail** adds edge cases, language notes, and related code.
  Pseudocode highlights control words and code names. Flowcharts show decisions,
  loops, exits, and nested UI output. React explanations distinguish rendering,
  effects, and event handlers rather than implying everything runs at once.
  Invalid flowcharts, including paths continuing after an end node, are omitted
  with a limitation; structural checks cannot guarantee semantic accuracy.
- **Stay beside the source.** Editor and preview scroll together. Clicking
  steps, pseudocode, or flowchart nodes highlights their source lines without
  moving the preview; ordinary-file clicks keep keyboard focus in the preview.
  Saved explanations reappear when you return to a file.
  Click a function's name to navigate to its source;
  use **Explain** to request an explanation.
- **Explore the project.** Run **Downside Up: Preview Project**, preview a
  folder from the Explorer, or navigate the breadcrumbs. Project maps show
  parts and connections; folder pages offer summaries and main flows.
- **Understand a change.** With the preview open, show a Git diff in VS Code
  and click **Explain changes**. The result groups functions into **Added**,
  **Changed**, and **Removed**, followed by **Other changes** for non-function
  edits. Current cached function details expand automatically when you return
  to a diff; cache misses never generate them. Added and Removed functions get
  a short summary and an **Explain** button; only that explicit action
  requests their normal Steps, Pseudocode, and Flowchart detail.
  Changed functions retain before/after/when/flow items
  and paired visuals. Signature-only changes count; pure comments and
  formatting do not. Renames, container moves, and ambiguous duplicates are
  removed+added, without guessed rename detection. Incomplete discovery falls
  back to an explicitly unclassified textual comparison, without Added/Removed
  cards. All three sections use consistent function headers. Click a Changed
  function's name to reveal its modified source; its behavior descriptions and
  paired views sit underneath with room to read. The views use the same tabs,
  text highlighting, and flowchart shapes as normal explanations.
  Click a visual item to focus and select its source lines in the matching
  Before or After side of the existing diff editor.
  With **Prefetch** enabled and sharing already approved, the comparison
  preloads automatically when the preview shows the diff. Otherwise,
  **Explain changes** sends both versions of that one file.
  All comparison summaries and Changed visuals come from **one request per
  file**. Added/Removed card details remain explicit by default. With prefetch
  enabled, `downsideUp.prefetch.diff.added` and `.removed` separately opt into
  full function details for the shown diff, including during review.
  `downsideUp.prefetch.diff.changed` controls ordinary paired-comparison prefetch
  (default on); it does not limit an explicitly confirmed review.
  Card prefetch needs a current comparison and existing sharing approval,
  never prompts, and does not prepare unseen files. Each uncached
  detail is a separate request; a working-side addition can first prime/review
  project context with the separately consented Overview model, but does not
  request an incidental file summary. Removed functions and revision/index-side
  additions use only their own snapshot's function and bounded same-file
  preamble, with a limitation: historical callers and cross-file dependencies
  are not resolved. They never use today's repository overview or dependencies.
  Missing formats require their own explicit **Generate** request.
  Failed responses report incomplete JSON, malformed JSON, or schema validation
  errors without exposing source text or silently retrying.
- **Prepare a review.** Run **Downside Up: Review Changes…**, select a
  comparison, and confirm the number of changed files to explain; each opens in
  VS Code's native diff. The confirmed count remains one comparison per file;
  Added/Removed details are not included in that count; optional card prefetch
  applies only to the diff being viewed. After
  you confirm, the first file's diff opens on the left with the preview on the
  right (the active editor's file if it is in the review). The preview starts
  on **Review summary**. Starting the review also requests its summary: a current
  saved summary is reused, otherwise it loads asynchronously with a skeleton
  while file preparation and navigation remain available.
  The Overview model summarizes the actual
  confirmed diffs and bounded surrounding source, with host-validated links to
  those diffs. Individual file explanations do not need to be ready first.
  The overview focuses on the main behavioral or contract change, grouping
  related edits rather than listing implementation details file by file.
  When useful and supported by the source, a small affected-parts chart shows
  their relationships, with links to the confirmed diffs.
  It discloses incomplete coverage, omitted context, and uncertainties; it is
  not proof of correctness. Overview-model sharing approval is separate, and
  this request shares diff source with that model. Saved summaries are reused;
  changed evidence or summary settings require explicit regeneration.
  An outdated summary shows a refresh icon beside its heading, with an
  explanatory tooltip; current summaries show no refresh control.
  Returning to the summary or editing source never starts generation. A failed
  or cancelled initial request is not retried automatically.
  While a confirmed file's native diff is shown, the review stays associated
  with that comparison in either side-by-side or inline layout, including
  automatic collapse on narrow windows. Review bands above the file header and
  at the bottom of the preview offer **‹ Previous** and **Next ›** to step through
  the review in path order, plus **Review: 3/8 ready** progress at the top.
  The filename and position open the existing **Show Changed Files** picker,
  with **Review summary** first. Previous from the first file returns to the
  summary; Next from the summary opens the first file.
  Navigation stays within the confirmed review, does not wrap, and only
  reprioritizes its pending work; it does not start requests. Opening a file
  outside the review ends review mode. If the review is still preparing, you
  are asked first. Returning to an exact native diff from the most recent review
  restores its navigation with that file selected. For working reviews,
  selecting a reviewed file in Source Control's
  **Changes** list opens its confirmed review comparison, keeping the review base.
  Staged and unrelated historical comparisons are not redirected. Unfinished preparation stays
  stopped until you choose **Continue explaining changed files**. This context
  is kept only in the current window; explicitly closing/cancelling the review,
  closing the preview, or starting another review discards it.
- **Prepare a commit.** Run **Downside Up: Prepare Commit Explanations…**,
  choose a commit (or enter its ID/ref), and confirm the bounded file scope and
  request count; the first file's diff then opens beside the review-summary
  preview. This
  compares the immutable commit with its parent, **not**
  today's working tree; root commits compare with the empty tree, and merges
  require an explicit parent choice. Keep using Source Control Graph's existing
  file tree and individual Git diffs: they pick up the same saved comparisons,
  prioritize the confirmed file being read, and update when preparation finishes.
  While the preparation session remains open, the graph's single historical
  documents for additions/deletions also show their confirmed comparison.
  The preview shows **Commit: 3/8 ready · 1 preparing** with **Stop** (sent
  requests may finish; **Cancel** aborts uncommitted results). At most 200
  changed files are considered; exclusions and limits still apply, and failures
  may retry once. Opening anything outside this scope never adds requests.
  Added/Removed details are not prepared for unseen files; opted-in card
  prefetch applies only when their diff is shown. Use the command palette to start
  preparation; there is no added Source Control Graph context-menu command.
  The graph defaults to the first merge parent; for another parent, use the
  existing **Show Changed Files** list to open that exact prepared diff.
- **Choose models by role.** **Functions** handles function and change
  explanations, added formats, and file summaries. **Project overview**
  handles repository context, architecture maps, folder summaries, and flows.
  It can use the same model or a different one.
- **Follow callers.** The **Show callers** icon beside a function lists direct callers
  using your language extension's incoming Call Hierarchy. Choose one to open
  its source and preview; use VS Code's **Go Back** to return. This works
  regardless of the selected steps, pseudocode, or flowchart tab.

Caller lookup prefers a language extension's incoming Call Hierarchy. Without
it, Go, Rust, and Python use a bounded local scan of direct free-function calls, labelled
**Statically found callers**. That fallback omits uncertain receiver methods,
interface/trait dispatch, macros, and closures; results are not exhaustive.
SQL also provides a local fallback for routine calls, matched by name rather
than argument types; overloaded routines can have extra candidate callers.
Results are limited to eligible files in the current repository. Lookup itself
makes no AI requests. Navigation
shows cached explanations; with prefetch enabled and sharing already approved,
the existing reader-focused queue loads missing explanations.

Rust, Go, Python, JavaScript, and TypeScript (including JSX and React) have bundled
function discovery. Python supports functions, async functions, class methods,
properties, and nested functions without Pylance. It statically follows local
helpers, repository imports, and same-class `self`/`cls` methods; dynamic
dispatch, inheritance, star imports, and re-exports are not resolved.
JavaScript/TypeScript dependency lookup uses VS Code's
built-in TypeScript tooling. Other languages depend on installed extensions
providing document symbols and go-to-definition; support varies.

SQL previews show **tables and queries by default**, not just routines. Table
cards list columns, types, required values, defaults, generated expressions,
keys, and relationships with source links. PostgreSQL dump constraints and
indexes declared later in the same file are folded into their table cards;
enums list their values and sequences show their definition.

Queries use sqlc `-- name: ... :one/:many/:exec` names when available, or
numbered statement headings, with local input and result-mode details.
Choose **Explain** on a table, query, view, or routine for a plain-language AI
explanation grounded in eligible schema definitions. Opening the preview never
executes SQL or requests AI explanations (unless prefetch was enabled).
Common PostgreSQL, MySQL, T-SQL, and SQLite forms need no database or language
server. This is not a full dialect parser: dynamic and embedded SQL are not
resolved. Repeated definitions use lexical file order, not actual migration
execution order; ALTER folding is limited to statements in the same file.

## Initialize, refresh, and clear

**Initialize project**, above the divider, appears when repository context is
missing, including after Clear. It builds the shared overview and project map.
Opening the project preview also requests a map if none is current.

The **Refresh** icon beside a page title updates only the checked outdated
items on that page, not the whole repository. An amber divider indicates
known outdated content; an animated blue divider, stage, and elapsed time
show active work. Slow models can take several minutes; **Cancel** remains
available.

**Clear** removes this repository's cached results and saved sharing consent.
It does not start generation or require a restart. **Tokens in current cache**
expands into input/output totals by role and model. These are retained-record
totals, not lifetime usage or billing.

**Max Project Context Request Size** (`downsideUp.maxProjectContextRequestSize`)
caps repository context requests at 256 KiB by default (128–1024 KiB, user
settings only), including the previous overview and map. Raising it does not
scan more files or start generation. If a review would exceed that budget,
the same action rebuilds context from current bounded evidence instead,
without an extra request. Any further inventory truncation is disclosed in
the overview's limitations.

**Max Request Size** (`downsideUp.maxRequestSize`, default 96 KiB, 32–512 KiB)
separately limits function and change explanations, added formats, summaries,
and flows. Raise it if a large file's two diff versions or a function's related
context will not fit. The model's own input-token limit still applies.

## Privacy and control

Generation normally requires an explicit action. Opening files, moving the
cursor, editing source, hovering, and cache misses do not send provider
requests. Opening an unmapped project preview is an explicit mapping request.
Optional **prefetch** is off by default; enabling it allows background
explanations and consumes provider quota or billing, but only with existing
repository/model sharing approval. It never prompts for consent on its own.

External requests require a trusted workspace and approval per repository and
model. Depending on the action, requests include selected source, related
code, file text, or bounded repository context. The extension respects Git
ignore rules, `.copilotignore`, VS Code exclusions, and secret/generated-file
exclusions. API keys are stored in VS Code SecretStorage.

**GitHub Copilot's server-side content exclusions do not apply to this
extension's Language Model API requests.** Configure the extension's exclusions
to match your organization's policy before sharing source. Provider
data-handling terms still apply.

Explanations and maps are AI-generated and may be wrong or incomplete.
Outdated indicators check recorded inputs; they are not a correctness guarantee
or a whole-repository audit.

## More information

In the repository and extension package:

- `docs/configuration.md`: detailed usage, OpenAI setup, settings, prefetch,
  review mode, request limits, and enterprise exclusions.
- `docs/development.md`: contributor setup, Copilot development agents, tests,
  packaging, and releases.
- `docs/prototype.md`: architecture, privacy contract, and known limitations.
- `CHANGELOG.md`: release notes.

For a locally built package, install the current version with
`code --install-extension the-downside-up-0.53.0.vsix`.

## License

MIT. See the repository's `LICENSE` file.
