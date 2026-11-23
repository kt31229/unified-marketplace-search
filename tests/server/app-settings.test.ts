import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, type AppInstance } from '../../src/server/app.ts';
import { resolveDataDir } from '../../src/server/paths.ts';

const tempDirs: string[] = [];
const activeApps: AppInstance[] = [];

function createTempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ums-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (activeApps.length > 0) {
    const instance = activeApps.pop();
    if (instance) {
      await instance.shutdown();
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('resolveDataDir', () => {
  it('prefers UMS_DATA_DIR override when set', () => {
    const customDir = path.join('C:', 'custom', 'ums-data');
    const resolved = resolveDataDir({
      env: { UMS_DATA_DIR: customDir },
      platform: 'win32',
      homeDir: 'C:\\Users\\test',
    });
    expect(resolved).toBe(path.resolve(customDir));
  });

  it('uses LOCALAPPDATA on Windows when UMS_DATA_DIR is unset', () => {
    const resolved = resolveDataDir({
      env: { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' },
      platform: 'win32',
      homeDir: 'C:\\Users\\test',
    });
    expect(resolved).toBe(path.join('C:\\Users\\test\\AppData\\Local', 'unified-marketplace-search'));
  });

  it('uses XDG_DATA_HOME or ~/.local/share fallback on non-Windows', () => {
    const withXdg = resolveDataDir({
      env: { XDG_DATA_HOME: '/tmp/xdg-data' },
      platform: 'linux',
      homeDir: '/home/test',
    });
    expect(withXdg).toBe(path.join('/tmp/xdg-data', 'unified-marketplace-search'));

    const withoutXdg = resolveDataDir({
      env: {},
      platform: 'linux',
      homeDir: '/home/test',
    });
    expect(withoutXdg).toBe(path.join('/home/test', '.local', 'share', 'unified-marketplace-search'));
  });
});

describe('createApp persistence and /api/settings', () => {
  it('initializes WAL-mode SQLite with user_version >= 1 and seeded 8-city defaults', async () => {
    const dataDir = createTempDataDir();
    const instance = createApp({ dataDir, env: {} });
    activeApps.push(instance);

    expect(fs.existsSync(path.join(dataDir, 'data.sqlite'))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'thumbnails'))).toBe(true);

    const res = await instance.app.request('/api/settings');
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.dataDir).toBe(dataDir);
    expect(body.settings.browserChannel).toBe('chrome');
    expect(body.settings.homePostalCode).toBeNull();
    expect(body.settings.defaultLocalPickupRadiusMiles).toBe(50);
    expect(body.settings.homeFacebookCitySlug).toBeNull();
    expect(body.settings.facebookRadiusMiles).toBe(500);
    expect(body.settings.facebookCityHubs.map((h: { slug: string }) => h.slug)).toEqual([
      'seattle',
      'sanfrancisco',
      'la',
      'denver',
      'dallas',
      'chicago',
      'atlanta',
      'nyc',
    ]);
    expect(body.ebay).toEqual({
      configured: false,
      origin: 'none',
      clientId: null,
      clientSecretMasked: null,
    });

    await instance.shutdown();
    activeApps.pop();

    const inspectDb = new DatabaseSync(path.join(dataDir, 'data.sqlite'));
    try {
      const modeRow = inspectDb.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
      const versionRow = inspectDb.prepare('PRAGMA user_version').get() as { user_version: number };
      expect(modeRow.journal_mode.toLowerCase()).toBe('wal');
      expect(versionRow.user_version).toBeGreaterThanOrEqual(1);
    } finally {
      inspectDb.close();
    }
  });

  it('persists AppSettings updates across restarts and writes secrets.json without leaking raw client_secret', async () => {
    const dataDir = createTempDataDir();
    const first = createApp({ dataDir, env: {} });
    activeApps.push(first);

    const updateRes = await first.app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        settings: {
          browserChannel: 'msedge',
          homePostalCode: '98101',
          defaultLocalPickupRadiusMiles: 25,
          homeFacebookCitySlug: 'seattle',
          facebookCityHubs: [
            { slug: 'seattle', label: 'Seattle, WA', enabled: true },
            { slug: 'nyc', label: 'New York, NY', enabled: false },
          ],
        },
        ebay: {
          clientId: 'ebay-app-id-123',
          clientSecret: 'super-secret-value-a9f2',
        },
      }),
    });

    expect(updateRes.status).toBe(200);
    const updateText = await updateRes.text();
    expect(updateText).not.toContain('super-secret-value-a9f2');

    const updated = JSON.parse(updateText);
    expect(updated.settings.browserChannel).toBe('msedge');
    expect(updated.settings.homePostalCode).toBe('98101');
    expect(updated.settings.defaultLocalPickupRadiusMiles).toBe(25);
    expect(updated.settings.homeFacebookCitySlug).toBe('seattle');
    expect(updated.settings.facebookCityHubs).toEqual([
      { slug: 'seattle', label: 'Seattle, WA', enabled: true },
      { slug: 'nyc', label: 'New York, NY', enabled: false },
    ]);
    expect(updated.ebay).toEqual({
      configured: true,
      origin: 'file',
      clientId: 'ebay-app-id-123',
      clientSecretMasked: '••••••••a9f2',
    });

    const secretsRaw = JSON.parse(fs.readFileSync(path.join(dataDir, 'secrets.json'), 'utf8'));
    expect(secretsRaw).toEqual({
      ebay: {
        client_id: 'ebay-app-id-123',
        client_secret: 'super-secret-value-a9f2',
      },
    });

    await first.shutdown();
    activeApps.pop();

    const second = createApp({ dataDir, env: {} });
    activeApps.push(second);

    const getRes = await second.app.request('/api/settings');
    expect(getRes.status).toBe(200);
    const reloadedText = await getRes.text();
    expect(reloadedText).not.toContain('super-secret-value-a9f2');
    const reloaded = JSON.parse(reloadedText);
    expect(reloaded.settings.browserChannel).toBe('msedge');
    expect(reloaded.settings.homePostalCode).toBe('98101');
    expect(reloaded.ebay.clientSecretMasked).toBe('••••••••a9f2');
  });

  it('preserves existing client_secret when updating clientId via PUT /api/settings/ebay-credentials and honors env overrides', async () => {
    const dataDir = createTempDataDir();
    const instance = createApp({ dataDir, env: {} });
    activeApps.push(instance);

    await instance.app.request('/api/settings/ebay-credentials', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: 'file-client-1',
        client_secret: 'file-secret-9999',
      }),
    });

    const partialUpdate = await instance.app.request('/api/settings/ebay-credentials', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: 'file-client-2',
      }),
    });
    expect(partialUpdate.status).toBe(200);
    const partialJson = await partialUpdate.json();
    expect(partialJson.ebay).toEqual({
      configured: true,
      origin: 'file',
      clientId: 'file-client-2',
      clientSecretMasked: '••••••••9999',
    });

    await instance.shutdown();
    activeApps.pop();

    const envApp = createApp({
      dataDir,
      env: {
        EBAY_CLIENT_ID: 'env-client-id',
        EBAY_CLIENT_SECRET: 'env-secret-4321',
      },
    });
    activeApps.push(envApp);

    const envRes = await envApp.app.request('/api/settings');
    const envText = await envRes.text();
    expect(envText).not.toContain('env-secret-4321');
    expect(envText).not.toContain('file-secret-9999');
    const envJson = JSON.parse(envText);
    expect(envJson.ebay).toEqual({
      configured: true,
      origin: 'env',
      clientId: 'env-client-id',
      clientSecretMasked: '••••••••4321',
    });
  });

  it('validates invalid settings payloads with 400', async () => {
    const dataDir = createTempDataDir();
    const instance = createApp({ dataDir, env: {} });
    activeApps.push(instance);

    const res = await instance.app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        settings: {
          browserChannel: 'firefox',
        },
      }),
    });
    expect(res.status).toBe(400);
  });

  it('resets a browser profile directory and invokes registered shutdown teardown hooks cleanly', async () => {
    const dataDir = createTempDataDir();
    const profileDir = path.join(dataDir, 'profiles', 'poshmark');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'Cookies'), 'dummy');

    const teardownSpy = vi.fn();
    const shutdownSpy = vi.fn();
    const instance = createApp({
      dataDir,
      env: {},
      onShutdown: shutdownSpy,
    });
    instance.registerTeardown(teardownSpy);
    activeApps.push(instance);

    const beforeRes = await instance.app.request('/api/settings');
    const beforeJson = await beforeRes.json();
    expect(beforeJson.browserProfiles.poshmark.exists).toBe(true);
    expect(beforeJson.browserProfiles.facebook.exists).toBe(false);

    const resetRes = await instance.app.request('/api/browser/poshmark/reset-profile', {
      method: 'POST',
    });
    expect(resetRes.status).toBe(200);
    expect(fs.existsSync(profileDir)).toBe(false);

    const afterRes = await instance.app.request('/api/settings');
    const afterJson = await afterRes.json();
    expect(afterJson.browserProfiles.poshmark.exists).toBe(false);

    const shutdownRes = await instance.app.request('/api/system/shutdown', {
      method: 'POST',
    });
    expect(shutdownRes.status).toBe(200);
    const shutdownJson = await shutdownRes.json();
    expect(shutdownJson.ok).toBe(true);
    expect(teardownSpy).toHaveBeenCalledTimes(1);
    expect(shutdownSpy).toHaveBeenCalledTimes(1);

    // Verify SQLite handle is closed so opening/closing does not fail
    expect(() => instance.db.prepare('SELECT 1').get()).toThrow();
    activeApps.pop();
  });
});
