<?php

namespace Drupal\sacda_modules\Plugin\Block;

use Drupal\Core\Block\BlockBase;
use Drupal\Core\Plugin\ContainerFactoryPluginInterface;
use Drupal\sacda_modules\HeroResolver;
use Symfony\Component\DependencyInjection\ContainerInterface;

/**
 * Renders the hero section for the current page.
 *
 * Placed once in the theme's `hero` region; internally resolves the hero
 * config entity matching the current path alias. Renders nothing (block
 * collapses) when no hero matches. Carries a contextual "Edit hero" link to
 * the matched entity's edit form.
 *
 * @Block(
 *   id = "sacda_hero_block",
 *   admin_label = @Translation("SACDA Hero"),
 *   category = @Translation("SACDA"),
 * )
 */
class HeroBlock extends BlockBase implements ContainerFactoryPluginInterface {

  protected HeroResolver $resolver;

  public static function create(ContainerInterface $container, array $configuration, $plugin_id, $plugin_definition) {
    $instance = new static($configuration, $plugin_id, $plugin_definition);
    $instance->resolver = $container->get('sacda_modules.hero_resolver');
    return $instance;
  }

  /**
   * {@inheritdoc}
   */
  public function build() {
    $hero = $this->resolver->resolve();
    $cache = $this->resolver->getCacheMetadata();

    if (!$hero) {
      $build = [];
      $cache->applyTo($build);
      return $build;
    }

    $build = [
      '#theme' => 'sacda_hero',
      '#title' => $hero['title'],
      '#subtitle' => $hero['subtitle'],
      '#image' => $hero['image'],
      '#contextual_links' => [
        'sacda_hero' => [
          'route_parameters' => ['sacda_hero' => $hero['entity']->id()],
        ],
      ],
    ];
    $cache->applyTo($build);
    return $build;
  }

}
