import { z } from 'zod';
import {
  DEFAULT_FACEBOOK_CITY_HUBS,
  ListingSchema,
  type AppSettings,
  type ConditionTier,
  type FacebookCityHub,
  type Listing,
  type MarketplaceId,
  type ShippingType,
  type SortOrder,
  type TranslationStatus,
  type UnifiedFilter,
} from '../../shared/index.ts';
import type {
  BrowserContextHandle,
  BrowserResponseHandle,
  BrowserSessionManager,
} from '../browser-session-manager.ts';
import { applyPostFilters } from './post-filter.ts';
import {
  createTimeoutRace,
  defaultSleep,
  isTimeoutError,
  summarizeUpstreamError,
} from './utils.ts';
import type {
  AdapterBatchResult,
  AdapterExecutionContext,
  AdapterLoadMoreParams,
  AdapterSearchParams,
  AdapterTranslationResult,
  ClockFn,
  MarketplaceAdapter,
  SleepFn,
} from './types.ts';

export const FACEBOOK_TIMEOUT_MS = 20_000;
export const FACEBOOK_MIN_COOLDOWN_MS = 3_000;
export const FACEBOOK_MAX_COOLDOWN_MS = 5_000;
export const FACEBOOK_DEFAULT_RADIUS_MILES = 500;

const FACEBOOK_CONDITION_MAP: Record<ConditionTier, string> = {
  new: 'new',
  like_new: 'used_like_new',
  good: 'used_good',
  fair: 'used_fair',
  poor: 'used_fair',
};

const FACEBOOK_SORT_MAP: Record<
  SortOrder,
  'best_match' | 'creation_time_descend' | 'price_ascend' | 'price_descend'
> = {
  relevance: 'best_match',
  newest: 'creation_time_descend',
  price_asc: 'price_ascend',
  price_desc: 'price_descend',
};

const FacebookListingNodeSchema = z.object({
  id: z.string().min(1),
  marketplace_listing_title: z.string().optional().nullable(),
  custom_title: z.string().optional().nullable(),
  listing_price: z
    .object({
      amount: z.union([z.string(), z.number()]),
      currency: z.string().optional(),
    })
    .optional(),
  is_sold: z.boolean().optional().default(false),
  is_pending: z.boolean().optional().default(false),
  delivery_types: z.array(z.string()).optional().nullable(),
  creation_time: z.number().optional().nullable(),
  primary_listing_photo: z
    .object({
      image: z
        .object({
          uri: z.string().url().optional().nullable(),
        })
        .optional()
        .nullable(),
    })
    .optional()
    .nullable(),
  location: z
    .object({
      reverse_geocode: z
        .object({
          city: z.string().optional().nullable(),
          state: z.string().optional().nullable(),
        })
        .optional()
        .nullable(),
    })
    .optional()
    .nullable(),
  condition: z.string().optional().nullable(),
  // marketplace_listing_seller / seller PII intentionally omitted
});

const FacebookFeedUnitsSchema = z.object({
  edges: z.array(z.unknown()),
  page_info: z
    .object({
      end_cursor: z.string().nullable().optional(),
      has_next_page: z.boolean().optional(),
    })
    .nullable()
    .optional(),
});

export interface FacebookHubQuery {
  slug: string;
  label: string;
  searchUrl: string;
}

export interface FacebookNativeQuery {
  hubs: FacebookHubQuery[];
  sortOrder: SortOrder;
}

export interface FacebookHubCursorState {
  slug: string;
  label: string;
  searchUrl: string;
  endCursor: string | null;
  hasNextPage: boolean;
  rankOffset: number;
}

export interface FacebookCursor {
  hubs: FacebookHubCursorState[];
  currentLoadedHubSlug: string;
  seenIds: string[];
  nativeQuery: FacebookNativeQuery;
}

export interface FacebookAdapterOptions {
  browserSessionManager: BrowserSessionManager;
  timeoutMs?: number;
  clock?: ClockFn;
  sleep?: SleepFn;
  random?: () => number;
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
    const mapped = FACEBOOK_CONDITION_MAP[tier];
    if (!seen.has(mapped)) {
      seen.add(mapped);
      codes.push(mapped);
    }
  }
  return { codes, broadenedPoor };
}

function resolveHubLabel(slug: string, settings: AppSettings): string {
  const fromSettings = settings.facebookCityHubs.find((h) => h.slug === slug);
  if (fromSettings) {
    return fromSettings.label;
  }
  const fromDefault = DEFAULT_FACEBOOK_CITY_HUBS.find((h) => h.slug === slug);
  return fromDefault?.label ?? slug;
}

function resolveHubList(unifiedFilters: UnifiedFilter, settings: AppSettings): FacebookCityHub[] {
  const enabledSlugs = unifiedFilters.facebookLocationSlugs.filter((s) => s.trim().length > 0);
  if (unifiedFilters.fulfillment === 'local_pickup') {
    const slug =
      settings.homeFacebookCitySlug?.trim() ||
      enabledSlugs[0] ||
      settings.facebookCityHubs.find((h) => h.enabled)?.slug ||
      DEFAULT_FACEBOOK_CITY_HUBS[0]!.slug;
    return [{ slug, label: resolveHubLabel(slug, settings), enabled: true }];
  }

  if (unifiedFilters.fulfillment === 'shipping') {
    const slug =
      settings.homeFacebookCitySlug?.trim() ||
      enabledSlugs[0] ||
      settings.facebookCityHubs.find((h) => h.enabled)?.slug ||
      DEFAULT_FACEBOOK_CITY_HUBS[0]!.slug;
    return [{ slug, label: resolveHubLabel(slug, settings), enabled: true }];
  }

  const targetSlugs =
    enabledSlugs.length > 0
      ? enabledSlugs
      : settings.facebookCityHubs.filter((h) => h.enabled).map((h) => h.slug);
  const finalSlugs =
    targetSlugs.length > 0 ? targetSlugs : DEFAULT_FACEBOOK_CITY_HUBS.map((h) => h.slug);

  const unique = Array.from(new Set(finalSlugs));
  return unique.map((slug) => ({
    slug,
    label: resolveHubLabel(slug, settings),
    enabled: true,
  }));
}

