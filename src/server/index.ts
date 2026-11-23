import { startServer } from './server.ts';

const running = await startServer();
console.log(`Unified Marketplace Search listening on ${running.url}`);
console.log(`Data directory: ${running.appInstance.dataDir}`);
