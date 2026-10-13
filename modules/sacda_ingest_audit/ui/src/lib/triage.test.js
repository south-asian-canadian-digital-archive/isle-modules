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

test('queues, then polls only the open ids until all are answered', async () => {
  const items = Array.from({ length: CHUNK + 3 }, (_, i) => ({ id: `k${i}` }));
  const bodies = [];
  let round = 0;
  const fetchFn = async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    const ids = body.items ? body.items.map((i) => i.id) : body.ids;
    // Queueing answers nothing; the first poll answers its first chunk only;
    // the next poll answers the rest.
    round++;
    const answer = body.items || round === 4 ? [] : ids;
    return { ok: true, status: 200, json: async () => ({ results: answer.map((id) => ({ id, verdict: 'same', reason: 'r' })).concat({ id: 'x', verdict: 'bogus' }), pending: 0 }) };
  };
  const waiting = [];
  let got = 0;
  await requestTriage('/t', items, (results, open) => { got += results.length; waiting.push(open); }, { fetchFn, pause: async () => {} });
  expect(bodies.map((b) => (b.items ? `items:${b.items.length}` : `ids:${b.ids.length}`))).toEqual([`items:${CHUNK}`, 'items:3', `ids:${CHUNK}`, 'ids:3', 'ids:3']);
  expect(waiting).toEqual([CHUNK + 3, 3, 0]);
  expect(got).toBe(CHUNK + 3);
});

test('stops polling when asked', async () => {
  let calls = 0;
  const fetchFn = async () => { calls++; return { ok: true, status: 200, json: async () => ({ results: [], pending: 1 }) }; };
  let n = 0;
  await requestTriage('/t', [{ id: 'a' }], () => {}, { fetchFn, pause: async () => {}, stopped: () => ++n > 3 });
  expect(calls).toBe(2);
});

test('a hard failure surfaces the server message', async () => {
  const fetchFn = async () => ({ ok: false, status: 503, json: async () => ({ error: 'AI triage is not set up on this site.' }) });
  await expect(requestTriage('/t', [{ id: 'a' }], () => {}, { fetchFn })).rejects.toThrow('not set up');
});

test('browser copies of verdicts expire after two days', async () => {
  const { load, MAX_AGE_MS } = await import('./triage.js');
  const now = 10 * MAX_AGE_MS;
  globalThis.localStorage = { getItem: () => JSON.stringify([['fresh', { verdict: 'same', at: now - 1000 }], ['old', { verdict: 'same', at: now - MAX_AGE_MS - 1 }], ['legacy', { verdict: 'same' }]]) };
  expect([...load(now).keys()]).toEqual(['fresh']);
  delete globalThis.localStorage;
});

test('agent prompt fills in endpoint, token and expiry', async () => {
  const { agentPrompt } = await import('./agent.js');
  const p = agentPrompt('https://x/ingest-audit/triage-queue', 'ia-abc', 1800000000);
  expect(p).not.toMatch(/<TOKEN>|<ENDPOINT>|<EXPIRY>/);
  expect(p).toContain('Endpoint: https://x/ingest-audit/triage-queue');
  expect(p).toContain('{"token": "ia-abc", "action": "upload"');
  expect(p).toContain('Saroya, Karnail \\"Joe\\" Singh');
  expect(p).toContain('30. Long text cut off');
});
