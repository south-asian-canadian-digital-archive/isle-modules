<?php

declare(strict_types=1);

namespace Drupal\sacda_modules\PlaceLookup;

use Drupal\Component\Datetime\TimeInterface;
use Drupal\Component\Transliteration\TransliterationInterface;
use Drupal\Core\Database\Connection;
use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\Core\Url;
use Drupal\taxonomy\TermInterface;

/**
 * Search, normalization and sync for the local place authority mirror.
 *
 * Everything is answered from sacda_place_authority. Nothing here calls Getty
 * or NRCan, deliberately:
 * - Getty discontinued its TGN/AAT XML web services and is part-way through a
 *   multi-year infrastructure migration; a live integration is a scheduled
 *   outage.
 * - Per-keystroke requests to a third party get us rate-limited within a day of
 *   real use, and a network round trip per keystroke is not "instant".
 * - An offline index returns the same answer next month, which matters when the
 *   archivist reviews an RA's work.
 *
 * The mirror is refreshed on a schedule by the sacda-place:* Drush commands.
 */
class PlaceLookupService {

  /**
   * Vocabulary the "does this place already exist?" check runs against.
   */
  public const VOCABULARY = 'geo_location';

  /**
   * Shortest query we will run. Anything shorter matches most of the table.
   */
  public const MIN_QUERY_LENGTH = 2;

  /**
   * Whether the FULLTEXT index is present; resolved lazily, once per request.
   */
  protected ?bool $hasFulltext = NULL;

  public function __construct(
    protected Connection $connection,
    protected TransliterationInterface $transliteration,
    protected EntityTypeManagerInterface $entityTypeManager,
    protected TimeInterface $time,
  ) {}

  /**
   * Folds a name to its match key.
   *
   * Lowercased, diacritic-stripped, punctuation-collapsed. MySQL's default
   * utf8mb4_general_ci already makes LIKE case-insensitive, so what this really
   * buys is diacritic and punctuation folding — "Montréal" / "Montreal",
   * "Patiala (City)" / "Patiala City".
   *
   * The SAME function must run over authority names at import time and over
   * term labels in sync-local. Diverge them and matching fails silently on
   * every accented name.
   */
  public function normalize(string $value): string {
    // Unicode::strtolower() was removed in Drupal 10; mb_* is the replacement.
    $value = mb_strtolower(trim($value), 'UTF-8');
    $value = $this->transliteration->transliterate($value, 'en', '');
    // Collapse anything that is not a letter, digit or space into a space, so
    // punctuation never changes word boundaries.
    $value = preg_replace('/[^a-z0-9]+/u', ' ', $value) ?? '';
    return trim(preg_replace('/\s+/', ' ', $value) ?? '');
  }

