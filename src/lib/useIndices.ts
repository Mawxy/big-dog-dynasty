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
 *
 * WHY THE FALLBACK IS NOT FETCHED UP FRONT. It used to be, unconditionally:
 * every screen that showed an index downloaded dvi.json and cvi.json (~76 KB
 * between them) alongside index_models.json and then read neither, because the
 * only branch that reads them is the one where index_models.json has FAILED.
 * `useJson(null)` means "nothing to fetch yet", so the fetch is now conditioned
 * on `mx.error` — the legacy path is unchanged the moment it is actually
 * needed, and costs nothing the rest of the time.
 */
function useIndexModels() {
  const q = useJson<IndexModelsFile>("index_models.json", "leagueDaily");
  return q;
}

/**
 * One implementation behind both `useDvi` and `useDviQuery`, so the fallback
 * fetch exists once per component rather than twice, and so `.loading` can
 * account for it: on the legacy path the board must not paint while the file
 * that carries its default sort column is still in flight.
 */
function useDviJson(): Json<DviFile> {
  const { curve } = useModel();
  const mx = useIndexModels();
  // The fallback is a real path, not defensive noise: a deploy whose data
  // predates index_models.json still renders, on the default curve, and the
  // masthead control hides itself rather than offering six choices that all
  // return the same numbers. It is REQUESTED only once that deploy is the one
  // we are on — see the note above.
  const flat = useJson<DviFile>(mx.error ? "dvi.json" : null, "leagueDaily");
  const data = useMemo(() => {
    if (!mx.data) return mx.error ? flat.data : null;
    const players: DviFile["players"] = {};
    for (const [pid, r] of Object.entries(mx.data.players)) {
      const t = r.dvi[curve];
      if (t) players[pid] = { name: r.name, pos: r.pos, dvi: t[0], rank: t[1], pos_rank: t[2] };
    }
    return { generated: mx.data.generated, players };
  }, [mx.data, mx.error, flat.data, curve]);
  return { data, error: mx.error, loading: mx.loading || flat.loading };
}

function useCviJson(): Json<CviFile> {
  const { curve } = useModel();
  const mx = useIndexModels();
  const flat = useJson<CviFile>(mx.error ? "cvi.json" : null, "leagueDaily");
  const data = useMemo(() => {
    if (!mx.data) return mx.error ? flat.data : null;
    const players: CviFile["players"] = {};
    for (const [pid, r] of Object.entries(mx.data.players)) {
      const t = r.cvi[curve];
      if (t) players[pid] = { name: r.name, pos: r.pos, cvi: t[0], rank: t[1], pos_rank: t[2], ecr: r.ecr };
    }
    return { generated: mx.data.generated, format: mx.data.format, players };
  }, [mx.data, mx.error, flat.data, curve]);
  return { data, error: mx.error, loading: mx.loading || flat.loading };
}

export function useDvi(): DviFile | null { return useDviJson().data; }
export function useCvi(): CviFile | null { return useCviJson().data; }

/**
 * The `Json<T>`-shaped form, for call sites that hold query objects rather than
 * data — Value.tsx gates its whole board on `.loading` across six fetches, so
 * handing it bare data would have made the index the one source that couldn't
 * say whether it had arrived.
 */
export function useDviQuery(): Json<DviFile> { return useDviJson(); }
export function useCviQuery(): Json<CviFile> { return useCviJson(); }

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
 * Projected YEAR-1 WAR for the curve the site is being read under — the
 * next-season figure, not useProjWar's 3-year total.
 *
 * The beta price board shows this one: a board column labeled "Proj WAR" next
 * to single-season figures (PPG, CVI) reads as next year, and the 3-year
 * total quietly tripling it made projections look inflated. The trade
 * machine's WAR column deliberately stays on the 3-year total — a traded
 * asset is bought for its stream, not its next season.
 */
export function useProjWar1(): Record<string, number> | null {
  const { curve } = useModel();
  const mx = useJson<MatrixFile>("projections_matrix.json");
  const flat = useJson<ProjectionsFile>("projections.json");
  return useMemo(() => {
    if (mx.data) {
      const out: Record<string, number> = {};
      for (const r of mx.data.players) {
        const y1 = r[curve]?.[0];
        if (y1 != null) out[r.pid] = y1;
      }
      return out;
    }
    if (!flat.data) return null;
    // pre-matrix data: composite[0] is the same number scalar_composite[0]
    // would carry (locked by tests/test_curves.py)
    const out: Record<string, number> = {};
    for (const p of flat.data.players)
      if (p.composite?.[0] != null) out[p.pid] = p.composite[0];
    return out;
  }, [mx.data, flat.data, curve]);
}

/**
 * `useIndexFallbacks(pid)` lived here and had no callers — it read
 * `has_analog` / `has_sleeper` off index_models.json for a player, which the
 * player page gets from its own shard's matrix row instead. Removed 2026-09-01.
 * The claim it existed to protect still stands and belongs to whoever writes
 * that copy next: those flags say a second opinion was never MEASURED for him,
 * not that his index figure is model-independent. Both indices clamp on
 * percentiles of the whole field, so changing the model reprices everyone and
 * moves him too — of the 65 players with no analog cohort, all 65 had identical
 * WAR across curves and only 4 an identical DVI.
 */

export { useIndexModels };
