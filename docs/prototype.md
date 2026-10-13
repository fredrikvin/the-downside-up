# Prototype scope and decisions

## Product scope

The Downside Up helps people understand what code does without knowing the
language. The side-by-side Downside Up preview reads like rendered Markdown.
By default it is concise: the file name, an AI summary of the file (see
below), and one heading per function or method in source order, with its doc
comment. `downsideUp.preview.include` adds local descriptions of imports,
types (structs, enums, interfaces, traits, aliases, implementations, fields),
values outside functions, locals, standalone comments, modules and macros, and
each function's one-line signature description and notes; nesting is
recomputed from the items shown. With everything included it describes every
import, module, function/method, type, constant/static, local variable
binding, and standalone comment in plain language, in source order and
without regrouping, with attached doc comments and attributes. These
descriptions are deterministic and local (Tree-sitter for
Rust, Go, JavaScript, and TypeScript; VS Code document symbols plus line-based import and comment
detection for other languages) and are labelled as not AI-generated. Go
descriptions also explain Go-specific meaning, such as exported names,
pointer and value receivers, multiple and named results, `iota` groups,
distinct defined types, embedding, and `main`, `init`, test, and `//go:`
directive roles; if the bundled Go parser is unavailable, editor symbols are
used instead. The preview follows
the active editor and rebuilds after edits (debounced) without losing its
place. Scrolling either side keeps the other aligned by interpolating between
item anchors, as the Markdown preview does; each side ignores the scrolling it
caused, so the two do not feed back. Inside an open explanation, its linked
steps, pseudocode lines, and flowchart nodes are anchors at their own code
lines, so a scrolled code line lands on what describes it; anchors that would
make the mapping run backwards (such as an exit node beside its decision) are
skipped. Clicking an item in the preview scrolls the editor to its lines but
leaves the preview where it is. Moving the cursor in the code brings what it
highlights into view in the preview (the highlighted item, or else the item
at the cursor) without scrolling the editor back. Item headings are sticky:
a function's heading stays at the top of the preview, on one line with its
AI title shortened if needed, while its explanation scrolls under it, and
the next heading pushes it away; scroll sync and scrolling into view account
for its height. The item at the cursor is highlighted, and double-clicking
an item reveals its source.

