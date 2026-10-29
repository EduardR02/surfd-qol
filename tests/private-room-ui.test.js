import {describe, expect, test} from 'bun:test';
import {ROOM_CLASS, createRoomUi, uploadEstimate} from '../src/private-rooms/ui.js';
import {estimateBandwidth} from '../src/private-rooms/bandwidth.js';
import {parseRoomCode} from '../src/private-rooms/ids.js';
import {MAX_ROOM_PLAYERS, roomNameProblem} from '../src/private-rooms/protocol.js';

class Element {
  constructor(tag = 'div') {
    this.tag = tag; this.children = []; this.dataset = {}; this.attributes = {};
    this.hidden = false; this.disabled = false; this.className = ''; this.id = ''; this.value = '';
    this.parentNode = null; this.content = '';
    const names = () => this.className.split(' ').filter(Boolean);
    this.classList = {
      contains: value => names().includes(value),
      add: value => { if (!names().includes(value)) this.className = [...names(), value].join(' '); },
      remove: value => { this.className = names().filter(item => item !== value).join(' '); },
      toggle: (value, force = !names().includes(value)) => { force ? this.classList.add(value) : this.classList.remove(value); return force; },
    };
  }
  get textContent() { return this.content + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.content = String(value); this.children = []; }
  get isConnected() { let node = this; while (node.parentNode) node = node.parentNode; return node.tag === 'document'; }
  get previousElementSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) - 1] ?? null; }
  get nextElementSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] ?? null; }
  append(...nodes) { for (const node of nodes) {node.remove(); node.parentNode = this; this.children.push(node);} }
  prepend(node) { node.remove(); node.parentNode = this; this.children.unshift(node); }
  replaceChildren(...nodes) { for (const child of [...this.children]) child.remove(); this.append(...nodes); }
  remove() { if (this.parentNode) {this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null;} }
  before(node) { const parent = this.parentNode; node.remove(); node.parentNode = parent; parent.children.splice(parent.children.indexOf(this), 0, node); }
  after(node) { const parent = this.parentNode; node.remove(); node.parentNode = parent; parent.children.splice(parent.children.indexOf(this) + 1, 0, node); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  // A submit button submits its form, as Enter in one of the form's fields does.
  async click() {
    if (this.disabled) return;
    if (this.type === 'submit') {
      let form = this.parentNode;
      while (form && form.tag !== 'form') form = form.parentNode;
      return form?.onsubmit?.({preventDefault() {}});
    }
    await this.onclick?.();
  }
  matches(selector) {
    const attr = selector.match(/\[([^=\]]+)(?:="([^"]*)")?\]$/);
    if (attr) {
      const name = attr[1], value = name.startsWith('data-') ? this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] : this.attributes[name];
      return value !== undefined && (attr[2] === undefined || value === attr[2]) && (!selector.slice(0, attr.index) || this.matches(selector.slice(0, attr.index)));
    }
    return selector.startsWith('#') ? this.id === selector.slice(1) : selector.startsWith('.') ? this.classList.contains(selector.slice(1)) : this.tag === selector;
  }
  querySelectorAll(selector) {
    const result = [];
    for (const branch of selector.split(', ')) {
      const parts = branch.split(' '), last = parts.pop();
      const walk = node => {
        for (const child of node.children) {
          if (child.matches(last)) {
            let parent = child.parentNode, index = parts.length - 1;
            while (index >= 0 && parent) {if (parent.matches(parts[index])) index--; parent = parent.parentNode;}
            if (index < 0 && !result.includes(child)) result.push(child);
          }
          walk(child);
        }
      };
      walk(this);
    }
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

class Observer {
  static instances = new Set();
  targets = new Map();
  constructor(callback) { this.callback = callback; Observer.instances.add(this); }
  observe(node, options) { this.targets.set(node, options); }
  disconnect() { this.targets.clear(); }
}

const ROOM = 'p-aaaaaaaaaaaa';
const VALID = "Night_owls's room";
const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };

