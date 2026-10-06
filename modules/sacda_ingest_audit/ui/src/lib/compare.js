// Cell-level comparison of a spreadsheet value against a node's field.
//
// Pure functions, no I/O — see compare.test.js. Values are compared as
// Workbench would have written them: a multi-valued cell is split on the
// subdelimiter and compared as a set; term references match on ID, URI or
// name; typed relations must also agree on the relator.

export const OK = 'ok';
export const INFO = 'info';
export const WARN = 'warn';
export const ERROR = 'error';
export const SKIP = 'skip';

export const SEVERITY = { [SKIP]: 0, [OK]: 0, [INFO]: 1, [WARN]: 2, [ERROR]: 3 };

// Kinds whose values Workbench (or Drupal) legitimately rewrites: term
// names get reconciled, EDTF gets normalised. Mismatches there are warnings.
export const FUZZY_KINDS = new Set(['term', 'typed', 'edtf', 'authority']);

// Workbench columns that steer the ingest but are not stored on the node.
const WORKBENCH_ONLY = new Set([
  'id', 'media_use_tid', 'media_use_tids', 'checksum', 'directory', 'image_alt_text',
  'transcript', 'langcode', 'created', 'uid', 'node_id', 'url_alias_old',
]);

/** Field type → comparison kind. */
export function kindOf(field) {
  switch (field.type) {
    case 'typed_relation': return 'typed';
    case 'entity_reference':
    case 'entity_reference_revisions':
      if (field.targetType === 'taxonomy_term') return 'term';
      if (field.targetType === 'node') return 'node';
      return 'ref';
    case 'edtf': return 'edtf';
    case 'link': return 'link';
    case 'authority_link': return 'authority';
    case 'geolocation': return 'geo';
    case 'boolean': return 'bool';
    case 'integer':
    case 'decimal':
    case 'float': return 'number';
    default: return 'text';
  }
}

// Mapping targets that are not plain fields. The column mapped to MATCH_KEY
// is what rows are matched on.
export const MATCH_KEY = 'field_identifier';
const SPECIAL = {
  parent_id: { role: 'parent', label: 'Parent (by identifier)', kind: 'node' },
  file: { role: 'file', label: 'Original file', kind: 'file' },
  url_alias: { role: 'alias', label: 'URL alias', kind: 'text' },
  published: { role: 'published', label: 'Published', kind: 'bool' },
};

// Common spellings of the special columns in hand-made sheets.
const ALIASES = {
  identifier: MATCH_KEY, accessidentifier: MATCH_KEY, objectidentifier: MATCH_KEY, objectid: MATCH_KEY,
  parent: 'parent_id', parentid: 'parent_id', parentidentifier: 'parent_id', memberof: 'parent_id',
  filename: 'file', filepath: 'file', urlalias: 'url_alias', alias: 'url_alias', status: 'published',
};

const key = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

function fieldIndex(bundles) {
  const fields = new Map();
  for (const info of Object.values(bundles)) {
    for (const [name, f] of Object.entries(info.fields)) if (!fields.has(name)) fields.set(name, f);
  }
  return fields;
}

