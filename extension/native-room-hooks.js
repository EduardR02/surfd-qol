const identifier = '[A-Za-z_$][\\w$]*';
const literal = name => name.replace(/\$/g, () => '\\$');
const community = value => `/^p-[a-z0-9]{12}$/.test(${value})`;

function unique(source, pattern, label) {
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`Unsupported Surfd build: ${label} (${matches.length} matches)`);
  return matches[0];
}

// Each hook is optional. Match everything before replacing, so a changed native
// signature skips the whole unit instead of leaving half a hook.
export function nativeRoomHooks(source, hook, lobby) {
  let adapter = '';
  try {
    const visibility = unique(source, new RegExp(`${literal(lobby)}\\.sync\\(\\{joined:${identifier},visible:!(${identifier})\\.hidden,roomId:(${identifier})\\?\\.roomId\\(\\)\\?\\?null\\}\\)`, 'g'), 'native menu visibility');
    const transition = unique(source, new RegExp(`function (${identifier})\\((${identifier})\\)\\{const (${identifier})=\x60\\$\\{\\2\\.joined\\}\\|\\$\\{\\2\\.visible\\}\\|\\$\\{\\2\\.roomId\\}\\|\\$\\{${identifier}\\.isOpen\\(\\)\\}\x60;if\\(\\3===(${identifier})\\)return;const (${identifier})=(${identifier}),(${identifier})=(${identifier});\\4=\\3,\\6=\\2\\.joined,\\8=\\2\\.visible,`, 'g'), 'native menu transition');
    source = source.replace(transition[0], () => `${transition[0]}${transition[7]}!==${transition[2]}.visible&&${hook}?.menuVisibility(${transition[2]}.visible),`);
    adapter = `\n      menuOpen: () => !${visibility[1]}.hidden,`;
  } catch (error) {
    console.warn('[Surfd QoL] Native menu refresh unavailable:', error.message);
  }
  try {
    source = friendHooks(source, hook, lobby);
  } catch (error) {
    console.warn('[Surfd QoL] Native community friends unavailable:', error.message);
  }
  try {
    const reply = unique(source, new RegExp(`(${identifier})\\("Use /vote followed by one of the displayed numbers\\."\\)`, 'g'), 'native command reply')[1];
    const command = unique(source, new RegExp(`function (${identifier})\\((${identifier})\\)\\{const\\[(${identifier}),\\.\\.\\.(${identifier})\\]=\\2\\.trim\\(\\)\\.split\\(/\\\\s\\+/\\),(${identifier})=\\4\\.join\\(" "\\),(${identifier})=\\3\\.replace\\(/\\^\\[!/\\]/,""\\)\\.toLowerCase\\(\\);(?:if\\(!${identifier}\\.onCommand\\?\\.\\(\\6,\\5\\)\\)\\{)?if\\(\\6==="played"\\)\\{if\\((${identifier})\\?\\.status==="connected"&&!\\7\\.playtime\\)`, 'g'), 'native command entry');
    const entry = `function ${command[1]}(${command[2]}){`;
    source = source.replace(entry, () => `${entry}if(${community(`${command[7]}?.roomId`)}){const __qolReply=${hook}?.commandReply(${command[2]},${command[7]}.roomId);if(typeof __qolReply==="string"){${reply}(__qolReply);return}}`);
  } catch (error) {
    console.warn('[Surfd QoL] Native community commands unavailable:', error.message);
  }
  try {
    source = resultHooks(source, lobby);
  } catch (error) {
    console.warn('[Surfd QoL] Native community results unavailable:', error.message);
  }
  try {
    // The attempt id of a finish the game sends for verification, or null when it sends none.
    const queued = unique(source, new RegExp(`if\\((${identifier})=(${identifier})\\?\\.ticket\\.id\\?\\?null,!\\2\\)`, 'g'), 'native ranked finish');
    source = source.replace(queued[0], () => `if(${queued[1]}=${queued[2]}?.ticket.id??null,${hook}?.finishQueued?.(${queued[1]}),!${queued[2]})`);
  } catch (error) {
    console.warn('[Surfd QoL] Verified community results unavailable:', error.message);
  }
  return {source, adapter};
}