function fixture({guest = false, roster = null} = {}) {
  const document = new Element('document');
  document.documentElement = document;
  document.createElement = tag => new Element(tag);
  document.createTextNode = value => { const node = new Element('#text'); node.content = value; return node; };
  const add = (parent, tag, id = '', className = '', value = '') => {const node = new Element(tag); node.id = id; node.className = className; node.textContent = value; parent.append(node); return node;};
  const root = add(document, 'section', 'servers-window', 'window');
  const titlebar = add(root, 'header', '', 'titlebar');
  const title = add(titlebar, 'h2', '', '', 'Find a server');
  const body = add(root, 'div', '', 'window-body split');
  const layout = add(body, 'div', '', 'servers-layout');
  const toolbar = add(layout, 'div', '', 'toolbar');
  add(toolbar, 'div', '', 'chips');
  add(toolbar, 'span', '', 'grow');
  const rowsBody = add(layout, 'tbody', 'server-rows');
  const detail = add(layout, 'div', 'server-detail');
  const info = add(detail, 'div', '', 'srv-info');
  add(info, 'p', '', 'sub', 'Europe');
  const invite = add(info, 'div', '', 'invite-line');
  const ping = add(info, 'dd', '', '', '—'); ping.dataset.fact = 'ping';
  const rosterNode = add(detail, 'div', '', 'srv-roster');
  const head = add(rosterNode, 'div', '', 'section-head'); add(head, 'small', '', '', '2 / 16');
  const foot = add(root, 'footer', '', 'window-foot');
  const status = add(foot, 'span', 'servers-status', 'foot-note');
  const group = add(foot, 'div', '', 'foot-group');
  const refresh = add(group, 'button', 'servers-refresh', 'btn', 'Refresh');
  const join = add(group, 'button', 'servers-join', 'btn btn-primary', 'Join');
  let visibility = 'private', hosting = null, current = null, selected = 'eu', failure = null, nativeJoins = 0, signIns = 0;
  let name = "Surfer's room", remembered = 16, copiedText = [], clipboardFails = false, refusePublic = false;
  let renameFailure = null, limitFailure = null, finishRename = null;
  let players = roster ?? [{name: 'Surfer', points: 0}, {name: 'Guest_1a2b3', points: 0}];
  const calls = [], ended = [], details = [], joined = [], renames = [], limits = [], rows = [{id: 'eu', region: 'Europe', players: 4, online: true}];
  let finishJoin = null;
  const rooms = {
    visibility: () => visibility, hosting: () => hosting && {...hosting}, currentRoom: () => current, roomName: () => hosting?.name ?? name,
    maxPlayers: () => remembered,
    roomInfo: id => id === ROOM && hosting ? {id, roster: players} : null,
    showHostDetails: value => details.push(value),
    setVisibility(value) {
      if (value === 'public' && refusePublic) throw new Error('Public rooms are unavailable right now.');
      visibility = value;
      if (hosting) hosting.visibility = value;
    },
    rename(value) {
      renames.push(value);
      if (finishRename) return new Promise(resolve => { const done = finishRename; finishRename = () => { done(); name = value; hosting.name = value; resolve(); }; });
      const problem = renameFailure ?? roomNameProblem(value);
      if (problem) return Promise.reject(new Error(problem));
      name = value;
      if (hosting) hosting.name = value;
      return Promise.resolve();
    },
    setMaxPlayers(value) {
      limits.push(value);
      if (limitFailure) return Promise.reject(limitFailure);
      hosting.maxPlayers = value; remembered = value;
      return Promise.resolve();
    },
    async host(options) {
      calls.push(options);
      if (failure) throw failure;
      hosting = {id: ROOM, visibility: options.visibility, name: options.name, mapId: options.mapId, players: 2,
        maxPlayers: options.maxPlayers, uploadMbps: 0.2};
      current = ROOM; selected = ROOM; root.hidden = true;
      rows.push({id: ROOM, visibility: options.visibility, players: 2, online: true});
      return ROOM;
    },
    end() { ended.push(hosting.id); hosting = null; current = null; },
    joinCode(value) {
      const id = parseRoomCode(value);
      if (!id) return Promise.reject(new Error('Check the room code.'));
      if (id !== ROOM) return Promise.reject(new Error('This private room has closed.'));
      return new Promise(resolve => { finishJoin = () => { joined.push(id); resolve(id); }; });
    },
  };
  const pickers = [], statuses = [], opened = [], changes = [];
  const adapter = {rooms: {
    guest: () => guest, signIn: () => { signIns++; }, root: () => root, browserOpen: () => !root.hidden,
    rows: () => rows, selected: () => selected, currentMap: () => ({id: 'map'}), displayName: () => 'Surfer',
    maps: () => [{id: 'map', slug: 'loaded', title: 'Loaded map', tier: 3, checkpoints: 4}, {id: 'other', slug: 'other', title: 'Other map', tier: 1, stages: 6}],
    setStatus: text => { statuses.push(text); status.textContent = text; },
    openBrowser: () => { opened.push('servers'); root.hidden = false; },
    changeMap: () => changes.push('change'),
    mapPicker(options) {
      const dialog = add(document, 'dialog', '', 'nominate-window map-change-window');
      const head = add(dialog, 'header', '', 'nominate-head'); add(head, 'h2', '', '', 'Change the server map');
      add(dialog, 'p', '', 'nominate-status map-change-status');
      add(dialog, 'footer', '', 'nominate-foot', 'Moderator tool');
      const picker = {options, dialog, states: [], opens: 0, open() { this.opens++; dialog.querySelector('.map-change-status').textContent = 'Pick a map to change it now for everyone in this server.'; },
        state(value) { this.states.push(value); }, close() { this.closed = true; }};
      pickers.push(picker);
      return picker;
    },
  }};
  join.onclick = () => { nativeJoins++; };
  const clipboard = {writeText: async value => { if (clipboardFails) throw new Error('denied'); copiedText.push(value); }};
  const ui = createRoomUi({rooms, getAdapter: () => adapter, document, MutationObserver: Observer, clipboard});
  const footButton = label => [...foot.children, ...group.children].find(node => node.textContent === label && !node.hidden);
  const view = () => body.querySelector('.qol-host-view');
  const button = label => view().querySelectorAll('button').find(node => node.textContent === label);
  return {ui, rooms, adapter, document, root, title, layout, toolbar, rowsBody, detail, info, invite, foot, group, status, refresh, join, calls, ended, details, rows,
    pickers, statuses, opened, changes, renames, limits, copied: () => copiedText, failClipboard: () => { clipboardFails = true; },
    joined, finishJoin: () => finishJoin(), view, button, footButton,
    nameInput: () => view().querySelector('.field input'), nameNote: () => view().querySelector('.setting-text small'),
    limitInput: () => view().querySelector('.num'), limitNote: () => view().querySelector('.num').parentNode.parentNode.querySelector('small'),
    host: () => group.children[0], nativeJoins: () => nativeJoins, signIns: () => signIns,
    fail: error => { failure = error; }, select: id => { selected = id; }, current: id => { current = id; },
    refusePublic: () => { refusePublic = true; }, failRename: message => { renameFailure = message; },
    holdRename: () => { finishRename = () => {}; }, finishRename: () => { const done = finishRename; finishRename = null; done(); },
    failLimit: error => { limitFailure = error; }, setRoster: value => { players = value; }, setPlayers: count => { hosting.players = count; },
    hostNow: () => rooms.host({visibility: 'private', mapId: 'map', name, maxPlayers: remembered}).then(() => { root.hidden = false; ui.refresh(); })};
}
const shown = node => { for (; node; node = node.parentNode) if (node.hidden) return false; return true; };
const groupTitles = view => view.querySelectorAll('.group-title').filter(shown)
  .map(node => node.textContent.slice(0, node.textContent.length - (node.querySelector('small')?.textContent.length ?? 0)));
