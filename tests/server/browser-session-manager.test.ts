import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserSessionManager,
  type BrowserContextHandle,
  type BrowserPageHandle,
  type BrowserTransport,
  type LaunchPersistentContextOptions,
} from '../../src/server/browser-session-manager.ts';
import type { BrowserChannel } from '../../src/shared/index.ts';

interface FakeContextRecord {
  userDataDir: string;
  options: LaunchPersistentContextOptions;
  closed: boolean;
  pages: FakePageRecord[];
  closeListeners: Array<() => void>;
  handle: BrowserContextHandle;
}

interface FakePageRecord {
  navigatedUrls: string[];
  closed: boolean;
  handle: BrowserPageHandle;
}

function createFakeBrowserTransport() {
  const launches: FakeContextRecord[] = [];
  const events: string[] = [];

  const transport: BrowserTransport = {
    async launchPersistentContext(userDataDir, options) {
      events.push(`launch:${path.basename(userDataDir)}:${options.args.join(',')}`);
      const record: FakeContextRecord = {
        userDataDir,
        options,
        closed: false,
        pages: [],
        closeListeners: [],
        handle: null as unknown as BrowserContextHandle,
      };

      const makePage = (): FakePageRecord => {
        const pageRec: FakePageRecord = {
          navigatedUrls: [],
          closed: false,
          handle: {
            async goto(url: string) {
              pageRec.navigatedUrls.push(url);
              events.push(`goto:${path.basename(userDataDir)}:${url}`);
              return null;
            },
            url() {
              return pageRec.navigatedUrls.at(-1) ?? 'about:blank';
            },
            async title() {
              return 'Fake Page';
            },
            async content() {
              return '<html></html>';
            },
            async evaluate() {
              return undefined as never;
            },
            async close() {
              pageRec.closed = true;
            },
            isClosed() {
              return pageRec.closed;
            },
          },
        };
        record.pages.push(pageRec);
        return pageRec;
      };

      // Persistent context starts with an initial blank page like Chromium
      makePage();

      record.handle = {
        pages() {
          return record.pages.filter((p) => !p.closed).map((p) => p.handle);
        },
        async newPage() {
          return makePage().handle;
        },
        async cookies() {
          return [];
        },
        async close() {
          if (!record.closed) {
            record.closed = true;
            events.push(`close:${path.basename(userDataDir)}`);
            for (const listener of [...record.closeListeners]) {
              listener();
            }
          }
        },
        on(event, listener) {
          if (event === 'close') {
            record.closeListeners.push(listener);
          }
        },
        off(event, listener) {
          if (event === 'close') {
            record.closeListeners = record.closeListeners.filter((l) => l !== listener);
          }
        },
      };

      launches.push(record);
      return record.handle;
    },
  };

  return { transport, launches, events };
}

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ums-bsm-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('BrowserSessionManager', () => {
  it('launches lazily per Marketplace with off-screen headed args, reuses warm context, auto-closes on idle, and tears down on shutdown', async () => {
    vi.useFakeTimers();
    const dataDir = createTempDir();
    let channel: BrowserChannel = 'chrome';
    const fake = createFakeBrowserTransport();

    const manager = new BrowserSessionManager({
      dataDir,
      getBrowserChannel: () => channel,
      transport: fake.transport,
      idleTimeoutMs: 5_000,
    });

    // Never launches on construction
    expect(fake.launches).toHaveLength(0);
    expect(manager.isContextActive('poshmark')).toBe(false);

    // First background usage launches poshmark profile off-screen
    await manager.runInBackgroundPage('poshmark', async (page) => {
      await page.goto('https://poshmark.com/search?query=patagonia');
    });

    expect(fake.launches).toHaveLength(1);
    expect(fake.launches[0]?.userDataDir).toBe(path.join(dataDir, 'profiles', 'poshmark'));
    expect(fake.launches[0]?.options).toEqual({
      channel: 'chrome',
      headless: false,
      args: ['--window-position=-2400,-2400', '--window-size=1280,900'],
      viewport: null,
    });
    expect(manager.isContextActive('poshmark')).toBe(true);
    expect(manager.isContextActive('mercari')).toBe(false);

    // Second usage before idle timeout reuses the warm context & single page
    await vi.advanceTimersByTimeAsync(3_000);
    await manager.runInBackgroundPage('poshmark', async (page) => {
      await page.goto('https://poshmark.com/search?query=arcteryx');
    });
    expect(fake.launches).toHaveLength(1);

    // Idle timeout closes background context automatically
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fake.launches[0]?.closed).toBe(true);
    expect(manager.isContextActive('poshmark')).toBe(false);

    // Next usage after idle close relaunches cleanly; changing channel also relaunches
    await manager.runInBackgroundPage('poshmark', async (page) => {
      await page.goto('https://poshmark.com/search?query=nike');
    });
    expect(fake.launches).toHaveLength(2);

    channel = 'msedge';
    await manager.runInBackgroundPage('poshmark', async (page) => {
      await page.goto('https://poshmark.com/search?query=adidas');
    });
    expect(fake.launches[1]?.closed).toBe(true);
    expect(fake.launches).toHaveLength(3);
    expect(fake.launches[2]?.options.channel).toBe('msedge');

    // Shutdown closes all remaining active contexts
    await manager.shutdown();
    expect(fake.launches[2]?.closed).toBe(true);
    expect(manager.isContextActive('poshmark')).toBe(false);
  });

  it('enforces exclusive per-profile locking on openForegroundSession and resetProfile', async () => {
    const dataDir = createTempDir();
    const fake = createFakeBrowserTransport();
    const manager = new BrowserSessionManager({
      dataDir,
      getBrowserChannel: () => 'chrome',
      transport: fake.transport,
      idleTimeoutMs: 30_000,
    });

    // Warm background poshmark session
    await manager.runInBackgroundPage('poshmark', async (page) => {
      await page.goto('https://poshmark.com/search?query=patagonia');
    });
    expect(fake.launches).toHaveLength(1);
    expect(fake.launches[0]?.closed).toBe(false);

    // Open foreground session: MUST close background context BEFORE launching foreground
    await manager.openForegroundSession('poshmark');
    expect(fake.launches).toHaveLength(2);
    expect(fake.launches[0]?.closed).toBe(true);
    expect(fake.launches[1]?.closed).toBe(false);
    expect(fake.launches[1]?.options.headless).toBe(false);
    expect(fake.launches[1]?.options.args).toEqual(['--window-size=1280,900']);
    expect(fake.launches[1]?.pages[0]?.navigatedUrls).toEqual(['https://poshmark.com/']);

    const closeIdx = fake.events.indexOf('close:poshmark');
    const secondLaunchIdx = fake.events.lastIndexOf('launch:poshmark:--window-size=1280,900');
    expect(closeIdx).toBeGreaterThan(-1);
    expect(secondLaunchIdx).toBeGreaterThan(closeIdx);

    // Create dummy file inside poshmark profile dir, then resetProfile
    const profileDir = path.join(dataDir, 'profiles', 'poshmark');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'SingletonLock'), 'lock');

    await manager.resetProfile('poshmark');
    expect(fake.launches[1]?.closed).toBe(true);
    expect(manager.isContextActive('poshmark')).toBe(false);
    expect(fs.existsSync(profileDir)).toBe(false);
  });

  it('tracks manual foreground close, rejects unsafe URLs, and serializes concurrent profile access', async () => {
    const dataDir = createTempDir();
    const fake = createFakeBrowserTransport();
    const manager = new BrowserSessionManager({
      dataDir,
      getBrowserChannel: () => 'chrome',
      transport: fake.transport,
    });

    await expect(manager.openForegroundSession('facebook', 'javascript:alert(1)')).rejects.toThrow(
      /Unsupported browser session URL protocol/i,
    );

    await manager.openForegroundSession('facebook');
    expect(manager.isContextActive('facebook')).toBe(true);
    expect(manager.getContextMode('facebook')).toBe('foreground');

    // User closes foreground window manually
    await fake.launches[0]!.handle.close();
    expect(manager.isContextActive('facebook')).toBe(false);
    expect(manager.getContextMode('facebook')).toBeNull();

    // Concurrent background run + foreground open serialize cleanly without overlapping launches
    let releaseBackground!: () => void;
    const backgroundStarted = new Promise<void>((resolve) => {
      void manager.runInBackgroundPage('mercari', async () => {
        resolve();
        await new Promise<void>((done) => {
          releaseBackground = done;
        });
      });
    });
    await backgroundStarted;

    let foregroundDone = false;
    const fgPromise = manager.openForegroundSession('mercari', 'https://www.mercari.com/search/?keyword=sony').then(() => {
      foregroundDone = true;
    });

    await Promise.resolve();
    expect(foregroundDone).toBe(false);
    expect(fake.launches).toHaveLength(2); // only facebook + mercari bg so far

    releaseBackground();
    await fgPromise;
    expect(foregroundDone).toBe(true);
    expect(fake.launches).toHaveLength(3);
    expect(fake.launches[1]?.closed).toBe(true);
    expect(fake.launches[2]?.closed).toBe(false);
    expect(fake.launches[2]?.pages[0]?.navigatedUrls).toEqual([
      'https://www.mercari.com/search/?keyword=sony',
    ]);

    await manager.shutdown();
  });

  it('maintains one persistent tab per pageKey in background mode while preserving unkeyed single-tab behavior', async () => {
    vi.useFakeTimers();
    const dataDir = createTempDir();
    const fake = createFakeBrowserTransport();
    const manager = new BrowserSessionManager({
      dataDir,
      getBrowserChannel: () => 'chrome',
      transport: fake.transport,
      idleTimeoutMs: 5_000,
    });

    // First pageKey claims the initial blank page (no extra newPage)
    let seattlePage!: BrowserPageHandle;
    await manager.runInBackgroundPage(
      'facebook',
      async (page) => {
        seattlePage = page;
        await page.goto('https://www.facebook.com/marketplace/seattle/search/');
      },
      { pageKey: 'seattle' },
    );
    expect(fake.launches[0]?.pages).toHaveLength(1);
    expect(seattlePage.url()).toBe('https://www.facebook.com/marketplace/seattle/search/');

    // Second pageKey opens a new tab while keeping 'seattle' open at its URL
    let sfPage!: BrowserPageHandle;
    await manager.runInBackgroundPage(
      'facebook',
      async (page) => {
        sfPage = page;
        await page.goto('https://www.facebook.com/marketplace/sanfrancisco/search/');
      },
      { pageKey: 'sanfrancisco' },
    );
    expect(fake.launches[0]?.pages).toHaveLength(2);
    expect(sfPage).not.toBe(seattlePage);
    expect(seattlePage.url()).toBe('https://www.facebook.com/marketplace/seattle/search/');
    expect(sfPage.url()).toBe('https://www.facebook.com/marketplace/sanfrancisco/search/');

    // Returning to 'seattle' reuses the exact same page handle without closing 'sanfrancisco'
    await manager.runInBackgroundPage(
      'facebook',
      async (page) => {
        expect(page).toBe(seattlePage);
      },
      { pageKey: 'seattle' },
    );
    expect(sfPage.isClosed?.()).toBe(false);

    // Unkeyed callers (e.g. poshmark) keep single-tab behavior
    await manager.runInBackgroundPage('poshmark', async (page) => {
      await page.goto('https://poshmark.com/search?query=coat');
    });
    expect(fake.launches[1]?.pages).toHaveLength(1);

    // Idle timeout clears keyed pages so subsequent launch opens a fresh tab
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fake.launches[0]?.closed).toBe(true);

    await manager.runInBackgroundPage(
      'facebook',
      async (page) => {
        expect(page).not.toBe(seattlePage);
      },
      { pageKey: 'seattle' },
    );
    expect(fake.launches).toHaveLength(3);

    await manager.shutdown();
  });
});
