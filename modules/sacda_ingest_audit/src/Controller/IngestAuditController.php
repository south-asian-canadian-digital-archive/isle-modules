<?php

declare(strict_types=1);

namespace Drupal\sacda_ingest_audit\Controller;

use Drupal\Core\Controller\ControllerBase;
use Drupal\Core\Access\CsrfTokenGenerator;
use Drupal\Core\Entity\EntityFieldManagerInterface;
use Drupal\Core\Site\Settings;
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
 *
 * The one exception is triage(): an optional AI second opinion on the
 * differences the reviewer still has open. It lives here because the API key
 * must stay on the server.
 */
class IngestAuditController extends ControllerBase {

  /**
   * Media use URI that marks the file Workbench uploaded from the CSV.
   */
  protected const ORIGINAL_FILE_USE = 'http://pcdm.org/use#OriginalFile';

  /**
   * Triage limits: differences per request, and characters per value.
   *
   * The browser sends distinct differences in chunks, so one request stays
   * well inside the proxy timeout in front of the site.
   */
  protected const TRIAGE_MAX_ITEMS = 40;
  protected const TRIAGE_MAX_CHARS = 600;
  protected const TRIAGE_MODEL = 'claude-opus-5-5';

  protected const TRIAGE_PROMPT = <<<'PROMPT'
You are helping an archivist review an ingest audit for a digital archive (Islandora / Drupal). A metadata spreadsheet was ingested by Islandora Workbench; the audit compared each spreadsheet cell with what the repository now holds and listed the differences. Each item you receive is one distinct difference in one column: the values that are in the file but not in the repository ("in_file_only"), and the values that are in the repository but not in the file ("in_repository_only"). Values both sides agree on are not shown. "rows" is how many rows share that exact difference.

Decide for each item whether the ingest lost or changed information:

- "same": both sides mean the same thing, so nothing was lost. Typical cases: a name the repository holds in its authorised form (added life dates, fuller form of the same name), a vocabulary term reconciled to its preferred label, the same date written in another notation, punctuation, case, diacritics or spacing only, a URL or code that resolves to the label on the other side.
- "problem": information in the file is not in the repository, or the repository holds something different. Typical cases: values in the file with nothing corresponding in the repository, a different person, place, subject or date, truncated or garbled text, a value that landed in the wrong field, a wrong parent, a missing file.
- "unsure": you cannot tell from the values alone. Use it freely; the archivist decides those by hand, and a wrong "same" hides a real loss.

A value that is only in the file and has nothing similar on the repository side is a "problem", however plausible the value is. Two different people who share a surname are a "problem", not "same". Do not judge whether the cataloguing itself is good; judge only whether file and repository agree.

Give a reason of at most 20 words that names the specific values, written for the archivist.
PROMPT;

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
            // NULL when no API key is configured: the app hides the feature.
            'triageEndpoint' => $this->triageKey() === '' ? NULL : Url::fromRoute('sacda_ingest_audit.triage', [], [
              'query' => ['token' => $this->csrfToken->get('admin/content/ingest-audit/triage')],
            ])->toString(),
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
   * POST {items: [...]} → an AI opinion on each distinct difference.
   *
   * Only what the browser sends leaves the site: column name, field type, the
   * audit's note and the unmatched values on each side. Nothing is read from
   * the repository here and nothing is changed; the reviewer accepts or
   * ignores each suggestion in the app.
   */
  public function triage(Request $request): JsonResponse {
    $key = $this->triageKey();
    if ($key === '') {
      return new JsonResponse(['error' => 'AI triage is not set up on this site (no API key).'], 503);
    }
    $body = json_decode((string) $request->getContent(), TRUE);
    $items = is_array($body) && is_array($body['items'] ?? NULL) ? array_values($body['items']) : [];
    if (!$items || count($items) > self::TRIAGE_MAX_ITEMS) {
      return new JsonResponse(['error' => 'Send between 1 and ' . self::TRIAGE_MAX_ITEMS . ' differences per request.'], 400);
    }

    // Number the items ourselves: the model answers by number, so a
    // client-chosen id can never be confused with content.
    $ids = [];
    $payload = [];
    foreach ($items as $i => $item) {
      $ids[$i + 1] = (string) ($item['id'] ?? $i);
      $payload[] = [
        'n' => $i + 1,
        'column' => $this->clip($item['column'] ?? ''),
        'field' => $this->clip($item['field'] ?? ''),
        'field_type' => $this->clip($item['type'] ?? ''),
        'audit_note' => $this->clip($item['note'] ?? ''),
        'in_file_only' => $this->clipAll($item['missing'] ?? []),
        'in_repository_only' => $this->clipAll($item['extra'] ?? []),
        'rows' => max(1, (int) ($item['count'] ?? 1)),
      ];
    }

    $model = (string) Settings::get('sacda_ingest_audit_triage_model', self::TRIAGE_MODEL);
    $json = [
      'model' => $model,
      'max_tokens' => 16000,
      'system' => self::TRIAGE_PROMPT,
      'messages' => [[
        'role' => 'user',
        'content' => "Differences to judge, as JSON. Answer every item once, by its \"n\".\n\n" . json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE),
      ]],
      'output_config' => [
        'effort' => 'low',
        'format' => [
          'type' => 'json_schema',
          'schema' => [
            'type' => 'object',
            'properties' => [
              'results' => [
                'type' => 'array',
                'items' => [
                  'type' => 'object',
                  'properties' => [
                    'n' => ['type' => 'integer'],
                    'verdict' => ['type' => 'string', 'enum' => ['same', 'problem', 'unsure']],
                    'reason' => ['type' => 'string'],
                  ],
                  'required' => ['n', 'verdict', 'reason'],
                  'additionalProperties' => FALSE,
                ],
              ],
            ],
            'required' => ['results'],
            'additionalProperties' => FALSE,
          ],
        ],
      ],
    ];
    $headers = ['x-api-key' => $key, 'anthropic-version' => '2023-06-01'];
    // A safety-classifier decline is retried on another model server-side.
    // Haiku has no server-side fallback and must not be sent the parameter.
    if (!str_contains($model, 'haiku')) {
      $json['fallbacks'] = 'default';
      $headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    }

