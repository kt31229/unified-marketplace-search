import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type AppInstance } from '../../src/server/app.ts';
import type { MarketplaceAdapter } from '../../src/server/adapters/types.ts';
import {
  createDefaultUnifiedFilter,
  sortListings,
  type Listing,
  type MarketplaceId,
} from '../../src/shared/index.ts';

const tempDirs: string[] = [];
const activeApps: AppInstance[] = [];

function createTempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ums-agg-test-'));
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

function makeListing(
  marketplace: MarketplaceId,
  id: string,
  overrides: Partial<Listing> = {},
): Listing {
  return {
    marketplace,
    marketplaceListingId: id,
    url: `https://example.com/${marketplace}/${id}`,
    title: `${marketplace} ${id}`,
    price: 50,
    shippingPrice: 0,
    shippingType: 'free',
    listingFormat: 'fixed_price',
    bidCount: null,
    buyNowPrice: null,
    thumbnailUrl: `https://example.com/${id}.jpg`,
    conditionLabel: 'Good',
    locationLabel: 'Seattle, WA',
    listedAt: '2026-11-22T00:00:00Z',
    adapterRank: 1,
    ...overrides,
  };
}

function makeFakeAdapter(
  id: MarketplaceId,
  executeInitialImpl: MarketplaceAdapter['executeInitial'],
  loadMoreImpl?: MarketplaceAdapter['loadMore'],
): MarketplaceAdapter {
  return {
    id,
    translateFilters(keywords) {
      return {
        marketplace: id,
        status: 'exact',
        notices: [],
        nativeSearchUrl: `https://example.com/search/${id}?q=${encodeURIComponent(keywords)}`,
      };
    },
    executeInitial: executeInitialImpl,
    loadMore:
      loadMoreImpl ??
      (async () => ({
        runStatus: 'empty',
        listings: [],
        droppedMalformedCount: 0,
        hasMore: false,
      })),
  };
}

