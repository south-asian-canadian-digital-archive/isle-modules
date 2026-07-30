<?php

declare(strict_types=1);

namespace Drupal\sacda_modules\Drush\Commands;

use Drupal\sacda_modules\PlaceLookup\Parser\CgndbCsvParser;
use Drupal\sacda_modules\PlaceLookup\Parser\TgnXmlParser;
use Drupal\sacda_modules\PlaceLookup\PlaceLookupService;
use Drupal\sacda_modules\PlaceLookup\PlaceSource;
use Drush\Attributes as CLI;
use Drush\Commands\AutowireTrait;
use Drush\Commands\DrushCommands;
use Symfony\Component\DependencyInjection\Attribute\Autowire;

/**
 * Maintenance commands for the Place Lookup authority mirror.
 *
 * Drush 13 discovery is convention-only and fails SILENTLY if any of this is
 * off, so do not rename casually:
 * - the directory must be exactly src/Drush/Commands/,
 * - the namespace must end in \Drush\Commands,
 * - the class and file name must end in "Commands".
 * There is deliberately no drush.services.yml (removed in Drush 12) and no
 * extra.drush entry in composer.json. Run `drush cr` after changing this file;
 * discovery is cached.
 */
final class PlaceCommands extends DrushCommands {

  use AutowireTrait;

  /**
   * Rows per multi-row INSERT. Keeps the packet well under max_allowed_packet.
   */
  private const DEFAULT_CHUNK = 500;

  public function __construct(
    #[Autowire(service: 'sacda_modules.place_lookup')]
    private readonly PlaceLookupService $lookup,
    #[Autowire(service: 'sacda_modules.place_lookup.tgn_parser')]
    private readonly TgnXmlParser $tgnParser,
    #[Autowire(service: 'sacda_modules.place_lookup.cgndb_parser')]
    private readonly CgndbCsvParser $cgndbParser,
  ) {
    parent::__construct();
  }

  /**
   * Rebuild the place authority table from local TGN / CGNDB dumps.
   *
   * Dumps are never fetched at query time; this is the scheduled refresh.
   * Point --dir at a host directory bind-mounted into the container. Do not
   * commit the dumps themselves — the TGN release is multi-gigabyte.
   */
  #[CLI\Command(name: 'sacda-place:sync-authority', aliases: ['spsa'])]
  #[CLI\Option(name: 'source', description: 'Which source to import: tgn, cgndb or all.')]
  #[CLI\Option(name: 'dir', description: 'Directory holding the dump files.')]
  #[CLI\Option(name: 'tgn-file', description: 'TGN XML filename within --dir.')]
  #[CLI\Option(name: 'cgndb-file', description: 'CGNDB CSV or ZIP filename within --dir.')]
  #[CLI\Option(name: 'chunk', description: 'Rows per multi-row INSERT.')]
  #[CLI\Option(name: 'strict', description: 'Apply the TGN place-type allowlist to trim the import.')]
  #[CLI\Option(name: 'no-sync-local', description: 'Skip the local-term match rebuild afterwards.')]
  #[CLI\Usage(name: 'drush sacda-place:sync-authority --source=cgndb', description: 'Import only the CGNDB extract.')]
  #[CLI\Usage(name: 'drush sacda-place:sync-authority --source=tgn --strict', description: 'Import TGN, place-type filtered.')]
  public function syncAuthority(array $options = [
    'source' => 'all',
    'dir' => '/opt/place-dumps',
    'tgn-file' => 'tgn_xml_0126.zip',
    'cgndb-file' => 'cgn_canada_csv_eng.zip',
    'chunk' => self::DEFAULT_CHUNK,
    'strict' => FALSE,
    'no-sync-local' => FALSE,
  ]): int {
    $requested = strtolower((string) $options['source']);
    $sources = $requested === 'all'
      ? PlaceSource::cases()
      : array_filter([PlaceSource::tryFrom($requested)]);

    if (!$sources) {
      $this->logger()->error(dt('Unknown --source "@s". Use tgn, cgndb or all.', ['@s' => $requested]));
      return self::EXIT_FAILURE;
    }

    $dir = rtrim((string) $options['dir'], '/');
    $chunk = max(1, (int) $options['chunk']);

    foreach ($sources as $source) {
      $file = $dir . '/' . match ($source) {
        PlaceSource::Tgn => (string) $options['tgn-file'],
        PlaceSource::Cgndb => (string) $options['cgndb-file'],
      };

      if (!is_readable($file)) {
        // A missing dump for one source must not abort the other. This is the
        // common case early on: CGNDB is a 15 MB download, TGN is not.
        $this->logger()->warning(dt('Skipping @label: no readable dump at @file', [
          '@label' => $source->label(),
          '@file' => $file,
        ]));
        continue;
      }

      $this->logger()->notice(dt('Importing @label from @file', [
        '@label' => $source->label(),
        '@file' => $file,
      ]));

      $records = match ($source) {
        PlaceSource::Tgn => $this->tgnParser->parse($file, (bool) $options['strict']),
        PlaceSource::Cgndb => $this->cgndbParser->parse($file),
      };

      // Purge then insert, scoped to this source, so reimporting one never
      // disturbs the other.
      $purged = $this->lookup->purgeSource($source);
      $written = $this->writeRecords($records, $chunk);

      $this->logger()->success(dt('@label: removed @purged, inserted @written.', [
        '@label' => $source->label(),
        '@purged' => $purged,
        '@written' => $written,
      ]));
    }

    if ($options['no-sync-local']) {
      $this->logger()->warning(dt('Skipped local match rebuild; run sacda-place:sync-local before using the tool.'));
      return self::EXIT_SUCCESS;
    }

    // A reload wipes local_tids, so the match rebuild is not optional.
    return $this->syncLocal();
  }

