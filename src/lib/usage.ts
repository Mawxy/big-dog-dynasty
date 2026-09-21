import { indexKey, jl } from "./data";

/**
 * USAGE AND EFFICIENCY — the nflverse figures scripts/usage_stats.py puts on
 * the site (Max, 2026-09-16): data/<season>/usage.json, one object per Sleeper
 * pid, and the same rows folded into each player's shard as `usage`.
 *
 * Every key is the CSV column's own name (nfl_features.py), so the board, the
 * player page and the script that computes the figure agree by construction.
 * Each position ships its own five; a figure the source left blank is absent
 * from the object and reads as the em dash, never 0.
 */
export type UsageKey =
  | "fp_exp_pg" | "fp_diff_pg"
  | "att_pg" | "car_pg" | "epa_db" | "cpoe"
  | "tgt_pg" | "tgt_share" | "ay_share" | "adot"
  | "car_share" | "rb_touch_share"
  /** every position's, and shown on the BOX SCORE rather than the Maxalytics
   *  lens (Max, 2026-09-17): the field-time behind the league line */
  | "snap_pct";

export type UsageRow = { g: number } & Partial<Record<UsageKey, number>>;
/** THE LEAGUE'S WINDOWS (Max, 2026-09-16): the regular season, the bracket
 *  weeks, and both — summed by usage_stats.py off the league's own
 *  playoff_start, so a receiver's week-16 catches never sit beside a PPG that
 *  stopped at week 14. A window he never touched the ball in is absent. */
export type UsagePhase = "reg" | "post" | "both";
export type UsagePhases = Partial<Record<UsagePhase, UsageRow>>;
export type UsageFile = Record<string, UsagePhases>;

/** THE POSITION'S OWN FIVE (Max, 2026-09-16). Expected PPG is common to all
 *  four; the other four are what usage means at that position. */
export const POS_USAGE: Record<string, UsageKey[]> = {
  QB: ["fp_exp_pg", "att_pg", "car_pg", "epa_db", "cpoe"],
  RB: ["fp_exp_pg", "car_pg", "tgt_share", "car_share", "rb_touch_share"],
  WR: ["fp_exp_pg", "tgt_pg", "tgt_share", "ay_share", "adot"],
  TE: ["fp_exp_pg", "tgt_pg", "tgt_share", "ay_share", "adot"],
};

/** the header, and the long form the Key spells out */
export const USAGE_LABEL: Record<UsageKey, { label: string; short?: string; def: string }> = {
  fp_exp_pg: { label: "Exp PPG", def:
    "Expected fantasy points per game (ffopportunity): what an average player would have "
    + "scored from the same targets, carries and air yards. PPR, before this league's TE premium." },
  fp_diff_pg: { label: "Vs exp", def:
    "Actual minus expected fantasy points per game. Finishing skill plus touchdown luck, and "
    + "the figure most likely to regress toward zero next year." },
  att_pg: { label: "Att/G", def: "Pass attempts per game." },
  car_pg: { label: "Car/G", def: "Carries per game." },
  epa_db: { label: "EPA/DB", def:
    "Expected points added per dropback — passing EPA over attempts plus sacks. Efficiency, "
    + "not volume." },
  cpoe: { label: "CPOE", def:
    "Completion percentage over expected, in percentage points, weighted by attempts. "
    + "Accuracy against the difficulty of the throws actually made." },
  tgt_pg: { label: "Tgt/G", def: "Targets per game." },
  tgt_share: { label: "Tgt %", def:
    "Target share: his targets over his team's, averaged over the weeks he had a stat line." },
  ay_share: { label: "AY %", def:
    "Air-yard share: his share of the team's intended air yards, averaged over stat-line weeks. "
    + "The downfield half of usage; target share is the volume half." },
  adot: { label: "aDOT", def: "Average depth of target, in yards downfield per target." },
  car_share: { label: "Car %", def:
    "Carry share: his carries over his team's in the weeks he had a stat line, every "
    + "position in the denominator." },
  rb_touch_share: { label: "RB touch %", short: "RB %", def:
    "Share of the RB room's touches: his carries plus receptions over those of every running "
    + "back on his team in the weeks he played." },
  snap_pct: { label: "Snap %", short: "SNAP", def:
    "Offensive snap share: his snaps over his team's, summed over the weeks he had a stat "
    + "line in the window (nflverse snap counts, 2012 on)." },
};

/** how a figure prints, in a column and on the player page */
export function fmtUsage(k: UsageKey, v: number): string {
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  // sign decided AFTER rounding — the same rule `lib/stats.ts#sgn` follows.
  // -0.04 vs exp at one place is "0.0", not the "−0.0" this column printed.
  const signed = (x: number, d: number) => {
    const s = Math.abs(x).toFixed(d);
    return (/^0(\.0*)?$/.test(s) ? "" : x > 0 ? "+" : "−") + s;
  };
  switch (k) {
    case "tgt_share": case "ay_share": case "car_share": case "rb_touch_share": case "snap_pct":
      return pct(v);
    case "fp_diff_pg": return signed(v, 1);
    case "epa_db": return signed(v, 2);
    case "cpoe": return signed(v, 1);
    default: return v.toFixed(1);
  }
}

/** pid -> season -> the three windows */
export interface UsageIndex { byPlayer: Record<string, Record<string, UsagePhases>> }

/** one index per (league, season list) — see `lib/data.ts#indexKey` */
const cache = new Map<string, Promise<UsageIndex>>();

/** every season's usage.json once per page load — the loadHonors shape. A
 *  season without the file (the one being played, before its first features
 *  run) is simply absent. */
export function loadUsage(seasons: string[]): Promise<UsageIndex> {
  const ck = indexKey(seasons);
  const hit = cache.get(ck);
  if (hit) return hit;
  const pending = (async () => {
    const files = await Promise.all(seasons.map(s => jl<UsageFile>(`${s}/usage.json`).catch(() => null)));
    const byPlayer: UsageIndex["byPlayer"] = {};
    seasons.forEach((season, i) => {
      const f = files[i];
      if (!f) return;
      for (const [pid, row] of Object.entries(f)) (byPlayer[pid] ??= {})[season] = row;
    });
    return { byPlayer };
  })();
  cache.set(ck, pending);
  pending.catch(() => cache.delete(ck));
  return pending;
}

/**
 * A player's usage over a set of seasons: one season's row as it stands, or a
 * GAMES-WEIGHTED pool over several — a per-game rate over 17 games and one
 * over 4 are not the same evidence, and a plain mean of the two would say
 * they were. A key absent from every season stays absent.
 */
export function usageOf(
  idx: UsageIndex | null, pid: string, seasons: string[], phase: UsagePhase = "reg",
): UsageRow | null {
  const rows = seasons.map(s => idx?.byPlayer[pid]?.[s]?.[phase]).filter((r): r is UsageRow => !!r);
  if (!rows.length) return null;
  if (rows.length === 1) return rows[0];
  const out: UsageRow = { g: rows.reduce((a, r) => a + r.g, 0) };
  const keys = new Set<UsageKey>();
  for (const r of rows) for (const k of Object.keys(r)) if (k !== "g") keys.add(k as UsageKey);
  for (const k of keys) {
    let num = 0, den = 0;
    for (const r of rows) {
      const v = r[k];
      if (v == null || !r.g) continue;
      num += v * r.g; den += r.g;
    }
    if (den) out[k] = num / den;
  }
  return out;
}
