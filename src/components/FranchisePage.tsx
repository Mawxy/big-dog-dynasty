import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type {
  DraftPick, Drafts, Franchise, FranchiseSeason, FranchiseTx, Franchises, Insights, PlayersMin, ProjectionsFile, SleeperProjFile, SummaryRow, Team, Trade, TradesPayload,
} from "../lib/types";
import { useJson } from "../lib/useJson";
import { useCvi, useDvi } from "../lib/useIndices";
import { fmt, fmtWar, sgnWar, clsOf, ord } from "../lib/stats";
import { lineupOf, optimalLineup, pInfo, POS_COLOR, pricedLineup, rosterSeasonOf, SLOT_LABEL } from "../lib/league";
import { useLeague, useLeaguePath } from "../lib/context";
import { readTrades, tradeWhen } from "../lib/trades";
import { useMobile } from "../lib/useWidth";
import DataTable, { type Col, type Grp } from "./DataTable";
import PosBadge from "./PosBadge";
import TradeCard from "./TradeCard";
import TScroll from "./TScroll";
import { PlayerLink } from "./PlayerLink";
import QuickJump from "./QuickJump";
import TeamStrengths from "./TeamStrengths";

const POS_ORDER = ["QB", "RB", "WR", "TE"];
const posIdx = (p: string) => { const i = POS_ORDER.indexOf(p); return i < 0 ? POS_ORDER.length : i; };

interface RosterRow {
  id: string; nm: string; pos: string; nfl: string;
  age: number | null; ppg: number | null;
  dvi: number | null; cvi: number | null;
  war: number; tag: string;
}

const SECTIONS = [
  ["roster", "Roster"], ["strengths", "Strengths"], ["years", "Year by year"],
  ["draft", "Draft history"], ["trades", "Trades"], ["waivers", "Waivers"],
] as const;
type SectionKey = typeof SECTIONS[number][0];
/** old tab URLs (/franchise/:rid/:tab) land on the matching section */
const TAB_SECTION: Record<string, SectionKey> = {
  overview: "roster", draft: "draft", trades: "trades", waivers: "waivers",
};

/* ---- the two DataTable boards on this page -------------------------------
   Year by year and Waivers are LOGS, not leaderboards: one is already in the
   only order it means anything in (newest season first) and the other is a
   transaction feed. Neither declares a `sort` accessor, so no header is a
   control and DataTable rests on an order it can never leave — hence the
   constants below rather than useTableSort, which exists to hold a sort state
   these two do not have.

   The Roster and Draft-history tables on this page are NOT here; both are
   built from in-body `tr.grpband` rows and full-width `colSpan` rows, which
   DataTable has no facility for. See the notes at each one. */
const NO_SORT = () => {};
/** a shared constant, not a `{}` literal: a new object every render would
 *  defeat DataTable's row memoization (see its `sameRow`) */
const NO_CTX: Record<string, never> = {};
/** the site's em dash for a figure that does not exist — never a zero */
const nul = <span className="fig quiet">—</span>;

/* ---- year by year -------------------------------------------------------- */

/** a season with no games yet has no record, seed, PPG or WAR to report */
const hasPlayed = (s: FranchiseSeason) => s.wins + s.losses + (s.ties || 0) > 0;
const recOf = (s: FranchiseSeason) => `${s.wins}-${s.losses}${s.ties ? `-${s.ties}` : ""}`;

/** Per-render context for the season rows. `records` is how a cell knows it is
 *  drawing a phone record rather than a table row — the mode travels through
 *  ctx, never through `window` inside a renderer. `mgr` is the current
 *  manager, which the desktop Team cell names only when the season's differs. */
interface YearCtx { players: PlayersMin; mgr: string; rosterSeason: string; records: boolean }

// records-mode roles (MOBILE.md M6): the season is the spine, that year's team
// name the identity — the rename history reads there — the record is the
// headline, and finish/PPG/WAR are the three micros. Seed and the two starter
// columns are `hm`, so they leave the phone entirely.
const YEAR_COLS: Col<FranchiseSeason, YearCtx>[] = [
  {
    id: "season", label: "Season", grp: 0, w: 7, align: "t", td: "t fig strong", role: "spine",
    // the accent spine marks a title or the live season; on a table row the
    // rank spine belongs to `td.spine-cell`, which this column is not
    cell: (s, x) => x.records
      ? <>
        {(s.finish === 1 || s.season === x.rosterSeason)
          && <span className="spine" style={{ background: "var(--acc)" }} />}
        {s.season}
      </>
      : s.season,
  },
  {
    id: "team", label: "Team", grp: 0, w: 21, align: "t", td: "t sub", role: "identity",
    cell: (s, x) => x.records
      ? <>
        {s.name}
        <span className="rec-sub">
          {s.manager}{s.season === x.rosterSeason && !hasPlayed(s) ? " · live" : ""}
        </span>
      </>
      : <>{s.name}{s.manager !== x.mgr && <> · {s.manager}</>}</>,
  },
  {
    id: "rec", label: "Record", grp: 0, w: 8, align: "n", td: "n fig",
    role: "headline", microKey: "Rec",
    cell: s => hasPlayed(s) ? recOf(s) : nul,
  },
  {
    id: "seed", label: "Seed", grp: 0, w: 6, align: "n", hm: true, td: "n fig quiet hm",
    cell: s => hasPlayed(s) ? s.seed ?? "—" : "—",
  },
  {
    id: "fin", label: "Finish", grp: 0, w: 9, align: "n", td: "n fig",
    role: "micro", microKey: "Fin",
    // a placing in a dense numeric row is a tabular ordinal, gold for the
    // title — the CHAMP tag lives in the rail, and on a phone in this cell,
    // where there is no rail to carry it
    cell: (s, x) => {
      if (s.finish == null) return nul;
      if (s.finish !== 1) return ord(s.finish);
      return <span style={x.records ? { color: "var(--acc)" } : { color: "var(--acc)", fontWeight: 700 }}>
        {x.records ? "CHAMP" : ord(1)}
      </span>;
    },
  },
  {
    id: "ppg", label: "PPG", grp: 0, w: 7, align: "n", td: "n fig",
    role: "micro", microKey: "PPG",
    cell: s => hasPlayed(s) ? fmt(s.ppg, 1) : nul,
  },
  {
    id: "war", label: "Lineup WAR", grp: 1, w: 10, align: "n", edge: true, td: "n edge",
    role: "micro", microKey: "WAR",
    cell: s => hasPlayed(s) ? <span className={clsOf(s.war)}>{fmtWar(s.war)}</span> : nul,
  },
  {
    id: "top", label: "Top WAR", grp: 1, w: 16, align: "t", hm: true, td: "t sub hm",
    cell: (s, x) => s.top
      ? <><PlayerLink pid={s.top.pid} name={pInfo(x.players, s.top.pid)[0]} />{" "}
        <span className={clsOf(s.top.war)}>{fmtWar(s.top.war)}</span></>
      : "—",
  },
  {
    id: "low", label: "Low starter", grp: 1, w: 16, align: "t", hm: true, td: "t sub hm",
    cell: (s, x) => s.low
      ? <><PlayerLink pid={s.low.pid} name={pInfo(x.players, s.low.pid)[0]} />{" "}
        <span className={clsOf(s.low.war)}>{fmtWar(s.low.war)}</span></>
      : "—",
  },
];
const YEAR_GROUPS: Grp[] = [
  { id: 0, label: "", cls: "" },
  { id: 1, label: "Wins added", cls: "edge" },
];

