import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_FACEBOOK_CITY_HUBS,
  MARKETPLACE_IDS,
  createDefaultUnifiedFilter,
  suggestSavedSearchName,
  validateSearchDraft,
  type FacebookCityHub,
  type Listing,
  type MarketplaceId,
  type SavedSearch,
  type SettingsResponse,
  type SortOrder,
  type UnifiedFilter,
  type WatchlistEntry,
  type WatchlistSnapshotInput,
} from '../shared/index.ts';
import { BackToTopTab } from './components/BackToTopTab.tsx';
import { ConfirmDialog } from './components/ConfirmDialog.tsx';
import { SaveSearchDialog } from './components/SaveSearchDialog.tsx';
import { SavedSearchesPanel } from './components/SavedSearchesPanel.tsx';
import { SearchView, type TriggeredSearchRequest } from './components/SearchView.tsx';
import { SettingsView, type FetchLike } from './components/SettingsView.tsx';
import { UndoToast } from './components/UndoToast.tsx';
import { UnifiedFiltersPanel } from './components/UnifiedFiltersPanel.tsx';
import { WatchlistView } from './components/WatchlistView.tsx';

export type WorkbenchView = 'search' | 'watchlist' | 'settings';

export interface AppProps {
  fetchImpl?: FetchLike;
  initialView?: WorkbenchView;
}

function sameSortedStrings(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((val, idx) => val === sb[idx]);
}

function isSavedSearchDirty(
  saved: SavedSearch | null,
  draft: {
    keywords: string;
    unifiedFilters: UnifiedFilter;
    marketplaces: readonly MarketplaceId[];
    sortOrder: SortOrder;
  },
): boolean {
  if (!saved) {
    return false;
  }
  if (saved.keywords.trim() !== draft.keywords.trim()) {
    return true;
  }
  if (saved.sortOrder !== draft.sortOrder) {
    return true;
  }
  if (!sameSortedStrings(saved.marketplaces, draft.marketplaces)) {
    return true;
  }

  const a = saved.unifiedFilters;
  const b = draft.unifiedFilters;
  if ((a.priceMin ?? null) !== (b.priceMin ?? null)) {
    return true;
  }
  if ((a.priceMax ?? null) !== (b.priceMax ?? null)) {
    return true;
  }
  if (!sameSortedStrings(a.conditions, b.conditions)) {
    return true;
  }
  if (a.fulfillment !== b.fulfillment) {
    return true;
  }
  if (!sameSortedStrings(a.facebookLocationSlugs, b.facebookLocationSlugs)) {
    return true;
  }
  if (a.facebookRadiusMiles !== b.facebookRadiusMiles) {
    return true;
  }
  if ((a.localPickupPostalCode?.trim() || null) !== (b.localPickupPostalCode?.trim() || null)) {
    return true;
  }
  if ((a.localPickupRadiusMiles ?? null) !== (b.localPickupRadiusMiles ?? null)) {
    return true;
  }
  return false;
}