    try {
      $response = $this->httpClient->request('POST', 'https://api.anthropic.com/v1/messages', [
        'headers' => $headers,
        'json' => $json,
        'timeout' => 85,
        'connect_timeout' => 10,
        'http_errors' => FALSE,
      ]);
    }
    catch (GuzzleException $e) {
      $this->getLogger('sacda_ingest_audit')->warning('AI triage request failed: @m', ['@m' => $e->getMessage()]);
      return new JsonResponse(['error' => 'The AI service could not be reached from the server.'], 502);
    }

    $status = $response->getStatusCode();
    $message = json_decode((string) $response->getBody(), TRUE);
    if ($status !== 200 || !is_array($message)) {
      $this->getLogger('sacda_ingest_audit')->warning('AI triage: HTTP @s @t', [
        '@s' => $status,
        '@t' => is_array($message) ? ($message['error']['message'] ?? '') : '',
      ]);
      // 429 and 529 are worth retrying; the app backs off on 503.
      $retry = in_array($status, [429, 500, 502, 503, 529], TRUE);
      return new JsonResponse([
        'error' => match (TRUE) {
          $status === 401, $status === 403 => 'The AI service rejected the site\'s API key.',
          $retry => 'The AI service is busy. Try again in a moment.',
          default => 'The AI service returned an error (' . $status . ').',
        },
      ], $retry ? 503 : 502);
    }
    if (($message['stop_reason'] ?? '') !== 'end_turn') {
      return new JsonResponse(['error' => 'The AI service did not finish its answer (' . ($message['stop_reason'] ?? 'unknown') . ').'], 502);
    }

    $text = '';
    foreach ($message['content'] ?? [] as $block) {
      if (($block['type'] ?? '') === 'text') {
        $text .= $block['text'];
      }
    }
    $parsed = json_decode($text, TRUE);
    $results = [];
    foreach (is_array($parsed) ? ($parsed['results'] ?? []) : [] as $r) {
      $n = (int) ($r['n'] ?? 0);
      if (isset($ids[$n]) && in_array($r['verdict'] ?? '', ['same', 'problem', 'unsure'], TRUE)) {
        $results[$ids[$n]] = ['id' => $ids[$n], 'verdict' => $r['verdict'], 'reason' => mb_substr((string) ($r['reason'] ?? ''), 0, 300)];
      }
    }
    return new JsonResponse(['model' => $message['model'] ?? $model, 'results' => array_values($results)], 200, ['Cache-Control' => 'no-store']);
  }

  /**
   * The Anthropic API key, or '' when triage is not configured.
   *
   * $settings['sacda_ingest_audit_anthropic_key'] wins; otherwise the
   * container's ANTHROPIC_API_KEY, read the way the image's settings.php
   * reads its own env (php-fpm does not pass the environment through).
   */
  protected function triageKey(): string {
    $key = (string) Settings::get('sacda_ingest_audit_anthropic_key', '');
    if ($key === '') {
      $file = '/var/run/s6/container_environment/ANTHROPIC_API_KEY';
      $key = is_readable($file) ? (string) file_get_contents($file) : (string) getenv('ANTHROPIC_API_KEY');
    }
    return trim($key);
  }

  protected function clip(mixed $value): string {
    return mb_substr(is_scalar($value) ? (string) $value : '', 0, self::TRIAGE_MAX_CHARS);
  }

  /**
   * @return string[]
   */
  protected function clipAll(mixed $values): array {
    return array_map(fn ($v) => $this->clip($v), array_slice(is_array($values) ? array_values($values) : [], 0, 50));
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
   * Media bundles that hold original files, keyed to their source field.
   *
   * Only bundles with at least one OriginalFile media are returned: each
   * bundle costs one request per chunk of rows, and derivative-only bundles
   * (extracted text, FITS) would never match.
   *
   * @return array<string, string>
   */
  protected function mediaSourceFields(): array {
    $used = $this->entityTypeManager()->getStorage('media')->getAggregateQuery()
      ->accessCheck(FALSE)
      ->condition('field_media_use.entity.field_external_uri.uri', self::ORIGINAL_FILE_USE)
      ->groupBy('bundle')
      ->execute();
    $used = array_column($used, 'bundle');

    $map = [];
    foreach ($this->entityTypeManager()->getStorage('media_type')->loadMultiple() as $id => $type) {
      $field = $type->getSource()->getSourceFieldDefinition($type);
      if ($field && in_array($field->getType(), ['file', 'image'], TRUE) && (!$used || in_array($id, $used, TRUE))) {
        $map[$id] = $field->getName();
      }
    }
    return $map;
  }

}
