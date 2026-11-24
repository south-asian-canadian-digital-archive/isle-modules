<?php

declare(strict_types=1);

namespace Drupal\sacda_modules\Controller;

use Drupal\Core\Controller\ControllerBase;
use Drupal\Core\Database\Connection;
use Symfony\Component\DependencyInjection\ContainerInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;

/**
 * Matches a sheet's term values against vocabularies, server-side.
 *
 * For organise (the SACDA ingest tool); see README.md, "Term matches". Every rule here is a looser copy of organise's suggest.rs:
 * returning a term organise then rejects costs nothing, leaving out one it
 * would pick changes its answer.
 */
final class TermMatchController extends ControllerBase {

  /** Most values, and most links, in one request. */
  private const MAX_VALUES = 5000;
  private const MAX_URIS = 5000;

  /** Longest value or link accepted. */
  private const MAX_LENGTH = 500;

  /** Most candidates returned per value (closest first, then by tid). */
  private const MAX_CANDIDATES = 200;

  /** Tables holding authority links, and their uri column. */
  private const URI_FIELDS = [
    'taxonomy_term__field_authority_link' => 'field_authority_link_uri',
    'taxonomy_term__field_external_uri' => 'field_external_uri_uri',
  ];

  public function __construct(private readonly Connection $database) {}

  public static function create(ContainerInterface $container): self {
    return new self($container->get('database'));
  }

  public function matches(Request $request): JsonResponse {
    // Accents are compared decomposed, as organise does; without intl the
    // answers would silently differ.
    if (!class_exists(\Normalizer::class)) {
      return new JsonResponse(['error' => 'the PHP intl extension is missing on this site'], 500);
    }
    $input = json_decode((string) $request->getContent(), TRUE);
    if (!is_array($input)) {
      return new JsonResponse(['error' => 'send a JSON object: {"values": [{"vid": ..., "value": ...}], "uris": [...]}'], 400);
    }
    $values = [];
    foreach (is_array($input['values'] ?? NULL) ? $input['values'] : [] as $v) {
      if (is_array($v) && is_string($v['vid'] ?? NULL) && is_string($v['value'] ?? NULL)) {
        // Each (vocabulary, value) once.
        $values[$v['vid'] . "\x1f" . $v['value']] = ['vid' => $v['vid'], 'value' => $v['value']];
      }
    }
    $values = array_values($values);
    $uris = array_values(array_unique(array_filter(is_array($input['uris'] ?? NULL) ? $input['uris'] : [], 'is_string')));
    if (count($values) > self::MAX_VALUES || count($uris) > self::MAX_URIS) {
      return new JsonResponse(['error' => 'at most ' . self::MAX_VALUES . ' values and ' . self::MAX_URIS . ' links per request'], 413);
    }
    foreach ($values as $v) {
      if (mb_strlen($v['value']) > self::MAX_LENGTH || mb_strlen($v['vid']) > 64) {
        return new JsonResponse(['error' => 'a value is longer than ' . self::MAX_LENGTH . ' characters'], 413);
      }
    }
    foreach ($uris as $u) {
      if (mb_strlen($u) > self::MAX_LENGTH) {
        return new JsonResponse(['error' => 'a link is longer than ' . self::MAX_LENGTH . ' characters'], 413);
      }
    }

    $matches = [];
    $wanted = [];
    $byVidValues = [];
    foreach ($values as $i => $v) {
      $byVidValues[$v['vid']][] = $i;
    }
    // One vocabulary at a time: only its index is in memory.
    foreach ($byVidValues as $vid => $indexes) {
      $index = $this->index((string) $vid);
      foreach ($indexes as $i) {
        $found = $this->candidates($index, $values[$i]['value']);
        foreach ($found as $t) {
          $wanted[$t['tid']] = TRUE;
        }
        $matches[$i] = ['vid' => $values[$i]['vid'], 'value' => $values[$i]['value'], 'terms' => $found];
      }
      unset($index);
    }
    ksort($matches);
    $matches = array_values($matches);

    // Terms holding the given links (any vocabulary). Stored links are
    // compared loosely: http/https, a trailing slash, case.
    $byUri = [];
    $askedByKey = [];
    foreach ($uris as $uri) {
      $byUri[$uri] = [];
      $askedByKey[self::uriKey($uri)][] = $uri;
    }
    $linkedTids = [];
    if ($askedByKey) {
      $variants = [];
      foreach ($uris as $uri) {
        foreach (self::uriVariants($uri) as $variant) {
          $variants[$variant] = TRUE;
        }
      }
      foreach (self::URI_FIELDS as $table => $column) {
        if (!$this->database->schema()->tableExists($table)) {
          continue;
        }
        foreach (array_chunk(array_keys($variants), 1000) as $chunk) {
          $rows = $this->database->select($table, 'l')
            ->fields('l', ['entity_id', $column])
            ->condition('l.' . $column, $chunk, 'IN')
            ->condition('l.deleted', 0)
            ->execute();
          foreach ($rows as $row) {
            foreach ($askedByKey[self::uriKey((string) $row->{$column})] ?? [] as $asked) {
              $linkedTids[(string) $row->entity_id][$asked] = TRUE;
              $wanted[(string) $row->entity_id] = TRUE;
            }
          }
        }
      }
    }

    // Every link of every term returned.
    $links = $this->links(array_keys($wanted));
    foreach ($matches as &$m) {
      foreach ($m['terms'] as &$t) {
        $t['uris'] = $links[$t['tid']] ?? [];
      }
      unset($t);
    }
    unset($m);
    if ($linkedTids) {
      $rows = $this->database->select('taxonomy_term_field_data', 't')
        ->fields('t', ['tid', 'vid', 'name'])
        ->condition('t.tid', array_keys($linkedTids), 'IN')
        ->condition('t.default_langcode', 1)
        ->orderBy('t.tid')
        ->execute();
      foreach ($rows as $row) {
        foreach (array_keys($linkedTids[(string) $row->tid]) as $asked) {
          $byUri[$asked][] = [
            'vid' => (string) $row->vid,
            'tid' => (string) $row->tid,
            'name' => (string) $row->name,
            'uris' => $links[(string) $row->tid] ?? [],
          ];
        }
      }
    }

    return new JsonResponse(['version' => 1, 'matches' => $matches, 'uris' => (object) $byUri]);
  }

