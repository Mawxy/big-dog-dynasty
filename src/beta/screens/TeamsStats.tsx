import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type { Franchises, Matchups, Team, Weekly } from "../../lib/types";
import { indexKey, jl } from "../../lib/data";
import { useJson } from "../../lib/useJson";
import { useSettledSeasons } from "../../lib/caps";
import { fmt, mean, ord, sd } from "../../lib/stats";
import { REG_WEEKS } from "../../lib/league";
import { useMobile } from "../../lib/useWidth";
import {
  Band, DataError, fmtWar, IdCell, LensStrip, NUL, sgnWar, Spine, sortBy, TapRow, Th,
  useBetaPath, useSort,
} from "../ui";
import { ALL_SEASONS } from "../Scope";

/**
 * TEAMS · STATS — what each franchise actually did (Max, 2026-09-28).
 *
 * The Value tense prices the rosters; this is the other half the Players
 * board has always had and Teams did not: one row per franchise, in one
 * season or pooled over every one, in figures that happened. It is the
 * classic board's Standings and All-time tables brought over and set in the
 * Players board's grammar — the same scope control, the same sortable header,
 * sort strip, micro line and row drawer.
 *
 * REGULAR SEASON ONLY, like every WAR on the site and like the classic
 * table: a bracket game is a selection effect (only good teams play week 16)
 * and the pipeline scores no playoff WAR for lineups.
 *
 * ACCRUED WAR is the headline figure: the WAR the franchise's actual starters
 * banked, week by week, against the league-wide replacement level — what the
 * lineups it fielded were worth, in wins. It is the classic board's "Lineup
 * WAR", renamed for what it is mid-season: a running total, not a projection.
 * Its twin in the drawer is the WAR left on the bench — the same measure over
 * the players rostered and not started.
 *
 * Every figure is read off three season files — teams.json for names,
 * matchups.json for scores, lineups and opponents, weekly.json for each
 * player-week's WAR — plus franchises.json for the finish and the titles, and
 * only for settled seasons (see lib/seasons#isSeasonSettled): a provisional
 * placing is not a finish.
 */

/* ---- one franchise-season ------------------------------------------------ */

interface WeekCell { wk: number; pts: number; opp: number | null; oppPts: number | null; res: "W" | "L" | "T" | null }

export interface TeamSeason {
  season: string;
  rid: number; fkey: string;
  team: string; manager: string;
  w: number; l: number; t: number;
  pf: number; pa: number;
  /** each regular-season week's score, for σ and the drawer */
  scores: number[];
  medW: number; medL: number; medT: number;
  war: number; bench: number;
  weeks: WeekCell[];
}

const cache = new Map<string, Promise<TeamSeason[]>>();

