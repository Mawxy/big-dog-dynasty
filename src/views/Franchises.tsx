import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type {
  Franchises, MatchEntry, Matchups, ProjectionsFile, Team, Values, WeekOdds, Weekly,
} from "../lib/types";
import { jl } from "../lib/data";
import { useJson } from "../lib/useJson";
import { useCvi, useDvi } from "../lib/useIndices";
import { fmt, fmtWar, mean, meterWidth, ord, sd } from "../lib/stats";
import { latestSeasonOf, lineupOf, optimalLineup, pricedLineup, rosterSeasonOf, seasonSeg, weekIndex } from "../lib/league";
import { useLeague, useLeaguePath } from "../lib/context";
import { ktcOf } from "../lib/values";
import { useSeasonData } from "../lib/useSeasonData";
import { useMobile } from "../lib/useWidth";
import DataTable, { applySort, sortCol, useTableSort, type Col, type Grp } from "../components/DataTable";
import { RouteLink } from "../components/RouteLink";

/**
 * TEAMS — one franchise per row, two boards.
 *
 * Same shape as Players: a scope switch naming what you are looking at, and
 * beneath it a year spine that only one of the two scopes has.
 *
 *   Value      what each roster is worth today, in three currencies: our two
 *              indices for the best legal lineup, the same two summed over
 *              every player held, and the dynasty market's price for the
 *              whole roster. No year, and no results — a record and a price
 *              are different claims and were previously sharing a row.
 *   Standings  a played season's table (absorbed from the old /standings
 *              route), or All-time for the franchise history board.
 *
 * These were one chip row — `2026 rosters · 2025 · 2024 · … · All-time` —
 * which put a scope and a set of years on the same axis and made "2026
 * rosters" read as just another season. It isn't one: it is the only board
 * here with no result in it.
 *
 * The League page's power table already ranks rosters by starter DVI as a
 * summary; this page owns the breakdown. If the two ever converge to the same
 * columns, cut this one.
 */
const nul = <span className="fig quiet">—</span>;
/** the two boards that need no per-render context; a shared constant rather
 *  than a `{}` literal, which would be a new object on every render and defeat
 *  DataTable's row memoization */
const NO_CTX: Record<string, never> = {};

export default function FranchisesView() {
  const { meta, league } = useLeague();
  const nav = useNavigate();
  const lp = useLeaguePath();
  const seg = useParams().season;

  const latest = latestSeasonOf(meta);
  const rosterSeason = rosterSeasonOf(league);
  const played = useMemo(
    () => meta.seasons.filter(s => s <= latest).slice().reverse(), [meta, latest]);

  /** The season under way (or about to be), when it is not yet a played one.
   *  It earns a chip because week_odds.py prices every week of it: the table
   *  reads as expected wins now and fills in with results as they land. */
  const upcoming = meta.seasons.includes(rosterSeason) && rosterSeason > latest
    ? rosterSeason : null;
  const years = useMemo(
    () => (upcoming ? [upcoming, ...played] : played), [upcoming, played]);

  /** "rosters" | "ALL" | a season on the spine */
  const scope = !seg ? "rosters"
    : seg.toLowerCase() === "all" ? "ALL"
      : years.includes(seg) ? seg : "rosters";
  const onValue = scope === "rosters";

  const chip = (label: string, to: string, on: boolean) => (
    <button key={to} type="button" className={`chip ${on ? "on" : ""}`}
      onClick={() => nav(lp(to))}>{label}</button>
  );

  return (
    <>
      <div className="screen-head">
        <span className="screen-title">Teams</span>
        {chip("Value", "/teams", onValue)}
        {/* Standings lands on the season under way — the one a reader checking
            standings means — falling back to the newest played season */}
        {chip("Standings", `/teams/${seasonSeg(upcoming ?? latest)}`, !onValue)}
        <span className="screen-note">
          {onValue ? `Rosters as they stand · ${rosterSeason}`
            : scope === "ALL" ? "Every season played"
              : scope === upcoming ? `${scope} · projected until played`
                : `${scope} regular season`}
        </span>
      </div>
      {/* the year spine: its own row, because it re-scopes the standings board
          rather than switching which board you are on */}
      {!onValue && (
        <div className="screen-head chiprow" style={{ paddingTop: 0 }}>
          {years.map(s => chip(s, `/teams/${seasonSeg(s)}`, scope === s))}
          {chip("All-time", "/teams/all", scope === "ALL")}
        </div>
      )}
      {onValue ? <RosterBoard />
        : scope === "ALL" ? <HistoryBoard />
          : <SeasonStandings season={scope} />}
    </>
  );
}