export function App({ fetchImpl = fetch, initialView = 'search' }: AppProps) {
  const [activeView, setActiveView] = useState<WorkbenchView>(initialView);
  const [availableHubs, setAvailableHubs] = useState<FacebookCityHub[]>(
    DEFAULT_FACEBOOK_CITY_HUBS,
  );
  const [defaultFilterBaseline, setDefaultFilterBaseline] = useState<UnifiedFilter>(() =>
    createDefaultUnifiedFilter(),
  );
  const [unifiedFilters, setUnifiedFilters] = useState<UnifiedFilter>(() =>
    createDefaultUnifiedFilter(),
  );
  const [watchlistEntries, setWatchlistEntries] = useState<WatchlistEntry[]>([]);
  const [watchlistLoading, setWatchlistLoading] = useState(false);
  const [undoEntry, setUndoEntry] = useState<WatchlistEntry | null>(null);

  const loadWatchlist = useCallback(async () => {
    setWatchlistLoading(true);
    try {
      const res = await fetchImpl('/api/watchlist');
      if (!res.ok) {
        return;
      }
      const json = (await res.json()) as { entries?: WatchlistEntry[] };
      if (Array.isArray(json.entries)) {
        setWatchlistEntries(json.entries);
      }
    } catch {
      // Ignore if watchlist endpoint is unavailable in isolated tests
    } finally {
      setWatchlistLoading(false);
    }
  }, [fetchImpl]);

  const [keywords, setKeywords] = useState('');
  const [enabledMarketplaces, setEnabledMarketplaces] = useState<MarketplaceId[]>([
    ...MARKETPLACE_IDS,
  ]);
  const [sortOrder, setSortOrder] = useState<SortOrder>('relevance');

  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>([]);
  const [activeSavedSearchId, setActiveSavedSearchId] = useState<string | null>(null);
  const [savedSearchError, setSavedSearchError] = useState<string | null>(null);
  const [isSavingSearch, setIsSavingSearch] = useState(false);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SavedSearch | null>(null);
  const [pendingRunRequest, setPendingRunRequest] = useState<TriggeredSearchRequest | null>(null);

  const runSeqRef = useRef(0);
  const hasExplicitFilterStateRef = useRef(false);

  useEffect(() => {
    let active = true;
    fetchImpl('/api/settings')
      .then(async (res) => {
        if (!res.ok) {
          return null;
        }
        return (await res.json()) as SettingsResponse;
      })
      .then((json) => {
        if (!active || !json?.settings) {
          return;
        }
        const hubs = json.settings.facebookCityHubs;
        const seeded = createDefaultUnifiedFilter(json.settings);
        setAvailableHubs(hubs);
        setDefaultFilterBaseline(seeded);
        if (!hasExplicitFilterStateRef.current) {
          setUnifiedFilters((prev) => ({
            ...prev,
            facebookLocationSlugs:
              prev.facebookLocationSlugs.length === DEFAULT_FACEBOOK_CITY_HUBS.length
                ? seeded.facebookLocationSlugs
                : prev.facebookLocationSlugs,
            facebookRadiusMiles: seeded.facebookRadiusMiles,
            localPickupPostalCode: prev.localPickupPostalCode ?? seeded.localPickupPostalCode,
            localPickupRadiusMiles: prev.localPickupRadiusMiles ?? seeded.localPickupRadiusMiles,
          }));
        }
      })
      .catch(() => {
        // Fallback to default Unified Filter settings if settings endpoint is unavailable
      });

    void loadWatchlist();

    return () => {
      active = false;
    };
  }, [fetchImpl, loadWatchlist]);

  useEffect(() => {
    if (activeView === 'watchlist') {
      void loadWatchlist();
    }
  }, [activeView, loadWatchlist]);

  const watchlistedKeys = useMemo(
    () =>
      new Set(watchlistEntries.map((entry) => `${entry.marketplace}:${entry.marketplaceListingId}`)),
    [watchlistEntries],
  );

  const saveWatchlistSnapshot = async (snapshot: WatchlistSnapshotInput) => {
    const res = await fetchImpl('/api/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listing: snapshot }),
    });
    if (!res.ok) {
      return;
    }
    const json = (await res.json()) as { entry?: WatchlistEntry };
    const saved = json.entry;
    if (!saved) {
      return;
    }
    setWatchlistEntries((prev) => [
      saved,
      ...prev.filter(
        (e) =>
          !(
            e.marketplace === saved.marketplace &&
            e.marketplaceListingId === saved.marketplaceListingId
          ),
      ),
    ]);
  };

  const removeWatchlistEntry = async (marketplace: MarketplaceId, listingId: string) => {
    const target = watchlistEntries.find(
      (e) => e.marketplace === marketplace && e.marketplaceListingId === listingId,
    );
    setWatchlistEntries((prev) =>
      prev.filter((e) => !(e.marketplace === marketplace && e.marketplaceListingId === listingId)),
    );
    if (target) {
      setUndoEntry(target);
    }

    try {
      await fetchImpl(`/api/watchlist/${marketplace}/${encodeURIComponent(listingId)}`, {
        method: 'DELETE',
      });
    } catch {
      // Keep optimistic UI state unless user clicks Undo
    }
  };

  const handleToggleWatchlist = (listing: Listing) => {
    const key = `${listing.marketplace}:${listing.marketplaceListingId}`;
    if (watchlistedKeys.has(key)) {
      void removeWatchlistEntry(listing.marketplace, listing.marketplaceListingId);
    } else {
      void saveWatchlistSnapshot(listing);
    }
  };

  const handleUndoRemove = (entry: WatchlistEntry) => {
    setUndoEntry(null);
    void saveWatchlistSnapshot({
      marketplace: entry.marketplace,
      marketplaceListingId: entry.marketplaceListingId,
      url: entry.url,
      title: entry.title,
      price: entry.price,
      shippingPrice: entry.shippingPrice,
      thumbnailUrl: entry.thumbnailUrl,
    });
  };

  useEffect(() => {
    let active = true;
    fetchImpl('/api/saved-searches')
      .then(async (res) => {
        if (!res.ok) {
          return null;
        }
        return (await res.json()) as { savedSearches?: SavedSearch[] };
      })
      .then((json) => {
        if (!active || !Array.isArray(json?.savedSearches)) {
          return;
        }
        setSavedSearches(json.savedSearches);
      })
      .catch(() => {
        // Saved Searches remain empty if endpoint is unavailable
      });

    return () => {
      active = false;
    };
  }, [fetchImpl]);

  const activeSavedSearch = useMemo(
    () =>
      activeSavedSearchId != null
        ? savedSearches.find((item) => item.id === activeSavedSearchId) ?? null
        : null,
    [activeSavedSearchId, savedSearches],
  );

  const isDirty = useMemo(
    () =>
      isSavedSearchDirty(activeSavedSearch, {
        keywords,
        unifiedFilters,
        marketplaces: enabledMarketplaces,
        sortOrder,
      }),
    [activeSavedSearch, keywords, unifiedFilters, enabledMarketplaces, sortOrder],
  );

  const handleOpenSaveDialog = () => {
    const err = validateSearchDraft({
      keywords,
      marketplaces: enabledMarketplaces,
      unifiedFilters,
    });
    if (err) {
      setSavedSearchError(err);
      return;
    }
    setSavedSearchError(null);
    setSaveDialogOpen(true);
  };

  const handleCreateSavedSearch = async (name: string) => {
    setIsSavingSearch(true);
    setSavedSearchError(null);
    try {
      const response = await fetchImpl('/api/saved-searches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          keywords: keywords.trim(),
          unifiedFilters,
          marketplaces: enabledMarketplaces,
          sortOrder,
        }),
      });
      if (!response.ok) {
        const errJson = (await response.json().catch(() => ({}))) as { error?: string };
        setSavedSearchError(errJson.error ?? `Failed to save search (${response.status}).`);
        return;
      }
      const json = (await response.json()) as { savedSearch: SavedSearch };
      setSavedSearches((prev) => [json.savedSearch, ...prev]);
      setActiveSavedSearchId(json.savedSearch.id);
      setSaveDialogOpen(false);
    } finally {
      setIsSavingSearch(false);
    }
  };

  const handleSelectSavedSearch = (item: SavedSearch) => {
    hasExplicitFilterStateRef.current = true;
    setSavedSearchError(null);
    setActiveSavedSearchId(item.id);
    setKeywords(item.keywords);
    setUnifiedFilters(structuredClone(item.unifiedFilters));
    setEnabledMarketplaces([...item.marketplaces]);
    setSortOrder(item.sortOrder);
    setActiveView('search');

    runSeqRef.current += 1;
    setPendingRunRequest({
      seq: runSeqRef.current,
      keywords: item.keywords,
      unifiedFilters: structuredClone(item.unifiedFilters),
      marketplaces: [...item.marketplaces],
      sortOrder: item.sortOrder,
    });

    void fetchImpl(`/api/saved-searches/${item.id}/run`, { method: 'POST' })
      .then(async (res) => {
        if (!res.ok) {
          return;
        }
        const json = (await res.json()) as { savedSearch: SavedSearch };
        // Update in place without changing sidebar display order
        setSavedSearches((prev) =>
          prev.map((entry) => (entry.id === item.id ? json.savedSearch : entry)),
        );
      })
      .catch(() => {
        // Non-fatal if recording lastRunAt fails offline
      });
  };

  const handleUpdateActiveSavedSearch = async () => {
    if (!activeSavedSearch) {
      return;
    }
    const err = validateSearchDraft({
      keywords,
      marketplaces: enabledMarketplaces,
      unifiedFilters,
    });
    if (err) {
      setSavedSearchError(err);
      return;
    }
    setIsSavingSearch(true);
    setSavedSearchError(null);
    try {
      const response = await fetchImpl(`/api/saved-searches/${activeSavedSearch.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keywords: keywords.trim(),
          unifiedFilters,
          marketplaces: enabledMarketplaces,
          sortOrder,
        }),
      });
      if (!response.ok) {
        const errJson = (await response.json().catch(() => ({}))) as { error?: string };
        setSavedSearchError(errJson.error ?? `Failed to update Saved Search (${response.status}).`);
        return;
      }
      const json = (await response.json()) as { savedSearch: SavedSearch };
      setSavedSearches((prev) =>
        prev.map((entry) => (entry.id === json.savedSearch.id ? json.savedSearch : entry)),
      );
    } finally {
      setIsSavingSearch(false);
    }
  };

  const handleRenameSavedSearch = async (id: string, nextName: string): Promise<boolean> => {
    setSavedSearchError(null);
    const response = await fetchImpl(`/api/saved-searches/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: nextName }),
    });
    if (!response.ok) {
      const errJson = (await response.json().catch(() => ({}))) as { error?: string };
      setSavedSearchError(errJson.error ?? `Failed to rename Saved Search (${response.status}).`);
      return false;
    }
    const json = (await response.json()) as { savedSearch: SavedSearch };
    setSavedSearches((prev) =>
      prev.map((entry) => (entry.id === id ? json.savedSearch : entry)),
    );
    return true;
  };

  const handleConfirmDeleteSavedSearch = async () => {
    if (!deleteTarget) {
      return;
    }
    const targetId = deleteTarget.id;
    setSavedSearchError(null);
    const response = await fetchImpl(`/api/saved-searches/${targetId}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      const errJson = (await response.json().catch(() => ({}))) as { error?: string };
      setSavedSearchError(errJson.error ?? `Failed to delete Saved Search (${response.status}).`);
      setDeleteTarget(null);
      return;
    }
    setSavedSearches((prev) => prev.filter((entry) => entry.id !== targetId));
    if (activeSavedSearchId === targetId) {
      setActiveSavedSearchId(null);
    }
    setDeleteTarget(null);
  };

  return (
    <div className="shell-a">
      <aside className="shell-a-sidebar">
        <div>
          <div className="text-base font-bold tracking-tight text-slate-900">
            Unified Marketplace Search
          </div>
          <div className="text-xs text-slate-500">Local Workbench · 127.0.0.1</div>
        </div>

        <nav className="nav-pills" aria-label="Primary">
          <button
            type="button"
            className="nav-pill-btn"
            aria-current={activeView === 'search' ? 'page' : undefined}
            onClick={() => setActiveView('search')}
          >
            <span>Search</span>
          </button>
          <button
            type="button"
            className="nav-pill-btn"
            aria-current={activeView === 'watchlist' ? 'page' : undefined}
            onClick={() => setActiveView('watchlist')}
          >
            <span>Watchlist</span>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700 tabular">
              {watchlistEntries.length}
            </span>
          </button>
          <button
            type="button"
            className="nav-pill-btn"
            aria-current={activeView === 'settings' ? 'page' : undefined}
            onClick={() => setActiveView('settings')}
          >
            <span>Settings</span>
          </button>
        </nav>

        <SavedSearchesPanel
          savedSearches={savedSearches}
          activeSavedSearchId={activeSavedSearchId}
          isDirty={isDirty}
          isBusy={isSavingSearch}
          errorMessage={savedSearchError}
          onRequestSaveNew={handleOpenSaveDialog}
          onUpdateActive={() => void handleUpdateActiveSavedSearch()}
          onSelect={handleSelectSavedSearch}
          onRename={handleRenameSavedSearch}
          onRequestDelete={setDeleteTarget}
        />

        <UnifiedFiltersPanel
          filters={unifiedFilters}
          availableHubs={availableHubs}
          onChange={(next) => {
            hasExplicitFilterStateRef.current = true;
            setSavedSearchError(null);
            setUnifiedFilters(next);
          }}
          onReset={() => {
            hasExplicitFilterStateRef.current = true;
            setSavedSearchError(null);
            setUnifiedFilters(defaultFilterBaseline);
          }}
        />
      </aside>

      <main className="shell-a-main">
        <div hidden={activeView !== 'search'}>
          <SearchView
            fetchImpl={fetchImpl}
            unifiedFilters={unifiedFilters}
            keywords={keywords}
            onKeywordsChange={(next) => {
              setSavedSearchError(null);
              setKeywords(next);
            }}
            enabledMarketplaces={enabledMarketplaces}
            onEnabledMarketplacesChange={(next) => {
              setSavedSearchError(null);
              setEnabledMarketplaces(next);
            }}
            sortOrder={sortOrder}
            onSortOrderChange={setSortOrder}
            pendingRunRequest={pendingRunRequest}
            watchlistedKeys={watchlistedKeys}
            onToggleWatchlist={handleToggleWatchlist}
          />
        </div>

        {activeView === 'watchlist' && (
          <WatchlistView
            entries={watchlistEntries}
            loading={watchlistLoading}
            onRemove={(entry) =>
              void removeWatchlistEntry(entry.marketplace, entry.marketplaceListingId)
            }
          />
        )}

        {activeView === 'settings' && <SettingsView fetchImpl={fetchImpl} />}
      </main>

      <BackToTopTab />

      <SaveSearchDialog
        open={saveDialogOpen}
        defaultName={suggestSavedSearchName(keywords, unifiedFilters)}
        isSaving={isSavingSearch}
        onSave={(name) => void handleCreateSavedSearch(name)}
        onCancel={() => setSaveDialogOpen(false)}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete Saved Search?"
        description={
          deleteTarget
            ? `Delete "${deleteTarget.name}" from your Saved Searches? This cannot be undone.`
            : ''
        }
        confirmLabel="Delete"
        danger
        onConfirm={() => void handleConfirmDeleteSavedSearch()}
        onCancel={() => setDeleteTarget(null)}
      />

      <UndoToast
        entry={undoEntry}
        onUndo={handleUndoRemove}
        onDismiss={() => setUndoEntry(null)}
      />
    </div>
  );
}