describe('Cross-Marketplace aggregation and sorting invariants', () => {
  it('interleaves relevance round-robin across active Marketplaces AND across Facebook City Hubs', async () => {
    const ebay = makeFakeAdapter('ebay', async () => ({
      runStatus: 'success',
      listings: [
        makeListing('ebay', 'e1', { adapterRank: 1 }),
        makeListing('ebay', 'e2', { adapterRank: 2 }),
        makeListing('ebay', 'e3', { adapterRank: 3 }),
      ],
      droppedMalformedCount: 0,
      hasMore: false,
    }));

    const poshmark = makeFakeAdapter('poshmark', async () => ({
      runStatus: 'success',
      listings: [
        makeListing('poshmark', 'p1', { adapterRank: 1 }),
        makeListing('poshmark', 'p2', { adapterRank: 2 }),
      ],
      droppedMalformedCount: 0,
      hasMore: false,
    }));

    const mercari = makeFakeAdapter('mercari', async () => ({
      runStatus: 'success',
      listings: [makeListing('mercari', 'm1', { adapterRank: 1 })],
      droppedMalformedCount: 0,
      hasMore: false,
    }));

    // Seattle emits ranks 1..3, San Francisco emits ranks 4..5 (cumulative ranks across hubs).
    // Round-robin across hubs ensures Seattle does not monopolize all early Facebook slots.
    const facebook = makeFakeAdapter('facebook', async ({ context }) => {
      const seattle = [
        makeListing('facebook', 'fb-sea-1', { adapterRank: 1 }),
        makeListing('facebook', 'fb-sea-2', { adapterRank: 2 }),
        makeListing('facebook', 'fb-sea-3', { adapterRank: 3 }),
      ];
      const sf = [
        makeListing('facebook', 'fb-sf-1', { adapterRank: 4 }),
        makeListing('facebook', 'fb-sf-2', { adapterRank: 5 }),
      ];
      const la = [makeListing('facebook', 'fb-la-1', { adapterRank: 6 })];

      context.onBatch?.({ listings: seattle, cityHub: 'seattle', hasMore: true });
      context.onBatch?.({ listings: sf, cityHub: 'sanfrancisco', hasMore: true });
      context.onBatch?.({ listings: la, cityHub: 'la', hasMore: false });

      return {
        runStatus: 'success',
        listings: [...seattle, ...sf, ...la],
        droppedMalformedCount: 0,
        hasMore: false,
        completedCities: 3,
        totalCities: 3,
      };
    });

    const instance = createApp({
      dataDir: createTempDataDir(),
      env: {},
      adapters: { ebay, poshmark, mercari, facebook },
    });
    activeApps.push(instance);

    const res = await instance.app.request('/api/searches/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keywords: 'patagonia',
        unifiedFilters: createDefaultUnifiedFilter(),
        marketplaces: ['ebay', 'poshmark', 'mercari', 'facebook'],
        sortOrder: 'relevance',
      }),
    });
    expect(res.status).toBe(200);

    const events = await readSseEvents(res);
    const streamedListings = events
      .filter((e) => e.event === 'listings_batch')
      .flatMap((e) => e.data.listings as Listing[]);

    const orderedIds = sortListings(streamedListings, 'relevance').map(
      (l) => l.marketplaceListingId,
    );

    // Round 1: e1, p1, m1, fb-sea-1
    // Round 2: e2, p2, fb-sf-1
    // Round 3: e3, fb-la-1
    // Round 4: fb-sea-2
    // Round 5: fb-sf-2
    // Round 6: fb-sea-3
    expect(orderedIds).toEqual([
      'e1',
      'p1',
      'm1',
      'fb-sea-1',
      'e2',
      'p2',
      'fb-sf-1',
      'e3',
      'fb-la-1',
      'fb-sea-2',
      'fb-sf-2',
      'fb-sea-3',
    ]);
  });

  it('sorts newest globally across all 4 Marketplaces and places null/invalid listedAt after timestamped Listings ordered by adapterRank', async () => {
    const ebay = makeFakeAdapter('ebay', async () => ({
      runStatus: 'success',
      listings: [
        makeListing('ebay', 'e-mid', { listedAt: '2026-11-21T10:00:00Z', adapterRank: 1 }),
        makeListing('ebay', 'e-null-r3', { listedAt: null, adapterRank: 3 }),
      ],
      droppedMalformedCount: 0,
      hasMore: false,
    }));
    const poshmark = makeFakeAdapter('poshmark', async () => ({
      runStatus: 'success',
      listings: [
        makeListing('poshmark', 'p-newest', { listedAt: '2026-11-22T09:00:00Z', adapterRank: 2 }),
        makeListing('poshmark', 'p-invalid-r1', { listedAt: 'not-a-date', adapterRank: 1 }),
      ],
      droppedMalformedCount: 0,
      hasMore: false,
    }));
    const mercari = makeFakeAdapter('mercari', async () => ({
      runStatus: 'success',
      listings: [
        makeListing('mercari', 'm-oldest', { listedAt: '2026-11-20T08:00:00Z', adapterRank: 1 }),
      ],
      droppedMalformedCount: 0,
      hasMore: false,
    }));
    const facebook = makeFakeAdapter('facebook', async () => ({
      runStatus: 'success',
      listings: [
        makeListing('facebook', 'fb-newer', { listedAt: '2026-11-22T01:00:00Z', adapterRank: 4 }),
        makeListing('facebook', 'fb-null-r2', { listedAt: null, adapterRank: 2 }),
      ],
      droppedMalformedCount: 0,
      hasMore: false,
    }));

    const instance = createApp({
      dataDir: createTempDataDir(),
      env: {},
      adapters: { ebay, poshmark, mercari, facebook },
    });
    activeApps.push(instance);

    const res = await instance.app.request('/api/searches/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keywords: 'jacket',
        unifiedFilters: createDefaultUnifiedFilter(),
        marketplaces: ['ebay', 'poshmark', 'mercari', 'facebook'],
        sortOrder: 'newest',
      }),
    });
    const events = await readSseEvents(res);
    const streamed = events
      .filter((e) => e.event === 'listings_batch')
      .flatMap((e) => e.data.listings as Listing[]);

    expect(sortListings(streamed, 'newest').map((l) => l.marketplaceListingId)).toEqual([
      'p-newest',
      'fb-newer',
      'e-mid',
      'm-oldest',
      'p-invalid-r1',
      'fb-null-r2',
      'e-null-r3',
    ]);
  });

  it('sorts price_asc and price_desc by base price with known-total tie-breaker and supports includeKnownShippingInPriceSort', async () => {
    const ebay = makeFakeAdapter('ebay', async () => ({
      runStatus: 'success',
      listings: [
        // Base 45 + $10 shipping = $55 total
        makeListing('ebay', 'e-45-ship10', {
          price: 45,
          shippingPrice: 10,
          shippingType: 'known',
          adapterRank: 1,
        }),
        // Base 50 + $0 free shipping = $50 total
        makeListing('ebay', 'e-50-free', {
          price: 50,
          shippingPrice: 0,
          shippingType: 'free',
          adapterRank: 2,
        }),
      ],
      droppedMalformedCount: 0,
      hasMore: false,
    }));
    const poshmark = makeFakeAdapter('poshmark', async () => ({
      runStatus: 'success',
      listings: [
        // Base 50 + $6.49 shipping = $56.49 total
        makeListing('poshmark', 'p-50-ship649', {
          price: 50,
          shippingPrice: 6.49,
          shippingType: 'known',
          adapterRank: 1,
        }),
      ],
      droppedMalformedCount: 0,
      hasMore: false,
    }));
    const mercari = makeFakeAdapter('mercari', async () => ({
      runStatus: 'success',
      listings: [
        // Base 50 + unknown shipping (sorts after known-total $50/$56.49 ties)
        makeListing('mercari', 'm-50-unknown', {
          price: 50,
          shippingPrice: null,
          shippingType: 'unknown',
          adapterRank: 1,
        }),
      ],
      droppedMalformedCount: 0,
      hasMore: false,
    }));

    const instance = createApp({
      dataDir: createTempDataDir(),
      env: {},
      adapters: { ebay, poshmark, mercari },
    });
    activeApps.push(instance);

    const res = await instance.app.request('/api/searches/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keywords: 'fleece',
        unifiedFilters: createDefaultUnifiedFilter(),
        marketplaces: ['ebay', 'poshmark', 'mercari'],
        sortOrder: 'price_asc',
      }),
    });
    const events = await readSseEvents(res);
    const streamed = events
      .filter((e) => e.event === 'listings_batch')
      .flatMap((e) => e.data.listings as Listing[]);

    // Base price_asc: 45, then 50 ties ordered by known total (50.00 < 56.49 < unknown)
    expect(sortListings(streamed, 'price_asc').map((l) => l.marketplaceListingId)).toEqual([
      'e-45-ship10',
      'e-50-free',
      'p-50-ship649',
      'm-50-unknown',
    ]);

    // Base price_desc: 50 ties ordered by known total descending (56.49 > 50.00, then unknown), then 45
    expect(sortListings(streamed, 'price_desc').map((l) => l.marketplaceListingId)).toEqual([
      'p-50-ship649',
      'e-50-free',
      'm-50-unknown',
      'e-45-ship10',
    ]);

    // Shipping-inclusive price_asc: effective totals e-50-free (50, known), m-50-unknown (50, unknown), e-45-ship10 (55), p-50-ship649 (56.49)
    expect(
      sortListings(streamed, 'price_asc', { includeKnownShippingInPriceSort: true }).map(
        (l) => l.marketplaceListingId,
      ),
    ).toEqual(['e-50-free', 'm-50-unknown', 'e-45-ship10', 'p-50-ship649']);

    // Shipping-inclusive price_desc: p-50-ship649 (56.49), e-45-ship10 (55), e-50-free (50, known), m-50-unknown (50, unknown)
    expect(
      sortListings(streamed, 'price_desc', { includeKnownShippingInPriceSort: true }).map(
        (l) => l.marketplaceListingId,
      ),
    ).toEqual(['p-50-ship649', 'e-45-ship10', 'e-50-free', 'm-50-unknown']);
  });

  it('activates a previously unqueried Marketplace on an active searchRunId via retry/:marketplace and supports subsequent load-more', async () => {
    let ebayCalls = 0;
    let poshmarkInitialCalls = 0;
    let poshmarkLoadMoreCalls = 0;

    const ebay = makeFakeAdapter('ebay', async () => {
      ebayCalls += 1;
      return {
        runStatus: 'success',
        listings: [makeListing('ebay', 'e1', { adapterRank: 1 })],
        droppedMalformedCount: 0,
        hasMore: false,
      };
    });

    const poshmark = makeFakeAdapter(
      'poshmark',
      async () => {
        poshmarkInitialCalls += 1;
        return {
          runStatus: 'success',
          listings: [makeListing('poshmark', 'p1', { adapterRank: 1 })],
          droppedMalformedCount: 0,
          hasMore: true,
          nextCursor: 'ENC_2',
        };
      },
      async ({ cursor }) => {
        poshmarkLoadMoreCalls += 1;
        expect(cursor).toBe('ENC_2');
        return {
          runStatus: 'success',
          listings: [makeListing('poshmark', 'p2', { adapterRank: 2 })],
          droppedMalformedCount: 0,
          hasMore: false,
        };
      },
    );

    const instance = createApp({
      dataDir: createTempDataDir(),
      env: {},
      adapters: { ebay, poshmark },
    });
    activeApps.push(instance);

    const initialRes = await instance.app.request('/api/searches/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keywords: 'patagonia',
        unifiedFilters: createDefaultUnifiedFilter(),
        marketplaces: ['ebay'],
        sortOrder: 'relevance',
      }),
    });
    const initialEvents = await readSseEvents(initialRes);
    const runId = initialEvents.find((e) => e.event === 'run_started')?.data.searchRunId as string;
    expect(ebayCalls).toBe(1);
    expect(poshmarkInitialCalls).toBe(0);

    // Mid-run activation of previously unqueried Poshmark
    const activateRes = await instance.app.request(`/api/searches/${runId}/retry/poshmark`, {
      method: 'POST',
    });
    expect(activateRes.status).toBe(200);
    const activateEvents = await readSseEvents(activateRes);
    expect(ebayCalls).toBe(1);
    expect(poshmarkInitialCalls).toBe(1);

    const poshBatch = activateEvents.find(
      (e) => e.event === 'listings_batch' && e.data.marketplace === 'poshmark',
    );
    expect((poshBatch?.data.listings as Listing[]).map((l) => l.marketplaceListingId)).toEqual([
      'p1',
    ]);

    const activateComplete = activateEvents.find((e) => e.event === 'run_complete');
    const completeStatuses = activateComplete?.data.statuses as Record<
      string,
      { runStatus: string; loadedCount: number }
    >;
    expect(completeStatuses.ebay?.runStatus).toBe('success');
    expect(completeStatuses.poshmark?.runStatus).toBe('success');
    expect(completeStatuses.poshmark?.loadedCount).toBe(1);

    // Subsequent load-more advances newly activated Poshmark cursor
    const lmRes = await instance.app.request(`/api/searches/${runId}/load-more`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ marketplace: 'poshmark' }),
    });
    expect(lmRes.status).toBe(200);
    const lmEvents = await readSseEvents(lmRes);
    expect(poshmarkLoadMoreCalls).toBe(1);
    const lmBatch = lmEvents.find((e) => e.event === 'listings_batch');
    expect((lmBatch?.data.listings as Listing[]).map((l) => l.marketplaceListingId)).toEqual([
      'p2',
    ]);
  });
});
