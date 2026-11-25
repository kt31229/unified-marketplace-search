import fs from 'node:fs';
import path from 'node:path';
import {
  BROWSER_MARKETPLACE_IDS,
  type BrowserChannel,
  type BrowserMarketplaceId,
} from '../shared/index.ts';
import type { ClockFn } from './adapters/types.ts';
import { getProfileDir } from './paths.ts';

export const BACKGROUND_BROWSER_ARGS = ['--window-size=1280,900'] as const;

export const FOREGROUND_BROWSER_ARGS = [
  '--window-position=80,80',
  '--window-size=1280,900',
] as const;

export const DEFAULT_BROWSER_IDLE_TIMEOUT_MS = 120_000;

export const DEFAULT_MARKETPLACE_SESSION_URLS: Record<BrowserMarketplaceId, string> = {
  poshmark: 'https://poshmark.com',
  mercari: 'https://www.mercari.com',
  facebook: 'https://www.facebook.com/marketplace',
};

export interface LaunchPersistentContextOptions {
  channel: BrowserChannel;
  headless: boolean;
  args: string[];
  viewport: { width: number; height: number } | null;
}

export interface BrowserCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
}

export interface BrowserRequestHandle {
  method?(): string;
  postData?(): string | null;
}

export interface BrowserResponseHandle {
  url(): string;
  status(): number;
  json(): Promise<unknown>;
  text?(): Promise<string>;
  headers?(): Record<string, string>;
  request?(): BrowserRequestHandle;
}

export interface BrowserPageHandle {
  goto(
    url: string,
    options?: {
      waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
      timeout?: number;
    },
  ): Promise<BrowserResponseHandle | null>;
  url(): string;
  title(): Promise<string>;
  content(): Promise<string>;
  evaluate<R, Arg = unknown>(
    pageFunction: ((arg: Arg) => R | Promise<R>) | string,
    arg?: Arg,
  ): Promise<R>;
  waitForResponse?(
    predicate: string | ((res: BrowserResponseHandle) => boolean | Promise<boolean>),
    options?: { timeout?: number },
  ): Promise<BrowserResponseHandle>;
  waitForSelector?(
    selector: string,
    options?: { timeout?: number; state?: 'attached' | 'detached' | 'visible' | 'hidden' },
  ): Promise<unknown>;
  click?(selector: string, options?: { timeout?: number }): Promise<void>;
  on?(event: 'response', listener: (res: BrowserResponseHandle) => void): void;
  off?(event: 'response', listener: (res: BrowserResponseHandle) => void): void;
  close(): Promise<void>;
  isClosed?(): boolean;
}

export interface BrowserContextHandle {
  pages(): BrowserPageHandle[];
  newPage(): Promise<BrowserPageHandle>;
  cookies(urls?: string | string[]): Promise<BrowserCookie[]>;
  close(): Promise<void>;
  on(event: 'close', listener: () => void): void;
  off?(event: 'close', listener: () => void): void;
}

export interface BrowserTransport {
  launchPersistentContext(
    userDataDir: string,
    options: LaunchPersistentContextOptions,
  ): Promise<BrowserContextHandle>;
}

export interface TimerScheduler {
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface BrowserSessionManagerOptions {
  dataDir: string;
  getBrowserChannel: () => BrowserChannel;
  transport?: BrowserTransport;
  idleTimeoutMs?: number;
  clock?: ClockFn;
  timers?: TimerScheduler;
}

interface ProfileSlot {
  marketplace: BrowserMarketplaceId;
  mode: 'background' | 'foreground' | null;
  channel: BrowserChannel | null;
  context: BrowserContextHandle | null;
  page: BrowserPageHandle | null;
  pagesByKey: Map<string, BrowserPageHandle>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  inUse: boolean;
  lastUsedAtMs: number;
  lockChain: Promise<void>;
}

export function detectInstalledChromiumMajorVersion(
  channel: BrowserChannel,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  if (platform !== 'win32') {
    return null;
  }
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA];
  const subPath =
    channel === 'msedge'
      ? ['Microsoft', 'Edge', 'Application']
      : ['Google', 'Chrome', 'Application'];
  let highest: number | null = null;

  for (const root of roots) {
    if (!root) continue;
    const appDir = path.win32.join(root, ...subPath);
    try {
      for (const entry of fs.readdirSync(appDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const match = /^(\d+)\.\d+\.\d+\.\d+$/.exec(entry.name);
        if (!match) continue;
        const major = Number.parseInt(match[1]!, 10);
        if (highest === null || major > highest) {
          highest = major;
        }
      }
    } catch {
      // Directory missing or unreadable; continue checking other roots.
    }
  }

  return highest;
}

export function buildHeadlessUserAgent(channel: BrowserChannel, majorVersion: number): string {
  const base = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${majorVersion}.0.0.0 Safari/537.36`;
  return channel === 'msedge' ? `${base} Edg/${majorVersion}.0.0.0` : base;
}

export function createPatchrightTransport(): BrowserTransport {
  return {
    async launchPersistentContext(userDataDir, options) {
      const { chromium } = await import('patchright');
      const args = [...options.args];
      if (options.headless && !args.some((arg) => arg.startsWith('--user-agent='))) {
        const majorVersion = detectInstalledChromiumMajorVersion(options.channel);
        if (majorVersion !== null) {
          args.push(`--user-agent=${buildHeadlessUserAgent(options.channel, majorVersion)}`);
        }
      }
      const context = await chromium.launchPersistentContext(userDataDir, {
        channel: options.channel,
        headless: options.headless,
        args,
        viewport: options.viewport,
      });
      return context as unknown as BrowserContextHandle;
    },
  };
}

function validateSessionUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Unsupported browser session URL protocol: ${parsed.protocol}`);
  }
  return parsed.toString();
}

