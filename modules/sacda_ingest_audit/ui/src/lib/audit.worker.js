// Web Worker: spreadsheet parsing and the whole audit (fetch + compare) run
// here, so a 5,000-row file never freezes the page. Messages:
//   { id, type: 'parse', name, data }            → { id, result }
//   { id, type: 'audit', table, settings, options } → { id, progress }…, { id, result }
import { parseWorkbook } from './sheet.js';
import { runAudit } from './audit.js';

self.onmessage = async ({ data: msg }) => {
  const { id } = msg;
  try {
    let result;
    if (msg.type === 'parse') result = parseWorkbook(msg.name, msg.data);
    else if (msg.type === 'audit') result = await runAudit(msg.table, msg.settings, msg.options, (progress) => self.postMessage({ id, progress }));
    else throw new Error(`Unknown message type ${msg.type}`);
    self.postMessage({ id, result });
  }
  catch (e) {
    self.postMessage({ id, error: e.message || String(e) });
  }
};
