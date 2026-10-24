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
