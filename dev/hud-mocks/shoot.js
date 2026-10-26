// Renders the HUD concept gallery to PNGs with headless Chrome.
//   PUPPETEER=<puppeteer ESM entry> CHROME=<chrome.exe> bun dev/hud-mocks/shoot.js [outDir] [m=2] [bg=snow]
// Writes <outDir>/sheet.png (today, every concept and the Underline mix at the chosen moment and backdrop, ×0.8) and
// <outDir>/shots/<n>-<id>.png (each concept's FULL and SURFING frames side by side, true scale; 0 is today's HUD).
// Extra flags: only=<id> to shoot one concept, mixes to include the mix suggestions,
// size=tight for a closer crop, tint=neutral|good|loss to override the speed tint.
import {resolve, join} from 'node:path';
import {mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const args = process.argv.slice(2);
const flag = name => args.find(a => a.startsWith(name + '='))?.split('=')[1];
const out = resolve(args.find(a => !a.includes('=') && !['mixes', 'pairs'].includes(a)) ?? import.meta.dir);
const m = flag('m') ?? '2', bg = flag('bg') ?? 'snow', only = flag('only'), tint = flag('tint') ?? 'auto', size = flag('size') ?? 'true';
const {default: puppeteer} = await import(process.env.PUPPETEER ?? 'puppeteer');
const page_url = pathToFileURL(join(import.meta.dir, 'index.html')).href;

await mkdir(join(out, 'shots'), {recursive: true});
const browser = await puppeteer.launch({executablePath: process.env.CHROME, headless: true, args: ['--allow-file-access-from-files']});
const page = await browser.newPage();
await page.setViewport({width: 1920, height: 1080});
const settle = async () => {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => Promise.all([...document.querySelectorAll('.stage')].slice(0, 1).map(() => new Promise(done => {
    const img = new Image(); img.onload = img.onerror = done; img.src = getComputedStyle(document.querySelector('.stage')).backgroundImage.slice(5, -2);
  }))));
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
};

await page.goto(`${page_url}?m=${m}&bg=${bg}&tint=${tint}&size=${size}${only ? `&only=${only}` : ''}`, {waitUntil: 'load'});
await settle();
const ids = await page.evaluate(() => window.HUD_MOCKS.CONCEPTS.map(c => c.id));
if (!only) {
  await (await page.$(args.includes('pairs') ? '#c-today .pair' : '#c-today')).screenshot({path: join(out, 'shots', '0-today.png')});
  console.log('0-today');
}
for (const [i, id] of ids.entries()) {
  if (only && id !== only) continue;
  const element = await page.$(args.includes('pairs') ? `#c-${id} .pair` : `#c-${id}`);
  await element.screenshot({path: join(out, 'shots', `${i + 1}-${id}.png`)});
  console.log(`${i + 1}-${id}`);
}
if (args.includes('mixes') && !only) {
  const mixes = await page.$$('.mix');
  for (const [i, element] of mixes.entries()) {
    await element.screenshot({path: join(out, 'shots', `mix-${i + 1}.png`)});
    console.log(`mix-${i + 1}`);
  }
}
if (!only) {
  await page.goto(`${page_url}?sheet&m=${m}&bg=${bg}&tint=${tint}`, {waitUntil: 'load'});
  await settle();
  const sheet = await page.$('#sheet');
  await sheet.screenshot({path: join(out, 'sheet.png')});
  console.log('sheet');
}
await browser.close();
