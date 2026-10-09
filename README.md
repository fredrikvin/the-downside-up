# The Downside Up

The Downside Up is a prototype VS Code extension that shows a document-style
Downside Up preview beside your source, like the Markdown preview. It lists the
file's functions at the same position as in the file and adds a plain-language
AI explanation under a function when you ask for one, written for someone who
wants to know what the code does without knowing the language. More local
detail (imports, types, values, and so on) can be turned on in settings.
Explanations are generated only when requested (or prefetched, if you turn
that on), and mock mode is the default and makes no external requests.

## Run locally

Requirements: Node.js 18 or newer, npm, and VS Code 1.90 or newer.

```sh
npm ci
npm test
npm run test:extension
npm run package
```

Open this project in VS Code and press **F5** to launch an Extension
Development Host. In the host, open a source file and run **Downside Up: Open
Preview to the Side** (or use the preview button in the editor title bar).

- **Document preview.** By default the preview is concise: the file name, a
  one-sentence AI summary of the file once one of its functions has been
  explained, and a heading per function in source order. **Downside Up ›
  Preview: Include** (`downsideUp.preview.include`) adds imports, types,
  values, locals, comments, modules, and one-line signature descriptions;
  these are built locally from the code and are not AI-generated. The preview
  follows the active editor and updates as you edit.
- **Scroll sync.** Scrolling the editor scrolls the preview to the matching
  position and vice versa, down to the step or pseudocode line describing
  each code line, and the item at the cursor is highlighted. Clicking in the
  code brings its explanation into view; clicking a step keeps the preview
  still. A function's heading stays pinned at the top while you read its
  explanation.
  Double-click an item to jump to its source.
- **AI explanations.** Each function has an **AI explanation** section.
  Open it (or click the function's name) to show its saved explanation, or to
  generate one if none is current; a spinner shows while it loads, and the
  chevron collapses it again. An explanation gives the function a short
  title (such as "Fetch a wearer"), says what it is for, and lists its inputs,
  its result, the main steps in order, and extras such as cleanup only when
  relevant. The innermost steps at the editor's cursor (or all steps a
  multi-line selection touches) are highlighted, and clicking a step
  highlights its lines in the editor. **Explanations:
  Formats** (`downsideUp.explanations.formats`) adds **Pseudocode** and
  **Flowchart** tabs next to the steps, with the same highlighting and
  click-to-select; **Explanations: Initial Format** picks the tab that opens
  first. Choosing a tab switches every explanation, like language tabs in
  documentation, while keeping your place. Enabled views are generated with new explanations; for saved ones,
  open the tab and choose **Generate**. **More detail** adds where it fits, edge cases, language notes,
  and related code; **Explanations: Show Details**
  (`downsideUp.explanations.showDetails`) opens it by default. Current
  explanations are shown open, so the preview reads like a document, unless
  you collapse them. Several can be open at once, and up to three
  generations run at the same time (see **Max Concurrent Requests** below).
  Each explanation links to the related code the extension found.
  For Rust and Go, the explanation also uses the types, functions, and methods
  the function uses, including from other files and packages, plus the
  signatures of the functions those call, and is marked outdated when any of
  them change. Rust and Go files are described, and their
  functions found, with bundled parsers, so no language server is needed.
  Current saved explanations appear whenever the preview shows their file,
  including after reopening the preview or restarting VS Code; this is a
  local cache check only. The file summary is generated with the first new
  explanation in a file and sends that file's text (up to 24 KiB).
  Selecting text inside a function
  in the editor opens its section only when a saved explanation exists.
  Selecting never starts generation by itself.

**Downside Up: Explain Function** explains the function at the cursor from the
command palette. The repository context used for explanations is shown at the
end of the preview. The development fixtures are in `fixtures/rust-app`,
`fixtures/go-app`, and `fixtures/js-app`.

To install a locally packaged VSIX, run
`code --install-extension the-downside-up-0.9.6.vsix`.

## Provider setup

The `downsideUp.provider` setting defaults to `mock`. Mock output is
deterministic placeholder content, not semantic analysis. There are two live
providers.

