import { useState } from 'react';
import { SettingsView, type FetchLike } from './components/SettingsView.tsx';

export type WorkbenchView = 'search' | 'watchlist' | 'settings';

export interface AppProps {
  fetchImpl?: FetchLike;
  initialView?: WorkbenchView;
}

export function App({ fetchImpl = fetch, initialView = 'search' }: AppProps) {
  const [activeView, setActiveView] = useState<WorkbenchView>(initialView);

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
            Saved Searches will appear here once search execution is wired (#19).
          </div>
        </section>

        <section className="sidebar-section" aria-label="Unified Filters">
          <div className="flex items-center justify-between">
            <h2 className="m-0 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Unified Filters
            </h2>
          </div>
          <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-3 text-xs text-slate-500">
            Price, 5-tier Condition, Fulfillment, and Facebook City Hubs filters (#17).
          </div>
        </section>
      </aside>

      <main className="shell-a-main">
        {activeView === 'search' && (
          <section className="panel-box flex flex-col gap-2">
            <h1 className="m-0 text-lg font-semibold text-slate-900">Search Workbench</h1>
            <p className="m-0 text-sm text-slate-600">
              Enter keywords, toggle target Marketplaces, and stream Listings across eBay,
              Poshmark, Mercari US, and Facebook Marketplace (coming in Ticket #17).
            </p>
          </section>
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