  /**
   * Searches the mirror.
   *
   * @return array
   *   Result rows, best match first, each with the keys documented in
   *   ::hydrate(). Empty for queries under MIN_QUERY_LENGTH.
   */
  public function search(string $query, int $limit = 25): array {
    $needle = $this->normalize($query);
    if (mb_strlen($needle) < self::MIN_QUERY_LENGTH) {
      return [];
    }

    // escapeLike() neutralises \ % and _ in the user's text. The wildcards we
    // want are appended AFTER escaping — never escape a string that already
    // contains your own wildcards.
    $escaped = $this->connection->escapeLike($needle);

    // Pass 1: prefix match, served by the name_norm prefix index. Sub-millisecond
    // on ~360k rows, and it is the overwhelmingly common case — an RA is copying
    // a name off a record, not guessing at one.
    $rows = $this->runMatch($limit, fn ($select) => $select->condition('p.name_norm', $escaped . '%', 'LIKE'));

    // Pass 2: word matching via the FULLTEXT index, so "british columbia" finds
    // "Province of British Columbia" and "shimla" finds it inside a longer name.
    // Indexed, so this stays in single-digit milliseconds.
    if (count($rows) < $limit) {
      $rows += $this->fulltextMatch($needle, $limit - count($rows), array_keys($rows), TRUE);
    }

    // Pass 2b: the same word match with the terms optional rather than all
    // required. "anandpur sahib" has no record carrying both words, but plenty
    // carry "Anandpur" — showing those beats an empty list, because the RA can
    // see for themselves that the qualified form is missing.
    if (!$rows && str_contains($needle, ' ')) {
      $rows = $this->fulltextMatch($needle, $limit, [], FALSE);
    }

    // Pass 3: true substring matching, which no index can serve — it full-scans
    // and costs ~350 ms at 1.3M rows. Deliberately reached ONLY when the first
    // two passes found nothing at all, i.e. when the alternative is telling the
    // RA "no match, send this to the archivist". Being sure about that answer is
    // worth a third of a second; making every keystroke pay it is not.
    if (!$rows) {
      $rows = $this->runMatch($limit, function ($select) use ($escaped) {
        // The two substring columns ARE OR-ed together here — neither can use an
        // index anyway, so one scan does the work of two. The prefix condition
        // is never OR-ed in with them, because that would throw away the index
        // on the common path.
        $select->condition($select->orConditionGroup()
          ->condition('p.name_norm', '%' . $escaped . '%', 'LIKE')
          ->condition('p.variant_norm', '%' . $escaped . '%', 'LIKE'));
      });
    }

    return $this->hydrate($rows);
  }

  /**
   * Word-prefix match through the FULLTEXT index.
   *
   * Each token becomes a boolean-mode term with a trailing wildcard, so
   * "anandpur sah" matches "Anandpur Sahib". Tokens shorter than MySQL's
   * ft_min_token_size (3 by default) are dropped — two-character queries are
   * served by the prefix pass instead.
   *
   * Returns nothing if the index is absent (a non-MySQL driver, or update 10002
   * not yet run); the caller's substring pass still covers that case.
   *
   * @param bool $require_all
   *   TRUE prefixes each token with '+' so every word must be present; FALSE
   *   leaves them optional and lets relevance ranking order the result.
   */
  protected function fulltextMatch(string $needle, int $limit, array $exclude_ids, bool $require_all): array {
    if (!$this->hasFulltextIndex()) {
      return [];
    }

    // normalize() has already stripped everything outside [a-z0-9 ], so no
    // boolean-mode operator can survive into this expression.
    $tokens = array_filter(
      explode(' ', $needle),
      static fn (string $token): bool => mb_strlen($token) >= 3,
    );
    if (!$tokens) {
      return [];
    }
    $expression = implode(' ', array_map(
      static fn (string $token): string => ($require_all ? '+' : '') . $token . '*',
      $tokens,
    ));

    return $this->runMatch($limit, function ($select) use ($expression, $exclude_ids, $require_all) {
      $select->where(
        'MATCH(p.name_norm, p.variant_norm) AGAINST (:q IN BOOLEAN MODE)',
        [':q' => $expression],
      );
      if ($exclude_ids) {
        $select->condition('p.id', $exclude_ids, 'NOT IN');
      }
      // With every token required, all hits are equally on-topic and the
      // shortest name is the best answer. With tokens optional, they are not:
      // a record matching both words must outrank one matching neither well, so
      // order by the match score first and only then by name length.
      if (!$require_all) {
        $select->addExpression(
          'MATCH(p.name_norm, p.variant_norm) AGAINST (:score IN BOOLEAN MODE)',
          'relevance',
          [':score' => $expression],
        );
        $select->orderBy('relevance', 'DESC');
      }
    });
  }

  /**
   * Whether the FULLTEXT index exists, cached for the request.
   */
  protected function hasFulltextIndex(): bool {
    if ($this->hasFulltext === NULL) {
      if ($this->connection->databaseType() !== 'mysql') {
        $this->hasFulltext = FALSE;
      }
      else {
        $this->hasFulltext = (bool) $this->connection
          ->query('SHOW INDEX FROM {sacda_place_authority} WHERE Key_name = :name', [':name' => 'ft_place_name'])
          ->fetchField();
      }
    }
    return $this->hasFulltext;
  }

