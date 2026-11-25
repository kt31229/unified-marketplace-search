import { randomUUID } from 'node:crypto';
import {
  MARKETPLACE_IDS,
  type AppSettings,
  type Listing,
  type MarketplaceId,
  type MarketplaceStatus,
  type SearchRequest,
  type SearchSseEvent,
  type SortOrder,
  type TranslationDiagnostic,
  type UnifiedFilter,
} from '../shared/index.ts';
import type { SecretsStore } from './secrets.ts';
import { applyPostFilters } from './adapters/post-filter.ts';
import {
  defaultSleep,
  formatRetryFailureMessage,
  formatRetrySuccessNotice,
  isRetryableRunStatus,
} from './adapters/utils.ts';
import type {
  AdapterBatchResult,
  AdapterExecutionContext,
  AdapterTranslationResult,
  ClockFn,
  MarketplaceAdapter,
  SleepFn,
} from './adapters/types.ts';

const CACHE_TTL_MS = 60_000;

export type SseEmitter = (event: SearchSseEvent) => Promise<void> | void;

interface MarketplaceRunState {
  translation: AdapterTranslationResult;
  status: MarketplaceStatus;
  cursor: unknown;
  page: number;
  hasMore: boolean;
}

interface ActiveRunState {
  runId: string;
  keywords: string;
  unifiedFilters: UnifiedFilter;
  sortOrder: SortOrder;
  abortController: AbortController;
  facebookAbortController: AbortController;
  facebookStoppedByUser: boolean;
  marketplaces: Map<MarketplaceId, MarketplaceRunState>;
}

interface CacheEntry {
  expiresAtMs: number;
  result: AdapterBatchResult;
}

export interface SearchOrchestratorOptions {
  adapters: Record<MarketplaceId, MarketplaceAdapter>;
  getSettings: () => AppSettings;
  secretsStore: SecretsStore;
  clock?: ClockFn;
  sleep?: SleepFn;
}

function buildCacheKey(
  marketplace: MarketplaceId,
  keywords: string,
  unifiedFilters: UnifiedFilter,
  sortOrder: SortOrder,
  page: number,
): string {
  const normalizedFilters = {
    priceMin: unifiedFilters.priceMin ?? null,
    priceMax: unifiedFilters.priceMax ?? null,
    conditions: [...unifiedFilters.conditions].sort(),
    fulfillment: unifiedFilters.fulfillment,
    facebookLocationSlugs: [...unifiedFilters.facebookLocationSlugs],
    facebookRadiusMiles: unifiedFilters.facebookRadiusMiles,
    localPickupPostalCode: unifiedFilters.localPickupPostalCode ?? null,
    localPickupRadiusMiles: unifiedFilters.localPickupRadiusMiles ?? null,
  };
  return JSON.stringify([marketplace, keywords.trim(), normalizedFilters, sortOrder, page]);
}

function toTranslationDiagnostic(result: AdapterTranslationResult): TranslationDiagnostic {
  return {
    marketplace: result.marketplace,
    status: result.status,
    notices: result.notices,
    nativeSearchUrl: result.nativeSearchUrl,
  };
}

function createInitialStatus(translation: AdapterTranslationResult): MarketplaceStatus {
  if (translation.status === 'skipped_unsupported') {
    return {
      marketplace: translation.marketplace,
      runStatus: 'skipped_unsupported',
      translationStatus: translation.status,
      notices: translation.notices,
      nativeSearchUrl: translation.nativeSearchUrl,
      loadedCount: 0,
      droppedMalformedCount: 0,
    };
  }
  return {
    marketplace: translation.marketplace,
    runStatus: 'running',
    translationStatus: translation.status,
    notices: translation.notices,
    nativeSearchUrl: translation.nativeSearchUrl,
    loadedCount: 0,
    droppedMalformedCount: 0,
  };
}

