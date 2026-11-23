import { MARKETPLACE_IDS, type Listing, type MarketplaceId, type SortOrder } from './schemas.ts';

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

function interleaveByHub(listings: Listing[]): Listing[] {
  const hubBuckets = new Map<string, Listing[]>();
  for (const listing of listings) {
    const key = listing.hubSlug ?? '__default';
    let bucket = hubBuckets.get(key);
    if (!bucket) {
      bucket = [];
      hubBuckets.set(key, bucket);
    }
    bucket.push(listing);
  }
  for (const bucket of hubBuckets.values()) {
    bucket.sort((a, b) => a.adapterRank - b.adapterRank);
  }
  if (hubBuckets.size <= 1) {
    return Array.from(hubBuckets.values())[0] ?? [];
  }

  const orderedBuckets = Array.from(hubBuckets.values());
  const interleaved: Listing[] = [];
  let index = 0;
  let added = true;
  while (added) {
    added = false;
    for (const bucket of orderedBuckets) {
      const next = bucket[index];
      if (next) {
        interleaved.push(next);
        added = true;
      }
    }
    index += 1;
  }
  return interleaved;
}

/**
 * Merges and sorts Listings across Marketplaces according to ADR-0004 invariants:
 * - relevance: deterministic round-robin interleaving by adapterRank across active Marketplaces
 *   (and across Facebook City Hubs within Facebook's bucket)
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
    for (const [mp, bucket] of buckets.entries()) {
      if (mp === 'facebook') {
        buckets.set(mp, interleaveByHub(bucket));
      } else {
        bucket.sort((a, b) => a.adapterRank - b.adapterRank);
      }
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
