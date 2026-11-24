import { z } from 'zod';
import {
  ListingSchema,
  type ConditionTier,
  type Listing,
  type MarketplaceId,
  type SortOrder,
  type ShippingType,
  type TranslationStatus,
  type UnifiedFilter,
} from '../../shared/index.ts';
import type { BrowserPageHandle, BrowserSessionManager } from '../browser-session-manager.ts';
import { applyPostFilters } from './post-filter.ts';
import { createTimeoutRace, isTimeoutError } from './utils.ts';
import type {
  AdapterBatchResult,
  AdapterExecutionContext,
  AdapterLoadMoreParams,
  AdapterSearchParams,
  AdapterTranslationResult,
  ClockFn,
  MarketplaceAdapter,
} from './types.ts';

export const POSHMARK_PAGE_COUNT = 48;
export const POSHMARK_TIMEOUT_MS = 20_000;
export const POSHMARK_FLAT_SHIPPING_USD = 6.49;

const POSHMARK_CONDITION_MAP: Record<ConditionTier, string> = {
  new: 'nwt',
  like_new: 'uln',
  good: 'ug',
  fair: 'uf',
  poor: 'uf',
};

const POSHMARK_SORT_MAP: Record<
  SortOrder,
  'relevance_v2' | 'added_desc' | 'price_asc' | 'price_desc'
> = {
  relevance: 'relevance_v2',
  newest: 'added_desc',
  price_asc: 'price_asc',
  price_desc: 'price_desc',
};

const PoshmarkPostNodeSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1),
  price_amount: z
    .object({
      val: z.union([z.string(), z.number()]),
      currency_code: z.string().optional(),
    })
    .optional(),
  price: z.union([z.string(), z.number()]).optional(),
  inventory: z
    .object({
      status: z.string().optional(),
    })
    .nullable()
    .optional(),
  shipping_discount_type: z.string().nullable().optional(),
  first_published_at: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
  cover_shot: z
    .object({
      url_small: z.string().url().nullable().optional(),
      url: z.string().url().nullable().optional(),
      url_large: z.string().url().nullable().optional(),
    })
    .nullable()
    .optional(),
  picture_url: z.string().url().nullable().optional(),
  condition: z.string().nullable().optional(),
  // Seller / creator PII fields intentionally omitted
});

