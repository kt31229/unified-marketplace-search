import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserSessionManager,
  type BrowserContextHandle,
  type BrowserCookie,
  type BrowserPageHandle,
  type BrowserResponseHandle,
  type BrowserTransport,
} from '../../src/server/browser-session-manager.ts';
import { createFacebookAdapter } from '../../src/server/adapters/facebook.ts';
import type { AdapterExecutionContext } from '../../src/server/adapters/types.ts';
import {
  createDefaultAppSettings,
  createDefaultUnifiedFilter,
  sortListings,
  type Listing,
} from '../../src/shared/index.ts';

function makeContext(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    settings: createDefaultAppSettings(),
    ...overrides,
  };
}

function makeFacebookListing(id: string, hubSlug: string, adapterRank: number): Listing {
  return {
    marketplace: 'facebook',
    marketplaceListingId: id,
    url: `https://www.facebook.com/marketplace/item/${id}/`,
    title: `Listing ${id}`,
    price: 50,
    shippingPrice: null,
    shippingType: 'local_pickup_only',
    listingFormat: 'fixed_price',
    bidCount: null,
    buyNowPrice: null,
    thumbnailUrl: null,
    conditionLabel: null,
    locationLabel: hubSlug,
    listedAt: '2026-11-22T00:00:00.000Z',
    adapterRank,
    hubSlug,
  };
}

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ums-fb-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function wrapRelayHtml(relayPayload: unknown): string {
  const json = JSON.stringify(relayPayload);
  return `<!doctype html><html><head><title>Facebook Marketplace</title></head><body><script type="application/json" data-sjs>${json}</script></body></html>`;
}

interface FacebookMockStep {
  finalUrl?: string;
  status?: number;
  title?: string;
  html: string;
}

interface ScriptedFacebookOptions {
  cookies?: BrowserCookie[];
  stepsByUrl?: (url: string, callIndex: number) => FacebookMockStep | Promise<FacebookMockStep>;
  onScrollLoadMore?: (
    callIndex: number,
    currentUrl: string,
  ) => Promise<{
    url?: string;
    status?: number;
    postData?: string;
    body: unknown;
  }>;
}

function createScriptedFacebookTransport(options: ScriptedFacebookOptions) {
  const gotoUrls: string[] = [];
  const evaluateCalls: number[] = [];
  const pages: BrowserPageHandle[] = [];
  let launchCount = 0;
  let scrollCallIndex = 0;

  const transport: BrowserTransport = {
    async launchPersistentContext(): Promise<BrowserContextHandle> {
      launchCount += 1;
      const makePage = (): BrowserPageHandle => {
        let currentUrl = 'about:blank';
        let currentStep: FacebookMockStep = { html: '<html></html>' };
        let closed = false;
        let pendingWaiter: ((res: BrowserResponseHandle) => void) | null = null;

        const page: BrowserPageHandle = {
          async goto(url: string) {
            const idx = gotoUrls.length;
            gotoUrls.push(url);
            if (options.stepsByUrl) {
              currentStep = await options.stepsByUrl(url, idx);
            }
            currentUrl = currentStep.finalUrl ?? url;
            return {
              url: () => currentUrl,
              status: () => currentStep.status ?? 200,
              json: async () => ({}),
            };
          },
          url: () => currentUrl,
          title: async () => currentStep.title ?? 'Marketplace Search',
          content: async () => currentStep.html,
          async evaluate<R>(): Promise<R> {
            evaluateCalls.push(scrollCallIndex);
            if (options.onScrollLoadMore) {
              const payload = await options.onScrollLoadMore(scrollCallIndex, currentUrl);
              scrollCallIndex += 1;
              const resHandle: BrowserResponseHandle = {
                url: () => payload.url ?? 'https://www.facebook.com/api/graphql/',
                status: () => payload.status ?? 200,
                json: async () => payload.body,
                request: () => ({
                  method: () => 'POST',
                  postData: () =>
                    payload.postData ??
                    'fb_api_req_friendly_name=CometMarketplaceSearchContentPaginationQuery&variables=%7B%7D',
                }),
              };
              pendingWaiter?.(resHandle);
              pendingWaiter = null;
            }
            return undefined as R;
          },
          waitForResponse: async (predicate) => {
            return new Promise<BrowserResponseHandle>((resolve) => {
              pendingWaiter = async (res) => {
                const matched =
                  typeof predicate === 'string'
                    ? res.url().includes(predicate)
                    : await predicate(res);
                if (matched) {
                  resolve(res);
                }
              };
            });
          },
          close: async () => {
            closed = true;
          },
          isClosed: () => closed,
        };
        pages.push(page);
        return page;
      };

      makePage();

      return {
        pages: () => pages.filter((p) => !p.isClosed?.()),
        newPage: async () => makePage(),
        cookies: async () =>
          options.cookies ?? [{ name: 'c_user', value: '10000123456', domain: '.facebook.com' }],
        close: async () => undefined,
        on: () => undefined,
      };
    },
  };

  return {
    transport,
    gotoUrls,
    evaluateCalls,
    getLaunchCount: () => launchCount,
    getPageCount: () => pages.length,
  };
}

