import { useEffect, useRef, useState } from 'react';
import {
  MARKETPLACE_IDS,
  MARKETPLACE_LABELS,
  sortListings,
  type BrowserMarketplaceId,
  type Listing,
  type ListingsBatchEvent,
  type MarketplaceId,
  type MarketplaceStatus,
  type MarketplaceStatusEvent,
  type RunCompleteEvent,
  type SearchRunStartedEvent,
  type SortOrder,
  type UnifiedFilter,
} from '../../shared/index.ts';
import { readSseStream } from '../lib/sse.ts';
import { ListingGrid } from './ListingGrid.tsx';
import type { FetchLike } from './SettingsView.tsx';
import { StatusStrip } from './StatusStrip.tsx';

export interface TriggeredSearchRequest {
  seq: number;
  keywords: string;
  unifiedFilters: UnifiedFilter;
  marketplaces: MarketplaceId[];
  sortOrder: SortOrder;
}

export interface SearchViewProps {
  fetchImpl: FetchLike;
  unifiedFilters: UnifiedFilter;
  keywords: string;
  onKeywordsChange: (keywords: string) => void;
  enabledMarketplaces: MarketplaceId[];
  onEnabledMarketplacesChange: (marketplaces: MarketplaceId[]) => void;
  sortOrder: SortOrder;
  onSortOrderChange: (sortOrder: SortOrder) => void;
  pendingRunRequest: TriggeredSearchRequest | null;
  watchlistedKeys?: ReadonlySet<string>;
  onToggleWatchlist?: (listing: Listing) => void;
}

