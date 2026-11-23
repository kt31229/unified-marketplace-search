import type { MarketplaceId, UnifiedFilter } from './schemas.ts';

export interface SearchDraftInput {
  keywords: string;
  marketplaces: readonly MarketplaceId[];
  unifiedFilters: UnifiedFilter;
}

/**
 * Validates search keywords, target Marketplaces, and USD base price bounds
 * for both Search runs and Saved Search persistence.
 */
export function validateSearchDraft(draft: SearchDraftInput): string | null {
  if (!draft.keywords.trim()) {
    return 'Enter search keywords.';
  }
  if (draft.marketplaces.length === 0) {
    return 'Select at least one Marketplace.';
  }
  if (
    (draft.unifiedFilters.priceMin != null && draft.unifiedFilters.priceMin < 0) ||
    (draft.unifiedFilters.priceMax != null && draft.unifiedFilters.priceMax < 0)
  ) {
    return 'Prices must be non-negative.';
  }
  if (
    draft.unifiedFilters.priceMin != null &&
    draft.unifiedFilters.priceMax != null &&
    draft.unifiedFilters.priceMin > draft.unifiedFilters.priceMax
  ) {
    return 'Minimum price must be less than or equal to maximum price.';
  }
  return null;
}
