import type {
  AppSettings,
  Listing,
  MarketplaceId,
  MarketplaceRunStatus,
  MarketplaceStatus,
  SortOrder,
  TranslationDiagnostic,
  UnifiedFilter,
} from '../../shared/index.ts';
import type { RawEbayCredentials } from '../secrets.ts';

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type ClockFn = () => number;
export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface AdapterExecutionContext {
  settings: AppSettings;
  ebayCredentials?: RawEbayCredentials;
  signal?: AbortSignal;
  clock?: ClockFn;
  sleep?: SleepFn;
  onProgress?: (update: Partial<MarketplaceStatus>) => void;
  onBatch?: (batch: { listings: Listing[]; cityHub?: string; hasMore: boolean }) => void;
}

export interface AdapterTranslationResult extends TranslationDiagnostic {
  nativeQuery?: unknown;
}

export interface AdapterSearchParams {
  keywords: string;
  unifiedFilters: UnifiedFilter;
  sortOrder: SortOrder;
  translation: AdapterTranslationResult;
  context: AdapterExecutionContext;
}

export interface AdapterLoadMoreParams extends AdapterSearchParams {
  cursor: unknown;
  page: number;
}

export interface AdapterBatchResult {
  runStatus: Exclude<MarketplaceRunStatus, 'running'>;
  listings: Listing[];
  droppedMalformedCount: number;
  hasMore: boolean;
  nextCursor?: unknown;
  errorMessage?: string | null;
  completedCities?: number;
  totalCities?: number;
  currentCityLabel?: string | null;
  stoppedByUser?: boolean;
}

/**
 * Narrow interface implemented by each Marketplace adapter (eBay, Poshmark, Mercari, Facebook).
 */
export interface MarketplaceAdapter {
  readonly id: MarketplaceId;
  translateFilters(
    keywords: string,
    unifiedFilters: UnifiedFilter,
    sortOrder: SortOrder,
    context: AdapterExecutionContext,
  ): AdapterTranslationResult;
  executeInitial(params: AdapterSearchParams): Promise<AdapterBatchResult>;
  loadMore(params: AdapterLoadMoreParams): Promise<AdapterBatchResult>;
  clearChallengeLatch?(): void;
}
