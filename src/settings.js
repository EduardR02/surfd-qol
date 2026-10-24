export const storageKey = 'surfd-qol.settings.v1';
export const defaults = {
  hud: true, scale: 1, y: 82, speedColor: '#ebbcba', opacity: 1,
  speedFps: 60, timerFps: 30,
  goodColor: '#9ccfd8', warnColor: '#f6c177', badColor: '#eb6f92',
  showSync: true, showBoard: true, showAir: true, showStart: true, showSurf: true,
  rampResult: 'split', speedEnergyColor: false, speedEnergyRamps: false,
  checkpointReference: 'both', wrSource: 'ksf', continuousFeedback: false, airMetric: 'combined',
  boardColorReference: 'fixed', startColorReference: 'fixed', surfColorReference: 'wr',
  startHeightAmazing: 7.5, startHeightGood: 15,
  startDeficitAmazing: 10, startDeficitGood: 17.5, strafeLookbackSeconds: 0.2,
  boardLossAmazing: 5, boardLossGood: 20, airLossAmazing: 5, airLossGood: 20,
  referenceLossTolerance: 2,
  // Binds change what the game receives, so each one is opt-in.
  crouchJump: false, crouchJumpKey: 'Space',
  nullAD: false, nullWSpace: false,
  // What run history and replays keep in this browser.
  keepHistory: true, historyRunsPerMap: 100, historyMaps: 20, historySessions: 0,
  saveReplays: true, replaysPerMap: 30, keepBestReplay: true,
};
// Changing any of these prunes stored history and replays.
export const storageLimitKeys = ['historyRunsPerMap', 'historyMaps', 'historySessions', 'saveReplays', 'replaysPerMap', 'keepBestReplay'];
export const colorKeys = ['speedColor', 'goodColor', 'warnColor', 'badColor'];
const choices = {
  checkpointReference: ['pb', 'wr', 'both'],
  wrSource: ['ksf', 'leaderboard'],
  airMetric: ['missed', 'braking', 'combined'],
  rampResult: ['split', 'total'],
  boardColorReference: ['fixed', 'pb', 'wr'],
  startColorReference: ['fixed', 'pb', 'wr'],
  surfColorReference: ['fixed', 'pb', 'wr'],
};

// Unknown keys and wrong types are ignored; every accepted value is clamped
// so the HUD and metrics never see an out-of-range setting.
export function applySettings(settings, patch) {
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!(key in defaults) || typeof value !== typeof defaults[key]) continue;
    if (typeof value === 'number' && !Number.isFinite(value)) continue;
    settings[key] = value;
  }
  settings.y = Math.max(10, Math.min(90, settings.y));
  settings.scale = Math.max(0.6, Math.min(1.6, settings.scale));
  settings.opacity = Math.max(0.25, Math.min(1, settings.opacity));
  settings.speedFps = Math.round(Math.max(1, Math.min(1000, settings.speedFps)));
  settings.timerFps = Math.round(Math.max(1, Math.min(1000, settings.timerFps)));
  settings.startHeightAmazing = Math.max(0, settings.startHeightAmazing);
  settings.startHeightGood = Math.max(settings.startHeightAmazing, Math.max(0, settings.startHeightGood));
  settings.startDeficitAmazing = Math.max(0, settings.startDeficitAmazing);
  settings.startDeficitGood = Math.max(settings.startDeficitAmazing, Math.max(0, settings.startDeficitGood));
  settings.boardLossAmazing = Math.max(0, settings.boardLossAmazing);
  settings.boardLossGood = Math.max(settings.boardLossAmazing, settings.boardLossGood);
  settings.airLossAmazing = Math.max(0, settings.airLossAmazing);
  settings.airLossGood = Math.max(settings.airLossAmazing, settings.airLossGood);
  settings.referenceLossTolerance = Math.max(0, settings.referenceLossTolerance);
  settings.strafeLookbackSeconds = Math.max(0.05, Math.min(0.5, settings.strafeLookbackSeconds));
  const whole = (key, min, max) => { settings[key] = Math.round(Math.max(min, Math.min(max, settings[key]))); };
  whole('historyRunsPerMap', 5, 500);
  whole('historyMaps', 1, 100);
  whole('historySessions', 0, 500);
  whole('replaysPerMap', 1, 100);
  for (const key of colorKeys) if (!/^#[a-f\d]{6}$/i.test(settings[key])) settings[key] = defaults[key];
  for (const [key, allowed] of Object.entries(choices)) if (!allowed.includes(settings[key])) settings[key] = defaults[key];
  return settings;
}
