import { expect, test } from 'bun:test';
import { applySettings, defaults } from '../src/settings.js';

test('binds that change game input are off by default', () => {
  const settings = applySettings({ ...defaults }, {});
  expect([settings.crouchJump, settings.nullAD, settings.nullWSpace]).toEqual([false, false, false]);
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

test('the strafe preview clamps its speed to 1-5000 units and falls back to the default for an unknown mode', () => {
  const settings = {...defaults};
  applySettings(settings, {strafePreviewUnits: 9000, strafePreviewMode: 'air'});
  expect([settings.strafePreviewUnits, settings.strafePreviewMode]).toEqual([5000, 'air']);
  applySettings(settings, {strafePreviewUnits: 0, strafePreviewMode: 'water'});
  expect([settings.strafePreviewUnits, settings.strafePreviewMode]).toEqual([1, defaults.strafePreviewMode]);
});

test('the Ramps view remembers a known metric and falls back to Surf', () => {
  const settings = {...defaults};
  expect(settings.rampMetric).toBe('surf');
  applySettings(settings, {rampMetric: 'speedOut'});
  expect(settings.rampMetric).toBe('speedOut');
  applySettings(settings, {rampMetric: 'height'});
  expect(settings.rampMetric).toBe('surf');
});