/**
 * Manages lazy, isolated patchright browser contexts per Marketplace with exclusive
 * profile locking, headless background search contexts, warm reuse with idle auto-close, and clean teardown.
 */
export class BrowserSessionManager {
  private readonly dataDir: string;
  private readonly getBrowserChannel: () => BrowserChannel;
  private readonly transport: BrowserTransport;
  private readonly idleTimeoutMs: number;
  private readonly clock: ClockFn;
  private readonly timers: TimerScheduler;
  private readonly slots = new Map<BrowserMarketplaceId, ProfileSlot>();
  private shuttingDown = false;

  constructor(options: BrowserSessionManagerOptions) {
    this.dataDir = options.dataDir;
    this.getBrowserChannel = options.getBrowserChannel;
    this.transport = options.transport ?? createPatchrightTransport();
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_BROWSER_IDLE_TIMEOUT_MS;
    this.clock = options.clock ?? (() => Date.now());
    this.timers = options.timers ?? {
      setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
      clearTimeout: (handle) => globalThis.clearTimeout(handle),
    };

    for (const mp of BROWSER_MARKETPLACE_IDS) {
      this.slots.set(mp, {
        marketplace: mp,
        mode: null,
        channel: null,
        context: null,
        page: null,
        pagesByKey: new Map(),
        idleTimer: null,
        inUse: false,
        lastUsedAtMs: 0,
        lockChain: Promise.resolve(),
      });
    }
  }

  private getSlot(marketplace: BrowserMarketplaceId): ProfileSlot {
    const slot = this.slots.get(marketplace);
    if (!slot) {
      throw new Error(`Unknown browser Marketplace: ${marketplace}`);
    }
    return slot;
  }

  private async withProfileLock<T>(
    marketplace: BrowserMarketplaceId,
    fn: (slot: ProfileSlot) => Promise<T>,
  ): Promise<T> {
    const slot = this.getSlot(marketplace);
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = slot.lockChain;
    slot.lockChain = prev.then(() => next, () => next);

    await prev;
    try {
      return await fn(slot);
    } finally {
      release();
    }
  }

  private clearIdleTimer(slot: ProfileSlot): void {
    if (slot.idleTimer !== null) {
      this.timers.clearTimeout(slot.idleTimer);
      slot.idleTimer = null;
    }
  }

  private scheduleIdleTimer(slot: ProfileSlot): void {
    this.clearIdleTimer(slot);
    if (this.shuttingDown || this.idleTimeoutMs <= 0 || slot.mode !== 'background' || !slot.context) {
      return;
    }
    const scheduledAtMs = slot.lastUsedAtMs;
    slot.idleTimer = this.timers.setTimeout(() => {
      void this.withProfileLock(slot.marketplace, async (lockedSlot) => {
        if (
          lockedSlot.mode === 'background' &&
          !lockedSlot.inUse &&
          lockedSlot.context &&
          lockedSlot.lastUsedAtMs === scheduledAtMs
        ) {
          await this.closeSlotLocked(lockedSlot);
        }
      });
    }, this.idleTimeoutMs);
  }

  private async closeSlotLocked(slot: ProfileSlot): Promise<void> {
    this.clearIdleTimer(slot);
    const context = slot.context;
    slot.context = null;
    slot.page = null;
    slot.pagesByKey.clear();
    slot.mode = null;
    slot.channel = null;
    if (context) {
      await context.close().catch(() => undefined);
    }
  }

  private attachCloseListener(slot: ProfileSlot, context: BrowserContextHandle): void {
    context.on('close', () => {
      if (slot.context === context) {
        this.clearIdleTimer(slot);
        slot.context = null;
        slot.page = null;
        slot.pagesByKey.clear();
        slot.mode = null;
        slot.channel = null;
      }
    });
  }

  private async getOrCreateSinglePage(context: BrowserContextHandle): Promise<BrowserPageHandle> {
    const openPages = context.pages().filter((p) => !p.isClosed?.());
    let primary = openPages[0];
    if (!primary) {
      primary = await context.newPage();
    }
    for (const extra of openPages.slice(1)) {
      await extra.close().catch(() => undefined);
    }
    return primary;
  }

