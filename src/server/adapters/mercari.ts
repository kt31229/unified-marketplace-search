import { z } from 'zod';
import {
  ListingSchema,
  type ConditionTier,
  type Listing,
  type MarketplaceId,
  type SortOrder,
  type UnifiedFilter,
} from '../../shared/index.ts';
import type {
  BrowserPageHandle,
  BrowserResponseHandle,
  BrowserSessionManager,
} from '../browser-session-manager.ts';
import { applyPostFilters } from './post-filter.ts';
import { createTimeoutRace, formatErrorWithUpstreamDetail, isTimeoutError } from './utils.ts';
import type {
  AdapterBatchResult,
  AdapterExecutionContext,
  AdapterLoadMoreParams,
  AdapterSearchParams,
  AdapterTranslationResult,
  ClockFn,
  MarketplaceAdapter,
} from './types.ts';

export const MERCARI_BATCH_SIZE = 100;
export const MERCARI_TIMEOUT_MS = 20_000;

const MERCARI_CONDITION_MAP: Record<ConditionTier, string> = {
  new: '1',
  like_new: '2',
  good: '3',
  fair: '4',
  poor: '5',
};

const MERCARI_SORT_MAP: Record<SortOrder, '1' | '2' | '3' | '4'> = {
  relevance: '1',
  newest: '2',
  price_asc: '3',
  price_desc: '4',
};

const MercariPhotoSchema = z.object({
  thumbnail: z.string().nullable().optional(),
  imageUrl: z.string().nullable().optional(),
});

const MercariItemNodeSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1),
  price: z.union([z.number(), z.string()]),
  status: z.string().optional(),
  created: z.union([z.number(), z.string()]).nullable().optional(),
  photos: z.array(MercariPhotoSchema).nullable().optional(),
  thumbnails: z.array(z.string()).nullable().optional(),
  itemCondition: z
    .object({
      id: z.union([z.number(), z.string()]).optional(),
      name: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  // shippingPayer, shippingClass, and seller PII intentionally omitted
});

const MercariEnvelopeSchema = z.object({
  data: z.object({
    search: z.object({
      itemsList: z.array(z.unknown()),
      nextKey: z.union([z.string(), z.number()]).nullable().optional(),
      searchId: z.string().nullable().optional(),
      initRequestTime: z.union([z.number(), z.string()]).nullable().optional(),
      offset: z.number().nullable().optional(),
    }),
  }),
});

export interface MercariNativeQuery {
  searchUrl: string;
  sortOrder: SortOrder;
}

export interface MercariCursor {
  nextKey: string;
  searchId: string | null;
  initRequestTime: number | string | null;
  offset: number | null;
  nativeQuery: MercariNativeQuery;
  rankOffset: number;
}

export interface MercariAdapterOptions {
  browserSessionManager: BrowserSessionManager;
  timeoutMs?: number;
  clock?: ClockFn;
}

function buildConditionIds(conditions: readonly ConditionTier[]): string[] {
  const seen = new Set<string>();
  const codes: string[] = [];
  for (const tier of conditions) {
    const code = MERCARI_CONDITION_MAP[tier];
    if (!seen.has(code)) {
      seen.add(code);
      codes.push(code);
    }
  }
  return codes;
}

/**
 * Builds the canonical Mercari US search URL using integer-cent pricing and hyphen-joined condition IDs.
 */
export function buildMercariNativeSearchUrl(
  keywords: string,
  unifiedFilters: UnifiedFilter,
  sortOrder: SortOrder,
): string {
  const url = new URL('https://www.mercari.com/search/');
  url.searchParams.set('keyword', keywords.trim());
  url.searchParams.set('itemStatuses', '1');

  if (unifiedFilters.priceMin != null) {
    url.searchParams.set('minPrice', String(Math.round(unifiedFilters.priceMin * 100)));
  }
  if (unifiedFilters.priceMax != null) {
    url.searchParams.set('maxPrice', String(Math.round(unifiedFilters.priceMax * 100)));
  }

  const conditionIds = buildConditionIds(unifiedFilters.conditions);
  if (conditionIds.length > 0) {
    url.searchParams.set('itemConditions', conditionIds.join('-'));
  }

  url.searchParams.set('sortBy', MERCARI_SORT_MAP[sortOrder]);
  return url.toString();
}

