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
