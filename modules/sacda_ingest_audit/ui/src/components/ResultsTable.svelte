<script>
  import CellDetail from './CellDetail.svelte';

  let { result, nodeBase } = $props();

  // Virtual scrolling: rows have a fixed height, and only the ones in view
  // (plus OVERSCAN either side) are in the DOM; spacer rows stand in for the
  // rest, so 5,000 rows scroll like 30.
  const ROW_H = 40;
  const OVERSCAN = 8;
  const GLYPH = { error: '✕', warn: '!', info: 'i' };
  const STATUS_LABEL = { ok: 'Matches', info: 'Only in repository', warn: 'Check', error: 'Mismatch', skip: 'Not compared' };

  let filter = $state('problems');
  let query = $state('');
  let focusColumn = $state('');
  let problemColumnsOnly = $state(false);
  let scroller = $state();
  let scrollTop = $state(0);
  let viewH = $state(600);
  let headH = $state(0);
  let selected = $state(null); // { row, column }

  const idColumn = $derived(result.columns.find((c) => c.role === 'identifier'));
  const colStats = $derived(result.stats.columns);
  const issues = (name) => colStats[name].error + colStats[name].warn;

  const columns = $derived(result.columns.filter((c) => c.role !== 'identifier'
    && (!problemColumnsOnly || issues(c.name) > 0)));

  const rows = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return result.rows.filter((r) => {
      if (filter === 'problems' && r.status === 'ok') return false;
      if (filter === 'errors' && r.status !== 'error') return false;
      if (filter === 'missing' && r.nodes.length) return false;
      if (focusColumn && !['error', 'warn'].includes(r.cells[focusColumn]?.status)) return false;
      if (q && !`${r.identifier} ${r.title}`.toLowerCase().includes(q)) return false;
      return true;
    });
  });
  const start = $derived(Math.max(0, Math.floor((scrollTop - headH) / ROW_H) - OVERSCAN));
  const end = $derived(Math.min(rows.length, start + Math.ceil(viewH / ROW_H) + 2 * OVERSCAN));
  const visible = $derived(rows.slice(start, end));

  // Any filter change goes back to the top.
  $effect(() => {
    filter; query; focusColumn;
    if (scroller) scroller.scrollTop = 0;
    scrollTop = 0;
  });

  const counts = $derived({
    all: result.rows.length,
    problems: result.rows.filter((r) => r.status !== 'ok').length,
    errors: result.rows.filter((r) => r.status === 'error').length,
    missing: result.rows.filter((r) => !r.nodes.length).length,
  });

  function text(cell) {
    if (cell.sheet.length) return cell.sheet.join(' | ');
    if (cell.server.length) return cell.server.join(' | ');
    return '';
  }

  function toggleFocus(name) {
    focusColumn = focusColumn === name ? '' : name;
    if (focusColumn) filter = 'all';
  }
</script>

