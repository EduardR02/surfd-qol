import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
for (const name of ['manifest.json', 'background.js', 'instrument.js']) await copyFile(`extension/${name}`, `dist/${name}`);
for (const [entry, name] of [['src/main.js', 'page.js'], ['src/bridge.js', 'bridge.js']]) {
  const result = await Bun.build({ entrypoints: [entry], outdir: 'dist', naming: name, target: 'browser', format: 'iife', minify: false });
  if (!result.success) throw new AggregateError(result.logs, `Failed to build ${name}`);
}
console.log('Chrome extension built: dist/');
