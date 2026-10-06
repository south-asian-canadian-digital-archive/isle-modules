// Orchestrates one audit run as map-reduce over identifier chunks:
//   map    — per chunk: look the nodes up, then (same job) fetch their files;
//            all jobs share the repository's request pool, so they overlap.
//   reduce — merge the chunk results, compare every row, then scan for nodes
//            the file does not mention.
import { Repository, asArray, chunks, merge } from './repository.js';
import {
  planColumns, serverItems, compareCell, norm, MATCH_KEY,
  OK, INFO, WARN, ERROR, SKIP, SEVERITY,
} from './compare.js';

// Models that never have child nodes; everything else may be a container.
const LEAF_MODELS = new Set(['Image', 'Digital Document', 'Audio', 'Video', 'Binary', 'Page']);
const DESCENDANT_CAP = 20000;
const BASE_FIELDS = ['title', MATCH_KEY, 'drupal_internal__nid', 'field_member_of', 'field_model', 'status', 'path'];

/**
 * @param {{headers: string[], rows: object[]}} table
 * @param {object} settings drupalSettings.sacdaIngestAudit + { origin }
 * @param {{mapping: object, delimiter: string, strict: boolean, scanExtra: boolean}} options
 * @param {(p: {stage: string, done: number, total: number, requests: number}) => void} onProgress
 */
export async function runAudit(table, settings, options, onProgress = () => {}) {
  const started = performance.now();
  const progress = { stage: '', done: 0, total: 0, requests: 0 };
  const report = (patch) => { Object.assign(progress, patch); onProgress({ ...progress }); };
  const repo = new Repository(settings, (requests) => report({ requests }));

  const { headers, rows } = table;
  const columns = planColumns(headers, settings.bundles, options.mapping);
  const idCol = columns.find((c) => c.role === 'identifier');
  if (!idCol) throw new Error(`Map one column to ${MATCH_KEY} so rows can be matched.`);
  const opts = {
    ...options,
    idColumn: idCol.name,
    parentColumn: columns.find((c) => c.role === 'parent')?.name ?? null,
    memberColumn: columns.find((c) => c.target === 'field_member_of')?.name ?? null,
  };

  const sheetCount = new Map();
  for (const r of rows) {
    const id = norm(r[opts.idColumn]);
    if (id) sheetCount.set(id, (sheetCount.get(id) ?? 0) + 1);
  }
  const identifiers = [...sheetCount.keys()];
  const need = fetchPlan(columns, settings.bundles);
  const checkFiles = columns.some((c) => c.role === 'file');

  // Map.
  const jobs = chunks(identifiers);
  report({ stage: checkFiles ? 'Looking up nodes and files' : 'Looking up nodes', done: 0, total: jobs.length });
  // A job that still fails after retries is recorded, not thrown: its rows
  // are reported as "could not be checked" and the rest of the audit stands.
  const failures = [];
  const lookupFailed = new Map(); // identifier → message
  const filesFailed = new Map(); // node uuid → message
  const parts = await Promise.all(jobs.map(async (ids) => {
    let found = { nodes: [], index: new Map() };
    let files = [];
    try {
      found = await repo.lookup(ids, need);
    }
    catch (e) {
      for (const id of ids) lookupFailed.set(id, e.message);
      failures.push({ stage: 'Node lookup', count: ids.length, message: e.message });
    }
    if (checkFiles && found.nodes.length) {
      try {
        files = await repo.originalFiles(found.nodes.map((n) => n.id));
      }
      catch (e) {
        for (const n of found.nodes) filesFailed.set(n.id, e.message);
        failures.push({ stage: 'File check', count: found.nodes.length, message: e.message });
      }
    }
    report({ done: progress.done + 1 });
    return { found, files };
  }));

  // Reduce.
  const { nodes, index } = merge(parts.map((p) => ({ data: p.found.nodes, included: [...p.found.index.values()] })));
  const files = new Map();
  for (const [uuid, entry] of parts.flatMap((p) => p.files)) {
    if (!files.has(uuid)) files.set(uuid, []);
    files.get(uuid).push(entry);
  }
  const byIdentifier = new Map();
  for (const n of nodes) {
    const id = norm(n.attributes.field_identifier);
    if (!byIdentifier.has(id)) byIdentifier.set(id, []);
    byIdentifier.get(id).push(n);
  }

  report({ stage: 'Comparing' });
  const results = rows.map((row) => compareRow(row, { columns, byIdentifier, sheetCount, index, files, lookupFailed, filesFailed, settings, options: opts }));

  let extra = [];
  let truncated = false;
  let extraIncomplete = false;
  if (options.scanExtra && nodes.length) {
    ({ extra, truncated, incomplete: extraIncomplete } = await scanExtra(repo, nodes, index, rows, opts, new Set(identifiers), report, failures));
  }

  return {
    columns,
    rows: results,
    extra,
    truncated,
    extraIncomplete,
    failures: summariseFailures(failures),
    stats: summarise(results, columns, extra),
    requests: repo.requests,
    seconds: (performance.now() - started) / 1000,
  };
}

