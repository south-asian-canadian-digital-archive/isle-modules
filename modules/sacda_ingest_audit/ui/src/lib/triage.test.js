import { test, expect } from 'bun:test';
import { openDifferences, requestTriage, CHUNK } from './triage.js';
import { applyResolved, valueKey, colSpec } from './resolved.js';

const col = (name, extra = {}) => ({ name, target: `field_${name}`, role: 'field', kind: 'term', ...extra });
const cell = (status, sheet, server, missing = [], extra = []) => ({ status, sheet, server, missing, extra, note: 'Terms differ.' });
const row = (line, cells) => ({ line, identifier: `id${line}`, nodes: [{ nid: line }], notes: [], noteStatus: 'ok', status: 'warn', cells });
const result = () => ({
  columns: [{ name: 'id', target: '__key__', role: 'identifier' }, col('subject'), col('date', { kind: 'edtf' })],
  extra: [],
  rows: [
    row(2, { id: cell('ok', ['id2'], ['id2']), subject: cell('warn', ['A', 'Singh, Mayo'], ['A', 'Singh, Mayo, 1891-1955'], ['Singh, Mayo'], ['Singh, Mayo, 1891-1955']), date: cell('ok', ['1934'], ['1934']) }),
    row(3, { id: cell('ok', ['id3'], ['id3']), subject: cell('warn', ['B', 'Singh, Mayo'], ['B', 'Singh, Mayo, 1891-1955'], ['Singh, Mayo'], ['Singh, Mayo, 1891-1955']), date: cell('error', ['1941'], [], ['1941'], []) }),
    row(4, { id: cell('ok', ['id4'], ['id4']), subject: cell('info', [], ['C']), date: cell('skip', ['x'], []) }),
  ],
});

test('one item per distinct difference, widest first, only the unmatched values', () => {
  const items = openDifferences(applyResolved(result(), new Set()));
  expect(items.map((i) => [i.column, i.count])).toEqual([['subject', 2], ['date', 1]]);
  expect(items[0]).toMatchObject({ field: 'field_subject', type: 'term', missing: ['Singh, Mayo'], extra: ['Singh, Mayo, 1891-1955'] });
  expect(items[0].id).toBe(valueKey(colSpec(col('subject')), result().rows[0].cells.subject));
});

test('marked differences are not sent', () => {
  const r = result();
  const marks = new Set([valueKey(colSpec(col('subject')), r.rows[0].cells.subject)]);
  expect(openDifferences(applyResolved(r, marks)).map((i) => i.column)).toEqual(['date']);
});

test('chunks requests, retries a busy service, reports progress', async () => {
  const items = Array.from({ length: CHUNK + 3 }, (_, i) => ({ id: `k${i}` }));
  const calls = [];
  let busy = true;
  const fetchFn = async (url, init) => {
    const sent = JSON.parse(init.body).items;
    calls.push(sent.length);
    if (busy) { busy = false; return { ok: false, status: 503, json: async () => ({ error: 'busy' }) }; }
    return { ok: true, status: 200, json: async () => ({ results: sent.map((s) => ({ id: s.id, verdict: 'same', reason: 'r' })).concat({ id: 'x', verdict: 'bogus' }) }) };
  };
  const progress = [];
  let got = 0;
  await requestTriage('/t', items, (results, done) => { got += results.length; progress.push(done); }, { fetchFn, pause: async () => {} });
  expect(calls).toEqual([CHUNK, CHUNK, 3]);
  expect(progress).toEqual([CHUNK, CHUNK + 3]);
  expect(got).toBe(CHUNK + 3);
});

test('a hard failure surfaces the server message', async () => {
  const fetchFn = async () => ({ ok: false, status: 502, json: async () => ({ error: 'The AI service rejected the site\'s API key.' }) });
  await expect(requestTriage('/t', [{ id: 'a' }], () => {}, { fetchFn })).rejects.toThrow('API key');
});
