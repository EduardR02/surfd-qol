import { describe, expect, test } from 'bun:test';
import { previewModel, formatBytes, panelMarkup, historyRule, historyPreview, zenMarkup } from '../src/settings-panel.js';
import { defaults } from '../src/settings.js';

const visible = model => ['board', 'result', 'up'].filter(key => !model.feedback[key].hidden);
const text = html => html.replace(/<[^>]+>/g, '');

describe('settings preview', () => {
  test('mirrors the feedback options', () => {
    expect(visible(previewModel(defaults))).toEqual(['board', 'result', 'up']);
    expect(previewModel(defaults).feedback.result.label).toBe('DOWN');
    const net = previewModel({ ...defaults, rampResult: 'total' });
    expect(visible(net)).toEqual(['board', 'result']);
    expect(net.feedback.result.label).toBe('SURF');
    expect(visible(previewModel({ ...defaults, showBoard: false, showSurf: false }))).toEqual(['result']);
    expect(previewModel({ ...defaults, showBoard: false, showSurf: false, airMetric: 'braking' }).feedback.result.label).toBe('BRAKE');
    const none = previewModel({ ...defaults, showBoard: false, showSurf: false, showAir: false });
    expect(none.feedback.hidden).toBe(true);
    expect(visible(previewModel({ ...defaults, continuousFeedback: true }))).toEqual(['board', 'result']);
    expect(previewModel({ ...defaults, showSync: false }).sync.hidden).toBe(true);
  });

  test('Zen leaves only the speed in the preview', () => {
    const zen = previewModel({ ...defaults, zen: true });
    expect(zen.zen).toBe(true);
    expect([zen.clock.hidden, zen.sync.hidden, zen.feedback.hidden]).toEqual([true, true, true]);
    // Compact shows no timer unless asked; Full always does.
    expect(previewModel(defaults).clock.hidden).toBe(true);
    expect(previewModel({ ...defaults, compactTimer: true }).clock.hidden).toBe(false);
    expect(previewModel({ ...defaults, surfHud: 'full' }).clock.hidden).toBe(false);
  });

  test('every setting the panel binds exists, and every default is reachable', () => {
    const bound = new Set([...panelMarkup.matchAll(/data-setting="(\w+)"/g)].map(match => match[1]));
    for (const key of bound) expect(key in defaults).toBe(true);
    // crouchJumpKey is set through the key-capture button, rampMetric in the Runs panel.
    for (const key of Object.keys(defaults)) if (key !== 'crouchJumpKey' && key !== 'rampMetric') expect(bound.has(key)).toBe(true);
  });

  test('players read touch, never board', () => {
    expect(text(panelMarkup)).not.toMatch(/\bboard/i);
    expect(text(panelMarkup)).toContain('leaderboard');
    expect(panelMarkup).toContain('aria-label="Touch loss, better below"');
    expect(previewModel(defaults).feedback.board.label).toBe('TOUCH');
  });

  test('the strafe preview takes a speed and a mode, then starts from its own button', () => {
    expect(panelMarkup).toContain('data-setting="strafePreviewUnits"');
    expect(panelMarkup).toContain('value="ground" data-setting="strafePreviewMode"><span>Ground</span>');
    expect(panelMarkup).toContain('value="air" data-setting="strafePreviewMode"><span>Air</span>');
    expect(panelMarkup).toContain('id="preview-start"');
  });

  test('the Zen pill is a named toggle button', () => {
    expect(zenMarkup).toContain('aria-pressed="false"');
    expect(zenMarkup).toContain('aria-label="Zen mode"');
  });
});

describe('history settings', () => {
  test('say what is kept in a few plain sentences that follow the settings, without calling it a PB', () => {
    const rule = text(historyRule(defaults));
    expect(rule).toContain('your 10 newest runs with their replays, plus your best finish');
    expect(rule).toContain('Resets under 10 s are skipped, except your latest run.');
    expect(rule).not.toMatch(/\bPB\b/);
    expect(text(historyRule({ ...defaults, historyRunsPerMap: 25, historyMinSeconds: 0 }))).not.toContain('Resets under');
    expect(historyRule({ ...defaults, keepHistory: false })).toStartWith('Recording is off.');
  });

  test('the History preview draws the newest runs, capped, and the skip rule', () => {
    const bars = html => (html.match(/<i style=/g) ?? []).length;
    expect(bars(historyPreview(defaults))).toBe(10);
    expect(historyPreview(defaults)).toContain('class="skip"');
    const many = historyPreview({ ...defaults, historyRunsPerMap: 40, historyMinSeconds: 0 });
    expect(bars(many)).toBe(20);
    expect(many).toContain('+20');
    expect(many).not.toContain('class="skip"');
    expect(historyPreview({ ...defaults, keepHistory: false })).toContain('Recording is off');
  });

  test('sizes read in KB, then MB', () => {
    expect(formatBytes(0)).toBe('0 KB');
    expect(formatBytes(200)).toBe('1 KB');
    expect(formatBytes(61440)).toBe('60 KB');
    expect(formatBytes(1.6 * 1024 * 1024)).toBe('1.6 MB');
  });
});
