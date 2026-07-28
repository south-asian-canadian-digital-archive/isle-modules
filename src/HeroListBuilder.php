<?php

namespace Drupal\sacda_modules;

use Drupal\Core\Config\Entity\ConfigEntityListBuilder;
use Drupal\Core\Entity\EntityInterface;

/**
 * Builds the listing of SACDA Hero config entities.
 */
class HeroListBuilder extends ConfigEntityListBuilder {

  /**
   * {@inheritdoc}
   */
  public function buildHeader() {
    $header['label'] = $this->t('Label');
    $header['path'] = $this->t('Path');
    $header['title'] = $this->t('Title');
    $header['status'] = $this->t('Status');
    return $header + parent::buildHeader();
  }

  /**
   * {@inheritdoc}
   */
  public function buildRow(EntityInterface $entity) {
    /** @var \Drupal\sacda_modules\Entity\Hero $entity */
    $row['label'] = $entity->label();
    $row['path'] = $entity->get('path');
    $row['title'] = $entity->get('title');
    $row['status'] = $entity->status() ? $this->t('Enabled') : $this->t('Disabled');
    return $row + parent::buildRow($entity);
  }

}
