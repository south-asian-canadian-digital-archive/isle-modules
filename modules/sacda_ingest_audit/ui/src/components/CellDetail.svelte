<script>
  let {
    row, column, nodeBase, onclose, onmark, onunmark, onmarkrow, groupSize = 1,
    position = null, onnext, onprev, autoAdvance = $bindable(true), onlyThisRow = $bindable(false),
    onundolast, undoLabel = '',
  } = $props();

  const LABEL = { ok: 'Matches', info: 'Only in the repository', warn: 'Differs — check it', error: 'Mismatch', skip: 'Not compared' };
  const cell = $derived(row.cells[column.name]);
  const isRowIssue = $derived(column.role === 'identifier' && (row.noteStatus !== 'ok'));
  const marked = $derived(!!(cell.resolved || cell.flagged));
  const rowMarked = $derived(!!(row.rowResolved || row.rowFlagged));
  const cellIssue = $derived(marked || ['error', 'warn'].includes(cell.status));
  const scope = $derived(onlyThisRow || groupSize < 2 ? 'one' : 'all');
  const canMark = $derived(isRowIssue ? !rowMarked : cellIssue && !marked);
  const canUnmark = $derived(isRowIssue ? rowMarked : marked);
  const canScope = $derived(!isRowIssue && groupSize > 1 && canMark);
  const missing = $derived(new Set(cell.missing));
  const extra = $derived(new Set(cell.extra));

  function mark(kind, shift = false) {
    if (isRowIssue) onmarkrow(kind);
    else if (cellIssue && !marked) onmark(kind, shift ? 'one' : scope);
  }
  function undo() {
    if (isRowIssue && rowMarked) onmarkrow(null);
    else if (marked) onunmark();
  }

  // Keyboard: N / → next, P / ← previous, R resolve, F mark as problem
  // (Shift = this row only), U undo, Esc close.
  function keydown(e) {
    if (e.target.closest?.('input, select, textarea, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (e.key === 'Escape') onclose();
    else if (k === 'n' || e.key === 'ArrowRight') onnext?.();
    else if (k === 'p' || e.key === 'ArrowLeft') onprev?.();
    else if (k === 'r') mark('resolved', e.shiftKey);
    else if (k === 'f') mark('problem', e.shiftKey);
    else if (k === 'u') undo();
    else return;
    e.preventDefault();
  }
</script>

<svelte:window onkeydown={keydown} />

<!-- Fixed layout: everything that changes with the cell lives in the
     scrolling body; the action bar is pinned to the bottom and always renders
     the same controls in the same places (disabled when they don't apply). -->
<aside class="detail" aria-label="Cell details">
  <div class="top">
    <div class="where">
      Row {row.line} · <code>{row.identifier || '(blank)'}</code> · <code>{column.name}</code>
      {#if column.label && column.role !== 'unknown'}<span class="muted">({column.label})</span>{/if}
    </div>
    <button class="close" onclick={onclose} aria-label="Close details">×</button>
  </div>
  <div class="hints muted">
    <span><span class="missing">Red</span> in the file only · <span class="extra">Blue</span> in the repository only</span>
    <span><kbd>N</kbd>/<kbd>P</kbd> next/prev · <kbd>R</kbd> resolve · <kbd>F</kbd> problem · <kbd>⇧</kbd> this row only · <kbd>U</kbd> unmark · <kbd>⌘Z</kbd> undo · <kbd>Esc</kbd></span>
  </div>

  <div class="body">
    <div class="status">
      {#if row.rowFlagged && isRowIssue}<span class="pill problem">⚑ Row marked as a problem (kept in the export)</span>
      {:else if row.rowResolved && isRowIssue}<span class="pill skip">✓ Row marked resolved</span>
      {:else if cell.flagged}<span class="pill problem">⚑ Marked as a problem{cell.flaggedBy === 'value' && groupSize > 1 ? ` with ${groupSize - 1} identical` : ''} (kept in the export)</span>
      {:else if cell.resolved}<span class="pill skip">✓ Marked resolved{cell.resolvedBy === 'value' && groupSize > 1 ? ` with ${groupSize - 1} identical` : ''} (was: {LABEL[cell.resolved]})</span>
      {:else if isRowIssue}<span class="pill {row.noteStatus}">{row.lookupFailed ? 'Not checked' : !row.nodes.length ? 'Not found' : row.nodes.length > 1 ? 'Duplicate identifier' : 'Duplicate in file'}</span>
      {:else}<span class="pill {cell.status}">{LABEL[cell.status]}</span>{/if}
      {#if cell.note && !isRowIssue}<span>{cell.note}</span>{/if}
    </div>

    {#if row.notes.length && column.role === 'identifier'}
      <ul class="notes">{#each row.notes as n}<li>{n}</li>{/each}</ul>
    {/if}

    <div class="sides">
      <div>
        <h3>In the file</h3>
        {#if cell.sheet.length}
          <ul>{#each cell.sheet as v}<li class:missing={missing.has(v)}>{v}</li>{/each}</ul>
        {:else}<p class="muted">(blank)</p>{/if}
      </div>
      <div>
        <h3>In the repository
          {#each row.nodes as n}<a href="{nodeBase}{n.nid}" target="_blank" rel="noopener">node/{n.nid}</a>{/each}
        </h3>
        {#if cell.server.length}
          <ul>{#each cell.server as v}<li class:extra={extra.has(v)}>{v}</li>{/each}</ul>
        {:else}<p class="muted">{row.nodes.length ? '(empty)' : 'No node with this identifier.'}</p>{/if}
      </div>
    </div>
  </div>

  <div class="bar">
    <div class="line">
      <label class="scope" class:off={!canScope} title="Same column and the same difference (file vs repository)">
        <input type="checkbox" disabled={!canScope} checked={canScope && !onlyThisRow} onchange={(e) => (onlyThisRow = !e.currentTarget.checked)} />
        all <span class="n">{groupSize > 1 ? groupSize : '–'}</span> identical
      </label>
      <button class="btn" disabled={!canMark} onclick={() => mark('resolved')}>✓ Resolve</button>
      <button class="btn problem" disabled={!canMark} onclick={() => mark('problem')} title="Hide from the view but keep it in the CSV export">⚑ Problem</button>
      <button class="btn secondary" disabled={!canUnmark} onclick={undo} title="Remove this cell's mark (or the whole group's, if it was marked with its identical ones)">Unmark</button>
      <button class="btn secondary right" disabled={!undoLabel} onclick={onundolast} title={undoLabel ? `Undo: ${undoLabel} (Ctrl/Cmd+Z)` : 'Nothing to undo'}>↶ Undo last</button>
    </div>
    <div class="line">
      <button class="btn secondary" onclick={onprev} disabled={!position?.total} aria-label="Previous issue">← Previous</button>
      <span class="pos muted">
        {#if position?.index}Issue {position.index} of {position.total}{:else if position?.total}{position.total} issues{:else}No issues in view{/if}
      </span>
      <button class="btn secondary" onclick={onnext} disabled={!position?.total} aria-label="Next issue">Next →</button>
      <label class="auto right"><input type="checkbox" bind:checked={autoAdvance} /> Go to next after marking</label>
    </div>
  </div>
</aside>

<style>
  .detail {
    position: fixed; z-index: 500; right: 1rem; bottom: 1rem;
    width: min(46rem, calc(100vw - 2rem)); height: min(26rem, 70vh);
    display: flex; flex-direction: column;
    background: var(--ia-surface); border: 1px solid var(--ia-border); border-radius: 10px;
    box-shadow: 0 12px 32px rgb(0 0 0 / 0.18); hyphens: manual;
  }
  .top { display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding: 0.7rem 1.1rem 0; }
  .where { font-size: 0.85rem; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hints { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0.2rem 1rem; font-size: 0.72rem; padding: 0.3rem 1.1rem 0.5rem; border-bottom: 1px solid #ececef; }
  .close { font-size: 1.5rem; line-height: 1; background: none; border: 0; cursor: pointer; color: var(--ia-muted); flex: none; }
  .body { flex: 1; min-height: 0; overflow: auto; padding: 0.7rem 1.1rem; }
  .status { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
  .pill.problem { background: #f3ecfb; color: #6b3fa0; }
  .notes { margin: 0.6rem 0 0; color: var(--ia-error); }
  .sides { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-top: 0.7rem; }
  h3 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ia-muted); margin: 0 0 0.35rem; display: flex; gap: 0.5rem; align-items: baseline; }
  h3 a { text-transform: none; letter-spacing: 0; font-weight: 400; }
  ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 0.3rem; }
  li { background: var(--ia-subtle); border-radius: 4px; padding: 0.3rem 0.5rem; white-space: pre-wrap; word-break: break-word; }
  li.missing, span.missing { background: var(--ia-error-bg); color: var(--ia-error); }
  li.extra, span.extra { background: var(--ia-info-bg); color: var(--ia-info); }
  span.missing, span.extra { padding: 0 0.3em; border-radius: 3px; }
  .bar { flex: none; display: flex; flex-direction: column; gap: 0.5rem; padding: 0.65rem 1.1rem 0.8rem; border-top: 1px solid var(--ia-border); background: #fafafb; border-radius: 0 0 10px 10px; }
  .line { display: flex; align-items: center; gap: 0.5rem; }
  .bar .btn { padding: 0.3em 0.8em; font-size: 0.85rem; white-space: nowrap; }
  .btn.problem { background: #6b3fa0; border-color: #6b3fa0; }
  .right { margin-left: auto; }
  .scope { display: inline-flex; gap: 0.3rem; align-items: center; font-size: 0.85rem; white-space: nowrap; width: 9.5rem; }
  .scope.off { color: var(--ia-skip); }
  .scope .n { display: inline-block; min-width: 2ch; text-align: center; font-variant-numeric: tabular-nums; }
  .pos { font-size: 0.85rem; font-variant-numeric: tabular-nums; width: 9rem; text-align: center; white-space: nowrap; }
  .auto { display: inline-flex; gap: 0.35rem; align-items: center; font-size: 0.85rem; white-space: nowrap; }
  kbd { font: inherit; font-size: 0.68rem; padding: 0 0.3em; border: 1px solid var(--ia-border); border-bottom-width: 2px; border-radius: 3px; background: var(--ia-subtle); }
  @media (max-width: 640px) { .sides { grid-template-columns: 1fr; } .line { flex-wrap: wrap; } }
</style>