export function isMercariSearchFacetResponse(res: BrowserResponseHandle): boolean {
  const rawUrl = res.url();
  try {
    const parsed = new URL(rawUrl);
    return (
      parsed.hostname.endsWith('mercari.com') &&
      parsed.pathname.includes('/v1/api') &&
      parsed.searchParams.get('operationName') === 'searchFacetQuery'
    );
  } catch {
    return rawUrl.includes('/v1/api') && rawUrl.includes('operationName=searchFacetQuery');
  }
}

function pickValidHttpUrl(candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const trimmed = candidate.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        return parsed.toString();
      }
    } catch {
      // Ignore malformed candidate URL and fall through to next candidate
    }
  }
  return null;
}

function convertEpochSecondsToIso(created: number | string | null | undefined): string | null {
  if (created == null) {
    return null;
  }
  const seconds = Number(created);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeMercariNode(
  rawNode: unknown,
  adapterRank: number,
): { parsedValid: boolean; listing: Listing | null } {
  const parsed = MercariItemNodeSchema.safeParse(rawNode);
  if (!parsed.success) {
    return { parsedValid: false, listing: null };
  }

  const item = parsed.data;
  const priceCents = Number(item.price);
  if (!Number.isFinite(priceCents) || priceCents < 0) {
    return { parsedValid: false, listing: null };
  }

  // Active guard: strictly status === 'on_sale'
  if (item.status !== 'on_sale') {
    return { parsedValid: true, listing: null };
  }

  const price = priceCents / 100;
  const thumbnailUrl = pickValidHttpUrl([
    item.photos?.[0]?.thumbnail,
    item.photos?.[0]?.imageUrl,
    item.thumbnails?.[0],
  ]);

  const candidate: Listing = {
    marketplace: 'mercari',
    marketplaceListingId: item.id,
    url: `https://www.mercari.com/us/item/${encodeURIComponent(item.id)}/`,
    title: item.name,
    price,
    shippingPrice: null,
    shippingType: 'unknown',
    listingFormat: 'fixed_price',
    bidCount: null,
    buyNowPrice: null,
    thumbnailUrl,
    conditionLabel: item.itemCondition?.name?.trim() || null,
    locationLabel: null,
    listedAt: convertEpochSecondsToIso(item.created),
    adapterRank,
  };

  const validated = ListingSchema.safeParse(candidate);
  if (!validated.success) {
    return { parsedValid: false, listing: null };
  }
  return { parsedValid: true, listing: validated.data };
}

function normalizeMercariEnvelope(
  rawBody: unknown,
  nativeQuery: MercariNativeQuery,
  unifiedFilters: UnifiedFilter,
  rankOffset: number,
): AdapterBatchResult {
  const envelope = MercariEnvelopeSchema.safeParse(rawBody);
  if (!envelope.success) {
    return {
      runStatus: 'parse_error',
      listings: [],
      droppedMalformedCount: 0,
      hasMore: false,
      errorMessage: formatErrorWithUpstreamDetail(
        'Unrecognized Mercari searchFacetQuery response envelope.',
        rawBody,
      ),
    };
  }

  const search = envelope.data.data.search;
  const rawItems = search.itemsList;
  const activeListings: Listing[] = [];
  let validParsedCount = 0;
  let droppedMalformedCount = 0;

  rawItems.forEach((node, index) => {
    const { parsedValid, listing } = normalizeMercariNode(node, rankOffset + index + 1);
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
      errorMessage: `All ${rawItems.length} Mercari nodes failed normalization.`,
    };
  }

  const filtered = applyPostFilters(activeListings, unifiedFilters);
  const rawNextKey = search.nextKey != null ? String(search.nextKey).trim() : '';
  const hasMore = rawNextKey.length > 0 && rawNextKey !== '0';

  return {
    runStatus: filtered.length > 0 ? 'success' : 'empty',
    listings: filtered,
    droppedMalformedCount,
    hasMore,
    nextCursor: hasMore
      ? ({
          nextKey: rawNextKey,
          searchId: search.searchId ?? null,
          initRequestTime: search.initRequestTime ?? null,
          offset: search.offset ?? null,
          nativeQuery,
          rankOffset: rankOffset + rawItems.length,
        } satisfies MercariCursor)
      : undefined,
  };
}

function isChallengeText(url: string, title: string, html?: string): boolean {
  const lowerUrl = url.toLowerCase();
  if (
    lowerUrl.includes('/login') ||
    lowerUrl.includes('/signin') ||
    lowerUrl.includes('/sign-in') ||
    lowerUrl.includes('/captcha') ||
    lowerUrl.includes('/challenge') ||
    lowerUrl.includes('/cdn-cgi/challenge')
  ) {
    return true;
  }
  const lowerTitle = title.toLowerCase();
  if (
    lowerTitle.includes('just a moment') ||
    lowerTitle.includes('attention required') ||
    lowerTitle.includes('access denied') ||
    lowerTitle.includes('security check') ||
    lowerTitle.includes('captcha') ||
    lowerTitle.includes('log in') ||
    lowerTitle.includes('sign in')
  ) {
    return true;
  }
  if (html) {
    const lowerHtml = html.toLowerCase();
    if (
      lowerHtml.includes('cf-turnstile') ||
      lowerHtml.includes('challenges.cloudflare.com') ||
      lowerHtml.includes('cdn-cgi/challenge-platform') ||
      lowerHtml.includes('px-captcha') ||
      lowerHtml.includes('g-recaptcha') ||
      lowerHtml.includes('h-captcha') ||
      lowerHtml.includes('verify you are human')
    ) {
      return true;
    }
  }
  return false;
}

function startFacetResponseWaiter(
  page: BrowserPageHandle,
  timeoutMs: number,
): { promise: Promise<BrowserResponseHandle>; cancel: () => void } {
  if (page.waitForResponse) {
    let cancelled = false;
    const rawPromise = page.waitForResponse(isMercariSearchFacetResponse, { timeout: timeoutMs });
    rawPromise.catch(() => undefined);
    const promise = rawPromise.then((res) => {
      if (cancelled) {
        throw new Error('Cancelled');
      }
      return res;
    });
    promise.catch(() => undefined);

    return {
      promise,
      cancel: () => {
        cancelled = true;
      },
    };
  }

  if (page.on && page.off) {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let listener!: (res: BrowserResponseHandle) => void;

    const cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      page.off?.('response', listener);
    };

    const promise = new Promise<BrowserResponseHandle>((resolve, reject) => {
      listener = (res: BrowserResponseHandle) => {
        if (!settled && isMercariSearchFacetResponse(res)) {
          settled = true;
          cleanup();
          resolve(res);
        }
      };
      page.on!('response', listener);
      timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(
            Object.assign(new Error(`Mercari searchFacetQuery timed out after ${timeoutMs}ms`), {
              isTimeout: true,
            }),
          );
        }
      }, timeoutMs);
    });

    promise.catch(() => undefined);

    return {
      promise,
      cancel: () => {
        if (!settled) {
          settled = true;
          cleanup();
        }
      },
    };
  }

  return {
    promise: Promise.reject(new Error('BrowserPageHandle does not support response interception.')),
    cancel: () => undefined,
  };
}

