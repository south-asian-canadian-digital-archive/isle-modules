<script>
  let { result, bundles, ondownload } = $props();
  const s = $derived(result.stats);
  const pct = (n) => `${(n * 100).toFixed(n === 1 || n === 0 ? 0 : 1)}%`;
  const share = (n) => (s.rows ? (n / s.rows) * 100 : 0);
</script>

<section class="card summary" aria-label="Audit summary">
  <div class="head">
    <h2>3. Results</h2>
    <span class="muted">{result.requests} JSON:API requests · {result.seconds.toFixed(1)}s{result.resolvedCount ? ` · ${result.resolvedCount} marked resolved` : ''}{result.problemCount ? ` · ${result.problemCount} marked as problems` : ''}</span>
    <button class="btn secondary" onclick={ondownload}>Download issues (CSV)</button>
  </div>

  <div class="tiles">
    <div class="tile hero">
      <span class="value">{pct(s.matchRate)}</span>
      <span class="label">of compared values match<br /><span class="muted">{s.cellsOk.toLocaleString()} / {s.cells.toLocaleString()} cells</span></span>
    </div>
    <div class="tile">
      <span class="value">{s.found}<span class="of">/{s.rows}</span></span>
      <span class="label">rows found in the repository</span>
      <span class="types">
        {#each Object.entries(s.byBundle) as [b, n]}<span>{n} {bundles[b]?.label ?? b}</span>{/each}
      </span>
    </div>
    <div class="tile" class:bad={s.notFound}>
      <span class="value">{s.notFound}</span>
      <span class="label">rows with no matching node</span>
    </div>
    {#if s.unchecked}
      <div class="tile warn">
        <span class="value">{s.unchecked}</span>
        <span class="label">rows not checked (lookup failed)</span>
      </div>
    {/if}
    <div class="tile" class:bad={s.duplicates}>
      <span class="value">{s.duplicates}</span>
      <span class="label">identifiers on more than one node</span>
    </div>
    <div class="tile" class:warn={s.extra}>
      <span class="value">{s.extra}</span>
      <span class="label">nodes in the repository, not in the file</span>
    </div>
  </div>

  <div class="bar" role="img" aria-label="{s.ok} rows match, {s.warn} rows with warnings, {s.error} rows with errors">
    <span class="ok" style:width="{share(s.ok)}%"></span>
    <span class="warn" style:width="{share(s.warn)}%"></span>
    <span class="error" style:width="{share(s.error)}%"></span>
  </div>
  <div class="legend">
    <span><i class="ok"></i>{s.ok} rows match</span>
    <span><i class="warn"></i>{s.warn} need a look (terms / dates)</span>
    <span><i class="error"></i>{s.error} with errors</span>
  </div>
</section>

<style>
  .head { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; align-items: baseline; }
  .head h2 { margin-right: auto; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 0.75rem; margin: 0.75rem 0 1rem; }
  .tile { border: 1px solid var(--ia-border); border-radius: 8px; padding: 0.75rem 0.9rem; display: flex; flex-direction: column; gap: 0.2rem; }
  .tile .value { font-size: 1.6rem; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.1; }
  .tile .of { font-size: 1rem; color: var(--ia-muted); font-weight: 500; }
  .tile .label { font-size: 0.8rem; color: var(--ia-muted); }
  .types { display: flex; flex-wrap: wrap; gap: 0.15rem 0.6rem; font-size: 0.75rem; color: var(--ia-muted); margin-top: 0.2rem; }
  .tile.hero { grid-column: span 2; flex-direction: row; align-items: center; gap: 0.9rem; background: var(--ia-subtle); }
  .tile.hero .value { font-size: 2.4rem; }
  .tile.bad { border-color: var(--ia-error-line); background: var(--ia-error-bg); }
  .tile.bad .value { color: var(--ia-error); }
  .tile.warn { border-color: var(--ia-warn-line); background: var(--ia-warn-bg); }
  .tile.warn .value { color: var(--ia-warn); }
  .bar { display: flex; height: 10px; border-radius: 999px; overflow: hidden; background: var(--ia-subtle); }
  .bar span { display: block; height: 100%; }
  .ok { background: #3fa35b; }
  .warn { background: #e0a91b; }
  .error { background: #d64550; }
  .legend { display: flex; flex-wrap: wrap; gap: 1.25rem; margin-top: 0.5rem; font-size: 0.85rem; color: var(--ia-muted); }
  .legend i { display: inline-block; width: 0.7em; height: 0.7em; border-radius: 2px; margin-right: 0.4em; }
  @media (max-width: 640px) { .tile.hero { grid-column: auto; } }
</style>
