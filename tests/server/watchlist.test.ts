import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, type AppInstance } from '../../src/server/app.ts';

const tempDirs: string[] = [];
const activeApps: AppInstance[] = [];

function createTempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ums-watchlist-test-'));
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

describe('Watchlist SQLite migration, PII-free persistence, and HTTP endpoints', () => {
  it('runs migration creating watchlist_entries with UNIQUE(marketplace, marketplace_listing_id) and strips seller PII', async () => {
    const dataDir = createTempDataDir();
    let nowMs = Date.parse('2026-11-22T10:00:00.000Z');
    const instance = createApp({
      dataDir,
      env: {},
      clock: () => nowMs,
      thumbnailFetch: vi.fn(async () => new Response('not found', { status: 404 })),
    });
    activeApps.push(instance);

    const versionRow = instance.db.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(versionRow.user_version).toBeGreaterThanOrEqual(2);

    const postRes = await instance.app.request('/api/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        listing: {
          marketplace: 'ebay',
          marketplaceListingId: 'itm-100',
          url: 'https://www.ebay.com/itm/itm-100',
          title: 'Patagonia R1 Pullover',
          price: 65,
          shippingPrice: 5,
          thumbnailUrl: 'https://i.ebayimg.com/itm-100.jpg',
          seller: { username: 'private-seller-123', feedbackScore: 99 },
          notes: 'Secret personal note',
        },
      }),
    });

    expect(postRes.status).toBe(201);
    const postText = await postRes.text();
    expect(postText).not.toContain('private-seller-123');
    expect(postText).not.toContain('Secret personal note');

    const postBody = JSON.parse(postText) as { entry: Record<string, unknown> };
    expect(postBody.entry).toEqual({
      marketplace: 'ebay',
      marketplaceListingId: 'itm-100',
      url: 'https://www.ebay.com/itm/itm-100',
      title: 'Patagonia R1 Pullover',
      price: 65,
      shippingPrice: 5,
      thumbnailUrl: 'https://i.ebayimg.com/itm-100.jpg',
      cachedThumbnailPath: null,
      savedAt: '2026-11-22T10:00:00.000Z',
    });

    // Verify SQLite table schema enforces uniqueness and contains no seller/notes columns
    const columns = instance.db.prepare("PRAGMA table_info('watchlist_entries')").all() as Array<{
      name: string;
    }>;
    const columnNames = columns.map((c) => c.name);
    expect(columnNames).toEqual([
      'id',
      'marketplace',
      'marketplace_listing_id',
      'url',
      'title',
      'price',
      'shipping_price',
      'thumbnail_url',
      'cached_thumbnail_path',
      'saved_at',
    ]);

    await instance.shutdown();
    activeApps.pop();

    const rawDb = new DatabaseSync(path.join(dataDir, 'data.sqlite'));
    try {
      expect(() =>
        rawDb
          .prepare(
            `INSERT INTO watchlist_entries (
              id, marketplace, marketplace_listing_id, url, title, saved_at
            ) VALUES ('dup-id', 'ebay', 'itm-100', 'https://www.ebay.com/itm/itm-100', 'Dup', '2026-11-22T10:01:00.000Z')`,
          )
          .run(),
      ).toThrow(/UNIQUE constraint failed/i);
    } finally {
      rawDb.close();
    }
  });

  it('deduplicates on (marketplace, marketplaceListingId), captures fresh snapshot on remove + re-add, and supports sorting/filtering', async () => {
    const dataDir = createTempDataDir();
    let nowMs = Date.parse('2026-11-22T10:00:00.000Z');
    const instance = createApp({
      dataDir,
      env: {},
      clock: () => nowMs,
      thumbnailFetch: vi.fn(async () => new Response('not found', { status: 404 })),
    });
    activeApps.push(instance);

    // Add entry 1 (price 90)
    await instance.app.request('/api/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        marketplace: 'ebay',
        marketplaceListingId: 'e-1',
        url: 'https://www.ebay.com/itm/e-1',
        title: 'Old Title',
        price: 90,
        shippingPrice: 0,
        thumbnailUrl: null,
      }),
    });

    // Add entry 2 (price null)
    nowMs += 10_000;
    await instance.app.request('/api/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        marketplace: 'poshmark',
        marketplaceListingId: 'p-1',
        url: 'https://poshmark.com/listing/p-1',
        title: 'Poshmark Jacket',
        price: null,
        shippingPrice: 6.49,
        thumbnailUrl: null,
      }),
    });

    // Add entry 3 (price 40)
    nowMs += 10_000;
    await instance.app.request('/api/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        marketplace: 'mercari',
        marketplaceListingId: 'm-1',
        url: 'https://www.mercari.com/us/item/m-1/',
        title: 'Mercari Boots',
        price: 40,
        shippingPrice: null,
        thumbnailUrl: null,
      }),
    });

    // Remove e-1 and re-add with updated snapshot
    const delRes = await instance.app.request('/api/watchlist/ebay/e-1', { method: 'DELETE' });
    expect(delRes.status).toBe(200);

    nowMs += 10_000;
    const reAddRes = await instance.app.request('/api/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        marketplace: 'ebay',
        marketplaceListingId: 'e-1',
        url: 'https://www.ebay.com/itm/e-1?v=2',
        title: 'Updated Fresh Title',
        price: 72,
        shippingPrice: 0,
        thumbnailUrl: null,
      }),
    });
    expect(reAddRes.status).toBe(201);

    // Default sort: newest saved first
    const listDefault = await instance.app.request('/api/watchlist');
    expect(listDefault.status).toBe(200);
    const defaultJson = (await listDefault.json()) as { entries: Array<{ marketplaceListingId: string; title: string; price: number | null; url: string }> };
    expect(defaultJson.entries.map((e) => e.marketplaceListingId)).toEqual(['e-1', 'm-1', 'p-1']);
    expect(defaultJson.entries[0]?.title).toBe('Updated Fresh Title');
    expect(defaultJson.entries[0]?.price).toBe(72);
    expect(defaultJson.entries[0]?.url).toBe('https://www.ebay.com/itm/e-1?v=2');

    // Sort price_asc: null price at bottom
    const listAsc = await instance.app.request('/api/watchlist?sort=price_asc');
    const ascJson = (await listAsc.json()) as { entries: Array<{ marketplaceListingId: string }> };
    expect(ascJson.entries.map((e) => e.marketplaceListingId)).toEqual(['m-1', 'e-1', 'p-1']);

    // Sort price_desc: null price STILL at bottom
    const listDesc = await instance.app.request('/api/watchlist?sort=price_desc');
    const descJson = (await listDesc.json()) as { entries: Array<{ marketplaceListingId: string }> };
    expect(descJson.entries.map((e) => e.marketplaceListingId)).toEqual(['e-1', 'm-1', 'p-1']);

    // Filter by marketplace
    const filtered = await instance.app.request('/api/watchlist?marketplace=poshmark');
    const filteredJson = (await filtered.json()) as { entries: Array<{ marketplaceListingId: string }> };
    expect(filteredJson.entries.map((e) => e.marketplaceListingId)).toEqual(['p-1']);
  });

  it('returns POST /api/watchlist immediately without blocking on thumbnail download, caches locally, serves /api/thumbnails/:filename safely, and deletes file on DELETE', async () => {
    const dataDir = createTempDataDir();
    let resolveThumb!: (res: Response) => void;
    const thumbPromise = new Promise<Response>((resolve) => {
      resolveThumb = resolve;
    });
    const fakeBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const thumbnailFetch = vi.fn(() => thumbPromise);

    const instance = createApp({
      dataDir,
      env: {},
      thumbnailFetch,
    });
    activeApps.push(instance);

    // POST must resolve immediately BEFORE thumbnailFetch resolves
    const postRes = await instance.app.request('/api/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        listing: {
          marketplace: 'facebook',
          marketplaceListingId: 'fb-999',
          url: 'https://www.facebook.com/marketplace/item/fb-999/',
          title: 'Mid-Century Desk',
          price: 180,
          shippingPrice: null,
          thumbnailUrl: 'https://scontent.xx.fbcdn.net/v/t39/desk.png?oh=abc',
        },
      }),
    });

    expect(postRes.status).toBe(201);
    const postJson = (await postRes.json()) as {
      entry: { cachedThumbnailPath: string | null; thumbnailUrl: string | null };
    };
    expect(postJson.entry.cachedThumbnailPath).toBeNull();
    expect(thumbnailFetch).toHaveBeenCalledTimes(1);

    // Now resolve the background thumbnail download
    resolveThumb(
      new Response(fakeBytes, {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }),
    );

    let cachedFilename: string | null = null;
    await vi.waitFor(async () => {
      const listRes = await instance.app.request('/api/watchlist');
      const listJson = (await listRes.json()) as {
        entries: Array<{ cachedThumbnailPath: string | null }>;
      };
      cachedFilename = listJson.entries[0]?.cachedThumbnailPath ?? null;
      expect(cachedFilename).toMatch(/^[a-z0-9_-]+\.png$/i);
    });

    const thumbFilePath = path.join(dataDir, 'thumbnails', cachedFilename!);
    expect(fs.existsSync(thumbFilePath)).toBe(true);

    // Serve cached image via GET /api/thumbnails/:filename
    const imgRes = await instance.app.request(`/api/thumbnails/${cachedFilename}`);
    expect(imgRes.status).toBe(200);
    expect(imgRes.headers.get('Content-Type')).toBe('image/png');
    const servedBytes = new Uint8Array(await imgRes.arrayBuffer());
    expect(servedBytes).toEqual(fakeBytes);

    // Prevent path traversal
    fs.writeFileSync(path.join(dataDir, 'secrets.json'), '{"secret":true}');
    const traversal1 = await instance.app.request('/api/thumbnails/..%2Fsecrets.json');
    expect([400, 404]).toContain(traversal1.status);
    const traversal2 = await instance.app.request('/api/thumbnails/..%5Csecrets.json');
    expect([400, 404]).toContain(traversal2.status);
    const missing = await instance.app.request('/api/thumbnails/nonexistent.png');
    expect(missing.status).toBe(404);

    // DELETE removes SQLite row AND deletes local thumbnail file
    const delRes = await instance.app.request('/api/watchlist/facebook/fb-999', {
      method: 'DELETE',
    });
    expect(delRes.status).toBe(200);
    expect(fs.existsSync(thumbFilePath)).toBe(false);

    const afterImg = await instance.app.request(`/api/thumbnails/${cachedFilename}`);
    expect(afterImg.status).toBe(404);
  });

  it('swallows thumbnail download failures gracefully so Watchlist Entry stays saved with remote URL fallback', async () => {
    const dataDir = createTempDataDir();
    const thumbnailFetch = vi.fn(async () => {
      throw new Error('CDN network error');
    });

    const instance = createApp({
      dataDir,
      env: {},
      thumbnailFetch,
    });
    activeApps.push(instance);

    const postRes = await instance.app.request('/api/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        listing: {
          marketplace: 'poshmark',
          marketplaceListingId: 'pm-404',
          url: 'https://poshmark.com/listing/pm-404',
          title: 'Wool Sweater',
          price: 45,
          shippingPrice: 6.49,
          thumbnailUrl: 'https://di2ponv0v5otw.cloudfront.net/pm-404.jpg',
        },
      }),
    });

    expect(postRes.status).toBe(201);
    await new Promise((r) => setTimeout(r, 20));

    const listRes = await instance.app.request('/api/watchlist');
    const listJson = (await listRes.json()) as {
      entries: Array<{ cachedThumbnailPath: string | null; thumbnailUrl: string | null }>;
    };
    expect(listJson.entries).toHaveLength(1);
    expect(listJson.entries[0]?.cachedThumbnailPath).toBeNull();
    expect(listJson.entries[0]?.thumbnailUrl).toBe('https://di2ponv0v5otw.cloudfront.net/pm-404.jpg');
  });

  it('cancels in-flight thumbnail caching when entry is deleted before download finishes so no orphaned file remains', async () => {
    const dataDir = createTempDataDir();
    let resolveThumb!: (res: Response) => void;
    const thumbPromise = new Promise<Response>((resolve) => {
      resolveThumb = resolve;
    });

    const instance = createApp({
      dataDir,
      env: {},
      thumbnailFetch: vi.fn(() => thumbPromise),
    });
    activeApps.push(instance);

    await instance.app.request('/api/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        listing: {
          marketplace: 'mercari',
          marketplaceListingId: 'm-race',
          url: 'https://www.mercari.com/us/item/m-race/',
          title: 'Race Test Item',
          price: 30,
          shippingPrice: null,
          thumbnailUrl: 'https://static.mercdn.net/item/detail/orig/photos/m-race.jpg',
        },
      }),
    });

    const delRes = await instance.app.request('/api/watchlist/mercari/m-race', {
      method: 'DELETE',
    });
    expect(delRes.status).toBe(200);

    resolveThumb(
      new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg' },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));

    const thumbFiles = fs.readdirSync(path.join(dataDir, 'thumbnails'));
    expect(thumbFiles).toEqual([]);
  });
});
