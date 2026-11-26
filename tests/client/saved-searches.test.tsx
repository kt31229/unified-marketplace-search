// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/client/App.tsx';
import {
  createDefaultAppSettings,
  createDefaultUnifiedFilter,
  type Listing,
  type MarketplaceId,
  type MarketplaceStatus,
  type SavedSearch,
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

function makeStatuses(
  marketplaces: MarketplaceId[],
  overrides: Partial<Record<MarketplaceId, Partial<MarketplaceStatus>>> = {},
): Partial<Record<MarketplaceId, MarketplaceStatus>> {
  const result: Partial<Record<MarketplaceId, MarketplaceStatus>> = {};
  for (const mp of marketplaces) {
    result[mp] = {
      marketplace: mp,
      runStatus: 'success',
      translationStatus: 'exact',
      notices: [],
      nativeSearchUrl: `https://example.com/${mp}`,
      loadedCount: 0,
      droppedMalformedCount: 0,
      errorMessage: null,
      ...overrides[mp],
    };
  }
  return result;
}

function makeDiagnostics(
  marketplaces: MarketplaceId[],
): Partial<Record<MarketplaceId, TranslationDiagnostic>> {
  const result: Partial<Record<MarketplaceId, TranslationDiagnostic>> = {};
  for (const mp of marketplaces) {
    result[mp] = {
      marketplace: mp,
      status: 'exact',
      notices: [],
      nativeSearchUrl: `https://example.com/${mp}`,
    };
  }
  return result;
}

function createSavedSearchFetchMock(initialSaved: SavedSearch[] = []) {
  let savedList = initialSaved.map((item) => structuredClone(item));
  let nextId = 100;
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    calls.push({ url, method, body });

    if (url === '/api/settings' && method === 'GET') {
      return new Response(JSON.stringify(createMockSettingsResponse()), { status: 200 });
    }

    if (url === '/api/saved-searches' && method === 'GET') {
      return new Response(JSON.stringify({ savedSearches: savedList }), { status: 200 });
    }

    if (url === '/api/saved-searches' && method === 'POST') {
      nextId += 1;
      const created: SavedSearch = {
        id: `saved-${nextId}`,
        name: String(body?.name ?? ''),
        keywords: String(body?.keywords ?? ''),
        unifiedFilters: body?.unifiedFilters as SavedSearch['unifiedFilters'],
        marketplaces: body?.marketplaces as MarketplaceId[],
        sortOrder: (body?.sortOrder as SavedSearch['sortOrder']) ?? 'relevance',
        createdAt: '2026-11-22T12:00:00Z',
        lastRunAt: null,
      };
      savedList = [created, ...savedList];
      return new Response(JSON.stringify({ savedSearch: created }), { status: 201 });
    }

    const runMatch = url.match(/^\/api\/saved-searches\/([^/]+)\/run$/);
    if (runMatch && method === 'POST') {
      const id = runMatch[1]!;
      const idx = savedList.findIndex((item) => item.id === id);
      if (idx === -1) {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
      }
      const updated: SavedSearch = {
        ...savedList[idx]!,
        lastRunAt: '2026-11-22T18:00:00Z',
      };
      savedList[idx] = updated;
      return new Response(JSON.stringify({ savedSearch: updated }), { status: 200 });
    }

    const itemMatch = url.match(/^\/api\/saved-searches\/([^/]+)$/);
    if (itemMatch && method === 'PATCH') {
      const id = itemMatch[1]!;
      const idx = savedList.findIndex((item) => item.id === id);
      if (idx === -1) {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
      }
      const updated: SavedSearch = {
        ...savedList[idx]!,
        ...(body?.name !== undefined ? { name: String(body.name) } : {}),
        ...(body?.keywords !== undefined ? { keywords: String(body.keywords) } : {}),
        ...(body?.unifiedFilters !== undefined
          ? { unifiedFilters: body.unifiedFilters as SavedSearch['unifiedFilters'] }
          : {}),
        ...(body?.marketplaces !== undefined
          ? { marketplaces: body.marketplaces as MarketplaceId[] }
          : {}),
        ...(body?.sortOrder !== undefined
          ? { sortOrder: body.sortOrder as SavedSearch['sortOrder'] }
          : {}),
      };
      savedList[idx] = updated;
      return new Response(JSON.stringify({ savedSearch: updated }), { status: 200 });
    }

    if (itemMatch && method === 'DELETE') {
      const id = itemMatch[1]!;
      savedList = savedList.filter((item) => item.id !== id);
      return new Response(JSON.stringify({ deleted: true }), { status: 200 });
    }

    if (url === '/api/searches/stream' && method === 'POST') {
      const mps = (body?.marketplaces as MarketplaceId[]) ?? ['ebay'];
      const listings: Listing[] = mps.includes('poshmark')
        ? [
            {
              marketplace: 'poshmark',
              marketplaceListingId: 'pm-99',
              url: 'https://poshmark.com/listing/pm-99',
              title: `${String(body?.keywords)} Result`,
              price: 60,
              shippingPrice: 6.49,
              shippingType: 'known',
              listingFormat: 'fixed_price',
              bidCount: null,
              buyNowPrice: null,
              thumbnailUrl: null,
              conditionLabel: 'Like New',
              locationLabel: null,
              listedAt: '2026-11-22T00:00:00Z',
              adapterRank: 1,
            },
          ]
        : [];
      return createSseResponse([
        {
          event: 'run_started',
          data: {
            searchRunId: 'run-saved-1',
            diagnostics: makeDiagnostics(mps),
            statuses: makeStatuses(mps),
          },
        },
        ...(listings.length > 0
          ? [
              {
                event: 'listings_batch',
                data: {
                  searchRunId: 'run-saved-1',
                  marketplace: 'poshmark',
                  listings,
                  hasMore: false,
                },
              },
            ]
          : []),
        {
          event: 'run_complete',
          data: {
            searchRunId: 'run-saved-1',
            statuses: makeStatuses(mps, {
              ...(mps.includes('ebay')
                ? {
                    ebay: {
                      runStatus: 'unconfigured',
                      loadedCount: 0,
                      errorMessage: 'eBay credentials not configured',
                    },
                  }
                : {}),
              ...(mps.includes('poshmark') ? { poshmark: { loadedCount: 1 } } : {}),
            }),
          },
        },
      ]);
    }

    throw new Error(`Unexpected call: ${method} ${url}`);
  });

  return { fetchMock, calls };
}