  /**
   * Recompute which authority records already exist in the geo_location vocabulary.
   *
   * Matching is by normalized name (term label plus field_geo_alt_name), not by
   * authority URI — almost no term carries an authority link yet. Run nightly
   * and after any batch of term edits.
   */
  #[CLI\Command(name: 'sacda-place:sync-local', aliases: ['spsl'])]
  #[CLI\Option(name: 'dry-run', description: 'Report what would match without writing.')]
  #[CLI\Usage(name: 'drush sacda-place:sync-local --dry-run', description: 'Preview the match counts.')]
  public function syncLocal(array $options = ['dry-run' => FALSE]): int {
    $dry_run = (bool) ($options['dry-run'] ?? FALSE);
    $stats = $this->lookup->rebuildLocalMatches($dry_run);

    $this->logger()->success(dt(
      '@mode @terms terms / @names distinct names: @matched authority rows matched (@ambiguous ambiguous).',
      [
        '@mode' => $dry_run ? 'Dry run —' : 'Rebuilt —',
        '@terms' => $stats['terms'],
        '@names' => $stats['names'],
        '@matched' => $stats['matched'],
        '@ambiguous' => $stats['ambiguous'],
      ],
    ));

    return self::EXIT_SUCCESS;
  }

  /**
   * Show the current state of the authority mirror.
   */
  #[CLI\Command(name: 'sacda-place:status', aliases: ['spst'])]
  public function status(): int {
    $this->logger()->notice(dt('Total: @n rows.', ['@n' => $this->lookup->count()]));
    foreach (PlaceSource::cases() as $source) {
      $this->logger()->notice(dt('  @label: @n', [
        '@label' => $source->label(),
        '@n' => $this->lookup->count($source),
      ]));
    }
    return self::EXIT_SUCCESS;
  }

  /**
   * Buffers generator output into chunked inserts.
   */
  private function writeRecords(iterable $records, int $chunk): int {
    $buffer = [];
    $written = 0;
    // (source, source_id) is UNIQUE, and a single duplicate would abort the
    // whole import with an integrity violation part-way through. Sources are
    // meant to be unique on their own ids, so drop repeats quietly rather than
    // letting one bad row cost a multi-hour reimport.
    $seen = [];

    foreach ($records as $record) {
      $key = $record['source_id'];
      if (isset($seen[$key])) {
        continue;
      }
      $seen[$key] = TRUE;
      $buffer[] = $record;
      if (count($buffer) >= $chunk) {
        $written += $this->lookup->insertBatch($buffer);
        $buffer = [];
        if ($written % 25000 === 0) {
          $this->logger()->notice(dt('  … @n rows', ['@n' => $written]));
        }
      }
    }
    if ($buffer) {
      $written += $this->lookup->insertBatch($buffer);
    }

    return $written;
  }

}
