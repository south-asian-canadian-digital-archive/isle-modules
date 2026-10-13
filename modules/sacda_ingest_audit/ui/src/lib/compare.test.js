import { describe, expect, test } from 'bun:test';
import { compareCell, serverItems, planColumns, suggestMapping, pairChanges, differenceTypes, OK, INFO, WARN, ERROR } from './compare.js';

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

  test('language codes match names in either direction', () => {
    for (const [code, name] of [['en', 'English'], ['eng', 'English'], ['pa', 'Punjabi'],
      ['pan', 'Punjabi'], ['fr', 'French'], ['fra', 'French'], ['fre', 'French'],
      ['hin', 'Hindi'], ['urd', 'Urdu']]) {
      const result = compareCell(code, [term(name, { vocab: 'language' })], col('term'), { strict: true });
      expect(result.status).toBe(OK);
      expect(result.note).toMatch(/language codes/);
      expect(compareCell(name, [term(code, { vocab: 'language' })], col('term')).status).toBe(OK);
    }
    const field = { targetBundles: ['language'] };
    expect(compareCell('language:eng|pan', [term('Punjabi', { vocab: 'language' }),
      term('English', { vocab: 'language' })], col('term'), { field, multi: true }).status).toBe(OK);
    expect(compareCell('en', [term('French', { vocab: 'language' })], col('term')).status).toBe(WARN);
    expect(compareCell('zzz', [term('English', { vocab: 'language' })], col('term')).status).toBe(WARN);
    expect(compareCell('eng', [term('English')], col('term')).status).toBe(WARN);
    expect(compareCell('eng', [], col('term')).status).toBe(ERROR);
  });

  test('month-only dates match day 01 only when the setting is enabled', () => {
    const date = (sheet, server, options = {}) => compareCell(sheet,
      [{ display: server, text: server }], col('edtf'), options);
    expect(date('2012-12', '2012-12-01').status).toBe(WARN);
    const result = date('2012-12', '2012-12-01', { matchMonthStart: true, strict: true });
    expect(result.status).toBe(OK);
    expect(result.note).toMatch(/adds day 01/);
    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual([]);
    for (const [sheet, server] of [['2012-12', '2012-12-02'], ['2012-12', '2012-11-01'],
      ['2012-12', '2013-12-01'], ['2012', '2012-01-01'], ['2012-12-01', '2012-12'],
      ['2012-13', '2012-13-01'], ['2012-00', '2012-00-01']]) {
      expect(date(sheet, server, { matchMonthStart: true }).status).toBe(WARN);
    }
    expect(date('193-', '193X?', { matchMonthStart: true }).status).toBe(OK);
    const multi = compareCell('2012-12|2013-01', [
      { display: '2013-01-02', text: '2013-01-02' }, { display: '2012-12-01', text: '2012-12-01' },
    ], col('edtf'), { matchMonthStart: true, multi: true });
    expect(multi.missing).toEqual(['2013-01']);
    expect(multi.extra).toEqual(['2013-01-02']);
  });

  test('geographic shortcodes match names, including the legacy Mackenzie code', () => {
    const geo = (name) => term(name, { vocab: 'geo_location' });
    for (const [code, name] of [
      ['mackenzie lake_bc', 'Mackenzie'], ['VANCOUVER_BC', 'Vancouver'],
      ['new_westminster_bc', 'New Westminster'], ['toronto_on', 'Toronto'],
      ['vancouver_bc', 'Vancouver (British Columbia)'], ['vancouver_bc', 'Vancouver, B.C.'],
    ]) {
      const result = compareCell(code, [geo(name)], col('term'), { strict: true });
      expect(result.status).toBe(OK);
      expect(result.missing).toEqual([]);
      expect(result.extra).toEqual([]);
      expect(result.note).toMatch(/geographic shortcodes/);
    }
  });

  test('geographic normalization preserves actual place and region differences', () => {
    const geo = (name) => term(name, { vocab: 'geo_location' });
    for (const [code, name] of [
      ['vancouver_bc', 'Victoria'], ['vancouver_bc', 'Vancouver, Ontario'],
      ['vancouver_bc', 'vancouver_on'], ['vancouver_zz', 'Vancouver'],
      ['mackenzie lake_on', 'Mackenzie'], ['christina lake_bc', 'Christina'],
    ]) expect(compareCell(code, [geo(name)], col('term')).status).toBe(WARN);
    expect(compareCell('vancouver_bc', [term('Vancouver')], col('term')).status).toBe(WARN);
    expect(compareCell('mackenzie lake_bc', [], col('term')).status).toBe(ERROR);
  });

  test('geographic alternate names are read from JSON:API and recognized', () => {
    const ref = { type: 'taxonomy_term--geo_location', id: 'place', meta: { drupal_internal__target_id: 7 } };
    const resource = { attributes: { name: 'Mackenzie', field_geo_alt_name: ['Mackenzie Lake', 'Legacy place name'] } };
    const items = serverItems({ relationships: { field_geographic_subject: { data: [ref] } } },
      'field_geographic_subject', 'term', new Map([['taxonomy_term--geo_location:place', resource]]));
    expect(compareCell('Legacy place name', items, col('term')).status).toBe(OK);
    expect(compareCell('geo_location:Mackenzie Lake', items, col('term'), { field: { targetBundles: ['geo_location'] } }).status).toBe(OK);
    expect(compareCell('7', items, col('term')).status).toBe(OK);
  });

  test('multi-valued geography matches as a set and retains remaining problems', () => {
    const items = [term('Vancouver', { vocab: 'geo_location' }), term('Mackenzie', { vocab: 'geo_location' })];
    expect(compareCell('mackenzie lake_bc|vancouver_bc', items, col('term'), { multi: true }).status).toBe(OK);
    const result = compareCell('mackenzie lake_bc|victoria_bc', items, col('term'), { multi: true });
    expect(result.status).toBe(WARN);
    expect(result.missing).toEqual(['victoria_bc']);
    expect(result.extra).toEqual(['Vancouver']);
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
