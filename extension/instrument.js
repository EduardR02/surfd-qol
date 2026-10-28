const identifier = '[A-Za-z_$][\\w$]*';
// A captured identifier, matched literally inside another pattern.
const literal = name => name.replace(/\$/g, '\\$');

function unique(source, pattern, label) {
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`Unsupported Surfd build: ${label} (${matches.length} matches)`);
  return matches[0];
}

// Replay hooks are optional: when the game's watch function or its replay
// player can't be found, Watch is unavailable and nothing else changes.
// Surfd's own player (the transport behind its replay bar) does playback,
// seeking, speed and the timeline; the extension drives it and adds to it.
function replayHooks(source) {
  try {
    const watch = unique(source, new RegExp(`async function (${identifier})\\((${identifier}),(${identifier}),(${identifier}),(${identifier})=\\+\\+(${identifier})\\)\\{if\\(!\\3\\(\\)\\)return;`, 'g'), 'replay watch');
    // The game's own debug snapshot reads the player: replay:<player>.snapshot().
    const transport = unique(source, new RegExp(`replay:(${identifier})\\.snapshot\\(\\)`, 'g'), 'replay player')[1];
    return `
    replay: {
      reserve: () => ++${watch[6]},
      isCurrent: token => token === ${watch[6]},
      watch: (replay, label, isCurrent, token) => ${watch[1]}(replay, isCurrent, label, token),
      transport: () => ${transport},
      // What's playing and where: index counts the commands played.
      playback: () => ({replay: ${transport}.replay ?? null, index: ${transport}.replay ? ${transport}.host.position() : 0}),
    },`;
  } catch (error) {
    console.warn('[Surfd QoL] Replay controls unavailable:', error.message);
    return '';
  }
}

// The game's practice savelocs, also optional: moments saved while watching
// a replay are filed into them when you leave it.
function practiceHooks(source, sessionClass, state) {
  try {
    const store = unique(source, new RegExp(`const ${identifier}=(${identifier})\\.entries\\((${identifier})\\)\\.length>=${identifier},${identifier}=\\1\\.save\\(\\2\\)`, 'g'), 'saveloc store')[1];
    // Use the same map, rules and replay format as native Restart. A replay
    // session can remain alive after Exit with an older format/rules bank.
    const fresh = unique(source, new RegExp(`function (${identifier})\\((${identifier})\\)\\{const ${identifier}=new ${sessionClass}\\(\\2,(${identifier})\\(\\2\\),(${identifier})\\),`, 'g'), 'live session factory');
    const maps = [...new Set([...source.matchAll(new RegExp(`${fresh[1]}\\((${identifier})\\?\\?${state}\\.map\\)`, 'g'))].map(match => match[1]))];
    if (maps.length !== 1) throw new Error('Unsupported Surfd build: practice destination map');
    // The start position the factory applies: yours if you set one, else none.
    let loadStart = null;
    try {
      const factory = new RegExp(`function ${literal(fresh[1])}\\((${identifier})\\)\\{const (${identifier})=new ${literal(sessionClass)}\\(\\1,${literal(fresh[3])}\\(\\1\\),${literal(fresh[4])}\\),(${identifier})=(${identifier})\\(\\1\\);return \\3&&\\2\\.setStartPosition\\(\\3\\)`, 'g');
      loadStart = unique(source, factory, 'start position loader')[4];
    } catch (error) {
      console.warn('[Surfd QoL] Savelocs from replays keep the replay’s start position:', error.message);
    }
    return `
    practice: {
      // The saveloc store: one bank of snapshots per practice key (map and movement rules).
      store: () => ${store},
      destination: () => {
        const map = ${maps[0]} ?? ${state}?.map;
        if (!map) return null;
        // practiceKey is native's pure metadata key, not a synthetic Session.
        const key = ${sessionClass}.prototype.practiceKey.call({map, config: ${fresh[3]}(map), replayFormat: ${fresh[4]}});
        return {mapId: map.id, mapVersion: map.version, key${loadStart ? `, startPosition: ${loadStart}(map) ?? null` : ''}};
      },
    },`;
  } catch (error) {
    console.warn('[Surfd QoL] Practice savelocs from replays unavailable:', error.message);
    return '';
  }
}
// The game's own notice line (where "Saved location #1" appears), optional.
function noticeHook(source) {
  try {
    const notice = unique(source, new RegExp(`\\{(${identifier})\\("Return to play before saving a location\\."\\);return\\}`, 'g'), 'notice')[1];
    return `
    notice: text => ${notice}(text),`;
  } catch (error) {
    console.warn('[Surfd QoL] Game notices unavailable:', error.message);
    return '';
  }
}

