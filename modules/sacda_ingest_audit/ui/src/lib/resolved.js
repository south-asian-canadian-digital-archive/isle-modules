// "Resolved" marks: a viewer hides an issue once they have dealt with it.
//
// Two kinds of mark, both keyed on the column AND both values, so a mark
// only hides that exact discrepancy and it comes back if either side changes:
//   value mark — every row with the same column, file value and repository
//                value (the default: one decision covers all its duplicates)
//   cell mark  — one row only ("only this one")
// The column part is the header AND the field it is mapped to, so after a
// remap + re-run, marks on unchanged columns still apply while a column that
// now points at a different field starts clean.
// Stored in this browser only (localStorage), as a convenience.
import { summarise } from './audit.js';
import { OK, INFO, SKIP, SEVERITY } from './compare.js';

const STORE = 'sacdaIngestAudit.resolved';
const CAP = 20000;
export const ROW = '__row__';

/** Column identity for marks: header plus its mapping target. */
export function colSpec(column) {
  return column.target ? `${column.name}\u2192${column.target}` : column.name;
}

const specs = (result) => new Map(result.columns.map((c) => [c.name, colSpec(c)]));

export function cellKey(row, column, cell) {
  return JSON.stringify([row.identifier, column, cell.sheet, cell.server]);
}

export function valueKey(column, cell) {
  return JSON.stringify(['*', column, cell.sheet, cell.server]);
}

/** How many issue cells share each value key (resolved or not). */
export function groupSizes(result) {
  const spec = specs(result);
  const sizes = new Map();
  for (const row of result.rows) {
    for (const [name, cell] of Object.entries(row.cells)) {
      if (!isIssue(cell.status)) continue;
      const k = valueKey(spec.get(name), cell);
      sizes.set(k, (sizes.get(k) ?? 0) + 1);
    }
  }
  return sizes;
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
  const spec = specs(result);
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
      const byValue = isIssue(cell.status) && marks.has(valueKey(spec.get(name), cell));
      if (isIssue(cell.status) && (byValue || marks.has(cellKey(row, spec.get(name), cell)))) {
        cells[name] = { ...cell, status: OK, resolved: cell.status, resolvedBy: byValue ? 'value' : 'cell' };
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
