import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, type AppInstance } from '../../src/server/app.ts';
import {
  BrowserSessionManager,
  type BrowserContextHandle,
  type BrowserPageHandle,
  type BrowserResponseHandle,
  type BrowserTransport,
} from '../../src/server/browser-session-manager.ts';
import { createMercariAdapter, type MercariCursor } from '../../src/server/adapters/mercari.ts';
import {
  createDefaultAppSettings,
  createDefaultUnifiedFilter,
  type Listing,
} from '../../src/shared/index.ts';
import type { AdapterExecutionContext } from '../../src/server/adapters/types.ts';

function makeContext(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    settings: createDefaultAppSettings(),
    ...overrides,
  };
}

const tempDirs: string[] = [];
const activeApps: AppInstance[] = [];

interface ParsedSseEvent {
  event: string;
  data: Record<string, unknown>;
}

async function readSseEvents(response: Response): Promise<ParsedSseEvent[]> {
  const text = await response.text();
  const blocks = text.split(/\r?\n\r?\n/).filter((b) => b.trim().length > 0);
  const events: ParsedSseEvent[] = [];
  for (const block of blocks) {
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) {
        eventName = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trim());
      }
    }
    if (dataLines.length > 0) {
      events.push({
        event: eventName,
        data: JSON.parse(dataLines.join('\n')) as Record<string, unknown>,
      });
    }
  }
  return events;
}

interface MercariMockScript {
  navStatus?: number;
  navFinalUrl?: string;
  navTitle?: string;
  navHtml?: string;
  initialFacetResponse?: {
    url?: string;
    status?: number;
    body: unknown;
    delayMs?: number;
  };
  scrollFacetResponses?: Array<{
    url?: string;
    status?: number;
    body: unknown;
    delayMs?: number;
  }>;
}