// Room transport hooks are one optional unit: a partial match must never send
// a private identifier to the site's ticket, ping or WebSocket endpoints.
function roomHooks(source, client, state) {
  try {
    const list = unique(source, new RegExp(`async list\\(\\)\\{const (${identifier})=await fetch\\(this\\.baseUrl\\+"/servers",\\{signal:AbortSignal\\.timeout\\(8e3\\),cache:"no-store"\\}\\);if\\(!\\1\\.ok\\)throw Error\\("Servers unavailable"\\);const (${identifier})=await \\1\\.json\\(\\);if\\(!Array\\.isArray\\(\\2\\.servers\\)\\)throw Error\\("Invalid server list"\\);return \\2\\.servers\\}`, 'g'), 'room list');
    const measure = unique(source, new RegExp(`async measure\\((${identifier})\\)\\{const (${identifier})=performance\\.now\\(\\);if\\(!\\(await fetch\\(this\\.baseUrl\\+"/servers/"\\+\\1\\+"/ping"`, 'g'), 'room ping');
    const socket = unique(source, new RegExp(`new WebSocket\\((${identifier}),\\["surfd-v1",(${identifier})\\]\\)`, 'g'), 'room socket');
    const tickets = [...source.matchAll(/await this\.ticket\(\)/g)];
    if (tickets.length !== 2) throw new Error(`Unsupported Surfd build: room tickets (${tickets.length} matches)`);
    const bind = unique(source, new RegExp(`bindServers\\((${identifier}),(${identifier})\\)\\{(${identifier})=\\1,(${identifier})=\\2,\\2\\(\\)\\}`, 'g'), 'room join callback');
    const lobby = unique(source, new RegExp(`(${identifier})\\.bindServers\\(`, 'g'), 'room lobby')[1];
    const maps = unique(source, new RegExp(`refreshTop10\\(\\)\\{${identifier}\\.refresh\\((${identifier})\\.find\\((${identifier})=>\\2\\.id===${identifier}\\.currentMap\\(\\)\\)\\?\\?null\\)\\}`, 'g'), 'room maps')[1];
    const countdown = unique(source, new RegExp(`function (${identifier})\\((${identifier}),(${identifier})\\)\\{const (${identifier})=(${identifier})\\(\\2,\\3\\);return \\4===0\\?"Changing map…":`, 'g'), 'room countdown')[1];
    const clocks = new RegExp(`${literal(countdown)}\\((${identifier}(?:\\.state)?)\\.endsAt,Date\\.now\\(\\)(?:\\+${identifier})?\\)`, 'g');
    const clockCount = [...source.matchAll(clocks)].length;
    if (clockCount !== 4) throw new Error(`Unsupported Surfd build: room countdown views (${clockCount} matches)`);
    const hook = 'globalThis.__SURFD_QOL__?.privateRooms';
    const listBody = list[0].slice('async list(){'.length, -1).replace(`return ${list[2]}.servers`, `return ${hook}?.mergeRooms(${list[2]}.servers)??${list[2]}.servers`);
    source = source.replace(list[0], `async list(){try{${listBody}}catch(error){const rows=${hook}?.mergeRooms([]);if(rows?.length)return rows;throw error}}`);
    source = source.replace(measure[0], measure[0].replace('{const ', `{const privatePing=${hook}?.measure(${measure[1]});if(privatePing!=null)return privatePing;const `));
    source = source.replace(socket[0], `(${hook}?.roomSocket(this.roomId,${socket[1]},["surfd-v1",${socket[2]}])??${socket[0]})`);
    source = source.replace(/await this\.ticket\(\)/g, `(${hook}?.ticket(this.roomId)??await this.ticket())`);
    source = source.replace(bind[0], `${bind[0]},joinServer(id){return ${bind[3]}(id)}`);
    source = source.replace(clocks, (call, room) => `(${room}.untimed===true?"No time limit":${call})`);
    return {source, adapter: `
    rooms: {
      join: id => ${lobby}.joinServer(id),
      rows: () => ${lobby}.servers.rows(),
      update: rows => ${lobby}.updateServers(rows, "Choose a region and connect."),
      displayName: () => ${client}.profile?.username ?? "Guest",
      appearance: () => ${client}.profile?.appearance ?? null,
      guest: () => !${client}.session,
      maps: () => ${maps},
      currentMap: () => ${state}?.map ?? ${lobby}.selected(),
    },`};
  } catch (error) {
    console.warn('[Surfd QoL] Private rooms unavailable:', error.message);
    return {source, adapter: ''};
  }
}

