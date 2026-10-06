<script>
  import { targetOptions, MATCH_KEY } from '../lib/compare.js';

  let { headers, rows, bundles, mapping = $bindable(), onchange } = $props();

  const groups = $derived(targetOptions(bundles));
  let open = $state(true);

  function sample(h) {
    for (const r of rows) {
      const v = String(r[h] ?? '').trim();
      if (v) return v.length > 60 ? `${v.slice(0, 60)}…` : v;
    }
    return '';
  }

  function set(header, target) {
    const next = { ...mapping, [header]: target };
    // Only one column can be the match key.
    if (target === MATCH_KEY) for (const h of headers) if (h !== header && next[h] === MATCH_KEY) next[h] = '';
    mapping = next;
    onchange?.(header, target);
  }

  const mapped = $derived(headers.filter((h) => mapping[h]).length);
  const keyColumn = $derived(headers.find((h) => mapping[h] === MATCH_KEY));
</script>

<details class="mapper" bind:open>
  <summary>
    <strong>Column mapping</strong>
    <span class="muted">{mapped} of {headers.length} columns mapped</span>
    {#if keyColumn}
      <span class="pill ok">matching on “{keyColumn}”</span>
    {:else}
      <span class="pill error">choose the identifier column</span>
    {/if}
  </summary>
  <p class="muted hint">
    Each column is compared with the field it is mapped to. Columns already named after a field are mapped
    automatically; point others at the right field, or leave them as <em>Don't compare</em>. Your choices are
    remembered for columns with the same name.
  </p>
  <div class="grid" role="table" aria-label="Column mapping">
    <div class="row head" role="row">
      <span role="columnheader">Column in file</span>
      <span role="columnheader">Example value</span>
      <span role="columnheader">Compare with</span>
    </div>
    {#each headers as h (h)}
      <div class="row" role="row" class:key={mapping[h] === MATCH_KEY} class:off={!mapping[h]}>
        <code role="cell">{h}</code>
        <span role="cell" class="sample muted" title={sample(h)}>{sample(h)}</span>
        <span role="cell">
          <select value={mapping[h] ?? ''} onchange={(e) => set(h, e.currentTarget.value)} aria-label="Compare column {h} with">
            <option value="">Don't compare</option>
            {#each groups as g}
              <optgroup label={g.group}>
                {#each g.options as o}<option value={o.value}>{o.label}</option>{/each}
              </optgroup>
            {/each}
          </select>
        </span>
      </div>
    {/each}
  </div>
</details>

<style>
  .mapper { border: 1px solid var(--ia-border); border-radius: 8px; padding: 0.6rem 0.9rem; margin-bottom: 1rem; }
  summary { cursor: pointer; display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; }
  .hint { font-size: 0.85rem; margin: 0.6rem 0; max-width: 75ch; }
  .grid { max-height: 22rem; overflow: auto; border-top: 1px solid var(--ia-border); }
  .row { display: grid; grid-template-columns: minmax(10rem, 1fr) minmax(8rem, 1.2fr) minmax(14rem, 1.4fr); gap: 0.75rem; align-items: center; padding: 0.3rem 0.25rem; border-bottom: 1px solid #f0f0f2; }
  .row.head { position: sticky; top: 0; background: var(--ia-surface); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ia-muted); z-index: 1; }
  .row.key { background: var(--ia-ok-bg); }
  .row.off code { color: var(--ia-skip); }
  code { word-break: break-all; }
  .sample { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.85rem; }
  select { font: inherit; width: 100%; padding: 0.25em 0.4em; border: 1px solid var(--ia-border); border-radius: 4px; }
</style>
