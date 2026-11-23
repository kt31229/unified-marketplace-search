// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
  Object.defineProperty(window, 'scrollY', { value: 0, writable: true, configurable: true });
});

function setScrollY(y: number) {
  Object.defineProperty(window, 'scrollY', { value: y, writable: true, configurable: true });
  window.dispatchEvent(new Event('scroll'));
}

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

function encodeSseEvent(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function createSseResponse(events: Array<{ event: string; data: unknown }>): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const evt of events) {
        controller.enqueue(encodeSseEvent(evt.event, evt.data));
      }
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
      status: 'exact',
      notices: [],
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
      runStatus: 'success',
      translationStatus: 'exact',
      notices: [],
      nativeSearchUrl: `https://example.com/search/${mp}`,
      loadedCount: 1,
      droppedMalformedCount: 0,
      errorMessage: null,
      ...overrides[mp],
    };
  }
  return map;
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

describe('Scroll-safe merge pill, gold New badges, and post-run controls', () => {
  it('latches pending batches behind merge pill when scrolled >450px, stays latched on scroll back to top, marks merged and load-more cards with persistent gold New badges, and clears on new run', async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let streamCallCount = 0;

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/settings') {
        return new Response(JSON.stringify(createMockSettingsResponse()), { status: 200 });
      }
      if (url === '/api/saved-searches') {
        return new Response(JSON.stringify({ savedSearches: [] }), { status: 200 });
      }

      if (url === '/api/searches/stream') {
        streamCallCount += 1;
        if (streamCallCount === 1) {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
              controller.enqueue(
                encodeSseEvent('run_started', {
                  searchRunId: 'run-scroll-1',
                  diagnostics: makeDiagnostics(['ebay', 'poshmark']),
                  statuses: makeStatuses(['ebay', 'poshmark'], {
                    ebay: { runStatus: 'running', loadedCount: 0 },
                    poshmark: { runStatus: 'running', loadedCount: 0 },
                  }),
                }),
              );
              controller.enqueue(
                encodeSseEvent('listings_batch', {
                  searchRunId: 'run-scroll-1',
                  marketplace: 'ebay',
                  listings: [makeListing('ebay', 'e1', { title: 'Initial eBay Coat' })],
                  hasMore: true,
                }),
              );
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }

        // Second search run clears prior New badges
        return createSseResponse([
          {
            event: 'run_started',
            data: {
              searchRunId: 'run-scroll-2',
              diagnostics: makeDiagnostics(['ebay']),
              statuses: makeStatuses(['ebay']),
            },
          },
          {
            event: 'listings_batch',
            data: {
              searchRunId: 'run-scroll-2',
              marketplace: 'ebay',
              listings: [makeListing('ebay', 'e-fresh', { title: 'Fresh Run Coat' })],
              hasMore: false,
            },
          },
          {
            event: 'run_complete',
            data: {
              searchRunId: 'run-scroll-2',
              statuses: makeStatuses(['ebay']),
            },
          },
        ]);
      }

      if (url === '/api/searches/run-scroll-1/load-more') {
        return createSseResponse([
          {
            event: 'listings_batch',
            data: {
              searchRunId: 'run-scroll-1',
              marketplace: 'ebay',
              listings: [makeListing('ebay', 'e-more', { title: 'Loaded More eBay Vest', adapterRank: 3 })],
              hasMore: false,
            },
          },
          {
            event: 'run_complete',
            data: {
              searchRunId: 'run-scroll-1',
              statuses: makeStatuses(['ebay', 'poshmark']),
            },
          },
        ]);
      }

      throw new Error(`Unexpected call: ${url}`);
    });

    render(<App fetchImpl={fetchMock} />);
    const main = screen.getByRole('main');
    await userEvent.type(screen.getByLabelText(/Search keywords/i), 'patagonia');
    await userEvent.click(within(main).getByRole('button', { name: /^Search$/i }));

    // Initial batch at scrollY = 0 merges live with NO New badge
    await waitFor(() => {
      expect(screen.getByText('Initial eBay Coat')).toBeInTheDocument();
    });
    const grid = screen.getByTestId('listing-grid');
    expect(within(grid).queryByText('New')).not.toBeInTheDocument();

    // User scrolls past forgiving top zone (> 450px) -> latches pending-buffer mode
    act(() => {
      setScrollY(600);
    });

    // Streaming batch arrives while scrolled down -> buffered behind merge pill, NOT in grid
    await act(async () => {
      streamController?.enqueue(
        encodeSseEvent('listings_batch', {
          searchRunId: 'run-scroll-1',
          marketplace: 'poshmark',
          listings: [
            makeListing('poshmark', 'p1', { title: 'Buffered Poshmark Parka', adapterRank: 1 }),
            makeListing('poshmark', 'p2', { title: 'Buffered Poshmark Fleece', adapterRank: 2 }),
          ],
          hasMore: false,
        }),
      );
      streamController?.enqueue(
        encodeSseEvent('run_complete', {
          searchRunId: 'run-scroll-1',
          statuses: makeStatuses(['ebay', 'poshmark']),
        }),
      );
      streamController?.close();
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /\+2 new Listings — Click to merge/i })).toBeVisible();
    });
    expect(screen.queryByText('Buffered Poshmark Parka')).not.toBeInTheDocument();

    // Scroll back up to 0 -> buffer MUST stay latched until pill is clicked!
    act(() => {
      setScrollY(0);
    });
    expect(screen.getByRole('button', { name: /\+2 new Listings — Click to merge/i })).toBeVisible();
    expect(screen.queryByText('Buffered Poshmark Parka')).not.toBeInTheDocument();

    // Click merge pill -> cards appear with persistent gold "New" badges
    await userEvent.click(screen.getByRole('button', { name: /\+2 new Listings — Click to merge/i }));
    await waitFor(() => {
      expect(screen.getByText('Buffered Poshmark Parka')).toBeInTheDocument();
      expect(screen.getByText('Buffered Poshmark Fleece')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /Click to merge/i })).not.toBeInTheDocument();

    const parkaCard = screen.getByText('Buffered Poshmark Parka').closest('article')!;
    const initialCard = screen.getByText('Initial eBay Coat').closest('article')!;
    expect(within(parkaCard).getByText('New')).toHaveClass('new-badge');
    expect(within(initialCard).queryByText('New')).not.toBeInTheDocument();

    // Click "Load more Listings" -> merged card ALSO gets persistent gold "New" badge
    await userEvent.click(screen.getByRole('button', { name: /Load more Listings/i }));
    await waitFor(() => {
      expect(screen.getByText('Loaded More eBay Vest')).toBeInTheDocument();
    });
    const loadMoreCard = screen.getByText('Loaded More eBay Vest').closest('article')!;
    expect(within(loadMoreCard).getByText('New')).toHaveClass('new-badge');
    // Existing New badge stays visible (persistent for duration of search run)
    expect(within(parkaCard).getByText('New')).toBeInTheDocument();

    // Starting a new search run clears New badges
    await userEvent.click(within(main).getByRole('button', { name: /^Search$/i }));
    await waitFor(() => {
      expect(screen.getByText('Fresh Run Coat')).toBeInTheDocument();
    });
    expect(within(screen.getByTestId('listing-grid')).queryByText('New')).not.toBeInTheDocument();
  });

  it('toggles Include known shipping in price sort and queried Marketplace visibility with zero network calls, and triggers targeted single-Marketplace fetch when activating an unqueried Marketplace', async () => {
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ url, method, body });

      if (url === '/api/settings') {
        return new Response(JSON.stringify(createMockSettingsResponse()), { status: 200 });
      }
      if (url === '/api/saved-searches') {
        return new Response(JSON.stringify({ savedSearches: [] }), { status: 200 });
      }

      if (url === '/api/searches/stream') {
        // Initial run only queries ebay + poshmark (mercari & facebook unchecked)
        return createSseResponse([
          {
            event: 'run_started',
            data: {
              searchRunId: 'run-controls-1',
              diagnostics: makeDiagnostics(['ebay', 'poshmark']),
              statuses: makeStatuses(['ebay', 'poshmark'], {
                ebay: { runStatus: 'running', loadedCount: 0 },
                poshmark: { runStatus: 'running', loadedCount: 0 },
              }),
            },
          },
          {
            event: 'listings_batch',
            data: {
              searchRunId: 'run-controls-1',
              marketplace: 'ebay',
              listings: [
                // Base $40 + $15 shipping = $55 total
                makeListing('ebay', 'e-40-ship15', {
                  title: 'eBay Base 40 Ship 15',
                  price: 40,
                  shippingPrice: 15,
                  shippingType: 'known',
                  adapterRank: 1,
                }),
                // Base $45 + $0 free shipping = $45 total
                makeListing('ebay', 'e-45-free', {
                  title: 'eBay Base 45 Free',
                  price: 45,
                  shippingPrice: 0,
                  shippingType: 'free',
                  adapterRank: 2,
                }),
              ],
              hasMore: false,
            },
          },
          {
            event: 'listings_batch',
            data: {
              searchRunId: 'run-controls-1',
              marketplace: 'poshmark',
              listings: [
                // Base $42 + $6.49 shipping = $48.49 total
                makeListing('poshmark', 'p-42-ship649', {
                  title: 'Poshmark Base 42 Ship 6.49',
                  price: 42,
                  shippingPrice: 6.49,
                  shippingType: 'known',
                  adapterRank: 1,
                }),
              ],
              hasMore: false,
            },
          },
          {
            event: 'run_complete',
            data: {
              searchRunId: 'run-controls-1',
              statuses: makeStatuses(['ebay', 'poshmark'], {
                ebay: { loadedCount: 2 },
                poshmark: { loadedCount: 1 },
              }),
            },
          },
        ]);
      }

      if (url === '/api/searches/run-controls-1/retry/mercari') {
        return createSseResponse([
          {
            event: 'marketplace_status',
            data: {
              searchRunId: 'run-controls-1',
              status: makeStatuses(['mercari'], {
                mercari: { runStatus: 'running', loadedCount: 0 },
              }).mercari,
            },
          },
          {
            event: 'listings_batch',
            data: {
              searchRunId: 'run-controls-1',
              marketplace: 'mercari',
              listings: [
                makeListing('mercari', 'm-38-unknown', {
                  title: 'Mercari Base 38 Unknown Ship',
                  price: 38,
                  shippingPrice: null,
                  shippingType: 'unknown',
                  adapterRank: 1,
                }),
              ],
              hasMore: false,
            },
          },
          {
            event: 'run_complete',
            data: {
              searchRunId: 'run-controls-1',
              statuses: makeStatuses(['ebay', 'poshmark', 'mercari'], {
                ebay: { loadedCount: 2 },
                poshmark: { loadedCount: 1 },
                mercari: { loadedCount: 1 },
              }),
            },
          },
        ]);
      }

      throw new Error(`Unexpected call: ${method} ${url}`);
    });

    render(<App fetchImpl={fetchMock} />);
    const main = screen.getByRole('main');

    // Uncheck Mercari US and Facebook Marketplace before running initial search
    const targetGroup = screen.getByRole('group', { name: /Target Marketplaces/i });
    await userEvent.click(within(targetGroup).getByRole('button', { name: 'Mercari US' }));
    await userEvent.click(
      within(targetGroup).getByRole('button', { name: 'Facebook Marketplace' }),
    );

    await userEvent.type(screen.getByLabelText(/Search keywords/i), 'jacket');
    await userEvent.selectOptions(screen.getByLabelText(/Sort order/i), 'price_asc');
    await userEvent.click(within(main).getByRole('button', { name: /^Search$/i }));

    await waitFor(() => {
      expect(screen.getByText('eBay Base 40 Ship 15')).toBeInTheDocument();
      expect(screen.getByText('Poshmark Base 42 Ship 6.49')).toBeInTheDocument();
      expect(screen.getByText('eBay Base 45 Free')).toBeInTheDocument();
    });

    const getRenderedTitles = () =>
      within(screen.getByTestId('listing-grid'))
        .getAllByRole('article')
        .map((card) => within(card).getAllByRole('link')[1]?.textContent ?? '');

    // Base price_asc order: 40, 42, 45
    expect(getRenderedTitles()).toEqual([
      'eBay Base 40 Ship 15',
      'Poshmark Base 42 Ship 6.49',
      'eBay Base 45 Free',
    ]);

    const callsBeforeClientToggles = calls.length;

    // Toggle "Include known shipping in price sort" -> 0 network calls, reorders by total (45, 48.49, 55)
    const shipToggle = screen.getByRole('checkbox', {
      name: /Include known shipping in price sort/i,
    });
    await userEvent.click(shipToggle);
    expect(shipToggle).toBeChecked();
    expect(getRenderedTitles()).toEqual([
      'eBay Base 45 Free',
      'Poshmark Base 42 Ship 6.49',
      'eBay Base 40 Ship 15',
    ]);
    expect(calls.length).toBe(callsBeforeClientToggles);

    // Toggle visibility of already-queried eBay off -> 0 network calls, hides eBay cards
    const filterGroup = screen.getByRole('group', { name: /Filter visible Marketplaces/i });
    const ebayVisBtn = within(filterGroup).getByRole('button', { name: /^eBay/i });
    expect(ebayVisBtn).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(ebayVisBtn);
    expect(ebayVisBtn).toHaveAttribute('aria-pressed', 'false');
    expect(getRenderedTitles()).toEqual(['Poshmark Base 42 Ship 6.49']);
    expect(screen.getByText(/Showing 1 Listing/i)).toBeInTheDocument();
    expect(calls.length).toBe(callsBeforeClientToggles);

    // Toggle eBay back on -> 0 network calls, restores eBay cards
    await userEvent.click(ebayVisBtn);
    expect(ebayVisBtn).toHaveAttribute('aria-pressed', 'true');
    expect(getRenderedTitles()).toHaveLength(3);
    expect(calls.length).toBe(callsBeforeClientToggles);

    // Click unqueried Mercari US in post-run strip -> triggers targeted POST /api/searches/run-controls-1/retry/mercari
    const mercariPostBtn = within(filterGroup).getByRole('button', { name: /^Mercari US/i });
    expect(mercariPostBtn).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(mercariPostBtn);

    await waitFor(() => {
      expect(screen.getByText('Mercari Base 38 Unknown Ship')).toBeInTheDocument();
    });
    expect(calls.slice(callsBeforeClientToggles)).toEqual([
      { url: '/api/searches/run-controls-1/retry/mercari', method: 'POST', body: undefined },
    ]);
    expect(mercariPostBtn).toHaveAttribute('aria-pressed', 'true');
    expect(getRenderedTitles()).toEqual([
      'Mercari Base 38 Unknown Ship',
      'eBay Base 45 Free',
      'Poshmark Base 42 Ship 6.49',
      'eBay Base 40 Ship 15',
    ]);
  });

  it('initiates a new search run when primary SortOrder changes after an active run, without running before the first search', async () => {
    const streamBodies: Array<Record<string, unknown>> = [];
    let runSeq = 0;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/settings') {
        return new Response(JSON.stringify(createMockSettingsResponse()), { status: 200 });
      }
      if (url === '/api/saved-searches') {
        return new Response(JSON.stringify({ savedSearches: [] }), { status: 200 });
      }
      if (url === '/api/searches/stream') {
        runSeq += 1;
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        streamBodies.push(body);
        const runId = `run-sort-${runSeq}`;
        return createSseResponse([
          {
            event: 'run_started',
            data: {
              searchRunId: runId,
              diagnostics: makeDiagnostics(['ebay']),
              statuses: makeStatuses(['ebay']),
            },
          },
          {
            event: 'listings_batch',
            data: {
              searchRunId: runId,
              marketplace: 'ebay',
              listings: [
                makeListing('ebay', `e-${runSeq}`, {
                  title: `Sorted Listing ${String(body.sortOrder)}`,
                }),
              ],
              hasMore: false,
            },
          },
          {
            event: 'run_complete',
            data: {
              searchRunId: runId,
              statuses: makeStatuses(['ebay']),
            },
          },
        ]);
      }
      throw new Error(`Unexpected call: ${url}`);
    });

    render(<App fetchImpl={fetchMock} />);
    const main = screen.getByRole('main');

    await userEvent.type(screen.getByLabelText(/Search keywords/i), 'jacket');
    // Changing SortOrder before any search run updates draft only (no stream call)
    await userEvent.selectOptions(screen.getByLabelText(/Sort order/i), 'newest');
    expect(streamBodies).toHaveLength(0);

    // Run initial search
    await userEvent.click(within(main).getByRole('button', { name: /^Search$/i }));
    await waitFor(() => {
      expect(screen.getByText('Sorted Listing newest')).toBeInTheDocument();
    });
    expect(streamBodies).toHaveLength(1);
    expect(streamBodies[0]?.sortOrder).toBe('newest');

    // Changing SortOrder after a run is active initiates a fresh search run with updated sortOrder
    await userEvent.selectOptions(screen.getByLabelText(/Sort order/i), 'price_desc');
    await waitFor(() => {
      expect(screen.getByText('Sorted Listing price_desc')).toBeInTheDocument();
    });
    expect(streamBodies).toHaveLength(2);
    expect(streamBodies[1]?.sortOrder).toBe('price_desc');
    expect(streamBodies[1]?.keywords).toBe('jacket');
    expect(streamBodies[1]?.refresh).toBe(false);
  });

  it('allows toggling visibility of an already-queried Marketplace while another Marketplace is still streaming', async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const calls: string[] = [];

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push(url);
      if (url === '/api/settings') {
        return new Response(JSON.stringify(createMockSettingsResponse()), { status: 200 });
      }
      if (url === '/api/saved-searches') {
        return new Response(JSON.stringify({ savedSearches: [] }), { status: 200 });
      }
      if (url === '/api/searches/stream') {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            controller.enqueue(
              encodeSseEvent('run_started', {
                searchRunId: 'run-mid-stream',
                diagnostics: makeDiagnostics(['ebay', 'facebook']),
                statuses: makeStatuses(['ebay', 'facebook'], {
                  ebay: { runStatus: 'running', loadedCount: 0 },
                  facebook: {
                    runStatus: 'running',
                    loadedCount: 0,
                    completedCities: 1,
                    totalCities: 4,
                    currentCityLabel: 'Seattle, WA',
                  },
                }),
              }),
            );
            controller.enqueue(
              encodeSseEvent('listings_batch', {
                searchRunId: 'run-mid-stream',
                marketplace: 'ebay',
                listings: [makeListing('ebay', 'e-live', { title: 'Live eBay Jacket' })],
                hasMore: false,
              }),
            );
            controller.enqueue(
              encodeSseEvent('marketplace_status', {
                searchRunId: 'run-mid-stream',
                status: makeStatuses(['ebay'], {
                  ebay: { runStatus: 'success', loadedCount: 1 },
                }).ebay,
              }),
            );
            // Leave stream open so Facebook is still sweeping (isStreaming === true)
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }
      throw new Error(`Unexpected call: ${url}`);
    });

    render(<App fetchImpl={fetchMock} />);
    const main = screen.getByRole('main');
    await userEvent.type(screen.getByLabelText(/Search keywords/i), 'jacket');
    await userEvent.click(within(main).getByRole('button', { name: /^Search$/i }));

    await waitFor(() => {
      expect(screen.getByText('Live eBay Jacket')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Searching\.\.\./i })).toBeDisabled();
    });

    const callsBeforeToggle = calls.length;
    const filterGroup = screen.getByRole('group', { name: /Filter visible Marketplaces/i });
    const ebayVisBtn = within(filterGroup).getByRole('button', { name: /^eBay/i });
    expect(ebayVisBtn).toBeEnabled();
    expect(ebayVisBtn).toHaveAttribute('aria-pressed', 'true');

    // Toggle eBay off mid-stream -> hides eBay Listing immediately with 0 network calls
    await userEvent.click(ebayVisBtn);
    expect(ebayVisBtn).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByText('Live eBay Jacket')).not.toBeInTheDocument();
    expect(calls.length).toBe(callsBeforeToggle);

    // Toggle eBay back on mid-stream -> restores eBay Listing immediately
    await userEvent.click(ebayVisBtn);
    expect(ebayVisBtn).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Live eBay Jacket')).toBeInTheDocument();
    expect(calls.length).toBe(callsBeforeToggle);

    // Cleanly close stream
    await act(async () => {
      streamController?.enqueue(
        encodeSseEvent('run_complete', {
          searchRunId: 'run-mid-stream',
          statuses: makeStatuses(['ebay', 'facebook']),
        }),
      );
      streamController?.close();
    });
  });

  it('renders a per-Marketplace Load more button on status cards with hasMore and sends { marketplace } to load-more', async () => {
    const loadMoreBodies: Array<Record<string, unknown>> = [];

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/settings') {
        return new Response(JSON.stringify(createMockSettingsResponse()), { status: 200 });
      }
      if (url === '/api/saved-searches') {
        return new Response(JSON.stringify({ savedSearches: [] }), { status: 200 });
      }
      if (url === '/api/searches/stream') {
        return createSseResponse([
          {
            event: 'run_started',
            data: {
              searchRunId: 'run-per-mp-1',
              diagnostics: makeDiagnostics(['ebay', 'poshmark']),
              statuses: makeStatuses(['ebay', 'poshmark'], {
                ebay: { runStatus: 'running', loadedCount: 0 },
                poshmark: { runStatus: 'running', loadedCount: 0 },
              }),
            },
          },
          {
            event: 'listings_batch',
            data: {
              searchRunId: 'run-per-mp-1',
              marketplace: 'ebay',
              listings: [makeListing('ebay', 'e-p1', { title: 'eBay Page 1 Coat' })],
              hasMore: true,
            },
          },
          {
            event: 'listings_batch',
            data: {
              searchRunId: 'run-per-mp-1',
              marketplace: 'poshmark',
              listings: [makeListing('poshmark', 'p-p1', { title: 'Poshmark Page 1 Vest' })],
              hasMore: false,
            },
          },
          {
            event: 'run_complete',
            data: {
              searchRunId: 'run-per-mp-1',
              statuses: makeStatuses(['ebay', 'poshmark']),
            },
          },
        ]);
      }
      if (url === '/api/searches/run-per-mp-1/load-more') {
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        loadMoreBodies.push(body);
        return createSseResponse([
          {
            event: 'listings_batch',
            data: {
              searchRunId: 'run-per-mp-1',
              marketplace: 'ebay',
              listings: [makeListing('ebay', 'e-p2', { title: 'eBay Page 2 Parka', adapterRank: 2 })],
              hasMore: false,
            },
          },
          {
            event: 'run_complete',
            data: {
              searchRunId: 'run-per-mp-1',
              statuses: makeStatuses(['ebay', 'poshmark'], {
                ebay: { loadedCount: 2 },
                poshmark: { loadedCount: 1 },
              }),
            },
          },
        ]);
      }
      throw new Error(`Unexpected call: ${url}`);
    });

    render(<App fetchImpl={fetchMock} />);
    const main = screen.getByRole('main');
    await userEvent.type(screen.getByLabelText(/Search keywords/i), 'patagonia');
    await userEvent.click(within(main).getByRole('button', { name: /^Search$/i }));

    await waitFor(() => {
      expect(screen.getByText('eBay Page 1 Coat')).toBeInTheDocument();
      expect(screen.getByText('Poshmark Page 1 Vest')).toBeInTheDocument();
    });

    const ebayCard = screen.getByTestId('status-card-ebay');
    const poshCard = screen.getByTestId('status-card-poshmark');

    // eBay hasMore === true -> shows per-Marketplace Load more button; Poshmark hasMore === false -> does not
    const ebayLoadMoreBtn = within(ebayCard).getByRole('button', { name: /Load more/i });
    expect(ebayLoadMoreBtn).toBeEnabled();
    expect(within(poshCard).queryByRole('button', { name: /Load more/i })).not.toBeInTheDocument();

    await userEvent.click(ebayLoadMoreBtn);

    await waitFor(() => {
      expect(screen.getByText('eBay Page 2 Parka')).toBeInTheDocument();
    });
    expect(loadMoreBodies).toEqual([{ marketplace: 'ebay' }]);
    const page2Card = screen.getByText('eBay Page 2 Parka').closest('article')!;
    expect(within(page2Card).getByText('New')).toHaveClass('new-badge');
    expect(within(ebayCard).queryByRole('button', { name: /Load more/i })).not.toBeInTheDocument();
  });
});
