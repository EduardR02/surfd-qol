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
