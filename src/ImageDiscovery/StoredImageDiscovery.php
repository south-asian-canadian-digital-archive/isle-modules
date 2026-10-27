<?php

namespace Drupal\sacda_modules\ImageDiscovery;

use Drupal\Core\Cache\Cache;
use Drupal\Core\Database\Connection;
use Drupal\Core\Entity\ContentEntityInterface;
use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\Core\Session\AccountProxyInterface;
use Drupal\Core\Site\Settings;
use Drupal\dgi_image_discovery\ImageDiscoveredEvent;
use Drupal\dgi_image_discovery\ImageDiscoveryEvent;
use Drupal\dgi_image_discovery\ImageDiscoveryInterface;
use Drupal\node\NodeInterface;
use Symfony\Contracts\EventDispatcher\EventDispatcherInterface;

/**
 * Remembers which image discovery picked for each node, in sacda_thumbnail.
 *
 * Collection cards fall back to a child's thumbnail, and
 * DiscoverFirstAvailableChildThumbnailSubscriber may walk ~1,000 descendants
 * to answer — usually to conclude there is no image at all. That answer only
 * changes when something below the node changes, so it is computed once and
 * stored; saving any node or media below it deletes the row (see
 * sacda_modules_entity_insert() and friends) and the next view recomputes.
 * `drush sacda:thumbnails:rebuild` pre-fills the table after an ingest.
 *
 * Why a table and not field_representative_image: a field cannot say "checked,
 * nothing found", which is the expensive case, and writing it would mean a node
 * save (Solr, Fedora sync, Islandora contexts) per collection per ingest. The
 * field stays for curators' manual picks, which upstream checks first.
 *
 * Only anonymous root lookups use the table, so a stored answer never depends
 * on who computed it. View access is re-checked on every read.
 *
 * Kill switch, no deploy needed:
 * @code
 * $settings['sacda_image_discovery_cache'] = FALSE;
 * @endcode
 */
class StoredImageDiscovery implements ImageDiscoveryInterface {

  /**
   * Nested lookups made by subscribers while answering a root lookup.
   *
   * Discovery is depth-limited, so a nested answer is not a valid root answer
   * for the same entity; only depth-0 results are stored.
   *
   * @var int
   */
  protected int $depth = 0;

  /**
   * Constructor.
   */
  public function __construct(
    protected ImageDiscoveryInterface $inner,
    protected Connection $database,
    protected EntityTypeManagerInterface $entityTypeManager,
    protected AccountProxyInterface $currentUser,
    protected EventDispatcherInterface $eventDispatcher,
    protected Settings $settings,
  ) {}

  /**
   * {@inheritdoc}
   */
  public function getImage(ContentEntityInterface $entity) : ImageDiscoveryEvent {
    if (!$this->settings->get('sacda_image_discovery_cache', TRUE)
      || $this->depth > 0 || !($entity instanceof NodeInterface) || $entity->isNew()
      || $this->currentUser->isAuthenticated()) {
      return $this->inner->getImage($entity);
    }

    $row = $this->database->select('sacda_thumbnail', 't')
      ->fields('t', ['mid'])
      ->condition('nid', $entity->id())
      ->execute()
      ->fetchObject();
    if ($row && ($event = $this->fromRow($entity, $row->mid))) {
      return $event;
    }

    $event = $this->compute($entity);
    $this->database->merge('sacda_thumbnail')
      ->keys(['nid' => $entity->id()])
      ->fields(['mid' => $event->getMedia()?->id(), 'computed' => time()])
      ->execute();
    return $event;
  }

  /**
   * Runs the full discovery chain, bypassing the table.
   */
  public function compute(NodeInterface $node) : ImageDiscoveryEvent {
    $this->depth++;
    try {
      $event = $this->inner->getImage($node);
    }
    finally {
      $this->depth--;
    }
    return $event->addCacheTags([static::cacheTag($node->id())]);
  }

  /**
   * Forgets stored answers so they are recomputed on next view.
   *
   * @param int[] $nids
   *   Node IDs whose answer may have changed.
   */
  public function forget(array $nids) : void {
    if (!$nids) {
      return;
    }
    $this->database->delete('sacda_thumbnail')
      ->condition('nid', $nids, 'IN')
      ->execute();
    Cache::invalidateTags(array_map([static::class, 'cacheTag'], $nids));
  }

  /**
   * The cache tag every rendering of a stored answer carries.
   */
  public static function cacheTag(int|string $nid) : string {
    return 'sacda_thumbnail:' . $nid;
  }

  /**
   * Rebuilds a discovery event from a stored row, if still usable.
   */
  protected function fromRow(NodeInterface $node, $mid) : ?ImageDiscoveryEvent {
    $event = (new ImageDiscoveryEvent($node))
      ->addCacheTags([static::cacheTag($node->id())]);

    if ($mid !== NULL) {
      $media = $this->entityTypeManager->getStorage('media')->load($mid);
      if (!$media) {
        return NULL;
      }
      $access = $media->access('view', NULL, TRUE);
      if (!$access->isAllowed()) {
        return NULL;
      }
      $event->addCacheableDependency($access)->setMedia($media);
    }

    // Upstream fires this after every discovery; keep listeners seeing it.
    return $this->eventDispatcher
      ->dispatch(new ImageDiscoveredEvent($event), ImageDiscoveredEvent::EVENT_NAME)
      ->getEvent();
  }

}