function mergeRetryDiagnostics(
  baseNotices: readonly string[],
  resultNotices: readonly string[] | undefined,
  retriesUsed: number,
  finalRunStatus: MarketplaceStatus['runStatus'],
  rawErrorMessage: string | null | undefined,
): { notices: string[]; errorMessage: string | null } {
  const notices = [...baseNotices];
  if (resultNotices?.length) {
    for (const notice of resultNotices) {
      if (!notices.includes(notice)) {
        notices.push(notice);
      }
    }
  }
  let errorMessage = rawErrorMessage ?? null;
  if (retriesUsed > 0) {
    if (isRetryableRunStatus(finalRunStatus)) {
      errorMessage = formatRetryFailureMessage(retriesUsed, errorMessage);
    } else {
      notices.push(formatRetrySuccessNotice(retriesUsed));
    }
  }
  return { notices, errorMessage };
}

function recordFromRunMap<T>(
  entries: Iterable<[MarketplaceId, T]>,
): Partial<Record<MarketplaceId, T>> {
  const record: Partial<Record<MarketplaceId, T>> = {};
  for (const [mp, value] of entries) {
    record[mp] = value;
  }
  return record;
}

/**
 * Coordinates streaming multi-Marketplace searches, 60s caching, post-filtering,
 * run cancellation, load-more pagination, and targeted single-Marketplace retries.
 */
export class SearchOrchestrator {
  private readonly adapters: Record<MarketplaceId, MarketplaceAdapter>;
  private readonly getSettings: () => AppSettings;
  private readonly secretsStore: SecretsStore;
  private readonly clock: ClockFn;
  private readonly sleep: SleepFn;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly runs = new Map<string, ActiveRunState>();
  private readonly latchedChallenges = new Set<MarketplaceId>();
  private currentStreamRunId: string | null = null;

  constructor(options: SearchOrchestratorOptions) {
    this.adapters = options.adapters;
    this.getSettings = options.getSettings;
    this.secretsStore = options.secretsStore;
    this.clock = options.clock ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
  }

  private getCached(key: string): AdapterBatchResult | null {
    const entry = this.cache.get(key);
    if (!entry) {
      return null;
    }
    if (this.clock() >= entry.expiresAtMs) {
      this.cache.delete(key);
      return null;
    }
    return entry.result;
  }

  private setCached(key: string, result: AdapterBatchResult): void {
    if (result.runStatus !== 'success' && result.runStatus !== 'empty') {
      return;
    }
    this.cache.set(key, {
      expiresAtMs: this.clock() + CACHE_TTL_MS,
      result,
    });
  }

  private buildExecutionContext(
    run: ActiveRunState,
    marketplace: MarketplaceId,
    emit: SseEmitter,
    settings: AppSettings,
    allowAutoRetry = false,
  ): AdapterExecutionContext {
    const signal =
      marketplace === 'facebook'
        ? AbortSignal.any([run.abortController.signal, run.facebookAbortController.signal])
        : run.abortController.signal;

    return {
      settings,
      ebayCredentials: this.secretsStore.getRawCredentials(),
      signal,
      clock: this.clock,
      sleep: this.sleep,
      allowAutoRetry,
      onProgress: (update) => {
        const mpState = run.marketplaces.get(marketplace);
        if (!mpState) {
          return;
        }
        mpState.status = {
          ...mpState.status,
          ...update,
        };
        void emit({
          event: 'marketplace_status',
          data: {
            searchRunId: run.runId,
            status: mpState.status,
          },
        });
      },
      onBatch: (batch) => {
        const mpState = run.marketplaces.get(marketplace);
        if (!mpState) {
          return;
        }
        const normalizedListings = batch.cityHub
          ? batch.listings.map((item) =>
              item.hubSlug ? item : { ...item, hubSlug: batch.cityHub },
            )
          : batch.listings;
        const filtered = applyPostFilters(normalizedListings, run.unifiedFilters);
        mpState.status = {
          ...mpState.status,
          loadedCount: mpState.status.loadedCount + filtered.length,
        };
        if (filtered.length > 0) {
          void emit({
            event: 'listings_batch',
            data: {
              searchRunId: run.runId,
              marketplace,
              cityHub: batch.cityHub,
              listings: filtered,
              hasMore: batch.hasMore,
            },
          });
        }
      },
    };
  }

