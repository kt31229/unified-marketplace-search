import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type AppInstance } from '../../src/server/app.ts';
import type {
  BrowserContextHandle,
  BrowserPageHandle,
  BrowserTransport,
} from '../../src/server/browser-session-manager.ts';
import { createDefaultUnifiedFilter, type Listing } from '../../src/shared/index.ts';

const tempDirs: string[] = [];
const activeApps: AppInstance[] = [];

function createTempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ums-fb-app-'));
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

function parseSseBlocks(text: string): ParsedSseEvent[] {
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

async function readSseEvents(response: Response): Promise<ParsedSseEvent[]> {
  return parseSseBlocks(await response.text());
}

function wrapRelayHtml(edges: unknown[]): string {
  return `<!doctype html><html><body><script type="application/json">${JSON.stringify({
    marketplace_search: {
      feed_units: {
        edges,
        page_info: { end_cursor: null, has_next_page: false },
      },
    },
  })}</script></body></html>`;
}

describe('Facebook Marketplace orchestrator & HTTP integration', () => {
  it('streams multi-hub Facebook sweep and stops remaining hubs via POST /api/searches/:runId/stop-facebook while preserving earlier Listings', async () => {
    const gotoUrls: string[] = [];
    let resolveFirstHubCooldown: (() => void) | null = null;
    const firstHubDone = new Promise<void>((resolve) => {
      resolveFirstHubCooldown = resolve;
    });

    const transport: BrowserTransport = {
      async launchPersistentContext(): Promise<BrowserContextHandle> {
        let currentUrl = 'about:blank';
        let currentHtml = '<html></html>';
        const page: BrowserPageHandle = {
          async goto(url: string) {
            currentUrl = url;
            gotoUrls.push(url);
            const hub = url.match(/\/marketplace\/([^/]+)\/search\//)?.[1] ?? 'unknown';
            currentHtml = wrapRelayHtml([
              {
                node: {
                  listing: {
                    id: `fb-${hub}-1`,
                    marketplace_listing_title: `Listing from ${hub}`,
                    listing_price: { amount: '55.00' },
                    is_sold: false,
                    is_pending: false,
                    delivery_types: ['IN_PERSON'],
                    creation_time: 1732233600,
                  },
                },
              },
            ]);
            return {
              url: () => currentUrl,
              status: () => 200,
              json: async () => ({}),
            };
          },
          url: () => currentUrl,
          title: async () => 'Facebook Marketplace',
          content: async () => currentHtml,
          async evaluate<R>(): Promise<R> {
            return undefined as R;
          },
          close: async () => undefined,
          isClosed: () => false,
        };
        return {
          pages: () => [page],
          newPage: async () => page,
          cookies: async () => [{ name: 'c_user', value: '10001' }],
          close: async () => undefined,
          on: () => undefined,
        };
      },
    };

    const instance = createApp({
      dataDir: createTempDataDir(),
      env: {},
      browserTransport: transport,
      sleep: async (_ms, signal) => {
        resolveFirstHubCooldown?.();
        await new Promise<void>((_, reject) => {
          if (signal?.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
          }
          signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
      },
    });
    activeApps.push(instance);

    const streamRes = await instance.app.request('/api/searches/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keywords: 'patagonia',
        unifiedFilters: {
          ...createDefaultUnifiedFilter(),
          facebookLocationSlugs: ['seattle', 'sanfrancisco', 'la'],
        },
        marketplaces: ['facebook'],
        sortOrder: 'relevance',
      }),
    });
    expect(streamRes.status).toBe(200);

    const reader = streamRes.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const events: ParsedSseEvent[] = [];
    let searchRunId = '';

    // Wait for first hub to enter cooldown, reading initial SSE events
    await firstHubDone;
    while (!searchRunId) {
      const { value, done } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split(/\r?\n\r?\n/);
        buffer = parts.pop() ?? '';
        for (const p of parts) {
          events.push(...parseSseBlocks(p));
        }
        const started = events.find((e) => e.event === 'run_started');
        if (started) {
          searchRunId = String(started.data.searchRunId);
        }
      }
      if (done) break;
    }

    expect(searchRunId).toBeTruthy();

    // Unknown runId returns 404
    const missingStop = await instance.app.request('/api/searches/nonexistent/stop-facebook', {
      method: 'POST',
    });
    expect(missingStop.status).toBe(404);

    // Stop active Facebook sweep
    const stopRes = await instance.app.request(`/api/searches/${searchRunId}/stop-facebook`, {
      method: 'POST',
    });
    expect(stopRes.status).toBe(200);
    const stopJson = (await stopRes.json()) as {
      ok: boolean;
      stopped: boolean;
      status: { stoppedByUser?: boolean };
    };
    expect(stopJson.ok).toBe(true);
    expect(stopJson.stopped).toBe(true);
    expect(stopJson.status.stoppedByUser).toBe(true);

    // Drain remainder of SSE stream
    while (true) {
      const { value, done } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: true });
      }
      if (done) break;
    }
    events.push(...parseSseBlocks(buffer));

    const batches = events.filter((e) => e.event === 'listings_batch');
    const fetchedIds = batches.flatMap((b) =>
      (b.data.listings as Listing[]).map((l) => l.marketplaceListingId),
    );
    expect(fetchedIds).toEqual(['fb-seattle-1']);
    expect(gotoUrls).toHaveLength(1); // Only Seattle navigated; SF and LA aborted

    const runComplete = events.find((e) => e.event === 'run_complete');
    const fbStatus = (runComplete?.data.statuses as Record<string, { runStatus: string; stoppedByUser?: boolean; loadedCount: number }>).facebook;
    expect(fbStatus?.runStatus).toBe('success');
    expect(fbStatus?.stoppedByUser).toBe(true);
    expect(fbStatus?.loadedCount).toBe(1);
  });

  it('registers FacebookAdapter by default, latches challenge_or_auth_required across runs, and unlatches on open-session or retry', async () => {
    let checkpointCleared = false;
    const gotoUrls: string[] = [];

    const transport: BrowserTransport = {
      async launchPersistentContext(_userDataDir, options): Promise<BrowserContextHandle> {
        let currentUrl = 'about:blank';
        let currentHtml = '<html></html>';
        let currentTitle = 'Facebook Marketplace';
        const isForeground = !options.args.some((a) => a.includes('-2400'));

        const page: BrowserPageHandle = {
          async goto(url: string) {
            currentUrl = url;
            gotoUrls.push(url);
            if (isForeground) {
              checkpointCleared = true;
              currentHtml = '<html><body>Signed in</body></html>';
              return { url: () => currentUrl, status: () => 200, json: async () => ({}) };
            }
            if (!checkpointCleared && url.includes('/marketplace/sanfrancisco/')) {
              currentUrl = 'https://www.facebook.com/checkpoint/';
              currentTitle = 'Security Check';
              currentHtml = '<html><body><div id="checkpoint_title">Check</div></body></html>';
              return { url: () => currentUrl, status: () => 200, json: async () => ({}) };
            }
            const hub = url.match(/\/marketplace\/([^/]+)\/search\//)?.[1] ?? 'seattle';
            currentTitle = 'Facebook Marketplace';
            currentHtml = wrapRelayHtml([
              {
                node: {
                  listing: {
                    id: `fb-${hub}`,
                    marketplace_listing_title: `Clean ${hub}`,
                    listing_price: { amount: '40.00' },
                    is_sold: false,
                    is_pending: false,
                    delivery_types: ['SHIPPING_ONSITE'],
                  },
                },
              },
            ]);
            return { url: () => currentUrl, status: () => 200, json: async () => ({}) };
          },
          url: () => currentUrl,
          title: async () => currentTitle,
          content: async () => currentHtml,
          async evaluate<R>(): Promise<R> {
            return undefined as R;
          },
          close: async () => undefined,
          isClosed: () => false,
        };
        return {
          pages: () => [page],
          newPage: async () => page,
          cookies: async () => [{ name: 'c_user', value: '10001' }],
          close: async () => undefined,
          on: () => undefined,
        };
      },
    };

    const instance = createApp({
      dataDir: createTempDataDir(),
      env: {},
      browserTransport: transport,
      sleep: async () => undefined,
    });
    activeApps.push(instance);

    const payload = {
      keywords: 'desk',
      unifiedFilters: {
        ...createDefaultUnifiedFilter(),
        facebookLocationSlugs: ['seattle', 'sanfrancisco', 'la'],
      },
      marketplaces: ['facebook'],
      sortOrder: 'relevance',
    };

    // Run 1: Seattle succeeds, SF hits checkpoint -> retains Seattle listing & latches
    const res1 = await instance.app.request('/api/searches/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const events1 = await readSseEvents(res1);
    const runId1 = String(events1.find((e) => e.event === 'run_started')?.data.searchRunId);
    expect(runId1).toBeTruthy();
    const retainedBatches1 = events1.filter((e) => e.event === 'listings_batch');
    expect(retainedBatches1).toHaveLength(1);
    expect((retainedBatches1[0]?.data.listings as Listing[])[0]?.marketplaceListingId).toBe(
      'fb-seattle',
    );
    const complete1 = events1.find((e) => e.event === 'run_complete');
    const fb1 = (complete1?.data.statuses as Record<string, { runStatus: string; loadedCount: number }>).facebook;
    expect(fb1?.runStatus).toBe('challenge_or_auth_required');
    expect(fb1?.loadedCount).toBe(1);
    expect(gotoUrls).toHaveLength(3); // seattle + sanfrancisco (initial + 1 auto-retry), la never visited

    // Run 2 while latched: does NOT navigate at all, immediately returns challenge_or_auth_required
    const res2 = await instance.app.request('/api/searches/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const events2 = await readSseEvents(res2);
    const runId2 = String(events2.find((e) => e.event === 'run_started')?.data.searchRunId);
    const complete2 = events2.find((e) => e.event === 'run_complete');
    const fb2 = (complete2?.data.statuses as Record<string, { runStatus: string }>).facebook;
    expect(fb2?.runStatus).toBe('challenge_or_auth_required');
    expect(gotoUrls).toHaveLength(3);

    // Open browser session -> unlatches
    const openRes = await instance.app.request('/api/browser/facebook/open-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(openRes.status).toBe(200);

    // Retry Facebook on run 2 -> runs all 3 hubs cleanly
    const retryRes = await instance.app.request(`/api/searches/${runId2}/retry/facebook`, {
      method: 'POST',
    });
    expect(retryRes.status).toBe(200);
    const retryEvents = await readSseEvents(retryRes);
    const retryComplete = retryEvents.find((e) => e.event === 'run_complete');
    const fbRetry = (retryComplete?.data.statuses as Record<string, { runStatus: string; loadedCount: number }>).facebook;
    expect(fbRetry?.runStatus).toBe('success');
    expect(fbRetry?.loadedCount).toBe(3);
  });
});
