import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  BROWSER_MARKETPLACE_IDS,
  BrowserMarketplaceIdSchema,
  LoadMoreRequestSchema,
  MarketplaceIdSchema,
  SearchRequestSchema,
  UpdateEbayCredentialsInputSchema,
  UpdateSettingsInputSchema,
  type BrowserMarketplaceId,
  type BrowserProfileStatus,
  type MarketplaceId,
  type SettingsResponse,
} from '../shared/index.ts';
import { createEbayAdapter } from './adapters/ebay.ts';
import { createBrowserPlaceholderAdapter } from './adapters/placeholders.ts';
import type {
  ClockFn,
  FetchLike,
  MarketplaceAdapter,
  SleepFn,
} from './adapters/types.ts';
import { openDatabase, type AppDatabase } from './db.ts';
import { ensureBaseDirectories, getProfileDir, resolveDataDir } from './paths.ts';
import { SearchOrchestrator } from './search-orchestrator.ts';
import { SecretsStore, type RawEbayCredentials } from './secrets.ts';

export type TeardownHook = () => Promise<void> | void;

export interface CreateAppDeps {
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  staticDir?: string;
  fetchImpl?: FetchLike;
  clock?: ClockFn;
  sleep?: SleepFn;
  adapters?: Partial<Record<MarketplaceId, MarketplaceAdapter>>;
  onShutdown?: () => Promise<void> | void;
  onOpenBrowserSession?: (marketplace: BrowserMarketplaceId, url?: string) => Promise<void> | void;
  onResetBrowserProfile?: (marketplace: BrowserMarketplaceId) => Promise<void> | void;
  isBrowserContextActive?: (marketplace: BrowserMarketplaceId) => boolean;
  verifyEbayCredentials?: (
    creds: RawEbayCredentials,
  ) => Promise<{ valid: boolean; error?: string }>;
}

export interface AppInstance {
  app: Hono;
  db: DatabaseSync;
  database: AppDatabase;
  dataDir: string;
  secretsStore: SecretsStore;
  registerTeardown: (hook: TeardownHook) => void;
  shutdown: () => Promise<void>;
}

function getBrowserProfilesStatus(
  dataDir: string,
  isActive?: (marketplace: BrowserMarketplaceId) => boolean,
): Record<BrowserMarketplaceId, BrowserProfileStatus> {
  const result = {} as Record<BrowserMarketplaceId, BrowserProfileStatus>;
  for (const marketplace of BROWSER_MARKETPLACE_IDS) {
    result[marketplace] = {
      exists: fs.existsSync(getProfileDir(dataDir, marketplace)),
      activeContext: isActive ? isActive(marketplace) : false,
    };
  }
  return result;
}

/**
 * Creates the Hono HTTP application wired to SQLite, SecretsStore, and lifecycle teardown hooks.
 */
