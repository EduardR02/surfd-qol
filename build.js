import { mkdir, copyFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
await mkdir('dist', { recursive: true });
for (const name of ['manifest.json', 'background.js', 'touch-history.js', 'instrument.js', 'collision-world.js', 'collision-tree.js', 'replay-index-worker.js', 'stage-reset-hooks.js', 'map-load-hooks.js', 'map-worker-hooks.js', 'map-floor-hooks.js', 'map-preparation-hooks.js', 'map-entry-hooks.js', 'native-world-contracts.js', 'map-load-worker.js', 'map-asset-worker.js', 'sky-resample.js', 'progressive-map-hooks.js', 'progressive-assets.js', 'progressive-textures.js', 'bsp-shader-signature.js', 'native-room-hooks.js', 'native-saveloc-hooks.js', 'source-loader.js', 'update-check.js']) await copyFile(`extension/${name}`, `dist/${name}`);
// The bundled HUD font (Instrument Sans, subset) ships with its licence.
await copyFile('docs/fonts/OFL.txt', 'dist/InstrumentSans-OFL.txt');
await copyFile('LICENSE', 'dist/LICENSE');
await copyFile('src/private-rooms/chat-filter-notice.txt', 'dist/chat-filter-notice.txt');
// Only the replay-analysis dependency closure invalidates saved PB/WR results.
// Keep this list in sync with replay-store.js and its analysis imports, so a change to any of them invalidates saved results.
const sources = ['metrics.js', 'observer.js', 'replay-store.js', 'start.js', 'surfaces.js'];
const hash = createHash('sha256');
for (const name of sources) hash.update(name).update(await readFile(`src/${name}`));
// Cached collision records are rebuilt whenever their encoding or derived data can change.
const mapHash = createHash('sha256');
for (const path of ['src/map-cache.js', 'src/map-ramp-preparation.js', 'src/surfaces.js', 'extension/map-bvh-preparation.js', 'extension/collision-tree.js']) mapHash.update(path).update(await readFile(path));
const define = { __QOL_ANALYSIS__: JSON.stringify(hash.digest('hex').slice(0, 16)), __QOL_MAP_CACHE__: JSON.stringify(mapHash.digest('hex').slice(0, 16)) };
for (const [entry, name] of [['src/main.js', 'page.js'], ['src/bridge.js', 'bridge.js'], ['src/cinema-worker.js', 'cinema-worker.js'], ['src/map-load-worker-entry.js', 'map-preparation-worker.js']]) {
  const result = await Bun.build({ entrypoints: [entry], outdir: 'dist', naming: name, target: 'browser', format: 'iife', minify: false, define });
  if (!result.success) throw new AggregateError(result.logs, `Failed to build ${name}`);
}
console.log('Chrome extension built: dist/');
