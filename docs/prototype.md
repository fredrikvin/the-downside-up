# Prototype scope and decisions

## Product scope

The Downside Up helps programmers understand functions in unfamiliar languages.
The side-by-side Downside Up preview reads like rendered Markdown. For the
active file it describes every import, module, function/method, type,
constant/static, local variable binding, and standalone comment in plain
language, in source order and without regrouping, with attached doc comments
and attributes. These descriptions are deterministic and local (Tree-sitter for
Rust and Go; VS Code document symbols plus line-based import and comment
detection for other languages) and are labelled as not AI-generated. Go
descriptions also explain Go-specific meaning, such as exported names,
pointer and value receivers, multiple and named results, `iota` groups,
distinct defined types, embedding, and `main`, `init`, test, and `//go:`
directive roles; if the bundled Go parser is unavailable, editor symbols are
used instead. The preview follows
the active editor and rebuilds after edits (debounced) without losing its
place. Scrolling either side keeps the other aligned by interpolating between
item anchors, as the Markdown preview does; each side ignores the scrolling it
caused, so the two do not feed back. The item at the cursor is highlighted, and
double-clicking an item reveals its source.

Every function has a collapsed **AI explanation** section. Opening it, or
clicking the function name, is an explicit request: the extension first looks
for a current saved explanation (local only) and generates one only when none
exists and the section is still open. Loading shows a spinner and can be
cancelled. Several sections can be open; provider work runs one request at a
time, so concurrent requests cannot each prime repository context or prompt for
consent. When the preview shows a file, it checks the local cache once for that
file's functions and labels those with a current saved explanation as ready,
so saved explanations remain visible after the preview is closed and reopened
or VS Code restarts; misses stay collapsed and unlabelled. Repository and
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
nearby functions. For Rust and Go, `downsideUp.prefetch.dependencies`
(default 3, `0` for none) adds the functions and methods in other files that
the function nearest the reader calls: among its first that many calls in
order of use, the ones without an explanation are fetched right after that
function and before the rest of the window. Calls that already have an
explanation count toward the number, so at most that many are considered per
function read. Prefetching starts after saved explanations are marked
ready, runs one request at a time after any explicit request, keeps sections
collapsed, and does not regenerate outdated, failed, or cancelled
explanations or functions added by later edits. Switching files drops
prefetches that have not been sent; one already sent finishes and is saved.
Closing the preview, Cancel, Clear Repository Cache, or turning the setting
off stops it, and a failed request stops it with a notice. It runs only in a
trusted workspace and only after code sharing was approved for the repository
and model by an explicit explanation; it never asks for approval itself and
shows a notice when it is waiting for one. Prefetching uses the provider's
usage limits or billing for every function it explains.

Hovering a call to a Rust or Go function inside another function shows the
purpose from that function's current saved explanation, found with the same
local dependency resolution as explanation context. The hover reads only the
local cache (after the usual freshness check), never generates, renders
generated text as plain text, and can be turned off with
`downsideUp.hover.savedExplanations`. Like the rest of the extension it is
available once a Downside Up command has activated it.

The core is language-neutral. Rust and Go function discovery and source
fingerprinting use bundled Tree-sitter WASM grammars, so neither needs a
language server; Go methods are identified by receiver type (for example
`Catalog.Add`). Other languages use VS Code document-symbol providers; the
fixtures exercise Rust, Go, and JavaScript. Arbitrary blocks,
automated edits, a full repository browser, vector stores, cloud state,
collaboration, and marketplace publishing are out of scope.

## Repository context and grounding

