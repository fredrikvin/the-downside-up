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
  relevant. When parts of a function run at different times, such as a React
  component's effects and click handlers, the steps are grouped under when
  they run ("Each time it is shown", "When the person clicks Check out"), and
  React components and hooks are explained in React's terms: props as inputs,
  what is shown as the result, and hooks in plain words. The innermost steps at the editor's cursor (or all steps a
  multi-line selection touches) are highlighted, and clicking a step
  highlights its lines in the editor. **Explanations:
  Formats** (`downsideUp.explanations.formats`) adds **Pseudocode** and
  **Flowchart** tabs next to the steps, with the same highlighting and
  click-to-select; **Explanations: Initial Format** picks the tab that opens
  first. In flowcharts, what a function returns to be shown on screen (such
  as a React element) is drawn as a "Shows" box, and the logic deciding what
  appears inside it, such as a button's label, is drawn inside that box. Choosing a tab switches every explanation, like language tabs in
  documentation, while keeping your place. Enabled views are generated with new explanations; for saved ones,
  open the tab and choose **Generate**. **More detail** adds where it fits, edge cases, language notes,
  and related code; **Explanations: Show Details**
  (`downsideUp.explanations.showDetails`) opens it by default. Current
  explanations are shown open, so the preview reads like a document, unless
  you collapse them. Several can be open at once, and up to three
  generations run at the same time (see **Max Concurrent Requests** below).
  Each explanation links to the related code the extension found.
  The explanation also uses the functions the function calls, including from
  other files, plus the signatures of the functions those call, and is marked
  outdated when any of them change. For Rust and Go, it also uses the types,
  constants, and methods the function uses, and their files are described,
  and their functions and calls found, with bundled parsers, so no language
  server is needed. JavaScript and TypeScript (including JSX and React) are
  described and their functions found with bundled parsers too: arrow
  functions, components (also inside `memo` or `forwardRef`), hooks, and
  class and object methods are all functions you can explain, and the
  preview labels components and hooks and describes state in plain words.
  What such a function uses (the functions and hooks it calls, the components
  it renders, and the types it names, such as its props) is found with VS
  Code's built-in TypeScript go-to-definition; right after VS Code starts,
  this waits for TypeScript to load the project. Other languages use the
  editor's own tooling: functions come from its document symbols and calls
  are found with go-to-definition, so this works where a language extension
  provides them.
  Current saved explanations appear whenever the preview shows their file,
  including after reopening the preview or restarting VS Code; this is a
  local cache check only. The file summary is generated with the first new
  explanation in a file and sends that file's text (up to 24 KiB).
  Selecting text inside a function
  in the editor opens its section only when a saved explanation exists.
  Selecting never starts generation by itself.

**Downside Up: Open Preview to the Side** (the preview button in the editor
title bar) opens or reveals the preview of the active file, following the
editor's position. If text is selected inside a function, it also opens that
function's explanation, generating or regenerating it when none is current, so
selecting a function's name and opening the preview explains it. With a plain
cursor it only opens the preview. The repository context used for explanations is shown at the
end of the preview.

**Folder and project previews.** A folder can be previewed like a file: run
**Open Preview to the Side** on a folder in the Explorer, run **Downside Up:
Preview Project** for the repository root, or click a step of the breadcrumb
trail (`project › folder › file`) at the top of any preview. A folder preview
lists its subfolders (with how many files they hold) and files, with each
file's saved one-sentence AI summary, and draws a **structure diagram** of
which of them import which: importers above what they import, so entry points
sit on top and foundations below; folders that most of the others use sit in
a bottom row without arrows, and items with no imports to or from the others
in a row of their own. Click a box or name to preview that folder or open
that file. The diagram is built locally from imports (Rust, Go, JavaScript,
and TypeScript, including `tsconfig` path aliases); it does not show other
connections, such as dependency injection or calls between services, and
nothing is generated or sent. The folder preview stays until you switch to
another file. The project (repository root) preview also shows the saved
repository overview under **About this project**.

A folder (or the whole project) can also get an AI summary: choose
**Summarize this folder** at the top of its preview. It gives one sentence on
what the folder is for, a few on how its parts fit together and where to start
reading, and a sentence for each file or subfolder that has no summary of its
own (marked as inferred from names). The request holds only names: the
contents' names and saved summaries, the names of functions and types in
files without a summary, the imports between them, and the folder's README;
no code. Summarize subfolders first, and their summaries feed the parent's.
A saved summary is shown whenever you preview the folder, and marked
outdated when its contents change; choose **Regenerate** to update it.

**Describe the main flows** in a folder (or project) preview draws one to
three flowcharts of what happens, such as handling a request or starting up.
Each step names the file and function where it happens, and clicking it opens
that place; the extension only links to files and functions it found itself.
The request holds file paths, saved file summaries, function names, and the
imports between parts, not code, so explaining a few functions first (which
saves file summaries) gives better flows.

**Summarize with all subfolders** does both for a whole tree in one go. It
first checks every folder below locally, then says how many requests it will
send and roughly how many tokens, and sends nothing until you accept. It then
summarizes each folder without a current summary, deepest first so every
summary builds on its subfolders' new ones, and finally describes the main
flows if they are not current. Up to 100 folders are summarized per run (in
trees of at most 400 folders); for larger trees, start with their subfolders.
The preview shows the progress, and **Cancel** (or changing the overview
model) stops the run; finished summaries are kept.

