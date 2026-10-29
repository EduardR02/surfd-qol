import {formatRoomCode, inviteLink, isPrivateRoomId} from './ids.js';
import {roomNameProblem} from './protocol.js';
import {CHOICES, NAME_HINT, attribute, buildRoomView, clampLimit, classes, courseText, hidden, normalizeName, rosterRows, text,
  uploadEstimate} from './ui-room.js';

export {uploadEstimate} from './ui-room.js';

const PRIVATE_ROW = 'Join with the room code or link.';
const PUBLIC_ROW = 'Listed for everyone with Surfd QoL.';
const PICKER_TITLE = 'Choose the room’s map';
const PICKER_HELP = 'Pick the map the room starts on.';
const NOBODY = 'Nobody here yet.';
const NOT_STARTED = 'Players show here once the room starts.';

export const ROOM_CLASS = 'qol-room';
// The first rule hides map votes and official-server moderation while in a community room.
export const ROOM_STYLE = `
html.${ROOM_CLASS} :is(#menu-server [data-act="nominate"], #menu-server [data-act="rtv"], #menu-server [data-act="extend"], #players-actions [data-act="reports"], #players-actions [data-act="panel"], .more-menu [data-act="moderate"]) { display: none !important; }
html.${ROOM_CLASS} #menu .menu-server { grid-template-columns: none; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); }
.qol-code-join { display: inline-flex; align-items: center; gap: 6px; }
.qol-code-join .field input { width: 150px; }
.qol-host-view { flex: 1; min-height: 0; overflow: auto; display: grid; grid-template-columns: minmax(500px, 1.6fr) minmax(220px, 1fr); grid-template-rows: minmax(0, 1fr); gap: 0 18px; }
.qol-host-view .qol-room-players { display: flex; flex-direction: column; min-height: 0; margin: 0; }
.qol-host-view .qol-room-players .table-wrap { flex: 1; }
@media (max-width: 1100px) { .qol-host-view { display: block; } }
.qol-host-view .field input { width: 220px; }
.qol-host-view .setting.qol-map-row { grid-template-columns: auto minmax(0, 1fr) auto; }
.qol-host-view .qol-room-code { padding: 5px 8px; border: 1px solid; border-color: var(--m-dark) var(--m-light) var(--m-light) var(--m-dark); background: var(--m-well); color: var(--m-ink); font: 13px/18px Consolas, monospace; letter-spacing: 1px; user-select: all; }
.qol-host-view .input-error { color: var(--m-behind); }
.qol-host-view input[aria-invalid="true"] { border-color: var(--m-behind); }
#servers-window .qol-end-room + .foot-note { margin-right: auto; }
.server-detail .qol-room-note { margin: 10px 0 0; color: var(--m-muted); font-size: 12px; }
`;