  /**
   * One vocabulary's terms, keyed for quick comparison.
   *
   * @return array{terms: array, lower: array, letters: array, plural: array, byLen: array}
   */
  private function index(string $vid): array {
    $index = ['terms' => [], 'lower' => [], 'letters' => [], 'plural' => [], 'tid' => [], 'byLen' => []];
    $rows = $this->database->select('taxonomy_term_field_data', 't')
      ->fields('t', ['tid', 'name'])
      ->condition('t.vid', $vid)
      ->condition('t.default_langcode', 1)
      ->orderBy('t.tid')
      ->execute();
    foreach ($rows as $row) {
      $n = count($index['terms']);
      $name = (string) $row->name;
      $keys = self::keys($name);
      $index['terms'][] = ['tid' => (string) $row->tid, 'name' => $name, 'chars' => $keys['chars'], 'nchars' => $keys['nchars'], 'loose' => $keys['loose']];
      $index['lower'][$keys['lower']][] = $n;
      if ($keys['letters'] !== '') {
        $index['letters'][$keys['letters']][] = $n;
      }
      foreach ($keys['plural'] as $p) {
        $index['plural'][$p][] = $n;
      }
      $index['tid'][(string) $row->tid] = $n;
      // Bucketed by the lengths the distance is taken on (both forms).
      foreach (array_unique([count($keys['chars']), count($keys['nchars'])]) as $l) {
        $index['byLen'][$l][] = $n;
      }
    }
    return $index;
  }

