<script>
  import { tick } from 'svelte';
  import SourcePicker from './components/SourcePicker.svelte';
  import ColumnMapper from './components/ColumnMapper.svelte';
  import Summary from './components/Summary.svelte';
  import ResultsTable from './components/ResultsTable.svelte';
  import ExtraNodes from './components/ExtraNodes.svelte';
  import { issuesCsv } from './lib/audit.js';
  import { suggestMapping, MATCH_KEY } from './lib/compare.js';
  import { audit } from './lib/worker.js';
  import { buildTable, guessHeaderRow } from './lib/table.js';
  import { load as loadMarks, save as saveMarks, cellKey, rowKey, valueKey, colSpec, groupSizes, applyResolved } from './lib/resolved.js';

  let { settings } = $props();

  const REMEMBER = 'sacdaIngestAudit.mapping';

  // "Back to upload": shown once the spreadsheet card has scrolled out of view.
  let uploadCard = $state();
  let uploadVisible = $state(true);
  $effect(() => {
    if (!uploadCard) return;
    const io = new IntersectionObserver(([e]) => { uploadVisible = e.isIntersecting; }, { rootMargin: '-80px 0px 0px 0px' });
    io.observe(uploadCard);
    return () => io.disconnect();
  });
  // "Review another": drop the file, mapping, results and undo history, reset
  // the upload box, and go back to it. Review marks stay (they are keyed on
  // values, so they still apply if the same data is audited again).
  let pickerKey = $state(0);
  async function reviewAnother() {
    source = null;
    table = null;
    result = null;
    mapping = {};
    history = [];
    loadError = '';
    runError = '';
    ranWith = '';
    pickerKey++;
    await tick();
    toUpload();
  }

  function toUpload() {
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    uploadCard?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
    uploadCard?.querySelector('button, input, select')?.focus({ preventScroll: true });
  }

  // Raw state: large plain data, replaced wholesale, never mutated in place.
  let source = $state.raw(null); // { name, sheetNames, matrices, notices }
  let sheet = $state('');
  let headerRow = $state(1);
  let table = $state.raw(null);
  let loadError = $state('');

  let mapping = $state({});
  let delimiter = $state('|');
  let strict = $state(false);
  let scanExtra = $state(true);

  let running = $state(false);
  let progress = $state({ stage: '', done: 0, total: 0, requests: 0 });
  let runError = $state('');
  let result = $state.raw(null);

  const hasKey = $derived(table ? table.headers.some((h) => mapping[h] === MATCH_KEY) : false);

  // Review marks (this browser only): "resolved" hides an issue everywhere;
  // "problem" hides it from the view but keeps it in the CSV export.
  let marks = $state.raw(loadMarks('resolved'));
  let problems = $state.raw(loadMarks('problem'));
  let showResolved = $state(false);
  const view = $derived(result ? applyResolved(result, marks, problems) : null);

  // How many issues share each (column, difference).
  const sizes = $derived(result ? groupSizes(result) : new Map());

  // Marks are keyed on header + mapped field (see resolved.js).
  const specOf = (name) => colSpec(result.columns.find((c) => c.name === name) ?? { name });

  // Undo history: a snapshot of both mark sets before each change, with the
  // cell it happened at so undo can take the viewer back there.
  const HISTORY = 100;
  let history = $state.raw([]);

  function commit(r, p) {
    marks = r;
    problems = p;
    saveMarks(r, 'resolved');
    saveMarks(p, 'problem');
  }

  function update(fn, at = null, label = '') {
    history = [...history.slice(-(HISTORY - 1)), { marks, problems, at, label }];
    const r = new Set(marks);
    const p = new Set(problems);
    fn({ resolved: r, problem: p });
    commit(r, p);
  }

  /** Undo the last mark change; returns the cell it was made at, if any. */
  function undoLast() {
    const last = history.at(-1);
    if (!last) return null;
    history = history.slice(0, -1);
    commit(last.marks, last.problems);
    return last.at;
  }
  const undoLabel = $derived(history.at(-1)?.label ?? '');
  const verb = (kind) => (kind === 'problem' ? 'problem' : kind === 'resolved' ? 'resolve' : 'undo');
  // kind: 'resolved' | 'problem'; scope 'all': every identical difference, 'one': this row.
  function markCell(kind, row, name, cell, scope) {
    const column = specOf(name);
    const keys = [valueKey(column, cell), cellKey(row, column, cell)];
    update((sets) => {
      for (const set of Object.values(sets)) for (const k of keys) set.delete(k);
      sets[kind].add(scope === 'all' ? keys[0] : keys[1]);
    }, { line: row.line, column: name }, `${verb(kind)}${scope === 'all' ? ' (all identical)' : ''} · row ${row.line} ${name}`);
  }
  function unmarkCell(row, name, cell) {
    const column = specOf(name);
    update((sets) => { for (const set of Object.values(sets)) { set.delete(valueKey(column, cell)); set.delete(cellKey(row, column, cell)); } },
      { line: row.line, column: name }, `unmark · row ${row.line} ${name}`);
  }
  function markRow(kind, row) {
    const idName = result.columns.find((c) => c.role === 'identifier')?.name;
    update((sets) => { for (const set of Object.values(sets)) set.delete(rowKey(row)); if (kind) sets[kind].add(rowKey(row)); },
      { line: row.line, column: idName }, `${kind ? verb(kind) : 'unmark'} row ${row.line}`);
  }
  // Bulk: mark (or with kind null, unmark) many cells in one write. Each is
  // marked for its own row only: an explicit selection means those cells.
  function markMany(kind, items) {
    update((sets) => {
      for (const { row, name, cell } of items) {
        const column = specOf(name);
        const keys = [valueKey(column, cell), cellKey(row, column, cell)];
        for (const set of Object.values(sets)) for (const k of keys) set.delete(k);
        if (kind) sets[kind].add(keys[1]);
      }
    }, items[0] ? { line: items[0].row.line, column: items[0].name } : null, `${kind ? verb(kind) : 'unmark'} ${items.length} cell${items.length === 1 ? '' : 's'}`);
  }
  const groupSize = (name, cell) => sizes.get(valueKey(specOf(name), cell)) ?? 1;

  // The result belongs to the mapping/options it was run with; say so when
  // they have changed since, instead of silently showing stale results.
  const runKey = $derived(JSON.stringify([mapping, delimiter, strict, scanExtra]));
  let ranWith = $state('');
  const stale = $derived(!!result && !running && runKey !== ranWith);

  // Per-viewer convenience only: remembered column choices, by header name.
  function remembered() {
    try { return JSON.parse(localStorage.getItem(REMEMBER) ?? '{}') ?? {}; } catch { return {}; }
  }
  function remember(header, target) {
    const next = { ...remembered() };
    if (target === null) delete next[header]; else next[header] = target;
    try { localStorage.setItem(REMEMBER, JSON.stringify(next)); } catch { /* storage unavailable */ }
  }

  function loaded(workbook) {
    source = workbook;
    result = null;
    const first = workbook.sheetNames.find((n) => workbook.matrices[n].length) ?? workbook.sheetNames[0];
    selectSheet(first);
  }

  function selectSheet(name, row) {
    sheet = name;
    result = null;
    const matrix = source.matrices[name] ?? [];
    loadError = matrix.length ? '' : `Sheet "${name}" is empty.`;
    table = null;
    if (!matrix.length) return;
    headerRow = row ?? guessHeaderRow(matrix);
    table = buildTable(matrix, headerRow);
    const saved = remembered();
    const next = suggestMapping(table.headers, settings.bundles);
    for (const h of table.headers) if (h in saved) next[h] = saved[h];
    // A remembered match key can clash with a suggested one; keep the first.
    let key = false;
    for (const h of table.headers) if (next[h] === MATCH_KEY) { if (key) next[h] = ''; key = true; }
    mapping = next;
  }

  async function run() {
    running = true;
    runError = '';
    result = null;
    progress = { stage: 'Starting', done: 0, total: 0, requests: 0 };
    const key = runKey;
    try {
      result = await audit(table, $state.snapshot(settings), { mapping: $state.snapshot(mapping), delimiter: delimiter || '|', strict, scanExtra },
        (p) => { progress = p; });
      ranWith = key;
    }
    catch (e) {
      runError = e.message;
    }
    finally {
      running = false;
    }
  }

  function download() {
    const blob = new Blob([issuesCsv(view)], { type: 'text/csv' });
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

  <section class="card upload" bind:this={uploadCard}>
    <h2>1. Spreadsheet</h2>
    {#key pickerKey}<SourcePicker sheetEndpoint={settings.sheetEndpoint} onloaded={loaded} />{/key}

    {#if source}
      <div class="loaded">
        <strong>{source.name}</strong>
        {#if source.matrices[sheet]?.length > 1}
          <label>
            Header row
            <select value={headerRow} onchange={(e) => selectSheet(sheet, Number(e.currentTarget.value))}>
              {#each source.matrices[sheet].slice(0, 10) as cells, i}
                <option value={i + 1}>{i + 1}: {cells.filter((c) => c.trim()).slice(0, 3).join(', ').slice(0, 40) || '(blank)'}</option>
              {/each}
            </select>
          </label>
        {/if}
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
    {#if (source?.notices?.length || table?.notices?.length)}
      <ul class="notices" role="status">
        {#each [...(source?.notices ?? []), ...(table?.notices ?? [])] as n}<li>{n}</li>{/each}
      </ul>
    {/if}
  </section>

  {#if table}
    <section class="card">
      <h2>2. Compare</h2>
      {#key table}
        <ColumnMapper headers={table.headers} rows={table.rows} bundles={settings.bundles} bind:mapping onchange={remember} />
      {/key}
      <div class="options">
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
        <button class="btn" onclick={run} disabled={running || !hasKey}>{running ? 'Auditing…' : result ? 'Run audit again' : 'Run audit'}</button>
        {#if !hasKey}<span class="muted">Map a column to the identifier first.</span>{/if}
        {#if running}
          <div class="progress" aria-live="polite">
            <span>{progress.stage}{progress.total ? ` · ${progress.done}/${progress.total}` : ''} · {progress.requests} requests</span>
            {#if progress.total}<progress max={progress.total} value={progress.done}></progress>{/if}
          </div>
        {/if}
      </div>
      {#if runError}<p class="error" role="alert">{runError}</p>{/if}
    </section>
  {/if}

  {#if view}
    {#if stale}
      <div class="stale" role="status">
        The mapping or options changed since these results were produced.
        <button class="btn" onclick={run}>Re-run with the new mapping</button>
      </div>
    {/if}
    {#if view.failures?.length}
      <div class="failures" role="alert">
        <strong>Part of the audit could not be completed.</strong> The rest of the results stand; affected rows are marked
        “not checked”. Run the audit again to retry.
        <ul>{#each view.failures as f}<li>{f.stage} — {f.count} item{f.count === 1 ? '' : 's'}: {f.message}</li>{/each}</ul>
        <button class="btn" onclick={run}>Retry</button>
      </div>
    {/if}
    <Summary result={view} bundles={settings.bundles} ondownload={download} />
    <ResultsTable result={view} bundles={settings.bundles} nodeBase={settings.nodeBase}
      bind:showResolved onmark={markCell} onunmark={unmarkCell} onmarkrow={markRow} onmarkmany={markMany} {groupSize}
      onundo={undoLast} {undoLabel} ondownload={download} onreviewanother={reviewAnother}
      fileName={source ? `${source.name}${source.sheetNames.length > 1 ? ` · ${sheet}` : ''}` : ''} />
    {#if scanExtra}<ExtraNodes extra={view.extra} truncated={view.truncated} incomplete={view.extraIncomplete} nodeBase={settings.nodeBase} />{/if}
  {/if}
  {#if !uploadVisible}
    <button class="to-upload" onclick={toUpload} title="Back to the spreadsheet upload" aria-label="Back to the spreadsheet upload">
      <span aria-hidden="true">↑</span> Upload
    </button>
  {/if}
</div>

<style>
  .intro { max-width: 70ch; margin: 0 0 1rem; }
  /* Toolbar clearance: Claro's sticky admin toolbar covers the top ~80px. */
  .upload { scroll-margin-top: 6rem; }
  .to-upload {
    position: fixed; z-index: 450; left: 1rem; bottom: 1rem;
    display: inline-flex; gap: 0.35rem; align-items: center;
    font: inherit; font-size: 0.875rem; font-weight: 600; cursor: pointer;
    padding: 0.5rem 0.9rem; border-radius: 999px;
    color: var(--ia-accent); background: var(--ia-surface); border: 1px solid var(--ia-border);
    box-shadow: 0 6px 18px rgb(0 0 0 / 0.15);
  }
  .to-upload:hover { border-color: var(--ia-accent); }
  .to-upload:focus-visible { outline: 2px solid var(--ia-accent); outline-offset: 2px; }
  .loaded { display: flex; flex-wrap: wrap; gap: 1rem; align-items: center; margin-top: 0.75rem; }
  .options { display: flex; flex-wrap: wrap; gap: 0.75rem 1.5rem; align-items: center; }
  .options label { display: inline-flex; gap: 0.5rem; align-items: center; }
  .options select, .options input:not([type]) { font: inherit; padding: 0.3em 0.5em; border: 1px solid var(--ia-border); border-radius: 4px; }
  .narrow { width: 3.5em; text-align: center; }
  .stale {
    position: sticky; top: 0.5rem; z-index: 10; display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center;
    padding: 0.6rem 0.9rem; margin-bottom: 1rem; border-radius: 8px;
    background: var(--ia-warn-bg); color: var(--ia-warn); border: 1px solid var(--ia-warn-line);
  }
  .actions { display: flex; flex-wrap: wrap; gap: 1rem; align-items: center; margin-top: 1rem; }
  .progress { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.85rem; color: var(--ia-muted); }
  .progress progress { width: 16rem; }
  .failures { margin-bottom: 1rem; padding: 0.75rem 1rem; border-radius: 8px; background: var(--ia-error-bg); color: var(--ia-error); border: 1px solid var(--ia-error-line); }
  .failures ul { margin: 0.4rem 0 0.6rem; }
  .notices { margin: 0.75rem 0 0; padding: 0.5rem 0.75rem 0.5rem 1.75rem; border-radius: 6px; background: var(--ia-warn-bg); color: var(--ia-warn); font-size: 0.875rem; }
  .error { color: var(--ia-error); background: var(--ia-error-bg); padding: 0.5rem 0.75rem; border-radius: 6px; margin: 0.75rem 0 0; }
</style>
