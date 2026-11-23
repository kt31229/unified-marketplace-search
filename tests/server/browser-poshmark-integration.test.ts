import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type AppInstance } from '../../src/server/app.ts';
import type {
  BrowserContextHandle,
  BrowserPageHandle,
  BrowserTransport,
  LaunchPersistentContextOptions,
} from '../../src/server/browser-session-manager.ts';
import { createDefaultUnifiedFilter, type Listing } from '../../src/shared/index.ts';

const tempDirs: string[] = [];
const activeApps: AppInstance[] = [];

function createTempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ums-posh-app-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (activeApps.length > 0) {
    const app = activeApps.pop();
    if (app) {
      await app.shutdown();
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

interface ParsedSseEvent {
  event: string;
  data: Record<string, unknown>;
}

async function readSseEvents(response: Response): Promise<ParsedSseEvent[]> {
  const text = await response.text();
  const blocks = text.split(/\r?\n\r?\n/).filter((b) => b.trim().length > 0);
  const events: ParsedSseEvent[] = [];
  for (const block of blocks) {
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) {
        eventName = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trim());
      }
    }
    if (dataLines.length > 0) {
      events.push({
        event: eventName,
        data: JSON.parse(dataLines.join('\n')) as Record<string, unknown>,
      });
    }
  }
  return events;
}

function createTrackingTransport() {
  const launches: Array<{
    userDataDir: string;
    options: LaunchPersistentContextOptions;
    closed: boolean;
    gotoUrls: string[];
  }> = [];
  const lifecycleEvents: string[] = [];

  const transport: BrowserTransport = {
    async launchPersistentContext(userDataDir, options): Promise<BrowserContextHandle> {
      const idx = launches.length;
      const mode = options.args.some((a) => a.includes('-2400')) ? 'bg' : 'fg';
      lifecycleEvents.push(`launch:${mode}:${idx}`);
      const rec = {
        userDataDir,
        options,
        closed: false,
        gotoUrls: [] as string[],
      };
      launches.push(rec);

      let currentUrl = 'about:blank';
      let closeListeners: Array<() => void> = [];

      const page: BrowserPageHandle = {
        async goto(url: string) {
          currentUrl = url;
          rec.gotoUrls.push(url);
          return {
            url: () => currentUrl,
            status: () => 200,
            json: async () => ({}),
          };
        },
        url: () => currentUrl,
        title: async () => 'Poshmark',
        content: async () => '<html></html>',
        async evaluate<R, Arg>(_fn: unknown, arg?: Arg): Promise<R> {
          const { endpointUrl } = arg as { endpointUrl: string };
          const req = JSON.parse(
            new URL(endpointUrl, 'https://poshmark.com').searchParams.get('request') ?? '{}',
          ) as { max_id?: string };

          if (!req.max_id) {
            return {
              status: 200,
              ok: true,
              contentType: 'application/json',
              isChallengeDom: false,
              body: {
                data: [
                  {
                    id: 'pm-101',
                    title: 'Patagonia Fleece Vest',
                    price_amount: { val: '55.00' },
                    inventory: { status: 'available' },
                    shipping_discount_type: null,
                    first_published_at: '2026-11-22T01:00:00Z',
                    cover_shot: { url_small: 'https://di2ponv0v5otw.cloudfront.net/pm-101.jpg' },
                  },
                ],
                more: { next_max_id: 'ENC_NEXT_102' },
              },
            } as R;
          }

          return {
            status: 200,
            ok: true,
            contentType: 'application/json',
            isChallengeDom: false,
            body: {
              data: [
                {
                  id: 'pm-102',
                  title: 'Patagonia Synchilla Snap-T',
                  price_amount: { val: '65.00' },
                  inventory: { status: 'available' },
                  shipping_discount_type: 'free',
                },
              ],
              more: { next_max_id: null },
            },
          } as R;
        },
        close: async () => undefined,
        isClosed: () => false,
      };

      return {
        pages: () => [page],
        newPage: async () => page,
        cookies: async () => [],
        async close() {
          if (!rec.closed) {
            rec.closed = true;
            lifecycleEvents.push(`close:${mode}:${idx}`);
            for (const l of [...closeListeners]) {
              l();
            }
          }
        },
        on(event, listener) {
          if (event === 'close') {
            closeListeners.push(listener);
          }
        },
        off(event, listener) {
          if (event === 'close') {
            closeListeners = closeListeners.filter((l) => l !== listener);
          }
        },
      };
    },
  };

  return { transport, launches, lifecycleEvents };
}