/** Which node fields to return and which references to embed. */
function fetchPlan(columns, bundles) {
  const defs = {};
  for (const info of Object.values(bundles)) for (const [n, f] of Object.entries(info.fields)) defs[n] ??= f;
  const fields = new Set(BASE_FIELDS);
  const include = new Set(['field_member_of', 'field_model']);
  const vocabularies = new Set(['islandora_models']);
  for (const c of columns) {
    if (c.role !== 'field') continue;
    fields.add(c.target);
    const f = defs[c.target];
    if (f?.targetType === 'taxonomy_term' || f?.targetType === 'node') include.add(c.target);
    if (f?.targetType === 'taxonomy_term') for (const v of f.targetBundles) vocabularies.add(v);
  }
  return { fields: [...fields], include: [...include], vocabularies: [...vocabularies] };
}

/**
 * Nodes below the rows' parents and containers that the file does not list.
 *
 * Starts from (a) parents the file names that are not rows themselves, and
 * (b) matched rows whose model can hold children (collections, compound
 * objects, paged content). Leaf items (Image, Digital Document, …) are not
 * scanned: with thousands of rows that is the difference between a few
 * dozen requests and thousands. Only newly found extra nodes are descended
 * into further. A parent the file never names (e.g. a site-wide root
 * collection above a fonds) is deliberately not scanned.
 */
async function scanExtra(repo, nodes, index, rows, opts, inSheet, report, failures) {
  const named = new Set();
  for (const r of rows) {
    for (const col of [opts.parentColumn, opts.memberColumn]) {
      if (!col) continue;
      for (const p of String(r[col] ?? '').split(opts.delimiter || '|')) if (p.trim()) named.add(norm(p));
    }
  }
  const frontier = new Set();
  for (const n of nodes) {
    if (mayHaveChildren(n, index)) frontier.add(n.id);
    for (const ref of asArray(n.relationships.field_member_of?.data)) {
      const parent = index.get(`${ref.type}:${ref.id}`);
      const ident = norm(parent?.attributes.field_identifier);
      const nid = String(ref.meta?.drupal_internal__target_id ?? '');
      if (!inSheet.has(ident) && ((ident && named.has(ident)) || named.has(nid))) frontier.add(ref.id);
    }
  }

  const labels = new Map([...index.values()].filter((r) => r.type.startsWith('node--'))
    .map((r) => [r.id, r.attributes.field_identifier || r.attributes.title]));
  const seen = new Set(frontier);
  const extra = [];
  let level = [...frontier];
  let truncated = false;
  let incomplete = false;
  while (level.length && !truncated) {
    const jobs = chunks(level);
    report({ stage: 'Scanning for nodes missing from the file', done: 0, total: jobs.length });
    let done = 0;
    const found = merge(await Promise.all(jobs.map(async (ids) => {
      try {
        const r = await repo.children(ids);
        return { data: r.nodes, included: [...r.index.values()] };
      }
      catch (e) {
        incomplete = true;
        failures.push({ stage: 'Scan for nodes not in the file', count: ids.length, message: e.message });
        return { data: [], included: [] };
      }
      finally {
        report({ done: ++done });
      }
    })));
    const next = [];
    for (const n of found.nodes) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      const identifier = n.attributes.field_identifier ?? '';
      labels.set(n.id, identifier || n.attributes.title);
      if (inSheet.has(norm(identifier))) continue;
      extra.push({
        uuid: n.id,
        nid: n.attributes.drupal_internal__nid,
        bundle: n.type.replace('node--', ''),
        title: n.attributes.title,
        identifier,
        parents: asArray(n.relationships.field_member_of?.data).map((p) => p.id),
      });
      if (mayHaveChildren(n, found.index)) next.push(n.id);
    }
    if (seen.size >= DESCENDANT_CAP) truncated = true;
    level = next;
  }
  for (const e of extra) e.parentLabels = e.parents.map((p) => labels.get(p) ?? p);
  return { extra, truncated, incomplete };
}

