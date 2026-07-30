<?php

declare(strict_types=1);

namespace Drupal\sacda_modules\PlaceLookup;

/**
 * The authority sources mirrored into sacda_place_authority.
 *
 * The schema stores this as a varchar because Drupal's Schema API has no ENUM;
 * this enum is where the allowed values actually live.
 */
enum PlaceSource: string {

  case Tgn = 'tgn';
  case Cgndb = 'cgndb';

  /**
   * Human label, used in Drush output and as the result group heading.
   */
  public function label(): string {
    return match ($this) {
      self::Tgn => 'Getty TGN',
      self::Cgndb => 'CGNDB',
    };
  }

  /**
   * Display order on the lookup page. TGN first, CGNDB second.
   */
  public function weight(): int {
    return match ($this) {
      self::Tgn => 0,
      self::Cgndb => 1,
    };
  }

  /**
   * Resolves a URI for a source record, or NULL if the source has no URIs.
   */
  public function uri(string $source_id): ?string {
    return match ($this) {
      self::Tgn => 'http://vocab.getty.edu/tgn/' . $source_id,
      // CGNDB has no stable per-record resolver URI; identifiers are cited
      // bare, so callers should fall back to the raw CGNDB ID.
      self::Cgndb => NULL,
    };
  }

}
