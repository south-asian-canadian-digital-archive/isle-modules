<script>
  // Column mapping, add-as-you-need style. Columns named after a field are
  // matched automatically and only summarised; the identifier column has its
  // own picker; anything else is mapped by adding it explicitly.
  import { targetOptions, autoTarget, MATCH_KEY } from '../lib/compare.js';

  let { headers, rows, bundles, mapping = $bindable(), onchange } = $props();

  const groups = targetOptions(bundles).filter((g) => g.group !== 'Match rows on');
  const auto = Object.fromEntries(headers.map((h) => [h, autoTarget(h, bundles)]));

  // Initial state from the incoming mapping (suggestions + remembered choices).
  let idHeader = $state(headers.find((h) => mapping[h] === MATCH_KEY) ?? '');
  let custom = $state(headers
    .filter((h) => h !== idHeader && (mapping[h] ?? '') !== auto[h])
    .map((h) => ({ header: h, target: mapping[h] ?? '' })));
  let adding = $state('');

  // Recompose the full header → target mapping whenever anything changes.
  $effect(() => {
    const next = {};
    for (const h of headers) next[h] = auto[h] === MATCH_KEY ? '' : auto[h];
    for (const { header, target } of custom) next[header] = target === MATCH_KEY ? '' : target;
    if (idHeader) next[idHeader] = MATCH_KEY;
    mapping = next;
  });

  const autoMatched = $derived(headers.filter((h) => h !== idHeader && auto[h] && !custom.some((c) => c.header === h)));
  const ignored = $derived(headers.filter((h) => h !== idHeader && !custom.some((c) => c.header === h) && !auto[h]));
  const addable = $derived(headers.filter((h) => h !== idHeader && !custom.some((c) => c.header === h)));

  function sample(h) {
    for (const r of rows) {
      const v = String(r[h] ?? '').trim();
      if (v) return v.length > 48 ? `${v.slice(0, 48)}…` : v;
    }
    return '(empty)';
  }

  function add() {
    if (!adding) return;
    custom = [...custom, { header: adding, target: auto[adding] }];
    adding = '';
  }

  function setTarget(i, target) {
    custom[i].target = target;
    onchange?.(custom[i].header, target);
  }

  function remove(i) {
    onchange?.(custom[i].header, null);
    custom = custom.filter((_, j) => j !== i);
  }

  function setId(h) {
    idHeader = h;
    custom = custom.filter((c) => c.header !== h);
    onchange?.(h, MATCH_KEY);
  }
</script>

<div class="mapper">
  <div class="key" class:missing={!idHeader}>
    <label for="ia-id">Match rows on</label>
    <select id="ia-id" value={idHeader} onchange={(e) => setId(e.currentTarget.value)}>
      {#if !idHeader}<option value="">Choose the identifier column…</option>{/if}
      {#each headers as h}<option value={h}>{h}</option>{/each}
    </select>
    <span class="arrow" aria-hidden="true">→</span>
    <span class="target">Identifier <code>{MATCH_KEY}</code></span>
    {#if idHeader}<span class="muted ex">e.g. {sample(idHeader)}</span>{/if}
  </div>

  <h3>Mappings</h3>
  {#if custom.length}
    <ul class="list">
      {#each custom as m, i (m.header)}
        <li>
          <span class="col" title={sample(m.header)}>
            <code>{m.header}</code>
            <span class="muted ex">{sample(m.header)}</span>
          </span>
          <span class="arrow" aria-hidden="true">→</span>
          <select value={m.target} onchange={(e) => setTarget(i, e.currentTarget.value)} aria-label="Field for column {m.header}">
            <option value="">Don't compare</option>
            {#each groups as g}
              <optgroup label={g.group}>
                {#each g.options as o}<option value={o.value}>{o.label}</option>{/each}
              </optgroup>
            {/each}
          </select>
          <button class="remove" onclick={() => remove(i)} aria-label="Remove mapping for {m.header}" title="Remove">×</button>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="muted none">No custom mappings. Columns named after a field are compared automatically.</p>
  {/if}

  <div class="add">
    <select bind:value={adding} aria-label="Column to map">
      <option value="">Map another column…</option>
      {#each addable as h}<option value={h}>{h}{auto[h] ? ' (auto-matched)' : ''}</option>{/each}
    </select>
    <button class="btn secondary plus" onclick={add} disabled={!adding} aria-label="Add mapping">+ Add</button>
  </div>

  <div class="summary-chips">
    {#if autoMatched.length}
      <details>
        <summary><span class="pill ok">{autoMatched.length}</span> matched by name</summary>
        <div class="chips">{#each autoMatched as h}<code>{h}</code>{/each}</div>
      </details>
    {/if}
    {#if ignored.length}
      <details>
        <summary><span class="pill skip">{ignored.length}</span> not compared</summary>
        <div class="chips">{#each ignored as h}<code>{h}</code>{/each}</div>
      </details>
    {/if}
  </div>
</div>

<style>
  .mapper { display: flex; flex-direction: column; gap: 0.75rem; margin-bottom: 1rem; }
  .key {
    display: flex; flex-wrap: wrap; gap: 0.6rem; align-items: center;
    padding: 0.75rem 0.9rem; border-radius: 8px; background: var(--ia-ok-bg); border: 1px solid #b9e2c4;
  }
  .key.missing { background: var(--ia-error-bg); border-color: var(--ia-error-line); }
  .key label { font-weight: 600; }
  .target { font-weight: 600; }
  .arrow { color: var(--ia-muted); }
  .ex { font-size: 0.8rem; }
  h3 { margin: 0.25rem 0 0; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ia-muted); }
  .list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
  .list li {
    display: grid; grid-template-columns: minmax(10rem, 1fr) auto minmax(14rem, 1.4fr) auto; gap: 0.6rem; align-items: center;
    padding: 0.45rem 0.6rem; border: 1px solid var(--ia-border); border-radius: 8px; background: var(--ia-surface);
  }
  .col { display: flex; flex-direction: column; min-width: 0; }
  .col .ex { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .none { margin: 0; font-size: 0.85rem; }
  select { font: inherit; padding: 0.35em 0.5em; border: 1px solid var(--ia-border); border-radius: 6px; background: var(--ia-surface); min-width: 0; }
  .remove { font-size: 1.25rem; line-height: 1; width: 2rem; height: 2rem; border: 0; border-radius: 6px; background: none; color: var(--ia-muted); cursor: pointer; }
  .remove:hover { background: var(--ia-error-bg); color: var(--ia-error); }
  .add { display: flex; gap: 0.5rem; align-items: center; }
  .add select { min-width: 16rem; }
  .plus { padding: 0.35em 0.9em; }
  .summary-chips { display: flex; flex-wrap: wrap; gap: 0.5rem 1.5rem; font-size: 0.85rem; }
  details summary { cursor: pointer; color: var(--ia-muted); }
  .chips { display: flex; flex-wrap: wrap; gap: 0.3rem; margin-top: 0.4rem; max-width: 60rem; }
  .chips code { font-size: 0.75rem; }
  @media (max-width: 640px) { .list li { grid-template-columns: 1fr auto; } }
</style>