/* ---------------------------------------------------------------- 5C board */

interface BoardRow {
  rid: number; fkey: string; name: string; manager: string;
  /** best legal lineup, priced in each index's own currency */
  sDvi: number; sCvi: number; age: number | null;
  /** every rostered player, bench and taxi included */
  rDvi: number; rCvi: number;
  ktc: number | null; fc: number | null;
}

// records-mode roles (MOBILE.md M5): headline is the resting sort (starters
// DVI); the micros are starters CVI, the full-roster DVI and the market sum.
// Age and the second market column live on the desktop row only.
const BOARD_COLS: Col<BoardRow, Record<string, never>>[] = [
  {
    id: "rk", label: "Rk", grp: 0, w: 4, align: "c", td: "spine-cell", role: "spine",
    cell: (_r, _x, i) => <>
      <span className="spine" style={{ background: i < 4 ? "var(--acc)" : "var(--rule-2)" }} />
      <span className={`rank${i < 4 ? " top" : ""}`}>{i + 1}</span>
    </>,
  },
  {
    id: "team", label: "Franchise", grp: 0, w: 0, align: "t", td: "t name", asc: true,
    role: "identity", sort: r => r.name, cell: r => r.name,
  },
  {
    id: "manager", label: "Manager", grp: 0, w: 9, align: "t", hm: true, td: "t sub hm",
    sort: r => r.manager, cell: r => r.manager,
  },
  // Starter totals, bare figures — this table sorts by an index, so nothing
  // in it is metered. Starters and roster are separate columns rather than a
  // figure over a sub-label because both are sortable: the gap between them
  // IS the depth question, and you can only see it by ordering on each.
  {
    id: "dvi", label: "DVI", grp: 1, w: 8, align: "n", edge: true, keyCol: true, td: "n edge",
    role: "headline", microKey: "DVI",
    sort: r => r.sDvi, cell: r => <span className="head-fig sm">{fmt(r.sDvi, 0)}</span>,
  },
  {
    id: "cvi", label: "CVI", grp: 1, w: 8, align: "n", td: "n", role: "micro", microKey: "CVI",
    sort: r => r.sCvi, cell: r => <span className="head-fig sm" style={{ color: "var(--txt2)" }}>{fmt(r.sCvi, 0)}</span>,
  },
  // context, not a verdict — uncoloured; the League power table carries the
  // green/amber age read. It sits with the starters because it IS the average
  // age of the best nine by DVI, not of the whole roster.
  {
    id: "age", label: "Age", grp: 1, w: 6, align: "n", hm: true, td: "hm n",
    sort: r => r.age, cell: r => <span style={{ color: "var(--txt2)" }}>{r.age == null ? "—" : fmt(r.age, 1)}</span>,
  },
  {
    id: "rdvi", label: "DVI", grp: 2, w: 8, align: "n", edge: true, td: "n edge",
    role: "micro", microKey: "Roster",
    sort: r => r.rDvi, cell: r => <span className="head-fig sm" style={{ color: "var(--txt2)" }}>{fmt(r.rDvi, 0)}</span>,
  },
  {
    id: "rcvi", label: "CVI", grp: 2, w: 8, align: "n", hm: true, td: "n hm",
    sort: r => r.rCvi, cell: r => <span className="head-fig sm" style={{ color: "var(--txt2)" }}>{fmt(r.rCvi, 0)}</span>,
  },
  {
    id: "ktc", label: "KTC", grp: 3, w: 9, align: "n", edge: true, td: "n edge",
    role: "micro", microKey: "KTC",
    sort: r => r.ktc,
    cell: r => r.ktc == null ? nul
      : <span className="head-fig src">{r.ktc.toLocaleString()}</span>,
  },
  {
    id: "fc", label: "FantasyCalc", grp: 3, w: 11, align: "n", hm: true, td: "n hm",
    sort: r => r.fc,
    cell: r => r.fc == null ? nul
      : <span className="head-fig src">{r.fc.toLocaleString()}</span>,
  },
];