  private async executeWithRetries(params: {
    run: ActiveRunState;
    marketplace: MarketplaceId;
    allowAutoRetry: boolean;
    settings: AppSettings;
    emit: SseEmitter;
    runAttempt: (context: AdapterExecutionContext) => Promise<AdapterBatchResult>;
  }): Promise<{
    result: AdapterBatchResult;
    streamedIncrementally: boolean;
    retriesUsed: number;
    abortedDuringSleep: boolean;
  }> {
    const retryConfig = params.settings.retrySettings[params.marketplace];
    const maxRetries =
      params.marketplace !== 'facebook' && params.allowAutoRetry && retryConfig.enabled
        ? retryConfig.maxRetries
        : 0;
    const delayMs = Math.round(retryConfig.delaySeconds * 1000);
    const signal =
      params.marketplace === 'facebook'
        ? AbortSignal.any([params.run.abortController.signal, params.run.facebookAbortController.signal])
        : params.run.abortController.signal;

    for (let attempt = 0; ; attempt += 1) {
      let streamedIncrementally = false;
      const baseContext = this.buildExecutionContext(
        params.run,
        params.marketplace,
        params.emit,
        params.settings,
        params.allowAutoRetry,
      );
      const wrappedContext: AdapterExecutionContext = {
        ...baseContext,
        onBatch: (batch) => {
          streamedIncrementally = true;
          baseContext.onBatch?.(batch);
        },
      };

      const result = await params.runAttempt(wrappedContext);
      if (
        signal.aborted ||
        params.run.abortController.signal.aborted ||
        !isRetryableRunStatus(result.runStatus) ||
        attempt >= maxRetries
      ) {
        return {
          result,
          streamedIncrementally,
          retriesUsed: attempt,
          abortedDuringSleep: false,
        };
      }

      const mpState = params.run.marketplaces.get(params.marketplace);
      if (mpState) {
        mpState.status = {
          ...mpState.status,
          runStatus: 'running',
          retryAttempt: attempt + 1,
          retryMax: maxRetries,
        };
        await params.emit({
          event: 'marketplace_status',
          data: {
            searchRunId: params.run.runId,
            status: mpState.status,
          },
        });
      }

      try {
        await this.sleep(delayMs, signal);
      } catch {
        return {
          result,
          streamedIncrementally,
          retriesUsed: attempt,
          abortedDuringSleep: true,
        };
      }

      if (signal.aborted || params.run.abortController.signal.aborted) {
        return {
          result,
          streamedIncrementally,
          retriesUsed: attempt,
          abortedDuringSleep: true,
        };
      }
    }
  }