  /**
   * Runs one match pass, keyed by id so merged passes de-duplicate for free.
   *
   * @param int $limit
   *   Maximum rows to return.
   * @param callable $apply_conditions
   *   Receives the select query and adds the pass's WHERE conditions.
   */
  protected function runMatch(int $limit, callable $apply_conditions): array {
    if ($limit < 1) {
      return [];
    }
    $select = $this->connection->select('sacda_place_authority', 'p');
    $select->fields('p', [
      'id', 'source', 'source_id', 'name', 'name_norm', 'parent_path',
      'place_type', 'country_code', 'lat', 'lon', 'variant_names',
      'local_tids', 'local_match_count',
    ]);
    // Primary sort, ahead of anything a pass adds: countries in the order this
    // archive actually cares about, so "Surrey, British Columbia" outranks
    // "Surrey, North Dakota" and "Anandpur, Punjab" outranks a US namesake.
    // Ordering only — nothing is filtered out.
    //
    // Sorting on local_match_count instead would do nothing: matching is by name
    // alone, so every Surrey on earth carries the same badge. The country is the
    // only signal available that actually separates them.
    $select->addExpression(
      'IFNULL(NULLIF(FIELD(p.country_code, :c1, :c2, :c3, :c4, :c5), 0), 99)',
      'country_rank',
      [
        ':c1' => 'CA',
        ':c2' => 'IN',
        ':c3' => 'PK',
        ':c4' => 'GB',
        ':c5' => 'US',
      ],
    );
    $select->orderBy('country_rank');

    // Conditions always go through the query builder's LIKE operator, never a
    // hand-written ->where(). The builder appends ESCAPE '\\', without which the
    // backslashes escapeLike() produced are meaningless and someone typing
    // "100%" matches every row in the table.
    $apply_conditions($select);
    // Shortest name first: an exact hit outranks a longer name containing it.
    $select->addExpression('CHAR_LENGTH(p.name_norm)', 'name_len');
    $select->orderBy('name_len');
    $select->orderBy('p.name');
    $select->range(0, $limit);

    return $select->execute()->fetchAllAssoc('id', \PDO::FETCH_ASSOC);
  }

  /**
   * Turns raw rows into the shape the JSON endpoint and template consume.
   */
  protected function hydrate(array $rows): array {
    // Collect every referenced tid up front, then load once.
    $tids = [];
    foreach ($rows as $row) {
      foreach ($this->splitTids($row['local_tids'] ?? '') as $tid) {
        $tids[$tid] = $tid;
      }
    }
    $terms = $tids
      ? $this->entityTypeManager->getStorage('taxonomy_term')->loadMultiple($tids)
      : [];

    $out = [];
    foreach ($rows as $row) {
      $source = PlaceSource::tryFrom($row['source']);
      $matches = [];
      foreach ($this->splitTids($row['local_tids'] ?? '') as $tid) {
        if (isset($terms[$tid])) {
          $matches[] = $this->describeTerm($terms[$tid]);
        }
      }

      $out[] = [
        'source' => $row['source'],
        'source_label' => $source?->label() ?? $row['source'],
        'source_id' => $row['source_id'],
        'source_uri' => $source?->uri($row['source_id']),
        'name' => $row['name'],
        'parent_path' => $row['parent_path'] ?: NULL,
        'place_type' => $row['place_type'] ?: NULL,
        'country_code' => $row['country_code'] ?: NULL,
        // PDO hands back numeric columns as strings; cast so the JS can do
        // arithmetic and comparisons on them.
        'lat' => $row['lat'] !== NULL ? (float) $row['lat'] : NULL,
        'lon' => $row['lon'] !== NULL ? (float) $row['lon'] : NULL,
        'variants' => array_values(array_filter(explode("\n", (string) $row['variant_names']))),
        // 0 / 1 / many drives the badge; the term list lets the archivist
        // judge an ambiguous match rather than being told a bare yes/no.
        'local_match_count' => (int) $row['local_match_count'],
        'local_terms' => $matches,
      ];
    }

    return $out;
  }

