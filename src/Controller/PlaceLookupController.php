<?php

declare(strict_types=1);

namespace Drupal\sacda_modules\Controller;

use Drupal\Core\Controller\ControllerBase;
use Drupal\Core\Url;
use Drupal\sacda_modules\PlaceLookup\PlaceLookupService;
use Symfony\Component\DependencyInjection\ContainerInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;

/**
 * The Place Lookup tool: page shell and JSON search endpoint.
 *
 * Replaces the "Find > Places > Basic Search" step of the CA cataloguing
 * manual. An RA types a place name, candidates appear from Getty TGN and CGNDB
 * with an indication of whether the place already exists in the geo_location
 * vocabulary, and the RA copies the authority identifier for the ingest
 * spreadsheet.
 *
 * The point of copying a TGN id rather than a coined slug like "surrey_bc":
 * a slug has no external referent, so a wrong one fails silently at ingest
 * (which is why the manual has to shout NEVER GUESS). An authority id either
 * resolves against the mirror or it does not, so wrong values are detectable
 * before ingest instead of after.
 */
class PlaceLookupController extends ControllerBase {

  /**
   * Hard cap on results per request, whatever the client asks for.
   */
  protected const MAX_LIMIT = 50;

  public function __construct(
    protected PlaceLookupService $lookup,
  ) {}

  public static function create(ContainerInterface $container): static {
    return new static($container->get('sacda_modules.place_lookup'));
  }

  /**
   * Page callback: /admin/content/places/lookup.
   */
  public function page(): array {
    return [
      '#theme' => 'sacda_place_lookup',
      '#endpoint' => Url::fromRoute('sacda_modules.place_lookup_api')->toString(),
      '#can_create_terms' => $this->currentUser()->hasPermission('create place terms'),
      '#attached' => [
        'library' => ['sacda_modules/place_lookup'],
        'drupalSettings' => [
          'sacdaPlaceLookup' => [
            // Built server-side so the JS never hardcodes a path.
            'endpoint' => Url::fromRoute('sacda_modules.place_lookup_api')->toString(),
            'minLength' => PlaceLookupService::MIN_QUERY_LENGTH,
            'debounce' => 150,
            'canCreateTerms' => $this->currentUser()->hasPermission('create place terms'),
          ],
        ],
      ],
      '#cache' => [
        // Rendered markup differs by permission; results are fetched client
        // side, so the shell itself is cacheable.
        'contexts' => ['user.permissions'],
      ],
    ];
  }

  /**
   * JSON callback: /api/place-lookup?q=…
   *
   * Permissioned GET with no state change, so no CSRF token is required. If a
   * POST is ever added here (term creation under 'create place terms') it will
   * need _csrf_token: 'TRUE' on the route and a token on the request.
   */
  public function search(Request $request): JsonResponse {
    $query = trim((string) $request->query->get('q', ''));
    $limit = (int) $request->query->get('limit', 25);
    $limit = max(1, min($limit, self::MAX_LIMIT));

    try {
      $payload = $this->lookup->searchGrouped($query, $limit);
    }
    catch (\Throwable $e) {
      $this->getLogger('sacda_modules')->error('Place lookup failed for %q: @message', [
        '%q' => $query,
        '@message' => $e->getMessage(),
      ]);
      // Name what failed and what to do about it — the UI renders this string
      // verbatim rather than a generic "something went wrong".
      return new JsonResponse([
        'error' => 'The place authority index could not be queried. It may not have been imported yet — ask an administrator to run "drush sacda-place:status".',
      ], 500);
    }

    return new JsonResponse($payload);
  }

}
