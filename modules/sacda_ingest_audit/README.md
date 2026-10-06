# SACDA Ingest Audit

**`/admin/content/ingest-audit`** (Content → Ingest audit), permission
`use ingest audit`.

Upload the spreadsheet a collection was ingested from (Workbench CSV, Excel,
ODS, or a Google Sheets link). Each row is matched to a node by
**`field_identifier`**, and every column is checked against what the repository
holds. The result is a table that highlights rows, columns and cells that don't
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
| `file` | basename of the OriginalFile media's file; Drupal's `_0` collision rename tolerated | no file → **error** |
| text / string / number / link / geolocation | normalised whitespace; case and accents relaxed as a fallback; 255-char truncation tolerated | **error** |
| taxonomy refs, typed relations, EDTF, authority links | term ID, URI or name (`vocab:` prefix stripped); relator must agree | **warning** ("fuzzy", since Workbench reconciles these). *Strict* turns them into errors |
| `id`, `media_use_tid`, … | Workbench options, not stored | not compared |
| anything else | not a field on any content type | not compared, greyed header |

Multi-valued cells are split on the subdelimiter (default `|`) and compared as
sets. A value blank in the file but set in the repository is shown as **info**.
`field_member_of` left blank because `parent_id` drives it is skipped.

## Building the UI

Svelte 5 + Vite, in `ui/`. `dist/` is **committed**, because the Drupal image
build runs no JS toolchain. Rebuild after editing anything under `ui/src`:

```bash
cd ui
bun install
bun run build   # → ../dist/ingest-audit.{js,css}
bun test        # comparison rules (src/lib/compare.test.js)
```

Then `drush cr` so the CSS aggregate is rebuilt.
