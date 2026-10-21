# Prototype scope and decisions

## Product scope

The extension is displayed in VS Code as **Downside Up**; its full name is
**The Downside Up**.

The Downside Up helps people understand what code does without knowing the
language. The side-by-side Downside Up preview reads like rendered Markdown.
File, folder/project, and change previews omit a repeated general-help footer;
contextual notices, consent controls, model attribution, and result
limitations remain where they apply.
By default it is concise: the file name, an AI summary of the file (see
below), and one heading per function or method in source order. Attached function
and method doc comments are hidden by default; `downsideUp.preview.include.functionComments`
shows them independently of standalone comments and function signature details.
This is display-only: source outlines, generation context, and saved explanations
are unchanged, and toggling it renders immediately without provider requests.
`downsideUp.preview.include` adds local descriptions of imports,
types (structs, enums, interfaces, traits, aliases, implementations, fields),
values outside functions, locals, standalone comments, modules and macros, and
each function's one-line signature description and notes; nesting is
recomputed from the items shown. With everything included it describes every
import, module, function/method, type, constant/static, local variable
binding, and standalone comment in plain language, in source order and
without regrouping, with attached doc comments and attributes. These
descriptions are deterministic and local (Tree-sitter for
Rust, Go, Python, JavaScript, and TypeScript; a bundled lexer for SQL;
VS Code document symbols plus line-based import and comment
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
Ordinary and paired-diff pseudocode share a small local lexer that highlights
control words (such as if, otherwise, for each, and return), quoted strings,
numbers, boolean/null literals, operators, and backticked code names.
Unrecognized prose stays plain text; this is a readability aid, not a parser
or a claim that pseudocode is executable. Colours distinguish light, dark,
and high-contrast themes, and control words are also bold. Only host-created
spans/code elements are used, with token content assigned as text; generated
HTML is never parsed. No external highlighting library, network resource,
prompt change, cache invalidation, or additional request is needed, so saved
explanations gain highlighting too. Existing source links and indentation
are preserved.

`downsideUp.explanations.formats` adds two views of "What happens", both enabled by default,
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
flowchart itself from HTML nodes and SVG shapes/lines, with every label set as text.
Decisions (including if/loop tests marked as decisions) use diamonds,
start/end nodes remain rounded, and actions remain boxes. A diamond sizes
itself around its unrotated label and any source caption; connectors meet its
top, right, bottom, or left vertex, and focus/selection follows the diamond
border. The same renderer covers ordinary, nested, project, and paired-diff
flows, including saved charts, without regeneration.
In the layout,
the main path runs downward in the first column, an early exit sits to the
right of the node it leaves from, and edges that loop back are routed up the
left side, so loops and exits never cross. Room for loops is reserved only when
a chart has them. A chart wider than its column is laid out again with fewer
boxes per row, moving side exits below their source when necessary; only
then is it scaled down, without a minimum scale. Charts fit the reading
column (at most 860px) without horizontal or nested vertical scrollbars;
the document scrolls vertically. Rows have more vertical room for arrows
and labels, labels are positioned away from boxes and other labels, and
fixed-size arrowheads meet straight path endings at the box boundary. A show
node with nodes inside it holds a smaller flow laid out the same way, and
boxes in its row line up with its top. Clicking a node inside it selects only
that node's lines. No diagram library or HTML parsing is involved.

Clicking a function heading's name navigates to its host-validated source
reference; it does not request an explanation.
Every unexplained function has an **Explain** button beside its name. Pressing it,
or running **Open Preview to the Side** (the
editor title-bar button) while text inside the function is selected is an
explicit request (with a selection, an outdated, failed, or cancelled
explanation is regenerated); with only a cursor, opening the preview never
generates. For a request, the extension first looks
for a current saved explanation (local only) and generates one only when none
exists. Explanations are always shown inline rather than in an accordion.
Loading, including queued and prefetched requests, shows skeleton lines
using the existing theme-aware shimmer (static with reduced motion), a
status, and Cancel. Loading an extra format uses the same skeleton lines.
**More detail** remains collapsible. Several explanations can load, and up to
`downsideUp.maxConcurrentRequests` provider requests (default 6, 1–8, user
settings only) run at once. Building or reviewing the repository overview is
exclusive per repository, so parallel requests wait for it and reuse it
instead of priming twice, and parallel requests share a single code-sharing
prompt per repository and model. Explicit requests always start before
waiting prefetches. When the preview shows a file, it checks the local cache once for that
file's functions and shows those with a current saved explanation, open,
so saved explanations remain visible after the preview is closed and reopened
or VS Code restarts; misses retain their Explain button. Saved, generated,
and prefetched explanations stay inline, with outdated, failed, and cancelled
states and their existing Regenerate or Try again actions visible.
When content above the reader changes, the preview preserves the visible entry's
position, including after charts finish fitting. Repository and
function context are gathered only for functions that have a saved record.
Selecting non-empty text inside a function in the editor only checks for a
fresh saved explanation and opens its section when one exists. A cache miss
never triggers generation. Opening files, moving the cursor, scrolling, local
outlining, and source edits do not call a provider, unless the user turns on
prefetching (below). After edits, file changes,
or a model change, open explanations are rechecked against the cache locally
and marked outdated when their recorded inputs no longer match.

Function headings have a compact **Show callers** icon, independent of the
explanation format. It uses native incoming Call Hierarchy, never references
as a proxy for calls. When native lookup is unavailable (not when it fails),
Go, Rust, and Python provide a local direct-call fallback via their `LanguageSupport`.
This reverses direct free-function dependencies using existing package/module
resolution, not text name matches or uncertain receiver-type guesses. It skips
references, receiver methods, macros, closures, shadowed local names and
ambiguous declarations; coverage remains conservative and incomplete.
Python targets are module-level functions only; decorated targets, star
imports, re-exports, and conditional or reassigned bindings are not inferred.
Calls inside nested functions belong to those functions, not their enclosing
function; defaults and decorators are not counted as calls made by the body.
SQL also supplies a routine-call fallback using statically named calls
(`CALL`, `EXEC`, `EXECUTE FUNCTION`, `PERFORM`, and `name(...)`), not table
reads as callers. Names are resolved against eligible CREATE definitions,
not a database catalog. Overloads are name-based candidates, so a caller can
appear for multiple overloads; ambiguous unqualified schema matches are omitted.
Dynamic SQL is not inspected.
The local SQL caller picker states that overloads are candidates and repeated
definitions use lexical file order rather than migration execution order.
Fallback limits: 2,000 filesystem entries, 100 loaded files, 2 MiB of text,
256 KiB per file, 500 functions, eight seconds checked between operations, and
100 results. It is cancellable, reads unsaved buffers, labels results
**Statically found callers**, and checks selected source snapshots again before
navigation. No results is explicitly scoped to the scan limits.
Lookup requires trust
and respects sharing exclusions for the source and results, restricts navigation
to local files within the repository, and bounds queries to eight prepared
targets and 100 caller functions. Unsupported lookup and no eligible callers
have distinct messages; provider failures are explicit. Dynamic calls and
callbacks may be missing. Selection opens a call site with an empty cursor,
not an Explain request; normal cache-only loading and opt-in, consent-gated
reader-focused prefetch apply. VS Code's Go Back returns to the previous location.
The caller picker does not enqueue explanations.

The preview header has two separate buttons opening their model pickers
directly: **Functions** (function explanations, added explanation formats, and
file summaries) and **Project overview** (project priming, repository context
reviews, architecture maps, folder summaries, and main flows). A single sparkle
icon groups both controls, with **Project overview** first. Each shows its role
beside its model name on a compact line, including when both use the same model.
Names wrap and buttons stack in narrow columns without hiding either role. Tooltips
describe the responsibilities, rather than calling project-level work only
"map". Changing a model still uses the existing settings and consent rules.
Clear is a repository-wide control. A separate **Initialize project** button
above the divider appears
when the cache has no saved repository overview, including immediately after
Clear. It explicitly requests repository context and the project map with the
existing consent flow; rendering the button never generates anything.
The architecture map follows the opening description without a Map heading or
repetitive arrow paragraph. Its tooltip retains AI provenance and limitations.
Page Refresh lives beside the title below the divider. It refreshes the fixed
set of checked outdated items on that page,
with separate **Map project** (missing) or **Update project map** (different
model/settings) actions on the project page. Map requests do not expand the
outdated-item batch.
The divider is amber for known outdated page content and blue/animated while
busy, never a claim that the whole repository has been checked. Successful
refresh leaves no persistent message; errors remain explicit.
Page Refresh is an accessible icon button; Clear has a label that collapses
in narrow columns. Header buttons are borderless and transparent at rest, with
background highlighting on hover, keyboard focus, or press; Clear also turns red
on interaction and keeps its modal confirmation. Keyboard focus retains its outline.
Icons are fixed inline SVG paths, with no font, asset, or CSP changes.

The header's **Tokens in current cache** disclosure totals recorded usage on
retained records, split into input/output and grouped by Overview/Functions
and provider/model. Map usage counts the joint overview/map request once;
folder summaries and flows are Overview work, while explanations, added
formats, and file summaries are Functions work. Added formats store usage
separately by format. Replacements replace their contribution, Clear resets it,
and cache hits do not add usage. Totals are not lifetime usage or billing and
exclude discarded/failed/cancelled requests. Estimates are marked `~`; records
without usage are explicitly reported as incomplete. Cache schema version 2
records this metadata; older schemas require Clear.
The disclosure also counts saved explanation, file-summary, folder-summary,
and flow-set records across all models for the repository, and show the map's
saved age (not a freshness claim). The host retains a snapshot, refreshed on
navigation and successful cache writes/clear, not on cursor movement or
webview renders. Read failures show an error instead of zero counts.
Zero outdated counts are hidden. Successful refresh leaves no persistent
message or per-request token report.
The outdated count is scoped to checked items here: shown function explanations
and a file's summary, or a folder's displayed summary, main flows, and its
directly listed file summaries. It does not scan the repository or include
nested folders. The page **Refresh** icon is an explicit request for a
fixed set of these items, through the existing sharing consent and request
scheduler. It never adds missing items or new ones while navigating, skips
current explanations, and stops on cancellation, decline, failure, model
changes, repository edits, or a change of preview. Completed results remain saved. Source
freshness and exclusion checks still apply. This action can explicitly refresh
a saved file summary without explaining another function first.

Prefetching is an opt-in exception to explicit-only generation. On
the first preview opening, a one-time non-modal prompt offers **Enable prefetch**
or **Not now**, unless the user already explicitly configured the setting.
Dismissal leaves prefetch off. The choice is remembered per VS Code profile,
including for existing installations after upgrading. Enabling saves only to
user settings; the prompt explains quota/billing and that repository/model
sharing approval is still required. It never grants sharing consent.
With
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
a slot frees, shows skeletons while it loads and each explanation when ready,
and does not regenerate outdated, failed, or cancelled
explanations or functions added by later edits. Switching files drops
prefetches that have not been sent; one already sent finishes and is saved.
Closing the preview, Cancel, Clear Repository Cache, or turning the setting
off stops it. A failed request is retried once after a five-second pause,
for example after a rate limit; a second failure stops prefetching with a
notice. It runs only in a
trusted workspace and only after code sharing was approved for the repository
and model, including the separate overview model when configured; it never
asks for approval itself. A persistent banner names the models still needing
approval and offers **Approve sharing**: only that explicit click opens the
existing per-repository, per-model dialog (without a token estimate, since no
request has been assembled yet). Each missing model is approved separately;
declining leaves the banner available and never retries the prompt automatically.
Approval can also be given by an explicit explanation. The banner is separate
from transient status notices and is hidden when prefetch is disabled, the
file is excluded, the workspace is untrusted, or a folder is shown; model
and repository changes recheck it without prompting. When approval is given for the
shown file's repository (by explaining a function or mapping the project),
prefetching that was waiting starts. Prefetching uses the provider's
usage limits or billing for every function it explains.

### Change view and review mode

Explaining a change is a request for one file's before and after, in the
preview. When the editor being viewed is a native VS Code diff of local Git
changes (working tree against the index, staged changes against `HEAD`, or a
base commit against the working tree), the preview, if open, switches to a
**change view** for that exact pair of documents. Opening a diff alone never
opens a closed preview, and clicking between the two sides or focusing the
preview keeps the same comparison; a normal file or folder preview returns
when another editor is shown. **Open Preview to the Side** and the editor
title button work from either side of a diff. A saved explanation is looked up
first, even with text selected.

With `downsideUp.prefetch.enabled` and existing sharing approval for the
repository and Functions model, first showing a diff in the preview also
preloads a missing comparison with background request priority. It never
prompts for consent, needs no Overview model approval, reuses saved comparisons,
and does not retry failed or cancelled attempts or regenerate outdated results.
Enabling prefetch or granting consent can start a waiting comparison.
Changing the shown diff, closing the preview, cancelling, disabling prefetch,
or changing provider/exclusion settings cancels its background request.
A queued request is also dropped if the diff was refreshed before it starts.
Review mode retains its confirmed scope and disables this separate diff prefetch.
Switching tabs within a comparison, scrolling, editing, refreshing, and a
cache miss outside this opt-in path never call a provider.
**Explain changes** is the explicit request: it reads both versions
again (unsaved editor text stands in for the working file), resolving `HEAD`
and the index to what they are at that moment rather than reusing the commit
they named when the diff was shown, checks the
sharing exclusions for each side's own path (including a renamed file's old
path), the repository restriction, request size, and per-repository and
per-model consent (it asks like any explanation), sends the two versions of
that one file, and saves the result. Each side is limited to 256 KiB of text;
binary, oversized, excluded, unreadable, identical, and not-yet-existing
comparisons are reported instead of explained, and an added or deleted file
compares against nothing. A renamed file is explained even when its text is
unchanged; the model is told the file moved. If either version changes while
the request runs (including `HEAD` or the index moving), or the request is
cancelled or the repository cache cleared before the result is saved, the
result is discarded. A failed attempt keeps any earlier result visible and
offers to try again.

