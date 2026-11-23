// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/client/App.tsx';
import {
  createDefaultAppSettings,
  type SettingsResponse,
} from '../../src/shared/index.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function createMockSettingsResponse(
  overrides: Partial<SettingsResponse> = {},
): SettingsResponse {
  return {
    settings: createDefaultAppSettings(),
    ebay: {
      configured: true,
      origin: 'file',
      clientId: 'ebay-client-1',
      clientSecretMasked: '••••••••a9f2',
    },
    dataDir: 'C:\\Users\\test\\AppData\\Local\\unified-marketplace-search',
    browserProfiles: {
      facebook: { exists: true, activeContext: false },
      poshmark: { exists: false, activeContext: false },
      mercari: { exists: false, activeContext: false },
    },
    ...overrides,
  };
}

function createFetchMock(initial: SettingsResponse) {
  let state = structuredClone(initial);
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });

    if (url === '/api/settings' && method === 'GET') {
      return new Response(JSON.stringify(state), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url === '/api/settings' && method === 'PUT') {
      if (body?.settings) {
        state = {
          ...state,
          settings: {
            ...state.settings,
            ...body.settings,
          },
        };
      }
      if (body?.ebay) {
        const nextId = body.ebay.clientId ?? body.ebay.client_id ?? state.ebay.clientId;
        const nextSecret = body.ebay.clientSecret ?? body.ebay.client_secret;
        state = {
          ...state,
          ebay: {
            configured: Boolean(nextId && (nextSecret || state.ebay.clientSecretMasked)),
            origin: 'file',
            clientId: nextId,
            clientSecretMasked: nextSecret
              ? `••••••••${String(nextSecret).slice(-4)}`
              : state.ebay.clientSecretMasked,
          },
        };
      }
      return new Response(JSON.stringify(state), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url === '/api/settings/ebay/verify' && method === 'POST') {
      return new Response(JSON.stringify({ valid: true, origin: state.ebay.origin }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url === '/api/browser/poshmark/open-session' && method === 'POST') {
      state = {
        ...state,
        browserProfiles: {
          ...state.browserProfiles,
          poshmark: { exists: true, activeContext: true },
        },
      };
      return new Response(JSON.stringify({ ok: true, marketplace: 'poshmark' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url === '/api/browser/facebook/reset-profile' && method === 'POST') {
      state = {
        ...state,
        browserProfiles: {
          ...state.browserProfiles,
          facebook: { exists: false, activeContext: false },
        },
      };
      return new Response(JSON.stringify({ reset: true, marketplace: 'facebook', ...state }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url === '/api/system/shutdown' && method === 'POST') {
      return new Response(JSON.stringify({ ok: true, shuttingDown: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
  });

  return { fetchMock, calls };
}

describe('Workbench Sidebar and Settings UI', () => {
  it('renders Variant A Workbench Sidebar with Search, Watchlist, Settings nav and Search placeholders', async () => {
    const { fetchMock } = createFetchMock(createMockSettingsResponse());
    render(<App fetchImpl={fetchMock} />);

    const nav = screen.getByRole('navigation', { name: /primary/i });
    expect(within(nav).getByRole('button', { name: /^Search$/i })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('button', { name: /Watchlist/i })).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: /Settings/i })).toBeInTheDocument();

    expect(screen.getByRole('region', { name: /Saved Searches/i })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /Unified Filters/i })).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveTextContent(/Search Workbench/i);

    await userEvent.click(within(nav).getByRole('button', { name: /Watchlist/i }));
    expect(within(nav).getByRole('button', { name: /Watchlist/i })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('heading', { name: /Watchlist/i })).toBeInTheDocument();
  });

  it('loads Settings, updates browser channel, ZIP/radius, Home Facebook City Slug, Facebook City Hubs, and eBay credentials', async () => {
    const { fetchMock, calls } = createFetchMock(createMockSettingsResponse());
    render(<App fetchImpl={fetchMock} />);

    await userEvent.click(screen.getByRole('button', { name: /^Settings$/i }));

    await waitFor(() => {
      expect(
        screen.getByText('C:\\Users\\test\\AppData\\Local\\unified-marketplace-search'),
      ).toBeInTheDocument();
    });

    expect(screen.getByText('••••••••a9f2')).toBeInTheDocument();

    const channelSelect = screen.getByLabelText(/Browser channel/i);
    await userEvent.selectOptions(channelSelect, 'msedge');

    const zipInput = screen.getByLabelText(/Home ZIP \/ Postal Code/i);
    await userEvent.clear(zipInput);
    await userEvent.type(zipInput, '98101');

    const radiusInput = screen.getByLabelText(/Default Local Pickup Radius/i);
    await userEvent.clear(radiusInput);
    await userEvent.type(radiusInput, '25');

    const homeCityInput = screen.getByLabelText(/Home Facebook City Slug/i);
    await userEvent.clear(homeCityInput);
    await userEvent.type(homeCityInput, 'seattle');

    await userEvent.click(screen.getByRole('button', { name: /Save defaults/i }));

    await waitFor(() => {
      const putCall = calls.find(
        (c) => c.url === '/api/settings' && c.method === 'PUT',
      );
      expect(putCall).toBeDefined();
      expect(putCall?.body).toMatchObject({
        settings: {
          browserChannel: 'msedge',
          homePostalCode: '98101',
          defaultLocalPickupRadiusMiles: 25,
          homeFacebookCitySlug: 'seattle',
        },
      });
    });

    // Toggle a Facebook City Hub (disable Seattle) and save hubs
    const seattleToggle = screen.getByRole('checkbox', { name: /Enable Seattle, WA/i });
    await userEvent.click(seattleToggle);
    await userEvent.click(screen.getByRole('button', { name: /Save hubs/i }));

    await waitFor(() => {
      const hubPut = calls
        .filter((c) => c.url === '/api/settings' && c.method === 'PUT')
        .at(-1);
      const savedHubs = (hubPut?.body as { settings: { facebookCityHubs: Array<{ slug: string; enabled: boolean }> } })
        .settings.facebookCityHubs;
      expect(savedHubs.find((h) => h.slug === 'seattle')?.enabled).toBe(false);
    });

    // Replace eBay secret
    await userEvent.click(screen.getByRole('button', { name: /Replace secret/i }));
    const secretInput = screen.getByLabelText(/eBay Client Secret/i);
    await userEvent.type(secretInput, 'new-ebay-secret-7788');
    await userEvent.click(screen.getByRole('button', { name: /Save eBay credentials/i }));

    await waitFor(() => {
      expect(screen.getByText('••••••••7788')).toBeInTheDocument();
    });
  });

  it('confirms browser profile reset in a <dialog> and triggers Stop server shutdown', async () => {
    const { fetchMock, calls } = createFetchMock(createMockSettingsResponse());
    render(<App fetchImpl={fetchMock} />);

    await userEvent.click(screen.getByRole('button', { name: /^Settings$/i }));

    await waitFor(() => {
      expect(screen.getByText(/Browser Sessions & Profiles/i)).toBeInTheDocument();
    });

    const poshRow = screen.getByTestId('profile-row-poshmark');
    await userEvent.click(within(poshRow).getByRole('button', { name: /Open browser session/i }));

    await waitFor(() => {
      expect(
        calls.some(
          (c) => c.url === '/api/browser/poshmark/open-session' && c.method === 'POST',
        ),
      ).toBe(true);
      expect(within(poshRow).getByText(/Active browser session/i)).toBeInTheDocument();
    });

    const fbRow = screen.getByTestId('profile-row-facebook');
    await userEvent.click(within(fbRow).getByRole('button', { name: /Reset profile/i }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: /Confirm reset/i }));

    await waitFor(() => {
      expect(
        calls.some(
          (c) => c.url === '/api/browser/facebook/reset-profile' && c.method === 'POST',
        ),
      ).toBe(true);
    });

    await userEvent.click(screen.getByRole('button', { name: /Stop server/i }));

    await waitFor(() => {
      expect(
        calls.some((c) => c.url === '/api/system/shutdown' && c.method === 'POST'),
      ).toBe(true);
      expect(screen.getByRole('status')).toHaveTextContent(/Server stopped cleanly/i);
    });
  });
});
