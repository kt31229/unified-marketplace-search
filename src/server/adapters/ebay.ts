import { z } from 'zod';
import {
  ListingSchema,
  type ConditionTier,
  type Listing,
  type ListingFormat,
  type MarketplaceId,
  type ShippingType,
  type SortOrder,
  type TranslationStatus,
  type UnifiedFilter,
} from '../../shared/index.ts';
import type { RawEbayCredentials } from '../secrets.ts';
import { applyPostFilters } from './post-filter.ts';
import { formatErrorWithUpstreamDetail } from './utils.ts';
import type {
  AdapterBatchResult,
  AdapterExecutionContext,
  AdapterLoadMoreParams,
  AdapterSearchParams,
  AdapterTranslationResult,
  ClockFn,
  FetchLike,
  MarketplaceAdapter,
} from './types.ts';

export const EBAY_OAUTH_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
export const EBAY_BROWSE_SEARCH_URL = 'https://api.ebay.com/buy/browse/v1/item_summary/search';
export const EBAY_PAGE_LIMIT = 48;
export const EBAY_TIMEOUT_MS = 10_000;
const EBAY_HARD_OFFSET_CAP = 10_000;
const TOKEN_REFRESH_BUFFER_MS = 60_000;

const EBAY_CONDITION_MAP: Record<ConditionTier, readonly string[]> = {
  new: ['1000'],
  like_new: ['1500', '2000', '2010', '2020', '2500', '2750', '3000', '4000'],
  good: ['2030', '3000', '5000'],
  fair: ['3000', '6000'],
  poor: ['7000'],
};

const USED_TIERS: readonly ConditionTier[] = ['like_new', 'good', 'fair'];

const EbayMoneySchema = z.object({
  value: z.union([z.string(), z.number()]),
  currency: z.string().optional(),
});

const EbayImageSchema = z.object({
  imageUrl: z.string().url(),
});

const EbayItemSummarySchema = z.object({
  itemId: z.string().min(1),
  title: z.string().trim().min(1),
  itemWebUrl: z.string().url(),
  price: EbayMoneySchema.optional(),
  currentBidPrice: EbayMoneySchema.optional(),
  bidCount: z.number().int().nonnegative().optional(),
  buyingOptions: z.array(z.string()).optional(),
  shippingOptions: z
    .array(
      z.object({
        shippingCostType: z.string().optional(),
        shippingCost: EbayMoneySchema.optional(),
      }),
    )
    .optional(),
  pickupOptions: z.array(z.unknown()).optional(),
  image: EbayImageSchema.optional(),
  thumbnailImages: z.array(EbayImageSchema).optional(),
  additionalImages: z.array(EbayImageSchema).optional(),
  additionalImageUrls: z.array(z.string().url()).optional(),
  condition: z.string().optional(),
  itemLocation: z
    .object({
      city: z.string().optional(),
      stateOrProvince: z.string().optional(),
      country: z.string().optional(),
    })
    .optional(),
  itemCreationDate: z.string().optional(),
  // Explicitly omit/strip seller PII during normalization
});

const EbaySearchEnvelopeSchema = z.object({
  total: z.number().int().nonnegative().optional(),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
  next: z.string().optional(),
  itemSummaries: z.array(z.unknown()).optional(),
});

const EbayOAuthResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});

export interface EbayNativeQuery {
  q: string;
  limit: number;
  offset: number;
  fieldgroups: string;
  sort?: string;
  filter: string;
  endUserCtx?: string;
}

export interface EbayCursor {
  offset: number;
  nativeQuery: EbayNativeQuery;
}

export interface EbayAdapterOptions {
  fetchImpl?: FetchLike;
  clock?: ClockFn;
  timeoutMs?: number;
}

interface CachedToken {
  cacheKey: string;
  accessToken: string;
  expiresAtMs: number;
}

