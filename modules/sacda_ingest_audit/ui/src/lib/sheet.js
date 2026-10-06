// Spreadsheet input: CSV/TSV/Excel/ODS files and Google Sheets links.
//
// Every cell is read as the text the spreadsheet displays, never as a number
// or date, so identifiers like 000123 and EDTF strings like 1959-09 survive.
import { read, utils } from 'xlsx';

export const ACCEPT = '.csv,.tsv,.txt,.xlsx,.xlsm,.xls,.ods';

/** Parse a File into a workbook handle: { name, sheetNames, table(sheet) }. */
export async function readFile(file) {
  const buffer = await file.arrayBuffer();
  const isText = /\.(csv|tsv|txt)$/i.test(file.name);
  const workbook = isText
    ? read(new TextDecoder('utf-8').decode(buffer).replace(/^﻿/, ''), { type: 'string', raw: true, dense: true })
    : read(buffer, { type: 'array', dense: true, cellDates: false });
  return wrap(file.name, workbook);
}

/** Fetch a Google Sheets link as CSV through the Drupal proxy. */
export async function readGoogleSheet(url, endpoint) {
  const sep = endpoint.includes('?') ? '&' : '?';
  const res = await fetch(`${endpoint}${sep}url=${encodeURIComponent(url)}`, { credentials: 'same-origin' });
  if (!res.ok) {
    let message = `Google Sheets fetch failed (${res.status}).`;
    try { message = (await res.json()).error || message; } catch { /* not JSON */ }
    throw new Error(message);
  }
  const text = await res.text();
  return wrap('Google Sheet', read(text, { type: 'string', raw: true, dense: true }));
}

function wrap(name, workbook) {
  return {
    name,
    sheetNames: workbook.SheetNames,
    table: (sheet) => toTable(workbook.Sheets[sheet ?? workbook.SheetNames[0]]),
  };
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
