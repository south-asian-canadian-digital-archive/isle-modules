<?php

declare(strict_types=1);

namespace Drupal\sacda_ingest_audit\Controller;

use Drupal\Core\Controller\ControllerBase;
use Drupal\Core\Access\CsrfTokenGenerator;
use Drupal\Core\Entity\EntityFieldManagerInterface;
use Drupal\Core\KeyValueStore\KeyValueExpirableFactoryInterface;
use Drupal\Core\State\StateInterface;
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
 * The one exception is triage: a small queue that lets an AI agent running
 * on someone's own machine give a second opinion on the differences a
 * reviewer still has open. The browser posts the open differences, the agent
 * pulls them with a shared token and posts verdicts back, the browser shows
 * them. The site itself calls no external service.
 */
class IngestAuditController extends ControllerBase {

  /**
   * Media use URI that marks the file Workbench uploaded from the CSV.
   */
  protected const ORIGINAL_FILE_USE = 'http://pcdm.org/use#OriginalFile';

  /**
   * Triage queue: key-value collection, state key for the agent token, and
   * limits on what one request may carry.
   */
  protected const TRIAGE_STORE = 'sacda_ingest_audit_triage';
  protected const TRIAGE_TOKEN = 'sacda_ingest_audit.triage_token';
  protected const TRIAGE_MAX_ITEMS = 2000;
  // Verdicts (and unanswered items) are forgotten after this long, so a
  // difference seen again later is judged afresh, not from an old answer.
  protected const TRIAGE_TTL = 2 * 86400;
  protected const TRIAGE_MAX_CHARS = 600;
  protected const VERDICTS = ['same', 'problem', 'unsure'];

  /**
   * Agent sessions: a temporary token minted by an open audit page, valid
   * for the queue and for handing that page spreadsheets to audit.
   */
  protected const SESSION_STORE = 'sacda_ingest_audit_agent';
  protected const SESSION_TTL = 8 * 3600;
  protected const UPLOAD_MAX_BYTES = 15 * 1024 * 1024;

  /**
   * Instructions handed to the agent with every batch of work.
   */
  protected const TRIAGE_GUIDANCE = <<<'GUIDANCE'
You are helping an archivist review an ingest audit for a digital archive (Islandora / Drupal). A metadata spreadsheet was ingested by Islandora Workbench; the audit compared each spreadsheet cell with what the repository now holds and listed the differences. Each item you receive is one distinct difference in one column: the values that are in the file but not in the repository ("in_file_only"), and the values that are in the repository but not in the file ("in_repository_only"). Values both sides agree on are not shown. "rows" is how many rows share that exact difference.

Decide for each item whether the ingest lost or changed information:

- "same": both sides mean the same thing, so nothing was lost. Typical cases: a name the repository holds in its authorised form (added life dates, fuller form of the same name), a vocabulary term reconciled to its preferred label, the same date written in another notation, punctuation, case, diacritics or spacing only, a URL or code that resolves to the label on the other side.
- "problem": information in the file is not in the repository, or the repository holds something different. Typical cases: values in the file with nothing corresponding in the repository, a different person, place, subject or date, truncated or garbled text, a value that landed in the wrong field, a wrong parent, a missing file.
- "unsure": you cannot tell from the values alone. Use it freely; the archivist decides those by hand, and a wrong "same" hides a real loss.

A value that is only in the file and has nothing similar on the repository side is a "problem", however plausible the value is. Two different people who share a surname are a "problem", not "same". Do not judge whether the cataloguing itself is good; judge only whether file and repository agree.

Give a reason of at most 20 words that names the specific values, written for the archivist.

Answer by POSTing {"token": ..., "results": [{"key": ..., "verdict": "same"|"problem"|"unsure", "reason": ...}]} to the same URL.
GUIDANCE;

  public function __construct(
    protected EntityFieldManagerInterface $fieldManager,
    protected ClientInterface $httpClient,
    protected CsrfTokenGenerator $csrfToken,
    protected StateInterface $triageState,
    protected KeyValueExpirableFactoryInterface $agentSessions,
  ) {}