export function buildFacebookSearchUrl(
  hubSlug: string,
  keywords: string,
  unifiedFilters: UnifiedFilter,
  sortOrder: SortOrder,
  conditionCodes?: string[],
): string {
  const url = new URL(`https://www.facebook.com/marketplace/${encodeURIComponent(hubSlug)}/search/`);
  url.searchParams.set('query', keywords.trim());

  if (unifiedFilters.priceMin != null) {
    url.searchParams.set('minPrice', String(Math.floor(unifiedFilters.priceMin)));
  }
  if (unifiedFilters.priceMax != null) {
    url.searchParams.set('maxPrice', String(Math.ceil(unifiedFilters.priceMax)));
  }

  const codes = conditionCodes ?? buildConditionCodes(unifiedFilters.conditions).codes;
  if (codes.length > 0) {
    url.searchParams.set('itemCondition', codes.join(','));
  }

  if (unifiedFilters.fulfillment === 'shipping') {
    url.searchParams.set('deliveryMethod', 'shipping');
  } else if (unifiedFilters.fulfillment === 'local_pickup') {
    url.searchParams.set('deliveryMethod', 'local_pick_up');
  }

  url.searchParams.set('sortBy', FACEBOOK_SORT_MAP[sortOrder]);
  return url.toString();
}

function isChallengeUrlOrDom(url: string, title: string, html: string): boolean {
  const lowerUrl = url.toLowerCase();
  if (
    lowerUrl.includes('/login') ||
    lowerUrl.includes('/checkpoint') ||
    lowerUrl.includes('/two_step_verification') ||
    lowerUrl.includes('/recover')
  ) {
    return true;
  }

  const lowerTitle = title.toLowerCase();
  if (
    lowerTitle.includes('log in') ||
    lowerTitle.includes('login') ||
    lowerTitle.includes('security check') ||
    lowerTitle.includes('checkpoint') ||
    lowerTitle.includes('captcha')
  ) {
    return true;
  }

  const visibleHtml = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .toLowerCase();
  if (
    visibleHtml.includes('id="login_form"') ||
    visibleHtml.includes('name="login"') ||
    visibleHtml.includes('id="checkpoint_title"') ||
    visibleHtml.includes('/checkpoint/') ||
    visibleHtml.includes('two_step_verification') ||
    visibleHtml.includes('g-recaptcha') ||
    visibleHtml.includes('cf-turnstile') ||
    visibleHtml.includes('you must log in to continue')
  ) {
    return true;
  }

  return false;
}

async function hasMissingAuthenticatedCookie(context: BrowserContextHandle): Promise<boolean> {
  try {
    const cookies = await context.cookies('https://www.facebook.com');
    if (cookies.length === 0) {
      // Minimal test transports that do not model cookies return []; only flag when cookies exist without c_user
      return false;
    }
    return !cookies.some((c) => c.name === 'c_user' && c.value.trim().length > 0);
  } catch {
    return false;
  }
}

function hasRelayAuthError(node: unknown): boolean {
  if (!node || typeof node !== 'object') {
    return false;
  }
  if (Array.isArray(node)) {
    return node.some((item) => hasRelayAuthError(item));
  }
  const record = node as Record<string, unknown>;
  if (Array.isArray(record.errors)) {
    for (const err of record.errors) {
      if (err && typeof err === 'object') {
        const errRec = err as Record<string, unknown>;
        const code = errRec.code;
        const msg = String(errRec.message ?? errRec.summary ?? '').toLowerCase();
        if (
          code === 1357001 ||
          code === 1675004 ||
          code === 1357004 ||
          msg.includes('log in') ||
          msg.includes('login') ||
          msg.includes('checkpoint') ||
          msg.includes('not logged in')
        ) {
          return true;
        }
      }
    }
  }
  for (const val of Object.values(record)) {
    if (val && typeof val === 'object' && hasRelayAuthError(val)) {
      return true;
    }
  }
  return false;
}

