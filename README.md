# The Downside Up

The Downside Up is a prototype VS Code extension that shows a document-style
Downside Up preview beside your source, like the Markdown preview. It describes
each import, function, type, and variable in plain language at the same
position as in the file, and adds an AI explanation under a function when you
ask for one. Descriptions are built locally; explanations are generated only
when requested, and mock mode is the default and makes no external requests.

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

- **Document preview.** The preview reads like rendered documentation: each
  import, module, function, type, constant, local variable, and standalone
  comment gets a plain-language sentence in source order, with doc comments
  and attributes alongside. Nothing is regrouped. These descriptions are built
  locally from the code and are not AI-generated. The preview follows the
  active editor and updates as you edit.
- **Scroll sync.** Scrolling the editor scrolls the preview to the matching
  position and vice versa, and the item at the cursor is highlighted.
  Double-click an item to jump to its source.
- **AI explanations.** Each function has a collapsed **AI explanation** section.
  Open it (or click the function's name) to show its saved explanation, or to
  generate one if none is current; a spinner shows while it loads, and the
  chevron collapses it again. Several can be open at once; generations run one
  at a time. Each explanation links to the related code the extension found.
  For Rust and Go, the explanation also uses the types, functions, and methods
  the function uses, including from other files and packages, and is marked
  outdated when any of them change. Rust and Go files are described, and their
  functions found, with bundled parsers, so no language server is needed.
  Functions with a current saved explanation are marked **ready** whenever the
  preview shows their file, including after reopening the preview or
  restarting VS Code; this is a local cache check only.
  Selecting text inside a function
  in the editor opens its section only when a saved explanation exists.
  Selecting never starts generation by itself.

**Downside Up: Explain Function** explains the function at the cursor from the
command palette. The repository context used for explanations is shown at the
end of the preview. The development fixtures are in `fixtures/rust-app`,
`fixtures/go-app`, and `fixtures/js-app`.

To install a locally packaged VSIX, run
`code --install-extension the-downside-up-0.4.1.vsix`.

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

## Development

`npm run typecheck` checks TypeScript, `npm test` runs deterministic unit tests,
`npm run test:extension` exercises the Rust, Go, and JavaScript flows in a real
VS Code host, `cargo test --manifest-path fixtures/rust-app/Cargo.toml` checks
the Rust fixture, and `go test ./...` in `fixtures/go-app` checks the Go
fixture. `npm run package` builds a VSIX including the required
production Tree-sitter runtime.