function resultHooks(source, lobby) {
  const native = unique(source, new RegExp(`${literal(lobby)}\\.sync\\(\\{joined:${identifier},visible:!${identifier}\\.hidden,roomId:(${identifier})\\?\\.roomId\\(\\)\\?\\?null\\}\\)`, 'g'), 'native result room')[1];
  // Bonus builds name a bonus record separately; the result line already names the bonus.
  const formatter = unique(source, new RegExp(`function (${identifier})\\((${identifier})\\)\\{const ((?:(${identifier})=${identifier}\\(\\2\\),)?${identifier}=\\2\\.record\\?)((?:\\4\\?"New bonus record!":)?"New Surfd record!"):`, 'g'), 'native result text');
  if (!formatter[4] !== !formatter[5].startsWith(`${formatter[4]}?`)) throw new Error('Unsupported Surfd build: native bonus result text');
  const first = unique(source, /"First verified completion\."/g, 'native first completion');
  const call = unique(source, new RegExp(`${literal(formatter[1])}\\((${identifier})\\),"result",\\1\\.name,\\1\\.rank`, 'g'), 'native result notification');
  // Community hosts mark room records and unverified runs; the site's own results never carry these marks.
  source = source.replace(formatter[0], () => `function ${formatter[1]}(${formatter[2]},__qolCommunity=false){const ${formatter[3]}(__qolCommunity&&${formatter[2]}.roomRecord?"New room record!":${formatter[5]}):`);
  source = source.replace(first[0], () => `(__qolCommunity&&${formatter[2]}.verified===false?"First completion.":"First verified completion.")`);
  return source.replace(call[0], () => `${formatter[1]}(${call[1]},${community(`${native}?.roomId()`)}),"result",${call[1]}.name,${call[1]}.rank`);
}