  /**
   * Groups search results by source, TGN first.
   *
   * This is the response body of /api/place-lookup.
   */
  public function searchGrouped(string $query, int $limit = 25): array {
    $results = $this->search($query, $limit);

    $groups = [];
    foreach (PlaceSource::cases() as $source) {
      $groups[$source->value] = [
        'source' => $source->value,
        'label' => $source->label(),
        'results' => [],
      ];
    }
    foreach ($results as $result) {
      if (isset($groups[$result['source']])) {
        $groups[$result['source']]['results'][] = $result;
      }
    }

    return [
      'query' => $query,
      'total' => count($results),
      'groups' => array_values($groups),
    ];
  }

  /**
   * Summarises a matched local term for display.
   */
  protected function describeTerm(TermInterface $term): array {
    $authority = NULL;
    if ($term->hasField('field_authority_link') && !$term->get('field_authority_link')->isEmpty()) {
      $authority = $term->get('field_authority_link')->first()->getValue()['uri'] ?? NULL;
    }

    $broader = [];
    if ($term->hasField('field_geo_broader')) {
      foreach ($term->get('field_geo_broader')->referencedEntities() as $parent) {
        $broader[] = $parent->label();
      }
    }

    return [
      'tid' => (int) $term->id(),
      'name' => $term->label(),
      'url' => Url::fromRoute('entity.taxonomy_term.edit_form', ['taxonomy_term' => $term->id()])->toString(),
      'authority_uri' => $authority,
      'broader' => $broader,
    ];
  }

  /**
   * Parses the comma-delimited local_tids column.
   */
  protected function splitTids(string $value): array {
    if ($value === '') {
      return [];
    }
    return array_values(array_filter(array_map('intval', explode(',', $value))));
  }

  /**
   * Inserts a batch of authority rows.
   *
   * @param array $rows
   *   Rows as emitted by the parsers: source (PlaceSource), source_id, name,
   *   parent_path, place_type, country_code, lat, lon, variants (string[]).
   */
  public function insertBatch(array $rows): int {
    if (!$rows) {
      return 0;
    }
    $now = $this->time->getRequestTime();
    $insert = $this->connection->insert('sacda_place_authority')->fields([
      'source', 'source_id', 'name', 'name_norm', 'parent_path', 'place_type',
      'country_code', 'lat', 'lon', 'variant_names', 'variant_norm', 'imported',
    ]);

    foreach ($rows as $row) {
      $variants = array_values(array_unique(array_filter($row['variants'] ?? [])));
      $variant_norm = array_values(array_unique(array_filter(array_map(
        fn (string $v): string => $this->normalize($v),
        $variants,
      ))));

      $insert->values([
        'source' => $row['source'] instanceof PlaceSource ? $row['source']->value : (string) $row['source'],
        'source_id' => (string) $row['source_id'],
        'name' => mb_substr((string) $row['name'], 0, 255),
        'name_norm' => mb_substr($this->normalize((string) $row['name']), 0, 255),
        'parent_path' => $row['parent_path'] !== NULL ? mb_substr((string) $row['parent_path'], 0, 512) : NULL,
        'place_type' => $row['place_type'] !== NULL ? mb_substr((string) $row['place_type'], 0, 128) : NULL,
        'country_code' => $row['country_code'] ?? NULL,
        'lat' => $row['lat'] ?? NULL,
        'lon' => $row['lon'] ?? NULL,
        'variant_names' => $variants ? implode("\n", $variants) : NULL,
        'variant_norm' => $variant_norm ? implode("\n", $variant_norm) : NULL,
        'imported' => $now,
      ]);
    }

    $insert->execute();
    return count($rows);
  }

