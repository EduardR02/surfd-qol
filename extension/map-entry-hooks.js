const identifier = '[A-Za-z_$][\\w$]*';
const literal = name => name.replace(/\$/g, () => '\\$');

function unique(source, pattern) {
  const matches = [...source.matchAll(pattern)];
  return matches.length === 1 ? matches[0] : null;
}

// The game asks the server for a run ticket only once a map has loaded, and
// its first step waits for the reply. A prefetch added to its online
// controller asks through the game's own prefetch instead, so the ticket is
// buffered by the time the run begins. The gates mirror beginAttempt's before
// it calls begin; the number of ticket requests is unchanged.
function runTicketPrefetch(source, load, entry) {
  const factory = unique(source, new RegExp(`function (${identifier})\\((${identifier})\\)\\{const (${identifier})=\\2\\.client\\?\\?new ${identifier},(${identifier})=new (${identifier})\\(\\3\\),(${identifier})=new \\5\\(\\{attempt:(${identifier})=>\\3\\.guestAttempt\\(\\7\\)\\}\\)`, 'g'));
  if (!factory) return null;
  const [, factoryName, , client, tickets, Tickets, guests] = factory;
  const prefetch = unique(source, new RegExp(`class ${literal(Tickets)}\\{[^]{0,600}?async prefetch\\((${identifier}),(${identifier})\\)\\{const (${identifier})=\`\\$\\{\\2\\}:\\$\\{\\1\\.boardId\\}\`;`, 'g'));
  const controller = unique(source, new RegExp(`const (${identifier})=(${identifier})\\(\\),(${identifier})=\\{ready:\\1,setMap\\(`, 'g'));
  if (!prefetch || !controller || controller.index < factory.index) return null;
  const [, ready, , object] = controller;
  const end = source.indexOf(`return ${object}}`, controller.index);
  const begin = unique(source.slice(controller.index, end), new RegExp(`async beginAttempt\\((${identifier})\\)\\{[^]{0,700}?(${identifier})\\|\\|await ${literal(ready)},!${identifier}\\(\\)\\)return;if\\(${literal(client)}\\.session\\)\\{if\\(await ${identifier},!${identifier}\\(\\)\\)return;if\\((${identifier})\\.retained>=6\\)\\{${literal(tickets)}\\.invalidate\\(\\),[^]{0,300}?return\\}\\}if\\((${identifier})\\)\\{${literal(tickets)}\\.invalidate\\(\\),${literal(guests)}\\.invalidate\\(\\),[^]{0,300}?return\\}(?:const (${identifier})=${literal(client)}\\.config\\.enabled&&!\\1\\.practice&&${identifier}\\(\\1\\.map\\)&&!${literal(client)}\\.board\\(\\1\\.map\\);)?if\\(!${literal(client)}\\.config\\.enabled\\|\\|!${literal(client)}\\.session&&!${literal(client)}\\.config\\.guestRuns(?:&&!\\5)?\\)\\{[^]{0,300}?return\\}const (${identifier})=${literal(client)}\\.board\\(\\1\\.map\\)(?:,${identifier}=${identifier}\\(\\1\\.map\\))?;if\\(!\\6\\|\\|\\1\\.practice\\)\\{[^]{0,600}?\\?await ${literal(guests)}\\.begin\\(\\1,\\6,"guest"\\):await ${literal(tickets)}\\.begin\\(\\1,\\6,${literal(client)}\\.session\\.user\\.id,`, 'g'));
  // Bonus builds let guests run a bonus without a board locally. That case has
  // no board, so the prefetch below never requests a ticket for it either.
  if (end < 0 || !begin || begin[5] && !begin[0].includes(`guestRuns&&!${begin[5]}){`)) return null;
  const [, , initialized, retained, failure] = begin;
  // The catalogue entry carries the version the geometry loader fetches, and
  // board() looks boards up in the same catalogue.
  const board = unique(source, new RegExp(`board\\((${identifier})\\)\\{(?:if\\(${identifier}\\(\\1\\)\\)\\{[^{}]{0,200}\\})?const (${identifier})=(${identifier})\\.find\\((${identifier})=>\\4\\.id===\\1\\.id&&\\4\\.version===\\1\\.version\\);return \\2\\?this\\.config\\.maps\\.find\\(`, 'g'));
  const instance = unique(source, new RegExp(`const (${identifier})=${literal(factoryName)}\\(\\{`, 'g'));
  if (!board || !instance) return null;
  const catalog = board[3];
  const geometry = unique(source, new RegExp(`async function (${identifier})\\((${identifier}),${identifier}\\)\\{const (${identifier})=${literal(catalog)}\\.find\\((${identifier})=>\\4\\.id===\\2\\.id\\),`, 'g'));
  const body = source.slice(load.index + load[0].length, load.index + load[0].length + 1200);
  if (!geometry || !new RegExp(`try\\{const(?: ${identifier}=${identifier}\\(${literal(entry)}\\.id\\),)?\\[${identifier},${identifier}(?:,${identifier})?\\]=await Promise\\.all\\(\\[${literal(geometry[1])}\\(${literal(entry)},`).test(body)) return null;
  return {instance: instance[1], at: controller.index + controller[0].length - `ready:${ready},setMap(`.length,
    method: `__qolPrefetchRun(__qolMap){if(!${initialized}||${failure}||!${client}.config.enabled||!${client}.session&&!${client}.config.guestRuns||${client}.session&&${retained}.retained>=6)return;
    const __qolRecord=${catalog}.find(__qolEntry=>__qolEntry.id===__qolMap?.id),__qolBoard=__qolRecord&&${client}.board(__qolRecord);
    if(__qolBoard)(${client}.session?${tickets}.prefetch(__qolBoard,${client}.session.user.id):${guests}.prefetch(__qolBoard,"guest")).catch(()=>{})},`};
}

// When a solo, practice or room map load starts (not a replay, a return to a
// server or a restored run), request its run ticket and report the start for
// the entry timing line. controller names the online controller, whose ticket
// requests the timing line also follows. Unknown code is left as it is.
export function nativeMapEntryHooks(source) {
  if (source.includes('mapLoadStarted')) return {source, controller: null};
  const load = unique(source, new RegExp(`async function ${identifier}\\((${identifier}),${identifier}=!1,(${identifier})=!1\\)\\{if\\(!\\2&&!${identifier}\\(\\1\\.id\\)\\)throw Error\\("This map is temporarily unavailable for play\\."\\);if\\(${identifier}\\)return;`, 'g'));
  if (!load) return {source, controller: null};
  const [, entry, bypass] = load;
  const prefetch = runTicketPrefetch(source, load, entry);
  const changes = [{at: load.index + load[0].length,
    text: `if(!${bypass}){${prefetch ? `try{${prefetch.instance}.__qolPrefetchRun(${entry})}catch{}` : ''}globalThis.__SURFD_QOL__?.mapLoadStarted?.(${entry})}`}];
  if (prefetch) changes.push({at: prefetch.at, text: prefetch.method});
  changes.sort((a, b) => b.at - a.at);
  for (const change of changes) source = source.slice(0, change.at) + change.text + source.slice(change.at);
  return {source, controller: prefetch?.instance ?? null};
}