/* ---- waivers & free agents ----------------------------------------------- */

/** a transaction plus a key: `ts` is not unique (a waiver run settles several
 *  moves on the same millisecond), so the row carries the index it was read at */
interface WaiverRow { key: string; tx: FranchiseTx }

const WAIVER_COLS: Col<WaiverRow, Record<string, never>>[] = [
  {
    id: "when", label: "When", grp: 0, w: 10, align: "t", td: "t fig quiet",
    cell: r => `${r.tx.season} W${r.tx.week}`,
  },
  {
    id: "type", label: "Type", grp: 0, w: 9, align: "t", td: "t fig quiet",
    cell: r => r.tx.type === "waiver" ? "WAIVER" : "FA",
  },
  // a move can name half a dozen players, so these two wrap where every other
  // cell on the site does not — `white-space` on the inline box re-enables
  // breaking inside a `nowrap` cell
  {
    id: "adds", label: "Added", grp: 0, w: 40, align: "t", td: "t sub",
    cell: r => <span style={{ whiteSpace: "normal", color: "var(--good)" }}>
      {r.tx.adds?.length ? r.tx.adds.join(", ") : "—"}
    </span>,
  },
  {
    id: "drops", label: "Dropped", grp: 0, w: 41, align: "t", td: "t sub",
    cell: r => <span style={{ whiteSpace: "normal", color: "var(--drop)" }}>
      {r.tx.drops?.length ? r.tx.drops.join(", ") : "—"}
    </span>,
  },
];
/** four columns, nothing to band — the group row carries no label rather than
 *  inventing one (SKILL §3: band a table past about seven columns) */
const WAIVER_GROUPS: Grp[] = [{ id: 0, label: "", cls: "" }];

/**
 * Franchise page (1C): split rail. The rail carries the season ladder — one
 * row per season with that year's team name on the second line, which is
 * where the rename history reads — and the content column carries the figure
 * strip, the outlook, and every section as bands on one page.
 */