function findFeedUnitsInTree(node: unknown): z.infer<typeof FacebookFeedUnitsSchema> | null {
  if (!node || typeof node !== 'object') {
    return null;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findFeedUnitsInTree(item);
      if (found) {
        return found;
      }
    }
    return null;
  }

  const record = node as Record<string, unknown>;
  const ms = record.marketplace_search;
  if (ms && typeof ms === 'object') {
    const feedUnits = (ms as Record<string, unknown>).feed_units;
    const parsed = FacebookFeedUnitsSchema.safeParse(feedUnits);
    if (parsed.success) {
      return parsed.data;
    }
  }

  for (const value of Object.values(record)) {
    if (value && typeof value === 'object') {
      const found = findFeedUnitsInTree(value);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

function extractRelayFeedFromHtml(html: string): {
  feedUnits: z.infer<typeof FacebookFeedUnitsSchema> | null;
  hasAuthError: boolean;
  upstreamError: string | null;
} {
  const scriptRegex =
    /<script\b[^>]*\btype=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  let hasAuthError = false;
  let upstreamError: string | null = null;

  while ((match = scriptRegex.exec(html)) !== null) {
    const rawJson = match[1]?.trim();
    if (!rawJson) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      continue;
    }
    if (hasRelayAuthError(parsed)) {
      hasAuthError = true;
    }
    if (!upstreamError) {
      upstreamError = summarizeUpstreamError(parsed);
    }
    const found = findFeedUnitsInTree(parsed);
    if (found) {
      return { feedUnits: found, hasAuthError, upstreamError };
    }
  }

  return { feedUnits: null, hasAuthError, upstreamError };
}

function normalizeFacebookEdge(
  rawEdge: unknown,
  hubSlug: string,
  adapterRank: number,
): { parsedValid: boolean; listing: Listing | null } {
  if (!rawEdge || typeof rawEdge !== 'object') {
    return { parsedValid: false, listing: null };
  }
  const edge = rawEdge as Record<string, unknown>;
  const node = edge.node;
  if (!node || typeof node !== 'object') {
    return { parsedValid: false, listing: null };
  }
  const nodeRec = node as Record<string, unknown>;
  const rawListing = nodeRec.listing ?? (typeof nodeRec.id === 'string' ? nodeRec : null);
  if (!rawListing) {
    return { parsedValid: false, listing: null };
  }

  const parsed = FacebookListingNodeSchema.safeParse(rawListing);
  if (!parsed.success) {
    return { parsedValid: false, listing: null };
  }

  const item = parsed.data;
  const title = (item.marketplace_listing_title ?? item.custom_title ?? '').trim();
  if (!title) {
    return { parsedValid: false, listing: null };
  }

  if (!item.listing_price) {
    return { parsedValid: false, listing: null };
  }
  const price = Number(item.listing_price.amount);
  if (!Number.isFinite(price) || price < 0) {
    return { parsedValid: false, listing: null };
  }

  // Active guard: !is_sold && !is_pending
  if (item.is_sold || item.is_pending) {
    return { parsedValid: true, listing: null };
  }

  const deliveryTypes = Array.isArray(item.delivery_types) ? item.delivery_types : [];
  const shippingType: ShippingType = deliveryTypes.includes('SHIPPING_ONSITE')
    ? 'buyer_paid_unknown'
    : 'local_pickup_only';

  const listedAt =
    typeof item.creation_time === 'number' &&
    Number.isFinite(item.creation_time) &&
    item.creation_time > 0
      ? new Date(item.creation_time * 1000).toISOString()
      : null;

  const city = item.location?.reverse_geocode?.city?.trim() ?? '';
  const state = item.location?.reverse_geocode?.state?.trim() ?? '';
  const locationLabel = [city, state].filter(Boolean).join(', ') || null;

  const candidate: Listing = {
    marketplace: 'facebook',
    marketplaceListingId: item.id,
    url: `https://www.facebook.com/marketplace/item/${encodeURIComponent(item.id)}/`,
    title,
    price,
    shippingPrice: null,
    shippingType,
    listingFormat: 'fixed_price',
    bidCount: null,
    buyNowPrice: null,
    thumbnailUrl: item.primary_listing_photo?.image?.uri ?? null,
    conditionLabel: item.condition ?? null,
    locationLabel,
    listedAt,
    adapterRank,
    hubSlug,
  };

  const validated = ListingSchema.safeParse(candidate);
  if (!validated.success) {
    return { parsedValid: false, listing: null };
  }
  return { parsedValid: true, listing: validated.data };
}

function normalizeFeedUnits(
  feedUnits: z.infer<typeof FacebookFeedUnitsSchema>,
  hubSlug: string,
  unifiedFilters: UnifiedFilter,
  rankOffset: number,
  seenIds: Set<string>,
): {
  runStatus: 'success' | 'empty' | 'parse_error';
  listings: Listing[];
  droppedMalformedCount: number;
  endCursor: string | null;
  hasNextPage: boolean;
  rawEdgeCount: number;
  errorMessage?: string;
} {
  const edges = feedUnits.edges;
  const activeListings: Listing[] = [];
  let validParsedCount = 0;
  let droppedMalformedCount = 0;

  edges.forEach((edge, index) => {
    const { parsedValid, listing } = normalizeFacebookEdge(edge, hubSlug, rankOffset + index + 1);
    if (!parsedValid) {
      droppedMalformedCount += 1;
      return;
    }
    validParsedCount += 1;
    if (listing && !seenIds.has(listing.marketplaceListingId)) {
      seenIds.add(listing.marketplaceListingId);
      activeListings.push(listing);
    }
  });

  if (edges.length > 0 && validParsedCount === 0) {
    return {
      runStatus: 'parse_error',
      listings: [],
      droppedMalformedCount,
      endCursor: null,
      hasNextPage: false,
      rawEdgeCount: edges.length,
      errorMessage: `All ${edges.length} Facebook Marketplace feed edges failed normalization.`,
    };
  }

  const filtered = applyPostFilters(activeListings, unifiedFilters);
  const endCursor = feedUnits.page_info?.end_cursor ?? null;
  const hasNextPage = Boolean(feedUnits.page_info?.has_next_page && endCursor);

  return {
    runStatus: filtered.length > 0 ? 'success' : 'empty',
    listings: filtered,
    droppedMalformedCount,
    endCursor,
    hasNextPage,
    rawEdgeCount: edges.length,
  };
}

function interleaveListingsAcrossHubs(listings: readonly Listing[]): Listing[] {
  const byHub = new Map<string, Listing[]>();
  for (const listing of listings) {
    const key = listing.hubSlug ?? '__default';
    let bucket = byHub.get(key);
    if (!bucket) {
      bucket = [];
      byHub.set(key, bucket);
    }
    bucket.push(listing);
  }
  if (byHub.size <= 1) {
    return [...listings];
  }
  const buckets = Array.from(byHub.values());
  const result: Listing[] = [];
  let idx = 0;
  let added = true;
  while (added) {
    added = false;
    for (const bucket of buckets) {
      const next = bucket[idx];
      if (next) {
        result.push(next);
        added = true;
      }
    }
    idx += 1;
  }
  return result;
}

async function parseGraphqlResponseBody(res: BrowserResponseHandle): Promise<unknown[]> {
  if (res.text) {
    const rawText = await res.text().catch(() => '');
    if (rawText.trim().length > 0) {
      const cleaned = rawText.replace(/^for\s*\(;;\);\s*/, '');
      const payloads: unknown[] = [];
      try {
        payloads.push(JSON.parse(cleaned));
        return payloads;
      } catch {
        for (const line of cleaned.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            payloads.push(JSON.parse(trimmed));
          } catch {
            // Ignore malformed line
          }
        }
        if (payloads.length > 0) {
          return payloads;
        }
      }
    }
  }
  const jsonBody = await res.json().catch(() => null);
  return jsonBody !== null ? [jsonBody] : [];
}