<section class="card results">
  <div class="toolbar">
    <div class="segmented" role="group" aria-label="Rows to show">
      {#each [['problems', 'With issues'], ['errors', 'Errors'], ['missing', 'Not found'], ['all', 'All rows']] as [key, label]}
        <button class:active={filter === key} aria-pressed={filter === key} onclick={() => (filter = key)}>
          {label} <span class="count">{counts[key]}</span>
        </button>
      {/each}
    </div>
    <input type="search" bind:value={query} placeholder="Find identifier or title" aria-label="Find identifier or title" />
    <label class="check"><input type="checkbox" bind:checked={problemColumnsOnly} /> Only columns with issues</label>
    <span class="muted shown">{rows.length.toLocaleString()} rows</span>
  </div>

  {#if focusColumn}
    <p class="focus">
      Showing rows with an issue in <code>{focusColumn}</code>.
      <button class="link" onclick={() => (focusColumn = '')}>Clear</button>
    </p>
  {/if}

  <div class="legend muted">
    <span class="sw error">✕ mismatch</span>
    <span class="sw warn">! term or date differs, check it</span>
    <span class="sw info">i blank in file, set in repository</span>
    <span class="sw skip">not compared</span>
    <span>Click any cell for the side-by-side values.</span>
  </div>

  {#if !rows.length}
    <p class="empty">{filter === 'problems' && !query && !focusColumn ? 'Every row matches the repository.' : 'No rows match this filter.'}</p>
  {:else}
    <div class="scroll" tabindex="-1" bind:this={scroller} bind:clientHeight={viewH} onscroll={(e) => (scrollTop = e.currentTarget.scrollTop)}>
      <table>
        <thead bind:offsetHeight={headH}>
          <tr>
            <th class="sticky c-line" scope="col">Row</th>
            <th class="sticky c-id" scope="col">{idColumn?.name ?? 'Identifier'}</th>
            {#each columns as col (col.name)}
              {@const st = colStats[col.name]}
              <th scope="col" class:unknown={col.role === 'unknown' || col.role === 'workbench'} class:focused={focusColumn === col.name}>
                <div class="h-name">{col.name}</div>
                <div class="h-meta">
                  {#if col.role === 'unknown'}<span class="pill skip" title="This column is not mapped to a field, so it was not compared">not mapped</span>
                  {:else if col.role === 'workbench'}<span class="pill skip">workbench option</span>
                  {:else}
                    <span class="h-label">{col.label}</span>
                    {#if col.fuzzy}<span class="pill skip" title="Workbench may rewrite these values; differences are shown as warnings">fuzzy</span>{/if}
                  {/if}
                </div>
                {#if st.error || st.warn}
                  <button class="h-issues" onclick={() => toggleFocus(col.name)} title="Show only rows with issues in this column">
                    {#if st.error}<span class="pill error">✕ {st.error}</span>{/if}
                    {#if st.warn}<span class="pill warn">! {st.warn}</span>{/if}
                  </button>
                {/if}
              </th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#if start > 0}<tr class="spacer" aria-hidden="true"><td colspan={columns.length + 2} style:height="{start * ROW_H}px"></td></tr>{/if}
          {#each visible as row (row.line)}
            {@const idCell = row.cells[idColumn.name]}
            <tr class="r-{row.status}">
              <td class="sticky c-line num">{row.line}</td>
              <td class="sticky c-id {row.nodes.length === 1 ? '' : 'error'}">
                <button class="cell-btn" class:selected={selected?.row === row && selected?.column === idColumn}
                  onclick={() => (selected = { row, column: idColumn })}>
                  <span class="ident">{row.identifier || '(blank)'}</span>
                  {#if !row.nodes.length}<span class="pill error">not found</span>
                  {:else if row.nodes.length > 1}<span class="pill error">{row.nodes.length} nodes</span>
                  {:else if row.status === 'ok'}<span class="pill ok">✓</span>
                  {/if}
                </button>
                {#each row.nodes as n}
                  <a class="node" href="{nodeBase}{n.nid}" target="_blank" rel="noopener" title="{n.title} (node/{n.nid})">↗</a>
                {/each}
              </td>
              {#each columns as col (col.name)}
                {@const cell = row.cells[col.name]}
                <td class="c {cell.status}" class:focused={focusColumn === col.name}>
                  <button class="cell-btn" class:selected={selected?.row === row && selected?.column === col}
                    title="{STATUS_LABEL[cell.status]}{cell.note ? ` — ${cell.note}` : ''}"
                    onclick={() => (selected = { row, column: col })}>
                    {#if GLYPH[cell.status]}<span class="glyph" aria-hidden="true">{GLYPH[cell.status]}</span>{/if}
                    <span class="sr">{STATUS_LABEL[cell.status]}:</span>
                    <span class="val" class:from-server={!cell.sheet.length && cell.server.length}>{text(cell)}</span>
                  </button>
                </td>
              {/each}
            </tr>
          {/each}
          {#if end < rows.length}<tr class="spacer" aria-hidden="true"><td colspan={columns.length + 2} style:height="{(rows.length - end) * ROW_H}px"></td></tr>{/if}
        </tbody>
      </table>
    </div>

  {/if}
</section>

{#if selected}
  <CellDetail row={selected.row} column={selected.column} {nodeBase} onclose={() => (selected = null)} />
{/if}

<style>
  .toolbar { display: flex; flex-wrap: wrap; gap: 0.75rem 1rem; align-items: center; margin-bottom: 0.75rem; }
  .segmented { display: inline-flex; border: 1px solid var(--ia-border); border-radius: 6px; overflow: hidden; }
  .segmented button { font: inherit; border: 0; background: var(--ia-surface); padding: 0.4em 0.8em; cursor: pointer; border-right: 1px solid var(--ia-border); }
  .segmented button:last-child { border-right: 0; }
  .segmented button.active { background: var(--ia-accent); color: #fff; }
  .count { font-variant-numeric: tabular-nums; opacity: 0.75; margin-left: 0.2em; }
  input[type='search'] { font: inherit; padding: 0.4em 0.6em; border: 1px solid var(--ia-border); border-radius: 6px; min-width: 14em; }
  .check { display: inline-flex; gap: 0.4rem; align-items: center; }
  .focus { margin: 0 0 0.5rem; }
  .link { font: inherit; background: none; border: 0; color: var(--ia-accent); text-decoration: underline; cursor: pointer; padding: 0; }
  .legend { display: flex; flex-wrap: wrap; gap: 0.4rem 1rem; font-size: 0.8rem; margin-bottom: 0.6rem; align-items: center; }
  .sw { padding: 0.1em 0.5em; border-radius: 3px; border: 1px solid transparent; }
  .sw.error { background: var(--ia-error-bg); color: var(--ia-error); border-color: var(--ia-error-line); }
  .sw.warn { background: var(--ia-warn-bg); color: var(--ia-warn); border-color: var(--ia-warn-line); }
  .sw.info { background: var(--ia-info-bg); color: var(--ia-info); }
  .sw.skip { background: var(--ia-skip-bg); color: var(--ia-skip); }
  .empty { padding: 2rem; text-align: center; color: var(--ia-ok); font-weight: 600; background: var(--ia-ok-bg); border-radius: 8px; }

  .scroll { overflow: auto; max-height: 70vh; border: 1px solid var(--ia-border); border-radius: 6px; }
  table { border-collapse: separate; border-spacing: 0; font-size: 0.85rem; width: max-content; min-width: 100%; }
  th, td { border-right: 1px solid #ececef; border-bottom: 1px solid #ececef; padding: 0; text-align: left; vertical-align: top; background: var(--ia-surface); }
  thead th { position: sticky; top: 0; z-index: 2; background: #f8f8fa; padding: 0.45rem 0.6rem; font-weight: 600; border-bottom: 1px solid var(--ia-border); min-width: 9rem; max-width: 18rem; }
  th.unknown { background: #f1f1f3; color: var(--ia-skip); }
  th.focused, td.focused { box-shadow: inset 0 0 0 2px var(--ia-accent); }
  .h-name { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8rem; word-break: break-all; }
  .h-meta { display: flex; flex-wrap: wrap; gap: 0.3rem; align-items: center; margin-top: 0.15rem; font-weight: 400; }
  .h-label { color: var(--ia-muted); font-size: 0.75rem; }
  .h-issues { display: flex; gap: 0.25rem; margin-top: 0.3rem; background: none; border: 0; padding: 0; cursor: pointer; }

  .sticky { position: sticky; z-index: 1; }
  thead .sticky { z-index: 3; }
  .c-line { left: 0; min-width: 3.2rem; width: 3.2rem; }
  .c-id { left: 3.2rem; min-width: 12rem; max-width: 16rem; box-shadow: 2px 0 0 #e4e4e7; }
  td.c-line { padding: 0.4rem 0.5rem; color: var(--ia-muted); text-align: right; }
  .num { font-variant-numeric: tabular-nums; }
  td.c-id .ident { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8rem; }
  .node { font-size: 0.8rem; text-decoration: none; padding: 0 0.5rem 0 0.1rem; }
  td.c-id { white-space: nowrap; overflow: hidden; }
  td.c-id .cell-btn { display: inline-flex; width: auto; max-width: calc(100% - 1.5rem); vertical-align: middle; }
  tbody tr:not(.spacer) td { height: 40px; box-sizing: border-box; overflow: hidden; }
  tr.spacer td { border: 0; padding: 0; background: transparent; }

  tr.r-error td.c-line { box-shadow: inset 4px 0 0 #d64550; }
  tr.r-warn td.c-line { box-shadow: inset 4px 0 0 #e0a91b; }
  tr.r-ok td.c-line { box-shadow: inset 4px 0 0 #3fa35b; }

  .cell-btn {
    font: inherit; color: inherit; text-align: left; width: 100%; height: 100%;
    display: flex; gap: 0.35rem; align-items: center; flex-wrap: nowrap; white-space: nowrap; overflow: hidden;
    background: none; border: 0; padding: 0.4rem 0.6rem; cursor: pointer;
    position: relative; /* anchors the visually-hidden .sr label inside the scroller */
  }
  .cell-btn:focus-visible, .cell-btn.selected { outline: 2px solid var(--ia-accent); outline-offset: -2px; }
  td.c .cell-btn { flex-wrap: nowrap; }
  .val { display: block; max-width: 16rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .val.from-server { font-style: italic; }
  .glyph { font-weight: 700; flex: none; }
  td.error, td.c-id.error { background: var(--ia-error-bg); color: var(--ia-error); }
  td.warn { background: var(--ia-warn-bg); color: var(--ia-warn); }
  td.info { background: var(--ia-info-bg); color: var(--ia-info); }
  td.skip { background: var(--ia-skip-bg); color: var(--ia-skip); }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }

  .shown { font-size: 0.85rem; margin-left: auto; }
</style>
