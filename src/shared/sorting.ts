import { MARKETPLACE_IDS, type Listing, type MarketplaceId, type SortOrder } from './schemas.ts';

export interface SortListingsOptions {
  includeKnownShipping?: boolean;
  includeKnownShippingInPriceSort?: boolean;
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

function roundRobinInterleave(streams: readonly (readonly Listing[])[]): Listing[] {
  const result: Listing[] = [];
  let index = 0;
  let added = true;
  while (added) {
    added = false;
    for (const stream of streams) {
      const next = stream[index];
      if (next) {
        result.push(next);
        added = true;
      }
    }
    index += 1;
  }
  return result;
}

function buildMarketplaceRelevanceStream(bucket: Listing[]): Listing[] {
  const hasSubStreams = bucket.some((item) => Boolean(item.hubSlug));
  if (!hasSubStreams) {
    return [...bucket].sort((a, b) => a.adapterRank - b.adapterRank);
  }

  const hubBuckets = new Map<string, Listing[]>();
  for (const item of bucket) {
    const key = item.hubSlug ?? '';
    let list = hubBuckets.get(key);
    if (!list) {
      list = [];
      hubBuckets.set(key, list);
    }
    list.push(item);
  }

  for (const list of hubBuckets.values()) {
    list.sort((a, b) => a.adapterRank - b.adapterRank);
  }

  return roundRobinInterleave(Array.from(hubBuckets.values()));
}

/**
 * Merges and sorts Listings across Marketplaces according to ADR-0004 invariants:
 * - relevance: deterministic round-robin interleaving by adapterRank across active Marketplaces
 *   and across Facebook City Hubs (hubSlug) within Facebook's stream
 * - newest: global listedAt descending (null listedAt placed after timestamped Listings, ordered by adapterRank)
 * - price_asc / price_desc: base price (or price + known shipping when enabled), tie-broken by known total price
 */
export function sortListings(
  listings: readonly Listing[],
  sortOrder: SortOrder,
  options: SortListingsOptions = {},
): Listing[] {
  const includeKnownShipping =
    options.includeKnownShippingInPriceSort ?? options.includeKnownShipping ?? false;

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

    const streams = MARKETPLACE_IDS.map((mp) =>
      buildMarketplaceRelevanceStream(buckets.get(mp) ?? []),
    );
    return roundRobinInterleave(streams);
  }

  const copy = [...listings];

  if (sortOrder === 'newest') {
    copy.sort((a, b) => {
      const timeA = a.listedAt ? Date.parse(a.listedAt) : Number.NaN;
      const timeB = b.listedAt ? Date.parse(b.listedAt) : Number.NaN;
      const validA = Number.isFinite(timeA);
      const validB = Number.isFinite(timeB);
      if (validA && validB) {
        if (timeB !== timeA) {
          return timeB - timeA;
        }
      } else if (validA !== validB) {
        return validA ? -1 : 1;
      }
      const rankDiff = a.adapterRank - b.adapterRank;
      if (rankDiff !== 0) {
        return rankDiff;
      }
      return MARKETPLACE_IDS.indexOf(a.marketplace) - MARKETPLACE_IDS.indexOf(b.marketplace);
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

    const rankDiff = a.adapterRank - b.adapterRank;
    if (rankDiff !== 0) {
      return rankDiff;
    }
    return MARKETPLACE_IDS.indexOf(a.marketplace) - MARKETPLACE_IDS.indexOf(b.marketplace);
  });

  return copy;
}
