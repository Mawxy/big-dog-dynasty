declare const __BUILD_ID__: string;

const cache = new Map<string, Promise<unknown>>();
// Cache-bust key: the build id changes on every deploy (guarantees a refetch
// when new data ships), combined with the data version when it's known.
let ver = __BUILD_ID__;
export function setVersion(v: string) { ver = `${__BUILD_ID__}.${v}`; }

/** fetch JSON once per path per page load (cache-busted by build + data version).
 *  A failed fetch is evicted so the next caller retries rather than inheriting
 *  the cached rejection for the life of the page. */
export function j<T>(path: string): Promise<T> {
  if (!cache.has(path)) {
    const sep = path.includes("?") ? "&" : "?";
    const p = fetch(`${path}${sep}v=${encodeURIComponent(ver)}`).then(r => {
      if (!r.ok) throw new Error(`failed to load ${path}`);
      return r.json();
    });
    p.catch(() => cache.delete(path));
    cache.set(path, p);
  }
  return cache.get(path) as Promise<T>;
}

/** values.json refreshes daily on its own schedule — bust by date, not data version */
export function jDaily<T>(path: string): Promise<T> {
  return j<T>(`${path}?d=${new Date().toISOString().slice(0, 10)}`);
}

/**
 * Where this league's data lives. Set once at boot from the resolved league.
 * Empty means the flat pre-restructure layout.
 */
let leagueBase = "";
export function setLeagueBase(key: string) {
  leagueBase = key ? `data/leagues/${key}/` : "";
}

/**
 * Point the base at the league layout only if it is actually there.
 *
 * Without this every jl() call pays a 404 before falling back, which during the
 * transition is ~20 wasted requests per page load. One probe answers it for the
 * whole session; if the files haven't moved yet the base clears and jl() goes
 * straight to the flat layout.
 */
export async function probeLeagueBase(key: string): Promise<void> {
  if (!key) return setLeagueBase("");
  setLeagueBase(key);
  const ok = await fetch(`${leagueBase}meta.json?v=${encodeURIComponent(ver)}`)
    .then(r => r.ok).catch(() => false);
  if (!ok) setLeagueBase("");
}

/**
 * Fetch a LEAGUE-SCOPED file by name, e.g. `jl("meta.json")` or
 * `jl("2025/teams.json")`.
 *
 * Falls back to the flat `data/<name>` layout when the league path 404s, which
 * is what makes moving the files a separate, reversible change rather than one
 * commit that has to land the scripts, the site and the data together. Once
 * everything is moved the fallback is dead weight and can go.
 *
 * Global files — values.json, the crawl corpora — are NOT fetched through this;
 * they use `j()` directly, because they belong to no league.
 */
export function jl<T>(name: string): Promise<T> {
  if (!leagueBase) return j<T>(`data/${name}`);
  return j<T>(`${leagueBase}${name}`).catch(() => j<T>(`data/${name}`));
}

/** jl + the daily cache-bust, for league files on the values schedule */
export function jlDaily<T>(name: string): Promise<T> {
  const d = `?d=${new Date().toISOString().slice(0, 10)}`;
  if (!leagueBase) return j<T>(`data/${name}${d}`);
  return j<T>(`${leagueBase}${name}${d}`).catch(() => j<T>(`data/${name}${d}`));
}
