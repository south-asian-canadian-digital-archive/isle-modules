<?php

namespace Drupal\sacda_modules\Form;

use Drupal\Core\Entity\EntityForm;
use Drupal\Core\Entity\EntityRepositoryInterface;
use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\Core\Form\FormStateInterface;
use Symfony\Component\DependencyInjection\ContainerInterface;

/**
 * Add/edit form for SACDA Hero config entities.
 */
class HeroForm extends EntityForm {

  /**
   * The entity repository.
   *
   * @var \Drupal\Core\Entity\EntityRepositoryInterface
   */
  protected $entityRepository;

  /**
   * The entity type manager.
   *
   * @var \Drupal\Core\Entity\EntityTypeManagerInterface
   */
  protected $entityTypeManager;

  /**
   * Constructs a HeroForm.
   */
  public function __construct(EntityRepositoryInterface $entity_repository, EntityTypeManagerInterface $entity_type_manager) {
    $this->entityRepository = $entity_repository;
    $this->entityTypeManager = $entity_type_manager;
  }

  /**
   * {@inheritdoc}
   */
  public static function create(ContainerInterface $container) {
    return new static(
      $container->get('entity.repository'),
      $container->get('entity_type.manager')
    );
  }

  /**
   * {@inheritdoc}
   */
  public function form(array $form, FormStateInterface $form_state) {
    $form = parent::form($form, $form_state);
    /** @var \Drupal\sacda_modules\Entity\Hero $hero */
    $hero = $this->entity;

    $form['label'] = [
      '#type' => 'textfield',
      '#title' => $this->t('Label'),
      '#description' => $this->t('Administrative label, shown only in the admin listing.'),
      '#default_value' => $hero->label(),
      '#required' => TRUE,
      '#maxlength' => 255,
    ];

    $form['id'] = [
      '#type' => 'machine_name',
      '#default_value' => $hero->id(),
      '#machine_name' => [
        'exists' => [$this, 'exists'],
        'source' => ['label'],
      ],
      '#disabled' => !$hero->isNew(),
    ];

    $form['path'] = [
      '#type' => 'textfield',
      '#title' => $this->t('Path'),
      '#description' => $this->t('The URL alias this hero applies to, e.g. <em>/about</em> or <em>/about/team</em>. Exact match against the current page alias.'),
      '#default_value' => $hero->get('path'),
      '#required' => TRUE,
      '#maxlength' => 255,
    ];

    $form['title'] = [
      '#type' => 'textfield',
      '#title' => $this->t('Hero title'),
      '#default_value' => $hero->get('title'),
      '#maxlength' => 255,
    ];

    $form['subtitle'] = [
      '#type' => 'textfield',
      '#title' => $this->t('Hero subtitle'),
      '#default_value' => $hero->get('subtitle'),
      '#maxlength' => 512,
    ];

    $media = NULL;
    if ($hero->get('image')) {
      $media = $this->entityRepository->loadEntityByUuid('media', $hero->get('image'));
    }
    $form['image'] = [
      '#type' => 'entity_autocomplete',
      '#target_type' => 'media',
      '#title' => $this->t('Background image'),
      '#description' => $this->t('A media entity used as the hero background. Leave empty to use the fallback below.'),
      '#default_value' => $media,
    ];

    $form['image_fallback'] = [
      '#type' => 'textfield',
      '#title' => $this->t('Fallback image path'),
      '#description' => $this->t('Path relative to the default theme\'s static/graphics/ directory, e.g. <code>contact/hero-bg.jpg</code>. Used when no media is selected above, or when the selected media does not exist on this site. Media references are content and do not survive a config deployment between environments; this path does. Leave empty for a solid background.'),
      '#default_value' => $hero->get('image_fallback'),
      '#maxlength' => 255,
    ];

    $style_options = ['' => $this->t('- Original image -')];
    foreach ($this->entityTypeManager->getStorage('image_style')->loadMultiple() as $style) {
      $style_options[$style->id()] = $style->label();
    }
    $form['image_style'] = [
      '#type' => 'select',
      '#title' => $this->t('Image style'),
      '#description' => $this->t('Optional image style applied to the background image.'),
      '#options' => $style_options,
      '#default_value' => $hero->get('image_style'),
    ];

    $form['status'] = [
      '#type' => 'checkbox',
      '#title' => $this->t('Enabled'),
      '#default_value' => $hero->status(),
    ];

    return $form;
  }

  /**
   * {@inheritdoc}
   */
  public function validateForm(array &$form, FormStateInterface $form_state) {
    parent::validateForm($form, $form_state);
    $path = $form_state->getValue('path');
    if ($path && $path[0] !== '/') {
      $form_state->setErrorByName('path', $this->t('The path must start with a slash, e.g. <em>/about</em>.'));
    }
  }

  /**
   * {@inheritdoc}
   */
  public function submitForm(array &$form, FormStateInterface $form_state) {
    // Convert the autocomplete's media entity ID to a UUID for storage.
    $uuid = '';
    if ($mid = $form_state->getValue('image')) {
      $media = $this->entityTypeManager->getStorage('media')->load($mid);
      if ($media) {
        $uuid = $media->uuid();
      }
    }
    $form_state->setValue('image', $uuid);
    parent::submitForm($form, $form_state);
  }

  /**
   * {@inheritdoc}
   */
  public function save(array $form, FormStateInterface $form_state) {
    $result = $this->entity->save();
    $this->messenger()->addStatus($this->t('Saved hero section %label.', ['%label' => $this->entity->label()]));
    $form_state->setRedirectUrl($this->entity->toUrl('collection'));
    return $result;
  }

  /**
   * Machine name exists callback.
   */
  public function exists($id) {
    return (bool) $this->entityTypeManager->getStorage('sacda_hero')->load($id);
  }

}