describe('FacebookMarketplaceAdapter & hub sorting', () => {
  it('round-robin interleaves Facebook Listings across hubSlug under relevance sort', () => {
    const listings: Listing[] = [
      makeFacebookListing('sea-1', 'seattle', 1),
      makeFacebookListing('sea-2', 'seattle', 2),
      makeFacebookListing('sea-3', 'seattle', 3),
      makeFacebookListing('sf-1', 'sanfrancisco', 1),
      makeFacebookListing('sf-2', 'sanfrancisco', 2),
      makeFacebookListing('la-1', 'la', 1),
    ];

    const sorted = sortListings(listings, 'relevance');
    expect(sorted.map((l) => l.marketplaceListingId)).toEqual([
      'sea-1',
      'sf-1',
      'la-1',
      'sea-2',
      'sf-2',
      'sea-3',
    ]);
  });

  it('translates conditions, sortBy, shipping, and local_pickup (broadened radius vs 500 mi)', () => {
    const launchSpy = vi.fn();
    const transport: BrowserTransport = { launchPersistentContext: launchSpy };
    const bsm = new BrowserSessionManager({
      dataDir: createTempDir(),
      getBrowserChannel: () => 'chrome',
      transport,
    });
    const adapter = createFacebookAdapter({ browserSessionManager: bsm });

    // 1. Exact shipping translation with multi-select conditions (new..fair)
    const shippingTx = adapter.translateFilters(
      '  patagonia nano puff  ',
      {
        ...createDefaultUnifiedFilter(),
        priceMin: 20,
        priceMax: 150,
        conditions: ['new', 'like_new', 'good', 'fair'],
        fulfillment: 'shipping',
      },
      'newest',
      makeContext(),
    );
    expect(shippingTx.status).toBe('exact');
    expect(shippingTx.notices).toEqual([]);
    const shippingUrl = new URL(shippingTx.nativeSearchUrl);
    expect(shippingUrl.searchParams.get('query')).toBe('patagonia nano puff');
    expect(shippingUrl.searchParams.get('minPrice')).toBe('20');
    expect(shippingUrl.searchParams.get('maxPrice')).toBe('150');
    expect(shippingUrl.searchParams.get('itemCondition')).toBe(
      'new,used_like_new,used_good,used_fair',
    );
    expect(shippingUrl.searchParams.get('sortBy')).toBe('creation_time_descend');
    expect(shippingUrl.searchParams.get('deliveryMethod')).toBe('shipping');

    // 2. Poor condition -> used_fair (broadened, deduplicated with fair)
    const poorTx = adapter.translateFilters(
      'bike',
      {
        ...createDefaultUnifiedFilter(),
        conditions: ['fair', 'poor'],
      },
      'price_asc',
      makeContext(),
    );
    expect(poorTx.status).toBe('broadened');
    expect(poorTx.notices.some((n) => /poor/i.test(n))).toBe(true);
    const poorUrl = new URL(poorTx.nativeSearchUrl);
    expect(poorUrl.searchParams.get('itemCondition')).toBe('used_fair');
    expect(poorUrl.searchParams.get('sortBy')).toBe('price_ascend');

    // 3. local_pickup routes to homeFacebookCitySlug || firstEnabledHub and reports broadened when radius differs from 500 mi
    const settings = createDefaultAppSettings();
    settings.homeFacebookCitySlug = 'denver';
    const pickupBroadened = adapter.translateFilters(
      'desk',
      {
        ...createDefaultUnifiedFilter(),
        fulfillment: 'local_pickup',
        localPickupRadiusMiles: 25,
      },
      'price_desc',
      makeContext({ settings }),
    );
    expect(pickupBroadened.status).toBe('broadened');
    expect(pickupBroadened.notices.some((n) => /500|radius/i.test(n))).toBe(true);
    const pickupUrl = new URL(pickupBroadened.nativeSearchUrl);
    expect(pickupUrl.pathname).toBe('/marketplace/denver/search/');
    expect(pickupUrl.searchParams.get('deliveryMethod')).toBe('local_pick_up');
    expect(pickupUrl.searchParams.get('sortBy')).toBe('price_descend');

    // 4. local_pickup with 500 mi radius and no homeFacebookCitySlug -> falls back to firstEnabledHub, exact
    const pickupExact = adapter.translateFilters(
      'desk',
      {
        ...createDefaultUnifiedFilter(),
        fulfillment: 'local_pickup',
        facebookLocationSlugs: ['chicago', 'nyc'],
        localPickupRadiusMiles: 500,
      },
      'relevance',
      makeContext(),
    );
    expect(pickupExact.status).toBe('exact');
    const pickupExactUrl = new URL(pickupExact.nativeSearchUrl);
    expect(pickupExactUrl.pathname).toBe('/marketplace/chicago/search/');
    expect(pickupExactUrl.searchParams.get('deliveryMethod')).toBe('local_pick_up');
    expect(pickupExactUrl.searchParams.get('sortBy')).toBe('best_match');
    expect(launchSpy).not.toHaveBeenCalled();
  });

  it('parses SSR Relay JSON without DOM scraping, normalizes fields, enforces active/price guards, and paginates via CometMarketplaceSearchContentPaginationQuery', async () => {
    const scripted = createScriptedFacebookTransport({
      stepsByUrl: () => ({
        html: wrapRelayHtml({
          require: [
            [
              'ScheduledServerJS',
              'handle',
              null,
              [
                {
                  __bbox: {
                    require: [
                      [
                        'RelayPrefetchedStreamCache',
                        'next',
                        [],
                        [
                          'adp_MarketplaceSearchQuery',
                          {
                            __bbox: {
                              result: {
                                data: {
                                  marketplace_search: {
                                    feed_units: {
                                      edges: [
                                        {
                                          node: {
                                            __typename: 'MarketplaceFeedListingStory',
                                            listing: {
                                              id: 'fb-1',
                                              marketplace_listing_title: 'Patagonia Nano Puff M',
                                              listing_price: { amount: '85.00', currency: 'USD' },
                                              is_sold: false,
                                              is_pending: false,
                                              delivery_types: ['IN_PERSON', 'SHIPPING_ONSITE'],
                                              creation_time: 1732233600,
                                              primary_listing_photo: {
                                                image: { uri: 'https://scontent.xx.fbcdn.net/fb-1.jpg' },
                                              },
                                              location: {
                                                reverse_geocode: { city: 'Seattle', state: 'WA' },
                                              },
                                              condition: 'used_like_new',
                                              marketplace_listing_seller: {
                                                id: 'seller-pii',
                                                name: 'Private Seller',
                                              },
                                            },
                                          },
                                        },
                                        {
                                          node: {
                                            __typename: 'MarketplaceFeedListingStory',
                                            listing: {
                                              id: 'fb-2',
                                              custom_title: 'Patagonia Better Sweater Local',
                                              listing_price: { amount: '45' },
                                              is_sold: false,
                                              is_pending: false,
                                              delivery_types: ['IN_PERSON'],
                                              creation_time: 1732147200,
                                              primary_listing_photo: {
                                                image: { uri: 'https://scontent.xx.fbcdn.net/fb-2.jpg' },
                                              },
                                              location: {
                                                reverse_geocode: { city: 'Tacoma', state: 'WA' },
                                              },
                                            },
                                          },
                                        },
                                        // Sold -> skipped by active guard
                                        {
                                          node: {
                                            listing: {
                                              id: 'fb-sold',
                                              marketplace_listing_title: 'Sold Jacket',
                                              listing_price: { amount: '50.00' },
                                              is_sold: true,
                                              is_pending: false,
                                              delivery_types: ['IN_PERSON'],
                                            },
                                          },
                                        },
                                        // Pending -> skipped by active guard
                                        {
                                          node: {
                                            listing: {
                                              id: 'fb-pending',
                                              marketplace_listing_title: 'Pending Jacket',
                                              listing_price: { amount: '50.00' },
                                              is_sold: false,
                                              is_pending: true,
                                              delivery_types: ['IN_PERSON'],
                                            },
                                          },
                                        },
                                        // Exceeds priceMax ($200 > $100) -> filtered out locally
                                        {
                                          node: {
                                            listing: {
                                              id: 'fb-over',
                                              marketplace_listing_title: 'Too Expensive Parka',
                                              listing_price: { amount: '200.00' },
                                              is_sold: false,
                                              is_pending: false,
                                              delivery_types: ['SHIPPING_ONSITE'],
                                            },
                                          },
                                        },
                                        // Malformed ad/promo node -> droppedMalformedCount++
                                        {
                                          node: {
                                            __typename: 'MarketplaceAdStory',
                                          },
                                        },
                                      ],
                                      page_info: {
                                        end_cursor: 'FB_CURSOR_2',
                                        has_next_page: true,
                                      },
                                    },
                                  },
                                },
                              },
                            },
                          },
                        ],
                      ],
                    ],
                  },
                },
              ],
            ],
          ],
        }),
      }),
      onScrollLoadMore: async () => ({
        body: {
          data: {
            marketplace_search: {
              feed_units: {
                edges: [
                  {
                    node: {
                      listing: {
                        id: 'fb-3',
                        marketplace_listing_title: 'Patagonia R1 Page 2',
                        listing_price: { amount: '60.00' },
                        is_sold: false,
                        is_pending: false,
                        delivery_types: ['SHIPPING_ONSITE'],
                        creation_time: 1732060800,
                      },
                    },
                  },
                  // Duplicate from page 1 -> deduplicated
                  {
                    node: {
                      listing: {
                        id: 'fb-1',
                        marketplace_listing_title: 'Patagonia Nano Puff M',
                        listing_price: { amount: '85.00' },
                        is_sold: false,
                        is_pending: false,
                        delivery_types: ['SHIPPING_ONSITE'],
                      },
                    },
                  },
                ],
                page_info: {
                  end_cursor: null,
                  has_next_page: false,
                },
              },
            },
          },
        },
      }),
    });

    const bsm = new BrowserSessionManager({
      dataDir: createTempDir(),
      getBrowserChannel: () => 'chrome',
      transport: scripted.transport,
    });
    const adapter = createFacebookAdapter({ browserSessionManager: bsm });

    const filters = {
      ...createDefaultUnifiedFilter(),
      fulfillment: 'shipping' as const,
      priceMin: 20,
      priceMax: 100,
    };
    const translation = adapter.translateFilters('patagonia', filters, 'relevance', makeContext());

    const page1 = await adapter.executeInitial({
      keywords: 'patagonia',
      unifiedFilters: filters,
      sortOrder: 'relevance',
      translation,
      context: makeContext(),
    });

    expect(scripted.getLaunchCount()).toBe(1);
    expect(scripted.gotoUrls).toHaveLength(1);
    expect(page1.runStatus).toBe('success');
    expect(page1.droppedMalformedCount).toBe(1);
    expect(page1.hasMore).toBe(true);
    expect(page1.listings).toHaveLength(2);

    expect(page1.listings[0]).toEqual({
      marketplace: 'facebook',
      marketplaceListingId: 'fb-1',
      url: 'https://www.facebook.com/marketplace/item/fb-1/',
      title: 'Patagonia Nano Puff M',
      price: 85,
      shippingPrice: null,
      shippingType: 'buyer_paid_unknown',
      listingFormat: 'fixed_price',
      bidCount: null,
      buyNowPrice: null,
      thumbnailUrl: 'https://scontent.xx.fbcdn.net/fb-1.jpg',
      conditionLabel: 'used_like_new',
      locationLabel: 'Seattle, WA',
      listedAt: new Date(1732233600 * 1000).toISOString(),
      adapterRank: 1,
      hubSlug: 'seattle',
    });
    expect('marketplace_listing_seller' in (page1.listings[0] as Record<string, unknown>)).toBe(false);

    expect(page1.listings[1]?.shippingType).toBe('local_pickup_only');
    expect(page1.listings[1]?.shippingPrice).toBeNull();
    expect(page1.listings[1]?.title).toBe('Patagonia Better Sweater Local');
    expect(page1.listings[1]?.locationLabel).toBe('Tacoma, WA');

    // Load more uses warm page scroll + GraphQL capture without extra goto
    const page2 = await adapter.loadMore({
      keywords: 'patagonia',
      unifiedFilters: filters,
      sortOrder: 'relevance',
      translation,
      context: makeContext(),
      cursor: page1.nextCursor,
      page: 2,
    });

    expect(scripted.gotoUrls).toHaveLength(1);
    expect(scripted.evaluateCalls).toHaveLength(1);
    expect(page2.runStatus).toBe('success');
    expect(page2.hasMore).toBe(false);
    expect(page2.listings.map((l) => l.marketplaceListingId)).toEqual(['fb-3']);

    await bsm.shutdown();
  });

  it('sweeps all 8 default city hubs sequentially in 1 tab with 3-5s jittered cooldowns, streams progress, deduplicates overlaps, and interleaves results', async () => {
    const scripted = createScriptedFacebookTransport({
      stepsByUrl: (url) => {
        const match = url.match(/\/marketplace\/([^/]+)\/search\//);
        const hubSlug = match?.[1] ?? 'unknown';
        return {
          html: wrapRelayHtml({
            marketplace_search: {
              feed_units: {
                edges: [
                  {
                    node: {
                      listing: {
                        id: `${hubSlug}-1`,
                        marketplace_listing_title: `Unique ${hubSlug} 1`,
                        listing_price: { amount: '50.00' },
                        is_sold: false,
                        is_pending: false,
                        delivery_types: ['IN_PERSON'],
                        creation_time: 1732233600,
                      },
                    },
                  },
                  // Shared overlapping listing ID across hubs -> deduplicated after first hub
                  {
                    node: {
                      listing: {
                        id: 'shared-overlap-id',
                        marketplace_listing_title: 'Overlapping Listing',
                        listing_price: { amount: '75.00' },
                        is_sold: false,
                        is_pending: false,
                        delivery_types: ['IN_PERSON'],
                        creation_time: 1732233600,
                      },
                    },
                  },
                  {
                    node: {
                      listing: {
                        id: `${hubSlug}-2`,
                        marketplace_listing_title: `Unique ${hubSlug} 2`,
                        listing_price: { amount: '60.00' },
                        is_sold: false,
                        is_pending: false,
                        delivery_types: ['IN_PERSON'],
                        creation_time: 1732233600,
                      },
                    },
                  },
                ],
                page_info: { end_cursor: null, has_next_page: false },
              },
            },
          }),
        };
      },
    });

    const sleepCalls: number[] = [];
    const progressUpdates: Array<{ completedCities?: number; totalCities?: number; currentCityLabel?: string | null }> = [];
    const streamedBatches: Array<{ cityHub?: string; ids: string[] }> = [];

    const bsm = new BrowserSessionManager({
      dataDir: createTempDir(),
      getBrowserChannel: () => 'chrome',
      transport: scripted.transport,
    });
    let randStep = 0;
    const adapter = createFacebookAdapter({
      browserSessionManager: bsm,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      random: () => {
        const vals = [0.0, 0.25, 0.5, 0.75, 0.99, 0.1, 0.8];
        return vals[randStep++ % vals.length]!;
      },
    });

    const filters = createDefaultUnifiedFilter(); // fulfillment: 'any', 8 default hubs
    const translation = adapter.translateFilters('jacket', filters, 'relevance', makeContext());

    const result = await adapter.executeInitial({
      keywords: 'jacket',
      unifiedFilters: filters,
      sortOrder: 'relevance',
      translation,
      context: makeContext({
        onProgress: (u) => {
          progressUpdates.push({
            completedCities: u.completedCities,
            totalCities: u.totalCities,
            currentCityLabel: u.currentCityLabel,
          });
        },
        onBatch: (b) => {
          streamedBatches.push({
            cityHub: b.cityHub,
            ids: b.listings.map((l) => l.marketplaceListingId),
          });
        },
      }),
    });

    expect(scripted.getLaunchCount()).toBe(1);
    expect(scripted.gotoUrls).toHaveLength(8);
    expect(
      scripted.gotoUrls.map((u) => u.match(/\/marketplace\/([^/]+)\/search\//)?.[1]),
    ).toEqual(['seattle', 'sanfrancisco', 'la', 'denver', 'dallas', 'chicago', 'atlanta', 'nyc']);

    // 7 jittered cooldowns between 8 consecutive navigations, all within 3000-5000ms
    expect(sleepCalls).toHaveLength(7);
    for (const ms of sleepCalls) {
      expect(ms).toBeGreaterThanOrEqual(3000);
      expect(ms).toBeLessThanOrEqual(5000);
    }

    // Progress updates City 1..8 of 8
    expect(progressUpdates.map((p) => `${p.completedCities}/${p.totalCities}`)).toEqual([
      '1/8',
      '2/8',
      '3/8',
      '4/8',
      '5/8',
      '6/8',
      '7/8',
      '8/8',
    ]);
    expect(progressUpdates[0]?.currentCityLabel).toBe('Seattle, WA');

    // Deduplicated: 8*2 unique + 1 shared = 17 Listings
    expect(result.runStatus).toBe('success');
    expect(result.listings).toHaveLength(17);
    expect(
      result.listings.filter((l) => l.marketplaceListingId === 'shared-overlap-id'),
    ).toHaveLength(1);
    expect(streamedBatches).toHaveLength(8);
    // Round-robin interleaved: first 8 listings come from the 8 different hubs
    expect(result.listings.slice(0, 8).map((l) => l.hubSlug)).toEqual([
      'seattle',
      'sanfrancisco',
      'la',
      'denver',
      'dallas',
      'chicago',
      'atlanta',
      'nyc',
    ]);

    await bsm.shutdown();
  });

  it('triggers mid-sweep circuit breaker on checkpoint, retains earlier Listings, and latches challenge_or_auth_required until cleared', async () => {
    const scripted = createScriptedFacebookTransport({
      stepsByUrl: (url) => {
        if (url.includes('/marketplace/seattle/')) {
          return {
            html: wrapRelayHtml({
              marketplace_search: {
                feed_units: {
                  edges: [
                    {
                      node: {
                        listing: {
                          id: 'sea-kept-1',
                          marketplace_listing_title: 'Kept Seattle Listing',
                          listing_price: { amount: '40.00' },
                          is_sold: false,
                          is_pending: false,
                          delivery_types: ['IN_PERSON'],
                        },
                      },
                    },
                  ],
                  page_info: { end_cursor: null, has_next_page: false },
                },
              },
            }),
          };
        }
        // Hub 2 hits Facebook security checkpoint
        return {
          finalUrl: 'https://www.facebook.com/checkpoint/?next=https://www.facebook.com/marketplace',
          title: 'Security Check Required',
          html: '<html><body><div id="checkpoint_title">Confirm your identity</div></body></html>',
        };
      },
    });

    const bsm = new BrowserSessionManager({
      dataDir: createTempDir(),
      getBrowserChannel: () => 'chrome',
      transport: scripted.transport,
    });
    const adapter = createFacebookAdapter({
      browserSessionManager: bsm,
      sleep: async () => undefined,
    });

    const filters = {
      ...createDefaultUnifiedFilter(),
      facebookLocationSlugs: ['seattle', 'sanfrancisco', 'la', 'denver'],
    };
    const translation = adapter.translateFilters('camera', filters, 'relevance', makeContext());

    const firstRun = await adapter.executeInitial({
      keywords: 'camera',
      unifiedFilters: filters,
      sortOrder: 'relevance',
      translation,
      context: makeContext(),
    });

    // Stopped immediately at hub 2 (0 retries, hubs 3 & 4 never visited)
    expect(scripted.gotoUrls).toHaveLength(2);
    expect(firstRun.runStatus).toBe('challenge_or_auth_required');
    expect(firstRun.listings.map((l) => l.marketplaceListingId)).toEqual(['sea-kept-1']);
    expect(firstRun.completedCities).toBe(1);
    expect(firstRun.totalCities).toBe(4);
    expect(adapter.isChallengeLatched()).toBe(true);

    // Subsequent run stays latched without navigating
    const latchedRun = await adapter.executeInitial({
      keywords: 'camera',
      unifiedFilters: filters,
      sortOrder: 'relevance',
      translation,
      context: makeContext(),
    });
    expect(latchedRun.runStatus).toBe('challenge_or_auth_required');
    expect(scripted.gotoUrls).toHaveLength(2);

    // Clearing latch allows navigation again
    adapter.clearChallengeLatch();
    expect(adapter.isChallengeLatched()).toBe(false);

    await bsm.shutdown();
  });

  it('returns parse_error on unrecognized HTML without Relay JSON and timeout on slow hub navigation', async () => {
    const badHtml = createScriptedFacebookTransport({
      stepsByUrl: () => ({ html: '<html><body><div>Unexpected layout</div></body></html>' }),
    });
    const bsm1 = new BrowserSessionManager({
      dataDir: createTempDir(),
      getBrowserChannel: () => 'chrome',
      transport: badHtml.transport,
    });
    const adapter1 = createFacebookAdapter({ browserSessionManager: bsm1 });
    const singleHubFilters = {
      ...createDefaultUnifiedFilter(),
      fulfillment: 'shipping' as const,
    };
    const t1 = adapter1.translateFilters('chair', singleHubFilters, 'relevance', makeContext());
    const r1 = await adapter1.executeInitial({
      keywords: 'chair',
      unifiedFilters: singleHubFilters,
      sortOrder: 'relevance',
      translation: t1,
      context: makeContext(),
    });
    expect(r1.runStatus).toBe('parse_error');
    expect(badHtml.gotoUrls).toHaveLength(1);
    await bsm1.shutdown();

    const slowNav = createScriptedFacebookTransport({
      stepsByUrl: () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ html: '<html></html>' }), 200);
        }),
    });
    const bsm2 = new BrowserSessionManager({
      dataDir: createTempDir(),
      getBrowserChannel: () => 'chrome',
      transport: slowNav.transport,
    });
    const adapter2 = createFacebookAdapter({ browserSessionManager: bsm2, timeoutMs: 25 });
    const t2 = adapter2.translateFilters('chair', singleHubFilters, 'relevance', makeContext());
    const r2 = await adapter2.executeInitial({
      keywords: 'chair',
      unifiedFilters: singleHubFilters,
      sortOrder: 'relevance',
      translation: t2,
      context: makeContext(),
    });
    expect(r2.runStatus).toBe('timeout');
    expect(slowNav.gotoUrls).toHaveLength(1);
    await bsm2.shutdown();
  });

  it('triggers challenge_or_auth_required when Facebook cookies are present without c_user', async () => {
    const guestOnly = createScriptedFacebookTransport({
      cookies: [{ name: 'datr', value: 'guest-only-cookie', domain: '.facebook.com' }],
      stepsByUrl: () => ({
        html: wrapRelayHtml({
          marketplace_search: { feed_units: { edges: [], page_info: { has_next_page: false } } },
        }),
      }),
    });
    const bsm = new BrowserSessionManager({
      dataDir: createTempDir(),
      getBrowserChannel: () => 'chrome',
      transport: guestOnly.transport,
    });
    const adapter = createFacebookAdapter({ browserSessionManager: bsm });
    const filters = createDefaultUnifiedFilter();
    const t = adapter.translateFilters('bike', filters, 'relevance', makeContext());
    const res = await adapter.executeInitial({
      keywords: 'bike',
      unifiedFilters: filters,
      sortOrder: 'relevance',
      translation: t,
      context: makeContext(),
    });

    expect(res.runStatus).toBe('challenge_or_auth_required');
    expect(guestOnly.gotoUrls).toHaveLength(1);
    expect(adapter.isChallengeLatched()).toBe(true);
    await bsm.shutdown();
  });

  it('ignores checkpoint/two_step_verification strings inside embedded <script> or <style> blocks when Relay feed_units are present', async () => {
    const relayHtml = wrapRelayHtml({
      marketplace_search: {
        feed_units: {
          edges: [
            {
              node: {
                listing: {
                  id: 'fb-script-meta-1',
                  marketplace_listing_title: 'Patagonia Torrentshell',
                  listing_price: { amount: '65.00', currency: 'USD' },
                  is_sold: false,
                  is_pending: false,
                  delivery_types: ['SHIPPING_ONSITE'],
                  creation_time: 1732233600,
                },
              },
            },
          ],
          page_info: { end_cursor: null, has_next_page: false },
        },
      },
    });
    const htmlWithScriptMeta = relayHtml.replace(
      '</body>',
      '<style>/* /checkpoint/ */</style><script type="application/json">{"29818881.two_step_verification.pre_authentication":11,"routes":["/checkpoint/"]}</script></body>',
    );

    const scripted = createScriptedFacebookTransport({
      stepsByUrl: () => ({
        title: 'Facebook',
        html: htmlWithScriptMeta,
      }),
    });
    const bsm = new BrowserSessionManager({
      dataDir: createTempDir(),
      getBrowserChannel: () => 'chrome',
      transport: scripted.transport,
    });
    const adapter = createFacebookAdapter({ browserSessionManager: bsm });
    const filters = {
      ...createDefaultUnifiedFilter(),
      fulfillment: 'shipping' as const,
    };
    const translation = adapter.translateFilters('patagonia', filters, 'relevance', makeContext());

    const result = await adapter.executeInitial({
      keywords: 'patagonia',
      unifiedFilters: filters,
      sortOrder: 'relevance',
      translation,
      context: makeContext(),
    });

    expect(result.runStatus).toBe('success');
    expect(result.listings.map((l) => l.marketplaceListingId)).toEqual(['fb-script-meta-1']);
    expect(adapter.isChallengeLatched()).toBe(false);
    await bsm.shutdown();
  });

  it('paginates all designated city hubs with next pages on loadMore using dedicated warm per-hub tabs, 3-5s cooldowns, dedup, and interleaving', async () => {
    const scrollUrls: string[] = [];
    const scripted = createScriptedFacebookTransport({
      stepsByUrl: (url) => {
        const hubSlug = url.match(/\/marketplace\/([^/]+)\/search\//)?.[1] ?? 'unknown';
        const hasNext = hubSlug !== 'sanfrancisco';
        return {
          html: wrapRelayHtml({
            marketplace_search: {
              feed_units: {
                edges: [
                  {
                    node: {
                      listing: {
                        id: `${hubSlug}-p1`,
                        marketplace_listing_title: `${hubSlug} Page 1`,
                        listing_price: { amount: '50.00' },
                        is_sold: false,
                        is_pending: false,
                        delivery_types: ['IN_PERSON'],
                        creation_time: 1732233600,
                      },
                    },
                  },
                ],
                page_info: {
                  end_cursor: hasNext ? `${hubSlug}-c1` : null,
                  has_next_page: hasNext,
                },
              },
            },
          }),
        };
      },
      onScrollLoadMore: async (_callIndex, currentUrl) => {
        scrollUrls.push(currentUrl);
        const hubSlug = currentUrl.match(/\/marketplace\/([^/]+)\/search\//)?.[1] ?? 'unknown';
        const isThirdPage = scrollUrls.filter((u) => u === currentUrl).length >= 2;
        const pageNum = isThirdPage ? 3 : 2;
        const edges: unknown[] = [
          {
            node: {
              listing: {
                id: `${hubSlug}-p${pageNum}`,
                marketplace_listing_title: `${hubSlug} Page ${pageNum}`,
                listing_price: { amount: '60.00' },
                is_sold: false,
                is_pending: false,
                delivery_types: ['IN_PERSON'],
                creation_time: 1732233600,
              },
            },
          },
        ];
        if (!isThirdPage) {
          edges.push({
            node: {
              listing: {
                id: 'shared-p2-dup',
                marketplace_listing_title: 'Shared Page 2 Dup',
                listing_price: { amount: '70.00' },
                is_sold: false,
                is_pending: false,
                delivery_types: ['IN_PERSON'],
                creation_time: 1732233600,
              },
            },
          });
        }
        return {
          body: {
            data: {
              marketplace_search: {
                feed_units: {
                  edges,
                  page_info: {
                    end_cursor: isThirdPage ? null : `${hubSlug}-c2`,
                    has_next_page: !isThirdPage,
                  },
                },
              },
            },
          },
        };
      },
    });

    const sleepCalls: number[] = [];
    const progressUpdates: Array<{
      completedCities?: number;
      totalCities?: number;
      currentCityLabel?: string | null;
    }> = [];
    const streamedBatches: Array<{ cityHub?: string; ids: string[] }> = [];

    const bsm = new BrowserSessionManager({
      dataDir: createTempDir(),
      getBrowserChannel: () => 'chrome',
      transport: scripted.transport,
    });
    const adapter = createFacebookAdapter({
      browserSessionManager: bsm,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      random: () => 0.5,
    });

    const filters = {
      ...createDefaultUnifiedFilter(),
      facebookLocationSlugs: ['seattle', 'sanfrancisco', 'la'],
    };
    const translation = adapter.translateFilters('bike', filters, 'relevance', makeContext());

    const page1 = await adapter.executeInitial({
      keywords: 'bike',
      unifiedFilters: filters,
      sortOrder: 'relevance',
      translation,
      context: makeContext(),
    });

    expect(scripted.getPageCount()).toBe(3);
    expect(scripted.gotoUrls).toHaveLength(3);
    expect(page1.hasMore).toBe(true);

    sleepCalls.length = 0;

    // Page 2: sweeps seattle and la (skips exhausted sanfrancisco) with 0 extra gotos
    const page2 = await adapter.loadMore({
      keywords: 'bike',
      unifiedFilters: filters,
      sortOrder: 'relevance',
      translation,
      context: makeContext({
        onProgress: (u) => {
          progressUpdates.push({
            completedCities: u.completedCities,
            totalCities: u.totalCities,
            currentCityLabel: u.currentCityLabel,
          });
        },
        onBatch: (b) => {
          streamedBatches.push({
            cityHub: b.cityHub,
            ids: b.listings.map((l) => l.marketplaceListingId),
          });
        },
      }),
      cursor: page1.nextCursor,
      page: 2,
    });

    expect(scripted.gotoUrls).toHaveLength(3);
    expect(scrollUrls.map((u) => u.match(/\/marketplace\/([^/]+)\/search\//)?.[1])).toEqual([
      'seattle',
      'la',
    ]);
    expect(sleepCalls).toHaveLength(1);
    expect(sleepCalls[0]).toBeGreaterThanOrEqual(3000);
    expect(sleepCalls[0]).toBeLessThanOrEqual(5000);
    expect(progressUpdates.map((p) => `${p.completedCities}/${p.totalCities}`)).toEqual(['1/2', '2/2']);
    expect(streamedBatches).toEqual([
      { cityHub: 'seattle', ids: ['seattle-p2', 'shared-p2-dup'] },
      { cityHub: 'la', ids: ['la-p2'] },
    ]);
    expect(page2.runStatus).toBe('success');
    expect(page2.hasMore).toBe(true);
    expect(page2.completedCities).toBe(2);
    expect(page2.totalCities).toBe(2);
    // Round-robin interleaved: seattle-p2, la-p2, shared-p2-dup
    expect(page2.listings.map((l) => l.marketplaceListingId)).toEqual([
      'seattle-p2',
      'la-p2',
      'shared-p2-dup',
    ]);

    // Page 3: continues on warm per-hub tabs with 0 extra gotos and exhausts hasMore
    const page3 = await adapter.loadMore({
      keywords: 'bike',
      unifiedFilters: filters,
      sortOrder: 'relevance',
      translation,
      context: makeContext(),
      cursor: page2.nextCursor,
      page: 3,
    });

    expect(scripted.gotoUrls).toHaveLength(3);
    expect(page3.runStatus).toBe('success');
    expect(page3.hasMore).toBe(false);
    expect(page3.listings.map((l) => l.marketplaceListingId)).toEqual(['seattle-p3', 'la-p3']);

    await bsm.shutdown();
  });

  it('handles mid-sweep circuit breaker, non-challenge per-hub fault isolation, and user abort during loadMore', async () => {
    const makeInitialStep = (hubSlug: string): FacebookMockStep => ({
      html: wrapRelayHtml({
        marketplace_search: {
          feed_units: {
            edges: [
              {
                node: {
                  listing: {
                    id: `${hubSlug}-init`,
                    marketplace_listing_title: `${hubSlug} Init`,
                    listing_price: { amount: '40.00' },
                    is_sold: false,
                    is_pending: false,
                    delivery_types: ['IN_PERSON'],
                  },
                },
              },
            ],
            page_info: { end_cursor: `${hubSlug}-c1`, has_next_page: true },
          },
        },
      }),
    });

    // 1. Mid-sweep challenge on hub 2 of 3 aborts immediately and retains hub 1 listings
    const scrolledChallenge: string[] = [];
    const challengeTransport = createScriptedFacebookTransport({
      stepsByUrl: (url) => makeInitialStep(url.match(/\/marketplace\/([^/]+)\/search\//)?.[1] ?? 'unknown'),
      onScrollLoadMore: async (_idx, currentUrl) => {
        const hubSlug = currentUrl.match(/\/marketplace\/([^/]+)\/search\//)?.[1] ?? 'unknown';
        scrolledChallenge.push(hubSlug);
        if (hubSlug === 'sanfrancisco') {
          return { status: 403, body: {} };
        }
        return {
          body: {
            data: {
              marketplace_search: {
                feed_units: {
                  edges: [
                    {
                      node: {
                        listing: {
                          id: `${hubSlug}-p2`,
                          marketplace_listing_title: `${hubSlug} Page 2`,
                          listing_price: { amount: '55.00' },
                          is_sold: false,
                          is_pending: false,
                          delivery_types: ['IN_PERSON'],
                        },
                      },
                    },
                  ],
                  page_info: { end_cursor: null, has_next_page: false },
                },
              },
            },
          },
        };
      },
    });
    const bsm1 = new BrowserSessionManager({
      dataDir: createTempDir(),
      getBrowserChannel: () => 'chrome',
      transport: challengeTransport.transport,
    });
    const adapter1 = createFacebookAdapter({
      browserSessionManager: bsm1,
      sleep: async () => undefined,
    });
    const filters3 = {
      ...createDefaultUnifiedFilter(),
      facebookLocationSlugs: ['seattle', 'sanfrancisco', 'la'],
    };
    const t1 = adapter1.translateFilters('camera', filters3, 'relevance', makeContext());
    const init1 = await adapter1.executeInitial({
      keywords: 'camera',
      unifiedFilters: filters3,
      sortOrder: 'relevance',
      translation: t1,
      context: makeContext(),
    });
    const lmChallenge = await adapter1.loadMore({
      keywords: 'camera',
      unifiedFilters: filters3,
      sortOrder: 'relevance',
      translation: t1,
      context: makeContext(),
      cursor: init1.nextCursor,
      page: 2,
    });
    expect(scrolledChallenge).toEqual(['seattle', 'sanfrancisco']);
    expect(lmChallenge.runStatus).toBe('challenge_or_auth_required');
    expect(lmChallenge.listings.map((l) => l.marketplaceListingId)).toEqual(['seattle-p2']);
    expect(adapter1.isChallengeLatched()).toBe(true);
    await bsm1.shutdown();

    // 2. Non-challenge parse_error on hub 1 of 2 continues to hub 2
    const faultTransport = createScriptedFacebookTransport({
      stepsByUrl: (url) => makeInitialStep(url.match(/\/marketplace\/([^/]+)\/search\//)?.[1] ?? 'unknown'),
      onScrollLoadMore: async (_idx, currentUrl) => {
        const hubSlug = currentUrl.match(/\/marketplace\/([^/]+)\/search\//)?.[1] ?? 'unknown';
        if (hubSlug === 'seattle') {
          return { body: { unexpected: true } };
        }
        return {
          body: {
            data: {
              marketplace_search: {
                feed_units: {
                  edges: [
                    {
                      node: {
                        listing: {
                          id: 'la-p2-ok',
                          marketplace_listing_title: 'LA Page 2 OK',
                          listing_price: { amount: '65.00' },
                          is_sold: false,
                          is_pending: false,
                          delivery_types: ['IN_PERSON'],
                        },
                      },
                    },
                  ],
                  page_info: { end_cursor: null, has_next_page: false },
                },
              },
            },
          },
        };
      },
    });
    const bsm2 = new BrowserSessionManager({
      dataDir: createTempDir(),
      getBrowserChannel: () => 'chrome',
      transport: faultTransport.transport,
    });
    const adapter2 = createFacebookAdapter({
      browserSessionManager: bsm2,
      sleep: async () => undefined,
    });
    const filters2 = {
      ...createDefaultUnifiedFilter(),
      facebookLocationSlugs: ['seattle', 'la'],
    };
    const t2 = adapter2.translateFilters('camera', filters2, 'relevance', makeContext());
    const init2 = await adapter2.executeInitial({
      keywords: 'camera',
      unifiedFilters: filters2,
      sortOrder: 'relevance',
      translation: t2,
      context: makeContext(),
    });
    const lmFault = await adapter2.loadMore({
      keywords: 'camera',
      unifiedFilters: filters2,
      sortOrder: 'relevance',
      translation: t2,
      context: makeContext(),
      cursor: init2.nextCursor,
      page: 2,
    });
    expect(lmFault.runStatus).toBe('success');
    expect(lmFault.listings.map((l) => l.marketplaceListingId)).toEqual(['la-p2-ok']);
    await bsm2.shutdown();

    // 3. Aborting context.signal during cooldown returns stoppedByUser: true and retains hub 1 listings
    const abortController = new AbortController();
    const abortTransport = createScriptedFacebookTransport({
      stepsByUrl: (url) => makeInitialStep(url.match(/\/marketplace\/([^/]+)\/search\//)?.[1] ?? 'unknown'),
      onScrollLoadMore: async (_idx, currentUrl) => {
        const hubSlug = currentUrl.match(/\/marketplace\/([^/]+)\/search\//)?.[1] ?? 'unknown';
        return {
          body: {
            data: {
              marketplace_search: {
                feed_units: {
                  edges: [
                    {
                      node: {
                        listing: {
                          id: `${hubSlug}-p2`,
                          marketplace_listing_title: `${hubSlug} Page 2`,
                          listing_price: { amount: '55.00' },
                          is_sold: false,
                          is_pending: false,
                          delivery_types: ['IN_PERSON'],
                        },
                      },
                    },
                  ],
                  page_info: { end_cursor: null, has_next_page: false },
                },
              },
            },
          },
        };
      },
    });
    const bsm3 = new BrowserSessionManager({
      dataDir: createTempDir(),
      getBrowserChannel: () => 'chrome',
      transport: abortTransport.transport,
    });
    let inLoadMore = false;
    const adapter3 = createFacebookAdapter({
      browserSessionManager: bsm3,
      sleep: async () => {
        if (inLoadMore) {
          abortController.abort(new Error('User stopped'));
        }
      },
    });
    const t3 = adapter3.translateFilters('camera', filters2, 'relevance', makeContext());
    const init3 = await adapter3.executeInitial({
      keywords: 'camera',
      unifiedFilters: filters2,
      sortOrder: 'relevance',
      translation: t3,
      context: makeContext(),
    });
    inLoadMore = true;
    const lmAbort = await adapter3.loadMore({
      keywords: 'camera',
      unifiedFilters: filters2,
      sortOrder: 'relevance',
      translation: t3,
      context: makeContext({ signal: abortController.signal }),
      cursor: init3.nextCursor,
      page: 2,
    });
    expect(lmAbort.stoppedByUser).toBe(true);
    expect(lmAbort.runStatus).toBe('success');
    expect(lmAbort.listings.map((l) => l.marketplaceListingId)).toEqual(['seattle-p2']);
    await bsm3.shutdown();
  });

  it('surfaces upstream non-auth Relay error details when feed_units is missing', async () => {
    const scripted = createScriptedFacebookTransport({
      stepsByUrl: () => ({
        html: wrapRelayHtml({
          errors: [
            {
              code: 1675012,
              summary: 'Rate limit exceeded',
            },
          ],
        }),
      }),
    });
    const bsm = new BrowserSessionManager({
      dataDir: createTempDir(),
      getBrowserChannel: () => 'chrome',
      transport: scripted.transport,
    });
    const adapter = createFacebookAdapter({ browserSessionManager: bsm, sleep: async () => {} });
    const filters = {
      ...createDefaultUnifiedFilter(),
      facebookLocationSlugs: ['seattle'],
    };
    const translation = adapter.translateFilters('jacket', filters, 'relevance', makeContext());

    const res = await adapter.executeInitial({
      keywords: 'jacket',
      unifiedFilters: filters,
      sortOrder: 'relevance',
      translation,
      context: makeContext(),
    });

    expect(res.runStatus).toBe('parse_error');
    expect(res.errorMessage).toContain('1675012');
    expect(res.errorMessage).toContain('Rate limit exceeded');
    await bsm.shutdown();
  });
});