/** one season's franchise rows, cached per league and season */
function loadSeason(season: string): Promise<TeamSeason[]> {
  const ck = indexKey([season]);
  const hit = cache.get(ck);
  if (hit) return hit;
  const pending = (async () => {
    const [teams, mw, weekly] = await Promise.all([
      jl<Team[]>(`${season}/teams.json`),
      jl<Matchups>(`${season}/matchups.json`),
      jl<Weekly>(`${season}/weekly.json`).catch(() => ({} as Weekly)),
    ]);
    const ps = mw.playoff_start || 15;
    const war = new Map<string, number>();
    for (const [pid, rows] of Object.entries(weekly))
      for (const r of rows) war.set(`${pid}|${r[0]}`, r[5]);
    // each week's league median, over the teams that played it
    const byWk = new Map<number, number[]>();
    for (const list of Object.values(mw.teams))
      for (const e of list) if (e[0] < ps && e[3] != null) {
        const l = byWk.get(e[0]) ?? [];
        l.push(e[1]); byWk.set(e[0], l);
      }
    const med = new Map<number, number>();
    for (const [wk, l] of byWk) {
      const v = l.slice().sort((a, b) => a - b), n = v.length;
      med.set(wk, n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2);
    }
    return teams.map(t => {
      const ent = (mw.teams[String(t.roster_id)] ?? [])
        .filter(e => e[0] < ps && e[3] != null)
        .sort((a, b) => a[0] - b[0]);
      const r: TeamSeason = {
        season, rid: t.roster_id, fkey: t.fkey ?? String(t.roster_id),
        team: t.team, manager: t.manager,
        w: 0, l: 0, t: 0, pf: 0, pa: 0, scores: [],
        medW: 0, medL: 0, medT: 0, war: 0, bench: 0, weeks: [],
      };
      for (const e of ent) {
        const [wk, pts, opp, oppPts] = e;
        const res = pts > oppPts! ? "W" : pts < oppPts! ? "L" : "T";
        r[res === "W" ? "w" : res === "L" ? "l" : "t"]++;
        r.pf += pts; r.pa += oppPts!; r.scores.push(pts);
        const m = med.get(wk);
        if (m != null) { if (pts > m) r.medW++; else if (pts < m) r.medL++; else r.medT++; }
        const starters = (e[4] ?? []).filter(p => p && p !== "0");
        for (const p of starters) r.war += war.get(`${p}|${wk}`) ?? 0;
        for (const p of e[5] ?? []) if (p && p !== "0" && !starters.includes(p))
          r.bench += war.get(`${p}|${wk}`) ?? 0;
        r.weeks.push({ wk, pts, opp, oppPts, res });
      }
      return r;
    });
  })();
  cache.set(ck, pending);
  pending.catch(() => cache.delete(ck));
  return pending;
}

/* ---- the board's row --------------------------------------------------- */

type Key = "rec" | "fin" | "pct" | "titles" | "med" | "luck" | "pf" | "pa" | "ppg" | "sdv" | "war";

interface Col {
  id: Key; label: string; short?: string; width: string;
  /** smallest first on the first press (a finish) */
  asc?: boolean;
  grp: "res" | "score" | "war";
}

const SEASON_COLS: Col[] = [
  { id: "rec", label: "Record", short: "W-L", width: "9%", grp: "res" },
  { id: "fin", label: "Finish", short: "Fin", width: "7%", asc: true, grp: "res" },
  { id: "med", label: "Vs median", short: "Vs med", width: "9%", grp: "res" },
  { id: "luck", label: "Luck", width: "6%", grp: "res" },
  { id: "pf", label: "PF", width: "8%", grp: "score" },
  { id: "pa", label: "PA", width: "8%", grp: "score" },
  { id: "ppg", label: "PPG", width: "7%", grp: "score" },
  { id: "sdv", label: "σ", width: "6%", grp: "score" },
  { id: "war", label: "Accrued WAR", short: "WAR", width: "11%", grp: "war" },
];
const ALL_COLS: Col[] = [
  { id: "rec", label: "Record", short: "W-L", width: "9%", grp: "res" },
  { id: "pct", label: "Win %", short: "Win %", width: "7%", grp: "res" },
  { id: "titles", label: "Titles", width: "6%", grp: "res" },
  { id: "fin", label: "Best", width: "7%", asc: true, grp: "res" },
  { id: "luck", label: "Luck", width: "6%", grp: "res" },
  { id: "pf", label: "PF", width: "9%", grp: "score" },
  { id: "ppg", label: "PPG", width: "7%", grp: "score" },
  { id: "sdv", label: "σ", width: "6%", grp: "score" },
  { id: "war", label: "Accrued WAR", short: "WAR", width: "11%", grp: "war" },
];
const GRP_LABEL = { res: "Results", score: "Scoring", war: "WAR" } as const;