function isPaginationGraphqlResponse(res: BrowserResponseHandle): boolean {
  const url = res.url();
  if (!url.includes('/api/graphql')) {
    return false;
  }
  const req = res.request?.();
  if (req) {
    const method = req.method?.()?.toUpperCase();
    if (method && method !== 'POST') {
      return false;
    }
    const postData = req.postData?.();
    if (typeof postData === 'string' && postData.length > 0) {
      return postData.includes('CometMarketplaceSearchContentPaginationQuery');
    }
  }
  return true;
}

/**
 * Dedicated-profile Facebook Marketplace adapter using SSR Relay JSON and
 * CometMarketplaceSearchContentPaginationQuery scroll interception.
 */
export class FacebookAdapter implements MarketplaceAdapter {
  readonly id: MarketplaceId = 'facebook';
  private readonly browserSessionManager: BrowserSessionManager;
  private readonly timeoutMs: number;
  private readonly clock: ClockFn;
  private readonly sleep: SleepFn;
  private readonly random: () => number;
  private challengeLatched = false;

  constructor(options: FacebookAdapterOptions) {
    this.browserSessionManager = options.browserSessionManager;
    this.timeoutMs = options.timeoutMs ?? FACEBOOK_TIMEOUT_MS;
    this.clock = options.clock ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
  }

  isChallengeLatched(): boolean {
    return this.challengeLatched;
  }

  clearChallengeLatch(): void {
    this.challengeLatched = false;
  }

  private computeCooldownMs(): number {
    const raw = this.random();
    const clamped = Number.isFinite(raw) ? Math.min(0.999999, Math.max(0, raw)) : 0.5;
    return (
      FACEBOOK_MIN_COOLDOWN_MS +
      Math.floor(clamped * (FACEBOOK_MAX_COOLDOWN_MS - FACEBOOK_MIN_COOLDOWN_MS + 1))
    );
  }

  translateFilters(
    keywords: string,
    unifiedFilters: UnifiedFilter,
    sortOrder: SortOrder,
    context: AdapterExecutionContext,
  ): AdapterTranslationResult {
    const trimmedKeywords = keywords.trim();
    const { codes, broadenedPoor } = buildConditionCodes(unifiedFilters.conditions);
    const hubs = resolveHubList(unifiedFilters, context.settings);

    const hubQueries: FacebookHubQuery[] = hubs.map((hub) => ({
      slug: hub.slug,
      label: hub.label,
      searchUrl: buildFacebookSearchUrl(
        hub.slug,
        trimmedKeywords,
        unifiedFilters,
        sortOrder,
        codes,
      ),
    }));

    const nativeSearchUrl = hubQueries[0]!.searchUrl;
    const notices: string[] = [];
    let status: TranslationStatus = 'exact';

    if (broadenedPoor) {
      status = 'broadened';
      notices.push('Facebook Marketplace has no Poor tier; mapped Poor to Used - Fair.');
    }

    const savedRadius =
      context.settings.facebookRadiusMiles ??
      unifiedFilters.facebookRadiusMiles ??
      FACEBOOK_DEFAULT_RADIUS_MILES;

    if (
      unifiedFilters.fulfillment === 'local_pickup' &&
      unifiedFilters.localPickupRadiusMiles != null &&
      unifiedFilters.localPickupRadiusMiles !== savedRadius
    ) {
      status = 'broadened';
      notices.push(
        `Facebook Marketplace local pickup uses the profile-saved ${savedRadius} mi browse radius rather than automating the in-page radius picker.`,
      );
    }

    const nativeQuery: FacebookNativeQuery = {
      hubs: hubQueries,
      sortOrder,
    };

    return {
      marketplace: 'facebook',
      status,
      notices,
      nativeSearchUrl,
      nativeQuery,
    };
  }