function createScriptedMercariTransport(script: MercariMockScript) {
  const gotoUrls: string[] = [];
  const scrollCalls: number[] = [];
  let currentUrl = 'about:blank';
  let launchCount = 0;
  let scrollIndex = 0;
  const responseListeners = new Set<(res: BrowserResponseHandle) => void>();

  const emitResponse = (res: BrowserResponseHandle) => {
    for (const listener of [...responseListeners]) {
      listener(res);
    }
  };

  const toResponseHandle = (spec: {
    url?: string;
    status?: number;
    body: unknown;
  }): BrowserResponseHandle => ({
    url: () =>
      spec.url ?? 'https://www.mercari.com/v1/api?operationName=searchFacetQuery&variables={}',
    status: () => spec.status ?? 200,
    json: async () => spec.body,
  });

  const transport: BrowserTransport = {
    async launchPersistentContext(): Promise<BrowserContextHandle> {
      launchCount += 1;
      let pendingWaiter: {
        predicate: string | ((res: BrowserResponseHandle) => boolean | Promise<boolean>);
        resolve: (res: BrowserResponseHandle) => void;
        reject: (err: Error) => void;
      } | null = null;

      const deliverResponse = async (res: BrowserResponseHandle) => {
        emitResponse(res);
        if (pendingWaiter) {
          const waiter = pendingWaiter;
          const matches =
            typeof waiter.predicate === 'string'
              ? res.url().includes(waiter.predicate)
              : await waiter.predicate(res);
          if (matches) {
            pendingWaiter = null;
            waiter.resolve(res);
          }
        }
      };

      const page: BrowserPageHandle = {
        async goto(url: string) {
          gotoUrls.push(url);
          currentUrl = script.navFinalUrl ?? url;
          if (script.initialFacetResponse && (script.navStatus ?? 200) < 400) {
            const spec = script.initialFacetResponse;
            const fire = () => {
              void deliverResponse(toResponseHandle(spec));
            };
            if (spec.delayMs && spec.delayMs > 0) {
              setTimeout(fire, spec.delayMs);
            } else {
              queueMicrotask(fire);
            }
          }
          return {
            url: () => currentUrl,
            status: () => script.navStatus ?? 200,
            json: async () => ({}),
          };
        },
        url: () => currentUrl,
        title: async () => script.navTitle ?? 'Mercari Search',
        content: async () => script.navHtml ?? '<html><body></body></html>',
        async evaluate<R>(_fn: unknown): Promise<R> {
          scrollCalls.push(scrollIndex);
          const spec = script.scrollFacetResponses?.[scrollIndex];
          scrollIndex += 1;
          if (spec) {
            const fire = () => {
              void deliverResponse(toResponseHandle(spec));
            };
            if (spec.delayMs && spec.delayMs > 0) {
              setTimeout(fire, spec.delayMs);
            } else {
              queueMicrotask(fire);
            }
          }
          return undefined as R;
        },
        waitForResponse(predicate, options) {
          return new Promise<BrowserResponseHandle>((resolve, reject) => {
            const timeoutMs = options?.timeout ?? 5000;
            const timer = setTimeout(() => {
              if (pendingWaiter?.resolve === wrappedResolve) {
                pendingWaiter = null;
              }
              reject(
                Object.assign(new Error('waitForResponse timed out'), { name: 'TimeoutError' }),
              );
            }, timeoutMs);
            const wrappedResolve = (res: BrowserResponseHandle) => {
              clearTimeout(timer);
              resolve(res);
            };
            const wrappedReject = (err: Error) => {
              clearTimeout(timer);
              reject(err);
            };
            pendingWaiter = { predicate, resolve: wrappedResolve, reject: wrappedReject };
          });
        },
        on(event, listener) {
          if (event === 'response') {
            responseListeners.add(listener);
          }
        },
        off(event, listener) {
          if (event === 'response') {
            responseListeners.delete(listener);
          }
        },
        close: async () => undefined,
        isClosed: () => false,
      };

      return {
        pages: () => [page],
        newPage: async () => page,
        cookies: async () => [],
        close: async () => undefined,
        on: () => undefined,
      };
    },
  };

  return {
    transport,
    gotoUrls,
    scrollCalls,
    getLaunchCount: () => launchCount,
  };
}

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ums-mercari-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (activeApps.length > 0) {
    const app = activeApps.pop();
    if (app) {
      await app.shutdown();
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('MercariAdapter', () => {
  it('translates Unified Filters into integer-cent prices, hyphen-joined itemConditions, sortBy, itemStatuses=1, and skips local_pickup without launching browser', async () => {
    const launchSpy = vi.fn();
    const transport: BrowserTransport = {
      launchPersistentContext: launchSpy,
    };
    const bsm = new BrowserSessionManager({
      dataDir: createTempDir(),
      getBrowserChannel: () => 'chrome',
      transport,
    });
    const adapter = createMercariAdapter({ browserSessionManager: bsm });

    const exact = adapter.translateFilters(
      '  sony walkman  ',
      {
        ...createDefaultUnifiedFilter(),
        priceMin: 12.5,
        priceMax: 150,
        conditions: ['new', 'like_new', 'good', 'fair', 'poor'],
        fulfillment: 'shipping',
      },
      'price_asc',
      makeContext(),
    );

    expect(exact.status).toBe('exact');
    expect(exact.notices).toEqual([]);
    const parsedExact = new URL(exact.nativeSearchUrl);
    expect(parsedExact.origin + parsedExact.pathname).toBe('https://www.mercari.com/search/');
    expect(parsedExact.searchParams.get('keyword')).toBe('sony walkman');
    expect(parsedExact.searchParams.get('itemStatuses')).toBe('1');
    expect(parsedExact.searchParams.get('minPrice')).toBe('1250');
    expect(parsedExact.searchParams.get('maxPrice')).toBe('15000');
    expect(parsedExact.searchParams.get('itemConditions')).toBe('1-2-3-4-5');
    expect(parsedExact.searchParams.get('sortBy')).toBe('3');

    const newestSubset = adapter.translateFilters(
      'nintendo 64',
      {
        ...createDefaultUnifiedFilter(),
        conditions: ['new', 'like_new'],
      },
      'newest',
      makeContext(),
    );
    expect(newestSubset.status).toBe('exact');
    const parsedSubset = new URL(newestSubset.nativeSearchUrl);
    expect(parsedSubset.searchParams.get('itemConditions')).toBe('1-2');
    expect(parsedSubset.searchParams.get('sortBy')).toBe('2');
    expect(parsedSubset.searchParams.has('minPrice')).toBe(false);
    expect(parsedSubset.searchParams.has('maxPrice')).toBe(false);

    const skipped = adapter.translateFilters(
      'desk',
      {
        ...createDefaultUnifiedFilter(),
        fulfillment: 'local_pickup',
      },
      'relevance',
      makeContext(),
    );
    expect(skipped.status).toBe('skipped_unsupported');

    const skipResult = await adapter.executeInitial({
      keywords: 'desk',
      unifiedFilters: { ...createDefaultUnifiedFilter(), fulfillment: 'local_pickup' },
      sortOrder: 'relevance',
      translation: skipped,
      context: makeContext(),
    });
    expect(skipResult.runStatus).toBe('skipped_unsupported');
    expect(skipResult.listings).toEqual([]);
    expect(launchSpy).not.toHaveBeenCalled();
  });

  it('intercepts searchFacetQuery, converts cents to USD, normalizes null grid shipping, tolerates malformed/non-listing nodes, and scrolls once for Load more', async () => {
    const scripted = createScriptedMercariTransport({
      initialFacetResponse: {
        body: {
          data: {
            search: {
              nextKey: 'cursor-page-2',
              searchId: 'search-abc-123',
              initRequestTime: 1763800000,
              offset: 100,
              itemsList: [
                // 1. Valid on_sale item with photos[0].thumbnail & seller PII to strip
                {
                  id: 'm1001',
                  name: 'Sony Walkman WM-EX190',
                  price: 4599,
                  status: 'on_sale',
                  created: 1763790000,
                  shippingPayer: null,
                  shippingClass: null,
                  photos: [
                    {
                      thumbnail: 'https://u-mercari-images.mercdn.net/photos/m1001_thumb.jpg',
                      imageUrl: 'https://u-mercari-images.mercdn.net/photos/m1001.jpg',
                    },
                  ],
                  itemCondition: { id: 3, name: 'Good' },
                  seller: { id: 'seller-99', name: 'PrivateSeller' },
                },
                // 2. Fallback to photos[0].imageUrl when thumbnail is null
                {
                  id: 'm1002',
                  name: 'Sony Walkman WM-FX290',
                  price: 2500,
                  status: 'on_sale',
                  created: 1763780000,
                  shippingPayer: null,
                  shippingClass: null,
                  photos: [
                    {
                      thumbnail: null,
                      imageUrl: 'https://u-mercari-images.mercdn.net/photos/m1002.jpg',
                    },
                  ],
                },
                // 3. Sold item -> filtered out by status === 'on_sale'
                {
                  id: 'm1003-sold',
                  name: 'Sony Walkman Sold',
                  price: 4000,
                  status: 'sold_out',
                  created: 1763770000,
                },
                // 4. Out-of-bounds price ($150.00 > $100 max) -> post-filtered
                {
                  id: 'm1004-over',
                  name: 'Sony Walkman Too Expensive',
                  price: 15000,
                  status: 'on_sale',
                  created: 1763760000,
                },
                // 5. Non-Listing / malformed module -> droppedMalformedCount++
                {
                  __typename: 'SearchPromoBanner',
                  headline: 'Save on electronics',
                },
              ],
            },
          },
        },
      },
      scrollFacetResponses: [
        {
          body: {
            data: {
              search: {
                nextKey: '0',
                searchId: 'search-abc-123',
                initRequestTime: 1763800000,
                offset: 200,
                itemsList: [
                  {
                    id: 'm1005',
                    name: 'Sony Walkman Sports WM-FS395',
                    price: 5250,
                    status: 'on_sale',
                    created: 1763750000,
                    shippingPayer: null,
                    shippingClass: null,
                    photos: [{ thumbnail: 'https://u-mercari-images.mercdn.net/photos/m1005.jpg' }],
                  },
                ],
              },
            },
          },
        },
      ],
    });

    const bsm = new BrowserSessionManager({
      dataDir: createTempDir(),
      getBrowserChannel: () => 'chrome',
      transport: scripted.transport,
    });
    const adapter = createMercariAdapter({ browserSessionManager: bsm });

    const filters = {
      ...createDefaultUnifiedFilter(),
      priceMin: 20,
      priceMax: 100,
      conditions: ['good'] as const,
    };
    const translation = adapter.translateFilters(
      'sony walkman',
      { ...filters, conditions: [...filters.conditions] },
      'relevance',
      makeContext(),
    );

    const page1 = await adapter.executeInitial({
      keywords: 'sony walkman',
      unifiedFilters: { ...filters, conditions: [...filters.conditions] },
      sortOrder: 'relevance',
      translation,
      context: makeContext(),
    });

    expect(scripted.getLaunchCount()).toBe(1);
    expect(scripted.gotoUrls).toHaveLength(1);
    expect(scripted.gotoUrls[0]).toContain('https://www.mercari.com/search/');
    expect(scripted.scrollCalls).toHaveLength(0);

    expect(page1.runStatus).toBe('success');
    expect(page1.droppedMalformedCount).toBe(1);
    expect(page1.hasMore).toBe(true);
    expect(page1.listings).toHaveLength(2);

    expect(page1.listings[0]).toEqual({
      marketplace: 'mercari',
      marketplaceListingId: 'm1001',
      url: 'https://www.mercari.com/us/item/m1001/',
      title: 'Sony Walkman WM-EX190',
      price: 45.99,
      shippingPrice: null,
      shippingType: 'unknown',
      listingFormat: 'fixed_price',
      bidCount: null,
      buyNowPrice: null,
      thumbnailUrl: 'https://u-mercari-images.mercdn.net/photos/m1001_thumb.jpg',
      conditionLabel: 'Good',
      locationLabel: null,
      listedAt: new Date(1763790000 * 1000).toISOString(),
      adapterRank: 1,
    });
    expect('seller' in (page1.listings[0] as Record<string, unknown>)).toBe(false);

    expect(page1.listings[1]?.price).toBe(25);
    expect(page1.listings[1]?.thumbnailUrl).toBe(
      'https://u-mercari-images.mercdn.net/photos/m1002.jpg',
    );

    const cursor = page1.nextCursor as MercariCursor;
    expect(cursor.nextKey).toBe('cursor-page-2');
    expect(cursor.searchId).toBe('search-abc-123');
    expect(cursor.initRequestTime).toBe(1763800000);
    expect(cursor.offset).toBe(100);

    // Load more executes 1 controlled scroll step on the warm page (no extra goto)
    const page2 = await adapter.loadMore({
      keywords: 'sony walkman',
      unifiedFilters: { ...filters, conditions: [...filters.conditions] },
      sortOrder: 'relevance',
      translation,
      context: makeContext(),
      cursor: page1.nextCursor,
      page: 2,
    });

    expect(scripted.getLaunchCount()).toBe(1);
    expect(scripted.gotoUrls).toHaveLength(1);
    expect(scripted.scrollCalls).toHaveLength(1);
    expect(page2.runStatus).toBe('success');
    expect(page2.hasMore).toBe(false); // nextKey === "0" signals end of feed
    expect(page2.listings).toHaveLength(1);
    expect(page2.listings[0]?.marketplaceListingId).toBe('m1005');
    expect(page2.listings[0]?.price).toBe(52.5);
    expect(page2.listings[0]?.adapterRank).toBe(6);

    await bsm.shutdown();
  });

  it('fails soft into challenge_or_auth_required with 0 auto-retries on Cloudflare 403, Turnstile/Just a moment, /v1/api 401, or login redirect', async () => {
    const filters = createDefaultUnifiedFilter();

    // 1. HTTP 403 on navigation
    const cf403 = createScriptedMercariTransport({ navStatus: 403 });
    const bsm1 = new BrowserSessionManager({
      dataDir: createTempDir(),
      getBrowserChannel: () => 'chrome',
      transport: cf403.transport,
    });
    const a1 = createMercariAdapter({ browserSessionManager: bsm1 });
    const t1 = a1.translateFilters('camera', filters, 'relevance', makeContext());
    const r1 = await a1.executeInitial({
      keywords: 'camera',
      unifiedFilters: filters,
      sortOrder: 'relevance',
      translation: t1,
      context: makeContext(),
    });
    expect(r1.runStatus).toBe('challenge_or_auth_required');
    expect(cf403.gotoUrls).toHaveLength(1); // 0 auto-retries
    await bsm1.shutdown();

    // 2. Cloudflare "Just a moment..." / Turnstile challenge DOM
    const turnstile = createScriptedMercariTransport({
      navTitle: 'Just a moment...',
      navHtml: '<html><body><div class="cf-turnstile"></div></body></html>',
    });
    const bsm2 = new BrowserSessionManager({
      dataDir: createTempDir(),
      getBrowserChannel: () => 'chrome',
      transport: turnstile.transport,
    });
    const a2 = createMercariAdapter({ browserSessionManager: bsm2 });
    const t2 = a2.translateFilters('camera', filters, 'relevance', makeContext());
    const r2 = await a2.executeInitial({
      keywords: 'camera',
      unifiedFilters: filters,
      sortOrder: 'relevance',
      translation: t2,
      context: makeContext(),
    });
    expect(r2.runStatus).toBe('challenge_or_auth_required');
    expect(turnstile.gotoUrls).toHaveLength(1);
    await bsm2.shutdown();

    // 3. 401 Unauthorized on /v1/api?operationName=searchFacetQuery
    const api401 = createScriptedMercariTransport({
      initialFacetResponse: {
        status: 401,
        body: { error: 'Unauthorized' },
      },
    });
    const bsm3 = new BrowserSessionManager({
      dataDir: createTempDir(),
      getBrowserChannel: () => 'chrome',
      transport: api401.transport,
    });
    const a3 = createMercariAdapter({ browserSessionManager: bsm3 });
    const t3 = a3.translateFilters('camera', filters, 'relevance', makeContext());
    const r3 = await a3.executeInitial({
      keywords: 'camera',
      unifiedFilters: filters,
      sortOrder: 'relevance',
      translation: t3,
      context: makeContext(),
    });
    expect(r3.runStatus).toBe('challenge_or_auth_required');
    expect(api401.gotoUrls).toHaveLength(1);
    await bsm3.shutdown();

    // 4. Login wall redirect
    const loginRedirect = createScriptedMercariTransport({
      navFinalUrl: 'https://www.mercari.com/login/?next=%2Fsearch%2F',
    });
    const bsm4 = new BrowserSessionManager({
      dataDir: createTempDir(),
      getBrowserChannel: () => 'chrome',
      transport: loginRedirect.transport,
    });
    const a4 = createMercariAdapter({ browserSessionManager: bsm4 });
    const t4 = a4.translateFilters('camera', filters, 'relevance', makeContext());
    const r4 = await a4.executeInitial({
      keywords: 'camera',
      unifiedFilters: filters,
      sortOrder: 'relevance',
      translation: t4,
      context: makeContext(),
    });
    expect(r4.runStatus).toBe('challenge_or_auth_required');
    expect(loginRedirect.gotoUrls).toHaveLength(1);
    await bsm4.shutdown();
  });

  it('returns parse_error on unrecognized envelope or all-malformed nodes, empty on zero results, and timeout on slow searchFacetQuery', async () => {
    const filters = createDefaultUnifiedFilter();

    // 1. Unrecognized envelope
    const badEnvelope = createScriptedMercariTransport({
      initialFacetResponse: { body: { unexpected: true } },
    });
    const bsm1 = new BrowserSessionManager({
      dataDir: createTempDir(),
      getBrowserChannel: () => 'chrome',
      transport: badEnvelope.transport,
    });
    const a1 = createMercariAdapter({ browserSessionManager: bsm1 });
    const t1 = a1.translateFilters('camera', filters, 'relevance', makeContext());
    const r1 = await a1.executeInitial({
      keywords: 'camera',
      unifiedFilters: filters,
      sortOrder: 'relevance',
      translation: t1,
      context: makeContext(),
    });
    expect(r1.runStatus).toBe('parse_error');
    await bsm1.shutdown();

    // 2. rawCount > 0 && validCount === 0 -> parse_error
    const allMalformed = createScriptedMercariTransport({
      initialFacetResponse: {
        body: {
          data: {
            search: {
              itemsList: [{ bad: 'node' }, { alsoBad: 123 }],
            },
          },
        },
      },
    });
    const bsm2 = new BrowserSessionManager({
      dataDir: createTempDir(),
      getBrowserChannel: () => 'chrome',
      transport: allMalformed.transport,
    });
    const a2 = createMercariAdapter({ browserSessionManager: bsm2 });
    const t2 = a2.translateFilters('camera', filters, 'relevance', makeContext());
    const r2 = await a2.executeInitial({
      keywords: 'camera',
      unifiedFilters: filters,
      sortOrder: 'relevance',
      translation: t2,
      context: makeContext(),
    });
    expect(r2.runStatus).toBe('parse_error');
    expect(r2.droppedMalformedCount).toBe(2);
    await bsm2.shutdown();

    // 3. Empty itemsList -> empty
    const emptySearch = createScriptedMercariTransport({
      initialFacetResponse: {
        body: {
          data: {
            search: {
              nextKey: null,
              itemsList: [],
            },
          },
        },
      },
    });
    const bsm3 = new BrowserSessionManager({
      dataDir: createTempDir(),
      getBrowserChannel: () => 'chrome',
      transport: emptySearch.transport,
    });
    const a3 = createMercariAdapter({ browserSessionManager: bsm3 });
    const t3 = a3.translateFilters('camera', filters, 'relevance', makeContext());
    const r3 = await a3.executeInitial({
      keywords: 'camera',
      unifiedFilters: filters,
      sortOrder: 'relevance',
      translation: t3,
      context: makeContext(),
    });
    expect(r3.runStatus).toBe('empty');
    expect(r3.listings).toEqual([]);
    expect(r3.hasMore).toBe(false);
    await bsm3.shutdown();

    // 4. Slow response -> timeout with 0 auto-retries
    const slowSearch = createScriptedMercariTransport({
      initialFacetResponse: {
        delayMs: 200,
        body: { data: { search: { itemsList: [] } } },
      },
    });
    const bsm4 = new BrowserSessionManager({
      dataDir: createTempDir(),
      getBrowserChannel: () => 'chrome',
      transport: slowSearch.transport,
    });
    const a4 = createMercariAdapter({ browserSessionManager: bsm4, timeoutMs: 25 });
    const t4 = a4.translateFilters('camera', filters, 'relevance', makeContext());
    const r4 = await a4.executeInitial({
      keywords: 'camera',
      unifiedFilters: filters,
      sortOrder: 'relevance',
      translation: t4,
      context: makeContext(),
    });
    expect(r4.runStatus).toBe('timeout');
    expect(slowSearch.gotoUrls).toHaveLength(1);
    await bsm4.shutdown();
  });

  it('wires MercariAdapter as default in createApp, streams search + load-more, and recovers after challenge via open-session + retry', async () => {
    let phase: 'challenged' | 'fg' | 'recovered' = 'challenged';
    const launches: Array<{ isBackground: boolean; gotoUrls: string[] }> = [];

    const transport: BrowserTransport = {
      async launchPersistentContext(_dir, options): Promise<BrowserContextHandle> {
        const isBackground = options.headless;
        const rec = { isBackground, gotoUrls: [] as string[] };
        launches.push(rec);
        let currentUrl = 'about:blank';
        let pendingWaiter: {
          predicate: string | ((res: BrowserResponseHandle) => boolean | Promise<boolean>);
          resolve: (res: BrowserResponseHandle) => void;
        } | null = null;
        const closeListeners: Array<() => void> = [];

        const emit = async (url: string, status: number, body: unknown) => {
          const res: BrowserResponseHandle = {
            url: () => url,
            status: () => status,
            json: async () => body,
          };
          if (pendingWaiter) {
            const w = pendingWaiter;
            const matches =
              typeof w.predicate === 'string'
                ? res.url().includes(w.predicate)
                : await w.predicate(res);
            if (matches) {
              pendingWaiter = null;
              w.resolve(res);
            }
          }
        };

        const page: BrowserPageHandle = {
          async goto(url: string) {
            currentUrl = url;
            rec.gotoUrls.push(url);
            if (isBackground && phase === 'challenged') {
              return {
                url: () => currentUrl,
                status: () => 403,
                json: async () => ({}),
              };
            }
            if (isBackground && phase === 'recovered') {
              queueMicrotask(() => {
                void emit('https://www.mercari.com/v1/api?operationName=searchFacetQuery', 200, {
                  data: {
                    search: {
                      nextKey: 'page-2-key',
                      searchId: 's-1',
                      initRequestTime: 1763800000,
                      offset: 100,
                      itemsList: [
                        {
                          id: 'm-rec-1',
                          name: 'Leica M6 Body',
                          price: 250000,
                          status: 'on_sale',
                          created: 1763790000,
                          shippingPayer: null,
                          shippingClass: null,
                          photos: [
                            { thumbnail: 'https://u-mercari-images.mercdn.net/photos/m-rec-1.jpg' },
                          ],
                        },
                      ],
                    },
                  },
                });
              });
            }
            return {
              url: () => currentUrl,
              status: () => 200,
              json: async () => ({}),
            };
          },
          url: () => currentUrl,
          title: async () => 'Mercari',
          content: async () => '<html><body></body></html>',
          async evaluate<R>(): Promise<R> {
            queueMicrotask(() => {
              void emit('https://www.mercari.com/v1/api?operationName=searchFacetQuery', 200, {
                data: {
                  search: {
                    nextKey: '0',
                    searchId: 's-1',
                    initRequestTime: 1763800000,
                    offset: 200,
                    itemsList: [
                      {
                        id: 'm-rec-2',
                        name: 'Leica Summicron 35mm',
                        price: 180000,
                        status: 'on_sale',
                        created: 1763780000,
                        shippingPayer: null,
                        shippingClass: null,
                      },
                    ],
                  },
                },
              });
            });
            return undefined as R;
          },
          waitForResponse(predicate, options) {
            return new Promise<BrowserResponseHandle>((resolve, reject) => {
              const timer = setTimeout(
                () => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })),
                options?.timeout ?? 5000,
              );
              pendingWaiter = {
                predicate,
                resolve: (res) => {
                  clearTimeout(timer);
                  resolve(res);
                },
              };
            });
          },
          close: async () => undefined,
          isClosed: () => false,
        };

        return {
          pages: () => [page],
          newPage: async () => page,
          cookies: async () => [],
          async close() {
            for (const l of [...closeListeners]) {
              l();
            }
          },
          on(event, listener) {
            if (event === 'close') {
              closeListeners.push(listener);
            }
          },
        };
      },
    };

    const instance = createApp({
      dataDir: createTempDir(),
      env: {},
      browserTransport: transport,
    });
    activeApps.push(instance);

    // 1. Initial search hits 403 challenge -> fails soft
    const res1 = await instance.app.request('/api/searches/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keywords: 'leica',
        unifiedFilters: createDefaultUnifiedFilter(),
        marketplaces: ['mercari'],
        sortOrder: 'relevance',
      }),
    });
    expect(res1.status).toBe(200);
    const events1 = await readSseEvents(res1);
    const runId = events1.find((e) => e.event === 'run_started')?.data.searchRunId as string;
    const complete1 = events1.find((e) => e.event === 'run_complete')?.data.statuses as Record<
      string,
      { runStatus: string }
    >;
    expect(complete1.mercari?.runStatus).toBe('challenge_or_auth_required');

    // 2. Open foreground browser session
    phase = 'fg';
    const openRes = await instance.app.request('/api/browser/mercari/open-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.mercari.com/search/?keyword=leica' }),
    });
    expect(openRes.status).toBe(200);

    // 3. Retry Mercari -> recovers listing with integer-cent conversion
    phase = 'recovered';
    const retryRes = await instance.app.request(`/api/searches/${runId}/retry/mercari`, {
      method: 'POST',
    });
    expect(retryRes.status).toBe(200);
    const retryEvents = await readSseEvents(retryRes);
    const batch1 = retryEvents.find((e) => e.event === 'listings_batch')?.data
      .listings as Listing[];
    expect(batch1).toHaveLength(1);
    expect(batch1[0]?.marketplaceListingId).toBe('m-rec-1');
    expect(batch1[0]?.price).toBe(2500);
    expect(batch1[0]?.shippingType).toBe('unknown');
    expect(batch1[0]?.shippingPrice).toBeNull();

    // 4. Load more on warm page
    const lmRes = await instance.app.request(`/api/searches/${runId}/load-more`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ marketplace: 'mercari' }),
    });
    expect(lmRes.status).toBe(200);
    const lmEvents = await readSseEvents(lmRes);
    const batch2 = lmEvents.find((e) => e.event === 'listings_batch')?.data.listings as Listing[];
    expect(batch2).toHaveLength(1);
    expect(batch2[0]?.marketplaceListingId).toBe('m-rec-2');
    expect(batch2[0]?.price).toBe(1800);
    expect(launches.filter((l) => l.isBackground)).toHaveLength(2);
    expect(launches.filter((l) => !l.isBackground)).toHaveLength(1);
  });

  it('does not emit an unhandled rejection when waitForResponse resolves after waiter is cancelled on 403/challenge', async () => {
    let resolveWaitForResponse!: (res: BrowserResponseHandle) => void;
    const deferredResponse = new Promise<BrowserResponseHandle>((resolve) => {
      resolveWaitForResponse = resolve;
    });

    const page: BrowserPageHandle = {
      url: () => 'https://www.mercari.com/search/?keyword=jacket',
      goto: async () => ({
        url: () => 'https://www.mercari.com/search/?keyword=jacket',
        status: () => 403,
        json: async () => ({}),
      }),
      title: async () => 'Access Denied',
      content: async () => '<html><body>Blocked</body></html>',
      evaluate: (async () => undefined) as BrowserPageHandle['evaluate'],
      waitForResponse: () => deferredResponse,
      close: async () => undefined,
      isClosed: () => false,
    };

    const transport: BrowserTransport = {
      async launchPersistentContext(): Promise<BrowserContextHandle> {
        return {
          pages: () => [page],
          newPage: async () => page,
          cookies: async () => [],
          close: async () => undefined,
          on: () => undefined,
        };
      },
    };

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ums-mercari-cancel-'));
    tempDirs.push(dataDir);

    const browserSessionManager = new BrowserSessionManager({
      dataDir,
      getBrowserChannel: () => 'chrome',
      transport,
    });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      const adapter = createMercariAdapter({ browserSessionManager });
      const filters = createDefaultUnifiedFilter();
      const translation = adapter.translateFilters('jacket', filters, 'relevance', makeContext());
      const result = await adapter.executeInitial({
        keywords: 'jacket',
        translation,
        unifiedFilters: filters,
        sortOrder: 'relevance',
        context: makeContext(),
      });

      expect(result.runStatus).toBe('challenge_or_auth_required');

      resolveWaitForResponse({
        url: () => 'https://www.mercari.com/v1/api?operationName=searchFacetQuery',
        status: () => 200,
        json: async () => ({}),
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await browserSessionManager.shutdown();
    }
  });

  it('surfaces upstream Mercari GraphQL error code and message when searchFacetQuery returns errors', async () => {
    const scripted = createScriptedMercariTransport({
      initialFacetResponse: {
        status: 200,
        body: {
          errors: [
            {
              message: 'Invalid sort parameter',
              extensions: { code: 'BAD_USER_INPUT' },
            },
          ],
        },
      },
    });
    const bsm = new BrowserSessionManager({
      dataDir: createTempDir(),
      getBrowserChannel: () => 'chrome',
      transport: scripted.transport,
    });
    const adapter = createMercariAdapter({ browserSessionManager: bsm });
    const filters = createDefaultUnifiedFilter();
    const translation = adapter.translateFilters('jacket', filters, 'relevance', makeContext());

    const res = await adapter.executeInitial({
      keywords: 'jacket',
      unifiedFilters: filters,
      sortOrder: 'relevance',
      translation,
      context: makeContext(),
    });

    expect(res.runStatus).toBe('parse_error');
    expect(res.errorMessage).toContain('BAD_USER_INPUT');
    expect(res.errorMessage).toContain('Invalid sort parameter');
    await bsm.shutdown();
  });
});