AI explanations are written for a reader who does not know the language:
a 2–5 word action title shown in the function's heading, a one-sentence
purpose, inputs with friendly labels, the result, the main steps in order
(including what happens on failure), and extra sections such as cleanup only
when relevant. Language features are described by what they do rather than by
jargon. When parts of a function run at different times (such as a React
component's effects and click handlers, or a callback run later), each step
names when it runs, and the preview groups consecutive steps under that
heading ("Each time it is shown", "When the person clicks Check out"), with
numbering continuing across groups; for most functions every step runs in
one call and no heading is shown. A language can add background on a kind
of function to the prompt (`explanationGuidance` in `LanguageSupport`); it is
the extension's own fixed text, never repository text, and depends only on
the function's own source, which is tracked. For React components it says how
React shows a component again when props or state change, to treat props as
inputs and what is shown as the result, to phrase conditional rendering as
conditions and `map` as "for each", what each built-in hook does in plain
words, that handlers passed to props such as `onClick` run later, and how to
group steps by when they run and lay out pseudocode and flowcharts; hooks and
functions defined inside a component or hook get matching background. Every explanation also includes where the function fits, edge cases,
language notes, related code, and limitations, shown under **More detail**
(`downsideUp.explanations.showDetails` opens it by default); the detail level
is display-only and never regenerates anything. Generated text is rendered as
text, with backticked names shown as code.

The function source is sent with numbered lines, and each step names the
lines it covers (or none). The extension keeps only ranges inside the
function and records the text of each step's first line. While an
explanation is current and open, the steps that cover the editor's cursor or
selection are highlighted (local only), and clicking a step highlights its
lines. Lines are resolved against the function as it is now: if a step's
first line moved, for example after a comment was added, the nearest line
with the same text is used; if that text no longer exists, the step is not
linked. Model-provided lines are never used without this check. A cursor
highlights only the innermost items on its line (a multi-line selection
highlights every item it touches). Clicking an item moves the cursor to its
first line and marks its lines with a line highlight rather than a selection,
because VS Code would also mark every other line with the same text; the
clicked item stays highlighted until the cursor moves. Pseudocode is laid out
from the code it describes: each linked line takes the indentation of its
source line, and a blank line appears where the code has one.

`downsideUp.explanations.formats` adds two optional views of "What happens",
shown as tabs beside the steps (`downsideUp.explanations.initialFormat` picks
the first tab; choosing a tab switches every explanation, like language tabs in
documentation, keeps the clicked tabs in place on screen, and lasts while the
preview is open): plain-language pseudocode lines with indentation, and a
flowchart of start, action, decision, end, and show nodes with labelled edges.
A show node is an exit that returns something shown on screen, such as a
React element, drawn like a small window (a thick top bar and a "Shows"
caption). The logic that decides what appears inside it, such as a decision
choosing a "Delete" or "Cancel" label inside a button, can be drawn inside it
as its own small flow, and show nodes can contain show nodes, up to 3 levels
deep. Both
carry source lines checked like steps, so they highlight at the cursor and
select their lines when clicked. Enabled views are requested together with
new explanations (making each request somewhat larger). For a saved
explanation without a view, its tab offers **Generate**, an explicit request
that sends the function source with numbered lines and the saved step titles,
and saves the view into the explanation only if the function and its context
are unchanged afterwards. The flowchart is validated before use (at most 24
nodes and 40 edges, unique node IDs, edges only between known nodes); an
invalid view is dropped without failing the explanation. A node nested in
anything other than a show node, in itself, in a cycle, or more than 3 levels
deep is drawn at the top level instead, and an edge between nodes at
different nesting levels is dropped, since each level is drawn as its own
flow. The panel draws the
flowchart itself from HTML boxes and SVG lines, with every label set as text:
the main path runs downward in the first column, an early exit sits to the
right of the node it leaves from, and edges that loop back are routed up the
left side, so loops and exits never cross. Room for loops is reserved only when
a chart has them, and a chart wider than its column is scaled down (to at least
60%) so the whole flow stays visible; below that it scrolls sideways. A show
node with nodes inside it holds a smaller flow laid out the same way, and
boxes in its row line up with its top. Clicking a node inside it selects only
that node's lines. No diagram library or HTML parsing is involved.

Every function has an **AI explanation** section. Opening it,
clicking the function name, or running **Open Preview to the Side** (the
editor title-bar button) while text inside the function is selected is an
explicit request (with a selection, an outdated, failed, or cancelled
explanation is regenerated); with only a cursor, opening the preview never
generates. For a request, the extension first looks
for a current saved explanation (local only) and generates one only when none
exists and the section is still open. Loading shows a spinner and can be
cancelled. Several sections can be open, and up to
`downsideUp.maxConcurrentRequests` provider requests (default 3, 1–8, user
settings only) run at once. Building or reviewing the repository overview is
exclusive per repository, so parallel requests wait for it and reuse it
instead of priming twice, and parallel requests share a single code-sharing
prompt per repository and model. Explicit requests always start before
waiting prefetches. When the preview shows a file, it checks the local cache once for that
file's functions and shows those with a current saved explanation, open,
so saved explanations remain visible after the preview is closed and reopened
or VS Code restarts; misses stay collapsed. Current explanations, saved or
prefetched, open automatically unless the reader collapsed that section;
outdated ones are not reopened. Repository and
function context are gathered only for functions that have a saved record.
Selecting non-empty text inside a function in the editor only checks for a
fresh saved explanation and opens its section when one exists. A cache miss
never triggers generation. Opening files, moving the cursor, scrolling, local
outlining, and source edits do not call a provider, unless the user turns on
prefetching (below). After edits, file changes,
or a model change, open explanations are rechecked against the cache locally
and marked outdated when their recorded inputs no longer match.

Prefetching is an opt-in exception to explicit-only generation. With
`downsideUp.prefetch.enabled` (off by default, user settings only, so a
repository cannot turn it on), the extension generates explanations in the
background for the functions of the file shown in the preview. It starts with
the function at the cursor (or the middle of the visible lines when the cursor
is off screen) and spreads outward, re-evaluating the order after every
request, so the reader's position acts like a priority. `downsideUp.prefetch.window`
(default 10, `0` for every function) limits it to that many functions nearest
the reader; moving through the file moves the window and fetches newly
nearby functions. `downsideUp.prefetch.dependencies`
(default 3, `0` for none) adds the functions and methods in other files that
the function nearest the reader calls (found as for explanation context,
below): among its first that many calls in
order of use, the ones without an explanation are fetched right after that
function and before the rest of the window. Calls that already have an
explanation count toward the number, so at most that many are considered per
function read. Prefetching starts after saved explanations are marked
ready, fills the request slots explicit requests leave free (never the last
one, unless the limit is 1), choosing the function nearest the reader each time
a slot frees, opens each explanation when it is ready (unless the reader
collapsed it), and does not regenerate outdated, failed, or cancelled
explanations or functions added by later edits. Switching files drops
prefetches that have not been sent; one already sent finishes and is saved.
Closing the preview, Cancel, Clear Repository Cache, or turning the setting
off stops it. A failed request is retried once after a five-second pause,
for example after a rate limit; a second failure stops prefetching with a
notice. It runs only in a
trusted workspace and only after code sharing was approved for the repository
and model by an explicit explanation; it never asks for approval itself and
shows a notice when it is waiting for one. Prefetching uses the provider's
usage limits or billing for every function it explains.

Review mode explains the functions changed on the checked-out code ahead of
the reader. **Review Changes…** offers bases found with Git: the merge base of
`HEAD` with the remote's default branch, `main`, `master`, `origin/main`, or
`origin/master`, those branches' tips, `HEAD` (uncommitted changes only), and
any of the last 50 commits. It compares the base with the working tree
(`git diff --unified=0 -M <base>` restricted to the repository root, plus
untracked files that are not ignored, counted whole); commits that are not
checked out are not explained, since everything else works on the working
tree. A function counts as changed when a changed line falls inside it
(including its attached comments), or lines were removed from inside it;
nested functions and the functions around them all count. Functions come
from the same local description as the preview, so this works for every
language the preview describes. At most 200 changed files are considered, and
excluded files are skipped and counted. Nothing is sent until the user
confirms the number of functions; running the command is an explicit
request, so if code sharing is not yet approved for the repository and model,
the first function is explained as an ordinary request, which asks. The rest
are explained like prefetching: with the free request slots (never the last
one), keeping sections collapsed, never prompting, skipping functions with a
current explanation or an explicit request in progress, and in the file being
read nearest the reader first, otherwise in path and line order. A failed
function is retried once after five seconds; after three failures review
mode stops with a notice. It also stops when the preview closes, on **Cancel**,
or when consent is missing; **Clear Repository Cache** ends it. A status bar
item shows progress and opens a list of the changed functions with their
state, to jump to one, stop, continue, or close review mode. It works
regardless of the `downsideUp.prefetch.*` settings.

Hovering a call to a function inside another function shows the
purpose from that function's current saved explanation, found with the same
local dependency resolution as explanation context. In languages without
bundled analysis only words followed by `(` are considered, and only the
hovered name is looked up. The hover reads only the
local cache (after the usual freshness check), never generates, renders
generated text as plain text, and can be turned off with
`downsideUp.hover.savedExplanations`. Like the rest of the extension it is
available once a Downside Up command has activated it.

The core is language-neutral. Rust and Go function discovery and source
fingerprinting use bundled Tree-sitter WASM grammars, so neither needs a
language server; Go methods are identified by receiver type (for example
`Catalog.Add`). JavaScript and TypeScript, including JSX and React, also use
bundled Tree-sitter grammars (TypeScript for `.ts`, `.mts`, and `.cts`, since
generic arrow functions such as `<T>(x: T) => x` read as JSX in TSX; TSX for
`.tsx` and all JavaScript). Their functions are function declarations,
functions and arrow functions assigned to variables, functions wrapped in
calls known to return them (`memo`, `forwardRef`, `useCallback`, `observer`,
`debounce`, `throttle`, `once`, `memoize`, and `with…` higher-order
functions), class and object methods, and class fields holding functions,
named by their enclosing classes, objects, and functions (for example
`CartView.handleCheckout`); a default-exported unnamed function is `default`.
Unnamed callbacks, such as an effect passed to `useEffect` or a callback
passed to `items.map` or `useMemo`, are part of the function around them. A
capitalized function that returns JSX, or is wrapped in `memo` or
`forwardRef`, is a component; a function named `use…` is a hook. Other
languages use VS Code document-symbol providers,
including nested symbols such as class methods; unnamed functions that
providers name by position (such as TypeScript's `find() callback`) are
treated as part of the function around them. The fixtures exercise Rust, Go,
JavaScript, and React with TypeScript.

Language support is modular. Each language with bundled analysis is a folder
under `src/languages/` (parser, local file description, and dependency
resolution) that exports one `LanguageSupport` object
(`src/languages/support.ts`): its language IDs and file extensions, how to
find the function at a position, list functions, describe the file, build the
file's import preamble, and find the items a function uses. The registry
(`src/languages/registry.ts`) lists them and is the only place the rest of the
extension asks about languages: function discovery, the preview's local
description, the repository symbol outline, the inventory's language IDs,
explanation context, tracking, hovers, and prefetching. Adding a language
means adding its folder, one registry entry, and, for a Tree-sitter grammar,
its name in `esbuild.config.mjs` so the grammar is bundled. Languages
without one use `src/languages/editor/`, which implements the same interface
with VS Code document symbols and go-to-definition.
Arbitrary blocks,
automated edits, a full repository browser, vector stores, cloud state,
collaboration, and marketplace publishing are out of scope.

## Repository context and grounding

Before the first explanation, the extension gathers bounded local evidence:
project manifests, README and architecture-style documents, selected source
files, and a small symbol outline. Rust, Go, JavaScript, and TypeScript symbols use Tree-sitter; other
symbols use VS Code providers where available. Function context adds related types,
imports, directly related helpers, and references where tooling can resolve
them. For JavaScript and TypeScript, it adds the file's import and
re-export statements and, under the same budgets as Rust and Go below, the
items the function uses (depth 1): the functions, hooks, and methods it
calls, the components it renders (capitalized JSX tags, including
`<Cart.Item>`), and the interfaces, type aliases, enums, and classes it names
(such as its props type). Each name is resolved, at its first use, with VS
Code's built-in TypeScript go-to-definition (at most 40 distinct names) and
read with the bundled grammar at the definition; definitions that are not a
function or type declaration (such as a variable or an object property) are
skipped. At depth 2, the signatures of the functions those call are added.
Right after VS Code starts, TypeScript first answers from a syntax-only
server that resolves names only within a file, so an imported name leads to
its `import` line. Before resolving, the extension asks for the definition of
a name the file imports from a relative or aliased path (`./`, `../`, `/`,
`@/`, `~/`) and waits, up to 15 seconds once per repository, until it leads
elsewhere; otherwise a function explained during that time would be saved
without what it uses and later shown as outdated. If TypeScript does not
answer in time, what it resolved is used and the limitation is stated. For
other languages without bundled analysis, it adds the functions the
function calls (depth 1) and, at depth 2, the signatures of the functions
those call, under the same budgets as Rust and Go below: call sites (a name
followed by `(`, outside comments and quoted strings, skipping keywords and
declarations) are resolved with VS Code's go-to-definition, at most 24
distinct names, 1.5 seconds per lookup, and 4 seconds for the whole function
including depth 2, and each definition is mapped to its enclosing function
with document symbols. Definitions outside the repository (such as the
standard library or `node_modules`), in files the inventory may not read
(ignored, excluded, or secret-like), or inside the function itself are
skipped; a timeout, files outside the read budget, or a language without a
definition provider are stated as limitations. For Rust, it also adds the items the function uses directly from other
files of the crate (depth 1): types, functions, constants, and methods of used
types, found by following `use` declarations and paths (`crate::`, `self::`,
`super::`, child modules, `mod.rs`, glob imports, and the package's own name
from `tests/`, `examples/`, or `bin/` files) with Tree-sitter and Cargo's
file layout. Items are sent whole up to 4 KiB each and 16 KiB in total; a
larger item is sent as its signature only, and items beyond the budget are
omitted with a stated limitation. At depth 2, for Rust and Go, the signatures
(not bodies) of the functions and methods that the depth-1 functions sent whole
call are added, from up to 8 such functions, at most 12 signatures and 4 KiB in
total; anything already tracked is skipped. External crates and the standard library are
not followed. For Go, function context adds the file's package clause and
import block and, under the same budget, the package-level functions, methods,
types, constants, and variables the function uses directly: from any file of
its own package (test files only for tests) and from imported packages inside
the same module, found through `go.mod`'s module path. Methods are matched for
the types the function names and the types returned by functions it calls.
The standard library and other modules are not followed. Snippets sent to the model are labelled with their file path and what
they contain, and the model is asked to refer to code by file, function, and
type names in plain prose rather than by identifiers. The "related code" links
under an explanation come from the extension's own analysis, so navigation only
goes to host-validated locations, never to locations taken from model output.

The overview aims for approximately 500–1,000 words and separates observations,
inferences, and limitations. It is shown at the end of the preview
for inspection.
The repository overview is cached by repository and provider/model/prompt
configuration. Explaining another function in an unchanged repository reuses the
same overview; a bounded review/re-prime happens only when tracked repository
changes make the existing overview potentially stale.
Priming and explanation inputs are bounded by byte budgets; the complete
priming/review request is limited to 96 KiB and the complete explanation request
to 48 KiB. The scanner examines at most 2,000 eligible files, reads at most
200 files and 12 MiB for snapshots, and excludes files over 256 KiB. Initial
priming source/document text is capped at 80 KiB, with up to 16 KiB for the
symbol outline. Excessive complete prompts fail before source is sent.

The scanner honors `.gitignore`, `.copilotignore` (including `.copilotignore`
files in folders above the repository, with patterns relative to their own
folder), and VS Code file/search exclusions, plus an optional organization
exclusion policy read from files named in user settings only (application
scope; workspace values are ignored), as plain-text files with one entry per
line and `#` comments (a format some organizations already keep for their
Copilot hook scripts): gitignore-style blocked file patterns
applied to repository-relative paths in every repository; restricted remote
URL prefixes, where a repository with a matching remote is not read at all
(the scan is empty, explanations and file summaries stop with the reason, and
**Refresh Repository Context** sends nothing) unless it has a `.copilotignore`
at its root or in a folder above it, a `.allowed-services` file at its Git
root naming `copilot`, or a repository path matching the allowed-repositories
file (`*` matches one path segment). Empty settings and unreadable files add
nothing, matching the hooks; decisions about a repository are cached for ten
seconds and cleared when the settings change. It avoids symlinks, hidden trees, common generated/dependency/vendor
directories, secret-like names, credentials, binaries, and lock-binary files.
The same rules apply to the file that holds the function being explained:
before any scanning or provider request, an explanation (explicit or
prefetched) of a function in an excluded file stops with the reason, nothing
is sent, and the preview shows a notice for that file and never prefetches
it. Its local description and any explanation saved before it was excluded
remain local and visible.
Open buffers take precedence over disk contents. Repository text is untrusted
data, not instructions to the extension. The current Git branch and commit are
also fingerprinted when Git metadata is available; branch changes enter the
bounded overview review flow.

## File summaries

After a function is freshly explained (explicitly or by prefetching), the
extension also asks for a one-sentence plain-language summary of that file,
unless a current one is saved; this uses the same request slots and consent
and never prompts. The request contains the file's text (up to 24 KiB,
truncated with a note beyond that), its path and language, and the repository
overview's purpose. Excluded files are never summarized. Summaries are cached
per file, provider, model, and prompt version, with a whitespace-insensitive
fingerprint of the file text: after other edits the preview shows the old
summary marked outdated until a function in the file is explained again.
Opening a file only reads the cache. When an AI summary is shown, it replaces
the file's leading doc comment at the top of the preview.

## Folder and project previews

A folder (or, with **Preview Project**, the repository root) is previewed one
zoom level above files. It is opened from the Explorer's context menu ("Open
Preview to the Side" on a folder), the **Preview Project** command, or the
breadcrumb trail shown at the top of file and folder previews, whose steps
(every folder from the repository root down) open folder previews. The
preview stays on the folder until the active editor changes or a file is
opened from it; opening a file there also previews it even when its editor
was already active. Links and boxes use navigation ids that the extension
resolves, so the webview never names paths.

The listing applies the scanner's rules (hidden, dependency, and build
folders, `.gitignore` and `.copilotignore`, VS Code exclusions, the
organization policy, secret-like names, and non-text files are skipped; hidden
files are not listed) and shows subfolders that hold eligible files, with
their counts (the walk stops after 20,000 folder entries and says so), then
files with their language and their saved one-sentence summary, read from the
cache with the same freshness check as the file preview (a changed file's
summary is shown as outdated). Nothing is generated.