  private async fetchHubInitial(
    hub: FacebookHubQuery,
    unifiedFilters: UnifiedFilter,
    seenIds: Set<string>,
    signal?: AbortSignal,
  ): Promise<
    | {
        ok: true;
        listings: Listing[];
        droppedMalformedCount: number;
        endCursor: string | null;
        hasNextPage: boolean;
        rawEdgeCount: number;
      }
    | {
        ok: false;
        runStatus: 'challenge_or_auth_required' | 'timeout' | 'parse_error' | 'network_error';
        errorMessage: string;
        droppedMalformedCount?: number;
      }
  > {
    const deadlineMs = this.clock() + this.timeoutMs;
    const remainingMs = () => Math.max(1, deadlineMs - this.clock());

    try {
      return await createTimeoutRace(
        this.browserSessionManager.runInBackgroundPage(
          'facebook',
          async (page, context) => {
            const navResponse = await page.goto(hub.searchUrl, {
              waitUntil: 'domcontentloaded',
              timeout: remainingMs(),
            });

            const navStatus = navResponse?.status();
            if (navStatus === 401 || navStatus === 403) {
              return {
                ok: false as const,
                runStatus: 'challenge_or_auth_required' as const,
                errorMessage: `Facebook Marketplace returned HTTP ${navStatus}.`,
              };
            }

            if (await hasMissingAuthenticatedCookie(context)) {
              return {
                ok: false as const,
                runStatus: 'challenge_or_auth_required' as const,
                errorMessage:
                  'Facebook Marketplace session is not signed in (missing c_user cookie). Open browser session to sign in.',
              };
            }

            const title = await page.title().catch(() => '');
            const html = await page.content().catch(() => '');
            const currentUrl = page.url();

            const { feedUnits, hasAuthError, upstreamError } = extractRelayFeedFromHtml(html);

            if (hasAuthError || isChallengeUrlOrDom(currentUrl, title, html)) {
              return {
                ok: false as const,
                runStatus: 'challenge_or_auth_required' as const,
                errorMessage:
                  'Facebook Marketplace presented a login prompt, CAPTCHA, or security checkpoint.',
              };
            }

            if (!feedUnits) {
              return {
                ok: false as const,
                runStatus: 'parse_error' as const,
                errorMessage: upstreamError
                  ? `Could not locate Facebook Marketplace Relay JSON for ${hub.label} (${upstreamError}).`
                  : `Could not locate Facebook Marketplace Relay JSON for ${hub.label}.`,
              };
            }

            const normalized = normalizeFeedUnits(feedUnits, hub.slug, unifiedFilters, 0, seenIds);
            if (normalized.runStatus === 'parse_error') {
              return {
                ok: false as const,
                runStatus: 'parse_error' as const,
                errorMessage: normalized.errorMessage ?? 'Facebook Marketplace parse error.',
                droppedMalformedCount: normalized.droppedMalformedCount,
              };
            }

            return {
              ok: true as const,
              listings: normalized.listings,
              droppedMalformedCount: normalized.droppedMalformedCount,
              endCursor: normalized.endCursor,
              hasNextPage: normalized.hasNextPage,
              rawEdgeCount: normalized.rawEdgeCount,
            };
          },
          { signal, pageKey: hub.slug },
        ),
        this.timeoutMs,
        signal,
        'Facebook Marketplace',
      );
    } catch (err) {
      if (signal?.aborted) {
        throw err;
      }
      if (isTimeoutError(err)) {
        return {
          ok: false,
          runStatus: 'timeout',
          errorMessage: err instanceof Error ? err.message : `Facebook Marketplace timed out for ${hub.label}.`,
        };
      }
      return {
        ok: false,
        runStatus: 'network_error',
        errorMessage: err instanceof Error ? err.message : `Facebook Marketplace browser error for ${hub.label}.`,
      };
    }
  }