async function checkPageForChallenge(page: BrowserPageHandle): Promise<boolean> {
  const title = await page.title().catch(() => '');
  const html = await page.content().catch(() => '');
  return isChallengeText(page.url(), title, html);
}

/**
 * Unauthenticated guest Mercari US adapter backed by BrowserSessionManager + searchFacetQuery interception.
 */
export class MercariAdapter implements MarketplaceAdapter {
  readonly id: MarketplaceId = 'mercari';
  private readonly browserSessionManager: BrowserSessionManager;
  private readonly timeoutMs: number;
  private readonly clock: ClockFn;

  constructor(options: MercariAdapterOptions) {
    this.browserSessionManager = options.browserSessionManager;
    this.timeoutMs = options.timeoutMs ?? MERCARI_TIMEOUT_MS;
    this.clock = options.clock ?? (() => Date.now());
  }

  translateFilters(
    keywords: string,
    unifiedFilters: UnifiedFilter,
    sortOrder: SortOrder,
    _context: AdapterExecutionContext,
  ): AdapterTranslationResult {
    const nativeSearchUrl = buildMercariNativeSearchUrl(keywords, unifiedFilters, sortOrder);

    if (unifiedFilters.fulfillment === 'local_pickup') {
      return {
        marketplace: 'mercari',
        status: 'skipped_unsupported',
        notices: ['Mercari Local was discontinued; local pickup is not supported.'],
        nativeSearchUrl,
      };
    }

    const nativeQuery: MercariNativeQuery = {
      searchUrl: nativeSearchUrl,
      sortOrder,
    };

    return {
      marketplace: 'mercari',
      status: 'exact',
      notices: [],
      nativeSearchUrl,
      nativeQuery,
    };
  }