  /**
   * The terms of one vocabulary a value could be, closest first.
   *
   * @return array<int, array{tid: string, name: string, uris: string[]}>
   */
  private function candidates(array $index, string $value): array {
    $keys = self::keys($value);
    $d = [];
    // Same name ignoring case, same letters, singular/plural, the term ID.
    $exact = FALSE;
    foreach ($index['lower'][$keys['lower']] ?? [] as $n) {
      $d[$n] = 0;
      $exact = TRUE;
    }
    if ($keys['letters'] !== '') {
      foreach ($index['letters'][$keys['letters']] ?? [] as $n) {
        $d[$n] = 0;
      }
    }
    foreach ($keys['plural'] as $p) {
      foreach ($index['plural'][$p] ?? [] as $n) {
        $d[$n] = 0;
      }
    }
    $trimmed = self::trim($value);
    if ($trimmed !== '' && ctype_digit($trimmed) && isset($index['tid'][$trimmed])) {
      $d[$index['tid'][$trimmed]] = 0;
    }
    // A typo away - unless the name matched exactly (ignoring case): organise
    // takes that match and never looks for typos. A same-letters match can
    // still be refused (different accents, two such terms), so it doesn't stop
    // the scan. The widest budget the
    // closest term could have (at most 3 longer than the value; lengths
    // counted with combining marks, as organise does) bounds what's kept, so
    // terms tied with it are kept too: organise refuses to guess between them.
    if (!$exact && $keys['loose'] > 0) {
      $room = self::budget($keys['loose'] + 3);
      $same = $keys['chars'] === $keys['nchars'];
      // The distance is at least the difference in length, so only terms whose
      // compared length is within $room of the value's can be in range.
      $lengths = array_unique([count($keys['chars']), count($keys['nchars'])]);
      $seen = [];
      foreach ($lengths as $base) {
        for ($len = max(1, $base - $room); $len <= $base + $room; $len++) {
          foreach ($index['byLen'][$len] ?? [] as $n) {
            if (isset($seen[$n]) || isset($d[$n])) {
              continue;
            }
            $seen[$n] = TRUE;
            $t = $index['terms'][$n];
            $dist = self::distance($keys['chars'], $t['chars'], $room);
            if ($dist > 0 && !($same && $t['chars'] === $t['nchars'])) {
              $dist = min($dist, self::distance($keys['nchars'], $t['nchars'], $room));
            }
            if ($dist <= $room) {
              $d[$n] = $dist;
            }
          }
        }
      }
    }
    $found = [];
    foreach ($d as $n => $dist) {
      $found[] = ['d' => $dist, 'n' => $n];
    }
    usort($found, fn($a, $b) => [$a['d'], $a['n']] <=> [$b['d'], $b['n']]);
    return array_map(
      fn($f) => ['tid' => $index['terms'][$f['n']]['tid'], 'name' => $index['terms'][$f['n']]['name'], 'uris' => []],
      array_slice($found, 0, self::MAX_CANDIDATES),
    );
  }

  /**
   * The comparison keys of a name (suggest.rs: exact_ci, letters, squash,
   * normalize, the trailing-s plural).
   */
  private static function keys(string $s): array {
    $trimmed = self::trim($s);
    $lower = mb_strtolower($trimmed);
    $squash = (string) preg_replace('/[^\p{L}\p{N}]+/u', '', $lower);
    $normal = str_starts_with($lower, 'field_') ? (string) preg_replace('/[^\p{L}\p{N}]+/u', '', substr($lower, 6)) : $squash;
    // Rust's is_alphanumeric also keeps the vowel signs of Indic scripts and
    // other marks: count them for the length (and so the typo budget).
    $loose = mb_strlen((string) preg_replace('/[^\p{L}\p{N}\p{M}]+/u', '', $lower));
    return [
      'lower' => $lower,
      'letters' => self::letters($s),
      'plural' => array_values(array_unique(array_filter([rtrim($squash, 's'), rtrim($normal, 's')], fn($p) => $p !== ''))),
      'chars' => mb_str_split($squash),
      'nchars' => mb_str_split($normal),
      'loose' => $loose,
    ];
  }

