import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type {
  Franchises, PickValues, PicksOwned, ProjectionsFile, Team,
  Trade, TradesPayload,
} from "../lib/types";
import { j, jl, jDaily, jlDaily } from "../lib/data";
import { fmt, sgn } from "../lib/stats";
import { useLeague, useLeaguePath } from "../lib/context";
import { computePostures } from "../lib/rosterModel";
import { DEFAULT_LINEUP, optimalLineup } from "../lib/league";
import { readTrades, tradeWhen } from "../components/TradeCard";
import { PlayerLink } from "../components/PlayerLink";
import PosBadge from "../components/PosBadge";

const ord = (n: number) => {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

/**
 * A traded asset as one line: what changed hands, then what it became.
 *
 * Trade labels arrive as "<asset> → <resolution>", e.g. "2024 2nd → Roman
 * Wilson". The head is the trade; the tail is only how it turned out later, and
 * printing the tail alone describes a deal nobody made. Parenthesising the tail
 * matches how an unresolved pick already reads — "2028 4th (not yet drafted)" —
 * so both forms are "the asset, then a note about it".
 */
const assetLabel = (label: string) => {
  const [head, tail] = label.split(" → ");
  return tail ? `${head} (${tail})` : head;
};
const RECENT_TRADES = 5;
const MOVERS = 5;
const RECENT_MOVES = 5;
/** the window the movers list reports; matches the player page's mid window */
const MOVER_DAYS = 14;

interface Col {
  key: string; label: string; cls: string;
  val: (r: Row) => number | string;
  /** sort as a string rather than a number */
  text?: boolean;
}

interface Row {
  rid: number; name: string; manager: string;
  finish: number | null; record: string; lastSeason: string | null;
  war: number;
  /** WAR per season actually played, oldest first */
  hist: { season: string; war: number }[];
  age: number | null;
  /** best finish across every season played, and when it happened */
  best: number | null; bestSeason: string | null;
  /** every season the franchise has played */
  allW: number; allL: number; allT: number; winPct: number;
  titles: number;
}

/**
 * Per-season WAR bars, on one scale shared by every franchise — BOTH axes.
 *
 * Vertical: a single league-wide max, so a taller bar always means a better
 * season no matter whose row it is on.
 *
 * Horizontal: a fixed season axis, passed in rather than derived per row. Every
 * franchise renders the same seasons at the same x positions, so column three
 * is the same year on all twelve rows and bar widths never differ. Deriving the
 * axis per row happens to look right while everyone has played the same years
 * and silently breaks the moment one has not — a franchise that joined a season
 * late would draw wider bars against different years, directly under a row it
 * appears to line up with.
 *
 * The baseline sits at the bottom unless some franchise has actually posted a
 * negative season. A season's lineup WAR is a sum over ~14 weeks of starters and
 * in practice never goes below zero — all 48 played seasons here run 0.04 to
 * 9.28 — so centring on zero the way the weekly chart does would spend half the
 * height on a region nothing can reach. The zero floor is kept honest: bars are
 * not truncated to exaggerate differences, they just use the whole box.
 */
function SeasonWar({ hist, axis, max, min }: {
  hist: { season: string; war: number }[];
  axis: string[]; max: number; min: number;
}) {
  const W = 108, H = 34, PAD = 2;
  const signed = min < 0;
  const zero = signed ? H * (max / (max - min)) : H;      // y of the baseline
  const span = signed ? H : H - PAD;
  const step = W / Math.max(1, axis.length);
  const bw = Math.min(14, Math.max(4, step - 4));
  const byS = new Map(hist.map(h => [h.season, h.war]));
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}
      style={{ overflow: "visible", verticalAlign: "middle" }}>
      <title>{axis.map(sn => `${sn}: ${byS.has(sn) ? fmt(byS.get(sn)!, 2) : "—"}`).join("\n")}</title>
      <line x1={0} y1={zero} x2={W} y2={zero} stroke="#2b3642" strokeWidth={1} />
      {axis.map((sn, i) => {
        const v = byS.get(sn);
        if (v == null) return null;                       // no season: leave the slot empty
        const frac = Math.abs(v) / (signed ? Math.max(max, -min) : max);
        const bh = Math.max(1, frac * (signed ? span / 2 : span));
        return <rect key={sn} x={(i * step + (step - bw) / 2).toFixed(1)}
          y={(v >= 0 ? zero - bh : zero).toFixed(1)} width={bw} height={bh.toFixed(1)}
          fill={v >= 0 ? "var(--acc)" : "var(--bad)"} />;
      })}
    </svg>
  );
}

