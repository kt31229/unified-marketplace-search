import { useState } from 'react';
import type { SavedSearch, SortOrder } from '../../shared/index.ts';

function formatSortLabel(sortOrder: SortOrder): string {
  switch (sortOrder) {
    case 'newest':
      return 'Newest';
    case 'price_asc':
      return 'Price ↑';
    case 'price_desc':
      return 'Price ↓';
    case 'relevance':
    default:
      return 'Relevance';
  }
}

export function formatRelativeTimestamp(isoString: string | null, nowMs = Date.now()): string {
  if (!isoString) {
    return 'Never run';
  }
  const timestampMs = Date.parse(isoString);
  if (!Number.isFinite(timestampMs)) {
    return 'Never run';
  }
  const diffSeconds = Math.max(0, Math.floor((nowMs - timestampMs) / 1000));
  if (diffSeconds < 60) {
    return 'Just now';
  }
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) {
    return `${diffDays}d ago`;
  }
  return new Date(timestampMs).toLocaleDateString();
}

export interface SavedSearchesPanelProps {
  savedSearches: readonly SavedSearch[];
  activeSavedSearchId: string | null;
  isDirty: boolean;
  isBusy?: boolean;
  errorMessage: string | null;
  onRequestSaveNew: () => void;
  onUpdateActive: () => void;
  onSelect: (savedSearch: SavedSearch) => void;
  onRename: (id: string, nextName: string) => Promise<boolean> | boolean;
  onRequestDelete: (savedSearch: SavedSearch) => void;
}

export function SavedSearchesPanel({
  savedSearches,
  activeSavedSearchId,
  isDirty,
  isBusy = false,
  errorMessage,
  onRequestSaveNew,
  onUpdateActive,
  onSelect,
  onRename,
  onRequestDelete,
}: SavedSearchesPanelProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);

  const activeSavedSearch =
    activeSavedSearchId != null
      ? savedSearches.find((item) => item.id === activeSavedSearchId) ?? null
      : null;

  const startRename = (item: SavedSearch) => {
    setEditingId(item.id);
    setEditingName(item.name);
    setRenameError(null);
  };

  const cancelRename = () => {
    setEditingId(null);
    setEditingName('');
    setRenameError(null);
  };

  const commitRename = async (id: string) => {
    const trimmed = editingName.trim();
    if (!trimmed) {
      setRenameError('Saved Search name cannot be empty.');
      return;
    }
    const ok = await onRename(id, trimmed);
    if (ok) {
      cancelRename();
    }
  };

  return (
    <section className="sidebar-section" aria-label="Saved Searches">
      <div className="flex items-center justify-between gap-2">
        <h2 className="m-0 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Saved Searches
        </h2>
        <button
          type="button"
          disabled={isBusy}
          onClick={onRequestSaveNew}
          className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 cursor-pointer"
        >
          + Save Search
        </button>
      </div>

      {errorMessage && (
        <div role="alert" className="validation-msg">
          {errorMessage}
        </div>
      )}

      {activeSavedSearch && isDirty && (
        <div className="saved-dirty-banner" role="status" data-testid="saved-search-dirty-banner">
          <span>
            Modified <strong>{activeSavedSearch.name}</strong> — changes are not saved automatically.
          </span>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              disabled={isBusy}
              onClick={onUpdateActive}
              className="rounded border border-amber-700 bg-amber-700 px-2 py-1 text-xs font-medium text-white hover:bg-amber-800 disabled:opacity-50 cursor-pointer"
            >
              Update Saved Search
            </button>
            <button
              type="button"
              disabled={isBusy}
              onClick={onRequestSaveNew}
              className="rounded border border-amber-400 bg-white px-2 py-1 text-xs font-medium text-amber-900 hover:bg-amber-50 disabled:opacity-50 cursor-pointer"
            >
              Save as New
            </button>
          </div>
        </div>
      )}

      {savedSearches.length === 0 ? (
        <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-3 text-xs text-slate-500">
          No Saved Searches yet. Configure keywords and Unified Filters, then click &ldquo;+ Save
          Search&rdquo;.
        </div>
      ) : (
        <div className="saved-list" data-testid="saved-searches-list">
          {savedSearches.map((item) => {
            const isActive = item.id === activeSavedSearchId;
            const isEditing = item.id === editingId;
            const mpCount = item.marketplaces.length;

            return (
              <div
                key={item.id}
                data-testid={`saved-search-item-${item.id}`}
                className={isActive ? 'saved-item saved-item-active' : 'saved-item'}
              >
                <div className="saved-item-top">
                  {isEditing ? (
                    <form
                      className="flex flex-1 flex-col gap-1"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void commitRename(item.id);
                      }}
                    >
                      <div className="flex items-center gap-1">
                        <input
                          type="text"
                          aria-label={`Edit name for ${item.name}`}
                          value={editingName}
                          onChange={(e) => {
                            setEditingName(e.target.value);
                            setRenameError(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') {
                              e.preventDefault();
                              cancelRename();
                            }
                          }}
                          autoFocus
                          className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-900"
                        />
                        <button
                          type="submit"
                          aria-label="Confirm rename"
                          className="rounded border border-blue-600 bg-blue-600 px-1.5 py-0.5 text-[11px] font-medium text-white hover:bg-blue-700 cursor-pointer"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          aria-label="Cancel rename"
                          onClick={cancelRename}
                          className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[11px] font-medium text-slate-600 hover:bg-slate-50 cursor-pointer"
                        >
                          Cancel
                        </button>
                      </div>
                      {renameError && (
                        <span role="alert" className="text-[11px] text-red-700">
                          {renameError}
                        </span>
                      )}
                    </form>
                  ) : (
                    <>
                      <div className="saved-name-group">
                        <button
                          type="button"
                          className="saved-name-btn"
                          onClick={() => onSelect(item)}
                          title={`${item.name} — ${item.keywords}`}
                        >
                          <span data-saved-search-name="">{item.name}</span>
                        </button>
                        <button
                          type="button"
                          className="saved-icon-btn"
                          aria-label={`Rename ${item.name}`}
                          title={`Rename ${item.name}`}
                          onClick={() => startRename(item)}
                        >
                          ✎
                        </button>
                      </div>
                      <button
                        type="button"
                        className="saved-icon-delete"
                        aria-label={`Delete ${item.name}`}
                        title={`Delete ${item.name}`}
                        onClick={() => onRequestDelete(item)}
                      >
                        ×
                      </button>
                    </>
                  )}
                </div>

                <div className="saved-meta-line">
                  <span>
                    {mpCount} {mpCount === 1 ? 'Marketplace' : 'Marketplaces'} ·{' '}
                    {formatSortLabel(item.sortOrder)}
                  </span>
                  <span className="tabular">{formatRelativeTimestamp(item.lastRunAt)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