function RosterBoard() {
  const { meta, league } = useLeague();
  const nav = useNavigate();
  const lp = useLeaguePath();
  const rosterSeason = rosterSeasonOf(league);
  const { sortId, dir, onSort } = useTableSort("dvi");

  const fr = useJson<Franchises>("franchises.json").data;
  const teams = useJson<Team[]>(`${rosterSeason}/teams.json`).data;
  // model-aware: these follow the masthead's projection-model control
  const dvi = useDvi();
  const cvi = useCvi();
  const projs = useJson<ProjectionsFile>("projections.json").data;
  // global file: the market prices a format, not a league
  const vals = useJson<Values>("data/values.json", "globalDaily").data;

  /**
   * Starters = the roster's best legal lineup optimized IN that currency, not
   * the lineup as set. Each index gets its own optimal lineup: the best
   * win-now nine and the best dynasty nine can differ, and pricing one lineup
   * in the other's currency would understate every roster whose veterans and
   * prospects split the two roles.
   */
  const rows = useMemo<BoardRow[] | null>(() => {
    if (!teams || !dvi || !cvi || !fr) return null;
    const lineup = lineupOf(meta);
    const ageOf = new Map((projs?.players ?? []).map(p => [p.pid, p.age]));
    /**
     * A roster total sums every player the team holds — bench and taxi
     * included — so it answers depth where the starter figure answers
     * quality. A market total is null rather than 0 when NO player on the
     * roster carries a price: 0 would read as "this roster is worthless"
     * when it means "the feed didn't cover it".
     */
    const total = (t: Team, of: (pid: string) => number | null | undefined) => {
      let sum = 0, n = 0;
      for (const p of t.players) {
        const x = of(p);
        if (x != null) { sum += x; n++; }
      }
      return n ? sum : null;
    };
    return teams.map(t => {
      const d = pricedLineup(t, dvi.players, (_p, r) => r.dvi, lineup);
      const c = pricedLineup(t, cvi.players, (_p, r) => r.cvi, lineup);
      // average age of the best nine by DVI — context, not a verdict
      const ages = d.slots.map(sl => sl.player && ageOf.get(sl.player.id))
        .filter((a): a is number => a != null);
      const key = t.fkey ?? String(t.roster_id);
      const f = fr[key];
      const cur = f?.seasons[f.seasons.length - 1];
      return {
        rid: t.roster_id, fkey: key,
        name: cur?.name ?? t.team, manager: cur?.manager ?? t.manager,
        sDvi: d.starters, sCvi: c.starters, age: ages.length ? mean(ages) : null,
        rDvi: total(t, p => dvi.players[p]?.dvi) ?? 0,
        rCvi: total(t, p => cvi.players[p]?.cvi) ?? 0,
        ktc: total(t, p => ktcOf(vals?.players[p], meta.tep) ?? undefined),
        fc: total(t, p => vals?.players[p]?.fc),
      };
    });
  }, [teams, dvi, cvi, fr, projs, vals, meta]);

  const groups: Grp[] = [
    { id: 0, label: "", cls: "" },
    { id: 1, label: `Starters · ${rosterSeason}`, cls: "edge value" },
    { id: 2, label: "Full roster", cls: "edge" },
    { id: 3, label: "Dynasty market", cls: "edge" },
  ];

  const sorted = useMemo(
    () => rows ? applySort(rows, sortCol(BOARD_COLS, sortId, "dvi"), dir) : null,
    [rows, sortId, dir]);

  if (!sorted) return <div className="empty">Loading rosters…</div>;
  return (
    <>
      <div className="band">
        <span className="band-label">Roster value · {rosterSeason}</span>
        <span className="band-note">
          Each index prices its own best legal lineup — the best dynasty nine and the best
          win-now nine can differ · index points, not value
        </span>
      </div>
      {/* the row opens the franchise page BY FKEY, the key franchises.json is
          actually keyed on. A rid only resolves through FranchisePage's legacy
          fallback, and in an owner-keyed league (redraft: franchise = person)
          that fallback lands on whoever held the slot last — which is not
          necessarily this row. */}
      <DataTable cols={BOARD_COLS} groups={groups} rows={sorted} ctx={NO_CTX}
        label={`Roster value · ${rosterSeason}`}
        rowKey={r => r.fkey} sortId={sortId} dir={dir} onSort={onSort}
        homeCol="rk" onRowClick={r => nav(lp(`/franchise/${r.fkey}`))}
        recordsOnMobile recordsClass="t3" />
      <div className="tnote screen">
        Sorted by starters DVI — every header re-sorts, a row opens the franchise page.
        Starters DVI and CVI each price the roster's best legal lineup in their own
        index — the best dynasty nine and the best win-now nine can differ, so each gets
        its own optimal lineup — and age is the average of the best nine by DVI. Full
        roster sums every player held, bench and taxi included: a team well ahead on
        roster but not on starters is deep, not good. KTC and FantasyCalc are the same
        sum in the dynasty market's own currencies, and a roster no feed covers reads
        <span className="sigma"> —</span>, not zero. What each team did in a given
        season is on Standings.
      </div>
    </>
  );
}