Project-level work (the repository overview and folder summaries) happens
far less often than explaining functions, so it can use a stronger model:
run **Downside Up: Choose Overview Model** (or, with OpenAI, set
`downsideUp.openai.overviewModel`). Explanations keep using the regular model.
Code sharing is approved once per repository and model, so a new overview
model asks once.

The development fixtures are in `fixtures/rust-app`,
`fixtures/go-app`, `fixtures/js-app`, and `fixtures/react-app`.

To install a locally packaged VSIX, run
`code --install-extension the-downside-up-0.20.0.vsix`.

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
is excluded by `.gitignore` or `.copilotignore` (at any folder level inside
the repository, and `.copilotignore` in folders above it), by VS
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

If your organization enforces content exclusion with its own policy files on
each computer (some organizations keep these for Copilot hook scripts), point
these settings at them. Each takes a path to a plain-text file, with one
entry per line; blank lines and lines starting with `#` are skipped, and `~`
is expanded. They are read from user settings only, so a repository cannot
change them, and take effect immediately. An empty setting, or a file that is
missing or unreadable, adds nothing, so check the paths.

**Exclusion: Blocked File Patterns File**
(`downsideUp.exclusion.blockedFilePatternsFile`) lists gitignore-style
patterns for files that are never read into context or sent, in any
repository. Patterns are matched against paths inside the repository: one
without `/` matches at any depth, one with `/` is anchored at the repository
root, and a pattern matching a folder covers everything in it. `*` and `?`
stay within one folder; `**` crosses folders.

```text
# Deployment settings with credentials
deploy*.yml
*.vault
# A whole folder, wherever it is
private-assets
# Only at the repository root
docs/internal
```

**Exclusion: Restricted Remotes File**
(`downsideUp.exclusion.restrictedRemotesFile`) lists Git remote URL prefixes.
`*` matches any characters, and a trailing `*` is implied. A repository with
any matching remote is not read or sent at all (explanations, file summaries,
and **Refresh Repository Context** stop with the reason, while the local
preview keeps working) until it opts in with one of:

- a `.copilotignore` file at its root or in a folder above it (an empty file
  allows everything; patterns in it exclude files as usual),
- a `.allowed-services` file at its Git root that contains the word
  `copilot`,
- a listing in the allowed repositories file below.

```text
# Every repository on these servers
ssh://git.example.com/
https://git.example.com/
https://*.internal.example.com/
```

**Exclusion: Allowed Repositories File**
(`downsideUp.exclusion.allowedRepositoriesFile`) lists repository paths that
may be sent even when their remote is restricted. A remote's path is its URL
without the scheme, user, host and port, and `.git`: for
`ssh://user@git.example.com:29418/team/app.git` it is `team/app`. `*` matches
within one path segment, and the whole path must match.

```text
team/app
# Every repository directly under tools
tools/*
```

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
function. **Prefetch: Dependencies**
(`downsideUp.prefetch.dependencies`, default 3, `0` for none) also prefetches
up to that many functions in other files that the function you are reading
calls, right after the function itself, so they are ready if you follow a
call. Prefetching runs only in trusted workspaces after you have explained
one function with the current model, which approves code sharing for the
repository; it never asks for approval itself. Every prefetched explanation
counts toward your provider's usage limits or billing.

### Review mode

To review a branch or a pull request, check it out and run **Downside Up:
Review Changes…**. Choose what to compare the checked-out code with: the
branch's merge base with `main` (or `master`, or the remote's default
branch), that branch as it is now, only uncommitted changes, or any recent
commit. The extension finds the functions that changed locally (including
uncommitted edits and new files), tells you how many, and after you confirm,
explains them in the background with the request slots your own requests
leave free, so their explanations are ready when you get to them. In the file
you are reading, the changed function nearest your cursor goes first, so
jumping to a changed function that is still waiting moves it forward;
everything else uses the preview as usual. Functions that already have a
current explanation are skipped, as are files excluded from AI explanations.
The status bar shows progress; click it (or run **Downside Up: Show Changed
Functions**) to jump to a changed function, or to stop. Closing the preview
or **Cancel** stops it too. Running the command is an explicit request, so it
asks for code-sharing approval if needed, and every explanation counts toward
your provider's usage limits or billing.

### Saved explanations on hover

Hovering a call to a function shows the purpose from its saved AI
explanation, if one is current. Calls are found the same way as for
explanations, so outside Rust and Go this needs
go-to-definition (built in for JavaScript and TypeScript, where hovering a
rendered component such as `<CartItem>` works too). This only reads the local cache and never
generates; turn it off with **Downside Up › Hover: Saved Explanations**
(`downsideUp.hover.savedExplanations`). It works once the extension is active,
for example after opening the preview.

## Development

`npm run typecheck` checks TypeScript, `npm test` runs deterministic unit tests,
`npm run test:extension` exercises the Rust, Go, JavaScript, and React flows in a real
VS Code host, `cargo test --manifest-path fixtures/rust-app/Cargo.toml` checks
the Rust fixture, and `go test ./...` in `fixtures/go-app` checks the Go
fixture. `npm run package` builds a VSIX including the required
production Tree-sitter runtime.

Language support is modular. Each language with bundled analysis has a
folder under `src/languages/` that exports one `LanguageSupport`
(`src/languages/support.ts`): how to find a function at a position, list
functions, describe the file, find what a function uses, and optionally add
background for explaining a kind of function (as for React components). To add one, add
the folder, list it in `src/languages/registry.ts`, and, for a Tree-sitter
grammar, add the grammar's name to `esbuild.config.mjs`. Languages without
one use `src/languages/editor/` (VS Code document symbols and
go-to-definition).