The structure diagram is computed locally. Every eligible file under the
folder (at most 1,500 files and 24 MiB, skipping files over 256 KiB) is parsed
by its language support's optional `fileImports`, which returns the
repository files or folders it imports: JavaScript and TypeScript relative
specifiers in imports, re-exports, `require`, and `import()`, with `.js` to
`.ts` mapping, `index` files, and `paths` from the nearest `tsconfig.json` or
`jsconfig.json`; Go imports inside the module named by the nearest `go.mod`
(package folders); Rust `mod` declarations and `crate::` paths (module files).
Other languages contribute no edges and the preview says so. Results are
cached per file by modification time and size. Imports are counted per
importing file and target and summed into edges between the folder's direct
children; imports within one child, or leaving the folder, are left out. The
layout (`structureLayout`, a self-contained function also run in tests) puts
importers above what they import by longest path, moves a child imported by at
least half of the others (with five or more children) to a bottom "shared"
row without drawing its edges (it shows "used by N"), puts children with no
drawn edges in a row of their own, breaks cycles by depth-first search and
routes their closing edges up the left, gives edges that skip rows an
invisible waypoint in each row so they run between boxes, and orders rows with
barycenter sweeps to reduce crossings. Arrows are spread along box edges and
drawn thicker for more imports.

Folder summaries are AI-generated only on an explicit **Summarize this
folder** (or **Regenerate**) in the folder preview, which may ask for
code-sharing approval like an explanation and uses an explicit request slot.
The request (`folderSummaryPrompt`) holds the folder's path, the repository
overview's purpose as background, and for each listed part (at most 150) its
saved summary (a file's one-sentence summary or a subfolder's folder summary,
current or not), or else the names of a file's functions and types from its
bundled language support (at most 20) or a subfolder's contents (at most 20),
the import edges between parts by name (at most 200), and the folder's README
(at most 8 KiB, marked when truncated); never source code, and a restricted
repository sends nothing. The model returns one sentence on what the folder is
for, two to four on how its parts fit together and where to start, and one
sentence for each part without a summary; sentences about parts that were not
listed, or that have a summary, are dropped, and the preview marks the rest as
inferred from names. Folder summaries are cached per folder, provider, model,
and prompt version with a fingerprint of the input (not of the repository's
purpose), so a changed part, summary, function name, import, or README marks
the summary outdated; opening a folder preview only reads the cache. A
subfolder's saved summary feeds its parent's input, so summaries can be built
bottom-up.

