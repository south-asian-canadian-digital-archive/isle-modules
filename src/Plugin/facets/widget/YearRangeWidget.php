<?php

declare(strict_types=1);

namespace Drupal\sacda_modules\Plugin\facets\widget;

use Drupal\Core\Form\FormStateInterface;
use Drupal\Core\Url;
use Drupal\facets\FacetInterface;
use Drupal\facets\Widget\WidgetPluginBase;

/**
 * A year-range widget for the edtf_year facet.
 *
 * The `edtf_year` Search API field encodes each year as a Unix timestamp equal
 * to the year number in seconds (e.g. 1900 -> 1900s -> 1970-01-01T00:31:40Z).
 * That means the range boundaries the Solr BETWEEN needs ARE the plain year
 * integers, so this widget collects years directly and skips the date<->epoch
 * conversion that facets_date_range's stock widget performs (which would send
 * real epoch seconds and never match). It reuses that module's encoding-agnostic
 * `date_range` processor for the URL template and query type.
 *
 * @FacetsWidget(
 *   id = "year_range",
 *   label = @Translation("Year Range"),
 *   description = @Translation("Two year fields (from/to) with an Apply button, for edtf_year-style facets."),
 * )
 */
class YearRangeWidget extends WidgetPluginBase {

  /**
   * {@inheritdoc}
   */
  public function build(FacetInterface $facet): array {
    $build = parent::build($facet);
    $results = $facet->getResults();
    $active = $facet->getActiveItems();

    // Render nothing on pages where this facet has neither values to offer nor
    // an active selection to display/clear.
    if (empty($results) && empty($active)) {
      return $build;
    }

    if (!empty($results)) {
      ksort($results);
    }

    $config = $this->getConfiguration();

    // Resolve the currently-active min/max. Depending on where in the pipeline
    // the widget builds, the date_range processor may have already rewritten
    // the active item into an array (['min'=>.., 'max'=>..]) or it may still be
    // the raw "(min:X,max:Y)" string — handle both.
    [$min, $max] = $this->activeRange($active);

    // Derive selectable bounds from the results so the fields hint at the range
    // actually present in the index.
    $years = [];
    foreach ($results as $result) {
      $raw = $result->getRawValue();
      // The index carries a stray year-0 (undated) bucket; ignore implausible
      // values so the from/to hints reflect the real corpus range.
      if (is_numeric($raw) && (int) $raw > 1000) {
        $years[] = (int) $raw;
      }
    }
    $bound_min = $years ? (string) min($years) : '';
    $bound_max = $years ? (string) max($years) : '';

    // No visible labels — the From/To wording lives in the placeholders. Keep
    // the year bounds only as validation min/max attributes.
    $build['#items'] = [
      'min' => [
        '#type' => 'number',
        '#title' => $config['min_label'],
        '#title_display' => 'invisible',
        '#value' => $min,
        '#attributes' => [
          'class' => ['facet-year-range'],
          'id' => $facet->id() . '_min',
          'name' => $facet->id() . '_min',
          'data-type' => 'year-range-min',
          'inputmode' => 'numeric',
          'min' => $bound_min,
          'max' => $bound_max,
          'step' => 1,
          'placeholder' => $config['min_label'],
          'aria-label' => $config['min_label'],
        ],
      ],
      'max' => [
        '#type' => 'number',
        '#title' => $config['max_label'],
        '#title_display' => 'invisible',
        '#value' => $max,
        '#attributes' => [
          'class' => ['facet-year-range'],
          'id' => $facet->id() . '_max',
          'name' => $facet->id() . '_max',
          'data-type' => 'year-range-max',
          'inputmode' => 'numeric',
          'min' => $bound_min,
          'max' => $bound_max,
          'step' => 1,
          'placeholder' => $config['max_label'],
          'aria-label' => $config['max_label'],
        ],
      ],
      'apply' => [
        '#type' => 'html_tag',
        '#tag' => 'button',
        '#value' => $config['apply_label'],
        '#attributes' => [
          'type' => 'button',
          'class' => ['facet-year-range__apply'],
          'data-facet-id' => $facet->id(),
        ],
      ],
    ];

    // Build the resubmit URL template ourselves rather than borrowing a result
    // URL: once a range is active the facet returns no result buckets, so the
    // result-derived template (what facets_date_range uses) disappears exactly
    // when the user needs it to adjust or clear the range.
    $build['#attached']['library'][] = 'sacda_modules/year-range';
    $build['#attached']['drupalSettings']['facets']['yearrange'][$facet->id()] = [
      'url' => $this->rangeUrlTemplate($facet),
    ];

    return $build;
  }

