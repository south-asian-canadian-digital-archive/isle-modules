<script>
  import { tick, untrack } from 'svelte';
  import SourcePicker from './components/SourcePicker.svelte';
  import ColumnMapper from './components/ColumnMapper.svelte';
  import Summary from './components/Summary.svelte';
  import ResultsTable from './components/ResultsTable.svelte';
  import ExtraNodes from './components/ExtraNodes.svelte';
  import { issuesCsv } from './lib/audit.js';
  import { suggestMapping, MATCH_KEY } from './lib/compare.js';
  import { audit, parse } from './lib/worker.js';
  import { loadSession, saveSession, sessionCall, bytesFromBase64, agentPrompt, POLL_MS } from './lib/agent.js';
  import { buildTable, guessHeaderRow } from './lib/table.js';
  import { openDifferences, requestTriage, load as loadAi, save as saveAi } from './lib/triage.js';
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
  let matchMonthStart = $state(false);
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

  // AI triage (optional; hidden when the site has no API key): an opinion on
  // each distinct open difference, kept per browser and keyed like the marks
  // so it survives a re-run. Never applied without a click.
  let ai = $state.raw(loadAi());
  let triaging = $state(false);
  let triageDone = $state(0);
  let triageTotal = $state(0);
  let triageError = $state('');
  const openItems = $derived(view ? openDifferences(view) : []);
  const aiOf = (name, cell) => ai.get(valueKey(specOf(name), cell)) ?? null;
  const aiStats = $derived.by(() => {
    const out = { pending: 0, same: 0, problem: 0, unsure: 0, cells: { same: 0, problem: 0, unsure: 0 } };
    for (const item of openItems) {
      const v = ai.get(item.id)?.verdict;
      if (!v) out.pending++;
      else { out[v]++; out.cells[v] += item.count; }
    }
    return out;
  });
  // Queue the open differences, then wait for the agent to answer them.
  let triageWaiting = $state(0);
  let stopTriage = false;
  async function runTriage() {
    const items = openItems.filter((i) => !ai.has(i.id));
    if (!items.length || triaging) return;
    triaging = true;
    stopTriage = false;
    triageError = '';
    triageDone = 0;
    triageTotal = items.length;
    triageWaiting = items.length;
    try {
      await requestTriage(settings.triageEndpoint, items, (results, waiting) => {
        if (results.length) {
          const next = new Map(ai);
          for (const r of results) next.set(r.id, { verdict: r.verdict, reason: r.reason });
          ai = next;
          saveAi(next);
        }
        triageWaiting = waiting;
        triageDone = items.length - waiting;
      }, { stopped: () => stopTriage });
    }
    catch (e) { triageError = e.message; }
    finally { triaging = false; }
  }
  function cancelTriage() { stopTriage = true; }
  // Accept every open suggestion of one verdict, as one undoable step.
  function acceptAi(verdict) {
    const kind = verdict === 'same' ? 'resolved' : 'problem';
    const ids = openItems.filter((i) => ai.get(i.id)?.verdict === verdict).map((i) => i.id);
    if (!ids.length) return;
    update((sets) => { for (const id of ids) sets[kind].add(id); }, null, `accept ${ids.length} AI "${verdict === 'same' ? 'same meaning' : 'real problem'}"`);
  }
  const triage = $derived(settings.triageEndpoint ? {
    running: triaging, done: triageDone, total: triageTotal, waiting: triageWaiting, error: triageError, stats: aiStats,
    run: runTriage, cancel: cancelTriage, accept: acceptAi, of: aiOf,
  } : null);

  // Agent session: a temporary token for an AI agent on someone's machine,
  // which can answer the triage queue and hand this page spreadsheets.
  let agent = $state(loadSession()); // { token, expires } | null
  let agentError = $state('');
  let agentCopied = $state(false);
  let agentStatus = $state.raw(null);
  let agentInbox = [];
  let agentWorking = false;
  async function startAgent() {
    agentError = '';
    try {
      const r = await sessionCall(settings.sessionEndpoint, { action: 'start' });
      agent = { token: r.token, expires: r.expires };
      saveSession(agent);
    }
    catch (e) { agentError = e.message; }
  }
  async function stopAgent() {
    const token = agent?.token;
    agent = null;
    saveSession(null);
    agentStatus = null;
    if (token) await sessionCall(settings.sessionEndpoint, { action: 'stop', session: token }).catch(() => {});
  }
  async function copyPrompt() {
    try { await navigator.clipboard.writeText(agentPrompt(settings.queueUrl, agent.token, agent.expires)); agentCopied = true; setTimeout(() => (agentCopied = false), 2000); }
    catch { agentError = 'Could not copy. Select the token and copy it by hand.'; }
  }
  function report(status) { agentStatus = status; }
  function columnReport(r) {
    const out = {};
    for (const c of r.columns) out[c.name] = { field: c.target || '', ...(r.stats.columns[c.name] ?? {}) };
    return out;
  }
  async function agentFile(f) {
    const opts = f.options ?? {};
    report({ state: 'loading', file: f.name });
    try {
      if (triaging) { cancelTriage(); while (triaging) await new Promise((r) => setTimeout(r, 100)); }
      const workbook = await parse(f.name, new Blob([bytesFromBase64(f.content_base64)]));
      pickerKey++;
      loaded(workbook);
      if (opts.sheet && workbook.sheetNames.includes(opts.sheet)) selectSheet(opts.sheet, opts.header_row ? Number(opts.header_row) : undefined);
      else if (opts.header_row) selectSheet(sheet, Number(opts.header_row));
      if (!table) throw new Error(loadError || 'The spreadsheet has no rows.');
      if (opts.delimiter) delimiter = String(opts.delimiter);
      if (opts.mapping && typeof opts.mapping === 'object') mapping = { ...mapping, ...opts.mapping };
      if (!hasKey) throw new Error('No column is mapped to field_identifier; pass options.mapping.');
      report({ state: 'auditing', file: f.name, mapping: $state.snapshot(mapping), delimiter });
      await run();
      if (runError || !result) throw new Error(runError || 'The audit did not finish.');
      await tick();
      const differences = openItems.filter((i) => !ai.has(i.id)).length;
      const st = view.stats;
      report({
        state: opts.triage === false ? 'done' : 'queued', file: f.name, delimiter, differences,
        stats: { rows: st.rows, found: st.found, notFound: st.notFound, duplicates: st.duplicates, unchecked: st.unchecked,
          ok: st.ok, warn: st.warn, error: st.error, matchRate: st.matchRate, extra: st.extra },
        columns: columnReport(view), failures: view.failures ?? [],
      });
      if (opts.triage !== false) {
        const file = f.name;
        runTriage().then(() => { if (agentStatus?.file === file) report({ ...agentStatus, state: triageWaiting ? 'queued' : 'triaged', waiting: triageWaiting }); });
      }
    }
    catch (e) { report({ state: 'error', file: f.name, error: e.message }); }
  }
  async function agentWork() {
    if (agentWorking) return;
    agentWorking = true;
    try { while (agentInbox.length) await agentFile(agentInbox.shift()); }
    finally { agentWorking = false; }
  }
  $effect(() => {
    if (!agent?.token) return;
    const token = agent.token;
    let busy = false;
    const tickPoll = async () => {
      if (busy) return;
      busy = true;
      try {
        const r = await sessionCall(settings.sessionEndpoint, { action: 'poll', session: token, status: untrack(() => agentStatus) ?? { state: 'idle' } });
        agentError = '';
        if (r.files?.length) { agentInbox.push(...r.files); agentWork(); }
      }
      catch (e) {
        if (e.ended) { agent = null; saveSession(null); agentError = 'The agent session ended.'; }
        else agentError = e.message;
      }
      finally { busy = false; }
    };
    tickPoll();
    const id = setInterval(tickPoll, POLL_MS);
    return () => clearInterval(id);
  });

  // The result belongs to the mapping/options it was run with; say so when
  // they have changed since, instead of silently showing stale results.
  const runKey = $derived(JSON.stringify([mapping, delimiter, strict, scanExtra, matchMonthStart]));
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
      result = await audit(table, $state.snapshot(settings), { mapping: $state.snapshot(mapping), delimiter: delimiter || '|', strict, scanExtra, matchMonthStart },
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
    const blob = new Blob([issuesCsv(view, triage ? aiOf : null)], { type: 'text/csv' });
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

  <section class="card agent">
    <h2>AI agent</h2>
    {#if agent}
      <p class="muted">An agent can upload spreadsheets to this page and judge the differences while it stays open. Copy the prompt into your agent; it carries the token.</p>
      <div class="agent-row">
        <code class="token" title="Agent token">{agent.token}</code>
        <button class="btn" onclick={copyPrompt}>{agentCopied ? 'Copied ✓' : 'Copy agent prompt'}</button>
        <button class="btn secondary" onclick={stopAgent}>End session</button>
        <span class="muted">until {new Date(agent.expires * 1000).toLocaleTimeString()}</span>
      </div>
      {#if agentStatus && agentStatus.state !== 'idle'}
        <p class="muted agent-state" role="status">Agent file <strong>{agentStatus.file}</strong>: {agentStatus.state}{agentStatus.error ? ` · ${agentStatus.error}` : ''}{agentStatus.differences != null ? ` · ${agentStatus.differences} differences queued` : ''}</p>
      {/if}
    {:else}
      <div class="agent-row">
        <button class="btn secondary" onclick={startAgent}>Start agent session</button>
        <span class="muted">Gives an AI agent on your computer a temporary token to upload sheets here and triage the differences.</span>
      </div>
    {/if}
    {#if agentError}<p class="error" role="alert">{agentError}</p>{/if}
  </section>

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
        <label class="check">
          <input type="checkbox" bind:checked={matchMonthStart} />
          Auto-match month-only dates when the repository adds day 01 (2012-12 = 2012-12-01)
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
        <button class="btn" onclick={run}>Re-run with the new settings</button>
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
      {triage} onundo={undoLast} {undoLabel} ondownload={download} onreviewanother={reviewAnother}
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
  .agent p { margin: 0 0 0.5rem; }
  .agent-row { display: flex; flex-wrap: wrap; gap: 0.6rem 0.9rem; align-items: center; }
  .token { font-size: 0.85rem; padding: 0.3rem 0.5rem; border-radius: 4px; border: 1px solid var(--ia-border); user-select: all; }
  .agent-state { margin: 0.6rem 0 0; }
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
