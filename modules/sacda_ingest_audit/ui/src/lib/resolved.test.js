import { describe, expect, test } from 'bun:test';
import { applyResolved, cellKey, rowKey } from './resolved.js';

const cell = (status, sheet = ['a'], server = ['b']) => ({ status, sheet, server, missing: [], extra: [], note: '' });
const result = () => ({
  columns: [{ name: 'id', role: 'identifier' }, { name: 'title', role: 'field' }, { name: 'date', role: 'field' }],
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

  test('row-level issues (not found) are resolved per row', () => {
    const r = result();
    const v = applyResolved(r, new Set([rowKey(r.rows[1])]));
    expect(v.rows[1].rowResolved).toBe(true);
    expect(v.rows[1].status).toBe('ok');
  });
});
