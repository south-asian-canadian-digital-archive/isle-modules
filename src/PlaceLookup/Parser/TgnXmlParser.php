<?php

declare(strict_types=1);

namespace Drupal\sacda_modules\PlaceLookup\Parser;

use Drupal\sacda_modules\PlaceLookup\PlaceSource;

/**
 * Streams place records out of a Getty TGN XML release.
 *
 * SHAPE OF THE RELEASE — this is not what you would guess. `tgn_xml_0126.zip`
 * is not one large XML document; it is ~2.99 MILLION individual files, one per
 * subject, at `tgn/<Subject_ID>.xml`, each a complete little <Vocabulary>
 * document of 3–10 KB. So this parser walks zip entries and parses each entry
 * whole, rather than streaming one giant document with XMLReader.
 *
 * That is still fast: ZipArchive's central directory loads in ~3 s and reads run
 * at ~60k entries/second, so a full pass over all 3M subjects takes a few
 * minutes. It is not cheap in memory, though — see parseZip().
 *
 * Why the XML release and not the monthly N-Triples one: each subject carries
 * its full ancestor chain in Parent_String, so parent_path comes for free. The
 * N-Triples dump gives gvp:broaderPreferred triples instead, which would need a
 * multi-million-node parent map in memory or a staging table plus a recursive
 * CTE. The XML release is frozen (January 2026 was Getty's last) — fine here,
 * because TGN identifiers are stable and this tool looks up identifiers rather
 * than tracking vocabulary churn.
 *
 * Licensed ODC-By 1.0. The required attribution is rendered in the page footer;
 * see templates/sacda-place-lookup.html.twig.
 */
class TgnXmlParser {

  /**
   * Nation names we keep, mapped to the country code stored on the row.
   *
   * Pakistan is not optional: pre-partition material resolves to places that
   * are now in Pakistan, and TGN's historical coverage is the reason it was
   * picked over GeoNames.
   */
  public const NATIONS = [
    'Canada' => 'CA',
    'India' => 'IN',
    'Pakistan' => 'PK',
    'United States' => 'US',
    'United Kingdom' => 'GB',
  ];

  /**
   * Place types kept when --strict is on, to trim the import.
   */
  public const PLACE_TYPE_ALLOWLIST = [
    'inhabited place', 'city', 'town', 'village', 'nation', 'province',
    'state', 'district', 'county', 'region', 'municipality', 'township',
    'neighborhood', 'former administrative division', 'river', 'lake',
    'island', 'mountain', 'valley', 'national capital', 'provincial capital',
    'metropolitan area', 'regional district', 'union territory', 'tehsil',
    'taluk', 'suburb', 'settlement', 'historical region', 'deserted settlement',
  ];

  /**
   * Ancestor segment types dropped from parent_path as noise.
   *
   * "World" and the continent add nothing an RA is scanning for; "Surrey, Metro
   * Vancouver, British Columbia, Canada" is the useful chain.
   */
  protected const PATH_NOISE_TYPES = ['facet', 'continent'];

  /**
   * Yields one normalized row per in-scope TGN subject.
   *
   * @param string $file
   *   The release .zip, a directory of subject .xml files, or a single .xml
   *   document containing one or more <Subject> elements.
   * @param bool $strict
   *   Apply PLACE_TYPE_ALLOWLIST on top of the nation filter.
   *
   * @return \Generator
   *   Rows in the shape PlaceLookupService::insertBatch() expects.
   */
  public function parse(string $file, bool $strict = FALSE): \Generator {
    if (!file_exists($file)) {
      throw new \RuntimeException(sprintf('TGN dump not found: %s', $file));
    }

    if (is_dir($file)) {
      yield from $this->parseDirectory($file, $strict);
    }
    elseif (strtolower(pathinfo($file, PATHINFO_EXTENSION)) === 'zip') {
      yield from $this->parseZip($file, $strict);
    }
    else {
      yield from $this->parseDocument(file_get_contents($file) ?: '', $strict);
    }
  }

