import {
  type ConditionTier,
  type FacebookCityHub,
  type FulfillmentMode,
  type UnifiedFilter,
} from '../../shared/index.ts';

const CONDITION_OPTIONS: ReadonlyArray<{ value: ConditionTier; label: string }> = [
  { value: 'new', label: 'New' },
  { value: 'like_new', label: 'Like New' },
  { value: 'good', label: 'Good' },
  { value: 'fair', label: 'Fair' },
  { value: 'poor', label: 'Poor' },
];

const FULFILLMENT_OPTIONS: ReadonlyArray<{ value: FulfillmentMode; label: string }> = [
  { value: 'any', label: 'Any' },
  { value: 'shipping', label: 'Shipping' },
  { value: 'local_pickup', label: 'Local Pickup' },
];

const RADIUS_OPTIONS = [10, 25, 50, 100] as const;

export interface UnifiedFiltersPanelProps {
  filters: UnifiedFilter;
  availableHubs: readonly FacebookCityHub[];
  onChange: (next: UnifiedFilter) => void;
  onReset: () => void;
}

export function UnifiedFiltersPanel({
  filters,
  availableHubs,
  onChange,
  onReset,
}: UnifiedFiltersPanelProps) {
  const parsePriceInput = (raw: string): number | null => {
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const toggleCondition = (tier: ConditionTier, checked: boolean) => {
    const next = checked
      ? Array.from(new Set([...filters.conditions, tier]))
      : filters.conditions.filter((c) => c !== tier);
    onChange({ ...filters, conditions: next });
  };

  const toggleHub = (slug: string) => {
    const exists = filters.facebookLocationSlugs.includes(slug);
    const next = exists
      ? filters.facebookLocationSlugs.filter((s) => s !== slug)
      : [...filters.facebookLocationSlugs, slug];
    onChange({ ...filters, facebookLocationSlugs: next });
  };

  return (
    <section className="sidebar-section" aria-label="Unified Filters">
      <div className="flex items-center justify-between">
        <h2 className="m-0 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Unified Filters
        </h2>
        <button
          type="button"
          onClick={onReset}
          className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs font-medium text-slate-600 hover:bg-slate-50 cursor-pointer"
        >
          Reset
        </button>
      </div>

      {/* USD Base Price */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold text-slate-700">USD Base Price</span>
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1 text-xs text-slate-600">
            <span>Min price ($)</span>
            <input
              type="number"
              min={0}
              step="any"
              placeholder="Min"
              value={filters.priceMin ?? ''}
              onChange={(e) => onChange({ ...filters, priceMin: parsePriceInput(e.target.value) })}
              className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-xs tabular"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-600">
            <span>Max price ($)</span>
            <input
              type="number"
              min={0}
              step="any"
              placeholder="Max"
              value={filters.priceMax ?? ''}
              onChange={(e) => onChange({ ...filters, priceMax: parsePriceInput(e.target.value) })}
              className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-xs tabular"
            />
          </label>
        </div>
      </div>

      {/* 5-tier multi-select Condition */}
      <fieldset className="m-0 border-0 p-0">
        <legend className="mb-1.5 text-xs font-semibold text-slate-700">Condition</legend>
        <div className="flex flex-col gap-1">
          {CONDITION_OPTIONS.map((opt) => (
            <label key={opt.value} className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={filters.conditions.includes(opt.value)}
                onChange={(e) => toggleCondition(opt.value, e.target.checked)}
              />
              <span>{opt.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {/* Fulfillment */}
      <fieldset className="m-0 border-0 p-0">
        <legend className="mb-1.5 text-xs font-semibold text-slate-700">Fulfillment</legend>
        <div className="flex flex-col gap-1">
          {FULFILLMENT_OPTIONS.map((opt) => (
            <label key={opt.value} className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
              <input
                type="radio"
                name="fulfillment-mode"
                value={opt.value}
                checked={filters.fulfillment === opt.value}
                onChange={() => onChange({ ...filters, fulfillment: opt.value })}
              />
              <span>{opt.label}</span>
            </label>
          ))}
        </div>

        {filters.fulfillment === 'local_pickup' && (
          <div className="mt-2 grid grid-cols-2 gap-2 rounded-md border border-slate-200 bg-slate-50 p-2">
            <label className="flex flex-col gap-1 text-xs text-slate-600">
              <span>Pickup ZIP</span>
              <input
                type="text"
                placeholder="e.g. 98101"
                value={filters.localPickupPostalCode ?? ''}
                onChange={(e) =>
                  onChange({
                    ...filters,
                    localPickupPostalCode: e.target.value.trim() || null,
                  })
                }
                className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-600">
              <span>Radius</span>
              <select
                value={filters.localPickupRadiusMiles ?? 50}
                onChange={(e) =>
                  onChange({ ...filters, localPickupRadiusMiles: Number(e.target.value) })
                }
                className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs"
              >
                {RADIUS_OPTIONS.map((miles) => (
                  <option key={miles} value={miles}>
                    {miles} mi
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </fieldset>

      {/* Facebook City Hubs */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-slate-700">Facebook City Hubs</span>
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600 tabular">
            {filters.facebookRadiusMiles} mi
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {availableHubs.map((hub) => {
            const active = filters.facebookLocationSlugs.includes(hub.slug);
            return (
              <button
                key={hub.slug}
                type="button"
                aria-pressed={active}
                onClick={() => toggleHub(hub.slug)}
                className="toggle-pill"
              >
                {hub.label}
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