The model returns a summary, a list of changes with before and after
behavior, when it differs, and its effect on flow, line spans that are
checked against the real line counts of each side (an invalid span drops the
link, never the explanation), text outside functions, possible consequences,
and limits. It uses the Functions model and needs no function discovery, so it
works for any text file. Everything renders as text; evidence links go
through host-validated ids and reveal the lines in the visible original or
modified side of the diff without moving the comparison. This is a
description of what changed, not an automated correctness or security
review.

When a comparison includes a visual scope, its change card also offers
**Steps**, **Pseudocode**, and **Flowchart** tabs for the original and modified
versions together. Each side has its own ordered explanation and control-flow
chart from the exact numbered source; the model supplies explicit operation
and edge correspondences, so similar labels alone do not imply a match.
The tabs, numbered steps, and unnumbered, indented pseudocode share the
normal-file styles. Linked rows retain ordinary text styling, with a subtle
background highlight on hover or keyboard focus rather than link colours
or underlines. The same highlight colour marks active source-linked items.
Flowchart nodes in all views gain a slightly larger shape-following background
halo on hover, keyboard focus, or active source selection, including diamonds.
Changed behavior stays paired, while added, removed, or uncertain operations
remain unmatched. Scopes name the source region and coverage; an unavailable
chart says why instead of inventing a path. Visual text is rendered as text,
and clicking a linked step, pseudocode line, or chart node reveals only the
host-validated lines on that side. Selecting an item focuses its existing
native diff editor group and the original (Before) or modified (After) side
before selecting and revealing the range; it does not open a separate file
tab. If that comparison is no longer visible or its side cannot be focused,
navigation reports an error instead of opening another document.
Switching tabs is local and makes no
request. Valid side views survive invalid operation or connection matching;
unverified matches are omitted with a specific limitation, never inferred.
A malformed visual scope does not discard other valid scopes. Unsafe source
references still reject their scope, and aggregate safety limits still apply.
If no valid scopes remain, the textual comparison remains and the specific
validation reason is shown.

