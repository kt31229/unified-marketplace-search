import { vi } from 'vitest';

const ALLOWED_LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const originalFetch = globalThis.fetch.bind(globalThis);

function extractRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const rawUrl = extractRequestUrl(input);
  let parsed: URL;
  try {
    parsed = new URL(rawUrl, 'http://127.0.0.1');
  } catch {
    throw new Error(`[offline-guardrail] Unmocked fetch with invalid URL during npm test: ${rawUrl}`);
  }

  if (!ALLOWED_LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error(
      `[offline-guardrail] Unmocked external fetch blocked during npm test: ${rawUrl}. Inject/mock fetch instead.`,
    );
  }

  return originalFetch(input, init);
}) as typeof globalThis.fetch;

function blockedBrowserLaunch(): never {
  throw new Error(
    '[offline-guardrail] Real patchright browser launch blocked during npm test. Inject a mock BrowserTransport instead.',
  );
}

vi.mock('patchright', () => ({
  chromium: {
    launch: async () => blockedBrowserLaunch(),
    launchPersistentContext: async () => blockedBrowserLaunch(),
  },
}));
