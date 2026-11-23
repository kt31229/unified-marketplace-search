import { serve, type ServerType } from '@hono/node-server';
import { createApp, type AppInstance, type CreateAppDeps } from './app.ts';

export const BIND_HOST = '127.0.0.1';
export const DEFAULT_PORT = 4173;

export function parseServerPort(raw?: string): number {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return DEFAULT_PORT;
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid UMS_PORT value: "${raw}". Expected an integer between 0 and 65535.`);
  }
  return parsed;
}

export interface StartServerOptions extends Omit<CreateAppDeps, 'onShutdown'> {
  port?: number;
  registerSignalHandlers?: boolean;
  exitProcess?: (code: number) => void;
}

export interface RunningServer {
  server: ServerType;
  appInstance: AppInstance;
  port: number;
  url: string;
  stop: () => Promise<void>;
}

/**
 * Starts the Hono HTTP server bound exclusively to 127.0.0.1 and manages graceful shutdown.
 */
export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  const env = options.env ?? process.env;
  const port = options.port ?? parseServerPort(env.UMS_PORT);
  const exitProcess = options.exitProcess ?? ((code: number) => process.exit(code));
  const registerSignals = options.registerSignalHandlers ?? true;

  let serverRef: ServerType | undefined;
  let stopped = false;

  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    detachSignals();

    await appInstance.shutdown();

    if (serverRef) {
      await new Promise<void>((resolve) => {
        serverRef?.close(() => resolve());
      });
    }
  };

  const appInstance = createApp({
    dataDir: options.dataDir,
    env,
    staticDir: options.staticDir,
    onOpenBrowserSession: options.onOpenBrowserSession,
    onResetBrowserProfile: options.onResetBrowserProfile,
    isBrowserContextActive: options.isBrowserContextActive,
    verifyEbayCredentials: options.verifyEbayCredentials,
    onShutdown: () => {
      setTimeout(() => {
        void stop().then(() => exitProcess(0));
      }, 15);
    },
  });

  const handleSignal = () => {
    void stop().then(() => exitProcess(0));
  };

  const detachSignals = () => {
    if (registerSignals) {
      process.off('SIGINT', handleSignal);
      process.off('SIGTERM', handleSignal);
    }
  };

  if (registerSignals) {
    process.on('SIGINT', handleSignal);
    process.on('SIGTERM', handleSignal);
  }

  const server = await new Promise<ServerType>((resolve, reject) => {
    const srv = serve(
      {
        fetch: appInstance.app.fetch,
        hostname: BIND_HOST,
        port,
      },
      () => {
        resolve(srv);
      },
    );
    srv.on('error', reject);
  });

  serverRef = server;
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;

  return {
    server,
    appInstance,
    port: actualPort,
    url: `http://${BIND_HOST}:${actualPort}`,
    stop,
  };
}