Comparison generation stays on the Functions model. The prompt prefers one to
three coherent changed regions, concise steps and charts, and compact JSON
rather than exhaustive full-file diagrams. The wire contract defines operations
and their source spans once per side. Steps and pseudocode reference those
operations; operations with a chart kind become nodes, and edges explicitly
name their endpoints. Source-ordered text and graph control flow remain
independent. The host constructs side-specific units, occurrences, item IDs,
edge IDs, and line links locally; the model supplies only explicit operation
matches and zero-based edge matches, never navigation targets. Missing-file
presence comes from the snapshots, not model output. Each side allows at most
30 operations, still capped at 24 chart nodes and 40 edges, with the existing
whole-response budgets checked after expansion.
This remains one model request for both exact snapshots and all three views.
Coverage limitations name what is not shown. Invalid JSON is still rejected;
the compact contract does not guarantee a valid response, and no automatic
repair call, retry, or model fallback is made for diff prefetch.
The comparison prompt version is bumped for this contract; old comparison
records are not migrated or reused under the new version.

An illustrative **Trace a case** remains planned in
[Visual behavior comparisons](diff-flow-plan.md); it will not execute code or
prove that either version is correct.

Comparison records are saved in the repository cache beside explanations,
under a key made from both sides' identities (`working`, `index`, or a
resolved commit) and paths and the provider, model, and prompt version.
Any change to the exact text of either side, including formatting or blank
lines (evidence links name absolute lines), leaves the record visible as
outdated, without its line links, until the reader explains again; a
different pair, such as staged versus unstaged, is a separate record. Only local `git:` and `file:` diffs are supported; other
schemes say they are not supported yet. Changes to the index or working tree
made outside the editor are noticed when the window regains focus, the diff
is shown again, or VS Code updates the diff's open Git document, not watched
live. **Clear Repository Cache** and **Refresh Repository Context** act on the
shown diff's repository, also when the preview or a non-file side has focus.

Review mode prepares these comparisons ahead of the reader.
**Review Changes…** offers bases found with Git: the merge base of `HEAD`
with the remote's default branch, `main`, `master`, `origin/main`, or
`origin/master`, those branches' tips, `HEAD` (uncommitted changes only), and
any of the last 50 commits. It compares the base, resolved to a commit, with
the working tree (`git diff --name-status -M` restricted to the repository
root, plus untracked files that are not ignored). Additions, deletions,
renames, and changes outside functions each count as one file comparison;
commits that are not checked out are not explained. At most 200 changed files
are considered; excluded files are skipped and counted, as are binary,
oversized, identical, and unreadable ones. Nothing is sent until the user
confirms the number of requests (files with a current saved comparison are
not counted); running the command is an explicit request, so if code sharing
is not yet approved for the repository and the Functions model (the only model
comparisons use; a separate Overview model needs no approval for review), the
first file is explained as an ordinary request, which asks. The rest are
explained like prefetching: with the free request slots (never the last one),
never prompting, skipping files with a current explanation, and the file being
read (or its diff) first, otherwise in path order. A file is read and checked
for a saved comparison only once it holds a request slot, so files not yet
started keep following the reader. Each item keeps the versions that were confirmed; if
either changed before its turn, or while it was explaining, it is marked
changed since, not explained, and needs an explicit **Explain changes**. A
failed file is retried once after five seconds; after three failures review
mode stops with a notice. It also stops when consent is missing. Stopping
from the list lets requests already sent finish and be saved, and continuing
does not send them again; closing the preview, **Cancel**, and **Clear
Repository Cache** end it and abort its requests, queued or sent, so none of
them is saved. A
status bar item shows progress and opens a list of the changed files with
their state; choosing one opens its native diff (with an empty document for
the missing side of an added or deleted file), which shows the same saved
comparison. It works regardless of the `downsideUp.prefetch.*` settings.

Hovering a call to a function inside another function shows the
purpose from that function's current saved explanation, found with the same
local dependency resolution as explanation context. In languages without
bundled analysis only words followed by `(` are considered, and only the
hovered name is looked up. The hover reads only the
local cache (after the usual freshness check), never generates, renders
generated text as plain text, and can be turned off with
`downsideUp.hover.savedExplanations`. Like the rest of the extension it is
available once a Downside Up command has activated it.