## Providers and data handling

Mock mode is the default and returns deterministic placeholder content. It is
useful for development and tests, but it is not a semantic explanation.

OpenAI is a live provider, using the Responses API with structured output,
request-size limits, timeout/cancellation handling, and `store:false`. Actual
usage is shown when reported by the provider; byte-based estimates are labelled
as estimates. The key is entered through the extension command and stored only
in VS Code SecretStorage. API access and billing are separate from a Copilot
subscription.

The `vscode-lm` provider uses the VS Code Language Model API
(`vscode.lm`), so GitHub Copilot or any other extension-provided model works
without an API key and uses the user's existing subscription and its usage
limits. **Downside Up: Choose Language Model** lists the available models and
records the vendor and model ID; if none is recorded, Explain asks for one
first. Copilot's internal `copilotcli` models are listed by VS Code but only
serve Copilot CLI sessions and never return output, so the picker hides them
and a previously saved one prompts for a new choice. The cache and consent
identity is `vendor/id`. VS Code shows its own
one-time permission prompt for language-model access in addition to this
extension's consent. The API has no system role or schema-constrained output,
so the instructions and JSON Schema are sent in a single user message, and the
reply is validated with the same parser as other providers. Malformed replies
fail without an automatic retry. The request is checked against the model's
`maxInputTokens` before sending, the output is capped, and requests time out
after 90 seconds. Token usage comes from the model's `countTokens` and is
labelled as an estimate (falling back to a byte-based estimate when a vendor
reports zero). Permission, quota/rate-limit/policy blocks, empty replies, and
unavailable models are reported with actionable messages; there is never a
fallback to another provider.

