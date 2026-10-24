// Renders every harness state to PNGs: `bun dev/shoot.js [outDir]` (default: <tmp>/surfd-qol-shots).
// Needs Puppeteer, which this repo deliberately does not depend on:
//   PUPPETEER=<path to puppeteer's ESM entry, or a package name>  (default 'puppeteer')
//   CHROME=<path to a Chrome/Chromium executable>                 (optional)
import {mkdir} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {tmpdir} from 'node:os';
import {serve} from './serve.js';

const out = resolve(process.argv[2] ?? join(tmpdir(), 'surfd-qol-shots'));
const {default: puppeteer} = await import(process.env.PUPPETEER ?? 'puppeteer');
const server = serve(0);
const base = `http://127.0.0.1:${server.port}/dev/?shot&`;
// [file, query, width, height]
const shots = [
  ['ramp-snow', 'state=ramp&bg=snow'], ['ramp-neon', 'state=ramp&bg=neon'], ['air-stale-up-fog', 'state=air&bg=fog'],
  ['net', 'state=net&bg=warm'], ['sole-slot', 'state=sole&bg=dark'], ['no-feedback', 'state=none&bg=snow'],
  ['unavailable', 'state=unavailable&bg=warm'], ['live', 'state=live&bg=fog'],
  ['start-good', 'state=start-good&bg=dark'], ['start-bad', 'state=start-bad&bg=snow'],
  ['checkpoint', 'state=checkpoint&bg=warm'], ['practice', 'state=practice&bg=neon'], ['replay', 'state=replay&bg=fog'],
  ['spectating', 'state=spectating&bg=dark'],
  ['energy-good', 'state=energy-good&bg=dark'], ['energy-loss', 'state=energy-loss&bg=dark'], ['energy-neutral', 'state=energy-neutral&bg=dark'],
  ['scale-0.6-top', 'state=checkpoint&bg=warm&scale=0.6&y=10'], ['scale-1.6-bottom', 'state=checkpoint-start&bg=neon&scale=1.6&y=90'],
  ['scale-1.6-top-flipped', 'state=checkpoint-start&bg=fog&scale=1.6&y=10'], ['custom-palette', 'state=air&bg=snow&palette=custom'],
  ...['display', 'feedback', 'compare', 'controls', 'history'].flatMap(page => [
    [`panel-${page}`, `panel=${page}`], [`panel-${page}-540x600`, `panel=${page}`, 540, 600],
  ]),
  ['panel-custom-palette', 'panel=display&palette=custom'],
  ['runs-session', 'runs=session'], ['runs-map', 'runs=map'], ['runs-map-540x600', 'runs=map', 540, 600],
  ['runs-detail', 'runs=map&expand=fixture-6'],
  ['watching', 'state=watching&bg=snow'], ['watching-540x600', 'state=watching&bg=snow', 540, 600],
];
await mkdir(out, {recursive: true});
const browser = await puppeteer.launch({executablePath: process.env.CHROME, headless: true});
const page = await browser.newPage();
for (const [name, query, width = 1920, height = 1080] of shots) {
  await page.setViewport({width, height});
  await page.goto(base + query, {waitUntil: 'load'});
  await page.evaluate(() => document.fonts.ready);
  await new Promise(done => setTimeout(done, 500));
  await page.screenshot({path: `${out}/${name}.png`});
  console.log(name);
}
await browser.close();
server.stop(true);