/** Mapping targets for the UI, grouped. */
export function targetOptions(bundles) {
  const fields = [...fieldIndex(bundles)]
    .filter(([name]) => name !== MATCH_KEY)
    .map(([value, f]) => ({ value, label: `${f.label} (${value})` }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return [
    { group: 'Match rows on', options: [{ value: MATCH_KEY, label: `Identifier (${MATCH_KEY})` }] },
    { group: 'Workbench columns', options: Object.entries(SPECIAL).map(([value, s]) => ({ value, label: `${s.label} (${value})` })) },
    { group: 'Fields', options: fields },
  ];
}

/**
 * Best guess at what each column is: its exact machine name, a common alias,
 * or a field whose label or name matches ignoring case and punctuation
 * ("Identifier" → field_identifier). Only one column ever gets the match key.
 * Returns { header: target | '' }.
 */
export function suggestMapping(headers, bundles) {
  const fields = fieldIndex(bundles);
  const byKey = new Map();
  for (const [name, f] of fields) {
    for (const k of [key(name), key(name.replace(/^field_/, '')), key(f.label)]) if (k && !byKey.has(k)) byKey.set(k, name);
  }
  const mapping = {};
  let keyTaken = false;
  const pick = (h) => {
    if (fields.has(h) || h in SPECIAL) return h;
    if (WORKBENCH_ONLY.has(h)) return '';
    return ALIASES[key(h)] ?? byKey.get(key(h)) ?? '';
  };
  for (const h of headers) {
    let t = pick(h);
    if (t === MATCH_KEY) {
      if (keyTaken) t = '';
      keyTaken = true;
    }
    mapping[h] = t;
  }
  // Workbench's own `id` usually equals the identifier; use it as a last resort.
  if (!keyTaken && headers.includes('id')) mapping.id = MATCH_KEY;
  return mapping;
}

/**
 * Decide what each spreadsheet column is, given header → target mapping.
 * Returns [{ name, target, role, label, kind?, fuzzy? }] in header order.
 * role: identifier | parent | file | alias | published | field | workbench | unknown
 */
export function planColumns(headers, bundles, mapping = suggestMapping(headers, bundles)) {
  const fields = fieldIndex(bundles);
  let keyDone = false;
  return headers.map((name) => {
    const target = mapping[name] ?? '';
    if (target === MATCH_KEY && !keyDone) {
      keyDone = true;
      return { name, target, role: 'identifier', label: 'Identifier (match key)' };
    }
    if (target in SPECIAL) return { name, target, ...SPECIAL[target] };
    if (fields.has(target)) {
      const f = fields.get(target);
      const kind = kindOf(f);
      return { name, target, role: 'field', label: target === name ? f.label : `→ ${f.label} (${target})`, kind, fuzzy: FUZZY_KINDS.has(kind) };
    }
    if (WORKBENCH_ONLY.has(name)) return { name, target: '', role: 'workbench', label: 'Workbench option' };
    return { name, target: '', role: 'unknown', label: 'Not mapped' };
  });
}

// ---------------------------------------------------------------------------
// Normalisation

export function norm(s) {
  return String(s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

export function loose(s) {
  return norm(String(s ?? '').replace(/<[^>]+>/g, ' '))
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .toLowerCase();
}

function normUrl(u) {
  return norm(u).replace(/^http:\/\//i, 'https://').replace(/\/+$/, '').toLowerCase();
}

function basename(p) {
  return norm(p).split(/[\\/]/).pop();
}

function parseBool(v) {
  const s = loose(v);
  if (['1', 'true', 'yes', 'y', 'published'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'unpublished'].includes(s)) return false;
  return null;
}

// ---------------------------------------------------------------------------
// Server side: node resource → comparable items

/**
 * Items on the server for one field of one node.
 * Each item: { display, ...kind-specific match data }.
 */
export function serverItems(node, name, kind, index, extra = {}) {
  if (kind === 'file') return (extra.files ?? []).map((f) => ({ display: f.filename ?? `(media ${f.mediaId} has no file)`, filename: f.filename ?? '' }));
  if (name === 'url_alias') return node.attributes.path?.alias ? [{ display: node.attributes.path.alias, text: node.attributes.path.alias }] : [];
  if (name === 'published') return [{ display: node.attributes.status ? 'true' : 'false', bool: !!node.attributes.status }];

  const rel = node.relationships?.[name === 'parent_id' ? 'field_member_of' : name];
  if (rel) {
    return asArray(rel.data).map((ref) => {
      const r = index.get(`${ref.type}:${ref.id}`);
      const tid = ref.meta?.drupal_internal__target_id;
      if (kind === 'node') {
        const identifier = r?.attributes.field_identifier ?? '';
        return {
          display: r ? `${identifier || '(no identifier)'} — ${r.attributes.title}` : `node ${tid}`,
          nid: tid, identifier, uuid: ref.id,
        };
      }
      const term = {
        tid,
        name: r?.attributes.name ?? '',
        vocab: ref.type.split('--')[1] ?? '',
        uris: termUris(r),
      };
      if (kind === 'typed') {
        const relType = ref.meta?.rel_type ?? '';
        return { display: `${relType}: ${term.name || `#${tid}`}`, rel: relType, term };
      }
      return { display: term.name ? `${term.name}` : `#${tid}`, term };
    });
  }

  const raw = name === 'title' ? node.attributes.title : node.attributes[name];
  return asArray(raw).filter((v) => v !== null && v !== '').map((v) => {
    switch (kind) {
      case 'link': return { display: v.title ? `${v.uri} (${v.title})` : v.uri, uri: v.uri };
      case 'authority': return { display: `${v.source ?? ''} ${v.uri}`.trim(), uri: v.uri };
      case 'geo': return { display: `${v.lat},${v.lng}`, lat: Number(v.lat), lng: Number(v.lng) };
      case 'bool': return { display: String(v), bool: !!v };
      default: {
        const text = typeof v === 'object' ? (v.value ?? JSON.stringify(v)) : String(v);
        return { display: text, text };
      }
    }
  });
}

function termUris(term) {
  if (!term) return [];
  const a = term.attributes;
  return [
    ...asArray(a.field_external_uri).map((l) => l?.uri),
    ...asArray(a.field_authority_link).map((l) => l?.uri),
  ].filter(Boolean).map(normUrl);
}

// ---------------------------------------------------------------------------
// Sheet side: cell text → tokens

export function splitCell(raw, multi, delimiter) {
  const s = String(raw ?? '');
  if (!s.trim()) return [];
  const parts = multi ? s.split(delimiter) : [s];
  return parts.map((p) => p.trim()).filter(Boolean);
}

function parseTermToken(token, vocabs = []) {
  if (/^\d+$/.test(token)) return { tid: Number(token) };
  if (/^https?:\/\//i.test(token)) return { uri: normUrl(token) };
  const i = token.indexOf(':');
  if (i > 0 && vocabs.includes(token.slice(0, i))) return { name: token.slice(i + 1) };
  return { name: token };
}

function parseTypedToken(token, vocabs) {
  // namespace:code:rest — rest is a term ID, vocab:name or a bare name.
  const parts = token.split(':');
  if (parts.length < 3) return { rel: '', term: parseTermToken(token, vocabs) };
  return { rel: `${parts[0]}:${parts[1]}`, term: parseTermToken(parts.slice(2).join(':'), vocabs) };
}

// ---------------------------------------------------------------------------
// Matching: token vs server item → 'exact' | 'loose' | null

function matchText(a, b) {
  if (norm(a) === norm(b)) return 'exact';
  if (loose(a) === loose(b)) return 'loose';
  return null;
}

function matchTerm(tok, term) {
  if (tok.tid != null) return tok.tid === term.tid ? 'exact' : null;
  if (tok.uri) return term.uris.includes(tok.uri) ? 'exact' : null;
  return matchText(tok.name, term.name);
}

function matcher(kind, column, field) {
  const vocabs = field?.targetBundles ?? [];
  switch (kind) {
    case 'term':
      return (t, item) => matchTerm(parseTermToken(t, vocabs), item.term);
    case 'typed':
      return (t, item) => {
        const tok = parseTypedToken(t, vocabs);
        if (tok.rel && tok.rel.toLowerCase() !== item.rel.toLowerCase()) return null;
        return matchTerm(tok.term, item.term);
      };
    case 'node':
      return (t, item) => {
        if (column.role === 'parent') return norm(t) === norm(item.identifier) ? 'exact' : null;
        const nid = t.match(/^(?:.*\/node\/)?(\d+)$/)?.[1];
        if (nid && Number(nid) === item.nid) return 'exact';
        return norm(t) === norm(item.identifier) ? 'exact' : null;
      };
    case 'link':
    case 'authority':
      return (t, item) => {
        const parts = t.split('%%');
        const uri = kind === 'authority' && parts.length > 1 ? parts[1] : parts[0];
        return normUrl(uri) === normUrl(item.uri) ? 'exact' : null;
      };
    case 'geo':
      return (t, item) => {
        const [lat, lng] = t.split(',').map(Number);
        return Math.abs(lat - item.lat) < 1e-5 && Math.abs(lng - item.lng) < 1e-5 ? 'exact' : null;
      };
    case 'bool':
      return (t, item) => (parseBool(t) === item.bool ? 'exact' : null);
    case 'number':
      return (t, item) => (Number(t) === Number(item.text) ? 'exact' : null);
    case 'file':
      return (t, item) => {
        const want = basename(t);
        if (want === item.filename) return 'exact';
        if (want.toLowerCase() === item.filename.toLowerCase()) return 'loose';
        // Drupal renames on collision: photo.jpg → photo_0.jpg
        if (want.toLowerCase() === item.filename.toLowerCase().replace(/_\d+(\.[^.]+)$/, '$1')) return 'loose';
        return null;
      };
    default:
      return (t, item) => {
        const m = matchText(t, item.text);
        if (m) return m;
        // string fields are 255 chars; Workbench truncates longer values.
        if (item.text.length >= 250 && norm(t).startsWith(norm(item.text))) return 'loose';
        return null;
      };
  }
}

/**
 * Compare one cell. Returns
 * { status, sheet: [token], server: [display], missing: [token], extra: [display], note }.
 */
export function compareCell(raw, items, column, { field, multi, delimiter = '|', strict = false } = {}) {
  const tokens = splitCell(raw, multi, delimiter);
  const result = { status: OK, sheet: tokens, server: items.map((i) => i.display), missing: [], extra: [], note: '' };

  if (!tokens.length && !items.length) return result;
  if (!tokens.length) {
    result.extra = result.server;
    // Media is checked both ways: a node with no file in the sheet should
    // not have picked up an original file from somewhere.
    if (column.role === 'file') {
      result.status = ERROR;
      result.note = 'The file column is blank, but this node has Original File media.';
    }
    else {
      result.status = INFO;
      result.note = 'Blank in the file, but the repository has a value.';
    }
    return result;
  }
  if (!items.length) {
    result.status = ERROR;
    result.missing = tokens;
    result.note = column.role === 'file' ? 'The file column names a file, but this node has no Original File media.' : 'Missing in the repository.';
    return result;
  }

  const match = matcher(column.kind, column, field);
  const used = new Set();
  let normalised = false;
  const unmatched = [];
  for (const pass of ['exact', 'loose']) {
    const pending = pass === 'exact' ? tokens : unmatched.splice(0);
    for (const t of pending) {
      const i = items.findIndex((item, j) => !used.has(j) && (pass === 'exact' ? match(t, item) === 'exact' : match(t, item)));
      if (i === -1) unmatched.push(t);
      else {
        used.add(i);
        if (pass === 'loose') normalised = true;
      }
    }
  }
  result.missing = unmatched;
  result.extra = items.filter((_, j) => !used.has(j)).map((i) => i.display);

  if (!result.missing.length && !result.extra.length) {
    if (normalised) result.note = 'Matches after ignoring case, accents or punctuation.';
    return result;
  }
  const fuzzy = FUZZY_KINDS.has(column.kind) && !strict;
  result.status = fuzzy ? WARN : ERROR;
  if (column.role === 'parent') {
    result.status = ERROR;
    result.note = 'Attached to a different parent in the repository.';
  }
  else if (fuzzy) {
    result.note = column.kind === 'edtf'
      ? 'Date differs. Workbench may have normalised it; check it is the same date.'
      : 'Terms differ. Workbench may have reconciled names; check it is the same term.';
  }
  else {
    result.note = result.missing.length && result.extra.length ? 'Values differ.'
      : result.missing.length ? 'Some values from the file are not in the repository.'
        : column.role === 'file' ? 'The node has more Original File media than the file column lists.' : 'The repository has extra values.';
  }
  return result;
}

export function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}