Before an external request, the extension asks for explicit consent for the
repository, provider, and model. It sends the selected function and relevant snippets,
repository overview, and bounded priming/review input as needed. Changing
provider or model requires renewed consent. Each approval is kept per
repository and model (`consents` in the cache, with `consent` as the latest),
so switching back to an approved model, or using a separate overview model,
does not ask again; prefetching only uses approvals already given.

An optional overview model does project-level work: the repository overview
(priming, review, and **Refresh Repository Context**) and folder summaries.
For VS Code language models it is chosen with **Choose Overview Model**
(`downsideUp.overviewModel.vendor` and `.id`); with OpenAI it is
`downsideUp.openai.overviewModel`; empty settings use the explanation model,
and the mock provider ignores it. Explanations, pseudocode and flowchart
views, and file summaries always use the explanation model. The overview and
folder summaries are cached per overview model, so changing it means the next
explanation reviews or primes the overview with the new model and folder
previews look up that model's summaries. External sharing is disabled in
untrusted workspaces. For OpenAI, `store:false` is not a guarantee of zero
provider-side retention; review the provider's current data controls before use.
GitHub Copilot content exclusion configured by administrators on GitHub is
not applied to this extension's requests, even with Copilot models: GitHub
enforces it in Copilot's own features, and requests through the VS Code
Language Model API carry plain text without file identity. Organizations
that rely on it should mirror the excluded paths into `.copilotignore` or the
organization policy files above.
For VS Code language models, data handling follows the model provider's terms
(for Copilot, the user's or organization's Copilot plan and policies). No
provider request occurs without the user requesting an explanation or
repository-context refresh, or turning on prefetching in user settings.