The core is language-neutral. Rust, Go, and Python function discovery and source
fingerprinting use bundled Tree-sitter WASM grammars, so none needs a
language server; Go methods are identified by receiver type (for example
`Catalog.Add`). Python discovers `def` and `async def`, decorated class methods
(including static/class methods and properties), and nested functions, qualified
by their enclosing classes/functions (`Catalog.find`, `outer.inner`).
Property setters/deleters have distinct identities. Lambdas are not separate
explainable functions. Python's local outline uses module/class/function
docstrings, attached comments, imports, classes and bases, values, and signatures.
SQL uses its own bundled bounded lexer, not Tree-sitter or a database
connection. Explainable units in `.sql` files are `CREATE FUNCTION`,
`PROCEDURE`, `TRIGGER`, and `VIEW` (including materialized views), tables,
types, indexes, sequences, and standalone query statements. These objects are
visible by default, independent of optional type/function-detail settings.
Table cards render structured column/type/required/default rows, generated
expressions, keys and foreign-key relationships. Column and same-file
relationship links resolve local qualified names to unique host-owned outline
references before rendering; unresolved or ambiguous targets stay plain text.
Embedded column entries provide navigation/scroll anchors rather than duplicate
rows. Caller buttons are omitted on non-routine SQL units. It recognizes
common PostgreSQL dollar-quoted bodies, MySQL custom delimiters, T-SQL GO
batches, and SQLite trigger blocks, including quoted object names and
BEGIN/END blocks. Routine overload identities include their syntactic
argument types. Named sqlc query annotations provide query identities and result
modes; unnamed SELECT/WITH/INSERT/UPDATE/DELETE/MERGE/VALUES/CALL/EXEC statements
use numbered headings. Duplicate named queries get distinct qualified names.
Query previews show syntactic parameters and relations locally. Embedded SQL
is not supported. Schema/query explanations use language-owned guidance that
describes schema rules or query behavior instead of inventing application
control flow. SQL is never executed.
JavaScript and TypeScript, including JSX and React, also use
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
Python, JavaScript, and React with TypeScript.

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
files, and a small symbol outline. Rust, Go, Python, JavaScript, and TypeScript symbols use Tree-sitter; other
symbols use VS Code providers where available, except SQL, which uses its lexer.
Function context adds related types,
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
skipped; a timeout, files beyond the scanner's 2,000-file limit, or a
language without a definition provider are stated as limitations. For Rust, it also adds the items the function uses directly from other
files of the crate (depth 1): types, functions, constants, and methods of used
types, found by following `use` declarations and paths (`crate::`, `self::`,
`super::`, child modules, `mod.rs`, glob imports, and the package's own name
from `tests/`, `examples/`, or `bin/` files) with Tree-sitter and Cargo's
file layout. Items are sent whole up to 4 KiB each and 16 KiB in total; a
larger item is sent as its signature only, and items beyond the budget are
omitted with a stated limitation. At depth 2, for Rust, Go, and Python, the signatures
(not bodies) of the functions and methods that the depth-1 functions sent whole
call are added, from up to 8 such functions, at most 12 signatures and 4 KiB in
total; anything already tracked is skipped. External crates and the standard library are
not followed. For Go, function context adds the file's package clause and
import block and, under the same budget, the package-level functions, methods,
types, constants, and variables the function uses directly: from any file of
its own package (test files only for tests) and from imported packages inside
the same module, found through `go.mod`'s module path. Methods are matched for
the types the function names and the types returned by functions it calls.
The standard library and other modules are not followed.
Python adds module imports and `__all__`, and uses the same depth-1/body and
depth-2/signature budgets. It statically resolves same-file and enclosing-scope
definitions, imported repository symbols, module-qualified calls, and same-class
`self`/`cls` methods. Parameter/local bindings, reassignment, conditional
definitions, and ambiguous module roots are handled conservatively; imports
are resolved only against eligible paths and loaded through the shared
unsaved-buffer-aware reader. Each lookup inspects at most 80 names and 80
attribute references, reads at most 40 modules, and honors the shared deadline.
SQL adds preceding `SET search_path`/`USE` context and syntactically referenced
tables, views, type casts, and named routine calls. It loads only eligible
repository `.sql` files through the shared unsaved-buffer-aware reader: at most
100 files, 2 MiB total, 256 KiB per file, and 160 distinct references, honoring
the shared deadline and depth-1/depth-2 budgets. CTE names are excluded as local
bindings. Explicit schema names, a basic search path, and the enclosing schema
help disambiguate names; unresolved or ambiguous schemas are not guessed.
Repeated definitions with the same name and syntactic signature use the last
lexical file/statement, with a stated limitation: this is not migration
execution order. Overloads are matched by name rather than argument types,
and all matching overloads are disclosed as candidates. SQL source is never
executed, and no database connection, SQL language server, or extra WASM is needed.
Same-file PostgreSQL `ALTER TABLE [ONLY]` constraints/defaults, table comments,
and `CREATE INDEX` definitions are associated with their CREATE table, shown
locally, and included/tracked in explanation context for that table and queries
that use it. This is not replay across migration files. Primary/unique keys,
foreign keys and delete actions, defaults, generated columns, enum values, and
sequence definitions are derived from source, not a database. Other ALTER
operations may be retained as context without being reflected in the card.
Ordinary comments are formatting-insensitive; sqlc name/mode annotations remain
meaningful fingerprint inputs. Unnamed query identities are ordinal, so inserting
an earlier unnamed query can change them.
Snippets sent to the model are labelled with their file path and what
they contain, and the model is asked to refer to code by file, function, and
type names in plain prose rather than by identifiers. The "related code" links
under an explanation come from the extension's own analysis, so navigation only
goes to host-validated locations, never to locations taken from model output.

