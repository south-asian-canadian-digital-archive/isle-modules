// Cell matrix → { headers, rows, notices }. Pure, no I/O.
//
// Never rejects a sheet over its headers: problems are repaired and reported
// as notices so the viewer can decide (via the column mapping) what to do.
//   blank header        → "(column N)", not compared unless mapped
//   duplicate header    → "name (2)", only the first copy auto-matches
//   reserved key names  → suffixed, so they cannot clobber object internals

const RESERVED = new Set(['__proto__', '__line', 'constructor', 'prototype', 'hasOwnProperty']);
const SCAN = 10;

const filled = (cells) => (cells ?? []).filter((c) => String(c ?? '').trim() !== '').length;

/**
 * Best guess at the header row (1-based): the first of the top rows with the
 * most filled cells. A title row ("SACDA export 2024") has one filled cell,
 * so it is skipped; real header rows are usually fully filled.
 */
export function guessHeaderRow(matrix) {
  const top = matrix.slice(0, SCAN).map(filled);
  const most = Math.max(0, ...top);
  return most ? top.indexOf(most) + 1 : 1;
}

export function buildTable(matrix, headerRow = guessHeaderRow(matrix)) {
  const notices = [];
  const raw = (matrix[headerRow - 1] ?? []).map((h) => String(h ?? '').trim());
  // Columns past the header row's end can still hold data.
  const width = Math.max(raw.length, ...matrix.slice(headerRow).map((r) => r.length));

  const headers = [];
  const seen = new Map();
  for (let i = 0; i < width; i++) {
    let h = raw[i] ?? '';
    if (!h) {
      if (!matrix.slice(headerRow).some((r) => String(r[i] ?? '').trim())) continue; // empty column, drop it
      h = `(column ${i + 1})`;
      notices.push(`Column ${i + 1} has no header; it is listed as "${h}" and not compared unless you map it.`);
    }
    if (RESERVED.has(h)) {
      notices.push(`Column header "${h}" is a reserved name; it is listed as "${h} (column)".`);
      h = `${h} (column)`;
    }
    const n = (seen.get(h) ?? 0) + 1;
    seen.set(h, n);
    if (n > 1) {
      const renamed = `${h} (${n})`;
      notices.push(`Column header "${h}" appears ${n === 2 ? 'twice' : `${n} times`}; copy ${n} is listed as "${renamed}" and is not compared unless you map it.`);
      h = renamed;
    }
    headers.push({ name: h, index: i });
  }

  const rows = [];
  matrix.slice(headerRow).forEach((cells, k) => {
    if (!filled(cells)) return;
    const row = { __line: headerRow + k + 1 };
    for (const { name, index } of headers) row[name] = String(cells[index] ?? '');
    rows.push(row);
  });
  if (!rows.length) notices.push('There are no data rows below the header row.');

  return { headers: headers.map((h) => h.name), rows, notices, headerRow };
}
