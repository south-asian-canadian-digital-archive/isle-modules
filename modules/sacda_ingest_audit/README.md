# SACDA Ingest Audit

**`/admin/content/ingest-audit`** (Content → Ingest audit), permission
`use ingest audit`.

Upload the spreadsheet a collection was ingested from (Workbench CSV, Excel,
ODS, or a Google Sheets link). Each row is matched to a node by
**`field_identifier`**, and every column is checked against what the repository
holds.

**All three content types.** Rows are looked up across every content type
with `field_identifier` (Repository Item, Collection, Archival Component), so
one sheet can hold a fonds, its series and its items. Results show each row's
type, can be filtered by it, and the summary breaks matches down per type.
Fields only some types have are labelled as such in the mapping list.

**Column mapping.** The identifier column has its own picker ("Match rows on").
Columns named after a field or a Workbench column (`parent_id`, `file`, …) are
matched automatically and only summarised. Anything else is mapped on purpose:
choose the column, press **+ Add**, pick the field. Common aliases ("Object ID",
"Parent ID", "File name") arrive pre-added. Choices are remembered per header
name in the viewer's browser. If the mapping changes after a run, a banner
offers to re-run instead of leaving stale results on screen.

**Marking issues resolved.** Click a cell. If the same discrepancy (same
column, same file value, same repository value) occurs in other rows, the
panel offers **Mark all N identical resolved**, plus **Only this row**.
Missing or duplicated identifiers use **Mark row resolved**. Resolved issues
drop out of the filters, counts and CSV export; **Show resolved** brings them
back struck through, and unresolving a group unresolves all of it.

Marks are keyed on the column's header *and the field it is mapped to*, plus
both values. So they survive a remap and re-run for every column whose mapping
didn't change; a remapped column starts clean; and any mark disappears by
itself once either value changes. Marks live in the viewer's browser
(localStorage).

## What does not stop an audit

Problems are repaired or isolated and reported, never fatal to the whole run:

| Problem | Handling |
|---|---|
| duplicate header (`repository` twice) | second copy listed as `repository (2)`, not compared unless mapped |
| blank header with data under it | listed as `(column N)`, not compared unless mapped; empty columns dropped |
| title row(s) above the headers | header row guessed (first of the top 10 rows with the most filled cells); **Header row** picker to override |
| header named `__proto__`, `__line`, … | suffixed so it cannot clobber row internals |
| Windows-1252 CSV (Excel "CSV") | detected and decoded as such, with a notice to save as CSV UTF-8 |
| no data rows | notice, not an error |
| transient request failure (network, 429, 5xx, Cloudflare 52x) | retried 3× with backoff |
| a lookup that still fails | only that chunk's rows are marked **not checked** (never "not found"); a banner lists the failures with a Retry button |
| file check / extra-node scan fails | affected file cells become warnings, the extra list is flagged incomplete |
| very long identifiers | IN-filter chunks are sized by URL length, not just count |

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
| text / string / number / link / geolocation | whitespace ignored entirely ("Paldi,BC" = "Paldi, BC", including non-breaking/zero-width spaces and `&nbsp;`); case, accents and quote style relaxed as a fallback; 255-char truncation tolerated | **error** |
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
the DOM. Row height is measured rather than assumed, the window is clamped at
the end, and scroll anchoring is off, so it doesn't jump at the bottom. Measured on DEV with 5,000 rows: 488 → 327 requests, 15.9 s → 7.1 s.
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
