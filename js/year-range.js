/**
 * @file
 * Year-range facet: submit a from/to year pair straight into the facet URL.
 *
 * Unlike facets_date_range's date-range.js, this does NO epoch conversion. The
 * edtf_year field stores each year as a Unix timestamp equal to the year in
 * seconds, so the raw year integers ARE the BETWEEN bounds Solr needs.
 */
(function (Drupal, once) {
  Drupal.behaviors.sacdaYearRange = {
    attach(context, settings) {
      const config = (settings.facets && settings.facets.yearrange) || {};

      // Opt our facet blocks out of the facets AJAX re-render. When the search
      // view (use_ajax) fires any AJAX request, facets-views-ajax.js rebuilds
      // every .block-facets-ajax block from the current URL — which would wipe
      // this server-rendered widget once a range is active. The module honours
      // drupalSettings.facets.rangeInput[*].facetId (keyed by BLOCK id) as an
      // exclusion list; register each block that hosts a year_range widget.
      once('sacda-year-range-optout', '.block-facets-ajax', context).forEach((block) => {
        if (!block.querySelector('.facets-widget-year_range')) {
          return;
        }
        const cls = Array.from(block.classList).find((c) => c.indexOf('js-facet-block-id-') === 0);
        if (!cls) {
          return;
        }
        const blockId = cls.slice('js-facet-block-id-'.length);
        settings.facets = settings.facets || {};
        settings.facets.rangeInput = settings.facets.rangeInput || {};
        settings.facets.rangeInput[blockId] = { facetId: blockId };
      });

      function submit(facetId) {
        const template = config[facetId] && config[facetId].url;
        if (!template) {
          return;
        }

        const minEl = document.getElementById(`${facetId}_min`);
        const maxEl = document.getElementById(`${facetId}_max`);
        let min = (minEl && minEl.value.trim()) || '';
        let max = (maxEl && maxEl.value.trim()) || '';

        // Keep the pair ordered so a from > to entry still returns results.
        if (min && max && Number(min) > Number(max)) {
          [min, max] = [max, min];
        }

        window.location.href = template
          .replace('__date_range_min__', encodeURIComponent(min))
          .replace('__date_range_max__', encodeURIComponent(max));
      }

      // Apply buttons.
      once('sacda-year-range-apply', 'button.facet-year-range__apply', context).forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          submit(btn.getAttribute('data-facet-id'));
        });
      });

      // Enter within a field applies too.
      once('sacda-year-range-input', 'input.facet-year-range', context).forEach((input) => {
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const list = input.closest('.facets-widget-year_range').querySelector('ul[data-drupal-facet-id]');
            const facetId = list ? list.getAttribute('data-drupal-facet-id') : input.id.replace(/_(min|max)$/, '');
            submit(facetId);
          }
        });
      });
    },
  };
})(Drupal, once);