export function SearchView({
  fetchImpl,
  unifiedFilters,
  keywords,
  onKeywordsChange,
  enabledMarketplaces,
  onEnabledMarketplacesChange,
  sortOrder,
  onSortOrderChange,
  pendingRunRequest,
  watchlistedKeys,
  onToggleWatchlist,
}: SearchViewProps) {
  const [validationError, setValidationError] = useState<string | null>(null);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);

  const [searchRunId, setSearchRunId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [retryingMarketplace, setRetryingMarketplace] = useState<MarketplaceId | null>(null);
  const [statuses, setStatuses] = useState<Partial<Record<MarketplaceId, MarketplaceStatus>>>({});
  const [listings, setListings] = useState<Listing[]>([]);
  const [hasMoreByMp, setHasMoreByMp] = useState<Partial<Record<MarketplaceId, boolean>>>({});

  const activeAbortRef = useRef<AbortController | null>(null);
  const lastTriggeredSeqRef = useRef<number>(0);

  const toggleMarketplace = (mp: MarketplaceId) => {
    const next = enabledMarketplaces.includes(mp)
      ? enabledMarketplaces.filter((item) => item !== mp)
      : [...enabledMarketplaces, mp];
    onEnabledMarketplacesChange(next);
  };

  const validateSearch = (params: {
    keywords: string;
    unifiedFilters: UnifiedFilter;
    marketplaces: MarketplaceId[];
  }): string | null => {
    if (!params.keywords.trim()) {
      return 'Enter search keywords.';
    }
    if (params.marketplaces.length === 0) {
      return 'Select at least one Marketplace.';
    }
    if (
      (params.unifiedFilters.priceMin != null && params.unifiedFilters.priceMin < 0) ||
      (params.unifiedFilters.priceMax != null && params.unifiedFilters.priceMax < 0)
    ) {
      return 'Prices must be non-negative.';
    }
    if (
      params.unifiedFilters.priceMin != null &&
      params.unifiedFilters.priceMax != null &&
      params.unifiedFilters.priceMin > params.unifiedFilters.priceMax
    ) {
      return 'Minimum price must be less than or equal to maximum price.';
    }
    return null;
  };

  const handleSseEvent = (
    event: string,
    data: unknown,
    replaceMarketplace?: MarketplaceId,
  ) => {
    if (event === 'run_started') {
      const payload = data as SearchRunStartedEvent;
      setSearchRunId(payload.searchRunId);
      setStatuses(payload.statuses);
      setListings([]);
      setHasMoreByMp({});
      return;
    }

    if (event === 'marketplace_status') {
      const payload = data as MarketplaceStatusEvent;
      setStatuses((prev) => ({
        ...prev,
        [payload.status.marketplace]: payload.status,
      }));
      return;
    }

    if (event === 'listings_batch') {
      const payload = data as ListingsBatchEvent;
      setHasMoreByMp((prev) => ({
        ...prev,
        [payload.marketplace]: payload.hasMore,
      }));
      setListings((prev) => {
        const base = replaceMarketplace
          ? prev.filter((item) => item.marketplace !== replaceMarketplace)
          : prev;
        const existingKeys = new Set(
          base.map((item) => `${item.marketplace}:${item.marketplaceListingId}`),
        );
        const merged = [...base];
        for (const incoming of payload.listings) {
          const key = `${incoming.marketplace}:${incoming.marketplaceListingId}`;
          if (!existingKeys.has(key)) {
            existingKeys.add(key);
            merged.push(incoming);
          }
        }
        return merged;
      });
      return;
    }

    if (event === 'run_complete') {
      const payload = data as RunCompleteEvent;
      setStatuses((prev) => ({ ...prev, ...payload.statuses }));
    }
  };

  const runSearch = async (
    refresh: boolean,
    override?: Omit<TriggeredSearchRequest, 'seq'>,
  ) => {
    const params = override ?? {
      keywords,
      unifiedFilters,
      marketplaces: enabledMarketplaces,
      sortOrder,
    };

    const err = validateSearch(params);
    if (err) {
      setValidationError(err);
      return;
    }

    setValidationError(null);
    setSessionNotice(null);
    activeAbortRef.current?.abort();
    const controller = new AbortController();
    activeAbortRef.current = controller;

    setIsStreaming(true);
    try {
      const response = await fetchImpl('/api/searches/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          keywords: params.keywords.trim(),
          unifiedFilters: params.unifiedFilters,
          marketplaces: params.marketplaces,
          sortOrder: params.sortOrder,
          refresh,
        }),
      });

      if (!response.ok) {
        const errJson = (await response.json().catch(() => ({}))) as { error?: string };
        setValidationError(errJson.error ?? `Search failed (${response.status}).`);
        return;
      }

      await readSseStream(response, ({ event, data }) => {
        handleSseEvent(event, data);
      });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setValidationError(error instanceof Error ? error.message : 'Search failed.');
      }
    } finally {
      if (activeAbortRef.current === controller) {
        setIsStreaming(false);
      }
    }
  };

  useEffect(() => {
    if (!pendingRunRequest || pendingRunRequest.seq === lastTriggeredSeqRef.current) {
      return;
    }
    lastTriggeredSeqRef.current = pendingRunRequest.seq;
    void runSearch(false, pendingRunRequest);
  });

  const handleLoadMore = async () => {
    if (!searchRunId || isLoadingMore || isStreaming) {
      return;
    }
    setIsLoadingMore(true);
    try {
      const response = await fetchImpl(`/api/searches/${searchRunId}/load-more`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!response.ok) {
        const errJson = (await response.json().catch(() => ({}))) as { error?: string };
        setValidationError(errJson.error ?? `Load more failed (${response.status}).`);
        return;
      }
      await readSseStream(response, ({ event, data }) => {
        handleSseEvent(event, data);
      });
    } finally {
      setIsLoadingMore(false);
    }
  };

  const handleRetryMarketplace = async (mp: MarketplaceId) => {
    if (!searchRunId) {
      return;
    }
    setRetryingMarketplace(mp);
    setHasMoreByMp((prev) => ({ ...prev, [mp]: false }));
    try {
      const response = await fetchImpl(`/api/searches/${searchRunId}/retry/${mp}`, {
        method: 'POST',
      });
      if (!response.ok) {
        const errJson = (await response.json().catch(() => ({}))) as { error?: string };
        setValidationError(errJson.error ?? `Retry failed (${response.status}).`);
        return;
      }
      await readSseStream(response, ({ event, data }) => {
        handleSseEvent(event, data, mp);
      });
    } finally {
      setRetryingMarketplace(null);
    }
  };

  const handleOpenBrowserSession = async (mp: BrowserMarketplaceId, url?: string) => {
    setSessionNotice(null);
    const response = await fetchImpl(`/api/browser/${mp}/open-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(url ? { url } : {}),
    });
    if (!response.ok) {
      const errJson = (await response.json().catch(() => ({}))) as { error?: string };
      setSessionNotice(
        errJson.error ?? `Could not open ${MARKETPLACE_LABELS[mp]} browser session.`,
      );
      return;
    }
    setSessionNotice(`Opened ${MARKETPLACE_LABELS[mp]} browser session.`);
  };

  const sortedListings = sortListings(listings, sortOrder);
  const hasAnyMore = Object.values(hasMoreByMp).some(Boolean);

  return (
    <div className="flex flex-col gap-3.5">
      <section className="panel-box flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="m-0 text-lg font-semibold text-slate-900">Search Workbench</h1>
          <label className="flex items-center gap-2 text-xs font-medium text-slate-700">
            <span>Sort order</span>
            <select
              aria-label="Sort order"
              value={sortOrder}
              onChange={(e) => onSortOrderChange(e.target.value as SortOrder)}
              className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-800"
            >
              <option value="relevance">Relevance</option>
              <option value="newest">Newest</option>
              <option value="price_asc">Price: Low to High</option>
              <option value="price_desc">Price: High to Low</option>
            </select>
          </label>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void runSearch(false);
          }}
          className="flex flex-wrap items-center gap-2"
        >
          <input
            type="text"
            aria-label="Search keywords"
            placeholder="Search secondhand Listings (e.g. patagonia nano puff)..."
            value={keywords}
            onChange={(e) => onKeywordsChange(e.target.value)}
            className="min-w-[220px] flex-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900"
          />
          <button
            type="submit"
            disabled={isStreaming}
            className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 cursor-pointer"
          >
            {isStreaming ? 'Searching...' : 'Search'}
          </button>
          <button
            type="button"
            disabled={isStreaming}
            onClick={() => void runSearch(true)}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 cursor-pointer"
          >
            Refresh
          </button>
        </form>

        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Target Marketplaces">
          <span className="text-xs font-semibold text-slate-600">Marketplaces:</span>
          {MARKETPLACE_IDS.map((mp) => {
            const active = enabledMarketplaces.includes(mp);
            return (
              <button
                key={mp}
                type="button"
                aria-pressed={active}
                onClick={() => toggleMarketplace(mp)}
                className="mp-arm-btn"
              >
                {MARKETPLACE_LABELS[mp]}
              </button>
            );
          })}
        </div>

        {validationError && (
          <div role="alert" className="validation-msg">
            {validationError}
          </div>
        )}

        {sessionNotice && (
          <div role="status" className="text-xs text-slate-700">
            {sessionNotice}
          </div>
        )}
      </section>

      {searchRunId && (
        <>
          <StatusStrip
            statuses={statuses}
            retryingMarketplace={retryingMarketplace}
            onRetry={(mp) => void handleRetryMarketplace(mp)}
            onOpenBrowserSession={(mp, url) => void handleOpenBrowserSession(mp, url)}
          />

          <ListingGrid
            listings={sortedListings}
            watchlistedKeys={watchlistedKeys}
            onToggleWatchlist={onToggleWatchlist}
          />

          <footer className="panel-box flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs text-slate-600 tabular">
              Showing {sortedListings.length}{' '}
              {sortedListings.length === 1 ? 'Listing' : 'Listings'}
            </span>
            <button
              type="button"
              disabled={!hasAnyMore || isLoadingMore || isStreaming}
              onClick={() => void handleLoadMore()}
              className="rounded-md border border-slate-300 bg-white px-4 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50 cursor-pointer"
            >
              {isLoadingMore
                ? 'Loading more...'
                : hasAnyMore
                  ? 'Load more Listings'
                  : 'No more Listings'}
            </button>
          </footer>
        </>
      )}
    </div>
  );
}
