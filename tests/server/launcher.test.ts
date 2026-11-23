import { describe, expect, it, vi } from 'vitest';
import { runServerEntrypoint } from '../../src/server/index.ts';
import { launchApp } from '../../src/server/launcher.ts';
import type { RunningServer } from '../../src/server/server.ts';

describe('launchApp', () => {
  it('opens the existing URL and does not spawn a duplicate server when /api/health reports UMS is already running', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('http://127.0.0.1:4173/api/health');
      return new Response(JSON.stringify({ ok: true, bindHost: '127.0.0.1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const probePortOpen = vi.fn(async () => true);
    const spawnServer = vi.fn();
    const openUrl = vi.fn(async () => {});

    const result = await launchApp({
      env: {},
      fetchImpl,
      probePortOpen,
      spawnServer,
      openUrl,
    });

    expect(result).toEqual({
      action: 'opened_existing',
      port: 4173,
      url: 'http://127.0.0.1:4173',
    });
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:4173');
    expect(spawnServer).not.toHaveBeenCalled();
  });

  it('spawns the server on cold start, polls /api/health until ready, unrefs child, and opens the URL (honoring UMS_PORT)', async () => {
    let healthAttempts = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('http://127.0.0.1:4999/api/health');
      healthAttempts++;
      if (healthAttempts < 3) {
        throw new Error('ECONNREFUSED');
      }
      return new Response(JSON.stringify({ ok: true, bindHost: '127.0.0.1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const probePortOpen = vi.fn(async () => false);
    const unrefSpy = vi.fn();
    const spawnServer = vi.fn(() => ({
      pid: 12345,
      exitedEarly: new Promise<number | null>(() => {}),
      unref: unrefSpy,
    }));
    const openUrl = vi.fn(async () => {});
    const sleep = vi.fn(async () => {});

    const result = await launchApp({
      env: { UMS_PORT: '4999' },
      serverEntryPath: 'C:/repo/dist/server/index.js',
      fetchImpl,
      probePortOpen,
      spawnServer,
      openUrl,
      sleep,
      pollIntervalMs: 10,
      readyTimeoutMs: 5000,
    });

    expect(result).toEqual({
      action: 'started_and_opened',
      port: 4999,
      url: 'http://127.0.0.1:4999',
    });
    expect(probePortOpen).toHaveBeenCalledWith('127.0.0.1', 4999);
    expect(spawnServer).toHaveBeenCalledTimes(1);
    expect(spawnServer).toHaveBeenCalledWith(
      'C:/repo/dist/server/index.js',
      { UMS_PORT: '4999' },
      ['--no-open'],
    );
    expect(unrefSpy).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:4999');
  });

  it('rejects cleanly without spawning or opening if the port is already bound by a non-UMS process', async () => {
    const fetchImpl = vi.fn(async () => new Response('not ums', { status: 404 }));
    const probePortOpen = vi.fn(async () => true);
    const spawnServer = vi.fn();
    const openUrl = vi.fn();

    await expect(
      launchApp({
        env: { UMS_PORT: '4173' },
        fetchImpl,
        probePortOpen,
        spawnServer,
        openUrl,
      }),
    ).rejects.toThrow(/already in use/i);

    expect(spawnServer).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('fails fast without opening URL if the spawned server exits before /api/health is ready', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const probePortOpen = vi.fn(async () => false);
    const spawnServer = vi.fn(() => ({
      pid: 999,
      exitedEarly: Promise.resolve(1),
      unref: vi.fn(),
    }));
    const openUrl = vi.fn();
    const sleep = vi.fn(async () => {});

    await expect(
      launchApp({
        env: {},
        fetchImpl,
        probePortOpen,
        spawnServer,
        openUrl,
        sleep,
        readyTimeoutMs: 5000,
      }),
    ).rejects.toThrow(/exited prematurely/i);

    expect(openUrl).not.toHaveBeenCalled();
  });

  it('times out without opening URL if /api/health never becomes ready', async () => {
    let nowMs = 0;
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const probePortOpen = vi.fn(async () => false);
    const spawnServer = vi.fn(() => ({
      pid: 999,
      exitedEarly: new Promise<number | null>(() => {}),
      unref: vi.fn(),
    }));
    const openUrl = vi.fn();
    const sleep = vi.fn(async (ms: number) => {
      nowMs += ms;
    });

    await expect(
      launchApp({
        env: {},
        fetchImpl,
        probePortOpen,
        spawnServer,
        openUrl,
        sleep,
        clock: () => nowMs,
        pollIntervalMs: 100,
        readyTimeoutMs: 250,
      }),
    ).rejects.toThrow(/timed out/i);

    expect(openUrl).not.toHaveBeenCalled();
  });
});

describe('runServerEntrypoint (npm start)', () => {
  function createStubRunningServer(port: number): RunningServer {
    return {
      server: {} as RunningServer['server'],
      appInstance: {
        dataDir: 'C:/tmp/ums-data',
      } as RunningServer['appInstance'],
      port,
      url: `http://127.0.0.1:${port}`,
      stop: vi.fn(async () => {}),
    };
  }

  it('probes /api/health, opens the URL, and skips starting a second server when UMS is already running', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('http://127.0.0.1:4173/api/health');
      return new Response(JSON.stringify({ ok: true, bindHost: '127.0.0.1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const startServerImpl = vi.fn();
    const openUrl = vi.fn(async () => {});
    const log = vi.fn();

    const result = await runServerEntrypoint({
      argv: [],
      env: {},
      fetchImpl,
      startServerImpl,
      openUrl,
      log,
    });

    expect(result).toEqual({
      action: 'opened_existing',
      port: 4173,
      url: 'http://127.0.0.1:4173',
      openedBrowser: true,
    });
    expect(startServerImpl).not.toHaveBeenCalled();
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:4173');
  });

  it('starts the server in the foreground and auto-opens the default browser when not already running', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const stubRunning = createStubRunningServer(4321);
    const startServerImpl = vi.fn(async () => stubRunning);
    const openUrl = vi.fn(async () => {});
    const log = vi.fn();

    const result = await runServerEntrypoint({
      argv: [],
      env: { UMS_PORT: '4321' },
      fetchImpl,
      startServerImpl,
      openUrl,
      log,
    });

    expect(result.action).toBe('started');
    expect(result.port).toBe(4321);
    expect(result.url).toBe('http://127.0.0.1:4321');
    expect(result.openedBrowser).toBe(true);
    expect(startServerImpl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:4321');
  });

  it('suppresses auto-open when --no-open or UMS_NO_OPEN=1 is passed', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const startServerImpl = vi.fn(async () => createStubRunningServer(4173));
    const openUrl = vi.fn(async () => {});
    const log = vi.fn();

    const flagRes = await runServerEntrypoint({
      argv: ['--no-open'],
      env: {},
      fetchImpl,
      startServerImpl,
      openUrl,
      log,
    });
    expect(flagRes.action).toBe('started');
    expect(flagRes.openedBrowser).toBe(false);
    expect(openUrl).not.toHaveBeenCalled();

    const envRes = await runServerEntrypoint({
      argv: [],
      env: { UMS_NO_OPEN: '1' },
      fetchImpl,
      startServerImpl,
      openUrl,
      log,
    });
    expect(envRes.action).toBe('started');
    expect(envRes.openedBrowser).toBe(false);
    expect(openUrl).not.toHaveBeenCalled();
  });
});
