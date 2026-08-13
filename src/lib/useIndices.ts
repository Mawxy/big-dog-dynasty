import { useMemo } from "react";
import type { CviFile, DviFile, IndexModelsFile, MatrixFile, ProjectionsFile } from "./types";
import type { Json } from "./useJson";
import { useJson } from "./useJson";
import { useModel } from "./model";

/**
 * DVI and CVI for the curve the site is currently being read under.
 *
 * These are DROP-IN replacements for `useJson<DviFile>("dvi.json")`: they hand
 * back the same shape, so the twelve screens that read these figures each
 * changed by one line rather than being rewritten around a new data model.
 *
 * WHY ONE FILE INSTEAD OF SIX. index_models.json is ~181 KB and holds all six
 * curves; dvi.json and cvi.json are ~37 KB each. So the first screen that needs
 * an index pays about 107 KB more than before and every model flip after that
 * is free — no fetch, no spinner, no chance of a screen showing one curve while
 * its neighbour shows another. Fetching per curve would have inverted all three.
 *
 * WHY dvi.json STILL EXISTS. It is the default curve, it is what
 * validate_data checks index_models.json against, and it is the fallback below
 * for data built before this file did. Two publishers of one number is a real
 * risk, which is why the pipeline writes both from the same run and the
 * validator fails if they ever disagree.
 */
function useIndexModels() {
  const q = useJson<IndexModelsFile>("index_models.json", "leagueDaily");
  return q;
}

export function useDvi(): DviFile | null {
  const { curve } = useModel();
  const mx = useIndexModels();
  // The fallback is a real path, not defensive noise: a deploy whose data
  // predates index_models.json still renders, on the default curve, and the
  // masthead control hides itself rather than offering six choices that all
  // return the same numbers.
  const flat = useJson<DviFile>("dvi.json", "leagueDaily");
  return useMemo(() => {
    if (!mx.data) return mx.error ? flat.data : null;
    const players: DviFile["players"] = {};
    for (const [pid, r] of Object.entries(mx.data.players)) {
      const t = r.dvi[curve];
      if (t) players[pid] = { name: r.name, pos: r.pos, dvi: t[0], rank: t[1], pos_rank: t[2] };
    }
    return { generated: mx.data.generated, players };
  }, [mx.data, mx.error, flat.data, curve]);
}

export function useCvi(): CviFile | null {
  const { curve } = useModel();
  const mx = useIndexModels();
  const flat = useJson<CviFile>("cvi.json", "leagueDaily");
  return useMemo(() => {
    if (!mx.data) return mx.error ? flat.data : null;
    const players: CviFile["players"] = {};
    for (const [pid, r] of Object.entries(mx.data.players)) {
      const t = r.cvi[curve];
      if (t) players[pid] = { name: r.name, pos: r.pos, cvi: t[0], rank: t[1], pos_rank: t[2] };
    }
    return { generated: mx.data.generated, format: mx.data.format, players };
  }, [mx.data, mx.error, flat.data, curve]);
}

/**
 * The `Json<T>`-shaped form, for call sites that hold query objects rather than
 * data — Value.tsx gates its whole board on `.loading` across seven fetches, so
 * handing it bare data would have made the index the one source that couldn't
 * say whether it had arrived.
 */
export function useDviQuery(): Json<DviFile> {
  const mx = useIndexModels();
  const data = useDvi();
  return { data, error: mx.error, loading: mx.loading };
}
export function useCviQuery(): Json<CviFile> {
  const mx = useIndexModels();
  const data = useCvi();
  return { data, error: mx.error, loading: mx.loading };
}

/**
 * Projected 3-year WAR for the curve the site is being read under.
 *
 * The third currency. Without this the masthead control would reprice DVI and
 * CVI while the WAR column sat still on the scalar composite, which reads as a
 * broken selector rather than as a deliberate exemption.
 *
 * Reads `totals` from projections_matrix.json — the three-year sum, not the
 * year-1 figure the two indices clamp on. That difference is real and predates
 * this: DVI and CVI have always been year-1 signals while the trade machine's
 * WAR column has always been the 3-year total. The model control does not
 * introduce it, but it does make it visible, since one selector now drives
 * figures over two horizons.
 */
export function useProjWar(): Record<string, number> | null {
  const { curve } = useModel();
  const mx = useJson<MatrixFile>("projections_matrix.json");
  const flat = useJson<ProjectionsFile>("projections.json");
  return useMemo(() => {
    if (mx.data) {
      const out: Record<string, number> = {};
      for (const r of mx.data.players) {
        const t = r.totals?.[curve];
        if (t != null) out[r.pid] = t;
      }
      return out;
    }
    if (!flat.data) return null;
    // pre-matrix data: the scalar composite was the only curve there was
    const out: Record<string, number> = {};
    for (const p of flat.data.players) out[p.pid] = p.total_comp;
    return out;
  }, [mx.data, flat.data, curve]);
}

/**
 * Whether a player has a second opinion at all, for the two curves that would
 * otherwise be silent about it.
 *
 * `analog` false means his analog and blend PROJECTIONS are the scalar one;
 * `sleeper` false means every composite projection is his own natural. Neither
 * means his index figure is model-independent — both indices clamp on
 * percentiles of the whole field, so changing the model reprices everyone and
 * moves him too. Of the 65 players with no analog cohort, all 65 had identical
 * WAR across curves and only 4 an identical DVI. Say "not measured for him",
 * never "won't change".
 */
export function useIndexFallbacks(pid: string | null) {
  const mx = useIndexModels();
  const r = pid ? mx.data?.players[pid] : null;
  return r ? { analog: r.has_analog, sleeper: r.has_sleeper } : null;
}

export { useIndexModels };
