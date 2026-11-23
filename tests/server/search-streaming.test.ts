import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, type AppInstance } from '../../src/server/app.ts';
import type { MarketplaceAdapter } from '../../src/server/adapters/types.ts';
import {
  createDefaultUnifiedFilter,
  type Listing,
  type MarketplaceId,
} from '../../src/shared/index.ts';

const tempDirs: string[] = [];
const activeApps: AppInstance[] = [];

function createTempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ums-search-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (activeApps.length > 0) {
    const instance = activeApps.pop();
    if (instance) {
      await instance.shutdown();
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

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

function createUnconfiguredAdapter(marketplace: MarketplaceId): MarketplaceAdapter {
  return {
    id: marketplace,
    translateFilters(keywords) {
      return {
        marketplace,
        status: 'exact',
        notices: [],
        nativeSearchUrl: `https://example.com/${marketplace}?q=${encodeURIComponent(keywords.trim())}`,
      };
    },
    async executeInitial() {
      return {
        runStatus: 'unconfigured',
        listings: [],
        droppedMalformedCount: 0,
        hasMore: false,
        errorMessage: `${marketplace} is not configured in this test.`,
      };
    },
    async loadMore() {
      return {
        runStatus: 'empty',
        listings: [],
        droppedMalformedCount: 0,
        hasMore: false,
      };
    },
  };
}

function makeFakeListing(
  marketplace: MarketplaceId,
  id: string,
  price: number,
  rank: number,
): Listing {
  return {
    marketplace,
    marketplaceListingId: id,
    url: `https://example.com/${marketplace}/${id}`,
    title: `${marketplace} item ${id}`,
    price,
    shippingPrice: 0,
    shippingType: 'free',
    listingFormat: 'fixed_price',
    bidCount: null,
    buyNowPrice: null,
    thumbnailUrl: `https://example.com/${id}.jpg`,
    conditionLabel: 'Good',
    locationLabel: 'Seattle, WA',
    listedAt: '2026-11-22T00:00:00Z',
    adapterRank: rank,
  };
}

describe('Search streaming orchestrator & HTTP API', () => {
  it('validates search requests (non-empty trimmed keywords, >=1 marketplace, 0 <= priceMin <= priceMax)', async () => {
    const instance = createApp({ dataDir: createTempDataDir(), env: {} });
    activeApps.push(instance);

    const emptyKeywords = await instance.app.request('/api/searches/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keywords: '   ',
        unifiedFilters: createDefaultUnifiedFilter(),
        marketplaces: ['ebay'],
        sortOrder: 'relevance',
      }),
    });
    expect(emptyKeywords.status).toBe(400);

    const noMarketplaces = await instance.app.request('/api/searches/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keywords: 'patagonia',
        unifiedFilters: createDefaultUnifiedFilter(),
        marketplaces: [],
        sortOrder: 'relevance',
      }),
    });
    expect(noMarketplaces.status).toBe(400);

    const invertedPrices = await instance.app.request('/api/searches/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keywords: 'patagonia',
        unifiedFilters: {
          ...createDefaultUnifiedFilter(),
          priceMin: 100,
          priceMax: 50,
        },
        marketplaces: ['ebay'],
        sortOrder: 'relevance',
      }),
    });
    expect(invertedPrices.status).toBe(400);
  });

  it('wires live eBay OAuth verification and streams run_started, listings_batch, marketplace_status, and run_complete', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'https://api.ebay.com/identity/v1/oauth2/token') {
        return new Response(
          JSON.stringify({ access_token: 'live-oauth-token', expires_in: 7200 }),
          { status: 200 },
        );
      }
      if (url.startsWith('https://api.ebay.com/buy/browse/v1/item_summary/search')) {
        return new Response(
          JSON.stringify({
            total: 2,
            offset: 0,
            limit: 48,
            itemSummaries: [
              {
                itemId: 'e1',
                title: 'Patagonia Fleece',
                itemWebUrl: 'https://www.ebay.com/itm/e1',
                price: { value: '45.00', currency: 'USD' },
                buyingOptions: ['FIXED_PRICE'],
              },
              // Exceeds priceMax 80 -> post-filtered out by orchestrator/adapter
              {
                itemId: 'e2',
                title: 'Patagonia Too Expensive',
                itemWebUrl: 'https://www.ebay.com/itm/e2',
                price: { value: '120.00', currency: 'USD' },
                buyingOptions: ['FIXED_PRICE'],
              },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const instance = createApp({
      dataDir: createTempDataDir(),
      env: {
        EBAY_CLIENT_ID: 'ebay-id',
        EBAY_CLIENT_SECRET: 'ebay-secret',
      },
      fetchImpl: fetchMock,
      adapters: {
        facebook: createUnconfiguredAdapter('facebook'),
      },
    });
    activeApps.push(instance);

    const verifyRes = await instance.app.request('/api/settings/ebay/verify', { method: 'POST' });
    expect(verifyRes.status).toBe(200);
    expect(await verifyRes.json()).toEqual({ valid: true, origin: 'env' });

    const streamRes = await instance.app.request('/api/searches/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keywords: 'patagonia',
        unifiedFilters: {
          ...createDefaultUnifiedFilter(),
          priceMin: 20,
          priceMax: 80,
        },
        marketplaces: ['ebay', 'facebook'],
        sortOrder: 'relevance',
      }),
    });
    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get('content-type')).toContain('text/event-stream');

    const events = await readSseEvents(streamRes);
    const runStarted = events.find((e) => e.event === 'run_started');
    expect(runStarted).toBeDefined();
    expect(typeof runStarted?.data.searchRunId).toBe('string');

    const ebayBatch = events.find(
      (e) => e.event === 'listings_batch' && e.data.marketplace === 'ebay',
    );
    expect(ebayBatch).toBeDefined();
    expect((ebayBatch?.data.listings as Listing[])).toHaveLength(1);
    expect((ebayBatch?.data.listings as Listing[])[0]?.marketplaceListingId).toBe('e1');

    const runComplete = events.find((e) => e.event === 'run_complete');
    expect(runComplete).toBeDefined();
    const statuses = runComplete?.data.statuses as Record<string, { runStatus: string }>;
    expect(statuses.ebay?.runStatus).toBe('success');
    // Unimplemented browser placeholder returns unconfigured cleanly without failing eBay
    expect(statuses.facebook?.runStatus).toBe('unconfigured');
  });

  it('caches successful batches for 60s, enforces post-filters, bypasses cache on refresh/retry, and advances load-more', async () => {
    let now = 1_700_000_000_000;
    let initialCalls = 0;
    let loadMoreCalls = 0;

    const fakeEbay: MarketplaceAdapter = {
      id: 'ebay',
      translateFilters(keywords) {
        return {
          marketplace: 'ebay',
          status: 'exact',
          notices: [],
          nativeSearchUrl: `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(keywords)}`,
        };
      },
      async executeInitial() {
        initialCalls += 1;
        return {
          runStatus: 'success',
          // Includes an out-of-range item ($5) to verify orchestrator enforces priceMin/priceMax
          listings: [
            makeFakeListing('ebay', `p1-${initialCalls}`, 40, 1),
            makeFakeListing('ebay', `cheap-${initialCalls}`, 5, 2),
          ],
          droppedMalformedCount: 0,
          hasMore: true,
          nextCursor: { page: 2 },
        };
      },
      async loadMore({ page }) {
        loadMoreCalls += 1;
        return {
          runStatus: 'success',
          listings: [makeFakeListing('ebay', `p${page}-${loadMoreCalls}`, 50, 3)],
          droppedMalformedCount: 0,
          hasMore: false,
        };
      },
    };

    const instance = createApp({
      dataDir: createTempDataDir(),
      env: {},
      clock: () => now,
      adapters: { ebay: fakeEbay },
    });
    activeApps.push(instance);

    const payload = {
      keywords: 'thinkpad',
      unifiedFilters: { ...createDefaultUnifiedFilter(), priceMin: 20, priceMax: 100 },
      marketplaces: ['ebay'],
      sortOrder: 'relevance',
    };

    // 1st run -> executes adapter (1 call)
    const res1 = await instance.app.request('/api/searches/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const events1 = await readSseEvents(res1);
    const runId1 = events1.find((e) => e.event === 'run_started')?.data.searchRunId as string;
    const batch1 = events1.find((e) => e.event === 'listings_batch')?.data.listings as Listing[];
    expect(initialCalls).toBe(1);
    expect(batch1.map((l) => l.marketplaceListingId)).toEqual(['p1-1']);

    // 30s later -> identical query hits 60s cache (still 1 call)
    now += 30_000;
    const res2 = await instance.app.request('/api/searches/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    await readSseEvents(res2);
    expect(initialCalls).toBe(1);

    // Explicit refresh: true bypasses 60s cache (2 calls)
    const res3 = await instance.app.request('/api/searches/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, refresh: true }),
    });
    const events3 = await readSseEvents(res3);
    const runId3 = events3.find((e) => e.event === 'run_started')?.data.searchRunId as string;
    expect(initialCalls).toBe(2);

    // Retry single marketplace bypasses 60s cache (3 calls)
    const retryRes = await instance.app.request(`/api/searches/${runId3}/retry/ebay`, {
      method: 'POST',
    });
    expect(retryRes.status).toBe(200);
    const retryEvents = await readSseEvents(retryRes);
    const retryBatch = retryEvents.find((e) => e.event === 'listings_batch')?.data.listings as Listing[];
    expect(initialCalls).toBe(3);
    expect(retryBatch[0]?.marketplaceListingId).toBe('p1-3');

    // Load more advances cursor on active run
    const loadMoreRes = await instance.app.request(`/api/searches/${runId3}/load-more`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ marketplace: 'ebay' }),
    });
    expect(loadMoreRes.status).toBe(200);
    const loadMoreEvents = await readSseEvents(loadMoreRes);
    const lmBatch = loadMoreEvents.find((e) => e.event === 'listings_batch')?.data.listings as Listing[];
    expect(loadMoreCalls).toBe(1);
    expect(lmBatch[0]?.marketplaceListingId).toBe('p2-1');

    // After 61s from refresh, cache expires (4 calls)
    now += 61_000;
    const res4 = await instance.app.request('/api/searches/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    await readSseEvents(res4);
    expect(initialCalls).toBe(4);
    expect(runId1).not.toBe(runId3);
  });

  it('cancels prior active search run cleanly when a new search run starts', async () => {
    let firstAborted = false;
    let resolveFirstStarted: (() => void) | null = null;
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirstStarted = resolve;
    });

    let callIndex = 0;
    const slowAdapter: MarketplaceAdapter = {
      id: 'ebay',
      translateFilters(keywords) {
        return {
          marketplace: 'ebay',
          status: 'exact',
          notices: [],
          nativeSearchUrl: `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(keywords)}`,
        };
      },
      async executeInitial({ context }) {
        callIndex += 1;
        if (callIndex === 1) {
          resolveFirstStarted?.();
          await new Promise<void>((resolve) => {
            context.signal?.addEventListener(
              'abort',
              () => {
                firstAborted = true;
                resolve();
              },
              { once: true },
            );
          });
          return {
            runStatus: 'network_error',
            listings: [],
            droppedMalformedCount: 0,
            hasMore: false,
            errorMessage: 'Cancelled',
          };
        }
        return {
          runStatus: 'success',
          listings: [makeFakeListing('ebay', 'fast-2', 30, 1)],
          droppedMalformedCount: 0,
          hasMore: false,
        };
      },
      async loadMore() {
        return { runStatus: 'empty', listings: [], droppedMalformedCount: 0, hasMore: false };
      },
    };

    const instance = createApp({
      dataDir: createTempDataDir(),
      env: {},
      adapters: { ebay: slowAdapter },
    });
    activeApps.push(instance);

    const req1Promise = instance.app.request('/api/searches/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keywords: 'first query',
        unifiedFilters: createDefaultUnifiedFilter(),
        marketplaces: ['ebay'],
        sortOrder: 'relevance',
      }),
    });

    await firstStarted;

    const res2 = await instance.app.request('/api/searches/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keywords: 'second query',
        unifiedFilters: createDefaultUnifiedFilter(),
        marketplaces: ['ebay'],
        sortOrder: 'relevance',
      }),
    });
    const events2 = await readSseEvents(res2);
    expect(firstAborted).toBe(true);
    expect(events2.find((e) => e.event === 'run_complete')).toBeDefined();

    const res1 = await req1Promise;
    await readSseEvents(res1);
  });

  it('streams incremental onBatch and onProgress during Facebook loadMore without duplicate batches or double-counted loadedCount, and latches challenges', async () => {
    let loadMoreCall = 0;
    const fbAdapter: MarketplaceAdapter = {
      id: 'facebook',
      translateFilters(keywords) {
        return {
          marketplace: 'facebook',
          status: 'exact',
          notices: [],
          nativeSearchUrl: `https://www.facebook.com/marketplace/seattle/search/?query=${encodeURIComponent(keywords)}`,
        };
      },
      async executeInitial() {
        return {
          runStatus: 'success',
          listings: [makeFakeListing('facebook', 'init-1', 40, 1)],
          droppedMalformedCount: 0,
          hasMore: true,
          nextCursor: { page: 1 },
          completedCities: 2,
          totalCities: 2,
          currentCityLabel: null,
        };
      },
      async loadMore({ context }) {
        loadMoreCall += 1;
        if (loadMoreCall === 1) {
          const sea = { ...makeFakeListing('facebook', 'sea-p2', 50, 1), hubSlug: 'seattle' };
          const la = { ...makeFakeListing('facebook', 'la-p2', 55, 1), hubSlug: 'la' };
          context.onProgress?.({
            runStatus: 'running',
            completedCities: 1,
            totalCities: 2,
            currentCityLabel: 'Seattle, WA',
          });
          context.onBatch?.({ listings: [sea], cityHub: 'seattle', hasMore: true });
          context.onProgress?.({
            runStatus: 'running',
            completedCities: 2,
            totalCities: 2,
            currentCityLabel: 'Los Angeles, CA',
          });
          context.onBatch?.({ listings: [la], cityHub: 'la', hasMore: true });
          return {
            runStatus: 'success',
            listings: [sea, la],
            droppedMalformedCount: 0,
            hasMore: true,
            nextCursor: { page: 2 },
            completedCities: 2,
            totalCities: 2,
            currentCityLabel: null,
          };
        }
        return {
          runStatus: 'challenge_or_auth_required',
          listings: [],
          droppedMalformedCount: 0,
          hasMore: false,
          errorMessage: 'Checkpoint reached during loadMore',
        };
      },
    };

    const instance = createApp({
      dataDir: createTempDataDir(),
      env: {},
      adapters: { facebook: fbAdapter },
    });
    activeApps.push(instance);

    const initRes = await instance.app.request('/api/searches/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keywords: 'jacket',
        unifiedFilters: createDefaultUnifiedFilter(),
        marketplaces: ['facebook'],
        sortOrder: 'relevance',
      }),
    });
    const initEvents = await readSseEvents(initRes);
    const runId = initEvents.find((e) => e.event === 'run_started')?.data.searchRunId as string;

    const lm1Res = await instance.app.request(`/api/searches/${runId}/load-more`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ marketplace: 'facebook' }),
    });
    expect(lm1Res.status).toBe(200);
    const lm1Events = await readSseEvents(lm1Res);
    const lm1Batches = lm1Events.filter((e) => e.event === 'listings_batch');
    expect(lm1Batches).toHaveLength(2);
    expect(lm1Batches.map((b) => b.data.cityHub)).toEqual(['seattle', 'la']);

    const lm1RunComplete = lm1Events.find((e) => e.event === 'run_complete');
    const fbStatus1 = (lm1RunComplete?.data.statuses as Record<string, Record<string, unknown>>)
      .facebook;
    expect(fbStatus1?.loadedCount).toBe(3);
    expect(fbStatus1?.completedCities).toBe(2);
    expect(fbStatus1?.totalCities).toBe(2);
    expect(fbStatus1?.currentCityLabel).toBeNull();

    // Second loadMore returns challenge_or_auth_required -> latches facebook for subsequent runs
    const lm2Res = await instance.app.request(`/api/searches/${runId}/load-more`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ marketplace: 'facebook' }),
    });
    await readSseEvents(lm2Res);

    const latchedRes = await instance.app.request('/api/searches/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keywords: 'jacket 2',
        unifiedFilters: createDefaultUnifiedFilter(),
        marketplaces: ['facebook'],
        sortOrder: 'relevance',
      }),
    });
    const latchedEvents = await readSseEvents(latchedRes);
    const latchedComplete = latchedEvents.find((e) => e.event === 'run_complete');
    const fbStatusLatched = (
      latchedComplete?.data.statuses as Record<string, Record<string, unknown>>
    ).facebook;
    expect(fbStatusLatched?.runStatus).toBe('challenge_or_auth_required');
  });
});
