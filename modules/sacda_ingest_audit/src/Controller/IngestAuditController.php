<?php

declare(strict_types=1);

namespace Drupal\sacda_ingest_audit\Controller;

use Drupal\Core\Controller\ControllerBase;
use Drupal\Core\Access\CsrfTokenGenerator;
use Drupal\Core\Entity\EntityFieldManagerInterface;
use Drupal\Core\Url;
use GuzzleHttp\ClientInterface;
use GuzzleHttp\Exception\GuzzleException;
use Symfony\Component\DependencyInjection\ContainerInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Ingest audit: page shell for the Svelte app, plus a Google Sheets fetch.
 *
 * Deliberately thin. The comparison runs in the browser against core JSON:API
 * (nodes, terms, media, files), so access control is exactly the user's normal
 * entity access. All this class adds is the field schema the app needs to
 * decide how to compare a column, which JSON:API does not expose.
 */
class IngestAuditController extends ControllerBase {

  /**
   * Media use URI that marks the file Workbench uploaded from the CSV.
   */
  protected const ORIGINAL_FILE_USE = 'http://pcdm.org/use#OriginalFile';

  public function __construct(
    protected EntityFieldManagerInterface $fieldManager,
    protected ClientInterface $httpClient,
    protected CsrfTokenGenerator $csrfToken,
  ) {}

  public static function create(ContainerInterface $container): static {
    return new static(
      $container->get('entity_field.manager'),
      $container->get('http_client'),
      $container->get('csrf_token'),
    );
  }

  /**
   * Page callback: /admin/content/ingest-audit.
   */
  public function page(): array {
    return [
      '#type' => 'html_tag',
      '#tag' => 'div',
      '#attributes' => ['id' => 'sacda-ingest-audit'],
      '#attached' => [
        'library' => ['sacda_ingest_audit/app'],
        'drupalSettings' => [
          'sacdaIngestAudit' => [
            'jsonapi' => Url::fromUri('base:/jsonapi')->toString(),
            // Token minted here, not via Url's CSRF route processor: inside a
            // drupalSettings string its placeholder is never replaced, and a
            // cached copy would carry someone else's token.
            'sheetEndpoint' => Url::fromRoute('sacda_ingest_audit.sheet', [], [
              'query' => ['token' => $this->csrfToken->get('admin/content/ingest-audit/sheet')],
            ])->toString(),
            'nodeBase' => Url::fromUri('base:/node/')->toString(),
            'bundles' => $this->nodeBundles(),
            'mediaBundles' => $this->mediaSourceFields(),
            'originalFileUse' => self::ORIGINAL_FILE_USE,
          ],
        ],
      ],
      // Per-session token above; never serve this page from cache.
      '#cache' => ['max-age' => 0],
    ];
  }

  /**
   * GET ?url=<Google Sheets link> → the sheet's CSV export.
   *
   * Only docs.google.com spreadsheet URLs are accepted, and the export URL is
   * rebuilt from the sheet key rather than passed through, so this cannot be
   * pointed at anything else.
   */
  public function sheet(Request $request): Response {
    $export = $this->sheetExportUrl((string) $request->query->get('url', ''));
    if ($export === NULL) {
      return new JsonResponse(['error' => 'That is not a Google Sheets link. Paste the URL of the sheet from your browser address bar.'], 400);
    }

    try {
      $response = $this->httpClient->request('GET', $export, [
        'timeout' => 30,
        'http_errors' => FALSE,
        'allow_redirects' => ['max' => 5, 'protocols' => ['https']],
      ]);
    }
    catch (GuzzleException $e) {
      $this->getLogger('sacda_ingest_audit')->warning('Google Sheets fetch failed: @m', ['@m' => $e->getMessage()]);
      return new JsonResponse(['error' => 'Google Sheets could not be reached from the server.'], 502);
    }

    // A private sheet answers 200 with a sign-in page (or 401/404), never CSV.
    $type = $response->getHeaderLine('Content-Type');
    if ($response->getStatusCode() !== 200 || !str_contains($type, 'text/csv')) {
      return new JsonResponse(['error' => 'Google did not return CSV. Set the sheet to "Anyone with the link can view", or download it and upload the file instead.'], 422);
    }

    return new Response((string) $response->getBody(), 200, [
      'Content-Type' => 'text/csv; charset=utf-8',
      'Cache-Control' => 'no-store',
    ]);
  }

  /**
   * Builds the CSV export URL for a Google Sheets link, or NULL.
   *
   * Handles both editor links (/spreadsheets/d/<key>/edit#gid=N) and
   * "Publish to web" links (/spreadsheets/d/e/<key>/pubhtml).
   */
  protected function sheetExportUrl(string $url): ?string {
    if (!preg_match('#^https://docs\.google\.com/spreadsheets/d/(e/)?([A-Za-z0-9_-]{20,})#', $url, $m)) {
      return NULL;
    }
    $gid = preg_match('#[?&\#]gid=(\d+)#', $url, $g) ? $g[1] : NULL;
    $base = 'https://docs.google.com/spreadsheets/d/' . $m[1] . $m[2];
    $query = $m[1] ? ['output' => 'csv'] : ['format' => 'csv'];
    if ($gid !== NULL) {
      $query['gid'] = $gid;
    }
    return $base . ($m[1] ? '/pub?' : '/export?') . http_build_query($query);
  }

  /**
   * Node bundles that carry field_identifier, with their configurable fields.
   *
   * @return array<string, array{label: string, fields: array<string, array>}>
   */
  protected function nodeBundles(): array {
    $bundles = [];
    foreach ($this->entityTypeManager()->getStorage('node_type')->loadMultiple() as $id => $type) {
      $definitions = $this->fieldManager->getFieldDefinitions('node', $id);
      if (!isset($definitions['field_identifier'])) {
        continue;
      }
      $fields = [];
      foreach ($definitions as $name => $definition) {
        if (!str_starts_with($name, 'field_') && $name !== 'title') {
          continue;
        }
        $storage = $definition->getFieldStorageDefinition();
        $settings = $definition->getSettings();
        $fields[$name] = [
          'label' => (string) $definition->getLabel(),
          'type' => $definition->getType(),
          'cardinality' => $storage->getCardinality(),
          'targetType' => $settings['target_type'] ?? NULL,
          'targetBundles' => array_values($settings['handler_settings']['target_bundles'] ?? []),
        ];
      }
      $bundles[$id] = ['label' => (string) $type->label(), 'fields' => $fields];
    }
    return $bundles;
  }

  /**
   * Media bundles whose source is a file, keyed to their source field.
   *
   * @return array<string, string>
   */
  protected function mediaSourceFields(): array {
    $map = [];
    foreach ($this->entityTypeManager()->getStorage('media_type')->loadMultiple() as $id => $type) {
      $field = $type->getSource()->getSourceFieldDefinition($type);
      if ($field && in_array($field->getType(), ['file', 'image'], TRUE)) {
        $map[$id] = $field->getName();
      }
    }
    return $map;
  }

}