  async executeInitial(params: AdapterSearchParams): Promise<AdapterBatchResult> {
    if (this.challengeLatched) {
      return {
        runStatus: 'challenge_or_auth_required',
        listings: [],
        droppedMalformedCount: 0,
        hasMore: false,
        errorMessage:
          'Facebook Marketplace is paused after a security checkpoint or login prompt. Click "Open browser session" or "Retry Facebook".',
      };
    }

    const nativeQuery = params.translation.nativeQuery as FacebookNativeQuery | undefined;
    if (!nativeQuery || nativeQuery.hubs.length === 0) {
      return {
        runStatus: 'parse_error',
        listings: [],
        droppedMalformedCount: 0,
        hasMore: false,
        errorMessage: 'Missing Facebook Marketplace native query.',
      };
    }

    const { context, unifiedFilters } = params;
    const sleepFn = context.sleep ?? this.sleep;
    const hubs = nativeQuery.hubs;
    const totalCities = hubs.length;

    const seenIds = new Set<string>();
    const allListings: Listing[] = [];
    const hubCursors: FacebookHubCursorState[] = [];
    let totalDroppedMalformed = 0;
    let completedCities = 0;
    let lastLoadedHubSlug = hubs[0]!.slug;
    let lastErrorStatus: 'timeout' | 'parse_error' | 'network_error' | null = null;
    let lastErrorMessage: string | null = null;

    for (let i = 0; i < hubs.length; i += 1) {
      const hub = hubs[i]!;
      if (context.signal?.aborted) {
        return {
          runStatus: allListings.length > 0 ? 'success' : 'empty',
          listings: interleaveListingsAcrossHubs(allListings),
          droppedMalformedCount: totalDroppedMalformed,
          hasMore: false,
          completedCities,
          totalCities,
          currentCityLabel: null,
          stoppedByUser: true,
        };
      }

      if (i > 0) {
        const cooldownMs = this.computeCooldownMs();
        try {
          await sleepFn(cooldownMs, context.signal);
        } catch {
          return {
            runStatus: allListings.length > 0 ? 'success' : 'empty',
            listings: interleaveListingsAcrossHubs(allListings),
            droppedMalformedCount: totalDroppedMalformed,
            hasMore: false,
            completedCities,
            totalCities,
            currentCityLabel: null,
            stoppedByUser: true,
          };
        }
      }

      if (context.signal?.aborted) {
        return {
          runStatus: allListings.length > 0 ? 'success' : 'empty',
          listings: interleaveListingsAcrossHubs(allListings),
          droppedMalformedCount: totalDroppedMalformed,
          hasMore: false,
          completedCities,
          totalCities,
          currentCityLabel: null,
          stoppedByUser: true,
        };
      }

      context.onProgress?.({
        runStatus: 'running',
        completedCities: i + 1,
        totalCities,
        currentCityLabel: hub.label,
      });

      let outcome: Awaited<ReturnType<FacebookAdapter['fetchHubInitial']>>;
      try {
        outcome = await this.fetchHubInitial(hub, unifiedFilters, seenIds, context.signal);
      } catch {
        return {
          runStatus: allListings.length > 0 ? 'success' : 'empty',
          listings: interleaveListingsAcrossHubs(allListings),
          droppedMalformedCount: totalDroppedMalformed,
          hasMore: false,
          completedCities,
          totalCities,
          currentCityLabel: null,
          stoppedByUser: true,
        };
      }

      if (!outcome.ok) {
        totalDroppedMalformed += outcome.droppedMalformedCount ?? 0;

        if (outcome.runStatus === 'challenge_or_auth_required') {
          this.challengeLatched = true;
          const retained = interleaveListingsAcrossHubs(allListings);
          return {
            runStatus: 'challenge_or_auth_required',
            listings: retained,
            droppedMalformedCount: totalDroppedMalformed,
            hasMore: false,
            completedCities,
            totalCities,
            currentCityLabel: null,
            errorMessage:
              completedCities > 0
                ? `${outcome.errorMessage} Circuit breaker aborted remaining hubs; retained ${retained.length} earlier Listing(s).`
                : outcome.errorMessage,
          };
        }

        lastErrorStatus = outcome.runStatus;
        lastErrorMessage = outcome.errorMessage;

        if (totalCities === 1) {
          return {
            runStatus: outcome.runStatus,
            listings: [],
            droppedMalformedCount: totalDroppedMalformed,
            hasMore: false,
            completedCities,
            totalCities,
            currentCityLabel: null,
            errorMessage: outcome.errorMessage,
          };
        }
        continue;
      }

      completedCities += 1;
      lastLoadedHubSlug = hub.slug;
      totalDroppedMalformed += outcome.droppedMalformedCount;
      allListings.push(...outcome.listings);

      hubCursors.push({
        slug: hub.slug,
        label: hub.label,
        searchUrl: hub.searchUrl,
        endCursor: outcome.endCursor,
        hasNextPage: outcome.hasNextPage,
        rankOffset: outcome.rawEdgeCount,
      });

      const hasMoreSoFar = hubCursors.some((h) => h.hasNextPage && Boolean(h.endCursor));
      if (outcome.listings.length > 0) {
        context.onBatch?.({
          listings: outcome.listings,
          cityHub: hub.slug,
          hasMore: hasMoreSoFar,
        });
      }
    }

    const interleaved = interleaveListingsAcrossHubs(allListings);
    const hasMore = hubCursors.some((h) => h.hasNextPage && Boolean(h.endCursor));

    if (completedCities === 0 && lastErrorStatus) {
      return {
        runStatus: lastErrorStatus,
        listings: [],
        droppedMalformedCount: totalDroppedMalformed,
        hasMore: false,
        completedCities,
        totalCities,
        currentCityLabel: null,
        errorMessage: lastErrorMessage,
      };
    }

    return {
      runStatus: interleaved.length > 0 ? 'success' : 'empty',
      listings: interleaved,
      droppedMalformedCount: totalDroppedMalformed,
      hasMore,
      nextCursor: hasMore
        ? ({
            hubs: hubCursors,
            currentLoadedHubSlug: lastLoadedHubSlug,
            seenIds: Array.from(seenIds),
            nativeQuery,
          } satisfies FacebookCursor)
        : undefined,
      completedCities,
      totalCities,
      currentCityLabel: null,
    };
  }