const type = (input, value) => { input.value = value; input.oninput(); };

describe('Host a room', () => {
  test('replaces the server list with the room groups in the same window', async () => {
    const f = fixture();
    expect(f.host().textContent).toBe('Host a room');
    expect(f.refresh.previousElementSibling).toBe(f.host());
    await f.host().click();
    const view = f.view();
    expect(f.title.textContent).toBe('Host a room');
    expect(f.layout.hidden).toBe(true);
    expect(view.hidden).toBe(false);
    expect(view.className).toBe('settings-window qol-host-view');
    expect(groupTitles(view)).toEqual(['Room', 'Map', 'Players']);
    expect(view.querySelectorAll('.setting-label').filter(shown).map(node => node.textContent))
      .toEqual(['Name', 'Who can join', 'Player limit', 'Loaded map T3Tier 3']);
    expect(f.foot.children.filter(node => !node.hidden).map(node => node.id || node.className)).toEqual(['servers-status', 'foot-group']);
    expect(f.group.children.filter(node => !node.hidden).map(node => node.textContent)).toEqual(['Back', 'Start room']);
    expect(f.footButton('Start room').className).toBe('btn btn-primary');
    expect(view.querySelector('.tier-chip').className).toBe('tier-chip t3');
    expect(view.querySelector('.thumb').getAttribute('src')).toBe('/previews/loaded.jpg');
    expect(view.querySelector('.qol-map-row small').textContent).toBe('Linear · 4 checkpoints');
    expect(f.nameInput().value).toBe("Surfer's room");
    expect(f.button('Save').hidden).toBe(true);
    expect(view.querySelector('[data-visibility="private"]').getAttribute('aria-pressed')).toBe('true');
    expect(view.textContent).toContain('Only people with the room code or link.');
    expect(f.limitInput().value).toBe('16');
    expect(f.limitNote().textContent).toBe(uploadEstimate(16));
    expect(view.querySelector('.qol-room-players .group-title small').textContent).toBe('0 / 16');
    expect(view.querySelector('.qol-room-players .empty').textContent).toBe('Players show here once the room starts.');
    expect(view.querySelector('.roster-list').hidden).toBe(true);
    expect(f.details.at(-1)).toBe(false);
    f.ui.destroy();
    expect(f.title.textContent).toBe('Find a server');
    expect(f.layout.hidden).toBe(false);
    expect(f.group.children.map(node => node.textContent)).toEqual(['Refresh', 'Join']);
    expect(f.foot.children.map(node => node.id)).toEqual(['servers-status', '']);
  });

  test('the upload line gives the estimate for one player limit to one decimal', () => {
    for (const players of [2, 16, 64]) {
      expect(uploadEstimate(players)).toBe(`${players} players need about ${estimateBandwidth(players).upload.toFixed(1)} Mbps up.`);
    }
    expect(uploadEstimate(16)).toMatch(/^16 players need about \d+\.\d Mbps up\.$/);
  });

  test('Change opens the game’s map dialog for the starting map and Start room hosts on it', async () => {
    const f = fixture();
    await f.host().click();
    await f.button('Change').click();
    const picker = f.pickers[0];
    expect(picker.opens).toBe(1);
    expect(picker.dialog.querySelector('h2').textContent).toBe('Choose the room’s map');
    expect(picker.dialog.querySelector('.nominate-foot').hidden).toBe(true);
    expect(picker.dialog.querySelector('.map-change-status').textContent).toBe('Pick the map the room starts on.');
    expect(picker.options.allowed()).toBe(true);
    expect(picker.options.state().mapId).toBe('map');
    expect(picker.options.change('other')).toBe(true);
    expect(picker.states).toEqual([]);
    await flush();
    expect(picker.states).toEqual([{mapId: 'other', epoch: 2}]);
    expect(picker.options.state()).toEqual({mapId: null, epoch: 2});
    expect(f.view().querySelector('.qol-map-row .setting-label').textContent).toBe('Other map T1Tier 1');
    expect(f.view().querySelector('.qol-map-row small').textContent).toBe('Staged · 6 stages');
    await f.button('Change').click();
    expect(f.pickers).toHaveLength(1);
    expect(picker.opens).toBe(2);
    await f.view().querySelector('[data-visibility="public"]').click();
    await f.footButton('Start room').click();
    expect(f.calls).toEqual([{visibility: 'public', mapId: 'other', name: "Surfer's room", maxPlayers: 16}]);
    expect(f.nativeJoins()).toBe(0);
    f.ui.destroy();
    expect(picker.closed).toBe(true);
  });

  test('the name is checked as it is typed and starts the room trimmed', async () => {
    const f = fixture();
    await f.host().click();
    const input = f.nameInput(), note = f.nameNote(), start = f.footButton('Start room');
    expect([note.textContent, note.className]).toEqual(['Shown in Find a server.', '']);
    type(input, 'ab');
    expect([note.textContent, note.className]).toEqual([roomNameProblem('ab'), 'input-error']);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.value).toBe('ab');
    expect(start.disabled).toBe(true);
    await input.parentNode.parentNode.onsubmit({preventDefault() {}});
    expect(f.calls).toEqual([]);
    type(input, `  ${VALID.replace(' ', '   ')} `);
    expect([note.textContent, note.className]).toEqual(['Shown in Find a server.', '']);
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(start.disabled).toBe(false);
    await f.footButton('Back').click();
    await f.host().click();
    expect(f.nameInput().value).toBe(`  ${VALID.replace(' ', '   ')} `);
    await f.footButton('Start room').click();
    expect(f.calls[0].name).toBe(VALID);
    f.ui.destroy();
  });

  test('the player limit is clamped to 2 and the room maximum and starts the room', async () => {
    const f = fixture();
    await f.host().click();
    const input = f.limitInput();
    expect([input.min, input.max, input.step]).toEqual(['2', String(MAX_ROOM_PLAYERS), '1']);
    type(input, '8');
    expect(f.limitNote().textContent).toBe(uploadEstimate(8));
    type(input, '1');
    expect(f.limitNote().textContent).toBe(uploadEstimate(16));
    await input.onchange();
    expect(input.value).toBe('2');
    expect(f.limitNote().textContent).toBe(uploadEstimate(2));
    type(input, '9999'); await input.onchange();
    expect(input.value).toBe(String(MAX_ROOM_PLAYERS));
    type(input, ''); await input.onchange();
    expect(input.value).toBe(String(MAX_ROOM_PLAYERS));
    type(input, '12.4'); await input.onchange();
    expect(input.value).toBe('12');
    expect(f.view().querySelector('.qol-room-players .group-title small').textContent).toBe('0 / 12');
    expect(f.limits).toEqual([]);
    await f.footButton('Start room').click();
    expect(f.calls[0].maxPlayers).toBe(12);
    f.ui.destroy();
  });

  test('Back and closing the window return to the server list', async () => {
    const f = fixture();
    await f.host().click();
    await f.footButton('Back').click();
    expect(f.layout.hidden).toBe(false);
    expect(f.view().hidden).toBe(true);
    expect(f.title.textContent).toBe('Find a server');
    expect(f.group.children.filter(node => !node.hidden).map(node => node.textContent)).toEqual(['Host a room', 'Refresh', 'Join']);
    expect(f.footButton('End room')).toBeUndefined();
    await f.host().click();
    f.root.hidden = true; f.ui.refresh();
    f.root.hidden = false; f.ui.refresh();
    expect(f.view().hidden).toBe(true);
    expect(f.title.textContent).toBe('Find a server');
    f.ui.destroy();
  });

  test('a guest is sent to sign in instead', async () => {
    const f = fixture({guest: true});
    await f.host().click();
    expect(f.signIns()).toBe(1);
    expect(f.view().hidden).toBe(true);
    await f.join.click();
    expect(f.nativeJoins()).toBe(1);
    f.ui.destroy();
  });

  test('start failures and refused choices use the browser’s status line', async () => {
    const f = fixture();
    f.refusePublic();
    await f.host().click();
    await f.view().querySelector('[data-visibility="public"]').click();
    expect(f.status.textContent).toBe('Public rooms are unavailable right now.');
    expect(f.rooms.visibility()).toBe('private');
    f.fail(new Error("Couldn't reach the room service. Try again in a moment."));
    await f.footButton('Start room').click();
    expect(f.statuses.at(-1)).toBe("Couldn't reach the room service. Try again in a moment.");
    expect(f.footButton('Start room').disabled).toBe(false);
    f.ui.destroy();
  });
});