## Cache and freshness

Overview and explanation records are stored in VS Code global storage, outside
the target repository. Explanations and file summaries have their own prompt
version, separate from the repository overview's, so changing the explanation
format outdates saved explanations once without rebuilding overviews; the
switch to plain-language explanations is such a change. The cache includes prompt/schema/model settings and
fingerprints of the relevant source and context. Function identity does not
depend on line numbers or navigation history. Rust methods are identified by
their `impl` type and trait (for example `Catalog::add` or
`<StoreError as Display>::fmt`), so same-named methods in different `impl`
blocks have separate explanations; explanations of Rust methods saved by
versions before 0.4.0 are therefore not reused. Rust structural fingerprints
preserve meaningful tokens and literals; languages using VS Code symbols use
conservative source matching and may invalidate on formatting changes.

Unchanged explanations are reused across extension restarts without a provider
call. An explanation is outdated only when its own tracked inputs change (the
function, its file's imports, and the items it uses), or the explanation
prompt, settings, provider, or model change. The repository overview is
background context and not part of that: changes to files sent for priming,
manifests, entry points, additions/deletions, or the Git branch/revision make
the overview due for a bounded review, which happens the next time an
explanation is actually generated (or on **Refresh Repository Context**), but
they do not outdate saved explanations. A saved explanation, even one opened
explicitly, is returned without reviewing the overview first. When the
overview has changed since an explanation was made, the explanation stays
current and notes under **More detail** that an earlier overview was used;
regenerating it uses the latest one. Unrelated edits do not by
themselves discard a valid explanation. Unsaved buffers participate in
freshness checks, and results are not saved as current if source changes during
generation.

Each explanation records what it was built from, so tracking matches what the
model saw. Every tracked input notes its depth (0 for the function itself, 1
for items it uses directly, 2 for functions those call) and whether it covers
the whole item or only its signature. A function's explanation
becomes outdated when its own source, its file's imports, or any directly used
item changes (for languages without bundled analysis, the functions it calls),
including items in other files, or when the signature of a
depth-2 function changes. Rewriting a depth-2 function's body, changes beyond
depth 2, or changes to other items in the same files do not by themselves make
it outdated; a change to a file
sent for priming still enters the overview review described above. For an item
tracked by signature only, body edits keep the explanation current.
Formatting-only edits do not change Rust or Go
structural fingerprints, attributes such as `#[derive(...)]` count as part of a
Rust type, and each Go constant tracks its whole `const` group because `iota`
and implicit repetition depend on it. Saved explanations of Rust functions that
use items from other files, and of all Go functions, are shown as outdated once
after upgrading, because they were made without that context. `go.mod` is now
part of the repository inventory, so a Go repository's overview is reviewed
once as well. Saved JavaScript and TypeScript explanations are not found
after upgrading to the bundled grammars, because function identities changed
(and now include arrow functions); explain those functions again. Saved
explanations of functions in other languages that call
functions in the repository are likewise shown as outdated once, because the
called functions are now part of their context; functions whose editor symbol
details were previously unread may also need one new explanation.

Invalidation never regenerates automatically. Use the preview's
**Regenerate** link, or select text in the function and run **Open Preview to
the Side**, to regenerate. **Refresh Repository
Context** explicitly reviews or rebuilds the overview. **Clear Repository
Cache** removes cached overviews, explanations, and saved provider consent for
that repository. Freshness means recorded inputs match; it does not prove the
generated explanation is correct.

## Local development and verification

Requirements: Node.js 18+, npm, Git, Cargo for the Rust fixture, Go for the Go
fixture, and VS Code 1.90+.

```sh
npm ci
npm test
npm run test:extension
cargo test --manifest-path fixtures/rust-app/Cargo.toml
(cd fixtures/go-app && go test ./...)
npm run package
```

Open the project in VS Code and press F5 to launch the Extension Development
Host. Open a fixture source file and run **Downside Up: Open Preview to the
Side**, then click a function in the preview (or select text inside a
function before opening the preview). For live generation, either run **Downside
Up: Choose Language Model** to use GitHub Copilot or another VS Code
language model, or configure `downsideUp.provider` as `openai` and store an
API key using **Downside Up: Set OpenAI API Key**. Then explicitly accept the
per-repository sharing prompt.

The deterministic unit suite covers cache reuse across restart, batched
saved-explanation lookup, request scheduling with priorities and a reserved
slot, a single overview build for parallel explanations, shared consent
prompts, prefetch ordering and windows, called-function
lists for hovers and prefetching, Rust and Go dependency resolution and their
depth-1 freshness and signature-only budget, depth-2 signatures (body edits
keep an explanation current, signature edits outdate it), Go method naming, source and
context invalidation, unrelated edits, explanations staying current when only
the overview changes, overview content-version preservation,
branch changes, in-flight edits, cancellation, clear-cache fencing, provider
failures, VS Code language-model prompt/validation/error/cancellation handling,
ignored files, per-file sharing exclusion reasons and refusal before any
provider request, unsaved buffers, parser fingerprints, the language registry,
symbols shaped like VS Code's command results (nested methods, anonymous
callbacks), and call resolution through editor tooling (call sites outside
comments and strings, other-file and same-file callees, skipped ignored files
and external definitions, hovered-name-only lookups, depth-2 signatures and
their freshness, missing definition providers, and the lookup deadline), and
JavaScript and TypeScript analysis (named functions, components, hooks, and
methods but not callbacks or values from `useMemo` or `items.find`, generic
arrow functions in `.ts`, the function at a position, positions after
non-ASCII text, component and hook labels, props, state, refs, remembered
values, wrapper notes, plain JavaScript descriptions, hooks, rendered
components, and helpers in order of first use, hovered-name-only lookups,
waiting for TypeScript to load the project, and the props type and depth-2
signatures with their freshness). Extension
host tests exercise Rust, Go, JavaScript, and React discovery (Go without a language
server), distinct identities for
same-named Rust methods in different `impl` blocks, document-ordered outlines,
explanations requested by selecting text and opening the preview, preview creation, selection changes during an in-flight
request, saved explanations listed as ready after closing and reopening the
preview, steps that follow the cursor and select their lines when clicked, a flowchart
added on request whose nodes follow the cursor and select their lines, prefetching that starts at the cursor, stays within its window, and
follows the cursor, prefetching of a called function in another package,
saved-explanation hovers that appear only when an explanation is saved and
never generate, a folder preview of the Go repository root (excluded
folder left out, import edges), the Explorer command previewing a folder, and
switching to a file leaving the folder preview, a folder summary generated
only on request and shown as current when the folder is previewed again,
review mode queueing only an edited component and a new
untracked file's component and explaining both, including the one in a file
that is not shown, JavaScript calls resolved through the built-in TypeScript
go-to-definition (standard-library calls not followed) and their hovers, a
React component's concise preview (component and nested handler) with no
explanation generated for a plain cursor, its
hook, rendered component, and helper resolved in order of first use through
the real TypeScript server, its props interface tracked, a `memo`-wrapped
arrow component explained and shown when hovering `<CartItem>`, refusal to explain a function in a `.copilotignore`d file, and
unsupported plaintext discovery. Each run uses a fresh temporary
VS Code profile so earlier runs' windows are not restored.
Concise-outline tests cover which items each `preview.include` option adds and the
recomputed nesting; schema tests cover the plain-language explanation and file
summary formats; step-line tests cover numbering, validation, lines that
moved, and cursor and selection matching; view tests cover pseudocode and
flowchart parsing, rejection of malformed flowcharts, and adding a view to a
saved explanation; service tests cover file summaries being generated once,
reused while current, outdated after edits, and never made for excluded files;
provider tests cover step phases (kept, trimmed, or dropped when unusable),
the phase instruction, and background added to the prompt only when given;
flowchart tests cover show nodes, nesting inside show nodes (kept up to 3
levels; unknown, non-show, self, cyclic, and deeper parents moved to the top
level), and edges between nesting levels being dropped;
policy tests cover blocked, anchored, and folder patterns, remote prefixes and
repository paths, no effect without settings, blocked files left out of the
scan and refused as the explained file, restricted repositories with an empty
scan until they opt in with `.allowed-services`, `.copilotignore`, or an
allowed-repository listing, workspace values being ignored, and
`.copilotignore` files above the repository; a settings test keeps the policy
settings user-level;
folder tests cover listings (subfolder counts, hidden, excluded, and non-text
files left out), Go, Rust, and TypeScript import edges between a folder's
children, and the structure layout (importers above imports, shared rows with
hidden edges, unconnected rows, cycles' upward edges, waypoints for edges that
skip rows, crossing reduction, and running standalone as in the webview);
folder summary tests cover the input (names, saved summaries, function names,
imports, no code), parsing that drops unusable part sentences, and the
service saving a summary, keeping only sentences for parts without one, and
marking it outdated when the input changes but not when the repository's
purpose does;
overview-model tests cover keeping one approval per model and reading older
single approvals, and the service priming with the overview model while
explaining with the explanation model, and summarizing folders with the
overview model;
review-mode tests cover changed lines from diffs (ranges, removals, deleted
files, paths with spaces), when a removal counts for a function, base choices
in a real Git repository (merge base, branch tip, uncommitted only, recent
commits), committed, uncommitted, and untracked changes relative to a
subdirectory root, and the order of changed functions near the reader;
React guidance tests cover components, memo-wrapped components, hooks, and
functions inside them, and none for other code; and a service test checks the
background reaches the provider for a component and not for a plain function.
Local description tests cover Rust items (imports, modules, functions and
methods with receivers, structs, enums, traits, impls, constants, statics,
aliases, macros, locals, doc comments, attributes, and standalone comments),
Go declarations (package, imports, functions and methods with receivers,
structs with embedding, interfaces and constraints, defined types, aliases,
grouped constants with `iota`, variables, locals, doc comments, directives,
and standalone comments), JavaScript and TypeScript declarations (imports,
re-exports, functions, components, hooks, methods, classes and class
components, fields, interfaces, type aliases, enums, constants, locals, React
state, refs, context and remembered values, JSDoc, and standalone comments), symbol-based descriptions and import detection for other languages, scroll
anchor interpolation in both directions, prompts that ask for plain-prose
references rather than identifiers, and the
webview's content-security policy.

