const identifier = '[A-Za-z_$][\\w$]*';
const literal = name => name.replace(/\$/g, () => '\\$');
const methods = ['entries', 'selected', 'save', 'select', 'cycle', 'remove', 'restore'];

function unique(source, pattern, label) {
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`Unsupported Surfd build: ${label} (${matches.length} matches)`);
  return matches[0];
}

// In a community room the saveloc store's methods come from the room. The game's
// panel gains owner names, a count and help text; native Save leaves its message
// to the room. Load still runs the game's whole restore sequence.
export function nativeSavelocHooks(source, store) {
  const panel = unique(source, new RegExp(`function (${identifier})\\((${identifier}),${identifier},${identifier}\\)\\{const ${identifier}=document\\.getElementById\\("save"\\),`, 'g'), 'saveloc panel');
  const selector = unique(source, new RegExp(`const (${identifier})=${literal(panel[1])}\\(${literal(store)},`, 'g'), 'saveloc selector')[1];
  const label = unique(source, new RegExp('(' + identifier + ')\\.textContent=`#\\$\\{(' + identifier + ')\\.id\\} · ', 'g'), 'saveloc label');
  const save = unique(source, new RegExp(`const ${identifier}=${literal(store)}\\.entries\\((${identifier})\\)\\.length>=${identifier},${identifier}=${literal(store)}\\.save\\(\\1\\)`, 'g'), 'saveloc save action');
  const count = unique(source, new RegExp('(' + identifier + ')\\.textContent=`\\$\\{(' + identifier + ')\\.length\\} / \\$\\{' + identifier + '\\}`', 'g'), 'saveloc count');
  source = source.replace(label[0], () => `${label[1]}.textContent=\`\${${label[2]}.name ? ${label[2]}.name + " #" + ${label[2]}.id : "#" + ${label[2]}.id} · `);
  source = source.replace(save[0], () => `if(__qolSharedPractice){${store}.save(${save[1]});${selector}.refresh();return}${save[0]}`);
  source = source.replace(count[0], () => `${count[1]}.textContent=__qolSharedPractice?${count[2]}.length+" shared":${count[0].slice(count[0].indexOf('=') + 1)}`);
  return {source, setup: `
var __qolSharedPractice=null;
const __qolPracticeMethods=${JSON.stringify(methods)};
let __qolPracticeOriginals=null,__qolPracticeHelp=null;
function __qolRefreshPractice(){
  const help=document.getElementById("saveloc-help");
  if(help){
    __qolPracticeHelp??=help.textContent;
    help.textContent=__qolSharedPractice?"Everyone in this room sees your saves until the map changes. Each player keeps their newest 20. Deleting your own save removes it for everyone; deleting someone else’s hides it for you. Loading enters practice and restores the captured time.":__qolPracticeHelp;
  }
  ${store}.revision++;${selector}.refresh();
}
function __qolSetSharedPractice(handlers){
  if(__qolPracticeOriginals){
    for(const [name,descriptor] of __qolPracticeOriginals){
      if(descriptor)Object.defineProperty(${store},name,descriptor);else delete ${store}[name];
    }
    __qolPracticeOriginals=null;
  }
  __qolSharedPractice=handlers;
  if(handlers){
    __qolPracticeOriginals=__qolPracticeMethods.map(name=>[name,Object.getOwnPropertyDescriptor(${store},name)]);
    for(const name of __qolPracticeMethods)${store}[name]=(...args)=>handlers[name](...args);
  }
  __qolRefreshPractice();
  return ()=>{if(__qolSharedPractice===handlers)__qolSetSharedPractice(null)};
}
`, adapter: `
      // A community room's handlers replace the store's methods until the returned cleanup runs.
      shared: __qolSetSharedPractice,
      refresh: __qolRefreshPractice,
      shareSnapshot: snapshot => __qolSharedPractice?.saveSnapshot(snapshot) === true,`};
}
