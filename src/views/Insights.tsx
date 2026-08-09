import { useEffect, useMemo, useState } from "react";
import type { Benchmarks, Franchises, Matchups, Weekly } from "../lib/types";
import { j, jl } from "../lib/data";
import { fmt, rate, sgn } from "../lib/stats";
import { useLeague } from "../lib/context";
import TScroll from "../components/TScroll";

/**
 * Insights — what a championship team looks like across every crawled league,
 * with this league's own figures beside them.
 *
 * Reads data/benchmarks.json, the merged output of the outcomes crawl. Every
 * published rate arrives with its own denominator (`n`), and the merge writes
 * null rather than a percentage built on a handful of observations — so a cell
 * reading "—" means not enough data yet, never zero. `Fig` below is the one
 * place that distinction is rendered, so it can't be lost per-table.
 */

/** a rate or per-unit figure with the sample behind it */
type F = { v: number | null; n: number; of?: number };

/** the one renderer for "figure or not enough data" */
function Fig({ f, as = "pct", d = 2 }: { f?: F; as?: "pct" | "num"; d?: number }) {
  if (!f || f.v == null) {
    return <span className="fig quiet" title={f ? `n = ${f.n}` : undefined}>—</span>;
  }
  return (
    <span className="fig" title={`n = ${f.n.toLocaleString("en-US")}`}>
      {as === "pct" ? rate(f.v) : fmt(f.v, d)}
    </span>
  );
}

