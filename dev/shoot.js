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
// [file, query, width, height, wait ms]
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
  ['panel-custom-palette', 'panel=display&palette=custom'], ['panel-display-zen', 'panel=display&set.zen=true'],
  ['panel-history-720', 'panel=history', 1280, 720], ['panel-display-720', 'panel=display', 1280, 720],
  ['runs', 'runs'], ['runs-540x600', 'runs', 540, 600], ['runs-maps', 'runs&maps'], ['runs-stages', 'runs=kitsune:1'],
  ['runs-no-finish', 'runs=mesa:2'], ['runs-empty', 'runs&history=empty'], ['runs-off', 'runs&history=empty&set.keepHistory=false'],
  ['runs-off-with-runs', 'runs&set.keepHistory=false'], ['runs-official-pb', 'runs&pb=official'],
  ['ramps', 'runs&view=ramps'], ['ramps-last-10', 'runs&view=ramps&stat=recent'], ['ramps-average', 'runs&view=ramps&stat=average'],
  ['ramps-expanded', 'runs&view=ramps&expand=1'], ['ramps-reset', 'runs&view=ramps&stat=average&reset'], ['ramps-net-pb', 'runs&view=ramps&set.rampResult=total&ref=pb'], ['ramps-loading', 'runs&view=ramps&ref=loading'],
  ['ramps-no-reference', 'runs&view=ramps&ref=none'], ['ramps-other-map', 'runs=kitsune:1&view=ramps'], ['ramps-540x600', 'runs&view=ramps', 540, 600],
  ['watching', 'state=watching&bg=snow'], ['watching-paused', 'state=watching&bg=warm&play=paused'],
  ['watching-ended', 'state=watching&bg=fog&play=ended&locs=4&binds=custom'], ['watching-notice', 'state=watching&bg=neon&notice=saved'],
  ['watching-keys', 'state=watching&bg=neon&play=paused&pop=keys&binds=custom'], ['watching-speed', 'state=watching&bg=warm&play=paused&pop=speed&speed=0.5'],
  ['watching-runs', 'state=watching&bg=dark&play=paused&runs'], ['watching-other', 'state=watching&bg=dark&title=other&locs=0'],
  ['watching-700x900', 'state=watching&bg=ice&play=paused&binds=custom', 700, 900], ['watching-540x600', 'state=watching&bg=snow&play=paused', 540, 600],
  // Left alone while playing, the bar recedes to the timeline.
  ['watching-rest', 'state=watching&bg=snow', 1920, 1080, 3400],
  ['native-ramp-hover', 'state=watching&bg=snow&play=paused&hover=ramp'],
  ['native-indexing', 'state=watching&bg=snow&play=paused&indexing'],
  ['native-return-540x600', 'state=watching&bg=snow&play=paused&parked=true', 540, 600],
  ['custom-watching', 'state=watching&bg=snow&play=paused&set.customReplayUi=true&parked=true'],
  ['custom-watching-1280', 'state=watching&bg=snow&play=paused&set.customReplayUi=true&parked=true', 1280, 720],
  ['custom-watching-540x600', 'state=watching&bg=snow&play=paused&set.customReplayUi=true&parked=true', 540, 600],
  ['custom-keys', 'state=watching&bg=neon&play=paused&set.customReplayUi=true&pop=keys&binds=custom'],
  ['custom-idle', 'state=watching&bg=snow&set.customReplayUi=true', 1920, 1080, 3400],
];
await mkdir(out, {recursive: true});
const browser = await puppeteer.launch({executablePath: process.env.CHROME, headless: true});
const page = await browser.newPage();
for (const [name, query, width = 1920, height = 1080, wait = 500] of shots) {
  await page.setViewport({width, height});
  await page.goto(base + query, {waitUntil: 'load'});
  await page.evaluate(() => document.fonts.ready);
  await new Promise(done => setTimeout(done, wait));
  if (new URLSearchParams(query).get('hover') === 'ramp') await page.hover('pierce/.nr-mark.loss');
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  await page.screenshot({path: `${out}/${name}.png`});
  console.log(name);
}
await browser.close();
server.stop(true);
