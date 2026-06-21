import { build, context } from 'esbuild';
import { rm, mkdir, copyFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const watch = process.argv.includes('--watch');
const outdir = 'dist';

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const shared = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  sourcemap: true,
  target: ['es2022'],
  loader: { '.css': 'text' },
  logLevel: 'info',
};

const esm = {
  ...shared,
  format: 'esm',
  outfile: `${outdir}/liveinterface.esm.js`,
};

const iife = {
  ...shared,
  format: 'iife',
  globalName: 'LiveInterface',
  outfile: `${outdir}/liveinterface.iife.js`,
};

if (watch) {
  const a = await context(esm);
  const b = await context(iife);
  await Promise.all([a.watch(), b.watch()]);
  console.log('watching…');
} else {
  await Promise.all([build(esm), build(iife)]);
  // Copy demo-served CSS for now (theme stylesheet emitted from TS via tagged template)
  await copyFile('src/core/theme.css', `${outdir}/liveinterface.css`).catch(() => {});
  console.log('built', outdir);
}
