import {estimateBandwidth} from './bandwidth.js';
import {MAX_ROOM_PLAYERS} from './protocol.js';

export const MIN_ROOM_PLAYERS = 2;
export const CHOICES = [
  ['private', 'Private', 'Only people with the room code or link.'],
  ['public', 'Public', 'Listed in Community for everyone with Surfd QoL.'],
];
export const NAME_HINT = 'Shown in Find a server.';
const CODE_HINT = 'Send it to friends.';

export const uploadEstimate = players =>
  `${players} players need about ${estimateBandwidth(players).upload.toFixed(1)} Mbps up.`;
// The game's own course line for a map, as in its server details.
export const courseText = map => map?.stages ? `Staged · ${map.stages} stages`
  : Number.isInteger(map?.checkpoints) ? `Linear · ${map.checkpoints} checkpoints` : '';
export const normalizeName = value => String(value ?? '').trim().replace(/ {2,}/g, ' ');
export function clampLimit(value) {
  const number = Math.round(Number(value));
  return String(value).trim() && Number.isFinite(number) ? Math.min(MAX_ROOM_PLAYERS, Math.max(MIN_ROOM_PLAYERS, number)) : null;
}

export const text = (node, value) => { if (node && node.textContent !== value) node.textContent = value; };
export const hidden = (node, value) => { if (node && node.hidden !== value) node.hidden = value; };
export const classes = (node, value) => { if (node && node.className !== value) node.className = value; };
export const attribute = (node, name, value) => {
  if (value == null) { if (node.getAttribute(name) !== null) node.removeAttribute(name); }
  else if (node.getAttribute(name) !== value) node.setAttribute(name, value);
};

// The Host a room and Your room view, laid out like the game's Settings groups.
export function buildRoomView(doc) {
  const element = (tag, className = '', value = '') => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (value) node.textContent = value;
    return node;
  };
  const button = (label, className = 'btn') => {
    const node = element('button', className, label);
    node.type = 'button';
    return node;
  };
  const group = (parent, title) => {
    const node = element('div', 'group'), heading = element('h4', 'group-title', title);
    node.append(heading);
    parent.append(node);
    return {node, heading};
  };
  const row = (parent, label, controlTag = 'div') => {
    const setting = element('div', 'setting'), info = element('div', 'setting-text'), control = element(controlTag, 'setting-control');
    const name = element('span', 'setting-label', label), note = element('small');
    info.append(name, note);
    setting.append(info, control);
    parent.append(setting);
    return {setting, info, control, label: name, note};
  };

  const view = element('div', 'settings-window qol-host-view');
  view.hidden = true;
  const main = element('div', 'qol-room-main');
  view.append(main);

  const room = group(main, 'Room').node;
  const nameRow = row(room, 'Name', 'form');
  const field = element('label', 'field'), name = element('input'), save = button('Save');
  name.type = 'text'; name.spellcheck = false; name.autocomplete = 'off';
  name.setAttribute('aria-label', 'Room name');
  save.type = 'submit';
  field.append(name);
  nameRow.control.append(field, save);
  nameRow.note.setAttribute('role', 'status');

  const access = row(room, 'Who can join');
  const seg = element('div', 'seg');
  seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'Who can join');
  for (const [value, label] of CHOICES) {
    const option = button(label, '');
    option.dataset.visibility = value;
    seg.append(option);
  }
  access.control.append(seg);

  const limitRow = row(room, 'Player limit');
  const limit = element('input', 'num');
  limit.type = 'number'; limit.min = String(MIN_ROOM_PLAYERS); limit.max = String(MAX_ROOM_PLAYERS); limit.step = '1';
  limit.setAttribute('aria-label', 'Player limit');
  limitRow.control.append(limit);

  const mapRow = row(group(main, 'Map').node, '');
  mapRow.setting.classList.add('qol-map-row');
  const thumb = element('img', 'thumb');
  thumb.alt = ''; thumb.width = 64; thumb.height = 36;
  mapRow.setting.prepend(thumb);
  const mapName = element('span'), chip = element('span', 'tier-chip'), chipShort = element('span'), chipLong = element('span', 'visually-hidden');
  chipShort.setAttribute('aria-hidden', 'true');
  chip.append(chipShort, chipLong);
  mapRow.label.append(mapName, doc.createTextNode(' '), chip);
  const change = button('Change');
  mapRow.control.append(change);

  const invite = group(main, 'Invite').node;
  const codeRow = row(invite, 'Room code');
  codeRow.note.textContent = CODE_HINT;
  const code = element('code', 'qol-room-code'), copyCode = button('Copy code'), copyLink = button('Copy link');
  codeRow.control.append(code, copyCode, copyLink);

  const players = group(view, 'Players');
  players.node.classList.add('qol-room-players');
  const count = element('small');
  players.heading.append(count);
  const wrap = element('div', 'table-wrap'), table = element('table', 'list roster-list'), roster = element('tbody');
  const empty = element('p', 'empty');
  table.append(roster);
  wrap.append(table, empty);
  players.node.append(wrap);

  return {view, nameForm: nameRow.control, name, save, nameNote: nameRow.note, seg, accessNote: access.note,
    limit, limitNote: limitRow.note, thumb, mapName, chip, chipShort, chipLong, mapNote: mapRow.note, change,
    invite, code, copyCode, copyLink, players: players.node, count, table, roster, empty};
}

// Rows like the game's Who's on list: face, name, and Guest for guests.
export function rosterRows(element, players, total, me) {
  const rows = players.map(player => {
    const tr = element('tr'), who = element('td'), rank = element('td', 'c-min');
    const tag = element('span', 'who'), face = element('img', 'face');
    face.src = '/menu/cosmetics/render/face-default.png'; face.alt = ''; face.width = 20; face.height = 20;
    tag.append(face, element('span', '', player.name));
    if (player.name === me) tag.append(element('span', 'you-tag', 'you'));
    who.append(tag);
    if (player.guest) rank.append(element('span', 'rank-name rank-guest', 'Guest'));
    tr.append(who, rank);
    return tr;
  });
  if (players.length && total > players.length) {
    const tr = element('tr'), more = element('td', 'quiet', `+${total - players.length} more`);
    more.colSpan = 2;
    tr.append(more);
    rows.push(tr);
  }
  return rows;
}
