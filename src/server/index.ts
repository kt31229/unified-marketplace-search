import { defaultOpenUrl } from './launcher.ts';
import { startServer } from './server.ts';

const shouldOpen =
  process.argv.includes('--open') ||
  process.env.UMS_OPEN === '1' ||
  process.env.UMS_OPEN === 'true';

const running = await startServer();
console.log(`Unified Marketplace Search listening on ${running.url}`);
console.log(`Data directory: ${running.appInstance.dataDir}`);

if (shouldOpen) {
  await defaultOpenUrl(running.url);
}
