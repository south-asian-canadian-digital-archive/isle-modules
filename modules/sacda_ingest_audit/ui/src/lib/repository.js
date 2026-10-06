// Reads repository state through core JSON:API. Nothing here is custom
// server code: nodes, terms, parents, media and files all come from the
// standard /jsonapi resources with the current user's session and access.

const PAGE = 50; // JSON:API's hard maximum page size.
const CHUNK = 40; // Values per IN filter; keeps URLs well under limits.
const CONCURRENCY = 4;
const DESCENDANT_CAP = 5000;

export class Repository {
  constructor(settings, onProgress = () => {}) {
    this.base = settings.jsonapi.replace(/\/$/, '');
    this.bundles = settings.bundles;
    this.mediaBundles = settings.mediaBundles;
    this.originalFileUse = settings.originalFileUse;
    this.onProgress = onProgress;
    this.requests = 0;
  }

  async get(url) {
    this.requests++;
    this.onProgress({ requests: this.requests });
    const res = await fetch(url, {
      credentials: 'same-origin',
      headers: { Accept: 'application/vnd.api+json' },
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).errors?.[0]?.detail ?? ''; } catch { /* ignore */ }
      throw new Error(`JSON:API ${res.status} for ${new URL(url, location.href).pathname}${detail ? `: ${detail}` : ''}`);
    }
    return res.json();
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

  collectionUrl(type, bundle, params) {
    const q = new URLSearchParams(params);
    q.set('page[limit]', String(PAGE));
    return `${this.base}/${type}/${bundle}?${q}`;
  }

  /**
   * Nodes whose field_identifier is in `identifiers`, across every bundle
   * that has the field. Returns { nodes: [resource], index: Map(type--id → resource) }.
   */
  async nodesByIdentifier(identifiers) {
    const tasks = [];
    for (const [bundle, info] of Object.entries(this.bundles)) {
      const include = relationshipFields(info.fields).join(',');
      for (const chunk of chunks(identifiers, CHUNK)) {
        const params = filterIn('ident', 'field_identifier', chunk);
        if (include) params.include = include;
        tasks.push(() => this.all(this.collectionUrl('node', bundle, params)));
      }
    }
    return merge(await pool(tasks));
  }

  /**
   * Original-file media for the given node UUIDs, with their files.
   * Returns Map(nodeUuid → [{ media, filename, mime, bundle }]).
   */
  async originalFiles(nodeUuids) {
    const tasks = [];
    for (const [bundle, sourceField] of Object.entries(this.mediaBundles)) {
      for (const chunk of chunks(nodeUuids, CHUNK)) {
        const params = {
          ...filterIn('of', 'field_media_of.id', chunk),
          'filter[use][condition][path]': 'field_media_use.field_external_uri.uri',
          'filter[use][condition][value]': this.originalFileUse,
          include: sourceField,
          [`fields[media--${bundle}]`]: `name,field_media_of,${sourceField}`,
          'fields[file--file]': 'filename,filemime',
        };
        tasks.push(async () => ({ bundle, sourceField, ...(await this.all(this.collectionUrl('media', bundle, params))) }));
      }
    }
    const byNode = new Map();
    for (const { bundle, sourceField, data, included } of await pool(tasks)) {
      const files = new Map(included.filter((r) => r.type === 'file--file').map((f) => [f.id, f]));
      for (const media of data) {
        const fileRef = media.relationships[sourceField]?.data;
        const file = fileRef ? files.get(fileRef.id) : null;
        const entry = {
          bundle,
          mediaId: media.attributes.drupal_internal__mid,
          name: media.attributes.name,
          filename: file?.attributes.filename ?? null,
          mime: file?.attributes.filemime ?? null,
        };
        for (const of of asArray(media.relationships.field_media_of?.data)) {
          if (!byNode.has(of.id)) byNode.set(of.id, []);
          byNode.get(of.id).push(entry);
        }
      }
    }
    return byNode;
  }

  /**
   * Every node below the given node UUIDs (via field_member_of), breadth
   * first. Returns { nodes: [{uuid, nid, bundle, title, identifier, parents}], truncated }.
   */
  async descendants(rootUuids) {
    const found = new Map();
    let frontier = [...new Set(rootUuids)];
    let truncated = false;
    while (frontier.length && !truncated) {
      const tasks = [];
      for (const bundle of Object.keys(this.bundles)) {
        for (const chunk of chunks(frontier, CHUNK)) {
          tasks.push(() => this.all(this.collectionUrl('node', bundle, {
            ...filterIn('parent', 'field_member_of.id', chunk),
            [`fields[node--${bundle}]`]: 'title,field_identifier,drupal_internal__nid,field_member_of',
          })));
        }
      }
      const next = [];
      for (const { data } of await pool(tasks)) {
        for (const n of data) {
          if (found.has(n.id)) continue;
          found.set(n.id, {
            uuid: n.id,
            nid: n.attributes.drupal_internal__nid,
            bundle: n.type.replace('node--', ''),
            title: n.attributes.title,
            identifier: n.attributes.field_identifier ?? '',
            parents: asArray(n.relationships.field_member_of?.data).map((p) => p.id),
          });
          next.push(n.id);
        }
      }
      if (found.size >= DESCENDANT_CAP) truncated = true;
      frontier = next;
    }
    return { nodes: [...found.values()], truncated };
  }
}

/** Entity-reference fields worth including (terms and parent nodes). */
export function relationshipFields(fields) {
  return Object.entries(fields)
    .filter(([, f]) => f.targetType === 'taxonomy_term' || f.targetType === 'node')
    .map(([name]) => name);
}

function filterIn(key, path, values) {
  const p = {
    [`filter[${key}][condition][path]`]: path,
    [`filter[${key}][condition][operator]`]: 'IN',
  };
  // URLSearchParams can't hold repeated keys from an object; encode the
  // array members with explicit indices instead.
  values.forEach((v, i) => { p[`filter[${key}][condition][value][${i}]`] = v; });
  return p;
}

function merge(results) {
  const index = new Map();
  const nodes = new Map();
  for (const { data, included } of results) {
    for (const r of included) index.set(`${r.type}:${r.id}`, r);
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

function* chunks(list, size) {
  for (let i = 0; i < list.length; i += size) yield list.slice(i, i + size);
}

async function pool(tasks, size = CONCURRENCY) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, tasks.length) }, worker));
  return results;
}