## Limitations and verification status

- GitHub Copilot's server-side content exclusion is not visible to the
  extension and is not applied to its requests; only `.gitignore`,
  `.copilotignore`, VS Code exclusions, the built-in path rules, and the
  optional organization policy files are. Blocked patterns are matched
  against repository-relative paths, so a pattern containing a slash is
  anchored at the repository root, and negated patterns (`!`) in a
  `.copilotignore` re-include files only within the same file.
- Rust macros, procedural macros, and conditional compilation may hide or alter
  syntax and relationships. Tree-sitter is not a Rust compiler.
- Cross-file Rust tracking follows bodies at depth 1 and signatures at depth 2,
  and stops there; it resolves names without type
  inference. A method call such as `value.find(...)` is matched by name against
  methods of the types the function uses, so it may track an extra same-named
  method or miss one whose type is never named. It follows Cargo's default
  file layout only (no `#[path]` attributes or `include!`), does not follow
  other crates in a Cargo workspace, finds `impl` blocks only in the file that
  defines the type, and skips module files outside the inventory's read budget
  (stated as a limitation).
- Go tracking also follows bodies at depth 1 and signatures at depth 2, and
  matches method calls by name against
  methods of the types the function names or receives from calls, so it may
  track an extra same-named method or miss one reached only through an
  interface, embedding, or a variable of an unnamed type. Build tags and
  `//go:build` constraints are ignored, packages are followed only within the
  file's own module (not `go.work` workspaces, `replace` targets, or
  `vendor/`), and package files outside the inventory's read budget are
  skipped with a stated limitation.
