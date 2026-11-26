import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type AppInstance } from '../../src/server/app.ts';
import { createDefaultUnifiedFilter } from '../../src/shared/index.ts';

const tempDirs: string[] = [];
const activeApps: AppInstance[] = [];

function createTempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ums-saved-searches-test-'));
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

describe('Saved Searches SQLite persistence and HTTP API', () => {
  it('runs migration v2, validates POST /api/saved-searches, allows duplicate names, and persists across restarts', async () => {
    const dataDir = createTempDataDir();
    const first = createApp({ dataDir, env: {} });
    activeApps.push(first);

    expect(first.database.getUserVersion()).toBeGreaterThanOrEqual(2);

    const emptyRes = await first.app.request('/api/saved-searches');
    expect(emptyRes.status).toBe(200);
    expect(await emptyRes.json()).toEqual({ savedSearches: [] });

    // Rejects blank trimmed keywords
    const blankKwRes = await first.app.request('/api/saved-searches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Blank keywords',
        keywords: '   ',
        unifiedFilters: createDefaultUnifiedFilter(),
        marketplaces: ['ebay'],
        sortOrder: 'relevance',
      }),
    });
    expect(blankKwRes.status).toBe(400);

    // Rejects empty marketplaces array
    const noMpRes = await first.app.request('/api/saved-searches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'No Marketplaces',
        keywords: 'patagonia',
        unifiedFilters: createDefaultUnifiedFilter(),
        marketplaces: [],
        sortOrder: 'relevance',
      }),
    });
    expect(noMpRes.status).toBe(400);

    // Creates first Saved Search
    const filtersA = {
      ...createDefaultUnifiedFilter(),
      priceMin: 25,
      priceMax: 150,
      conditions: ['like_new', 'good'] as const,
      fulfillment: 'shipping' as const,
    };
    const createA = await first.app.request('/api/saved-searches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Patagonia Jacket',
        keywords: '  patagonia nano puff  ',
        unifiedFilters: filtersA,
        marketplaces: ['ebay', 'poshmark'],
        sortOrder: 'price_asc',
      }),
    });
    expect(createA.status).toBe(201);
    const bodyA = await createA.json();
    expect(bodyA.savedSearch).toMatchObject({
      name: 'Patagonia Jacket',
      keywords: 'patagonia nano puff',
      marketplaces: ['ebay', 'poshmark'],
      sortOrder: 'price_asc',
      lastRunAt: null,
    });
    expect(bodyA.savedSearch.id).toBeTypeOf('string');
    expect(bodyA.savedSearch.unifiedFilters.priceMin).toBe(25);
    expect(bodyA.savedSearch.unifiedFilters.priceMax).toBe(150);

    // Permits duplicate name tracked by unique id
    const createB = await first.app.request('/api/saved-searches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Patagonia Jacket',
        keywords: 'patagonia down sweater',
        unifiedFilters: createDefaultUnifiedFilter(),
        marketplaces: ['ebay'],
        sortOrder: 'newest',
      }),
    });
    expect(createB.status).toBe(201);
    const bodyB = await createB.json();
    expect(bodyB.savedSearch.name).toBe('Patagonia Jacket');
    expect(bodyB.savedSearch.id).not.toBe(bodyA.savedSearch.id);

    await first.shutdown();
    activeApps.pop();

    // Persists across restart
    const second = createApp({ dataDir, env: {} });
    activeApps.push(second);

    const listRes = await second.app.request('/api/saved-searches');
    expect(listRes.status).toBe(200);
    const listJson = await listRes.json();
    expect(listJson.savedSearches).toHaveLength(2);
    expect(listJson.savedSearches.map((s: { id: string }) => s.id)).toEqual([
      bodyB.savedSearch.id,
      bodyA.savedSearch.id,
    ]);
  });

  it('supports PATCH rename/update, DELETE, and POST /run updating lastRunAt in place without re-ordering', async () => {
    let nowMs = Date.parse('2026-11-22T12:00:00Z');
    const instance = createApp({
      dataDir: createTempDataDir(),
      env: {},
      clock: () => nowMs,
    });
    activeApps.push(instance);

    const createOne = async (name: string, keywords: string) => {
      const res = await instance.app.request('/api/saved-searches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          keywords,
          unifiedFilters: createDefaultUnifiedFilter(),
          marketplaces: ['ebay'],
          sortOrder: 'relevance',
        }),
      });
      expect(res.status).toBe(201);
      return (await res.json()).savedSearch as {
        id: string;
        name: string;
        lastRunAt: string | null;
      };
    };

    const first = await createOne('First', 'jacket');
    nowMs += 1000;
    const second = await createOne('Second', 'boots');
    nowMs += 1000;
    const third = await createOne('Third', 'backpack');

    // Newly created items prepend: [third, second, first]
    const initialList = (await (await instance.app.request('/api/saved-searches')).json())
      .savedSearches as Array<{ id: string }>;
    expect(initialList.map((s) => s.id)).toEqual([third.id, second.id, first.id]);

    // Running `first` updates lastRunAt without changing display_order
    nowMs += 5000;
    const runRes = await instance.app.request(`/api/saved-searches/${first.id}/run`, {
      method: 'POST',
    });
    expect(runRes.status).toBe(200);
    const runBody = await runRes.json();
    expect(runBody.savedSearch.lastRunAt).toBe(new Date(nowMs).toISOString());

    const afterRunList = (await (await instance.app.request('/api/saved-searches')).json())
      .savedSearches as Array<{ id: string; lastRunAt: string | null }>;
    expect(afterRunList.map((s) => s.id)).toEqual([third.id, second.id, first.id]);
    expect(afterRunList[2]?.lastRunAt).toBe(new Date(nowMs).toISOString());

    // PATCH inline rename + update fields without altering display_order
    const renameRes = await instance.app.request(`/api/saved-searches/${second.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Winter Boots',
        sortOrder: 'price_asc',
      }),
    });
    expect(renameRes.status).toBe(200);
    const renamed = (await renameRes.json()).savedSearch;
    expect(renamed.name).toBe('Winter Boots');
    expect(renamed.sortOrder).toBe('price_asc');

    // Invalid PATCH -> 400; missing id -> 404
    const badPatch = await instance.app.request(`/api/saved-searches/${second.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '   ' }),
    });
    expect(badPatch.status).toBe(400);

    const missingPatch = await instance.app.request('/api/saved-searches/does-not-exist', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Nope' }),
    });
    expect(missingPatch.status).toBe(404);

    const afterPatchList = (await (await instance.app.request('/api/saved-searches')).json())
      .savedSearches as Array<{ id: string; name: string }>;
    expect(afterPatchList.map((s) => s.id)).toEqual([third.id, second.id, first.id]);

    // DELETE removes entry
    const delRes = await instance.app.request(`/api/saved-searches/${second.id}`, {
      method: 'DELETE',
    });
    expect(delRes.status).toBe(200);
    const missingDel = await instance.app.request(`/api/saved-searches/${second.id}`, {
      method: 'DELETE',
    });
    expect(missingDel.status).toBe(404);

    const afterDelList = (await (await instance.app.request('/api/saved-searches')).json())
      .savedSearches as Array<{ id: string }>;
    expect(afterDelList.map((s) => s.id)).toEqual([third.id, first.id]);
  });

  it('tolerates an unconfigured Marketplace when running a Saved Search and still runs remaining Marketplaces', async () => {
    const instance = createApp({
      dataDir: createTempDataDir(),
      env: {}, // eBay unconfigured
      adapters: {
        poshmark: {
          id: 'poshmark',
          translateFilters: (keywords) => ({
            marketplace: 'poshmark',
            status: 'exact',
            notices: [],
            nativeSearchUrl: `https://poshmark.com/search?query=${encodeURIComponent(keywords)}`,
          }),
          executeInitial: async () => ({
            listings: [
              {
                marketplace: 'poshmark',
                marketplaceListingId: 'pm-1',
                url: 'https://poshmark.com/listing/pm-1',
                title: 'Patagonia Fleece Poshmark',
                price: 45,
                shippingPrice: 6.49,
                shippingType: 'known',
                listingFormat: 'fixed_price',
                bidCount: null,
                buyNowPrice: null,
                thumbnailUrl: null,
                conditionLabel: 'Good',
                locationLabel: null,
                listedAt: '2026-11-22T00:00:00Z',
                adapterRank: 1,
              },
            ],
            hasMore: false,
            nextCursor: undefined,
            droppedMalformedCount: 0,
            runStatus: 'success',
          }),
          loadMore: async () => ({
            listings: [],
            hasMore: false,
            nextCursor: undefined,
            droppedMalformedCount: 0,
            runStatus: 'empty',
          }),
        },
      },
    });
    activeApps.push(instance);

    const createRes = await instance.app.request('/api/saved-searches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Fleece Multi',
        keywords: 'patagonia fleece',
        unifiedFilters: createDefaultUnifiedFilter(),
        marketplaces: ['ebay', 'poshmark'],
        sortOrder: 'relevance',
      }),
    });
    const saved = (await createRes.json()).savedSearch;

    const runMetaRes = await instance.app.request(`/api/saved-searches/${saved.id}/run`, {
      method: 'POST',
    });
    expect(runMetaRes.status).toBe(200);

    const streamRes = await instance.app.request('/api/searches/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keywords: saved.keywords,
        unifiedFilters: saved.unifiedFilters,
        marketplaces: saved.marketplaces,
        sortOrder: saved.sortOrder,
      }),
    });
    expect(streamRes.status).toBe(200);
    const sseText = await streamRes.text();
    expect(sseText).toContain('Patagonia Fleece Poshmark');
    expect(sseText).toContain('"runStatus":"unconfigured"');
  });
});
