// Spreadsheet parsing (runs in the Web Worker): CSV/TSV/Excel/ODS.
//
// Every cell is read as the text the spreadsheet displays, never as a number
// or date, so identifiers like 000123 and EDTF strings like 1959-09 survive.
import { read, utils } from 'xlsx';

/**
 * Parse spreadsheet bytes (or CSV text) into every sheet's table.
 * Runs inside the Web Worker. Returns { name, sheetNames, tables } where each
 * table is { headers, rows } or { error } for a sheet that cannot be read.
 */
export function parseWorkbook(name, data) {
  const isText = typeof data === 'string' || /\.(csv|tsv|txt)$/i.test(name);
  const workbook = isText
    ? read(typeof data === 'string' ? data : new TextDecoder('utf-8').decode(data).replace(/^\uFEFF/, ''), { type: 'string', raw: true, dense: true })
    : read(data, { type: 'array', dense: true, cellDates: false });
  const tables = {};
  for (const sheet of workbook.SheetNames) {
    try { tables[sheet] = toTable(workbook.Sheets[sheet]); }
    catch (e) { tables[sheet] = { error: e.message }; }
  }
  return { name, sheetNames: workbook.SheetNames, tables };
}

/** A worksheet → { headers, rows } with rows as header→string objects. */
export function toTable(worksheet) {
  const matrix = utils.sheet_to_json(worksheet, { header: 1, raw: false, defval: '', blankrows: false });
  if (!matrix.length) throw new Error('The sheet is empty.');
  const headers = matrix[0].map((h) => String(h ?? '').trim());
  const seen = new Set();
  headers.forEach((h, i) => {
    if (!h) throw new Error(`Column ${i + 1} has no header.`);
    if (seen.has(h)) throw new Error(`Column header "${h}" appears twice.`);
    seen.add(h);
  });
  const rows = [];
  matrix.slice(1).forEach((cells, i) => {
    if (!cells.some((c) => String(c ?? '').trim() !== '')) return;
    const row = { __line: i + 2 };
    headers.forEach((h, j) => { row[h] = String(cells[j] ?? ''); });
    rows.push(row);
  });
  return { headers, rows };
}
