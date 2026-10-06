// Date comparison by meaning, not text: both sides are read as EDTF (or the
// CollectiveAccess notations the migration converted from, mirroring
// islandora_workbench g/scripts/ca-migration/edtf_normalize.py) and reduced
// to the day range they cover. "193-", "1930s" and "193X?" are all
// 1930-01-01..1939-12-31, so they match.
//
// Qualifiers (? uncertain, ~ approximate, % both, circa/ca.) are ignored:
// they say how sure the cataloguer was, not which dates are meant.

const MONTHS = Object.fromEntries(['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december'].flatMap((m, i) => [[m, i + 1], [m.slice(0, 3), i + 1]]));
const SEASONS = { 21: [3, 5], 22: [6, 8], 23: [9, 11], 24: [12, 12] }; // spring … winter
const QUALIFIER_PHRASES = /\b(date\(s\) of creation|date\(s\) of publication|estimated date\(s\)|predominant date\(s\))\b/gi;

const pad = (n, w = 2) => String(n).padStart(w, '0');
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Strip qualifiers and CA-isms; turn CA notations into EDTF. */
function clean(s) {
  let t = String(s ?? '')
    .replace(QUALIFIER_PHRASES, '')
    .replace(/\b(circa|ca|c)\.?\s*(?=\d)/gi, '')
    .replace(/[?~%[\]]/g, '')
    .replace(/[–—]/g, ' - ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s;,.]+|[\s;,.]+$/g, '');
  // Named months: "July 14, 1948" / "14 July 1948" / "July 1948".
  t = t.replace(/\b([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})\b/g, (m, mon, d, y) => (MONTHS[mon.toLowerCase()] ? `${y}-${pad(MONTHS[mon.toLowerCase()])}-${pad(d)}` : m));
  t = t.replace(/\b(\d{1,2})\s+([A-Za-z]+)\.?,?\s+(\d{4})\b/g, (m, d, mon, y) => (MONTHS[mon.toLowerCase()] ? `${y}-${pad(MONTHS[mon.toLowerCase()])}-${pad(d)}` : m));
  t = t.replace(/\b([A-Za-z]+)\.?,?\s+(\d{4})\b/g, (m, mon, y) => (MONTHS[mon.toLowerCase()] ? `${y}-${pad(MONTHS[mon.toLowerCase()])}` : m));
  // Decades / centuries: "1930s" → 193X, "193-" → 193X, "19--" → 19XX.
  t = t.replace(/\b(\d{3})0s\b/g, '$1X');
  t = t.replace(/\b([12]\d*)(-+)(?=$|\s|\/)/g, (m, d, dashes) => (d.length + dashes.length === 4 ? d + 'X'.repeat(dashes.length) : m));
  return t;
}

/** One date (EDTF level 0–2 shapes, X masks, seasons) → [start, end] ISO days, or null. */
function point(s) {
  const m = s.match(/^(-?[\dX]{4})(?:-([\dX]{2}))?(?:-([\dX]{2}))?$/i);
  if (!m) return null;
  const [, Y, M, D] = m.map((v) => v?.toUpperCase());
  const y0 = Number(Y.replace(/X/g, '0'));
  const y1 = Number(Y.replace(/X/g, '9'));
  if (!M) return [`${y0}-01-01`, `${y1}-12-31`];
  if (SEASONS[M]) return [`${y0}-${pad(SEASONS[M][0])}-01`, `${y1}-${pad(SEASONS[M][1])}-${lastDay(y1, SEASONS[M][1])}`];
  const m0 = M === 'XX' ? 1 : Number(M.replace(/X/g, '0')) || 1;
  const m1 = M === 'XX' ? 12 : Math.min(12, Number(M.replace(/X/g, '9')));
  if (m0 < 1 || m0 > 12) return null;
  if (!D) return [`${y0}-${pad(m0)}-01`, `${y1}-${pad(m1)}-${lastDay(y1, m1)}`];
  const d0 = D === 'XX' ? 1 : Number(D.replace(/X/g, '0')) || 1;
  const d1 = D === 'XX' ? lastDay(y1, m1) : Math.min(lastDay(y1, m1), Number(D.replace(/X/g, '9')));
  return [`${y0}-${pad(m0)}-${pad(d0)}`, `${y1}-${pad(m1)}-${pad(d1)}`];
}

const OPEN = new Set(['', '..']);

/**
 * The day range a date value covers: { start, end } (either may be null for
 * an open end), or null when the value cannot be read as a date.
 */
export function edtfRange(value) {
  const t = clean(value);
  if (!t) return null;

  let a; let b;
  let m;
  if ((m = t.match(/^(.*)\/(.*)$/))) [a, b] = [m[1].trim(), m[2].trim()];
  else if ((m = t.match(/^before (.+)$/i))) [a, b] = ['..', m[1]];
  else if ((m = t.match(/^after (.+)$/i))) [a, b] = [m[1], '..'];
  else if ((m = t.match(/^between (\S+) and (\S+)$/i))) [a, b] = [m[1], m[2]];
  else if ((m = t.match(/^(\S+) (?:-|to) (\S+)$/i))) [a, b] = [m[1], m[2]];
  else if ((m = t.match(/^(\d{3,4})-(\d{3,4})$/))) [a, b] = [m[1], m[2]];
  else if ((m = t.match(/^\{(.+)\}$|^(.+(?:,| or ).+)$/i))) {
    // A set / "one of": the span from its earliest to latest member.
    const parts = (m[1] ?? m[2]).split(/,| or /i).map((p) => p.trim().replace(/^\.\./, '')).filter(Boolean).map(point);
    if (!parts.length || parts.some((p) => !p)) return null;
    return { start: parts.map((p) => p[0]).sort()[0], end: parts.map((p) => p[1]).sort().at(-1) };
  }
  else {
    const p = point(t);
    return p && { start: p[0], end: p[1] };
  }

  const pa = OPEN.has(a) ? null : point(a);
  const pb = OPEN.has(b) ? null : point(b);
  if ((!OPEN.has(a) && !pa) || (!OPEN.has(b) && !pb)) return null;
  return { start: pa ? pa[0] : null, end: pb ? pb[1] : null };
}

/** True when both values read as dates covering exactly the same days. */
export function sameDates(x, y) {
  const a = edtfRange(x);
  const b = edtfRange(y);
  return !!a && !!b && a.start === b.start && a.end === b.end;
}