function friendHooks(source, hook, lobby) {
  const native = unique(source, new RegExp(`${literal(lobby)}\\.sync\\(\\{joined:${identifier},visible:!${identifier}\\.hidden,roomId:(${identifier})\\?\\.roomId\\(\\)\\?\\?null\\}\\)`, 'g'), 'native friend room')[1];
  const joins = [...source.matchAll(new RegExp(`join:(${identifier})=>\\{(${identifier})\\.close\\(!1\\),(${identifier})\\(\\1\\)\\}`, 'g'))];
  if (joins.length !== 2) throw new Error(`Unsupported Surfd build: native friend joins (${joins.length} matches)`);
  const roomName = unique(source, new RegExp(`roomName:(${identifier})=>(${identifier})\\.rows\\(\\)\\.find\\((${identifier})=>\\3\\.id===\\1\\)\\?\\.name\\?\\?(${identifier})\\(\\1\\)`, 'g'), 'native friend room name');
  const roomMap = unique(source, new RegExp(`roomMap:(${identifier})=>\\{const (${identifier})=(${identifier})\\.rows\\(\\)\\.find\\((${identifier})=>\\4\\.id===\\1\\);return \\2\\?\\3\\.mapTitle\\(\\2\\):"connecting"\\}`, 'g'), 'native friend map');
  const profile = unique(source, new RegExp(`\x60Playing on \\$\\{${literal(roomName[2])}\\.rows\\(\\)\\.find\\((${identifier})=>\\1\\.id===(${identifier})\\.roomId\\)\\?\\.name\\?\\?${literal(roomName[4])}\\(\\2\\.roomId\\)\\}\x60`, 'g'), 'native profile presence');
  const invite = unique(source, new RegExp(`invite:(${identifier})=>\\{const (${identifier})=(${identifier})\\.connected\\(\\)\\?(${identifier})\\.rows\\(\\)\\.find\\((${identifier})=>\\5\\.name===\\3\\.title\\(\\)\\)\\?\\.id:null;if\\(!\\2\\)\\{(${identifier})\\.toast\\("Join a server first, then invite friends to it\\."\\);return\\}(${identifier})\\.invite\\(\\1\\.userId,\\2\\),`, 'g'), 'native friend invitation');
  const ownRoom = unique(source, new RegExp(`myRoom:\\(\\)=>(${identifier})\\.connected\\(\\)\\?(${identifier})\\.rows\\(\\)\\.find\\((${identifier})=>\\3\\.name===\\1\\.title\\(\\)\\)\\?\\.id\\?\\?null:null`, 'g'), 'native passive invite link');
  const note = unique(source, new RegExp(`noteOf\\((${identifier})\\)\\{const (${identifier})=(${identifier})\\[\\1\\.roomId\\?\\?"eu"\\]\\?\\.name\\?\\?"Surfd EU"`, 'g'), 'native invitation label');
  const fallback = unique(source, new RegExp(`${literal(roomName[4])}=(${identifier})=>(${identifier})\\[\\1\\]\\?\\.name\\?\\?"Surfd "\\+\\1\\.toUpperCase\\(\\)`, 'g'), 'native room label fallback');
  const liveInvite = unique(source, new RegExp(`invite\\((${identifier}),(${identifier})\\)\\{this\\.write\\("invite",\\{to:\\1,roomId:\\2\\},("[^"]+")\\)\\}`, 'g'), 'native invite response');
  const proxyInvite = unique(source, new RegExp(`invite\\((${identifier}),(${identifier})\\)\\{this\\.inner\\.invite\\(\\1,\\2\\)\\}`, 'g'), 'native invite proxy');
  const inviteAction = unique(source, new RegExp(`(${identifier})==="invite"&&\\((${identifier})\\.invite\\((${identifier})\\),(${identifier})\\.add\\(\\3\\.userId\\),(${identifier})\\(\\)\\)`, 'g'), 'native invite acknowledgement');
  const passiveLink = unique(source, new RegExp(`(${identifier})\\.myRoom\\(\\)\\?\x60Invite link: surfd\\.net/\\?join=\\$\\{\\1\\.myRoom\\(\\)\\}\x60:`, 'g'), 'native passive invite text');
  const profileRoom = unique(source, new RegExp(`roomOf:(${identifier})=>\\{const (${identifier})=(${identifier})\\.friends\\(\\)\\.find\\((${identifier})=>\\4\\.userId===\\1\\),(${identifier})=(${identifier})\\.connected\\(\\)\\?(${identifier})\\.rows\\(\\)\\.find\\((${identifier})=>\\8\\.name===\\6\\.title\\(\\)\\)\\?\\.id:null;return \\2\\?\\.presence\\.kind==="server"&&\\2\\.presence\\.roomId!==\\5\\?\\2\\.presence\\.roomId:null\\}`, 'g'), 'native profile join availability');
  for (const join of joins) source = source.replace(join[0], () => `join:${join[1]}=>{${join[2]}.close(!1);return ${community(join[1])}?__qolNativeJoin(${join[1]},${invite[6]}):${join[3]}(${join[1]})}`);
  source = source.replace(roomName[0], () => `roomName:${roomName[1]}=>${community(roomName[1])}?__qolNativeRoomName(${roomName[1]}):${roomName[0].slice(roomName[0].indexOf('=>') + 2)}`);
  source = source.replace(roomMap[0], () => roomMap[0].replace('{', () => `{if(${community(roomMap[1])})return __qolNativeRoomMap(${roomMap[1]});`));
  source = source.replace(profile[0], () => `(${community(`${profile[2]}.roomId`)}?"Playing on "+__qolNativeRoomName(${profile[2]}.roomId)+" · "+__qolNativeRoomMap(${profile[2]}.roomId):${profile[0]})`);
  source = source.replace(invite[0], () => `invite:${invite[1]}=>{const ${invite[2]}=${native}?.connected()?${native}.roomId():null;if(!${invite[2]}){${invite[6]}.toast("Join a server first, then invite friends to it.");return}if(${community(invite[2])})return __qolNativeInvite(${invite[1]},${invite[2]},${invite[7]},${invite[6]});${invite[7]}.invite(${invite[1]}.userId,${invite[2]}),`);
  // Keep real room identity for same-room Join gating. Community-room CSS hides
  // native Invite separately; suppress private codes only in the passive link.
  source = source.replace(ownRoom[0], () => `myRoom:()=>${native}?.connected()?${native}.roomId():null`);
  source = source.replace(passiveLink[0], () => `${passiveLink[1]}.myRoom()&&(!${community(`${passiveLink[1]}.myRoom()`)}||${hook}?.roomInfo?.(${passiveLink[1]}.myRoom())?.visibility==="public")?\x60Invite link: surfd.net/?join=\${${passiveLink[1]}.myRoom()}\x60:`);
  source = source.replace(profileRoom[0], () => profileRoom[0].replace(`${profileRoom[6]}.connected()?${profileRoom[7]}.rows().find(${profileRoom[8]}=>${profileRoom[8]}.name===${profileRoom[6]}.title())?.id:null`, `${native}?.connected()?${native}.roomId():null`));
  // Both native layers otherwise discard write()'s acknowledged response / null error.
  source = source.replace(liveInvite[0], () => liveInvite[0].replace('{this.write(', '{return this.write('));
  source = source.replace(proxyInvite[0], () => proxyInvite[0].replace('{this.inner.invite(', '{return this.inner.invite('));
  source = source.replace(inviteAction[0], () => `${inviteAction[1]}==="invite"&&(${community(`${inviteAction[2]}.myRoom()`)}?${inviteAction[2]}.invite(${inviteAction[3]}).then(sent=>{if(sent){${inviteAction[4]}.add(${inviteAction[3]}.userId);${inviteAction[5]}()}}):(${inviteAction[2]}.invite(${inviteAction[3]}),${inviteAction[4]}.add(${inviteAction[3]}.userId),${inviteAction[5]}()))`);
  source = source.replace(note[0], () => `noteOf(${note[1]}){const ${note[2]}=${community(`${note[1]}.roomId`)}?__qolNativeRoomName(${note[1]}.roomId):${note[3]}[${note[1]}.roomId??"eu"]?.name??"Surfd EU"`);
  source = source.replace(fallback[0], () => `${roomName[4]}=${fallback[1]}=>${community(fallback[1])}?__qolNativeRoomName(${fallback[1]}):${fallback[2]}[${fallback[1]}]?.name??"Surfd "+${fallback[1]}.toUpperCase()`);
  // Native only publishes menu/solo; server presence requires the site's backend.
  // Never invent it from community roster account ids (those are self-asserted).
  return source + `
async function __qolNativeJoin(id,options){
  try{
    if(typeof ${hook}?.join!=="function")throw new Error("Community rooms are unavailable. Reload Surfd QoL and try again.");
    return await ${hook}.join(id);
  }catch(error){options.toast(error?.message??"Couldn't reach the room service. Try again in a moment.")}
}
async function __qolNativeInvite(friend,id,store,options){
  try{
    const result=await store.invite(friend.userId,id);
    if(result===null)return false;
    if(!result||result.ok===false){
      options.toast("The site did not confirm this community invite. Share the room code or link directly.");
      return false;
    }
    options.toast("Invitation sent to "+friend.name+".");
    return true;
  }catch(error){
    options.toast(error?.message??"Couldn't send the invite. Share the room code or link directly.");
    return false;
  }
}
function __qolNativeRoomName(id){const room=${hook}?.roomInfo?.(id);return room?.visibility==="public"?room.name:"Private room"}
function __qolNativeRoomMap(id){return ${hook}?.roomInfo?.(id)?.mapTitle??"connecting"}
`;
}
