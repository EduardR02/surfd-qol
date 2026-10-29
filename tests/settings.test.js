import { expect, test } from 'bun:test';
import { applySettings, defaults } from '../src/settings.js';

test('binds that change game input are opt-in, and the HUD starts fully opaque', () => {
  const settings = applySettings({ ...defaults }, {});
  expect([settings.crouchJump, settings.nullAD, settings.nullWSpace]).toEqual([false, false, false]);
  expect(settings.opacity).toBe(1);
});

test('saved choices still override the defaults', () => {
  expect(applySettings({ ...defaults }, { crouchJump: true, opacity: 0.6 })).toMatchObject({ crouchJump: true, opacity: 0.6 });
});

test('history cutoff accepts zero and clamps saved numeric values to a usable range', () => {
  const settings = {...defaults};
  applySettings(settings, {historyMinSeconds: 0});
  expect(settings.historyMinSeconds).toBe(0);
  applySettings(settings, {historyMinSeconds: 12.5});
  expect(settings.historyMinSeconds).toBe(12.5);
  applySettings(settings, {historyMinSeconds: NaN});
  expect(settings.historyMinSeconds).toBe(12.5);
  applySettings(settings, {historyMinSeconds: -2});
  expect(settings.historyMinSeconds).toBe(0);
  applySettings(settings, {historyMinSeconds: 1000});
  expect(settings.historyMinSeconds).toBe(300);
});

test('the strafe preview keeps a speed from 1 to 5000 units and a ground or air mode', () => {
  const settings = {...defaults};
  expect([settings.strafePreviewUnits, settings.strafePreviewMode]).toEqual([300, 'ground']);
  applySettings(settings, {strafePreviewUnits: 9000, strafePreviewMode: 'air'});
  expect([settings.strafePreviewUnits, settings.strafePreviewMode]).toEqual([5000, 'air']);
  applySettings(settings, {strafePreviewUnits: 0, strafePreviewMode: 'water'});
  expect([settings.strafePreviewUnits, settings.strafePreviewMode]).toEqual([1, 'ground']);
});

test('the Ramps view remembers a known metric and falls back to Surf', () => {
  const settings = {...defaults};
  expect(settings.rampMetric).toBe('surf');
  applySettings(settings, {rampMetric: 'speedOut'});
  expect(settings.rampMetric).toBe('speedOut');
  applySettings(settings, {rampMetric: 'height'});
  expect(settings.rampMetric).toBe('surf');
});
