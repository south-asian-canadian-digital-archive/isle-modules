// AI triage: an optional second opinion on the differences still open.
//
// Only distinct differences are sent (grouped exactly like review marks, see
// resolved.js), and only the values that did not match, so a column with the
// same renamed subject on 40 rows is one question. The site only queues them:
// an AI agent on someone's own machine pulls the queue and posts verdicts
// back, and this page polls for them. Nothing is applied here; suggestions
// are advice the reviewer accepts or ignores.
import { OK, INFO, SKIP } from './compare.js';
import { colSpec, valueKey } from './resolved.js';

const STORE = 'sacdaIngestAudit.ai';
const CAP = 5000;
export const CHUNK = 500;
export const POLL_MS = 5000;
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

// Kept for two days, like the server's copy, so old answers get rechecked.
export const MAX_AGE_MS = 2 * 86400 * 1000;

export function load(now = Date.now()) {
  try {
    const entries = JSON.parse(localStorage.getItem(STORE) ?? '[]');
    return new Map(entries.filter(([, v]) => v?.at && now - v.at < MAX_AGE_MS));
  }
  catch { return new Map(); }
}

export function save(map) {
  try { localStorage.setItem(STORE, JSON.stringify([...map].slice(-CAP))); } catch { /* storage unavailable */ }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(endpoint, body, fetchFn) {
  let response;
  try {
    response = await fetchFn(endpoint, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
  }
  catch { throw new Error('The site could not be reached. Check your connection and try again.'); }
  const json = await response.json().catch(() => null);
  if (response.ok && Array.isArray(json?.results)) return json;
  throw new Error(json?.error ?? (response.status === 403 ? 'Your session has expired. Reload the page and try again.' : `AI triage failed (${response.status}).`));
}

/**
 * Queue the items, then poll until every one has a verdict or `stopped()`
 * says to give up. `onUpdate(results, waiting)` fires after every round, so
 * verdicts appear as the agent posts them. Throws with a readable message.
 */
export async function requestTriage(endpoint, items, onUpdate, { fetchFn = fetch, pause = wait, stopped = () => false } = {}) {
  let open = new Set(items.map((i) => i.id));
  const round = async (bodies) => {
    const got = [];
    for (const body of bodies) got.push(...(await post(endpoint, body, fetchFn)).results);
    const results = got.filter((r) => r.verdict in VERDICTS && open.has(r.id));
    for (const r of results) open.delete(r.id);
    onUpdate(results, open.size);
  };
  const chunks = (list, wrap) => Array.from({ length: Math.ceil(list.length / CHUNK) }, (_, i) => wrap(list.slice(i * CHUNK, (i + 1) * CHUNK)));
  await round(chunks(items, (c) => ({ items: c })));
  while (open.size && !stopped()) {
    await pause(POLL_MS);
    if (stopped()) break;
    await round(chunks([...open], (c) => ({ ids: c })));
  }
}
