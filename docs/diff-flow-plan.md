# Visual behavior comparisons: implementation plan

Status: Paired visual comparisons are implemented in the development tree;
**Trace a case** remains planned. Baseline: 0.39.2.
Recorded: 2026-10-20.

This extends the textual native-diff change view, not ordinary function
explanations or project maps. Read `docs/prototype.md`,
`.github/copilot-instructions.md`, and the `vscode-extension-development`
skill before implementing.

The shared general-help footer has been removed separately. This plan does
not require a replacement footer or another persistent panel.

## Goal

Make it easy to see which operations, decisions, and execution paths differ
between the exact original and modified versions of a file. Keep the short
behavioral explanation, but make its evidence and flow visible.

Deliver paired visual comparisons first. Add **Trace a case**, an
illustrative comparison of paths for a stated condition, as the next phase.
Neither phase is a debugger, compiler, correctness proof, or security review.

## Proposed first-version experience

1. Open a native diff and its existing Downside Up preview. Opening checks
   the cache first; existing opt-in prefetch may generate a missing comparison
   using sharing approval already given. **Explain changes** remains the
   explicit generation request.
2. Show the file summary and one card per meaningful change, including when
   behavior differs. Closely related changes in the same region can share a
   visual comparison instead of repeating the whole function.
3. Offer **Steps / Pseudocode / Flowchart** within the comparison. All three
   views describe the same paired behavior, not independent explanations.
   Reuse existing format preferences; do not add another model selector.
4. Present **Before / After** side by side when there is enough room. Use
   consistent names and shapes for matched operations and emphasize changes
   to both nodes and edges. Keep version labels visible.
5. In a narrow panel, use a Before / After toggle instead of shrinking two
   charts into unreadable columns. Preserve the selected semantic step and
   viewport anchor when switching. **Expand comparison** provides a focused
   view in the same preview, with a clear return action.
6. Start with changed behavior and enough context to understand it.
   **Show surrounding flow** expands already-generated unchanged regions
   locally. Do not promise a full-function view if the bounded response did
   not include the whole function.

Use existing VS Code editor-group resizing first. A custom resizable
Before / After splitter is optional polish after the layout works. Do not
ship an overlapping wipe slider, combined old/new graph, or animated morph
in the first version: they can splice unrelated paths together or imply
correspondence that has not been established.

### Visual language and navigation

- Distinguish **Added**, **Removed**, **Moved**, **Changed**, and **Condition
  changed**, with words and border/line treatments as well as color.
- Keep unchanged behavior visually quiet. A move is a matched operation
  whose ordering or control-flow context changed, not just shifted line
  numbers. Moving and changing an operation can both be indicated.
- Highlight the corresponding operation on the other side on pointer hover
  or keyboard focus. Do not invent a counterpart for an unmatched operation.
- Click a step, pseudocode line, or node to reveal its host-validated range
  on that side of the existing native diff. Changing focus must not turn the
  preview into an ordinary file view.
- Preserve branch labels, loop relationships, error paths, and early exits.
  Changed edges are significant even when the node labels are unchanged.
- Keep model attribution, relevant limitations, and uncertainty near the
  result. Do not reinstate the removed general-help footer.

For the motivating example, collecting IDs after the inventory call should
appear as a reordered operation. If a side appears unable to run, distinguish
an AI observation from any actual editor diagnostic, and show source order
or an unavailable-flow explanation rather than a fictitious successful run.
Do not invoke builds or require a language server to establish validity.

## Representation and generation

### One paired model, not a textual diff of two generated charts

Extend the comparison response with bounded visual scopes. A scope is a
function or coherent region named by the model, with checked evidence on
each side; it must not require perfect symbol discovery or another file.
Changes reference these scopes so overlapping changes can share one pair.

The proposed contract contains:

| Part | Required information |
| --- | --- |
| Change | Stable ID within this response, existing explanation/evidence, optional visual-scope ID |
| Scope | ID, title, included region and coverage limitations for each side |
| Side | Present/absent status; flow available, not applicable, or unavailable with a reason |
| Semantic units | IDs, consistent labels, and optional original/modified occurrences with their own source spans |
| Side graph | Nodes referencing that side's unit occurrences; edges with IDs, endpoints, and branch labels |
| Correspondences | Explicit matched units/edges and described differences; uncertain matches remain unpaired |
| Steps/pseudocode | Ordered side-specific items referencing the same units and checked source spans |

Use the existing `Flowchart`, node-kind, and line-link conventions where
they fit. Keep paired matching and annotations in comparison-specific types
rather than changing ordinary function-cache semantics.

Generate both sides and their correspondence in one structured comparison
request. Do not explain each side separately and diff the generated prose.
The Steps, Pseudocode, and Flowchart representations must share units and
branch meanings; do not derive pseudocode by naively traversing a graph,
which can misrepresent loops, joins, or deferred work.