export default function Home() {
  const { meta, league } = useLeague();
  const nav = useNavigate();
  const lp = useLeaguePath();
  const [fr, setFr] = useState<Franchises | null>(null);
  const [proj, setProj] = useState<ProjectionsFile | null>(null);
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [pv, setPv] = useState<PickValues | null>(null);
  const [owned, setOwned] = useState<PicksOwned | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [hist, setHist] = useState<Record<string, [string, number, number][]> | null>(null);
  const [sortKey, setSortKey] = useState("war");
  const [dir, setDir] = useState<1 | -1>(1);

  useEffect(() => {
    let live = true;
    const set = <T,>(f: (v: T) => void) => (v: T) => { if (live) f(v); };
    jl<Franchises>("franchises.json").then(set(setFr)).catch(() => {});
    jl<ProjectionsFile>("projections.json").then(p => {
      if (!live) return;
      setProj(p);
      jl<Team[]>(`${p.meta.roster_season}/teams.json`).then(set(setTeams)).catch(() => {});
    }).catch(() => {});
    jlDaily<PickValues>("pick_values.json").then(set(setPv)).catch(() => {});
    jl<PicksOwned>("picks_owned.json").then(set(setOwned)).catch(() => {});
    jl<TradesPayload>("trades.json")
      .then(p => { if (live) setTrades(readTrades(p).trades); }).catch(() => {});
    j<Record<string, [string, number, number][]>>("data/values_history.json")
      .then(set(setHist)).catch(() => {});
    return () => { live = false; };
  }, []);

  /** the franchise board — one row per franchise */
  const rows = useMemo<Row[] | null>(() => {
    if (!fr || !proj || !teams) return null;
    const season = String(proj.meta.roster_season);
    const lineup = meta.rosterPositions?.length ? meta.rosterPositions : DEFAULT_LINEUP;

    // Postures are used ONLY for the WAR-weighted lineup age now that the
    // window column is gone. They need pick_values + picks_owned, so the board
    // renders without them and simply shows no age until they land.
    const postures = pv
      ? computePostures(proj.players, teams, pv, owned, +season)
      : [];
    const warOf = new Map(postures.map(p => [p.rid, p]));

    const byPid = new Map(proj.players.map(p => [p.pid, p]));
    // Projected WAR = what this roster's best legal lineup produces in the
    // roster season. Deliberately NOT posture.s[0], which also folds in owned
    // picks' expected production — that answers "how strong is the franchise",
    // a different question from "how good is the team you can field".
    const projWar = new Map(teams.map(t => {
      const pool = t.players.map(pid => byPid.get(pid)).filter(Boolean)
        .map(p => ({ id: p!.pid, pos: p!.pos, war: Math.max(0, p!.composite?.[0] ?? 0) }));
      const { slots } = optimalLineup(pool, lineup);
      return [t.roster_id, slots.reduce((a, sl) => a + (sl.player?.war ?? 0), 0)];
    }));
    // the last completed season is what "finish" means — not the roster season,
    // which in the offseason has no games and every team at 0-0
    const done = league.latest;
    return teams.map(t => {
      const rid = t.roster_id;
      const f = fr[String(rid)];
      const cur = f?.seasons.find(s => s.season === season) ?? f?.seasons[f.seasons.length - 1];
      const last = f?.seasons.find(s => s.season === done);
      const p = warOf.get(rid);
      // all-time is every season on record, including the unplayed current one
      // (0-0, so it costs nothing and keeps the column honest as games land)
      const all = (f?.seasons ?? []).reduce(
        (a, sn) => ({ w: a.w + sn.wins, l: a.l + sn.losses, t: a.t + (sn.ties || 0) }),
        { w: 0, l: 0, t: 0 });
      const games = all.w + all.l + all.t;
      // best finish, and the most recent season it was achieved — a franchise
      // that has won twice should read as its latest title, not its first
      const bestSn = (f?.seasons ?? []).filter(sn => sn.finish != null)
        .reduce<typeof f.seasons[number] | null>(
          (b, sn) => !b || sn.finish! < b.finish! || (sn.finish === b.finish && sn.season > b.season)
            ? sn : b, null);
      const best = bestSn?.finish ?? null;
      return {
        rid, name: cur?.name ?? t.team, manager: cur?.manager ?? t.manager,
        finish: last?.finish ?? null,
        record: last ? `${last.wins}-${last.losses}${last.ties ? `-${last.ties}` : ""}` : "—",
        lastSeason: last?.season ?? done ?? null,
        war: projWar.get(rid) ?? 0,
        // played seasons only — an unplayed season sits at 0.0 WAR and would
        // draw as a collapsed bar, reading as a bad year rather than no year
        hist: (f?.seasons ?? [])
          .filter(sn => sn.wins + sn.losses > 0)
          .map(sn => ({ season: sn.season, war: sn.war })),
        age: p?.age ?? null,
        best, bestSeason: bestSn?.season ?? null,
        allW: all.w, allL: all.l, allT: all.t,
        winPct: games ? (all.w + all.t / 2) / games : 0,
        titles: (f?.seasons ?? []).filter(sn => sn.finish === 1).length,
      };
    }).sort((a, b) => b.war - a.war);
  }, [fr, proj, teams, pv, owned, meta, league]);

  /** biggest market moves over the window, per source.
   *  values_history rows are [date, ktc, fc] — index 1 is KeepTradeCut, 2 is
   *  FantasyCalc, and the two disagree often enough to be worth both. */
  const movers = useMemo(() => {
    if (!hist || !teams) return null;
    const owner = new Map<string, string>();
    for (const t of teams) for (const pid of t.players) owner.set(pid, t.team);
    const forCol = (col: 1 | 2) => {
      const out: { pid: string; d: number; now: number; team: string }[] = [];
      for (const [pid, rows] of Object.entries(hist)) {
        if (!owner.has(pid) || rows.length < 2) continue;
        const now = rows[rows.length - 1];
        // walk back to the first snapshot at least MOVER_DAYS old; short history
        // just uses the oldest there is rather than dropping the player
        const cutoff = Date.parse(now[0]) - MOVER_DAYS * 864e5;
        let prev = rows[0];
        for (const r of rows) { if (Date.parse(r[0]) <= cutoff) prev = r; }
        const a = now[col], b = prev[col];
        if (!a || !b || a === b) continue;
        out.push({ pid, d: a - b, now: a, team: owner.get(pid)! });
      }
      out.sort((x, y) => y.d - x.d);
      return { up: out.slice(0, MOVERS), down: out.slice(-MOVERS).reverse() };
    };
    return { ktc: forCol(1), fc: forCol(2) };
  }, [hist, teams]);

  /** last few waiver / free-agent moves across the league */
  const waivers = useMemo(() => {
    if (!fr) return [];
    return Object.entries(fr).flatMap(([rid, f]) =>
      f.tx.filter(t => t.type !== "trade").map(t => ({ ...t, rid: +rid, team: f.seasons[f.seasons.length - 1].name })))
      .sort((a, b) => b.ts - a.ts).slice(0, RECENT_MOVES);
  }, [fr]);

  const recent = useMemo(
    () => trades.slice().sort((a, b) => b.ts - a.ts).slice(0, RECENT_TRADES),
    [trades]);

  // one scale for every sparkline, so bar heights compare across franchises
  const warMax = useMemo(
    () => Math.max(1, ...(rows ?? []).flatMap(r => r.hist.map(h => h.war))), [rows]);
  const warMin = useMemo(
    () => Math.min(0, ...(rows ?? []).flatMap(r => r.hist.map(h => h.war))), [rows]);
  // the season axis every row draws against — union across franchises, so a
  // team that missed a year leaves a gap instead of shifting its neighbours
  const warAxis = useMemo(() => [...new Set((rows ?? [])
    .flatMap(r => r.hist.map(h => h.season)))].sort(), [rows]);

  const champ = rows?.find(r => r.finish === 1);
  // One spec per column: label, alignment, and the value to sort on. Sorting
  // falls out of the spec instead of every column needing its own case. There
  // are no rank columns — with twelve rows, sorting a column IS the ranking.
  const cols = useMemo<Col[]>(() => [
    { key: "name", label: "Franchise", cls: "t", val: r => r.name, text: true },
    { key: "war", label: "WAR by season", cls: "n",
      val: r => r.hist.length ? r.hist[r.hist.length - 1].war : 0 },
    { key: "age", label: "Age", cls: "n hm", val: r => r.age ?? 99 },
    { key: "finish", label: "Last year", cls: "n", val: r => -(r.finish ?? 99) },
    { key: "best", label: "Best", cls: "n", val: r => -(r.best ?? 99) },
    { key: "alltime", label: "All-time", cls: "n hm", val: r => r.winPct },
    { key: "titles", label: "Titles", cls: "n", val: r => r.titles },
  ], []);

  const sorted = useMemo(() => {
    if (!rows) return null;
    const c = cols.find(x => x.key === sortKey) ?? cols[2];
    return rows.slice().sort((a, b) => c.text
      ? String(c.val(a)).localeCompare(String(c.val(b))) * -dir
      : ((c.val(b) as number) - (c.val(a) as number)) * dir);
  }, [rows, cols, sortKey, dir]);

  const clickCol = (k: string) => {
    if (sortKey === k) setDir(d => (-d) as 1 | -1);
    else { setSortKey(k); setDir(1); }
  };

  return (
    <>
      <div className="screen-head">
        <span className="screen-title">{league.name}</span>
        <span className="screen-note">
          {league.seasons.length} seasons · {league.rosterSeason} rosters
          {champ && <> · {league.latest} champion <b>{champ.name}</b></>}
        </span>
      </div>

      {/* ---- activity: what has happened lately ---- */}
      <div className="dwrap">
        <div className="dhead">
          <div className="chart-label" style={{ marginBottom: 0 }}>Activity</div>
          <button type="button" className="dtoggle" onClick={() => nav(lp("/trades"))}>
            All trades
          </button>
        </div>
        <div className="feeds">
          <div className="feed-panel">
            <div className="pick-title">Recent trades</div>
            <table className="feed">
              <tbody>
                {recent.length === 0 && <tr><td className="sub">No trades yet.</td></tr>}
                {recent.map(t => (
                  <tr key={t.ts}>
                    <td className="t">
                      {t.sides.map((sd, k) => (
                        <div key={sd.rid} className="line">
                          <span className={k ? "arrow alt" : "arrow"}>{k ? "◄" : "►"}</span>
                          <span className="nm">{sd.team}</span>
                          <span className="by">
                            {sd.got.map(a => assetLabel(a.label)).join(" · ") || "—"}
                          </span>
                        </div>
                      ))}
                    </td>
                    <td className="n sub">{tradeWhen(t.ts)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="feed-panel">
            <div className="pick-title">Recent waivers</div>
            <table className="feed">
              <tbody>
                {waivers.length === 0 && <tr><td className="sub">No moves yet.</td></tr>}
                {waivers.map((w, i) => (
                  <tr key={`${w.ts}${i}`}>
                    <td className="t">
                      <div className="nm">{w.team}</div>
                      <div className="by">
                        {w.adds?.length ? <span className="add">+ {w.adds.join(", ")}</span> : null}
                        {w.adds?.length && w.drops?.length ? " · " : null}
                        {w.drops?.length ? <span className="drop">− {w.drops.join(", ")}</span> : null}
                      </div>
                    </td>
                    <td className="n sub">{tradeWhen(w.ts)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* ---- market movers, both sources ---- */}
      {movers && (
        <div className="dwrap">
          <div className="dhead">
            <div className="chart-label" style={{ marginBottom: 0 }}>
              Market movers · {MOVER_DAYS} days
            </div>
          </div>
          <div className="feeds">
            {([["KeepTradeCut", movers.ktc], ["FantasyCalc", movers.fc]] as const).map(([src, m]) => (
              <div key={src} className="feed-panel">
                <div className="pick-title">{src}</div>
                <table className="feed">
                  {/* Rising and falling are two labelled groups rather than one
                      list with a hairline — a reader shouldn't have to infer
                      where the sign flips by scanning the numbers. */}
                  {([["Rising", "best", m.up], ["Falling", "worst", m.down]] as const)
                    .map(([label, cls, list]) => (
                      <tbody key={label}>
                        <tr className="grp">
                          <th className={`t ${cls}`} colSpan={3}>{label}</th>
                        </tr>
                        {list.length === 0 && (
                          <tr><td className="sub" colSpan={3}>No moves.</td></tr>
                        )}
                        {list.map(mv => {
                          const pl = proj?.players.find(x => x.pid === mv.pid);
                          return (
                            <tr key={`${src}${label}${mv.pid}`}>
                              <td className="who">
                                <div className="line">
                                  {pl && <PosBadge pos={pl.pos} />}
                                  <PlayerLink pid={mv.pid} name={pl?.name ?? mv.pid} />
                                </div>
                                <div className="by">{mv.team}</div>
                              </td>
                              <td className="n sub">{fmt(mv.now, 0)}</td>
                              <td className="n vs"
                                style={{ color: mv.d >= 0 ? "var(--good)" : "var(--bad)" }}>
                                {sgn(mv.d, 0)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    ))}
                </table>
              </div>
            ))}
          </div>
          <div className="tnote">
            Value change over the last {MOVER_DAYS} days, rostered players only. The two
            markets are priced independently and often disagree.
          </div>
        </div>
      )}

      {/* ---- franchise board ---- */}
      <div className="dwrap">
        <div className="dhead">
          <div className="chart-label" style={{ marginBottom: 0 }}>The league</div>
        </div>
        {!sorted ? <div className="empty">Loading league…</div> : (
          <div className="dscroll">
            <table className="wide homeboard">
              <thead>
                <tr>
                  {cols.map(c => (
                    <th key={c.key}
                      className={[c.cls, "sortable", sortKey === c.key ? "sorted" : ""]
                        .filter(Boolean).join(" ")}
                      onClick={() => clickCol(c.key)}>
                      {c.label}{sortKey === c.key ? (dir > 0 ? " ▼" : " ▲") : ""}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map((r, i) => (
                  <tr key={r.rid} className={`click ${i % 2 ? "zebra" : ""}`}
                    onClick={() => nav(lp(`/teams/${league.rosterSeason}/${r.rid}`))}>
                    <td className="t">
                      <div className="nm">{r.name}</div>
                      <div className="by">{r.manager}</div>
                    </td>
                    <td className="n">
                      <SeasonWar hist={r.hist} axis={warAxis} max={warMax} min={warMin} />
                    </td>
                    <td className="n hm sub">{r.age == null ? "—" : fmt(r.age, 1)}</td>
                    <td className="n">
                      {r.finish ? <span className={r.finish === 1 ? "fin champ" : "fin"}>
                        {ord(r.finish)}
                      </span> : "—"}
                      <div className="by">{r.record}</div>
                    </td>
                    <td className="n">
                      {r.best ? <span className={r.best === 1 ? "fin champ" : "fin"}>
                        {ord(r.best)}
                      </span> : <span className="sub">—</span>}
                      <div className="by">{r.bestSeason ?? ""}</div>
                    </td>
                    <td className="n hm">
                      <b>{r.allW}-{r.allL}{r.allT ? `-${r.allT}` : ""}</b>
                      <div className="by">{fmt(r.winPct * 100, 0)}%</div>
                    </td>
                    <td className="n">
                      {r.titles ? <span className="titles">
                        {"🏆".repeat(Math.min(r.titles, 3))}{r.titles > 3 ? ` ×${r.titles}` : ""}
                      </span> : <span className="sub">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="tnote">
          WAR bars are each season's lineup WAR from zero — same vertical scale and
          same season columns for every franchise, oldest first ({warAxis[0]}–
          {warAxis[warAxis.length - 1]}); sorting uses the most recent. DVI is total dynasty value across the
          current roster, drawn against the league leader. Last year is {league.latest};
          all-time, best finish and titles span every season the franchise has played.
          Click any column to sort.
        </div>
      </div>

    </>
  );
}