The overview stays under 800 words and separates observations,
inferences, and limitations. It is shown at the end of the preview
for inspection. The same request also returns the project map (see "The
project map" below).
The repository overview is cached by repository and provider/model/prompt
configuration. Explaining another function in an unchanged repository reuses the
same overview; a bounded review/re-prime happens only when tracked repository
changes make the existing overview potentially stale.
Priming and explanation inputs are bounded by byte budgets; the complete
priming/review request is limited to 128 KiB. Every other request (an
explanation, an added view, a file or folder summary, or main flows) is
limited by `downsideUp.maxRequestSize` (user settings only; default 96 KiB,
32 to 512 KiB), checked before anything is sent; a larger request fails with
its size, the limit, and the setting's name. The selected function is sent
once, as the numbered source to explain, and not again among the related
code, although it is still tracked there. For VS Code language models, the
model's own input-token limit is checked as well. The scanner lists at most 2,000 eligible files, breadth-first, so
in a larger repository every area is listed at its top levels rather than
only the first folders in alphabetical order (the walk also stops after
50,000 folder entries), and excludes files over 256 KiB. Listing only uses
names; each file's size and modification time are recorded so changes are
noticed. Files are ranked by name and location for what they say about the
project: the root README, manifests, other READMEs, API contracts (OpenAPI,
AsyncAPI, protobuf, and GraphQL files whose name or folder says schema),
Dockerfiles and deployment files, architecture notes, and entry points (any
`main` file, and `index`, `lib`, `app`, or `server` files only at a
component's top or in its `src` folder, not every barrel file), then the
rest, shallow before deep. Files in test, fixture, mock, and example folders
rank below the rest, and generated code (`__generated__` and `generated`
folders, and names such as `.generated.`, `.pb.go`, `.min.js`, or `.d.ts`)
last. Only what priming may send is read (and fingerprinted by content): up
to 300 evidence files, then up to 40 other files while the priming budget
has room, within 12 MiB; test files and generated code are not read for
priming. Explanations, hovers, and prefetching read the related files they
need on demand from the scanner's eligible files, which passed every
exclusion, so a function's context does not depend on what priming read.
Priming file text is capped at 64 KiB. Each of those kinds first gets a share of it
(10, 14, 16, 10, 6, 4, and 4 KiB), and what is left is filled in the same
order, so no kind crowds out the others. The root README is cut at 12 KiB,
manifests at 3 KiB, and other files at 6 KiB (marked). Compose, Kubernetes,
and Helm files are sent only as
facts reduced to names (`deploymentFacts`: resource kinds and names, Compose
services and their dependencies, images, ports, environment variable names,
ConfigMap and Secret keys, and Kustomize resources), never values. Up to
16 KiB go to the symbol outline and up to 12 KiB to the folder outline.
Excessive complete prompts fail before source is sent.

The scanner honors `.gitignore`, `.copilotignore` (including `.copilotignore`
files in folders above the repository, with patterns relative to their own
folder), and VS Code file/search exclusions, plus an optional organization
exclusion policy read from files named in user settings only (application
scope; workspace values are ignored), as plain-text files with one entry per
line. Each setting offers a **Choose file…** command using a local, single-file
dialog and saving only to global user settings. **Choose policy folder…** lists
regular files immediately inside a chosen local folder and asks which file to use
for each of the three settings, without assuming filenames or reading file contents.
The four-step setup webview uses radio-button file choices without a textbox,
step indicators, Back buttons, remembered choices, and role-specific examples.
Selecting a file never advances: the user explicitly presses Next. Navigation
rejects duplicate messages from an earlier step. A final summary lists all
assignments; only Save writes settings. Back from the review revisits the last
assignment. Closing the panel cancels setup. The panel has no local resource access,
uses a nonce-restricted content policy, and renders filenames and paths as text.
Assignments are collected before writing; cancellation leaves every setting unchanged,
and **Keep current setting** preserves that policy. Picker and write errors are
shown explicitly. The normal policy-settings change handling applies immediately;
choosing paths does not grant sharing consent or request AI generation.
**Check Content Exclusions…**, available from the Command Palette and each policy
setting, opens a local unsaved plain-text report. It freshly parses all three user
policy files with the enforcement parser, lists load status, resolved paths, active
entries with original line numbers and ignored comments/blanks, and prominently
warns when a missing/unreadable file adds no restrictions. Users may test the current
file or choose a file in a trusted local workspace. The same single-file enforcement
path returns its decision and matched rule/source (including ignore-file line numbers
or VS Code setting patterns); the repository matcher reports the restricted-remote
rule and applicable opt-in. Explicit checks clear policy and ancestor-ignore caches.
No recursive scans, AI requests, settings writes, or consent changes are involved.
Only local policy/ignore/opt-in control files and Git metadata are read, not source
contents (unless the tested file is itself one of those control files). Only the
first blocking check is reported; other exclusions may also match.
Reports are snapshots, not a guarantee of safe sharing: supported file types,
trust, consent, and scan/request budgets remain separate. Unavailable policy files
or Git remote inspection failures flag incomplete checks, not an all-clear.
The file format uses one entry per
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
per file, provider, model, and prompt version, with the same language-aware
formatting fingerprint used for explanation evidence (including literal
contents and syntax-sensitive newlines): after meaningful edits the preview shows the old
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
Breadcrumbs include fixed icons for project, group, component, module,
support, plain folder, and file levels. Project/group/component crumbs have
tinted chip styling; hover text shows the level and saved map summary.
Levels reuse `folderLevel` and summaries reuse `mapPartAt`, including for
file previews; without a saved map only the root is a project. Root-only
trails remain visible and the last crumb is marked as the current page.
Loading this metadata is cache-only; it does not generate a project map.

### The project map

Each folder preview zooms one level below its folder, using the project map
that priming makes. The priming or review request that makes the repository
overview, with the overview model, also sends a bounded folder outline
(`folderOutline`, from the eligible files the scanner found): every folder up
to two levels deep, deeper folders (up to six levels) that hold a marker, and
the folders above those, at most 250, each with its file count and markers:
manifests (`package.json`, `go.mod`, `Cargo.toml`, `pyproject.toml`, and
others), Dockerfiles, Compose, Kubernetes or Helm files, API contracts,
READMEs, and entry points. The model returns, besides the overview, `map`: a
two- or three-sentence summary of the project, at most 60 parts, and at most
80 links. A part is a folder with a level (`group`, a folder holding several
components; `component`, something built, deployed, or published on its own;
`module`, a main part inside a component; `support`, documentation, tooling,
tests, infrastructure, or configuration) or something outside the repository
(`external`, such as devices or a message broker), with a plain name and one
sentence. A link names two parts and how they connect, such as "GraphQL" or
"MQTT events". With `downsideUp.projectMap.detail` set to `detailed` (user
settings only), components also get a few sentences and what they offer and
use. The map is read leniently, so a malformed map never costs the overview:
parts whose folder the scanner did not find, that leave the repository, or
that repeat a folder or id are dropped, as are links to dropped parts, and
duplicate links are merged (`checkedProjectMap`).

The map is saved in the cache next to the overview, but apart from it
(`projectMap`, with the overview model, prompt version, and detail setting it
was made with), so changing it never outdates explanations. It is reviewed
whenever the overview is (the previous map is part of the review request),
made again when the detail setting or overview model changed, and never
generated on its own: opening a preview only reads it. A map made with other
settings is still shown, with a note offering to refresh it.

A folder's level (`folderLevel`) is the project at the root, its own level
when the map lists it, `module` inside a component or module, `support`
inside a support folder, and otherwise a plain folder. The preview shows, by
level:

- **Project**: the map's summary, a map of the outermost components (drawn as
  their groups when there are more than 14) and the outside parts they
  connect to, the main parts (top-level parts and outside ones) with their
  sentences, flows between parts, and all files and folders collapsed.
  Opening it without a current map (none, or one made with another overview
  model or detail setting) maps the project: opening the project preview is
  the request, so the first time it asks for code-sharing approval like an
  explanation. It is skipped in an untrusted workspace, without a usable
  model (or OpenAI key), or while another refresh runs, and after a declined
  approval, a cancel, or a failure it is not started again on its own in that
  session for the repository and overview model; the page then offers **Map
  this project** (the same request as **Refresh Repository Context**). While
  the map is made, the page shows a shimmering placeholder of the summary
  and map with what is happening; a folder that is still being listed shows
  a placeholder page too. Until there is a map, the project has no flows.
- **Group**: its sentence, its members, and a map of its components with the
  parts elsewhere they connect to.
- **Component**: its sentence (or its folder summary, with what it offers
  and uses), a map of its modules, or of itself when it has none, with what
  they connect to, and flows between those parts.
- **Module** and plain folders: the folder summary, import structure, and
  flows through files and functions, as below.
- **Support**: a short summary and the contents; no diagram and no flows.

Each map (`mapView`) draws a link between the boxes that hold its ends: an
end elsewhere in the repository is drawn as its outermost component, an end
outside the repository as itself, links inside one box are left for that
box's own page, and links between two outside ends are left out. Maps use the
structure diagram's layout with labelled arrows; boxes elsewhere in the
repository are dashed, and outside parts are dashed and rounded. A map
without separate parts (a project whose map lists no components, such as a
single library) is not drawn, and the page shows the import structure and
file flows instead. Boxes and members open their folder through navigation
ids; outside parts open nothing. The repository overview itself is shown in
the collapsed repository-context section at the end of every preview,
including the project's.

The listing applies the scanner's rules (hidden, dependency, and build
folders, `.gitignore` and `.copilotignore`, VS Code exclusions, the
organization policy, secret-like names, and non-text files are skipped; hidden
files are not listed) and shows subfolders that hold eligible files, with
their counts (the walk stops after 20,000 folder entries and says so), then
files with their language and their saved one-sentence summary, read from the
cache with the same freshness check as the file preview (a changed file's
summary is shown as outdated). Nothing is generated. A folder is refused, with
a notice, when its real path leaves the repository (a symlinked folder) or it
sits in a hidden, dependency, build, policy-blocked, or ignored folder; ignore
patterns that only match folders (such as `generated/`) apply to folders.

