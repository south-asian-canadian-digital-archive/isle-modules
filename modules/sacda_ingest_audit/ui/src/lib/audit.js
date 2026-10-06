// Orchestrates one audit run: look up every row's node, then compare cells.
import { Repository, asArray } from './repository.js';
import {
  planColumns, serverItems, compareCell, norm,
  OK, INFO, WARN, ERROR, SKIP, SEVERITY,
} from './compare.js';

/**
 * @param {{headers: string[], rows: object[]}} table
 * @param {object} settings drupalSettings.sacdaIngestAudit
 * @param {{idColumn: string, delimiter: string, strict: boolean, scanExtra: boolean}} options
 * @param {(p: {stage: string, requests?: number}) => void} onProgress
 */
export async function runAudit(table, settings, options, onProgress = () => {}) {
  const started = performance.now();
  let stage = '';
  const repo = new Repository(settings, (p) => onProgress({ stage, ...p }));
  const step = (s) => { stage = s; onProgress({ stage, requests: repo.requests }); };

  const { headers, rows } = table;
  const { idColumn } = options;
  const columns = planColumns(headers, settings.bundles, idColumn);

  const sheetCount = new Map();
  for (const r of rows) {
    const id = norm(r[idColumn]);
    if (id) sheetCount.set(id, (sheetCount.get(id) ?? 0) + 1);
  }
  const identifiers = [...sheetCount.keys()];

  step(`Looking up ${identifiers.length} identifiers`);
  const { nodes, index } = await repo.nodesByIdentifier(identifiers);
  const byIdentifier = new Map();
  for (const n of nodes) {
    const id = norm(n.attributes.field_identifier);
    if (!byIdentifier.has(id)) byIdentifier.set(id, []);
    byIdentifier.get(id).push(n);
  }

  let files = new Map();
  if (columns.some((c) => c.role === 'file') && nodes.length) {
    step('Checking original files');
    files = await repo.originalFiles(nodes.map((n) => n.id));
  }

  step('Comparing');
  const results = rows.map((row) => compareRow(row, { columns, byIdentifier, sheetCount, index, files, settings, options }));

  let extra = [];
  let truncated = false;
  if (options.scanExtra && nodes.length) {
    step('Scanning for nodes missing from the file');
    const roots = scanRoots(nodes, index, rows, columns);
    const found = await repo.descendants(roots);
    truncated = found.truncated;
    const inSheet = new Set(identifiers);
    const titles = new Map([...index.values()].filter((r) => r.type.startsWith('node--'))
      .map((r) => [r.id, r.attributes.field_identifier || r.attributes.title]));
    for (const n of found.nodes) titles.set(n.uuid, n.identifier || n.title);
    extra = found.nodes
      .filter((n) => !inSheet.has(norm(n.identifier)))
      .map((n) => ({ ...n, parentLabels: n.parents.map((p) => titles.get(p) ?? p) }));
  }

  return {
    columns,
    rows: results,
    extra,
    truncated,
    stats: summarise(results, columns, extra),
    requests: repo.requests,
    seconds: (performance.now() - started) / 1000,
  };
}