  public static function create(ContainerInterface $container): static {
    return new static(
      $container->get('entity_field.manager'),
      $container->get('http_client'),
      $container->get('csrf_token'),
      $container->get('state'),
      $container->get('keyvalue.expirable'),
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
            'sessionEndpoint' => Url::fromRoute('sacda_ingest_audit.agent_session', [], [
              'query' => ['token' => $this->csrfToken->get('admin/content/ingest-audit/agent-session')],
            ])->toString(),
            'queueUrl' => Url::fromRoute('sacda_ingest_audit.triage_queue', [], ['absolute' => TRUE])->toString(),
            'triageEndpoint' => Url::fromRoute('sacda_ingest_audit.triage', [], [
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
   * Browser side. POST {items: [...]} queues open differences for the agent;
   * POST {ids: [...]} only asks. Either way the answer is the verdicts known
   * so far for those ids, plus how many are still waiting.
   *
   * Verdicts are shared: a difference another reviewer had judged in the
   * last two days is answered at once; older answers have expired.
   */
  public function triage(Request $request): JsonResponse {
    $body = json_decode((string) $request->getContent(), TRUE);
    $items = is_array($body['items'] ?? NULL) ? array_values($body['items']) : [];
    $ids = is_array($body['ids'] ?? NULL) ? array_values($body['ids']) : array_map(fn ($i) => $i['id'] ?? NULL, $items);
    $ids = array_values(array_filter($ids, 'is_string'));
    if (!$ids || count($ids) > self::TRIAGE_MAX_ITEMS) {
      return new JsonResponse(['error' => 'Send between 1 and ' . self::TRIAGE_MAX_ITEMS . ' differences per request.'], 400);
    }

    $store = $this->agentSessions->get(self::TRIAGE_STORE);
    $keys = array_combine($ids, array_map(fn ($id) => hash('sha256', $id), $ids));
    $known = $store->getMultiple(array_values($keys));
    $new = [];
    foreach ($items as $item) {
      $id = $item['id'] ?? NULL;
      if (!is_string($id) || isset($known[$keys[$id]])) {
        continue;
      }
      $new[$keys[$id]] = [
        'id' => $id,
        'column' => $this->clip($item['column'] ?? ''),
        'field' => $this->clip($item['field'] ?? ''),
        'field_type' => $this->clip($item['type'] ?? ''),
        'audit_note' => $this->clip($item['note'] ?? ''),
        'in_file_only' => $this->clipAll($item['missing'] ?? []),
        'in_repository_only' => $this->clipAll($item['extra'] ?? []),
        'rows' => max(1, (int) ($item['count'] ?? 1)),
        'queued' => time(),
      ];
    }
    if ($new) {
      $store->setMultipleWithExpire($new, self::TRIAGE_TTL);
      $known += $new;
    }

    $results = [];
    $pending = 0;
    foreach ($keys as $id => $key) {
      $entry = $known[$key] ?? NULL;
      if (isset($entry['verdict'])) {
        $results[] = ['id' => $id, 'verdict' => $entry['verdict'], 'reason' => $entry['reason']];
      }
      elseif ($entry) {
        $pending++;
      }
    }
    return new JsonResponse(['results' => $results, 'pending' => $pending], 200, ['Cache-Control' => 'no-store']);
  }

  /**
   * Agent side. Everything goes in a POST JSON body, because the load
   * balancer in front of production strips custom headers:
   *
   * {"token": "...", "limit": 100} → {instructions, waiting, items: [{key,
   * column, ..., in_file_only, in_repository_only, rows}]}, the differences
   * still waiting.
   * {"token": "...", "results": [{key, verdict, reason}]} → stores verdicts.
   *
   * The X-Triage-Token header (and a GET) still work where headers survive.
   */
  public function queue(Request $request): JsonResponse {
    $body = $request->isMethod('POST') ? json_decode((string) $request->getContent(), TRUE) : NULL;
    $body = is_array($body) ? $body : [];
    $given = trim((string) ($request->headers->get('X-Triage-Token') ?: (is_string($body['token'] ?? NULL) ? $body['token'] : '')));
    $sessions = $this->agentSessions->get(self::SESSION_STORE);
    $sessionKey = $given === '' ? '' : hash('sha256', $given);
    $session = $sessionKey === '' ? NULL : $sessions->get($sessionKey);
    $site = $this->agentToken();
    if (!$session && ($site === '' || $given === '' || !hash_equals($site, $given))) {
      return new JsonResponse(['error' => 'Missing, wrong or expired token. Send it as "token" in the JSON body; session tokens end when the reviewer ends the session or after 8 hours.'], 403);
    }
    $store = $this->agentSessions->get(self::TRIAGE_STORE);
    $action = is_string($body['action'] ?? NULL) ? $body['action'] : '';

    // Session-only actions: hand the open page a spreadsheet, and read back
    // what the page is doing with it.
    if ($action === 'upload' || $action === 'status') {
      if (!$session) {
        return new JsonResponse(['error' => 'Uploads need a session token from an open audit page.'], 403);
      }
      if ($action === 'status') {
        return new JsonResponse([
          'page_seen' => $session['seen'] ?? NULL,
          'page_online' => isset($session['seen']) && time() - $session['seen'] < 30,
          'inbox' => array_map(fn ($f) => $f['name'], $session['inbox'] ?? []),
          'status' => $session['status'] ?? NULL,
        ], 200, ['Cache-Control' => 'no-store']);
      }
      $name = is_string($body['name'] ?? NULL) ? basename($body['name']) : '';
      $data = is_string($body['content_base64'] ?? NULL) ? base64_decode($body['content_base64'], TRUE) : FALSE;
      if ($name === '' || $data === FALSE || $data === '') {
        return new JsonResponse(['error' => 'Send "name" and "content_base64" (the file, base64-encoded).'], 400);
      }
      if (strlen($data) > self::UPLOAD_MAX_BYTES) {
        return new JsonResponse(['error' => 'File too large (15 MB max).'], 413);
      }
      $session['inbox'][] = [
        'name' => $name,
        'content_base64' => base64_encode($data),
        'options' => array_intersect_key(is_array($body['options'] ?? NULL) ? $body['options'] : [], array_flip(['mapping', 'delimiter', 'sheet', 'header_row', 'triage'])),
      ];
      $sessions->setWithExpire($sessionKey, $session, self::SESSION_TTL);
      return new JsonResponse(['queued_for_page' => $name, 'inbox' => count($session['inbox'])], 200, ['Cache-Control' => 'no-store']);
    }

    if (isset($body['results'])) {
      $saved = 0;
      $rejected = [];
      foreach (is_array($body['results']) ? $body['results'] : [] as $r) {
        $key = is_string($r['key'] ?? NULL) ? $r['key'] : '';
        $entry = $key !== '' ? $store->get($key) : NULL;
        if (!$entry || !in_array($r['verdict'] ?? '', self::VERDICTS, TRUE)) {
          $rejected[] = $key;
          continue;
        }
        $entry['verdict'] = $r['verdict'];
        $entry['reason'] = mb_substr(is_string($r['reason'] ?? NULL) ? $r['reason'] : '', 0, 300);
        $entry['answered'] = time();
        $store->setWithExpire($key, $entry, self::TRIAGE_TTL);
        $saved++;
      }
      return new JsonResponse(['saved' => $saved, 'rejected' => $rejected], 200, ['Cache-Control' => 'no-store']);
    }

    $limit = max(1, min(500, (int) ($body['limit'] ?? $request->query->get('limit', 100))));
    $items = [];
    $waiting = 0;
    foreach ($store->getAll() as $key => $entry) {
      if (isset($entry['verdict'])) {
        continue;
      }
      $waiting++;
      if (count($items) < $limit) {
        $item = ['key' => $key] + $entry;
        unset($item['id'], $item['queued']);
        $items[] = $item;
      }
    }
    return new JsonResponse([
      'instructions' => self::TRIAGE_GUIDANCE,
      'waiting' => $waiting,
      'items' => $items,
    ], 200, ['Cache-Control' => 'no-store']);
  }

  /**
   * Browser side of agent sessions (CSRF-protected, the reviewer's own login).
   *
   * {"action":"start"} → {token, expires}: a new temporary token for an agent.
   * {"action":"poll", "session":"<token>", "status":{...}} → {files: [...]}
   *   records what the page is doing (for the agent's "status") and hands
   *   over any spreadsheets the agent uploaded, emptying the inbox.
   * {"action":"stop", "session":"<token>"} → ends the session.
   */
  public function agentSession(Request $request): JsonResponse {
    $body = json_decode((string) $request->getContent(), TRUE);
    $body = is_array($body) ? $body : [];
    $sessions = $this->agentSessions->get(self::SESSION_STORE);
    $action = $body['action'] ?? '';

    if ($action === 'start') {
      $token = 'ia-' . bin2hex(random_bytes(16));
      $sessions->setWithExpire(hash('sha256', $token), [
        'uid' => (int) $this->currentUser()->id(),
        'created' => time(),
        'seen' => time(),
        'inbox' => [],
        'status' => NULL,
      ], self::SESSION_TTL);
      return new JsonResponse(['token' => $token, 'expires' => time() + self::SESSION_TTL], 200, ['Cache-Control' => 'no-store']);
    }

    $key = hash('sha256', is_string($body['session'] ?? NULL) ? $body['session'] : '');
    $session = $sessions->get($key);
    if (!$session || $session['uid'] !== (int) $this->currentUser()->id()) {
      return new JsonResponse(['error' => 'This agent session has ended.', 'ended' => TRUE], 404);
    }
    if ($action === 'stop') {
      $sessions->delete($key);
      return new JsonResponse(['ended' => TRUE], 200, ['Cache-Control' => 'no-store']);
    }
    $files = $session['inbox'] ?? [];
    $session['inbox'] = [];
    $session['seen'] = time();
    if (is_array($body['status'] ?? NULL)) {
      $session['status'] = $body['status'] + ['at' => time()];
    }
    $sessions->setWithExpire($key, $session, self::SESSION_TTL);
    return new JsonResponse(['files' => $files], 200, ['Cache-Control' => 'no-store']);
  }

  /**
   * The optional permanent site token, or ''. Session tokens from an open
   * page are the normal way in; this is for unattended agents.
   *
   * Set with: drush sset sacda_ingest_audit.triage_token <something>
   */
  protected function agentToken(): string {
    return trim((string) $this->triageState->get(self::TRIAGE_TOKEN, ''));
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