export function buildEbayNativeSearchUrl(
  keywords: string,
  unifiedFilters: UnifiedFilter,
  sortOrder: SortOrder,
): string {
  const url = new URL('https://www.ebay.com/sch/i.html');
  url.searchParams.set('_nkw', keywords.trim());
  if (unifiedFilters.priceMin != null) {
    url.searchParams.set('_udlo', String(unifiedFilters.priceMin));
  }
  if (unifiedFilters.priceMax != null) {
    url.searchParams.set('_udhi', String(unifiedFilters.priceMax));
  }
  if (sortOrder === 'newest') {
    url.searchParams.set('_sop', '10');
  } else if (sortOrder === 'price_asc') {
    url.searchParams.set('_sop', '15');
  } else if (sortOrder === 'price_desc') {
    url.searchParams.set('_sop', '16');
  }
  return url.toString();
}

function mapSortOrder(sortOrder: SortOrder): string | undefined {
  switch (sortOrder) {
    case 'newest':
      return 'newlyListed';
    case 'price_asc':
      return 'price';
    case 'price_desc':
      return '-price';
    case 'relevance':
    default:
      return undefined;
  }
}

function parseShipping(
  item: z.infer<typeof EbayItemSummarySchema>,
): { shippingPrice: number | null; shippingType: ShippingType } {
  const firstOption = item.shippingOptions?.[0];
  if (firstOption) {
    if (firstOption.shippingCostType === 'FIXED') {
      const cost = Number(firstOption.shippingCost?.value ?? 0);
      if (Number.isFinite(cost) && cost === 0) {
        return { shippingPrice: 0, shippingType: 'free' };
      }
      if (Number.isFinite(cost) && cost > 0) {
        return { shippingPrice: cost, shippingType: 'known' };
      }
    }
    return { shippingPrice: null, shippingType: 'buyer_paid_unknown' };
  }

  if (item.pickupOptions && item.pickupOptions.length > 0) {
    return { shippingPrice: null, shippingType: 'local_pickup_only' };
  }

  return { shippingPrice: null, shippingType: 'buyer_paid_unknown' };
}

function normalizeEbayItem(
  rawNode: unknown,
  adapterRank: number,
): Listing | null {
  const parsed = EbayItemSummarySchema.safeParse(rawNode);
  if (!parsed.success) {
    return null;
  }
  const item = parsed.data;
  const buyingOptions = item.buyingOptions ?? [];
  const isAuction = buyingOptions.includes('AUCTION') && item.currentBidPrice?.value != null;

  let listingFormat: ListingFormat = 'fixed_price';
  let price: number;
  let bidCount: number | null = null;
  let buyNowPrice: number | null = null;

  if (isAuction) {
    listingFormat = 'auction';
    price = Number(item.currentBidPrice!.value);
    bidCount = item.bidCount ?? 0;
    buyNowPrice = item.price?.value != null ? Number(item.price.value) : null;
  } else {
    if (item.price?.value == null) {
      return null;
    }
    price = Number(item.price.value);
  }

  if (!Number.isFinite(price) || price < 0) {
    return null;
  }

  const { shippingPrice, shippingType } = parseShipping(item);
  const thumbnailUrl =
    item.image?.imageUrl ??
    item.thumbnailImages?.[0]?.imageUrl ??
    item.additionalImages?.[0]?.imageUrl ??
    item.additionalImageUrls?.[0] ??
    null;

  const locationLabel =
    [item.itemLocation?.city, item.itemLocation?.stateOrProvince]
      .filter((part): part is string => Boolean(part && part.trim()))
      .join(', ') ||
    item.itemLocation?.country ||
    null;

  const candidate: Listing = {
    marketplace: 'ebay',
    marketplaceListingId: item.itemId,
    url: item.itemWebUrl,
    title: item.title,
    price,
    shippingPrice,
    shippingType,
    listingFormat,
    bidCount,
    buyNowPrice: buyNowPrice != null && Number.isFinite(buyNowPrice) ? buyNowPrice : null,
    thumbnailUrl,
    conditionLabel: item.condition ?? null,
    locationLabel,
    listedAt: item.itemCreationDate ?? null,
    adapterRank,
  };

  const validated = ListingSchema.safeParse(candidate);
  return validated.success ? validated.data : null;
}

