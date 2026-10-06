<script>
  let { extra, truncated, nodeBase } = $props();
</script>

<section class="card">
  <h2>In the repository, not in the file <span class="pill {extra.length ? 'warn' : 'ok'}">{extra.length}</span></h2>
  <p class="muted">
    Nodes under the rows (and parents) this file names, whose identifier does not appear in it: leftovers from an
    earlier ingest, stray duplicates, or rows dropped from the sheet.
  </p>
  {#if truncated}<p class="pill warn">Stopped after 5,000 nodes; the list is incomplete.</p>{/if}
  {#if extra.length}
    <table>
      <thead><tr><th>Identifier</th><th>Title</th><th>Type</th><th>Parent</th><th>Node</th></tr></thead>
      <tbody>
        {#each extra as n (n.uuid)}
          <tr>
            <td><code>{n.identifier || '(none)'}</code></td>
            <td>{n.title}</td>
            <td>{n.bundle}</td>
            <td>{n.parentLabels.join(', ')}</td>
            <td><a href="{nodeBase}{n.nid}" target="_blank" rel="noopener">node/{n.nid}</a></td>
          </tr>
        {/each}
      </tbody>
    </table>
  {:else}
    <p class="ok">Nothing extra: every node found under these parents is in the file.</p>
  {/if}
</section>

<style>
  h2 { display: flex; gap: 0.5rem; align-items: center; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid #ececef; }
  th { background: #f8f8fa; }
  .ok { color: var(--ia-ok); }
</style>
