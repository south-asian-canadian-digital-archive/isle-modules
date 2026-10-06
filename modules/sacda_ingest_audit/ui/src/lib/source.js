// Main-thread side of spreadsheet input. Parsing happens in the worker; this
// only covers what the page itself must do.

export const ACCEPT = '.csv,.tsv,.txt,.xlsx,.xlsm,.xls,.ods';

/** Fetch a Google Sheets link as CSV text through the Drupal proxy. */
export async function fetchGoogleSheet(url, endpoint) {
  const sep = endpoint.includes('?') ? '&' : '?';
  const res = await fetch(`${endpoint}${sep}url=${encodeURIComponent(url)}`, { credentials: 'same-origin' });
  if (!res.ok) {
    let message = `Google Sheets fetch failed (${res.status}).`;
    try { message = (await res.json()).error || message; } catch { /* not JSON */ }
    throw new Error(message);
  }
  return res.text();
}