  private async fetchHubLoadMore(
    hub: FacebookHubCursorState,
    unifiedFilters: UnifiedFilter,
    seenIds: Set<string>,
    signal?: AbortSignal,
  ): Promise<
    | {
        ok: true;
        listings: Listing[];
        droppedMalformedCount: number;
        endCursor: string | null;
        hasNextPage: boolean;
        rawEdgeCount: number;
      }
    | {
        ok: false;
        runStatus: 'challenge_or_auth_required' | 'timeout' | 'parse_error' | 'network_error';
        errorMessage: string;
        droppedMalformedCount?: number;
      }
  > {
    const deadlineMs = this.clock() + this.timeoutMs;
    const remainingMs = () => Math.max(1, deadlineMs - this.clock());

    try {
      return await createTimeoutRace(
        this.browserSessionManager.runInBackgroundPage(
          'facebook',
          async (page, context) => {
            const currentUrl = page.url();
            const expectedPath = `/marketplace/${encodeURIComponent(hub.slug)}/search`;
            if (!currentUrl.includes(expectedPath)) {
              const navRes = await page.goto(hub.searchUrl, {
                waitUntil: 'domcontentloaded',
                timeout: remainingMs(),
              });
              const navStatus = navRes?.status();
              if (navStatus === 401 || navStatus === 403) {
                return {
                  ok: false as const,
                  runStatus: 'challenge_or_auth_required' as const,
                  errorMessage: `Facebook Marketplace returned HTTP ${navStatus}.`,
                };
              }
            }

            if (await hasMissingAuthenticatedCookie(context)) {
              return {
                ok: false as const,
                runStatus: 'challenge_or_auth_required' as const,
                errorMessage: 'Facebook Marketplace session is not signed in.',
              };
            }

            if (!page.waitForResponse) {
              return {
                ok: false as const,
                runStatus: 'network_error' as const,
                errorMessage: 'Browser page does not support response interception.',
              };
            }

            const responsePromise = page.waitForResponse(isPaginationGraphqlResponse, {
              timeout: remainingMs(),
            });

            await page.evaluate(() => {
              window.scrollTo(0, document.body.scrollHeight);
            });

            const res = await responsePromise;
            const status = res.status();
            if (status === 401 || status === 403) {
              return {
                ok: false as const,
                runStatus: 'challenge_or_auth_required' as const,
                errorMessage: `Facebook Marketplace GraphQL pagination blocked with HTTP ${status}.`,
              };
            }

            const payloads = await parseGraphqlResponseBody(res);
            let feedUnits: z.infer<typeof FacebookFeedUnitsSchema> | null = null;
            let hasAuthError = false;
            for (const payload of payloads) {
              if (hasRelayAuthError(payload)) {
                hasAuthError = true;
              }
              const found = findFeedUnitsInTree(payload);
              if (found) {
                feedUnits = found;
                break;
              }
            }

            if (hasAuthError) {
              return {
                ok: false as const,
                runStatus: 'challenge_or_auth_required' as const,
                errorMessage:
                  'Facebook Marketplace presented a login prompt or checkpoint during pagination.',
              };
            }

            if (!feedUnits) {
              const upstreamError = payloads
                .map((payload) => summarizeUpstreamError(payload))
                .find((detail): detail is string => Boolean(detail));
              return {
                ok: false as const,
                runStatus: 'parse_error' as const,
                errorMessage: upstreamError
                  ? `Unrecognized CometMarketplaceSearchContentPaginationQuery response for ${hub.label} (${upstreamError}).`
                  : `Unrecognized CometMarketplaceSearchContentPaginationQuery response for ${hub.label}.`,
              };
            }

            const normalized = normalizeFeedUnits(
              feedUnits,
              hub.slug,
              unifiedFilters,
              hub.rankOffset,
              seenIds,
            );
            if (normalized.runStatus === 'parse_error') {
              return {
                ok: false as const,
                runStatus: 'parse_error' as const,
                errorMessage: normalized.errorMessage ?? 'Facebook Marketplace parse error.',
                droppedMalformedCount: normalized.droppedMalformedCount,
              };
            }

            return {
              ok: true as const,
              listings: normalized.listings,
              droppedMalformedCount: normalized.droppedMalformedCount,
              endCursor: normalized.endCursor,
              hasNextPage: normalized.hasNextPage,
              rawEdgeCount: normalized.rawEdgeCount,
            };
          },
          { signal, pageKey: hub.slug },
        ),
        this.timeoutMs,
        signal,
        'Facebook Marketplace',
      );
    } catch (err) {
      if (signal?.aborted) {
        throw err;
      }
      if (isTimeoutError(err)) {
        return {
          ok: false,
          runStatus: 'timeout',
          errorMessage:
            err instanceof Error ? err.message : `Facebook Marketplace load-more timed out for ${hub.label}.`,
        };
      }
      return {
        ok: false,
        runStatus: 'network_error',
        errorMessage:
          err instanceof Error ? err.message : `Facebook Marketplace load-more failed for ${hub.label}.`,
      };
    }
  }

