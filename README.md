# SACDA Hero

Stores per-page hero sections (title, subtitle, background image) as **config
entities** (`sacda_hero.hero.*`) instead of hardcoding them in theme templates.
Because they are config, heroes deploy with the rest of the site config via
`drush cex` / `drush cim` — no code change needed to add or edit a hero.

## Managing heroes

Admin UI: **Structure → SACDA Hero sections** (`/admin/structure/sacda-hero`),
permission `administer sacda hero`. Each hero has:

- **path** — the URL alias it applies to (e.g. `/about`, `/about/team`);
  exact match against the current page's alias.
- **title** / **subtitle** — displayed text.
- **image** — a media entity, stored as its UUID (config entities cannot hold
  entity reference fields). Empty = no background; the theme macro falls back
  to a solid colour. The referenced media is *content*, so it must exist on the
  target site — config only carries the UUID.
- **image_style** — optional image style machine name; empty serves the
  original file.

## Theme consumption

`hook_preprocess_page()` sets `$variables['sacda_hero']` =
`['title' => ..., 'subtitle' => ..., 'image' => <URL string>]` on matching
pages — exactly the options shape of the sacda theme's hero macro. In
`page.html.twig` (or a page template suggestion):

```twig
{% import '@sacda/macros/hero.twig' as hero %}
{% if sacda_hero %}
  {{ hero.section(sacda_hero) }}
{% endif %}
```

Cacheability is handled: the hero config entity, media, file and image style
are attached as cache dependencies, plus the `url.path` cache context and the
`config:sacda_hero_list` tag, so pages update when heroes change.

## Why not per-node fields?

A field-based hero would only work on node pages. Several hero-bearing pages
(`/about/team`, `/about/media`, `/exhibits`) are **Views pages with no node**,
so path-matched config entities were chosen deliberately.

---

# Place Lookup

Internal cataloguing tool at **`/admin/content/places/lookup`**. Replaces the
"Find > Places > Basic Search" step of the CA cataloguing manual.

An RA types a place name; candidates appear as they type from **Getty TGN** and
**CGNDB**, each showing whether that place already exists in the
`geo_location` vocabulary. The RA copies the authority identifier for the ingest
spreadsheet. Places with no match route to the archivist.

The point of copying a TGN/CGNDB id rather than a coined slug like `surrey_bc`:
a slug has no external referent, so a wrong one fails silently at ingest — which
is why the manual has to shout NEVER GUESS. An authority id either resolves
against the mirror or it does not, so wrong values are catchable *before*
ingest.

## Everything is served from a local table

`sacda_place_authority` is a local mirror. **Nothing calls Getty or NRCan at
keystroke time**, and that is not an optimisation:

- Getty discontinued its TGN XML web services and is part-way through a
  multi-year infrastructure migration. A live integration is a scheduled outage.
- Per-keystroke requests to a third party get us rate-limited within a day of
  real use.
- A network round trip per keystroke is not "instant". The local index is
  sub-millisecond on the common path.
- Offline means reproducible: the same query returns the same result next month,
  which matters when the archivist reviews an RA's work.

Getty explicitly encourages periodic refresh over live querying.

## Refreshing the data

Dumps live in a host directory bind-mounted to `/opt/place-dumps`
(`docker-compose.dev.yml`). They are gitignored — **never commit them**, the TGN
release is ~3.5 GB compressed.

| Source | File | Size | Where from | Rows imported |
|---|---|---|---|---|
| Getty TGN | `tgn_xml_0126.zip` | 3.2 GB | `tgndownloads.getty.edu/VocabData/` | 982,355 |
| CGNDB | `cgn_canada_csv_eng.zip` | 15 MB | `ftp.maps.canada.ca/pub/nrcan_rncan/vector/geobase_cgn_toponyme/prov_csv_eng/` | 364,489 |

Refresh quarterly. Full import takes about five minutes end to end.

```bash
drush sacda-place:sync-authority                  # both sources
drush sacda-place:sync-authority --source=cgndb   # one source; the other is untouched
drush sacda-place:sync-local                      # re-match against geo_location; nightly
drush sacda-place:status                          # row counts
```

`sync-authority` purges and reloads **per source**, then chains `sync-local`
automatically (a reload discards the local match columns).

### The TGN release is not one XML file

This is the single most surprising thing here. `tgn_xml_0126.zip` contains
**2,991,143 individual XML files**, one per subject at `tgn/<Subject_ID>.xml`,
each a complete little `<Vocabulary>` document. So the parser walks zip entries;
it does not stream one giant document.

Opening that archive costs **~1.2 GB of RSS** — the central directory, allocated
by libzip *outside* PHP's heap, so `memory_get_usage()` reports a flat 40 MB and
will mislead you. Measured: reads do not leak, RSS is flat start to finish, and
`close()` returns all of it. The archive is therefore opened exactly **once**. An
earlier version recycled the handle every N entries on a leak theory; that was
strictly worse, because a reopen can allocate the new directory before releasing
the old one and spike to 2.4 GB, which is what actually got OOM-killed on this
~4 GB container.

Other things the real files disagree with the documentation about:

- `Parent_String` lives under `Parent_Relationships/Preferred_Parent`, not
  directly on `<Subject>`.
