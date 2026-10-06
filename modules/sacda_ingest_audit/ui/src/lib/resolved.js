// "Resolved" marks: a viewer hides an issue once they have dealt with it.
//
// A mark is keyed on the identifier, column AND both values, so it only
// hides that exact discrepancy: if either side changes later, the issue
// comes back. Stored in this browser only (localStorage), as a convenience.
import { summarise } from './audit.js';
import { OK, INFO, SKIP, SEVERITY } from './compare.js';

const STORE = 'sacdaIngestAudit.resolved';
const CAP = 20000;
export const ROW = '__row__';

export function cellKey(row, column, cell) {
  return JSON.stringify([row.identifier, column, cell.sheet, cell.server]);
}

export function rowKey(row) {
  return JSON.stringify([row.identifier, ROW, row.notes]);
}

export function load() {
  try { return new Set(JSON.parse(localStorage.getItem(STORE) ?? '[]')); } catch { return new Set(); }
}

export function save(set) {
  try { localStorage.setItem(STORE, JSON.stringify([...set].slice(-CAP))); } catch { /* storage unavailable */ }
}

const isIssue = (status) => status !== OK && status !== SKIP && status !== INFO;

/**
 * Apply resolved marks: resolved cells read as OK (flagged `resolved`), row
 * status and stats are recomputed. Returns a new result; the original is
 * untouched so un-resolving restores it exactly.
 */
export function applyResolved(result, marks) {
  let resolvedCount = 0;
  const idName = result.columns.find((c) => c.role === 'identifier')?.name;
  const rows = result.rows.map((row) => {
    const rowResolved = row.noteStatus !== OK && marks.has(rowKey(row));
    if (rowResolved) resolvedCount++;
    let status = rowResolved ? OK : row.noteStatus;
    let changed = rowResolved;
    const cells = {};
    for (const [name, cell] of Object.entries(row.cells)) {
      // The identifier cell just mirrors the row-level notes (not found,
      // duplicates), which noteStatus already counts.
      if (name === idName) {
        cells[name] = rowResolved && isIssue(cell.status) ? { ...cell, status: OK, resolved: cell.status } : cell;
        continue;
      }
      if (isIssue(cell.status) && marks.has(cellKey(row, name, cell))) {
        cells[name] = { ...cell, status: OK, resolved: cell.status };
        resolvedCount++;
        changed = true;
      }
      else {
        cells[name] = cell;
        const s = cell.status === INFO ? OK : cell.status;
        if (SEVERITY[s] > SEVERITY[status]) status = s;
      }
    }
    return changed ? { ...row, status, cells, rowResolved } : row;
  });
  return { ...result, rows, resolvedCount, stats: summarise(rows, result.columns, result.extra) };
}
