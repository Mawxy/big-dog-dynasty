const cache = new Map<string, Promise<unknown>>();
let ver = "";
export function setVersion(v: string) { ver = v; }

/** fetch JSON once per path per page load (cache-busted by data version) */
export function j<T>(path: string): Promise<T> {
  if (!cache.has(path)) {
    const sep = path.includes("?") ? "&" : "?";
    cache.set(path, fetch(`${path}${sep}v=${encodeURIComponent(ver)}`).then(r => {
      if (!r.ok) throw new Error(`failed to load ${path}`);
      return r.json();
    }));
  }
  return cache.get(path) as Promise<T>;
}

/** values.json refreshes daily on its own schedule — bust by date, not data version */
export function jDaily<T>(path: string): Promise<T> {
  return j<T>(`${path}?d=${new Date().toISOString().slice(0, 10)}`);
}