  /**
   * Deletes every row for one source, so a reimport never touches the other.
   */
  public function purgeSource(PlaceSource $source): int {
    return (int) $this->connection->delete('sacda_place_authority')
      ->condition('source', $source->value)
      ->execute();
  }

  /**
   * Row count, optionally for one source.
   */
  public function count(?PlaceSource $source = NULL): int {
    $query = $this->connection->select('sacda_place_authority', 'p');
    if ($source) {
      $query->condition('p.source', $source->value);
    }
    return (int) $query->countQuery()->execute()->fetchField();
  }

  /**
   * Recomputes local_tids / local_match_count for every authority row.
   *
   * Matching is by normalized NAME, not by authority URI. Only one of the
   * existing geo_location terms carries a field_authority_link at all (and it
   * is a GeoNames URI, not TGN), so URI matching would report "not in
   * vocabulary" for the entire vocabulary. Name matching over-matches instead
   * of under-matching, which is the right failure direction here: the page
   * shows every matched term and lets the archivist decide.
   *
   * Term alt names (field_geo_alt_name) count as term-side aliases. Authority
   * variant names deliberately do NOT participate — matching into variant_norm
   * would let a single term claim dozens of authority rows.
   *
   * Full reset then rebuild: idempotent, and cheap because the vocabulary is
   * tiny (tens of terms, not thousands).
   *
   * @return array
   *   Counts keyed 'terms', 'names', 'matched', 'ambiguous', 'cleared'.
   */
  public function rebuildLocalMatches(bool $dry_run = FALSE): array {
    $storage = $this->entityTypeManager->getStorage('taxonomy_term');
    $tids = $storage->getQuery()
      ->accessCheck(FALSE)
      ->condition('vid', self::VOCABULARY)
      ->execute();

    // norm => [tid, ...]
    $by_norm = [];
    foreach ($storage->loadMultiple($tids) as $term) {
      $names = [$term->label()];
      if ($term->hasField('field_geo_alt_name')) {
        foreach ($term->get('field_geo_alt_name') as $item) {
          $names[] = (string) $item->value;
        }
      }
      foreach ($names as $name) {
        $norm = $this->normalize((string) $name);
        if ($norm === '') {
          continue;
        }
        $by_norm[$norm][(int) $term->id()] = (int) $term->id();
      }
    }

    $stats = [
      'terms' => count($tids),
      'names' => count($by_norm),
      'matched' => 0,
      'ambiguous' => 0,
      'cleared' => 0,
    ];

    if ($dry_run) {
      $matched = $this->connection->select('sacda_place_authority', 'p')
        ->fields('p', ['name_norm'])
        ->condition('p.name_norm', array_keys($by_norm) ?: [''], 'IN')
        ->countQuery()->execute()->fetchField();
      $stats['matched'] = (int) $matched;
      return $stats;
    }

    $transaction = $this->connection->startTransaction();
    try {
      $stats['cleared'] = (int) $this->connection->update('sacda_place_authority')
        ->fields(['local_tids' => NULL, 'local_match_count' => 0])
        ->condition('local_match_count', 0, '>')
        ->execute();

      foreach ($by_norm as $norm => $term_ids) {
        $term_ids = array_values($term_ids);
        sort($term_ids);
        $affected = (int) $this->connection->update('sacda_place_authority')
          ->fields([
            'local_tids' => implode(',', $term_ids),
            'local_match_count' => count($term_ids),
          ])
          ->condition('name_norm', $norm)
          ->execute();

        $stats['matched'] += $affected;
        if (count($term_ids) > 1) {
          $stats['ambiguous'] += $affected;
        }
      }
    }
    catch (\Throwable $e) {
      $transaction->rollBack();
      throw $e;
    }

    return $stats;
  }

}
