import { mkdir, copyFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
await mkdir('dist', { recursive: true });
for (const name of ['manifest.json', 'background.js', 'instrument.js', 'collision-world.js', 'stage-reset-hooks.js', 'native-room-hooks.js', 'native-saveloc-hooks.js', 'source-loader.js', 'update-check.js']) await copyFile(`extension/${name}`, `dist/${name}`);
// The bundled HUD font (Instrument Sans, subset) ships with its licence.
await copyFile('docs/fonts/OFL.txt', 'dist/InstrumentSans-OFL.txt');
await copyFile('LICENSE', 'dist/LICENSE');
await copyFile('src/private-rooms/chat-filter-notice.txt', 'dist/chat-filter-notice.txt');
// Only the replay-analysis dependency closure invalidates saved PB/WR results.
// Keep this list in sync with replay-store.js and its analysis imports, so a change to any of them invalidates saved results.
const sources = ['metrics.js', 'observer.js', 'replay-store.js', 'start.js', 'surfaces.js'];
const hash = createHash('sha256');
for (const name of sources) hash.update(name).update(await readFile(`src/${name}`));
const define = { __QOL_ANALYSIS__: JSON.stringify(hash.digest('hex').slice(0, 16)) };
for (const [entry, name] of [['src/main.js', 'page.js'], ['src/bridge.js', 'bridge.js']]) {
  const result = await Bun.build({ entrypoints: [entry], outdir: 'dist', naming: name, target: 'browser', format: 'iife', minify: false, define });
  if (!result.success) throw new AggregateError(result.logs, `Failed to build ${name}`);
}
console.log('Chrome extension built: dist/');