  /**
   * Extracts the active [min, max] year pair from the facet's active items.
   */
  protected function activeRange(array $active): array {
    $current = reset($active);
    if (is_array($current)) {
      return [$current['min'] ?? '', $current['max'] ?? ''];
    }
    if (is_string($current) && preg_match('/\(min:([^,]*),max:([^)]*)\)/i', $current, $m)) {
      return [$m[1], $m[2]];
    }
    return ['', ''];
  }

  /**
   * Builds a navigation URL for the current page carrying placeholder bounds.
   *
   * Mirrors what the date_range build processor writes onto result URLs, but is
   * derived from the live request so it exists even with zero result buckets.
   * The JS swaps __date_range_min__/__date_range_max__ for the entered years.
   */
  protected function rangeUrlTemplate(FacetInterface $facet): string {
    /** @var \Drupal\facets\Plugin\facets\processor\UrlProcessorHandler $handler */
    $handler = $facet->getProcessors()['url_processor_handler'];
    $url_processor = $handler->getProcessor();
    $filter_key = $url_processor->getFilterKey();
    $separator = $url_processor->getSeparator();
    $alias = $facet->getUrlAlias();

    $request = \Drupal::request();
    $query = $request->query->all();

    // Drop any existing filter for THIS facet, keep every other active facet.
    $filters = $query[$filter_key] ?? [];
    if (is_array($filters)) {
      $filters = array_filter($filters, function ($f) use ($alias, $separator) {
        return strpos((string) $f, $alias . $separator) !== 0;
      });
    }
    else {
      $filters = [];
    }
    $filters[] = $alias . $separator . '(min:__date_range_min__,max:__date_range_max__)';
    $query[$filter_key] = array_values($filters);

    return Url::fromRoute('<current>', [], ['query' => $query])->toString();
  }

  /**
   * {@inheritdoc}
   */
  public function isPropertyRequired($name, $type): bool {
    // Reuse facets_date_range's processor to supply the URL template + query.
    return $name === 'date_range' && $type === 'processors';
  }

  /**
   * {@inheritdoc}
   */
  public function getQueryType(): string {
    return 'range';
  }

  /**
   * {@inheritdoc}
   */
  public function buildConfigurationForm(array $form, FormStateInterface $form_state, FacetInterface $facet): array {
    $form += parent::buildConfigurationForm($form, $form_state, $facet);

    $message = $this->t('Requires the <em>"Date Range Picker"</em> processor (enable it under Processors below). Values are treated as plain years — do not use this widget on a true date field.');
    $form['warning'] = [
      '#markup' => '<div class="messages messages--warning">' . $message . '</div>',
    ];

    $config = $this->getConfiguration();

    $form['min_label'] = [
      '#type' => 'textfield',
      '#title' => $this->t('Minimum (from) label'),
      '#default_value' => $config['min_label'],
    ];
    $form['max_label'] = [
      '#type' => 'textfield',
      '#title' => $this->t('Maximum (to) label'),
      '#default_value' => $config['max_label'],
    ];
    $form['apply_label'] = [
      '#type' => 'textfield',
      '#title' => $this->t('Apply button label'),
      '#default_value' => $config['apply_label'],
    ];

    return $form;
  }

  /**
   * {@inheritdoc}
   */
  public function defaultConfiguration(): array {
    return [
      'min_label' => 'From',
      'max_label' => 'To',
      'apply_label' => 'Apply',
    ];
  }

}
