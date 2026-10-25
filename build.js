import { mkdir, copyFile, readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
await mkdir('dist', { recursive: true });
for (const name of ['manifest.json', 'background.js', 'instrument.js', 'update-check.js']) await copyFile(`extension/${name}`, `dist/${name}`);
// The bundled HUD font (Instrument Sans, subset) ships with its licence.
await copyFile('docs/fonts/OFL.txt', 'dist/InstrumentSans-OFL.txt');
await copyFile('LICENSE', 'dist/LICENSE');
// Saved PB/WR analysis is keyed by the source it was made with (replay-store.js).
const sources = (await readdir('src')).filter(name => name.endsWith('.js')).sort();
const hash = createHash('sha256');
for (const name of sources) hash.update(name).update(await readFile(`src/${name}`));
const define = { __QOL_ANALYSIS__: JSON.stringify(hash.digest('hex').slice(0, 16)) };
for (const [entry, name] of [['src/main.js', 'page.js'], ['src/bridge.js', 'bridge.js']]) {
  const result = await Bun.build({ entrypoints: [entry], outdir: 'dist', naming: name, target: 'browser', format: 'iife', minify: false, define });
  if (!result.success) throw new AggregateError(result.logs, `Failed to build ${name}`);
}
console.log('Chrome extension built: dist/');
