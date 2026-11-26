import { describe, expect, it, vi } from 'vitest';
import { createDefaultAppSettings, createDefaultUnifiedFilter } from '../../src/shared/index.ts';
import { createEbayAdapter } from '../../src/server/adapters/ebay.ts';
import type { RawEbayCredentials } from '../../src/server/secrets.ts';

const VALID_CREDS: RawEbayCredentials = {
  clientId: 'app-id-123',
  clientSecret: 'secret-xyz',
  origin: 'file',
  configured: true,
};

describe('eBay Buy Browse API adapter — filter translation', () => {
  it('translates keywords verbatim, mandatory buyingOptions, open/closed price bounds, sort order, and nativeSearchUrl', () => {
    const adapter = createEbayAdapter();
    const settings = { ...createDefaultAppSettings(), homePostalCode: '98101' };

    const filters = {
      ...createDefaultUnifiedFilter(settings),
      priceMin: 25,
      priceMax: 150.5,
      conditions: ['new'] as const,
      fulfillment: 'any' as const,
    };

    const diag = adapter.translateFilters(
      '  patagonia nano puff  ',
      { ...filters, conditions: [...filters.conditions] },
      'newest',
      {
        settings,
      },
    );

    expect(diag.marketplace).toBe('ebay');
    expect(diag.status).toBe('exact');
    expect(diag.nativeSearchUrl).toContain('https://www.ebay.com/sch/i.html');
    expect(diag.nativeSearchUrl).toContain('_nkw=patagonia+nano+puff');

    const query = diag.nativeQuery as {
      q: string;
      sort?: string;
      filter: string;
      endUserCtx?: string;
    };
    expect(query.q).toBe('patagonia nano puff');
    expect(query.sort).toBe('newlyListed');
    expect(query.filter).toContain('buyingOptions:{FIXED_PRICE|AUCTION}');
    expect(query.filter).toContain('price:[25.00..150.50],priceCurrency:USD');
    expect(query.filter).toContain('conditionIds:{1000}');
    expect(query.endUserCtx).toBe('contextualLocation=country=US,zip=98101');

    // Open-ended min bound & price_desc
    const openMin = adapter.translateFilters(
      'sony camera',
      { ...createDefaultUnifiedFilter(settings), priceMin: 10 },
      'price_desc',
      { settings },
    );
    expect((openMin.nativeQuery as { filter: string; sort?: string }).filter).toContain(
      'price:[10.00..],priceCurrency:USD',
    );
    expect((openMin.nativeQuery as { sort?: string }).sort).toBe('-price');

    // Open-ended max bound & relevance omits sort
    const openMax = adapter.translateFilters(
      'sony camera',
      { ...createDefaultUnifiedFilter(settings), priceMax: 99 },
      'relevance',
      { settings },
    );
    expect((openMax.nativeQuery as { filter: string; sort?: string }).filter).toContain(
      'price:[..99.00],priceCurrency:USD',
    );
    expect((openMax.nativeQuery as { sort?: string }).sort).toBeUndefined();
  });

  it('maps 5-tier conditions with 2010/2020/2030 refurbished IDs and reports broadened when 3000 lacks all three used tiers', () => {
    const adapter = createEbayAdapter();
    const settings = createDefaultAppSettings();

    // like_new alone -> includes 1500|2000|2010|2020|2500|2750|3000|4000 and marks broadened
    const likeNew = adapter.translateFilters(
      'keyboard',
      { ...createDefaultUnifiedFilter(settings), conditions: ['like_new'] },
      'relevance',
      { settings },
    );
    expect(likeNew.status).toBe('broadened');
    expect((likeNew.nativeQuery as { filter: string }).filter).toContain(
      'conditionIds:{1500|2000|2010|2020|2500|2750|3000|4000}',
    );
    expect(likeNew.notices.some((n) => n.includes('3000'))).toBe(true);

    // good alone -> includes 2030|3000|5000 and marks broadened
    const good = adapter.translateFilters(
      'keyboard',
      { ...createDefaultUnifiedFilter(settings), conditions: ['good'] },
      'relevance',
      { settings },
    );
    expect(good.status).toBe('broadened');
    expect((good.nativeQuery as { filter: string }).filter).toContain(
      'conditionIds:{2030|3000|5000}',
    );

    // all three used tiers -> exact (all 3000 tiers covered)
    const allUsed = adapter.translateFilters(
      'keyboard',
      { ...createDefaultUnifiedFilter(settings), conditions: ['like_new', 'good', 'fair'] },
      'relevance',
      { settings },
    );
    expect(allUsed.status).toBe('exact');
    expect((allUsed.nativeQuery as { filter: string }).filter).toContain(
      'conditionIds:{1500|2000|2010|2020|2030|2500|2750|3000|4000|5000|6000}',
    );

    // poor alone -> 7000 exact
    const poor = adapter.translateFilters(
      'keyboard',
      { ...createDefaultUnifiedFilter(settings), conditions: ['poor'] },
      'price_asc',
      { settings },
    );
    expect(poor.status).toBe('exact');
    expect((poor.nativeQuery as { filter: string }).filter).toContain('conditionIds:{7000}');
    expect((poor.nativeQuery as { sort?: string }).sort).toBe('price');
  });

  it('translates local_pickup with SELLER_ARRANGED_LOCAL_PICKUP or returns skipped_unsupported if ZIP is missing', () => {
    const adapter = createEbayAdapter();
    const settingsNoZip = createDefaultAppSettings();

    const withFilterZip = adapter.translateFilters(
      'bike',
      {
        ...createDefaultUnifiedFilter(settingsNoZip),
        fulfillment: 'local_pickup',
        localPickupPostalCode: '98101',
        localPickupRadiusMiles: 25,
      },
      'relevance',
      { settings: settingsNoZip },
    );
    expect(withFilterZip.status).toBe('exact');
    expect((withFilterZip.nativeQuery as { filter: string }).filter).toContain(
      'deliveryOptions:{SELLER_ARRANGED_LOCAL_PICKUP},pickupCountry:US,pickupPostalCode:98101,pickupRadius:25,pickupRadiusUnit:mi',
    );

    const missingZip = adapter.translateFilters(
      'bike',
      {
        ...createDefaultUnifiedFilter(settingsNoZip),
        fulfillment: 'local_pickup',
        localPickupPostalCode: null,
      },
      'relevance',
      { settings: settingsNoZip },
    );
    expect(missingZip.status).toBe('skipped_unsupported');
    expect(missingZip.notices[0]).toMatch(/ZIP|postal/i);
  });
});

