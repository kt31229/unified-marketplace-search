import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FACEBOOK_CITY_HUBS,
  createDefaultMarketplaceRetrySettings,
  type AppSettings,
  type Listing,
  type MarketplaceId,
} from '../../src/shared/index.ts';
import type { MarketplaceAdapter } from '../../src/server/adapters/types.ts';
import {
  formatLiveSmokeReport,
  parseLiveSmokeArgs,
  redactSensitiveText,
  runLiveSmoke,
  type LiveSmokeSummary,
} from '../../src/server/live-smoke.ts';

describe('parseLiveSmokeArgs & opt-in guard', () => {
  it('rejects execution when no explicit opt-in (--yes, UMS_LIVE_SMOKE=1, or npm_lifecycle_event=smoke:live) is present', () => {
    expect(() => parseLiveSmokeArgs([], {})).toThrow(/opt-in/i);
  });

  it('allows --help without opt-in and parses --yes, --query, and --marketplaces', () => {
    expect(parseLiveSmokeArgs(['--help'], {})).toMatchObject({ help: true });

    const withYes = parseLiveSmokeArgs(
      ['--yes', '--query=vintage camera', '--marketplaces=ebay,facebook'],
      {},
    );
    expect(withYes).toEqual({
      help: false,
      optedIn: true,
      query: 'vintage camera',
      marketplaces: ['ebay', 'facebook'],
      priceMin: null,
      priceMax: null,
      conditions: [],
      isolated: false,
    });

    const withNpmLifecycle = parseLiveSmokeArgs(
      ['--query', 'leather boots', '--marketplaces', 'poshmark,mercari,poshmark'],
      { npm_lifecycle_event: 'smoke:live' },
    );
    expect(withNpmLifecycle).toEqual({
      help: false,
      optedIn: true,
      query: 'leather boots',
      marketplaces: ['poshmark', 'mercari'],
      priceMin: null,
      priceMax: null,
      conditions: [],
      isolated: false,
    });

    const withFilters = parseLiveSmokeArgs(
      [
        '--yes',
        '--price-min=25',
        '--price-max',
        '100',
        '--condition=new,like_new,new',
        '--isolated',
      ],
      {},
    );
    expect(withFilters).toEqual({
      help: false,
      optedIn: true,
      query: 'patagonia jacket',
      marketplaces: ['ebay', 'poshmark', 'mercari', 'facebook'],
      priceMin: 25,
      priceMax: 100,
      conditions: ['new', 'like_new'],
      isolated: true,
    });
  });

  it('rejects unknown Marketplace names, empty queries, invalid prices, or invalid conditions', () => {
    expect(() => parseLiveSmokeArgs(['--yes', '--marketplaces=ebay,craigslist'], {})).toThrow(
      /marketplace/i,
    );
    expect(() => parseLiveSmokeArgs(['--yes', '--query=   '], {})).toThrow(/query/i);
    expect(() => parseLiveSmokeArgs(['--yes', '--price-min=-5'], {})).toThrow(/price-min/i);
    expect(() => parseLiveSmokeArgs(['--yes', '--price-max=abc'], {})).toThrow(/price-max/i);
    expect(() => parseLiveSmokeArgs(['--yes', '--price-min=120', '--price-max=80'], {})).toThrow(
      /cannot exceed/i,
    );
    expect(() => parseLiveSmokeArgs(['--yes', '--condition=mint'], {})).toThrow(/condition/i);
  });
});

describe('redactSensitiveText & formatLiveSmokeReport', () => {
  it('redacts tokens, secrets, Authorization headers, and cookies from diagnostic messages', () => {
    const raw =
      'HTTP 401 Authorization: Bearer secret-oauth-token-123; Basic Y2xpZW50OnNlY3JldA==; ' +
      'Cookie: c_user=100012345; xs=99%3Aabcdef; datr=xyz123; client_secret=my-top-secret; ' +
      '"access_token":"tok_abc_999" rawSecret=supersecret123';

    const redacted = redactSensitiveText(raw, ['supersecret123']);

    expect(redacted).not.toContain('secret-oauth-token-123');
    expect(redacted).not.toContain('Y2xpZW50OnNlY3JldA==');
    expect(redacted).not.toContain('100012345');
    expect(redacted).not.toContain('99%3Aabcdef');
    expect(redacted).not.toContain('xyz123');
    expect(redacted).not.toContain('my-top-secret');
    expect(redacted).not.toContain('tok_abc_999');
    expect(redacted).not.toContain('supersecret123');
    expect(redacted).toContain('[REDACTED]');
  });

  it('formats a clean per-Marketplace diagnostic summary without leaking secrets', () => {
    const summary: LiveSmokeSummary = {
      query: 'patagonia jacket',
      startedAt: '2026-11-23T01:00:00.000Z',
      totalDurationMs: 4210,
      results: [
        {
          marketplace: 'ebay',
          outcome: 'skipped',
          runStatus: 'unconfigured',
          listingCount: 0,
          droppedMalformedCount: 0,
          durationMs: 2,
          message: 'eBay credentials are not configured',
          sampleListing: null,
        },
        {
          marketplace: 'poshmark',
          outcome: 'pass',
          runStatus: 'success',
          listingCount: 48,
          droppedMalformedCount: 1,
          durationMs: 1200,
          message: 'OK',
          sampleListing: {
            title: 'Patagonia Nano Puff Jacket',
            price: 85,
          },
        },
        {
          marketplace: 'facebook',
          outcome: 'fail',
          runStatus: 'challenge_or_auth_required',
          listingCount: 0,
          droppedMalformedCount: 0,
          durationMs: 950,
          message: 'Cookie: c_user=123456 checkpoint required',
          sampleListing: null,
        },
      ],
    };

    const report = formatLiveSmokeReport(summary);
    expect(report).toContain('[SKIP] ebay (unconfigured)');
    expect(report).toContain('[PASS] poshmark (success) — 48 Listings');
    expect(report).toContain('Patagonia Nano Puff Jacket ($85.00)');
    expect(report).toContain('[FAIL] facebook (challenge_or_auth_required)');
    expect(report).not.toContain('123456');
    expect(report).toContain('[REDACTED]');
  });
});