  private async getOrCreateKeyedPage(
    slot: ProfileSlot,
    pageKey: string,
  ): Promise<BrowserPageHandle> {
    const existing = slot.pagesByKey.get(pageKey);
    if (existing && !existing.isClosed?.()) {
      return existing;
    }

    const context = slot.context!;
    const claimed = new Set<BrowserPageHandle>(slot.pagesByKey.values());
    if (slot.page) {
      claimed.add(slot.page);
    }
    const unclaimed = context.pages().find((p) => !p.isClosed?.() && !claimed.has(p));
    const page = unclaimed ?? (await context.newPage());
    slot.pagesByKey.set(pageKey, page);
    return page;
  }

  isContextActive(marketplace: BrowserMarketplaceId): boolean {
    return this.getSlot(marketplace).context !== null;
  }

  getContextMode(marketplace: BrowserMarketplaceId): 'background' | 'foreground' | null {
    return this.getSlot(marketplace).mode;
  }

  async runInBackgroundPage<T>(
    marketplace: BrowserMarketplaceId,
    fn: (page: BrowserPageHandle, context: BrowserContextHandle) => Promise<T>,
    options?: { signal?: AbortSignal; pageKey?: string },
  ): Promise<T> {
    if (this.shuttingDown) {
      throw new Error('BrowserSessionManager is shutting down.');
    }
    if (options?.signal?.aborted) {
      throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');
    }

    return this.withProfileLock(marketplace, async (slot) => {
      if (this.shuttingDown) {
        throw new Error('BrowserSessionManager is shutting down.');
      }
      if (options?.signal?.aborted) {
        throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');
      }

      this.clearIdleTimer(slot);
      const desiredChannel = this.getBrowserChannel();

      // Enforce exclusive profile ownership & channel consistency
      if (
        slot.context &&
        (slot.mode !== 'background' || slot.channel !== desiredChannel)
      ) {
        await this.closeSlotLocked(slot);
      }

      if (!slot.context) {
        const profileDir = getProfileDir(this.dataDir, marketplace);
        fs.mkdirSync(profileDir, { recursive: true });
        const context = await this.transport.launchPersistentContext(profileDir, {
          channel: desiredChannel,
          headless: true,
          args: [...BACKGROUND_BROWSER_ARGS],
          viewport: null,
        });
        slot.context = context;
        slot.mode = 'background';
        slot.channel = desiredChannel;
        this.attachCloseListener(slot, context);
      }

      let activePage: BrowserPageHandle;
      if (options?.pageKey) {
        activePage = await this.getOrCreateKeyedPage(slot, options.pageKey);
      } else {
        if (!slot.page || slot.page.isClosed?.()) {
          slot.page = await this.getOrCreateSinglePage(slot.context);
        }
        activePage = slot.page;
      }

      slot.inUse = true;
      slot.lastUsedAtMs = this.clock();
      try {
        return await fn(activePage, slot.context);
      } finally {
        slot.inUse = false;
        slot.lastUsedAtMs = this.clock();
        if (!this.shuttingDown && slot.context && slot.mode === 'background') {
          this.scheduleIdleTimer(slot);
        }
      }
    });
  }

  async openForegroundSession(marketplace: BrowserMarketplaceId, url?: string): Promise<void> {
    if (this.shuttingDown) {
      throw new Error('BrowserSessionManager is shutting down.');
    }
    const targetUrl = validateSessionUrl(
      url?.trim() || DEFAULT_MARKETPLACE_SESSION_URLS[marketplace],
    );

    await this.withProfileLock(marketplace, async (slot) => {
      if (this.shuttingDown) {
        throw new Error('BrowserSessionManager is shutting down.');
      }

      // Close any active background or previous foreground context BEFORE opening foreground
      await this.closeSlotLocked(slot);

      const profileDir = getProfileDir(this.dataDir, marketplace);
      fs.mkdirSync(profileDir, { recursive: true });
      const channel = this.getBrowserChannel();
      const context = await this.transport.launchPersistentContext(profileDir, {
        channel,
        headless: false,
        args: [...FOREGROUND_BROWSER_ARGS],
        viewport: null,
      });

      slot.context = context;
      slot.mode = 'foreground';
      slot.channel = channel;
      this.attachCloseListener(slot, context);

      const page = await this.getOrCreateSinglePage(context);
      slot.page = page;
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    });
  }

  async closeProfile(marketplace: BrowserMarketplaceId): Promise<void> {
    await this.withProfileLock(marketplace, async (slot) => {
      await this.closeSlotLocked(slot);
    });
  }

  async resetProfile(marketplace: BrowserMarketplaceId): Promise<void> {
    await this.withProfileLock(marketplace, async (slot) => {
      await this.closeSlotLocked(slot);
      const profileDir = getProfileDir(this.dataDir, marketplace);
      if (fs.existsSync(profileDir)) {
        fs.rmSync(profileDir, { recursive: true, force: true });
      }
    });
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const slot of this.slots.values()) {
      this.clearIdleTimer(slot);
    }
    await Promise.all(
      BROWSER_MARKETPLACE_IDS.map((mp) =>
        this.withProfileLock(mp, async (slot) => {
          await this.closeSlotLocked(slot);
        }),
      ),
    );
  }
}
