# Preview navigation consolidation

Status: deferred follow-up, recorded 2026-10-22 against release 0.43.4.

## Decision and priority

Keep the current implementation while adding language support and unrelated
tweaks. The latest changes address reproducible event-ordering failures, and
the user reports substantially improved stability. This is not a claim that
all races are eliminated or that the exact user chart has been verified.

Revisit before extending editor/preview scroll synchronization, source-item
selection, focus routing, or diff-side navigation. Revisit sooner if jumping,
lost highlights, wrong-side selection, or rapid-click regressions return.
Language-specific discovery and context changes do not themselves require this
refactor, provided they preserve the existing navigation contracts.

This is a focused interaction-lifecycle review, not a rewrite of the preview,
language support, generation, or caching.

## Existing safeguards to preserve

- A preview item click keeps that pane still while revealing its source.
- Ordinary-file clicks retain preview focus; diff items use their own side
  of the existing comparison editor without opening a separate source tab.
- Pending navigation ignores intermediate programmatic selections, and stale
  selection events cannot replace the current clicked highlight.
- New code-editor keyboard/mouse input returns control to the editor.
- Superseded navigation cannot overwrite the newer highlight.
- Same-document focus does not rebuild the preview.
- Linked-item clicks cancel queued scroll/reveal feedback.
- During a redraw, preserve the absolute scroll offset until charts have
  layout; restore reading anchors only afterward.

## Debt and starting points

Ownership is currently distributed across `revealed`, `suppressEditorSyncUntil`,
selection/focus/visible-range handlers, and webview animation-frame callbacks.
Host suppression uses 250/800 ms windows, and webview guards use 100/200 ms
windows. These feedback guards should not be treated as a complete causal
protocol. Ordinary-file and diff navigation duplicate lifecycle handling.

Read these areas before designing a replacement:

- `src/extension.ts`: `revealItem`, `revealChangeLines`, `clearReveal`,
  `syncStepHighlight`, and active-editor, selection, and visible-range handlers.
- `src/presentation/panel.ts`: `linkItem`, `render`, `scrollToLine`,
  `revealActive`, message handling, and flowchart drawing.
- `test/panel.test.ts`: queued-frame cancellation and intermediate-scroll tests.
- `test/extensionHost/runner.ts`: pending/stale selection events, rapid clicks,
  and native diff-side navigation.
- `docs/prototype.md`: the existing scrolling, selection, and privacy contract.

## TODO

- [ ] Map event sequences for preview clicks, code clicks/keyboard movement,
  scrolling either pane, diff-side focus, redraws, and switching/closing views.
  Distinguish application-owned effects from VS Code events whose origin is
  unavailable or ambiguous.
- [ ] Define a small navigation coordinator with explicit ownership and
  transitions, covering pending, applied, superseded, cancelled, and failed
  navigation. Decide how genuine user input takes precedence over pending work.
- [ ] Evaluate interaction IDs and view/document generations across the
  host/webview boundary. Guard side effects as well as completion callbacks:
  rejecting an old completion alone does not prevent an old editor operation
  from moving the caret.
- [ ] Route ordinary-file and diff navigation through the shared lifecycle,
  retaining separate adapters for their source validation and editor APIs.
- [ ] Keep layout restoration separate from navigation ownership. Guard queued
  layout work against view replacement, and avoid rebuilding unchanged content.
- [ ] Replace timing-based correctness assumptions with causal guards where
  feasible. Retain bounded timers only where VS Code lacks suitable signals;
  document each remaining timer's purpose and limitations.
- [ ] Add deterministic event-order tests before removing existing safeguards.
  Implement incrementally rather than replacing all synchronization at once.

## Acceptance criteria

- The originating pane never moves due to the navigation it requested,
  including intermediate frames and delayed events.
- The latest accepted interaction owns the caret/highlight; rapid alternating
  clicks and out-of-order completions cannot restore an older interaction.
- A real code-editor interaction resumes normal cursor following, including
  clicking at the same caret position.
- Working-file and original/modified diff navigation preserve their intended
  focus behavior and never select a different document or open an extra tab.
- Tall/nested charts remain stable with their top above the viewport and the
  following function visible, including redraws, resizing, and tab changes.
- Switching files, editing source, closing the preview, navigation failure,
  and cancellation invalidate obsolete work without leaving ownership stuck.
- No provider requests, consent changes, source-path trust changes, or cache
  behavior changes result from this work.

Use synthetic fixtures, not private application code, for persistent tests.
Cover delayed selection/focus events, rapid clicks on different nodes and diff
sides, user input during a pending request, delayed visible-range events, and
stale layout frames. Include real-browser layout checks for intermediate
scroll positions, not just final offsets, plus extension-host navigation checks.

Run `npm test` and `npm run test:extension`. For an installable build, follow the
repository's version-bump, packaging, and separate release-commit procedure.