const DEF: Record<Key, string> = {
  rec: "Regular-season wins, losses and ties. Sorts by wins (a tie is half of one), then points for.",
  fin: "Where the season ended — the bracket's placing, then the standings' for everyone else. Settled seasons only; all-time, the best one.",
  pct: "Wins over games, a tie counting half.",
  titles: "Championships won.",
  med: "The record against each week's league median score — what the team would have gone playing all twelve every week.",
  luck: "Actual wins minus median wins. Positive won more than the scores earned.",
  pf: "Points for, regular season.",
  pa: "Points against, regular season.",
  ppg: "Points per game.",
  sdv: "Week-to-week standard deviation of the team's score. Lower is steadier.",
  war: "The WAR the lineups actually fielded banked, summed week by week — each starter's points against his position's replacement level, turned into wins. A running total while the season is on.",
};

interface Row {
  rid: number; fkey: string; team: string; manager: string;
  /** the seasons behind the row: one, or every one the franchise played */
  parts: TeamSeason[];
  w: number; l: number; t: number; pf: number; pa: number;
  f: Partial<Record<Key, number | null>>;
  text: Partial<Record<Key, string>>;
  best: { fin: number; season: string } | null;
  titles: number;
  war: number; bench: number; games: number;
}

const wlStr = (w: number, l: number, t: number) => `${w}-${l}${t ? `-${t}` : ""}`;

function rowOf(parts: TeamSeason[], fin: (s: TeamSeason) => number | null, allTime: boolean): Row {
  const last = parts[parts.length - 1];
  const sum = (k: "w" | "l" | "t" | "pf" | "pa" | "medW" | "medL" | "medT" | "war" | "bench") =>
    parts.reduce((a, p) => a + p[k], 0);
  const w = sum("w"), l = sum("l"), t = sum("t");
  const pf = sum("pf"), pa = sum("pa");
  const games = w + l + t;
  const scores = parts.flatMap(p => p.scores);
  const medW = sum("medW"), medL = sum("medL"), medT = sum("medT");
  const finishes = parts.map(p => ({ fin: fin(p), season: p.season }))
    .filter((x): x is { fin: number; season: string } => x.fin != null);
  const best = finishes.reduce<Row["best"]>(
    (b, x) => (!b || x.fin < b.fin || (x.fin === b.fin && x.season > b.season) ? x : b), null);
  const titles = finishes.filter(x => x.fin === 1).length;
  const war = sum("war"), bench = sum("bench");
  return {
    rid: last.rid, fkey: last.fkey, team: last.team, manager: last.manager,
    parts, w, l, t, pf, pa, best, titles, war, bench, games,
    f: {
      rec: games ? (w + t / 2) * 1e6 + pf : null,
      fin: allTime ? best?.fin ?? null : fin(last),
      pct: games ? (w + t / 2) / games : null,
      titles: allTime ? titles : null,
      med: games ? (medW + medT / 2) * 1e6 + pf : null,
      luck: games ? w - medW : null,
      pf: games ? pf : null,
      pa: games ? pa : null,
      ppg: games ? pf / games : null,
      sdv: scores.length > 1 ? sd(scores) : null,
      war: games ? war : null,
    },
    text: {
      rec: games ? wlStr(w, l, t) : undefined,
      med: games ? wlStr(medW, medL, medT) : undefined,
    },
  };
}

const FMT: Record<Key, (v: number, r: Row) => ReactNode> = {
  rec: (_v, r) => r.text.rec ?? NUL,
  fin: v => ord(v),
  pct: v => `${fmt(v * 100, 1)}%`,
  titles: v => (v ? String(v) : NUL),
  med: (_v, r) => r.text.med ?? NUL,
  luck: v => (v > 0 ? `+${v}` : v < 0 ? `−${-v}` : "0"),
  pf: v => fmt(v, 1),
  pa: v => fmt(v, 1),
  ppg: v => fmt(v, 1),
  sdv: v => fmt(v, 1),
  war: v => fmtWar(v),
};
const cellOf = (k: Key, r: Row): ReactNode => {
  const v = r.f[k];
  if (v == null) return NUL;
  const out = FMT[k](v, r);
  if (k === "luck") return <span className={v > 0 ? "tmx-pos" : v < 0 ? "tmx-neg" : ""}>{out}</span>;
  if ((k === "fin" && v === 1) || (k === "titles" && v > 0)) return <span className="tmx-acc">{out}</span>;
  return out;
};

