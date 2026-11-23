import type { Listing, UnifiedFilter } from '../../shared/index.ts';

/**
 * Enforces local Unified Filter post-conditions (USD base price bounds) after adapter normalization.
 */
export function applyPostFilters(
  listings: readonly Listing[],
  unifiedFilters: UnifiedFilter,
): Listing[] {
  return listings.filter((listing) => {
    if (!Number.isFinite(listing.price) || listing.price < 0) {
      return false;
    }
    if (unifiedFilters.priceMin != null && listing.price < unifiedFilters.priceMin) {
      return false;
    }
    if (unifiedFilters.priceMax != null && listing.price > unifiedFilters.priceMax) {
      return false;
    }
    return true;
  });
}