The structure diagram is computed locally. Every eligible file under the
folder (at most 1,500 files and 24 MiB, skipping files over 256 KiB) is parsed
by its language support's optional `fileImports`, which returns the
repository files or folders it imports: JavaScript and TypeScript relative
specifiers in imports, re-exports, `require`, and `import()`, with `.js` to
`.ts` mapping, `index` files, and `paths` from the nearest `tsconfig.json` or
`jsconfig.json`; Go imports inside the module named by the nearest `go.mod`
(package folders); Rust `mod` declarations and `crate::` paths (module files);
Python absolute and relative imports (`module.py` or `module/__init__.py`),
using the repository root, `src/` layout, and the source's package/script root.
Ambiguous roots and unresolvable imports are omitted, not guessed.
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
drawn thicker for more imports. On resize, a wide diagram is rebuilt with a
smaller real-box capacity per layer while keeping every forward edge downward;
waypoints are recomputed for the new ranks and remain narrow routing lanes,
not boxes counted toward that capacity. Unconnected and shared rows wrap.
If the boxes and routing lanes still cannot fit, the whole diagram scales
to the column. Diagram ResizeObservers are disconnected when the document
is rendered again.

Folder summaries are AI-generated only on an explicit **Summarize this
folder** (or **Regenerate**) in the folder preview, which may ask for
code-sharing approval like an explanation and uses an explicit request slot.
The project and groups do not offer it once mapped, since the map describes
them.
The request (`folderSummaryPrompt`) holds the folder's path, the repository
overview's purpose as background, and for each listed part (at most 150) its
saved summary (a file's one-sentence summary or a subfolder's folder summary,
current or not), or else the names of a file's functions and types from its
bundled language support (at most 20) or a subfolder's contents (at most 20),
the import edges between parts by name (at most 200), and the folder's README
(at most 8 KiB, marked when truncated); never source code, and a restricted
repository sends nothing. Once the project is mapped, it also holds the
folder's level and the map's sentence about it as background, and a subfolder
without a summary of its own contributes the map's sentence instead. A
component's request also holds its API contracts (`isContractFile` files
under it that pass the sharing exclusion, shallow first, each cut at 6 KiB,
16 KiB in total) and asks what the component offers and what it uses; a
support folder's asks for a brief summary. The model returns one sentence on
what the folder is for, two to four on how its parts fit together and where
to start, what a component offers and uses, and one sentence for each part
without a summary; sentences about parts that were not
listed, or that have a summary, are dropped, and the preview marks the rest as
inferred from names. Folder summaries are cached per folder, provider, model,
and folder prompt version with a fingerprint of the input (not of the
repository's purpose or the map's sentence), so a changed part, summary,
function name, import, README, level, or contract marks the summary outdated; opening a folder preview only reads the cache. A
subfolder's saved summary feeds its parent's input, so summaries can be built
bottom-up. Every text sent (saved summaries' files and the README) passes the
same sharing exclusion as an explained file.

Main flows are AI-generated only on an explicit **Describe the main flows**
(or **Regenerate**) in a folder preview, with the overview model, at the
preview's level. For the project, groups, and components with a drawn map
that has connections, the request (`partFlowsPrompt`) holds the map's boxes
(id, name, sentence, and whether they are inside, elsewhere, or outside) and
links, and the folder's or project's summary as background; the model returns
up to three flows of at most 12 nodes, each naming the part where its step
happens. A node keeps its part only when the map lists it, and parts in the
repository open their folder preview (`checkedPartReferences`); these flows
are cached like file flows, with a fingerprint of the parts and links. For
modules, plain folders, and a mapped project without separate parts, the
request (`projectFlowsPrompt`) holds a catalog of the eligible files under the folder
(at most 300, in path order, leaving out files with neither a saved summary
nor function names, and stopping at 36 KiB, which is stated in the request),
each with its saved one-sentence summary (current or not) and up to 25
qualified function names from its bundled language support, the import edges
between the folder's children, and as background the repository overview's
purpose, components, and flows and the folder's saved summary; never source
code, and a restricted repository sends nothing. The model returns up to three
flows, each a title, a summary, and a flowchart of at most 16 nodes in the
flowchart format (no nesting, no source lines) whose nodes name a catalog file
and function. Each flow is checked like a function's flowchart, and a
malformed one is dropped. A node keeps its file only when it is in the
catalog, and its function only when that file lists it, so links go only to
places the extension found itself; clicking a linked node opens the file at
that function (found again with the language support) and previews it. Flows
are cached per folder, provider, overview model, and prompt version with a
fingerprint of the catalog and imports (not the background), so a changed
summary, function name, or file marks them outdated; opening a folder preview
builds the catalog locally and only reads the cache.

**Summarize with all subfolders**, in a folder preview with subfolders, runs
both for the folder's tree on one explicit request. It walks the folders below
(`collectFolderTree`, refusing trees of more than 400 folders), builds each
folder's summary input locally, and marks a folder to summarize when its saved
summary is missing or not current, or when any folder below it will be
summarized, since that changes its input (`foldersToSummarize`). The flows
are described too when they are not current. Nothing is sent until a modal
dialog, showing the number of requests (at most 100 per run) and a byte-based
token estimate of their prompts, is accepted. Folders are summarized by
height, leaves first; the folders of one height run side by side through the
request scheduler, and each folder's input is rebuilt just before its request
so it holds its subfolders' new summaries. The flows follow, with the folder's
new summary as background. A failed folder does not stop the run (its parent
falls back to names); a declined code-sharing prompt, **Cancel**, or a change
of the overview model stops it, keeping finished summaries. A run does not
start while it is being checked or while other folder requests are in
progress, and it never takes over another request. While it runs, previews of
folders in the tree show its progress instead of their own summary and flow
actions, and the shown folder's summaries and flows are reloaded from the
cache after each height without restarting the preview, so a navigation in
progress is kept. At the end a notice gives the number of finished and failed
requests and their token usage.

Folder summary and flow requests are tracked per folder, kind, and model, so
leaving the folder neither cancels nor duplicates them: Cancel stops all of
them, returning to the folder shows the request still running, and a result
is shown only while the same folder and model are previewed (it is saved
either way).

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
saves the chosen model's name (for example `Claude Opus 4.5`) in
`downsideUp.languageModel.model`; there is no separate vendor setting. VS
Code settings cannot list runtime choices, so the setting is a text field
whose description links to the same picker. If no model is set, Explain asks
for one first. A setting is matched against the available models by name,
then by model ID, then by name in any letter case. If several match, Copilot's
model wins, then the vendors in alphabetical order. A name that matches no
available model asks for a new choice. Copilot's internal `copilotcli` models
are listed by VS Code but only serve Copilot CLI sessions and never return
output, so they are never offered or matched. Cached results are keyed by the
model name. Consent is keyed by the matched model's `vendor/name`, so a
same-named model from another vendor asks again. VS Code shows its own
one-time permission prompt for language-model access in addition to this
extension's consent. The API has no system role or schema-constrained output,
so the instructions and JSON Schema are sent in a single user message, and the
reply is validated with the same parser as other providers. Malformed replies
fail without an automatic retry. JSON failures from either real provider report
`incomplete-json` (an unclosed structure/string suggests incompleteness, not
proof of provider truncation), `malformed-json`, or `invalid-schema`, along with
the received character count. Schema details use only fixed host-owned labels.
No response excerpts, source text, or raw JSON-parser errors are logged or
attached to those diagnostics. The request is checked against the model's
`maxInputTokens` before sending, the output is capped, and requests time out
after 10 minutes, allowing slower reasoning and overview models time to finish.
The preview animates the existing header divider and shows the current stage
and elapsed time below the toolbar while requests are active; reduced motion
disables the divider animation. Refresh and Clear are disabled while busy;
Cancel remains available, and Clear retains its confirmation and descriptive tooltip.
Elapsed time covers the continuous busy period, not a provider progress estimate.
No ETA is inferred from file counts, since provider latency is unknown.
Token usage comes from the model's `countTokens` and is
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
and project map (priming, review, and **Refresh Repository Context**), folder
summaries, and flows.
For VS Code language models it is chosen with **Choose Overview Model**
(`downsideUp.languageModel.overviewModel`, a model name next to the
explanation model's `downsideUp.languageModel.model`); with OpenAI it is
`downsideUp.openai.overviewModel`, next to `downsideUp.openai.model`. The
settings are grouped in sections per provider. Empty settings use the
explanation model, and the mock provider ignores it. Explanations, pseudocode and flowchart
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
repository-context refresh, opening the project preview without a current
project map, or turning on prefetching in user settings.

## Cache and freshness

Overview and explanation records are stored in VS Code global storage, outside
the target repository. Explanations and file summaries have their own prompt
version, separate from the repository overview's (which also covers the
project map) and from folder summaries' and flows', so changing the
explanation format outdates saved explanations once without rebuilding
overviews; the
switch to plain-language explanations is such a change. The cache includes prompt/schema/model settings and
fingerprints of the relevant source and context. Function identity does not
depend on line numbers or navigation history. Rust methods are identified by
their `impl` type and trait (for example `Catalog::add` or
`<StoreError as Display>::fmt`), so same-named methods in different `impl`
blocks have separate explanations; explanations of Rust methods saved by
versions before 0.4.0 are therefore not reused. Rust structural fingerprints
preserve meaningful tokens, syntax structure, and literals. Go, Rust, Python, JavaScript,
and TypeScript ignore formatting whitespace in functions, imports, dependency
signatures, and caller evidence. Pure newline tokens in Go are omitted, but syntax
structure is retained so a newline changing control flow is not ignored.
Python fingerprints preserve indentation through the syntax tree: changing
the block structure invalidates cached results, but equivalent reindentation
does not. String/docstring/f-string contents and comments remain meaningful.
Rust imports are collected as complete syntax nodes, including multiline imports.
Languages using VS Code symbols conservatively normalize CRLF, trailing horizontal
whitespace, and blank lines; indentation and in-line spacing remain meaningful.
Potential multiline literals, block comments, or continuations keep exact text
rather than risking removal of meaningful whitespace.

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
freshness checks, and results are not saved as current if relevant inputs change
meaningfully during generation. The selected function is re-resolved against
the current document before saving explanations or extra formats; an unrelated
edit, or a formatting-only edit to tracked source, does not reject the result.
Exclusions, cancellation, and Clear Cache fences still apply.

Within a session, up to 64 recent function-context lookups reuse their evidence
while the selected document and the snapshot entries and eligible dirty buffers
of its recorded inputs are unchanged. Unrelated file edits also reuse that evidence.
Opening a clean file, focusing the editor, or moving the
cursor does not change that identity. Language tools timing out or discovering
additional callers on a later lookup must not be mistaken for a source edit.
An actual tracked-file or selected-document change gathers context again and applies the
usual tracked-input checks; clearing the cache also fences this reuse.

Each explanation records what it was built from, so tracking matches what the
model saw. Every tracked input notes its depth (0 for the function itself, 1
for items it uses directly, 2 for functions those call) and whether it covers
the whole item or only its signature. Related callers are tracked once per file,
without line numbers, using that eligible file's formatting fingerprint; a
meaningful edit elsewhere in the caller file can therefore outdate the result.
Only the existing bounded excerpts are sent, not the whole caller file, and
their navigation references are refreshed from current language-tool locations.
On-demand related files, including open buffers, remain capped at 256 KiB.
A function's explanation
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

The formatting-aware tracked-input and line-anchor format has its own explanation
prompt-version bump, so earlier explanations and file summaries need regeneration
once. Step links record both ends of their source range and tolerate spacing
outside quoted text and blank-line shifts; when reflow changes an anchor so it
cannot be resolved, that item has no source range rather than using an old offset.

Invalidation never regenerates automatically. Use the preview's
**Regenerate** link, or select text in the function and run **Open Preview to
the Side**, to regenerate, or use the page heading's **Refresh** icon
for the checked outdated items in the shown preview. **Refresh Repository
Context** explicitly reviews or rebuilds the overview. **Clear Repository
Cache** removes cached overviews, explanations, and saved provider consent for
that repository. Freshness means recorded inputs match; it does not prove the
generated explanation is correct.

## Local development and verification

Repository-local Copilot development agents in `.github/agents/` separate
architecture, correctness review, core implementation, preview UI, language
support, and testing. Their model assignments and usage are documented in
`docs/development.md`. They do not alter the extension's runtime model selection
or consent, are excluded from the VSIX, and do not start an automatic fleet.

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
host tests exercise Rust, Go, Python, JavaScript, and React discovery (Go and
Python without a language server), distinct identities for
same-named Rust methods in different `impl` blocks, document-ordered outlines,
explanations requested by selecting text and opening the preview, preview creation, selection changes during an in-flight
request, saved explanations listed as ready after closing and reopening the
preview, steps that follow the cursor and select their lines when clicked, a flowchart
added on request whose nodes follow the cursor and select their lines,
the persistent prefetch approval state for separate explanation and overview
models without starting generation, and clearing that state when prefetch is
disabled or mock mode is selected, prefetching that starts at the cursor, stays within its window, and
follows the cursor, prefetching of a called function in another package,
saved-explanation hovers that appear only when an explanation is saved and
never generate, a folder preview of the Go repository root (excluded
folder left out, import edges), the Explorer command previewing a folder, and
switching to a file leaving the folder preview, a folder summary generated
only on request and shown as current when the folder is previewed again,
main flows described only on request with steps linked to the files and
functions found, and shown again when the folder is previewed again, a
folder tree run summarizing the subfolders and then the project again,
review mode queueing only an edited component and a new
untracked file's component and explaining both, **Cancel** aborting review
requests in flight so none is saved, repository commands acting on the shown
diff's repository while its non-file side has focus, including the one in a file
that is not shown, JavaScript calls resolved through the built-in TypeScript
go-to-definition (standard-library calls not followed) and their hovers, a
React component's concise preview (component and nested handler) with no
explanation generated for a plain cursor, its
hook, rendered component, and helper resolved in order of first use through
the real TypeScript server, its props interface tracked, a `memo`-wrapped
arrow component explained and shown when hovering `<CartItem>`, refusal to explain a function in a `.copilotignore`d file, and
unsupported plaintext discovery. Each run uses a fresh temporary
VS Code profile so earlier runs' windows are not restored.
Header tests cover native icon buttons, responsive label collapse, model roles,
text-only breadcrumb summaries, level styling, scoped statistics and explicit
action validation. Service tests count records across models without scanning
source or calling a provider and check cache-change notifications. Extension-host
tests check local saved counts, outdated function/file-summary regeneration
without touching current neighbours, direct child file-summary regeneration
from a folder, folder-summary/flow regeneration, cancellation before sending,
and project/group/component breadcrumb levels from the saved map.
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
files left out, and symlinked, hidden, dependency, or ignored folders
refused), Go, Rust, and TypeScript import edges between a folder's
children, and the structure layout (importers above imports, shared rows with
hidden edges, unconnected rows, cycles' upward edges, waypoints for edges that
skip rows, crossing reduction, and running standalone as in the webview);
folder tree tests cover grouping folders by height, refusing trees over the
limit, and summarizing stale folders with every folder above them while
skipping current branches;
folder summary tests cover the input (names, saved summaries, function names,
imports, no code), parsing that drops unusable part sentences, and the
service saving a summary, keeping only sentences for parts without one, and
marking it outdated when the input changes but not when the repository's
purpose does;
overview-model tests cover keeping one approval per model and reading older
single approvals, and the service priming with the overview model while
explaining with the explanation model, and summarizing folders with the
overview model;
project flow tests cover the catalog (files with summaries or functions, no
code), dropping malformed flows, keeping only confirmed file and function
references, and saving flows with the overview model, outdated when the
catalog changes but not when the background does;
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