/* ======================================================================== */

export default function TeamsStats({ season, played }: {
  /** a season, or ALL_SEASONS */
  season: string;
  /** every season the league has, newest first */
  played: string[];
}) {
  const betaPath = useBetaPath();
  const mobile = useMobile("(max-width: 899px)");
  const allTime = season === ALL_SEASONS;
  const seasons = useMemo(() => (allTime ? played : [season]), [allTime, played, season]);
  const settled = useSettledSeasons();
  const fr = useJson<Franchises>("franchises.json").data;

  const [data, setData] = useState<TeamSeason[][] | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let live = true;
    setData(null); setErr(false);
    Promise.all(seasons.map(s => loadSeason(s).catch(() => null)))
      .then(d => {
        if (!live) return;
        const got = d.filter((x): x is TeamSeason[] => x != null);
        if (!got.length) setErr(true); else setData(got);
      });
    return () => { live = false; };
  }, [seasons]);

  /** a franchise-season's finish, settled seasons only */
  const finOf = useMemo(() => (s: TeamSeason): number | null => {
    if (!fr || !settled.isSettled(s.season)) return null;
    return fr[s.fkey]?.seasons.find(x => x.season === s.season)?.finish ?? null;
  }, [fr, settled]);

  const rows = useMemo<Row[] | null>(() => {
    if (!data) return null;
    const by = new Map<string, TeamSeason[]>();
    for (const list of data) for (const t of list) {
      const l = by.get(t.fkey) ?? [];
      l.push(t); by.set(t.fkey, l);
    }
    return [...by.values()].map(parts =>
      rowOf(parts.sort((a, b) => a.season.localeCompare(b.season)), finOf, allTime));
  }, [data, finOf, allTime]);

  /** season|rid -> the franchise's name that season, for the drawer's opponents */
  const names = useMemo(() => new Map(
    (data ?? []).flat().map(t => [`${t.season}|${t.rid}`, t.team] as const)), [data]);
  const cols = allTime ? ALL_COLS : SEASON_COLS;
  const groups = (["res", "score", "war"] as const)
    .map(g => ({ id: g, label: GRP_LABEL[g], span: cols.filter(c => c.grp === g).length }));
  const s = useSort<Key>("rec", -1, "tmx:sort.stats");
  useEffect(() => {
    if (!cols.some(c => c.id === s.sort)) s.onSort("rec");
  }, [cols, s]);
  const col = (id: Key) => cols.find(c => c.id === id) ?? cols[0];

  const ordered = useMemo(() => (rows ? sortBy(rows, r => r.f[s.sort] ?? null, s.dir) : null),
    [rows, s.sort, s.dir]);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { setOpen(null); }, [season]);

  const anyGames = !!rows?.some(r => r.games > 0);
  const micro: Key[] = (["ppg", "war", "rec"] as Key[]).filter(k => k !== s.sort).slice(0, 2);
  const span = mobile ? 3 : 2 + cols.length;
  const [keyOpen, setKeyOpen] = useState(false);

  return (
    <>
      {mobile && (
        <div className="plx-sort">
          <button type="button" className="plx-dir" aria-label={s.dir === -1 ? "Most first" : "Least first"}
            onClick={() => s.onSort(s.sort)}>{s.dir === -1 ? "▾" : "▴"}</button>
          <LensStrip label="Sort" value={s.sort}
            onChange={k => { if (k !== s.sort) s.onSort(k, col(k).asc); }}
            options={cols.map(c => ({ id: c.id, label: c.short ?? c.label }))} />
        </div>
      )}
      <Band label={`${allTime ? "All-time" : season} · Regular season`}
        right={
          <span className="plx-bandr">
            <span className="band-note plx-hint">WAR is what the lineups fielded banked</span>
            <button type="button" className={`plx-keybtn${keyOpen ? " on" : ""}`}
              aria-expanded={keyOpen} onClick={() => setKeyOpen(v => !v)}>
              {keyOpen ? "Close" : "Key"}
            </button>
          </span>
        } />
      {keyOpen && (
        <dl className="plx-keylist">
          {cols.map(c => (
            <Fragment key={c.id}>
              <dt>{c.label}</dt>
              <dd>{DEF[c.id]}</dd>
            </Fragment>
          ))}
        </dl>
      )}
      {err ? <DataError what="The season didn't load" />
        : !ordered ? <div className="empty">Loading…</div>
        : !anyGames ? <div className="empty">No scored week in {season} yet — this fills in as the season is played.</div>
        : (
        <table className={`v3tbl plx-tbl tmx-stats ${allTime ? "tmx-all" : "tmx-season"}`}>
          {!mobile && (
            <thead>
              <tr className="plx-grp">
                <th className="sp" />
                <th className="t" />
                {groups.map(g => (
                  <th key={g.id} className="plx-edge" colSpan={g.span}>{g.label}</th>
                ))}
              </tr>
              <tr className="plx-cols">
                <th className="c sp">#</th>
                <th className="t">Franchise</th>
                {cols.map(c => (
                  <Th key={c.id} id={c.id} label={c.label} align="n" width={c.width}
                    asc={c.asc} sort={s.sort} onSort={s.onSort} />
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {ordered.map((r, i) => (
              <Fragment key={r.fkey}>
                <TapRow className={`${i % 2 ? "zebra" : ""}${open === r.fkey ? " plx-on" : ""}`}
                  onTap={() => setOpen(open === r.fkey ? null : r.fkey)}>
                  <Spine rank={i + 1} />
                  <IdCell name={r.team} to={betaPath(`/team/${r.rid}`)}
                    sub={allTime
                      ? `${r.manager} · ${r.parts.length} season${r.parts.length === 1 ? "" : "s"}`
                      : `${r.manager} · ${r.games} game${r.games === 1 ? "" : "s"}`} />
                  {mobile ? (
                    <td className="n plx-lead">
                      <span className="f hd">{cellOf(s.sort, r)}</span>
                      <div className="plx-micro">
                        {micro.map(k => (
                          <span key={k} className="o">
                            {(col(k).short ?? col(k).label).toUpperCase()}<b>{cellOf(k, r)}</b>
                          </span>
                        ))}
                      </div>
                    </td>
                  ) : cols.map((c, ci) => (
                    <td key={c.id} className={`n${ci === 0 || c.grp !== cols[ci - 1].grp ? " plx-edge" : ""}`}>
                      <span className={`f${c.id === s.sort ? " hd" : ""}`}>{cellOf(c.id, r)}</span>
                    </td>
                  ))}
                </TapRow>
                {open === r.fkey && (
                  <tr className="plx-drawrow">
                    <td colSpan={span}>
                      <Drawer r={r} allTime={allTime} to={betaPath(`/team/${r.rid}`)}
                        nameOf={rid => names.get(`${r.parts[r.parts.length - 1].season}|${rid}`) ?? `Team ${rid}`} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
      <div className="tnote screen">
        Regular season only. Accrued WAR sums, week by week, the WAR of the players each franchise actually
        started — the lineup as set, not the best one it could have fielded — so it rewards the roster and the
        manager's calls together; the drawer carries the WAR left on the bench beside it. Vs median is the record
        against each week's league median, and luck is the gap between that and the real one. A finish is printed
        only once its season is settled.
      </div>
    </>
  );
}

/* ---- the drawer ---------------------------------------------------------- */

function Fig({ k, v, sub }: { k: string; v: ReactNode; sub?: ReactNode }) {
  return (
    <div>
      <div className="k">{k}</div>
      <div className="v">{v}</div>
      {sub != null && <div className="s">{sub}</div>}
    </div>
  );
}

function Drawer({ r, allTime, to, nameOf }: {
  r: Row; allTime: boolean; to: string; nameOf: (rid: number) => string;
}) {
  const nav = useNavigate();
  const weeks = r.parts.flatMap(p => p.weeks.map(w => ({ ...w, season: p.season })));
  const best = weeks.reduce<(typeof weeks)[number] | null>((b, w) => (!b || w.pts > b.pts ? w : b), null);
  const worst = weeks.reduce<(typeof weeks)[number] | null>((b, w) => (!b || w.pts < b.pts ? w : b), null);
  const when = (w: { wk: number; season: string }) => (allTime ? `${w.season} week ${w.wk}` : `week ${w.wk}`);
  const one = !allTime ? r.parts[r.parts.length - 1] : null;
  const max = Math.max(1, ...(one?.weeks.map(w => w.pts) ?? [1]));
  return (
    <div className="plx-draw">
      <div className="hd">
        <span className="nm">{r.team}</span>
        <span className="mt">{r.manager} · {allTime ? `${r.parts.length} seasons` : `${one?.season} regular season`}</span>
      </div>
      <div className="plx-figs">
        <Fig k="Accrued WAR" v={r.games ? sgnWar(r.war) : NUL}
          sub={r.games ? `${fmtWar(r.war / r.games)} a game` : "no game yet"} />
        <Fig k="Bench WAR" v={r.games ? sgnWar(r.bench) : NUL} sub="what sat, same measure" />
        <Fig k="PF – PA" v={r.games ? `${r.pf - r.pa >= 0 ? "+" : "−"}${fmt(Math.abs(r.pf - r.pa), 1)}` : NUL}
          sub={r.games ? `${fmt(r.pf, 1)} for, ${fmt(r.pa, 1)} against` : undefined} />
        <Fig k="Best week" v={best ? fmt(best.pts, 1) : NUL} sub={best ? when(best) : "no scored week"} />
        <Fig k="Worst week" v={worst ? fmt(worst.pts, 1) : NUL} sub={worst ? when(worst) : "no scored week"} />
        {allTime
          ? <Fig k="Best finish" v={r.best ? ord(r.best.fin) : NUL}
              sub={r.best ? `${r.best.season}${r.titles ? ` · ${r.titles} title${r.titles === 1 ? "" : "s"}` : ""}` : "no settled season"} />
          : <Fig k="Avg margin" v={r.games ? `${r.pf - r.pa >= 0 ? "+" : "−"}${fmt(Math.abs(r.pf - r.pa) / r.games, 1)}` : NUL}
              sub="points a game" />}
      </div>
      {one && (
        <div className="plx-weeks">
          <div className="k">Week by week</div>
          <div className="weekgrid">
            {Array.from({ length: REG_WEEKS }, (_, i) => {
              const w = one.weeks.find(x => x.wk === i + 1);
              if (!w) return (
                <div key={i} className="weekcell miss">
                  <div className="top"><span className="wk">W{i + 1}</span><span className="pts">—</span></div>
                  <div className="bar" /><div className="war">{" "}</div>
                </div>
              );
              return (
                <div key={i} className="weekcell">
                  <div className="top"><span className="wk">W{w.wk}</span><span className="pts">{fmt(w.pts, 1)}</span></div>
                  <div className="bar"><i style={{ width: `${Math.round(Math.max(0, w.pts) / max * 100)}%` }} /></div>
                  <div className={`war ${w.res === "W" ? "good" : w.res === "L" ? "bad" : ""}`}
                    title={w.opp != null ? `vs ${nameOf(w.opp)}, ${fmt(w.oppPts ?? 0, 1)}` : undefined}>
                    {w.res}{w.oppPts != null ? ` · ${fmt(w.oppPts, 1)}` : ""}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {allTime && (
        <div className="plx-note">
          {r.parts.map(p => `${p.season} ${wlStr(p.w, p.l, p.t)}`).join(" · ")}
        </div>
      )}
      <a className="plx-go" href={`#${to}`}
        onClick={e => {
          e.stopPropagation();
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault(); nav(to);
        }}>Team page</a>
    </div>
  );
}
