<?php

declare(strict_types=1);

namespace Drupal\sacda_modules\PlaceLookup\Parser;

use Drupal\sacda_modules\PlaceLookup\PlaceSource;

/**
 * Streams place records out of a Canadian Geographical Names CSV extract.
 *
 * Source: ftp.maps.canada.ca/pub/nrcan_rncan/vector/geobase_cgn_toponyme/
 * prov_csv_eng/ — use cgn_canada_csv_eng.zip (one national file rather than
 * thirteen provincial ones) and optionally cgn_indg_csv_eng.zip (Indigenous
 * names), which is worth importing for this archive.
 *
 * CONTENT ADVISORY: CGNDB contains historical terminology that is racist,
 * offensive and derogatory, and the naming authorities are still working
 * through it. The lookup page surfaces this inline above CGNDB results rather
 * than burying it in a help page.
 *
 * Zips are read in place through the zip:// stream wrapper; nothing is
 * extracted to disk.
 */
class CgndbCsvParser {

  /**
   * Required logical column => accepted normalized header spellings.
   *
   * The _eng extracts ship human-readable labels ("Geographical Name") rather
   * than the schema codes ("GEONAME"), and NRCan has changed them before —
   * hence matching on a normalized alias list instead of on fixed positions.
   */
  public const COLUMN_ALIASES = [
    'id' => ['cgndbid', 'cgndbkey', 'cgndb'],
    'name' => ['geographicalname', 'geoname', 'name'],
    'lat' => ['latitude', 'lat'],
    'lon' => ['longitude', 'long', 'lon'],
    'generic' => ['genericterm', 'generic', 'generictermenglish'],
    'category' => ['genericcategory', 'category', 'concise', 'concisecode'],
    'location' => ['location', 'relativelocation'],
    'province' => ['provinceterritory', 'provterr', 'province'],
    'language' => ['language'],
    'feature' => ['toponymicfeatureid', 'featureid', 'feature'],
    'syllabic' => ['syllabicform', 'syllabic', 'syllabics'],
  ];

  /**
   * Columns without which the import is not worth running.
   */
  public const REQUIRED = ['id', 'name'];

  /**
   * Yields one normalized row per CGNDB feature.
   *
   * Rows sharing a FEATURE_ID across languages are collapsed into a single
   * record: the first (English/official) row supplies the name, the rest fold
   * into variants. Where no feature id column exists, every row stands alone.
   *
   * @param string $file
   *   Path to a .csv, or to a .zip containing exactly one .csv.
   *
   * @return \Generator
   *   Rows in the shape PlaceLookupService::insertBatch() expects.
   */
  public function parse(string $file): \Generator {
    $handle = $this->open($file);

    try {
      $header = fgetcsv($handle);
      if ($header === FALSE) {
        throw new \RuntimeException(sprintf('CGNDB file is empty: %s', $file));
      }
      $map = $this->mapColumns($header);

      // Buffer of features awaiting more language rows. Flushed when the
      // feature id changes; the national extract is grouped, but we also flush
      // at EOF so an ungrouped file still yields every record.
      $pending = [];

      while (($record = fgetcsv($handle)) !== FALSE) {
        $get = function (string $key) use ($record, $map): ?string {
          $index = $map[$key] ?? NULL;
          if ($index === NULL || !isset($record[$index])) {
            return NULL;
          }
          $value = trim((string) $record[$index]);
          return $value === '' ? NULL : $value;
        };

        $source_id = $get('id');
        $name = $get('name');
        if ($source_id === NULL || $name === NULL) {
          continue;
        }

        $key = $get('feature') ?? $source_id;
        if (isset($pending[$key])) {
          // Additional language spelling for a feature we already have.
          $pending[$key]['variants'][] = $name;
          if ($syllabic = $get('syllabic')) {
            $pending[$key]['variants'][] = $syllabic;
          }
          continue;
        }

        // A new feature: flush what we were holding, then start this one.
        foreach ($pending as $row) {
          yield $row;
        }
        $pending = [];

        $variants = [];
        if ($syllabic = $get('syllabic')) {
          $variants[] = $syllabic;
        }

        $place_type = $get('generic') ?? $get('category');
        $lat = $get('lat');
        $lon = $get('lon');

        $pending[$key] = [
          'source' => PlaceSource::Cgndb,
          'source_id' => $source_id,
          'name' => $name,
          // CGNDB has no hierarchy file. LOCATION (the containing municipality
          // or regional district) plus PROV_TERR is the natural two-level
          // equivalent of TGN's Parent_String.
          'parent_path' => implode(', ', array_filter([
            $get('location'),
            $get('province'),
            'Canada',
          ])),
          'place_type' => $place_type,
          'country_code' => 'CA',
          'lat' => is_numeric($lat) ? round((float) $lat, 6) : NULL,
          'lon' => is_numeric($lon) ? round((float) $lon, 6) : NULL,
          'variants' => $variants,
        ];
      }

      foreach ($pending as $row) {
        yield $row;
      }
    }
    finally {
      fclose($handle);
    }
  }

  /**
   * Opens a plain CSV or the single CSV inside a zip.
   *
   * @return resource
   */
  protected function open(string $file) {
    if (!is_readable($file)) {
      throw new \RuntimeException(sprintf('CGNDB dump not readable: %s', $file));
    }

    if (strtolower(pathinfo($file, PATHINFO_EXTENSION)) === 'zip') {
      $zip = new \ZipArchive();
      if ($zip->open($file) !== TRUE) {
        throw new \RuntimeException(sprintf('Could not open zip: %s', $file));
      }
      $entry = NULL;
      for ($i = 0; $i < $zip->numFiles; $i++) {
        $candidate = $zip->getNameIndex($i);
        if (is_string($candidate) && strtolower(pathinfo($candidate, PATHINFO_EXTENSION)) === 'csv') {
          $entry = $candidate;
          break;
        }
      }
      $zip->close();
      if ($entry === NULL) {
        throw new \RuntimeException(sprintf('No .csv inside %s', $file));
      }
      $file = 'zip://' . $file . '#' . $entry;
    }

    $handle = fopen($file, 'r');
    if ($handle === FALSE) {
      throw new \RuntimeException(sprintf('Could not open %s', $file));
    }
    return $handle;
  }

  /**
   * Builds logical key => column index from the header row.
   *
   * Fails loudly, listing what it actually saw. A silent column shift here
   * would poison every one of ~150k rows, and nothing downstream would notice.
   */
  protected function mapColumns(array $header): array {
    // Strip a UTF-8 BOM off the first header cell if present.
    if (isset($header[0])) {
      $header[0] = preg_replace('/^\x{FEFF}/u', '', (string) $header[0]);
    }

    $normalized = [];
    foreach ($header as $index => $label) {
      $key = strtolower(preg_replace('/[^a-z0-9]+/i', '', (string) $label) ?? '');
      if ($key !== '' && !isset($normalized[$key])) {
        $normalized[$key] = $index;
      }
    }

    $map = [];
    foreach (self::COLUMN_ALIASES as $logical => $aliases) {
      foreach ($aliases as $alias) {
        if (isset($normalized[$alias])) {
          $map[$logical] = $normalized[$alias];
          break;
        }
      }
    }

    $missing = array_diff(self::REQUIRED, array_keys($map));
    if ($missing) {
      throw new \RuntimeException(sprintf(
        'CGNDB header is missing required column(s) [%s]. Headers seen: %s',
        implode(', ', $missing),
        implode(' | ', array_map('strval', $header)),
      ));
    }

    return $map;
  }

}