/* ------------------------------------------------- a played season's table */

/**
 * A standings row for a season that may be partly, or entirely, unplayed.
 *
 * Anything a projection can honestly stand in for is a plain number: expected
 * wins from the per-week win probabilities, points per game from the projected
 * totals. Anything it cannot is nullable and renders as an em dash rather than
 * a zero — volatility is the spread of what a team ACTUALLY scored, lineup WAR
 * is what the manager actually fielded, and luck is the gap between real wins
 * and median wins. None of those exist before a game is played, and printing
 * 0.0 would say the team was perfectly steady and added nothing.
 */
interface StandRow {
  rid: number; fkey: string; seed: number; team: string; manager: string;
  /** real wins plus the summed win probability of every unplayed week */
  wins: number; fpts: number; rec: string;
  /** the median record as a label, and the wins in it — the column shows the
   *  first and sorts on the second; luck is a different quantity with its own
   *  column, and sorting Vs median by it ordered the table by neither */
  med: string | null; medWins: number | null; luck: number | null;
  ppg: number; sdv: number | null; war: number | null; ent: MatchEntry[];
  /** any week in this row's record is a projection, not a result */
  proj: boolean;
}
/** `records` is how a meter-drawing cell knows to return the bare figure on a
 *  phone — the mode travels through ctx, never through `window` (MOBILE.md M1) */
interface StandCtx { warMax: number; records: boolean }

const luckStr = (l: number) => (l > 0 ? "+" : l < 0 ? "−" : "") + Math.abs(l);
const luckColor = (l: number) => l === 0 ? "var(--dim)" : l > 0 ? "var(--good)" : "var(--bad)";