  /**
   * Walks every .xml entry in the release zip.
   *
   * MEMORY: opening this archive costs ~1.2 GB RSS and there is no way around
   * it — that is the central directory for 2.99M entries, allocated by libzip
   * outside PHP's heap (memory_get_usage() reports a flat ~40 MB throughout and
   * will mislead you). Measured behaviour, so do not "optimise" against a guess:
   * - reads do NOT leak; RSS is flat from the first entry to the last,
   * - close() returns the whole 1.2 GB immediately,
   * - therefore the archive is opened exactly ONCE.
   *
   * An earlier version reopened the archive every N entries on the theory that
   * something was leaking. Nothing was, and reopening is strictly worse: the
   * new central directory can be allocated before the old one is released, so
   * each recycle risks a transient 2.4 GB spike. On a container with under 4 GB
   * shared with nginx and php-fpm, that is what actually got OOM-killed.
   */
  protected function parseZip(string $file, bool $strict): \Generator {
    $zip = new \ZipArchive();
    if ($zip->open($file) !== TRUE) {
      throw new \RuntimeException(sprintf('Could not open zip: %s', $file));
    }

    try {
      for ($i = 0; $i < $zip->numFiles; $i++) {
        $stat = $zip->statIndex($i);
        if (!$stat || strtolower(pathinfo($stat['name'], PATHINFO_EXTENSION)) !== 'xml') {
          continue;
        }
        $xml = $zip->getFromIndex($i);
        if ($xml === FALSE || $xml === '') {
          continue;
        }
        yield from $this->parseDocument($xml, $strict);
      }
    }
    finally {
      $zip->close();
    }
  }

