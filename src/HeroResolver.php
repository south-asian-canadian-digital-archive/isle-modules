<?php

namespace Drupal\sacda_modules;

use Drupal\Core\Cache\CacheableMetadata;
use Drupal\Core\Entity\EntityRepositoryInterface;
use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\Core\Extension\ThemeHandlerInterface;
use Drupal\Core\File\FileUrlGeneratorInterface;
use Drupal\Core\Path\CurrentPathStack;
use Drupal\path_alias\AliasManagerInterface;

/**
 * Resolves the hero config entity matching the current page's URL alias.
 *
 * Single source of truth for "does this page have a hero?" — consumed by the
 * HeroBlock plugin (rendering) and by sacda_modules_preprocess_block() (page
 * title suppression in the theme).
 */
class HeroResolver {

  /**
   * Memoized result for the current request (FALSE = not yet resolved).
   *
   * @var array|null|false
   */
  protected array|null|false $resolved = FALSE;

  /**
   * Cache metadata accumulated while resolving.
   */
  protected CacheableMetadata $cacheMetadata;

  public function __construct(
    protected CurrentPathStack $currentPath,
    protected AliasManagerInterface $aliasManager,
    protected EntityTypeManagerInterface $entityTypeManager,
    protected EntityRepositoryInterface $entityRepository,
    protected FileUrlGeneratorInterface $fileUrlGenerator,
    protected ThemeHandlerInterface $themeHandler,
  ) {
    $this->cacheMetadata = new CacheableMetadata();
  }

  /**
   * Finds the enabled hero entity whose path matches the current alias.
   *
   * @return array|null
   *   ['entity' => Hero, 'title' => string, 'subtitle' => string,
   *    'image' => string (URL or '')] or NULL when no hero matches.
   */
  public function resolve(): ?array {
    if ($this->resolved !== FALSE) {
      return $this->resolved;
    }

    // The result varies by path, and adding/removing hero entities must
    // invalidate pages (list cache tag covers entities matched or not).
    $this->cacheMetadata->addCacheContexts(['url.path']);
    $this->cacheMetadata->addCacheTags(['config:sacda_hero_list']);

    $alias = $this->aliasManager->getAliasByPath($this->currentPath->getPath());

    $storage = $this->entityTypeManager->getStorage('sacda_hero');
    $ids = $storage->getQuery()
      ->condition('status', TRUE)
      ->condition('path', $alias)
      ->execute();

    if (!$ids) {
      return $this->resolved = NULL;
    }

    /** @var \Drupal\sacda_modules\Entity\Hero $hero */
    $hero = $storage->load(reset($ids));
    $this->cacheMetadata->addCacheableDependency($hero);

    $image_url = '';
    if ($uuid = $hero->get('image')) {
      /** @var \Drupal\media\MediaInterface|null $media */
      $media = $this->entityRepository->loadEntityByUuid('media', $uuid);
      if ($media) {
        $this->cacheMetadata->addCacheableDependency($media);
        $fid = $media->getSource()->getSourceFieldValue($media);
        $file = is_numeric($fid)
          ? $this->entityTypeManager->getStorage('file')->load($fid)
          : NULL;
        if ($file) {
          $this->cacheMetadata->addCacheableDependency($file);
          $uri = $file->getFileUri();
          $style = $hero->get('image_style')
            ? $this->entityTypeManager->getStorage('image_style')->load($hero->get('image_style'))
            : NULL;
          if ($style && $style->supportsUri($uri)) {
            $this->cacheMetadata->addCacheableDependency($style);
            $image_url = $style->buildUrl($uri);
          }
          else {
            $image_url = $this->fileUrlGenerator->generateAbsoluteString($uri);
          }
        }
      }
    }

    // Media UUIDs are content, not config, so an exported hero carries a UUID
    // that only resolves on the site it was exported from. Fall back to an
    // image shipped with the theme so a fresh environment still renders a real
    // background instead of the solid-colour placeholder.
    if ($image_url === '' && ($fallback = $hero->get('image_fallback'))) {
      $image_url = $this->themeImageUrl($fallback);
    }

    return $this->resolved = [
      'entity' => $hero,
      'title' => $hero->get('title'),
      'subtitle' => $hero->get('subtitle'),
      'image' => $image_url,
    ];
  }

  /**
   * Resolves a theme-relative path (e.g. "contact/hero-bg.jpg") to a URL.
   *
   * Paths are looked up under the default theme's static/graphics/ directory.
   * Returns '' when the file is absent, so the twig template falls through to
   * its solid-colour branch rather than emitting a broken <img>.
   */
  protected function themeImageUrl(string $path): string {
    // Defend against a path escaping the graphics directory.
    if (str_contains($path, '..')) {
      return '';
    }
    $theme = $this->themeHandler->getDefault();
    if (!$this->themeHandler->themeExists($theme)) {
      return '';
    }
    $relative = $this->themeHandler->getTheme($theme)->getPath()
      . '/static/graphics/' . ltrim($path, '/');
    if (!is_file(DRUPAL_ROOT . '/' . $relative)) {
      return '';
    }
    // The theme's assets change with its deployed code, not with any entity,
    // so the surrounding config-entity cache metadata already covers this.
    return $this->fileUrlGenerator->generateAbsoluteString($relative);
  }

  /**
   * Cache metadata for the resolution (valid after calling resolve()).
   */
  public function getCacheMetadata(): CacheableMetadata {
    return $this->cacheMetadata;
  }

}