function makeSettings(): AppSettings {
  return {
    browserChannel: 'chrome',
    homePostalCode: '98101',
    defaultLocalPickupRadiusMiles: 50,
    homeFacebookCitySlug: 'seattle',
    facebookRadiusMiles: 500,
    facebookCityHubs: DEFAULT_FACEBOOK_CITY_HUBS,
    facebookCooldownProfile: 'conservative',
    retrySettings: createDefaultMarketplaceRetrySettings(),
  };
}

function makeListing(
  marketplace: MarketplaceId,
  id: string,
  title: string,
  price: number,
): Listing {
  return {
    marketplace,
    marketplaceListingId: id,
    url: `https://example.com/${marketplace}/${id}`,
    title,
    price,
    shippingPrice: null,
    shippingType: 'unknown',
    listingFormat: 'fixed_price',
    bidCount: null,
    buyNowPrice: null,
    thumbnailUrl: null,
    conditionLabel: null,
    locationLabel: null,
    listedAt: null,
    adapterRank: 1,
  };
}

function makeFakeAdapter(
  id: MarketplaceId,
  impl: Partial<MarketplaceAdapter> = {},
): MarketplaceAdapter {
  return {
    id,
    translateFilters: vi.fn<MarketplaceAdapter['translateFilters']>((keywords) => ({
      marketplace: id,
      status: 'exact',
      notices: [],
      nativeSearchUrl: `https://example.com/${id}?q=${encodeURIComponent(keywords)}`,
    })),
    executeInitial: vi.fn<MarketplaceAdapter['executeInitial']>(async () => ({
      runStatus: 'success',
      listings: [makeListing(id, '1', `${id} item`, 42)],
      droppedMalformedCount: 0,
      hasMore: false,
    })),
    loadMore: vi.fn<MarketplaceAdapter['loadMore']>(async () => ({
      runStatus: 'empty',
      listings: [],
      droppedMalformedCount: 0,
      hasMore: false,
    })),
    ...impl,
  };
}

