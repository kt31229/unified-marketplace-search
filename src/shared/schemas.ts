import { z } from 'zod';

export const MARKETPLACE_IDS = ['ebay', 'poshmark', 'mercari', 'facebook'] as const;
export const BROWSER_MARKETPLACE_IDS = ['facebook', 'poshmark', 'mercari'] as const;

export const MarketplaceIdSchema = z.enum(MARKETPLACE_IDS);
export const MarketplaceSchema = MarketplaceIdSchema;
export const BrowserMarketplaceIdSchema = z.enum(BROWSER_MARKETPLACE_IDS);

export const ConditionTierSchema = z.enum(['new', 'like_new', 'good', 'fair', 'poor']);
export const FulfillmentModeSchema = z.enum(['any', 'shipping', 'local_pickup']);
export const SortOrderSchema = z.enum(['relevance', 'newest', 'price_asc', 'price_desc']);

export const ShippingTypeSchema = z.enum([
  'free',
  'known',
  'buyer_paid_unknown',
  'local_pickup_only',
  'unknown',
]);

export const ListingFormatSchema = z.enum(['fixed_price', 'auction']);
export const TranslationStatusSchema = z.enum(['exact', 'broadened', 'skipped_unsupported']);

export const MarketplaceRunStatusSchema = z.enum([
  'running',
  'success',
  'empty',
  'skipped_unsupported',
  'unconfigured',
  'challenge_or_auth_required',
  'timeout',
  'parse_error',
  'network_error',
]);

export const BrowserChannelSchema = z.enum(['chrome', 'msedge']);

export const FacebookCityHubSchema = z.object({
  slug: z.string().trim().min(1, 'Hub slug is required'),
  label: z.string().trim().min(1, 'Hub label is required'),
  enabled: z.boolean(),
});

export type MarketplaceId = z.infer<typeof MarketplaceIdSchema>;
export type Marketplace = MarketplaceId;
export type BrowserMarketplaceId = z.infer<typeof BrowserMarketplaceIdSchema>;
export type ConditionTier = z.infer<typeof ConditionTierSchema>;
export type FulfillmentMode = z.infer<typeof FulfillmentModeSchema>;
export type SortOrder = z.infer<typeof SortOrderSchema>;
export type ShippingType = z.infer<typeof ShippingTypeSchema>;
export type ListingFormat = z.infer<typeof ListingFormatSchema>;
export type TranslationStatus = z.infer<typeof TranslationStatusSchema>;
export type MarketplaceRunStatus = z.infer<typeof MarketplaceRunStatusSchema>;
export type BrowserChannel = z.infer<typeof BrowserChannelSchema>;
export type FacebookCityHub = z.infer<typeof FacebookCityHubSchema>;

export const MARKETPLACE_LABELS: Record<MarketplaceId, string> = {
  ebay: 'eBay',
  poshmark: 'Poshmark',
  mercari: 'Mercari US',
  facebook: 'Facebook Marketplace',
};

export const DEFAULT_FACEBOOK_CITY_HUBS: FacebookCityHub[] = [
  { slug: 'seattle', label: 'Seattle, WA', enabled: true },
  { slug: 'sanfrancisco', label: 'San Francisco, CA', enabled: true },
  { slug: 'la', label: 'Los Angeles, CA', enabled: true },
  { slug: 'denver', label: 'Denver, CO', enabled: true },
  { slug: 'dallas', label: 'Dallas, TX', enabled: true },
  { slug: 'chicago', label: 'Chicago, IL', enabled: true },
  { slug: 'atlanta', label: 'Atlanta, GA', enabled: true },
  { slug: 'nyc', label: 'New York, NY', enabled: true },
];

export function createDefaultFacebookCityHubs(): FacebookCityHub[] {
  return DEFAULT_FACEBOOK_CITY_HUBS.map((hub) => ({ ...hub }));
}