export default function FranchisePage({ fkey, players, tab }:
  { fkey: string; players: PlayersMin; tab?: string }) {
  const { meta, league } = useLeague();
  const nav = useNavigate();
  const lp = useLeaguePath();
  // MOBILE.md M6 — the rail becomes a header, the ladder reads at the foot of
  // the page, and every table section renders as records
  const mobile = useMobile();
  const rosterSeason = rosterSeasonOf(league);

  /* ---- the page's ten files ---------------------------------------------
     One `useJson` per file, each keyed on its own resolved path. This was a
     single effect over [rid, rosterSeason, viewSeason] that re-ran ALL ten
     chains — franchises, insights, drafts, trades, teams, summary,
     projections, sleeper, dvi, cvi — every time the reader clicked a year in
     the rail's ladder, although only teams.json and summary.json are scoped
     to that year. The split is now per file rather than per effect: the eight
     league-wide files are fetched once for the life of the mount (the route
     keys FranchisePage on `rid`, so a different franchise is a fresh mount)
     and only the two season files re-fetch on a ladder click.

     `useJson` also clears its state IN RENDER when the path changes, which is
     what stops a frame pairing last season's summary with this season's
     roster — the guard in the roster memo below only ever caught the null. */
  const frFile = useJson<Franchises>("franchises.json");

  /* franchises.json is resolved FIRST, ahead of the rest of the list, because
     the two season-scoped fetches below are keyed on a season this franchise
     has to actually have. */

  /** Resolve the route key against the franchise map. A legacy
   *  /franchise/<rid> link into an OWNER-keyed league (redraft: franchise =
   *  person, keys are user_ids) resolves to whoever held that roster slot
   *  most recently, so old bookmarks and rid-shaped redirects keep landing. */
  const resolvedKey = useMemo(() => {
    const m = frFile.data;
    if (!m || m[fkey]) return fkey;
    if (/^\d{1,3}$/.test(fkey)) {
      const rid = Number(fkey);
      let best: string | null = null, bestSeason = "";
      for (const [k, f] of Object.entries(m))
        for (const sn of f.seasons)
          if (sn.rid === rid && sn.season > bestSeason) { best = k; bestSeason = sn.season; }
      if (best) return best;
    }
    return fkey;
  }, [frFile.data, fkey]);

  /** undefined while franchises.json is in flight, null once it has settled
   *  with no entry for this key — the two drive different empty states */
  const fr: Franchise | null | undefined = frFile.data
    ? frFile.data[resolvedKey] ?? null
    : frFile.error ? null : undefined;

  /** Which season's roster the Roster band shows. Null until the ladder sets
   *  it, so the default can follow the franchise once it resolves.
   *
   *  THE DEFAULT IS NOT ALWAYS THE ROSTER SEASON. In an owner-keyed league a
   *  departed manager's franchise lists the seasons he played and nothing
   *  else, so pinning the view to the current roster season left `rid` null,
   *  `team` null and the Roster band reading "Loading roster…" for a load that
   *  was never coming — while the figure strip printed a lineup WAR for a
   *  season this franchise was not in. Defaulting to the newest season it
   *  actually has puts the page on a year the ladder can also mark. */
  const [picked, setPicked] = useState<string | null>(null);
  const viewSeason = picked
    ?? (fr && !fr.seasons.some(sn => sn.season === rosterSeason)
      ? fr.seasons[fr.seasons.length - 1]?.season ?? rosterSeason
      : rosterSeason);

  const insights = useJson<Insights>("insights.json").data;
  const drafts = useJson<Drafts>("drafts.json").data;
  const tradesFile = useJson<TradesPayload>("trades.json");
  const teamsFile = useJson<Team[]>(`${viewSeason}/teams.json`);
  const projFile = useJson<ProjectionsFile>("projections.json");
  const sprojFile = useJson<SleeperProjFile>("proj_sleeper.json");
  // the daily pair, and the scope has to match what the rest of the site uses
  // for the same file or the cache downloads it twice (useJson.ts)
  // model-aware: these follow the masthead's projection-model control
  const dvi = useDvi();
  const cvi = useCvi();
  // A past roster is priced in what those players ACTUALLY did that year, not
  // in today's projection: 2022's roster carries 2022 WAR and 2022 PPG. DVI
  // and CVI are current-market indices with no historical series, so they
  // read — - see the Roster band's note. On the roster season there is no
  // summary to read, and `null` is how useJson is told there is nothing yet.
  const onRosterSeason = viewSeason === rosterSeason;
  const summaryFile = useJson<SummaryRow[]>(
    onRosterSeason ? null : `${viewSeason}/summary.json`);

  /** The roster slot this franchise held in `season` — the join key for every
   *  per-season file. Constant for dynasty (franchise = slot, and the numeric
   *  key itself is the fallback for data built before seasons carried `rid`);
   *  varies by season for redraft (franchise = owner). */
  const ridOf = useCallback((season: string): number | null =>
    fr?.seasons.find(sn => sn.season === season)?.rid
    ?? (/^\d{1,3}$/.test(resolvedKey) ? Number(resolvedKey) : null),
    [fr, resolvedKey]);
  /** the slot in the season being VIEWED (drives roster/summary joins) */
  const rid = ridOf(viewSeason);
  /** the slot held right now (drives strengths + insight) */
  const curRid = ridOf(rosterSeason);

  const picks = useMemo<DraftPick[]>(() => {
    if (!drafts) return [];
    // owner-keyed data: gather (season, rid) pairs; rid-keyed or pre-rid
    // data: the key IS the rid bucket
    if (fr?.seasons?.some(sn => sn.rid != null)) {
      const out: DraftPick[] = [];
      for (const sn of fr.seasons)
        if (sn.rid != null)
          for (const pk of drafts[String(sn.rid)] ?? [])
            if (pk.season === sn.season) out.push(pk);
      return out;
    }
    return drafts[resolvedKey] ?? [];
  }, [drafts, fr, resolvedKey]);
  const draftSeasons = useMemo(() => {
    if (!drafts) return [];
    const all = new Set<string>();
    for (const list of Object.values(drafts))
      for (const p of list) if (p.kind === "rookie") all.add(p.season);
    return [...all].sort((a, b) => b.localeCompare(a));
  }, [drafts]);

  /** null until trades.json settles — the section reads "Loading trades…" */
  const trades = useMemo<Trade[] | null>(() => {
    if (tradesFile.error) return [];
    if (!tradesFile.data) return null;
    // per-trade join: the slot this franchise held in the TRADE's season —
    // a redraft owner's rid can differ year to year
    return readTrades(tradesFile.data).trades.filter(
      t => t.sides.some(s => s.rid === ridOf(t.season)));
  }, [tradesFile.data, tradesFile.error, ridOf]);

  const team = useMemo<Team | null>(
    () => teamsFile.data?.find(t => t.roster_id === rid) ?? null, [teamsFile.data, rid]);

  /** played-season actuals for viewSeason; null while on the roster season */
  const actual = useMemo<Map<string, { war: number; ppg: number }> | null>(() => {
    if (onRosterSeason) return null;
    if (summaryFile.error) return new Map();
    if (!summaryFile.data) return null;
    return new Map(summaryFile.data.map(r => [r[0], { war: r[6], ppg: r[4] }]));
  }, [onRosterSeason, summaryFile.data, summaryFile.error]);

  const proj = useMemo<Map<string, { war: number; age: number }> | null>(() => {
    if (projFile.error) return new Map();
    if (!projFile.data) return null;
    return new Map(projFile.data.players.map(
      r => [r.pid, { war: r.composite?.[0] ?? 0, age: r.age }]));
  }, [projFile.data, projFile.error]);

  /** a missing sleeper projection file is an empty map, not an error state */
  const sppg = useMemo(
    () => new Map(Object.entries(sprojFile.data?.players ?? {}).map(([pid, x]) => [pid, x.ppg])),
    [sprojFile.data]);

  const refs = useRef<Record<SectionKey, HTMLDivElement | null>>({
    roster: null, strengths: null, years: null, draft: null, trades: null, waivers: null,
  });
  const goto = (k: SectionKey) =>
    refs.current[k]?.scrollIntoView({ behavior: "smooth", block: "start" });
  // pre-restructure tab URLs scroll to their section once content exists
  const scrolled = useRef(false);
  useEffect(() => {
    if (scrolled.current || !tab || !fr) return;
    const k = TAB_SECTION[tab];
    if (k) { scrolled.current = true; setTimeout(() => goto(k), 60); }
  }, [tab, fr]);

  /** roster rows with everything a row needs, priced in every currency */
  const roster = useMemo(() => {
    if (!team) return null;
    // teams.json and summary.json land on separate promises; without this the
    // table flashes one season's roster priced in the other season's numbers
    if (viewSeason !== rosterSeason && !actual) return null;
    const rows: RosterRow[] = team.players.map(pid => {
      const [nm, pos, nfl] = pInfo(players, pid);
      const pj = proj?.get(pid);
      const act = actual?.get(pid);
      // projections.json ages to the roster season, so a past roster walks the
      // age BACK to the season being viewed rather than printing today's
      const back = Number(rosterSeason) - Number(viewSeason);
      return {
        id: pid, nm, pos, nfl,
        age: pj?.age == null ? null : pj.age - (actual ? back : 0),
        ppg: (actual ? act?.ppg : sppg.get(pid)) ?? null,
        // no historical index series exists — never fabricate one
        dvi: actual ? null : dvi?.players[pid]?.dvi ?? null,
        cvi: actual ? null : cvi?.players[pid]?.cvi ?? null,
        war: (actual ? act?.war : pj?.war) ?? 0,
        tag: team.taxi.includes(pid) ? "TAXI" : team.reserve.includes(pid) ? "IR" : "",
      };
    });
    const lineup = lineupOf(meta);
    // taxi and IR players can't start, so they never enter the lineup pool
    const eligible = rows.filter(r => r.tag !== "TAXI" && r.tag !== "IR");
    const { slots, starters } = optimalLineup(eligible, lineup);
    const benched = rows.filter(r => !starters.has(r.id))
      .sort((a, b) => posIdx(a.pos) - posIdx(b.pos) || b.war - a.war);
    const bench = benched.filter(r => r.tag !== "TAXI");
    const taxi = benched.filter(r => r.tag === "TAXI");
    const startTot = slots.reduce((s, x) => s + (x.player?.war ?? 0), 0);
    const warMax = Math.max(0.01, ...rows.map(r => r.war));
    return { rows, slots, bench, taxi, startTot, warMax };
  }, [team, players, proj, sppg, dvi, cvi, meta, actual, rosterSeason, viewSeason]);

  /** starters/roster totals in an index currency (lineup optimized in it) */
  const indexTotals = useMemo(() => {
    if (!team) return null;
    const priced = <V extends { pos: string }>(
      idx: Record<string, V> | undefined, of: (pid: string, row: V) => number,
    ) => {
      if (!idx) return null;
      const { starters, roster } = pricedLineup(team, idx, of, lineupOf(meta));
      return { s: starters, t: roster };
    };
    return {
      dvi: priced(dvi?.players, (_p, r) => r.dvi),
      cvi: priced(cvi?.players, (_p, r) => r.cvi),
    };
  }, [team, dvi, cvi, meta]);

  /* ---- the two DataTable boards' rows and context ------------------------
     Built up here, above the early returns, because they are hooks: the guards
     below bail on a franchise that hasn't loaded, and a hook can't sit after
     one. `rows` and `ctx` are both memoized, which is what DataTable's
     memoized Row needs — a fresh array or a `{}` literal per render would
     re-run every cell of every row on every keystroke elsewhere on the page. */
  // A franchise row with no seasons is a legal shape in franchises.json (an
  // expansion entry, a roster added mid-offseason) and every read below assumes
  // a last one — `latest.name` on undefined threw and took the SPA with it.
  const seasons = useMemo(() => fr?.seasons ?? [], [fr]);
  /** newest first — the ladder's order, and the only one this log means
   *  anything in, which is why no column here declares a sort */
  const yearRows = useMemo(() => seasons.slice().reverse(), [seasons]);
  const yearCtx = useMemo<YearCtx>(() => ({
    players, rosterSeason, records: mobile,
    mgr: seasons[seasons.length - 1]?.manager ?? "",
  }), [players, rosterSeason, mobile, seasons]);

  /** the transaction log, trades excluded — they have their own section */
  const waiverRows = useMemo<WaiverRow[]>(
    () => (fr?.tx ?? []).slice().sort((a, b) => b.ts - a.ts)
      .filter(t => t.type !== "trade")
      .map((tx, i) => ({ key: `${tx.ts}-${i}`, tx })),
    [fr]);

  if (fr === undefined) return <div className="empty">Loading franchise…</div>;
  if (!fr) return <div className="empty">No franchise history found.</div>;
  if (!seasons.length) return <div className="empty">No seasons recorded for this franchise yet.</div>;
  const latest = seasons[seasons.length - 1];
  const all = seasons.reduce(
    (a, s) => ({ w: a.w + s.wins, l: a.l + s.losses, t: a.t + (s.ties || 0) }),
    { w: 0, l: 0, t: 0 });
  const games = all.w + all.l + all.t;
  const champYears = seasons.filter(s => s.finish === 1).map(s => s.season);
  const insight = curRid != null ? insights?.teams[String(curRid)] ?? null : null;

  // "" rather than the newest LISTED season, so this is NOT latestSeasonOf:
  // a listed-but-unplayed season is not a last season played.
  const lastPlayed = meta.latest && meta.seasons.includes(meta.latest)
    ? meta.latest : "";
  /** a rookie class with no played season yet returns —, never 0.00 */
  const unplayed = (season: string) => !lastPlayed || season > lastPlayed;

  const rookiePicks = picks.filter(p => p.kind === "rookie");
  const bySeason = new Map<string, DraftPick[]>();
  for (const p of rookiePicks) {
    const arr = bySeason.get(p.season);
    if (arr) arr.push(p); else bySeason.set(p.season, [p]);
  }
  for (const arr of bySeason.values()) arr.sort((a, b) => a.pick_no - b.pick_no);
  const draftYears = draftSeasons.length ? draftSeasons
    : [...bySeason.keys()].sort((a, b) => b.localeCompare(a));
  const keptTotal = (arr: DraftPick[]) =>
    arr.reduce((s, p) => s + (p.traded ? 0 : p.war ?? 0), 0);
  const kept = (arr: DraftPick[]) => arr.filter(p => !p.traded).length;

  const myTrades = (trades ?? []).slice().sort((a, b) => b.ts - a.ts)
    .map(t => {
      const trid = ridOf(t.season);
      return {
        ...t,
        sides: [...t.sides].sort((a, b) => Number(b.rid === trid) - Number(a.rid === trid)),
      };
    });

  const rosterCell = (r: RosterRow, slot: string, warMax: number) => (
    <>
      <td className="t fig quiet">{slot}</td>
      <td className="t name">
        <PlayerLink pid={r.id} name={r.nm} />
        {r.tag === "IR" && <span className="name-note">IR</span>}
      </td>
      <td className="c"><PosBadge pos={r.pos} /></td>
      <td className="c fig quiet">{r.nfl || "—"}</td>
      <td className="n fig quiet">{r.age ?? "—"}</td>
      <td className="n fig">{r.ppg == null ? "—" : fmt(r.ppg, 1)}</td>
      <td className="n fig edge">{r.dvi == null ? "—" : fmt(r.dvi, 1)}</td>
      <td className="n fig">{r.cvi == null ? "—" : fmt(r.cvi, 1)}</td>
      <td className="n last edge">
        <div className="meter-row">
          <div className="meter"><i style={{ width: `${Math.round(Math.max(0, r.war) / warMax * 100)}%` }} /></div>
          <span className="fig">{fmtWar(r.war)}</span>
        </div>
      </td>
    </>
  );

  const rosterHead = (
    <tr>
      <th scope="col" className="t" style={{ width: "6%" }}>Slot</th>
      <th scope="col" className="t" style={{ width: "24%" }}>Player</th>
      <th scope="col" className="c" style={{ width: "7%" }}>Pos</th>
      <th scope="col" className="c" style={{ width: "7%" }}>NFL</th>
      <th scope="col" className="n" style={{ width: "6%" }}>Age</th>
      <th scope="col" className="n" style={{ width: "8%" }}>PPG</th>
      <th scope="col" className="n edge" style={{ width: "9%" }}>DVI</th>
      <th scope="col" className="n" style={{ width: "9%" }}>CVI</th>
      {/* a header must label its own column: a played season is realized WAR */}
      <th scope="col" className="n key edge" style={{ width: "24%" }}>{actual ? `${viewSeason} WAR` : "Proj WAR"}</th>
    </tr>
  );

  const grpband = (label: string, note: string | null, tot: string | null) => (
    <tr className="grpband">
      <th scope="colgroup" colSpan={9}>
        <div>
          <span>{label}</span>
          {note && <span className="note">{note}</span>}
          {tot != null && <span className="tot">{tot}</span>}
        </div>
      </th>
    </tr>
  );

  /* ---- records mode (MOBILE.md M6) ---------------------------------------
     The roster as two-line records: slot label in the spine cell, Proj WAR as
     the named headline, DVI · CVI spelled out on line two. Group bands keep
     their totals — all three figures labeled, since a phone has no column
     headers to name them. */
  const groupTot = (rs: RosterRow[]) =>
    `WAR ${fmtWar(rs.reduce((s, r) => s + r.war, 0))}`
    + ` · DVI ${fmt(rs.reduce((s, r) => s + (r.dvi ?? 0), 0), 0)}`
    + ` · CVI ${fmt(rs.reduce((s, r) => s + (r.cvi ?? 0), 0), 0)}`;

  const mBand = (label: string, note: string) => (
    <div className="band">
      <span className="band-label">{label}</span>
      <span className="band-note">{note}</span>
    </div>
  );

  const rosterRec = (r: RosterRow, slot: string, i: number) => (
    <div key={r.id} className={`rec${i % 2 ? " zebra" : ""}`}>
      <div className="rec-l1">
        <span className="rec-rk">
          <span className="spine" style={{ background: POS_COLOR[r.pos] || "var(--rule-2)" }} />
          {slot}
        </span>
        <span className="rec-id">
          <PlayerLink pid={r.id} name={r.nm} />
          {r.tag === "IR" && <span className="name-note">IR</span>}
          <span className="rec-sub">
            {r.pos} · {r.nfl || "—"}{r.age != null && <> · age {r.age}</>}
          </span>
        </span>
        <span className="rec-fig">{fmtWar(r.war)}</span>
        <span className="rec-key">{actual ? `${viewSeason} WAR` : "Proj WAR"}</span>
      </div>
      <div className="rec-l2">
        <span className="mic"><span className="mk">DVI</span>
          <span className="mv">{r.dvi == null ? <span className="quiet">—</span> : fmt(r.dvi, 1)}</span></span>
        <span className="mic"><span className="mk">CVI</span>
          <span className="mv">{r.cvi == null ? <span className="quiet">—</span> : fmt(r.cvi, 1)}</span></span>
      </div>
    </div>
  );

  return (
    <>
      <div className="screen-head">
        <span className="screen-title">Franchise</span>
        <QuickJump />
      </div>
      <div className="board" style={{ marginTop: 0 }}>
        <div className="split">
          <div className="rail">
            <span className="rail-back" onClick={() => nav(lp("/teams"))}>← Teams</span>
            <div className="rail-name">{latest.name}</div>
            <div className="rail-sub">{latest.manager}</div>

            {/* the ladder does not fit above the roster on a phone — its
                content reads in the Year-by-year records at the foot */}
            {!mobile && <>
              <div className="rail-h">Seasons</div>
              <div className="rail-ladder">
                {seasons.slice().reverse().map(s => (
                  // The accent rule marks WHERE YOU ARE, nothing else. It used
                  // to mark champions too, which made a title indistinguishable
                  // from the selected row — the CHAMP tag already says champion.
                  <div key={s.season} role="button" tabIndex={0}
                    className={`rail-season pick${s.season === viewSeason ? " mark" : ""}`}
                    onClick={() => setPicked(s.season)}
                    onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setPicked(s.season); } }}>
                    <div className="l1">
                      <span className="yr">{s.season}</span>
                      <span className="fin" style={s.finish === 1 ? { color: "var(--acc)" } : undefined}>
                        {s.finish === 1 ? "CHAMP" : s.finish != null ? ord(s.finish) : s.season === rosterSeason ? "live" : "—"}
                      </span>
                      <span className="rec">{s.wins}-{s.losses}{s.ties ? `-${s.ties}` : ""}</span>
                    </div>
                    <div className="tname">{s.name}</div>
                  </div>
                ))}
              </div>
            </>}

            {/* the horizontal section strip needs no header on a phone */}
            {!mobile && <div className="rail-h">On this page</div>}
            <div className="rail-nav">
              {SECTIONS.map(([k, label]) => (
                <button key={k} onClick={() => goto(k)}>{label}</button>
              ))}
            </div>
          </div>

          <div className="main">
            <div className="figstrip">
              <div className="figcell">
                <div className="figkey">All-time record</div>
                <div className="figval">{all.w}-{all.l}{all.t ? `-${all.t}` : ""}</div>
                <div className="figsub">{games ? `${fmt((all.w + all.t / 2) / games * 100, 1)}% · ${seasons.length} seasons` : "no games"}</div>
              </div>
              <div className="figcell">
                <div className="figkey">Titles</div>
                <div className="figval">{champYears.length}</div>
                <div className="figsub">{champYears.length ? champYears.join(" · ") : "none yet"}</div>
              </div>
              <div className="figcell">
                <div className="figkey">{viewSeason} lineup WAR</div>
                <div className="figval">{roster ? fmtWar(roster.startTot) : "—"}</div>
                <div className="figsub">{actual ? "realized, best legal lineup" : "projected, best legal lineup"}</div>
              </div>
              <div className="figcell">
                <div className="figkey">Starters DVI</div>
                <div className="figval">{indexTotals?.dvi ? fmt(indexTotals.dvi.s, 0) : "—"}</div>
                <div className="figsub">{indexTotals?.dvi ? `Roster DVI ${fmt(indexTotals.dvi.t, 0)}` : "no index"}</div>
              </div>
              <div className="figcell">
                <div className="figkey">Starters CVI</div>
                <div className="figval">{indexTotals?.cvi ? fmt(indexTotals.cvi.s, 0) : "—"}</div>
                <div className="figsub">{indexTotals?.cvi ? `Roster CVI ${fmt(indexTotals.cvi.t, 0)}` : "no index"}</div>
              </div>
            </div>

            {insight && (
              <div className="verdict">
                <div className="k">{insights?.meta.season} outlook</div>
                <div className="meta">{insight.head} · written {insights?.meta.generated}</div>
                <div className="body">{insight.text}</div>
              </div>
            )}

            {/* ---- roster ----
                HAND-ROLLED, deliberately. DataTable draws one <tr> per row out
                of the column registry and nothing else; this table's whole
                anatomy is the three things it cannot draw:
                  · `tr.grpband` section rows — Starting lineup / Bench / Taxi
                    squad, each a <th colSpan={9}> carrying the section's own
                    WAR total. DataTable's `Grp` is a COLUMN banner in <thead>,
                    a different object: it bands columns side to side, not rows
                    top to bottom, and there is no hook to interleave a row.
                  · full-width rows — an unfilled lineup slot is one
                    <td colSpan={9}>, and a cell renderer has no colSpan.
                  · one <tbody> holding three ordered sections rather than one
                    sorted population.
                Expressing it would mean adding a band-row facility to
                DataTable, which is frozen. Same story for Draft history
                below. */}
            <div ref={el => { refs.current.roster = el; }}>
              <div className="band">
                <span className="band-label">Roster · {viewSeason}</span>
                <span className="band-note">{actual
                  ? `Best legal lineup by WAR actually produced in ${viewSeason}, not the lineup as set · DVI and CVI are current-market indices with no historical series`
                  : "Best legal lineup by projected WAR, not the lineup as set"}</span>
              </div>
              {/* "Loading roster…" is a claim that something is still coming.
                  It only is while the season's teams.json is in flight — once
                  that file has settled with no row for this slot there is no
                  roster to wait for, and the band says so instead of hanging. */}
              {!roster ? (
                teamsFile.error
                  ? <div className="empty">Couldn't load the {viewSeason} roster.</div>
                  : teamsFile.data && !team
                    ? <div className="empty">No roster recorded for {viewSeason}.</div>
                    : <div className="empty">Loading roster…</div>
              ) : mobile ? (
                <div className="records wrk">
                  {mBand("Starting lineup",
                    groupTot(roster.slots.flatMap(s => s.player ? [s.player as RosterRow] : [])))}
                  {roster.slots.map((s, i) => s.player
                    ? rosterRec(s.player as RosterRow, SLOT_LABEL[s.slot] ?? s.slot, i)
                    : (
                      <div key={`${s.slot}-${i}`} className={`rec${i % 2 ? " zebra" : ""}`}>
                        <div className="rec-l1">
                          <span className="rec-rk">{SLOT_LABEL[s.slot] ?? s.slot}</span>
                          <span className="rec-id" style={{ color: "var(--dim)", fontWeight: 400 }}>empty</span>
                        </div>
                      </div>
                    ))}
                  {mBand("Bench", groupTot(roster.bench))}
                  {roster.bench.map((r, i) => rosterRec(r, "BN", i))}
                  {roster.taxi.length > 0 && mBand("Taxi squad", groupTot(roster.taxi))}
                  {roster.taxi.map((r, i) => rosterRec(r, "TX", i))}
                </div>
              ) : (
                <TScroll>
                <table style={{ tableLayout: "fixed" }}>
                  <thead>{rosterHead}</thead>
                  <tbody>
                    {grpband("Starting lineup", "best legal lineup by projected WAR", fmtWar(roster.startTot))}
                    {roster.slots.map((s, i) => (
                      <tr key={`${s.slot}-${i}`} className={i % 2 ? "zebra" : ""}>
                        {s.player
                          ? rosterCell(s.player as RosterRow, SLOT_LABEL[s.slot] ?? s.slot, roster.warMax)
                          : <td colSpan={9} className="t fig quiet">{SLOT_LABEL[s.slot] ?? s.slot} — empty</td>}
                      </tr>
                    ))}
                    {grpband("Bench", null,
                      fmtWar(roster.bench.reduce((s, r) => s + r.war, 0)))}
                    {roster.bench.map((r, i) => (
                      <tr key={r.id} className={i % 2 ? "zebra" : ""}>{rosterCell(r, "BN", roster.warMax)}</tr>
                    ))}
                    {roster.taxi.length > 0 && grpband("Taxi squad", null,
                      fmtWar(roster.taxi.reduce((s, r) => s + r.war, 0)))}
                    {roster.taxi.map((r, i) => (
                      <tr key={r.id} className={i % 2 ? "zebra" : ""}>{rosterCell(r, "TAXI", roster.warMax)}</tr>
                    ))}
                  </tbody>
                </table>
                </TScroll>
              )}
            </div>

            {/* ---- strengths ---- */}
            <div ref={el => { refs.current.strengths = el; }}>
              <div className="band">
                <span className="band-label">Strengths</span>
                <span className="band-note">Each seat ranked against the same seat on the other eleven rosters</span>
              </div>
              <div style={{ padding: "6px 22px 16px" }}>
                {curRid != null && <TeamStrengths rid={curRid} />}
              </div>
            </div>

            {/* ---- year by year ---- */}
            <div ref={el => { refs.current.years = el; }}>
              <div className="band">
                <span className="band-label">Year by year</span>
                <span className="band-note">Lineup WAR sums each week's actual starters against the league-wide optimal pool</span>
              </div>
              {/* On a phone this is the season ladder's home — the rail drops
                  it, and DataTable's records mode draws the same two-line
                  record the hand-rolled branch here used to: the year in the
                  spine cell, that year's team name as the identity, so the
                  rename history still reads here. Nothing in it sorts: a
                  season log is already in its only meaningful order. */}
              <DataTable cols={YEAR_COLS} groups={YEAR_GROUPS} rows={yearRows} ctx={yearCtx}
                label="Year by year" rowKey={s => s.season}
                sortId="" dir={-1} onSort={NO_SORT}
                recordsOnMobile recordsClass="wrk t3" />
            </div>

            {/* ---- draft history ----
                HAND-ROLLED, for the same reason as the roster and two more: a
                `tr.grpband` per rookie class, a full-width "no picks — traded
                away" row, a per-ROW `opacity` on the traded picks and a
                row-dependent <td> class list (`clsOf` when the pick played,
                `fig quiet` when it did not). `Col.td` is one static string and
                `Row` takes no per-row class or style. */}
            <div ref={el => { refs.current.draft = el; }}>
              <div className="band">
                <span className="band-label">Draft history</span>
                <span className="band-note">Rookie drafts only · vs = realized minus expected WAR for the slot, over the same seasons</span>
              </div>
              {!draftYears.length ? <div className="empty">No drafts yet.</div> : mobile ? (
                /* one records list per class under a season band carrying the
                   class WAR — an unplayed class prints — for every pick AND
                   for the total, never 0.00 */
                <div className="records wrk">
                  {draftYears.map(season => {
                    const rows = bySeason.get(season) ?? [];
                    const np = unplayed(season);
                    return (
                      <Fragment key={season}>
                        <div className="band">
                          <span className="band-label">{season} rookie draft</span>
                          <span className="band-note">
                            {kept(rows)} pick{kept(rows) === 1 ? "" : "s"}
                            {rows.length - kept(rows) > 0 && ` · ${rows.length - kept(rows)} traded away`}
                            {" · "}{np ? "not yet played" : `${fmtWar(keptTotal(rows))} WAR returned`}
                          </span>
                        </div>
                        {rows.length === 0 && <div className="empty">no picks — traded away</div>}
                        {rows.map((p, i) => (
                          <div key={`${p.season}-${p.pick_no}-${p.traded ? "t" : "m"}`}
                            className={`rec${i % 2 ? " zebra" : ""}`}
                            style={p.traded ? { opacity: 0.55 } : undefined}>
                            <div className="rec-l1">
                              <span className="rec-rk">
                                <span className="spine" style={{ background: POS_COLOR[p.pos] || "var(--rule-2)" }} />
                                {p.slot}
                              </span>
                              <span className="rec-id">
                                <PlayerLink pid={p.pid} name={p.name} />
                                <span className="rec-sub">{p.pos}{p.traded ? " · traded away" : ""}</span>
                              </span>
                              <span className="rec-fig">
                                {np ? <span className="quiet">—</span> : fmtWar(p.war)}
                              </span>
                              <span className="rec-key">WAR</span>
                            </div>
                            {!np && p.diff != null && (
                              <div className="rec-l2">
                                <span className="mic"><span className="mk">Vs slot</span>
                                  <span className={`mv ${clsOf(p.diff)}`}>{sgnWar(p.diff)}</span></span>
                              </div>
                            )}
                          </div>
                        ))}
                      </Fragment>
                    );
                  })}
                </div>
              ) : (
                <TScroll>
                <table style={{ tableLayout: "fixed" }}>
                  <thead>
                    <tr>
                      <th scope="col" className="t" style={{ width: "8%" }}>Pick</th>
                      <th scope="col" className="t" style={{ width: "24%" }}>Player</th>
                      <th scope="col" className="c" style={{ width: "7%" }}>Pos</th>
                      <th scope="col" className="n" style={{ width: "9%" }}>WAR</th>
                      <th scope="col" className="n hm" style={{ width: "10%" }}>On roster</th>
                      <th scope="col" className="n hm" style={{ width: "10%" }}>Expected</th>
                      <th scope="col" className="n" style={{ width: "8%" }}>Vs</th>
                      <th scope="col" className="t hm" style={{ width: "24%" }}>Better available</th>
                    </tr>
                  </thead>
                  <tbody>
                    {draftYears.map(season => {
                      const rows = bySeason.get(season) ?? [];
                      const np = unplayed(season);
                      return (
                        <Fragment key={season}>
                          <tr className="grpband">
                            <th scope="colgroup" colSpan={8}>
                              <div>
                                <span>{season} rookie draft</span>
                                <span className="note">
                                  {kept(rows)} pick{kept(rows) === 1 ? "" : "s"}
                                  {rows.length - kept(rows) > 0 && ` · ${rows.length - kept(rows)} traded away`}
                                </span>
                                <span className="tot">
                                  {np ? "not yet played" : `${fmtWar(keptTotal(rows))} WAR returned`}
                                </span>
                              </div>
                            </th>
                          </tr>
                          {rows.length === 0 && (
                            <tr><td colSpan={8} className="t fig quiet">no picks — traded away</td></tr>
                          )}
                          {rows.map((p, i) => (
                            <tr key={`${p.season}-${p.pick_no}-${p.traded ? "t" : "m"}`}
                              className={i % 2 ? "zebra" : ""}
                              style={p.traded ? { opacity: 0.55 } : undefined}>
                              <td className="t fig strong">{p.slot}</td>
                              <td className="t name">
                                <PlayerLink pid={p.pid} name={p.name} />
                                {p.traded && <span className="name-note">traded</span>}
                              </td>
                              <td className="c"><PosBadge pos={p.pos} /></td>
                              <td className={`n ${np || p.traded ? "fig quiet" : clsOf(p.war)}`}>
                                {np ? "—" : fmtWar(p.war)}</td>
                              <td className={`n hm ${np || p.traded ? "fig quiet" : clsOf(p.war_roster ?? 0)}`}>
                                {np || p.traded ? "—" : fmtWar(p.war_roster ?? 0)}</td>
                              <td className="n hm fig quiet">{p.expected == null ? "—" : fmtWar(p.expected)}</td>
                              <td className={`n ${np || p.diff == null ? "fig quiet" : clsOf(p.diff)}`}>
                                {np || p.diff == null ? "—" : sgnWar(p.diff)}</td>
                              <td className="t sub hm last"
                                title={p.alts.map(a => `${a.name} (pick ${a.pick_no}) ${fmtWar(a.war)}`).join(" · ")}>
                                {np || p.alts.length === 0 ? "—"
                                  : p.alts.slice(0, 2).map(a => `${a.name} ${fmtWar(a.war)}`).join(", ")}
                              </td>
                            </tr>
                          ))}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
                </TScroll>
              ) /* mobile branch above */}
            </div>

            {/* ---- trades ---- */}
            <div ref={el => { refs.current.trades = el; }}>
              <div className="band">
                <span className="band-label">Trades</span>
                <span className="band-note">Each side scored on the WAR its return produced after the trade · both sides in the same neutral ink</span>
              </div>
              <div className="ledger" style={{ paddingTop: 14 }}>
                {!trades ? <div className="empty">Loading trades…</div>
                  : !myTrades.length ? <div className="empty">No trades yet.</div>
                    : myTrades.map((t, i) => (
                      <TradeCard key={`${t.ts}-${i}`} trade={t} players={players}
                        when={tradeWhen(t.ts)} sideFig="realized" />
                    ))}
              </div>
            </div>

            {/* ---- waivers ---- */}
            <div ref={el => { refs.current.waivers = el; }}>
              <div className="band">
                <span className="band-label">Waivers &amp; free agents</span>
                <span className="band-note">Trades live in their own section</span>
              </div>
              {!waiverRows.length ? <div className="empty">No moves yet.</div> : mobile ? (
                /* NOT DataTable's records mode. A move is one dateline over a
                   `+ added` / `− dropped` pair of full-width `.rec-line`s, and
                   Records only emits the two-line record — identity, headline
                   figure, a grid of labeled micros. Squeezing six names into a
                   micro cell is not the same object, so this branch stays
                   hand-rolled; the desktop table below is the DataTable. */
                <div className="records flat">
                  {waiverRows.map(({ key, tx }, i) => (
                    <div key={key} className={`rec${i % 2 ? " zebra" : ""}`}>
                      <div className="rec-l1">
                        <span className="rec-id" style={{ font: "600 11px/1.4 var(--cond)", letterSpacing: ".12em", textTransform: "uppercase", color: "var(--dim)" }}>
                          {tx.season} W{tx.week} · {tx.type === "waiver" ? "waiver" : "free agent"}
                        </span>
                      </div>
                      {!!tx.adds?.length && (
                        <div className="rec-line" style={{ color: "var(--good)" }}>+ {tx.adds.join(", ")}</div>
                      )}
                      {!!tx.drops?.length && (
                        <div className="rec-line" style={{ color: "var(--drop)" }}>− {tx.drops.join(", ")}</div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <DataTable cols={WAIVER_COLS} groups={WAIVER_GROUPS} rows={waiverRows} ctx={NO_CTX}
                  label="Waivers and free agents" rowKey={r => r.key}
                  sortId="" dir={-1} onSort={NO_SORT} />
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