- Structure diagrams show imports only: dependency injection, plugin
  registries, message queues, HTTP calls between services, Rust `super::`
  and `self::` paths, Go imports of other modules, TypeScript `baseUrl`
  imports without `paths`, and languages other than Rust, Go, JavaScript, and
  TypeScript are not drawn. A child folder counts as one box, however large.
- Callers are tracked only when VS Code tooling reports them. In languages
  other than Rust, Go, JavaScript, and TypeScript, only called functions are tracked (not the types,
  constants, or variables a function uses), and only when the installed
  language extension provides go-to-definition. Call sites are found
  textually (a name followed by `(`), so calls through references (passing a
  function as a value), decorators, operators, or interpolation inside quoted
  strings (such as Python f-strings) are missed, and a slow language server can
  leave calls out (stated as a limitation), which can show an explanation as
  outdated until the server answers again. Each name is resolved at its first
  call site only.
- JavaScript and TypeScript tracking depends on VS Code's built-in
  TypeScript go-to-definition (or a replacement that provides it). Names are
  resolved at their first use only, and at most 40 per function. Functions
  passed as values (such as an `onRemove` prop or a handler given to
  `onClick`) are not followed, a method reached through an object returned by
  a hook resolves to the returned property rather than the function, and
  wrappers other than the listed ones (and class components' lifecycle) are
  not recognized as functions. Components are recognized by name and JSX;
  `React.createElement` calls and render props are not treated as rendering a
  component. Values a function uses (constants, context objects) are not
  tracked. Tree-sitter does not type-check, so files with syntax errors may
  lose functions.
- Other language support depends on installed VS Code document-symbol
  providers. There is no whole-program analyzer or guaranteed call graph;
  unresolved references and unavailable tooling are surfaced as limitations.
- Review mode needs Git and a commit to compare with. It compares with the
  working tree only, finds changed functions by line overlap (a renamed or
  moved function counts as changed, and a deleted one is not listed), and
  skips a changed function it can no longer find by name, for example after
  edits move it before its turn.
- Git branch/revision tracking requires an available Git executable and a
  resolvable `HEAD`; when unavailable, source-file fingerprints still apply and
  the limitation is reported.
- The prototype supports local file workspaces. Remote workspaces and binary,
  generated, vendored, ignored, secret-like, oversized, or out-of-budget inputs
  are omitted.
- Mock output is deliberately placeholder text. No live OpenAI credentials were
  supplied, so live OpenAI generation has not been verified. The VS Code
  language-model provider is covered by unit tests with a simulated model;
  live generation through a signed-in Copilot account has not been verified,
  and model quality and JSON compliance vary by model. The Extension
  Development Host verifies command behavior and preview creation. The preview
  layout, scroll alignment, and click actions were checked by rendering the
  webview in a browser, but not inside VS Code with real themes; a manual
  accessibility inspection has not been completed.
- Local descriptions are syntactic: they restate declarations, signatures,
  imports, and comments, not behavior. Languages other than Rust, Go,
  JavaScript, and TypeScript depend
  on the installed symbol provider's detail; import detection covers JavaScript/
  TypeScript, Python, Go, Java/Kotlin/Scala/Groovy, C#, C/C++, PHP, Ruby, and
  Swift.
- Two moderate npm audit findings affect the development-only Vitest toolchain;
  production dependency audit reports no advisories. The findings are recorded
  here rather than changing the test runner's major version as an unrelated
  compatibility change.