describe('Your room', () => {
  test('manages the hosted room with the same groups, the invite and the players', async () => {
    const f = fixture();
    await f.hostNow();
    expect(f.host().textContent).toBe('Your room');
    await f.host().click();
    const view = f.view();
    expect(f.title.textContent).toBe('Your room');
    expect(groupTitles(view)).toEqual(['Room', 'Map', 'Invite', 'Players']);
    expect(view.querySelector('.qol-room-code').textContent).toBe('AAAA-AAAA-AAAA');
    expect(f.limitNote().textContent).toBe(`${uploadEstimate(16)} Now using 0.2 Mbps up.`);
    expect(f.details.at(-1)).toBe(true);
    expect(f.foot.children[0].textContent).toBe('End room');
    expect(f.foot.children[0].className).toBe('btn btn-danger qol-end-room');
    expect(f.foot.children[1].id).toBe('servers-status');
    expect(f.group.children.filter(node => !node.hidden).map(node => node.textContent)).toEqual(['Back']);
    await f.button('Change').click();
    expect(f.changes).toEqual(['change']);
    expect(f.pickers).toEqual([]);
    await f.button('Copy code').click();
    await f.button('Copy link').click();
    expect(f.copied()).toEqual(['AAAA-AAAA-AAAA', `https://surfd.net/?join=${ROOM}`]);
    expect(view.querySelectorAll('.qol-room-code ~ button, button').filter(node => node.textContent.startsWith('Cop')).map(node => node.textContent))
      .toEqual(['Copy code', 'Copied']);
    await view.querySelector('[data-visibility="public"]').click();
    expect(f.rooms.hosting().visibility).toBe('public');
    expect(view.textContent).toContain('Listed in Community for everyone with Surfd QoL.');
    await f.footButton('End room').click();
    expect(f.ended).toEqual([ROOM]);
    expect(f.layout.hidden).toBe(false);
    expect(f.host().textContent).toBe('Host a room');
    expect(f.footButton('End room')).toBeUndefined();
    expect(f.details.at(-1)).toBe(false);
    f.ui.destroy();
  });

  test('Save and Enter rename the room; Save waits for a changed name', async () => {
    const f = fixture();
    await f.hostNow();
    f.ui.openRoom();
    const input = f.nameInput(), save = f.button('Save');
    expect(save.hidden).toBe(false);
    expect(save.disabled).toBe(true);
    type(input, "Surfer's room ");
    expect(save.disabled).toBe(true);
    type(input, `  ${VALID.replace(' ', '  ')}`);
    expect(save.disabled).toBe(false);
    f.holdRename();
    const saving = save.click();
    expect(f.renames).toEqual([VALID]);
    expect(save.disabled).toBe(true);
    f.finishRename();
    await saving;
    expect(f.rooms.hosting().name).toBe(VALID);
    expect(input.value).toBe(VALID);
    expect(save.disabled).toBe(true);
    type(input, "Dawn_patrol's room");
    await input.parentNode.parentNode.onsubmit({preventDefault() {}});
    expect(f.renames).toEqual([VALID, "Dawn_patrol's room"]);
    expect(input.value).toBe("Dawn_patrol's room");
    expect(save.disabled).toBe(true);
    f.ui.destroy();
  });

  test('a refused name shows its reason under the field until it is edited', async () => {
    const f = fixture();
    await f.hostNow();
    f.ui.openRoom();
    const input = f.nameInput(), note = f.nameNote(), save = f.button('Save');
    type(input, 'ab');
    expect([note.textContent, note.className]).toEqual([roomNameProblem('ab'), 'input-error']);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(save.disabled).toBe(true);
    await save.click();
    expect(f.renames).toEqual([]);
    f.failRename('Room names can’t be changed right now.');
    type(input, VALID);
    expect(note.className).toBe('');
    await save.click();
    expect([note.textContent, note.className]).toEqual(['Room names can’t be changed right now.', 'input-error']);
    expect(input.value).toBe(VALID);
    expect(save.disabled).toBe(true);
    expect(f.rooms.hosting().name).toBe("Surfer's room");
    type(input, `${VALID} `);
    expect([note.textContent, note.className]).toEqual(['Shown in Find a server.', '']);
    expect(save.disabled).toBe(false);
    await f.footButton('Back').click();
    f.ui.openRoom();
    expect(f.nameInput().value).toBe("Surfer's room");
    expect(f.nameNote().className).toBe('');
    f.ui.destroy();
  });

  test('the player limit applies to the hosted room when it is committed', async () => {
    const f = fixture();
    await f.hostNow();
    f.ui.openRoom();
    const input = f.limitInput(), count = f.view().querySelector('.qol-room-players .group-title small');
    expect(input.value).toBe('16');
    expect(count.textContent).toBe('2 / 16');
    type(input, '24');
    expect(f.limits).toEqual([]);
    expect(f.limitNote().textContent).toBe(`${uploadEstimate(24)} Now using 0.2 Mbps up.`);
    await input.onchange();
    expect(f.limits).toEqual([24]);
    expect(count.textContent).toBe('2 / 24');
    type(input, '2'); await input.onchange();
    expect(count.textContent).toBe('2 / 2 · full');
    type(input, '2'); await input.onchange();
    expect(f.limits).toEqual([24, 2]);
    f.failLimit(new Error('The room couldn’t change its player limit.'));
    type(input, '30'); await input.onchange();
    expect(f.statuses.at(-1)).toBe('The room couldn’t change its player limit.');
    expect(input.value).toBe('2');
    f.ui.destroy();
  });

  test('lists who is in the room with the game’s guest look', async () => {
    const f = fixture({roster: [{name: 'Surfer', guest: false, you: true}, {name: 'Guest_1a2b3', guest: true}, {name: 'Morrow', guest: true}]});
    await f.hostNow();
    f.setPlayers(4);
    f.ui.openRoom();
    const view = f.view(), rows = view.querySelectorAll('.roster-list tr');
    expect(rows.map(row => row.textContent)).toEqual(['Surferyou', 'Guest_1a2b3Guest', 'MorrowGuest', '+1 more']);
    expect(rows[0].querySelector('.face').src).toBe('/menu/cosmetics/render/face-default.png');
    expect(rows[0].querySelector('.you-tag').textContent).toBe('you');
    expect(rows[1].querySelector('.rank-name').className).toBe('rank-name rank-guest');
    expect(rows[0].querySelector('.rank-name')).toBeNull();
    expect(view.querySelector('.qol-room-players .group-title small').textContent).toBe('4 / 16');
    const first = rows[0];
    f.ui.refresh();
    expect(view.querySelectorAll('.roster-list tr')[0]).toBe(first);
    f.setRoster([]); f.setPlayers(0); f.ui.refresh();
    expect(view.querySelector('.roster-list').hidden).toBe(true);
    expect(view.querySelector('.qol-room-players .empty').textContent).toBe('Nobody here yet.');
    expect(view.querySelector('.qol-room-players .empty').hidden).toBe(false);
    f.ui.destroy();
  });

  test('marks only the local roster entry even when a peer copies the host name', async () => {
    const f = fixture({roster: [{name: 'Surfer', guest: false}, {name: 'Surfer', guest: false, you: true}]});
    await f.hostNow();
    f.ui.openRoom();
    const labels = () => f.view().querySelectorAll('.roster-list tr').map(row => !!row.querySelector('.you-tag'));
    expect(labels()).toEqual([false, true]);
    f.setRoster([{name: 'Surfer', guest: false, you: true}, {name: 'Surfer', guest: false}]);
    f.ui.refresh();
    expect(labels()).toEqual([true, false]);
    f.setRoster([{name: 'Surfer', guest: false}]);
    f.setPlayers(1);
    f.ui.refresh();
    expect(labels()).toEqual([false]);
    f.ui.destroy();
  });

  test('a failed copy says so', async () => {
    const f = fixture();
    await f.hostNow();
    await f.host().click();
    f.failClipboard();
    const copyCode = f.button('Copy code');
    await copyCode.click();
    expect(copyCode.textContent).toBe('Copy failed');
    f.ui.destroy();
  });

  test('the room menu’s Your room opens the browser on the managing view', async () => {
    const f = fixture();
    await f.hostNow();
    f.root.hidden = true; f.ui.refresh();
    f.ui.openRoom();
    expect(f.opened).toEqual(['servers']);
    expect(f.title.textContent).toBe('Your room');
    expect(f.view().hidden).toBe(false);
    f.ui.destroy();
  });

  test('the map can be changed only from inside the room', async () => {
    const f = fixture();
    await f.hostNow();
    f.current(null);
    await f.host().click();
    expect(f.button('Change').hidden).toBe(true);
    f.ui.destroy();
  });
});

