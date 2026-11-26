import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseServerPort, startServer, type RunningServer } from '../../src/server/server.ts';

const tempDirs: string[] = [];
const runningServers: RunningServer[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (runningServers.length > 0) {
    const srv = runningServers.pop();
    if (srv) {
      await srv.stop();
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('parseServerPort', () => {
  it('defaults to 4173 and honors valid UMS_PORT overrides', () => {
    expect(parseServerPort(undefined)).toBe(4173);
    expect(parseServerPort('')).toBe(4173);
    expect(parseServerPort('4999')).toBe(4999);
    expect(() => parseServerPort('not-a-port')).toThrow();
    expect(() => parseServerPort('70000')).toThrow();
  });
});

describe('startServer lifecycle & 127.0.0.1 binding', () => {
  it('binds strictly to 127.0.0.1, serves SPA static files alongside /api/*, and shuts down cleanly', async () => {
    const dataDir = createTempDir('ums-srv-data-');
    const staticDir = createTempDir('ums-srv-static-');
    fs.mkdirSync(path.join(staticDir, 'assets'), { recursive: true });
    fs.writeFileSync(
      path.join(staticDir, 'index.html'),
      '<!doctype html><html><body>UMS App</body></html>',
    );
    fs.writeFileSync(path.join(staticDir, 'assets', 'main.js'), 'console.log("ok");');

    const exitSpy = vi.fn();
    const running = await startServer({
      port: 0,
      dataDir,
      staticDir,
      env: {},
      exitProcess: exitSpy,
      registerSignalHandlers: false,
    });
    runningServers.push(running);

    const addr = running.server.address() as AddressInfo;
    expect(addr.address).toBe('127.0.0.1');
    expect(addr.port).toBeGreaterThan(0);

    const baseUrl = `http://127.0.0.1:${addr.port}`;
    const healthRes = await fetch(`${baseUrl}/api/health`);
    expect(healthRes.status).toBe(200);
    expect(await healthRes.json()).toEqual({ ok: true, bindHost: '127.0.0.1' });

    const htmlRes = await fetch(`${baseUrl}/`);
    expect(htmlRes.status).toBe(200);
    expect(await htmlRes.text()).toContain('UMS App');

    const assetRes = await fetch(`${baseUrl}/assets/main.js`);
    expect(assetRes.status).toBe(200);
    expect(assetRes.headers.get('content-type')).toContain('javascript');
    expect(await assetRes.text()).toContain('console.log("ok")');

    const shutdownRes = await fetch(`${baseUrl}/api/system/shutdown`, { method: 'POST' });
    expect(shutdownRes.status).toBe(200);
    expect(await shutdownRes.json()).toEqual({ ok: true, shuttingDown: true });

    // Wait briefly for deferred server close & exit hook
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(exitSpy).toHaveBeenCalledWith(0);
    runningServers.pop();
  });
});