- The change view explains only local `git:` and `file:` diffs, one file at a
  time, with no cross-file story and no before/after flowchart; it does not
  check the model's claims about behavior, so its consequences are things to
  verify. Changes to the index or working tree made outside the editor are
  noticed only when the window regains focus, the diff is shown again, or VS
  Code updates the diff's open Git document. Git URI forms are read as the
  built-in Git extension produces them; unit tests read such URIs against a
  real temporary repository (including `HEAD` moving before and during a
  request), but the extension-host tests use `file:` diffs and the empty
  stand-in document, not the Git extension's own diffs.
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
  defines the type, and skips module files beyond the scanner's 2,000-file
  limit (stated as a limitation).
- Go tracking also follows bodies at depth 1 and signatures at depth 2, and
  matches method calls by name against
  methods of the types the function names or receives from calls, so it may
  track an extra same-named method or miss one reached only through an
  interface, embedding, or a variable of an unnamed type. Build tags and
  `//go:build` constraints are ignored, packages are followed only within the
  file's own module (not `go.work` workspaces, `replace` targets, or
  `vendor/`), and package files beyond the scanner's 2,000-file limit are
  skipped with a stated limitation.
- Python analysis is syntactic, not an interpreter or type checker. It does
  not resolve inheritance, dynamic dispatch, wildcard imports, re-export
  chains, decorators' runtime replacements, monkey-patching, or custom
  `sys.path`/import hooks. Absolute imports use bounded repository, `src/`,
  and package/script roots; ambiguous matches are omitted. Dependencies inside
  nested functions are attributed to those functions, not the enclosing body.
  There is no dedicated notebook or `.pyi` stub support.
