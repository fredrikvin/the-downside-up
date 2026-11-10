# The Downside Up

[Source code](https://github.com/fredrikvin/the-downside-up) | [Report an issue](https://github.com/fredrikvin/the-downside-up/issues)

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
3. Click **Choose model** on the welcome screen, or the **Functions** button at
   the top of the preview. For GitHub Copilot, sign in to Copilot in VS Code
   first; other extensions that provide VS Code language models also work.
4. Click **Explain** beside a function. Review the repository/model sharing
   prompt before any code is sent.

Good to know:

- Local outlines work without a model. Until one is chosen, the preview offers
  **Choose model** and **OpenAI setup** instead of placeholder AI responses.
- Choosing a model sends no code and generates nothing.
- Requests use your provider's subscription and usage limits; they are not
  free or unlimited.
- To use your own OpenAI API key with separate billing, see
  [OpenAI API key](docs/configuration.md#openai-api-key).

## Features

### Explain functions

- Read a function's purpose, inputs, results, and steps in plain language.
- Switch between **Steps**, **Pseudocode**, and **Flowchart**. The chosen view
  applies to every function and file, including change comparisons, while the
  preview is open. Switching never generates content; a view that is missing
  for a saved explanation has its own **Generate** button.
- **More detail** adds where the function fits, edge cases, language notes, and
  related code.
- Pseudocode highlights control words and code names. Flowcharts show
  decisions, loops, exits, and nested UI output; an invalid flowchart is
  omitted with a noted limitation.
- React explanations separate rendering, effects, and event handlers instead of
  implying everything runs at once.
- Saved explanations reappear whenever you return to a file. Hovering a call
  shows the saved purpose of the function it calls.

### Read beside the source

- Editor and preview scroll together.
- Clicking a step, pseudocode line, or flowchart node highlights its source
  lines; the preview keeps its position and keyboard focus.
- Click a function's name to go to its source.
- Previewing a file from Explorer also opens its source to the left.

### Explore the project

- Run **Downside Up: Preview Project**, preview a folder from Explorer, or
  click a breadcrumb.
- The project page maps the project's parts and how they connect. Folder pages
  offer summaries, main flows, and a locally built import diagram.
- Opening the project page without a current map requests one, asking for
  sharing approval if needed. After a decline, cancel, or failure it is not
  retried on its own; choose **Map project** instead.

### Understand a change

With the preview open, show a Git diff in VS Code and click **Explain changes**.
Both versions go to the Functions model in one request when they fit.
For large files, it starts with every changed line and bounded surrounding
context instead. The model may request more of the same file in up to two
follow-ups, each within **Max Request Size**. Omitted context is disclosed;
partial-file explanations can be less certain.

| Section | What it shows |
|---|---|
| **Added**, **Removed** | A short summary per function. **Explain** requests its full Steps, Pseudocode, and Flowchart. |
| **Changed** | Before, after, when, and flow items with paired visuals. Click an item to select its lines in the matching side of the diff; move the cursor in either side to highlight its items. |
| **Other changes** | Additional details about edits outside functions; omitted when the summary already covers them. |

- Signature-only changes count; comment-only and formatting changes do not.
- Renames, moves between containers, and ambiguous duplicates show as Removed
  plus Added; renames are not guessed.
- If function discovery is incomplete, the result is an unclassified textual
  comparison without Added/Removed cards.
- Removed functions, and additions on a revision or index side, use only their
  own snapshot: historical callers and cross-file dependencies are not
  resolved.
- Saved function details expand automatically when you return to a diff; a
  cache miss never generates them.

### Review changes

Run **Downside Up: Review Changes…**, choose a base (merge base, branch tip,
uncommitted changes only, or a recent commit), and confirm how many files to
explain. Each confirmed file is one comparison, prepared in the background,
with up to two context follow-ups for large files.

- The first file's diff opens on the left and the preview on the right,
  starting on **Review summary**.
- The **review summary** uses the Overview model to describe the main
  behavioral or contract change across the confirmed diffs, with an optional
  affected-parts chart whose nodes open their diffs. It discloses incomplete
  coverage and uncertainty; it is not proof of correctness. A saved summary is
  reused; an outdated one shows a refresh icon and is regenerated only on
  request.
- **‹ Previous** and **Next ›** step through the files in path order, and the
  filename opens the **Show Changed Files** picker. Progress shows as
  **Review: 3/8 ready**.
- Reading only reorders pending work; it never adds files or starts requests.
  Opening a file outside the review ends review mode.
- Source Control's **Changes** list, and Graph diffs with matching content,
  return to the review.
- Low-value files such as lockfiles, generated files, and snapshots stay
  navigable but skip background comparisons and summary evidence; see
  `downsideUp.review.lowValuePatterns` under [Settings](#reviews).

Details: [Review mode](docs/configuration.md#review-mode).

### Prepare a commit

Run **Downside Up: Prepare Commit Explanations…**, choose a commit (or enter
its ID or ref), and confirm the file scope and request count.

- Compares the commit with its parent, **not** today's working tree. Root
  commits compare with the empty tree; merges ask which parent to use.
- Source Control Graph's file tree and diffs pick up the prepared comparisons.
- At most 200 changed files are considered. Progress shows as
  **Commit: 3/8 ready · 1 preparing**, with **Stop**.

### Export a review summary

Run **Downside Up: Export Review Summary…** and choose what to include, using
the same bases as **Review Changes…** (including **Uncommitted changes only**),
an immutable commit review, or your current/most recent review.
The **Export** button on the summary page exports that review directly.
Choose where to save the Markdown file in the save dialog. The file
then opens beside the review. It contains:

- the summary, themes, possible effects, limitations, and coverage, with the
  base and `HEAD` (or commit and parent) it describes;
- the affected-parts chart as a Mermaid diagram;
- each saved file comparison. For each change, collapsible **Steps** (open),
  **Pseudocode**, and **Flowchart** sections match the preview's columns
  (for example the committed version beside the working tree), including each
  step's detail, the region and coverage, and one Mermaid diagram per side;
- a list of files without a current comparison.

How it behaves:

- The suggested name is `review-<repository>-<base or commit>-<date>.md`, in
  the folder you last exported to, or else `Downloads`. Saving inside the
  repository asks first, because the file would join the next review of
  working changes.
- Export is cache-only: it never generates missing comparisons, asks for
  sharing consent, or posts to GitHub. A missing or outdated summary needs a
  separate confirmation before an Overview-model request.
- The command always offers scope selection, including the active review or
  the most recent one you left. Prepare a new review of working changes, or
  of a commit against its parent, as **Summary only** (no background Functions
  comparisons) or **Full review**.
  A later full review can reuse a summary-only review's summary.
- **Summary only** needs just an Overview model. If none is configured, it
  asks you to choose one, without choosing a Functions model or granting
  sharing consent; then run the export again.
- Working reviews can include staged, unstaged, untracked, and unsaved changes.
  Export checks that reviewed sources and `HEAD` have not changed while it
  is prepared, including time spent in the save dialog. Commit reviews use
  the exact commit and parent.

### Publish a review to a pull request

Run **Downside Up: Publish Review to Pull Request…**, enter the PR's HTTPS URL,
then choose **Generate summary only** or **Generate full review**.
Every invocation prepares the exact PR merge base and head, reuses current saved
content, and asks for review/model sharing approval before generation. Posting
requires a separate confirmation of the destination, account, revision, and
comment actions. Install [GitHub CLI](https://cli.github.com/)
and authenticate it for that host first (`gh auth login`). Downside Up uses
that existing authentication; it does not store a GitHub token.

- Posts a compact summary to the PR conversation and keeps file explanations
  with their code under **Files changed** (source comments are sent first).
  Steps, pseudocode, and Mermaid diagrams are collapsible; **Before** and
  **After** appear vertically rather than in tables. GitHub web renders Mermaid;
  other clients may show its source.
  The opening summary, themes, and chart are visible; coverage, effects, and
  caveats sit under **Review details**. File comments show their explanation
  directly, grouped under recorded function names and Before/After source line
  ranges. Each function gets its own inline comment on a changed line in its
  **After** source; removed functions use the deleted **Before** source.
  Both versions stay in that one comment, even when their locations differ.
  File-wide context and functions without a suitable diff line stay in a
  file-level comment; missing or incomplete GitHub patches also use that fallback.
  Related behavior changes and execution details stay together, with
  separate **Steps**, **Pseudocode**, and **Flowchart** accordions. Content
  without recorded function ownership is labelled separately, not guessed
  from generated titles. No nested wrappers or file limitations section.
  Final confirmation shows how many function explanations will be inline and
  how many require the file-level fallback.
- Posting uses prepared saved content only and never changes the PR description.
  Summary-only preparation does not generate file comparisons; missing
  explanations and incomplete coverage are disclosed. Standalone export remains
  available without GitHub CLI.
- Requires the exact PR merge-base/head comparison, complete local history,
  at most 200 PR files, and a repository-root review. For a multi-commit PR,
  choose its merge base in **Review Changes…**, not just the last commit's parent.
  The PR's commits must already be available locally; publishing never fetches.
  Local/unsaved differences can be exported but cannot be mislabelled as PR content.
  On-demand PR preparation reads committed snapshots, leaving local edits untouched.
- Rechecks content, sharing exclusions, models, and PR revisions before each
  comment. Posting is explicit and visible to everyone with access to the PR.
  Cancellation cannot retract comments already sent. Errors report partial or
  uncertain publication; no automatic retry or rollback occurs. Definite GitHub
  rejections show a sanitized HTTP status and validation fields, not source text;
  failures identify which comment action stopped.
  Writes are spaced at least one second apart to reduce secondary throttling.
  Inline requests use verified diff positions for GitHub API compatibility;
  returned source line and side are checked before accepting each comment.
  HTTP 422 may mean validation failure or comment spam protection, not necessarily
  an invalid diff anchor. Recognized rejection reasons are shown without server text.
- Repeat publishing skips identical comments by the same account. Choose
  **Update existing publication** to refresh the summary in place and replace
  file/function explanations. Same-revision inline comments update in place
  only when their anchor still matches. New PR revisions get fresh anchors; earlier
  unchanged comments without replies are removed after the replacement is
  verified. Comments with replies are kept as superseded with replacement links.
  Manually edited or legacy comments require extra confirmation to update and
  are never automatically deleted. Deletion counts are shown before publishing.
  Only the signed-in account's Downside Up comments are eligible. Reply checks
  are repeated before deletion, but GitHub cannot make the check/delete atomic.
  GitHub may mark inline discussions outdated after a push.
  Later pushes never generate or update automatically. Oversized
  comments are rejected rather than silently truncated.

### Follow callers

The **Show callers** icon beside a function lists its direct callers. Choose
one to open it, and use VS Code's **Go Back** to return.

- Uses your language extension's Call Hierarchy when available.
- Otherwise, Go, Rust, Python, and SQL use a bounded local scan labelled
  **Statically found callers**. It is not exhaustive: it skips uncertain
  receiver methods, interface/trait dispatch, macros, and closures, and SQL
  matches routines by name only.
- Only eligible files in the current repository are listed. Lookup makes no AI
  requests.

### SQL

- Previews show tables and queries by default, not just routines. Table cards
  list columns, types, required values, defaults, generated expressions, keys,
  and relationships with source links. Enums and sequences are shown too.
- Constraints and indexes declared later in the same file are folded into
  their table cards.
- Queries use sqlc `-- name: ... :one/:many/:exec` names when available, or
  numbered headings.
- **Explain** works on tables, queries, views, and routines, grounded in
  eligible schema definitions.
- Common PostgreSQL, MySQL, T-SQL, and SQLite need no database or language
  server. Opening a preview never executes SQL.
- This is not a full dialect parser: dynamic and embedded SQL are not
  resolved, and repeated definitions follow file order, not migration order.

## Preview controls

| Control | What it does |
|---|---|
| **Project overview**, **Functions** | Choose the model for each [role](#models). |
| **Initialize project** | Builds the repository overview and project map when missing, including after **Clear**. |
| **Refresh** icon beside a page title | Updates only the checked outdated items on that page. |
| **Clear** | Removes this repository's cached results and saved sharing consent. Starts nothing. |
| **Tokens in current cache** | Input/output token totals by role and model for saved results; not lifetime usage or billing. |
| **Cancel** | Stops active requests. |

The divider below the header turns **amber** for known outdated content and
**animated blue** while work is in progress. Slow models can take several
minutes.

## Commands

All commands are in the Command Palette under **Downside Up**.

| Command | What it does |
|---|---|
| **Open Preview to the Side** | Opens the preview for the active file or diff, or an Explorer file or folder. With text selected inside a function, also explains it. Without a source editor or Explorer target, asks you to open a local file. |
| **Preview Project** | Opens the repository's project page; maps the project if there is no current map. |
| **Choose Language Model** | Chooses the Functions model from VS Code language models. |
| **Choose Overview Model** | Chooses the Project overview model. With no model configured, sets up only the Overview model, for review summaries. |
| **Review Changes…** | Prepares comparisons for changed files against a chosen base. |
| **Prepare Commit Explanations…** | Prepares comparisons for one commit against its parent. |
| **Export Review Summary…** | Chooses a review scope (local changes, a base, a commit, or the current/most recent review) and saves its summary as Markdown. |
| **Publish Review to Pull Request…** | Uses saved content or prepares the exact PR review, then confirms publishing or updating summary/file comments. Requires authenticated GitHub CLI. |
| **Show Changed Files** | While a review is active, opens one of its files or stops it. |
| **Refresh Repository Context** | Updates the repository overview and project map. |
| **Clear Repository Cache** | Removes this repository's cached results and saved sharing consent. |
| **Cancel Explanation** | Cancels active requests. |
| **Set OpenAI API Key**, **Remove OpenAI API Key** | Stores or removes your key in VS Code SecretStorage. |
| **Check Content Exclusions…** | Shows the loaded exclusion policies and tests whether a file is excluded. Runs locally. |
| **Choose Content Exclusion Policy Folder**, **Choose Blocked File Patterns File**, **Choose Restricted Remotes File**, **Choose Allowed Repositories File** | Point the [exclusion settings](#organization-exclusion-files) at your organization's policy files. |

## Settings

Open Settings and search for `downsideUp`. Settings marked **user only** are
read from user settings only, so a repository cannot change them.

### Models

| Setting | Default | Description |
|---|---|---|
| `downsideUp.provider` | `none` | `vscode-lm` for GitHub Copilot or another VS Code language model; `openai` for your own API key. **Choose model** sets it for you. |
| `downsideUp.languageModel.model` | empty | **Functions** model: function and change explanations, added views, and file summaries. |
| `downsideUp.languageModel.overviewModel` | empty: uses the Functions model | **Project overview** model: repository overview, project map, folder summaries, main flows, and review summaries. |
| `downsideUp.openai.model` | `gpt-4.1-mini` | Functions model when the provider is `openai`. |
| `downsideUp.openai.overviewModel` | empty: uses `openai.model` | Project overview model when the provider is `openai`. |

Each new model asks once for sharing approval before code is sent.

### Preview and explanations

| Setting | Default | Description |
|---|---|---|
| `downsideUp.preview.include` | all `false` | Extra items to list besides functions: `imports`, `types`, `values`, `locals`, `comments`, `functionComments`, `modules`, and `functionDetails`. Built locally; never uses AI. |
| `downsideUp.explanations.formats` | `pseudocode` and `flowchart` both `true` | Views generated with each new explanation besides Steps. Each enabled view makes requests somewhat larger. |
| `downsideUp.explanations.initialFormat` | `steps` | The view an explanation opens with: `steps`, `pseudocode`, or `flowchart`. |
| `downsideUp.explanations.showDetails` | `false` | Opens **More detail** by default. Never regenerates anything. |
| `downsideUp.hover.savedExplanations` | `true` | Shows a saved explanation's purpose when hovering a call. Reads the local cache only. |
| `downsideUp.projectMap.detail` | `brief` | `detailed` adds a few sentences per component, making the mapping request larger. Applies at the next mapping. User only. |

### Prefetch

Prefetch is off by default. When enabled, it generates explanations in the
background using sharing approval you have already given; it never asks for
approval on its own, and every request counts toward your provider's usage
limits or billing. A one-time prompt offers to enable it when you first open
the preview. All prefetch settings are user only.

| Setting | Default | Description |
|---|---|---|
| `downsideUp.prefetch.enabled` | `false` | Turns prefetch on. Explains functions in the file shown in the preview, starting where you are reading. Required by all settings below. |
| `downsideUp.prefetch.window` | `10` | How many functions nearest your position to prefetch. `0` means every function in the file. |
| `downsideUp.prefetch.dependencies` | `3` | How many functions in other files, called by the function you are reading, to prefetch. `0` means none. |
| `downsideUp.prefetch.diff.changed` | `true` | Prefetches the change comparison for the diff shown in the preview. Does not limit a confirmed review. |
| `downsideUp.prefetch.diff.added` | `false` | Also prefetches full explanations of Added functions in the shown diff. |
| `downsideUp.prefetch.diff.removed` | `false` | Also prefetches full explanations of Removed functions in the shown diff. |

Added and Removed prefetch need a current saved comparison, make one request
per function, and never prepare files you have not opened.

### Reviews

| Setting | Default | Description |
|---|---|---|
| `downsideUp.review.lowValuePatterns` | lockfiles, generated and minified files, vendored folders, and snapshots | Repository-relative globs for review files that stay navigable but skip background comparisons and summary evidence. A user list replaces the defaults; workspace lists add to them. |

### Request limits

All request limits are user only. The model's own input limit still applies.

| Setting | Default | Range | Description |
|---|---|---|---|
| `downsideUp.maxRequestSize` | 96 KiB | 32–512 | Per-request limit for explanations, added views, summaries, and main flows. Large comparisons use diff-first excerpts with up to two same-file context follow-ups; other oversized requests are not sent. |
| `downsideUp.maxProjectContextRequestSize` | 256 KiB | 128–1024 | Largest repository overview and project map request, including previous context. Raising it does not scan more files or start generation. |
| `downsideUp.maxConcurrentRequests` | 6 | 1–8 | How many requests may run at once. Your own requests always start before prefetches. |

### Organization exclusion files

Each setting is a user-only path to a plain-text policy file. See
[formats and examples](docs/configuration.md#content-exclusion-and-enterprise-policies).

| Setting | The file lists |
|---|---|
| `downsideUp.exclusion.blockedFilePatternsFile` | Gitignore-style patterns for files that are never read or sent, in any repository. |
| `downsideUp.exclusion.restrictedRemotesFile` | Git remote URL prefixes whose repositories are not read or sent until they opt in. |
| `downsideUp.exclusion.allowedRepositoriesFile` | Repository paths that may be sent even though their remote is restricted. |

## Language support

| Language | Functions are found with | Related code is found with |
|---|---|---|
| Rust, Go, Python | Bundled parser | Bundled static analysis |
| JavaScript, TypeScript (including JSX and React) | Bundled parser | VS Code's built-in TypeScript go-to-definition |
| Svelte | Bounded component scanner and bundled TypeScript grammar | Static local import resolution |
| SQL | Bundled lexer: tables, queries, views, and routines | Static lookup in eligible `.sql` files |
| Other languages | Your language extension's document symbols | Your language extension's go-to-definition |

- No language server is needed for Rust, Go, Python, JavaScript, TypeScript,
  Svelte, or SQL. Support for other languages varies with installed extensions.
- Svelte support explains a component's script and markup together, plus
  named functions in `<script>`. It recognizes Svelte 5 runes and common
  Svelte 4 syntax, and resolves relative component imports and the conventional
  SvelteKit `$lib` alias locally. It does not type-check Svelte or resolve
  arbitrary SvelteKit aliases. `<style>` blocks are left out of component
  explanations and structural fingerprints.
- Python handles functions, async functions, class methods, properties, and
  nested functions, and follows local helpers, repository imports, and
  same-class `self`/`cls` methods. Dynamic dispatch, inheritance, star
  imports, and re-exports are not resolved. Explanations also include
  syntax-aware background and conservative NumPy, pandas, or PyTorch guidance
  when the function uses names from explicit imports; this does not verify
  installed packages or runtime types, values, shapes, or devices.
- Python explanation freshness includes the file's syntax-aware structure so
  import or binding changes cannot leave library guidance stale. Meaningful
  same-file edits can therefore mark explanations outdated, while formatting
  changes that preserve the syntax tree do not.

## Privacy and control

- **Explicit requests only.** Opening files, moving the cursor, editing source,
  hovering, and cache misses never send requests. Requests come from actions
  such as **Explain**, **Explain changes**, a confirmed review, opening an
  unmapped project page, or prefetch if you enable it.
- **Consent per repository and model.** External requests need a trusted
  workspace and your approval for each repository and model.
- **What is sent.** Depending on the action: selected source, related code,
  file text, diffs, or bounded repository context.
- Python guidance selection reads the eligible local snapshot, but adds only
  fixed extension-authored background to the request, not another copy of the
  whole file. Comparison guidance is selected independently from each exact
  side and omitted for excerpted Python sides.
- **What is never sent.** Files excluded by Git ignore rules, `.copilotignore`,
  VS Code exclusions, secret-like or generated file names, or the
  [organization exclusion files](#organization-exclusion-files).
- **GitHub Copilot's server-side content exclusions do not apply to this
  extension's Language Model API requests.** Configure the extension's
  exclusions to match your organization's policy before sharing source.
  Provider data-handling terms still apply.
- **API keys** are stored in VS Code SecretStorage.

Explanations, maps, and summaries are AI-generated and may be wrong or
incomplete. Outdated indicators check recorded inputs; they are not a
correctness guarantee or a whole-repository audit.

## More information

- [Detailed usage and configuration](docs/configuration.md): provider setup,
  prefetch, review mode, request limits, and enterprise exclusions.
- [How it works](docs/architecture.md): a short developer tour of local
  analysis, model roles, validation, and caching.
- [Architecture and privacy contract](docs/prototype.md), including known
  limitations.
- [Development](docs/development.md): contributor setup, development agents,
  tests, packaging, and releases.
- [Changelog](CHANGELOG.md): release notes.

For a locally built package, install the current version with
`code --install-extension the-downside-up-0.65.0.vsix`.

## License

MIT. See [LICENSE](LICENSE).