export default function Insights() {
  const { players, league } = useLeague();
  const [b, setB] = useState<Benchmarks | null>(null);
  const [err, setErr] = useState(false);
  const [fr, setFr] = useState<Franchises | null>(null);
  const [ours, setOurs] = useState<Record<string, number[]> | null>(null);

  useEffect(() => {
    let live = true;
    j<Benchmarks>("data/benchmarks.json")
      .then(x => { if (live) setB(x); })
      .catch(() => { if (live) setErr(true); });
    jl<Franchises>("franchises.json").then(x => { if (live) setFr(x); }).catch(() => {});
    return () => { live = false; };
  }, [league]);

  /** our own champions' slot values, computed the same way the crawl does:
   *  each season's best n-th player at a position, by that season's WAR */
  useEffect(() => {
    if (!fr) return;
    let live = true;
    const played = [...new Set(Object.values(fr)
      .flatMap(f => f.seasons.filter(s => s.finish).map(s => s.season)))].sort();
    Promise.all(played.map(s => Promise.all([
      jl<Matchups>(`${s}/matchups.json`), jl<Weekly>(`${s}/weekly.json`),
    ]).then(([m, w]) => [s, m, w] as const).catch(() => null)))
      .then(all => {
        if (!live) return;
        const acc: Record<string, number[]> = {};
        for (const got of all) {
          if (!got) continue;
          const [season, m, w] = got;
          const champRid = Object.entries(fr).find(([, f]) =>
            f.seasons.some(s => s.season === season && s.finish === 1))?.[0];
          if (!champRid) continue;
          // regular-season WAR per player, then the champion's best at each slot
          const war = new Map<string, number>();
          for (const [pid, rows] of Object.entries(w)) {
            let t = 0;
            for (const r of rows) if (r[0] < m.playoff_start) t += r[5];
            war.set(pid, t);
          }
          const entries = m.teams[champRid] || [];
          const roster = new Set<string>();
          for (const e of entries) {
            for (const pid of e[4] ?? []) roster.add(pid);
            for (const pid of e[5] ?? []) roster.add(pid);
          }
          const byPos = new Map<string, number[]>();
          for (const pid of roster) {
            const pos = players[pid]?.[1];
            if (!pos || pos === "?") continue;
            (byPos.get(pos) ?? byPos.set(pos, []).get(pos)!).push(war.get(pid) ?? 0);
          }
          for (const v of byPos.values()) v.sort((x, y) => y - x);
          const slots: [string, string, number][] = [
            ["QB1", "QB", 1], ["QB2", "QB", 2], ["RB1", "RB", 1], ["RB2", "RB", 2],
            ["WR1", "WR", 1], ["WR2", "WR", 2], ["WR3", "WR", 3], ["TE1", "TE", 1]];
          for (const [key, pos, nth] of slots) {
            const v = byPos.get(pos);
            (acc[key] ??= []).push(v && v.length >= nth ? v[nth - 1] : 0);
          }
        }
        setOurs(acc);
      });
    return () => { live = false; };
  }, [fr, players]);

  /** our champions' mean at each slot, for the comparison column */
  const oursMean = useMemo(() => {
    if (!ours) return null;
    const m = new Map<string, number>();
    for (const [k, v] of Object.entries(ours)) {
      if (v.length) m.set(k, v.reduce((a, x) => a + x, 0) / v.length);
    }
    return m;
  }, [ours]);

  if (err) return (
    <div className="empty">
      No benchmarks yet — they arrive with the first outcomes crawl.
    </div>
  );
  if (!b) return <div className="empty">Loading benchmarks…</div>;

  const m = b.meta;
  const years = b.by_league_year.filter(y => y.league_seasons > 0);

  return (
    <>
      <div className="screen-head">
        <span className="screen-title">Insights</span>
        <span style={{ font: "400 14px/1 var(--cond)", letterSpacing: ".1em", textTransform: "uppercase", color: "var(--dim)" }}>
          {m.champions.toLocaleString("en-US")} championships · {m.league_seasons.toLocaleString("en-US")} league-seasons
        </span>
        <span className="screen-note">Updated {m.generated}</span>
      </div>

      {/* ---- what a title team is worth, slot by slot ---- */}
      <div className="band">
        <span className="band-label">The average championship lineup</span>
        <span className="band-note">
          Each slot is the roster's nth-best player at that position by that season's WAR —
          the lineup it could field, not the one it set
        </span>
      </div>
      <TScroll>
        <table style={{ tableLayout: "fixed" }}>
          <thead>
            <tr>
              <th scope="col" className="t" style={{ width: "14%" }}>Slot</th>
              <th scope="col" className="n key edge" style={{ width: "15%" }}>Champion</th>
              <th scope="col" className="n" style={{ width: "13%" }}>Playoff field</th>
              <th scope="col" className="n" style={{ width: "13%" }}>Edge</th>
              <th scope="col" className="t" style={{ width: "27%" }}>Champion vs field</th>
              <th scope="col" className="n edge hm" style={{ width: "18%" }}>{league.name}</th>
            </tr>
          </thead>
          <tbody>
            {b.slots.map((s, i) => {
              const c = s.champ.v, f = s.field.v;
              const edge = c != null && f != null ? c - f : null;
              const ratio = c != null && f && f > 0 ? c / f : null;
              const ourV = oursMean?.get(s.slot);
              return (
                <tr key={s.slot} className={i % 2 ? "zebra" : ""}>
                  <td className="t name">{s.slot}</td>
                  <td className="n edge"><Fig f={s.champ} as="num" /></td>
                  <td className="n"><Fig f={s.field} as="num" /></td>
                  <td className="n fig strong" style={{ color: "var(--good)" }}>
                    {edge == null ? "—" : sgn(edge, 2)}
                  </td>
                  <td className="t">
                    <div className="meter-row">
                      <div className="meter">
                        <div className="track grow">
                          <div className="fill" style={{ width: `${Math.min(100, ((ratio ?? 1) - 1) * 140)}%` }} />
                        </div>
                      </div>
                      <span className="fig val sm">{ratio ? `${fmt(ratio, 2)}x` : "—"}</span>
                    </div>
                  </td>
                  <td className="n fig hm last">{ourV == null ? "—" : fmt(ourV, 2)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TScroll>
      <div className="tnote screen">
        Edge is champion minus playoff field in WAR; the bar shows the same as a multiple. The field is the other teams in that season’s bracket — the ones the title team actually had to beat — and excludes the champion itself. The
        {" "}{league.name} column averages this league's own title teams, so a single season
        moves it — read it as a comparison, not a benchmark.
      </div>

      {/* ---- drafted vs acquired, by league year ---- */}
      <div className="band">
        <span className="band-label">Drafted vs acquired · by league year</span>
        <span className="band-note">
          Share of the roster the manager drafted himself · year 1 is a league's founding
          season, so a startup draft starts everyone near 100%
        </span>
      </div>
      <TScroll>
        <table style={{ tableLayout: "fixed" }}>
          <thead>
            <tr>
              <th scope="col" className="t" style={{ width: "16%" }}>League year</th>
              <th scope="col" className="n" style={{ width: "20%" }}>League-seasons</th>
              <th scope="col" className="n key edge" style={{ width: "20%" }}>Champion drafted</th>
              <th scope="col" className="n" style={{ width: "20%" }}>Playoff field drafted</th>
              <th scope="col" className="n" style={{ width: "24%" }}>Difference</th>
            </tr>
          </thead>
          <tbody>
            {years.map((y, i) => {
              const d = y.champ.v != null && y.field.v != null ? y.champ.v - y.field.v : null;
              return (
                <tr key={y.year} className={i % 2 ? "zebra" : ""}>
                  <td className="t name">Year {y.year}</td>
                  <td className="n fig">{y.league_seasons.toLocaleString("en-US")}</td>
                  <td className="n edge"><Fig f={y.champ} /></td>
                  <td className="n"><Fig f={y.field} /></td>
                  <td className="n fig strong last" style={{
                    color: d == null ? "var(--dim3)" : d > 0 ? "var(--good)" : "var(--bad)",
                  }}>
                    {d == null ? "—" : `${d > 0 ? "+" : "−"}${Math.abs(Math.round(d * 100))}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TScroll>

      {/* ---- picks and playoffs, side by side ---- */}
      <div className="feeds" style={{ padding: "18px var(--pad) 0" }}>
        <div className="feed-panel">
          <div className="band" style={{ borderTop: "none" }}>
            <span className="band-label">Champions and draft capital</span>
            <span className="band-note">Measured at the end of the title season</span>
          </div>
          <table style={{ tableLayout: "fixed" }}>
            <tbody>
              {[
                ["Traded away their own 1st", <Fig key="a" f={b.picks.traded_own_1st} />],
                ["Kept their own 1st", <Fig key="b" f={b.picks.kept_own_1st} />],
                ["Were net buyers of picks", <Fig key="c" f={b.picks.bought} />],
                ["Were net sellers of picks", <Fig key="d" f={b.picks.sold} />],
                ["1sts held — champion", <Fig key="e" f={b.picks.r1_held.champ} as="num" />],
                ["1sts held — playoff field", <Fig key="f" f={b.picks.r1_held.field} as="num" />],
              ].map(([label, node], i) => (
                <tr key={String(label)} className={i % 2 ? "zebra" : ""}>
                  <td className="t">{label as string}</td>
                  <td className="n last" style={{ width: "26%" }}>{node}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="feed-panel">
          <div className="band" style={{ borderTop: "none" }}>
            <span className="band-label">Playoff persistence</span>
            <span className="band-note">Season to season, across every crawled league</span>
          </div>
          <table style={{ tableLayout: "fixed" }}>
            <tbody>
              {[
                ["Playoff teams that returned", <Fig key="a" f={b.playoffs.stayed} />],
                ["Missed, then made it", <Fig key="b" f={b.playoffs.climbed} />],
                ["Climbers' drafted share", <Fig key="c" f={b.playoffs.climber_homegrown} />],
                ["Teams that stayed out", <Fig key="d" f={b.playoffs.stuck_homegrown} />],
              ].map(([label, node], i) => (
                <tr key={String(label)} className={i % 2 ? "zebra" : ""}>
                  <td className="t">{label as string}</td>
                  <td className="n last" style={{ width: "26%" }}>{node}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="tnote" style={{ padding: "8px 10px 10px" }}>
            A climber's drafted share against a team that stayed out is the closest this
            answers "trades or draft hits" — it separates drafted from acquired, not
            trades from waivers.
          </div>
        </div>
      </div>

      {/* ---- turnaround ---- */}
      <div className="band" style={{ marginTop: 18 }}>
        <span className="band-label">Coming back from the bottom third</span>
        <span className="band-note">
          Rates count only finishes that HAD the seasons ahead of them —
          {" "}{b.turnaround.no_room.toLocaleString("en-US")} of
          {" "}{b.turnaround.bottom_finishes.toLocaleString("en-US")} were a league's newest
          season and could not recover even in principle
        </span>
      </div>
      <TScroll>
        <table style={{ tableLayout: "fixed" }}>
          <thead>
            <tr>
              <th scope="col" className="t" style={{ width: "20%" }}>Within</th>
              <th scope="col" className="n" style={{ width: "24%" }}>Finishes with room</th>
              <th scope="col" className="n key edge" style={{ width: "28%" }}>Won a title</th>
              <th scope="col" className="n" style={{ width: "28%" }}>Reached the top third</th>
            </tr>
          </thead>
          <tbody>
            {b.turnaround.within.map((w, i) => (
              <tr key={w.years} className={i % 2 ? "zebra" : ""}>
                <td className="t name">{w.years} {w.years === 1 ? "year" : "years"}</td>
                <td className="n fig">{w.title.n.toLocaleString("en-US")}</td>
                <td className="n edge"><Fig f={w.title} /></td>
                <td className="n last"><Fig f={w.top_third} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </TScroll>

      <div className="footnote">
        Benchmarks from {m.league_seasons.toLocaleString("en-US")} crawled league-seasons ·
        every figure carries its sample on hover · a dash means fewer than {m.min_n}
        {" "}observations, never zero
      </div>
    </>
  );
}