function mayHaveChildren(node, index) {
  if (node.type !== 'node--islandora_object') return true;
  const ref = node.relationships.field_model?.data;
  const model = ref ? index.get(`${ref.type}:${ref.id}`)?.attributes.name : null;
  return !model || !LEAF_MODELS.has(model);
}

/** One line per stage + message, with how many items it affected. */
function summariseFailures(failures) {
  const merged = new Map();
  for (const f of failures) {
    const k = `${f.stage}\u0000${f.message}`;
    if (merged.has(k)) merged.get(k).count += f.count;
    else merged.set(k, { ...f });
  }
  return [...merged.values()];
}

function compareRow(row, ctx) {
  const { columns, byIdentifier, sheetCount, index, files, lookupFailed, filesFailed, settings, options } = ctx;
  const identifier = norm(row[options.idColumn]);
  const failedLookup = identifier ? lookupFailed.get(identifier) : null;
  const matches = identifier ? byIdentifier.get(identifier) ?? [] : [];
  const node = matches[0];
  const notes = [];
  const cells = {};

  let status = OK;
  const raise = (s) => { if (SEVERITY[s] > SEVERITY[status]) status = s; };

  if (!identifier) { notes.push('No identifier in this row.'); raise(ERROR); }
  else if (failedLookup) { notes.push(`Could not be checked: ${failedLookup} Run the audit again to retry.`); raise(WARN); }
  else if (!node) { notes.push('No node in the repository has this identifier.'); raise(ERROR); }
  if (matches.length > 1) { notes.push(`${matches.length} nodes share this identifier; compared against the first.`); raise(ERROR); }
  if (identifier && sheetCount.get(identifier) > 1) { notes.push('This identifier appears more than once in the file.'); raise(WARN); }
  // Row-level severity (from the notes alone), kept so a viewer can mark
  // individual cell issues resolved and the row status can be recomputed.
  const noteStatus = status;

  const bundle = node ? node.type.replace('node--', '') : null;
  const fields = bundle ? settings.bundles[bundle]?.fields ?? {} : {};

  for (const col of columns) {
    const raw = row[col.name] ?? '';
    if (col.role === 'identifier') {
      cells[col.name] = { status: node ? OK : failedLookup ? WARN : ERROR, sheet: [raw], server: node ? [node.attributes.field_identifier] : [], missing: [], extra: [], note: notes.join(' ') };
      continue;
    }
    if (!node || col.role === 'workbench' || col.role === 'unknown') {
      cells[col.name] = skip(raw, failedLookup ? 'Not compared: the lookup failed.' : !node ? 'Not compared: no matching node.' : col.role === 'unknown' ? 'Column not mapped to a field; not compared.' : 'Workbench ingest option; not stored on the node.');
      continue;
    }
    // Workbench fills field_member_of from parent_id; the parent_id column
    // already carries that comparison.
    if (col.target === 'field_member_of' && !raw.trim() && options.parentColumn && String(row[options.parentColumn] ?? '').trim()) {
      cells[col.name] = skip(raw, 'Set from parent_id at ingest; compared in that column.');
      continue;
    }
    if (col.role === 'file' && filesFailed.has(node.id)) {
      cells[col.name] = { ...skip(raw, `File check failed: ${filesFailed.get(node.id)} Run the audit again to retry.`), status: WARN };
      raise(WARN);
      continue;
    }
    const field = col.role === 'field' ? fields[col.target] : null;
    if (col.role === 'field' && !field) {
      cells[col.name] = raw.trim()
        ? { ...skip(raw, `Not a field on "${bundle}" content, so this value was not ingested.`), status: WARN }
        : skip(raw, `Not a field on "${bundle}" content.`);
      raise(cells[col.name].status);
      continue;
    }
    const items = serverItems(node, col.target, col.kind, index, { files: files.get(node.id) });
    const multi = col.role === 'parent' || col.role === 'file' ? true : field ? field.cardinality !== 1 : false;
    const cell = compareCell(raw, items, col, { field, multi, delimiter: options.delimiter, strict: options.strict });
    cells[col.name] = cell;
    raise(cell.status === INFO ? OK : cell.status);
  }

  const counts = { error: 0, warn: 0, info: 0 };
  for (const c of Object.values(cells)) if (c.status in counts) counts[c.status]++;

  return {
    line: row.__line,
    identifier,
    lookupFailed: !!failedLookup,
    status,
    noteStatus,
    notes,
    counts,
    bundle,
    nodes: matches.map((n) => ({ nid: n.attributes.drupal_internal__nid, uuid: n.id, title: n.attributes.title, bundle: n.type.replace('node--', '') })),
    title: node?.attributes.title ?? '',
    cells,
  };
}