  private async handleFacetResponse(
    page: BrowserPageHandle,
    waiter: { promise: Promise<BrowserResponseHandle>; cancel: () => void },
    nativeQuery: MercariNativeQuery,
    unifiedFilters: UnifiedFilter,
    rankOffset: number,
  ): Promise<AdapterBatchResult> {
    let facetRes: BrowserResponseHandle;
    try {
      facetRes = await waiter.promise;
    } catch (err) {
      if (await checkPageForChallenge(page)) {
        return {
          runStatus: 'challenge_or_auth_required',
          listings: [],
          droppedMalformedCount: 0,
          hasMore: false,
          errorMessage: 'Mercari presented a Cloudflare, CAPTCHA, or login challenge.',
        };
      }
      if (isTimeoutError(err)) {
        return {
          runStatus: 'timeout',
          listings: [],
          droppedMalformedCount: 0,
          hasMore: false,
          errorMessage: `Mercari searchFacetQuery timed out after ${this.timeoutMs}ms.`,
        };
      }
      throw err;
    }

    const status = facetRes.status();
    if (status === 401 || status === 403) {
      return {
        runStatus: 'challenge_or_auth_required',
        listings: [],
        droppedMalformedCount: 0,
        hasMore: false,
        errorMessage: `Mercari searchFacetQuery blocked with HTTP ${status}.`,
      };
    }

    if (status < 200 || status >= 300) {
      return {
        runStatus: 'network_error',
        listings: [],
        droppedMalformedCount: 0,
        hasMore: false,
        errorMessage: `Mercari searchFacetQuery returned HTTP ${status}.`,
      };
    }

    let rawBody: unknown;
    try {
      rawBody = await facetRes.json();
    } catch {
      return {
        runStatus: 'parse_error',
        listings: [],
        droppedMalformedCount: 0,
        hasMore: false,
        errorMessage: 'Failed to parse Mercari searchFacetQuery JSON response.',
      };
    }

    return normalizeMercariEnvelope(rawBody, nativeQuery, unifiedFilters, rankOffset);
  }

