<?php

/**
 * @file
 * Post-config-import deploy hooks for sacda_modules.
 *
 * These run via `drush deploy:hook`, which custom.Makefile invokes AFTER
 * `drush cim`. That ordering matters: these hooks operate on hero config
 * entities, which do not exist on a fresh environment until the import has run.
 * hook_update_N would be too early — `drush updb` runs before `cim`.
 */

declare(strict_types=1);

use Drupal\file\Entity\File;
use Drupal\media\Entity\Media;

/**
 * Creates hero background media with the UUIDs referenced by exported config.
 *
 * A hero's `image` is a media entity UUID stored inside a config entity. Media
 * are content, so on any environment other than the one the config was exported
 * from that UUID resolves to nothing and the hero falls back to a solid colour.
 *
 * Rather than re-pointing all seven heroes by hand after every deployment, this
 * creates the missing media from the image the hero names in `image_fallback`,
 * forcing the entity to take the UUID the config already expects. Config stays
 * authoritative and the next `cim` has nothing to clobber.
 *
 * Idempotent: heroes whose UUID already resolves are skipped, so it is safe on
 * every deploy, including the environment the config came from.
 */
function sacda_modules_deploy_pin_hero_media(): string {
  $entity_type_manager = \Drupal::entityTypeManager();
  $entity_repository = \Drupal::service('entity.repository');
  $theme_handler = \Drupal::service('theme_handler');
  $file_system = \Drupal::service('file_system');
  $logger = \Drupal::logger('sacda_modules');

  $theme = $theme_handler->getDefault();
  if (!$theme_handler->themeExists($theme)) {
    return 'Default theme not found; skipped.';
  }
  $graphics = DRUPAL_ROOT . '/' . $theme_handler->getTheme($theme)->getPath() . '/static/graphics/';

  $created = 0;
  $skipped = 0;
  $missing = [];

  foreach ($entity_type_manager->getStorage('sacda_hero')->loadMultiple() as $hero) {
    $uuid = (string) $hero->get('image');
    $fallback = (string) $hero->get('image_fallback');

    // Nothing to pin: no UUID expected, or it already resolves here.
    if ($uuid === '' || $entity_repository->loadEntityByUuid('media', $uuid)) {
      $skipped++;
      continue;
    }

    if ($fallback === '' || str_contains($fallback, '..')) {
      $missing[] = $hero->id() . ' (no usable image_fallback)';
      continue;
    }
    $source = $graphics . ltrim($fallback, '/');
    if (!is_file($source)) {
      $missing[] = $hero->id() . " ({$fallback} not in theme)";
      continue;
    }

    // Copy into public:// so the file is served like any other upload.
    $directory = 'public://hero';
    $file_system->prepareDirectory($directory, $file_system::CREATE_DIRECTORY | $file_system::MODIFY_PERMISSIONS);
    $destination = $directory . '/' . basename($source);
    $uri = $file_system->copy($source, $destination, $file_system::EXISTS_REPLACE);

    $file = File::create(['uri' => $uri, 'status' => 1]);
    $file->save();

    // Forcing the UUID is the whole point — it makes the exported config's
    // reference valid on this site.
    $media = Media::create([
      'uuid' => $uuid,
      'bundle' => 'image',
      'name' => $hero->label() . ' hero background',
      'status' => 1,
      'field_media_image' => [
        'target_id' => $file->id(),
        'alt' => '',
      ],
    ]);
    $media->save();

    $logger->notice('Pinned hero %hero background to media %mid with UUID %uuid from theme image %path.', [
      '%hero' => $hero->id(),
      '%mid' => $media->id(),
      '%uuid' => $uuid,
      '%path' => $fallback,
    ]);
    $created++;
  }

  $summary = sprintf('Hero media pinned: %d created, %d already resolved.', $created, $skipped);
  if ($missing) {
    // Not fatal: HeroResolver falls back to the theme image directly, and
    // failing the deploy over a decorative background would be worse.
    $summary .= ' Could not pin: ' . implode(', ', $missing) . '.';
    $logger->warning('Heroes without a usable fallback image: @list', ['@list' => implode(', ', $missing)]);
  }
  return $summary;
}