function compareRow(row, ctx) {
  const { columns, byIdentifier, sheetCount, index, files, settings, options } = ctx;
  const identifier = norm(row[options.idColumn]);
  const matches = identifier ? byIdentifier.get(identifier) ?? [] : [];
  const node = matches[0];
  const notes = [];
  const cells = {};

  let status = OK;
  const raise = (s) => { if (SEVERITY[s] > SEVERITY[status]) status = s; };

  if (!identifier) { notes.push('No identifier in this row.'); raise(ERROR); }
  else if (!node) { notes.push('No node in the repository has this identifier.'); raise(ERROR); }
  if (matches.length > 1) { notes.push(`${matches.length} nodes share this identifier; compared against the first.`); raise(ERROR); }
  if (identifier && sheetCount.get(identifier) > 1) { notes.push('This identifier appears more than once in the file.'); raise(WARN); }

  const bundle = node ? node.type.replace('node--', '') : null;
  const fields = bundle ? settings.bundles[bundle]?.fields ?? {} : {};

  for (const col of columns) {
    const raw = row[col.name] ?? '';
    if (col.role === 'identifier') {
      cells[col.name] = { status: node ? OK : ERROR, sheet: [raw], server: node ? [node.attributes.field_identifier] : [], missing: [], extra: [], note: notes.join(' ') };
      continue;
    }
    if (!node || col.role === 'workbench' || col.role === 'unknown') {
      cells[col.name] = skip(raw, !node ? 'Not compared: no matching node.' : col.role === 'unknown' ? 'Not a field on any content type; not compared.' : 'Workbench ingest option; not stored on the node.');
      continue;
    }
    // Workbench fills field_member_of from parent_id; the parent_id column
    // already carries that comparison.
    if (col.name === 'field_member_of' && !raw.trim() && String(row.parent_id ?? '').trim()) {
      cells[col.name] = skip(raw, 'Set from parent_id at ingest; compared in that column.');
      continue;
    }
    const field = col.role === 'field' ? fields[col.name] : null;
    if (col.role === 'field' && !field) {
      cells[col.name] = raw.trim()
        ? { ...skip(raw, `Not a field on "${bundle}" content, so this value was not ingested.`), status: WARN }
        : skip(raw, `Not a field on "${bundle}" content.`);
      raise(cells[col.name].status);
      continue;
    }
    const items = serverItems(node, col.name, col.kind, index, { files: files.get(node.id) });
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
    status,
    notes,
    counts,
    bundle,
    nodes: matches.map((n) => ({ nid: n.attributes.drupal_internal__nid, uuid: n.id, title: n.attributes.title, bundle: n.type.replace('node--', '') })),
    title: node?.attributes.title ?? row.title ?? '',
    cells,
  };
}

function skip(raw, note) {
  const v = String(raw ?? '').trim();
  return { status: SKIP, sheet: v ? [v] : [], server: [], missing: [], extra: [], note };
}

/**
 * Where to look for nodes the file does not mention: every matched node,
 * plus any parent the file names (parent_id / field_member_of) that is not a
 * row itself. A parent the file never names (e.g. a site-wide root
 * collection above a fonds) is deliberately not scanned.
 */
function scanRoots(nodes, index, rows, columns) {
  const named = new Set();
  for (const r of rows) {
    if (columns.some((c) => c.name === 'parent_id')) for (const p of String(r.parent_id ?? '').split('|')) if (p.trim()) named.add(norm(p));
    if (columns.some((c) => c.name === 'field_member_of')) for (const p of String(r.field_member_of ?? '').split('|')) if (p.trim()) named.add(norm(p));
  }
  const roots = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    for (const ref of asArray(n.relationships.field_member_of?.data)) {
      const parent = index.get(`${ref.type}:${ref.id}`);
      const ident = norm(parent?.attributes.field_identifier);
      const nid = String(ref.meta?.drupal_internal__target_id ?? '');
      if ((ident && named.has(ident)) || named.has(nid)) roots.add(ref.id);
    }
  }
  return [...roots];
}

function summarise(rows, columns, extra) {
  const s = {
    rows: rows.length,
    found: 0, notFound: 0, duplicates: 0,
    ok: 0, warn: 0, error: 0,
    cells: 0, cellsOk: 0,
    extra: extra.length,
    columns: {},
  };
  for (const c of columns) s.columns[c.name] = { ok: 0, info: 0, warn: 0, error: 0, skip: 0 };
  for (const r of rows) {
    if (r.nodes.length) s.found++; else s.notFound++;
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
    if (!r.nodes.length) out.push([r.line, r.identifier, '', '', ERROR, r.notes.join(' '), '', '']);
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
