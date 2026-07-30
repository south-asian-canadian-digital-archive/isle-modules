/**
 * @file
 * Place Lookup: as-you-type search over the local TGN / CGNDB mirror.
 *
 * Plain ES2020, no build step — same as sacda-exhibit.js and year-range.js. The
 * module ships inside a Docker image with no Node stage, so a bundler here
 * would mean committing build output into a git submodule for one file.
 *
 * Nothing in this file talks to Getty or NRCan. It only ever calls our own
 * /api/place-lookup, which reads a local table.
 *
 * @typedef {object} LocalTerm
 * @property {number} tid
 * @property {string} name
 * @property {string} url
 * @property {?string} authority_uri
 * @property {string[]} broader
 *
 * @typedef {object} PlaceResult
 * @property {string} source
 * @property {string} source_label
 * @property {string} source_id
 * @property {?string} source_uri
 * @property {string} name
 * @property {?string} parent_path
 * @property {?string} place_type
 * @property {?number} lat
 * @property {?number} lon
 * @property {string[]} variants
 * @property {number} local_match_count
 * @property {LocalTerm[]} local_terms
 */
(function (Drupal, drupalSettings, once) {
  'use strict';

  /**
   * CGNDB ships historical terminology that is racist, offensive and
   * derogatory, and the naming authorities are still working through it. For a
   * South Asian Canadian archive that is not a help-page footnote — it renders
   * inline, above the CGNDB group, every time.
   */
  const CGNDB_ADVISORY = Drupal.t(
    'Content advisory: the Canadian Geographical Names Database contains historical names that are racist, offensive and derogatory. The naming authorities are still working through them.',
  );

  Drupal.behaviors.sacdaPlaceLookup = {
    attach(context) {
      const config = drupalSettings.sacdaPlaceLookup || {};

      once('sacda-place-lookup', '[data-place-lookup]', context).forEach((root) => {
        init(root, config);
      });
    },
  };

  /**
   * Wires one lookup widget.
   *
   * @param {HTMLElement} root
   * @param {object} config
   */
  function init(root, config) {
    const input = root.querySelector('[data-place-lookup-input]');
    const results = root.querySelector('[data-place-lookup-results]');
    const status = root.querySelector('[data-place-lookup-status]');
    if (!input || !results) {
      return;
    }

    const endpoint = config.endpoint || root.dataset.endpoint;
    const minLength = config.minLength || 2;
    const debounceMs = config.debounce || 150;
    const canCreateTerms = Boolean(config.canCreateTerms);

    /** Flat list of option elements, in visual order, across both groups. */
    let options = [];
    /** Index into `options`, or -1 for nothing active. */
    let active = -1;
    /** In-flight request, so a slow early reply cannot overwrite a fast later one. */
    let controller = null;
    let timer = null;
    let lastQuery = '';

    input.addEventListener('input', () => {
      window.clearTimeout(timer);
      const query = input.value.trim();

      if (query.length < minLength) {
        abort();
        clear();
        setStatus(query.length === 0 ? '' : Drupal.t('Keep typing…'));
        return;
      }

      timer = window.setTimeout(() => run(query), debounceMs);
    });

    input.addEventListener('keydown', onKeydown);

    results.addEventListener('click', (event) => {
      const option = event.target.closest('[data-source-id]');
      if (!option) {
        return;
      }
      // "Establish this place" is a distinct action; everything else on the row
      // is the copy target.
      if (event.target.closest('[data-place-lookup-request]')) {
        return;
      }
      copy(option.dataset.sourceId, option.dataset.name);
    });

    /**
     * Fires one search, cancelling whatever was in flight.
     *
     * The AbortController is the whole reason "instant" search feels solid:
     * without it, a slow response for "sur" can land after the fast response
     * for "surrey" and repaint the stale list.
     *
     * @param {string} query
     */
    function run(query) {
      abort();
      controller = new AbortController();
      lastQuery = query;
      setStatus(Drupal.t('Searching…'));

      const url = `${endpoint}?q=${encodeURIComponent(query)}`;
      fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      })
        .then((response) => {
          if (!response.ok) {
            return response
              .json()
              .catch(() => ({}))
              .then((body) => {
                throw new Error(body.error || describeStatus(response.status));
              });
          }
          return response.json();
        })
        .then((payload) => {
          if (query !== lastQuery) {
            return;
          }
          render(payload);
        })
        .catch((error) => {
          if (error.name === 'AbortError') {
            return;
          }
          clear();
          results.appendChild(errorRow(error.message));
          setStatus(error.message);
        });
    }

    function abort() {
      if (controller) {
        controller.abort();
        controller = null;
      }
    }

    /**
     * Paints the grouped result list.
     *
     * @param {{query: string, total: number, groups: Array}} payload
     */
    function render(payload) {
      clear();

      if (!payload.total) {
        results.appendChild(emptyState(payload.query));
        setStatus(Drupal.t('No matches.'));
        return;
      }

      payload.groups.forEach((group) => {
        if (!group.results.length) {
          return;
        }

        const section = document.createElement('div');
        section.className = `place-lookup__group place-lookup__group--${group.source}`;
        section.setAttribute('role', 'group');
        section.setAttribute('aria-label', group.label);

        const heading = document.createElement('h2');
        heading.className = 'place-lookup__group-title';
        heading.textContent = group.label;
        section.appendChild(heading);

        if (group.source === 'cgndb') {
          const advisory = document.createElement('p');
          advisory.className = 'place-lookup__advisory';
          advisory.textContent = CGNDB_ADVISORY;
          section.appendChild(advisory);
        }

        group.results.forEach((result) => {
          section.appendChild(row(result));
        });

        results.appendChild(section);
      });

      // One flat index across both groups, so arrow keys cross the divider
      // instead of dead-ending at the bottom of the TGN list.
      options = Array.from(results.querySelectorAll('[data-source-id]'));
      options.forEach((option, index) => {
        option.id = `place-lookup-opt-${index}`;
      });
      active = -1;
      input.setAttribute('aria-expanded', 'true');
      setStatus(
        Drupal.formatPlural(payload.total, '1 candidate.', '@count candidates.'),
      );
    }

    /**
     * Builds one result row.
     *
     * Everything is created with createElement/textContent rather than
     * innerHTML: place names are full of apostrophes and parentheses, and some
     * carry markup-hostile characters outright.
     *
     * @param {PlaceResult} result
     *
     * @return {HTMLElement}
     */
    function row(result) {
      const el = document.createElement('div');
      el.className = 'place-lookup__row';
      el.setAttribute('role', 'option');
      el.setAttribute('aria-selected', 'false');
      el.tabIndex = -1;
      el.dataset.sourceId = result.source_id;
      el.dataset.name = result.name;

      const main = document.createElement('div');
      main.className = 'place-lookup__row-main';

      const name = document.createElement('span');
      name.className = 'place-lookup__name';
      name.textContent = result.name;
      main.appendChild(name);

      if (result.place_type) {
        const type = document.createElement('span');
        type.className = 'place-lookup__type';
        type.textContent = result.place_type;
        main.appendChild(type);
      }

      if (result.parent_path) {
        const path = document.createElement('span');
        path.className = 'place-lookup__path';
        path.textContent = result.parent_path;
        main.appendChild(path);
      }

      const meta = document.createElement('span');
      meta.className = 'place-lookup__meta';
      const bits = [`${result.source_label} ${result.source_id}`];
      if (result.lat !== null && result.lon !== null) {
        bits.push(`${result.lat.toFixed(3)}, ${result.lon.toFixed(3)}`);
      }
      if (result.variants.length) {
        bits.push(Drupal.t('also: @names', { '@names': result.variants.slice(0, 3).join('; ') }));
      }
      meta.textContent = bits.join(' · ');
      main.appendChild(meta);

      el.appendChild(main);
      el.appendChild(badge(result, canCreateTerms));
      return el;
    }

    /**
     * Status badge plus, where relevant, the matched local terms.
     *
     * Matching is by name, so it is indicative rather than authoritative —
     * which is exactly why the matched terms are named and linked instead of
     * being reduced to a yes/no. The archivist makes the call.
     *
     * @param {PlaceResult} result
     * @param {boolean} mayCreate
     *
     * @return {HTMLElement}
     */
    function badge(result, mayCreate) {
      const wrap = document.createElement('div');
      wrap.className = 'place-lookup__aside';

      const tag = document.createElement('span');
      tag.className = 'place-lookup__badge';

      if (result.local_match_count === 1) {
        tag.classList.add('place-lookup__badge--exists');
        tag.textContent = Drupal.t('In vocabulary');
      } else if (result.local_match_count > 1) {
        tag.classList.add('place-lookup__badge--review');
        tag.textContent = Drupal.t('Needs review');
      } else {
        tag.classList.add('place-lookup__badge--absent');
        tag.textContent = Drupal.t('Not in vocabulary');
      }
      wrap.appendChild(tag);

      if (result.local_terms.length) {
        const list = document.createElement('ul');
        list.className = 'place-lookup__terms';
        result.local_terms.forEach((term) => {
          const item = document.createElement('li');
          const link = document.createElement('a');
          link.href = term.url;
          link.textContent = term.name;
          // Opening the term must not lose the RA's search.
          link.target = '_blank';
          link.rel = 'noopener';
          item.appendChild(link);

          const detail = [];
          if (term.broader.length) {
            detail.push(term.broader.join(', '));
          }
          if (term.authority_uri) {
            detail.push(term.authority_uri);
          }
          if (detail.length) {
            const note = document.createElement('span');
            note.className = 'place-lookup__term-note';
            note.textContent = ` — ${detail.join(' · ')}`;
            item.appendChild(note);
          }
          list.appendChild(item);
        });
        wrap.appendChild(list);
      } else if (mayCreate) {
        const note = document.createElement('span');
        note.className = 'place-lookup__term-note';
        note.textContent = Drupal.t('No local term yet.');
        wrap.appendChild(note);
      }

      return wrap;
    }

    /**
     * Shown when both sources come back empty. The manual's third step, turned
     * from a convention into a control.
     *
     * @param {string} query
     *
     * @return {HTMLElement}
     */
    function emptyState(query) {
      const box = document.createElement('div');
      box.className = 'place-lookup__empty';

      const text = document.createElement('p');
      text.textContent = Drupal.t(
        'No match in Getty TGN or CGNDB for "@query". Send this to the archivist to establish a new place.',
        { '@query': query },
      );
      box.appendChild(text);

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'place-lookup__request';
      button.dataset.placeLookupRequest = '1';
      button.textContent = Drupal.t('Copy a request for the archivist');
      button.addEventListener('click', () => {
        const body = Drupal.t(
          'Please establish a geographic term for "@query". No match found in Getty TGN or CGNDB via the place lookup tool.',
          { '@query': query },
        );
        writeClipboard(body)
          .then(() => setStatus(Drupal.t('Request copied — paste it to the archivist.')))
          .catch(() => setStatus(Drupal.t('Could not copy. Select the text above and copy it manually.')));
      });
      box.appendChild(button);

      return box;
    }

    /**
     * @param {string} message
     *
     * @return {HTMLElement}
     */
    function errorRow(message) {
      const box = document.createElement('div');
      box.className = 'place-lookup__error';
      box.textContent = message;
      return box;
    }

    /**
     * Turns an HTTP status into something that says what to do next. Never
     * "Something went wrong."
     *
     * @param {number} code
     *
     * @return {string}
     */
    function describeStatus(code) {
      if (code === 403) {
        return Drupal.t('You no longer have permission to use place lookup. Sign in again, or ask an administrator for the "use place lookup" permission.');
      }
      if (code === 404) {
        return Drupal.t('The lookup endpoint is missing. The module route cache may be stale — an administrator can run "drush cr".');
      }
      return Drupal.t('The lookup service returned an error (@code). Try again; if it persists, ask an administrator to check the Drupal log.', {
        '@code': code,
      });
    }

    function onKeydown(event) {
      switch (event.key) {
        case 'ArrowDown':
          if (options.length) {
            event.preventDefault();
            move(active + 1);
          }
          break;

        case 'ArrowUp':
          if (options.length) {
            event.preventDefault();
            move(active - 1);
          }
          break;

        case 'Home':
          if (options.length) {
            event.preventDefault();
            move(0);
          }
          break;

        case 'End':
          if (options.length) {
            event.preventDefault();
            move(options.length - 1);
          }
          break;

        case 'Enter':
          if (active >= 0 && options[active]) {
            event.preventDefault();
            copy(options[active].dataset.sourceId, options[active].dataset.name);
          }
          break;

        case 'Escape':
          event.preventDefault();
          if (options.length) {
            abort();
            clear();
            setStatus('');
          } else {
            input.value = '';
          }
          break;

        case 'Tab':
          clearActive();
          break;

        default:
          break;
      }
    }

    /**
     * Moves the active option, wrapping at both ends.
     *
     * Focus stays in the input and aria-activedescendant does the pointing —
     * moving DOM focus to the row would stop the RA from continuing to type.
     *
     * @param {number} index
     */
    function move(index) {
      if (!options.length) {
        return;
      }
      const next = (index + options.length) % options.length;
      clearActive();
      active = next;

      const option = options[active];
      option.classList.add('is-active');
      option.setAttribute('aria-selected', 'true');
      input.setAttribute('aria-activedescendant', option.id);
      option.scrollIntoView({
        block: 'nearest',
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      });
    }

    function clearActive() {
      if (active >= 0 && options[active]) {
        options[active].classList.remove('is-active');
        options[active].setAttribute('aria-selected', 'false');
      }
      active = -1;
      input.removeAttribute('aria-activedescendant');
    }

    function clear() {
      clearActive();
      options = [];
      results.textContent = '';
      input.setAttribute('aria-expanded', 'false');
    }

    /**
     * Copies an identifier — the primary action, since that is what goes in the
     * ingest spreadsheet.
     *
     * @param {string} sourceId
     * @param {string} name
     */
    function copy(sourceId, name) {
      writeClipboard(sourceId)
        .then(() => {
          const message = Drupal.t('Copied @id (@name).', { '@id': sourceId, '@name': name });
          setStatus(message);
          Drupal.announce(message);
        })
        .catch(() => {
          setStatus(Drupal.t('Could not copy @id automatically — select and copy it manually.', {
            '@id': sourceId,
          }));
        });
    }

    /**
     * @param {string} value
     *
     * @return {string}
     */
    function setStatus(value) {
      if (status) {
        status.textContent = value;
      }
      return value;
    }
  }

  /**
   * Clipboard write with a fallback for non-secure contexts.
   *
   * navigator.clipboard is unavailable over plain HTTP, which is a real case on
   * an internal box, so the execCommand path is not dead code.
   *
   * @param {string} value
   *
   * @return {Promise}
   */
  function writeClipboard(value) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(value);
    }

    return new Promise((resolve, reject) => {
      const scratch = document.createElement('textarea');
      scratch.value = value;
      scratch.setAttribute('readonly', 'readonly');
      scratch.style.position = 'fixed';
      scratch.style.opacity = '0';
      document.body.appendChild(scratch);
      scratch.select();
      try {
        if (document.execCommand('copy')) {
          resolve();
        } else {
          reject(new Error('copy rejected'));
        }
      } catch (error) {
        reject(error);
      } finally {
        document.body.removeChild(scratch);
      }
    });
  }

  /**
   * @return {boolean}
   */
  function prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
})(Drupal, drupalSettings, once);
