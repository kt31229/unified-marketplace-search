import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import {
  BROWSER_MARKETPLACE_IDS,
  BrowserMarketplaceIdSchema,
  UpdateEbayCredentialsInputSchema,
  UpdateSettingsInputSchema,
  type BrowserMarketplaceId,
  type BrowserProfileStatus,
  type SettingsResponse,
} from '../shared/index.ts';
import { openDatabase, type AppDatabase } from './db.ts';
import { ensureBaseDirectories, getProfileDir, resolveDataDir } from './paths.ts';
import { SecretsStore, type RawEbayCredentials } from './secrets.ts';

export type TeardownHook = () => Promise<void> | void;

export interface CreateAppDeps {
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  staticDir?: string;
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

  const registerTeardown = (hook: TeardownHook) => {
    teardownHooks.push(hook);
  };

  const shutdown = async () => {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;

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

    return c.json(
      {
        valid: false,
        origin: creds.origin,
        error: 'Live eBay OAuth verification is implemented in Ticket #17.',
      },
      501,
    );
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
