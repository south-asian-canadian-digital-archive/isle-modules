<?php

namespace Drupal\sacda_modules\Entity;

use Drupal\Core\Config\Entity\ConfigEntityBase;

/**
 * Defines the SACDA Hero config entity.
 *
 * @ConfigEntityType(
 *   id = "sacda_hero",
 *   label = @Translation("SACDA Hero"),
 *   label_collection = @Translation("SACDA Hero sections"),
 *   label_singular = @Translation("hero section"),
 *   label_plural = @Translation("hero sections"),
 *   handlers = {
 *     "list_builder" = "Drupal\sacda_modules\HeroListBuilder",
 *     "form" = {
 *       "add" = "Drupal\sacda_modules\Form\HeroForm",
 *       "edit" = "Drupal\sacda_modules\Form\HeroForm",
 *       "delete" = "Drupal\Core\Entity\EntityDeleteForm"
 *     },
 *     "route_provider" = {
 *       "html" = "Drupal\Core\Entity\Routing\AdminHtmlRouteProvider"
 *     }
 *   },
 *   config_prefix = "hero",
 *   admin_permission = "administer sacda hero",
 *   entity_keys = {
 *     "id" = "id",
 *     "label" = "label",
 *     "status" = "status"
 *   },
 *   config_export = {
 *     "id",
 *     "label",
 *     "path",
 *     "title",
 *     "subtitle",
 *     "image",
 *     "image_style",
 *     "image_fallback"
 *   },
 *   links = {
 *     "collection" = "/admin/structure/sacda-hero",
 *     "add-form" = "/admin/structure/sacda-hero/add",
 *     "edit-form" = "/admin/structure/sacda-hero/{sacda_hero}",
 *     "delete-form" = "/admin/structure/sacda-hero/{sacda_hero}/delete"
 *   }
 * )
 */
class Hero extends ConfigEntityBase {

  /**
   * The machine name.
   *
   * @var string
   */
  protected $id;

  /**
   * The administrative label.
   *
   * @var string
   */
  protected $label;

  /**
   * The URL alias this hero applies to (exact match), e.g. "/about".
   *
   * @var string
   */
  protected $path = '';

  /**
   * The hero title displayed on the page.
   *
   * @var string
   */
  protected $title = '';

  /**
   * The hero subtitle displayed on the page.
   *
   * @var string
   */
  protected $subtitle = '';

  /**
   * UUID of the background media entity. Empty for no background image.
   *
   * @var string
   */
  protected $image = '';

  /**
   * Image style machine name. Empty for the original image.
   *
   * @var string
   */
  protected $image_style = '';

  /**
   * Theme-relative fallback image path, e.g. "contact/hero-bg.jpg".
   *
   * Resolved under the default theme's static/graphics/ directory and used when
   * $image is empty or its media UUID does not resolve on this site. Media
   * UUIDs are content and do not survive a config export/import between
   * environments; this does.
   *
   * @var string
   */
  protected $image_fallback = '';

  /**
   * {@inheritdoc}
   */
  public function calculateDependencies() {
    parent::calculateDependencies();
    if ($this->image_style) {
      $this->addDependency('config', 'image.style.' . $this->image_style);
    }
    return $this;
  }

}
