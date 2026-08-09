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
 * There is no longer a fallback to the flat `data/<name>` layout. It existed to
 * make moving the files a reversible change; the migration is done (every
 * league file lives under data/leagues/<key>/) and the retry was pure cost —
 * it DOUBLED every expected 404, and expected 404s are routine here: a player
 * with no shard, a season with no odds.json or absence.json. Each one bought a
 * second round trip and a second red line in the console before the caller's
 * own `.catch` ran.
 *
 * `leagueBase` is still empty for data built before the registry existed, and
 * that case still reads the flat layout — as its only path, not as a retry.
 *
 * Global files — values.json, the crawl corpora — are NOT fetched through this;
 * they use `j()` directly, because they belong to no league.
 */
export function jl<T>(name: string): Promise<T> {
  return j<T>(`${leagueBase || "data/"}${name}`);
}

/** jl + the daily cache-bust, for league files on the values schedule */
export function jlDaily<T>(name: string): Promise<T> {
  return j<T>(`${leagueBase || "data/"}${name}?d=${new Date().toISOString().slice(0, 10)}`);
}