export const UnifiedFilterSchema = z
  .object({
    priceMin: z.number().nonnegative().nullable().optional(),
    priceMax: z.number().nonnegative().nullable().optional(),
    conditions: z.array(ConditionTierSchema).default([]),
    fulfillment: FulfillmentModeSchema.default('any'),
    facebookLocationSlugs: z.array(z.string().trim().min(1)).default([]),
    facebookRadiusMiles: z.number().positive().default(500),
    localPickupPostalCode: z.string().trim().nullable().optional(),
    localPickupRadiusMiles: z.number().positive().nullable().optional(),
  })
  .refine(
    (filter) =>
      filter.priceMin == null ||
      filter.priceMax == null ||
      filter.priceMin <= filter.priceMax,
    {
      message: 'Minimum price must be less than or equal to maximum price',
      path: ['priceMax'],
    },
  );

export type UnifiedFilter = z.infer<typeof UnifiedFilterSchema>;

export const ListingSchema = z.object({
  marketplace: MarketplaceIdSchema,
  marketplaceListingId: z.string().min(1),
  url: z.string().url(),
  title: z.string().min(1),
  price: z.number().nonnegative(),
  shippingPrice: z.number().nonnegative().nullable(),
  shippingType: ShippingTypeSchema,
  listingFormat: ListingFormatSchema,
  bidCount: z.number().int().nonnegative().nullable(),
  buyNowPrice: z.number().nonnegative().nullable(),
  thumbnailUrl: z.string().url().nullable(),
  conditionLabel: z.string().nullable(),
  locationLabel: z.string().nullable(),
  listedAt: z.string().nullable(),
  adapterRank: z.number().int().nonnegative(),
  hubSlug: z.string().nullable().optional(),
});

export type Listing = z.infer<typeof ListingSchema>;

export const TranslationDiagnosticSchema = z.object({
  marketplace: MarketplaceIdSchema,
  status: TranslationStatusSchema,
  notices: z.array(z.string()),
  nativeSearchUrl: z.string().url(),
});

export type TranslationDiagnostic = z.infer<typeof TranslationDiagnosticSchema>;

export const MarketplaceStatusSchema = z.object({
  marketplace: MarketplaceIdSchema,
  runStatus: MarketplaceRunStatusSchema,
  translationStatus: TranslationStatusSchema,
  notices: z.array(z.string()),
  nativeSearchUrl: z.string().url(),
  loadedCount: z.number().int().nonnegative(),
  droppedMalformedCount: z.number().int().nonnegative(),
  errorMessage: z.string().nullable().optional(),
  completedCities: z.number().int().nonnegative().optional(),
  totalCities: z.number().int().nonnegative().optional(),
  currentCityLabel: z.string().nullable().optional(),
  stoppedByUser: z.boolean().optional(),
});

export type MarketplaceStatus = z.infer<typeof MarketplaceStatusSchema>;

export const SavedSearchSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1),
  keywords: z.string().trim().min(1),
  unifiedFilters: UnifiedFilterSchema,
  marketplaces: z.array(MarketplaceIdSchema).min(1),
  sortOrder: SortOrderSchema,
  createdAt: z.string(),
  lastRunAt: z.string().nullable(),
});

export type SavedSearch = z.infer<typeof SavedSearchSchema>;

export const CreateSavedSearchInputSchema = z.object({
  name: z.string().trim().min(1, 'Saved Search name is required'),
  keywords: z.string().trim().min(1, 'Enter search keywords'),
  unifiedFilters: UnifiedFilterSchema,
  marketplaces: z.array(MarketplaceIdSchema).min(1, 'Select at least one Marketplace'),
  sortOrder: SortOrderSchema.default('relevance'),
});

export type CreateSavedSearchInput = z.infer<typeof CreateSavedSearchInputSchema>;

export const UpdateSavedSearchInputSchema = z
  .object({
    name: z.string().trim().min(1, 'Saved Search name is required').optional(),
    keywords: z.string().trim().min(1, 'Enter search keywords').optional(),
    unifiedFilters: UnifiedFilterSchema.optional(),
    marketplaces: z
      .array(MarketplaceIdSchema)
      .min(1, 'Select at least one Marketplace')
      .optional(),
    sortOrder: SortOrderSchema.optional(),
  })
  .refine(
    (input) =>
      input.name !== undefined ||
      input.keywords !== undefined ||
      input.unifiedFilters !== undefined ||
      input.marketplaces !== undefined ||
      input.sortOrder !== undefined,
    { message: 'Provide at least one field to update' },
  );