Before the first explanation, the extension gathers bounded local evidence:
project manifests, README and architecture-style documents, selected source
files, and a small symbol outline. Rust and Go symbols use Tree-sitter; other
symbols use VS Code providers where available. Function context adds related types,
imports, directly related helpers, and references where tooling can resolve
them. For Rust, it also adds the items the function uses directly from other
files of the crate (depth 1): types, functions, constants, and methods of used
types, found by following `use` declarations and paths (`crate::`, `self::`,
`super::`, child modules, `mod.rs`, glob imports, and the package's own name
from `tests/`, `examples/`, or `bin/` files) with Tree-sitter and Cargo's
file layout. Items are sent whole up to 4 KiB each and 16 KiB in total; a
larger item is sent as its signature only, and items beyond the budget are
omitted with a stated limitation. External crates and the standard library are
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

The scanner honors `.gitignore`, `.copilotignore`, and VS Code file/search
exclusions. It avoids symlinks, hidden trees, common generated/dependency/vendor
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
provider or model requires renewed consent. External sharing is disabled in
untrusted workspaces. For OpenAI, `store:false` is not a guarantee of zero
provider-side retention; review the provider's current data controls before use.
GitHub Copilot content exclusion configured by administrators on GitHub is
not applied to this extension's requests, even with Copilot models: GitHub
enforces it in Copilot's own features, and requests through the VS Code
Language Model API carry plain text without file identity. Organizations
that rely on it should mirror the excluded paths into `.copilotignore`.
For VS Code language models, data handling follows the model provider's terms
(for Copilot, the user's or organization's Copilot plan and policies). No
provider request occurs without the user requesting an explanation or
repository-context refresh, or turning on prefetching in user settings.

## Cache and freshness

Overview and explanation records are stored in VS Code global storage, outside
the target repository. The cache includes prompt/schema/model settings and
fingerprints of the relevant source and context. Function identity does not
depend on line numbers or navigation history. Rust methods are identified by
their `impl` type and trait (for example `Catalog::add` or
`<StoreError as Display>::fmt`), so same-named methods in different `impl`
blocks have separate explanations; explanations of Rust methods saved by
versions before 0.4.0 are therefore not reused. Rust structural fingerprints
preserve meaningful tokens and literals; languages using VS Code symbols use
conservative source matching and may invalidate on formatting changes.

Unchanged explanations are reused across extension restarts without a provider
call. The snapshot checked at priming is separate from the overview content
version: an unchanged overview can be revalidated without invalidating dependent
explanations. Changes to tracked function/context inputs, any file whose
content was sent for priming, manifests, entry points, additions/deletions, or
Git branch/revision trigger stale detection or bounded context review. A
review that leaves the overview text unchanged keeps dependent explanations
current. Unrelated edits do not by
themselves discard a valid explanation. Unsaved buffers participate in
freshness checks, and results are not saved as current if source changes during
generation.

Each explanation records what it was built from, so tracking matches what the
model saw. Every tracked input notes its depth (0 for the function itself, 1
for items it uses directly) and whether it covers the whole item or only its
signature. A Rust or Go function's explanation becomes outdated when its own
source, its file's imports, or any directly used item changes, including items
in other files. Changes only to items that those items use (depth 2), or to other items
in the same files, do not by themselves make it outdated; a change to a file
sent for priming still enters the overview review described above. For an item
tracked by signature only, body edits keep the explanation current.
Formatting-only edits do not change Rust or Go
structural fingerprints, attributes such as `#[derive(...)]` count as part of a
Rust type, and each Go constant tracks its whole `const` group because `iota`
and implicit repetition depend on it. Saved explanations of Rust functions that
use items from other files, and of all Go functions, are shown as outdated once
after upgrading, because they were made without that context. `go.mod` is now
part of the repository inventory, so a Go repository's overview is reviewed
once as well.

Invalidation never regenerates automatically. Use **Downside Up: Explain
Function** or the preview's **Regenerate** link to regenerate. **Refresh Repository
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
Side**, then click a function in the preview (or put the cursor inside a
function and run **Downside Up: Explain Function**). For live generation, either run **Downside
Up: Choose Language Model** to use GitHub Copilot or another VS Code
language model, or configure `downsideUp.provider` as `openai` and store an
API key using **Downside Up: Set OpenAI API Key**. Then explicitly accept the
per-repository sharing prompt.

