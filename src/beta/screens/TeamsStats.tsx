import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type { BracketFile, Franchises, Matchups, Team, Weekly } from "../../lib/types";
import { indexKey, jl } from "../../lib/data";
import { useJson } from "../../lib/useJson";
import { useSettledSeasons } from "../../lib/caps";
import { fmt, ord, sd } from "../../lib/stats";
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
 * THREE PHASES, THE PLAYERS BOARD'S (Max, 2026-09-28):
 *
 *   Regular season  weeks 1..playoff_start−1, every franchise.
 *   Playoffs        the WINNERS bracket, ELIMINATION GAMES ONLY — the scope
 *                   scripts/playoff_war.py prices and lib/postseason counts, so
 *                   the WAR here and the player board's playoff WAR are the
 *                   same games. Placement games and the consolation bracket
 *                   are out. A first-round BYE is a win (the reward for the
 *                   top seed must not rank below the third seed's), counted in
 *                   the record and nowhere else — it has no score.
 *   Both            the two added. Every column is a count or a sum, so each
 *                   survives the addition; PPG and σ are recomputed over the
 *                   games, never averaged across halves.
 *
 * Vs median and luck are regular-season constructs — a week's league median
 * needs all twelve teams playing — so they leave the board under the other
 * two phases rather than printing a figure that means something else.
 *
 * ACCRUED WAR is the headline figure: the WAR the franchise's actual starters
 * banked, game by game, against the league-wide replacement level — what the
 * lineups it fielded were worth, in wins. Regular-season WAR is weekly.json's;
 * bracket WAR is bracket.json's `war` block. Its twin in the drawer is the
 * WAR left on the bench, which the bracket does not score.
 */

/* ---- one franchise-season ------------------------------------------------ */

export type Phase = "reg" | "post" | "both";
export const PHASES: { id: Phase; label: string }[] = [
  { id: "reg", label: "Regular season" },
  { id: "post", label: "Playoffs" },
  { id: "both", label: "Both" },
];

interface WeekCell {
  wk: number; pts: number | null; opp: number | null; oppPts: number | null;
  res: "W" | "L" | "T"; bye?: boolean;
}

/** one phase of one franchise-season, in the units the columns print */
interface Half {
  w: number; l: number; t: number;
  /** first-round byes, each one of the wins above */
  byes: number;
  pf: number; pa: number;
  /** the scores of the games actually played — never a bye */
  scores: number[];
  /** null where the file prices none: a bracket with no WAR block */
  war: number | null;
  /** WAR left on the bench — regular season only */
  bench: number | null;
  /** MAX WAR (Max, 2026-09-29): the WAR perfect start/sit would have banked —
   *  each week's best legal lineup out of that week's roster, from
   *  franchises.json `max_war` (build_site_data.py). Regular season only;
   *  null where the file predates it. */
  maxw: number | null;
  medW: number; medL: number; medT: number;
  weeks: WeekCell[];
}

export interface TeamSeason {
  season: string;
  rid: number; fkey: string;
  team: string; manager: string;
  reg: Half;
  /** null when the franchise had no winners-bracket game that season */
  post: Half | null;
  /** the season has a bracket with a decided game in it */
  bracket: boolean;
}

/** the fourteen-cell regular season the Players drawer uses */
const REG_LEN = 14;

const emptyHalf = (): Half => ({
  w: 0, l: 0, t: 0, byes: 0, pf: 0, pa: 0, scores: [], war: 0, bench: 0, maxw: null,
  medW: 0, medL: 0, medT: 0, weeks: [],
});

const cache = new Map<string, Promise<TeamSeason[]>>();

/** one season's franchise rows, cached per league and season */
function loadSeason(season: string): Promise<TeamSeason[]> {
  const ck = indexKey([season]);
  const hit = cache.get(ck);
  if (hit) return hit;
  const pending = (async () => {
    const [teams, mw, weekly, br, fr] = await Promise.all([
      jl<Team[]>(`${season}/teams.json`),
      jl<Matchups>(`${season}/matchups.json`),
      jl<Weekly>(`${season}/weekly.json`).catch(() => ({} as Weekly)),
      jl<BracketFile>(`${season}/bracket.json`).catch(() => null),
      jl<Franchises>("franchises.json").catch(() => null),
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

    /* THE BRACKET: elimination games of the winners bracket, decided ones */
    const elim = (br?.winners ?? []).filter(g => !(g.p && g.p > 1));
    const played = elim.filter(g => g.w != null && g.l != null);
    const bps = br?.playoff_start ?? ps;
    const postWar = new Map<number, number>();
    if (br?.war) for (const r of Object.values(br.war))
      postWar.set(r.rid, (postWar.get(r.rid) ?? 0) + r.war);

    return teams.map(t => {
      const rid = t.roster_id;
      /* ---- the regular season ---- */
      const reg = emptyHalf();
      const ent = (mw.teams[String(rid)] ?? [])
        .filter(e => e[0] < ps && e[3] != null)
        .sort((a, b) => a[0] - b[0]);
      for (const e of ent) {
        const [wk, pts, opp, oppPts] = e;
        const res = pts > oppPts! ? "W" : pts < oppPts! ? "L" : "T";
        reg[res === "W" ? "w" : res === "L" ? "l" : "t"]++;
        reg.pf += pts; reg.pa += oppPts!; reg.scores.push(pts);
        const m = med.get(wk);
        if (m != null) { if (pts > m) reg.medW++; else if (pts < m) reg.medL++; else reg.medT++; }
        const starters = (e[4] ?? []).filter(p => p && p !== "0");
        for (const p of starters) reg.war! += war.get(`${p}|${wk}`) ?? 0;
        for (const p of e[5] ?? []) if (p && p !== "0" && !starters.includes(p))
          reg.bench! += war.get(`${p}|${wk}`) ?? 0;
        reg.weeks.push({ wk, pts, opp, oppPts, res });
      }

      /* ---- the bracket ---- */
      let post: Half | null = null;
      const mine = played.filter(g => g.t1 === rid || g.t2 === rid).sort((a, b) => a.r - b.r);
      const seated = elim.filter(g => g.t1 === rid || g.t2 === rid);
      if (mine.length || seated.length) {
        post = emptyHalf();
        post.bench = null;
        post.war = br?.war ? postWar.get(rid) ?? 0 : null;
        /* a bye for every elimination round the team was seeded past: its
           first seat is in round N, so rounds 1..N−1 were won without a game */
        const first = Math.min(...seated.map(g => g.r));
        for (let r = 1; r < first; r++) {
          post.w++; post.byes++;
          post.weeks.push({ wk: bps + r - 1, pts: null, opp: null, oppPts: null, res: "W", bye: true });
        }
        for (const g of mine) {
          const me1 = g.t1 === rid;
          const pts = (me1 ? g.t1_pts : g.t2_pts) ?? 0;
          const oppPts = (me1 ? g.t2_pts : g.t1_pts) ?? 0;
          const res = g.w === rid ? "W" : "L";
          post[res === "W" ? "w" : "l"]++;
          post.pf += pts; post.pa += oppPts; post.scores.push(pts);
          post.weeks.push({ wk: g.week, pts, opp: me1 ? g.t2 : g.t1, oppPts, res });
        }
        if (!mine.length && !post.byes) post = null;
      }
      const fkey = t.fkey ?? String(rid);
      reg.maxw = fr?.[fkey]?.seasons.find(x => x.season === season)?.max_war ?? null;
      return {
        season, rid, fkey, team: t.team, manager: t.manager,
        reg, post, bracket: played.length > 0,
      };
    });
  })();
  cache.set(ck, pending);
  pending.catch(() => cache.delete(ck));
  return pending;
}

/* ---- the board's row --------------------------------------------------- */

type Key = "rec" | "fin" | "pct" | "titles" | "med" | "luck" | "pf" | "pa" | "ppg" | "sdv" | "war" | "maxw";

interface Col {
  id: Key; label: string; short?: string; width: string;
  /** smallest first on the first press (a finish) */
  asc?: boolean;
  grp: "res" | "score" | "war";
}

const C: Record<Key, Col> = {
  rec: { id: "rec", label: "Record", short: "W-L", width: "9%", grp: "res" },
  fin: { id: "fin", label: "Finish", short: "Fin", width: "7%", asc: true, grp: "res" },
  pct: { id: "pct", label: "Win %", width: "6%", grp: "res" },
  titles: { id: "titles", label: "Titles", width: "5%", grp: "res" },
  med: { id: "med", label: "Vs median", short: "Vs med", width: "9%", grp: "res" },
  luck: { id: "luck", label: "Luck", width: "6%", grp: "res" },
  pf: { id: "pf", label: "PF", width: "8%", grp: "score" },
  pa: { id: "pa", label: "PA", width: "8%", grp: "score" },
  ppg: { id: "ppg", label: "PPG", width: "7%", grp: "score" },
  sdv: { id: "sdv", label: "σ", width: "6%", grp: "score" },
  war: { id: "war", label: "Accrued WAR", short: "WAR", width: "10%", grp: "war" },
  maxw: { id: "maxw", label: "Max WAR", short: "Max", width: "8%", grp: "war" },
};

/** the columns for a scope and a phase — median and luck are the regular
 *  season's alone */
function colsFor(allTime: boolean, phase: Phase): Col[] {
  const reg = phase === "reg";
  const ids: Key[] = allTime
    ? ["rec", "pct", "titles", "fin", ...(reg ? ["med", "luck"] as Key[] : []), "pf", "ppg", "sdv", "war",
      ...(phase !== "post" ? ["maxw" as Key] : [])]
    : ["rec", "fin", ...(reg ? ["med", "luck"] as Key[] : []), "pf", "pa", "ppg", "sdv", "war",
      ...(phase !== "post" ? ["maxw" as Key] : [])];
  return ids.map(k => (k === "fin" && allTime ? { ...C.fin, label: "Best" } : C[k]));
}
const GRP_LABEL = { res: "Results", score: "Scoring", war: "WAR" } as const;

/** A LABEL THAT KEEPS ITS CASE (Max, 2026-09-29). The header, the sort strip
 *  and the key all set their labels uppercase in CSS, which turns σ into Σ —
 *  a different symbol (a sum, not a standard deviation). The Greek letter
 *  rides in a span that opts out of the transform; everything else is the
 *  label as it was. */
const lbl = (s: string): ReactNode =>
  s.includes("σ")
    ? s.split(/(σ)/).map((x, i) => (x === "σ" ? <span key={i} className="tmx-lc">σ</span> : x))
    : s;

const DEF: Record<Key, string> = {
  rec: "Wins, losses and ties. Sorts by wins (a tie is half of one), then points for. In the playoffs a first-round bye counts as a win.",
  fin: "Where the season ended — the bracket's placing, then the standings' for everyone else. Settled seasons only; all-time, the best one.",
  pct: "Wins over decisions, a tie counting half.",
  titles: "Championships won.",
  med: "The record against each week's league median score — what the team would have gone playing all twelve every week.",
  luck: "Actual wins minus median wins. Positive won more than the scores earned.",
  pf: "Points for.",
  pa: "Points against.",
  ppg: "Points per game played — a bye is not a game.",
  sdv: "Game-to-game standard deviation of the team's score. Lower is steadier.",
  maxw: "The WAR perfect start/sit would have banked: every regular-season week's best legal lineup out of that week's own roster, starters and bench, on the same weekly WAR. Accrued WAR over it is how much of the roster's value the lineups used. Regular season only.",
  war: "The WAR the lineups actually fielded banked, summed game by game — each starter's points against his position's replacement level, turned into wins. A running total while the season is on. Playoff WAR is the bracket's, elimination games only.",
};

interface Row {
  rid: number; fkey: string; team: string; manager: string;
  /** the seasons behind the row: one, or every one the franchise played */
  parts: TeamSeason[];
  /** the phase's halves, season by season */
  halves: { season: string; h: Half }[];
  w: number; l: number; t: number; byes: number; pf: number; pa: number;
  f: Partial<Record<Key, number | null>>;
  text: Partial<Record<Key, string>>;
  best: { fin: number; season: string } | null;
  titles: number;
  war: number | null; bench: number | null; maxw: number | null;
  /** games actually played in the phase */
  games: number;
}

const wlStr = (w: number, l: number, t: number) => `${w}-${l}${t ? `-${t}` : ""}`;

function rowOf(
  parts: TeamSeason[], fin: (s: TeamSeason) => number | null, allTime: boolean, phase: Phase,
): Row | null {
  const halves = parts.flatMap(p => {
    const out: { season: string; h: Half }[] = [];
    if (phase !== "post") out.push({ season: p.season, h: p.reg });
    if (phase !== "reg" && p.post) out.push({ season: p.season, h: p.post });
    return out;
  });
  // the Playoffs board lists who reached the bracket and nobody else
  if (phase === "post" && !halves.length) return null;
  const last = parts[parts.length - 1];
  const hs = halves.map(x => x.h);
  const sum = (k: "w" | "l" | "t" | "byes" | "pf" | "pa" | "medW" | "medL" | "medT") =>
    hs.reduce((a, h) => a + h[k], 0);
  /** null only where every half is null — "not priced" is not zero */
  const sumN = (k: "war" | "bench" | "maxw") =>
    hs.every(h => h[k] == null) ? null : hs.reduce((a, h) => a + (h[k] ?? 0), 0);
  const w = sum("w"), l = sum("l"), t = sum("t"), byes = sum("byes");
  const pf = sum("pf"), pa = sum("pa");
  const scores = hs.flatMap(h => h.scores);
  const games = scores.length;
  const dec = w + l + t;
  const medW = sum("medW"), medL = sum("medL"), medT = sum("medT");
  const finishes = parts.map(p => ({ fin: fin(p), season: p.season }))
    .filter((x): x is { fin: number; season: string } => x.fin != null);
  const best = finishes.reduce<Row["best"]>(
    (b, x) => (!b || x.fin < b.fin || (x.fin === b.fin && x.season > b.season) ? x : b), null);
  const titles = finishes.filter(x => x.fin === 1).length;
  const war = sumN("war"), bench = sumN("bench");
  /** a total only when every regular half under it carries the figure */
  const regHs = halves.filter(x => parts.some(p => p.reg === x.h)).map(x => x.h);
  const maxw = regHs.length && regHs.every(h => h.maxw != null)
    ? regHs.reduce((a, h) => a + h.maxw!, 0) : null;
  const reg = phase === "reg";
  return {
    rid: last.rid, fkey: last.fkey, team: last.team, manager: last.manager,
    parts, halves, w, l, t, byes, pf, pa, best, titles, war, bench, maxw, games,
    f: {
      rec: dec ? (w + t / 2) * 1e6 + pf : null,
      fin: allTime ? best?.fin ?? null : fin(last),
      pct: dec ? (w + t / 2) / dec : null,
      titles: allTime ? titles : null,
      med: reg && games ? (medW + medT / 2) * 1e6 + pf : null,
      luck: reg && games ? w - medW : null,
      pf: games ? pf : null,
      pa: games ? pa : null,
      ppg: games ? pf / games : null,
      sdv: games > 1 ? sd(scores) : null,
      war: games ? war : null,
      maxw: games ? maxw : null,
    },
    text: {
      rec: dec ? wlStr(w, l, t) : undefined,
      med: reg && games ? wlStr(medW, medL, medT) : undefined,
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
  maxw: v => fmtWar(v),
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

export default function TeamsStats({ season, played, phase }: {
  /** a season, or ALL_SEASONS */
  season: string;
  /** every season the league has, newest first */
  played: string[];
  phase: Phase;
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
    return [...by.values()]
      .map(parts => rowOf(parts.sort((a, b) => a.season.localeCompare(b.season)), finOf, allTime, phase))
      .filter((r): r is Row => r != null);
  }, [data, finOf, allTime, phase]);

  /** season|rid -> the franchise's name that season, for the drawer's opponents */
  const names = useMemo(() => new Map(
    (data ?? []).flat().map(t => [`${t.season}|${t.rid}`, t.team] as const)), [data]);
  const cols = useMemo(() => colsFor(allTime, phase), [allTime, phase]);
  const groups = (["res", "score", "war"] as const)
    .map(g => ({ id: g, label: GRP_LABEL[g], span: cols.filter(c => c.grp === g).length }));
  const s = useSort<Key>("rec", -1, "tmx:sort.stats");
  useEffect(() => {
    if (!cols.some(c => c.id === s.sort)) s.onSort("rec");
  }, [cols, s]);
  const col = (id: Key) => cols.find(c => c.id === id) ?? C[id];
  const edge = (c: Col, i: number) => i === 0 || c.grp !== cols[i - 1].grp;

  const ordered = useMemo(() => (rows ? sortBy(rows, r => r.f[s.sort] ?? null, s.dir) : null),
    [rows, s.sort, s.dir]);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { setOpen(null); }, [season, phase]);

  const anyGames = !!rows?.some(r => r.games > 0 || r.byes > 0);
  const noBracket = phase === "post" && !!data && !data.some(l => l.some(t => t.bracket));
  const micro: Key[] = (["ppg", "war", "rec"] as Key[]).filter(k => k !== s.sort).slice(0, 2);
  /** THE LEAD FIGURE'S COMPANION on the phone (Max, 2026-09-29): the record
   *  carries the record against the median, points for and points per game
   *  carry what was scored against. One column wide, so the pair a desktop
   *  reads across two columns reads down one. */
  const subOf = (k: Key, r: Row): { k: string; v: ReactNode } | null => {
    if (!r.games) return null;
    if (k === "rec" && r.text.med) return { k: "Vs med", v: r.text.med };
    if (k === "pf") return { k: "PA", v: fmt(r.pa, 1) };
    if (k === "ppg") return { k: "PA/g", v: fmt(r.pa / r.games, 1) };
    return null;
  };
  const span = mobile ? 3 : 2 + cols.length;
  const [keyOpen, setKeyOpen] = useState(false);
  const phaseLabel = PHASES.find(p => p.id === phase)!.label;

  return (
    <>
      {mobile && (
        <div className="plx-sort">
          <button type="button" className="plx-dir" aria-label={s.dir === -1 ? "Most first" : "Least first"}
            onClick={() => s.onSort(s.sort)}>{s.dir === -1 ? "▾" : "▴"}</button>
          <LensStrip label="Sort" value={s.sort}
            onChange={k => { if (k !== s.sort) s.onSort(k, col(k).asc); }}
            options={cols.map(c => ({ id: c.id, label: lbl(c.short ?? c.label) }))} />
        </div>
      )}
      <Band label={`${allTime ? "All-time" : season} · ${phaseLabel}`}
        right={
          <span className="plx-bandr">
            <span className="band-note plx-hint">
              {phase === "reg" ? "WAR is what the lineups fielded banked"
                : "the bracket is elimination games only · a bye is a win"}
            </span>
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
              <dt>{lbl(c.label)}</dt>
              <dd>{DEF[c.id]}</dd>
            </Fragment>
          ))}
        </dl>
      )}
      {err ? <DataError what="The season didn't load" />
        : !ordered ? <div className="empty">Loading…</div>
        : noBracket ? <div className="empty">{allTime ? "No bracket" : season} has been played yet — the postseason fills in once it is.</div>
        : !anyGames ? <div className="empty">No scored week in {season} yet — this fills in as the season is played.</div>
        : (
        <table className="v3tbl plx-tbl tmx-stats">
          {!mobile && (
            <thead>
              <tr className="plx-grp">
                <th className="sp" />
                <th className="t" />
                {groups.filter(g => g.span).map(g => (
                  <th key={g.id} className="plx-edge" colSpan={g.span}>{g.label}</th>
                ))}
              </tr>
              <tr className="plx-cols">
                <th className="c sp">#</th>
                <th className="t">Franchise</th>
                {cols.map((c, i) => (
                  <Th key={c.id} id={c.id} label={lbl(c.label)} align="n" width={c.width}
                    asc={c.asc} sort={s.sort} onSort={s.onSort}
                    className={edge(c, i) ? "plx-edge" : undefined} />
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
                      : `${r.manager} · ${r.games} game${r.games === 1 ? "" : "s"}${r.byes ? " + bye" : ""}`} />
                  {mobile ? (
                    <td className="n plx-lead">
                      <span className="f hd">{cellOf(s.sort, r)}</span>
                      {(() => {
                        const sub = subOf(s.sort, r);
                        return sub && (
                          <div className="plx-micro">
                            <span className="o">{sub.k.toUpperCase()}<b>{sub.v}</b></span>
                          </div>
                        );
                      })()}
                      <div className="plx-micro">
                        {micro.map(k => (
                          <span key={k} className="o">
                            {(col(k).short ?? col(k).label).toUpperCase()}<b>{cellOf(k, r)}</b>
                          </span>
                        ))}
                      </div>
                    </td>
                  ) : cols.map((c, ci) => (
                    <td key={c.id} className={`n${edge(c, ci) ? " plx-edge" : ""}`}>
                      <span className={`f${c.id === s.sort ? " hd" : ""}`}>{cellOf(c.id, r)}</span>
                    </td>
                  ))}
                </TapRow>
                {open === r.fkey && (
                  <tr className="plx-drawrow">
                    <td colSpan={span}>
                      <Drawer r={r} allTime={allTime} phase={phase} to={betaPath(`/team/${r.rid}`)}
                        nameOf={(sn, rid) => names.get(`${sn}|${rid}`) ?? `Team ${rid}`} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
      <div className="tnote screen">
        {phase === "reg" ? "Regular season. " : phase === "post"
          ? "The winners bracket's elimination games — placement games and the consolation bracket are left out, the same games playoff WAR is scored over. A first-round bye counts as a win in the record and nowhere else. "
          : "Regular season and the winners bracket's elimination games, added; a bye counts as a win in the record. "}
        Accrued WAR sums, game by game, the WAR of the players each franchise actually started — the lineup as
        set, not the best one it could have fielded — so it rewards the roster and the manager's calls together.
        {phase === "reg" ? " The drawer carries the WAR left on the bench beside it. Vs median is the record against each week's league median, and luck is the gap between that and the real one." : ""}
        {" "}A finish is printed only once its season is settled.
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

function Drawer({ r, allTime, phase, to, nameOf }: {
  r: Row; allTime: boolean; phase: Phase; to: string;
  nameOf: (season: string, rid: number) => string;
}) {
  const nav = useNavigate();
  const weeks = r.halves.flatMap(x => x.h.weeks.filter(w => !w.bye).map(w => ({ ...w, season: x.season })));
  const best = weeks.reduce<(typeof weeks)[number] | null>((b, w) => (!b || w.pts! > b.pts! ? w : b), null);
  const worst = weeks.reduce<(typeof weeks)[number] | null>((b, w) => (!b || w.pts! < b.pts! ? w : b), null);
  const when = (w: { wk: number; season: string }) => (allTime ? `${w.season} week ${w.wk}` : `week ${w.wk}`);
  const one = !allTime ? r.parts[r.parts.length - 1] : null;
  /* the season's cells for the phase: the fourteen regular weeks, the
     bracket's, or both in order */
  const cells = one ? r.halves.flatMap(x => x.h.weeks) : [];
  /* the regular season is POSITIONAL — every week 1..14 has a cell, so two
     franchises' seasons compare cell for cell — and the bracket is its games
     in order after it, a bye included */
  const regLen = one && phase !== "post"
    ? Math.max(REG_LEN, ...one.reg.weeks.map(w => w.wk)) : 0;
  const grid: (WeekCell | { wk: number; none: true })[] = one
    ? [
      ...Array.from({ length: regLen }, (_, i) =>
        one.reg.weeks.find(c => c.wk === i + 1) ?? { wk: i + 1, none: true as const }),
      ...(phase !== "reg" ? one.post?.weeks ?? [] : []),
    ]
    : [];
  const max = Math.max(1, ...cells.map(w => w.pts ?? 0));
  const phaseWords = phase === "reg" ? "regular season" : phase === "post" ? "playoffs" : "regular season and playoffs";
  return (
    <div className="plx-draw">
      <div className="hd">
        <span className="nm">{r.team}</span>
        <span className="mt">{r.manager} · {allTime ? `${r.parts.length} seasons` : `${one?.season}`} {phaseWords}</span>
      </div>
      <div className="plx-figs">
        <Fig k="Accrued WAR" v={r.games && r.war != null ? sgnWar(r.war) : NUL}
          sub={r.games && r.war != null ? `${fmtWar(r.war / r.games)} a game` : r.games ? "not priced for this bracket" : "no game yet"} />
        <Fig k="Bench WAR" v={r.bench != null && r.games ? sgnWar(r.bench) : NUL}
          sub={phase === "post" ? "the bracket scores starters only" : phase === "both" ? "regular season only" : "what sat, same measure"} />
        <Fig k="PF – PA" v={r.games ? `${r.pf - r.pa >= 0 ? "+" : "−"}${fmt(Math.abs(r.pf - r.pa), 1)}` : NUL}
          sub={r.games ? `${fmt(r.pf, 1)} for, ${fmt(r.pa, 1)} against` : undefined} />
        <Fig k="Best game" v={best ? fmt(best.pts!, 1) : NUL} sub={best ? when(best) : "no scored game"} />
        <Fig k="Worst game" v={worst ? fmt(worst.pts!, 1) : NUL} sub={worst ? when(worst) : "no scored game"} />
        {allTime
          ? <Fig k="Best finish" v={r.best ? ord(r.best.fin) : NUL}
              sub={r.best ? `${r.best.season}${r.titles ? ` · ${r.titles} title${r.titles === 1 ? "" : "s"}` : ""}` : "no settled season"} />
          : <Fig k="Avg margin" v={r.games ? `${r.pf - r.pa >= 0 ? "+" : "−"}${fmt(Math.abs(r.pf - r.pa) / r.games, 1)}` : NUL}
              sub="points a game" />}
      </div>
      {one && grid.length > 0 && (
        <div className="plx-weeks">
          <div className="k">Game by game</div>
          <div className="weekgrid">
            {grid.map(c => {
              if ("none" in c) return (
                <div key={c.wk} className="weekcell miss">
                  <div className="top"><span className="wk">W{c.wk}</span><span className="pts">—</span></div>
                  <div className="bar" /><div className="war">{" "}</div>
                </div>
              );
              if (c.bye) return (
                <div key={`b${c.wk}`} className="weekcell bye">
                  <div className="top"><span className="wk">W{c.wk}</span><span className="pts">BYE</span></div>
                  <div className="bar" /><div className="war good">W · advanced</div>
                </div>
              );
              return (
                <div key={c.wk} className="weekcell">
                  <div className="top"><span className="wk">W{c.wk}</span><span className="pts">{fmt(c.pts ?? 0, 1)}</span></div>
                  <div className="bar"><i style={{ width: `${Math.round(Math.max(0, c.pts ?? 0) / max * 100)}%` }} /></div>
                  <div className={`war ${c.res === "W" ? "good" : c.res === "L" ? "bad" : ""}`}
                    title={c.opp != null ? `vs ${nameOf(one.season, c.opp)}, ${fmt(c.oppPts ?? 0, 1)}` : undefined}>
                    {c.res}{c.oppPts != null ? ` · ${fmt(c.oppPts, 1)}` : ""}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {allTime && (
        <div className="plx-note">
          {r.parts.map(p => {
            const h = r.halves.filter(x => x.season === p.season).map(x => x.h);
            if (!h.length) return null;
            const w = h.reduce((a, x) => a + x.w, 0), l = h.reduce((a, x) => a + x.l, 0), t = h.reduce((a, x) => a + x.t, 0);
            return `${p.season} ${wlStr(w, l, t)}`;
          }).filter(Boolean).join(" · ")}
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