export function createRoomUi({rooms, getAdapter, document: doc = globalThis.document,
  MutationObserver: Observer = globalThis.MutationObserver, clipboard = globalThis.navigator?.clipboard}) {
  let root = null, nodes = null, picker = null, style = null;
  // 'list' is the game's server list; 'host' replaces it with Host a room, or Your room while hosting.
  let mode = 'list', draftMap = null, pickerEpoch = 1, copied = null;
  // The name and limit a new room starts with, and edits not yet saved to the hosted room.
  let draftName = null, draftLimit = null, nameEdit = null, nameError = '', limitEdit = null;
  let starting = false, joining = false, saving = false, destroyed = false, scheduled = false, wasOpen = false;
  let observedRoot, observedOpen, rosterKey = '';

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
  const failure = error => error?.message ?? String(error);

  function buildView() {
    const view = buildRoomView(doc);
    view.change.onclick = changeMap;
    view.copyCode.onclick = () => copy('code');
    view.copyLink.onclick = () => copy('link');
    view.name.oninput = () => {
      if (rooms.hosting()) nameEdit = view.name.value; else draftName = view.name.value;
      nameError = '';
      refresh();
    };
    view.nameForm.onsubmit = event => { event.preventDefault(); void saveName(); };
    for (const option of view.seg.children) option.onclick = () => choose(option.dataset.visibility);
    view.limit.oninput = () => { limitEdit = view.limit.value; refresh(); };
    view.limit.onchange = () => void setLimit();
    return view;
  }

  function mount(next) {
    unmount();
    root = next;
    const refreshButton = root?.querySelector('#servers-refresh'), join = root?.querySelector('#servers-join');
    if (!refreshButton || !join) return;
    const hostButton = button('Host a room'), back = button('Back'), start = button('Start room', 'btn btn-primary');
    const endButton = button('End room', 'btn btn-danger qol-end-room');
    back.hidden = true; start.hidden = true; endButton.hidden = true;
    hostButton.onclick = openView;
    back.onclick = () => { mode = 'list'; refresh(); };
    start.onclick = startRoom;
    endButton.onclick = end;
    refreshButton.before(hostButton);
    join.after(back);
    back.after(start);
    root.querySelector('#servers-status')?.before(endButton);

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
    nodes = {hostButton, back, start, endButton, refreshButton, join, form, code, submit, view, title, titleText: title?.textContent ?? '',
      layout: root.querySelector('.servers-layout'), note: element('p', 'qol-room-note')};
    rosterKey = '';
  }
  function unmount() {
    if (!nodes) return;
    const {hostButton, back, start, endButton, refreshButton, join, form, view, title, titleText, layout, note} = nodes;
    for (const node of [hostButton, back, start, endButton, form, view.view, note]) node.remove();
    hidden(refreshButton, false); hidden(join, false); hidden(layout, false);
    text(title, titleText);
    nodes = null;
  }

  function reset() {
    mode = 'host'; copied = null; nameEdit = null; nameError = ''; limitEdit = null;
  }
  function openView() {
    const adapter = getAdapter()?.rooms;
    if (!rooms.hosting() && adapter?.guest?.()) { adapter.signIn?.(); return; }
    reset();
    if (!rooms.hosting()) draftMap = adapter?.currentMap?.()?.id ?? null;
    refresh();
  }
  // The host's own Your room button in the game's room menu.
  function openRoom() {
    if (!rooms.hosting()) return;
    reset();
    getAdapter()?.rooms?.openBrowser?.();
    refresh();
  }
  const startName = () => normalizeName(draftName ?? rooms.roomName());
  const startLimit = () => draftLimit ?? rooms.maxPlayers();
  async function startRoom() {
    if (starting || rooms.hosting()) return;
    starting = true; refresh();
    try {
      await rooms.host({visibility: rooms.visibility(), mapId: draftMap, name: startName(), maxPlayers: startLimit()});
    } catch (error) { status(failure(error)); }
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
    catch (error) { status(failure(error)); }
    finally { joining = false; refresh(); }
  }
  function choose(value) {
    try { rooms.setVisibility(value); }
    catch (error) { status(failure(error)); }
    refresh();
  }
  // What Save would send, and whether it can: a changed name with no problem.
  function pendingName(hosting) {
    if (!hosting || nameEdit === null) return {name: null, problem: nameError || null};
    const name = normalizeName(nameEdit);
    if (name === hosting.name) return {name: null, problem: null};
    return {name, problem: nameError || roomNameProblem(name)};
  }
  async function saveName() {
    const hosting = rooms.hosting();
    const {name, problem} = pendingName(hosting);
    if (saving || !name || problem) return;
    saving = true; refresh();
    try {
      await rooms.rename(name);
      nameEdit = null; nameError = ''; draftName = name;
    } catch (error) { nameError = failure(error); }
    finally { saving = false; refresh(); }
  }
  async function setLimit() {
    const hosting = rooms.hosting(), value = clampLimit(limitEdit ?? '');
    if (value === null || !hosting || value === hosting.maxPlayers) {
      if (value !== null && !hosting) draftLimit = value;
      limitEdit = null;
      refresh();
      return;
    }
    limitEdit = String(value);
    refresh();
    try { await rooms.setMaxPlayers(value); draftLimit = value; }
    catch (error) { status(failure(error)); }
    limitEdit = null;
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
    const detail = root.querySelector('#server-detail'), note = nodes.note;
    const selected = rows.find(row => row.id === selectedId);
    const info = detail?.querySelector('.srv-info');
    if (!isPrivateRoomId(selected?.id) || !info) { note.remove(); return; }
    text(info.querySelector('.sub'), selected.visibility === 'public' ? 'Public' : 'Private');
    const ping = info.querySelector('[data-fact="ping"]');
    if (ping?.textContent === '—') text(ping, '');
    text(note, selected.visibility === 'public' ? PUBLIC_ROW : PRIVATE_ROW);
    const invite = info.querySelector('.invite-line');
    if (invite && note.previousElementSibling !== invite) invite.after(note);
  }

  function renderName(view, hosting) {
    const value = hosting ? nameEdit ?? hosting.name : draftName ?? rooms.roomName();
    if (view.name.value !== value) view.name.value = value;
    const {name, problem} = hosting ? pendingName(hosting) : {name: null, problem: roomNameProblem(startName())};
    text(view.nameNote, problem ?? NAME_HINT);
    classes(view.nameNote, problem ? 'input-error' : '');
    attribute(view.name, 'aria-invalid', problem ? 'true' : null);
    hidden(view.save, !hosting);
    view.save.disabled = saving || !name || !!problem;
    return !problem;
  }
  function renderLimit(view, hosting, limit) {
    const value = limitEdit ?? String(limit);
    if (view.limit.value !== value) view.limit.value = value;
    // While typing, the estimate follows the number only once it's a valid limit.
    const shown = limitEdit !== null && clampLimit(limitEdit) === Number(limitEdit) ? Number(limitEdit) : limit;
    const measured = Number.isFinite(hosting?.uploadMbps) ? ` Now using ${hosting.uploadMbps.toFixed(1)} Mbps up.` : '';
    text(view.limitNote, uploadEstimate(shown) + measured);
  }
  function renderMap(view, adapter, hosting) {
    const mapId = hosting ? hosting.mapId : draftMap;
    const map = adapter.maps().find(entry => entry.id === mapId);
    text(view.mapName, map?.title ?? mapId ?? 'Select a map first.');
    text(view.mapNote, courseText(map));
    const tier = Number.isInteger(map?.tier) && map.tier > 0 ? map.tier : 0;
    hidden(view.chip, !tier);
    if (tier) {
      classes(view.chip, `tier-chip t${tier}`);
      text(view.chipShort, `T${tier}`);
      text(view.chipLong, `Tier ${tier}`);
    }
    // The game's own preview images, as its server list and details use.
    const src = map?.slug ? `/previews/${map.slug}.jpg` : '';
    attribute(view.thumb, 'src', src || null);
    hidden(view.thumb, !src);
    hidden(view.change, hosting ? !adapter.changeMap || rooms.currentRoom?.() !== hosting.id : !adapter.mapPicker);
  }
  function renderPlayers(view, hosting, limit) {
    const roster = hosting ? rooms.roomInfo?.(hosting.id)?.roster ?? [] : [];
    const players = roster.map(player => ({name: player.name, guest: player.guest === true, you: player.you === true}));
    const count = hosting?.players ?? 0;
    text(view.count, `${count} / ${limit}${count >= limit ? ' · full' : ''}`);
    const key = JSON.stringify([players, count]);
    if (key !== rosterKey) {
      rosterKey = key;
      view.roster.replaceChildren(...rosterRows(element, players, count));
    }
    hidden(view.table, !players.length);
    hidden(view.empty, !!players.length);
    text(view.empty, hosting ? NOBODY : NOT_STARTED);
  }
  function renderView(adapter, hosting) {
    const view = nodes.view;
    const nameOk = renderName(view, hosting);
    const visibility = hosting?.visibility ?? rooms.visibility();
    for (const option of view.seg.children) attribute(option, 'aria-pressed', String(option.dataset.visibility === visibility));
    text(view.accessNote, CHOICES.find(([value]) => value === visibility)[2]);
    const limit = hosting ? hosting.maxPlayers : startLimit();
    renderLimit(view, hosting, limit);
    renderMap(view, adapter, hosting);
    renderPlayers(view, hosting, limit);
    hidden(view.invite, !hosting);
    if (!hosting) return nameOk;
    text(view.code, formatRoomCode(hosting.id));
    const label = (kind, idle) => copied?.kind === kind && copied.id === hosting.id ? (copied.ok ? 'Copied' : 'Copy failed') : idle;
    text(view.copyCode, label('code', 'Copy code'));
    text(view.copyLink, label('link', 'Copy link'));
    return nameOk;
  }
  function render(adapter, hosting) {
    const host = mode === 'host';
    const {hostButton, back, start, endButton, refreshButton, join, submit, view, title, titleText, layout} = nodes;
    hidden(layout, host); hidden(view.view, !host);
    text(title, host ? (hosting ? 'Your room' : 'Host a room') : titleText);
    text(hostButton, hosting ? 'Your room' : 'Host a room');
    hidden(hostButton, host); hidden(refreshButton, host); hidden(join, host);
    hidden(back, !host); hidden(start, !host || !!hosting); hidden(endButton, !host || !hosting);
    hostButton.disabled = starting;
    submit.disabled = joining;
    if (!host) return;
    const nameOk = renderView(adapter, hosting);
    text(start, starting ? 'Starting…' : 'Start room');
    start.disabled = starting || !draftMap || !nameOk;
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
