import { describe, expect, test } from 'bun:test';
import { previewModel, formatBytes } from '../src/settings-panel.js';
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

});

describe('history settings', () => {
  test('sizes read in KB, then MB', () => {
    expect(formatBytes(0)).toBe('0 KB');
    expect(formatBytes(200)).toBe('1 KB');
    expect(formatBytes(61440)).toBe('60 KB');
    expect(formatBytes(1.6 * 1024 * 1024)).toBe('1.6 MB');
  });
});