- SQL is a bounded lexer, not a full dialect parser or database catalog.
  Dynamic SQL, non-SQL routine bodies, runtime schema changes, synonyms,
  migration execution order, and complete dialect semantics are not resolved.
  SQL/PL/pgSQL dollar routine bodies are inspected; strings containing SQL are
  not. Unquoted names are case-folded, while quoted names preserve case.
  Ordinary comments/whitespace are ignored by fingerprints, but literal
  contents, executable comments, hints, and operator boundaries are preserved.
  Overload calls are matched by name, so callers and context can include extra
  candidates. SQL has no import-diagram edges.
- The project map is the overview model's reading of bounded evidence
  (READMEs, manifests, API contracts, deployment facts, folder markers, and
  some source files), not an analysis of calls: levels can be wrong and
  connections can be missing or inferred from names, especially when calls
  between services are configured at runtime. Regenerating is the fix; levels
  cannot be overridden. Parts deeper than six folders, beyond 60 parts, or in
  folders outside the scanner's 2,000-file budget are not mapped.
- Structure diagrams show imports only: dependency injection, plugin
  registries, message queues, HTTP calls between services, Rust `super::`
  and `self::` paths, Go imports of other modules, TypeScript `baseUrl`
  imports without `paths`, and languages other than Rust, Go, Python, JavaScript, and
  TypeScript are not drawn. A child folder counts as one box, however large.
- Callers are tracked only when VS Code tooling reports them. In languages
  other than Rust, Go, Python, SQL, JavaScript, and TypeScript, only called functions are tracked (not the types,
  constants, or variables a function uses), and only when the installed
  language extension provides go-to-definition. Call sites are found
  textually (a name followed by `(`), so calls through references (passing a
  function as a value), decorators, operators, or interpolation inside quoted
  strings are missed, and a slow language server can
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
  Python, SQL, JavaScript, and TypeScript depend
  on the installed symbol provider's detail; import detection covers JavaScript/
  TypeScript, Python, Go, Java/Kotlin/Scala/Groovy, C#, C/C++, PHP, Ruby, and
  Swift.
- Two moderate npm audit findings affect the development-only Vitest toolchain;
  production dependency audit reports no advisories. The findings are recorded
  here rather than changing the test runner's major version as an unrelated
  compatibility change.
