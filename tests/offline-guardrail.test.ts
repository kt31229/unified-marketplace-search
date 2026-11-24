import { describe, expect, it } from 'vitest';

describe('offline test guardrail', () => {
  it('blocks unmocked external fetch calls', async () => {
    await expect(fetch('https://example.com/api/test')).rejects.toThrow(
      /offline-guardrail.*Unmocked external fetch blocked/,
    );
  });

  it('blocks real patchright browser launches', async () => {
    const { chromium } = await import('patchright');
    await expect(chromium.launchPersistentContext('/tmp/profile')).rejects.toThrow(
      /offline-guardrail.*Real patchright browser launch blocked/,
    );
  });
});
