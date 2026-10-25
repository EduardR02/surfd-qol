// Display names for the game's key, mouse button and wheel bind codes.
export function keyName(code) {
  return String(code ?? '').replace(/^Key(?=[A-Z]$)/, '').replace(/^Digit(?=\d$)/, '').replace(/^Mouse(?=\d$)/, 'Mouse ')
    .replace(/^Wheel(?=Up$|Down$)/, 'Wheel ').replace(/^Arrow/, '').replace(/(?<=.)(Left|Right)$/, ' $1');
}
// Every key bound to one action, e.g. "F5 / Mouse 2"; '' when none is.
export const bindLabel = codes => (Array.isArray(codes) ? codes : []).map(keyName).filter(Boolean).join(' / ');
// The game's defaults for the saveloc actions, for when it has no bindings to give.
const SAVELOC_DEFAULTS = {save: ['F5'], load: ['F9'], previousSave: [], nextSave: []};
export function savelocBinds(bindings) {
  return Object.fromEntries(Object.entries(SAVELOC_DEFAULTS).map(([action, codes]) =>
    [action, Array.isArray(bindings?.[action]) ? bindings[action] : codes]));
}
