<script>
  import { tick } from 'svelte';
  import CellDetail from './CellDetail.svelte';
  import { difference } from '../lib/resolved.js';
  import { differenceTypes } from '../lib/compare.js';

  let { result, bundles, nodeBase, showResolved = $bindable(false), onmark, onunmark, onmarkrow, onmarkmany, groupSize, onundo, undoLabel = '' } = $props();

  // Virtual scrolling: rows have a fixed height, and only the ones in view
  // (plus OVERSCAN either side) are in the DOM; spacer rows stand in for the
  // rest, so 5,000 rows scroll like 30. The row height is measured from the
  // DOM rather than assumed, and the window is clamped at the end, so the
  // spacers always add up to the same total height and nothing jumps.
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
  let rowH = $state(40);
  let typeFilter = $state('');
  // Cell-kind filter (the legend chips): show rows containing at least one
  // cell of any selected kind; other cells are dimmed.
  let kinds = $state([]);
  const KINDS = [
    ['error', '✕ mismatch'],
    ['warn', '! term or date differs, check it'],
    ['info', 'i blank in file, set in repository'],
    ['skip', 'not compared'],
    ['resolved', '✓ marked resolved'],
    ['problem', '⚑ marked problem'],
  ];
  const kindOf = (cell) => (cell.flagged ? 'problem' : cell.resolved ? 'resolved' : cell.status);

  // Review flow: Previous/Next walk the issues column by column (down a
  // column first, then on to the next), over the rows and columns currently
  // shown. "Issues" are the selected chip kinds, else mismatches + warnings.
  let autoAdvance = $state(true);
  const navKinds = $derived(kinds.length ? kinds.filter((k) => k !== 'resolved' || showResolved) : ['error', 'warn']);

  // Cells marked during this session stay in the Previous/Next walk, so you
  // can step back to what you just marked and change your mind.
  let touched = $state(new Set()); // "line|column"
  const touchedLines = $derived(new Set([...touched].map((k) => Number(k.slice(0, k.indexOf('|'))))));
  const touch = (pairs) => { const t = new Set(touched); for (const [line, col] of pairs) t.add(`${line}|${col}`); touched = t; };

  function qualifies(row, name, skip) {
    const c = row.cells[name];
    if (!c || skip?.(row, name, c)) return false;
    return navKinds.includes(kindOf(c)) || touched.has(`${row.line}|${name}`);
  }

  function undo() {
    const at = onundo?.();
    if (at) {
      bulk = new Set();
      if (!rows.some((r) => r.line === at.line)) filter = 'all';
      go(at);
    }
  }

  function findFrom(line, column, dir, skip) {
    if (!rows.length || !columns.length) return null;
    let ci = columns.findIndex((c) => c.name === column);
    let ri;
    if (ci < 0) { ci = dir > 0 ? 0 : columns.length - 1; ri = dir > 0 ? -1 : rows.length; }
    else {
      ri = rows.findIndex((r) => r.line === line);
      if (ri < 0) {
        // Row no longer shown (filtered out): continue from where it was.
        const after = rows.findIndex((r) => r.line > line);
        ri = (after < 0 ? rows.length : after) - (dir > 0 ? 1 : 0);
      }
    }
    for (;;) {
      ri += dir;
      if (ri < 0 || ri >= rows.length) {
        ci += dir;
        if (ci < 0 || ci >= columns.length) return null;
        ri = dir > 0 ? 0 : rows.length - 1;
      }
      if (qualifies(rows[ri], columns[ci].name, skip)) return { line: rows[ri].line, column: columns[ci].name };
    }
  }

  // "Issue 3 of 52" for the selected cell.
  const position = $derived.by(() => {
    if (!selected) return null;
    let total = 0;
    let index = 0;
    for (const c of columns) {
      for (const r of rows) {
        if (!qualifies(r, c.name)) continue;
        total++;
        if (r.line === selected.line && c.name === selected.column) index = total;
      }
    }
    return { index, total };
  });

  async function go(target) {
    if (!target) return;
    selected = target;
    const ri = rows.findIndex((r) => r.line === target.line);
    if (ri < 0 || !scroller) return;
    const top = ri * rowH;
    if (top < scroller.scrollTop || top + rowH > scroller.scrollTop + scroller.clientHeight - headH) {
      scroller.scrollTop = Math.max(0, top - rowH * 3);
      scrollTop = scroller.scrollTop;
    }
    await tick();
    scroller.querySelector(`[data-cell="${CSS.escape(`${target.line}|${target.column}`)}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  const next = () => go(selected && findFrom(selected.line, selected.column, 1));
  const prev = () => go(selected && findFrom(selected.line, selected.column, -1));

  // Bulk selection: Shift+click selects the rectangle from the last clicked
  // cell, Cmd/Ctrl+click toggles single cells. Only issue cells (and already
  // marked ones, for undo) are acted on.
  let bulk = $state(new Set()); // "line|column"
  let anchor = $state(null);    // { line, column }
  let menuCol = $state('');     // column whose ⋯ menu is open

  // "Which" filter for bulk and column actions: by severity or by the kind
  // of difference (missing in repository / value differs / only in repository).
  const TYPES = [
    ['all', 'All issues'],
    ['error', '✕ Mismatches'],
    ['warn', '! Term / date differs'],
    ['missing', 'Missing in repository'],
    ['changed', 'Value differs'],
    ['extra', 'Only in repository'],
  ];
  let bulkType = $state('all');
  let menuType = $state('all');
  function matchesType(cell, t) {
    if (t === 'all') return true;
    const base = cell.flagged || cell.resolved || cell.status;
    if (t === 'error' || t === 'warn') return base === t;
    return differenceTypes(cell)[t];
  }

  const isActionable = (cell) => !!cell && (cell.resolved || cell.flagged || ['error', 'warn'].includes(cell.status));
  const bulkItems = $derived([...bulk].map((k) => {
    const i = k.indexOf('|');
    const row = byLine.get(Number(k.slice(0, i)));
    const name = k.slice(i + 1);
    return row && isActionable(row.cells[name]) ? { row, name, cell: row.cells[name] } : null;
  }).filter(Boolean));
  const bulkTyped = $derived(bulkItems.filter((x) => matchesType(x.cell, bulkType)));
  const bulkOpen = $derived(bulkTyped.filter((x) => !x.cell.resolved && !x.cell.flagged));
  const bulkMarked = $derived(bulkTyped.filter((x) => x.cell.resolved || x.cell.flagged));
  const typeCounts = (items) => Object.fromEntries(TYPES.map(([t]) => [t, items.filter((x) => matchesType(x.cell, t)).length]));

  function cellClick(e, row, name) {
    const here = { line: row.line, column: name };
    if (e.shiftKey && anchor) {
      const r0 = rows.findIndex((r) => r.line === anchor.line);
      const r1 = rows.findIndex((r) => r.line === row.line);
      const c0 = columns.findIndex((c) => c.name === anchor.column);
      const c1 = columns.findIndex((c) => c.name === name);
      if (r0 < 0 || c0 < 0) { bulk = new Set([`${row.line}|${name}`]); anchor = here; return; }
      const next = new Set(e.metaKey || e.ctrlKey ? bulk : []);
      for (let ri = Math.min(r0, r1); ri <= Math.max(r0, r1); ri++) {
        for (let ci = Math.min(c0, c1); ci <= Math.max(c0, c1); ci++) {
          if (isActionable(rows[ri].cells[columns[ci].name])) next.add(`${rows[ri].line}|${columns[ci].name}`);
        }
      }
      bulk = next;
      selected = null;
    }
    else if (e.metaKey || e.ctrlKey) {
      const k = `${row.line}|${name}`;
      const next = new Set(bulk);
      if (next.has(k)) next.delete(k); else next.add(k);
      bulk = next;
      anchor = here;
      selected = null;
    }
    else {
      bulk = new Set();
      anchor = here;
      selected = here;
    }
  }

  function bulkMark(kind, items = kind ? bulkOpen : bulkMarked) {
    if (!items.length) return;
    touch(items.map(({ row, name }) => [row.line, name]));
    onmarkmany(kind, items.map(({ row, name, cell }) => ({ row, name, cell })));
    bulk = new Set();
  }

  // Issue (or marked) cells of one column, across every row that passes the
  // content-type filter and search. The status filters are ignored on
  // purpose: they hide rows whose issues are already marked, and "undo the
  // whole column" has to reach those too.
  const columnScope = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return result.rows.filter((r) => (!typeFilter || r.bundle === typeFilter)
      && (!q || `${r.identifier} ${r.title}`.toLowerCase().includes(q)));
  });
  function columnItems(name, which, type = menuType) {
    return columnScope.map((row) => ({ row, name, cell: row.cells[name] }))
      .filter(({ cell }) => isActionable(cell) && matchesType(cell, type)
        && (which === 'marked' ? (cell.resolved || cell.flagged) : which === 'any' || !(cell.resolved || cell.flagged)));
  }
  function columnAction(name, action) {
    menuCol = '';
    if (action === 'select') { bulk = new Set(columnItems(name, 'open').map(({ row }) => `${row.line}|${name}`)); return; }
    const items = columnItems(name, action === 'undo' ? 'marked' : 'open');
    touch(items.map(({ row }) => [row.line, name]));
    onmarkmany(action === 'undo' ? null : action, items);
  }

  function bulkKeys(e) {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && !e.target.closest?.('input, select, textarea')) {
      if (undoLabel) { undo(); e.preventDefault(); }
      return;
    }
    if (selected || !bulk.size || e.target.closest?.('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'r') bulkMark('resolved');
    else if (k === 'f') bulkMark('problem');
    else if (k === 'u') bulkMark(null);
    else if (e.key === 'Escape') bulk = new Set();
    else return;
    e.preventDefault();
  }

  // Mark (resolved or problem), then jump to the next issue the mark did not cover.
  let onlyThisRow = $state(false);
  function markAndAdvance(kind, scope) {
    const row = selRow;
    const name = selCol.name;
    const cell = row.cells[name];
    const sig = JSON.stringify(difference(cell));
    const covered = scope === 'all'
      ? (r, n, c) => n === name && JSON.stringify(difference(c)) === sig
      : (r, n) => r.line === row.line && n === name;
    const target = autoAdvance ? findFrom(row.line, name, 1, covered) : null;
    touch([[row.line, name]]);
    onmark(kind, row, name, cell, scope);
    if (target) go(target);
  }

  function markRowAndAdvance(kind) {
    const row = selRow;
    const target = kind && autoAdvance ? findFrom(row.line, selCol.name, 1, (r) => r.line === row.line) : null;
    touch([[row.line, selCol.name]]);
    onmarkrow(kind, row);
    if (target) go(target);
  }
  // Selection by row line + column name, so it survives re-runs and resolve toggles.
  let selected = $state(null); // { line, column }

  const idColumn = $derived(result.columns.find((c) => c.role === 'identifier'));
  const colStats = $derived(result.stats.columns);
  const issues = (name) => colStats[name].error + colStats[name].warn;

  const columns = $derived(result.columns.filter((c) => c.role !== 'identifier'
    && (!problemColumnsOnly || issues(c.name) > 0)));

  const rows = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return result.rows.filter((r) => {
      // Rows marked this session stay listed so Previous can return to them.
      const kept = touchedLines.has(r.line);
      if (filter === 'problems' && r.status === 'ok' && !kept && !(showResolved && hasResolved(r))) return false;
      if (filter === 'errors' && r.status !== 'error' && !kept) return false;
      if (filter === 'missing' && (r.nodes.length || r.lookupFailed || r.rowFlagged || (r.rowResolved && !showResolved))) return false;
      if (typeFilter && r.bundle !== typeFilter) return false;
      if (kinds.length) {
        const names = focusColumn ? [focusColumn] : columns.map((c) => c.name);
        const rowLevel = (kinds.includes('problem') && r.rowFlagged) || (kinds.includes('resolved') && r.rowResolved);
        if (!rowLevel && !names.some((n) => r.cells[n] && kinds.includes(kindOf(r.cells[n])))) return false;
      }
      else if (focusColumn && !['error', 'warn'].includes(r.cells[focusColumn]?.status)) return false;
      if (q && !`${r.identifier} ${r.title}`.toLowerCase().includes(q)) return false;
      return true;
    });
  });
  const windowSize = $derived(Math.ceil(viewH / rowH) + 2 * OVERSCAN);
  const start = $derived(Math.min(
    Math.max(0, Math.floor((scrollTop - headH) / rowH) - OVERSCAN),
    Math.max(0, rows.length - windowSize),
  ));
  const end = $derived(Math.min(rows.length, start + windowSize));
  const visible = $derived(rows.slice(start, end));

  $effect(() => {
    visible;
    const tr = scroller?.querySelector('tbody tr:not(.spacer)');
    if (tr?.offsetHeight && tr.offsetHeight !== rowH) rowH = tr.offsetHeight;
  });

  const byLine = $derived(new Map(result.rows.map((r) => [r.line, r])));
  const selRow = $derived(selected ? byLine.get(selected.line) : null);
  const selCol = $derived(selected ? result.columns.find((c) => c.name === selected.column) : null);
  const typesPresent = $derived(Object.keys(result.stats.byBundle));

  function hasResolved(r) {
    return r.rowResolved || Object.values(r.cells).some((c) => c.resolved);
  }

  // Any filter change goes back to the top.
  $effect(() => {
    filter; query; focusColumn; typeFilter; kinds;
    if (scroller) scroller.scrollTop = 0;
    scrollTop = 0;
  });

  const counts = $derived({
    all: result.rows.length,
    problems: result.rows.filter((r) => r.status !== 'ok').length,
    errors: result.rows.filter((r) => r.status === 'error').length,
    missing: result.rows.filter((r) => !r.nodes.length && !r.lookupFailed && !r.rowResolved && !r.rowFlagged).length,
  });

  function text(cell) {
    if (cell.sheet.length) return cell.sheet.join(' | ');
    if (cell.server.length) return cell.server.join(' | ');
    return '';
  }

  // Cells of each kind across the visible columns (resolved only counts when shown).
  const kindCounts = $derived.by(() => {
    const n = { error: 0, warn: 0, info: 0, skip: 0, resolved: 0, problem: 0 };
    for (const r of result.rows) for (const c of columns) { const cell = r.cells[c.name]; if (cell) n[kindOf(cell)]++; }
    return n;
  });

  function toggleKind(k) {
    kinds = kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k];
    if (kinds.length) filter = 'all';
    if (k === 'resolved' && kinds.includes(k)) showResolved = true;
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
    {#if typesPresent.length > 1}
      <select bind:value={typeFilter} aria-label="Content type">
        <option value="">All content types</option>
        {#each typesPresent as b}<option value={b}>{bundles[b]?.label ?? b} ({result.stats.byBundle[b]})</option>{/each}
      </select>
    {/if}
    <label class="check"><input type="checkbox" bind:checked={problemColumnsOnly} /> Only columns with issues</label>
    <label class="check"><input type="checkbox" bind:checked={showResolved} /> Show resolved{result.resolvedCount ? ` (${result.resolvedCount})` : ''}</label>
    {#if undoLabel}
      <button class="btn secondary undo" onclick={undo} title="Undo: {undoLabel} (Ctrl/Cmd+Z)">↶ Undo</button>
    {/if}
    <span class="muted shown">{rows.length.toLocaleString()} rows</span>
  </div>

  {#if focusColumn}
    <p class="focus">
      Showing rows with an issue in <code>{focusColumn}</code>.
      <button class="link" onclick={() => (focusColumn = '')}>Clear</button>
    </p>
  {/if}

  <div class="legend muted" role="group" aria-label="Show rows with cells of kind">
    {#each KINDS as [k, label]}
      <button class="sw {k}" class:on={kinds.includes(k)} class:off={kinds.length && !kinds.includes(k)}
        aria-pressed={kinds.includes(k)} onclick={() => toggleKind(k)} title="Show only rows with {label.replace(/^\S+ /, '')} cells">
        {label} <span class="n">{kindCounts[k].toLocaleString()}</span>
      </button>
    {/each}
    {#if kinds.length}<button class="link" onclick={() => (kinds = [])}>Clear</button>{/if}
    <span>Click a cell to compare values and mark it resolved.</span>
  </div>

  {#if !rows.length}
    <p class="empty">{filter === 'problems' && !query && !focusColumn ? 'Every row matches the repository.' : 'No rows match this filter.'}</p>
  {:else}
    <div class="scroll" tabindex="-1" style:--row-h="{rowH}px" bind:this={scroller} bind:clientHeight={viewH} onscroll={(e) => (scrollTop = e.currentTarget.scrollTop)}>
      <table>
        <thead bind:offsetHeight={headH}>
          <tr>
            <th class="sticky c-line" scope="col">Row</th>
            <th class="sticky c-id" scope="col">{idColumn?.name ?? 'Identifier'}</th>
            <th class="c-type" scope="col">Content type</th>
            {#each columns as col (col.name)}
              {@const st = colStats[col.name]}
              <th scope="col" class:unknown={col.role === 'unknown' || col.role === 'workbench'} class:focused={focusColumn === col.name}>
                <div class="h-top">
                  <div class="h-name">{col.name}</div>
                  {#if col.role !== 'unknown' && col.role !== 'workbench'}
                    <button class="h-menu-btn" aria-label="Actions for column {col.name}" aria-expanded={menuCol === col.name}
                      onclick={() => (menuCol = menuCol === col.name ? '' : col.name)}>⋯</button>
                  {/if}
                </div>
                {#if menuCol === col.name}
                  {@const open = columnItems(col.name, 'open').length}
                  {@const done = columnItems(col.name, 'marked').length}
                  {@const counts = typeCounts(columnItems(col.name, 'open', 'all'))}
                  <div class="h-menu" role="menu">
                    <label class="which">Only
                      <select bind:value={menuType} aria-label="Which issues in column {col.name}">
                        {#each TYPES as [t, label]}<option value={t}>{label} ({counts[t]})</option>{/each}
                      </select>
                    </label>
                    <button role="menuitem" disabled={!open} onclick={() => columnAction(col.name, 'resolved')}>✓ Resolve all {open} issue{open === 1 ? '' : 's'} in this column</button>
                    <button role="menuitem" disabled={!open} onclick={() => columnAction(col.name, 'problem')}>⚑ Mark all {open} as problems</button>
                    <button role="menuitem" disabled={!open} onclick={() => columnAction(col.name, 'select')}>Select these {open} for review</button>
                    <button role="menuitem" disabled={!done} onclick={() => columnAction(col.name, 'undo')}>Undo {done} mark{done === 1 ? '' : 's'} in this column</button>
                    <p class="muted">All rows{typeFilter || query.trim() ? ' matching the type filter / search' : ''}, including ones hidden by the status filters.</p>
                  </div>
                {/if}
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
          {#if start > 0}<tr class="spacer" aria-hidden="true"><td colspan={columns.length + 3} style:height="{start * rowH}px"></td></tr>{/if}
          {#each visible as row (row.line)}
            {@const idCell = row.cells[idColumn.name]}
            <tr class="r-{row.status}">
              <td class="sticky c-line num">{row.line}</td>
              <td class="sticky c-id {row.nodes.length === 1 || row.rowResolved ? '' : row.lookupFailed ? 'warn' : 'error'}" class:resolved={row.rowResolved && showResolved}>
                <button class="cell-btn" class:selected={selected?.line === row.line && selected?.column === idColumn.name}
                  onclick={() => (selected = { line: row.line, column: idColumn.name })}>
                  <span class="ident">{row.identifier || '(blank)'}</span>
                  {#if row.rowFlagged}<span class="pill problem">⚑ problem</span>
                  {:else if row.rowResolved}<span class="pill skip">✓ resolved</span>
                  {:else if row.lookupFailed}<span class="pill warn">not checked</span>
                  {:else if !row.nodes.length}<span class="pill error">not found</span>
                  {:else if row.nodes.length > 1}<span class="pill error">{row.nodes.length} nodes</span>
                  {:else if row.status === 'ok'}<span class="pill ok">✓</span>
                  {/if}
                </button>
                {#each row.nodes as n}
                  <a class="node" href="{nodeBase}{n.nid}" target="_blank" rel="noopener" title={n.title}>node/{n.nid}</a>
                {/each}
              </td>
              <td class="c-type"><span class="type">{row.bundle ? (bundles[row.bundle]?.label ?? row.bundle) : '—'}</span></td>
              {#each columns as col (col.name)}
                {@const cell = row.cells[col.name]}
                <td data-cell="{row.line}|{col.name}" class="c {cell.status}" class:focused={focusColumn === col.name}
                  class:bulk={bulk.has(`${row.line}|${col.name}`)} class:resolved={cell.resolved && showResolved}
                  class:flagged={cell.flagged && kinds.includes('problem')}
                  class:dim={kinds.length && !kinds.includes(kindOf(cell))}>
                  <button class="cell-btn" class:selected={selected?.line === row.line && selected?.column === col.name}
                    title="{cell.resolved ? 'Marked resolved' : STATUS_LABEL[cell.status]}{cell.note ? ` — ${cell.note}` : ''}"
                    onclick={(e) => cellClick(e, row, col.name)}>
                    {#if cell.flagged && kinds.includes('problem')}<span class="glyph" aria-hidden="true">⚑</span>
                    {:else if cell.resolved && showResolved}<span class="glyph" aria-hidden="true">✓</span>
                    {:else if GLYPH[cell.status]}<span class="glyph" aria-hidden="true">{GLYPH[cell.status]}</span>{/if}
                    <span class="sr">{cell.resolved ? 'Marked resolved' : STATUS_LABEL[cell.status]}:</span>
                    <span class="val" class:from-server={!cell.sheet.length && cell.server.length}>{text(cell)}</span>
                  </button>
                </td>
              {/each}
            </tr>
          {/each}
          {#if end < rows.length}<tr class="spacer" aria-hidden="true"><td colspan={columns.length + 3} style:height="{(rows.length - end) * rowH}px"></td></tr>{/if}
        </tbody>
      </table>
    </div>

  {/if}
</section>

<svelte:window onkeydown={bulkKeys} onclick={(e) => { if (menuCol && !e.target.closest?.('.h-menu, .h-menu-btn')) menuCol = ''; }} />

{#if bulk.size}
  <div class="bulkbar" role="region" aria-label="Bulk actions">
    <strong>{bulkItems.length} selected</strong>
    <label class="which">Only
      <select bind:value={bulkType} aria-label="Which selected issues">
        {#each Object.entries(typeCounts(bulkItems.filter((x) => !x.cell.resolved && !x.cell.flagged))) as [t, n]}
          <option value={t}>{TYPES.find((x) => x[0] === t)[1]} ({n})</option>
        {/each}
      </select>
    </label>
    <span class="muted">{bulkOpen.length} open{bulkMarked.length ? ` · ${bulkMarked.length} already marked` : ''}</span>
    <button class="btn" disabled={!bulkOpen.length} onclick={() => bulkMark('resolved')}>✓ Resolve {bulkOpen.length}</button>
    <button class="btn problem" disabled={!bulkOpen.length} onclick={() => bulkMark('problem')}>⚑ Problem {bulkOpen.length}</button>
    <button class="btn secondary" disabled={!bulkMarked.length} onclick={() => bulkMark(null)}>Undo {bulkMarked.length}</button>
    <button class="btn secondary" onclick={() => (bulk = new Set())}>Clear</button>
    {#if undoLabel}<button class="btn secondary" onclick={undo} title="Undo: {undoLabel}">↶ Undo last</button>{/if}
    <span class="keys muted"><kbd>R</kbd> resolve · <kbd>F</kbd> problem · <kbd>U</kbd> undo · <kbd>Esc</kbd> clear</span>
  </div>
{/if}

{#if selRow && selCol}
  <CellDetail row={selRow} column={selCol} {nodeBase} onclose={() => (selected = null)}
    groupSize={groupSize(selCol.name, selRow.cells[selCol.name])}
    onmark={markAndAdvance} onmarkrow={markRowAndAdvance} {position} onnext={next} onprev={prev} bind:autoAdvance bind:onlyThisRow
    onundolast={undo} {undoLabel}
    onunmark={() => onunmark(selRow, selCol.name, selRow.cells[selCol.name])} />
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
  .sw { font: inherit; padding: 0.15em 0.55em; border-radius: 4px; border: 1px solid transparent; cursor: pointer; }
  .sw .n { font-variant-numeric: tabular-nums; opacity: 0.7; margin-left: 0.15em; }
  .sw.on { box-shadow: 0 0 0 2px var(--ia-accent); font-weight: 600; }
  .sw.off { opacity: 0.45; }
  .sw:focus-visible { outline: 2px solid var(--ia-accent); outline-offset: 1px; }
  td.dim { opacity: 0.35; }
  td.bulk { box-shadow: inset 0 0 0 2px var(--ia-accent); background-image: linear-gradient(rgb(0 62 204 / 0.08), rgb(0 62 204 / 0.08)); }
  .cell-btn { user-select: none; }
  .h-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.25rem; }
  .h-menu-btn { font: inherit; line-height: 1; padding: 0 0.3rem; border: 0; border-radius: 4px; background: none; color: var(--ia-muted); cursor: pointer; }
  .h-menu-btn:hover, .h-menu-btn[aria-expanded='true'] { background: #e9e9ee; color: inherit; }
  .h-menu {
    position: absolute; z-index: 20; margin-top: 0.25rem; min-width: 17rem;
    display: flex; flex-direction: column; padding: 0.3rem; font-weight: 400;
    background: var(--ia-surface); border: 1px solid var(--ia-border); border-radius: 8px; box-shadow: 0 8px 24px rgb(0 0 0 / 0.15);
  }
  .h-menu button { font: inherit; text-align: left; padding: 0.4rem 0.6rem; border: 0; border-radius: 5px; background: none; cursor: pointer; white-space: nowrap; }
  .h-menu button:hover:not(:disabled) { background: var(--ia-subtle); }
  .h-menu button:disabled { color: var(--ia-skip); cursor: default; }
  .which { display: flex; gap: 0.4rem; align-items: center; font-size: 0.8rem; color: var(--ia-muted); padding: 0.2rem 0.6rem 0.4rem; }
  .which select { font: inherit; color: var(--ia-text, inherit); padding: 0.2em 0.35em; border: 1px solid var(--ia-border); border-radius: 5px; }
  .bulkbar .which { padding: 0; }
  .h-menu p { margin: 0.25rem 0.6rem 0.15rem; font-size: 0.75rem; hyphens: manual; white-space: normal; max-width: 17rem; }
  .bulkbar {
    position: fixed; z-index: 500; left: 50%; bottom: 1rem; transform: translateX(-50%);
    display: flex; flex-wrap: wrap; gap: 0.5rem 0.75rem; align-items: center; max-width: calc(100vw - 2rem);
    padding: 0.6rem 0.9rem; background: var(--ia-surface); border: 1px solid var(--ia-border); border-radius: 10px;
    box-shadow: 0 12px 32px rgb(0 0 0 / 0.18); font-size: 0.875rem;
  }
  .bulkbar .btn { padding: 0.3em 0.8em; font-size: 0.85rem; }
  .bulkbar .btn.problem { background: #6b3fa0; border-color: #6b3fa0; }
  .bulkbar .keys { font-size: 0.75rem; }
  .bulkbar kbd { font: inherit; font-size: 0.7rem; padding: 0 0.3em; border: 1px solid var(--ia-border); border-bottom-width: 2px; border-radius: 3px; background: var(--ia-subtle); }
  .sw.problem, td.flagged { background: #f3ecfb !important; color: #6b3fa0 !important; }
  .sw.problem { border-color: #d8c6ef; }
  .pill.problem { background: #f3ecfb; color: #6b3fa0; }
  /* Keep a cell revealed by Previous/Next clear of the sticky columns and header. */
  td.c { scroll-margin-left: 21rem; scroll-margin-top: 6rem; }
  .sw.error { background: var(--ia-error-bg); color: var(--ia-error); border-color: var(--ia-error-line); }
  .sw.warn { background: var(--ia-warn-bg); color: var(--ia-warn); border-color: var(--ia-warn-line); }
  .sw.info { background: var(--ia-info-bg); color: var(--ia-info); }
  .sw.skip { background: var(--ia-skip-bg); color: var(--ia-skip); }
  .empty { padding: 2rem; text-align: center; color: var(--ia-ok); font-weight: 600; background: var(--ia-ok-bg); border-radius: 8px; }

  .scroll { overflow: auto; overflow-anchor: none; max-height: 70vh; border: 1px solid var(--ia-border); border-radius: 6px; }
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
  .c-id { left: 3.2rem; min-width: 17rem; max-width: 22rem; box-shadow: 2px 0 0 #e4e4e7; }
  td.c-line { padding: 0.4rem 0.5rem; color: var(--ia-muted); text-align: right; }
  .num { font-variant-numeric: tabular-nums; }
  td.c-id .ident { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8rem; }
  .node { font-size: 0.75rem; padding: 0 0.6rem 0 0.1rem; }
  .c-type { min-width: 9rem; white-space: nowrap; }
  td.c-type { padding: 0 0.6rem; vertical-align: middle; }
  .type { font-size: 0.75rem; color: var(--ia-muted); }
  .sw.resolved, td.resolved { background: #eef7f1 !important; color: #3d7a52 !important; }
  td.resolved .val { text-decoration: line-through; text-decoration-color: #9cc9ab; }
  td.c-id { white-space: nowrap; overflow: hidden; }
  td.c-id .cell-btn { display: inline-flex; width: auto; max-width: calc(100% - 5.5rem); vertical-align: middle; }
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
  .btn.undo { padding: 0.3em 0.8em; font-size: 0.85rem; }
</style>
