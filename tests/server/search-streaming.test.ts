import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, type AppInstance } from '../../src/server/app.ts';
import { createBrowserPlaceholderAdapter } from '../../src/server/adapters/placeholders.ts';
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
        facebook: createBrowserPlaceholderAdapter('facebook'),
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
});
