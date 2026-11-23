import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserSessionManager,
  type BrowserContextHandle,
  type BrowserPageHandle,
  type BrowserResponseHandle,
  type BrowserTransport,
} from '../../src/server/browser-session-manager.ts';
import { createPoshmarkAdapter, type PoshmarkNativeQuery } from '../../src/server/adapters/poshmark.ts';
import {
  createDefaultAppSettings,
  createDefaultUnifiedFilter,
} from '../../src/shared/index.ts';
import type { AdapterExecutionContext as ServerAdapterContext } from '../../src/server/adapters/types.ts';

function makeContext(overrides: Partial<ServerAdapterContext> = {}): ServerAdapterContext {
  return {
    settings: createDefaultAppSettings(),
    ...overrides,
  };
}

interface PoshmarkMockScript {
  navStatus?: number;
  navFinalUrl?: string;
  navTitle?: string;
  navHtml?: string;
  evaluateHandler?: (arg: { endpointUrl: string; timeoutMs: number }) => Promise<{
    status: number;
    ok: boolean;
    contentType: string;
    body: unknown;
    isChallengeDom?: boolean;
    timedOut?: boolean;
    networkError?: string;
  }>;
  clickHandler?: (selector: string) => Promise<void>;
  waitForResponseHandler?: (
    predicate: string | ((res: BrowserResponseHandle) => boolean | Promise<boolean>),
  ) => Promise<BrowserResponseHandle>;
}

