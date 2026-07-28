<?php

namespace Drupal\sacda_modules\Controller;

use Drupal\Core\Controller\ControllerBase;
use Drupal\Core\Extension\ModuleExtensionList;
use Drupal\Core\Url;
use Drupal\node\NodeInterface;
use Symfony\Component\DependencyInjection\ContainerInterface;
use Symfony\Component\HttpFoundation\BinaryFileResponse;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;
use Symfony\Component\Mime\MimeTypes;

/**
 * Serves static exhibit sites mapped to exhibit nodes by field_slug.
 */
class ExhibitController extends ControllerBase {

  /**
   * Machine name of the exhibit content type.
   */
  const BUNDLE = 'exhibit';

  /**
   * The module extension list, used to locate the exhibits/ directory.
   */
  protected ModuleExtensionList $moduleList;

  public function __construct(ModuleExtensionList $module_list) {
    $this->moduleList = $module_list;
  }

  public static function create(ContainerInterface $container): static {
    return new static($container->get('extension.list.module'));
  }

  /**
   * Page callback: /exhibits/{node}.
   *
   * Renders the exhibit wrapper; actual exhibit markup is fetched client-side
   * by the <sacda-exhibit> element and injected into a shadow root.
   */
  public function view(NodeInterface $node): array {
    $slug = $this->resolveSlug($node);
    if (!is_file($this->exhibitDir($slug) . '/index.html')) {
      throw new NotFoundHttpException(sprintf('No exhibit files found for slug "%s".', $slug));
    }

    // The {path} requirement is ".+", so an empty value cannot be generated;
    // build the index.html URL and derive the assets base from it.
    $index_url = Url::fromRoute('sacda_modules.exhibit_asset', [
      'node' => $node->id(),
      'path' => 'index.html',
    ])->toString();
    $assets_base = substr($index_url, 0, -strlen('index.html'));

    return [
      '#theme' => 'sacda_exhibit',
      '#node' => $node,
      '#exhibit_src' => $assets_base . 'index.html',
      '#assets_base' => $assets_base,
      '#attached' => [
        'library' => ['sacda_modules/exhibit_loader'],
      ],
      '#cache' => [
        'tags' => $node->getCacheTags(),
      ],
    ];
  }

  /**
   * Title callback for the view route.
   */
  public function title(NodeInterface $node): string {
    return $node->label();
  }

  /**
   * Streams a single static asset: /exhibits/{node}/assets/{path}.
   */
  public function asset(NodeInterface $node, string $path): BinaryFileResponse {
    $slug = $this->resolveSlug($node);
    $dir = realpath($this->exhibitDir($slug));
    if ($dir === FALSE) {
      throw new NotFoundHttpException();
    }

    // Resolve and contain the requested path inside the exhibit directory.
    $file = realpath($dir . '/' . $path);
    if ($file === FALSE || !str_starts_with($file, $dir . DIRECTORY_SEPARATOR) || !is_file($file)) {
      throw new NotFoundHttpException();
    }

    $mime = MimeTypes::getDefault()->guessMimeType($file) ?? 'application/octet-stream';
    // guessMimeType() sniffs content, which reports css/js as text/plain;
    // prefer the extension mapping for correct browser behaviour.
    $ext = strtolower(pathinfo($file, PATHINFO_EXTENSION));
    $by_ext = MimeTypes::getDefault()->getMimeTypes($ext);
    if (!empty($by_ext)) {
      $mime = $by_ext[0];
    }

    $response = new BinaryFileResponse($file, 200, [
      'Content-Type' => $mime,
      // Exhibit files only change on deploy; cache modestly.
      'Cache-Control' => 'public, max-age=3600',
    ]);
    $response->isNotModified(\Drupal::request());
    return $response;
  }

  /**
   * Validates the node and returns its sanitized slug, or 404s.
   */
  protected function resolveSlug(NodeInterface $node): string {
    if ($node->bundle() !== static::BUNDLE || !$node->isPublished() && !$this->currentUser()->hasPermission('view own unpublished content')) {
      throw new NotFoundHttpException();
    }
    $slug = $node->hasField('field_slug') ? trim((string) $node->get('field_slug')->value) : '';
    // Strict allow-list: the slug becomes a filesystem path component.
    if ($slug === '' || !preg_match('/^[a-z0-9][a-z0-9_-]*$/', $slug)) {
      throw new NotFoundHttpException(sprintf('Exhibit node %d has a missing or invalid field_slug.', $node->id()));
    }
    return $slug;
  }

  /**
   * Absolute filesystem path of an exhibit's directory.
   */
  protected function exhibitDir(string $slug): string {
    return DRUPAL_ROOT . '/' . $this->moduleList->getPath('sacda_modules') . '/exhibits/' . $slug;
  }

}
