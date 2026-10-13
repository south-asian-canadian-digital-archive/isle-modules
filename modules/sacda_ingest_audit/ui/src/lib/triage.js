// AI triage: an optional second opinion on the differences still open.
//
// Only distinct differences are sent (grouped exactly like review marks, see
// resolved.js), and only the values that did not match, so a column with the
// same renamed subject on 40 rows is one question. The server holds the API
// key and does the asking; nothing is applied here. Suggestions are advice the
// reviewer accepts or ignores.
import { OK, INFO, SKIP } from './compare.js';
import { colSpec, valueKey } from './resolved.js';

const STORE = 'sacdaIngestAudit.ai';
const CAP = 5000;
export const CHUNK = 40;
export const VERDICTS = { same: 'same meaning', problem: 'real problem', unsure: 'unsure' };

const isOpen = (cell) => cell.status !== OK && cell.status !== SKIP && cell.status !== INFO;

/**
 * Distinct open differences in an applied result (marked cells already read
 * as OK there, so they are left out), most widespread first.
 */
export function openDifferences(view) {
  const idName = view.columns.find((c) => c.role === 'identifier')?.name;
  const groups = new Map();
  for (const row of view.rows) {
    for (const column of view.columns) {
      const cell = row.cells[column.name];
      if (!cell || column.name === idName || !isOpen(cell)) continue;
      const id = valueKey(colSpec(column), cell);
      const g = groups.get(id);
      if (g) { g.count++; continue; }
      const listed = cell.missing?.length || cell.extra?.length;
      groups.set(id, {
        id,
        column: column.name,
        field: column.target ?? '',
        type: column.kind ?? column.role ?? '',
        note: cell.note ?? '',
        missing: listed ? [...(cell.missing ?? [])].sort() : cell.sheet,
        extra: listed ? [...(cell.extra ?? [])].sort() : cell.server,
        count: 1,
      });
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

export function load() {
  try { return new Map(JSON.parse(localStorage.getItem(STORE) ?? '[]')); } catch { return new Map(); }
}

export function save(map) {
  try { localStorage.setItem(STORE, JSON.stringify([...map].slice(-CAP))); } catch { /* storage unavailable */ }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Ask for an opinion on each item, a chunk at a time. `onChunk(results, done)`
 * fires after every chunk so suggestions appear as they arrive. Throws with a
 * readable message if a chunk fails; what arrived before it is kept.
 */
export async function requestTriage(endpoint, items, onChunk, { fetchFn = fetch, pause = wait } = {}) {
  let done = 0;
  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK);
    let body;
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await fetchFn(endpoint, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ items: chunk }),
        });
      }
      catch { throw new Error('The site could not be reached. Check your connection and try again.'); }
      body = await response.json().catch(() => null);
      if (response.ok && Array.isArray(body?.results)) break;
      // 503: the AI service is busy. Anything else will not fix itself.
      if (response.status === 503 && attempt < 2) { await pause(2000 * (attempt + 1)); continue; }
      throw new Error(body?.error ?? (response.status === 403 ? 'Your session has expired. Reload the page and try again.' : `AI triage failed (${response.status}).`));
    }
    done += chunk.length;
    onChunk(body.results.filter((r) => r.verdict in VERDICTS), done);
  }
}
