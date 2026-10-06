<script>
  import SourcePicker from './components/SourcePicker.svelte';
  import Summary from './components/Summary.svelte';
  import ResultsTable from './components/ResultsTable.svelte';
  import ExtraNodes from './components/ExtraNodes.svelte';
  import { runAudit, issuesCsv } from './lib/audit.js';

  let { settings } = $props();

  // Raw state: large plain data, replaced wholesale, never mutated in place.
  let source = $state.raw(null); // { name, sheetNames, table() }
  let sheet = $state('');
  let table = $state.raw(null);
  let loadError = $state('');

  let idColumn = $state('field_identifier');
  let delimiter = $state('|');
  let strict = $state(false);
  let scanExtra = $state(true);

  let running = $state(false);
  let progress = $state({ stage: '', requests: 0 });
  let runError = $state('');
  let result = $state.raw(null);

  function loaded(workbook) {
    source = workbook;
    result = null;
    selectSheet(workbook.sheetNames[0]);
  }

  function selectSheet(name) {
    sheet = name;
    loadError = '';
    table = null;
    try {
      table = source.table(name);
      if (!table.headers.includes(idColumn)) {
        idColumn = table.headers.includes('field_identifier') ? 'field_identifier'
          : table.headers.includes('id') ? 'id' : table.headers[0];
      }
    }
    catch (e) {
      loadError = e.message;
    }
  }

  async function run() {
    running = true;
    runError = '';
    result = null;
    try {
      result = await runAudit(table, settings, { idColumn, delimiter: delimiter || '|', strict, scanExtra },
        (p) => { progress = p; });
    }
    catch (e) {
      runError = e.message;
    }
    finally {
      running = false;
    }
  }

  function download() {
    const blob = new Blob([issuesCsv(result)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ingest-audit-${(source?.name ?? 'sheet').replace(/\.[^.]+$/, '')}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
</script>

<div class="ia">
  <p class="intro muted">
    Upload the metadata spreadsheet a collection was ingested from. Each row is matched to a node by its
    identifier, then every column is checked against what the repository holds, including the parent it hangs from
    and its original file. Nothing is changed in the repository.
  </p>

  <section class="card">
    <h2>1. Spreadsheet</h2>
    <SourcePicker sheetEndpoint={settings.sheetEndpoint} onloaded={loaded} />

    {#if source}
      <div class="loaded">
        <strong>{source.name}</strong>
        {#if source.sheetNames.length > 1}
          <label>
            Sheet
            <select value={sheet} onchange={(e) => selectSheet(e.currentTarget.value)}>
              {#each source.sheetNames as name}<option value={name}>{name}</option>{/each}
            </select>
          </label>
        {/if}
        {#if table}
          <span class="muted">{table.rows.length} rows · {table.headers.length} columns</span>
        {/if}
      </div>
    {/if}
    {#if loadError}<p class="error" role="alert">{loadError}</p>{/if}
  </section>

  {#if table}
    <section class="card">
      <h2>2. Compare</h2>
      <div class="options">
        <label>
          Match rows on
          <select bind:value={idColumn}>
            {#each table.headers as h}<option value={h}>{h}</option>{/each}
          </select>
        </label>
        <label>
          Multi-value separator
          <input class="narrow" bind:value={delimiter} maxlength="3" />
        </label>
        <label class="check">
          <input type="checkbox" bind:checked={scanExtra} />
          Also list nodes in the repository that the file does not mention
        </label>
        <label class="check">
          <input type="checkbox" bind:checked={strict} />
          Strict: treat term and date differences as errors
        </label>
      </div>
      <div class="actions">
        <button class="btn" onclick={run} disabled={running}>{running ? 'Auditing…' : 'Run audit'}</button>
        {#if running}
          <span class="muted" aria-live="polite">{progress.stage}… {progress.requests} requests</span>
        {/if}
      </div>
      {#if runError}<p class="error" role="alert">{runError}</p>{/if}
    </section>
  {/if}

  {#if result}
    <Summary {result} ondownload={download} />
    <ResultsTable {result} nodeBase={settings.nodeBase} />
    {#if scanExtra}<ExtraNodes extra={result.extra} truncated={result.truncated} nodeBase={settings.nodeBase} />{/if}
  {/if}
</div>

<style>
  .intro { max-width: 70ch; margin: 0 0 1rem; }
  .loaded { display: flex; flex-wrap: wrap; gap: 1rem; align-items: center; margin-top: 0.75rem; }
  .options { display: flex; flex-wrap: wrap; gap: 0.75rem 1.5rem; align-items: center; }
  .options label { display: inline-flex; gap: 0.5rem; align-items: center; }
  .options select, .options input:not([type]) { font: inherit; padding: 0.3em 0.5em; border: 1px solid var(--ia-border); border-radius: 4px; }
  .narrow { width: 3.5em; text-align: center; }
  .actions { display: flex; gap: 1rem; align-items: center; margin-top: 1rem; }
  .error { color: var(--ia-error); background: var(--ia-error-bg); padding: 0.5rem 0.75rem; border-radius: 6px; margin: 0.75rem 0 0; }
</style>
