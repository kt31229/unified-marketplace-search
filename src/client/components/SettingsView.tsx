import { useEffect, useState } from 'react';
import {
  BROWSER_MARKETPLACE_IDS,
  MARKETPLACE_IDS,
  MARKETPLACE_LABELS,
  createDefaultFacebookCityHubs,
  createDefaultMarketplaceRetrySettings,
  type BrowserChannel,
  type BrowserMarketplaceId,
  type FacebookCityHub,
  type MarketplaceId,
  type MarketplaceRetrySettings,
  type SettingsResponse,
} from '../../shared/index.ts';
import { ConfirmDialog } from './ConfirmDialog.tsx';

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface SettingsViewProps {
  fetchImpl: FetchLike;
}

export function SettingsView({ fetchImpl }: SettingsViewProps) {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [serverStopped, setServerStopped] = useState(false);

  // eBay Credentials state
  const [ebayClientId, setEbayClientId] = useState('');
  const [ebayClientSecret, setEbayClientSecret] = useState('');
  const [replacingSecret, setReplacingSecret] = useState(false);
  const [verifyMessage, setVerifyMessage] = useState<string | null>(null);

  // Browser & Location Defaults state
  const [browserChannel, setBrowserChannel] = useState<BrowserChannel>('chrome');
  const [homePostalCode, setHomePostalCode] = useState('');
  const [defaultRadiusMiles, setDefaultRadiusMiles] = useState(50);
  const [homeFacebookCitySlug, setHomeFacebookCitySlug] = useState('');

  // Facebook City Hubs state
  const [hubs, setHubs] = useState<FacebookCityHub[]>([]);
  const [newHubSlug, setNewHubSlug] = useState('');
  const [newHubLabel, setNewHubLabel] = useState('');

  // Automatic Retries state
  const [retrySettings, setRetrySettings] = useState<MarketplaceRetrySettings>(
    createDefaultMarketplaceRetrySettings,
  );

  // Profile Reset <dialog> state
  const [resetTarget, setResetTarget] = useState<BrowserMarketplaceId | null>(null);
  const [openingProfile, setOpeningProfile] = useState<BrowserMarketplaceId | null>(null);

  const syncFromResponse = (res: SettingsResponse) => {
    setData(res);
    setEbayClientId(res.ebay.clientId ?? '');
    setEbayClientSecret('');
    setReplacingSecret(!res.ebay.configured);
    setBrowserChannel(res.settings.browserChannel);
    setHomePostalCode(res.settings.homePostalCode ?? '');
    setDefaultRadiusMiles(res.settings.defaultLocalPickupRadiusMiles);
    setHomeFacebookCitySlug(res.settings.homeFacebookCitySlug ?? '');
    setHubs(res.settings.facebookCityHubs.map((h) => ({ ...h })));
    setRetrySettings(res.settings.retrySettings ?? createDefaultMarketplaceRetrySettings());
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetchImpl('/api/settings')
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`Failed to load settings (${res.status})`);
        }
        return (await res.json()) as SettingsResponse;
      })
      .then((json) => {
        if (active) {
          syncFromResponse(json);
          setErrorMessage(null);
        }
      })
      .catch((err: unknown) => {
        if (active) {
          setErrorMessage(err instanceof Error ? err.message : 'Failed to load settings');
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [fetchImpl]);

  const handleSaveDefaults = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatusMessage(null);
    setErrorMessage(null);

    const parsedRadius = Number(defaultRadiusMiles);
    if (!Number.isInteger(parsedRadius) || parsedRadius <= 0) {
      setErrorMessage('Default pickup radius must be a positive whole number.');
      return;
    }

    const res = await fetchImpl('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        settings: {
          browserChannel,
          homePostalCode: homePostalCode.trim() || null,
          defaultLocalPickupRadiusMiles: parsedRadius,
          homeFacebookCitySlug: homeFacebookCitySlug.trim() || null,
        },
      }),
    });

    if (!res.ok) {
      const errJson = (await res.json().catch(() => ({}))) as { error?: string };
      setErrorMessage(errJson.error ?? 'Failed to save browser and location defaults.');
      return;
    }

    const updated = (await res.json()) as SettingsResponse;
    syncFromResponse(updated);
    setStatusMessage('Saved browser and location defaults.');
  };

  const handleSaveEbay = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatusMessage(null);
    setErrorMessage(null);
    setVerifyMessage(null);

    const payload: { clientId: string | null; clientSecret?: string } = {
      clientId: ebayClientId.trim() || null,
    };
    if (replacingSecret && ebayClientSecret.trim()) {
      payload.clientSecret = ebayClientSecret.trim();
    }

    const res = await fetchImpl('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ebay: payload }),
    });

    if (!res.ok) {
      const errJson = (await res.json().catch(() => ({}))) as { error?: string };
      setErrorMessage(errJson.error ?? 'Failed to update eBay credentials.');
      return;
    }

    const updated = (await res.json()) as SettingsResponse;
    syncFromResponse(updated);
    setStatusMessage('Saved eBay credentials to secrets.json.');
  };

  const handleVerifyEbay = async () => {
    setVerifyMessage(null);
    const res = await fetchImpl('/api/settings/ebay/verify', { method: 'POST' });
    const json = (await res.json().catch(() => ({}))) as {
      valid?: boolean;
      error?: string;
    };
    if (res.ok && json.valid) {
      setVerifyMessage('eBay credentials verified.');
    } else {
      setVerifyMessage(json.error ?? `Verification failed (${res.status}).`);
    }
  };

  const handleSaveHubs = async () => {
    setStatusMessage(null);
    setErrorMessage(null);

    const sanitized = hubs
      .map((h) => ({
        slug: h.slug.trim(),
        label: h.label.trim(),
        enabled: h.enabled,
      }))
      .filter((h) => h.slug.length > 0 && h.label.length > 0);

    const res = await fetchImpl('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        settings: {
          facebookCityHubs: sanitized,
        },
      }),
    });

    if (!res.ok) {
      const errJson = (await res.json().catch(() => ({}))) as { error?: string };
      setErrorMessage(errJson.error ?? 'Failed to save Facebook City Hubs.');
      return;
    }

    const updated = (await res.json()) as SettingsResponse;
    syncFromResponse(updated);
    setStatusMessage('Saved Facebook City Hubs.');
  };

  const updateRetryField = <K extends 'enabled' | 'maxRetries' | 'delaySeconds'>(
    mp: MarketplaceId,
    field: K,
    value: MarketplaceRetrySettings[MarketplaceId][K],
  ) => {
    setRetrySettings((prev) => ({
      ...prev,
      [mp]: {
        ...prev[mp],
        [field]: value,
      },
    }));
  };

  const handleSaveRetrySettings = async () => {
    setStatusMessage(null);
    setErrorMessage(null);

    for (const mp of MARKETPLACE_IDS) {
      const cfg = retrySettings[mp];
      if (!Number.isInteger(cfg.maxRetries) || cfg.maxRetries < 1 || cfg.maxRetries > 5) {
        setErrorMessage(`${MARKETPLACE_LABELS[mp]} retry count must be a whole number from 1 to 5.`);
        return;
      }
      if (!Number.isFinite(cfg.delaySeconds) || cfg.delaySeconds < 0 || cfg.delaySeconds > 60) {
        setErrorMessage(`${MARKETPLACE_LABELS[mp]} wait time must be between 0 and 60 seconds.`);
        return;
      }
    }

    const res = await fetchImpl('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        settings: {
          retrySettings,
        },
      }),
    });

    if (!res.ok) {
      const errJson = (await res.json().catch(() => ({}))) as { error?: string };
      setErrorMessage(errJson.error ?? 'Failed to save automatic retry settings.');
      return;
    }

    const updated = (await res.json()) as SettingsResponse;
    syncFromResponse(updated);
    setStatusMessage('Saved automatic retry settings.');
  };

  const handleAddHub = () => {
    const slug = newHubSlug.trim().toLowerCase();
    const label = newHubLabel.trim();
    if (!slug || !label) {
      return;
    }
    if (hubs.some((h) => h.slug === slug)) {
      setErrorMessage(`Hub slug "${slug}" already exists.`);
      return;
    }
    setErrorMessage(null);
    setHubs((prev) => [...prev, { slug, label, enabled: true }]);
    setNewHubSlug('');
    setNewHubLabel('');
  };

  const handleOpenSession = async (marketplace: BrowserMarketplaceId) => {
    setStatusMessage(null);
    setErrorMessage(null);
    setOpeningProfile(marketplace);
    try {
      const res = await fetchImpl(`/api/browser/${marketplace}/open-session`, {
        method: 'POST',
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        setErrorMessage(json.error ?? `Could not open ${MARKETPLACE_LABELS[marketplace]} session.`);
        return;
      }
      setData((prev) =>
        prev
          ? {
              ...prev,
              browserProfiles: {
                ...prev.browserProfiles,
                [marketplace]: { exists: true, activeContext: true },
              },
            }
          : prev,
      );
      setStatusMessage(`Opened ${MARKETPLACE_LABELS[marketplace]} browser session.`);
    } finally {
      setOpeningProfile(null);
    }
  };

  const handleConfirmResetProfile = async () => {
    if (!resetTarget) {
      return;
    }
    const target = resetTarget;
    setResetTarget(null);
    setStatusMessage(null);
    setErrorMessage(null);

    const res = await fetchImpl(`/api/browser/${target}/reset-profile`, {
      method: 'POST',
    });
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      setErrorMessage(json.error ?? `Failed to reset ${MARKETPLACE_LABELS[target]} profile.`);
      return;
    }
    const updated = (await res.json()) as SettingsResponse;
    syncFromResponse(updated);
    setStatusMessage(`Reset ${MARKETPLACE_LABELS[target]} browser profile.`);
  };

  const handleStopServer = async () => {
    setStatusMessage(null);
    setErrorMessage(null);
    const res = await fetchImpl('/api/system/shutdown', { method: 'POST' });
    if (res.ok) {
      setServerStopped(true);
      setStatusMessage('Server stopped cleanly.');
    } else {
      setErrorMessage('Failed to stop server.');
    }
  };

  if (loading) {
    return (
      <div className="panel-box text-sm text-slate-600">
        Loading local settings...
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="panel-box flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="m-0 text-lg font-semibold text-slate-900">Settings</h1>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-slate-600">
            <span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-slate-700">
              127.0.0.1
            </span>
            <span>
              Data directory:{' '}
              <code className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-800">
                {data?.dataDir ?? '—'}
              </code>
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {serverStopped ? (
            <span className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800">
              Server stopped
            </span>
          ) : (
            <button
              type="button"
              onClick={handleStopServer}
              className="rounded-md border border-red-300 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-100 cursor-pointer"
            >
              Stop server
            </button>
          )}
        </div>
      </header>

      {statusMessage && (
        <div
          role="status"
          className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800"
        >
          {statusMessage}
        </div>
      )}

      {errorMessage && (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {errorMessage}
        </div>
      )}

      <div className="settings-grid">
        {/* eBay API Credentials */}
        <section className="panel-box flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="m-0 text-base font-semibold text-slate-900">eBay API Credentials</h2>
            <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700">
              {data?.ebay.origin === 'env'
                ? 'Env override'
                : data?.ebay.origin === 'file'
                  ? 'secrets.json'
                  : 'Not configured'}
            </span>
          </div>

          <form onSubmit={handleSaveEbay} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-slate-700">eBay Client ID</span>
              <input
                type="text"
                value={ebayClientId}
                onChange={(e) => setEbayClientId(e.target.value)}
                disabled={data?.ebay.origin === 'env'}
                placeholder="YourApp-PRD-..."
                className="rounded-md border border-slate-300 px-2.5 py-1.5 text-sm disabled:bg-slate-100"
              />
            </label>

            <div className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-slate-700">eBay Client Secret</span>
              {data?.ebay.clientSecretMasked && !replacingSecret ? (
                <div className="flex items-center justify-between gap-2 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5">
                  <span className="font-mono text-sm text-slate-700">
                    {data.ebay.clientSecretMasked}
                  </span>
                  {data.ebay.origin !== 'env' && (
                    <button
                      type="button"
                      onClick={() => setReplacingSecret(true)}
                      className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs font-medium text-slate-700 hover:bg-slate-100 cursor-pointer"
                    >
                      Replace secret
                    </button>
                  )}
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="ebay-client-secret-input" className="sr-only">
                    eBay Client Secret
                  </label>
                  <input
                    id="ebay-client-secret-input"
                    aria-label="eBay Client Secret"
                    type="password"
                    value={ebayClientSecret}
                    onChange={(e) => setEbayClientSecret(e.target.value)}
                    disabled={data?.ebay.origin === 'env'}
                    placeholder="Enter new eBay client_secret"
                    className="rounded-md border border-slate-300 px-2.5 py-1.5 text-sm disabled:bg-slate-100"
                  />
                  {data?.ebay.configured && data.ebay.origin !== 'env' && (
                    <button
                      type="button"
                      onClick={() => {
                        setReplacingSecret(false);
                        setEbayClientSecret('');
                      }}
                      className="self-start text-xs text-slate-600 underline cursor-pointer"
                    >
                      Keep existing secret
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="submit"
                disabled={data?.ebay.origin === 'env'}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 cursor-pointer"
              >
                Save eBay credentials
              </button>
              <button
                type="button"
                onClick={handleVerifyEbay}
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
              >
                Verify credentials
              </button>
            </div>
            {verifyMessage && <p className="m-0 text-xs text-slate-600">{verifyMessage}</p>}
          </form>
        </section>

        {/* Browser & Location Defaults */}
        <section className="panel-box flex flex-col gap-3">
          <h2 className="m-0 text-base font-semibold text-slate-900">
            Browser &amp; Location Defaults
          </h2>
          <form onSubmit={handleSaveDefaults} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-slate-700">Browser channel</span>
              <select
                value={browserChannel}
                onChange={(e) => setBrowserChannel(e.target.value as BrowserChannel)}
                className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm"
              >
                <option value="chrome">Google Chrome (chrome)</option>
                <option value="msedge">Microsoft Edge (msedge)</option>
              </select>
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-slate-700">Home ZIP / Postal Code</span>
                <input
                  type="text"
                  value={homePostalCode}
                  onChange={(e) => setHomePostalCode(e.target.value)}
                  placeholder="e.g. 98101"
                  className="rounded-md border border-slate-300 px-2.5 py-1.5 text-sm"
                />
              </label>

              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-slate-700">Default Local Pickup Radius (mi)</span>
                <input
                  type="number"
                  min={1}
                  max={500}
                  value={defaultRadiusMiles}
                  onChange={(e) => setDefaultRadiusMiles(Number(e.target.value))}
                  className="rounded-md border border-slate-300 px-2.5 py-1.5 text-sm tabular"
                />
              </label>
            </div>

            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-slate-700">
                Home Facebook City Slug (optional)
              </span>
              <input
                type="text"
                value={homeFacebookCitySlug}
                onChange={(e) => setHomeFacebookCitySlug(e.target.value)}
                placeholder="e.g. seattle"
                className="rounded-md border border-slate-300 px-2.5 py-1.5 text-sm"
              />
            </label>

            <div className="pt-1">
              <button
                type="submit"
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 cursor-pointer"
              >
                Save defaults
              </button>
            </div>
          </form>
        </section>
      </div>

      {/* Facebook City Hubs */}
      <section className="panel-box flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="m-0 text-base font-semibold text-slate-900">Facebook City Hubs</h2>
            <p className="m-0 text-xs text-slate-600">
              500-mile nationwide sweep hubs ({hubs.filter((h) => h.enabled).length} of{' '}
              {hubs.length} enabled).
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setHubs(createDefaultFacebookCityHubs())}
              className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
            >
              Reset 8-city preset
            </button>
            <button
              type="button"
              onClick={handleSaveHubs}
              className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 cursor-pointer"
            >
              Save hubs
            </button>
          </div>
        </div>

        <div className="grid gap-2 md:grid-cols-2">
          {hubs.map((hub, idx) => (
            <div
              key={`${hub.slug}-${idx}`}
              className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 p-2"
            >
              <input
                type="checkbox"
                checked={hub.enabled}
                aria-label={`Enable ${hub.label}`}
                onChange={(e) => {
                  const checked = e.target.checked;
                  setHubs((prev) =>
                    prev.map((item, i) => (i === idx ? { ...item, enabled: checked } : item)),
                  );
                }}
              />
              <input
                type="text"
                aria-label={`Hub label for ${hub.slug}`}
                value={hub.label}
                onChange={(e) => {
                  const val = e.target.value;
                  setHubs((prev) =>
                    prev.map((item, i) => (i === idx ? { ...item, label: val } : item)),
                  );
                }}
                className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs"
              />
              <input
                type="text"
                aria-label={`Hub slug for ${hub.label}`}
                value={hub.slug}
                onChange={(e) => {
                  const val = e.target.value;
                  setHubs((prev) =>
                    prev.map((item, i) => (i === idx ? { ...item, slug: val } : item)),
                  );
                }}
                className="w-28 rounded border border-slate-300 bg-white px-2 py-1 font-mono text-xs"
              />
              <button
                type="button"
                aria-label={`Remove ${hub.label}`}
                onClick={() => setHubs((prev) => prev.filter((_, i) => i !== idx))}
                className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-600 hover:bg-red-50 hover:text-red-700 cursor-pointer"
              >
                ×
              </button>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-2">
          <input
            type="text"
            placeholder="City slug (e.g. boston)"
            aria-label="New hub slug"
            value={newHubSlug}
            onChange={(e) => setNewHubSlug(e.target.value)}
            className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-mono"
          />
          <input
            type="text"
            placeholder="Display label (e.g. Boston, MA)"
            aria-label="New hub label"
            value={newHubLabel}
            onChange={(e) => setNewHubLabel(e.target.value)}
            className="rounded-md border border-slate-300 px-2.5 py-1 text-xs"
          />
          <button
            type="button"
            onClick={handleAddHub}
            className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
          >
            Add hub
          </button>
        </div>
      </section>

      {/* Automatic Retries */}
      <section className="panel-box flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="m-0 text-base font-semibold text-slate-900">Automatic Retries</h2>
            <p className="m-0 text-xs text-slate-600">
              Retry failed initial searches, Load more requests, and queries to each Facebook City Hub
              after a fixed wait before surfacing an error.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setRetrySettings(createDefaultMarketplaceRetrySettings())}
              className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
            >
              Reset defaults
            </button>
            <button
              type="button"
              onClick={handleSaveRetrySettings}
              className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 cursor-pointer"
            >
              Save retry settings
            </button>
          </div>
        </div>

        <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-4">
          {MARKETPLACE_IDS.map((mp) => {
            const cfg = retrySettings[mp];
            const label = MARKETPLACE_LABELS[mp];
            return (
              <div
                key={mp}
                data-testid={`retry-card-${mp}`}
                className="flex flex-col gap-2 rounded-md border border-slate-200 bg-slate-50 p-3"
              >
                <label className="flex items-center justify-between gap-2 text-sm font-medium text-slate-900 cursor-pointer">
                  <span>{label}</span>
                  <input
                    type="checkbox"
                    checked={cfg.enabled}
                    aria-label={`Enable automatic retries for ${label}`}
                    onChange={(e) => updateRetryField(mp, 'enabled', e.target.checked)}
                  />
                </label>

                <div className="grid grid-cols-2 gap-2">
                  <label className="flex min-w-0 flex-col gap-1 text-xs text-slate-700">
                    <span>Retries (1–5)</span>
                    <input
                      type="number"
                      min={1}
                      max={5}
                      step={1}
                      disabled={!cfg.enabled}
                      aria-label={`${label} retry count`}
                      value={cfg.maxRetries}
                      onChange={(e) => updateRetryField(mp, 'maxRetries', Number(e.target.value))}
                      className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs tabular disabled:bg-slate-100 disabled:text-slate-400"
                    />
                  </label>

                  <label className="flex min-w-0 flex-col gap-1 text-xs text-slate-700">
                    <span>Wait (sec)</span>
                    <input
                      type="number"
                      min={0}
                      max={60}
                      step="any"
                      disabled={!cfg.enabled}
                      aria-label={`${label} retry wait seconds`}
                      value={cfg.delaySeconds}
                      onChange={(e) => updateRetryField(mp, 'delaySeconds', Number(e.target.value))}
                      className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs tabular disabled:bg-slate-100 disabled:text-slate-400"
                    />
                  </label>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Browser Sessions & Profiles */}
      <section className="panel-box flex flex-col gap-3">
        <div>
          <h2 className="m-0 text-base font-semibold text-slate-900">
            Browser Sessions &amp; Profiles
          </h2>
          <p className="m-0 text-xs text-slate-600">
            Isolated local profiles under <code>profiles/</code>. Browser contexts launch lazily
            only when queried or opened here.
          </p>
        </div>

        <div className="grid gap-2 md:grid-cols-3">
          {BROWSER_MARKETPLACE_IDS.map((mp) => {
            const profile = data?.browserProfiles[mp];
            return (
              <div
                key={mp}
                data-testid={`profile-row-${mp}`}
                className="flex flex-col justify-between gap-2 rounded-md border border-slate-200 bg-slate-50 p-3"
              >
                <div>
                  <div className="font-medium text-slate-900">{MARKETPLACE_LABELS[mp]}</div>
                  <div className="text-xs text-slate-600">
                    {profile?.activeContext
                      ? 'Active browser session'
                      : profile?.exists
                        ? 'Profile directory present'
                        : 'Not initialized yet'}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={openingProfile === mp}
                    onClick={() => handleOpenSession(mp)}
                    className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50 cursor-pointer"
                  >
                    Open browser session
                  </button>
                  <button
                    type="button"
                    onClick={() => setResetTarget(mp)}
                    className="rounded-md border border-red-200 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50 cursor-pointer"
                  >
                    Reset profile
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <ConfirmDialog
        open={resetTarget !== null}
        title={
          resetTarget
            ? `Reset ${MARKETPLACE_LABELS[resetTarget]} browser profile?`
            : 'Reset browser profile?'
        }
        description="This closes any active browser context for this Marketplace and deletes its local profile directory, cookies, and sign-in state."
        confirmLabel="Confirm reset"
        danger
        onConfirm={handleConfirmResetProfile}
        onCancel={() => setResetTarget(null)}
      />
    </div>
  );
}
