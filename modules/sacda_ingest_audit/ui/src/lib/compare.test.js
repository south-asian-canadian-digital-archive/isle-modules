import { describe, expect, test } from 'bun:test';
import { compareCell, planColumns, OK, INFO, WARN, ERROR } from './compare.js';

const term = (name, extra = {}) => ({ display: name, term: { tid: 1, name, vocab: 'subject', uris: [], ...extra } });
const col = (kind, role = 'field') => ({ name: 'x', role, kind });

describe('compareCell', () => {
  test('multi-valued text compares as a set, ignoring order and spacing', () => {
    const items = [{ display: 'b', text: 'b' }, { display: 'a  ', text: 'a  ' }];
    expect(compareCell('a| b', items, col('text'), { multi: true }).status).toBe(OK);
  });

  test('single-valued cells are not split on the delimiter', () => {
    const items = [{ display: 'A | B', text: 'A | B' }];
    expect(compareCell('A | B', items, col('text'), { multi: false }).status).toBe(OK);
  });

  test('blank in file but set on server is informational', () => {
    expect(compareCell('', [{ display: 'x', text: 'x' }], col('text')).status).toBe(INFO);
  });

  test('value missing on server is an error, even for fuzzy kinds', () => {
    expect(compareCell('Buttons', [], col('term'), { multi: true }).status).toBe(ERROR);
  });

  test('term names match with vocabulary prefix, case and accents relaxed', () => {
    const field = { targetBundles: ['subject'] };
    const r = compareCell('subject:Cafe|Buttons', [term('Café'), term('buttons')], col('term'), { field, multi: true });
    expect(r.status).toBe(OK);
    expect(r.note).toMatch(/ignoring case/);
  });

  test('term mismatch is a warning, or an error in strict mode', () => {
    expect(compareCell('Hats', [term('Caps')], col('term'), { multi: true }).status).toBe(WARN);
    expect(compareCell('Hats', [term('Caps')], col('term'), { multi: true, strict: true }).status).toBe(ERROR);
  });

  test('term matches by authority URI', () => {
    const items = [term('Couples', { uris: ['https://id.loc.gov/authorities/subjects/sh96009430'] })];
    expect(compareCell('http://id.loc.gov/authorities/subjects/sh96009430', items, col('term'), { multi: true }).status).toBe(OK);
  });

  test('typed relation must agree on relator and name', () => {
    const field = { targetBundles: ['person', 'corporate_body'] };
    const item = { display: 'relators:cre: Singh, Gobind', rel: 'relators:cre', term: { tid: 5, name: 'Singh, Gobind', uris: [] } };
    expect(compareCell('relators:cre:person:Singh, Gobind', [item], col('typed'), { field, multi: true }).status).toBe(OK);
    expect(compareCell('relators:pht:person:Singh, Gobind', [item], col('typed'), { field, multi: true }).status).toBe(WARN);
    expect(compareCell('relators:cre:5', [item], col('typed'), { field, multi: true }).status).toBe(OK);
  });

  test('parent mismatch is always an error', () => {
    const items = [{ display: 'B', identifier: 'B', nid: 2 }];
    expect(compareCell('A', items, col('node', 'parent'), { multi: true }).status).toBe(ERROR);
  });

  test('file matches on basename and tolerates Drupal collision renames', () => {
    expect(compareCell('2021_04/x/a.jpg', [{ display: 'a.jpg', filename: 'a.jpg' }], col('file', 'file'), { multi: true }).status).toBe(OK);
    expect(compareCell('a.jpg', [{ display: 'a_0.jpg', filename: 'a_0.jpg' }], col('file', 'file'), { multi: true }).status).toBe(OK);
  });

  test('values truncated to 255 characters still match', () => {
    const long = 'x'.repeat(300);
    expect(compareCell(long, [{ display: '', text: long.slice(0, 255) }], col('text')).status).toBe(OK);
  });

  test('geolocation compares numerically', () => {
    const items = [{ display: '', lat: 49.2377768, lng: -123.0950749 }];
    expect(compareCell('49.23777681701099,-123.0950749460191', items, col('geo'), { multi: true }).status).toBe(OK);
  });
});

describe('planColumns', () => {
  test('classifies Workbench columns', () => {
    const bundles = { islandora_object: { fields: { title: { type: 'string', label: 'Title' }, field_subject: { type: 'entity_reference', targetType: 'taxonomy_term', label: 'Subject' } } } };
    const plan = planColumns(['id', 'field_identifier', 'parent_id', 'title', 'field_subject', 'file', 'field_typo'], bundles, 'field_identifier');
    expect(plan.map((c) => c.role)).toEqual(['workbench', 'identifier', 'parent', 'field', 'field', 'file', 'unknown']);
    expect(plan[4].fuzzy).toBe(true);
  });
});
