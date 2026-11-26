import { MARKETPLACE_LABELS, type Listing } from '../../shared/index.ts';

function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function formatShippingBadge(listing: Listing): { label: string; className: string } {
  switch (listing.shippingType) {
    case 'free':
      return { label: 'Free shipping', className: 'ship-badge ship-badge-free' };
    case 'known':
      return {
        label:
          listing.shippingPrice != null
            ? `+${formatUsd(listing.shippingPrice)} shipping`
            : 'Known shipping',
        className: 'ship-badge ship-badge-known',
      };
    case 'buyer_paid_unknown':
      return { label: 'Buyer pays shipping', className: 'ship-badge ship-badge-neutral' };
    case 'local_pickup_only':
      return { label: 'Local pickup only', className: 'ship-badge ship-badge-pickup' };
    default:
      return { label: 'Shipping unknown', className: 'ship-badge ship-badge-neutral' };
  }
}

export interface ListingGridProps {
  listings: readonly Listing[];
  watchlistedKeys?: ReadonlySet<string>;
  onToggleWatchlist?: (listing: Listing) => void;
  newListingKeys?: ReadonlySet<string>;
}

export function ListingGrid({
  listings,
  watchlistedKeys,
  onToggleWatchlist,
  newListingKeys,
}: ListingGridProps) {
  if (listings.length === 0) {
    return (
      <div className="panel-box text-sm text-slate-600">
        No matching Listings loaded yet.
      </div>
    );
  }

  return (
    <div className="grid-a" data-testid="listing-grid">
      {listings.map((listing) => {
        const shipping = formatShippingBadge(listing);
        const mpLabel = MARKETPLACE_LABELS[listing.marketplace];
        const key = `${listing.marketplace}:${listing.marketplaceListingId}`;
        const isWatchlisted = watchlistedKeys?.has(key) ?? false;
        const isNew = newListingKeys?.has(key) ?? false;

        return (
          <article
            key={key}
            className="listing-card"
          >
            <a
              href={listing.url}
              target="_blank"
              rel="noopener noreferrer"
              className="listing-thumb-link"
              tabIndex={-1}
            >
              {listing.thumbnailUrl ? (
                <img
                  src={listing.thumbnailUrl}
                  alt={listing.title}
                  loading="lazy"
                  className="listing-thumb-img"
                />
              ) : (
                <div className="thumb-placeholder" aria-label="No image available">
                  No image
                </div>
              )}
            </a>

            <div className="flex flex-1 flex-col gap-1.5 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className={`mp-badge mp-badge-${listing.marketplace}`}>{mpLabel}</span>
                  {isNew && <span className="new-badge">New</span>}
                  {listing.listingFormat === 'auction' && (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-900">
                      Auction
                    </span>
                  )}
                </div>
                {onToggleWatchlist && (
                  <button
                    type="button"
                    aria-pressed={isWatchlisted}
                    aria-label={
                      isWatchlisted ? 'Remove from Watchlist' : 'Save to Watchlist'
                    }
                    onClick={() => onToggleWatchlist(listing)}
                    className="watchlist-toggle-btn"
                  >
                    {isWatchlisted ? '★ Saved' : '☆ Save'}
                  </button>
                )}
              </div>

              <a
                href={listing.url}
                target="_blank"
                rel="noopener noreferrer"
                className="line-clamp-2 text-sm font-semibold text-slate-900 no-underline hover:text-blue-700 hover:underline"
              >
                {listing.title}
              </a>

              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-base font-bold text-slate-900 tabular">
                  {formatUsd(listing.price)}
                </span>
                {listing.listingFormat === 'auction' && (
                  <span className="text-xs text-slate-600 tabular">
                    {listing.bidCount ?? 0} {listing.bidCount === 1 ? 'bid' : 'bids'}
                  </span>
                )}
              </div>

              {listing.listingFormat === 'auction' && listing.buyNowPrice != null && (
                <div className="text-xs font-medium text-slate-700 tabular">
                  Buy Now {formatUsd(listing.buyNowPrice)}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                <span className={shipping.className}>{shipping.label}</span>
                {listing.conditionLabel && (
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-700">
                    {listing.conditionLabel}
                  </span>
                )}
                {listing.locationLabel && (
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
                    {listing.locationLabel}
                  </span>
                )}
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