function SeasonStandings({ season }: { season: string }) {
  const { league } = useLeague();
  const nav = useNavigate();
  const lp = useLeaguePath();
  const data = useSeasonData(season);
  const [weekly, setWeekly] = useState<Weekly | null>(null);
  const [mw, setMw] = useState<Matchups | null>(null);
  const [err, setErr] = useState(false);
  const [reload, setReload] = useState(0);
  const [openRid, setOpenRid] = useState<number | null>(null);
  const { sortId, dir, onSort, reset: resetSort } = useTableSort("seed", 1);

  // the pregame lines: present for every season week_odds.py has run over, and
  // the ONLY source for a week that hasn't been played yet. A missing file is
  // not an error — an unplayed week simply has no figure.
  const odds = useJson<WeekOdds>(`${season}/odds.json`).data;

  // weekly and matchups stay hand-rolled: they settle together (the board reads
  // both or neither) and carry the retry the empty state offers
  useEffect(() => {
    let live = true;
    setErr(false);
    setOpenRid(null);
    resetSort();
    Promise.all([
      jl<Weekly>(`${season}/weekly.json`),
      jl<Matchups>(`${season}/matchups.json`).catch(() => ({ playoff_start: 15, teams: {} } as Matchups)),
    ]).then(([w, m]) => { if (live) { setWeekly(w); setMw(m); } })
      .catch(() => { if (live) setErr(true); });
    return () => { live = false; };
  }, [season, reload, league]);

  const rows = useMemo<StandRow[]>(() => {
    if (!data || !mw || !weekly) return [];
    const wkIdx = weekIndex(weekly);
    const ps = mw.playoff_start || 15;
    const weekPts: Record<number, number[]> = {};
    for (const list of Object.values(mw.teams))
      for (const e of list) if (e[0] < ps) (weekPts[e[0]] ??= []).push(e[1]);
    const medians: Record<number, number> = {};
    for (const [wk, pts] of Object.entries(weekPts)) {
      const v = pts.slice().sort((a, b) => a - b), n = v.length;
      medians[+wk] = n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
    }
    const rs = data.teams.map(t => {
      const ent = mw.teams[String(t.roster_id)] || [];
      const reg = ent.filter(e => e[0] < ps);
      const pts = reg.map(e => e[1]);
      let war = 0;
      for (const e of reg) for (const p of e[4]) {
        const v = wkIdx[p]?.[e[0]];
        if (v) war += v[1];
      }
      let mwin = 0, mloss = 0, mtie = 0;
      for (const e of reg) {
        const m = medians[e[0]];
        if (m == null) continue;
        e[1] > m ? mwin++ : e[1] < m ? mloss++ : mtie++;
      }
      // Every regular-season week the odds file prices that this team has not
      // actually played. Summed win probability is expected wins: over a
      // fourteen-week schedule that is a far better read than 0-0.
      //
      // A week counts only once it carries a WIN PROBABILITY, not merely an
      // entry: `wp` is optional in WeekOdds (week 1 without a snapshot is
      // deliberately left unpriced, with a mu and no line), and filtering on
      // `x.o != null` let such a week into `ahead.length` while contributing
      // `wp ?? 0` to expWins — a full projected LOSS for a week nobody has
      // priced.
      const done = new Set(reg.map(e => e[0]));
      const ahead = Object.keys(odds?.weeks ?? {})
        .map(wk => ({ wk: Number(wk), o: odds?.weeks[wk]?.[String(t.roster_id)] }))
        .filter(x => x.wk < ps && !done.has(x.wk) && x.o?.wp != null);
      const expWins = ahead.reduce((a, x) => a + (x.o?.wp ?? 0), 0);
      const projPts = ahead.map(x => x.o?.mu ?? 0);

      const g = t.wins + t.losses + t.ties;
      const wins = t.wins + expWins;
      // Played losses, NOT g - wins: that subtraction folded every tie into the
      // loss column, so a 6-6-2 team read 6-8 and its projected record inherited
      // the same two phantom losses. Ties are a third figure and stay one — the
      // odds file prices a win probability, never a draw, so no unplayed week
      // can add to them.
      const losses = t.losses + (ahead.length - expWins);
      const proj = ahead.length > 0;
      const all = [...pts, ...projPts];
      const ties = t.ties ? `-${t.ties}` : "";
      return {
        rid: t.roster_id, fkey: t.fkey ?? String(t.roster_id),
        seed: 0, manager: t.manager, team: t.team,
        wins, fpts: t.fpts + projPts.reduce((a, b) => a + b, 0),
        rec: proj
          ? `${wins.toFixed(1)}-${losses.toFixed(1)}${ties}`
          : `${t.wins}-${t.losses}${ties}`,
        // median record and luck are settled facts about weeks that happened;
        // an unplayed week contributes nothing to either
        med: reg.length ? `${mwin}-${mloss}${mtie ? "-" + mtie : ""}` : null,
        medWins: reg.length ? mwin : null,
        luck: reg.length ? t.wins - mwin : null,
        ppg: all.length ? mean(all) : (g ? t.fpts / g : 0),
        sdv: pts.length > 1 ? sd(pts) : null,
        war: reg.length ? war : null,
        ent, proj,
      };
    });
    const seedOrder = rs.slice().sort((a, b) => b.wins - a.wins || b.fpts - a.fpts);
    rs.forEach(r => { r.seed = seedOrder.indexOf(r) + 1; });
    return rs;
  }, [data, mw, weekly, odds]);

  const cols = useMemo<Col<StandRow, StandCtx>[]>(() => [
    {
      id: "seed", label: "Seed", grp: 0, w: 5, align: "c", td: "spine-cell", asc: true,
      role: "spine", sort: r => r.seed,
      cell: r => <>
        <span className="spine" style={{ background: r.seed <= 6 ? "var(--acc)" : "var(--rule-2)" }} />
        <span className={`rank${r.seed <= 6 ? " top" : ""}`}>{r.seed}</span>
      </>,
    },
    {
      id: "team", label: "Franchise", grp: 0, w: 0, align: "t", td: "t name", asc: true,
      role: "identity", sort: r => r.team,
      // an anchor, like PlayerLink — keyboard-reachable and openable in a new
      // tab, while a plain click stays an in-app navigation that doesn't also
      // toggle the row's drawer
      cell: r => {
        return <RouteLink to={lp(`/franchise/${r.fkey}`)}>{r.team}</RouteLink>;
      },
    },
    {
      id: "manager", label: "Manager", grp: 0, w: 11, align: "t", hm: true, td: "t sub hm",
      sort: r => r.manager, cell: r => r.manager,
    },
    // a projected figure is dimmed, the same treatment an unplayed week's score
    // gets on the Season tab — same fact, so the same visual weight
    {
      id: "rec", label: "Record", grp: 1, w: 9, align: "n", edge: true, td: "edge n",
      role: "headline", microKey: "Rec",
      sort: r => r.wins * 10000 + r.fpts,
      cell: r => <span style={{
        font: "600 20px/1 var(--cond)", color: r.proj ? "var(--dim)" : undefined,
      }}>{r.rec}</span>,
    },
    {
      id: "med", label: "Vs median", grp: 1, w: 9, align: "n", hm: true,
      td: "fig quiet hm n", sort: r => r.medWins, cell: r => r.med ?? nul,
    },
    {
      id: "luck", label: "Luck", grp: 1, w: 7, align: "n", td: "n",
      role: "micro", microKey: "Luck",
      sort: r => r.luck,
      cell: r => r.luck == null ? nul
        : <span style={{ font: "600 15px/1.4 var(--cond)", color: luckColor(r.luck) }}>{luckStr(r.luck)}</span>,
    },
    {
      id: "ppg", label: "PPG", grp: 2, w: 8, align: "n", edge: true, td: "fig strong edge n",
      role: "micro", microKey: "PPG",
      sort: r => r.ppg,
      cell: r => <span style={{ color: r.proj ? "var(--dim)" : undefined }}>{fmt(r.ppg, 1)}</span>,
    },
    {
      id: "sdv", label: "Volatility", grp: 2, w: 8, align: "n", hm: true,
      td: "fig quiet hm n", sort: r => r.sdv, cell: r => r.sdv == null ? nul : fmt(r.sdv, 1),
    },
    {
      id: "war", label: "Lineup WAR", grp: 2, w: 16, align: "n", keyCol: true, td: "n",
      role: "micro", microKey: "WAR",
      sort: r => r.war,
      // WAR is what the manager actually fielded, so there is nothing to show
      // — and nothing to meter — until a week has been played. On a records
      // line the meter goes too: the bare figure is the value.
      cell: (r, x) => r.war == null ? nul : x.records ? <>{fmtWar(r.war)}</> : (
        <div className="meter-row">
          <div className="meter"><i style={{ width: meterWidth(Math.max(0, r.war), x.warMax) }} /></div>
          <span className="fig">{fmtWar(r.war)}</span>
        </div>
      ),
    },
  ], [nav, lp]);

  /** no week played yet: every figure in the Results group is a projection */
  const wholly = rows.length > 0 && rows.every(r => r.proj && r.luck == null);
  const groups: Grp[] = [
    { id: 0, label: "", cls: "" },
    { id: 1, label: wholly ? "Projected results" : "Results", cls: "edge" },
    { id: 2, label: "Scoring & value", cls: "edge value" },
  ];

  const mobile = useMobile();
  const ctx = useMemo<StandCtx>(
    () => ({ warMax: Math.max(0.01, ...rows.map(r => r.war ?? 0)), records: mobile }),
    [rows, mobile]);
  const sorted = useMemo(
    () => applySort(rows, sortCol(cols, sortId, "seed"), dir), [rows, cols, sortId, dir]);

  // `data.error` is a FAILED season fetch, which arrives looking exactly like a
  // season nobody has played — without this it fell through to the "no scored
  // weeks" empty state below and claimed something about the season instead.
  // One button retries both halves; the one that didn't fail is a cache hit.
  if (err || data?.error) return (
    <div className="empty">Couldn't load team data.{" "}
      <button className="retry"
        onClick={() => { data?.retry?.(); setReload(n => n + 1); }}>Retry</button>
    </div>
  );
  if (!data || !mw || !weekly) return <div className="empty">Loading…</div>;
  // An unplayed season is only empty if nothing prices it either. With an odds
  // file every row still has an expected record and a projected PPG, which is
  // the whole point of listing the upcoming season here.
  if (!data.summary.length && !rows.some(r => r.proj)) return (
    <div className="empty">
      No scored weeks for {season} yet, and no projected lines to stand in —
      the Value board is the preseason read.
    </div>
  );

  const tnames: Record<number, string> = {};
  data.teams.forEach(t => { tnames[t.roster_id] = t.team; });
  const ps = mw.playoff_start || 15;

  return (
    <>
      <div className="band">
        <span className="band-label">
          {wholly ? `Projected standings · ${season}` : `Standings · ${season}`}
        </span>
        <span className="band-note">
          Playoffs from week {ps}, top 6 seeds · lineup WAR sums each week's real starters
          against the league-wide optimal pool
        </span>
      </div>
      <DataTable cols={cols} groups={groups} rows={sorted} ctx={ctx}
        label={wholly ? `Projected standings · ${season}` : `Standings · ${season}`}
        rowKey={r => String(r.rid)} sortId={sortId} dir={dir} onSort={onSort}
        homeCol="seed" openKey={openRid != null ? String(openRid) : null}
        onRowClick={r => setOpenRid(openRid === r.rid ? null : r.rid)}
        renderDrawer={r => <TeamDrawer r={r} tnames={tnames} ps={ps} />}
        recordsOnMobile recordsClass="t3" />
      <div className="tnote screen">
        Playoffs from week {ps}, top 6 seeds. Vs median is the record against each
        week's league median score; luck is actual wins minus median wins. Lineup WAR
        sums each week's real starters, measured against the league-wide optimal pool.
        Open a row for the week-by-week results.
        {rows.some(r => r.proj) && <>
          {" "}Dimmed figures are projections: an unplayed week contributes its pregame
          win probability to the record and its projected total to PPG, so the record
          reads in tenths of a win and firms up as results land. Volatility, luck and
          lineup WAR are facts about weeks that happened and stay <span className="sigma">—</span> until
          they have some.
        </>}
      </div>
    </>
  );
}

