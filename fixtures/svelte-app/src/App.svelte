<script lang="ts">
  import Card from "../components/Card.svelte";
  import { savedCount } from "$lib/state.svelte";

  let count = $state(0);
  let doubled = $derived(count * 2);

  function increment() {
    count += 1;
  }
</script>

<svelte:head>
  <title>Counter</title>
</svelte:head>

<Card value={count} />
<button onclick={increment}>{doubled}</button>

<style>
  button { color: red; }
</style>
