import { describe, expect, test } from 'bun:test';
import { applyResolved, cellKey, rowKey, valueKey, groupSizes } from './resolved.js';
import { issuesCsv } from './audit.js';

const cell = (status, sheet = ['a'], server = ['b'], missing = sheet, extra = server) => ({ status, sheet, server, missing, extra, note: '' });
const result = () => ({
  columns: [{ name: 'id', role: 'identifier' }, { name: 'title', role: 'field' }, { name: 'date', role: 'field' }],
  // (no targets here, so colSpec(column) is just the header name)
  extra: [],
  rows: [
    { line: 2, identifier: 'x1', status: 'error', noteStatus: 'ok', notes: [], nodes: [{}], bundle: 'islandora_object',
      cells: { id: cell('ok'), title: cell('error'), date: cell('warn') } },
    { line: 3, identifier: 'x2', status: 'error', noteStatus: 'error', notes: ['No node'], nodes: [], bundle: null,
      cells: { id: cell('error'), title: cell('skip'), date: cell('skip') } },
  ],
});

describe('applyResolved', () => {
  test('resolving every issue in a row makes it match; stats follow', () => {
    const r = result();
    const marks = new Set([cellKey(r.rows[0], 'title', r.rows[0].cells.title), cellKey(r.rows[0], 'date', r.rows[0].cells.date)]);
    const v = applyResolved(r, marks);
    expect(v.rows[0].status).toBe('ok');
    expect(v.rows[0].cells.title.resolved).toBe('error');
    expect(v.resolvedCount).toBe(2);
    expect(v.stats.error).toBe(1);
    expect(r.rows[0].status).toBe('error'); // original untouched
  });

  test('a partially resolved row keeps its worst remaining status', () => {
    const r = result();
    const v = applyResolved(r, new Set([cellKey(r.rows[0], 'title', r.rows[0].cells.title)]));
    expect(v.rows[0].status).toBe('warn');
  });

  test('a mark only hides that exact discrepancy', () => {
    const r = result();
    const marks = new Set([cellKey(r.rows[0], 'title', r.rows[0].cells.title)]);
    r.rows[0].cells.title = cell('error', ['a'], ['changed on server']);
    expect(applyResolved(r, marks).rows[0].cells.title.resolved).toBeUndefined();
  });

  test('a value mark resolves every identical discrepancy, and only those', () => {
    const r = result();
    r.rows.push({ line: 4, identifier: 'x3', status: 'error', noteStatus: 'ok', notes: [], nodes: [{}], bundle: 'islandora_object',
      cells: { id: cell('ok'), title: cell('error'), date: cell('warn', ['a'], ['other']) } });
    expect(groupSizes(r).get(valueKey('title', r.rows[0].cells.title))).toBe(2);
    const v = applyResolved(r, new Set([valueKey('title', r.rows[0].cells.title)]));
    expect(v.rows[0].cells.title.resolvedBy).toBe('value');
    expect(v.rows[2].cells.title.resolvedBy).toBe('value');
    expect(v.resolvedCount).toBe(2);
    // same file value but a different repository value is not "identical"
    const w = applyResolved(r, new Set([valueKey('date', r.rows[0].cells.date)]));
    expect(w.rows[2].cells.date.resolved).toBeUndefined();
  });

  test('marks follow the mapping: kept for an unchanged column, dropped for a remapped one', () => {
    const r = result();
    r.columns[1].target = 'title';
    const marks = new Set([valueKey('title\u2192title', r.rows[0].cells.title)]);
    expect(applyResolved(r, marks).rows[0].cells.title.resolved).toBe('error');
    r.columns[1].target = 'field_alt_title'; // remapped, same header
    expect(applyResolved(r, marks).rows[0].cells.title.resolved).toBeUndefined();
  });

  test('multi-valued cells group on the difference, not the whole cell', () => {
    const r = result();
    const mayo = (others) => cell('warn', [...others, 'Singh, Mayo'], [...others, 'Singh, Mayo, 1891-1955'], ['Singh, Mayo'], ['Singh, Mayo, 1891-1955']);
    r.rows[0].cells.date = mayo(['Singh, Basant']);
    r.rows[1].cells.date = mayo(['Singh, Karm', 'Singh, Ranjit']);
    r.rows[1].nodes = [{}]; r.rows[1].noteStatus = 'ok';
    expect(groupSizes(r).get(valueKey('date', r.rows[0].cells.date))).toBe(2);
    const v = applyResolved(r, new Set([valueKey('date', r.rows[0].cells.date)]));
    expect(v.rows[0].cells.date.resolvedBy).toBe('value');
    expect(v.rows[1].cells.date.resolvedBy).toBe('value');
  });

  test('row-level issues (not found) are resolved per row', () => {
    const r = result();
    const v = applyResolved(r, new Set([rowKey(r.rows[1])]));
    expect(v.rows[1].rowResolved).toBe(true);
    expect(v.rows[1].status).toBe('ok');
  });
});

describe('problem marks and the CSV export', () => {
  test('a problem leaves the view but stays in the export; resolved leaves both', () => {
    const r = result();
    const v = applyResolved(r,
      new Set([cellKey(r.rows[0], 'date', r.rows[0].cells.date)]),          // resolved
      new Set([valueKey('title', r.rows[0].cells.title), rowKey(r.rows[1])])); // problems
    expect(v.rows[0].status).toBe('ok');
    expect(v.rows[0].cells.title.flagged).toBe('error');
    expect(v.rows[1].rowFlagged).toBe(true);
    expect(v.problemCount).toBe(2);
    expect(v.resolvedCount).toBe(1);
    const csv = issuesCsv({ ...v, extra: [] }).split('\n');
    expect(csv[0]).toBe('line,identifier,node,column,status,review,note,in_file,in_repository');
    expect(csv.some((l) => l.startsWith('2,x1,') && l.includes(',title,error,confirmed problem,'))).toBe(true);
    expect(csv.some((l) => l.startsWith('3,x2,') && l.includes('confirmed problem'))).toBe(true);
    expect(csv.some((l) => l.includes(',date,'))).toBe(false); // resolved: not exported
  });

  test('a problem mark wins over a resolved mark on the same cell', () => {
    const r = result();
    const k = valueKey('title', r.rows[0].cells.title);
    const v = applyResolved(r, new Set([k]), new Set([k]));
    expect(v.rows[0].cells.title.flagged).toBe('error');
    expect(v.rows[0].cells.title.resolved).toBeUndefined();
  });
});
