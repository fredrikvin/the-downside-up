# Changelog

## 0.36.0

- Add bundled Python function discovery and local file outlines without Pylance:
  functions, async functions, class methods, properties, nested functions,
  docstrings, imports, and values.
- Statically resolve Python helpers, repository imports, and same-class
  `self`/`cls` methods for explanation context, freshness, hovers, and prefetch.
  Syntax-aware fingerprints tolerate formatting while preserving indentation
  structure, literals, and comments.
- Add Python import diagrams and conservative module-level direct caller lookup,
  using the same bounded, exclusion-aware scan as Go/Rust. Dynamic dispatch,
  inheritance, star imports, and re-exports are not resolved.

## 0.35.1

- Make function names navigate to their source instead of requesting an
  explanation. Explain and Show callers remain separate actions.

## 0.35.0

- Add conservative bundled Go/Rust caller lookup when native incoming Call
  Hierarchy is unavailable. Bounded, cancellable scans find direct free-function
  calls without a language server or AI requests and disclose incomplete coverage.
- Replace the Show callers text button with a compact accessible icon beside
  each function name.

## 0.34.0

- Add Show callers to function headings for steps, pseudocode, and flowcharts,
  using native incoming Call Hierarchy when supported by a language extension.
- Navigate to eligible repository callers with normal cache and opt-in prefetch
  behavior; caller lookup itself does not generate explanations.

## 0.33.1

- Simplify the Marketplace README around installation, everyday usage, privacy,
  and limitations. Move detailed configuration and contributor instructions
  into separate guides included in the extension package.

## 0.33.0

- Offer a repository-wide Initialize project button when context is missing,
  including after Clear, without requiring navigation or a restart.
- Integrate architecture maps into the opening description, removing the
  redundant Map heading and explanatory paragraph; retain a provenance tooltip.

## 0.32.0

- Move refresh into the page heading, separate from repository-wide controls.
- Refresh only checked outdated items on the displayed page; separate project
  actions map a missing project or update a map made with different model/settings.
- Show known outdated state with an amber divider and contextual text, while
  active requests retain the animated blue divider.
- Remove persistent successful-refresh messages.

## 0.31.0

- Replace expanded cache statistics with a tokens-in-current-cache disclosure,
  including input/output totals and overview/functions breakdowns per model.
- Record usage alongside saved results; replaced records no longer contribute.
  Counts are recorded tokens, not lifetime usage or billing.
- Shorten project refresh confirmation and hide zero outdated counts.
- Bump the local cache schema for usage metadata; Clear is required for older caches.

## 0.30.2

- Animate the existing header divider during requests instead of a separate bar.
- Shorten toolbar labels to **Refresh** and **Clear**, retaining descriptive tooltips.
- Disable Clear while requests are active; Cancel remains available.

## 0.30.1

- Allow VS Code language-model requests up to ten minutes instead of 90 seconds,
  while preserving manual cancellation and no automatic retries.
- Show a sticky animated activity strip, current stage, and elapsed time during
  active requests. Replace the misleading one-to-two-minute mapping message.

## 0.30.0

- Enable pseudocode and flowchart views by default for new explanations.
  Existing saved explanations still require **Generate** for missing views.
- Background prefetching remains opt-in and requires existing sharing consent.
- Offer to enable prefetch once when the preview is first opened, with
  quota/billing and sharing-approval information. Existing user choices are respected.

## 0.29.4

Initial public release of **Downside Up**, published by **FredrikVinkvist**.

- Read plain-language function explanations beside the source, with linked
  steps, optional pseudocode and flowcharts, and synchronized navigation.
- Explore project architecture, folder summaries, and main flows.
- Review a confirmed set of changed functions against a branch or commit.
- Reuse locally cached explanations and summaries, with source freshness checks.
- Choose VS Code language models or OpenAI, or use the local mock provider.
- Control code sharing with per-repository and per-model consent, content
  exclusions, and optional background prefetching.
- Discover Rust, Go, JavaScript, and TypeScript functions with bundled parsers;
  use editor language tools for other languages.
- Configure content-exclusion policy files through a step-by-step setup panel.
- Licensed under the MIT License.

Earlier versions were local development builds.