  private async runWithTimeout(
    fn: (page: BrowserPageHandle, remainingMs: () => number) => Promise<AdapterBatchResult>,
    context: AdapterExecutionContext,
  ): Promise<AdapterBatchResult> {
    const deadlineMs = this.clock() + this.timeoutMs;
    const remainingMs = () => Math.max(1, deadlineMs - this.clock());

    try {
      return await createTimeoutRace(
        this.browserSessionManager.runInBackgroundPage(
          'mercari',
          (page) => fn(page, remainingMs),
          { signal: context.signal },
        ),
        this.timeoutMs,
        context.signal,
        'Mercari',
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
          errorMessage: err instanceof Error ? err.message : 'Mercari search timed out.',
        };
      }
      return {
        runStatus: 'network_error',
        listings: [],
        droppedMalformedCount: 0,
        hasMore: false,
        errorMessage: err instanceof Error ? err.message : 'Mercari browser error.',
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

    const nativeQuery = params.translation.nativeQuery as MercariNativeQuery | undefined;
    if (!nativeQuery) {
      return {
        runStatus: 'parse_error',
        listings: [],
        droppedMalformedCount: 0,
        hasMore: false,
        errorMessage: 'Missing Mercari native query.',
      };
    }

    return this.runWithTimeout(async (page, remainingMs) => {
      const waiter = startFacetResponseWaiter(page, remainingMs());
      let navResponse: Awaited<ReturnType<BrowserPageHandle['goto']>>;
      try {
        navResponse = await page.goto(nativeQuery.searchUrl, {
          waitUntil: 'domcontentloaded',
          timeout: remainingMs(),
        });
      } catch (err) {
        waiter.cancel();
        throw err;
      }

      const navStatus = navResponse?.status();
      if (navStatus === 401 || navStatus === 403) {
        waiter.cancel();
        return {
          runStatus: 'challenge_or_auth_required',
          listings: [],
          droppedMalformedCount: 0,
          hasMore: false,
          errorMessage: `Mercari returned HTTP ${navStatus} on /search/.`,
        };
      }

      if (await checkPageForChallenge(page)) {
        waiter.cancel();
        return {
          runStatus: 'challenge_or_auth_required',
          listings: [],
          droppedMalformedCount: 0,
          hasMore: false,
          errorMessage: 'Mercari presented a Cloudflare, CAPTCHA, or login challenge.',
        };
      }

      return this.handleFacetResponse(page, waiter, nativeQuery, params.unifiedFilters, 0);
    }, params.context);
  }

  async loadMore(params: AdapterLoadMoreParams): Promise<AdapterBatchResult> {
    const cursor = params.cursor as MercariCursor | undefined;
    if (!cursor?.nextKey || cursor.nextKey === '0') {
      return {
        runStatus: 'empty',
        listings: [],
        droppedMalformedCount: 0,
        hasMore: false,
      };
    }

    return this.runWithTimeout(async (page, remainingMs) => {
      const currentUrl = page.url();
      if (!currentUrl.includes('mercari.com')) {
        return {
          runStatus: 'network_error',
          listings: [],
          droppedMalformedCount: 0,
          hasMore: false,
          errorMessage: 'Warm Mercari search page is no longer open; please refresh the search.',
        };
      }

      if (await checkPageForChallenge(page)) {
        return {
          runStatus: 'challenge_or_auth_required',
          listings: [],
          droppedMalformedCount: 0,
          hasMore: false,
          errorMessage: 'Mercari presented a Cloudflare, CAPTCHA, or login challenge.',
        };
      }

      const waiter = startFacetResponseWaiter(page, remainingMs());
      try {
        await page.evaluate(() => {
          const targetY = Math.max(
            document.documentElement?.scrollHeight ?? 0,
            document.body?.scrollHeight ?? 0,
            window.scrollY + Math.max(window.innerHeight || 900, 900),
          );
          window.scrollTo(0, targetY);
        });
      } catch (err) {
        waiter.cancel();
        throw err;
      }

      return this.handleFacetResponse(
        page,
        waiter,
        cursor.nativeQuery,
        params.unifiedFilters,
        cursor.rankOffset,
      );
    }, params.context);
  }
}

export function createMercariAdapter(options: MercariAdapterOptions): MercariAdapter {
  return new MercariAdapter(options);
}
