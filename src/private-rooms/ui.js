import {formatRoomCode, inviteLink, isPrivateRoomId} from './ids.js';
import {estimateBandwidth} from './bandwidth.js';

const PRIVATE_ROW = 'Join with the room code or link.';
const PUBLIC_ROW = 'Listed for everyone with Surfd QoL.';
const PICKER_TITLE = 'Choose the room’s map';
const PICKER_HELP = 'Pick the map the room starts on.';
const CHOICES = [
  ['private', 'Private', 'Only people with the room code or link'],
  ['public', 'Public', 'Listed in Community for everyone with Surfd QoL'],
];

export const ROOM_CLASS = 'qol-room';
// The first rule hides map votes and official-server moderation while in a community room.
export const ROOM_STYLE = `
html.${ROOM_CLASS} :is(#menu-server [data-act="nominate"], #menu-server [data-act="rtv"], #menu-server [data-act="extend"], #players-actions [data-act="reports"], #players-actions [data-act="panel"], .more-menu [data-act="moderate"]) { display: none !important; }
html.${ROOM_CLASS} #menu .menu-server { grid-template-columns: none; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); }
.qol-code-join { display: inline-flex; align-items: center; gap: 6px; }
.qol-code-join .field input { width: 150px; }
.qol-host-view { flex: 1; min-height: 0; overflow: auto; }
.qol-host-view .field input { width: 220px; }
.qol-host-view .setting code.qol-room-code { padding: 0; background: none; color: var(--m-ink); font: 700 22px/1.3 Consolas, monospace; letter-spacing: 2px; }
.qol-host-view .qol-name-error { color: var(--m-behind); }
.server-detail .qol-room-note { margin: 10px 0 0; color: var(--m-muted); font-size: 12px; }
`;

export function uploadEstimate() {
  const up = players => estimateBandwidth(players).upload.toFixed(1);
  return `8 players need about ${up(8)} Mbps up, 16 about ${up(16)}.`;
}

const text = (node, value) => { if (node && node.textContent !== value) node.textContent = value; };
const hidden = (node, value) => { if (node && node.hidden !== value) node.hidden = value; };
const classes = (node, value) => { if (node && node.className !== value) node.className = value; };