/** One season as a wrap of week cards, inline beneath the clicked row. */
function TeamDrawer({ r, tnames, ps }: { r: StandRow; tnames: Record<number, string>; ps: number }) {
  return (
    <div className="drawer">
      <div className="drawer-head">
        <span className="drawer-title">{r.team}</span>
        <span className="drawer-sub">
          {r.manager} · {r.rec}{r.proj ? " projected" : ""} · {fmt(r.ppg, 1)} ppg
          {r.war != null && <> · lineup WAR {fmtWar(r.war)}</>}
        </span>
      </div>
      <div className="week-grid">
        {r.ent.filter(e => e[0] < ps).map(e => {
          const [wk, pts, opp, oppPts] = e;
          const res = oppPts == null ? "—" : pts > oppPts ? "W" : pts < oppPts ? "L" : "T";
          const cls = res === "W" ? "win" : res === "L" ? "loss" : "";
          return (
            <div key={wk} className={`week-card ${cls}`}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                <span className="wk">W{wk}</span>
                <span className="res" style={{ color: res === "W" ? "var(--good)" : res === "L" ? "var(--bad)" : "var(--dim)" }}>{res}</span>
              </div>
              <div className="score">{fmt(pts, 1)}</div>
              <div className="opp">vs {opp != null ? tnames[opp] || "?" : "—"}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- all-time */

interface HistRow {
  fkey: string; name: string; manager: string;
  allRec: string; winPct: number; seasons: number;
  best: number | null; bestSeason: string | null; titles: number;
}

// records-mode roles: Win % is the resting sort so it is the headline; the
// micros are the all-time record and the title count. Best keeps its two-line
// cell on the desktop row only — the finish story is on the franchise page.
const HIST_COLS: Col<HistRow, Record<string, never>>[] = [
  {
    id: "rk", label: "Rk", grp: 0, w: 4, align: "c", td: "spine-cell", role: "spine",
    cell: (_r, _x, i) => <>
      <span className="spine" style={{ background: "var(--rule-2)" }} />
      <span className="rank">{i + 1}</span>
    </>,
  },
  {
    id: "team", label: "Franchise", grp: 0, w: 0, align: "t", td: "t name", asc: true,
    role: "identity", sort: r => r.name, cell: r => r.name,
  },
  {
    id: "manager", label: "Manager", grp: 0, w: 12, align: "t", hm: true, td: "t sub hm",
    sort: r => r.manager, cell: r => r.manager,
  },
  {
    id: "allrec", label: "All-time record", grp: 1, w: 12, align: "n", edge: true,
    role: "micro", microKey: "Rec",
    td: "fig edge n", sort: r => r.winPct, cell: r => r.allRec,
  },
  {
    id: "winPct", label: "Win %", grp: 1, w: 8, align: "n", keyCol: true, td: "fig n",
    role: "headline", microKey: "Win %",
    sort: r => r.winPct, cell: r => `${fmt(r.winPct * 100, 0)}%`,
  },
  {
    id: "seasons", label: "Seasons", grp: 1, w: 8, align: "n", hm: true,
    td: "fig quiet hm n", sort: r => r.seasons, cell: r => r.seasons,
  },
  {
    id: "best", label: "Best", grp: 2, w: 9, align: "n", edge: true, asc: true,
    td: "edge n", sort: r => r.best,
    cell: r => r.best == null ? nul : (
      <>
        <span className="fig" style={{ color: r.best === 1 ? "var(--acc)" : "var(--txt2)" }}>{ord(r.best)}</span>
        <div style={{ font: "400 11.5px/1.4 var(--sans)", color: "var(--dim)" }}>{r.bestSeason}</div>
      </>
    ),
  },
  {
    id: "titles", label: "Titles", grp: 2, w: 7, align: "n", td: "n",
    role: "micro", microKey: "Titles",
    sort: r => r.titles,
    cell: r => r.titles
      ? <span className="head-fig sm" style={{ color: "var(--acc)" }}>{r.titles}</span> : nul,
  },
];

const HIST_GROUPS: Grp[] = [
  { id: 0, label: "", cls: "" },
  { id: 1, label: "Record", cls: "edge" },
  { id: 2, label: "Finishes", cls: "edge" },
];

function HistoryBoard() {
  const nav = useNavigate();
  const lp = useLeaguePath();
  const { sortId, dir, onSort } = useTableSort("winPct");
  const fr = useJson<Franchises>("franchises.json").data;

  const rows = useMemo<HistRow[] | null>(() => {
    if (!fr) return null;
    return Object.entries(fr).map(([fkey, f]) => {
      const all = f.seasons.reduce(
        (a, sn) => ({ w: a.w + sn.wins, l: a.l + sn.losses, t: a.t + (sn.ties || 0) }),
        { w: 0, l: 0, t: 0 });
      const games = all.w + all.l + all.t;
      const bestSn = f.seasons.filter(sn => sn.finish != null)
        .reduce<(typeof f.seasons)[number] | null>(
          (b, sn) => !b || sn.finish! < b.finish! || (sn.finish === b.finish && sn.season > b.season)
            ? sn : b, null);
      const cur = f.seasons[f.seasons.length - 1];
      return {
        fkey, name: cur?.name ?? "—", manager: cur?.manager ?? "—",
        allRec: `${all.w}-${all.l}${all.t ? `-${all.t}` : ""}`,
        winPct: games ? (all.w + all.t / 2) / games : 0,
        seasons: f.seasons.filter(sn => sn.wins + sn.losses > 0).length,
        best: bestSn?.finish ?? null, bestSeason: bestSn?.season ?? null,
        titles: f.seasons.filter(sn => sn.finish === 1).length,
      };
    });
  }, [fr]);

  const sorted = useMemo(
    () => rows ? applySort(rows, sortCol(HIST_COLS, sortId, "winPct"), dir) : null,
    [rows, sortId, dir]);

  if (!sorted) return <div className="empty">Loading history…</div>;
  return (
    <>
      <div className="band">
        <span className="band-label">All-time · every season played</span>
        <span className="band-note">Win % counts a tie as half a win · a row opens the franchise page</span>
      </div>
      <DataTable cols={HIST_COLS} groups={HIST_GROUPS} rows={sorted} ctx={NO_CTX}
        label="All-time franchise records · every season played"
        rowKey={r => r.fkey} sortId={sortId} dir={dir} onSort={onSort}
        homeCol="rk" onRowClick={r => nav(lp(`/franchise/${r.fkey}`))}
        recordsOnMobile recordsClass="t3" />
      <div className="tnote screen">
        All-time spans every season the franchise has played; win % counts a tie as
        half a win. Best is the franchise's best playoff finish and the year it
        happened. A row opens the franchise page — roster, strengths, picks and
        transaction history.
      </div>
    </>
  );
}
