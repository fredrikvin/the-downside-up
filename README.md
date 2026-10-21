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
3. Choose a model with the **Functions** button at the top of the preview.
   For GitHub Copilot, sign in to Copilot in VS Code first. Other extensions
   that provide VS Code language models also work.
4. Click **Explain** beside a function. Review the repository/model sharing
   prompt before any code is sent.

The default provider is **mock**: it shows deterministic placeholder output
without external requests. Choosing a VS Code language model switches to that
provider. Requests use your provider's subscription and usage limits; they are
not free or unlimited. OpenAI API access is also supported with a separate key
and billing.

## Read and explore

- **Explain functions.** Read purpose, inputs, results, and steps in plain
  language. Pseudocode and flowcharts are enabled by default; **More detail**
  adds edge cases, language notes, and related code. Pseudocode highlights
  control words, quoted values, numbers, and backticked code names without
  changing its plain-language wording. Flowcharts use diamonds for decisions
  and rounded start/end nodes. Both improvements also apply to saved results
  and paired diff views, locally without extra AI requests.
- **Stay beside the source.** Editor and preview scroll together. Steps
  highlight their source lines, and saved explanations reappear when you
  return to a file. Click a function's name to navigate to its source;
  use **Explain** to request an explanation.
- **Explore the project.** Run **Downside Up: Preview Project**, preview a
  folder from the Explorer, or navigate the breadcrumbs. Project maps show
  parts and connections; folder pages offer summaries and main flows.
- **Understand a change.** With the preview open, show a Git diff in VS Code
  and click **Explain changes**. The result groups functions into **Added**,
  **Changed**, and **Removed**, followed by **Other changes** for non-function
  edits. Added and Removed functions get a short summary and an **Explain**
  button; only that explicit action requests their normal Steps, Pseudocode,
  and Flowchart detail. Changed functions retain before/after/when/flow items
  and paired visuals. Signature-only changes count; pure comments and
  formatting do not. Renames, container moves, and ambiguous duplicates are
  removed+added, without guessed rename detection. Incomplete discovery falls
  back to an explicitly unclassified textual comparison, without Added/Removed
  cards. The views use the same underlined tabs and subtle
  background highlights as normal files; pseudocode rows have no link styling.
  Flowchart highlights follow the node's shape with a slightly larger halo.
  Click a visual item to focus and select its source lines in the matching
  Before or After side of the existing diff editor.
  With **Prefetch** enabled and sharing already approved, the comparison
  preloads automatically when the preview shows the diff. Otherwise,
  **Explain changes** sends both versions of that one file.
  All comparison summaries and Changed visuals come from **one request per
  file**. Review and diff prefetch never request card details. Each uncached
  detail is a separate request; a working-side addition can first prime/review
  project context with the separately consented Overview model, but does not
  request an incidental file summary. Removed functions and revision/index-side
  additions use only their own snapshot's function and bounded same-file
  preamble, with a limitation: historical callers and cross-file dependencies
  are not resolved. They never use today's repository overview or dependencies.
  Missing formats require their own explicit **Generate** request.
  Failed responses
  report incomplete JSON, malformed JSON, or schema validation errors without
  exposing source text or silently retrying.
- **Prepare a review.** Run **Downside Up: Review Changes…**, select a
  comparison, and confirm the number of changed files to explain; each opens in
  VS Code's native diff. The confirmed count remains one comparison per file;
  Added/Removed details are not included or generated in the background.
- **Choose models by role.** **Functions** handles explanations and file
  summaries. **Project overview** handles repository context, architecture
  maps, folder summaries, and flows.
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
`code --install-extension the-downside-up-0.43.2.vsix`.

## License

MIT. See the repository's `LICENSE` file.