function skip(raw, note) {
  const v = String(raw ?? '').trim();
  return { status: SKIP, sheet: v ? [v] : [], server: [], missing: [], extra: [], note };
}

export function summarise(rows, columns, extra) {
  const s = {
    rows: rows.length,
    found: 0, notFound: 0, unchecked: 0, duplicates: 0,
    byBundle: {},
    ok: 0, warn: 0, error: 0,
    cells: 0, cellsOk: 0,
    extra: extra.length,
    columns: {},
  };
  for (const c of columns) s.columns[c.name] = { ok: 0, info: 0, warn: 0, error: 0, skip: 0 };
  for (const r of rows) {
    if (r.nodes.length) s.found++; else if (r.lookupFailed) s.unchecked++; else s.notFound++;
    if (r.bundle) s.byBundle[r.bundle] = (s.byBundle[r.bundle] ?? 0) + 1;
    if (r.nodes.length > 1) s.duplicates++;
    s[r.status]++;
    for (const [name, cell] of Object.entries(r.cells)) {
      s.columns[name][cell.status]++;
      if (cell.status === SKIP || !r.nodes.length) continue;
      // Count only cells with something to compare on either side.
      if (!cell.sheet.length && !cell.server.length) continue;
      s.cells++;
      if (cell.status === OK || cell.status === INFO) s.cellsOk++;
    }
  }
  s.matchRate = s.cells ? s.cellsOk / s.cells : 0;
  return s;
}

/** Flatten results to CSV: one line per problem cell / row note. */
export function issuesCsv(result) {
  const out = [['line', 'identifier', 'node', 'column', 'status', 'note', 'in_file', 'in_repository']];
  for (const r of result.rows) {
    const nid = r.nodes[0]?.nid ?? '';
    if (!r.nodes.length && !r.rowResolved) out.push([r.line, r.identifier, '', '', r.lookupFailed ? 'unchecked' : ERROR, r.notes.join(' '), '', '']);
    for (const [name, c] of Object.entries(r.cells)) {
      if (c.status === OK || c.status === SKIP || (!r.nodes.length)) continue;
      out.push([r.line, r.identifier, nid, name, c.status, c.note, c.sheet.join(' | '), c.server.join(' | ')]);
    }
  }
  for (const n of result.extra) out.push(['', n.identifier, n.nid, '', 'extra', 'In the repository but not in the file', '', n.title]);
  return out.map((line) => line.map((v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');
}