describe('runLiveSmoke paced orchestration', () => {
  it('runs a single paced sequential check across all 4 Marketplaces, restricts Facebook to 1 hub, and returns exitCode 0 when all pass', async () => {
    const callOrder: string[] = [];
    const sleepCalls: number[] = [];
    let nowMs = 1_700_000_000_000;

    const ebay = makeFakeAdapter('ebay', {
      executeInitial: vi.fn<MarketplaceAdapter['executeInitial']>(async () => {
        callOrder.push('ebay');
        nowMs += 100;
        return {
          runStatus: 'success',
          listings: [makeListing('ebay', 'e1', 'Patagonia Jacket eBay', 75)],
          droppedMalformedCount: 0,
          hasMore: false,
        };
      }),
    });
    const poshmark = makeFakeAdapter('poshmark', {
      executeInitial: vi.fn<MarketplaceAdapter['executeInitial']>(async () => {
        callOrder.push('poshmark');
        nowMs += 200;
        return {
          runStatus: 'success',
          listings: [makeListing('poshmark', 'p1', 'Patagonia Jacket Posh', 60)],
          droppedMalformedCount: 0,
          hasMore: false,
        };
      }),
    });
    const mercari = makeFakeAdapter('mercari', {
      executeInitial: vi.fn<MarketplaceAdapter['executeInitial']>(async () => {
        callOrder.push('mercari');
        nowMs += 150;
        return {
          runStatus: 'empty',
          listings: [],
          droppedMalformedCount: 0,
          hasMore: false,
        };
      }),
    });
    const facebook = makeFakeAdapter('facebook', {
      executeInitial: vi.fn<MarketplaceAdapter['executeInitial']>(async (params) => {
        callOrder.push('facebook');
        // Smoke check must restrict Facebook to a single city hub to respect ADR-0001
        expect(params.unifiedFilters.facebookLocationSlugs).toEqual(['seattle']);
        nowMs += 300;
        return {
          runStatus: 'success',
          listings: [makeListing('facebook', 'f1', 'Patagonia Jacket FB', 50)],
          droppedMalformedCount: 0,
          hasMore: false,
        };
      }),
    });

    const result = await runLiveSmoke({
      query: 'patagonia jacket',
      marketplaces: ['ebay', 'poshmark', 'mercari', 'facebook'],
      adapters: { ebay, poshmark, mercari, facebook },
      settings: makeSettings(),
      ebayCredentials: {
        configured: true,
        origin: 'env',
        clientId: 'ebay-client-id-1234',
        clientSecret: 'ebay-client-secret-9876',
      },
      pacingCooldownMs: 3500,
      sleep: async (ms) => {
        sleepCalls.push(ms);
        nowMs += ms;
      },
      clock: () => nowMs,
    });

    expect(callOrder).toEqual(['ebay', 'poshmark', 'mercari', 'facebook']);
    expect(sleepCalls).toEqual([3500, 3500, 3500]);
    expect(result.exitCode).toBe(0);
    expect(result.summary.results.map((r) => r.outcome)).toEqual(['pass', 'pass', 'pass', 'pass']);
    expect(result.report).not.toContain('ebay-client-secret-9876');
    expect(result.report).not.toContain('ebay-client-id-1234');
  });

  it('skips unconfigured eBay without blocking other Marketplaces, redacts leaked secrets on failure, and returns exitCode 1 on failure', async () => {
    const ebay = makeFakeAdapter('ebay');
    const poshmark = makeFakeAdapter('poshmark', {
      executeInitial: vi.fn<MarketplaceAdapter['executeInitial']>(async () => {
        throw new Error(
          'Unexpected failure with Bearer live-token-xyz and secret ebay-secret-abcd',
        );
      }),
    });
    const mercari = makeFakeAdapter('mercari');
    const facebook = makeFakeAdapter('facebook', {
      executeInitial: vi.fn<MarketplaceAdapter['executeInitial']>(async () => ({
        runStatus: 'challenge_or_auth_required',
        listings: [],
        droppedMalformedCount: 0,
        hasMore: false,
        errorMessage: 'Login prompt with cookie c_user=999888777',
      })),
    });

    const result = await runLiveSmoke({
      query: 'patagonia jacket',
      marketplaces: ['ebay', 'poshmark', 'facebook'],
      adapters: { ebay, poshmark, mercari, facebook },
      settings: makeSettings(),
      ebayCredentials: {
        configured: false,
        origin: 'none',
        clientId: null,
        clientSecret: 'ebay-secret-abcd',
      },
      pacingCooldownMs: 3500,
      sleep: async () => {},
    });

    expect(ebay.executeInitial).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(1);
    expect(result.summary.results.map((r) => [r.marketplace, r.outcome, r.runStatus])).toEqual([
      ['ebay', 'skipped', 'unconfigured'],
      ['poshmark', 'fail', 'network_error'],
      ['facebook', 'fail', 'challenge_or_auth_required'],
    ]);
    expect(result.report).not.toContain('live-token-xyz');
    expect(result.report).not.toContain('ebay-secret-abcd');
    expect(result.report).not.toContain('999888777');
    expect(result.report).toContain('[REDACTED]');
  });

  it('forwards optional priceMin, priceMax, and conditions into adapter unifiedFilters', async () => {
    const poshmark = makeFakeAdapter('poshmark', {
      translateFilters: vi.fn<MarketplaceAdapter['translateFilters']>((keywords, filters) => {
        expect(filters.priceMin).toBe(20);
        expect(filters.priceMax).toBe(100);
        expect(filters.conditions).toEqual(['like_new', 'good']);
        return {
          marketplace: 'poshmark',
          status: 'exact',
          notices: [],
          nativeSearchUrl: `https://example.com/poshmark?q=${encodeURIComponent(keywords)}`,
        };
      }),
      executeInitial: vi.fn<MarketplaceAdapter['executeInitial']>(async (params) => {
        expect(params.unifiedFilters.priceMin).toBe(20);
        expect(params.unifiedFilters.priceMax).toBe(100);
        expect(params.unifiedFilters.conditions).toEqual(['like_new', 'good']);
        return {
          runStatus: 'success',
          listings: [makeListing('poshmark', 'p1', 'Filtered Jacket', 65)],
          droppedMalformedCount: 0,
          hasMore: false,
        };
      }),
    });

    const result = await runLiveSmoke({
      query: 'jacket',
      marketplaces: ['poshmark'],
      priceMin: 20,
      priceMax: 100,
      conditions: ['like_new', 'good'],
      adapters: {
        ebay: makeFakeAdapter('ebay'),
        poshmark,
        mercari: makeFakeAdapter('mercari'),
        facebook: makeFakeAdapter('facebook'),
      },
      settings: makeSettings(),
      ebayCredentials: {
        configured: false,
        origin: 'none',
        clientId: null,
        clientSecret: null,
      },
      sleep: async () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(poshmark.translateFilters).toHaveBeenCalledTimes(1);
    expect(poshmark.executeInitial).toHaveBeenCalledTimes(1);
  });
});
