import { useMemo, useState } from 'react';
import {
  MARKETPLACE_IDS,
  MARKETPLACE_LABELS,
  sortWatchlistEntries,
  type MarketplaceId,
  type WatchlistEntry,
  type WatchlistSortOrder,
} from '../../shared/index.ts';

function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function formatSavedDate(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    return iso;
  }
  return new Date(parsed).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

interface WatchlistThumbnailProps {
  entry: WatchlistEntry;
}

function WatchlistThumbnail({ entry }: WatchlistThumbnailProps) {
  const cachedSrc = entry.cachedThumbnailPath
    ? `/api/thumbnails/${encodeURIComponent(entry.cachedThumbnailPath)}`
    : null;
  const remoteSrc = entry.thumbnailUrl;

  const [failedCachedSrc, setFailedCachedSrc] = useState<string | null>(null);
  const [failedRemoteSrc, setFailedRemoteSrc] = useState<string | null>(null);

  const activeSrc =
    cachedSrc && failedCachedSrc !== cachedSrc
      ? cachedSrc
      : remoteSrc && failedRemoteSrc !== remoteSrc
        ? remoteSrc
        : null;

  if (!activeSrc) {
    return (
      <div className="thumb-placeholder" aria-label="Image unavailable">
        <div className="flex flex-col items-center gap-1 text-slate-400">
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <path d="M21 15l-5-5L5 21" />
          </svg>
          <span className="text-xs text-slate-500">Image unavailable</span>
        </div>
      </div>
    );
  }

  return (
    <img
      src={activeSrc}
      alt={entry.title}
      loading="lazy"
      className="listing-thumb-img"
      onError={() => {
        if (activeSrc === cachedSrc) {
          setFailedCachedSrc(cachedSrc);
        } else if (activeSrc === remoteSrc) {
          setFailedRemoteSrc(remoteSrc);
        }
      }}
    />
  );
}

export interface WatchlistViewProps {
  entries: readonly WatchlistEntry[];
  loading: boolean;
  onRemove: (entry: WatchlistEntry) => void;
}

export function WatchlistView({ entries, loading, onRemove }: WatchlistViewProps) {
  const [marketplaceFilter, setMarketplaceFilter] = useState<'all' | MarketplaceId>('all');
  const [sortOrder, setSortOrder] = useState<WatchlistSortOrder>('saved_desc');

  const visibleEntries = useMemo(() => {
    const filtered =
      marketplaceFilter === 'all'
        ? entries
        : entries.filter((entry) => entry.marketplace === marketplaceFilter);
    return sortWatchlistEntries(filtered, sortOrder);
  }, [entries, marketplaceFilter, sortOrder]);

  return (
    <div className="flex flex-col gap-3.5">
      <section className="panel-box flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="m-0 text-lg font-semibold text-slate-900">Watchlist</h1>
          <p className="m-0 text-xs text-slate-600 tabular">
            {entries.length} saved {entries.length === 1 ? 'Watchlist Entry' : 'Watchlist Entries'}{' '}
            · PII-free snapshots
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs font-medium text-slate-700">
            <span>Marketplace</span>
            <select
              aria-label="Filter by Marketplace"
              value={marketplaceFilter}
              onChange={(e) => setMarketplaceFilter(e.target.value as 'all' | MarketplaceId)}
              className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-800"
            >
              <option value="all">All Marketplaces</option>
              {MARKETPLACE_IDS.map((mp) => (
                <option key={mp} value={mp}>
                  {MARKETPLACE_LABELS[mp]}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-2 text-xs font-medium text-slate-700">
            <span>Sort</span>
            <select
              aria-label="Sort Watchlist"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value as WatchlistSortOrder)}
              className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-800"
            >
              <option value="saved_desc">Newest saved</option>
              <option value="price_asc">Price: Low to High</option>
              <option value="price_desc">Price: High to Low</option>
            </select>
          </label>
        </div>
      </section>

      {loading && entries.length === 0 ? (
        <div className="panel-box text-sm text-slate-600">Loading Watchlist...</div>
      ) : visibleEntries.length === 0 ? (
        <div className="panel-box text-sm text-slate-600">
          {entries.length === 0
            ? 'No Watchlist Entries saved yet. Save any Listing from Search to track it here.'
            : 'No Watchlist Entries match the selected Marketplace filter.'}
        </div>
      ) : (
        <div className="watchlist-grid" data-testid="watchlist-grid">
          {visibleEntries.map((entry) => {
            const mpLabel = MARKETPLACE_LABELS[entry.marketplace];
            const cardKey = `${entry.marketplace}-${entry.marketplaceListingId}`;

            return (
              <article
                key={cardKey}
                data-testid={`watchlist-card-${cardKey}`}
                className="listing-card"
              >
                <div data-testid="watchlist-card" className="flex flex-1 flex-col">
                  <a
                    href={entry.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="listing-thumb-link"
                    tabIndex={-1}
                  >
                    <WatchlistThumbnail entry={entry} />
                  </a>

                  <div className="flex flex-1 flex-col gap-2 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className={`mp-badge mp-badge-${entry.marketplace}`}>{mpLabel}</span>
                      <span className="text-[11px] text-slate-500 tabular">
                        Saved {formatSavedDate(entry.savedAt)}
                      </span>
                    </div>

                    <h2 className="m-0 text-sm font-semibold leading-snug text-slate-900">
                      <a
                        href={entry.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="line-clamp-2 text-slate-900 no-underline hover:text-blue-700 hover:underline"
                      >
                        {entry.title}
                      </a>
                    </h2>

                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="text-base font-bold text-slate-900 tabular">
                        {entry.price != null ? formatUsd(entry.price) : 'Price unavailable'}
                      </span>
                      {entry.shippingPrice === 0 && (
                        <span className="ship-badge ship-badge-free">Free shipping</span>
                      )}
                      {entry.shippingPrice != null && entry.shippingPrice > 0 && (
                        <span className="ship-badge ship-badge-known">
                          +{formatUsd(entry.shippingPrice)} shipping
                        </span>
                      )}
                    </div>

                    <div className="mt-auto flex items-center justify-between gap-2 pt-2 border-t border-slate-100">
                      <a
                        href={entry.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 no-underline hover:bg-slate-50"
                      >
                        Open on {mpLabel} ↗
                      </a>
                      <button
                        type="button"
                        onClick={() => onRemove(entry)}
                        className="rounded border border-red-200 bg-red-50 px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-100 cursor-pointer"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
