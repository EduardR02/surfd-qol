import { describe, expect, test } from 'bun:test';
import { previewModel, panelMarkup } from '../src/settings-panel.js';
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
