import { describe, expect, test } from 'bun:test';
import { createStrafePreviewIndicator, indicatorModel, startStrafePreview, strafePreviewMarkup } from '../src/strafe-preview-ui.js';
import { defaults } from '../src/settings.js';

// The indicator's element: the parts it writes, found by data-sp.
function indicatorRig() {
  const node = (text = '') => {
    const classes = new Set();
    return {textContent: text, children: [], classList: {toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }, contains: name => classes.has(name)}};
  };
  const parts = {A: node('A'), D: node('D'), speed: node('—'), turn: node()};
  parts.turn.children = [node('—'), node('°/s')];
  const styles = {};
  const element = {hidden: true, querySelector: selector => parts[selector.match(/data-sp="(\w+)"/)[1]], style: {setProperty: (name, value) => { styles[name] = value; }}};
  let listener = null, subscriptions = 0, unsubscribed = 0;
  const preview = {subscribe(next) { listener = next; subscriptions++; return () => { listener = null; unsubscribed++; }; }};
  return {element, parts, styles, preview, emit: value => listener?.(value), get subscriptions() { return subscriptions; }, get unsubscribed() { return unsubscribed; }};
}

describe('strafe preview UI', () => {
  test('starts with the saved speed and mode, and hands back why it could not', async () => {
    const calls = [];
    const preview = {async start(options) { calls.push(options); }};
    expect(await startStrafePreview(preview, {...defaults, strafePreviewUnits: 1200, strafePreviewMode: 'air'})).toBe('');
    expect(calls).toEqual([{units: 1200, mode: 'air'}]);
    const refusing = {async start() { throw new Error('Stand still in the start zone first.'); }};
    expect(await startStrafePreview(refusing, defaults)).toBe('Stand still in the start zone first.');
    expect(await startStrafePreview({start() { throw new Error(''); }}, defaults)).toBe('The preview didn’t start.');
  });

  test('shows the key to hold, the speed and the turn rate, and hides once the preview ends', () => {
    expect(indicatorModel({active: true, key: 'D', speed: 312.6, turnRate: 147.2})).toEqual({hidden: false, key: 'D', speed: '313', turnRate: '147'});
    expect(indicatorModel({active: true, key: 'A', speed: NaN})).toMatchObject({key: 'A', speed: '—', turnRate: '—'});
    expect(indicatorModel({active: false})).toEqual({hidden: true});
    expect(strafePreviewMarkup).toContain('Press any key to stop');

    const rig = indicatorRig();
    const indicator = createStrafePreviewIndicator(rig.element, rig.preview);
    expect([rig.subscriptions, rig.element.hidden]).toEqual([1, true]);
    rig.emit({active: true, key: 'A', speed: 300, turnRate: 160});
    expect(rig.element.hidden).toBe(false);
    expect([rig.parts.A.classList.contains('on'), rig.parts.D.classList.contains('on')]).toEqual([true, false]);
    expect([rig.parts.speed.textContent, rig.parts.turn.children[0].textContent]).toEqual(['300', '160']);
    rig.emit({active: true, key: 'D', speed: 318, turnRate: 151});
    expect([rig.parts.A.classList.contains('on'), rig.parts.D.classList.contains('on'), rig.parts.speed.textContent]).toEqual([false, true, '318']);
    rig.emit({active: false});
    expect(rig.element.hidden).toBe(true);
    indicator.place({'--scale': 1.2});
    expect(rig.styles['--scale']).toBe(1.2);
    indicator.destroy();
    expect(rig.unsubscribed).toBe(1);
  });

  test('does nothing without a preview to show', () => {
    const rig = indicatorRig();
    const indicator = createStrafePreviewIndicator(rig.element, null);
    expect(rig.element.hidden).toBe(true);
    indicator.destroy();
  });
});
