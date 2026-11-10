import type { GuidanceRequest } from "../support";
import { componentName, functionEntries, withSvelteSyntaxTree } from "./syntax";
import { scanSvelte } from "./blocks";

export const SVELTE_COMPONENT_GUIDANCE = [
  "This is a Svelte component. Explain how its script and markup work together to show the component.",
  "Treat values from $props() in Svelte 5, or export let in legacy Svelte, as inputs; $bindable allows a prop to be bound by the parent.",
  "$state marks reactive state, and $derived computes a value from other values. In legacy syntax, assignments to $: declarations are recomputed when their dependencies change; other $: statements run again when referenced values change.",
  "$effect runs after updates when its dependencies change; distinguish this later work from setup. A $store reference reads a store's current value and subscribes the component to updates.",
  "Describe {#if}, {#each}, and {#await} branches as what appears, including their else, empty, pending, then, and catch cases when present. Snippets and legacy slots define reusable or supplied markup; {@render} displays a snippet.",
  "A capitalized component tag shows a child component and passes attributes as props. bind: creates a two-way binding. Treat {@html} as raw HTML output and note its security significance only when relevant to the code.",
  "Event handlers such as onclick or on:click run later in response to interaction, not while the component is rendered. Use phases for setup, reactive updates, and interaction.",
  "In pseudocode, put later event or effect work under the phase when it runs. In a flowchart, use show nodes for markup, with conditions and each/await branches inside the relevant show node; represent event handlers as later actions."
].join(" ");

export const SVELTE_NESTED_GUIDANCE = [
  "This function is defined in a Svelte component script. Explain when it runs: during setup, from a reactive effect, or later from an event handler.",
  "It can read component props, state, derived values, and stores. Explain which values it reads or changes and how those changes affect the markup.",
  "Event handlers run later when the corresponding interaction happens, not while the component is rendered."
].join(" ");

export const SVELTE_RUNE_MODULE_GUIDANCE =
  "This is a Svelte rune module (.svelte.js or .svelte.ts). $state creates shared reactive state, $derived computes from reactive values, and $effect runs work when its dependencies change. Explain which exported values are shared and how updates propagate; do not describe the module as a rendered component.";

export async function svelteGuidance(request: GuidanceRequest): Promise<string | undefined> {
  const scan = scanSvelte(request.text);
  if (!scan.supported) return undefined;
  return withSvelteSyntaxTree(request.text, request.path, (root) => {
    const component = componentName(request.path);
    if (request.qualifiedName === component) return SVELTE_COMPONENT_GUIDANCE;
    const entry = functionEntries(request.text, request.path, root)
      .find((candidate) => candidate.qualifiedName === request.qualifiedName);
    if (!entry) return undefined;
    if (entry.module) return SVELTE_RUNE_MODULE_GUIDANCE;
    return SVELTE_NESTED_GUIDANCE;
  });
}