### GitHub Copilot or another VS Code language model (no API key)

1. Sign in to GitHub Copilot in VS Code (or install another extension that
   provides language models).
2. Run **Downside Up: Choose Language Model** and pick a model. This sets
   `downsideUp.provider` to `vscode-lm` and records the model's vendor and ID.
3. Explain a function. Before the first request for a repository and model,
   review and accept the code-sharing prompt. VS Code also asks once whether
   The Downside Up may use language models; you can change that later under
   **Accounts › Manage Language Model Access**.

Requests go through the VS Code Language Model API and use your existing
subscription, so they count toward that plan's usage limits and follow that
provider's data-handling terms and your organization's policies.

### OpenAI API key

1. Set `downsideUp.provider` to `openai`.
2. Run **Downside Up: Set OpenAI API Key**. The key is stored in VS Code
   SecretStorage.
3. Explain a function. Before the first external request for a repository and
   model, review and accept the explicit code-sharing prompt.

OpenAI API access and billing are separate from any coding-assistant
subscription. The extension sends bounded repository context and selected
source to the OpenAI Responses API; `store:false` does not guarantee zero
provider-side retention. See `docs/prototype.md` for data handling, cache
freshness, limits, and known limitations.

### Content exclusion and enterprise policies

The extension never explains, prefetches, or sends as context any file that
is excluded by `.gitignore` or `.copilotignore` (at any folder level), by VS
Code's `files.exclude` or `search.exclude`, by being in a hidden, dependency,
build, or vendored folder, or by having a secret-like or generated name.
Explaining a function in such a file stops with the reason before anything is
sent, and the preview notes it; local descriptions are still shown.

GitHub Copilot's content exclusion, which organization and repository
administrators configure on GitHub, is **not** applied to this extension's
requests, even when the model is a Copilot model. GitHub enforces those rules
in Copilot's own features; this extension builds its prompts itself and sends
them through VS Code's Language Model API, so Copilot cannot tell which files
the text came from. To apply your organization's rules, mirror the excluded
paths into `.copilotignore` files in each repository, using the same path
patterns. With an OpenAI API key, no Copilot policy applies at all; check that
your organization allows sending source code to OpenAI before using it.

### Prefetching (optional)

By default, explanations are generated only when you ask for one. To have them
ready as you read, turn on **Downside Up › Prefetch: Enabled**
(`downsideUp.prefetch.enabled`) in your user settings. While the preview is
open, the extension then explains the shown file's functions in the
background, starting where you are and spreading outward. It uses the
request slots your own requests leave free and always leaves one for them;
**Max Concurrent Requests** (`downsideUp.maxConcurrentRequests`, default 3,
1–8) sets how many requests run at once. More is faster but may hit your
provider's rate limits sooner; it does not change how many requests are made. **Prefetch: Window**
(`downsideUp.prefetch.window`, default 10) limits it to that many functions
nearest your position and follows you through the file; `0` prefetches every
function. For Rust and Go, **Prefetch: Dependencies**
(`downsideUp.prefetch.dependencies`, default 3, `0` for none) also prefetches
up to that many functions in other files that the function you are reading
calls, right after the function itself, so they are ready if you follow a
call. Prefetching runs only in trusted workspaces after you have explained
one function with the current model, which approves code sharing for the
repository; it never asks for approval itself. Every prefetched explanation
counts toward your provider's usage limits or billing.

### Saved explanations on hover

Hovering a call to a Rust or Go function shows the purpose from its saved AI
explanation, if one is current. This only reads the local cache and never
generates; turn it off with **Downside Up › Hover: Saved Explanations**
(`downsideUp.hover.savedExplanations`). It works once the extension is active,
for example after opening the preview.

## Development

`npm run typecheck` checks TypeScript, `npm test` runs deterministic unit tests,
`npm run test:extension` exercises the Rust, Go, and JavaScript flows in a real
VS Code host, `cargo test --manifest-path fixtures/rust-app/Cargo.toml` checks
the Rust fixture, and `go test ./...` in `fixtures/go-app` checks the Go
fixture. `npm run package` builds a VSIX including the required
production Tree-sitter runtime.