export type UpdateSavedSearchInput = z.infer<typeof UpdateSavedSearchInputSchema>;

export function suggestSavedSearchName(
  keywords: string,
  unifiedFilters?: UnifiedFilter,
): string {
  const base = keywords.trim() || 'Saved Search';
  if (!unifiedFilters) {
    return base;
  }

  const parts: string[] = [];
  if (unifiedFilters.priceMin != null && unifiedFilters.priceMax != null) {
    parts.push(`$${unifiedFilters.priceMin}–$${unifiedFilters.priceMax}`);
  } else if (unifiedFilters.priceMin != null) {
    parts.push(`$${unifiedFilters.priceMin}+`);
  } else if (unifiedFilters.priceMax != null) {
    parts.push(`≤$${unifiedFilters.priceMax}`);
  }

  if (unifiedFilters.fulfillment === 'local_pickup') {
    parts.push('Local Pickup');
  } else if (unifiedFilters.fulfillment === 'shipping') {
    parts.push('Shipping');
  }

  return parts.length > 0 ? `${base} (${parts.join(' · ')})` : base;
}

export const WatchlistEntrySchema = z.object({
  marketplace: MarketplaceIdSchema,
  marketplaceListingId: z.string().min(1),
  url: z.string().url(),
  title: z.string().min(1),
  price: z.number().nonnegative().nullable(),
  shippingPrice: z.number().nonnegative().nullable(),
  thumbnailUrl: z.string().url().nullable(),
  cachedThumbnailPath: z.string().nullable(),
  savedAt: z.string(),
});

export type WatchlistEntry = z.infer<typeof WatchlistEntrySchema>;

export const WatchlistSortOrderSchema = z.enum(['saved_desc', 'price_asc', 'price_desc']);
export type WatchlistSortOrder = z.infer<typeof WatchlistSortOrderSchema>;

export const WatchlistSnapshotInputSchema = z.object({
  marketplace: MarketplaceIdSchema,
  marketplaceListingId: z.string().min(1),
  url: z.string().url(),
  title: z.string().min(1),
  price: z.number().nonnegative().nullable().optional().default(null),
  shippingPrice: z.number().nonnegative().nullable().optional().default(null),
  thumbnailUrl: z.string().url().nullable().optional().default(null),
});

export type WatchlistSnapshotInput = z.infer<typeof WatchlistSnapshotInputSchema>;

export const CreateWatchlistEntryRequestSchema = z.union([
  z.object({ listing: WatchlistSnapshotInputSchema }).transform((v) => v.listing),
  WatchlistSnapshotInputSchema,
]);

export const AppSettingsSchema = z.object({
  browserChannel: BrowserChannelSchema,
  homePostalCode: z.string().trim().nullable(),
  defaultLocalPickupRadiusMiles: z.number().int().positive().max(500),
  homeFacebookCitySlug: z.string().trim().nullable(),
  facebookRadiusMiles: z.number().int().positive().max(500).default(500),
  facebookCityHubs: z.array(FacebookCityHubSchema),
});

export type AppSettings = z.infer<typeof AppSettingsSchema>;

export function createDefaultAppSettings(): AppSettings {
  return {
    browserChannel: 'chrome',
    homePostalCode: null,
    defaultLocalPickupRadiusMiles: 50,
    homeFacebookCitySlug: null,
    facebookRadiusMiles: 500,
    facebookCityHubs: createDefaultFacebookCityHubs(),
  };
}

export const EbaySecretsStatusSchema = z.object({
  configured: z.boolean(),
  origin: z.enum(['env', 'file', 'none']),
  clientId: z.string().nullable(),
  clientSecretMasked: z.string().nullable(),
});

export type EbaySecretsStatus = z.infer<typeof EbaySecretsStatusSchema>;

export const BrowserProfileStatusSchema = z.object({
  exists: z.boolean(),
  activeContext: z.boolean(),
});

export type BrowserProfileStatus = z.infer<typeof BrowserProfileStatusSchema>;