The implemented wire contract is smaller than the presentation contract above:
each side sends one `operations` table (`id`, label, kind, source span).
Steps and pseudocode reference operation IDs without repeating spans or item
IDs. Chart nodes are operations whose kind is not `none`; edges reference
those same operations. `operationMatches` names one operation on each side,
and `edgeMatches` uses zero-based positions in the side-specific edge lists.
The host validates and expands this into the existing typed presentation
objects with its own side-specific identifiers. Source order and explicit
graph edges remain independent. Absent/present state comes from the snapshots.
There is no second model call for expansion, no chart-derived pseudocode, and
no inferred matching from equal labels or IDs.

Preserve one bounded request per file for initial **Explain changes** and
confirmed review batches. Steps are always available; request the optional
formats selected by existing format preferences. If a requested format was
not saved, show an explicit **Generate flow comparison** or **Generate
pseudocode comparison** action. Merely selecting a tab must not generate.
Such additions use both exact snapshots and the saved paired model, with
the same consent, freshness, cancellation, and usage accounting.

### Validation and honest degradation

- Check unique IDs, known references, one-sided additions/deletions,
  side membership, node kinds, edges, and correspondence consistency.
  Require one-to-one matches for this first version; split/merge behavior
  can remain unmatched with an explanation.
- Reuse the existing per-chart ceilings of 24 nodes and 40 edges. Add a
  whole-response ceiling so many changed regions cannot multiply that
  budget without limit. Initial proposed total: 96 nodes and 160 edges
  across both sides and all scopes, plus bounded text/item lengths.
  Exercise these limits against representative examples before release.
- Check each clickable span against that exact side's presence and line
  count. The host supplies URIs and navigation IDs; model IDs are never
  paths, command names, or executable links.
- Treat model correspondence and behavior claims as AI interpretations,
  not proven equivalence. Similar labels alone do not establish a match.
- Missing sides have an explicit empty state, not a fabricated Start/End
  flow. Path-only renames, comments, and configuration changes can keep a
  textual comparison when a flowchart would add nothing.
- If a visual format is malformed, retain a valid textual explanation with
  a visible format-specific limitation and explicit retry, following the
  existing optional-format pattern. Never silently claim it rendered.
- Report bounded/partial coverage. If the response cannot represent a scope
  usefully within limits, explain that instead of silently truncating edges.

## Layout and interaction work

Build a pure paired-layout helper, reusing existing graph-layout primitives
where possible. It should accept validated graphs and correspondence and
return deterministic layout data that can be tested without a webview.

Align unchanged anchors and use shared sizing/spacing where the graph
structure permits. Preserve the order and branch structure of each side:
reordered operations cannot always occupy the same rows. Do not force
alignment that makes an edge imply the wrong sequence. Stable labels,
matching highlights, and preserved focus matter more than pixel equality.

Fold unchanged regions only when their visible boundary connections can
be preserved and labelled accurately. Do not hide the decision explaining
a changed path, merge unrelated branches, or remove relevant loop/exit
structure. Expansion restores the cached subgraph without another request.

Use text labels and the existing restrictive HTML/SVG renderer, not
model-provided HTML, SVG, or executable Mermaid. Escape generated labels
and keep the current CSP. Keyboard navigation, visible focus, non-color
change labels, high contrast, and reduced motion are acceptance criteria.

Keep selected change, format, side, expansion, and focus state scoped to
the comparison. Expansion stays in the same preview rather than opening a
second review UI. Scope any layout extraction carefully so ordinary
function and project charts retain their current behavior.

## Cache, lifecycle, and privacy

Reuse the Functions provider, repository/model consent, shared scheduler,
comparison storage, and native-diff identity. Store paired views with the
comparison they describe; optional format additions must reference the
same comparison content/version, not just a matching file path.

Bump the comparison prompt version when introducing this contract, and any
changed schema/config version. Old comparison formats can be invalidated;
do not build cache migrations or preserve them by avoiding version bumps.
Do not invalidate ordinary function explanations for a comparison change.

Exact text on both sides remains the freshness boundary, including
formatting and line shifts. A mutable HEAD/index must be re-resolved before
generation and final validation; immutable review bases stay immutable.
Outdated diagrams remain clearly marked as saved explanations, with source
links disabled. Trace playback will also be disabled until current.

Scrolling, resizing, folding, expanding, switching comparison tabs, and following
source links must make zero provider requests. Generation is limited to explicit
actions, the already-confirmed review set, and missing comparisons when the
preview first shows a diff with existing user-level prefetch enabled.
Prefetch uses only existing consent and never prompts. All paths retain existing
exclusion, workspace-trust, size-limit, and consent rules.

The review lifecycle prerequisites from the 0.39.1 review are addressed in
the paired-visual implementation: retiring a review cancels its work, cache
persistence honors cancellation through the commit point, and the scheduler
keeps pending review items reorderable while explicit work occupies slots.
Focused regression tests cover these cases.

