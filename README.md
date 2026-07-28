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
