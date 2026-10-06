<script>
  let {
    row, column, nodeBase, onclose, onresolve, onunresolve, ontogglerow, groupSize = 1,
    position = null, onnext, onprev, autoAdvance = $bindable(true),
  } = $props();

  const LABEL = { ok: 'Matches', info: 'Only in the repository', warn: 'Differs — check it', error: 'Mismatch', skip: 'Not compared' };
  const cell = $derived(row.cells[column.name]);
  const isRowIssue = $derived(column.role === 'identifier' && (row.noteStatus !== 'ok'));
  const cellIssue = $derived(!!cell.resolved || ['error', 'warn'].includes(cell.status));
  const missing = $derived(new Set(cell.missing));
  const extra = $derived(new Set(cell.extra));

  // Keyboard: N / → next, P / ← previous, R resolve (all identical when
  // there are any), Shift+R this row only, U unresolve, Esc close.
  function keydown(e) {
    if (e.target.closest?.('input, select, textarea, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (e.key === 'Escape') onclose();
    else if (k === 'n' || e.key === 'ArrowRight') onnext?.();
    else if (k === 'p' || e.key === 'ArrowLeft') onprev?.();
    else if (k === 'r' && cellIssue && !cell.resolved) onresolve(e.shiftKey || groupSize < 2 ? 'one' : 'all');
    else if (k === 'u' && cell.resolved) onunresolve();
    else return;
    e.preventDefault();
  }
</script>

<svelte:window onkeydown={keydown} />

<aside class="detail" aria-label="Cell details">
  <header>
    <div>
      <div class="where">
        Row {row.line} · <code>{row.identifier || '(blank)'}</code> · <code>{column.name}</code>
        {#if column.label && column.role !== 'unknown'}<span class="muted">({column.label})</span>{/if}
      </div>
      <div class="status">
        {#if cell.resolved}<span class="pill skip">✓ Marked resolved{cell.resolvedBy === 'value' && groupSize > 1 ? ` with ${groupSize - 1} identical` : ''} (was: {LABEL[cell.resolved]})</span>
        {:else}<span class="pill {cell.status}">{LABEL[cell.status]}</span>{/if}
        {#if cell.note}<span>{cell.note}</span>{/if}
      </div>
    </div>
    <div class="acts">
      {#if isRowIssue}
        <button class="btn secondary" onclick={ontogglerow}>{row.rowResolved ? 'Unresolve row' : 'Mark row resolved'}</button>
      {:else if cell.resolved}
        <button class="btn secondary" onclick={onunresolve}>
          {cell.resolvedBy === 'value' && groupSize > 1 ? `Unresolve all ${groupSize}` : 'Unresolve'}
        </button>
      {:else if cellIssue}
        {#if groupSize > 1}
          <button class="btn" onclick={() => onresolve('all')} title="Same column, same file value and same repository value">Mark all {groupSize} identical resolved</button>
          <button class="btn secondary" onclick={() => onresolve('one')}>Only this row</button>
        {:else}
          <button class="btn secondary" onclick={() => onresolve('one')}>Mark resolved</button>
        {/if}
      {/if}
      <button class="close" onclick={onclose} aria-label="Close details">×</button>
    </div>
  </header>

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
  {#if cell.missing.length || cell.extra.length}
    <p class="key muted"><span class="missing">Red</span>: in the file only. <span class="extra">Blue</span>: in the repository only.</p>
  {/if}

  <footer>
    <button class="btn secondary" onclick={onprev} disabled={!position?.total} aria-label="Previous issue">← Previous</button>
    <span class="pos muted">
      {#if position?.index}Issue {position.index} of {position.total}{:else if position?.total}{position.total} issues{:else}No issues in view{/if}
    </span>
    <button class="btn secondary" onclick={onnext} disabled={!position?.total} aria-label="Next issue">Next →</button>
    <label class="auto"><input type="checkbox" bind:checked={autoAdvance} /> Go to next after resolving</label>
    <span class="keys muted"><kbd>N</kbd>/<kbd>P</kbd> next/prev · <kbd>R</kbd> resolve · <kbd>⇧R</kbd> this row · <kbd>U</kbd> undo · <kbd>Esc</kbd></span>
  </footer>
</aside>

<style>
  .detail {
    position: fixed; z-index: 500; right: 1rem; bottom: 1rem;
    width: min(46rem, calc(100vw - 2rem)); max-height: 45vh; overflow: auto;
    background: var(--ia-surface); border: 1px solid var(--ia-border); border-radius: 10px;
    box-shadow: 0 12px 32px rgb(0 0 0 / 0.18); padding: 1rem 1.25rem;
  }
  header { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0.75rem 1rem; align-items: flex-start; }
  header > div:first-child { flex: 1 1 22rem; min-width: 0; }
  .detail { hyphens: manual; }
  .where { font-size: 0.85rem; }
  .status { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin-top: 0.35rem; }
  .acts { display: flex; gap: 0.5rem; align-items: center; flex: none; margin-left: auto; }
  .acts .btn { padding: 0.35em 0.8em; font-size: 0.85rem; }
  .close { font-size: 1.5rem; line-height: 1; background: none; border: 0; cursor: pointer; color: var(--ia-muted); }
  .notes { margin: 0.75rem 0 0; color: var(--ia-error); }
  .sides { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-top: 0.75rem; }
  h3 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ia-muted); margin: 0 0 0.35rem; display: flex; gap: 0.5rem; align-items: baseline; }
  h3 a { text-transform: none; letter-spacing: 0; font-weight: 400; }
  ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 0.3rem; }
  li { background: var(--ia-subtle); border-radius: 4px; padding: 0.3rem 0.5rem; white-space: pre-wrap; word-break: break-word; }
  li.missing, span.missing { background: var(--ia-error-bg); color: var(--ia-error); }
  li.extra, span.extra { background: var(--ia-info-bg); color: var(--ia-info); }
  span.missing, span.extra { padding: 0 0.3em; border-radius: 3px; }
  .key { font-size: 0.8rem; margin: 0.6rem 0 0; }
  footer { display: flex; flex-wrap: wrap; gap: 0.5rem 0.75rem; align-items: center; margin-top: 0.9rem; padding-top: 0.75rem; border-top: 1px solid var(--ia-border); }
  footer .btn { padding: 0.3em 0.8em; font-size: 0.85rem; }
  .pos { font-size: 0.85rem; font-variant-numeric: tabular-nums; min-width: 7.5rem; text-align: center; }
  .auto { display: inline-flex; gap: 0.35rem; align-items: center; font-size: 0.85rem; }
  .keys { font-size: 0.75rem; margin-left: auto; }
  kbd { font: inherit; font-size: 0.7rem; padding: 0 0.3em; border: 1px solid var(--ia-border); border-bottom-width: 2px; border-radius: 3px; background: var(--ia-subtle); }
  @media (max-width: 640px) { .sides { grid-template-columns: 1fr; } }
</style>