  /**
   * Walks a directory of subject .xml files (an extracted release).
   */
  protected function parseDirectory(string $dir, bool $strict): \Generator {
    $iterator = new \RecursiveIteratorIterator(
      new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS),
    );
    foreach ($iterator as $item) {
      if (!$item->isFile() || strtolower($item->getExtension()) !== 'xml') {
        continue;
      }
      $xml = file_get_contents($item->getPathname());
      if ($xml !== FALSE && $xml !== '') {
        yield from $this->parseDocument($xml, $strict);
      }
    }
  }

  /**
   * Parses one <Vocabulary> document, which may hold one or more <Subject>.
   */
  protected function parseDocument(string $xml, bool $strict): \Generator {
    // Malformed single records must not abort a 3M-record import.
    $previous = libxml_use_internal_errors(TRUE);
    $doc = simplexml_load_string($xml);
    libxml_clear_errors();
    libxml_use_internal_errors($previous);

    if ($doc === FALSE) {
      return;
    }

    $subjects = $doc->getName() === 'Subject' ? [$doc] : ($doc->Subject ?? []);
    foreach ($subjects as $subject) {
      $row = $this->buildRow($subject, $strict);
      if ($row !== NULL) {
        yield $row;
      }
    }
  }

  /**
   * Maps one <Subject> to a row, or NULL if it is out of scope.
   */
  protected function buildRow(\SimpleXMLElement $subject, bool $strict): ?array {
    $source_id = trim((string) ($subject['Subject_ID'] ?? ''));
    if ($source_id === '') {
      return NULL;
    }

    // Merged subjects are redirects to another record; importing them would
    // surface the same place twice under two identifiers.
    $merged = trim((string) ($subject->Merged_Status ?? ''));
    if ($merged !== '' && stripos($merged, 'not merged') === FALSE && stripos($merged, 'merged') !== FALSE) {
      return NULL;
    }

    $segments = $this->parentSegments($subject);
    if (!$segments) {
      return NULL;
    }

    $country_code = $this->resolveNation($segments);
    if ($country_code === NULL) {
      return NULL;
    }

    [$preferred, $variants] = $this->extractTerms($subject);
    if ($preferred === NULL) {
      return NULL;
    }

    $place_type = $this->extractPlaceType($subject);
    if ($strict && $place_type !== NULL
      && !in_array(mb_strtolower($place_type), self::PLACE_TYPE_ALLOWLIST, TRUE)) {
      return NULL;
    }

    [$lat, $lon] = $this->extractCoordinates($subject);

    return [
      'source' => PlaceSource::Tgn,
      'source_id' => $source_id,
      'name' => $preferred,
      'parent_path' => $this->formatPath($segments),
      'place_type' => $place_type,
      'country_code' => $country_code,
      'lat' => $lat,
      'lon' => $lon,
      'variants' => $variants,
    ];
  }

  /**
   * Splits Parent_String into [name, type] pairs, nearest ancestor first.
   *
   * Parent_String lives under Parent_Relationships/Preferred_Parent (not
   * directly on Subject) and each segment is formatted
   * "Hokkaidō (prefecture) [1000985]" — so both the qualifier and the bracketed
   * id have to come off before anything can be matched against a nation name.
   *
   * @return array[]
   *   Each entry ['name' => string, 'type' => string].
   */
  protected function parentSegments(\SimpleXMLElement $subject): array {
    $raw = trim((string) ($subject->Parent_Relationships->Preferred_Parent->Parent_String ?? ''));
    if ($raw === '') {
      // Fall back to any parent relationship, and to a bare Parent_String for
      // simpler documents.
      $raw = trim((string) ($subject->Parent_Relationships->Non_Preferred_Parent->Parent_String ?? ''));
      if ($raw === '') {
        $raw = trim((string) ($subject->Parent_String ?? ''));
      }
    }
    if ($raw === '') {
      return [];
    }

    $segments = [];
    foreach (explode(',', $raw) as $segment) {
      $segment = trim($segment);
      if ($segment === '') {
        continue;
      }
      // Strip the trailing " [1000985]" identifier.
      $segment = trim(preg_replace('/\s*\[\d+\]\s*$/', '', $segment) ?? $segment);
      // Peel off a trailing " (type)" qualifier.
      $type = '';
      // Lazy on the name so nested qualifiers peel correctly:
      // "Catahoula parish (parish (political))" -> name "Catahoula parish".
      if (preg_match('/^(.*?)\s+\((.*)\)$/', $segment, $m)) {
        $segment = trim($m[1]);
        $type = mb_strtolower(trim($m[2]));
      }
      if ($segment !== '') {
        $segments[] = ['name' => $segment, 'type' => $type];
      }
    }

    return $segments;
  }

  /**
   * Finds which in-scope nation an ancestor chain belongs to.
   *
   * Takes the LAST matching segment, i.e. the one nearest the root. A locality
   * literally named "India" inside another country would otherwise be filed
   * under India.
   */
  protected function resolveNation(array $segments): ?string {
    $code = NULL;
    foreach ($segments as $segment) {
      if (isset(self::NATIONS[$segment['name']])) {
        $code = self::NATIONS[$segment['name']];
      }
    }
    return $code;
  }

  /**
   * Renders the ancestor chain for display, dropping the facet and continent.
   */
  protected function formatPath(array $segments): string {
    $names = [];
    foreach ($segments as $segment) {
      if (in_array($segment['type'], self::PATH_NOISE_TYPES, TRUE)) {
        continue;
      }
      $names[] = $segment['name'];
    }
    return implode(', ', $names);
  }

  /**
   * Splits <Terms> into the preferred name and the variant list.
   *
   * Note the release spells the variant element "Non-Preferred_Term" with a
   * HYPHEN, which is not a valid PHP property name — hence the {'…'} access.
   */
  protected function extractTerms(\SimpleXMLElement $subject): array {
    $preferred = NULL;
    $variants = [];

    foreach ($subject->Terms->Preferred_Term ?? [] as $term) {
      $text = trim((string) $term->Term_Text);
      if ($text !== '' && $preferred === NULL) {
        $preferred = $text;
      }
    }

    $terms = $subject->Terms ?? NULL;
    if ($terms !== NULL) {
      foreach ($terms->{'Non-Preferred_Term'} as $term) {
        $text = trim((string) $term->Term_Text);
        if ($text !== '') {
          $variants[] = $text;
        }
      }
      // Older exports used an underscore.
      foreach ($terms->Non_Preferred_Term as $term) {
        $text = trim((string) $term->Term_Text);
        if ($text !== '') {
          $variants[] = $text;
        }
      }
    }

    return [$preferred, $variants];
  }

  /**
   * Preferred place type.
   *
   * Place_Type_ID is "83002/inhabited place" — an id and a label joined by a
   * slash. Only the label is useful here.
   */
  protected function extractPlaceType(\SimpleXMLElement $subject): ?string {
    $types = $subject->Place_Types ?? NULL;
    if ($types === NULL) {
      return NULL;
    }

    $candidates = [];
    foreach ($types->Preferred_Place_Type as $type) {
      $candidates[] = (string) $type->Place_Type_ID;
    }
    foreach ($types->{'Non-Preferred_Place_Type'} as $type) {
      $candidates[] = (string) $type->Place_Type_ID;
    }

    foreach ($candidates as $candidate) {
      $candidate = trim($candidate);
      if ($candidate === '') {
        continue;
      }
      if (str_contains($candidate, '/')) {
        $candidate = trim(substr($candidate, strpos($candidate, '/') + 1));
      }
      if ($candidate !== '') {
        return $candidate;
      }
    }

    return NULL;
  }

  /**
   * Decimal lat/lon from <Coordinates><Standard>, or [NULL, NULL].
   */
  protected function extractCoordinates(\SimpleXMLElement $subject): array {
    $standard = $subject->Coordinates->Standard ?? NULL;
    if ($standard === NULL) {
      return [NULL, NULL];
    }
    $lat = trim((string) ($standard->Latitude->Decimal ?? ''));
    $lon = trim((string) ($standard->Longitude->Decimal ?? ''));

    return [
      is_numeric($lat) ? round((float) $lat, 6) : NULL,
      is_numeric($lon) ? round((float) $lon, 6) : NULL,
    ];
  }

}