// Append access to existing lexical objects; no original movement statement is rewritten.
// Fail open when the private game layout changes instead of guessing at another class.
export function instrumentGame(source) {
  const injected = source.indexOf('\n/* surfd-qol-adapter-v');
  if (injected >= 0) return source;
  const state = unique(source, new RegExp(`state:(${identifier})\\?\\.state,run:\\1\\?\\.timer\\.state`, 'g'), 'session snapshot')[1];
  const viewed = unique(source, new RegExp(`spectator:\\{target:(${identifier}),view:(${identifier})\\}`, 'g'), 'spectator view');
  const marker = unique(source, /checkpointSpeeds=\[\];startJumps=0/g, 'session fields').index;
  const classes = [...source.slice(0, marker).matchAll(new RegExp(`class (${identifier})\\{`, 'g'))];
  const sessionClass = classes.at(-1)?.[1];
  if (!sessionClass) throw new Error('Unsupported Surfd build: Session class');
  const body = source.slice(classes.at(-1).index, marker);
  const movementClass = unique(body, new RegExp(`this\\.movement=new (${identifier})\\(`, 'g'), 'movement class')[1];
  if (!body.includes('this.timer=') || !body.includes('this.map=')) throw new Error('Unsupported Surfd build: Session contract');
  const binding = unique(source, new RegExp(`(${identifier})\\.setBindings\\((${identifier})\\.bindings\\)`, 'g'), 'native input');
  const references = unique(source, new RegExp(`const (${identifier})=(${identifier})\\.current\\?\\.entries\\.find\\((${identifier})=>\\3\\.rank===1\\);(${identifier})\\.prepare\\(([^;]{1,200}?),\\(\\)=>(${identifier})\\.replay\\(\\1\\.runId\\)\\)`, 'g'), 'leaderboard references');
  const boardStore = references[2];
  const client = references[6];
  if (!source.includes(`${client}.board(${state}.map)`)) throw new Error('Unsupported Surfd build: board lookup');
  const rooms = roomHooks(source, client, state);
  source = rooms.source;
  return source + `
/* surfd-qol-adapter-v6: viewed state, replay playback and optional private room transport */
;(() => {
  const qol = globalThis.__SURFD_QOL__;
  if (!qol) return;
  const viewed = {target: null, view: null};
  qol.attach({
    Session: ${sessionClass}, Movement: ${movementClass},
    getSession: () => ${state},
    getView: () => { viewed.target = ${viewed[1]}; viewed.view = ${viewed[2]}; return viewed; },
    getInput: () => ${binding[1]},
    getBindings: () => ${binding[2]}.bindings,
    setInputBindings: bindings => ${binding[1]}.setBindings(bindings),${replayHooks(source)}${practiceHooks(source, sessionClass, state)}${noticeHook(source)}${rooms.adapter}
    getReferences: () => {
      const session = ${state};
      if (!session) return null;
      const board = ${client}.board(session.map);
      const ownerKey = ${client}.session?.user.id ?? 'guest';
      const key = board ? board.boardId + ':' + ownerKey : '';
      const current = ${boardStore}.current;
      const refs = board && ${boardStore}.key === key && current?.boardId === board.boardId ? current : null;
      const mapInfo = ${client}.config.maps.find(entry => entry.id === session.map.id);
      const recordSlug = mapInfo?.slug ?? session.map.slug;
      const record = refs?.entries?.find(entry => entry.rank === 1) ?? null;
      return {ownerKey, boardId: board?.boardId ?? null, own: refs?.own ?? null, record, mapName: mapInfo?.title ?? (mapInfo?.slug ? String(mapInfo.slug).split(/[-_]/).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ') : mapInfo?.name) ?? null,
        loadReplay: runId => ${client}.replay(runId),
        loadRecordRoute: () => recordSlug ? fetch('/replays/' + encodeURIComponent(recordSlug) + '-complete.json', {signal: AbortSignal.timeout(3e4)}).then(response => response.ok ? response.json() : null) : Promise.resolve(null)};
    }
  });
})();
`;
}