const PoshmarkEnvelopeSchema = z.object({
  data: z.array(z.unknown()),
  more: z
    .object({
      next_max_id: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});

export interface PoshmarkPriceAmount {
  val: string;
  currency_code: 'USD';
}

export interface PoshmarkVmRestRequest {
  filters: {
    department: 'All';
    inventory_status: ['available'];
    condition?: string[];
    price_amount_range?: Array<{ min?: PoshmarkPriceAmount; max?: PoshmarkPriceAmount }>;
  };
  query: string;
  sort_by: 'relevance_v2' | 'added_desc' | 'price_asc' | 'price_desc';
  count: number;
  experience: 'all';
  max_id?: string;
}

export interface PoshmarkNativeQuery {
  searchUrl: string;
  vmRestRequest: PoshmarkVmRestRequest;
  sortOrder: SortOrder;
}

export interface PoshmarkCursor {
  nextMaxId: string;
  nativeQuery: PoshmarkNativeQuery;
  rankOffset: number;
}

export interface PoshmarkAdapterOptions {
  browserSessionManager: BrowserSessionManager;
  timeoutMs?: number;
  clock?: ClockFn;
}

interface InPageFetchArg {
  endpointUrl: string;
  timeoutMs: number;
}

interface InPageFetchResult {
  status: number;
  ok: boolean;
  contentType: string;
  body: unknown;
  isChallengeDom: boolean;
  timedOut?: boolean;
  networkError?: string;
}

function buildConditionCodes(conditions: readonly ConditionTier[]): {
  codes: string[];
  broadenedPoor: boolean;
} {
  const seen = new Set<string>();
  const codes: string[] = [];
  let broadenedPoor = false;

  for (const tier of conditions) {
    if (tier === 'poor') {
      broadenedPoor = true;
    }
    const mapped = POSHMARK_CONDITION_MAP[tier];
    if (!seen.has(mapped)) {
      seen.add(mapped);
      codes.push(mapped);
    }
  }
  return { codes, broadenedPoor };
}

export function buildPoshmarkNativeSearchUrl(
  keywords: string,
  unifiedFilters: UnifiedFilter,
  sortOrder: SortOrder,
  conditionCodes?: string[],
): string {
  const url = new URL('https://poshmark.com/search');
  url.searchParams.set('query', keywords.trim());
  url.searchParams.set('availability', 'available');

  if (unifiedFilters.priceMin != null || unifiedFilters.priceMax != null) {
    const min = unifiedFilters.priceMin != null ? Math.floor(unifiedFilters.priceMin) : '';
    const max = unifiedFilters.priceMax != null ? Math.ceil(unifiedFilters.priceMax) : '';
    url.searchParams.append('price[]', `${min}-${max}`);
  }

  const codes = conditionCodes ?? buildConditionCodes(unifiedFilters.conditions).codes;
  for (const code of codes) {
    url.searchParams.append('condition', code);
  }

  url.searchParams.set('sort_by', POSHMARK_SORT_MAP[sortOrder]);
  return url.toString();
}

function buildVmRestEndpointUrl(requestPayload: PoshmarkVmRestRequest): string {
  const params = new URLSearchParams({
    request: JSON.stringify(requestPayload),
    nm: 'search_all',
    experience: 'all',
  });
  return `/vm-rest/posts?${params.toString()}`;
}

function mapPoshmarkShipping(
  discountType: string | null | undefined,
): { shippingPrice: number | null; shippingType: ShippingType } {
  if (discountType === 'free') {
    return { shippingPrice: 0, shippingType: 'free' };
  }
  if (discountType == null) {
    return { shippingPrice: POSHMARK_FLAT_SHIPPING_USD, shippingType: 'known' };
  }
  return { shippingPrice: null, shippingType: 'buyer_paid_unknown' };
}

function normalizePoshmarkNode(
  rawNode: unknown,
  adapterRank: number,
): { parsedValid: boolean; listing: Listing | null } {
  const parsed = PoshmarkPostNodeSchema.safeParse(rawNode);
  if (!parsed.success) {
    return { parsedValid: false, listing: null };
  }
  const node = parsed.data;
  const rawPrice = node.price_amount?.val ?? node.price;
  if (rawPrice == null) {
    return { parsedValid: false, listing: null };
  }
  const price = Number(rawPrice);
  if (!Number.isFinite(price) || price < 0) {
    return { parsedValid: false, listing: null };
  }

  // Active guard: strictly inventory.status === 'available'
  if (node.inventory?.status !== 'available') {
    return { parsedValid: true, listing: null };
  }

  const { shippingPrice, shippingType } = mapPoshmarkShipping(node.shipping_discount_type);
  const thumbnailUrl =
    node.cover_shot?.url_small ?? node.cover_shot?.url ?? node.picture_url ?? null;

  const candidate: Listing = {
    marketplace: 'poshmark',
    marketplaceListingId: node.id,
    url: `https://poshmark.com/listing/${encodeURIComponent(node.id)}`,
    title: node.title,
    price,
    shippingPrice,
    shippingType,
    listingFormat: 'fixed_price',
    bidCount: null,
    buyNowPrice: null,
    thumbnailUrl,
    conditionLabel: node.condition ?? null,
    locationLabel: null,
    listedAt: node.first_published_at ?? node.created_at ?? null,
    adapterRank,
  };

  const validated = ListingSchema.safeParse(candidate);
  if (!validated.success) {
    return { parsedValid: false, listing: null };
  }
  return { parsedValid: true, listing: validated.data };
}

function isChallengeText(url: string, title: string, html?: string): boolean {
  const lowerUrl = url.toLowerCase();
  if (
    lowerUrl.includes('/login') ||
    lowerUrl.includes('/captcha') ||
    lowerUrl.includes('/challenge')
  ) {
    return true;
  }
  const lowerTitle = title.toLowerCase();
  if (
    lowerTitle.includes('access denied') ||
    lowerTitle.includes('just a moment') ||
    lowerTitle.includes('security check') ||
    lowerTitle.includes('captcha')
  ) {
    return true;
  }
  if (html) {
    const lowerHtml = html.toLowerCase();
    if (
      lowerHtml.includes('px-captcha') ||
      lowerHtml.includes('cf-turnstile') ||
      lowerHtml.includes('g-recaptcha') ||
      lowerHtml.includes('h-captcha') ||
      lowerHtml.includes('cequence') ||
      lowerHtml.includes('verify you are human')
    ) {
      return true;
    }
  }
  return false;
}

async function runInPageVmRestFetch(
  page: BrowserPageHandle,
  endpointUrl: string,
  timeoutMs: number,
): Promise<InPageFetchResult> {
  return page.evaluate<InPageFetchResult, InPageFetchArg>(
    async ({ endpointUrl: targetUrl, timeoutMs: ms }) => {
      const hasCaptchaDom = Boolean(
        document.querySelector(
          'iframe[src*="captcha"], #px-captcha, .cf-turnstile, .g-recaptcha, .h-captcha, [data-cequence]',
        ),
      );
      if (hasCaptchaDom) {
        return {
          status: 403,
          ok: false,
          contentType: 'text/html',
          body: null,
          isChallengeDom: true,
        };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ms);
      try {
        const res = await fetch(targetUrl, {
          method: 'GET',
          credentials: 'same-origin',
          headers: {
            Accept: 'application/json, text/plain, */*',
            'X-Requested-With': 'XMLHttpRequest',
          },
          signal: controller.signal,
        });
        const contentType = res.headers.get('content-type') ?? '';
        let body: unknown = null;
        if (contentType.includes('application/json') || res.ok) {
          body = await res.json().catch(() => null);
        }
        return {
          status: res.status,
          ok: res.ok,
          contentType,
          body,
          isChallengeDom: false,
        };
      } catch (err) {
        const isAbort = err instanceof Error && err.name === 'AbortError';
        return {
          status: 0,
          ok: false,
          contentType: '',
          body: null,
          isChallengeDom: false,
          timedOut: isAbort,
          networkError: err instanceof Error ? err.message : 'Network error',
        };
      } finally {
        clearTimeout(timer);
      }
    },
    { endpointUrl, timeoutMs },
  );
}

async function tryInPageSortFallback(
  page: BrowserPageHandle,
  sortOrder: SortOrder,
  timeoutMs: number,
): Promise<{ status: number; body: unknown } | null> {
  if (!page.waitForResponse || !page.click) {
    return null;
  }

  const sortCode = POSHMARK_SORT_MAP[sortOrder];
  const responsePromise = page.waitForResponse(
    (res) => res.url().includes('/vm-rest/posts'),
    { timeout: Math.min(timeoutMs, 5_000) },
  );

  try {
    await page.click(`[data-test="sort-by"], [data-et-name="sort_by"], [data-value="${sortCode}"]`, {
      timeout: Math.min(timeoutMs, 2_500),
    });
    const res = await responsePromise;
    const status = res.status();
    if (status === 403 || status === 401) {
      return { status, body: null };
    }
    const body = await res.json().catch(() => null);
    return { status, body };
  } catch {
    await responsePromise.catch(() => undefined);
    return null;
  }
}

function normalizePoshmarkEnvelope(
  rawBody: unknown,
  nativeQuery: PoshmarkNativeQuery,
  unifiedFilters: UnifiedFilter,
  rankOffset: number,
): AdapterBatchResult {
  const envelope = PoshmarkEnvelopeSchema.safeParse(rawBody);
  if (!envelope.success) {
    return {
      runStatus: 'parse_error',
      listings: [],
      droppedMalformedCount: 0,
      hasMore: false,
      errorMessage: 'Unrecognized Poshmark /vm-rest/posts response envelope.',
    };
  }

  const rawItems = envelope.data.data;
  const activeListings: Listing[] = [];
  let validParsedCount = 0;
  let droppedMalformedCount = 0;

  rawItems.forEach((node, index) => {
    const { parsedValid, listing } = normalizePoshmarkNode(node, rankOffset + index + 1);
    if (!parsedValid) {
      droppedMalformedCount += 1;
      return;
    }
    validParsedCount += 1;
    if (listing) {
      activeListings.push(listing);
    }
  });

  if (rawItems.length > 0 && validParsedCount === 0) {
    return {
      runStatus: 'parse_error',
      listings: [],
      droppedMalformedCount,
      hasMore: false,
      errorMessage: `All ${rawItems.length} Poshmark nodes failed normalization.`,
    };
  }

  const filtered = applyPostFilters(activeListings, unifiedFilters);
  const nextMaxId = envelope.data.more?.next_max_id ?? null;
  const hasMore = Boolean(nextMaxId && nextMaxId.trim().length > 0);

  return {
    runStatus: filtered.length > 0 ? 'success' : 'empty',
    listings: filtered,
    droppedMalformedCount,
    hasMore,
    nextCursor: hasMore
      ? ({
          nextMaxId: nextMaxId!,
          nativeQuery,
          rankOffset: rankOffset + rawItems.length,
        } satisfies PoshmarkCursor)
      : undefined,
  };
}

/**
 * Unauthenticated guest Poshmark adapter backed by BrowserSessionManager + same-origin /vm-rest/posts.
 */
export class PoshmarkAdapter implements MarketplaceAdapter {
  readonly id: MarketplaceId = 'poshmark';
  private readonly browserSessionManager: BrowserSessionManager;
  private readonly timeoutMs: number;
  private readonly clock: ClockFn;

  constructor(options: PoshmarkAdapterOptions) {
    this.browserSessionManager = options.browserSessionManager;
    this.timeoutMs = options.timeoutMs ?? POSHMARK_TIMEOUT_MS;
    this.clock = options.clock ?? (() => Date.now());
  }

  translateFilters(
    keywords: string,
    unifiedFilters: UnifiedFilter,
    sortOrder: SortOrder,
    _context: AdapterExecutionContext,
  ): AdapterTranslationResult {
    const trimmedKeywords = keywords.trim();
    const { codes, broadenedPoor } = buildConditionCodes(unifiedFilters.conditions);
    const nativeSearchUrl = buildPoshmarkNativeSearchUrl(
      trimmedKeywords,
      unifiedFilters,
      sortOrder,
      codes,
    );

    if (unifiedFilters.fulfillment === 'local_pickup') {
      return {
        marketplace: 'poshmark',
        status: 'skipped_unsupported',
        notices: ['Poshmark does not support local pickup filtering.'],
        nativeSearchUrl,
      };
    }

    const notices: string[] = [];
    let status: TranslationStatus = 'exact';
    if (broadenedPoor) {
      status = 'broadened';
      notices.push('Poshmark has no Poor tier; mapped Poor to Fair (uf).');
    }

    const priceRange: { min?: PoshmarkPriceAmount; max?: PoshmarkPriceAmount } = {};
    if (unifiedFilters.priceMin != null) {
      priceRange.min = { val: String(unifiedFilters.priceMin), currency_code: 'USD' };
    }
    if (unifiedFilters.priceMax != null) {
      priceRange.max = { val: String(unifiedFilters.priceMax), currency_code: 'USD' };
    }

    const vmRestRequest: PoshmarkVmRestRequest = {
      filters: {
        department: 'All',
        inventory_status: ['available'],
        ...(codes.length > 0 ? { condition: codes } : {}),
        ...(priceRange.min !== undefined || priceRange.max !== undefined
          ? { price_amount_range: [priceRange] }
          : {}),
      },
      query: trimmedKeywords,
      sort_by: POSHMARK_SORT_MAP[sortOrder],
      count: POSHMARK_PAGE_COUNT,
      experience: 'all',
    };

    const nativeQuery: PoshmarkNativeQuery = {
      searchUrl: nativeSearchUrl,
      vmRestRequest,
      sortOrder,
    };

    return {
      marketplace: 'poshmark',
      status,
      notices,
      nativeSearchUrl,
      nativeQuery,
    };
  }

  private async executeQuery(
    nativeQuery: PoshmarkNativeQuery,
    requestPayload: PoshmarkVmRestRequest,
    unifiedFilters: UnifiedFilter,
    rankOffset: number,
    requireNavigation: boolean,
    context: AdapterExecutionContext,
  ): Promise<AdapterBatchResult> {
    const deadlineMs = this.clock() + this.timeoutMs;
    const remainingMs = () => Math.max(1, deadlineMs - this.clock());

    try {
      return await createTimeoutRace(
        this.browserSessionManager.runInBackgroundPage(
          'poshmark',
          async (page) => {
            const currentUrl = page.url();
            const needsNavigation =
              requireNavigation ||
              (!currentUrl.startsWith('https://poshmark.com/') &&
                !currentUrl.startsWith('https://www.poshmark.com/'));

            if (needsNavigation) {
              const navResponse = await page.goto(nativeQuery.searchUrl, {
                waitUntil: 'domcontentloaded',
                timeout: remainingMs(),
              });

              const navStatus = navResponse?.status();
              if (navStatus === 403 || navStatus === 401) {
                return {
                  runStatus: 'challenge_or_auth_required',
                  listings: [],
                  droppedMalformedCount: 0,
                  hasMore: false,
                  errorMessage: `Poshmark returned HTTP ${navStatus} on /search.`,
                };
              }

              const title = await page.title().catch(() => '');
              const html = await page.content().catch(() => '');
              if (isChallengeText(page.url(), title, html)) {
                return {
                  runStatus: 'challenge_or_auth_required',
                  listings: [],
                  droppedMalformedCount: 0,
                  hasMore: false,
                  errorMessage: 'Poshmark presented a CAPTCHA or login challenge.',
                };
              }
            }

            const endpointUrl = buildVmRestEndpointUrl(requestPayload);
            const fetchResult = await runInPageVmRestFetch(page, endpointUrl, remainingMs());

            if (fetchResult.isChallengeDom || fetchResult.status === 403 || fetchResult.status === 401) {
              return {
                runStatus: 'challenge_or_auth_required',
                listings: [],
                droppedMalformedCount: 0,
                hasMore: false,
                errorMessage:
                  fetchResult.status === 403 || fetchResult.status === 401
                    ? `Poshmark blocked request with HTTP ${fetchResult.status}.`
                    : 'Poshmark presented a CAPTCHA or security challenge.',
              };
            }

            if (fetchResult.timedOut) {
              return {
                runStatus: 'timeout',
                listings: [],
                droppedMalformedCount: 0,
                hasMore: false,
                errorMessage: `Poshmark request timed out after ${this.timeoutMs}ms.`,
              };
            }

            if (fetchResult.networkError) {
              return {
                runStatus: 'network_error',
                listings: [],
                droppedMalformedCount: 0,
                hasMore: false,
                errorMessage: fetchResult.networkError,
              };
            }

            let rawPayload = fetchResult.body;
            if (!fetchResult.ok) {
              // Facet fallback: when direct /vm-rest/posts rejects facets (e.g. 400/422), try in-page sort/filter interaction
              if (fetchResult.status === 400 || fetchResult.status === 422) {
                const fallback = await tryInPageSortFallback(
                  page,
                  nativeQuery.sortOrder,
                  remainingMs(),
                );
                if (fallback) {
                  if (fallback.status === 403 || fallback.status === 401) {
                    return {
                      runStatus: 'challenge_or_auth_required',
                      listings: [],
                      droppedMalformedCount: 0,
                      hasMore: false,
                      errorMessage: `Poshmark blocked fallback request with HTTP ${fallback.status}.`,
                    };
                  }
                  if (fallback.status >= 200 && fallback.status < 300) {
                    rawPayload = fallback.body;
                  } else {
                    return {
                      runStatus: 'parse_error',
                      listings: [],
                      droppedMalformedCount: 0,
                      hasMore: false,
                      errorMessage: `Poshmark /vm-rest/posts returned HTTP ${fallback.status}.`,
                    };
                  }
                } else {
                  return {
                    runStatus: 'parse_error',
                    listings: [],
                    droppedMalformedCount: 0,
                    hasMore: false,
                    errorMessage: `Poshmark /vm-rest/posts returned HTTP ${fetchResult.status}.`,
                  };
                }
              } else {
                return {
                  runStatus: 'network_error',
                  listings: [],
                  droppedMalformedCount: 0,
                  hasMore: false,
                  errorMessage: `Poshmark /vm-rest/posts returned HTTP ${fetchResult.status}.`,
                };
              }
            }

            return normalizePoshmarkEnvelope(rawPayload, nativeQuery, unifiedFilters, rankOffset);
          },
          { signal: context.signal },
        ),
        this.timeoutMs,
        context.signal,
        'Poshmark',
      );
    } catch (err) {
      if (context.signal?.aborted) {
        return {
          runStatus: 'network_error',
          listings: [],
          droppedMalformedCount: 0,
          hasMore: false,
          errorMessage: 'Search cancelled.',
        };
      }
      if (isTimeoutError(err)) {
        return {
          runStatus: 'timeout',
          listings: [],
          droppedMalformedCount: 0,
          hasMore: false,
          errorMessage: err instanceof Error ? err.message : 'Poshmark search timed out.',
        };
      }
      return {
        runStatus: 'network_error',
        listings: [],
        droppedMalformedCount: 0,
        hasMore: false,
        errorMessage: err instanceof Error ? err.message : 'Poshmark browser error.',
      };
    }
  }

  async executeInitial(params: AdapterSearchParams): Promise<AdapterBatchResult> {
    if (params.translation.status === 'skipped_unsupported') {
      return {
        runStatus: 'skipped_unsupported',
        listings: [],
        droppedMalformedCount: 0,
        hasMore: false,
      };
    }

    const nativeQuery = params.translation.nativeQuery as PoshmarkNativeQuery | undefined;
    if (!nativeQuery) {
      return {
        runStatus: 'parse_error',
        listings: [],
        droppedMalformedCount: 0,
        hasMore: false,
        errorMessage: 'Missing Poshmark native query.',
      };
    }

    return this.executeQuery(
      nativeQuery,
      nativeQuery.vmRestRequest,
      params.unifiedFilters,
      0,
      true,
      params.context,
    );
  }

  async loadMore(params: AdapterLoadMoreParams): Promise<AdapterBatchResult> {
    const cursor = params.cursor as PoshmarkCursor | undefined;
    if (!cursor) {
      return {
        runStatus: 'empty',
        listings: [],
        droppedMalformedCount: 0,
        hasMore: false,
      };
    }

    const nextRequest: PoshmarkVmRestRequest = {
      ...cursor.nativeQuery.vmRestRequest,
      max_id: cursor.nextMaxId,
    };

    return this.executeQuery(
      cursor.nativeQuery,
      nextRequest,
      params.unifiedFilters,
      cursor.rankOffset,
      false,
      params.context,
    );
  }
}

export function createPoshmarkAdapter(options: PoshmarkAdapterOptions): PoshmarkAdapter {
  return new PoshmarkAdapter(options);
}
