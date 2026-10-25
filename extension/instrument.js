const identifier = '[A-Za-z_$][\\w$]*';

function unique(source, pattern, label) {
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`Unsupported Surfd build: ${label} (${matches.length} matches)`);
  return matches[0];
}

// Replay playback hooks are optional: when the game's watch function or its
// playback cursor can't be found, Watch is unavailable and nothing else changes.
function replayHooks(source, state) {
  try {
    const watch = unique(source, new RegExp(`async function (${identifier})\\((${identifier}),(${identifier}),(${identifier}),(${identifier})=\\+\\+(${identifier})\\)\\{if\\(!\\3\\(\\)\\)return;`, 'g'), 'replay watch');
    const cursor = unique(source, new RegExp(`const ${identifier}=(${identifier})\\?\\1\\.commands\\[(${identifier})\\+\\+\\]:`, 'g'), 'replay cursor');
    const stepper = unique(source, new RegExp(`(${identifier})\\.advance\\(`, 'g'), 'fixed stepper')[1];
    const stepperClasses = new Set([...source.matchAll(new RegExp(`[,;]${stepper.replace(/\$/g, '\\$')}=new (${identifier})\\(`, 'g'))].map(match => match[1]));
    if (stepperClasses.size !== 1) throw new Error('Unsupported Surfd build: fixed stepper class');
    const [replay, index] = [cursor[1], cursor[2]];
    return `
    replay: {
      Stepper: ${[...stepperClasses][0]},
      stepper: () => ${stepper},
      reserve: () => ++${watch[6]},
      isCurrent: token => token === ${watch[6]},
      watch: (replay, label, isCurrent, token) => ${watch[1]}(replay, isCurrent, label, token),
      // The cursor outlives playback: after Esc or the end, index is where it stopped.
      playback: () => ({replay: ${replay}, index: ${index}}),
      // Re-simulates the watched session to \`index\` commands into \`replay\`:
      // forward from where it is, or from the start when going back or when
      // live input moved it after playback stopped. \`frames\` (replay-scan.js)
      // resumes from a snapshot closer to the target and keeps new ones.
      seek(replay, index, frames = null) {
        const session = ${state};
        if (!session || !replay || session.map.id !== replay.mapId || (${replay} && ${replay} !== replay)) return false;
        const length = replay.commands.length;
        index = Math.max(0, Math.min(length, Math.floor(index)));
        const at = session.commands.length;
        let from = at > length || at !== Math.min(${index}, length) || index < at ? 0 : at;
        if (!from) session.loadReplay(replay);
        from = Math.max(from, frames?.resume(session, from, index) ?? -1);
        ${index} = from;
        while (${index} < index) { session.step(replay.commands[${index}++]); frames?.keep(session, ${index}); }
        // Still the replay at its end: replay-control holds the last frame there.
        ${replay} = replay;
        ${stepper}.reset();
        return true;
      },
    },`;
  } catch (error) {
    console.warn('[Surfd QoL] Replay controls unavailable:', error.message);
    return '';
  }
}

// The game's practice savelocs, also optional: moments saved while watching
// a replay are filed into them when you leave it.
function practiceHooks(source) {
  try {
    const store = unique(source, new RegExp(`const ${identifier}=(${identifier})\\.entries\\((${identifier})\\)\\.length>=${identifier},${identifier}=\\1\\.save\\(\\2\\)`, 'g'), 'saveloc store')[1];
    return `
    practice: {
      // The saveloc store: one bank of snapshots per practice key (map and movement rules).
      store: () => ${store},
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

// Append access to existing lexical objects; no original movement statement is rewritten.
// Fail open when the private game layout changes instead of guessing at another class.
export function instrumentGame(source) {
  const injected = source.indexOf('\n/* surfd-qol-adapter-v');
  if (injected >= 0) source = source.slice(0, injected);
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
  return source + `
/* surfd-qol-adapter-v5: viewed state, selectable reference routes, input binding and replay playback */
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
    setInputBindings: bindings => ${binding[1]}.setBindings(bindings),${replayHooks(source, state)}${practiceHooks(source)}${noticeHook(source)}
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
