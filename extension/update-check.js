const CACHE_KEY = 'surfd-qol-release';
const CHECK_INTERVAL = 24 * 60 * 60 * 1000;
const API = 'https://api.github.com/repos/EduardR02/surfd-qol/releases/latest';
export const RELEASE_URL = 'https://github.com/EduardR02/surfd-qol/releases/latest';
const versionParts = value => typeof value === 'string' && /^v?\d{1,5}(?:\.\d{1,5}){2,3}$/.test(value)
  ? value.replace(/^v/, '').split('.').map(Number) : null;

export function newerVersion(candidate, installed) {
  const next = versionParts(candidate), current = versionParts(installed);
  if (!next || !current) return false;
  for (let i = 0; i < Math.max(next.length, current.length); i++) {
    const difference = (next[i] ?? 0) - (current[i] ?? 0);
    if (difference) return difference > 0;
  }
  return false;
}

// Metadata only: no downloaded code, timers or work in the game's frame loop.
// Failed checks are cached too, so offline visits do not keep retrying.
export function createUpdateChecker({storage, version, fetcher = fetch, clock = Date.now}) {
  let cached, pending = null;
  const result = () => newerVersion(cached?.version, version)
    ? {version: cached.version.replace(/^v/, ''), url: RELEASE_URL} : null;
  async function check() {
    if (cached === undefined) {
      try { cached = (await storage.get(CACHE_KEY))[CACHE_KEY] ?? null; } catch { cached = null; }
    }
    const now = clock();
    if (Number.isFinite(cached?.checkedAt) && now >= cached.checkedAt && now - cached.checkedAt < CHECK_INTERVAL) return result();
    let latest = cached?.version ?? null;
    try {
      const response = await fetcher(API, {credentials: 'omit', signal: AbortSignal.timeout(10000), headers: {Accept: 'application/vnd.github+json'}});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const release = await response.json();
      if (release.draft || release.prerelease || !versionParts(release.tag_name)) throw new Error('Not a stable version');
      latest = release.tag_name;
    } catch { /* No notice on a first failed check; keep any previous release. */ }
    cached = {checkedAt: now, version: latest};
    try { await storage.set({[CACHE_KEY]: cached}); } catch { /* in-memory cache still applies */ }
    return result();
  }
  return () => {
    if (!pending) pending = check().finally(() => { pending = null; });
    return pending;
  };
}
