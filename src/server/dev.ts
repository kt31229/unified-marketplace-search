import { spawn } from 'node:child_process';
import { startServer } from './server.ts';

const running = await startServer();
console.log(`API server listening on ${running.url}`);
console.log(`Data directory: ${running.appInstance.dataDir}`);

const viteBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const viteProcess = spawn(viteBin, ['vite'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

viteProcess.on('exit', (code) => {
  void running.stop().then(() => process.exit(code ?? 0));
});
