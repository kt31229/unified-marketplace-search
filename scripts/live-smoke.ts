import { createEbayAdapter } from '../src/server/adapters/ebay.ts';
import { createFacebookAdapter } from '../src/server/adapters/facebook.ts';
import { createMercariAdapter } from '../src/server/adapters/mercari.ts';
import { createPoshmarkAdapter } from '../src/server/adapters/poshmark.ts';
import { BrowserSessionManager } from '../src/server/browser-session-manager.ts';
import { openDatabase } from '../src/server/db.ts';
import { parseLiveSmokeArgs, runLiveSmoke } from '../src/server/live-smoke.ts';
import { ensureBaseDirectories, resolveDataDir } from '../src/server/paths.ts';
import { SecretsStore } from '../src/server/secrets.ts';

function printHelp(): void {
  console.log(
    [
      'Unified Marketplace Search — Manual Opt-In Live Smoke Check',
      '',
      'Usage:',
      '  npm run smoke:live [-- --query="patagonia jacket" --marketplaces=ebay,poshmark,mercari,facebook]',
      '  npx tsx scripts/live-smoke.ts --yes [--query="..."] [--marketplaces=...]',
      '',
      'Options:',
      '  --yes, -y                 Explicitly opt in to live Marketplace requests',
      '  --query=<keywords>        Search query (default: "patagonia jacket")',
      '  --marketplaces=<csv>      Comma-separated: ebay,poshmark,mercari,facebook',
      '  --help, -h                Show this help message',
    ].join('\n'),
  );
}

async function main(): Promise<number> {
  if (process.env.VITEST || process.env.CI === 'true' || process.env.CI === '1') {
    console.error('Refusing to run live Marketplace smoke check inside Vitest/CI.');
    return 1;
  }

  const parsed = parseLiveSmokeArgs(process.argv.slice(2), process.env);
  if (parsed.help) {
    printHelp();
    return 0;
  }

  const dataDir = resolveDataDir({ env: process.env });
  ensureBaseDirectories(dataDir);

  const database = openDatabase(dataDir);
  const secretsStore = new SecretsStore(dataDir, process.env);
  const settings = database.settings.getSettings();
  const ebayCredentials = secretsStore.getRawCredentials();

  const browserSessionManager = new BrowserSessionManager({
    dataDir,
    getBrowserChannel: () => database.settings.getSettings().browserChannel,
  });

  try {
    const result = await runLiveSmoke({
      query: parsed.query,
      marketplaces: parsed.marketplaces,
      settings,
      ebayCredentials,
      adapters: {
        ebay: createEbayAdapter(),
        poshmark: createPoshmarkAdapter({ browserSessionManager }),
        mercari: createMercariAdapter({ browserSessionManager }),
        facebook: createFacebookAdapter({ browserSessionManager }),
      },
    });

    console.log(result.report);
    return result.exitCode;
  } finally {
    await browserSessionManager.shutdown();
    database.close();
  }
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