describe('createApp BrowserSessionManager + Poshmark integration', () => {
  it('lazily launches Poshmark, streams results & load-more, enforces exclusive open-session/reset-profile locks, and closes on shutdown', async () => {
    const { transport, launches, lifecycleEvents } = createTrackingTransport();
    const dataDir = createTempDataDir();
    const instance = createApp({
      dataDir,
      env: {},
      browserTransport: transport,
    });
    activeApps.push(instance);

    // Zero browser launches at startup
    expect(launches).toHaveLength(0);

    // Run search for Poshmark
    const streamRes = await instance.app.request('/api/searches/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keywords: 'patagonia',
        unifiedFilters: createDefaultUnifiedFilter(),
        marketplaces: ['poshmark'],
        sortOrder: 'relevance',
      }),
    });
    expect(streamRes.status).toBe(200);
    const events = await readSseEvents(streamRes);
    const runId = events.find((e) => e.event === 'run_started')?.data.searchRunId as string;
    const batch1 = events.find(
      (e) => e.event === 'listings_batch' && e.data.marketplace === 'poshmark',
    )?.data.listings as Listing[];
    expect(batch1).toHaveLength(1);
    expect(batch1[0]?.marketplaceListingId).toBe('pm-101');
    expect(batch1[0]?.shippingPrice).toBe(6.49);
    expect(launches).toHaveLength(1);
    expect(launches[0]?.options.args).toContain('--window-position=-2400,-2400');

    // Settings reflects activeContext = true
    const settings1 = await (await instance.app.request('/api/settings')).json();
    expect(settings1.browserProfiles.poshmark).toEqual({ exists: true, activeContext: true });
    expect(settings1.browserProfiles.mercari.activeContext).toBe(false);

    // Load more reuses warm Poshmark context
    const lmRes = await instance.app.request(`/api/searches/${runId}/load-more`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ marketplace: 'poshmark' }),
    });
    expect(lmRes.status).toBe(200);
    const lmEvents = await readSseEvents(lmRes);
    const batch2 = lmEvents.find((e) => e.event === 'listings_batch')?.data.listings as Listing[];
    expect(batch2[0]?.marketplaceListingId).toBe('pm-102');
    expect(launches).toHaveLength(1);

    // Open browser session closes background context BEFORE launching foreground window
    const openRes = await instance.app.request('/api/browser/poshmark/open-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://poshmark.com/search?query=patagonia' }),
    });
    expect(openRes.status).toBe(200);
    expect(launches).toHaveLength(2);
    expect(launches[0]?.closed).toBe(true);
    expect(launches[1]?.closed).toBe(false);
    expect(launches[1]?.options.args).toEqual(['--window-size=1280,900']);
    expect(launches[1]?.gotoUrls).toEqual(['https://poshmark.com/search?query=patagonia']);
    expect(lifecycleEvents.indexOf('close:bg:0')).toBeLessThan(
      lifecycleEvents.indexOf('launch:fg:1'),
    );

    // Reset profile closes active foreground context and removes directory
    const profileDir = path.join(dataDir, 'profiles', 'poshmark');
    fs.writeFileSync(path.join(profileDir, 'Cookies'), 'cookie-data');
    const resetRes = await instance.app.request('/api/browser/poshmark/reset-profile', {
      method: 'POST',
    });
    expect(resetRes.status).toBe(200);
    expect(launches[1]?.closed).toBe(true);
    expect(fs.existsSync(profileDir)).toBe(false);

    // Open another session, then verify /api/system/shutdown closes it cleanly
    await instance.app.request('/api/browser/mercari/open-session', { method: 'POST' });
    expect(launches).toHaveLength(3);
    expect(launches[2]?.closed).toBe(false);

    const shutdownRes = await instance.app.request('/api/system/shutdown', { method: 'POST' });
    expect(shutdownRes.status).toBe(200);
    expect(launches[2]?.closed).toBe(true);
    activeApps.pop();
  });
});
