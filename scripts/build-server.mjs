import { build } from 'esbuild';

await build({
  entryPoints: ['src/server/index.ts', 'src/server/launcher.ts'],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  packages: 'external',
  outdir: 'dist/server',
  sourcemap: true,
});
