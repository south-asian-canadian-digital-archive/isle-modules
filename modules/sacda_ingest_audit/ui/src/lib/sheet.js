// Spreadsheet parsing (runs in the Web Worker): CSV/TSV/Excel/ODS.
//
// Every cell is read as the text the spreadsheet displays, never as a number
// or date, so identifiers like 000123 and EDTF strings like 1959-09 survive.
import { read, utils } from 'xlsx';

/**
 * Parse spreadsheet bytes (or CSV text) into every sheet's cell matrix.
 * Runs inside the Web Worker; headers are applied on the page (see table.js)
 * so the viewer can change the header row without re-parsing.
 * Returns { name, sheetNames, matrices, notices }.
 */
export function parseWorkbook(name, data) {
  const notices = [];
  const isText = typeof data === 'string' || /\.(csv|tsv|txt)$/i.test(name);
  let workbook;
  if (isText) {
    let text = data;
    if (typeof data !== 'string') {
      // Excel's "CSV" (not "CSV UTF-8") is Windows-1252. Decoding that as
      // UTF-8 turns every accent into U+FFFD and every such cell mismatches.
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); }
      catch {
        text = new TextDecoder('windows-1252').decode(data);
        notices.push('The file is not UTF-8; it was read as Windows-1252 (Excel "CSV"). Save as "CSV UTF-8" to avoid this.');
      }
    }
    workbook = read(text.replace(/^\uFEFF/, ''), { type: 'string', raw: true, dense: true });
  }
  else {
    workbook = read(data, { type: 'array', dense: true, cellDates: false });
  }
  const matrices = {};
  for (const sheet of workbook.SheetNames) {
    matrices[sheet] = utils.sheet_to_json(workbook.Sheets[sheet], { header: 1, raw: false, defval: '', blankrows: true })
      .map((r) => r.map((c) => String(c ?? '')));
  }
  return { name, sheetNames: workbook.SheetNames, matrices, notices };
}
