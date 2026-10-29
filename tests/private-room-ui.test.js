import {describe, expect, test} from 'bun:test';
import {createRoomUi, uploadEstimate} from '../src/private-rooms/ui.js';
import {estimateBandwidth} from '../src/private-rooms/bandwidth.js';
import {parseRoomCode} from '../src/private-rooms/ids.js';

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
  append(...nodes) { for (const node of nodes) {node.remove(); node.parentNode = this; this.children.push(node);} }
  remove() { if (this.parentNode) {this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null;} }
  before(node) { const parent = this.parentNode; node.remove(); node.parentNode = parent; parent.children.splice(parent.children.indexOf(this), 0, node); }
  after(node) { const parent = this.parentNode; node.remove(); node.parentNode = parent; parent.children.splice(parent.children.indexOf(this) + 1, 0, node); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  async click() { if (!this.disabled) await this.onclick?.(); }
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
const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };

function fixture({guest = false} = {}) {
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
  const roster = add(detail, 'div', '', 'srv-roster');
  const head = add(roster, 'div', '', 'section-head'); add(head, 'small', '', '', '2 / 16');
  const foot = add(root, 'footer', '', 'window-foot');
  const status = add(foot, 'span', 'servers-status', 'foot-note');
  const group = add(foot, 'div', '', 'foot-group');
  const refresh = add(group, 'button', 'servers-refresh', 'btn', 'Refresh');
  const join = add(group, 'button', 'servers-join', 'btn btn-primary', 'Join');
  let visibility = 'private', hosting = null, current = null, selected = 'eu', failure = null, nativeJoins = 0, signIns = 0;
  let name = "Surfer's room", copiedText = [], clipboardFails = false;
  const calls = [], ended = [], details = [], joined = [], rows = [{id: 'eu', region: 'Europe', players: 4, online: true}];
  let finishJoin = null;
  const rooms = {
    visibility: () => visibility, hosting: () => hosting, currentRoom: () => current, roomName: () => hosting?.name ?? name,
    showHostDetails: value => details.push(value),
    setVisibility(value) {
      if (value === 'public' && /surfd/i.test(name)) throw new Error("Rooms with Surfd or official in the name can't be public.");
      visibility = value;
      if (hosting) hosting.visibility = value;
    },
    rename(value) {
      if (!/^[A-Za-z0-9_-]{3,24}'s room$/.test(value)) throw new Error("Use 3–24 letters, digits, _ or - before 's room.");
      name = value;
      if (hosting) hosting.name = value;
    },
    async host(options) {
      calls.push(options);
      if (failure) throw failure;
      hosting = {id: ROOM, visibility: options.visibility, name: options.name, mapId: options.mapId, players: 2, uploadMbps: 0.2};
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
    rows: () => rows, selected: () => selected, currentMap: () => ({id: 'map'}),
    maps: () => [{id: 'map', title: 'Loaded map', tier: 3}, {id: 'other', title: 'Other map', tier: 1}],
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
  const footButton = label => group.children.find(node => node.textContent === label && !node.hidden);
  return {ui, rooms, adapter, document, root, title, layout, toolbar, rowsBody, detail, info, invite, foot, group, status, refresh, join, calls, ended, details, rows,
    pickers, statuses, opened, changes, copied: () => copiedText, failClipboard: () => { clipboardFails = true; },
    joined, finishJoin: () => finishJoin(),
    view: () => body.querySelector('.qol-host-view'), footButton,
    host: () => group.children[0], nativeJoins: () => nativeJoins, signIns: () => signIns,
    fail: error => { failure = error; }, select: id => { selected = id; }, current: id => { current = id; },
    hostNow: () => rooms.host({visibility: 'private', mapId: 'map', name}).then(() => { root.hidden = false; ui.refresh(); })};
}
const groupTitles = view => view.querySelectorAll('.group-title').filter(node => !node.parentNode.hidden).map(node => node.textContent);

describe('Host a room', () => {
  test('replaces the server list with the host view in the same window', async () => {
    const f = fixture();
    expect(f.host().textContent).toBe('Host a room');
    expect(f.refresh.previousElementSibling).toBe(f.host());
    await f.host().click();
    const view = f.view();
    expect(f.title.textContent).toBe('Host a room');
    expect(f.layout.hidden).toBe(true);
    expect(view.hidden).toBe(false);
    expect(view.className).toBe('settings-window qol-host-view');
    expect(groupTitles(view)).toEqual(['Map', 'Room name', 'Who can join', 'Upload']);
    expect(f.group.children.filter(node => !node.hidden).map(node => node.textContent)).toEqual(['Back', 'Start room']);
    expect(f.footButton('Start room').className).toBe('btn btn-primary');
    expect(view.querySelector('.setting-label').textContent).toBe('Loaded map T3Tier 3');
    expect(view.querySelector('.tier-chip').className).toBe('tier-chip t3');
    expect(view.querySelector('input').value).toBe("Surfer's room");
    expect(view.querySelector('[data-visibility="private"]').getAttribute('aria-pressed')).toBe('true');
    expect(view.textContent).toContain('Only people with the room code or link');
    expect(view.querySelector('.setting-note').textContent).toBe(uploadEstimate());
    expect(f.details.at(-1)).toBe(false);
    f.ui.destroy();
    expect(f.title.textContent).toBe('Find a server');
    expect(f.layout.hidden).toBe(false);
    expect(f.group.children.map(node => node.textContent)).toEqual(['Refresh', 'Join']);
  });

  test('the upload line gives real estimates to one decimal', () => {
    const up = players => estimateBandwidth(players).upload.toFixed(1);
    expect(uploadEstimate()).toBe(`8 players need about ${up(8)} Mbps up, 16 about ${up(16)}.`);
    expect(uploadEstimate()).toMatch(/^8 players need about \d+\.\d Mbps up, 16 about \d+\.\d\.$/);
  });

  test('Change opens the game’s map dialog for the starting map and Start room hosts on it', async () => {
    const f = fixture();
    await f.host().click();
    await f.view().querySelector('.setting-control button').click();
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
    expect(f.view().querySelector('.setting-label').textContent).toBe('Other map T1Tier 1');
    await f.view().querySelector('.setting-control button').click();
    expect(f.pickers).toHaveLength(1);
    expect(picker.opens).toBe(2);
    await f.view().querySelector('[data-visibility="public"]').click();
    await f.footButton('Start room').click();
    expect(f.calls).toEqual([{visibility: 'public', mapId: 'other', name: "Surfer's room"}]);
    expect(f.nativeJoins()).toBe(0);
    f.ui.destroy();
    expect(picker.closed).toBe(true);
  });

  test('Back and closing the window return to the server list', async () => {
    const f = fixture();
    await f.host().click();
    await f.footButton('Back').click();
    expect(f.layout.hidden).toBe(false);
    expect(f.view().hidden).toBe(true);
    expect(f.title.textContent).toBe('Find a server');
    expect(f.group.children.filter(node => !node.hidden).map(node => node.textContent)).toEqual(['Host a room', 'Refresh', 'Join']);
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

  test('a refused room name shows its reason under the field and keeps the old name', async () => {
    const f = fixture();
    await f.host().click();
    const input = f.view().querySelector('input'), problem = f.view().querySelector('.qol-name-error');
    expect(problem.hidden).toBe(true);
    input.value = 'Friday surf'; input.onchange();
    expect(problem.hidden).toBe(false);
    expect(problem.textContent).toBe("Use 3–24 letters, digits, _ or - before 's room.");
    expect(input.value).toBe("Surfer's room");
    input.value = "  Fridays's room "; input.onchange();
    expect(problem.hidden).toBe(true);
    expect(input.value).toBe("Fridays's room");
    await f.footButton('Start room').click();
    expect(f.calls[0].name).toBe("Fridays's room");
    f.ui.destroy();
  });

  test('start failures and refused choices use the browser’s status line', async () => {
    const f = fixture();
    f.rooms.rename("Surfd_crew's room");
    await f.host().click();
    await f.view().querySelector('[data-visibility="public"]').click();
    expect(f.status.textContent).toBe("Rooms with Surfd or official in the name can't be public.");
    expect(f.rooms.visibility()).toBe('private');
    f.fail(new Error("Couldn't reach the room service. Try again in a moment."));
    await f.footButton('Start room').click();
    expect(f.statuses.at(-1)).toBe("Couldn't reach the room service. Try again in a moment.");
    expect(f.footButton('Start room').disabled).toBe(false);
    f.ui.destroy();
  });
});

describe('Your room', () => {
  test('manages the hosted room in the same view', async () => {
    const f = fixture();
    await f.hostNow();
    expect(f.host().textContent).toBe('Your room');
    await f.host().click();
    const view = f.view();
    expect(f.title.textContent).toBe('Your room');
    expect(groupTitles(view)).toEqual(['Map', 'Room code', 'Room name', 'Who can join', 'Players']);
    expect(view.querySelector('.qol-room-code').textContent).toBe('AAAA-AAAA-AAAA');
    expect(view.textContent).toContain('2 players');
    expect(view.textContent).toContain('Now using 0.2 Mbps up');
    expect(view.querySelector('.setting-note').textContent).toBe(uploadEstimate());
    expect(f.details.at(-1)).toBe(true);
    const end = f.footButton('End room');
    expect(end.className).toBe('btn btn-danger');
    await view.querySelector('.setting-control button').click();
    expect(f.changes).toEqual(['change']);
    expect(f.pickers).toEqual([]);
    const [copyCode, copyLink] = view.querySelectorAll('.setting-control button').filter(node => node.textContent.startsWith('Copy'));
    await copyCode.click();
    await copyLink.click();
    expect(f.copied()).toEqual(['AAAA-AAAA-AAAA', `https://surfd.net/?join=${ROOM}`]);
    expect(copyLink.textContent).toBe('Copied');
    await view.querySelector('[data-visibility="public"]').click();
    expect(f.rooms.hosting().visibility).toBe('public');
    expect(view.textContent).toContain('Listed in Community for everyone with Surfd QoL');
    const input = view.querySelector('input');
    input.value = "Night_owls's room"; input.onchange();
    expect(f.rooms.hosting().name).toBe("Night_owls's room");
    await end.click();
    expect(f.ended).toEqual([ROOM]);
    expect(f.layout.hidden).toBe(false);
    expect(f.host().textContent).toBe('Host a room');
    expect(f.details.at(-1)).toBe(false);
    f.ui.destroy();
  });

  test('a failed copy says so', async () => {
    const f = fixture();
    await f.hostNow();
    await f.host().click();
    f.failClipboard();
    const copyCode = f.view().querySelectorAll('button').find(node => node.textContent === 'Copy code');
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
    expect(f.view().querySelector('.setting-control button').hidden).toBe(true);
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

  test('community rows keep one detail line', () => {
    const f = fixture();
    f.rows.push({id: ROOM, visibility: 'private', players: 3, online: true});
    f.select(ROOM); f.ui.refresh();
    expect(f.invite.parentNode.children[f.invite.parentNode.children.indexOf(f.invite) + 1].textContent).toBe('Join with the room code or link.');
    f.rows.at(-1).visibility = 'public'; f.ui.refresh();
    expect(f.info.textContent).toContain('Listed for everyone with Surfd QoL.');
    f.select('eu'); f.ui.refresh();
    expect(f.info.textContent).not.toContain('Surfd QoL');
    f.ui.destroy();
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