The deterministic unit suite covers cache reuse across restart, batched
saved-explanation lookup, prefetch ordering and windows, called-function
lists for hovers and prefetching, Rust and Go dependency resolution and their
depth-1 freshness and signature-only budget, Go method naming, source and
context invalidation, unrelated edits, overview content-version preservation,
branch changes, in-flight edits, cancellation, clear-cache fencing, provider
failures, VS Code language-model prompt/validation/error/cancellation handling,
ignored files, per-file sharing exclusion reasons and refusal before any
provider request, unsaved buffers, and parser fingerprints. Extension
host tests exercise Rust, Go, and JavaScript discovery (Go without a language
server), distinct identities for
same-named Rust methods in different `impl` blocks, document-ordered outlines,
explanation commands, preview creation, selection changes during an in-flight
request, saved explanations listed as ready after closing and reopening the
preview, prefetching that starts at the cursor, stays within its window, and
follows the cursor, prefetching of a called function in another package,
saved-explanation hovers that appear only when an explanation is saved and
never generate, refusal to explain a function in a `.copilotignore`d file, and
unsupported plaintext discovery. Each run uses a fresh temporary
VS Code profile so earlier runs' windows are not restored.
Local description tests cover Rust items (imports, modules, functions and
methods with receivers, structs, enums, traits, impls, constants, statics,
aliases, macros, locals, doc comments, attributes, and standalone comments),
Go declarations (package, imports, functions and methods with receivers,
structs with embedding, interfaces and constraints, defined types, aliases,
grouped constants with `iota`, variables, locals, doc comments, directives,
and standalone comments), symbol-based descriptions and import detection for other languages, scroll
anchor interpolation in both directions, prompts that ask for plain-prose
references rather than identifiers, and the
webview's content-security policy.

## Limitations and verification status

- GitHub Copilot's server-side content exclusion is not visible to the
  extension and is not applied to its requests; only `.gitignore`,
  `.copilotignore`, VS Code exclusions, and the built-in path rules are.
- Rust macros, procedural macros, and conditional compilation may hide or alter
  syntax and relationships. Tree-sitter is not a Rust compiler.
- Cross-file Rust tracking stops at depth 1 and resolves names without type
  inference. A method call such as `value.find(...)` is matched by name against
  methods of the types the function uses, so it may track an extra same-named
  method or miss one whose type is never named. It follows Cargo's default
  file layout only (no `#[path]` attributes or `include!`), does not follow
  other crates in a Cargo workspace, finds `impl` blocks only in the file that
  defines the type, and skips module files outside the inventory's read budget
  (stated as a limitation).
- Go tracking also stops at depth 1 and matches method calls by name against
  methods of the types the function names or receives from calls, so it may
  track an extra same-named method or miss one reached only through an
  interface, embedding, or a variable of an unnamed type. Build tags and
  `//go:build` constraints are ignored, packages are followed only within the
  file's own module (not `go.work` workspaces, `replace` targets, or
  `vendor/`), and package files outside the inventory's read budget are
  skipped with a stated limitation.
- Callers, and items used by functions in languages other than Rust and Go,
  are tracked only when VS Code tooling reports them.
- Other language support depends on installed VS Code document-symbol
  providers. There is no whole-program analyzer or guaranteed call graph;
  unresolved references and unavailable tooling are surfaced as limitations.
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
  imports, and comments, not behavior. Languages other than Rust and Go depend
  on the installed symbol provider's detail; import detection covers JavaScript/
  TypeScript, Python, Go, Java/Kotlin/Scala/Groovy, C#, C/C++, PHP, Ruby, and
  Swift.
- Two moderate npm audit findings affect the development-only Vitest toolchain;
  production dependency audit reports no advisories. The findings are recorded
  here rather than changing the test runner's major version as an unrelated
  compatibility change.