  async loadMore(params: AdapterLoadMoreParams): Promise<AdapterBatchResult> {
    if (this.challengeLatched) {
      return {
        runStatus: 'challenge_or_auth_required',
        listings: [],
        droppedMalformedCount: 0,
        hasMore: false,
        errorMessage:
          'Facebook Marketplace is paused after a security checkpoint or login prompt. Click "Open browser session" or "Retry Facebook".',
      };
    }

    const cursor = params.cursor as FacebookCursor | undefined;
    if (!cursor || cursor.hubs.length === 0) {
      return {
        runStatus: 'empty',
        listings: [],
        droppedMalformedCount: 0,
        hasMore: false,
      };
    }

    const eligibleHubs = cursor.hubs.filter((h) => h.hasNextPage && Boolean(h.endCursor));
    if (eligibleHubs.length === 0) {
      return {
        runStatus: 'empty',
        listings: [],
        droppedMalformedCount: 0,
        hasMore: false,
      };
    }

    const { context, unifiedFilters } = params;
    const sleepFn = context.sleep ?? this.sleep;
    const totalCities = eligibleHubs.length;

    const seenIds = new Set(cursor.seenIds);
    const allListings: Listing[] = [];
    const updatedHubsBySlug = new Map(cursor.hubs.map((h) => [h.slug, { ...h }]));
    let totalDroppedMalformed = 0;
    let completedCities = 0;
    let lastLoadedHubSlug = cursor.currentLoadedHubSlug;
    let lastErrorStatus: 'timeout' | 'parse_error' | 'network_error' | null = null;
    let lastErrorMessage: string | null = null;

    const buildStoppedResult = (): AdapterBatchResult => {
      const updatedHubs = cursor.hubs.map((h) => updatedHubsBySlug.get(h.slug) ?? h);
      const hasMore = updatedHubs.some((h) => h.hasNextPage && Boolean(h.endCursor));
      return {
        runStatus: allListings.length > 0 ? 'success' : 'empty',
        listings: interleaveListingsAcrossHubs(allListings),
        droppedMalformedCount: totalDroppedMalformed,
        hasMore,
        nextCursor: hasMore
          ? ({
              hubs: updatedHubs,
              currentLoadedHubSlug: lastLoadedHubSlug,
              seenIds: Array.from(seenIds),
              nativeQuery: cursor.nativeQuery,
            } satisfies FacebookCursor)
          : undefined,
        completedCities,
        totalCities,
        currentCityLabel: null,
        stoppedByUser: true,
      };
    };

    for (let i = 0; i < eligibleHubs.length; i += 1) {
      const hub = eligibleHubs[i]!;
      if (context.signal?.aborted) {
        return buildStoppedResult();
      }

      if (i > 0) {
        const cooldownMs = this.computeCooldownMs();
        try {
          await sleepFn(cooldownMs, context.signal);
        } catch {
          return buildStoppedResult();
        }
      }

      if (context.signal?.aborted) {
        return buildStoppedResult();
      }

      context.onProgress?.({
        runStatus: 'running',
        completedCities: i + 1,
        totalCities,
        currentCityLabel: hub.label,
      });

      let outcome: Awaited<ReturnType<FacebookAdapter['fetchHubLoadMore']>>;
      try {
        outcome = await this.fetchHubLoadMore(hub, unifiedFilters, seenIds, context.signal);
      } catch {
        return buildStoppedResult();
      }

      if (!outcome.ok) {
        totalDroppedMalformed += outcome.droppedMalformedCount ?? 0;

        if (outcome.runStatus === 'challenge_or_auth_required') {
          this.challengeLatched = true;
          const retained = interleaveListingsAcrossHubs(allListings);
          return {
            runStatus: 'challenge_or_auth_required',
            listings: retained,
            droppedMalformedCount: totalDroppedMalformed,
            hasMore: false,
            completedCities,
            totalCities,
            currentCityLabel: null,
            errorMessage:
              completedCities > 0
                ? `${outcome.errorMessage} Circuit breaker aborted remaining hubs; retained ${retained.length} earlier Listing(s).`
                : outcome.errorMessage,
          };
        }

        lastErrorStatus = outcome.runStatus;
        lastErrorMessage = outcome.errorMessage;

        if (totalCities === 1) {
          return {
            runStatus: outcome.runStatus,
            listings: [],
            droppedMalformedCount: totalDroppedMalformed,
            hasMore: false,
            completedCities,
            totalCities,
            currentCityLabel: null,
            errorMessage: outcome.errorMessage,
          };
        }
        continue;
      }

      completedCities += 1;
      lastLoadedHubSlug = hub.slug;
      totalDroppedMalformed += outcome.droppedMalformedCount;
      allListings.push(...outcome.listings);

      updatedHubsBySlug.set(hub.slug, {
        ...hub,
        endCursor: outcome.endCursor,
        hasNextPage: outcome.hasNextPage,
        rankOffset: hub.rankOffset + outcome.rawEdgeCount,
      });

      const updatedHubsSoFar = cursor.hubs.map((h) => updatedHubsBySlug.get(h.slug) ?? h);
      const hasMoreSoFar = updatedHubsSoFar.some((h) => h.hasNextPage && Boolean(h.endCursor));
      if (outcome.listings.length > 0) {
        context.onBatch?.({
          listings: outcome.listings,
          cityHub: hub.slug,
          hasMore: hasMoreSoFar,
        });
      }
    }

    const updatedHubs = cursor.hubs.map((h) => updatedHubsBySlug.get(h.slug) ?? h);
    const hasMore = updatedHubs.some((h) => h.hasNextPage && Boolean(h.endCursor));

    if (completedCities === 0 && lastErrorStatus) {
      return {
        runStatus: lastErrorStatus,
        listings: [],
        droppedMalformedCount: totalDroppedMalformed,
        hasMore: false,
        completedCities,
        totalCities,
        currentCityLabel: null,
        errorMessage: lastErrorMessage,
      };
    }

    const interleaved = interleaveListingsAcrossHubs(allListings);
    return {
      runStatus: interleaved.length > 0 ? 'success' : 'empty',
      listings: interleaved,
      droppedMalformedCount: totalDroppedMalformed,
      hasMore,
      nextCursor: hasMore
        ? ({
            hubs: updatedHubs,
            currentLoadedHubSlug: lastLoadedHubSlug,
            seenIds: Array.from(seenIds),
            nativeQuery: cursor.nativeQuery,
          } satisfies FacebookCursor)
        : undefined,
      completedCities,
      totalCities,
      currentCityLabel: null,
    };
  }
}

export function createFacebookAdapter(options: FacebookAdapterOptions): FacebookAdapter {
  return new FacebookAdapter(options);
}