function createTimeoutSignal(
  timeoutMs: number,
  callerSignal?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void; didTimeout: () => boolean } {
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`eBay request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  const onCallerAbort = () => {
    controller.abort(callerSignal?.reason);
  };

  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort(callerSignal.reason);
    } else {
      callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    },
  };
}

export class EbayAdapter implements MarketplaceAdapter {
  readonly id: MarketplaceId = 'ebay';
  private readonly fetchImpl: FetchLike;
  private readonly clock: ClockFn;
  private readonly timeoutMs: number;
  private cachedToken: CachedToken | null = null;

  constructor(options: EbayAdapterOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.clock = options.clock ?? (() => Date.now());
    this.timeoutMs = options.timeoutMs ?? EBAY_TIMEOUT_MS;
  }

  translateFilters(
    keywords: string,
    unifiedFilters: UnifiedFilter,
    sortOrder: SortOrder,
    context: AdapterExecutionContext,
  ): AdapterTranslationResult {
    const trimmedKeywords = keywords.trim();
    const nativeSearchUrl = buildEbayNativeSearchUrl(trimmedKeywords, unifiedFilters, sortOrder);
    const notices: string[] = [];
    let status: TranslationStatus = 'exact';

    const filterClauses: string[] = ['buyingOptions:{FIXED_PRICE|AUCTION}'];

    if (unifiedFilters.priceMin != null || unifiedFilters.priceMax != null) {
      const minStr = unifiedFilters.priceMin != null ? unifiedFilters.priceMin.toFixed(2) : '';
      const maxStr = unifiedFilters.priceMax != null ? unifiedFilters.priceMax.toFixed(2) : '';
      const rangeExpr =
        minStr && maxStr
          ? `[${minStr}..${maxStr}]`
          : minStr
            ? `[${minStr}..]`
            : `[..${maxStr}]`;
      filterClauses.push(`price:${rangeExpr},priceCurrency:USD`);
    }

    if (unifiedFilters.conditions.length > 0) {
      const idSet = new Set<string>();
      for (const tier of unifiedFilters.conditions) {
        for (const id of EBAY_CONDITION_MAP[tier]) {
          idSet.add(id);
        }
      }
      const orderedIds = Array.from(idSet).sort((a, b) => Number(a) - Number(b));
      filterClauses.push(`conditionIds:{${orderedIds.join('|')}}`);

      const includesGenericUsed = idSet.has('3000');
      const allUsedSelected = USED_TIERS.every((tier) => unifiedFilters.conditions.includes(tier));
      if (includesGenericUsed && !allUsedSelected) {
        status = 'broadened';
        notices.push(
          'Included eBay general Used (3000) alongside granular tiers so categories without sub-conditions are not omitted.',
        );
      }
    }

    const zip =
      unifiedFilters.localPickupPostalCode?.trim() ||
      context.settings.homePostalCode?.trim() ||
      null;

    if (unifiedFilters.fulfillment === 'local_pickup') {
      if (!zip) {
        return {
          marketplace: 'ebay',
          status: 'skipped_unsupported',
          notices: [
            'Local pickup on eBay requires a ZIP / postal code (set in Unified Filters or Settings).',
          ],
          nativeSearchUrl,
        };
      }
      const radius =
        unifiedFilters.localPickupRadiusMiles ?? context.settings.defaultLocalPickupRadiusMiles ?? 50;
      filterClauses.push(
        `deliveryOptions:{SELLER_ARRANGED_LOCAL_PICKUP},pickupCountry:US,pickupPostalCode:${zip},pickupRadius:${radius},pickupRadiusUnit:mi`,
      );
    }

    const nativeQuery: EbayNativeQuery = {
      q: trimmedKeywords,
      limit: EBAY_PAGE_LIMIT,
      offset: 0,
      fieldgroups: 'EXTENDED',
      sort: mapSortOrder(sortOrder),
      filter: filterClauses.join(','),
      endUserCtx: zip ? `contextualLocation=country=US,zip=${zip}` : undefined,
    };

    return {
      marketplace: 'ebay',
      status,
      notices,
      nativeSearchUrl,
      nativeQuery,
    };
  }

  private async mintAccessToken(
    creds: RawEbayCredentials,
    signal?: AbortSignal,
    forceRefresh = false,
  ): Promise<string> {
    if (!creds.configured || !creds.clientId || !creds.clientSecret) {
      throw new Error('eBay credentials are not configured');
    }

    const cacheKey = `${creds.clientId}:${creds.clientSecret}`;
    const now = this.clock();

    if (
      !forceRefresh &&
      this.cachedToken &&
      this.cachedToken.cacheKey === cacheKey &&
      now < this.cachedToken.expiresAtMs - TOKEN_REFRESH_BUFFER_MS
    ) {
      return this.cachedToken.accessToken;
    }

    const encodedBasic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
    const timeoutGuard = createTimeoutSignal(this.timeoutMs, signal);

    try {
      const response = await this.fetchImpl(EBAY_OAUTH_URL, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${encodedBasic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
        signal: timeoutGuard.signal,
      });

      if (!response.ok) {
        throw new Error(`eBay OAuth token request failed (${response.status})`);
      }

      const rawJson = await response.json();
      const parsed = EbayOAuthResponseSchema.safeParse(rawJson);
      if (!parsed.success) {
        throw new Error('Invalid eBay OAuth response payload');
      }

      this.cachedToken = {
        cacheKey,
        accessToken: parsed.data.access_token,
        expiresAtMs: this.clock() + parsed.data.expires_in * 1000,
      };

      return parsed.data.access_token;
    } finally {
      timeoutGuard.cleanup();
    }
  }

  async verifyCredentials(
    creds: RawEbayCredentials,
  ): Promise<{ valid: boolean; error?: string }> {
    if (!creds.configured) {
      return {
        valid: false,
        error: 'eBay client_id and client_secret must both be configured before verification.',
      };
    }

    try {
      await this.mintAccessToken(creds, undefined, true);
      return { valid: true };
    } catch (err) {
      return {
        valid: false,
        error: err instanceof Error ? err.message : 'Failed to verify eBay credentials.',
      };
    }
  }

  private async executePage(
    nativeQuery: EbayNativeQuery,
    offset: number,
    unifiedFilters: UnifiedFilter,
    context: AdapterExecutionContext,
  ): Promise<AdapterBatchResult> {
    const creds = context.ebayCredentials;
    if (!creds?.configured) {
      return {
        runStatus: 'unconfigured',
        listings: [],
        droppedMalformedCount: 0,
        hasMore: false,
        errorMessage: 'eBay API credentials are not configured in Settings.',
      };
    }

    const searchUrl = new URL(EBAY_BROWSE_SEARCH_URL);
    searchUrl.searchParams.set('q', nativeQuery.q);
    searchUrl.searchParams.set('limit', String(nativeQuery.limit));
    searchUrl.searchParams.set('offset', String(offset));
    searchUrl.searchParams.set('fieldgroups', nativeQuery.fieldgroups);
    searchUrl.searchParams.set('filter', nativeQuery.filter);
    if (nativeQuery.sort) {
      searchUrl.searchParams.set('sort', nativeQuery.sort);
    }

    const runRequest = async (forceRefreshToken: boolean): Promise<Response> => {
      const token = await this.mintAccessToken(creds, context.signal, forceRefreshToken);
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
        Accept: 'application/json',
      };
      if (nativeQuery.endUserCtx) {
        headers['X-EBAY-C-ENDUSERCTX'] = nativeQuery.endUserCtx;
      }

      const timeoutGuard = createTimeoutSignal(this.timeoutMs, context.signal);
      try {
        return await this.fetchImpl(searchUrl.toString(), {
          method: 'GET',
          headers,
          signal: timeoutGuard.signal,
        });
      } catch (err) {
        if (timeoutGuard.didTimeout()) {
          throw Object.assign(new Error(`eBay Buy Browse API timed out after ${this.timeoutMs}ms`), {
            isTimeout: true,
          });
        }
        throw err;
      } finally {
        timeoutGuard.cleanup();
      }
    };

    let response: Response;
    try {
      response = await runRequest(false);
      if (response.status === 401) {
        this.cachedToken = null;
        response = await runRequest(true);
      }
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
      if (
        err &&
        typeof err === 'object' &&
        'isTimeout' in err &&
        (err as { isTimeout?: boolean }).isTimeout
      ) {
        return {
          runStatus: 'timeout',
          listings: [],
          droppedMalformedCount: 0,
          hasMore: false,
          errorMessage: err instanceof Error ? err.message : 'eBay request timed out.',
        };
      }
      return {
        runStatus: 'network_error',
        listings: [],
        droppedMalformedCount: 0,
        hasMore: false,
        errorMessage: err instanceof Error ? err.message : 'eBay network error.',
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        runStatus: 'challenge_or_auth_required',
        listings: [],
        droppedMalformedCount: 0,
        hasMore: false,
        errorMessage: `eBay API returned ${response.status} authentication error.`,
      };
    }

    if (!response.ok) {
      const errBody = await response.json().catch(() => null);
      return {
        runStatus: 'network_error',
        listings: [],
        droppedMalformedCount: 0,
        hasMore: false,
        errorMessage: formatErrorWithUpstreamDetail(
          `eBay API returned HTTP ${response.status}.`,
          errBody,
        ),
      };
    }

    let rawJson: unknown;
    try {
      rawJson = await response.json();
    } catch {
      return {
        runStatus: 'parse_error',
        listings: [],
        droppedMalformedCount: 0,
        hasMore: false,
        errorMessage: 'eBay API returned invalid JSON.',
      };
    }

    const envelope = EbaySearchEnvelopeSchema.safeParse(rawJson);
    if (!envelope.success) {
      return {
        runStatus: 'parse_error',
        listings: [],
        droppedMalformedCount: 0,
        hasMore: false,
        errorMessage: formatErrorWithUpstreamDetail(
          'Unrecognized eBay Buy Browse API response envelope.',
          rawJson,
        ),
      };
    }

    const rawItems = envelope.data.itemSummaries ?? [];
    const normalized: Listing[] = [];
    let droppedMalformedCount = 0;

    rawItems.forEach((node, index) => {
      const listing = normalizeEbayItem(node, offset + index + 1);
      if (listing) {
        normalized.push(listing);
      } else {
        droppedMalformedCount += 1;
      }
    });

    if (rawItems.length > 0 && normalized.length === 0) {
      return {
        runStatus: 'parse_error',
        listings: [],
        droppedMalformedCount,
        hasMore: false,
        errorMessage: `All ${rawItems.length} eBay nodes failed normalization.`,
      };
    }

    const filtered = applyPostFilters(normalized, unifiedFilters);
    const nextOffset = offset + EBAY_PAGE_LIMIT;
    const total = envelope.data.total ?? 0;
    const hasMore =
      nextOffset < EBAY_HARD_OFFSET_CAP &&
      (Boolean(envelope.data.next) || offset + rawItems.length < total);

    return {
      runStatus: filtered.length > 0 ? 'success' : 'empty',
      listings: filtered,
      droppedMalformedCount,
      hasMore,
      nextCursor: hasMore ? ({ offset: nextOffset, nativeQuery } satisfies EbayCursor) : undefined,
    };
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

    const nativeQuery = params.translation.nativeQuery as EbayNativeQuery | undefined;
    if (!nativeQuery) {
      return {
        runStatus: 'parse_error',
        listings: [],
        droppedMalformedCount: 0,
        hasMore: false,
        errorMessage: 'Missing eBay native query.',
      };
    }

    return this.executePage(nativeQuery, 0, params.unifiedFilters, params.context);
  }

  async loadMore(params: AdapterLoadMoreParams): Promise<AdapterBatchResult> {
    const cursor = params.cursor as EbayCursor | undefined;
    if (!cursor) {
      return {
        runStatus: 'empty',
        listings: [],
        droppedMalformedCount: 0,
        hasMore: false,
      };
    }

    return this.executePage(
      cursor.nativeQuery,
      cursor.offset,
      params.unifiedFilters,
      params.context,
    );
  }
}

export function createEbayAdapter(options: EbayAdapterOptions = {}): EbayAdapter {
  return new EbayAdapter(options);
}
