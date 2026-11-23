import { useEffect, useRef, useState } from 'react';
import {
  MARKETPLACE_IDS,
  MARKETPLACE_LABELS,
  sortListings,
  validateSearchDraft,
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

const FORGIVING_SCROLL_ZONE_PX = 450;

function listingKey(listing: Listing): string {
  return `${listing.marketplace}:${listing.marketplaceListingId}`;
}

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
  const [loadingMoreTarget, setLoadingMoreTarget] = useState<MarketplaceId | 'all' | null>(null);
  const [isStoppingFacebook, setIsStoppingFacebook] = useState(false);
  const [retryingMarketplace, setRetryingMarketplace] = useState<MarketplaceId | null>(null);
  const [statuses, setStatuses] = useState<Partial<Record<MarketplaceId, MarketplaceStatus>>>({});
  const [listingPages, setListingPages] = useState<Listing[][]>(() => [[]]);
  const [pendingBuffer, setPendingBuffer] = useState<Listing[]>([]);
  const [newListingKeys, setNewListingKeys] = useState<Set<string>>(() => new Set());
  const [hasMoreByMp, setHasMoreByMp] = useState<Partial<Record<MarketplaceId, boolean>>>({});
  const [includeKnownShippingInPriceSort, setIncludeKnownShippingInPriceSort] = useState(false);
  const [visibleMarketplaces, setVisibleMarketplaces] = useState<Record<MarketplaceId, boolean>>({
    ebay: true,
    poshmark: true,
    mercari: true,
    facebook: true,
  });

  const activeAbortRef = useRef<AbortController | null>(null);
  const bufferLatchedRef = useRef(false);
  const listingPagesRef = useRef<Listing[][]>([[]]);
  const pendingBufferRef = useRef<Listing[]>([]);
  const lastTriggeredSeqRef = useRef<number>(0);

  listingPagesRef.current = listingPages;
  pendingBufferRef.current = pendingBuffer;

  useEffect(() => {
    const onScroll = () => {
      if (window.scrollY > FORGIVING_SCROLL_ZONE_PX) {
        bufferLatchedRef.current = true;
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const toggleMarketplace = (mp: MarketplaceId) => {
    const next = enabledMarketplaces.includes(mp)
      ? enabledMarketplaces.filter((item) => item !== mp)
      : [...enabledMarketplaces, mp];
    onEnabledMarketplacesChange(next);
  };

  const mergeIntoGrid = (
    incoming: readonly Listing[],
    options: {
      markAsNew?: boolean;
      replaceMarketplace?: MarketplaceId;
      targetPageIndex?: number;
    } = {},
  ) => {
    const basePages = options.replaceMarketplace
      ? listingPagesRef.current.map((page) =>
          page.filter((item) => item.marketplace !== options.replaceMarketplace),
        )
      : listingPagesRef.current.map((page) => [...page]);
    if (basePages.length === 0) {
      basePages.push([]);
    }

    const existingKeys = new Set(basePages.flat().map(listingKey));
    const pageIndex = options.targetPageIndex ?? 0;
    while (basePages.length <= pageIndex) {
      basePages.push([]);
    }
    const targetPage = basePages[pageIndex]!;
    const addedKeys: string[] = [];
    for (const item of incoming) {
      const key = listingKey(item);
      if (!existingKeys.has(key)) {
        existingKeys.add(key);
        targetPage.push(item);
        addedKeys.push(key);
      }
    }
    listingPagesRef.current = basePages;
    setListingPages(basePages);

    if (options.markAsNew && addedKeys.length > 0) {
      setNewListingKeys((prev) => {
        const next = new Set(prev);
        for (const key of addedKeys) {
          next.add(key);
        }
        return next;
      });
    }
  };

  const handleSseEvent = (
    event: string,
    data: unknown,
    options: {
      replaceMarketplace?: MarketplaceId;
      bypassBuffer?: boolean;
      markAsNew?: boolean;
      targetPageIndex?: number;
    } = {},
  ) => {
    if (event === 'run_started') {
      const payload = data as SearchRunStartedEvent;
      setSearchRunId(payload.searchRunId);
      setStatuses(payload.statuses);
      listingPagesRef.current = [[]];
      pendingBufferRef.current = [];
      bufferLatchedRef.current = false;
      setListingPages([[]]);
      setPendingBuffer([]);
      setNewListingKeys(new Set());
      setHasMoreByMp({});
      setIsStoppingFacebook(false);
      setVisibleMarketplaces({
        ebay: true,
        poshmark: true,
        mercari: true,
        facebook: true,
      });
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

      if (!options.bypassBuffer) {
        if (window.scrollY > FORGIVING_SCROLL_ZONE_PX) {
          bufferLatchedRef.current = true;
        }
        const shouldBuffer =
          bufferLatchedRef.current || pendingBufferRef.current.length > 0;
        if (shouldBuffer) {
          const knownKeys = new Set([
            ...listingPagesRef.current.flat().map(listingKey),
            ...pendingBufferRef.current.map(listingKey),
          ]);
          const appended = [...pendingBufferRef.current];
          for (const item of payload.listings) {
            const key = listingKey(item);
            if (!knownKeys.has(key)) {
              knownKeys.add(key);
              appended.push(item);
            }
          }
          pendingBufferRef.current = appended;
          setPendingBuffer(appended);
          return;
        }
      }

      mergeIntoGrid(payload.listings, {
        markAsNew: options.markAsNew,
        replaceMarketplace: options.replaceMarketplace,
        targetPageIndex: options.targetPageIndex,
      });
      return;
    }

    if (event === 'run_complete') {
      const payload = data as RunCompleteEvent;
      setStatuses((prev) => ({ ...prev, ...payload.statuses }));
    }
  };

  const handleFlushPendingBuffer = () => {
    const buffered = pendingBufferRef.current;
    if (buffered.length === 0) {
      return;
    }
    mergeIntoGrid(buffered, { markAsNew: true });
    pendingBufferRef.current = [];
    setPendingBuffer([]);
    bufferLatchedRef.current = window.scrollY > FORGIVING_SCROLL_ZONE_PX;
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

    const err = validateSearchDraft(params);
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

  const isLoadingMore = loadingMoreTarget !== null;

  const handleLoadMore = async (marketplace?: MarketplaceId) => {
    if (!searchRunId || loadingMoreTarget !== null) {
      return;
    }
    if (marketplace) {
      if (statuses[marketplace]?.runStatus === 'running') {
        return;
      }
    } else if (isStreaming) {
      return;
    }
    setLoadingMoreTarget(marketplace ?? 'all');
    let receivedBatchForTarget = false;
    let loadMorePageIndex: number | null = null;
    try {
      const response = await fetchImpl(`/api/searches/${searchRunId}/load-more`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(marketplace ? { marketplace } : {}),
      });
      if (!response.ok) {
        const errJson = (await response.json().catch(() => ({}))) as { error?: string };
        setValidationError(errJson.error ?? `Load more failed (${response.status}).`);
        return;
      }
      await readSseStream(response, ({ event, data }) => {
        if (event === 'listings_batch') {
          if (loadMorePageIndex === null) {
            loadMorePageIndex = listingPagesRef.current.length;
          }
          if (
            marketplace &&
            (data as ListingsBatchEvent).marketplace === marketplace
          ) {
            receivedBatchForTarget = true;
          }
        }
        handleSseEvent(event, data, {
          bypassBuffer: true,
          markAsNew: true,
          targetPageIndex: loadMorePageIndex ?? undefined,
        });
      });
      if (marketplace && !receivedBatchForTarget) {
        setHasMoreByMp((prev) => ({ ...prev, [marketplace]: false }));
      }
    } finally {
      setLoadingMoreTarget(null);
    }
  };

  const handleRetryMarketplace = async (mp: MarketplaceId) => {
    if (!searchRunId) {
      return;
    }
    setRetryingMarketplace(mp);
    setHasMoreByMp((prev) => ({ ...prev, [mp]: false }));
    setVisibleMarketplaces((prev) => ({ ...prev, [mp]: true }));
    if (!enabledMarketplaces.includes(mp)) {
      onEnabledMarketplacesChange([...enabledMarketplaces, mp]);
    }
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
        handleSseEvent(event, data, { replaceMarketplace: mp, bypassBuffer: true });
      });
    } finally {
      setRetryingMarketplace(null);
    }
  };

  const handleStopFacebook = async () => {
    if (!searchRunId || isStoppingFacebook) {
      return;
    }
    setIsStoppingFacebook(true);
    try {
      const response = await fetchImpl(`/api/searches/${searchRunId}/stop-facebook`, {
        method: 'POST',
      });
      if (response.ok) {
        const json = (await response.json().catch(() => null)) as {
          status?: MarketplaceStatus | null;
        } | null;
        if (json?.status) {
          setStatuses((prev) => ({
            ...prev,
            facebook: json.status!,
          }));
        }
      }
    } finally {
      setIsStoppingFacebook(false);
    }
  };

  const handlePostRunMarketplaceToggle = (mp: MarketplaceId) => {
    if (statuses[mp]) {
      setVisibleMarketplaces((prev) => ({ ...prev, [mp]: !prev[mp] }));
      return;
    }
    void handleRetryMarketplace(mp);
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

  const allListings = listingPages.flat();
  const countsByMarketplace: Record<MarketplaceId, number> = {
    ebay: 0,
    poshmark: 0,
    mercari: 0,
    facebook: 0,
  };
  for (const item of allListings) {
    countsByMarketplace[item.marketplace] += 1;
  }

  const sortedListings =
    sortOrder === 'relevance' || sortOrder === 'newest'
      ? listingPages.flatMap((page) =>
          sortListings(
            page.filter((item) => visibleMarketplaces[item.marketplace]),
            sortOrder,
            { includeKnownShippingInPriceSort },
          ),
        )
      : sortListings(
          allListings.filter((item) => visibleMarketplaces[item.marketplace]),
          sortOrder,
          { includeKnownShippingInPriceSort },
        );
  const hasAnyMore = Object.values(hasMoreByMp).some(Boolean);

  const handleSortOrderChange = (nextSortOrder: SortOrder) => {
    onSortOrderChange(nextSortOrder);
    if (searchRunId !== null && keywords.trim().length > 0 && enabledMarketplaces.length > 0) {
      void runSearch(false, {
        keywords,
        unifiedFilters,
        marketplaces: enabledMarketplaces,
        sortOrder: nextSortOrder,
      });
    }
  };

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
              onChange={(e) => handleSortOrderChange(e.target.value as SortOrder)}
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
            hasMoreByMp={hasMoreByMp}
            retryingMarketplace={retryingMarketplace}
            loadingMoreTarget={loadingMoreTarget}
            isStoppingFacebook={isStoppingFacebook}
            onRetry={(mp) => void handleRetryMarketplace(mp)}
            onLoadMoreMarketplace={(mp) => void handleLoadMore(mp)}
            onStopFacebook={() => void handleStopFacebook()}
            onOpenBrowserSession={(mp, url) => void handleOpenBrowserSession(mp, url)}
          />

          <div className="toolbar-bar">
            <div
              className="flex flex-wrap items-center gap-1.5"
              role="group"
              aria-label="Filter visible Marketplaces"
            >
              <span className="text-xs font-semibold text-slate-600">Show Marketplaces:</span>
              {MARKETPLACE_IDS.map((mp) => {
                const queried = Boolean(statuses[mp]);
                const pressed = queried && visibleMarketplaces[mp];
                return (
                  <button
                    key={mp}
                    type="button"
                    data-vis-mp={mp}
                    aria-pressed={pressed}
                    disabled={retryingMarketplace === mp || (!queried && !searchRunId)}
                    title={
                      queried
                        ? `Toggle ${MARKETPLACE_LABELS[mp]} visibility`
                        : `Query ${MARKETPLACE_LABELS[mp]} now`
                    }
                    onClick={() => handlePostRunMarketplaceToggle(mp)}
                    className="toggle-pill"
                  >
                    {MARKETPLACE_LABELS[mp]}{' '}
                    <span className="tabular">
                      ({queried ? countsByMarketplace[mp] : 'Not queried'})
                    </span>
                  </button>
                );
              })}
            </div>

            <label className="flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={includeKnownShippingInPriceSort}
                onChange={(e) => setIncludeKnownShippingInPriceSort(e.target.checked)}
              />
              <span>Include known shipping in price sort</span>
            </label>
          </div>

          <ListingGrid
            listings={sortedListings}
            watchlistedKeys={watchlistedKeys}
            onToggleWatchlist={onToggleWatchlist}
            newListingKeys={newListingKeys}
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

      {pendingBuffer.length > 0 && (
        <button
          id="scroll-merge-pill"
          type="button"
          className="merge-pill"
          onClick={handleFlushPendingBuffer}
        >
          +{pendingBuffer.length} new {pendingBuffer.length === 1 ? 'Listing' : 'Listings'} — Click
          to merge
        </button>
      )}
    </div>
  );
}