function createScriptedPoshmarkTransport(script: PoshmarkMockScript) {
  const gotoUrls: string[] = [];
  const evaluateArgs: Array<{ endpointUrl: string; timeoutMs: number }> = [];
  const clickSelectors: string[] = [];
  let currentUrl = 'about:blank';
  let launchCount = 0;

  const transport: BrowserTransport = {
    async launchPersistentContext(): Promise<BrowserContextHandle> {
      launchCount += 1;
      const page: BrowserPageHandle = {
        async goto(url: string) {
          gotoUrls.push(url);
          currentUrl = script.navFinalUrl ?? url;
          return {
            url: () => currentUrl,
            status: () => script.navStatus ?? 200,
            json: async () => ({}),
          };
        },
        url: () => currentUrl,
        title: async () => script.navTitle ?? 'Poshmark Search',
        content: async () => script.navHtml ?? '<html><body></body></html>',
        async evaluate<R, Arg>(_fn: unknown, arg?: Arg): Promise<R> {
          const typedArg = arg as { endpointUrl: string; timeoutMs: number };
          evaluateArgs.push(typedArg);
          if (!script.evaluateHandler) {
            throw new Error('No evaluateHandler configured');
          }
          return (await script.evaluateHandler(typedArg)) as R;
        },
        click: script.clickHandler
          ? async (selector: string) => {
              clickSelectors.push(selector);
              await script.clickHandler!(selector);
            }
          : undefined,
        waitForResponse: script.waitForResponseHandler
          ? async (predicate) => script.waitForResponseHandler!(predicate)
          : undefined,
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
    evaluateArgs,
    clickSelectors,
    getLaunchCount: () => launchCount,
  };
}

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ums-posh-'));
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

describe('PoshmarkAdapter', () => {
  it('translates Unified Filters into repeated condition params, price[], sort_by, availability, and skips local_pickup without launching browser', async () => {
    const launchSpy = vi.fn();
    const transport: BrowserTransport = {
      launchPersistentContext: launchSpy,
    };
    const bsm = new BrowserSessionManager({
      dataDir: createTempDir(),
      getBrowserChannel: () => 'chrome',
      transport,
    });
    const adapter = createPoshmarkAdapter({ browserSessionManager: bsm });

    // Exact translation with multiple conditions + price bounds + newest sort
    const exact = adapter.translateFilters(
      '  patagonia nano puff  ',
      {
        ...createDefaultUnifiedFilter(),
        priceMin: 25,
        priceMax: 150,
        conditions: ['new', 'like_new', 'good', 'fair'],
        fulfillment: 'shipping',
      },
      'newest',
      makeContext(),
    );

    expect(exact.status).toBe('exact');
    expect(exact.notices).toEqual([]);
    const parsedExact = new URL(exact.nativeSearchUrl);
    expect(parsedExact.origin + parsedExact.pathname).toBe('https://poshmark.com/search');
    expect(parsedExact.searchParams.get('query')).toBe('patagonia nano puff');
    expect(parsedExact.searchParams.get('availability')).toBe('available');
    expect(parsedExact.searchParams.get('sort_by')).toBe('added_desc');
    expect(parsedExact.searchParams.getAll('condition')).toEqual(['nwt', 'uln', 'ug', 'uf']);
    expect(parsedExact.searchParams.getAll('price[]')).toEqual(['25-150']);

    const nativeQuery = exact.nativeQuery as PoshmarkNativeQuery;
    expect(nativeQuery.vmRestRequest).toEqual({
      filters: {
        department: 'All',
        inventory_status: ['available'],
        condition: ['nwt', 'uln', 'ug', 'uf'],
        price_amount_range: [{ min: 2500, max: 15000 }],
      },
      query: 'patagonia nano puff',
      sort_by: 'added_desc',
      count: 48,
      experience: 'all',
    });

    // Broadened translation when 'poor' is selected (maps to 'uf', deduplicated with 'fair')
    const broadened = adapter.translateFilters(
      'jacket',
      {
        ...createDefaultUnifiedFilter(),
        conditions: ['fair', 'poor'],
      },
      'price_desc',
      makeContext(),
    );
    expect(broadened.status).toBe('broadened');
    expect(broadened.notices[0]).toMatch(/poor/i);
    const parsedBroadened = new URL(broadened.nativeSearchUrl);
    expect(parsedBroadened.searchParams.getAll('condition')).toEqual(['uf']);
    expect(parsedBroadened.searchParams.get('sort_by')).toBe('price_desc');

    // local_pickup -> skipped_unsupported and does NOT launch browser
    const skipped = adapter.translateFilters(
      'sofa',
      {
        ...createDefaultUnifiedFilter(),
        fulfillment: 'local_pickup',
      },
      'relevance',
      makeContext(),
    );
    expect(skipped.status).toBe('skipped_unsupported');

    const skipResult = await adapter.executeInitial({
      keywords: 'sofa',
      unifiedFilters: { ...createDefaultUnifiedFilter(), fulfillment: 'local_pickup' },
      sortOrder: 'relevance',
      translation: skipped,
      context: makeContext(),
    });
    expect(skipResult.runStatus).toBe('skipped_unsupported');
    expect(skipResult.listings).toEqual([]);
    expect(launchSpy).not.toHaveBeenCalled();
  });

  it('fetches page-1 via same-origin /vm-rest/posts, normalizes fields, strips seller PII, enforces active/price guards, and paginates via ENC_ cursor', async () => {
    const scripted = createScriptedPoshmarkTransport({
      evaluateHandler: async ({ endpointUrl }) => {
        const parsed = new URL(endpointUrl, 'https://poshmark.com');
        const requestJson = JSON.parse(parsed.searchParams.get('request') ?? '{}') as {
          max_id?: string;
        };

        if (!requestJson.max_id) {
          return {
            status: 200,
            ok: true,
            contentType: 'application/json',
            isChallengeDom: false,
            body: {
              data: [
                // 1. Free shipping, available, within price range
                {
                  id: 'posh-1',
                  title: 'Patagonia Nano Puff Jacket',
                  price_amount: { val: '75.00', currency_code: 'USD' },
                  inventory: { status: 'available' },
                  shipping_discount_type: 'free',
                  first_published_at: '2026-11-20T10:00:00Z',
                  created_at: '2026-11-19T10:00:00Z',
                  cover_shot: {
                    url_small: 'https://di2ponv0v5otw.cloudfront.net/posh-1-sm.jpg',
                    url: 'https://di2ponv0v5otw.cloudfront.net/posh-1.jpg',
                  },
                  condition: 'uln',
                  seller: { username: 'private_seller_pii', id: 'u123' },
                },
                // 2. Standard $6.49 shipping (null discount), fallback created_at + cover_shot.url
                {
                  id: 'posh-2',
                  title: 'Patagonia Better Sweater',
                  price_amount: { val: '60.00', currency_code: 'USD' },
                  inventory: { status: 'available' },
                  shipping_discount_type: null,
                  first_published_at: null,
                  created_at: '2026-11-18T08:00:00Z',
                  cover_shot: {
                    url_small: null,
                    url: 'https://di2ponv0v5otw.cloudfront.net/posh-2.jpg',
                  },
                  condition: 'ug',
                },
                // 3. Discounted shipping -> buyer_paid_unknown, fallback picture_url
                {
                  id: 'posh-3',
                  title: 'Patagonia R1 Pullover',
                  price: '45',
                  inventory: { status: 'available' },
                  shipping_discount_type: 'discounted',
                  created_at: '2026-11-17T08:00:00Z',
                  picture_url: 'https://di2ponv0v5otw.cloudfront.net/posh-3.jpg',
                },
                // 4. Sold out -> filtered out by inventory.status guard
                {
                  id: 'posh-sold',
                  title: 'Patagonia Sold Item',
                  price_amount: { val: '50.00', currency_code: 'USD' },
                  inventory: { status: 'sold_out' },
                  shipping_discount_type: null,
                },
                // 5. Over priceMax ($200 > $100) -> filtered out locally
                {
                  id: 'posh-over',
                  title: 'Patagonia Expensive Parka',
                  price_amount: { val: '200.00', currency_code: 'USD' },
                  inventory: { status: 'available' },
                  shipping_discount_type: null,
                },
                // 6. Malformed promo/non-listing node -> droppedMalformedCount++
                {
                  type: 'promo_banner',
                  headline: 'Shop Winter Deals',
                },
              ],
              more: {
                next_max_id: 'ENC_PAGE2_CURSOR',
              },
            },
          };
        }

        // Page 2 via ENC_ cursor
        return {
          status: 200,
          ok: true,
          contentType: 'application/json',
          isChallengeDom: false,
          body: {
            data: [
              {
                id: 'posh-4',
                title: 'Patagonia Capilene Tee',
                price_amount: { val: '30.00', currency_code: 'USD' },
                inventory: { status: 'available' },
                shipping_discount_type: 'free',
                first_published_at: '2026-11-16T08:00:00Z',
              },
            ],
            more: {
              next_max_id: null,
            },
          },
        };
      },
    });

    const bsm = new BrowserSessionManager({
      dataDir: createTempDir(),
      getBrowserChannel: () => 'chrome',
      transport: scripted.transport,
    });
    const adapter = createPoshmarkAdapter({ browserSessionManager: bsm });

    const filters = {
      ...createDefaultUnifiedFilter(),
      priceMin: 20,
      priceMax: 100,
      conditions: ['like_new', 'good'] as const,
    };
    const translation = adapter.translateFilters('patagonia', { ...filters, conditions: [...filters.conditions] }, 'relevance', makeContext());

    const page1 = await adapter.executeInitial({
      keywords: 'patagonia',
      unifiedFilters: { ...filters, conditions: [...filters.conditions] },
      sortOrder: 'relevance',
      translation,
      context: makeContext(),
    });

    expect(scripted.getLaunchCount()).toBe(1);
    expect(scripted.gotoUrls).toHaveLength(1);
    expect(scripted.gotoUrls[0]).toContain('https://poshmark.com/search');
    expect(scripted.evaluateArgs[0]?.endpointUrl).toContain('/vm-rest/posts?');
    expect(scripted.evaluateArgs[0]?.endpointUrl).toContain('nm=search_all');
    expect(scripted.evaluateArgs[0]?.endpointUrl).toContain('experience=all');

    expect(page1.runStatus).toBe('success');
    expect(page1.droppedMalformedCount).toBe(1);
    expect(page1.hasMore).toBe(true);
    expect(page1.listings).toHaveLength(3);

    expect(page1.listings[0]).toEqual({
      marketplace: 'poshmark',
      marketplaceListingId: 'posh-1',
      url: 'https://poshmark.com/listing/posh-1',
      title: 'Patagonia Nano Puff Jacket',
      price: 75,
      shippingPrice: 0,
      shippingType: 'free',
      listingFormat: 'fixed_price',
      bidCount: null,
      buyNowPrice: null,
      thumbnailUrl: 'https://di2ponv0v5otw.cloudfront.net/posh-1-sm.jpg',
      conditionLabel: 'uln',
      locationLabel: null,
      listedAt: '2026-11-20T10:00:00Z',
      adapterRank: 1,
    });
    expect('seller' in (page1.listings[0] as Record<string, unknown>)).toBe(false);

    expect(page1.listings[1]?.shippingPrice).toBe(6.49);
    expect(page1.listings[1]?.shippingType).toBe('known');
    expect(page1.listings[1]?.listedAt).toBe('2026-11-18T08:00:00Z');
    expect(page1.listings[1]?.thumbnailUrl).toBe('https://di2ponv0v5otw.cloudfront.net/posh-2.jpg');

    expect(page1.listings[2]?.shippingPrice).toBeNull();
    expect(page1.listings[2]?.shippingType).toBe('buyer_paid_unknown');
    expect(page1.listings[2]?.thumbnailUrl).toBe('https://di2ponv0v5otw.cloudfront.net/posh-3.jpg');

    // Load more reuses warm page without extra /search navigation
    const page2 = await adapter.loadMore({
      keywords: 'patagonia',
      unifiedFilters: { ...filters, conditions: [...filters.conditions] },
      sortOrder: 'relevance',
      translation,
      context: makeContext(),
      cursor: page1.nextCursor,
      page: 2,
    });

    expect(scripted.getLaunchCount()).toBe(1);
    expect(scripted.gotoUrls).toHaveLength(1);
    expect(scripted.evaluateArgs[1]?.endpointUrl).toContain('ENC_PAGE2_CURSOR');
    expect(page2.runStatus).toBe('success');
    expect(page2.hasMore).toBe(false);
    expect(page2.listings).toHaveLength(1);
    expect(page2.listings[0]?.marketplaceListingId).toBe('posh-4');
    expect(page2.listings[0]?.adapterRank).toBe(7);

    await bsm.shutdown();
  });

  it('uses in-page sort/filter fallback if direct /vm-rest/posts returns 400 validation error', async () => {
    const scripted = createScriptedPoshmarkTransport({
      evaluateHandler: async () => ({
        status: 400,
        ok: false,
        contentType: 'application/json',
        isChallengeDom: false,
        body: { error: 'ValidationError' },
      }),
      clickHandler: async () => undefined,
      waitForResponseHandler: async () => ({
        url: () => 'https://poshmark.com/vm-rest/posts?request=...',
        status: () => 200,
        json: async () => ({
          data: [
            {
              id: 'posh-fb-1',
              title: 'Fallback Intercepted Jacket',
              price_amount: { val: '42.00' },
              inventory: { status: 'available' },
              shipping_discount_type: null,
            },
          ],
          more: { next_max_id: null },
        }),
      }),
    });

    const bsm = new BrowserSessionManager({
      dataDir: createTempDir(),
      getBrowserChannel: () => 'chrome',
      transport: scripted.transport,
    });
    const adapter = createPoshmarkAdapter({ browserSessionManager: bsm });
    const filters = createDefaultUnifiedFilter();
    const translation = adapter.translateFilters('jacket', filters, 'newest', makeContext());

    const res = await adapter.executeInitial({
      keywords: 'jacket',
      unifiedFilters: filters,
      sortOrder: 'newest',
      translation,
      context: makeContext(),
    });

    expect(scripted.clickSelectors).toHaveLength(1);
    expect(res.runStatus).toBe('success');
    expect(res.listings[0]?.marketplaceListingId).toBe('posh-fb-1');
    await bsm.shutdown();
  });

  it('fails soft into challenge_or_auth_required with 0 auto-retries on 403 Cequence block or CAPTCHA', async () => {
    const cequenceScript = createScriptedPoshmarkTransport({
      navStatus: 403,
    });

    const bsm1 = new BrowserSessionManager({
      dataDir: createTempDir(),
      getBrowserChannel: () => 'chrome',
      transport: cequenceScript.transport,
    });
    const adapter1 = createPoshmarkAdapter({ browserSessionManager: bsm1 });
    const filters = createDefaultUnifiedFilter();
    const t1 = adapter1.translateFilters('patagonia', filters, 'relevance', makeContext());
    const r1 = await adapter1.executeInitial({
      keywords: 'patagonia',
      unifiedFilters: filters,
      sortOrder: 'relevance',
      translation: t1,
      context: makeContext(),
    });
    expect(r1.runStatus).toBe('challenge_or_auth_required');
    expect(cequenceScript.gotoUrls).toHaveLength(1); // 0 auto-retries
    expect(cequenceScript.evaluateArgs).toHaveLength(0);
    await bsm1.shutdown();

    const captchaDomScript = createScriptedPoshmarkTransport({
      evaluateHandler: async () => ({
        status: 403,
        ok: false,
        contentType: 'text/html',
        isChallengeDom: true,
        body: null,
      }),
    });

    const bsm2 = new BrowserSessionManager({
      dataDir: createTempDir(),
      getBrowserChannel: () => 'chrome',
      transport: captchaDomScript.transport,
    });
    const adapter2 = createPoshmarkAdapter({ browserSessionManager: bsm2 });
    const t2 = adapter2.translateFilters('patagonia', filters, 'relevance', makeContext());
    const r2 = await adapter2.executeInitial({
      keywords: 'patagonia',
      unifiedFilters: filters,
      sortOrder: 'relevance',
      translation: t2,
      context: makeContext(),
    });
    expect(r2.runStatus).toBe('challenge_or_auth_required');
    expect(captchaDomScript.evaluateArgs).toHaveLength(1); // 0 auto-retries
    await bsm2.shutdown();
  });

  it('returns parse_error on unrecognized envelope or all-malformed nodes, and timeout on slow responses', async () => {
    const badEnvelopeScript = createScriptedPoshmarkTransport({
      evaluateHandler: async () => ({
        status: 200,
        ok: true,
        contentType: 'application/json',
        isChallengeDom: false,
        body: { unexpected: true },
      }),
    });
    const bsm1 = new BrowserSessionManager({
      dataDir: createTempDir(),
      getBrowserChannel: () => 'chrome',
      transport: badEnvelopeScript.transport,
    });
    const adapter1 = createPoshmarkAdapter({ browserSessionManager: bsm1 });
    const filters = createDefaultUnifiedFilter();
    const t1 = adapter1.translateFilters('patagonia', filters, 'relevance', makeContext());
    const r1 = await adapter1.executeInitial({
      keywords: 'patagonia',
      unifiedFilters: filters,
      sortOrder: 'relevance',
      translation: t1,
      context: makeContext(),
    });
    expect(r1.runStatus).toBe('parse_error');
    await bsm1.shutdown();

    const slowScript = createScriptedPoshmarkTransport({
      evaluateHandler: () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                status: 200,
                ok: true,
                contentType: 'application/json',
                isChallengeDom: false,
                body: { data: [] },
              }),
            200,
          );
        }),
    });
    const bsm2 = new BrowserSessionManager({
      dataDir: createTempDir(),
      getBrowserChannel: () => 'chrome',
      transport: slowScript.transport,
    });
    const adapter2 = createPoshmarkAdapter({ browserSessionManager: bsm2, timeoutMs: 25 });
    const t2 = adapter2.translateFilters('patagonia', filters, 'relevance', makeContext());
    const r2 = await adapter2.executeInitial({
      keywords: 'patagonia',
      unifiedFilters: filters,
      sortOrder: 'relevance',
      translation: t2,
      context: makeContext(),
    });
    expect(r2.runStatus).toBe('timeout');
    expect(slowScript.gotoUrls).toHaveLength(1); // 0 auto-retries
    await bsm2.shutdown();
  });
});
