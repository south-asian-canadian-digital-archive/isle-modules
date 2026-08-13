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
    // Prefix with the hero id: several heroes name their fallback
    // `<page>/hero-bg.jpg`, so a bare basename collides and EXISTS_REPLACE
    // silently hands the later hero's photo to the earlier one. That is how
    // PROD's Contact page ended up showing the Exhibits background.
    $destination = $directory . '/' . $hero->id() . '-' . basename($source);
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

/**
 * Repairs hero backgrounds left wrong by the old un-prefixed destination name.
 *
 * Before the destination gained a hero-id prefix, every hero whose fallback was
 * named `<page>/hero-bg.jpg` copied to the same `public://hero/hero-bg.jpg`
 * with EXISTS_REPLACE. The alphabetically-later hero won, so on any site
 * deployed with the old code the Contact page renders the Exhibits photograph.
 *
 * pin_hero_media() cannot undo this on its own: it skips any hero whose UUID
 * already resolves, and these all do — they resolve to a media whose file
 * simply holds the wrong bytes. So this re-copies from the theme under the
 * prefixed name and re-points the media at it.
 *
 * Idempotent: a media already pointing at the prefixed URI is left alone, so
 * this settles after one deploy and no-ops thereafter. The superseded files are
 * left in place rather than deleted — they are a few hundred KB, and removing
 * a file another entity turned out to reference would be the worse failure.
 */
function sacda_modules_deploy_repin_collided_hero_media(): string {
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

  $repaired = 0;
  $ok = 0;

  foreach ($entity_type_manager->getStorage('sacda_hero')->loadMultiple() as $hero) {
    $uuid = (string) $hero->get('image');
    $fallback = (string) $hero->get('image_fallback');
    if ($uuid === '' || $fallback === '' || str_contains($fallback, '..')) {
      continue;
    }

    $source = $graphics . ltrim($fallback, '/');
    if (!is_file($source)) {
      continue;
    }

    $media = $entity_repository->loadEntityByUuid('media', $uuid);
    if (!$media) {
      // Never pinned here; pin_hero_media() will create it correctly.
      continue;
    }

    $item = $media->get('field_media_image');
    $file = $item->entity;
    $expected = 'public://hero/' . $hero->id() . '-' . basename($source);
    if ($file && $file->getFileUri() === $expected) {
      $ok++;
      continue;
    }

    $directory = 'public://hero';
    $file_system->prepareDirectory($directory, $file_system::CREATE_DIRECTORY | $file_system::MODIFY_PERMISSIONS);
    $uri = $file_system->copy($source, $expected, $file_system::EXISTS_REPLACE);

    $new_file = File::create(['uri' => $uri, 'status' => 1]);
    $new_file->save();

    $item->setValue([
      'target_id' => $new_file->id(),
      'alt' => $item->alt ?? '',
    ]);
    $media->save();

    $logger->notice('Re-pinned hero %hero background to %uri (was %old).', [
      '%hero' => $hero->id(),
      '%uri' => $uri,
      '%old' => $file ? $file->getFileUri() : 'no file',
    ]);
    $repaired++;
  }

  return sprintf('Hero backgrounds re-pinned: %d repaired, %d already correct.', $repaired, $ok);
}
