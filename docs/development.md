# Developing The Downside Up

For extension usage, start with the root `README.md`. Detailed settings are in
`docs/configuration.md`. Paths below are relative to the repository root.

## Setup

Use Node.js 22 or newer for the current packaging tool, npm, Git, and VS Code
1.90 or newer. Rust/Cargo and Go are needed for their fixture checks.

```sh
npm ci
npm test
npm run test:extension
```

Open the project in VS Code and press **F5** to launch an Extension Development
Host. Open a source file there and run **Downside Up: Open Preview to the
Side**. Mock mode is the default and makes no external requests.

The fixtures are in `fixtures/rust-app`, `fixtures/go-app`, `fixtures/js-app`,
`fixtures/react-app`, `fixtures/python-app`, `fixtures/sql-app`, and `fixtures/services-app`
(a multi-service project for the project map). Python analysis tests use the
bundled grammar; they need neither Python nor Pylance installed.
SQL tests use the bundled lexer and need neither a database nor a SQL language
server. There is no additional SQL WASM asset or runtime dependency.
SQL fixtures cover local table cards, later ALTER constraints/indexes, enum
values, sequences, sqlc-named queries, and explicit schema/query explanations.

## Architecture and conventions

Read `docs/prototype.md` and `.github/copilot-instructions.md` before changing
product behavior. Preserve explicit-request-only generation, bounded context
collection, per-repository/model consent, restrictive webviews, cancellation,
and cache freshness checks. Prefetch is an opt-in exception; opening an
unmapped project preview is an explicit mapping request.

Language support is modular. Each bundled language has a folder under
`src/languages/` exporting one `LanguageSupport` (`src/languages/support.ts`):
function discovery, file descriptions, dependency lookup, and optional
explanation guidance. Register new support in `src/languages/registry.ts`.
For a Tree-sitter grammar, also add its name to `esbuild.config.mjs`.
Other languages use `src/languages/editor/` and VS Code document symbols
and go-to-definition. Do not assume a language server is installed.

Native diff classification uses `LanguageSupport.comparisonFunctions`, sharing
the bundled languages' existing callable walks while adding completeness,
language-owned matching identities, exact ranges, and comment-insensitive
declaration fingerprints. `context/comparisonFunctions.ts` is language-neutral;
it never guesses names, containers, or renames. An incomplete side disables
categorical claims for both sides. The comparison record saves its own versioned
catalogue beside the validated summaries; never attach saved summaries to newly
discovered functions by array index.

Added/Removed card actions belong to `ChangeSession`, use explicit scheduler
priority, and cannot be reached from review/prefetch/render/cache misses.
Historical explanation keys are snapshot-only; their context contains function
source plus bounded same-snapshot preamble, not today's inventory or overview.
Working additions reuse canonical explanations without incidental file summaries.
`extension.ts` shares the ordinary ExplanationView builder and routes all item
navigation through the existing native diff, not `showTextDocument`.

`RepositoryCacheStore.update` accepts an optional asynchronous validation hook,
run after writing the temporary file and immediately before atomic rename.
Never read/update that store from its own validation hook (the repository write
lock is held). Recheck exact snapshot signatures, policy/model/trust and request
cancellation there. Rename is the commit point: test both pre-commit rejection
and post-commit successful cancellation with deterministic gates, not sleeps.
Comparison catalogue version 1 and prompt versions `downside-up-changes-6` /
`downside-up-plain-10` invalidate changed records without migrating them or
changing repository envelope schema 2/consent.

## Git graph integration contract

Verified against installed VS Code **1.143.0** (`extensions/git/package.json`,
`extensions/git/dist/main.js`, and workbench menu registry) and authoritative
upstream source:

- [`menusExtensionPoint.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/actions/common/menusExtensionPoint.ts):
  `scm/historyItem/context` is gated by the proposed
  `contribSourceControlHistoryItemMenu`. Stable extensions cannot use it merely
  by contributing a menu or raising their engine version. Do not add a
  nonfunctional contribution or enable proposed APIs for a release.
- [`scmHistoryViewPane.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/scm/browser/scmHistoryViewPane.ts):
  graph context actions forward the provider then the history item;
  extension-host SCM marshalling supplies `(SourceControl, HistoryItem)`.
  Only the provider's local `rootUri` and history item's immutable `id` are
  used. Parent IDs are independently read from Git. Single add/delete entries
  open the sole historical document, not a two-sided diff.
