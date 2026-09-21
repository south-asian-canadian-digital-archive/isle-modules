<?php

namespace Drupal\sacda_modules\EventSubscriber;

use Drupal\Core\Entity\EntityStorageInterface;
use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\dgi_image_discovery\EventSubscriber\AbstractImageDiscoverySubscriber;
use Drupal\dgi_image_discovery\ImageDiscoveryEvent;
use Drupal\dgi_image_discovery\ImageDiscoveryInterface;
use Drupal\node\NodeInterface;

/**
 * Finds a representative image on the first child that actually has one.
 *
 * dgi_image_discovery's own DiscoverChildThumbnailSubscriber looks at exactly
 * ONE child — the lowest `field_weight`, ties broken by node ID — and gives up
 * if that child has no image. In this repository most items carry no weight at
 * all, so "first child" is really "lowest nid", i.e. whichever row Workbench
 * happened to create first. When that one item is missing its file, or its
 * derivatives failed, the whole collection renders the generic model icon even
 * though dozens of its siblings have perfectly good thumbnails.
 *
 * This runs ahead of it (priority 850 vs. 800) and walks the children in the
 * same order until one yields an image.
 *
 * Breadth is capped per depth rather than globally: the recursion is
 * multiplicative, so an uncapped scan of a fonds whose sub-collections are all
 * imageless would load thousands of nodes to render one card.
 */
class DiscoverFirstAvailableChildThumbnailSubscriber extends AbstractImageDiscoverySubscriber {

  /**
   * Runs before dgi_image_discovery's single-child subscriber (800).
   *
   * Still below DiscoverOwnedThumbnailSubscriber (900), so a node's own
   * thumbnail continues to win over anything inherited from a child.
   */
  const PRIORITY = 850;

  /**
   * How many children to examine, indexed by the depth being entered.
   *
   * Tapers with depth to bound the total node loads (25 + 25*8 + 25*8*4).
   */
  protected const BREADTH_BY_DEPTH = [1 => 25, 2 => 8, 3 => 4];

  /**
   * Node storage.
   *
   * @var \Drupal\Core\Entity\EntityStorageInterface
   */
  protected EntityStorageInterface $nodeStorage;

  /**
   * Traversal depth, to break the recursion. Mirrors the contrib subscriber.
   *
   * @var int
   */
  protected int $depth = 0;

  /**
   * Constructor.
   */
  public function __construct(
    protected ImageDiscoveryInterface $imageDiscovery,
    EntityTypeManagerInterface $entity_type_manager,
  ) {
    $this->nodeStorage = $entity_type_manager->getStorage('node');
  }

  /**
   * {@inheritdoc}
   */
  public function discoverImage(ImageDiscoveryEvent $event) : void {
    $node = $event->getEntity();

    if (!($node instanceof NodeInterface)) {
      return;
    }

    $depth = $this->depth + 1;
    $breadth = static::BREADTH_BY_DEPTH[$depth] ?? NULL;
    if ($breadth === NULL) {
      // Exhausted depth.
      return;
    }

    try {
      $this->depth = $depth;

      $results = $this->nodeStorage->getQuery()
        ->condition('field_member_of', $node->id())
        ->sort('field_weight')
        // XXX: field_weight is nullable and not unique, so break ties on nid,
        // matching the order the collection itself is listed in.
        ->sort('nid')
        ->accessCheck()
        ->range(0, $breadth)
        ->execute();

      // Any child gaining or losing an image changes this answer, and so does
      // a new child appearing within the scanned range.
      $event->addCacheTags(['node_list']);

      // loadMultiple() returns entities keyed (and so ordered) by ID, which
      // would throw away the weight ordering above — walk the query result.
      $children = $this->nodeStorage->loadMultiple($results);
      foreach ($results as $nid) {
        $child = $children[$nid] ?? NULL;
        if (!$child) {
          continue;
        }

        $event->addCacheableDependency($child->access('view', NULL, TRUE));

        $child_event = $this->imageDiscovery->getImage($child);
        $event->addCacheableDependency($child_event);

        if ($child_event->hasMedia()) {
          $event->setMedia($child_event->getMedia())
            ->stopPropagation();
          return;
        }
      }
    }
    finally {
      $this->depth = $depth - 1;
    }
  }

}
