// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/client/App.tsx';
import {
  createDefaultAppSettings,
  type Listing,
  type MarketplaceId,
  type SettingsResponse,
  type WatchlistEntry,
} from '../../src/shared/index.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function createMockSettingsResponse(): SettingsResponse {
  return {
    settings: createDefaultAppSettings(),
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

function createSseResponse(events: Array<{ event: string; data: unknown }>): Response {
  const payload = events
    .map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
    .join('');
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

const SEARCH_LISTINGS: Listing[] = [
  {
    marketplace: 'ebay',
    marketplaceListingId: 'ebay-1',
    url: 'https://www.ebay.com/itm/ebay-1',
    title: 'Vintage Polaroid SX-70 Camera',
    price: 125,
    shippingPrice: 0,
    shippingType: 'free',
    listingFormat: 'fixed_price',
    bidCount: null,
    buyNowPrice: null,
    thumbnailUrl: 'https://i.ebayimg.com/sx70.jpg',
    conditionLabel: 'Good',
    locationLabel: 'Seattle, WA',
    listedAt: '2026-11-22T01:00:00Z',
    adapterRank: 1,
  },
];

function createWatchlistFetchMock(initialEntries: WatchlistEntry[]) {
  let entries = structuredClone(initialEntries);
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  let counter = 1;

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    calls.push({ url, method, body });

    if (url === '/api/settings') {
      return new Response(JSON.stringify(createMockSettingsResponse()), { status: 200 });
    }

    if (url === '/api/watchlist' && method === 'GET') {
      return new Response(JSON.stringify({ entries }), { status: 200 });
    }

    if (url === '/api/watchlist' && method === 'POST') {
      const payload = (body?.listing ?? body) as Omit<
        WatchlistEntry,
        'cachedThumbnailPath' | 'savedAt'
      >;
      const saved: WatchlistEntry = {
        marketplace: payload.marketplace,
        marketplaceListingId: payload.marketplaceListingId,
        url: payload.url,
        title: payload.title,
        price: payload.price ?? null,
        shippingPrice: payload.shippingPrice ?? null,
        thumbnailUrl: payload.thumbnailUrl ?? null,
        cachedThumbnailPath: null,
        savedAt: new Date(Date.parse('2026-11-22T12:00:00Z') + counter++ * 1000).toISOString(),
      };
      entries = [
        saved,
        ...entries.filter(
          (e) =>
            !(
              e.marketplace === saved.marketplace &&
              e.marketplaceListingId === saved.marketplaceListingId
            ),
        ),
      ];
      return new Response(JSON.stringify({ entry: saved }), { status: 201 });
    }

    if (url.startsWith('/api/watchlist/') && method === 'DELETE') {
      const parts = url.replace('/api/watchlist/', '').split('/');
      const mp = parts[0] as MarketplaceId;
      const listingId = decodeURIComponent(parts[1] ?? '');
      entries = entries.filter(
        (e) => !(e.marketplace === mp && e.marketplaceListingId === listingId),
      );
      return new Response(JSON.stringify({ deleted: true }), { status: 200 });
    }

    if (url === '/api/searches/stream' && method === 'POST') {
      return createSseResponse([
        {
          event: 'run_started',
          data: {
            searchRunId: 'run-wl-1',
            diagnostics: {
              ebay: {
                marketplace: 'ebay',
                status: 'exact',
                notices: [],
                nativeSearchUrl: 'https://www.ebay.com/sch/i.html',
              },
              poshmark: {
                marketplace: 'poshmark',
                status: 'exact',
                notices: [],
                nativeSearchUrl: 'https://poshmark.com/search',
              },
              mercari: {
                marketplace: 'mercari',
                status: 'exact',
                notices: [],
                nativeSearchUrl: 'https://www.mercari.com/search/',
              },
              facebook: {
                marketplace: 'facebook',
                status: 'exact',
                notices: [],
                nativeSearchUrl: 'https://www.facebook.com/marketplace/',
              },
            },
            statuses: {
              ebay: {
                marketplace: 'ebay',
                runStatus: 'success',
                translationStatus: 'exact',
                notices: [],
                nativeSearchUrl: 'https://www.ebay.com/sch/i.html',
                loadedCount: 1,
                droppedMalformedCount: 0,
              },
              poshmark: {
                marketplace: 'poshmark',
                runStatus: 'empty',
                translationStatus: 'exact',
                notices: [],
                nativeSearchUrl: 'https://poshmark.com/search',
                loadedCount: 0,
                droppedMalformedCount: 0,
              },
              mercari: {
                marketplace: 'mercari',
                runStatus: 'empty',
                translationStatus: 'exact',
                notices: [],
                nativeSearchUrl: 'https://www.mercari.com/search/',
                loadedCount: 0,
                droppedMalformedCount: 0,
              },
              facebook: {
                marketplace: 'facebook',
                runStatus: 'empty',
                translationStatus: 'exact',
                notices: [],
                nativeSearchUrl: 'https://www.facebook.com/marketplace/',
                loadedCount: 0,
                droppedMalformedCount: 0,
              },
            },
          },
        },
        {
          event: 'listings_batch',
          data: {
            searchRunId: 'run-wl-1',
            marketplace: 'ebay',
            listings: SEARCH_LISTINGS,
            hasMore: false,
          },
        },
        {
          event: 'run_complete',
          data: {
            searchRunId: 'run-wl-1',
            statuses: {},
          },
        },
      ]);
    }

    throw new Error(`Unexpected call: ${method} ${url}`);
  });

  return { fetchMock, calls, getEntries: () => entries };
}