export function createRoomUi({rooms, getAdapter, document: doc = globalThis.document,
  MutationObserver: Observer = globalThis.MutationObserver, clipboard = globalThis.navigator?.clipboard}) {
  let root = null, nodes = null, picker = null, style = null;
  // 'list' is the game's server list; 'host' replaces it with Host a room, or Your room while hosting.
  let mode = 'list', draftMap = null, pickerEpoch = 1, nameError = '', copied = null;
  let starting = false, joining = false, destroyed = false, scheduled = false, wasOpen = false;
  let observedRoot, observedOpen;

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
  function status(message) {
    const adapter = getAdapter()?.rooms;
    if (adapter?.setStatus) adapter.setStatus(message);
    else text(root?.querySelector('#servers-status'), message);
  }

  function buildView() {
    const view = element('div', 'settings-window qol-host-view');
    view.hidden = true;
    const group = title => {
      const node = element('div', 'group'), heading = element('h4', 'group-title', title);
      node.append(heading);
      view.append(node);
      return {node, heading};
    };
    const row = parent => {
      const setting = element('div', 'setting'), info = element('div', 'setting-text'), control = element('div', 'setting-control');
      setting.append(info, control);
      parent.append(setting);
      return {setting, info, control};
    };
    const map = row(group('Map').node);
    const mapName = element('span'), chip = element('span', 'tier-chip'), chipShort = element('span'), chipLong = element('span', 'visually-hidden');
    chipShort.setAttribute('aria-hidden', 'true');
    chip.append(chipShort, chipLong);
    const mapTitle = element('span', 'setting-label');
    mapTitle.append(mapName, doc.createTextNode(' '), chip);
    map.info.append(mapTitle);
    const change = button('Change');
    change.onclick = changeMap;
    map.control.append(change);

    const codeGroup = group('Room code');
    const codeRow = row(codeGroup.node);
    const code = element('code', 'qol-room-code');
    codeRow.info.append(code);
    const copyCode = button('Copy code'), copyLink = button('Copy link');
    copyCode.onclick = () => copy('code');
    copyLink.onclick = () => copy('link');
    codeRow.control.append(copyCode, copyLink);

    const nameRow = row(group('Room name').node);
    const field = element('label', 'field'), name = element('input'), nameProblem = element('small', 'qol-name-error');
    name.type = 'text'; name.maxLength = 31; name.spellcheck = false; name.autocomplete = 'off';
    name.setAttribute('aria-label', 'Room name');
    name.onchange = rename;
    nameProblem.hidden = true;
    field.append(name);
    nameRow.info.append(field, nameProblem);

    const access = row(group('Who can join').node);
    const accessHelp = element('span', 'setting-label');
    access.info.append(accessHelp);
    const seg = element('div', 'seg');
    seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'Who can join');
    for (const [value, label] of CHOICES) {
      const option = button(label, '');
      option.dataset.visibility = value;
      option.onclick = () => choose(value);
      seg.append(option);
    }
    access.control.append(seg);

    const load = group('Upload');
    const players = row(load.node);
    const count = element('span', 'setting-label'), usage = element('small');
    players.info.append(count, usage);
    const estimate = element('p', 'setting-note', uploadEstimate());
    load.node.append(estimate);
    return {view, mapName, chip, chipShort, chipLong, change, codeGroup: codeGroup.node, code, copyCode, copyLink,
      name, nameProblem, accessHelp, seg, loadTitle: load.heading, players: players.setting, count, usage, estimate};
  }

  function mount(next) {
    unmount();
    root = next;
    const refreshButton = root?.querySelector('#servers-refresh'), join = root?.querySelector('#servers-join');
    if (!refreshButton || !join) return;
    const hostButton = button('Host a room'), back = button('Back'), start = button('Start room', 'btn btn-primary');
    back.hidden = true; start.hidden = true;
    hostButton.onclick = openView;
    back.onclick = () => { mode = 'list'; refresh(); };
    start.onclick = () => rooms.hosting() ? end() : startRoom();
    refreshButton.before(hostButton);
    join.after(back);
    back.after(start);

    const form = element('form', 'qol-code-join'), field = element('label', 'field'), code = element('input');
    code.type = 'text'; code.placeholder = 'Room code'; code.spellcheck = false; code.autocomplete = 'off';
    code.setAttribute('aria-label', 'Room code');
    const submit = button('Join', 'btn small');
    submit.type = 'submit';
    field.append(code);
    form.append(field, submit);
    form.onsubmit = event => { event.preventDefault(); joinCode(); };
    const toolbar = root.querySelector('.toolbar'), grow = toolbar?.querySelector('.grow');
    if (grow) grow.before(form); else toolbar?.append(form);

    const view = buildView();
    root.querySelector('.window-body')?.append(view.view);
    const title = root.querySelector('.titlebar h2');
    nodes = {hostButton, back, start, refreshButton, join, form, code, submit, view, title, titleText: title?.textContent ?? '',
      layout: root.querySelector('.servers-layout'), help: element('p', 'qol-room-note')};
  }
  function unmount() {
    if (!nodes) return;
    const {hostButton, back, start, refreshButton, join, form, view, title, titleText, layout, help} = nodes;
    for (const node of [hostButton, back, start, form, view.view, help]) node.remove();
    hidden(refreshButton, false); hidden(join, false); hidden(layout, false);
    text(title, titleText);
    nodes = null;
  }

  function openView() {
    const adapter = getAdapter()?.rooms;
    if (!rooms.hosting() && adapter?.guest?.()) { adapter.signIn?.(); return; }
    mode = 'host'; nameError = ''; copied = null;
    if (!rooms.hosting()) draftMap = adapter?.currentMap?.()?.id ?? null;
    refresh();
  }
  // The host's own Your room button in the game's room menu.
  function openRoom() {
    if (!rooms.hosting()) return;
    mode = 'host'; nameError = ''; copied = null;
    getAdapter()?.rooms?.openBrowser?.();
    refresh();
  }
  async function startRoom() {
    if (starting) return;
    starting = true; refresh();
    try { await rooms.host({visibility: rooms.visibility(), mapId: draftMap, name: rooms.roomName()}); }
    catch (error) { status(error?.message ?? String(error)); }
    finally { starting = false; refresh(); }
  }
  function end() {
    rooms.end();
    mode = 'list';
    refresh();
  }
  async function joinCode() {
    if (joining || !nodes) return;
    joining = true; refresh();
    try { await rooms.joinCode(nodes.code.value); }
    catch (error) { status(error?.message ?? String(error)); }
    finally { joining = false; refresh(); }
  }
  function choose(value) {
    try { rooms.setVisibility(value); }
    catch (error) { status(error?.message ?? String(error)); }
    refresh();
  }
  function rename() {
    const input = nodes?.view.name;
    if (!input) return;
    try {
      rooms.rename(input.value.trim());
      nameError = '';
    } catch (error) { nameError = error?.message ?? String(error); }
    input.value = rooms.roomName();
    refresh();
  }
  async function copy(kind) {
    const id = rooms.hosting()?.id;
    if (!id) return;
    let ok = false;
    try {
      await clipboard.writeText(kind === 'code' ? formatRoomCode(id) : inviteLink(id));
      ok = true;
    } catch { /* The page may not be allowed to write the clipboard. */ }
    copied = {kind, ok, id};
    refresh();
  }
  const currentMapId = () => getAdapter()?.rooms?.currentMap?.()?.id ?? null;
  function changeMap() {
    const adapter = getAdapter()?.rooms;
    if (rooms.hosting()) { adapter?.changeMap?.(); return; }
    if (!picker) {
      picker = adapter?.mapPicker?.({
        allowed: () => true,
        maps: () => getAdapter()?.rooms?.maps() ?? [],
        // The map you're on is marked only while it's the chosen one, so it can be chosen again after another.
        state: () => ({mapId: draftMap === currentMapId() ? draftMap : null, epoch: pickerEpoch}),
        change: id => { pick(id); return true; },
      }) ?? null;
      const dialog = picker?.dialog;
      if (!dialog?.classList?.contains('map-change-window')) return;
      text(dialog.querySelector('.nominate-head h2'), PICKER_TITLE);
      dialog.setAttribute('aria-label', PICKER_TITLE);
      hidden(dialog.querySelector('.nominate-foot'), true);
    }
    picker?.open();
    text(picker?.dialog?.querySelector('.map-change-status'), PICKER_HELP);
  }
  function pick(id) {
    draftMap = id;
    const epoch = ++pickerEpoch;
    // The game's dialog closes on a new epoch; it must see it after its own click handler returns.
    queueMicrotask(() => picker?.state({mapId: id, epoch}));
    refresh();
  }

  // Only an open browser is observed; the game's open and close callbacks report the rest.
  function observe(open) {
    if (root === observedRoot && open === observedOpen) return;
    observedRoot = root; observedOpen = open;
    observer?.disconnect();
    if (root && open) observer?.observe(root, {attributes: true, attributeFilter: ['hidden', 'class'], childList: true, subtree: true});
  }
  function patchRows(rows) {
    const rowNodes = new Map([...root.querySelectorAll('#server-rows tr[data-id]')].map(node => [node.dataset.id, node]));
    for (const row of rows) {
      const node = isPrivateRoomId(row.id) ? rowNodes.get(row.id) : null;
      if (!node) continue;
      text(node.querySelector('.badge'), row.visibility === 'public' ? 'Public' : 'Private');
      const cells = node.querySelectorAll('td');
      if (cells[3]?.textContent === '—') text(cells[3], '');
    }
  }
  function patchDetail(rows, selectedId) {
    const detail = root.querySelector('#server-detail'), help = nodes.help;
    const selected = rows.find(row => row.id === selectedId);
    const info = detail?.querySelector('.srv-info');
    if (!isPrivateRoomId(selected?.id) || !info) { help.remove(); return; }
    text(info.querySelector('.sub'), selected.visibility === 'public' ? 'Public' : 'Private');
    const ping = info.querySelector('[data-fact="ping"]');
    if (ping?.textContent === '—') text(ping, '');
    text(help, selected.visibility === 'public' ? PUBLIC_ROW : PRIVATE_ROW);
    const invite = info.querySelector('.invite-line');
    if (invite && help.previousElementSibling !== invite) invite.after(help);
  }
  function renderView(adapter, hosting) {
    const view = nodes.view;
    const mapId = hosting ? hosting.mapId : draftMap;
    const map = adapter.maps().find(entry => entry.id === mapId);
    text(view.mapName, map?.title ?? mapId ?? 'Select a map first.');
    const tier = Number.isInteger(map?.tier) && map.tier > 0 ? map.tier : 0;
    hidden(view.chip, !tier);
    if (tier) {
      classes(view.chip, `tier-chip t${tier}`);
      text(view.chipShort, `T${tier}`);
      text(view.chipLong, `Tier ${tier}`);
    }
    hidden(view.change, hosting ? !adapter.changeMap || rooms.currentRoom?.() !== hosting.id : !adapter.mapPicker);

    hidden(view.codeGroup, !hosting);
    if (hosting) {
      text(view.code, formatRoomCode(hosting.id));
      const label = (kind, idle) => copied?.kind === kind && copied.id === hosting.id ? (copied.ok ? 'Copied' : 'Copy failed') : idle;
      text(view.copyCode, label('code', 'Copy code'));
      text(view.copyLink, label('link', 'Copy link'));
    }

    if (doc.activeElement !== view.name && view.name.value !== rooms.roomName()) view.name.value = rooms.roomName();
    text(view.nameProblem, nameError);
    hidden(view.nameProblem, !nameError);

    const visibility = hosting?.visibility ?? rooms.visibility();
    for (const option of view.seg.children) {
      const pressed = String(option.dataset.visibility === visibility);
      if (option.getAttribute('aria-pressed') !== pressed) option.setAttribute('aria-pressed', pressed);
    }
    text(view.accessHelp, CHOICES.find(([value]) => value === visibility)[2]);

    text(view.loadTitle, hosting ? 'Players' : 'Upload');
    hidden(view.players, !hosting);
    if (hosting) {
      text(view.count, `${hosting.players} player${hosting.players === 1 ? '' : 's'}`);
      const measured = Number.isFinite(hosting.uploadMbps);
      text(view.usage, measured ? `Now using ${hosting.uploadMbps.toFixed(1)} Mbps up` : '');
      hidden(view.usage, !measured);
    }
  }
  function render(adapter, hosting) {
    const host = mode === 'host';
    const {hostButton, back, start, refreshButton, join, submit, view, title, titleText, layout} = nodes;
    hidden(layout, host); hidden(view.view, !host);
    text(title, host ? (hosting ? 'Your room' : 'Host a room') : titleText);
    text(hostButton, hosting ? 'Your room' : 'Host a room');
    hidden(hostButton, host); hidden(refreshButton, host); hidden(join, host);
    hidden(back, !host); hidden(start, !host);
    hostButton.disabled = starting;
    submit.disabled = joining;
    if (!host) return;
    if (hosting) {
      classes(start, 'btn btn-danger'); text(start, 'End room'); start.disabled = false;
    } else {
      classes(start, 'btn btn-primary'); text(start, starting ? 'Starting…' : 'Start room');
      start.disabled = starting || !draftMap;
    }
    renderView(adapter, hosting);
  }
  function refresh() {
    if (destroyed || !doc) return;
    const adapter = getAdapter()?.rooms;
    const inRoom = isPrivateRoomId(rooms.currentRoom?.()), html = doc.documentElement;
    if (html && html.classList.contains(ROOM_CLASS) !== inRoom) html.classList.toggle(ROOM_CLASS, inRoom);
    const next = adapter?.root?.() ?? null;
    if (next !== root) mount(next);
    const open = !!root && (adapter?.browserOpen?.() ?? !root.hidden);
    observe(open);
    rooms.browserVisibility?.(open);
    // The window opens on the server list again after it closes, as when the game joins a room.
    if (wasOpen && !open) mode = 'list';
    wasOpen = open;
    const hosting = rooms.hosting();
    rooms.showHostDetails?.(open && mode === 'host' && !!hosting);
    if (!open || !nodes) return;
    const rows = adapter.rows();
    patchRows(rows);
    patchDetail(rows, adapter.selected?.());
    render(adapter, hosting);
  }
  const observer = doc && Observer ? new Observer(() => {
    if (scheduled || destroyed) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; refresh(); });
  }) : null;
  if (doc) {
    style = element('style');
    style.textContent = ROOM_STYLE;
    (doc.head ?? doc.documentElement)?.append(style);
  }
  refresh();
  return {
    refresh, openRoom,
    destroy() {
      destroyed = true;
      observer?.disconnect();
      unmount();
      style?.remove();
      doc?.documentElement?.classList.remove(ROOM_CLASS);
      picker?.close?.();
      picker?.dialog?.remove?.();
      picker = null;
    }
  };
}
