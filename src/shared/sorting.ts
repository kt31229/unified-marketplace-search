import {
  MARKETPLACE_IDS,
  type Listing,
  type MarketplaceId,
  type SortOrder,
  type WatchlistEntry,
  type WatchlistSortOrder,
} from './schemas.ts';

export interface SortListingsOptions {
  includeKnownShipping?: boolean;
}

function getEffectivePrice(listing: Listing, includeKnownShipping: boolean): number {
  if (!includeKnownShipping) {
    return listing.price;
  }
  return listing.price + (listing.shippingPrice ?? 0);
}

function getTotalPriceTieBreaker(listing: Listing): { hasKnownTotal: boolean; total: number } {
  const hasKnownTotal = listing.shippingPrice !== null;
  return {
    hasKnownTotal,
    total: listing.price + (listing.shippingPrice ?? 0),
  };
}

/**
 * Merges and sorts Listings across Marketplaces according to ADR-0004 invariants:
 * - relevance: deterministic round-robin interleaving by adapterRank across active Marketplaces
 * - newest: global listedAt descending (null listedAt placed after timestamped Listings, ordered by adapterRank)
 * - price_asc / price_desc: base price (or price + known shipping when enabled), tie-broken by known total price
 */
export function sortListings(
  listings: readonly Listing[],
  sortOrder: SortOrder,
  options: SortListingsOptions = {},
): Listing[] {
  const includeKnownShipping = options.includeKnownShipping ?? false;

  if (sortOrder === 'relevance') {
    const buckets = new Map<MarketplaceId, Listing[]>();
    for (const mp of MARKETPLACE_IDS) {
      buckets.set(mp, []);
    }
    for (const listing of listings) {
      const bucket = buckets.get(listing.marketplace);
      if (bucket) {
        bucket.push(listing);
      }
    }
    for (const bucket of buckets.values()) {
      bucket.sort((a, b) => a.adapterRank - b.adapterRank);
    }

    const result: Listing[] = [];
    let index = 0;
    let added = true;
    while (added) {
      added = false;
      for (const mp of MARKETPLACE_IDS) {
        const bucket = buckets.get(mp);
        const next = bucket?.[index];
        if (next) {
          result.push(next);
          added = true;
        }
      }
      index += 1;
    }
    return result;
  }

  const copy = [...listings];

  if (sortOrder === 'newest') {
    copy.sort((a, b) => {
      if (a.listedAt && b.listedAt) {
        const diff = Date.parse(b.listedAt) - Date.parse(a.listedAt);
        if (diff !== 0 && !Number.isNaN(diff)) {
          return diff;
        }
      } else if (a.listedAt && !b.listedAt) {
        return -1;
      } else if (!a.listedAt && b.listedAt) {
        return 1;
      }
      return a.adapterRank - b.adapterRank;
    });
    return copy;
  }

  const direction = sortOrder === 'price_asc' ? 1 : -1;
  copy.sort((a, b) => {
    const primaryDiff =
      (getEffectivePrice(a, includeKnownShipping) - getEffectivePrice(b, includeKnownShipping)) *
      direction;
    if (primaryDiff !== 0) {
      return primaryDiff;
    }

    const tieA = getTotalPriceTieBreaker(a);
    const tieB = getTotalPriceTieBreaker(b);
    if (tieA.hasKnownTotal !== tieB.hasKnownTotal) {
      return tieA.hasKnownTotal ? -1 : 1;
    }
    const tieDiff = (tieA.total - tieB.total) * direction;
    if (tieDiff !== 0) {
      return tieDiff;
    }

    return a.adapterRank - b.adapterRank;
  });

  return copy;
}

/**
 * Sorts Watchlist Entries by newest saved (default) or base price,
 * always pushing entries with null prices to the bottom.
 */
export function sortWatchlistEntries(
  entries: readonly WatchlistEntry[],
  sortOrder: WatchlistSortOrder = 'saved_desc',
): WatchlistEntry[] {
  const copy = [...entries];

  const compareSavedDesc = (a: WatchlistEntry, b: WatchlistEntry): number => {
    const diff = Date.parse(b.savedAt) - Date.parse(a.savedAt);
    if (diff !== 0 && !Number.isNaN(diff)) {
      return diff;
    }
    return b.savedAt.localeCompare(a.savedAt);
  };

  if (sortOrder === 'saved_desc') {
    copy.sort(compareSavedDesc);
    return copy;
  }

  const direction = sortOrder === 'price_asc' ? 1 : -1;
  copy.sort((a, b) => {
    if (a.price == null && b.price == null) {
      return compareSavedDesc(a, b);
    }
    if (a.price == null) {
      return 1;
    }
    if (b.price == null) {
      return -1;
    }
    const diff = (a.price - b.price) * direction;
    if (diff !== 0) {
      return diff;
    }
    return compareSavedDesc(a, b);
  });

  return copy;
}
