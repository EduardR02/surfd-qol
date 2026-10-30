// The runs a replay can have alongside it, on the loaded map: your PB and
// recent best, the site and KSF records, and any run on the leaderboard.
// Each is {id, label, time, reason (why it can't be added), load()}.
export function ghostSources({best = null, recentBest = null, refs = null, canWatch = () => false, archive = null}) {
  const list = [];
  const local = run => run && canWatch(run) ? () => archive.get(run.id) : null;
  if (best?.official) list.push({id: 'pb', label: 'PB', time: best.time, load: () => refs.loadReplay(best.runId)});
  else if (best) list.push({id: 'pb', label: 'Best finish', time: best.time, load: local(best), reason: local(best) ? '' : 'Its replay wasn’t kept'});
  else list.push({id: 'pb', label: 'PB', time: null, load: null, reason: 'No finish on this map yet'});
  if (recentBest && recentBest.id !== best?.id) list.push({id: 'recent', label: 'Recent best', time: recentBest.time,
    load: local(recentBest), reason: local(recentBest) ? '' : 'Its replay wasn’t kept'});
  const record = refs?.record;
  list.push(record?.runId && typeof refs.loadReplay === 'function'
    ? {id: `run:${record.runId}`, label: 'Site WR', time: record.timeUs / 1e6, load: () => refs.loadReplay(record.runId)}
    : {id: 'wr', label: 'Site WR', time: null, load: null, reason: 'No leaderboard on this map'});
  list.push(typeof refs?.loadRecordRoute === 'function'
    ? {id: 'ksf', label: 'KSF WR', time: null, load: () => refs.loadRecordRoute().then(replay => replay ?? Promise.reject(new Error('The KSF record route isn’t available.')))}
    : {id: 'ksf', label: 'KSF WR', time: null, load: null, reason: 'No KSF record route'});
  return list;
}
// A leaderboard run. The site WR is the same run as #1, so they share an id.
export function boardSource(entry, refs) {
  return {id: `run:${entry.runId}`, label: `#${entry.rank} ${entry.username ?? 'Guest'}`, time: entry.timeUs / 1e6, load: () => refs.loadReplay(entry.runId)};
}