  private async runInitialForMarketplace(
    run: ActiveRunState,
    marketplace: MarketplaceId,
    bypassCache: boolean,
    emit: SseEmitter,
    allowAutoRetry: boolean,
  ): Promise<void> {
    const mpState = run.marketplaces.get(marketplace);
    if (!mpState) {
      return;
    }

    if (mpState.translation.status === 'skipped_unsupported') {
      mpState.status = {
        ...mpState.status,
        runStatus: 'skipped_unsupported',
      };
      await emit({
        event: 'marketplace_status',
        data: { searchRunId: run.runId, status: mpState.status },
      });
      return;
    }

    if (marketplace === 'facebook' && this.latchedChallenges.has('facebook')) {
      mpState.status = {
        ...mpState.status,
        runStatus: 'challenge_or_auth_required',
        errorMessage:
          'Facebook Marketplace is paused after a security checkpoint or login prompt. Click "Open browser session" or "Retry Facebook".',
      };
      await emit({
        event: 'marketplace_status',
        data: { searchRunId: run.runId, status: mpState.status },
      });
      return;
    }

    const adapter = this.adapters[marketplace];
    const settings = this.getSettings();
    const cacheKey = buildCacheKey(
      marketplace,
      run.keywords,
      run.unifiedFilters,
      run.sortOrder,
      1,
    );

    let streamedIncrementally = false;
    let retriesUsed = 0;
    let result: AdapterBatchResult | null = bypassCache ? null : this.getCached(cacheKey);

    if (!result) {
      const execution = await this.executeWithRetries({
        run,
        marketplace,
        allowAutoRetry,
        settings,
        emit,
        runAttempt: (context) =>
          adapter.executeInitial({
            keywords: run.keywords,
            unifiedFilters: run.unifiedFilters,
            sortOrder: run.sortOrder,
            translation: mpState.translation,
            context,
          }),
      });
      if (execution.abortedDuringSleep) {
        return;
      }
      result = execution.result;
      streamedIncrementally = execution.streamedIncrementally;
      retriesUsed = execution.retriesUsed;

      const stoppedEarly = marketplace === 'facebook' && run.facebookStoppedByUser;
      if (!run.abortController.signal.aborted && !stoppedEarly) {
        this.setCached(cacheKey, result);
      }
    }

    if (run.abortController.signal.aborted) {
      return;
    }

    const stoppedByUser =
      marketplace === 'facebook' && (run.facebookStoppedByUser || Boolean(result.stoppedByUser));

    if (marketplace === 'facebook' && result.runStatus === 'challenge_or_auth_required') {
      this.latchedChallenges.add('facebook');
    }

    const filteredListings: Listing[] = applyPostFilters(result.listings, run.unifiedFilters);
    mpState.cursor = stoppedByUser ? undefined : result.nextCursor;
    mpState.hasMore = stoppedByUser ? false : result.hasMore;
    mpState.page = 1;

    const finalRunStatus = stoppedByUser
      ? (streamedIncrementally ? mpState.status.loadedCount > 0 : filteredListings.length > 0)
        ? 'success'
        : 'empty'
      : result.runStatus === 'success' &&
          (streamedIncrementally ? mpState.status.loadedCount === 0 : filteredListings.length === 0)
        ? 'empty'
        : result.runStatus;

    const { notices: nextNotices, errorMessage: nextErrorMessage } = mergeRetryDiagnostics(
      mpState.status.notices,
      result.notices,
      retriesUsed,
      finalRunStatus,
      result.errorMessage,
    );

    mpState.status = {
      ...mpState.status,
      runStatus: finalRunStatus,
      notices: nextNotices,
      loadedCount: streamedIncrementally
        ? mpState.status.loadedCount
        : filteredListings.length,
      droppedMalformedCount: result.droppedMalformedCount,
      errorMessage: nextErrorMessage,
      completedCities: result.completedCities,
      totalCities: result.totalCities,
      currentCityLabel: stoppedByUser ? null : result.currentCityLabel,
      stoppedByUser: stoppedByUser || result.stoppedByUser,
      retryAttempt: undefined,
      retryMax: undefined,
    };

    if (!streamedIncrementally && filteredListings.length > 0) {
      await emit({
        event: 'listings_batch',
        data: {
          searchRunId: run.runId,
          marketplace,
          listings: filteredListings,
          hasMore: result.hasMore,
        },
      });
    }

    await emit({
      event: 'marketplace_status',
      data: {
        searchRunId: run.runId,
        status: mpState.status,
      },
    });
  }

  async startSearchStream(request: SearchRequest, emit: SseEmitter): Promise<void> {
    if (this.currentStreamRunId) {
      const previous = this.runs.get(this.currentStreamRunId);
      previous?.abortController.abort(new Error('Superseded by new search run'));
    }

    const runId = randomUUID();
    this.currentStreamRunId = runId;

    const abortController = new AbortController();
    const facebookAbortController = new AbortController();
    const settings = this.getSettings();
    const uniqueMarketplaces = Array.from(new Set(request.marketplaces));

    const run: ActiveRunState = {
      runId,
      keywords: request.keywords.trim(),
      unifiedFilters: request.unifiedFilters,
      sortOrder: request.sortOrder,
      abortController,
      facebookAbortController,
      facebookStoppedByUser: false,
      marketplaces: new Map(),
    };
    this.runs.set(runId, run);

    const diagnosticsEntries: Array<[MarketplaceId, TranslationDiagnostic]> = [];
    const initialStatusEntries: Array<[MarketplaceId, MarketplaceStatus]> = [];

    for (const mp of uniqueMarketplaces) {
      const adapter = this.adapters[mp];
      const translation = adapter.translateFilters(
        run.keywords,
        run.unifiedFilters,
        run.sortOrder,
        { settings },
      );
      const initialStatus = createInitialStatus(translation);
      run.marketplaces.set(mp, {
        translation,
        status: initialStatus,
        cursor: undefined,
        page: 1,
        hasMore: false,
      });
      diagnosticsEntries.push([mp, toTranslationDiagnostic(translation)]);
      initialStatusEntries.push([mp, initialStatus]);
    }

    await emit({
      event: 'run_started',
      data: {
        searchRunId: runId,
        diagnostics: recordFromRunMap(diagnosticsEntries),
        statuses: recordFromRunMap(initialStatusEntries),
      },
    });

    await Promise.all(
      uniqueMarketplaces.map((mp) =>
        this.runInitialForMarketplace(run, mp, Boolean(request.refresh), emit, true),
      ),
    );

    const finalStatuses = recordFromRunMap(
      Array.from(run.marketplaces.entries()).map(([mp, state]) => [mp, state.status]),
    );

    await emit({
      event: 'run_complete',
      data: {
        searchRunId: runId,
        statuses: finalStatuses,
      },
    });
  }