export function createApp(deps: CreateAppDeps = {}): AppInstance {
  const env = deps.env ?? process.env;
  const dataDir = deps.dataDir ? path.resolve(deps.dataDir) : resolveDataDir({ env });
  ensureBaseDirectories(dataDir);

  const database = openDatabase(dataDir);
  const secretsStore = new SecretsStore(dataDir, env);
  const teardownHooks: TeardownHook[] = [];
  let isShuttingDown = false;

  const defaultEbayAdapter = createEbayAdapter({
    fetchImpl: deps.fetchImpl,
    clock: deps.clock,
  });

  const adapters: Record<MarketplaceId, MarketplaceAdapter> = {
    ebay: deps.adapters?.ebay ?? defaultEbayAdapter,
    poshmark: deps.adapters?.poshmark ?? createBrowserPlaceholderAdapter('poshmark'),
    mercari: deps.adapters?.mercari ?? createBrowserPlaceholderAdapter('mercari'),
    facebook: deps.adapters?.facebook ?? createBrowserPlaceholderAdapter('facebook'),
  };

  const orchestrator = new SearchOrchestrator({
    adapters,
    getSettings: () => database.settings.getSettings(),
    secretsStore,
    clock: deps.clock,
    sleep: deps.sleep,
  });

  const registerTeardown = (hook: TeardownHook) => {
    teardownHooks.push(hook);
  };

  const shutdown = async () => {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;
    orchestrator.abortAll();

    for (let i = teardownHooks.length - 1; i >= 0; i--) {
      const hook = teardownHooks[i];
      if (hook) {
        await hook();
      }
    }
    database.close();
  };

  const buildSettingsResponse = (): SettingsResponse => ({
    settings: database.settings.getSettings(),
    ebay: secretsStore.getStatus(),
    dataDir,
    browserProfiles: getBrowserProfilesStatus(dataDir, deps.isBrowserContextActive),
  });

  const app = new Hono();

  app.get('/api/health', (c) => {
    return c.json({ ok: true, bindHost: '127.0.0.1' });
  });

  app.get('/api/settings', (c) => {
    return c.json(buildSettingsResponse());
  });

  app.put('/api/settings', async (c) => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON payload' }, 400);
    }

    const parsed = UpdateSettingsInputSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json({ error: 'Invalid settings payload', details: parsed.error.flatten() }, 400);
    }

    if (parsed.data.settings) {
      database.settings.updateSettings(parsed.data.settings);
    }
    if (parsed.data.ebay) {
      secretsStore.saveEbayCredentials(parsed.data.ebay);
    }

    return c.json(buildSettingsResponse());
  });

  app.put('/api/settings/ebay-credentials', async (c) => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON payload' }, 400);
    }

    const parsed = UpdateEbayCredentialsInputSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        { error: 'Invalid eBay credentials payload', details: parsed.error.flatten() },
        400,
      );
    }

    secretsStore.saveEbayCredentials(parsed.data);
    return c.json(buildSettingsResponse());
  });

  app.post('/api/settings/ebay/verify', async (c) => {
    const creds = secretsStore.getRawCredentials();
    if (!creds.configured) {
      return c.json(
        {
          valid: false,
          origin: creds.origin,
          error: 'eBay client_id and client_secret must both be configured before verification.',
        },
        400,
      );
    }

    if (deps.verifyEbayCredentials) {
      const result = await deps.verifyEbayCredentials(creds);
      return c.json({
        valid: result.valid,
        origin: creds.origin,
        error: result.error,
      });
    }

    const result = await defaultEbayAdapter.verifyCredentials(creds);
    return c.json({
      valid: result.valid,
      origin: creds.origin,
      ...(result.error ? { error: result.error } : {}),
    });
  });

  app.post('/api/searches/stream', async (c) => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON payload' }, 400);
    }

    const parsed = SearchRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        { error: 'Invalid search request', details: parsed.error.flatten() },
        400,
      );
    }

    return streamSSE(c, async (stream) => {
      await orchestrator.startSearchStream(parsed.data, async (evt) => {
        await stream.writeSSE({
          event: evt.event,
          data: JSON.stringify(evt.data),
        });
      });
    });
  });

  app.post('/api/searches/:runId/load-more', async (c) => {
    const runId = c.req.param('runId');
    if (!orchestrator.hasRun(runId)) {
      return c.json({ error: 'Search run not found' }, 404);
    }

    let marketplace: MarketplaceId | undefined;
    try {
      const rawBody = await c.req.json();
      const parsed = LoadMoreRequestSchema.safeParse(rawBody);
      if (!parsed.success) {
        return c.json(
          { error: 'Invalid load-more request', details: parsed.error.flatten() },
          400,
        );
      }
      marketplace = parsed.data.marketplace;
    } catch {
      // Optional JSON body
    }

    return streamSSE(c, async (stream) => {
      await orchestrator.loadMore(runId, marketplace, async (evt) => {
        await stream.writeSSE({
          event: evt.event,
          data: JSON.stringify(evt.data),
        });
      });
    });
  });

  app.post('/api/searches/:runId/retry/:marketplace', async (c) => {
    const runId = c.req.param('runId');
    if (!orchestrator.hasRun(runId)) {
      return c.json({ error: 'Search run not found' }, 404);
    }

    const mpParsed = MarketplaceIdSchema.safeParse(c.req.param('marketplace'));
    if (!mpParsed.success) {
      return c.json({ error: 'Invalid Marketplace' }, 400);
    }

    return streamSSE(c, async (stream) => {
      await orchestrator.retryMarketplace(runId, mpParsed.data, async (evt) => {
        await stream.writeSSE({
          event: evt.event,
          data: JSON.stringify(evt.data),
        });
      });
    });
  });

  app.post('/api/browser/:marketplace/open-session', async (c) => {
    const mpParsed = BrowserMarketplaceIdSchema.safeParse(c.req.param('marketplace'));
    if (!mpParsed.success) {
      return c.json({ error: 'Invalid browser Marketplace' }, 400);
    }

    let url: string | undefined;
    try {
      const body = (await c.req.json()) as { url?: unknown };
      if (typeof body?.url === 'string' && body.url.trim()) {
        url = body.url.trim();
      }
    } catch {
      // Optional JSON body
    }

    if (!deps.onOpenBrowserSession) {
      return c.json(
        {
          error: 'Browser Session Manager is implemented in Ticket #21.',
          marketplace: mpParsed.data,
        },
        501,
      );
    }

    await deps.onOpenBrowserSession(mpParsed.data, url);
    return c.json({ ok: true, marketplace: mpParsed.data });
  });

  app.post('/api/browser/:marketplace/reset-profile', async (c) => {
    const mpParsed = BrowserMarketplaceIdSchema.safeParse(c.req.param('marketplace'));
    if (!mpParsed.success) {
      return c.json({ error: 'Invalid browser Marketplace' }, 400);
    }

    const marketplace = mpParsed.data;
    if (deps.onResetBrowserProfile) {
      await deps.onResetBrowserProfile(marketplace);
    }

    const profileDir = getProfileDir(dataDir, marketplace);
    if (fs.existsSync(profileDir)) {
      fs.rmSync(profileDir, { recursive: true, force: true });
    }

    return c.json({
      reset: true,
      marketplace,
      ...buildSettingsResponse(),
    });
  });

  app.post('/api/system/shutdown', async (c) => {
    await shutdown();
    if (deps.onShutdown) {
      await deps.onShutdown();
    }
    return c.json({ ok: true, shuttingDown: true });
  });

  const staticDir = path.resolve(deps.staticDir ?? path.resolve(process.cwd(), 'dist', 'client'));
  const indexHtmlPath = path.join(staticDir, 'index.html');
  if (fs.existsSync(indexHtmlPath)) {
    const contentTypes: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.mjs': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.ico': 'image/x-icon',
    };

    app.get('*', async (c, next) => {
      if (c.req.path.startsWith('/api/')) {
        return next();
      }
      const relativePath = c.req.path.replace(/^\/+/, '');
      if (relativePath) {
        const candidate = path.resolve(staticDir, relativePath);
        const insideStaticDir =
          candidate.startsWith(staticDir + path.sep) && fs.existsSync(candidate) && fs.statSync(candidate).isFile();
        if (insideStaticDir) {
          const ext = path.extname(candidate).toLowerCase();
          const mime = contentTypes[ext] ?? 'application/octet-stream';
          const bytes = fs.readFileSync(candidate);
          return c.body(bytes, 200, { 'Content-Type': mime });
        }
      }
      const html = fs.readFileSync(indexHtmlPath, 'utf8');
      return c.html(html);
    });
  }

  return {
    app,
    db: database.db,
    database,
    dataDir,
    secretsStore,
    registerTeardown,
    shutdown,
  };
}
