# Changelog

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