describe('Saved Searches Sidebar UI', () => {
  it('saves searches with auto-suggested editable name (including duplicates) and clicks to populate & run without re-ordering', async () => {
    const existingOlder: SavedSearch = {
      id: 'saved-older',
      name: 'Older Camera Search',
      keywords: 'fujifilm x100v',
      unifiedFilters: {
        ...createDefaultUnifiedFilter(),
        priceMin: 500,
        priceMax: 1200,
        conditions: ['like_new'],
        fulfillment: 'shipping',
      },
      marketplaces: ['ebay', 'poshmark'],
      sortOrder: 'price_desc',
      createdAt: '2026-11-20T10:00:00Z',
      lastRunAt: null,
    };
    const existingNewer: SavedSearch = {
      id: 'saved-newer',
      name: 'Newer Boots Search',
      keywords: 'blundstone 550',
      unifiedFilters: createDefaultUnifiedFilter(),
      marketplaces: ['mercari'],
      sortOrder: 'newest',
      createdAt: '2026-11-21T10:00:00Z',
      lastRunAt: null,
    };

    const { fetchMock, calls } = createSavedSearchFetchMock([existingNewer, existingOlder]);
    render(<App fetchImpl={fetchMock} />);

    const savedRegion = screen.getByRole('region', { name: /Saved Searches/i });

    await waitFor(() => {
      expect(within(savedRegion).getByText('Newer Boots Search')).toBeInTheDocument();
      expect(within(savedRegion).getByText('Older Camera Search')).toBeInTheDocument();
    });

    // Clicking "+ Save Search" with empty keywords shows validation error and does not save
    await userEvent.click(within(savedRegion).getByRole('button', { name: /Save Search/i }));
    expect(within(savedRegion).getByRole('alert')).toHaveTextContent(/Enter search keywords/i);

    // Configure search + Unified Filters, then save with auto-suggested name
    await userEvent.type(screen.getByLabelText(/Search keywords/i), 'patagonia fleece');
    await userEvent.type(screen.getByLabelText(/Min price/i), '20');
    await userEvent.type(screen.getByLabelText(/Max price/i), '80');
    await userEvent.click(within(savedRegion).getByRole('button', { name: /Save Search/i }));

    const saveDialog = screen.getByRole('dialog');
    const nameInput = within(saveDialog).getByLabelText(/Saved Search name/i) as HTMLInputElement;
    expect(nameInput.value).toContain('patagonia fleece');

    // Replace with custom duplicate-friendly name
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Newer Boots Search');
    await userEvent.click(within(saveDialog).getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      expect(within(savedRegion).getAllByText('Newer Boots Search')).toHaveLength(2);
    });

    // Order before clicking Older Camera Search: [newly created, existingNewer, existingOlder]
    const listContainer = within(savedRegion).getByTestId('saved-searches-list');
    expect(listContainer).toHaveClass('saved-list');

    const getOrderedNames = () =>
      Array.from(listContainer.querySelectorAll('[data-saved-search-name]')).map(
        (el) => el.textContent,
      );
    expect(getOrderedNames()).toEqual([
      'Newer Boots Search',
      'Newer Boots Search',
      'Older Camera Search',
    ]);

    // Click Older Camera Search -> populates all fields, streams search, updates lastRunAt without reordering
    await userEvent.click(within(savedRegion).getByRole('button', { name: 'Older Camera Search' }));

    await waitFor(() => {
      expect(screen.getByLabelText(/Search keywords/i)).toHaveValue('fujifilm x100v');
      expect(screen.getByLabelText(/Min price/i)).toHaveValue(500);
      expect(screen.getByLabelText(/Max price/i)).toHaveValue(1200);
      expect(screen.getByRole('checkbox', { name: /Like New/i })).toBeChecked();
      expect(screen.getByRole('radio', { name: /^Shipping$/i })).toBeChecked();
      expect(screen.getByLabelText(/Sort order/i)).toHaveValue('price_desc');
    });

    // Target Marketplaces synced to ['ebay', 'poshmark']
    const mpGroup = screen.getByRole('group', { name: /Target Marketplaces/i });
    expect(within(mpGroup).getByRole('button', { name: 'eBay' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(mpGroup).getByRole('button', { name: 'Poshmark' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(mpGroup).getByRole('button', { name: 'Mercari US' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    // Triggered /api/saved-searches/:id/run and /api/searches/stream, and tolerated unconfigured eBay
    await waitFor(() => {
      expect(
        calls.some((c) => c.url === '/api/saved-searches/saved-older/run' && c.method === 'POST'),
      ).toBe(true);
      expect(screen.getByText('fujifilm x100v Result')).toBeInTheDocument();
      expect(
        within(screen.getByTestId('status-card-ebay')).getByText(/Unconfigured/i),
      ).toBeInTheDocument();
    });

    // Order in sidebar MUST remain unchanged!
    expect(getOrderedNames()).toEqual([
      'Newer Boots Search',
      'Newer Boots Search',
      'Older Camera Search',
    ]);
    // lastRunAt updated in place (no longer "Never run" on Older Camera Search)
    const olderCard = within(savedRegion).getByTestId('saved-search-item-saved-older');
    expect(olderCard).not.toHaveTextContent(/Never run/i);
  });

  it('exposes dirty-state Update Saved Search / Save as New without auto-overwriting, inline rename, <dialog> delete, and bounded list with >6 entries', async () => {
    const entries: SavedSearch[] = Array.from({ length: 8 }, (_, idx) => ({
      id: `s-${idx + 1}`,
      name: `Saved Item ${idx + 1}`,
      keywords: `query ${idx + 1}`,
      unifiedFilters: createDefaultUnifiedFilter(),
      marketplaces: ['ebay', 'poshmark'],
      sortOrder: 'relevance',
      createdAt: '2026-11-22T10:00:00Z',
      lastRunAt: idx === 0 ? '2026-11-22T11:55:00Z' : null,
    }));

    const { fetchMock, calls } = createSavedSearchFetchMock(entries);
    render(<App fetchImpl={fetchMock} />);

    const savedRegion = screen.getByRole('region', { name: /Saved Searches/i });
    await waitFor(() => {
      expect(within(savedRegion).getByText('Saved Item 1')).toBeInTheDocument();
      expect(within(savedRegion).getByText('Saved Item 8')).toBeInTheDocument();
    });

    const listContainer = within(savedRegion).getByTestId('saved-searches-list');
    expect(listContainer).toHaveClass('saved-list');
    expect(listContainer.querySelectorAll('[data-saved-search-name]')).toHaveLength(8);

    // Load Saved Item 2
    await userEvent.click(within(savedRegion).getByRole('button', { name: 'Saved Item 2' }));
    await waitFor(() => {
      expect(screen.getByLabelText(/Search keywords/i)).toHaveValue('query 2');
    });

    // Clean initially -> no dirty banner
    expect(within(savedRegion).queryByTestId('saved-search-dirty-banner')).not.toBeInTheDocument();

    // Modify keywords -> dirty banner appears, and NO automatic PATCH is fired
    await userEvent.type(screen.getByLabelText(/Search keywords/i), ' jacket');
    const dirtyBanner = within(savedRegion).getByTestId('saved-search-dirty-banner');
    expect(dirtyBanner).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);

    // Click "Update Saved Search" -> PATCH updates stored entry and clears dirty state
    await userEvent.click(
      within(dirtyBanner).getByRole('button', { name: /Update Saved Search/i }),
    );
    await waitFor(() => {
      expect(calls.some((c) => c.url === '/api/saved-searches/s-2' && c.method === 'PATCH')).toBe(
        true,
      );
      expect(
        within(savedRegion).queryByTestId('saved-search-dirty-banner'),
      ).not.toBeInTheDocument();
    });

    // Modify Unified Filter -> dirty again, click "Save as New" -> creates new entry without overwriting s-2
    await userEvent.type(screen.getByLabelText(/Min price/i), '30');
    const dirtyBanner2 = within(savedRegion).getByTestId('saved-search-dirty-banner');
    await userEvent.click(within(dirtyBanner2).getByRole('button', { name: /Save as New/i }));

    const saveDialog = screen.getByRole('dialog');
    const nameInput = within(saveDialog).getByLabelText(/Saved Search name/i) as HTMLInputElement;
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Saved Item 2 Copy');
    await userEvent.click(within(saveDialog).getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      expect(within(savedRegion).getByText('Saved Item 2 Copy')).toBeInTheDocument();
      expect(within(savedRegion).getByText('Saved Item 2')).toBeInTheDocument();
    });

    // Inline rename Saved Item 3 via pencil icon immediately right of name
    await userEvent.click(within(savedRegion).getByRole('button', { name: 'Rename Saved Item 3' }));
    const renameInput = within(savedRegion).getByLabelText('Edit name for Saved Item 3');
    await userEvent.clear(renameInput);
    await userEvent.type(renameInput, 'Renamed Item 3');
    await userEvent.click(within(savedRegion).getByRole('button', { name: /Confirm rename/i }));

    await waitFor(() => {
      expect(within(savedRegion).getByText('Renamed Item 3')).toBeInTheDocument();
      expect(
        calls.some(
          (c) =>
            c.url === '/api/saved-searches/s-3' &&
            c.method === 'PATCH' &&
            c.body?.name === 'Renamed Item 3',
        ),
      ).toBe(true);
    });

    // Delete Saved Item 4 via top-right × -> opens native <dialog> confirmation
    await userEvent.click(within(savedRegion).getByRole('button', { name: 'Delete Saved Item 4' }));
    const confirmDialog = screen.getByRole('dialog');
    expect(confirmDialog).toHaveTextContent(/Saved Item 4/);

    // Cancel keeps it
    await userEvent.click(within(confirmDialog).getByRole('button', { name: /Cancel/i }));
    expect(within(savedRegion).getByText('Saved Item 4')).toBeInTheDocument();

    // Confirm removes it
    await userEvent.click(within(savedRegion).getByRole('button', { name: 'Delete Saved Item 4' }));
    const confirmDialog2 = screen.getByRole('dialog');
    await userEvent.click(within(confirmDialog2).getByRole('button', { name: /^Delete$/i }));

    await waitFor(() => {
      expect(within(savedRegion).queryByText('Saved Item 4')).not.toBeInTheDocument();
      expect(calls.some((c) => c.url === '/api/saved-searches/s-4' && c.method === 'DELETE')).toBe(
        true,
      );
    });
  });
});
