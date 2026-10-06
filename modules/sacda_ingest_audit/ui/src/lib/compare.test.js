import { describe, expect, test } from 'bun:test';
import { compareCell, planColumns, suggestMapping, pairChanges, differenceTypes, OK, INFO, WARN, ERROR } from './compare.js';

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

  test('whitespace-only differences are ignored everywhere', () => {
    const t = (sheet, server) => compareCell(sheet, [{ display: server, text: server }], col('text')).status;
    expect(t('Paldi,BC', 'Paldi, BC')).toBe(OK);
    expect(t('Lashkar ,  Donie', 'Lashkar, Donie')).toBe(OK);
    expect(t('Bonto\u200B Singh', 'Bonto Singh')).toBe(OK);
    expect(t('Bonto\u00A0Singh', 'Bonto Singh')).toBe(OK);
    expect(t('Bonto Singh', '<p>Bonto&nbsp;Singh</p>')).toBe(OK);
    expect(t('Bonto Singh', 'Banto Singh')).toBe(ERROR);
    const field = { targetBundles: ['person'] };
    const item = { display: '', rel: 'relators:cre', term: { tid: 5, name: 'Singh, Gobind', uris: [] } };
    expect(compareCell('relators: cre:person:Singh,Gobind', [item], col('typed'), { field, multi: true }).status).toBe(OK);
    expect(compareCell('2021_04_SF1 ', [{ display: '', identifier: '2021_04_SF1', nid: 1 }], col('node', 'parent'), { multi: true }).status).toBe(OK);
  });

  test('dates match by EDTF meaning, not text', () => {
    const d = (sheet, server) => compareCell(sheet, [{ display: server, text: server }], col('edtf'), { multi: true }).status;
    expect(d('193-', '193X?')).toBe(OK);
    const multi = compareCell('1930s|ca. 1950', [{ display: '1950~', text: '1950~' }, { display: '193X', text: '193X' }], col('edtf'), { multi: true });
    expect(multi.status).toBe(OK);
    expect(multi.note).toMatch(/EDTF/);
    expect(d('1935', '193X?')).toBe(WARN);
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
    expect(r.note).toMatch(/ignoring whitespace, case/);
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

  test('media is checked both ways', () => {
    const fileCol = col('file', 'file');
    const media = [{ display: 'a.jpg', filename: 'a.jpg' }];
    expect(compareCell('a.jpg', [], fileCol, { multi: true }).status).toBe(ERROR);
    expect(compareCell('', media, fileCol, { multi: true }).status).toBe(ERROR);
    expect(compareCell('', [], fileCol, { multi: true }).status).toBe(OK);
    expect(compareCell('a.jpg', [...media, { display: 'b.jpg', filename: 'b.jpg' }], fileCol, { multi: true }).status).toBe(ERROR);
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

const bundles = { islandora_object: { fields: {
  title: { type: 'string', label: 'Title' },
  field_identifier: { type: 'string', label: 'Identifier' },
  field_subject: { type: 'entity_reference', targetType: 'taxonomy_term', label: 'Subject' },
} } };

describe('planColumns', () => {
  test('classifies Workbench columns by suggestion', () => {
    const plan = planColumns(['id', 'field_identifier', 'parent_id', 'title', 'field_subject', 'file', 'field_typo'], bundles);
    expect(plan.map((c) => c.role)).toEqual(['workbench', 'identifier', 'parent', 'field', 'field', 'file', 'unknown']);
    expect(plan[4].fuzzy).toBe(true);
  });

  test('explicit mapping renames columns onto fields', () => {
    const plan = planColumns(['Object ID', 'Name', 'Scan'], bundles, { 'Object ID': 'field_identifier', Name: 'title', Scan: 'file' });
    expect(plan.map((c) => [c.role, c.target])).toEqual([['identifier', 'field_identifier'], ['field', 'title'], ['file', 'file']]);
  });

  test('an unmapped column is not compared', () => {
    expect(planColumns(['title'], bundles, { title: '' })[0].role).toBe('unknown');
  });
});

describe('suggestMapping', () => {
  test('matches labels and aliases, ignoring case and punctuation', () => {
    expect(suggestMapping(['Identifier', 'TITLE', 'Parent ID', 'File name', 'Notes'], bundles)).toEqual({
      Identifier: 'field_identifier', TITLE: 'title', 'Parent ID': 'parent_id', 'File name': 'file', Notes: '',
    });
  });

  test('only one column gets the match key; Workbench id is the fallback', () => {
    expect(suggestMapping(['identifier', 'field_identifier'], bundles)).toEqual({ identifier: 'field_identifier', field_identifier: '' });
    expect(suggestMapping(['id', 'title'], bundles).id).toBe('field_identifier');
  });
});

describe('pairing changed values', () => {
  test('a lone value on each side is a change', () => {
    expect(pairChanges(['Bonto'], ['Banto Singh'])).toEqual([['Bonto', 'Banto Singh']]);
  });
  test('multi-valued: pairs by similarity, leaves the rest missing / extra', () => {
    const pairs = pairChanges(['Singh, Mayo', 'Airplanes'], ['Trucks', 'Singh, Mayo, 1891-1955']);
    expect(pairs).toEqual([['Singh, Mayo', 'Singh, Mayo, 1891-1955']]);
  });
  test('cell difference types', () => {
    const items = [{ display: 'Friendship', term: { tid: 1, name: 'Friendship', uris: [] } }, { display: 'Group portraits, 1900-1999', term: { tid: 2, name: 'Group portraits, 1900-1999', uris: [] } }];
    const c = compareCell('Friendship|Group portraits|Airplanes', items, { name: 'x', role: 'field', kind: 'term' }, { multi: true });
    expect(c.pairs).toEqual([['Group portraits', 'Group portraits, 1900-1999']]);
    expect(differenceTypes(c)).toEqual({ missing: true, changed: true, extra: false });
  });
});
