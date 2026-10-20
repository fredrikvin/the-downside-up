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