- Its segments are formatted `Hokkaidō (prefecture) [1000985]` — the qualifier
  and the bracketed id both have to come off before a nation name can match.
- The variant element is `Non-Preferred_Term`, with a **hyphen** (not a legal
  PHP property name, hence `{'…'}` access).
- Place types are `83002/inhabited place` — id and label joined by a slash.
- Coordinates are at `Coordinates/Standard/Latitude/Decimal`.

TGN is filtered to Canada, India, Pakistan, USA and UK by walking the
`Parent_String` ancestor chain. **Pakistan is not optional** — pre-partition
material resolves to places now in Pakistan, and TGN's historical coverage is
the reason it was chosen over GeoNames.

## Matching against the vocabulary

`local_tids` / `local_match_count` are populated by **normalized name** matching
(term label plus `field_geo_alt_name`), not by authority URI: essentially no
`geo_location` term carries a `field_authority_link` yet, so URI matching would
report "not in vocabulary" for the entire vocabulary.

Name matching over-matches — "Hillcrest" exists in six provinces — so the UI
never reduces it to a yes/no. It shows the matched terms, their broader terms
and their existing authority links, and lets the archivist decide. Three badge
states: **In vocabulary** (1), **Needs review** (2+), **Not in vocabulary** (0).

## Permissions

| Permission | Who | Grants |
|---|---|---|
| `use place lookup` | RAs (`content_editor`) | The page and the JSON endpoint |
| `create place terms` | Archivist | Reserved for the term-creation action (not built yet) |

Both routes are guarded by plain `_permission` requirements — no custom access
checker. This keeps the control point the manual already established: RAs find
places, the archivist establishes them.

## Gotchas

- **Drush 13 command discovery is convention-only and fails silently.** The file
  must be `src/Drush/Commands/PlaceCommands.php`, namespace ending in
  `\Drush\Commands`, class name ending in `Commands`. No `drush.services.yml`
  (removed in Drush 12), no `extra.drush` in `composer.json`. Run `drush cr`
  after touching it.
- **Uninstalling the module drops the table**, silently discarding a full
  import. Re-run the sync commands after any reinstall.
- **The Getty attribution in the page footer is required** by ODC-By 1.0. Do not
  remove it.
- **The CGNDB advisory is deliberately inline**, above the CGNDB results. That
  database contains historical terminology that is racist, offensive and
  derogatory, and the naming authorities are still working through it. For a
  South Asian Canadian archive that is not a help-page footnote.
## How search is layered

At 1.35M rows a naive `LIKE '%foo%'` costs 350–900 ms, which is not "instant".
Four passes, each only reached if the previous under-filled:

1. **Prefix** `name_norm LIKE 'foo%'` — served by the 64-char prefix index,
   sub-millisecond. The overwhelmingly common case.
2. **All words** `MATCH … AGAINST ('+foo* +bar*')` — the FULLTEXT index added by
   update 10002. Finds "Province of British Columbia" from "british columbia".
3. **Any word**, relevance-ranked, only when 2 found nothing for a multi-word
   query. "Anandpur Sahib" has no record with both words, but plenty have
   "Anandpur"; showing those beats an empty list.
4. **Substring** `LIKE '%foo%'` — full-scans, ~400 ms, reached only when
   everything else found *nothing at all*. Being sure before telling an RA "no
   match, send it to the archivist" is worth 400 ms; charging every keystroke
   for it is not.

Results are ordered by country relevance first (CA, IN, PK, GB, US), so "Surrey,
British Columbia" outranks "Surrey, North Dakota". Sorting by `local_match_count`
would do nothing — matching is name-only, so every Surrey on earth carries the
same badge.

Two rules not to break: the prefix condition is never OR-ed together with the
substring ones (that discards the index for the fast path), and query text always
goes through `escapeLike()` plus the query builder's `LIKE` operator, which
appends `ESCAPE '\\'` — hand-writing `->where("… LIKE :q")` would let someone
typing `100%` match the entire table.

FULLTEXT needs tokens of at least `innodb_ft_min_token_size` (3 by default), so
two-character queries are served by pass 1 alone. Everything degrades gracefully
if the index is missing: the service checks for it and falls through to LIKE.

## Coverage, as actually measured

- **CGNDB covers the small BC localities TGN misses.** Clayburn, Hillcrest,
  Paldi and Malahat are all present. TGN has only 11,424 Canadian records against
  CGNDB's 364,489, so for Canadian places CGNDB is the primary source.
- **TGN's India/Pakistan coverage is good but not complete.** 46,751 Indian and
  157,416 Pakistani records, with useful historical depth. It has six places
  called Anandpur — but **not Anandpur Sahib**, so the Punjab-village gap the
  build plan worried about is real. A third source (GeoNames or Wikidata) is
  worth a spike before relying on TGN alone for Punjab.
- **Nation and top-level records are excluded by design**: the nation filter
  matches on *ancestors*, and Canada's own record has no nation above it. A
  search for "Canada" returns US localities named Canada, not the country. Fix
  this if RAs need to catalogue at nation level.
- `--strict` applies a place-type allowlist and roughly halves the import
  (982k → 459k), dropping creeks, streams, peaks and reservoirs. It is a blunt
  instrument: TGN types administrative places as `general region` and
  `second level subdivision`, which the allowlist does not currently carry, so
  strict mode would drop real administrative places. Left off by default.
