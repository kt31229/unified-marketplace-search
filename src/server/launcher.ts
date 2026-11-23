import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FetchLike } from './adapters/types.ts';
import { buildLocalUrl, checkUmsHealth, defaultOpenUrl } from './launch-helpers.ts';
import { BIND_HOST, parseServerPort } from './server.ts';

export { buildLocalUrl, checkUmsHealth, defaultOpenUrl } from './launch-helpers.ts';

export interface SpawnedServerHandle {
  pid?: number;
  exitedEarly?: Promise<number | null>;
  unref?: () => void;
}

export interface LaunchAppOptions {
  port?: number;
  env?: NodeJS.ProcessEnv;
  serverEntryPath?: string;
  fetchImpl?: FetchLike;
  probePortOpen?: (host: string, port: number) => Promise<boolean>;
  spawnServer?: (
    serverEntryPath: string,
    env: NodeJS.ProcessEnv,
    args?: string[],
  ) => SpawnedServerHandle;
  openUrl?: (url: string) => Promise<void> | void;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
  probeTimeoutMs?: number;
}

export interface LaunchAppResult {
  action: 'opened_existing' | 'started_and_opened';
  port: number;
  url: string;
}

export async function defaultProbePortOpen(
  host: string,
  port: number,
  timeoutMs = 500,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (result: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function defaultSpawnServer(
  serverEntryPath: string,
  env: NodeJS.ProcessEnv,
  args: string[] = ['--no-open'],
): SpawnedServerHandle {
  const child = spawn(process.execPath, [serverEntryPath, ...args], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env,
  });

  const exitedEarly = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
    child.once('error', () => resolve(1));
  });

  return {
    pid: child.pid,
    exitedEarly,
    unref: () => {
      child.removeAllListeners('exit');
      child.removeAllListeners('error');
      child.unref();
    },
  };
}

/**
 * Probes 127.0.0.1:<port> for an active Unified Marketplace Search instance;
 * opens the existing URL if bound, or starts the server, waits for /api/health, and opens it.
 */
export async function launchApp(options: LaunchAppOptions = {}): Promise<LaunchAppResult> {
  const env = options.env ?? process.env;
  const port = options.port ?? parseServerPort(env.UMS_PORT);
  const url = buildLocalUrl(port);
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const probePortOpen = options.probePortOpen ?? defaultProbePortOpen;
  const openUrl = options.openUrl ?? defaultOpenUrl;
  const probeTimeoutMs = options.probeTimeoutMs ?? 1_500;

  if (await checkUmsHealth(url, fetchImpl, probeTimeoutMs)) {
    await openUrl(url);
    return {
      action: 'opened_existing',
      port,
      url,
    };
  }

  if (await probePortOpen(BIND_HOST, port)) {
    throw new Error(
      `Port ${port} on ${BIND_HOST} is already in use by another process.`,
    );
  }

  const spawnServer = options.spawnServer ?? defaultSpawnServer;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const clock = options.clock ?? (() => Date.now());
  const readyTimeoutMs = options.readyTimeoutMs ?? 15_000;
  const pollIntervalMs = options.pollIntervalMs ?? 150;
  const serverEntryPath =
    options.serverEntryPath ?? path.resolve(process.cwd(), 'dist', 'server', 'index.js');

  const child = spawnServer(serverEntryPath, env, ['--no-open']);
  let earlyExitCode: number | null | undefined;
  void child.exitedEarly?.then((code) => {
    earlyExitCode = code;
  });

  const deadline = clock() + readyTimeoutMs;
  while (clock() <= deadline) {
    if (earlyExitCode !== undefined) {
      throw new Error(
        `Server process exited prematurely (code ${earlyExitCode ?? 'unknown'}) before ${url}/api/health became ready.`,
      );
    }
    if (await checkUmsHealth(url, fetchImpl, probeTimeoutMs)) {
      child.unref?.();
      await openUrl(url);
      return {
        action: 'started_and_opened',
        port,
        url,
      };
    }
    await sleep(pollIntervalMs);
  }

  throw new Error(`Timed out waiting for ${url}/api/health to become ready.`);
}

const isMainModule =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMainModule) {
  launchApp()
    .then((res) => {
      console.log(
        res.action === 'opened_existing'
          ? `Unified Marketplace Search already running at ${res.url}; opened browser.`
          : `Started Unified Marketplace Search at ${res.url}; opened browser.`,
      );
      process.exit(0);
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
