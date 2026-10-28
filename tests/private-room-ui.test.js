import {describe, expect, test} from 'bun:test';
import {createRoomUi} from '../src/private-rooms/ui.js';

class Element {
  constructor(tag = 'div') {
    this.tag = tag; this.children = []; this.dataset = {}; this.attributes = {};
    this.hidden = false; this.disabled = false; this.className = ''; this.id = ''; this.value = '';
    this.listeners = new Map(); this.parentNode = null; this.content = '';
    this.classList = {contains: value => this.className.split(' ').includes(value), remove: value => {this.className = this.className.split(' ').filter(item => item !== value).join(' ');}};
  }
  get textContent() { return this.content + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.content = String(value); this.children = []; }
  get previousElementSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) - 1] ?? null; }
  append(...nodes) { for (const node of nodes) {node.remove(); node.parentNode = this; this.children.push(node);} }
  remove() { if (this.parentNode) {this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null;} }
  before(node) { const parent = this.parentNode; node.remove(); node.parentNode = parent; parent.children.splice(parent.children.indexOf(this), 0, node); }
  after(node) { const parent = this.parentNode; node.remove(); node.parentNode = parent; parent.children.splice(parent.children.indexOf(this) + 1, 0, node); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  removeEventListener(name, listener) { if (this.listeners.get(name) === listener) this.listeners.delete(name); }
  async click() {
    if (this.disabled) return;
    let stopped = false;
    await this.listeners.get('click')?.({preventDefault(){},stopImmediatePropagation(){stopped = true;}});
    if (!stopped) await this.onclick?.();
  }
  matches(selector) {
    if (selector.endsWith(':not([hidden])')) return !this.hidden && this.matches(selector.slice(0, -':not([hidden])'.length));
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
  static mutate(node, type = 'childList', attributeName) {
    for (const observer of Observer.instances) {
      for (const [target, options] of observer.targets) {
        let inside = node === target;
        for (let parent = node.parentNode; options.subtree && parent; parent = parent.parentNode) inside ||= parent === target;
        if (inside && options[type] && (!attributeName || !options.attributeFilter || options.attributeFilter.includes(attributeName))) {
          observer.callback([{target: node, type, attributeName}]);
          break;
        }
      }
    }
  }
}

function fixture({observe = false} = {}) {
  const document = new Element('document'); document.documentElement = document; document.createElement = tag => new Element(tag);
  const add = (parent, tag, id = '', className = '', value = '') => {const node = new Element(tag); node.id = id; node.className = className; node.textContent = value; parent.append(node); return node;};
  const root = add(document, 'section');
  const detail = add(root, 'div', 'server-detail');
  const info = add(detail, 'div', '', 'srv-info');
  add(info, 'p', '', 'sub', 'Europe');
  const invite = add(info, 'div', '', 'invite-line');
  const code = add(invite, 'code', '', '', 'surfd.example/?join=p-aaaaaaaaaaaa');
  const copy = add(invite, 'button', 'copy-invite', 'btn', 'Copy');
  const ping = add(info, 'dd', '', '', '—'); ping.dataset.fact = 'ping';
  const roster = add(detail, 'div', '', 'srv-roster');
  const head = add(roster, 'div', '', 'section-head'); add(head, 'small', '', '', '2 / 16');
  const foot = add(root, 'div', '', 'foot-group');
  const refresh = add(foot, 'button', 'servers-refresh', 'btn', 'Refresh');
  const join = add(foot, 'button', 'servers-join', 'btn btn-primary', 'Join');
  const status = add(root, 'span', 'servers-status');
  const menu = add(document, 'div', '', 'room-menu-actions');
  const vote = add(menu, 'button', '', 'room-rtv', 'Rock the vote');
  const hud = add(document, 'div', '', 'hud');
  let visibility = 'private', hosting = null, current = null, selected = 'eu', failure = null, nativeJoins = 0;
  const calls = [], rows = [{id:'eu',region:'Europe',players:4,online:true}];
  const rooms = {
    visibility:()=>visibility, hosting:()=>hosting, currentRoom:()=>current,
    setVisibility(value){visibility=value;if(hosting){hosting.visibility=value;rows.find(row=>row.id===hosting.id).visibility=value;}},
    async host(options){calls.push(options);if(failure)throw failure;hosting={id:'p-aaaaaaaaaaaa',visibility,players:2,uploadMbps:0.2};current=hosting.id;selected=hosting.id;rows.push({...hosting,online:true});return hosting.id;}
  };
  let reads = 0;
  const adapter = {rooms:{root:()=>root,browserOpen:()=>!root.hidden,rows:()=>{reads++;return rows;},selected:()=>selected,currentMap:()=>({id:'map'}),maps:()=>[{id:'map',title:'Loaded map'}]}};
  join.onclick = () => {nativeJoins++;};
  const ui = createRoomUi({rooms,getAdapter:()=>adapter,document,MutationObserver:observe ? Observer : null});
  return {ui,rooms,root,detail,info,invite,code,copy,foot,refresh,join,status,vote,menu,hud,calls,rows,reads:()=>reads,
    host:()=>foot.children.find(node=>node.textContent==='Host a room'),nativeJoins:()=>nativeJoins,
    fail:error=>{failure=error;},select:id=>{selected=id;},current:id=>{current=id;}};
}

describe('native room UI', () => {
  test('HUD mutations never refresh room UI', async () => {
    const f = fixture({observe: true});
    const reads = f.reads();
    Observer.mutate(f.hud);
    Observer.mutate(f.hud, 'attributes', 'class');
    await Promise.resolve();
    expect(f.reads()).toBe(reads);
    Observer.mutate(f.detail);
    await Promise.resolve();
    expect(f.reads()).toBeGreaterThan(reads);
    f.ui.destroy();
  });

  test('hidden browser ignores rows and menu outside community rooms', async () => {
    const f = fixture({observe: true});
    f.root.hidden = true;
    Observer.mutate(f.root, 'attributes', 'hidden');
    await Promise.resolve();
    const reads = f.reads();
    Observer.mutate(f.detail);
    Observer.mutate(f.menu);
    f.ui.refresh();
    await Promise.resolve();
    expect(f.reads()).toBe(reads);
    f.current('p-aaaaaaaaaaaa');
    f.ui.refresh();
    expect(f.vote.hidden).toBe(true);
    f.root.hidden = false;
    Observer.mutate(f.root, 'attributes', 'hidden');
    await Promise.resolve();
    expect(f.reads()).toBeGreaterThan(reads);
    f.ui.destroy();
  });

  test('host starts from native footer', async () => {
    const f=fixture();
    expect(f.host().className).toBe('btn');
    expect(f.refresh.previousElementSibling).toBe(f.host());
    await f.host().click();
    expect(f.join.textContent).toBe('Start room');
    expect(f.detail.textContent).toContain('Loaded map');
    const publicChoice=f.detail.querySelector('[data-visibility="public"]');
    await publicChoice.click();
    await Promise.resolve();
    expect(f.rooms.visibility()).toBe('public');
    await f.join.click();
    expect(f.calls).toEqual([{visibility:'public'}]);
    expect(f.nativeJoins()).toBe(0);
    expect(f.host().hidden).toBe(true);
    expect(f.vote.hidden).toBe(true);
    expect(f.code.textContent).toBe('surfd.example/?join=p-aaaaaaaaaaaa');
    expect(f.copy.textContent).toBe('Copy');
    expect(f.info.textContent).toContain('Listed for everyone with Surfd QoL.');
    expect(f.info.textContent).toContain('Now using 0.2 Mbps up.');
    await f.info.querySelector('[data-visibility="private"]').click();
    await Promise.resolve();
    expect(f.rooms.hosting().visibility).toBe('private');
    expect(f.info.textContent).toContain('Only people with this link can join. They need Surfd QoL.');
    f.ui.destroy();
    expect(f.vote.hidden).toBe(false);
  });

  test('private invites stay native', () => {
    const f=fixture();
    f.rows.push({id:'p-aaaaaaaaaaaa',visibility:'private',players:91,online:true});f.select('p-aaaaaaaaaaaa');f.ui.refresh();
    expect(f.info.textContent).toContain('Only people with this link can join. They need Surfd QoL.');
    expect(f.detail.querySelector('.section-head small').textContent).toBe('91');
    expect(f.info.querySelector('[data-fact="ping"]').textContent).toBe('');
    expect(f.nativeJoins()).toBe(0);
    f.select('eu');f.ui.refresh();
    expect(f.info.textContent).not.toContain('They need Surfd QoL');
    f.ui.destroy();
  });

  test('cancelling restores native join', async () => {
    const f=fixture();
    await f.host().click();
    expect(f.info.hidden).toBe(true);
    await f.host().click();
    expect(f.info.hidden).toBe(false);
    expect(f.join.textContent).toBe('Join');
    await f.join.click();
    expect(f.nativeJoins()).toBe(1);
    expect(f.calls).toEqual([]);
    f.ui.destroy();
  });

  test('start failures use native status', async () => {
    const f=fixture();f.fail(new Error("Couldn't reach the room service. Try again in a moment."));
    await f.host().click();await f.join.click();
    expect(f.status.textContent).toBe("Couldn't reach the room service. Try again in a moment.");
    expect(f.join.disabled).toBe(false);
    expect(f.join.textContent).toBe('Start room');
    expect(f.nativeJoins()).toBe(0);
    f.ui.destroy();
  });

});
