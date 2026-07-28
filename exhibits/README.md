# SACDA Exhibits — static exhibit codebases

Each subdirectory here is one self-contained static exhibit site (HTML/CSS/JS),
committed to git. There is no upload UI.

## Adding an exhibit

1. Drop the exhibit's build output into `exhibits/<slug>/` — it MUST contain an
   `index.html` at its root. Slugs must match `[a-z0-9][a-z0-9_-]*`
   (e.g. `km`, `union-zindabad`, `legal-history`).
2. Create an **Exhibit** node in Drupal with `field_slug` = `<slug>` (plus
   title, description, thumbnail for the /exhibits listing).
3. Visit `/exhibits/<nid>` — the controller reads
   `exhibits/<slug>/index.html` and renders it inside the SACDA page chrome.

## How assets are served (and the tradeoff taken)

All exhibit files are streamed by the module's asset route:

    /exhibits/{nid}/assets/{path}   →   exhibits/{slug}/{path}

with content-type guessed from the file extension, and directory-traversal
containment (realpath check). The `<sacda-exhibit>` element fetches
`index.html` through this route and **rewrites relative `src`/`href`/`srcset`
attributes** in the fetched HTML against the assets base before injecting it.

Therefore: **exhibits must reference their assets with relative paths**
(`css/main.css`, `img/hero.jpg`), never root-absolute (`/css/main.css`).
Relative `url(...)` inside CSS files needs no rewriting — it resolves against
the stylesheet's own URL, which already lives under the asset route.

Tradeoff: streaming through PHP is slower than letting the webserver serve
files directly, and rewriting only covers HTML attributes (JS that builds URLs
at runtime must use relative paths or read the base from
`window.sacdaExhibitRoot.host.getAttribute('base')`). In exchange we get
stable per-node URLs, bundle/permission checks on every request, and no
webserver config or symlinks — the whole exhibit lives in this module.

## Style isolation (Shadow DOM)

Exhibit markup is injected into a shadow root inside a `<sacda-exhibit>`
custom element (`js/sacda-exhibit.js`), so exhibit CSS and the theme's
Tailwind CSS cannot leak into each other. Caveats for exhibit JS:

- Scripts execute in the page's global scope. `document.querySelector()` will
  NOT find exhibit markup — query `window.sacdaExhibitRoot` instead.
- `<base>` tags, `document.write`, and top-level `id` collisions with the host
  page are unsupported.

Legacy exhibits from sacda.ca/exhibits/* may need small adaptations for these
caveats when migrated.

## Demo

`demo/` is a minimal self-contained exhibit proving the pipeline (relative
CSS, image-free, one script using the shadow root). Create an exhibit node
with `field_slug: demo` to see it.
