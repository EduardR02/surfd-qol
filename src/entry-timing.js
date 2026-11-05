// One console line per solo, practice or room map entry: the time from the
// start of the load to the first physics step, and where it went.

// start, loaded and step are times; attempt is the run ticket request that
// was pending when loading ended, {start, end}, or null.
export function entryPhases({start, loaded, step, attempt = null}) {
  const total = step - start, loading = loaded - start;
  const ticket = attempt ? Math.max(0, Math.min(attempt.end ?? step, step) - Math.max(attempt.start, loaded)) : 0;
  return {total, loading, ticket, rest: total - loading - ticket};
}

const RECORD = {cache: 'collision record from cache', download: 'no collision record yet'};

export function formatEntry(map, phases, record = null) {
  const ms = value => Math.round(value);
  const parts = [`loading ${ms(phases.loading)}`, `run ticket wait ${ms(phases.ticket)}`, `first step ${ms(phases.rest)}`];
  return `[Surfd QoL] ${map} ready in ${ms(phases.total)} ms: ${parts.join(', ')}${RECORD[record] ? `; ${RECORD[record]}` : ''}`;
}

// Marks come from existing hook points during entry only: the load start, the
// first drawn frame, ticket requests, and the first step.
export function createEntryTiming({now = () => performance.now(), log = line => console.info(line)} = {}) {
  let entry = null;
  return {
    get pending() { return entry !== null; },
    start(map) {
      entry = {map: typeof map === 'string' && map ? map : 'map', start: now(), loaded: null, record: null, attempt: null};
    },
    loaded(record) {
      if (!entry || entry.loaded !== null) return;
      entry.loaded = now();
      entry.record = record;
    },
    // A ticket request still pending once the map has loaded holds the first step.
    attempt(promise) {
      if (!entry) return;
      const attempt = entry.attempt = {start: now(), end: null}, current = entry;
      Promise.resolve(promise).finally(() => { if (current.attempt === attempt) attempt.end = now(); }).catch(() => {});
    },
    step() {
      const current = entry;
      entry = null;
      // A load that failed or never drew its first frame has no entry to report.
      if (!current || current.loaded === null) return;
      log(formatEntry(current.map, entryPhases({...current, step: now()}), current.record));
    },
  };
}
