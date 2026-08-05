const cache = new Map<string, Promise<unknown>>();
// Cache-bust key: the data version (meta.updated), set once meta.json loads.
// Fetches made before then (leagues.json, meta.json itself) carry no ?v= and
// ride GitHub Pages' short max-age — at most ~10 minutes stale, fine for data
// that refreshes weekly. A per-build id was deliberately dropped: it
// invalidated every JSON URL on all ~30 daily deploys, most of which shipped
// no new site data at all.
let ver = "";
export function setVersion(v: string) { ver = v; }

/** fetch JSON once per path per page load (cache-busted by data version).
 *  A failed fetch is evicted so the next caller retries rather than inheriting
 *  the cached rejection for the life of the page. */
export function j<T>(path: string): Promise<T> {
  if (!cache.has(path)) {
    const sep = path.includes("?") ? "&" : "?";
    const p = fetch(ver ? `${path}${sep}v=${encodeURIComponent(ver)}` : path).then(r => {
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
