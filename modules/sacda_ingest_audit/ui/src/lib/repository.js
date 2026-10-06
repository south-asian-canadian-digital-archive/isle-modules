// Reads repository state through core JSON:API. Nothing here is custom
// server code: nodes, terms, parents, media and files all come from the
// standard /jsonapi resources with the current user's session and access.
//
// Every request goes through one shared pool, so work from different stages
// (node lookups, file checks, child scans) interleaves and keeps the server's
// PHP workers busy instead of waiting at stage boundaries.

const PAGE = 50; // JSON:API's hard maximum page size.
export const CHUNK = 50; // Values per IN filter: one chunk ≈ one page.
// Drupal answers from a small PHP-FPM pool (5 workers on DEV); a few more
// in flight than that keeps it saturated without just queueing.
const CONCURRENCY = 6;

export class Repository {
  /**
   * @param {object} settings drupalSettings.sacdaIngestAudit, plus `origin`
   *   (absolute URLs are required inside a Web Worker).
   * @param {(n: number) => void} onRequest called with the running request count
   */
  constructor(settings, onRequest = () => {}) {
    this.base = new URL(settings.jsonapi, settings.origin).href.replace(/\/$/, '');
    this.bundles = settings.bundles;
    this.mediaBundles = settings.mediaBundles;
    this.originalFileUse = settings.originalFileUse;
    this.onRequest = onRequest;
    this.requests = 0;
    this.active = 0;
    this.waiting = [];
  }

  async slot(fn) {
    if (this.active >= CONCURRENCY) await new Promise((resolve) => this.waiting.push(resolve));
    this.active++;
    try {
      return await fn();
    }
    finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  get(url) {
    return this.slot(async () => {
      this.onRequest(++this.requests);
      const res = await fetch(url, {
        credentials: 'same-origin',
        headers: { Accept: 'application/vnd.api+json' },
      });
      if (!res.ok) {
        let detail = '';
        try { detail = (await res.json()).errors?.[0]?.detail ?? ''; } catch { /* not JSON */ }
        throw new Error(`JSON:API ${res.status} for ${new URL(url).pathname}${detail ? `: ${detail}` : ''}`);
      }
      return res.json();
    });
  }

  /** GET every page of a collection, returning { data, included }. */
  async all(url) {
    const data = [];
    const included = [];
    let next = url;
    while (next) {
      const doc = await this.get(next);
      data.push(...doc.data);
      if (doc.included) included.push(...doc.included);
      next = doc.links?.next?.href ?? null;
    }
    return { data, included };
  }

  url(type, bundle, params) {
    const q = new URLSearchParams(params);
    q.set('page[limit]', String(PAGE));
    return `${this.base}/${type}/${bundle}?${q}`;
  }

  /**
   * Nodes of any bundle with field_identifier in `identifiers` (≤ CHUNK).
   * `need` = { fields: node fields to return, include: reference fields to
   * embed, vocabularies: term bundles those references can point at }.
   */
  async lookup(identifiers, need) {
    const sparse = {};
    for (const b of Object.keys(this.bundles)) sparse[`fields[node--${b}]`] = need.fields.join(',');
    for (const v of need.vocabularies) sparse[`fields[taxonomy_term--${v}]`] = 'name,field_external_uri,field_authority_link';
    const parts = await Promise.all(Object.entries(this.bundles).map(([bundle, info]) => {
      const include = need.include.filter((f) => f in info.fields);
      const params = { ...filterIn('ident', 'field_identifier', identifiers), ...sparse };
      if (include.length) params.include = include.join(',');
      return this.all(this.url('node', bundle, params));
    }));
    return merge(parts);
  }

  /**
   * Original-file media for the given node UUIDs (≤ CHUNK), with filenames.
   * Returns [[nodeUuid, { mediaId, name, filename, mime, bundle }]].
   */
  async originalFiles(nodeUuids) {
    const parts = await Promise.all(Object.entries(this.mediaBundles).map(async ([bundle, sourceField]) => {
      const { data, included } = await this.all(this.url('media', bundle, {
        ...filterIn('of', 'field_media_of.id', nodeUuids),
        'filter[use][condition][path]': 'field_media_use.field_external_uri.uri',
        'filter[use][condition][value]': this.originalFileUse,
        include: sourceField,
        [`fields[media--${bundle}]`]: `name,field_media_of,${sourceField}`,
        'fields[file--file]': 'filename,filemime',
      }));
      const files = new Map(included.filter((r) => r.type === 'file--file').map((f) => [f.id, f]));
      return data.flatMap((media) => {
        const file = files.get(media.relationships[sourceField]?.data?.id);
        const entry = {
          bundle,
          mediaId: media.attributes.drupal_internal__mid,
          name: media.attributes.name,
          filename: file?.attributes.filename ?? null,
          mime: file?.attributes.filemime ?? null,
        };
        return asArray(media.relationships.field_media_of?.data).map((of) => [of.id, entry]);
      });
    }));
    return parts.flat();
  }

  /** Direct children (via field_member_of) of the given node UUIDs (≤ CHUNK). */
  async children(parentUuids) {
    const fields = 'title,field_identifier,drupal_internal__nid,field_member_of,field_model';
    const parts = await Promise.all(Object.keys(this.bundles).map((bundle) => this.all(this.url('node', bundle, {
      ...filterIn('parent', 'field_member_of.id', parentUuids),
      [`fields[node--${bundle}]`]: fields,
      include: 'field_model',
      'fields[taxonomy_term--islandora_models]': 'name',
    }))));
    return merge(parts);
  }
}

function filterIn(key, path, values) {
  const p = {
    [`filter[${key}][condition][path]`]: path,
    [`filter[${key}][condition][operator]`]: 'IN',
  };
  // An object can't hold repeated keys; index the array members instead.
  values.forEach((v, i) => { p[`filter[${key}][condition][value][${i}]`] = v; });
  return p;
}

/** Reduce step: merge { data, included } parts into nodes + a resource index. */
export function merge(parts) {
  const index = new Map();
  const nodes = new Map();
  for (const { data, included } of parts) {
    for (const r of included ?? []) index.set(`${r.type}:${r.id}`, r);
    for (const r of data) {
      nodes.set(r.id, r);
      index.set(`${r.type}:${r.id}`, r);
    }
  }
  return { nodes: [...nodes.values()], index };
}

export function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

export function chunks(list, size = CHUNK) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
