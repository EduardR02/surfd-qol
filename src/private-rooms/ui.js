import {isPrivateRoomId} from './ids.js';
import {estimateBandwidth} from './bandwidth.js';
import {MAX_ROOM_PLAYERS} from './protocol.js';

const PRIVATE_HELP = 'Only people with this link can join. They need Surfd QoL.';
const PUBLIC_HELP = 'Listed for everyone with Surfd QoL.';
const text = (node, value) => { if (node && node.textContent !== value) node.textContent = value; };
const hidden = (node, value) => { if (node && node.hidden !== value) node.hidden = value; };
const decimal = value => value.toFixed(1);

export function bandwidthTooltip() {
  return [8, 16, 32].map(players => {
    const {upload, download} = estimateBandwidth(players);
    return `${players} players: about ${decimal(upload)} Mbps up · ${decimal(download)} Mbps down`;
  }).join('\n');
}

export function bandwidthDetail(players, uploadMbps) {
  const {upload, download} = estimateBandwidth(players);
  const extra = players < MAX_ROOM_PLAYERS ? estimateBandwidth(players + 1).upload - upload : upload - estimateBandwidth(players - 1).upload;
  return `${players} players need about ${decimal(upload)} Mbps up and ${decimal(download)} Mbps down. Each extra player adds about ${decimal(extra)} Mbps up.`
    + (Number.isFinite(uploadMbps) ? ` Now using ${decimal(uploadMbps)} Mbps up.` : '');
}

