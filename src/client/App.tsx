import { useEffect, useState } from 'react';
import {
  DEFAULT_FACEBOOK_CITY_HUBS,
  createDefaultUnifiedFilter,
  type FacebookCityHub,
  type SettingsResponse,
  type UnifiedFilter,
} from '../shared/index.ts';
import { SearchView } from './components/SearchView.tsx';
import { SettingsView, type FetchLike } from './components/SettingsView.tsx';
import { UnifiedFiltersPanel } from './components/UnifiedFiltersPanel.tsx';

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

    return () => {
      active = false;
    };
  }, [fetchImpl]);

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
        {activeView === 'search' && (
          <SearchView fetchImpl={fetchImpl} unifiedFilters={unifiedFilters} />
        )}

        {activeView === 'watchlist' && (
          <section className="panel-box flex flex-col gap-2">
            <h1 className="m-0 text-lg font-semibold text-slate-900">Watchlist</h1>
            <p className="m-0 text-sm text-slate-600">
              Your flat PII-free Watchlist Entries with local thumbnail caching will appear here
              (coming in Ticket #20).
            </p>
          </section>
        )}

        {activeView === 'settings' && <SettingsView fetchImpl={fetchImpl} />}
      </main>
    </div>
  );
}
