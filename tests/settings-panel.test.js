import { describe, expect, test } from 'bun:test';
import { previewModel, panelMarkup, historyRule, formatBytes } from '../src/settings-panel.js';
import { defaults } from '../src/settings.js';

const visible = model => ['board', 'result', 'up'].filter(key => !model.feedback[key].hidden);

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

  test('every setting the panel binds exists, and every default is reachable', () => {
    const bound = new Set([...panelMarkup.matchAll(/data-setting="(\w+)"/g)].map(match => match[1]));
    for (const key of bound) expect(key in defaults).toBe(true);
    // crouchJumpKey is set through the key-capture button.
    for (const key of Object.keys(defaults)) if (key !== 'crouchJumpKey') expect(bound.has(key)).toBe(true);
  });
});

describe('history settings', () => {
  test('say what is kept in one sentence that follows the settings', () => {
    const text = historyRule(defaults).replace(/<[^>]+>/g, '');
    expect(text).toContain('your PB, your latest attempt and your 10 newest runs, not counting resets under 10 s');
    expect(historyRule({ ...defaults, historyRunsPerMap: 25, historyMinSeconds: 0 }).replace(/<[^>]+>/g, '')).toContain('your 25 newest runs.');
    expect(historyRule({ ...defaults, keepHistory: false })).toStartWith('Recording is off.');
  });

  test('sizes read in KB, then MB', () => {
    expect(formatBytes(0)).toBe('0 KB');
    expect(formatBytes(200)).toBe('1 KB');
    expect(formatBytes(61440)).toBe('60 KB');
    expect(formatBytes(1.6 * 1024 * 1024)).toBe('1.6 MB');
  });
});
