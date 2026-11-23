import {
  MARKETPLACE_LABELS,
  type MarketplaceId,
  type SortOrder,
  type TranslationStatus,
  type UnifiedFilter,
} from '../../shared/index.ts';
import type {
  AdapterBatchResult,
  AdapterExecutionContext,
  AdapterLoadMoreParams,
  AdapterSearchParams,
  AdapterTranslationResult,
  MarketplaceAdapter,
} from './types.ts';

function buildPoshmarkNativeUrl(keywords: string, filters: UnifiedFilter, sortOrder: SortOrder): string {
  const url = new URL('https://poshmark.com/search');
  url.searchParams.set('query', keywords.trim());
  url.searchParams.set('availability', 'available');
  if (filters.priceMin != null || filters.priceMax != null) {
    const min = filters.priceMin != null ? Math.floor(filters.priceMin) : '';
    const max = filters.priceMax != null ? Math.ceil(filters.priceMax) : '';
    url.searchParams.append('price[]', `${min}-${max}`);
  }
  const sortMap: Record<SortOrder, string> = {
    relevance: 'relevance_v2',
    newest: 'added_desc',
    price_asc: 'price_asc',
    price_desc: 'price_desc',
  };
  url.searchParams.set('sort_by', sortMap[sortOrder]);
  return url.toString();
}

function buildMercariNativeUrl(keywords: string, filters: UnifiedFilter, sortOrder: SortOrder): string {
  const url = new URL('https://www.mercari.com/search/');
  url.searchParams.set('keyword', keywords.trim());
  url.searchParams.set('itemStatuses', '1');
  if (filters.priceMin != null) {
    url.searchParams.set('minPrice', String(Math.round(filters.priceMin * 100)));
  }
  if (filters.priceMax != null) {
    url.searchParams.set('maxPrice', String(Math.round(filters.priceMax * 100)));
  }
  const sortMap: Record<SortOrder, string> = {
    relevance: '1',
    newest: '2',
    price_asc: '3',
    price_desc: '4',
  };
  url.searchParams.set('sortBy', sortMap[sortOrder]);
  return url.toString();
}

function buildFacebookNativeUrl(
  keywords: string,
  filters: UnifiedFilter,
  sortOrder: SortOrder,
  context: AdapterExecutionContext,
): string {
  const hub =
    (filters.fulfillment === 'local_pickup' ? context.settings.homeFacebookCitySlug : null) ||
    filters.facebookLocationSlugs[0] ||
    context.settings.facebookCityHubs.find((h) => h.enabled)?.slug ||
    'seattle';
  const url = new URL(`https://www.facebook.com/marketplace/${encodeURIComponent(hub)}/search/`);
  url.searchParams.set('query', keywords.trim());
  if (filters.priceMin != null) {
    url.searchParams.set('minPrice', String(Math.floor(filters.priceMin)));
  }
  if (filters.priceMax != null) {
    url.searchParams.set('maxPrice', String(Math.ceil(filters.priceMax)));
  }
  if (filters.fulfillment === 'shipping') {
    url.searchParams.set('deliveryMethod', 'shipping');
  } else if (filters.fulfillment === 'local_pickup') {
    url.searchParams.set('deliveryMethod', 'local_pick_up');
  }
  const sortMap: Record<SortOrder, string> = {
    relevance: 'best_match',
    newest: 'creation_time_descend',
    price_asc: 'price_ascend',
    price_desc: 'price_descend',
  };
  url.searchParams.set('sortBy', sortMap[sortOrder]);
  return url.toString();
}

/**
 * Placeholder adapter for browser-backed Marketplaces prior to Tickets #21–#23.
 * Preserves accurate filter translation & native link-out URLs while returning unconfigured/skipped status.
 */
export function createBrowserPlaceholderAdapter(
  marketplace: Exclude<MarketplaceId, 'ebay'>,
): MarketplaceAdapter {
  return {
    id: marketplace,
    translateFilters(keywords, unifiedFilters, sortOrder, context): AdapterTranslationResult {
      const notices: string[] = [];
      let status: TranslationStatus = 'exact';

      if (marketplace === 'poshmark') {
        const nativeSearchUrl = buildPoshmarkNativeUrl(keywords, unifiedFilters, sortOrder);
        if (unifiedFilters.fulfillment === 'local_pickup') {
          return {
            marketplace,
            status: 'skipped_unsupported',
            notices: ['Poshmark does not support local pickup filtering.'],
            nativeSearchUrl,
          };
        }
        if (unifiedFilters.conditions.includes('poor')) {
          status = 'broadened';
          notices.push('Poshmark has no Poor tier; mapped Poor to Fair (uf).');
        }
        return { marketplace, status, notices, nativeSearchUrl };
      }

      if (marketplace === 'mercari') {
        const nativeSearchUrl = buildMercariNativeUrl(keywords, unifiedFilters, sortOrder);
        if (unifiedFilters.fulfillment === 'local_pickup') {
          return {
            marketplace,
            status: 'skipped_unsupported',
            notices: ['Mercari Local was discontinued; local pickup is not supported.'],
            nativeSearchUrl,
          };
        }
        return { marketplace, status, notices, nativeSearchUrl };
      }

      const nativeSearchUrl = buildFacebookNativeUrl(keywords, unifiedFilters, sortOrder, context);
      if (unifiedFilters.conditions.includes('poor')) {
        status = 'broadened';
        notices.push('Facebook Marketplace has no Poor tier; mapped Poor to Used - Fair.');
      }
      if (
        unifiedFilters.fulfillment === 'local_pickup' &&
        unifiedFilters.localPickupRadiusMiles != null &&
        unifiedFilters.localPickupRadiusMiles !== filtersRadiusDefault(unifiedFilters)
      ) {
        status = 'broadened';
        notices.push(
          'Facebook Marketplace local pickup uses the profile-saved browse radius rather than per-search radius automation.',
        );
      }
      return { marketplace, status, notices, nativeSearchUrl };
    },

    async executeInitial(params: AdapterSearchParams): Promise<AdapterBatchResult> {
      if (params.translation.status === 'skipped_unsupported') {
        return {
          runStatus: 'skipped_unsupported',
          listings: [],
          droppedMalformedCount: 0,
          hasMore: false,
        };
      }
      return {
        runStatus: 'unconfigured',
        listings: [],
        droppedMalformedCount: 0,
        hasMore: false,
        errorMessage: `${MARKETPLACE_LABELS[marketplace]} browser adapter is not enabled in this build yet.`,
      };
    },

    async loadMore(_params: AdapterLoadMoreParams): Promise<AdapterBatchResult> {
      return {
        runStatus: 'empty',
        listings: [],
        droppedMalformedCount: 0,
        hasMore: false,
      };
    },
  };
}

function filtersRadiusDefault(filters: UnifiedFilter): number {
  return filters.facebookRadiusMiles || 500;
}
