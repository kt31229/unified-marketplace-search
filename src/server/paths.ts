import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserMarketplaceId } from '../shared/index.ts';

export const APP_DIR_NAME = 'unified-marketplace-search';

export interface ResolveDataDirOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
}

/**
 * Resolves the persistent data directory outside the git repository:
 * UMS_DATA_DIR override -> %LOCALAPPDATA%\unified-marketplace-search on Windows -> XDG fallback.
 */
export function resolveDataDir(options: ResolveDataDirOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();

  const override = env.UMS_DATA_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim() || path.join(homeDir, 'AppData', 'Local');
    return path.join(localAppData, APP_DIR_NAME);
  }

  const xdgDataHome = env.XDG_DATA_HOME?.trim() || path.join(homeDir, '.local', 'share');
  return path.join(xdgDataHome, APP_DIR_NAME);
}

export function getThumbnailsDir(dataDir: string): string {
  return path.join(dataDir, 'thumbnails');
}

export function getProfilesDir(dataDir: string): string {
  return path.join(dataDir, 'profiles');
}

export function getProfileDir(dataDir: string, marketplace: BrowserMarketplaceId): string {
  return path.join(dataDir, 'profiles', marketplace);
}

export function ensureBaseDirectories(dataDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(getThumbnailsDir(dataDir), { recursive: true });
  fs.mkdirSync(getProfilesDir(dataDir), { recursive: true });
}
