import { useEffect, useState } from "react";
import { j, jDaily, jl, jlDaily } from "./data";

/**
 * Which helper in lib/data.ts resolves the name, and with it the caching
 * semantics. League files go through `jl`/`jlDaily`, which prefix the resolved
 * league base; the market feeds and the crawl corpora belong to no league and
 * take a full path through `j`/`jDaily`. The `Daily` pair adds the date
 * cache-bust for files on the nightly schedule — the scope has to match what
 * the rest of the site uses for the same file, because the cache keys on the
 * finished path string and a mismatched pair downloads it twice.
 */
export type JsonScope = "league" | "leagueDaily" | "global" | "globalDaily";

const FETCH = {
  league: jl,
  leagueDaily: jlDaily,
  global: j,
  globalDaily: jDaily,
} as const;

export interface Json<T> {
  /** null until the fetch settles, and on a failed one */
  data: T | null;
  error: boolean;
  /** true from mount, or from a path change, until that path settles */
  loading: boolean;
}

const IDLE: Json<never> = { data: null, error: false, loading: false };

/**
 * Fetch one JSON file into state.
 *
 * This replaces the hand-rolled `useEffect(() => { jl(…).then(setX) }, [])`
 * that every view had a copy of. Two things it does that most of those copies
 * did not:
 *
 *  - **Nothing lands after unmount.** Each run owns a `live` flag its cleanup
 *    clears, so a fetch still in flight when the reader navigates away resolves
 *    into nothing instead of a setState on a dead component. Six call sites had
 *    no guard at all.
 *  - **A path change resets first.** State is cleared in render, not from the
 *    effect, so no frame ever pairs the previous path's data with the new one
 *    — which is exactly how a season drawer showed the last season's numbers
 *    under this season's heading.
 *
 * `name` of null means "nothing to fetch yet" — for a path that depends on
 * another file, or a fetch that only some states need. It is a real value, not
 * a way to skip the hook: the hook is always called.
 *
 * Caching, cache-busting and the league prefix all stay in lib/data.ts. This is
 * only the React end of it, so a second caller of the same file costs one
 * promise `.then`, not a second download.
 */
export function useJson<T>(name: string | null, scope: JsonScope = "league"): Json<T> {
  const key = name == null ? null : `${scope}:${name}`;
  const [st, setSt] = useState<Json<T>>(
    () => (name == null ? IDLE : { data: null, error: false, loading: true }));
  const [cur, setCur] = useState(key);
  if (cur !== key) {
    setCur(key);
    setSt(key == null ? IDLE : { data: null, error: false, loading: true });
  }

  useEffect(() => {
    if (name == null) return;
    let live = true;
    FETCH[scope]<T>(name).then(
      d => { if (live) setSt({ data: d, error: false, loading: false }); },
      () => { if (live) setSt({ data: null, error: true, loading: false }); },
    );
    return () => { live = false; };
  }, [name, scope]);

  return st;
}