  hasRun(runId: string): boolean {
    const run = this.runs.get(runId);
    return Boolean(run && !run.abortController.signal.aborted);
  }

  async loadMore(
    runId: string,
    targetMarketplace: MarketplaceId | undefined,
    emit: SseEmitter,
  ): Promise<boolean> {
    const run = this.runs.get(runId);
    if (!run) {
      return false;
    }

    const targets = (targetMarketplace ? [targetMarketplace] : MARKETPLACE_IDS).filter((mp) => {
      const state = run.marketplaces.get(mp);
      return Boolean(state?.hasMore);
    });

    const settings = this.getSettings();

    await Promise.all(
      targets.map(async (mp) => {
        const mpState = run.marketplaces.get(mp);
        if (!mpState) {
          return;
        }
        const nextPage = mpState.page + 1;
        const cacheKey = buildCacheKey(
          mp,
          run.keywords,
          run.unifiedFilters,
          run.sortOrder,
          nextPage,
        );

        let streamedIncrementally = false;
        let retriesUsed = 0;
        let result = this.getCached(cacheKey);
        if (!result) {
          const adapter = this.adapters[mp];
          const execution = await this.executeWithRetries({
            run,
            marketplace: mp,
            allowAutoRetry: true,
            settings,
            emit,
            runAttempt: (context) =>
              adapter.loadMore({
                keywords: run.keywords,
                unifiedFilters: run.unifiedFilters,
                sortOrder: run.sortOrder,
                translation: mpState.translation,
                context,
                cursor: mpState.cursor,
                page: nextPage,
              }),
          });
          if (execution.abortedDuringSleep || run.abortController.signal.aborted) {
            return;
          }
          result = execution.result;
          streamedIncrementally = execution.streamedIncrementally;
          retriesUsed = execution.retriesUsed;

          const stoppedEarly = mp === 'facebook' && (run.facebookStoppedByUser || Boolean(result.stoppedByUser));
          if (!run.abortController.signal.aborted && !stoppedEarly) {
            this.setCached(cacheKey, result);
          }
        }

        const stoppedByUser =
          mp === 'facebook' && (run.facebookStoppedByUser || Boolean(result.stoppedByUser));

        if (mp === 'facebook' && result.runStatus === 'challenge_or_auth_required') {
          this.latchedChallenges.add('facebook');
        }

        const filtered = applyPostFilters(result.listings, run.unifiedFilters);
        mpState.cursor = stoppedByUser ? undefined : result.nextCursor;
        mpState.hasMore = stoppedByUser ? false : result.hasMore;
        mpState.page = nextPage;
        const nextLoadedCount = streamedIncrementally
          ? mpState.status.loadedCount
          : mpState.status.loadedCount + filtered.length;
        const nextRunStatus =
          result.runStatus === 'empty' && nextLoadedCount > 0
            ? 'success'
            : result.runStatus;
        const { notices: nextNotices, errorMessage: nextErrorMessage } = mergeRetryDiagnostics(
          mpState.status.notices,
          result.notices,
          retriesUsed,
          nextRunStatus,
          result.errorMessage,
        );
        mpState.status = {
          ...mpState.status,
          runStatus: nextRunStatus,
          notices: nextNotices,
          loadedCount: nextLoadedCount,
          droppedMalformedCount: mpState.status.droppedMalformedCount + result.droppedMalformedCount,
          errorMessage: nextErrorMessage,
          completedCities: result.completedCities ?? mpState.status.completedCities,
          totalCities: result.totalCities ?? mpState.status.totalCities,
          currentCityLabel: stoppedByUser
            ? null
            : result.currentCityLabel !== undefined
              ? result.currentCityLabel
              : mpState.status.currentCityLabel,
          stoppedByUser: stoppedByUser || result.stoppedByUser,
          retryAttempt: undefined,
          retryMax: undefined,
        };

        if (!streamedIncrementally && filtered.length > 0) {
          await emit({
            event: 'listings_batch',
            data: {
              searchRunId: run.runId,
              marketplace: mp,
              listings: filtered,
              hasMore: result.hasMore,
            },
          });
        }

        await emit({
          event: 'marketplace_status',
          data: {
            searchRunId: run.runId,
            status: mpState.status,
          },
        });
      }),
    );

    const statuses = recordFromRunMap(
      Array.from(run.marketplaces.entries()).map(([mp, state]) => [mp, state.status]),
    );
    await emit({
      event: 'run_complete',
      data: {
        searchRunId: run.runId,
        statuses,
      },
    });

    return true;
  }