describe('eBay Buy Browse API adapter — OAuth, execution, normalization, and pagination', () => {
  it('returns unconfigured cleanly when credentials are missing without calling fetch', async () => {
    const fetchMock = vi.fn();
    const adapter = createEbayAdapter({ fetchImpl: fetchMock });
    const settings = createDefaultAppSettings();
    const filters = createDefaultUnifiedFilter(settings);
    const translation = adapter.translateFilters('jacket', filters, 'relevance', { settings });

    const result = await adapter.executeInitial({
      keywords: 'jacket',
      unifiedFilters: filters,
      sortOrder: 'relevance',
      translation,
      context: {
        settings,
        ebayCredentials: { clientId: null, clientSecret: null, origin: 'none', configured: false },
      },
    });

    expect(result.runStatus).toBe('unconfigured');
    expect(result.listings).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('mints 2-hour OAuth tokens, caches them across searches, retries once on 401, and verifies credentials', async () => {
    let now = 1_700_000_000_000;
    let tokenCounter = 0;
    let searchCalls = 0;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'https://api.ebay.com/identity/v1/oauth2/token') {
        tokenCounter += 1;
        const headers = init?.headers as Record<string, string>;
        expect(headers.Authorization).toBe(
          `Basic ${Buffer.from('app-id-123:secret-xyz').toString('base64')}`,
        );
        expect(String(init?.body)).toContain('grant_type=client_credentials');
        return new Response(
          JSON.stringify({
            access_token: `tok-${tokenCounter}`,
            token_type: 'Application Access Token',
            expires_in: 7200,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (url.startsWith('https://api.ebay.com/buy/browse/v1/item_summary/search')) {
        searchCalls += 1;
        const headers = init?.headers as Record<string, string>;
        expect(headers['X-EBAY-C-MARKETPLACE-ID']).toBe('EBAY_US');
        // Simulate 401 on the 2nd search call to verify single refresh-and-retry
        if (searchCalls === 2) {
          return new Response(JSON.stringify({ errors: [{ message: 'Invalid token' }] }), {
            status: 401,
          });
        }
        return new Response(JSON.stringify({ total: 0, offset: 0, limit: 48, itemSummaries: [] }), {
          status: 200,
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const adapter = createEbayAdapter({ fetchImpl: fetchMock, clock: () => now });
    const settings = createDefaultAppSettings();
    const filters = createDefaultUnifiedFilter(settings);
    const translation = adapter.translateFilters('camera', filters, 'relevance', { settings });

    // 1st search mints tok-1
    const first = await adapter.executeInitial({
      keywords: 'camera',
      unifiedFilters: filters,
      sortOrder: 'relevance',
      translation,
      context: { settings, ebayCredentials: VALID_CREDS },
    });
    expect(first.runStatus).toBe('empty');
    expect(tokenCounter).toBe(1);

    // 30 minutes later: cached token reused -> 401 triggers 1 refresh to tok-2 + retry
    now += 30 * 60 * 1000;
    const second = await adapter.executeInitial({
      keywords: 'camera',
      unifiedFilters: filters,
      sortOrder: 'relevance',
      translation,
      context: { settings, ebayCredentials: VALID_CREDS },
    });
    expect(second.runStatus).toBe('empty');
    expect(tokenCounter).toBe(2);
    expect(searchCalls).toBe(3);

    // verifyCredentials succeeds using valid OAuth call (forces fresh token mint)
    const verifyOk = await adapter.verifyCredentials(VALID_CREDS);
    expect(verifyOk).toEqual({ valid: true });
    expect(tokenCounter).toBe(3);

    // After > 2 hours, token expires and mints a fresh one
    now += 2 * 60 * 60 * 1000 + 1000;
    await adapter.executeInitial({
      keywords: 'camera',
      unifiedFilters: filters,
      sortOrder: 'relevance',
      translation,
      context: { settings, ebayCredentials: VALID_CREDS },
    });
    expect(tokenCounter).toBe(4);
  });

  it('normalizes fixed-price, auction, shipping, thumbnails, strips seller PII, tolerates malformed nodes, post-filters price, and paginates offset += 48', async () => {
    const requestedUrls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'https://api.ebay.com/identity/v1/oauth2/token') {
        return new Response(JSON.stringify({ access_token: 'tok-live', expires_in: 7200 }), {
          status: 200,
        });
      }
      requestedUrls.push(url);
      const headers = init?.headers as Record<string, string>;
      expect(headers['X-EBAY-C-ENDUSERCTX']).toBe('contextualLocation=country=US,zip=98101');

      const parsed = new URL(url);
      const offset = Number(parsed.searchParams.get('offset') ?? '0');
      if (offset === 0) {
        return new Response(
          JSON.stringify({
            total: 100,
            offset: 0,
            limit: 48,
            next: 'https://api.ebay.com/buy/browse/v1/item_summary/search?offset=48',
            itemSummaries: [
              // Fixed price + free shipping + seller PII that MUST be stripped
              {
                itemId: 'v1|111|0',
                title: 'Patagonia Nano Puff Jacket',
                itemWebUrl: 'https://www.ebay.com/itm/111',
                price: { value: '89.99', currency: 'USD' },
                buyingOptions: ['FIXED_PRICE'],
                shippingOptions: [
                  { shippingCostType: 'FIXED', shippingCost: { value: '0.00', currency: 'USD' } },
                ],
                image: { imageUrl: 'https://i.ebayimg.com/111.jpg' },
                condition: 'Pre-owned',
                itemLocation: { city: 'Seattle', stateOrProvince: 'WA', country: 'US' },
                itemCreationDate: '2026-11-20T10:00:00Z',
                seller: { username: 'leaky_seller', feedbackScore: 999 },
              },
              // Auction with currentBidPrice, bidCount, buyNowPrice, known shipping, additionalImages fallback
              {
                itemId: 'v1|222|0',
                title: 'Patagonia Down Sweater Auction',
                itemWebUrl: 'https://www.ebay.com/itm/222',
                currentBidPrice: { value: '55.00', currency: 'USD' },
                bidCount: 7,
                price: { value: '120.00', currency: 'USD' },
                buyingOptions: ['AUCTION', 'FIXED_PRICE'],
                shippingOptions: [
                  { shippingCostType: 'FIXED', shippingCost: { value: '8.50', currency: 'USD' } },
                ],
                additionalImages: [{ imageUrl: 'https://i.ebayimg.com/222-add.jpg' }],
                condition: 'Like New',
                itemCreationDate: '2026-11-21T12:00:00Z',
              },
              // Out-of-range item ($5 < priceMin $20) -> post-filtered locally
              {
                itemId: 'v1|333|0',
                title: 'Cheap Patch',
                itemWebUrl: 'https://www.ebay.com/itm/333',
                price: { value: '5.00', currency: 'USD' },
                buyingOptions: ['FIXED_PRICE'],
                shippingOptions: [{ shippingCostType: 'CALCULATED' }],
              },
              // Malformed node (missing title & price) -> droppedMalformedCount++
              {
                itemId: 'v1|bad|0',
                title: '',
              },
            ],
          }),
          { status: 200 },
        );
      }

      // Page 2 (offset=48, final item)
      return new Response(
        JSON.stringify({
          total: 49,
          offset: 48,
          limit: 48,
          itemSummaries: [
            {
              itemId: 'v1|444|0',
              title: 'Patagonia Capilene',
              itemWebUrl: 'https://www.ebay.com/itm/444',
              price: { value: '35.00', currency: 'USD' },
              buyingOptions: ['FIXED_PRICE'],
              thumbnailImages: [{ imageUrl: 'https://i.ebayimg.com/444-thumb.jpg' }],
            },
          ],
        }),
        { status: 200 },
      );
    });

    const adapter = createEbayAdapter({ fetchImpl: fetchMock });
    const settings = { ...createDefaultAppSettings(), homePostalCode: '98101' };
    const filters = {
      ...createDefaultUnifiedFilter(settings),
      priceMin: 20,
      priceMax: 150,
    };
    const translation = adapter.translateFilters('patagonia', filters, 'relevance', { settings });

    const page1 = await adapter.executeInitial({
      keywords: 'patagonia',
      unifiedFilters: filters,
      sortOrder: 'relevance',
      translation,
      context: { settings, ebayCredentials: VALID_CREDS },
    });

    expect(page1.runStatus).toBe('success');
    expect(page1.hasMore).toBe(true);
    expect(page1.droppedMalformedCount).toBe(1);
    expect(page1.listings).toHaveLength(2);

    const fixed = page1.listings[0]!;
    expect(fixed.marketplaceListingId).toBe('v1|111|0');
    expect(fixed.price).toBe(89.99);
    expect(fixed.shippingType).toBe('free');
    expect(fixed.shippingPrice).toBe(0);
    expect(fixed.listingFormat).toBe('fixed_price');
    expect(fixed.locationLabel).toBe('Seattle, WA');
    expect(fixed.listedAt).toBe('2026-11-20T10:00:00Z');
    expect((fixed as unknown as Record<string, unknown>).seller).toBeUndefined();

    const auction = page1.listings[1]!;
    expect(auction.marketplaceListingId).toBe('v1|222|0');
    expect(auction.listingFormat).toBe('auction');
    expect(auction.price).toBe(55);
    expect(auction.bidCount).toBe(7);
    expect(auction.buyNowPrice).toBe(120);
    expect(auction.shippingType).toBe('known');
    expect(auction.shippingPrice).toBe(8.5);
    expect(auction.thumbnailUrl).toBe('https://i.ebayimg.com/222-add.jpg');

    const page2 = await adapter.loadMore({
      keywords: 'patagonia',
      unifiedFilters: filters,
      sortOrder: 'relevance',
      translation,
      context: { settings, ebayCredentials: VALID_CREDS },
      cursor: page1.nextCursor,
      page: 2,
    });

    expect(page2.runStatus).toBe('success');
    expect(page2.hasMore).toBe(false);
    expect(page2.listings).toHaveLength(1);
    expect(page2.listings[0]?.thumbnailUrl).toBe('https://i.ebayimg.com/444-thumb.jpg');
    expect(page2.listings[0]?.shippingType).toBe('buyer_paid_unknown');

    const secondUrl = new URL(requestedUrls[1]!);
    expect(secondUrl.searchParams.get('offset')).toBe('48');
    expect(secondUrl.searchParams.get('limit')).toBe('48');
  });

  it('raises parse_error when envelope is unrecognized or all raw nodes are malformed', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'https://api.ebay.com/identity/v1/oauth2/token') {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 7200 }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          total: 2,
          itemSummaries: [{ broken: true }, { broken: true }],
        }),
        { status: 200 },
      );
    });

    const adapter = createEbayAdapter({ fetchImpl: fetchMock });
    const settings = createDefaultAppSettings();
    const filters = createDefaultUnifiedFilter(settings);
    const translation = adapter.translateFilters('camera', filters, 'relevance', { settings });

    const res = await adapter.executeInitial({
      keywords: 'camera',
      unifiedFilters: filters,
      sortOrder: 'relevance',
      translation,
      context: { settings, ebayCredentials: VALID_CREDS },
    });

    expect(res.runStatus).toBe('parse_error');
    expect(res.droppedMalformedCount).toBe(2);
    expect(res.listings).toEqual([]);
  });

  it('classifies timed-out eBay API requests as timeout', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'https://api.ebay.com/identity/v1/oauth2/token') {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 7200 }), {
          status: 200,
        });
      }
      return await new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    });

    const adapter = createEbayAdapter({ fetchImpl: fetchMock, timeoutMs: 25 });
    const settings = createDefaultAppSettings();
    const filters = createDefaultUnifiedFilter(settings);
    const translation = adapter.translateFilters('camera', filters, 'relevance', { settings });

    const res = await adapter.executeInitial({
      keywords: 'camera',
      unifiedFilters: filters,
      sortOrder: 'relevance',
      translation,
      context: { settings, ebayCredentials: VALID_CREDS },
    });

    expect(res.runStatus).toBe('timeout');
    expect(res.errorMessage).toMatch(/timed out/i);
  });

  it('surfaces upstream eBay errorId and message on non-OK HTTP responses', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'https://api.ebay.com/identity/v1/oauth2/token') {
        return new Response(JSON.stringify({ access_token: 'tok-err', expires_in: 7200 }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          errors: [
            {
              errorId: 12001,
              message: 'Invalid filter value',
            },
          ],
        }),
        { status: 400 },
      );
    });

    const adapter = createEbayAdapter({ fetchImpl: fetchMock });
    const settings = createDefaultAppSettings();
    const filters = createDefaultUnifiedFilter(settings);
    const translation = adapter.translateFilters('camera', filters, 'relevance', { settings });

    const res = await adapter.executeInitial({
      keywords: 'camera',
      unifiedFilters: filters,
      sortOrder: 'relevance',
      translation,
      context: { settings, ebayCredentials: VALID_CREDS },
    });

    expect(res.runStatus).toBe('network_error');
    expect(res.errorMessage).toContain('HTTP 400');
    expect(res.errorMessage).toContain('12001');
    expect(res.errorMessage).toContain('Invalid filter value');
  });
});
