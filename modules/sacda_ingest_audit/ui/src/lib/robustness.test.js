import { describe, expect, test, afterEach } from 'bun:test';
import { buildTable, guessHeaderRow } from './table.js';
import { chunks } from './repository.js';
import { runAudit, issuesCsv } from './audit.js';

describe('buildTable never rejects a sheet over its headers', () => {
  test('duplicate headers get numbered copies and a notice', () => {
    const t = buildTable([['field_identifier', 'repository', 'repository'], ['a', 'x', 'y']], 1);
    expect(t.headers).toEqual(['field_identifier', 'repository', 'repository (2)']);
    expect(t.rows[0]).toMatchObject({ repository: 'x', 'repository (2)': 'y' });
    expect(t.notices[0]).toMatch(/appears twice/);
  });

  test('blank headers are named; fully empty columns are dropped', () => {
    const t = buildTable([['field_identifier', '', '', 'title'], ['a', 'x', '', 'y']], 1);
    expect(t.headers).toEqual(['field_identifier', '(column 2)', 'title']);
    expect(t.rows[0]['(column 2)']).toBe('x');
  });

  test('reserved names cannot clobber row internals', () => {
    const t = buildTable([['field_identifier', '__proto__', '__line'], ['a', 'x', 'y']], 1);
    expect(t.headers).toEqual(['field_identifier', '__proto__ (column)', '__line (column)']);
    expect(t.rows[0]['__proto__ (column)']).toBe('x');
    expect(t.rows[0].__line).toBe(2);
  });

  test('a title row above the headers is skipped by the guess', () => {
    const m = [['SACDA export 2024', '', ''], ['field_identifier', 'title', 'file'], ['a', 'b', 'c']];
    expect(guessHeaderRow(m)).toBe(2);
    expect(buildTable(m).rows[0]).toMatchObject({ __line: 3, field_identifier: 'a' });
  });

  test('a header-only sheet is a notice, not an error', () => {
    expect(buildTable([['field_identifier', 'title']], 1).notices).toContain('There are no data rows below the header row.');
  });
});

describe('chunks', () => {
  test('long identifiers are split to keep URLs short', () => {
    const long = Array.from({ length: 50 }, (_, i) => `${'x'.repeat(300)}${i}`);
    const parts = chunks(long);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.flat()).toEqual(long);
  });
});

describe('runAudit survives failed requests', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  const settings = {
    jsonapi: '/jsonapi', origin: 'https://example.test', originalFileUse: 'u',
    mediaBundles: {}, bundles: { islandora_object: { label: 'Item', fields: { title: { type: 'string', label: 'Title', cardinality: 1 }, field_identifier: { type: 'string', label: 'Identifier', cardinality: 1 } } } },
  };
  const node = (id, title) => ({ type: 'node--islandora_object', id: `uuid-${id}`, attributes: { field_identifier: id, title, drupal_internal__nid: 1 }, relationships: {} });

  test('date option reaches the audit comparison and removes only matching first-day issues', async () => {
    const dateSettings = structuredClone(settings);
    dateSettings.bundles.islandora_object.fields.field_edtf_date = { type: 'edtf', label: 'Date', cardinality: -1 };
    globalThis.fetch = async () => {
      const item = node('a', 'T');
      item.attributes.field_edtf_date = ['2012-12-01'];
      return new Response(JSON.stringify({ data: [item], links: {} }), { status: 200 });
    };
    const table = { headers: ['field_identifier', 'date'], rows: [
      { __line: 2, field_identifier: 'a', date: '2012-12' },
    ] };
    const options = { mapping: { field_identifier: 'field_identifier', date: 'field_edtf_date' },
      delimiter: '|', scanExtra: false };
    const before = await runAudit(table, dateSettings, options);
    expect(before.stats.columns.date.warn).toBe(1);
    expect(issuesCsv(before)).toContain('2012-12-01');
    const after = await runAudit(table, dateSettings, { ...options, matchMonthStart: true });
    expect(after.stats.columns.date.ok).toBe(1);
    expect(issuesCsv(after).split('\n')).toHaveLength(1);
    const reset = await runAudit(table, dateSettings, { ...options, matchMonthStart: false });
    expect(reset.stats.columns.date.warn).toBe(1);
  });

  test('audit requests geographic alternate names and removes recognized codes from issue counts', async () => {
    const geoSettings = structuredClone(settings);
    geoSettings.bundles.islandora_object.fields.field_geographic_subject = {
      type: 'entity_reference', targetType: 'taxonomy_term', targetBundles: ['geo_location'],
      label: 'Subject (Geographic)', cardinality: -1,
    };
    const ref = { type: 'taxonomy_term--geo_location', id: 'place', meta: { drupal_internal__target_id: 7 } };
    globalThis.fetch = async (url) => {
      expect(new URL(url).searchParams.get('fields[taxonomy_term--geo_location]')).toContain('field_geo_alt_name');
      const item = node('a', 'T');
      item.relationships.field_geographic_subject = { data: [ref] };
      return new Response(JSON.stringify({ data: [item], included: [{ ...ref, attributes: {
        name: 'Mackenzie', field_geo_alt_name: ['Legacy place name'],
      } }], links: {} }), { status: 200 });
    };
    const table = { headers: ['field_identifier', 'subjectGeographic'], rows: [
      { __line: 2, field_identifier: 'a', subjectGeographic: 'mackenzie lake_bc' },
      { __line: 3, field_identifier: 'a', subjectGeographic: 'Legacy place name' },
    ] };
    const result = await runAudit(table, geoSettings, { mapping: {
      field_identifier: 'field_identifier', subjectGeographic: 'field_geographic_subject',
    }, delimiter: '|', scanExtra: false });
    expect(result.stats.columns.subjectGeographic).toMatchObject({ ok: 2, warn: 0, error: 0 });
  });

  test('a failing chunk marks its rows "not checked" and the rest still compare', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `id${String(i).padStart(2, '0')}`);
    globalThis.fetch = async (url) => {
      const u = decodeURIComponent(String(url));
      if (u.includes('id00')) return new Response('nope', { status: 403 }); // first chunk: hard failure
      const data = ids.filter((id) => u.includes(`=${id}&`) || u.endsWith(`=${id}`)).map((id) => node(id, 'T'));
      return new Response(JSON.stringify({ data, links: {} }), { status: 200 });
    };
    const table = { headers: ['field_identifier', 'title'], rows: ids.map((id, i) => ({ __line: i + 2, field_identifier: id, title: 'T' })) };
    const r = await runAudit(table, settings, { mapping: { field_identifier: 'field_identifier', title: 'title' }, delimiter: '|', scanExtra: false });
    expect(r.stats.unchecked).toBe(50);
    expect(r.stats.notFound).toBe(0);
    expect(r.stats.found).toBe(10);
    expect(r.failures[0]).toMatchObject({ stage: 'Node lookup', count: 50 });
    expect(r.rows[0].status).toBe('warn');
  });

  test('transient 502s are retried', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) return new Response('bad gateway', { status: 502 });
      return new Response(JSON.stringify({ data: [node('a', 'T')], links: {} }), { status: 200 });
    };
    const table = { headers: ['field_identifier'], rows: [{ __line: 2, field_identifier: 'a' }] };
    const r = await runAudit(table, settings, { mapping: { field_identifier: 'field_identifier' }, delimiter: '|', scanExtra: false });
    expect(r.failures).toEqual([]);
    expect(r.stats.found).toBe(1);
  });
});
