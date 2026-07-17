declare const __BUILD_ID__: string;

const cache = new Map<string, Promise<unknown>>();
// Cache-bust key: the build id changes on every deploy (guarantees a refetch
// when new data ships), combined with the data version when it's known.
let ver = __BUILD_ID__;
export function setVersion(v: string) { ver = `${__BUILD_ID__}.${v}`; }

/** fetch JSON once per path per page load (cache-busted by build + data version) */
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
