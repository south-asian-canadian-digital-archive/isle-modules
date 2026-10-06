# SACDA Ingest Audit

**`/admin/content/ingest-audit`** (Content → Ingest audit), permission
`use ingest audit`.

Upload the spreadsheet a collection was ingested from (Workbench CSV, Excel,
ODS, or a Google Sheets link). Each row is matched to a node by
**`field_identifier`**, and every column is checked against what the repository
holds.

**Column mapping.** Every column can be pointed at any field, the match key
(`field_identifier`), or the Workbench columns `parent_id` / `file` /
`url_alias` / `published`, so sheets with headers like "Object ID" or
"Scan file" still work. Columns named after a field map automatically, as do
common aliases and field labels ("Identifier", "Parent ID", "File name").
Choices are remembered per header name in the viewer's browser. The result is a table that highlights rows, columns and cells that don't
match. Nothing is written to the repository.

## How it is built

The custom code is deliberately thin. Repository data comes from **core
JSON:API**, read in the browser with the user's own session:

| Need | Source |
|---|---|
| Node fields, titles, aliases, status | `/jsonapi/node/{bundle}?filter[field_identifier] IN …` |
| Term names / URIs, typed-relation relators | the same request, `include=` every term/node reference field |
| Parent identifiers | `include=field_member_of` |
| Original files | `/jsonapi/media/{bundle}` filtered on `field_media_of` + media use `OriginalFile`, `include=` source file |
| Nodes missing from the sheet | `/jsonapi/node/{bundle}?filter[field_member_of.id] IN …`, breadth first |

The PHP (`src/Controller/IngestAuditController.php`) only:

1. renders the mount point and passes the **field schema** (type, cardinality,
   target vocabularies) in `drupalSettings`, because JSON:API does not expose it;
2. proxies a **Google Sheets CSV export**, because Google sends no CORS headers.
   Only `docs.google.com/spreadsheets/...` links are accepted, and the export URL
   is rebuilt from the sheet key, so it cannot be pointed anywhere else.
   CSRF-protected.

Access is exactly the viewer's normal entity access. A node the user cannot see
reports as "not found".

## What counts as a mismatch

| Column | Compared as | Mismatch is |
|---|---|---|
| `field_identifier` | match key | missing node or duplicates → **error** |
| `parent_id` | parent node's `field_identifier` | **error** (wrong place in hierarchy) |
| `file` | basename of the OriginalFile media's file; Drupal's `_0` collision rename tolerated | checked **both ways**: file named but no Original File media → **error**; file blank but media present → **error**; extra originals → **error** |
| text / string / number / link / geolocation | normalised whitespace; case and accents relaxed as a fallback; 255-char truncation tolerated | **error** |
| taxonomy refs, typed relations, EDTF, authority links | term ID, URI or name (`vocab:` prefix stripped); relator must agree | **warning** ("fuzzy", since Workbench reconciles these). *Strict* turns them into errors |
| `id`, `media_use_tid`, … | Workbench options, not stored | not compared |
| anything else | not a field on any content type | not compared, greyed header |

Multi-valued cells are split on the subdelimiter (default `|`) and compared as
sets. A value blank in the file but set in the repository is shown as **info**.
`field_member_of` left blank because `parent_id` drives it is skipped.

## Speed (5,000-row sheets)

The cost is HTTP round trips to Drupal, not CPU, and Drupal answers at most
`PHP_PM_MAX_CHILDREN` requests at once (5 by default in isle-buildkit). So the
audit is a **map-reduce over 50-identifier chunks**: each chunk is one job
(look the nodes up, then fetch their files), all jobs share one 6-slot
request pool, and the results are merged at the end. On top of that:

- sparse fieldsets: only the mapped fields are returned, roughly halving each response;
- the file check only queries media types that actually hold OriginalFile media;
- the "not in the file" scan descends only into containers (collections,
  compound/paged objects), never into leaf items.

Parsing, fetching and comparing all run in a **Web Worker**, so the page stays
responsive. The results table is **virtualised**: only the rows in view are in
the DOM. Measured on DEV with 5,000 rows: 488 → 327 requests, 15.9 s → 7.1 s.
With thousands of real matches the saving is larger: the file check and the
child scan used to be per-item, which comes to roughly 1,600 requests versus about
520. Raising `PHP_PM_MAX_CHILDREN` on the server is the next lever.

## Building the UI

Svelte 5 + Vite, in `ui/`. `dist/` is **committed**, because the Drupal image
build runs no JS toolchain. Rebuild after editing anything under `ui/src`:

```bash
cd ui
bun install
bun run build   # → ../dist/ingest-audit.{js,css}
bun test        # comparison rules (src/lib/compare.test.js)
```

Then `drush cr`. The library has no `version` and is not aggregated on
purpose: the built files keep fixed names, so the URL carries Drupal's
cache-busting query string (renewed by `drush cr`, which every deploy runs).
Without it Cloudflare served the previous build indefinitely.