export const SettingsResponseSchema = z.object({
  settings: AppSettingsSchema,
  ebay: EbaySecretsStatusSchema,
  dataDir: z.string(),
  browserProfiles: z.record(BrowserMarketplaceIdSchema, BrowserProfileStatusSchema),
});

export type SettingsResponse = z.infer<typeof SettingsResponseSchema>;

export const UpdateEbayCredentialsInputSchema = z.object({
  clientId: z.string().trim().min(1).nullable().optional(),
  clientSecret: z.string().trim().optional(),
  client_id: z.string().trim().min(1).nullable().optional(),
  client_secret: z.string().trim().optional(),
  clear: z.boolean().optional(),
});

export type UpdateEbayCredentialsInput = z.infer<typeof UpdateEbayCredentialsInputSchema>;

export const UpdateSettingsInputSchema = z.object({
  settings: AppSettingsSchema.partial().optional(),
  ebay: UpdateEbayCredentialsInputSchema.optional(),
});

export type UpdateSettingsInput = z.infer<typeof UpdateSettingsInputSchema>;

export const SearchRequestSchema = z.object({
  keywords: z.string().trim().min(1, 'Enter search keywords'),
  unifiedFilters: UnifiedFilterSchema,
  marketplaces: z.array(MarketplaceIdSchema).min(1, 'Select at least one Marketplace'),
  sortOrder: SortOrderSchema.default('relevance'),
  refresh: z.boolean().optional(),
});

export type SearchRequest = z.infer<typeof SearchRequestSchema>;

export const LoadMoreRequestSchema = z.object({
  marketplace: MarketplaceIdSchema.optional(),
});

export type LoadMoreRequest = z.infer<typeof LoadMoreRequestSchema>;

export const SearchRunStartedEventSchema = z.object({
  searchRunId: z.string().min(1),
  diagnostics: z.record(MarketplaceIdSchema, TranslationDiagnosticSchema),
  statuses: z.record(MarketplaceIdSchema, MarketplaceStatusSchema),
});

export type SearchRunStartedEvent = z.infer<typeof SearchRunStartedEventSchema>;

export const MarketplaceStatusEventSchema = z.object({
  searchRunId: z.string().min(1),
  status: MarketplaceStatusSchema,
});

export type MarketplaceStatusEvent = z.infer<typeof MarketplaceStatusEventSchema>;

export const ListingsBatchEventSchema = z.object({
  searchRunId: z.string().min(1),
  marketplace: MarketplaceIdSchema,
  cityHub: z.string().optional(),
  listings: z.array(ListingSchema),
  hasMore: z.boolean(),
});

export type ListingsBatchEvent = z.infer<typeof ListingsBatchEventSchema>;

export const RunCompleteEventSchema = z.object({
  searchRunId: z.string().min(1),
  statuses: z.record(MarketplaceIdSchema, MarketplaceStatusSchema),
});

export type RunCompleteEvent = z.infer<typeof RunCompleteEventSchema>;

export type SearchSseEvent =
  | { event: 'run_started'; data: SearchRunStartedEvent }
  | { event: 'marketplace_status'; data: MarketplaceStatusEvent }
  | { event: 'listings_batch'; data: ListingsBatchEvent }
  | { event: 'run_complete'; data: RunCompleteEvent };

export function createDefaultUnifiedFilter(settings?: Pick<AppSettings, 'facebookCityHubs' | 'facebookRadiusMiles' | 'homePostalCode' | 'defaultLocalPickupRadiusMiles'>): UnifiedFilter {
  const hubs = settings?.facebookCityHubs ?? DEFAULT_FACEBOOK_CITY_HUBS;
  return {
    priceMin: null,
    priceMax: null,
    conditions: [],
    fulfillment: 'any',
    facebookLocationSlugs: hubs.filter((h) => h.enabled).map((h) => h.slug),
    facebookRadiusMiles: settings?.facebookRadiusMiles ?? 500,
    localPickupPostalCode: settings?.homePostalCode ?? null,
    localPickupRadiusMiles: settings?.defaultLocalPickupRadiusMiles ?? 50,
  };
}