describe('server browser', () => {
  test('the room code field joins from the toolbar and explains refusals in the status line', async () => {
    const f = fixture();
    const form = f.toolbar.querySelector('.qol-code-join');
    expect(f.toolbar.children.map(node => node.className)).toEqual(['chips', 'qol-code-join', 'grow']);
    const input = form.querySelector('input'), submit = form.querySelector('button');
    expect(input.placeholder).toBe('Room code');
    expect([submit.textContent, submit.className, submit.type]).toEqual(['Join', 'btn small', 'submit']);
    let prevented = 0;
    const send = async value => { input.value = value; await form.onsubmit({preventDefault() { prevented++; }}); };
    await send('7GR6-3S7Y');
    expect(f.status.textContent).toBe('Check the room code.');
    await send('7gr6 3s7y fb9p');
    expect(f.status.textContent).toBe('This private room has closed.');
    const pending = send(' AAAA-aaaa-AAAA ');
    expect(submit.disabled).toBe(true);
    f.finishJoin();
    await pending;
    expect(f.joined).toEqual([ROOM]);
    expect(submit.disabled).toBe(false);
    expect(prevented).toBe(3);
    expect(f.nativeJoins()).toBe(0);
    f.ui.destroy();
    expect(f.toolbar.querySelector('.qol-code-join')).toBeNull();
  });

  test('community rows keep the game’s players cell and count', () => {
    const f = fixture();
    const row = new Element('tr'); row.dataset.id = ROOM; f.rowsBody.append(row);
    const cell = (className, value) => { const node = new Element('td'); node.className = className; node.textContent = value; row.append(node); return node; };
    const badgeCell = cell('', ''), badge = new Element('span'); badge.className = 'badge'; badge.textContent = 'Community'; badgeCell.append(badge);
    cell('', 'Loaded map');
    const players = cell('players-cell', '2 / 256'), bar = new Element('span'); bar.className = 'bar'; players.append(bar);
    const ping = cell('c-num', '—');
    f.rows.push({id: ROOM, visibility: 'private', players: 2, capacity: 256, online: true});
    f.select(ROOM); f.ui.refresh();
    expect(badge.textContent).toBe('Private');
    expect(players.children).toEqual([bar]);
    expect(players.textContent).toBe('2 / 256');
    expect(ping.textContent).toBe('');
    expect(f.detail.querySelector('.section-head small').textContent).toBe('2 / 16');
    f.ui.destroy();
  });

  test('community rows keep one detail line, spaced under the invite link', () => {
    const f = fixture();
    f.rows.push({id: ROOM, visibility: 'private', players: 3, online: true});
    f.select(ROOM); f.ui.refresh();
    const note = f.invite.nextElementSibling;
    expect([note.tag, note.className, note.textContent]).toEqual(['p', 'qol-room-note', 'Join with the room code or link.']);
    expect(f.info.querySelector('.sub').textContent).toBe('Private');
    const style = f.document.children.find(node => node.tag === 'style').textContent;
    expect(style).toContain('.server-detail .qol-room-note { margin: 10px 0 0; color: var(--m-muted); font-size: 12px; }');
    f.rows.at(-1).visibility = 'public'; f.ui.refresh();
    expect(f.info.textContent).toContain('Listed for everyone with Surfd QoL.');
    f.select('eu'); f.ui.refresh();
    expect(f.info.textContent).not.toContain('Surfd QoL');
    f.ui.destroy();
  });

  test('one CSS rule keyed on a class on <html> hides votes and official moderation in community rooms', () => {
    const f = fixture();
    const html = f.document.documentElement, style = f.document.children.find(node => node.tag === 'style');
    const [rule] = style.textContent.trim().split('\n');
    expect(rule).toStartWith(`html.${ROOM_CLASS} :is(`);
    for (const selector of ['#menu-server [data-act="nominate"]', '#menu-server [data-act="rtv"]', '#menu-server [data-act="extend"]',
      '#players-actions [data-act="reports"]', '#players-actions [data-act="panel"]', '.more-menu [data-act="moderate"]']) {
      expect(rule).toContain(selector);
    }
    expect(rule).toEndWith('{ display: none !important; }');
    expect(style.textContent).not.toContain('#players-actions [data-act="change"]');
    f.root.hidden = true; f.ui.refresh();
    const observer = [...Observer.instances].at(-1);
    f.current('eu'); f.ui.refresh();
    expect(html.classList.contains(ROOM_CLASS)).toBe(false);
    f.current(ROOM); f.ui.refresh();
    expect(html.classList.contains(ROOM_CLASS)).toBe(true);
    expect(observer.targets.size).toBe(0);
    f.current(null); f.ui.refresh();
    expect(html.classList.contains(ROOM_CLASS)).toBe(false);
    f.current(ROOM); f.ui.refresh();
    f.ui.destroy();
    expect(html.classList.contains(ROOM_CLASS)).toBe(false);
    expect(f.document.children.includes(style)).toBe(false);
  });

  test('a closed browser is not observed', () => {
    const f = fixture();
    const observer = [...Observer.instances].at(-1);
    expect(observer.targets.has(f.root)).toBe(true);
    f.root.hidden = true; f.ui.refresh();
    expect(observer.targets.size).toBe(0);
    f.ui.destroy();
  });
});
