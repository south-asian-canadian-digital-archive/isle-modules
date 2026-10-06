<script>
  import { ACCEPT, fetchGoogleSheet } from '../lib/source.js';
  import { parse } from '../lib/worker.js';

  let { sheetEndpoint, onloaded } = $props();

  let mode = $state('file');
  let url = $state('');
  let busy = $state(false);
  let error = $state('');
  let dragging = $state(false);
  let input = $state();

  async function load(fn) {
    busy = true;
    error = '';
    try {
      onloaded(await fn());
    }
    catch (e) {
      error = e.message || String(e);
    }
    finally {
      busy = false;
    }
  }

  function pick(files) {
    const file = files?.[0];
    if (file) load(() => parse(file.name, file));
  }

  function drop(e) {
    e.preventDefault();
    dragging = false;
    pick(e.dataTransfer?.files);
  }
</script>

<div class="source-tabs" role="tablist">
  <button role="tab" aria-selected={mode === 'file'} class:active={mode === 'file'} onclick={() => (mode = 'file')}>Upload a file</button>
  <button role="tab" aria-selected={mode === 'gsheet'} class:active={mode === 'gsheet'} onclick={() => (mode = 'gsheet')}>Google Sheets link</button>
</div>

{#if mode === 'file'}
  <button
    type="button"
    class="drop"
    class:dragging
    disabled={busy}
    onclick={() => input.click()}
    ondragover={(e) => { e.preventDefault(); dragging = true; }}
    ondragleave={() => (dragging = false)}
    ondrop={drop}
  >
    <strong>{busy ? 'Reading…' : 'Drop a spreadsheet here, or click to choose'}</strong>
    <span class="muted">CSV, TSV, Excel (.xlsx, .xls) or OpenDocument (.ods), e.g. the Workbench input CSV</span>
  </button>
  <input bind:this={input} type="file" accept={ACCEPT} hidden onchange={(e) => pick(e.currentTarget.files)} />
{:else}
  <form class="gsheet" onsubmit={(e) => { e.preventDefault(); if (url.trim()) load(async () => parse('Google Sheet', await fetchGoogleSheet(url.trim(), sheetEndpoint))); }}>
    <input type="url" bind:value={url} placeholder="https://docs.google.com/spreadsheets/d/…/edit#gid=0" required />
    <button class="btn" disabled={busy}>{busy ? 'Fetching…' : 'Load sheet'}</button>
  </form>
  <p class="muted hint">
    The sheet must be shared as <em>Anyone with the link can view</em>. The tab in the link (<code>gid</code>) is
    the one that gets read.
  </p>
{/if}

{#if error}<p class="error" role="alert">{error}</p>{/if}

<style>
  .source-tabs { display: flex; gap: 0.25rem; margin-bottom: 0.75rem; border-bottom: 1px solid var(--ia-border); }
  .source-tabs button {
    font: inherit; background: none; border: 0; padding: 0.5em 0.9em; cursor: pointer;
    color: var(--ia-muted); border-bottom: 3px solid transparent; margin-bottom: -1px;
  }
  .source-tabs button.active { color: var(--ia-accent); border-bottom-color: var(--ia-accent); font-weight: 600; }
  .drop {
    font: inherit; width: 100%; display: flex; flex-direction: column; gap: 0.35rem; align-items: center;
    padding: 1.75rem 1rem; border: 2px dashed var(--ia-border); border-radius: 8px;
    background: var(--ia-subtle); cursor: pointer; color: inherit;
  }
  .drop:hover, .drop.dragging { border-color: var(--ia-accent); background: #eef3ff; }
  .gsheet { display: flex; gap: 0.5rem; }
  .gsheet input { flex: 1; font: inherit; padding: 0.45em 0.6em; border: 1px solid var(--ia-border); border-radius: 6px; min-width: 0; }
  .hint { margin: 0.5rem 0 0; font-size: 0.85rem; }
  .error { color: var(--ia-error); background: var(--ia-error-bg); padding: 0.5rem 0.75rem; border-radius: 6px; margin: 0.75rem 0 0; }
</style>
