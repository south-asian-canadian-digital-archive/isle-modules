<?php

declare(strict_types=1);

namespace Drupal\sacda_modules\Drush\Commands;

use Drupal\Core\Database\Connection;
use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\Core\Session\AccountSwitcherInterface;
use Drupal\Core\Session\AnonymousUserSession;
use Drupal\dgi_image_discovery\ImageDiscoveryInterface;
use Drush\Attributes as CLI;
use Drush\Commands\AutowireTrait;
use Drush\Commands\DrushCommands;
use Symfony\Component\DependencyInjection\Attribute\Autowire;

/**
 * Pre-fills sacda_thumbnail so the first visitor after an ingest is not slow.
 *
 * Discovery convention notes are in PlaceCommands; the same rules apply here.
 */
final class ThumbnailCommands extends DrushCommands {

  use AutowireTrait;

  public function __construct(
    #[Autowire(service: 'dgi_image_discovery.service')]
    private readonly ImageDiscoveryInterface $discovery,
    #[Autowire(service: 'database')]
    private readonly Connection $database,
    #[Autowire(service: 'entity_type.manager')]
    private readonly EntityTypeManagerInterface $entityTypeManager,
    #[Autowire(service: 'account_switcher')]
    private readonly AccountSwitcherInterface $accountSwitcher,
  ) {
    parent::__construct();
  }

  /**
   * Computes the stored thumbnail for every node that has children.
   */
  #[CLI\Command(name: 'sacda:thumbnails:rebuild')]
  #[CLI\Option(name: 'all', description: 'Recompute existing rows too, not just missing ones.')]
  #[CLI\Usage(name: 'drush sacda:thumbnails:rebuild', description: 'Fill in collections with no stored thumbnail (run after an ingest).')]
  public function rebuild(array $options = ['all' => FALSE]): void {
    $query = $this->database->select('node__field_member_of', 'm');
    $query->addField('m', 'field_member_of_target_id', 'nid');
    $query->distinct();
    if (!$options['all']) {
      $query->leftJoin('sacda_thumbnail', 't', 't.nid = m.field_member_of_target_id');
      $query->isNull('t.nid');
    }
    $nids = $query->execute()->fetchCol();

    // Stored answers are what an anonymous visitor would see.
    $this->accountSwitcher->switchTo(new AnonymousUserSession());
    try {
      $storage = $this->entityTypeManager->getStorage('node');
      $found = 0;
      foreach (array_chunk($nids, 50) as $chunk) {
        if ($options['all']) {
          $this->database->delete('sacda_thumbnail')->condition('nid', $chunk, 'IN')->execute();
        }
        foreach ($storage->loadMultiple($chunk) as $node) {
          $found += (int) $this->discovery->getImage($node)->hasMedia();
        }
        $storage->resetCache($chunk);
      }
    }
    finally {
      $this->accountSwitcher->switchBack();
    }
    $this->logger()->success(sprintf('Stored thumbnails for %d nodes (%d with an image).', count($nids), $found));
  }

}
