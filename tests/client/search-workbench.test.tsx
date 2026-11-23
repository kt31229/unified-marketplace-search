// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/client/App.tsx';
import {
  createDefaultAppSettings,
  type Listing,
  type MarketplaceId,
  type MarketplaceStatus,
  type SettingsResponse,
  type TranslationDiagnostic,
} from '../../src/shared/index.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function createMockSettingsResponse(): SettingsResponse {
  return {
    settings: {
      ...createDefaultAppSettings(),
      homePostalCode: '98101',
      defaultLocalPickupRadiusMiles: 50,
    },
    ebay: {
      configured: true,
      origin: 'file',
      clientId: 'ebay-client-1',
      clientSecretMasked: '••••••••a9f2',
    },
    dataDir: 'C:\\Users\\test\\AppData\\Local\\unified-marketplace-search',
    browserProfiles: {
      facebook: { exists: false, activeContext: false },
      poshmark: { exists: false, activeContext: false },
      mercari: { exists: false, activeContext: false },
    },
  };
}

function encodeSse(events: Array<{ event: string; data: unknown }>): string {
  return events
    .map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
    .join('');
}

function createSseResponse(events: Array<{ event: string; data: unknown }>): Response {
  const payload = encodeSse(events);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function makeDiagnostics(
  marketplaces: MarketplaceId[],
): Partial<Record<MarketplaceId, TranslationDiagnostic>> {
  const map: Partial<Record<MarketplaceId, TranslationDiagnostic>> = {};
  for (const mp of marketplaces) {
    map[mp] = {
      marketplace: mp,
      status: mp === 'ebay' ? 'broadened' : 'exact',
      notices:
        mp === 'ebay'
          ? ['Included eBay general Used (3000) alongside granular tiers.']
          : [],
      nativeSearchUrl: `https://example.com/search/${mp}`,
    };
  }
  return map;
}

function makeStatuses(
  marketplaces: MarketplaceId[],
  overrides: Partial<Record<MarketplaceId, Partial<MarketplaceStatus>>> = {},
): Partial<Record<MarketplaceId, MarketplaceStatus>> {
  const map: Partial<Record<MarketplaceId, MarketplaceStatus>> = {};
  for (const mp of marketplaces) {
    map[mp] = {
      marketplace: mp,
      runStatus: mp === 'ebay' ? 'success' : 'unconfigured',
      translationStatus: mp === 'ebay' ? 'broadened' : 'exact',
      notices:
        mp === 'ebay'
          ? ['Included eBay general Used (3000) alongside granular tiers.']
          : [],
      nativeSearchUrl: `https://example.com/search/${mp}`,
      loadedCount: mp === 'ebay' ? 2 : 0,
      droppedMalformedCount: 0,
      errorMessage: mp === 'ebay' ? null : `${mp} not configured yet`,
      ...overrides[mp],
    };
  }
  return map;
}

const EBAY_PAGE_1: Listing[] = [
  {
    marketplace: 'ebay',
    marketplaceListingId: 'e1',
    url: 'https://www.ebay.com/itm/e1',
    title: 'Patagonia Nano Puff Jacket Blue',
    price: 75,
    shippingPrice: 0,
    shippingType: 'free',
    listingFormat: 'fixed_price',
    bidCount: null,
    buyNowPrice: null,
    thumbnailUrl: 'https://i.ebayimg.com/e1.jpg',
    conditionLabel: 'Pre-owned',
    locationLabel: 'Seattle, WA',
    listedAt: '2026-11-22T00:00:00Z',
    adapterRank: 1,
  },
  {
    marketplace: 'ebay',
    marketplaceListingId: 'e2',
    url: 'https://www.ebay.com/itm/e2',
    title: 'Patagonia Down Sweater Auction',
    price: 55,
    shippingPrice: 8.5,
    shippingType: 'known',
    listingFormat: 'auction',
    bidCount: 4,
    buyNowPrice: 120,
    thumbnailUrl: null,
    conditionLabel: 'Like New',
    locationLabel: 'Portland, OR',
    listedAt: '2026-11-21T12:00:00Z',
    adapterRank: 2,
  },
];

const EBAY_PAGE_2: Listing[] = [
  {
    marketplace: 'ebay',
    marketplaceListingId: 'e3',
    url: 'https://www.ebay.com/itm/e3',
    title: 'Patagonia R1 Fleece',
    price: 49,
    shippingPrice: null,
    shippingType: 'buyer_paid_unknown',
    listingFormat: 'fixed_price',
    bidCount: null,
    buyNowPrice: null,
    thumbnailUrl: 'https://i.ebayimg.com/e3.jpg',
    conditionLabel: 'Good',
    locationLabel: 'Denver, CO',
    listedAt: '2026-11-20T10:00:00Z',
    adapterRank: 3,
  },
];

describe('Search Workbench UI', () => {
  it('validates non-empty trimmed keywords, >=1 Marketplace toggle, and 0 <= priceMin <= priceMax', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/settings') {
        return new Response(JSON.stringify(createMockSettingsResponse()), { status: 200 });
      }
      throw new Error(`Unexpected call: ${url}`);
    });

    render(<App fetchImpl={fetchMock} />);

    const main = screen.getByRole('main');

    // Empty keywords -> validation error, no stream call
    await userEvent.click(within(main).getByRole('button', { name: /^Search$/i }));
    expect(screen.getByRole('alert')).toHaveTextContent(/Enter search keywords/i);
    expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/searches/stream')).toBe(false);

    // Enter keywords, then uncheck all 4 Marketplace toggles
    const kwInput = screen.getByLabelText(/Search keywords/i);
    await userEvent.type(kwInput, '  patagonia  ');
    const mpGroup = screen.getByRole('group', { name: /Target Marketplaces/i });
    for (const label of ['eBay', 'Poshmark', 'Mercari US', 'Facebook Marketplace']) {
      const toggle = within(mpGroup).getByRole('button', { name: label });
      expect(toggle).toHaveAttribute('aria-pressed', 'true');
      await userEvent.click(toggle);
    }

    await userEvent.click(within(main).getByRole('button', { name: /^Search$/i }));
    expect(screen.getByRole('alert')).toHaveTextContent(/Select at least one Marketplace/i);

    // Re-enable eBay, then set inverted priceMin > priceMax
    await userEvent.click(within(mpGroup).getByRole('button', { name: 'eBay' }));
    const minInput = screen.getByLabelText(/Min price/i);
    const maxInput = screen.getByLabelText(/Max price/i);
    await userEvent.type(minInput, '200');
    await userEvent.type(maxInput, '50');
    await userEvent.click(within(main).getByRole('button', { name: /^Search$/i }));

    expect(screen.getByRole('alert')).toHaveTextContent(/Minimum price/i);
    expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/searches/stream')).toBe(false);
  });

  it('streams search results, renders 4-card status strip with diagnostic popover, renders Listing cards, loads more, and refreshes', async () => {
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ url, method, body });

      if (url === '/api/settings') {
        return new Response(JSON.stringify(createMockSettingsResponse()), { status: 200 });
      }

      if (url === '/api/searches/stream') {
        const requestedMps = (body?.marketplaces as MarketplaceId[]) ?? ['ebay', 'poshmark', 'mercari', 'facebook'];
        return createSseResponse([
          {
            event: 'run_started',
            data: {
              searchRunId: 'run-1',
              diagnostics: makeDiagnostics(requestedMps),
              statuses: makeStatuses(requestedMps, {
                ebay: { runStatus: 'running', loadedCount: 0 },
              }),
            },
          },
          {
            event: 'listings_batch',
            data: {
              searchRunId: 'run-1',
              marketplace: 'ebay',
              listings: EBAY_PAGE_1,
              hasMore: true,
            },
          },
          {
            event: 'run_complete',
            data: {
              searchRunId: 'run-1',
              statuses: makeStatuses(requestedMps),
            },
          },
        ]);
      }

      if (url === '/api/searches/run-1/load-more') {
        return createSseResponse([
          {
            event: 'listings_batch',
            data: {
              searchRunId: 'run-1',
              marketplace: 'ebay',
              listings: EBAY_PAGE_2,
              hasMore: false,
            },
          },
          {
            event: 'run_complete',
            data: {
              searchRunId: 'run-1',
              statuses: makeStatuses(['ebay', 'poshmark', 'mercari', 'facebook'], {
                ebay: { loadedCount: 3 },
              }),
            },
          },
        ]);
      }

      if (url === '/api/searches/run-1/retry/poshmark') {
        return createSseResponse([
          {
            event: 'run_complete',
            data: {
              searchRunId: 'run-1',
              statuses: makeStatuses(['ebay', 'poshmark', 'mercari', 'facebook'], {
                ebay: { loadedCount: 3 },
                poshmark: { runStatus: 'empty', loadedCount: 0, errorMessage: null },
              }),
            },
          },
        ]);
      }

      if (url === '/api/browser/poshmark/open-session') {
        return new Response(JSON.stringify({ ok: true, marketplace: 'poshmark' }), { status: 200 });
      }

      throw new Error(`Unexpected request: ${method} ${url}`);
    });

    render(<App fetchImpl={fetchMock} />);

    // Configure filters in left sidebar
    const main = screen.getByRole('main');
    await userEvent.type(screen.getByLabelText(/Search keywords/i), 'patagonia nano puff');
    await userEvent.type(screen.getByLabelText(/Min price/i), '25');
    await userEvent.type(screen.getByLabelText(/Max price/i), '150');
    await userEvent.click(screen.getByRole('checkbox', { name: /Like New/i }));
    await userEvent.click(screen.getByRole('radio', { name: /Local Pickup/i }));
    await userEvent.selectOptions(screen.getByLabelText(/Radius/i), '25');
    await userEvent.selectOptions(screen.getByLabelText(/Sort order/i), 'price_asc');

    await userEvent.click(within(main).getByRole('button', { name: /^Search$/i }));

    // Verify Listings rendered (fixed price + auction)
    await waitFor(() => {
      expect(screen.getByText('Patagonia Nano Puff Jacket Blue')).toBeInTheDocument();
      expect(screen.getByText('Patagonia Down Sweater Auction')).toBeInTheDocument();
    });

    expect(screen.getByText('$75.00')).toBeInTheDocument();
    expect(screen.getByText(/Free shipping/i)).toBeInTheDocument();
    expect(screen.getByText('$55.00')).toBeInTheDocument();
    expect(screen.getByText(/4 bids/i)).toBeInTheDocument();
    expect(screen.getByText(/Buy Now \$120\.00/i)).toBeInTheDocument();
    expect(screen.getByText(/\+\$8\.50 shipping/i)).toBeInTheDocument();

    // Verify 4-card status strip & open diagnostic tooltip via i button
    const ebayCard = screen.getByTestId('status-card-ebay');
    expect(within(ebayCard).getByText(/Broadened/i)).toBeInTheDocument();
    expect(within(ebayCard).getByRole('link', { name: /Open on eBay/i })).toHaveAttribute(
      'href',
      'https://example.com/search/ebay',
    );

    const infoBtn = within(ebayCard).getByRole('button', { name: /eBay status details/i });
    await userEvent.click(infoBtn);
    expect(infoBtn).toHaveAttribute('aria-expanded', 'true');
    const tooltip = document.getElementById('status-tip-ebay');
    expect(tooltip).toBeVisible();
    expect(tooltip).toHaveTextContent(/Included eBay general Used \(3000\)/i);

    // Poshmark card has Open browser session & Retry Poshmark
    const poshCard = screen.getByTestId('status-card-poshmark');
    await userEvent.click(within(poshCard).getByRole('button', { name: /Open browser session/i }));
    await waitFor(() => {
      expect(
        calls.some((c) => c.url === '/api/browser/poshmark/open-session' && c.method === 'POST'),
      ).toBe(true);
    });

    await userEvent.click(within(poshCard).getByRole('button', { name: /Retry Poshmark/i }));
    await waitFor(() => {
      expect(
        calls.some((c) => c.url === '/api/searches/run-1/retry/poshmark' && c.method === 'POST'),
      ).toBe(true);
    });

    // Click Load more Listings
    const loadMoreBtn = screen.getByRole('button', { name: /Load more Listings/i });
    expect(loadMoreBtn).toBeEnabled();
    await userEvent.click(loadMoreBtn);

    await waitFor(() => {
      expect(screen.getByText('Patagonia R1 Fleece')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /No more Listings|Load more Listings/i })).toBeDisabled();

    // Click Refresh -> sends refresh: true
    await userEvent.click(screen.getByRole('button', { name: /^Refresh$/i }));
    await waitFor(() => {
      const refreshCall = calls.filter((c) => c.url === '/api/searches/stream').at(-1);
      expect(refreshCall?.body?.refresh).toBe(true);
      expect(refreshCall?.body?.sortOrder).toBe('price_asc');
      expect((refreshCall?.body?.unifiedFilters as { conditions: string[]; fulfillment: string; localPickupRadiusMiles: number }).conditions).toEqual([
        'like_new',
      ]);
      expect((refreshCall?.body?.unifiedFilters as { fulfillment: string }).fulfillment).toBe('local_pickup');
      expect((refreshCall?.body?.unifiedFilters as { localPickupRadiusMiles: number }).localPickupRadiusMiles).toBe(25);
    });
  });
});