  clearMarketplaceChallenge(marketplace: MarketplaceId): void {
    this.latchedChallenges.delete(marketplace);
    this.adapters[marketplace]?.clearChallengeLatch?.();
  }

  stopFacebookSweep(runId: string): { found: boolean; status: MarketplaceStatus | null } {
    const run = this.runs.get(runId);
    if (!run) {
      return { found: false, status: null };
    }
    run.facebookStoppedByUser = true;
    run.facebookAbortController.abort(new Error('Facebook sweep stopped by user'));
    const fbState = run.marketplaces.get('facebook');
    if (fbState) {
      fbState.hasMore = false;
      fbState.cursor = undefined;
      if (fbState.status.runStatus === 'running') {
        fbState.status = {
          ...fbState.status,
          runStatus: fbState.status.loadedCount > 0 ? 'success' : 'empty',
          currentCityLabel: null,
          stoppedByUser: true,
        };
      } else {
        fbState.status = {
          ...fbState.status,
          stoppedByUser: true,
        };
      }
      return { found: true, status: fbState.status };
    }
    return { found: true, status: null };
  }

  async retryMarketplace(
    runId: string,
    marketplace: MarketplaceId,
    emit: SseEmitter,
  ): Promise<boolean> {
    const run = this.runs.get(runId);
    if (!run) {
      return false;
    }

    this.clearMarketplaceChallenge(marketplace);
    if (marketplace === 'facebook') {
      run.facebookAbortController = new AbortController();
      run.facebookStoppedByUser = false;
    }

    const settings = this.getSettings();
    const adapter = this.adapters[marketplace];
    const translation = adapter.translateFilters(
      run.keywords,
      run.unifiedFilters,
      run.sortOrder,
      { settings },
    );
    const initialStatus = createInitialStatus(translation);

    run.marketplaces.set(marketplace, {
      translation,
      status: initialStatus,
      cursor: undefined,
      page: 1,
      hasMore: false,
    });

    await emit({
      event: 'marketplace_status',
      data: {
        searchRunId: run.runId,
        status: initialStatus,
      },
    });

    // Bypass 60s cache and disable automatic retries on explicit manual retry
    await this.runInitialForMarketplace(run, marketplace, true, emit, false);

    const statuses = recordFromRunMap(
      Array.from(run.marketplaces.entries()).map(([mp, state]) => [mp, state.status]),
    );
    await emit({
      event: 'run_complete',
      data: {
        searchRunId: run.runId,
        statuses,
      },
    });

    return true;
  }

  abortAll(): void {
    for (const run of this.runs.values()) {
      run.abortController.abort(new Error('Server shutting down'));
    }
    this.runs.clear();
  }
}