## Implementation sequence

| Milestone | Main changes | Completion evidence |
| --- | --- | --- |
| 1. Reliable request lifecycle | Resolve the three findings above in scheduler/review/cache integration | Cancel, disposal, replacement, persistence, and saturated-slot regressions pass |
| 2. Paired contract | Extend `src/core/types.ts`, comparison schema/parser/prompt, provider inputs, both real providers, and mock output | Bounded parsing, side validation, and correspondence tests; prompt version bumped |
| 3. Service and evidence | Extend `src/controller.ts`, `src/changeSession.ts`, and cache records for paired views and explicit format additions | Current-cache reuse, stale-result rejection, checked navigation, usage, and no implicit generation |
| 4. Local layout and views | Add the paired-layout helper and extend `src/presentation/panel.ts` and its typed view/actions | Steps, pseudocode, paired charts, narrow layout, focus/hover matches, changed edges, and local expansion |
| 5. Integration and documentation | Connect format actions in `src/extension.ts`; retain ordinary preview behavior; document shipped limits | Real native Git diff checks, full suites, accessibility/width inspection, release preparation |

Suggested tests: extend `test/comparisonSchema.test.ts`, `test/service.test.ts`,
`test/changeSession.test.ts`, `test/review.test.ts`, `test/requestScheduler.test.ts`,
and `test/panel.test.ts`; add a focused pure paired-layout suite. Extend
`test/extensionHost/runner.ts` for both-side navigation and explicit format
requests. Use a properly opened temporary repository with the built-in Git
provider; `file:` diffs and empty stand-ins alone are not sufficient evidence.

### Acceptance cases

- Reordering a matched operation shows a move, not a deletion/addition pair.
- Adding an early return or changing a predicate highlights the changed
  path/edge, including when operation labels stay the same.
- Branch joins, error exits, loops, removed code, and uncertain matching
  remain understandable without implying nonexistent execution.
- Original-side evidence opens original lines, including deleted code;
  modified-side evidence honors unsaved text and cannot target another file.
- A formatting edit outdates both the explanation and its diagrams.
  Source changes, cancellation, cache clearing, and model changes cannot
  attach an old format/result to a new comparison.
- Selecting cached formats, resizing, and expanding make no requests.
  Unavailable formats are visibly unavailable until explicitly requested.
- Narrow and wide panels, keyboard-only use, high contrast, and reduced
  motion remain usable. Ordinary file/folder previews do not regress.

Run `npm test` (including typecheck) and `npm run test:extension`. Inspect
real Git diffs manually for focus, original-side navigation, and layout;
mock-provider tests cannot establish semantic quality. Update README,
configuration/prototype docs, and changelog only to describe implemented
behavior. For an installable feature release, choose the next unused minor
version, follow the separate release-commit rules, and inspect the VSIX's
external Tree-sitter runtime and WASM assets.

## Next phase: Trace a case

Start this after the paired views are usable and validated. The question is
"For this stated condition, which path would each version take, and where
would their outcomes differ?" It is an illustration grounded in the paired
model, not running, testing, or symbolically executing repository code.

### Experience

Offer a small **Trace a case** control within a visual scope. Begin with
bounded suggested cases such as "validation fails" or "inventory returns an
error", not an unrestricted natural-language debugger.

Selecting a prepared case highlights paths in both versions, shows the
first divergence and outcomes, and supports **Next step**, **Previous
step**, and **Reset**. Shared operations remain matched; one side can finish
earlier than the other. Show assumptions and unknown external behavior.
Do not make one visual step imply equal elapsed time on both sides.

### Data and generation

Add a separately versioned, bounded trace result containing a condition,
assumptions, side-specific sequences of existing node/edge IDs, outcomes,
and limitations. Validate that every path belongs to its side's graph and
that adjacent steps are connected. Bound loop iterations and label the
chosen example; do not imply coverage of all paths or all input values.

Use an explicit **Prepare example paths** request if cases are not already
saved. Generate from the current validated comparison and eligible source
snapshots, never arbitrary code execution. Cache against the exact paired
comparison content, format version, provider/model, and source identities.
Selecting or stepping through saved cases is entirely local.

If source, model, or the paired representation changes while preparing a
trace, discard the result. Keep traces visibly outdated and disable playback
and source links until regenerated explicitly. For absent, invalid, or
insufficiently described sides, report why a trace cannot be shown rather
than inventing a feasible path. A scope with omitted branches may need an
explicit richer comparison before tracing that case.

### Trace acceptance

Cover identical outcomes, an added early exit, a changed condition,
different error handling, unequal path lengths, bounded loops, unavailable
sides, malformed path IDs, stale snapshots, cancellation, and no requests
while stepping. Keep arbitrary execution, automatic test generation,
cross-file tracing, and proofs of correctness outside this phase.
