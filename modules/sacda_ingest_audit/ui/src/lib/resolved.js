// "Resolved" marks: a viewer hides an issue once they have dealt with it.
//
// Two kinds of mark, both keyed on the column AND both values, so a mark
// only hides that exact discrepancy and it comes back if either side changes:
//   value mark — every row with the same column and the same *difference*
//                (the default: one decision covers all its duplicates). For a
//                multi-valued cell the difference is just the values that did
//                not match, so "Singh, Mayo" vs "Singh, Mayo, 1891-1955"
//                groups across rows whatever other names they list.
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

/**
 * What actually differs in a cell: the unmatched values on each side, order
 * ignored. Cells with no listed difference (e.g. "not a field on this
 * content type") fall back to their full values.
 */
export function difference(cell) {
  const missing = [...(cell.missing ?? [])].sort();
  const extra = [...(cell.extra ?? [])].sort();
  return missing.length || extra.length ? { missing, extra } : { sheet: cell.sheet, server: cell.server };
}

export function valueKey(column, cell) {
  return JSON.stringify(['*d', column, difference(cell)]);
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

// Two independent mark sets, same key scheme: "resolved" (dealt with; gone
// from the view and the export) and "problem" (confirmed; gone from the
// view but kept in the export, flagged). Each in its own localStorage key.
const STORES = { resolved: STORE, problem: 'sacdaIngestAudit.problems' };

export function load(kind = 'resolved') {
  try { return new Set(JSON.parse(localStorage.getItem(STORES[kind]) ?? '[]')); } catch { return new Set(); }
}

export function save(set, kind = 'resolved') {
  try { localStorage.setItem(STORES[kind], JSON.stringify([...set].slice(-CAP))); } catch { /* storage unavailable */ }
}

const isIssue = (status) => status !== OK && status !== SKIP && status !== INFO;

/**
 * Apply marks: resolved and problem cells both read as OK for row status
 * and counts (so they leave the main view), keeping the original status in
 * `resolved` / `flagged`. Problem marks win over resolved ones. Returns a
 * new result; the original is untouched so unmarking restores it exactly.
 */
export function applyResolved(result, marks, problems = new Set()) {
  let resolvedCount = 0;
  let problemCount = 0;
  const idName = result.columns.find((c) => c.role === 'identifier')?.name;
  const spec = specs(result);
  const markOf = (set, row, name, cell) => {
    if (set.has(valueKey(spec.get(name), cell))) return 'value';
    if (set.has(cellKey(row, spec.get(name), cell))) return 'cell';
    return null;
  };
  const rows = result.rows.map((row) => {
    const isRowIssue = row.noteStatus !== OK;
    const rowFlagged = isRowIssue && problems.has(rowKey(row));
    const rowResolved = isRowIssue && !rowFlagged && marks.has(rowKey(row));
    if (rowResolved) resolvedCount++;
    if (rowFlagged) problemCount++;
    let status = rowResolved || rowFlagged ? OK : row.noteStatus;
    let changed = rowResolved || rowFlagged;
    const cells = {};
    for (const [name, cell] of Object.entries(row.cells)) {
      // The identifier cell just mirrors the row-level notes (not found,
      // duplicates), which noteStatus already counts.
      if (name === idName) {
        if (isIssue(cell.status) && rowFlagged) cells[name] = { ...cell, status: OK, flagged: cell.status };
        else if (isIssue(cell.status) && rowResolved) cells[name] = { ...cell, status: OK, resolved: cell.status };
        else cells[name] = cell;
        continue;
      }
      const flaggedBy = isIssue(cell.status) ? markOf(problems, row, name, cell) : null;
      const resolvedBy = isIssue(cell.status) && !flaggedBy ? markOf(marks, row, name, cell) : null;
      if (flaggedBy) {
        cells[name] = { ...cell, status: OK, flagged: cell.status, flaggedBy };
        problemCount++;
        changed = true;
      }
      else if (resolvedBy) {
        cells[name] = { ...cell, status: OK, resolved: cell.status, resolvedBy };
        resolvedCount++;
        changed = true;
      }
      else {
        cells[name] = cell;
        const st = cell.status === INFO ? OK : cell.status;
        if (SEVERITY[st] > SEVERITY[status]) status = st;
      }
    }
    return changed ? { ...row, status, cells, rowResolved, rowFlagged } : row;
  });
  return { ...result, rows, resolvedCount, problemCount, stats: summarise(rows, result.columns, result.extra) };
}