export function createRoomUi({rooms, getAdapter, document: doc = globalThis.document, MutationObserver: Observer = globalThis.MutationObserver}) {
  let root = null, hostButton = null, draft = null, help = null, choices = null, bandwidth = null;
  let staging = false, pending = false, destroyed = false, scheduled = false;
  let joinLabel = '', joinDisabled = false;
  const votes = new Map();
  // Looked up when needed: the game may build its room menu after the extension attaches.
  let menu = null;
  const roomMenu = () => menu?.isConnected ? menu : (menu = doc?.querySelector('.room-menu-actions') ?? null);
  let observedRoot, observedOpen, observedCommunity, observedMenu;
  function observe(open, community) {
    const actions = community ? roomMenu() : null;
    if (root === observedRoot && open === observedOpen && community === observedCommunity && actions === observedMenu) return;
    observedRoot = root; observedOpen = open; observedCommunity = community; observedMenu = actions;
    observer?.disconnect();
    if (root && open) observer?.observe(root, {attributes: true, attributeFilter: ['hidden', 'class'], childList: true, subtree: true});
    if (actions) observer?.observe(actions, {attributes: true, attributeFilter: ['hidden', 'class'], childList: true, subtree: true});
  }
  const button = (label, className = 'btn') => {
    const node = doc.createElement('button');
    node.type = 'button'; node.className = className; node.textContent = label;
    return node;
  };
  function visibilityChoices() {
    const group = doc.createElement('div');
    group.className = 'seg'; group.setAttribute('role', 'group'); group.setAttribute('aria-label', 'Room visibility');
    for (const [value, label, explanation] of [['private', 'Private', 'Only people with the invite link'], ['public', 'Public', 'Listed for everyone with Surfd QoL']]) {
      const option = button(label, '');
      option.dataset.visibility = value; option.title = explanation;
      option.onclick = () => {
        Promise.resolve().then(() => rooms.setVisibility(value)).then(refresh, fail);
      };
      group.append(option);
    }
    return group;
  }
  function selectVisibility(group, value) {
    for (const option of group?.children ?? []) {
      const pressed = String(option.dataset.visibility === value);
      if (option.getAttribute('aria-pressed') !== pressed) option.setAttribute('aria-pressed', pressed);
    }
  }
  function fail(error) {
    text(root?.querySelector('#servers-status'), error?.message ?? String(error));
  }
  function cancelDraft() {
    if (!staging) return;
    staging = false;
    for (const child of root?.querySelector('#server-detail')?.children ?? []) hidden(child, child === draft);
    const join = root?.querySelector('#servers-join');
    if (join && (join.textContent === 'Start room' || join.textContent === 'Starting…')) {
      text(join, joinLabel); join.disabled = joinDisabled;
    }
  }
  async function start(event) {
    if (!staging) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (pending) return;
    pending = true; refresh();
    try {
      await rooms.host({visibility: rooms.visibility()});
      staging = false;
    } catch (error) { fail(error); }
    finally { pending = false; refresh(); }
  }
  function mount(next) {
    cancelDraft();
    root?.querySelector('#servers-join')?.removeEventListener('click', start, true);
    hostButton?.remove(); draft?.remove(); help?.remove(); choices?.remove(); bandwidth?.remove();
    root = next; staging = false;
    const refreshButton = root?.querySelector('#servers-refresh');
    if (!refreshButton) return;
    hostButton = button('Host a room'); hostButton.title = bandwidthTooltip();
    hostButton.onclick = () => {
      const adapter = getAdapter()?.rooms;
      if (!staging && adapter?.guest?.()) { adapter.signIn?.(); return; }
      if (staging) cancelDraft();
      else {
        const join = root.querySelector('#servers-join');
        joinLabel = join?.textContent ?? 'Join'; joinDisabled = join?.disabled ?? true;
        staging = true;
      }
      refresh();
    };
    refreshButton.before(hostButton);
    root.querySelector('#servers-join')?.addEventListener('click', start, true);
    draft = doc.createElement('div'); draft.className = 'srv-info'; draft.hidden = true;
    const title = doc.createElement('h3'); title.textContent = 'Host a room';
    const map = doc.createElement('p'); map.className = 'sub'; map.dataset.hostMap = '';
    const group = visibilityChoices();
    const explanation = doc.createElement('p'); explanation.className = 'lede'; explanation.dataset.visibilityHelp = '';
    draft.append(title, map, group, explanation);
    help = doc.createElement('p'); help.className = 'sub';
    choices = visibilityChoices();
    bandwidth = doc.createElement('p'); bandwidth.className = 'sub'; bandwidth.title = bandwidthTooltip();
  }
  function refresh() {
    if (destroyed || !doc) return;
    const adapter = getAdapter()?.rooms;
    const next = adapter?.root?.();
    if (next !== root) mount(next);
    const community = isPrivateRoomId(rooms.currentRoom?.());
    const open = adapter?.browserOpen?.() ?? (!!root && !root.hidden);
    observe(open, community);
    rooms.browserVisibility?.(open);
    const hosting = rooms.hosting();
    rooms.showHostDetails?.(open && hosting?.id === adapter?.selected?.());
    if (!open && !community && !votes.size) return;
    for (const node of menu?.querySelectorAll('[data-act="rtv"], [data-act="nominate"], [data-act="extend"], .room-rtv, .room-nominate, .room-extend') ?? []) {
      if (community) {
        if (!votes.has(node)) votes.set(node, node.hidden);
        hidden(node, true);
      } else if (votes.has(node)) { hidden(node, votes.get(node)); votes.delete(node); }
    }
    if (!open || !root || !hostButton) return;
    if (hosting) staging = false;
    hidden(hostButton, !!hosting); hostButton.disabled = pending;
    const rows = adapter.rows();
    const rowNodes = new Map([...root.querySelectorAll('#server-rows tr[data-id]')].map(node => [node.dataset.id, node]));
    for (const row of rows) {
      if (!isPrivateRoomId(row.id)) continue;
      const node = rowNodes.get(row.id);
      if (!node) continue;
      if (node.classList.contains('full')) node.classList.remove('full');
      text(node.querySelector('.badge'), row.visibility === 'public' ? 'Public' : 'Private');
      text(node.querySelector('.players-cell'), String(row.players));
      const cells = node.querySelectorAll('td');
      if (cells[3]?.textContent === '—') text(cells[3], '');
    }
    const detail = root.querySelector('#server-detail');
    const join = root.querySelector('#servers-join');
    if (!detail || !join) return;
    if (staging) {
      if (draft.parentNode !== detail) detail.append(draft);
      for (const child of detail.children) hidden(child, child !== draft);
      const map = adapter.currentMap();
      const metadata = adapter.maps().find(entry => entry.id === map?.id);
      text(draft.querySelector('[data-host-map]'), metadata?.title ?? map?.title ?? map?.id ?? 'Select a map first.');
      selectVisibility(draft.querySelector('.seg'), rooms.visibility());
      text(draft.querySelector('[data-visibility-help]'), rooms.visibility() === 'public' ? 'Listed for everyone with Surfd QoL' : 'Only people with the invite link');
      text(join, pending ? 'Starting…' : 'Start room'); join.disabled = pending || !map;
      return;
    }
    for (const child of detail.children) hidden(child, child === draft);
    const selected = rows.find(row => row.id === adapter.selected());
    const isCommunity = isPrivateRoomId(selected?.id);
    const info = detail.querySelector('.srv-info:not([hidden])');
    if (!isCommunity || !info) {
      help?.remove(); choices?.remove(); bandwidth?.remove();
      return;
    }
    text(info.querySelector('.sub'), selected.visibility === 'public' ? 'Public' : 'Private');
    text(detail.querySelector('.section-head small'), selected.online ? String(selected.players) : 'Offline');
    const ping = info.querySelector('[data-fact="ping"]');
    if (ping?.textContent === '—') text(ping, '');
    text(help, selected.visibility === 'public' ? PUBLIC_HELP : PRIVATE_HELP);
    const invite = info.querySelector('.invite-line');
    if (invite && help.previousElementSibling !== invite) invite.after(help);
    if (hosting?.id === selected.id) {
      if (choices.parentNode !== info) info.append(choices);
      selectVisibility(choices, hosting.visibility);
      if (bandwidth.parentNode !== info) info.append(bandwidth);
      text(bandwidth, bandwidthDetail(hosting.players, hosting.uploadMbps));
    } else { choices.remove(); bandwidth.remove(); }
  }
  const observer = doc && Observer ? new Observer(() => {
    if (scheduled || destroyed) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; refresh(); });
  }) : null;
  refresh();
  return {
    refresh,
    destroy() {
      destroyed = true; observer?.disconnect();
      cancelDraft();
      root?.querySelector('#servers-join')?.removeEventListener('click', start, true);
      hostButton?.remove(); draft?.remove(); help?.remove(); choices?.remove(); bandwidth?.remove();
      for (const [node, wasHidden] of votes) hidden(node, wasHidden);
      votes.clear();
    }
  };
}
