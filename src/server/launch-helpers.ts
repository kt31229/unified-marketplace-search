import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { FetchLike } from './adapters/types.ts';
import { BIND_HOST } from './server.ts';

export interface DefaultOpenUrlDeps {
  env?: NodeJS.ProcessEnv;
  existsSync?: (p: string) => boolean;
  spawnImpl?: typeof spawn;
}

export function buildLocalUrl(port: number): string {
  return `http://${BIND_HOST}:${port}`;
}

export async function checkUmsHealth(
  url: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${url}/api/health`, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!res.ok) {
      return false;
    }
    const json = (await res.json()) as { ok?: unknown; bindHost?: unknown } | null;
    return Boolean(json && json.ok === true && json.bindHost === BIND_HOST);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function findChromeExecutable(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  existsSync: (p: string) => boolean,
): string | null {
  if (platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA];
    for (const root of roots) {
      if (!root) continue;
      const candidate = path.win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe');
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  if (platform === 'darwin') {
    const macApp = '/Applications/Google Chrome.app';
    return existsSync(macApp) ? macApp : null;
  }

  return null;
}

export async function defaultOpenUrl(
  rawUrl: string,
  platform: NodeJS.Platform = process.platform,
  deps: DefaultOpenUrlDeps = {},
): Promise<void> {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Refusing to open unsupported URL protocol: ${parsed.protocol}`);
  }
  const safeUrl = parsed.toString();
  const env = deps.env ?? process.env;
  const existsSync = deps.existsSync ?? fs.existsSync;
  const spawnImpl = deps.spawnImpl ?? spawn;

  if (platform === 'win32') {
    const chromePath = findChromeExecutable('win32', env, existsSync);
    if (chromePath) {
      const child = spawnImpl(chromePath, [safeUrl], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return;
    }

    const child = spawnImpl('cmd', ['/c', 'start', '', safeUrl], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return;
  }

  if (platform === 'darwin') {
    const chromeApp = findChromeExecutable('darwin', env, existsSync);
    const args = chromeApp ? ['-a', 'Google Chrome', safeUrl] : [safeUrl];
    const child = spawnImpl('open', args, {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return;
  }

  const child = spawnImpl('xdg-open', [safeUrl], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}
