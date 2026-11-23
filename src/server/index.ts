import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FetchLike } from './adapters/types.ts';
import { buildLocalUrl, checkUmsHealth, defaultOpenUrl } from './launch-helpers.ts';
import { parseServerPort, startServer, type RunningServer } from './server.ts';

export interface RunServerEntrypointOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  probeTimeoutMs?: number;
  startServerImpl?: typeof startServer;
  openUrl?: (url: string) => Promise<void> | void;
  log?: (message: string) => void;
}

export interface RunServerEntrypointResult {
  action: 'opened_existing' | 'started';
  port: number;
  url: string;
  openedBrowser: boolean;
  running?: RunningServer;
}

/**
 * CLI entrypoint for `npm start`: probes 127.0.0.1:<port>/api/health first so
 * an already-running instance simply opens/focuses the browser URL and exits 0;
 * otherwise starts the server in the foreground (preserving Ctrl+C shutdown)
 * and opens the browser unless `--no-open` or `UMS_NO_OPEN=1` is set.
 */
export async function runServerEntrypoint(
  options: RunServerEntrypointOptions = {},
): Promise<RunServerEntrypointResult> {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const port = parseServerPort(env.UMS_PORT);
  const url = buildLocalUrl(port);
  const noOpen =
    argv.includes('--no-open') ||
    env.UMS_NO_OPEN === '1' ||
    env.UMS_NO_OPEN === 'true';

  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const probeTimeoutMs = options.probeTimeoutMs ?? 1_500;
  const openUrl = options.openUrl ?? defaultOpenUrl;
  const log = options.log ?? ((message: string) => console.log(message));
  const startServerImpl = options.startServerImpl ?? startServer;

  if (port > 0 && (await checkUmsHealth(url, fetchImpl, probeTimeoutMs))) {
    if (!noOpen) {
      await openUrl(url);
    }
    log(
      noOpen
        ? `Unified Marketplace Search is already running on ${url}.`
        : `Unified Marketplace Search is already running on ${url}; opened browser.`,
    );
    return {
      action: 'opened_existing',
      port,
      url,
      openedBrowser: !noOpen,
    };
  }

  const running = await startServerImpl({ env, port });
  log(`Unified Marketplace Search listening on ${running.url}`);
  log(`Data directory: ${running.appInstance.dataDir}`);

  if (!noOpen) {
    await openUrl(running.url);
  }

  return {
    action: 'started',
    port: running.port,
    url: running.url,
    openedBrowser: !noOpen,
    running,
  };
}

const isMainModule =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMainModule) {
  runServerEntrypoint()
    .then((result) => {
      if (result.action === 'opened_existing') {
        process.exit(0);
      }
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