- [`historyProvider.ts`](https://github.com/microsoft/vscode/blob/main/extensions/git/src/historyProvider.ts)
  and [`uri.ts`](https://github.com/microsoft/vscode/blob/main/extensions/git/src/uri.ts):
  graph revisions are `git:` URIs with JSON `{ path, ref }`; renames use the
  old/new paths. Missing sides are absent URIs; a root has Git's empty tree as
  its base. Preparation shares these revision/path cache identities.

The release-facing fallback is **Downside Up: Prepare Commit Explanations…**
(`downsideUp.prepareCommit`), compatible with the existing ^1.90.0 engine.
Graph argument validation is retained for future public menu support, without
depending on proposed API types. The Review queue remains the only preparation
queue. `ChangeSession.comparisonSaved` refreshes a visible exact pair cache-only
after successful persistence; UI failure must not trigger a paid retry.
Unit tests gate in-flight completion/cancellation deterministically, and the
extension-host suite uses a disposable Git repository outside the development
worktree to verify graph-shaped URIs, historical documents and cache reuse.

## Copilot development agents

Repository-local profiles live in `.github/agents/`. These are development
assistants, not the extension's Functions or Project overview models. They do
not change runtime model settings, sharing consent, or global CLI preferences.

| Agent | Model | Role |
|---|---|---|
| `dsu-architect` | GPT-6 Astra | Read-only architecture and implementation plans |
| `dsu-reviewer` | Claude Opus 5.5 | Read-only correctness and regression review |
| `dsu-core` | GPT-6.1 Sol | Services, providers, schemas, cache, and request lifecycle |
| `dsu-preview` | GPT-6 Luna | Webviews, paired visuals, accessibility, and navigation |
| `dsu-languages` | GPT-6.1 Sol | LanguageSupport, bundled analysis, and fingerprints |
| `dsu-tests` | Claude Sonnet 5.5 | Regression tests and extension-host diagnosis |

In Copilot CLI, select a profile with `/agent`, name it in a task, or start
`copilot --agent=dsu-core`. Models are pinned in each profile.
Reasoning effort and context tier remain inherited: this CLI does not allow
per-subagent preferences in repository settings. `/subagents` can adjust those
preferences at the user level, but this setup does not change them.
Model availability still depends on the signed-in account and organization policy.

Use agents for substantial bounded work, not every lookup or small edit.
Give each implementation agent an explicit objective and file ownership;
parallelize only independent work. Do not run a fleet by default. The profiles
do not delegate further, and architecture/review roles do not edit. Shell access
for those two roles is limited by their instructions to read-only inspection,
not by an OS sandbox; normal CLI permission controls still apply.
Review the implementation with a different model family when warranted.

## Verification

| Command | Purpose |
|---|---|
| `npm run typecheck` | Check TypeScript |
| `npm test` | Typecheck and deterministic unit tests |
| `npm run test:extension` | Build and test in a real VS Code extension host |
| `cargo test --manifest-path fixtures/rust-app/Cargo.toml` | Check the Rust fixture |
| `go test ./...` from `fixtures/go-app` | Check the Go fixture |

Use the existing scripts and test setup. Run the extension-host suite for
VS Code integration changes. Documentation-only edits need no runtime tests.

## Packaging and releases

Never rebuild a VSIX under a version that was already packaged. For a new
installable build, first commit the changes it will ship, then increment the
version (patch for fixes, minor for features/settings):

```sh
npm version <x.y.z> --no-git-tag-version
```

Update the install command in `README.md` for the new version, then run:

```sh
npm run package
```

Review the package inventory: compiled code, webview assets, bundled grammar
WASM files, and the external `web-tree-sitter` runtime must be included.
Fixtures, tests, development files, and credentials must not be included.

Install the package with the command in the root `README.md`.

Commit the version bump separately as `Release <x.y.z>`, changing only
`package.json`, `package-lock.json`, and `README.md`.
Keep the changelog with the implementation changes.
Packaging does not publish anything to the Marketplace.