  /**
   * Authority links of these terms, by tid.
   *
   * @return array<string, string[]>
   */
  private function links(array $tids): array {
    $out = [];
    if (!$tids) {
      return $out;
    }
    foreach (self::URI_FIELDS as $table => $column) {
      if (!$this->database->schema()->tableExists($table)) {
        continue;
      }
      foreach (array_chunk($tids, 1000) as $chunk) {
        $rows = $this->database->select($table, 'l')
          ->fields('l', ['entity_id', $column])
          ->condition('l.entity_id', $chunk, 'IN')
          ->condition('l.deleted', 0)
          ->execute();
        foreach ($rows as $row) {
          $out[(string) $row->entity_id][] = (string) $row->{$column};
        }
      }
    }
    return $out;
  }

  /** suggest.rs budget(): how many edits a name of this length may be off by. */
  private static function budget(int $len): int {
    return match (TRUE) {
      $len <= 3 => 0,
      $len <= 7 => 1,
      $len <= 12 => 2,
      default => 3,
    };
  }

  /**
   * Optimal string alignment distance, giving up past $max.
   *
   * @param string[] $a
   * @param string[] $b
   */
  private static function distance(array $a, array $b, int $max): int {
    $n = count($a);
    $m = count($b);
    if ($n === 0 || $m === 0) {
      return max($n, $m);
    }
    if (abs($n - $m) > $max) {
      return $max + 1;
    }
    $prev2 = [];
    $prev = range(0, $m);
    for ($i = 1; $i <= $n; $i++) {
      $cur = [$i];
      $rowMin = $i;
      for ($j = 1; $j <= $m; $j++) {
        $cost = $a[$i - 1] === $b[$j - 1] ? 0 : 1;
        $v = min($prev[$j] + 1, $cur[$j - 1] + 1, $prev[$j - 1] + $cost);
        if ($i > 1 && $j > 1 && $a[$i - 1] === $b[$j - 2] && $a[$i - 2] === $b[$j - 1]) {
          $v = min($v, $prev2[$j - 2] + 1);
        }
        $cur[$j] = $v;
        $rowMin = min($rowMin, $v);
      }
      if ($rowMin > $max) {
        return $max + 1;
      }
      $prev2 = $prev;
      $prev = $cur;
    }
    return $prev[$m];
  }

  /** suggest.rs letters(): letters and digits, accents and modifier letters dropped, lower-cased a letter at a time. */
  private static function letters(string $s): string {
    $s = (string) \Normalizer::normalize($s, \Normalizer::FORM_D);
    $s = (string) preg_replace('/[\x{02B0}-\x{02FF}]/u', '', $s);
    return (string) preg_replace('/[^\p{L}\p{N}]+/u', '', mb_convert_case($s, MB_CASE_LOWER_SIMPLE));
  }

  /** Rust's trim(): Unicode whitespace too. */
  private static function trim(string $s): string {
    return (string) preg_replace('/^[\s\p{Z}]+|[\s\p{Z}]+$/u', '', $s);
  }

  /** A link compared loosely: no scheme, no trailing slash, lower-case. */
  private static function uriKey(string $uri): string {
    return mb_strtolower(rtrim((string) preg_replace('#^https?://#i', '', self::trim($uri)), '/'));
  }

  /** A link as it may be stored: http or https, with or without a trailing slash. */
  private static function uriVariants(string $uri): array {
    $core = rtrim((string) preg_replace('#^https?://#i', '', self::trim($uri)), '/');
    $out = [];
    foreach (['http://', 'https://'] as $scheme) {
      $out[] = $scheme . $core;
      $out[] = $scheme . $core . '/';
    }
    return $out;
  }

}
