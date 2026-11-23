import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_FACEBOOK_CITY_HUBS,
  createDefaultUnifiedFilter,
  type FacebookCityHub,
  type Listing,
  type MarketplaceId,
  type SettingsResponse,
  type UnifiedFilter,
  type WatchlistEntry,
  type WatchlistSnapshotInput,
} from '../shared/index.ts';
import { SearchView } from './components/SearchView.tsx';
import { SettingsView, type FetchLike } from './components/SettingsView.tsx';
import { UndoToast } from './components/UndoToast.tsx';
import { UnifiedFiltersPanel } from './components/UnifiedFiltersPanel.tsx';
import { WatchlistView } from './components/WatchlistView.tsx';

export type WorkbenchView = 'search' | 'watchlist' | 'settings';

export interface AppProps {
  fetchImpl?: FetchLike;
  initialView?: WorkbenchView;
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

        <section className="sidebar-section" aria-label="Saved Searches">
          <div className="flex items-center justify-between">
            <h2 className="m-0 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Saved Searches
            </h2>
          </div>
          <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-3 text-xs text-slate-500">
            Saved Searches will appear here once search persistence is wired (#19).
          </div>
        </section>

        <UnifiedFiltersPanel
          filters={unifiedFilters}
          availableHubs={availableHubs}
          onChange={setUnifiedFilters}
          onReset={() => setUnifiedFilters(defaultFilterBaseline)}
        />
      </aside>

      <main className="shell-a-main">
        <div hidden={activeView !== 'search'}>
          <SearchView
            fetchImpl={fetchImpl}
            unifiedFilters={unifiedFilters}
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

      <UndoToast
        entry={undoEntry}
        onUndo={handleUndoRemove}
        onDismiss={() => setUndoEntry(null)}
      />
    </div>
  );
}