describe('Watchlist UI and synchronized Listing card toggle', () => {
  it('synchronizes one-click Watchlist toggle on Listing cards with the Watchlist view and nav count', async () => {
    const { fetchMock, calls } = createWatchlistFetchMock([]);
    render(<App fetchImpl={fetchMock} />);

    // Run a search
    await userEvent.type(screen.getByLabelText(/Search keywords/i), 'polaroid');
    await userEvent.click(
      within(screen.getByRole('main')).getByRole('button', { name: /^Search$/i }),
    );

    await waitFor(() => {
      expect(screen.getByText('Vintage Polaroid SX-70 Camera')).toBeInTheDocument();
    });

    const toggleBtn = screen.getByRole('button', { name: /Save to Watchlist/i });
    expect(toggleBtn).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(toggleBtn);

    await waitFor(() => {
      expect(calls.some((c) => c.url === '/api/watchlist' && c.method === 'POST')).toBe(true);
      expect(screen.getByRole('button', { name: /Remove from Watchlist/i })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });

    const nav = screen.getByRole('navigation', { name: /Primary/i });
    const watchlistNavBtn = within(nav).getByRole('button', { name: /Watchlist/i });
    expect(watchlistNavBtn).toHaveTextContent(/1/);

    // Switch to Watchlist view -> saved entry is rendered
    await userEvent.click(watchlistNavBtn);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Watchlist/i })).toBeInTheDocument();
      expect(
        within(screen.getByTestId('watchlist-grid')).getByText('Vintage Polaroid SX-70 Camera'),
      ).toBeInTheDocument();
    });

    // Remove instantly from Watchlist -> switches back to Search shows unsaved toggle
    await userEvent.click(screen.getByRole('button', { name: /^Remove$/i }));
    await waitFor(() => {
      expect(
        calls.some((c) => c.url === '/api/watchlist/ebay/ebay-1' && c.method === 'DELETE'),
      ).toBe(true);
    });

    await userEvent.click(within(nav).getByRole('button', { name: /^Search$/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Save to Watchlist/i })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
    });
  });

  it('supports Marketplace filter, price_asc/price_desc sorting with null prices at bottom, thumbnail priority fallback, and Undo toast', async () => {
    const seededEntries: WatchlistEntry[] = [
      {
        marketplace: 'facebook',
        marketplaceListingId: 'fb-1',
        url: 'https://www.facebook.com/marketplace/item/fb-1/',
        title: 'Mid-Century Lamp',
        price: 85,
        shippingPrice: null,
        thumbnailUrl: 'https://fbcdn.example.com/lamp.jpg',
        cachedThumbnailPath: 'fb1hash.jpg',
        savedAt: '2026-11-22T09:00:00Z',
      },
      {
        marketplace: 'poshmark',
        marketplaceListingId: 'pm-1',
        url: 'https://poshmark.com/listing/pm-1',
        title: 'Cashmere Scarf',
        price: null,
        shippingPrice: 6.49,
        thumbnailUrl: 'https://posh.example.com/scarf.jpg',
        cachedThumbnailPath: null,
        savedAt: '2026-11-22T11:00:00Z',
      },
      {
        marketplace: 'mercari',
        marketplaceListingId: 'mc-1',
        url: 'https://www.mercari.com/us/item/mc-1/',
        title: 'Ceramic Mug Set',
        price: 24,
        shippingPrice: 0,
        thumbnailUrl: null,
        cachedThumbnailPath: null,
        savedAt: '2026-11-22T10:00:00Z',
      },
    ];

    const { fetchMock, calls } = createWatchlistFetchMock(seededEntries);
    render(<App fetchImpl={fetchMock} initialView="watchlist" />);

    await waitFor(() => {
      expect(screen.getByText('Mid-Century Lamp')).toBeInTheDocument();
      expect(screen.getByText('Cashmere Scarf')).toBeInTheDocument();
      expect(screen.getByText('Ceramic Mug Set')).toBeInTheDocument();
    });

    // Default sort: savedAt desc -> Cashmere Scarf (11:00), Ceramic Mug Set (10:00), Mid-Century Lamp (09:00)
    const getTitlesInOrder = () =>
      screen
        .getAllByTestId('watchlist-card')
        .map((card) => within(card).getByRole('heading').textContent);

    expect(getTitlesInOrder()).toEqual(['Cashmere Scarf', 'Ceramic Mug Set', 'Mid-Century Lamp']);

    // Verify image priority: cachedThumbnailPath -> /api/thumbnails/fb1hash.jpg
    const lampCard = screen.getByTestId('watchlist-card-facebook-fb-1');
    const lampImg = within(lampCard).getByRole('img', { name: 'Mid-Century Lamp' });
    expect(lampImg).toHaveAttribute('src', '/api/thumbnails/fb1hash.jpg');

    // Simulate cached thumbnail error -> falls back to remote thumbnailUrl
    fireEvent.error(lampImg);
    await waitFor(() => {
      expect(within(lampCard).getByRole('img', { name: 'Mid-Century Lamp' })).toHaveAttribute(
        'src',
        'https://fbcdn.example.com/lamp.jpg',
      );
    });

    // Simulate remote thumbnailUrl error -> falls back to clean broken-image placeholder
    fireEvent.error(within(lampCard).getByRole('img', { name: 'Mid-Century Lamp' }));
    await waitFor(() => {
      expect(within(lampCard).queryByRole('img')).not.toBeInTheDocument();
      expect(within(lampCard).getByLabelText(/Image unavailable/i)).toBeInTheDocument();
    });

    // Direct link-out present
    expect(
      within(lampCard).getByRole('link', { name: /Open on Facebook Marketplace/i }),
    ).toHaveAttribute('href', 'https://www.facebook.com/marketplace/item/fb-1/');

    // Sort price_asc -> Ceramic Mug Set ($24), Mid-Century Lamp ($85), Cashmere Scarf (null at bottom)
    const sortSelect = screen.getByLabelText(/Sort Watchlist/i);
    await userEvent.selectOptions(sortSelect, 'price_asc');
    expect(getTitlesInOrder()).toEqual(['Ceramic Mug Set', 'Mid-Century Lamp', 'Cashmere Scarf']);

    // Sort price_desc -> Mid-Century Lamp ($85), Ceramic Mug Set ($24), Cashmere Scarf (null STILL at bottom)
    await userEvent.selectOptions(sortSelect, 'price_desc');
    expect(getTitlesInOrder()).toEqual(['Mid-Century Lamp', 'Ceramic Mug Set', 'Cashmere Scarf']);

    // Filter by Marketplace
    const mpFilter = screen.getByLabelText(/Filter by Marketplace/i);
    await userEvent.selectOptions(mpFilter, 'mercari');
    expect(getTitlesInOrder()).toEqual(['Ceramic Mug Set']);
    await userEvent.selectOptions(mpFilter, 'all');

    // Instant removal (no <dialog>) + popover="manual" Undo toast inside ARIA region/live region
    const mugCard = screen.getByTestId('watchlist-card-mercari-mc-1');
    await userEvent.click(within(mugCard).getByRole('button', { name: /^Remove$/i }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText('Ceramic Mug Set')).not.toBeInTheDocument();
    });

    const toast = document.getElementById('undo-toast');
    expect(toast).toBeInTheDocument();
    expect(toast).toHaveAttribute('popover', 'manual');
    expect(toast).toHaveTextContent(/Removed/i);

    const liveRegion = document.getElementById('sr-live-region');
    expect(liveRegion).toHaveAttribute('aria-live', 'polite');

    const undoBtn = within(toast!).getByRole('button', { name: /^Undo$/i });
    await userEvent.click(undoBtn);

    await waitFor(() => {
      expect(calls.some((c) => c.url === '/api/watchlist' && c.method === 'POST')).toBe(true);
      expect(screen.getByText('Ceramic Mug Set')).toBeInTheDocument();
    });
  });
});
