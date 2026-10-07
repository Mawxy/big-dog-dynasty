import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type {
  Absences, Matchups, Ownership, PlayerShard, RecentAsset, RecentTrades, Team,
  Values, Weekly, WeeklyRow,
} from "../lib/types";
import { jl } from "../lib/data";
import { useJson } from "../lib/useJson";
import { useCvi, useDvi } from "../lib/useIndices";
import type { InSeason } from "../lib/outlook";
import { isInSeason, outlookLabel, outlookNote, weeksLeft } from "../lib/outlook";
import { fmt, sgn } from "../lib/stats";
// WAR at the beta shell's two places (Max, 2026-09-10): the player page is a
// beta screen now, and "0.382" was the one three-place figure left on it
import { fmtWar, sgnWar } from "../beta/ui";
import { fmtUsage, POS_USAGE, USAGE_LABEL, usageOf, type UsageKey, type UsagePhase } from "../lib/usage";
import { useModel } from "../lib/model";
import { clubName, latestSeasonOf, pInfo, POS_COLOR, REG_WEEKS, rosterSeasonOf } from "../lib/league";
import { leagueSeg, useLeague } from "../lib/context";
import { useLeagueCaps } from "../lib/caps";
import { RouteLink } from "../components/RouteLink";
import { RECENT_NOTE, RecentFigs, RecentRows } from "../components/RecentTrades";
import { ktcOf } from "../lib/values";
import { useMobile } from "../lib/useWidth";
import PosBadge from "../components/PosBadge";
import Portrait from "../components/Portrait";
import TScroll from "../components/TScroll";
import WeekGrid from "../components/WeekGrid";
import QuickJump from "../components/QuickJump";
import HonorMarks, { HonorLegend, HonorSprite } from "../components/HonorMarks";
import {
  honorTotals, loadCareer, loadHonors, ownerSplits, playerHonors, yearSpan,
  type CareerSeason, type HonorIndex, type OwnerSplit,
} from "../lib/honors";

const num = (n: number) => n.toLocaleString("en-US");

/** the franchises that held him in a season, in order, arrows between — the
 *  career table's Held by cell, and on a phone the season's second line */
const heldBy = (owners: CareerSeason["owners"]) => owners.length
  ? owners.map((o, k) => (
    <Fragment key={`${o.team}-${o.from}`}>
      {k > 0 && <span className="held-arrow">→</span>}
      {o.team}
    </Fragment>
  ))
  : <span className="fig quiet">—</span>;
const WINDOWS = ["7", "14", "30"] as const;

/**
 * THE SEASON CELL'S SECOND LINE, on the projected row that is already being
 * played: what is banked, and how much of the projection is still ahead of it.
 *
 * It sits under the SEASON, not under a figure, because it is true of every
 * figure in the row — the same realized WAR and the same remaining fraction
 * apply to the whole row. Sentence-case body
 * face at caption size, so it reads as the qualifier it is and never competes
 * with the year above it; the full sentence is on hover.
 */
function OutlookSub({ banked, inseason }: { banked: number; inseason: InSeason }) {
  const left = weeksLeft(inseason) ?? 0;
  return (
    <div title={outlookNote(inseason)}
      style={{
        marginTop: 2, font: "400 11px/1.35 var(--sans)", color: "var(--dim)",
        whiteSpace: "normal",
      }}>
      {fmtWar(banked)} banked + {left}/{inseason.reg_weeks} proj
    </div>
  );
}

/** data/recent_trades/<bucket>.json — MIRRORS dynasty_movers.py
 *  (RECENT_BUCKETS / recent_bucket): the same pid has to land in the same
 *  file on both ends. Numeric pids by modulus; anything else in bucket 0. */
const RECENT_BUCKETS = 32;
const recentBucket = (pid: string) => (/^\d+$/.test(pid) ? Number(pid) % RECENT_BUCKETS : 0);
/** how many trades the section shows before "View all" */
const RECENT_PREVIEW = 3;
/** stable empty stand-ins, so a not-yet-loaded file doesn't hand every memo a
 *  fresh object literal on each render */
const NO_OWNERSHIP: Ownership = {};
const NO_ABSENCES: Record<string, string> = {};

/**
 * Player page (3A): split rail. The rail carries identity and the career WAR
 * ladder — projected years above played ones, so decline is visible in the
 * rail alone; the content column carries the figure strip, the verdict, the
 * projection table, last season's week strip, ownership, and market value.
 */
export default function Player({ pid }: { pid: string }) {
  const { meta, players, league } = useLeague();
  const nav = useNavigate();
  const [shard, setShard] = useState<PlayerShard | null | undefined>(undefined);
  /** the usage table's window: the league's regular season, its bracket weeks, or both */
  const [usagePhase, setUsagePhase] = useState<UsagePhase>("reg");
  const [wks, setWks] = useState<WeeklyRow[] | null>(null);
  const [abs, setAbs] = useState<Record<string, string>>(NO_ABSENCES);
  /** which PLAYED season the week grid shows — the career ladder sets it */
  const [weekSeason, setWeekSeason] = useState<string | null>(null);
  /** league-wide honor index — loaded once per page load, shared by every player */
  const [honors, setHonors] = useState<HonorIndex | null>(null);
  /** this player's league seasons — the career table's rows */
  const [career, setCareer] = useState<CareerSeason[] | null>(null);
  /** career split by the franchise that held him — the table's footer */
  const [splits, setSplits] = useState<OwnerSplit[]>([]);
  /**
   * THE PHONE SHAPE (≤640px, the same breakpoint `.hm` hides columns at).
   *
   * The split rail is a desktop shell: 232px of identity and ladder beside the
   * content. Stacked on a phone it put the whole rail — portrait, name, honors,
   * a ten-row ladder and four nav buttons — above the first figure, so the
   * reader scrolled a screen and a half before the page said anything. On a
   * phone the rail becomes a compact identity header with a jump strip, the
   * ladder moves into its own band under the figure strip, and each table
   * keeps only the columns that earn their width. Same elements, same order of
   * importance, one column.
   */
  const mobile = useMobile();
  /** the board gutter the inline paddings below use — the phone's 14px, the
   *  desktop's 22px, matching what `.band` and the tables sit inside */
  const gut = mobile ? 14 : 22;

  // Everything the page reads whole and picks this player out of. Each is one
  // cached download shared with every other view that wants the same file.
  // model-aware: these follow the masthead's projection-model control
  const dvi = useDvi()?.players[pid] ?? null;
  const cvi = useCvi()?.players[pid] ?? null;
  const own = useJson<Ownership>("ownership.json").data ?? NO_OWNERSHIP;
  const teams = useJson<Team[]>(`${rosterSeasonOf(league)}/teams.json`).data;
  /** what this league publishes. `market` is the one that matters here: KTC
   *  and FantasyCalc price a DYNASTY asset, and the Market value table put a
   *  dynasty price and a "priced like 2027 Early 1st" row on a redraft
   *  league's player page, where neither means anything. */
  const caps = useLeagueCaps();
  // global file: the market prices a format, not a league
  const vals = useJson<Values>(caps.market ? "data/values.json" : null, "globalDaily").data;
  /**
   * HIS TRADES ACROSS THE CRAWLED LEAGUES, last 7 days (Max, 2026-09-08).
   * Global, like the market feed: a trade in one of 46k dynasty leagues
   * belongs to no league of ours. One bucket file of 32, picked by pid, so
   * the page downloads one player's worth of the window rather than all of
   * it. The movers job rewrites the buckets ~12x a day; the daily cache-bust
   * means a browser sees at most a day-old window, same as values.json.
   * `error` (the shards not deployed yet) hides the section rather than
   * showing an empty one.
   */
  const recentQ = useJson<RecentTrades>(
    caps.market ? `data/recent_trades/${recentBucket(pid)}.json` : null, "globalDaily");
  const recent = recentQ.data?.players[pid] ?? null;

  /**
   * The six-curve matrix row and the analog read — BOTH out of the shard.
   *
   * They used to be two whole-file fetches, projections_knn_hybrid.json (788
   * KB) and projections_matrix.json (228 KB), linear-scanned for one pid: a
   * megabyte downloaded per player page to render two tables about one man,
   * against a shard that exists precisely so the page does not do that. They
   * are ~1.2 KB of it now, and they arrive WITH the shard rather than a second
   * later, so the projection section no longer paints the fallback table first
   * and swaps to the six-curve one when the matrix lands.
   *
   * A shard predating the enrichment simply lacks the fields, which reads the
   * same as a player the matrix does not price: null, and the fallbacks below
   * take over.
   */
  const knn = shard?.knn ?? null;
  const mx = shard?.mx ?? null;

  /**
   * HOW MUCH OF THE ROSTER SEASON IS ALREADY A FACT (Max, 2026-09-21).
   *
   * Every curve's year 1 is a FULL-SEASON figure, which is the right input to
   * a model and the wrong thing to show a reader in week 4: by then four of
   * those weeks have happened and have a realized WAR attached. So while the
   * shard carries `inseason`, every year-1 figure the projection tables and
   * the career ladder PRINT is the outlook — banked + projection × the share
   * of the season left (lib/outlook, mirrored by scripts/inseason.py).
   *
   * WHY THE WHOLE ROW MOVES, not just the accented cell. The transform is
   * affine with the SAME two constants for every curve, so the eight model
   * figures shift and scale together: their ordering, their spread relative to
   * each other, and the band around them are all preserved. Prorating one cell
   * and leaving its neighbour on fourteen weeks would have put two numbers
   * measuring different seasons under one header.
   *
   * Absent `inseason` — the offseason, a shard built before the field, and
   * every byte of data committed today — `owY` is the identity and this page
   * renders exactly as it did.
   */
  const blk = shard?.inseason ?? null;
  const inseason = isInSeason(blk) ? blk : null;
  /** his realized regular-season WAR so far. No row in the season summary
   *  means he has not dressed for anybody: a real zero, not a missing value. */
  const banked = typeof shard?.banked === "number" && Number.isFinite(shard.banked)
    ? shard.banked : 0;

  const last = latestSeasonOf(meta);
  /** THE LEAGUE'S OWN REGULAR SEASON, for the usage table's caption: the
   *  windows usage_stats.py sums are cut on `playoff_start`, so the caption
   *  has to read it from the same place rather than asserting "weeks 1–14"
   *  (lib/league's REG_WEEKS is explicitly the assumption for where that
   *  figure is NOT known). Fetched only when there is a usage table to
   *  caption, and matchups.json for this season is already in the cache from
   *  the career build. */
  const regMw = useJson<Matchups>(shard?.usage ? `${last}/matchups.json` : null).data;
  const regTo = (regMw?.playoff_start ?? REG_WEEKS + 1) - 1;
  /** the open career row. Null means every row is collapsed — the week grid is
   *  a drawer now, so nothing is fetched until a season is actually opened. */
  const wkSeason = weekSeason && meta.seasons.includes(weekSeason) ? weekSeason : null;

  useEffect(() => {
    let live = true;
    jl<PlayerShard>(`player/${pid}.json`).then(
      sh => { if (live) setShard(sh); },
      // 404 = no record in any projection source. The ladder then falls back
      // to his league seasons, which `career` below already holds.
      () => { if (live) setShard(null); });
    loadHonors(meta.seasons).then(h => { if (live) setHonors(h); }).catch(() => {});
    loadCareer(meta.seasons).then(c => {
      if (!live) return;
      const rows = c[pid] ?? [];
      setCareer(rows);
      // splits fetch weekly data only for seasons he changed hands in
      ownerSplits(rows).then(s => { if (live) setSplits(s); }).catch(() => {});
    }).catch(() => {});
    return () => { live = false; };
  }, [pid, last, league, meta]);

  /**
   * The open drawer's two files, and ONLY those.
   *
   * wkSeason changes every time a career row is clicked, and it used to sit in
   * the dependency list above — so opening a drawer re-ran the whole cascade:
   * the shard, both indices, ownership, teams, market values, the league-wide
   * honor index and the career build. All of it cached, none of it free, and it
   * reset state the page was already showing. A drawer toggle is a drawer
   * fetch.
   *
   * Both files settle together, deliberately. `wks` alone gates the grid, so
   * letting weekly.json land first drew the new season's weeks against the
   * PREVIOUS season's BYE/DNP flags until absence.json caught up.
   */
  useEffect(() => {
    if (!wkSeason) return;
    let live = true;
    Promise.all([
      jl<Weekly>(`${wkSeason}/weekly.json`).catch(() => ({} as Weekly)),
      jl<Absences>(`${wkSeason}/absence.json`).catch(() => ({} as Absences)),
    ]).then(([w, a]) => {
      if (!live) return;
      setWks((w[pid] || []).slice().sort((x, y) => x[0] - y[0]));
      setAbs(a[pid] || NO_ABSENCES);
    });
    return () => { live = false; };
  }, [pid, wkSeason]);

  const refs = {
    projection: useRef<HTMLDivElement>(null),
    career: useRef<HTMLDivElement>(null),
    usage: useRef<HTMLDivElement>(null),
    ownership: useRef<HTMLDivElement>(null),
    market: useRef<HTMLDivElement>(null),
    trades: useRef<HTMLDivElement>(null),
  };
  const goto = (k: keyof typeof refs) =>
    refs[k].current?.scrollIntoView({ behavior: "smooth", block: "start" });

  const [nm, pos, nfl] = pInfo(players, pid);
  const proj = shard?.proj ?? null;
  const years = shard?.years ?? [];
  /** is projected year `i` the season currently being played? The pipeline
   *  publishes the block only when year 1 IS the roster season, so this is row
   *  0 and nothing else — matched on the season rather than on the index so a
   *  rebuilt horizon can never prorate the wrong year. */
  const owRow = (i: number) => !!inseason && years[i] === inseason.season;
  /** `banked + v × remaining_frac` for that row, `v` untouched everywhere
   *  else. Applied at render, never to a stored figure: nothing downstream of
   *  this page — no index, no price, no optimiser — may see the prorated
   *  number. */
  const owY = (v: number, i: number): number =>
    owRow(i) && inseason ? banked + v * inseason.remaining_frac : v;
  /* ONE PROJECTION, ONE SOURCE (Max, 2026-10-07). The page used to quote two
     models at once: the six-curve table read the matrix while the ladder, the
     verdict, the figure strip and the finish badges read the shard's `proj`
     row — projections.json, which was the points-first model's file from
     2026-09-11. Now every projected figure here reads ONE path: the matrix on
     the site's curve (blend · composite unless the reader changed it on More).
     `proj` is only the fallback for a deploy whose data predates the matrix.

     WAR PROJ is the projection; for the season being played it is the
     PRESEASON read (shard `pre`, frozen before kickoff by project_matrix), so
     it states what we expected rather than drifting with every week. WAR PACE
     is banked WAR plus the rest of the season on today's projection — only
     the season being played has one. */
  const { curve } = useModel();
  const path: number[] = (mx ? mx[curve] : null) ?? proj?.composite ?? [];
  const preRow = shard?.pre ?? null;
  /** WAR PROJ for row i */
  const projOf = (i: number): number | null =>
    owRow(i) ? (preRow?.[curve]?.[0] ?? null) : (path[i] ?? null);
  /** the projected position finish beside WAR PROJ — the same read it ranks */
  const finOf = (i: number): number | null =>
    (owRow(i) ? preRow?.posFin?.[curve]?.[0]
      : mx ? mx.posFin?.[curve]?.[i] : proj?.posFin?.[i]) ?? null;
  /** WAR PACE for row i: the season being played only */
  const paceOf = (i: number): number | null =>
    owRow(i) && path[i] != null ? owY(path[i], i) : null;
  const owner = useMemo(() => {
    const t = teams?.find(x => x.players.includes(pid));
    return t ? t.team : null;
  }, [teams, pid]);

  const events = own[pid] || [];
  const v = vals?.players[pid];
  const market = useMemo(() => {
    if (!v) return [];
    const closest = (list: [string, number][] | undefined, val: number) => {
      if (!list?.length) return null;
      let best = list[0];
      for (const pk of list) if (Math.abs(pk[1] - val) < Math.abs(best[1] - val)) best = pk;
      return best;
    };
    return [
      // value prices in this league's TE-premium column; ranks/trends stay the
      // base feed's (KTC publishes them for one ladder only)
      { src: "KeepTradeCut", value: ktcOf(v, meta.tep), ovr: v.ktcRank, posRank: v.ktcPosRank, t: v.ktcT, imp: v.impWar?.ktc ?? null, picks: vals?.picks?.ktc },
      { src: "FantasyCalc", value: v.fc, ovr: v.fcRank, posRank: v.fcPosRank, t: v.fcT, imp: v.impWar?.fc ?? null, picks: vals?.picks?.fc },
    ].filter(m => m.value != null).map(m => ({
      ...m, value: m.value as number, pick: closest(m.picks, m.value as number),
    }));
  }, [v, vals, meta]);

  if (shard === undefined) return <div className="empty">Loading player…</div>;

  // wks goes null again whenever a different season is opened. That is a
  // reload of ONE drawer, not of the page — gating the whole render on it
  // flashed "Loading player…" over everything on every click.
  const reg = (wks ?? []).filter(w => w[0] <= REG_WEEKS);
  /** newest league season, for the figure strip. Read from the career rows
   *  rather than the week fetch, so the strip no longer depends on a drawer
   *  being open. */
  const lastRow = career?.find(r => r.season === last) ?? career?.[0] ?? null;

  /** the career table's totals row. PPG is points over games, not the mean of
   *  the per-season averages — a four-game season should not weigh as much as
   *  a full one. */
  const tot = career?.length ? {
    seasons: career.length,
    gp: career.reduce((s, r) => s + r.gp, 0),
    pts: career.reduce((s, r) => s + r.pts, 0),
    war: career.reduce((s, r) => s + r.war, 0),
    /** mean position finish. Belongs on the average row and NOT on the career
     *  row above it: a total of ranks is meaningless, but a mean of them is
     *  exactly what "average season" claims to be. Seasons he went unranked are
     *  left out rather than counted as a bad finish. */
    finish: (() => {
      const r = career.filter(x => x.posRank != null).map(x => x.posRank as number);
      return r.length ? r.reduce((a, b) => a + b, 0) / r.length : null;
    })(),
  } : null;

  /** open a season's drawer and bring it into view; clicking the open one closes it.
   *  Both setters are called from the handler, not from inside the updater — a
   *  state updater has to be pure, and React runs it twice under StrictMode. */
  const openSeason = (s: string, scroll = false) => {
    const next = weekSeason === s ? null : s;
    setWeekSeason(next);
    // both, together: `abs` left behind here is the previous season's flags
    if (next) { setWks(null); setAbs(NO_ABSENCES); }
    if (scroll) refs.career.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  /**
   * THE LADDER'S FALLBACK, off the career rows this page already holds.
   *
   * A player the projection model never priced has no `proj.career`, and the
   * ladder used to fill that gap by fetching every season's summary.json and
   * scanning each one for his pid — the same files `loadCareer` had already
   * read to build the career table twelve rows below, filtered the same way
   * (`typeof war === "number"`) to the same figure. One source, so the rail
   * and the table can never disagree about what he did in 2024.
   */
  const leagueCareer: [number, number][] | null = career
    ? career.map(r => [Number(r.season), r.war] as [number, number])
      .sort((a, b) => a[0] - b[0])
    : null;

  /** ladder rows, newest first: projected years above played ones */
  const played: [number, number][] = proj?.career ?? leagueCareer ?? [];
  /* THE LADDER IS WHERE THE FULL-SEASON RATE READ WORST: a projected 2026 sat
     directly above a played 2025 in the same column of season figures, and in
     week 4 those two were measuring different amounts of football. The roster
     season's rung is the OUTLOOK, which is the figure it will settle at. */
  const projected: [number, number][] = path.length
    ? years.map((y, i) => [y, paceOf(i) ?? path[i] ?? 0] as [number, number])
    : [];
  const ladder = [...projected.slice().reverse(), ...played.slice().reverse()];
  const ladderMax = Math.max(0.001, ...ladder.map(([, w]) => Math.max(0, w)));
  const careerWar = played.reduce((s, [, w]) => s + w, 0);
  const firstYear = played.length ? played[0][0] : null;

  const barColor = (w: number) =>
    w >= 1.5 ? "var(--acc)" : w >= 0.75 ? "var(--acc-dim)" : "var(--dim)";

  /** career honors: the rail row is the total, the ladder carries the seasons */
  const honorRows = playerHonors(honors, pid);
  const honorBySeason = new Map(honorRows.map(r => [r.season, r.keys]));
  const honorCareer = honorTotals(honorRows);

  /** verdict prose — generated from the payload, never hand-written. Every
   *  figure in it is off `path` (the site curve), the same as the table. */
  const verdict = years.length >= 3 && path.length >= 3 ? (() => {
    const lastIdx = Math.min(2, path.length - 1);
    const dir = (path[lastIdx] ?? 0) - (path[0] ?? 0);
    const trend = dir > 0.15 ? "rising" : dir < -0.15 ? "declining" : "holding";
    const f0 = finOf(0);
    const fin = f0 ? `, a ${pos}${f0} finish` : "";
    const pace = paceOf(0);
    const pre = projOf(0);
    const wk = inseason ? inseason.weeks_played : 0;
    const trendLine = `The three-year path is ${trend}: ${fmtWar(path[0])} in ${years[0]} `
      + `to ${fmtWar(path[lastIdx])} by ${years[lastIdx]}`
      + `${inseason ? ", on the full-season rate" : ""}.`;
    if (inseason && pace != null) {
      const gap = pre != null ? pace - pre : null;
      return {
        meta: `${years[0]} pace ${fmtWar(pace)} WAR · ${fmtWar(banked)} banked in `
          + `${wk} wk${wk === 1 ? "" : "s"}`
          + (pre != null ? ` · preseason proj ${fmtWar(pre)}` : ""),
        body: `${years[0]} is on pace for ${fmtWar(pace)} WAR: ${fmtWar(banked)} banked over `
          + `${wk} of ${inseason.reg_weeks} weeks plus the rest of a ${fmtWar(path[0])} `
          + `full-season projection. `
          + (gap == null || pre == null ? ""
            : Math.abs(gap) < 0.05 ? `That is in line with his ${fmtWar(pre)} preseason projection${fin}. `
              : `That is ${fmtWar(Math.abs(gap))} WAR ${gap > 0 ? "ahead of" : "behind"} his `
                + `${fmtWar(pre)} preseason projection${fin}. `)
          + trendLine,
      };
    }
    return {
      meta: `${years[0]} projection ${fmtWar(path[0])} WAR`,
      body: `${years[0]} projects ${fmtWar(path[0])} WAR${fin}. ${trendLine}`,
    };
  })() : null;

  /* ---- the rail's parts, built once and placed by shape ------------------
     Desktop puts all of them in the 232px rail; the phone puts identity and
     the jump strip in a header and the ladder in a band under the figures.
     One definition each, so the two shapes cannot drift. */

  /** badge, club, name, and the age / seasons / bye / owner line */
  const identity = (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <PosBadge pos={pos} />
        {/* the club in full — the rail has the width, and "GB" beside
            a badge was a code where a name fits. No club is a fact too:
            "NFL Free Agent", not a blank (Max, 2026-09-02). */}
        <span style={{ font: "600 13px/1.2 var(--cond)", letterSpacing: ".12em", color: "var(--dim)", textTransform: "uppercase" }}>
          {clubName(nfl)}
        </span>
      </div>
      <div className="rail-name">{nm}</div>
      <div className="rail-sub">
        {/* "— seasons", never "0 seasons": an unknown career length is
            not a rookie's */}
        {proj && <>age {proj.age} · {proj.exp ?? "—"} seasons · bye {proj.bye ?? "—"} · </>}
        {owner ?? "free agent"}
      </div>
    </>
  );

  /** the section jumps. Buttons, not anchors: the targets are refs, and a
   *  hash link would fight the router for the URL. */
  const jumps = (
    <>
      {proj && <button onClick={() => goto("projection")}>Projection</button>}
      <button onClick={() => goto("career")}>Career</button>
      {shard?.usage && <button onClick={() => goto("usage")}>Usage</button>}
      {events.length > 0 && <button onClick={() => goto("ownership")}>Ownership</button>}
      {market.length > 0 && <button onClick={() => goto("market")}>Market value</button>}
      {recentQ.data && <button onClick={() => goto("trades")}>Trades</button>}
    </>
  );

  /** an asset on either side of a recent trade, named. Players resolve
   *  through the bucket's own names map first — players_min covers this
   *  league's rostered players, not every body traded in 46k leagues — then
   *  the league map, then the bare pid, so a row is never silently short. */
  /** the career WAR ladder, newest first — the rows only; the caller frames it */
  const ladderRows = ladder.length > 0 && (
    <div className="rail-ladder">
      {ladder.map(([y, w]) => {
        const isProj = projected.some(([py]) => py === y);
        // Three kinds of row, and only one of them is pickable.
        // A projected year has no weeks. A season before the league
        // existed has no career row to open and no honors to earn —
        // it is career context, not league history, and it says so by
        // sitting back. Leaving it clickable pointed at a row that
        // was never rendered.
        const inLeague = meta.seasons.includes(String(y));
        const pick = !isProj && inLeague;
        const on = pick && String(y) === wkSeason;
        return (
          <div key={y} role={pick ? "button" : undefined}
            tabIndex={pick ? 0 : undefined}
            title={pick ? `Open ${y} in the career table`
              : isProj
                ? (inseason && y === inseason.season ? outlookNote(inseason) : undefined)
                : `${y} — before the league began`}
            className={`rail-war${isProj ? " proj" : pick ? " pick" : " pre"}${on ? " mark" : ""}`}
            onClick={pick ? () => openSeason(String(y), true) : undefined}
            onKeyDown={pick ? e => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault(); openSeason(String(y), true);
              }
            } : undefined}>
            <span className="yr">{y}</span>
            <span className="bar">
              <i style={{
                width: `${Math.round(Math.max(0, w) / ladderMax * 100)}%`,
                background: isProj ? "var(--dim)" : barColor(w),
              }} />
            </span>
            <span className="v">{fmtWar(w)}</span>
          </div>
        );
      })}
    </div>
  );

  return (
    <>
      <div className="screen-head">
        <span className="screen-title">Player</span>
        <QuickJump />
      </div>
      <HonorSprite />
      <div className="board" style={{ marginTop: 0 }}>
        {/* the position tint is declared once here, not on the rail: the career
            table needs it too, and scoping it to the rail left every crown and
            gem in the table falling back to gray */}
        <div className={`split pos-mark-${pos}${mobile ? " phone" : ""}`}>
          {mobile ? (
            /* THE PHONE HEADER. Portrait beside the identity, not above it;
               honors on their own line under the sub-line; the section jumps
               as one scrolling strip. Everything the rail says, at a fifth of
               the height. */
            <div className="pid-head">
              <span className="rail-back" onClick={() => nav(-1)}>← Back</span>
              <div className="pid-row">
                <Portrait pid={pid} size={76} />
                <div className="pid-id">{identity}</div>
              </div>
              {honorCareer.length > 0 && (
                <div className="pid-honors">
                  <span className="k">Honors · in league</span>
                  <HonorMarks marks={honorCareer} />
                </div>
              )}
              <div className="pid-jump" role="navigation" aria-label="On this page">{jumps}</div>
            </div>
          ) : (
          <div className="rail">
            <span className="rail-back" onClick={() => nav(-1)}>← Back</span>
            <Portrait pid={pid} />
            {identity}

            {honorCareer.length > 0 && (
              <>
                {/* Scoped on purpose: honors are league seasons only, and the
                    ladder above runs back further than the league does. */}
                <div className="rail-h">Honors · in league</div>
                <div className="rail-honors">
                  <HonorMarks marks={honorCareer} />
                </div>
              </>
            )}

            {ladderRows && <>
              <div className="rail-h">Career WAR</div>
              {ladderRows}
            </>}

            <div className="rail-h">On this page</div>
            <div className="rail-nav">{jumps}</div>
          </div>
          )}

          <div className="main">
            <div className="figstrip">
              <div className="figcell">
                <div className="figkey">Dynasty index</div>
                <div className="figval acc">{dvi ? fmt(dvi.dvi, 1) : "—"}</div>
                <div className="figsub">{dvi ? `#${dvi.rank} overall · ${pos}${dvi.pos_rank}` : "no index"}</div>
              </div>
              <div className="figcell">
                <div className="figkey">Contender index</div>
                <div className="figval acc">{cvi ? fmt(cvi.cvi, 1) : "—"}</div>
                <div className="figsub">{cvi ? `#${cvi.rank} this season · ${pos}${cvi.pos_rank}` : "no index"}</div>
              </div>
              <div className="figcell">
                <div className="figkey">{lastRow?.season ?? last} WAR</div>
                <div className="figval">{lastRow ? fmtWar(lastRow.war) : "—"}</div>
                <div className="figsub">{lastRow
                  ? `${pos}${lastRow.posRank ?? "—"} · ${lastRow.gp} games`
                  : `did not play ${last}`}</div>
              </div>
              <div className="figcell">
                <div className="figkey">Career WAR</div>
                <div className="figval">{played.length ? fmtWar(careerWar) : "—"}</div>
                <div className="figsub">{firstYear ? `since ${firstYear}` : "no seasons"}</div>
              </div>
              <div className="figcell">
                {/* THE PROJECTION'S OWN YEARS, never the roster season. The
                    shard states which years it projects (`years`), and when a
                    rebuild shifts the horizon "Next 3 years" would quietly
                    mean a different three. Label with the real ones. */}
                <div className="figkey">
                  {years.length ? `${years[0]}–${years[years.length - 1]}` : "Next 3 years"}
                </div>
                <div className="figval">{projected.length
                  ? fmtWar(projected.reduce((s, [, w]) => s + w, 0)) : "—"}</div>
                <div className="figsub">{inseason ? `${years[0]} on pace + projected` : "projected WAR"}</div>
              </div>
            </div>

            {mobile && ladderRows && (
              /* THE LADDER AS A BAND. On the desktop it sits in the rail and
                 stays in view while the page scrolls; a phone has no rail, so
                 it takes the band grammar every other section uses and sits
                 directly under the figures it explains. Same rows, same
                 tap-to-open. */
              <div className="pid-ladder">
                <div className="band">
                  <span className="band-label">Career WAR</span>
                  <span className="band-note">
                    Projected years above played · tap a season to open it
                    {inseason && <> · <span title={outlookNote(inseason)}>{outlookLabel(inseason)}</span></>}
                  </span>
                </div>
                {ladderRows}
              </div>
            )}

            {verdict && (
              <div className="verdict">
                <div className="k">Model read</div>
                <div className="meta">{verdict.meta}</div>
                <div className="body">{verdict.body}</div>
              </div>
            )}

            {/* THE PROJECTION (Max, 2026-10-07): two figures per season. WAR
                PROJ is what we projected — the preseason read for the season
                being played, today's projection for the years after it. WAR
                PACE is where the season being played is tracking: banked WAR
                plus the rest of the season on today's projection. Future years
                have no pace, and say so with a dash. One curve, the site's,
                for every cell; the model comparison lives on More. */}
            {years.length > 0 && path.length > 0 && (
              <div ref={refs.projection}>
                <div className="band">
                  <span className="band-label">Projection · {years[0]}–{years[years.length - 1]}</span>
                  <span className="band-note">
                    {inseason
                      ? <>{years[0]} proj is the preseason projection
                        {shard?.pre_at ? ` (${shard.pre_at})` : ""} · pace is banked WAR plus the
                        rest of the season projected</>
                      : "Projected WAR by season · pace starts once the season does"}
                  </span>
                </div>
                <table style={{ tableLayout: "fixed" }}>
                  <thead>
                    <tr>
                      <th scope="col" className="t" style={{ width: "24%" }}>Season</th>
                      <th scope="col" className="n" style={{ width: "14%" }}>Age</th>
                      <th scope="col" className="n edge" style={{ width: "20%" }}>WAR proj</th>
                      <th scope="col" className="n" style={{ width: "22%" }}>WAR pace</th>
                      <th scope="col" className="n edge" style={{ width: "20%" }}>Proj finish</th>
                    </tr>
                  </thead>
                  <tbody>
                    {years.map((y, i) => {
                      const pj = projOf(i), pc = paceOf(i), fin = finOf(i);
                      const age = mx?.age ?? proj?.age ?? null;
                      return (
                        <tr key={y} className={i % 2 ? "zebra" : ""}>
                          <td className="t fig strong">{y}</td>
                          <td className="n fig quiet">{age == null ? "—" : age + i}</td>
                          <td className="n edge">
                            {pj == null ? <span className="fig quiet">—</span>
                              : <span className="head-fig sm">{fmtWar(pj)}</span>}
                          </td>
                          <td className="n">
                            {pc == null ? <span className="fig quiet">—</span> : <>
                              <span className="head-fig sm" style={{ color: "var(--acc)" }}>{fmtWar(pc)}</span>
                              {inseason && <OutlookSub banked={banked} inseason={inseason} />}
                            </>}
                          </td>
                          <td className="n edge last">
                            {fin
                              ? <PosBadge pos={pos} size="wide" rank={fin} color={POS_COLOR[pos] || "var(--rule-2)"} />
                              : <span className="fig quiet">—</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {knn && knn.near && knn.near.length > 0 && (
              <div>
                <div className="band">
                  <span className="band-label">Closest comparables · {knn.near.length} of {knn.n}</span>
                  <span className="band-note">
                    What each one actually returned over the three years after ·
                    cohort median match {knn.sim_med ?? 0}
                  </span>
                </div>
                <TScroll>
                <table style={{ tableLayout: "fixed" }}>
                  <thead>
                    <tr>
                      <th scope="col" className="t" style={{ width: "27%" }}>Comparable</th>
                      <th scope="col" className="n" style={{ width: "6%" }}>Age</th>
                      {/* the three inputs the match was made on — the desktop's
                          evidence column, and the one a phone can spare: the
                          Match score beside it is the same fact summarized */}
                      <th scope="col" className="t edge hm" style={{ width: "24%" }}>Points going in</th>
                      {/* "Yr 1" on a phone: three "Year N" headers at 11% of
                          375px wrapped onto two lines each (Max, 2026-09-05) */}
                      {[0, 1, 2].map(i => (
                        <th key={i} scope="col" className={`n${i === 0 ? " edge" : ""}`}
                          style={{ width: "11%" }}>{mobile ? `Yr ${i + 1}` : `Year ${i + 1}`}</th>
                      ))}
                      <th scope="col" className="n edge" style={{ width: "10%" }}
                        title="0–100, higher is more alike: 100 is an identical profile, 0 is nothing in common. Comparable across players, and 50 is exactly the cutoff for joining a cohort — above it he was already in the neighbourhood, below it he was reached for.">
                        Match</th>
                    </tr>
                  </thead>
                  <tbody>
                    {knn.near.map((m, i) => (
                      <tr key={`${m.name}-${m.season}`} className={i % 2 ? "zebra" : ""}>
                        {/* the season stacks under the name on a phone, so the
                            name keeps the line to itself */}
                        <td className="t name">
                          {m.name ?? "—"}
                          {mobile ? <div className="fig quiet pid-sub">{m.season}</div>
                            : <> <span className="fig quiet">{m.season}</span></>}
                        </td>
                        <td className="n fig quiet">{m.age ?? "—"}</td>
                        {/* the same three numbers the match was made on, most
                            recent first. A slot he has no season for reads as a
                            dash: it is not a season in which he scored nothing. */}
                        <td className="t fig quiet edge hm">
                          {m.seen.map(v => v == null ? "—" : Math.round(v * 100)).join(" · ")}
                        </td>
                        {m.then.map((v, k) => (
                          <td key={k} className={`n${k === 0 ? " edge" : ""}`}>
                            {v == null
                              /* hurt or inactive that year — skipped, never
                                 scored. A real 0.00 below means he left the
                                 league, which is a different fact. */
                              ? <span className="fig quiet">—</span>
                              : <span className="fig" style={{
                                color: v > 0.005 ? "var(--good)"
                                  : v < -0.005 ? "var(--bad)" : "var(--dim)",
                              }}>{mobile ? sgn(v, 2) : sgnWar(v)}</span>}
                          </td>
                        ))}
                        {/* a 0-100 score is an index: a bare figure, never a
                            meter. A bar would only restate the number. */}
                        <td className="n edge last">
                          <span className="head-fig sm">{m.sim}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </TScroll>
              </div>
            )}

            <div ref={refs.career}>
              <div className="band">
                <span className="band-label">Career · league seasons</span>
                <span className="band-note">Open a season for its week grid · WAR vs the best player left out of the startable pool</span>
              </div>
              {career === null ? <div className="tnote" style={{ padding: `14px ${gut}px 18px` }}>Loading career…</div>
                : career.length === 0 ? <div className="tnote" style={{ padding: `14px ${gut}px 18px` }}>
                  No league seasons — this player has never been scored in the league.
                </div> : <>
                  <TScroll>
                  <table style={{ tableLayout: "fixed" }}>
                    <thead>
                      <tr>
                        <th scope="col" className="t" style={{ width: "9%" }}>Season</th>
                        {/* ON A PHONE, HELD BY FOLDS UNDER THE SEASON (Max,
                            2026-09-05). A 30% column of franchise names at
                            375px wrapped every row to three lines and left the
                            figures unreadable; as the season cell's second
                            line it has the whole row's width to wrap in. */}
                        <th scope="col" className="t hm" style={{ width: "30%" }}>Held by</th>
                        <th scope="col" className="n" style={{ width: "7%" }}>GP</th>
                        {/* Points and PPG sit out on a phone: WAR is the
                            figure this table is sorted by and the one the
                            page is about, and the week grid under an open
                            season carries the points */}
                        <th scope="col" className="n hm" style={{ width: "10%" }}>Points</th>
                        <th scope="col" className="n hm" style={{ width: "9%" }}>PPG</th>
                        <th scope="col" className="n key edge" style={{ width: "11%" }}>WAR</th>
                        <th scope="col" className="n" style={{ width: "10%" }}>Finish</th>
                        <th scope="col" className="t edge" style={{ width: "14%" }}>Honors</th>
                      </tr>
                    </thead>
                    <tbody>
                      {career.map((r, i) => {
                        const on = r.season === wkSeason;
                        return (
                          <Fragment key={r.season}>
                            <tr className={`${i % 2 ? "zebra " : ""}click${on ? " open" : ""}`}
                              onClick={() => openSeason(r.season)}
                              title={`${on ? "Close" : "Open"} ${r.season} week by week`}>
                              <td className="t fig strong">
                                {r.season}
                                {mobile && <div className="pid-held">{heldBy(r.owners)}</div>}
                              </td>
                              <td className="t name quiet hm"
                                title={r.owners.map(o => o.from
                                  ? `${o.team} · W${o.from}${o.to > o.from ? `–${o.to}` : ""}`
                                  : o.team).join("  →  ")}>
                                {heldBy(r.owners)}
                              </td>
                              <td className="n fig quiet">{r.gp}</td>
                              <td className="n fig hm">{num(Math.round(r.pts))}</td>
                              <td className="n fig hm">{fmt(r.ppg, 1)}</td>
                              <td className="n edge"><span className="head-fig sm" style={{ color: "var(--acc)" }}>{fmtWar(r.war)}</span></td>
                              <td className="n fig">
                                {r.posRank
                                  ? <PosBadge pos={r.pos} size="wide" rank={r.posRank} color={POS_COLOR[r.pos] || "var(--rule-2)"} />
                                  : <span className="fig quiet">—</span>}
                              </td>
                              <td className="t last edge">
                                {r.keys.length
                                  ? <HonorMarks marks={r.keys} size={17} showCounts={false} />
                                  : <span className="fig quiet">—</span>}
                              </td>
                            </tr>
                            {on && (
                              <tr className="drawer-row">
                                <td colSpan={mobile ? 5 : 8}>
                                  <div style={{ padding: `14px ${gut}px 18px` }}>
                                    {wks === null ? <div className="tnote">Loading {r.season}…</div>
                                      : reg.length ? <WeekGrid weeks={reg} absent={abs} />
                                        : <div className="tnote">No scored weeks in {r.season}.</div>}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                    {tot && (
                      <tfoot>
                        {/* One label cell spanning the season and Held by
                            columns. Split across two, a franchise name had 30%
                            of the table and clipped to a single letter. */}
                        <tr className="tot">
                          <td className="t fig strong" colSpan={mobile ? 1 : 2}>
                            Career<span className="tot-yrs">{tot.seasons} {tot.seasons === 1 ? "yr" : "yrs"}</span>
                          </td>
                          <td className="n fig">{tot.gp}</td>
                          <td className="n fig hm">{num(Math.round(tot.pts))}</td>
                          <td className="n fig hm">{tot.gp ? fmt(tot.pts / tot.gp, 1) : "—"}</td>
                          <td className="n edge"><span className="head-fig sm" style={{ color: "var(--acc)" }}>{fmtWar(tot.war)}</span></td>
                          {/* Finish is a per-season rank and does not add up.
                              Best-of is a different statistic wearing this
                              column's header, so the career row leaves it. */}
                          <td className="n fig quiet">—</td>
                          <td className="t last edge">
                            {honorCareer.length
                              ? <HonorMarks marks={honorCareer} size={17} />
                              : <span className="fig quiet">—</span>}
                          </td>
                        </tr>
                        <tr className="tot sub">
                          <td className="t fig quiet" colSpan={mobile ? 1 : 2}>Average season</td>
                          <td className="n fig quiet">{fmt(tot.gp / tot.seasons, 1)}</td>
                          <td className="n fig quiet hm">{num(Math.round(tot.pts / tot.seasons))}</td>
                          <td className="n fig quiet hm">{tot.gp ? fmt(tot.pts / tot.gp, 1) : "—"}</td>
                          <td className="n fig quiet edge">{fmtWar(tot.war / tot.seasons)}</td>
                          {/* a MEAN finish, so a figure rather than the badge the
                              per-season rows use — those are placings, this is
                              not, and rendering them alike would say he finished
                              RB8.4 in some season */}
                          <td className="n fig quiet">
                            {tot.finish == null ? "—" : `${pos} ${fmt(tot.finish, 1)}`}
                          </td>
                          {/* honors do not average — the career row above already
                              carries every mark he has */}
                          <td className="t last edge"><span className="fig quiet">—</span></td>
                        </tr>
                        {/* keyed on the FRANCHISE, not the roster slot: in a
                            redraft league a slot is reassigned every year, so
                            two different managers split on the same `rid` and
                            React silently dropped one of the two rows */}
                        {splits.length > 1 && splits.map(s => (
                          <tr key={s.fkey} className="tot owner">
                            {/* the manager, not the team name — a franchise
                                renames itself most years and the splits have
                                to survive that */}
                            <td className="t name quiet" colSpan={mobile ? 1 : 2}
                              title={`${s.manager} — most recently ${s.team.trim()}`}>
                              {s.manager}
                              {/* the seasons themselves, not just how many:
                                  a count cannot tell you WHICH years were his */}
                              <span className="tot-yrs">{yearSpan(s.years)}</span>
                            </td>
                            <td className="n fig quiet">{s.gp}</td>
                            <td className="n fig quiet hm">{num(Math.round(s.pts))}</td>
                            <td className="n fig quiet hm">{s.gp ? fmt(s.pts / s.gp, 1) : "—"}</td>
                            <td className="n fig edge">{fmtWar(s.war)}</td>
                            <td className="n fig quiet">
                              {s.finish == null ? "—" : `${pos} ${fmt(s.finish, 1)}`}
                            </td>
                            {/* what he won while this manager held him. A season
                                he changed hands in goes whole to whoever had him
                                longest — an award cannot be cut in half. */}
                            <td className="t last edge">
                              {s.keys.length
                                ? <HonorMarks marks={s.keys} size={17} />
                                : <span className="fig quiet">—</span>}
                            </td>
                          </tr>
                        ))}
                      </tfoot>
                    )}
                  </table>
                  </TScroll>
                  <HonorLegend />
                  <div className="tnote" style={{ padding: `12px ${gut}px 16px` }}>
                    The crown and the gem carry the position's color. Honors cover league seasons
                    only, and held by is every franchise that rostered him that season, in the
                    order they held him — read week by week off the lineups, not off the roster
                    at season end, so a player traded in November shows both teams with the
                    weeks on hover. The moves themselves are in the ownership table below.
                  </div>
                </>}
            </div>

            {/* ---- usage and efficiency ----
                THE NFLVERSE LINE (Max, 2026-09-16): what happened around the
                points — the position's own five figures, one row per NFL
                season, dense enough to hold all five at once on a phone
                (the table scrolls sideways rather than dropping a column).
                Expected points first, then the four that say how the
                opportunity came; the career row is games-weighted. */}
            {shard?.usage && (() => {
              const seasons = Object.keys(shard.usage!).sort((a, b) => b.localeCompare(a));
              const keys: UsageKey[] = [...(POS_USAGE[pos] ?? ["fp_exp_pg"]), "fp_diff_pg", "snap_pct"];
              const pooled = usageOf({ byPlayer: { [pid]: shard.usage! } }, pid, seasons, usagePhase);
              const PH: { id: UsagePhase; label: string }[] = [
                { id: "reg", label: "Regular season" }, { id: "post", label: "Playoffs" }, { id: "both", label: "Both" },
              ];
              const cell = (row: Partial<Record<UsageKey, number>>, k: UsageKey, quiet = false) => {
                const v = row[k];
                return v == null ? <span className="fig quiet">—</span>
                  : <span className={`fig${quiet ? " quiet" : ""}`}>{fmtUsage(k, v)}</span>;
              };
              return (
                <div ref={refs.usage}>
                  <div className="band">
                    <span className="band-label">Usage and efficiency</span>
                    <span className="band-note">
                      {/* the league's windows, the leaderboard's three chips */}
                      {PH.map(x => (
                        <button key={x.id} type="button" className={`chip${usagePhase === x.id ? " on" : ""}`}
                          onClick={() => setUsagePhase(x.id)}>{x.label}</button>
                      ))}
                    </span>
                  </div>
                  <TScroll>
                    <table className="usage-tbl" style={{ tableLayout: "fixed", minWidth: 480 }}>
                      <thead>
                        <tr>
                          <th scope="col" className="t" style={{ width: "13%" }}>Season</th>
                          <th scope="col" className="n" style={{ width: "8%" }}>G</th>
                          {keys.map((k, i) => (
                            <th key={k} scope="col" className={`n${i === 0 ? " key edge" : k === "fp_diff_pg" ? " edge" : ""}`}
                              title={USAGE_LABEL[k].def}>
                              {USAGE_LABEL[k].short ?? USAGE_LABEL[k].label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {seasons.map((season, i) => {
                          // a season without this window: the row stays so the
                          // years line up across the three chips, and reads dashes
                          const r: Partial<Record<UsageKey, number>> & { g?: number } =
                            shard.usage![season][usagePhase] ?? {};
                          return (
                            <tr key={season} className={i % 2 ? "zebra" : ""}>
                              <td className="t fig strong">{season}</td>
                              <td className="n fig quiet">{r.g ?? "—"}</td>
                              {keys.map((k, j) => (
                                <td key={k} className={`n${j === 0 || k === "fp_diff_pg" ? " edge" : ""}`}>
                                  {j === 0 ? <span className="head-fig sm" style={{ color: "var(--acc)" }}>{r[k] == null ? "—" : fmtUsage(k, r[k]!)}</span> : cell(r, k)}
                                </td>
                              ))}
                            </tr>
                          );
                        })}
                      </tbody>
                      {pooled && seasons.length > 1 && (
                        <tfoot>
                          <tr className="tot">
                            <td className="t fig strong">Career<span className="tot-yrs">{seasons.length} yrs</span></td>
                            <td className="n fig">{pooled.g}</td>
                            {keys.map((k, j) => (
                              <td key={k} className={`n${j === 0 || k === "fp_diff_pg" ? " edge" : ""}`}>
                                {j === 0 ? <span className="head-fig sm" style={{ color: "var(--acc)" }}>{pooled[k] == null ? "—" : fmtUsage(k, pooled[k]!)}</span> : cell(pooled, k, true)}
                              </td>
                            ))}
                          </tr>
                        </tfoot>
                      )}
                    </table>
                  </TScroll>
                  <div className="tnote" style={{ padding: `12px ${gut}px 16px` }}>
                    {keys.map(k => `${USAGE_LABEL[k].short ?? USAGE_LABEL[k].label}: ${USAGE_LABEL[k].def}`).join(" · ")}
                    {" "}Windows are the league's: regular season is weeks 1–{regTo}, playoffs the bracket weeks. G is NFL games
                    with a stat line in the window, not league games; the career row is games-weighted.
                  </div>
                </div>
              );
            })()}

            {events.length > 0 && (
              <div ref={refs.ownership}>
                <div className="band">
                  <span className="band-label">Ownership</span>
                  <span className="band-note">Every roster event since the league began</span>
                </div>
                <TScroll>
                <table style={{ tableLayout: "fixed" }}>
                  <thead>
                    <tr>
                      <th scope="col" className="t" style={{ width: "12%" }}>When</th>
                      {/* the kind is the detail's first word; on a phone the
                          detail column needs the width more than a label does */}
                      <th scope="col" className="t hm" style={{ width: "12%" }}>Event</th>
                      <th scope="col" className="t" style={{ width: "76%" }}>Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.slice().reverse().map((e, i) => {
                      const kind = e[2].startsWith("traded") ? "Trade"
                        : e[2].startsWith("drafted") ? "Draft"
                          : e[2].includes("waiver") ? "Waiver" : "Move";
                      return (
                        <tr key={i} className={i % 2 ? "zebra" : ""}>
                          <td className="t fig" style={{ color: kind === "Trade" ? "var(--acc)" : undefined }}>
                            {e[0]}{e[1] ? ` W${e[1]}` : ""}
                          </td>
                          <td className="t fig quiet hm">{kind}</td>
                          <td className="t last" style={{ whiteSpace: "normal", font: "400 13px/1.55 var(--sans)", color: "var(--txt2)" }}>
                            {e[2]}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                </TScroll>
              </div>
            )}

            {market.length > 0 && (
              <div ref={refs.market}>
                <div className="band">
                  <span className="band-label">Market value · as of {vals?.fetched ?? "—"}</span>
                  <span className="band-note">Priced like = the rookie pick currently worth the same · implied WAR runs the price through the value-to-WAR curve</span>
                </div>
                <TScroll>
                <table style={{ tableLayout: "fixed" }}>
                  <thead>
                    <tr className="grp">
                      <th colSpan={2}></th>
                      {/* a phone keeps 7 and 30 day (the ends of the window)
                          and drops 14; keeps both ranks and drops the
                          pick-equivalent, which the band note still defines */}
                      <th scope="colgroup" className="edge" colSpan={mobile ? 2 : 3}>Movement</th>
                      <th scope="colgroup" className="edge" colSpan={mobile ? 2 : 3}>Standing</th>
                      <th scope="colgroup" className="edge value" colSpan={1}>Implied</th>
                    </tr>
                    <tr>
                      <th scope="col" className="t" style={{ width: "16%" }}>Source</th>
                      <th scope="col" className="n" style={{ width: "10%" }}>Value</th>
                      <th scope="col" className="n edge" style={{ width: "9%" }}>7 day</th>
                      <th scope="col" className="n hm" style={{ width: "9%" }}>14 day</th>
                      <th scope="col" className="n" style={{ width: "9%" }}>30 day</th>
                      <th scope="col" className="n edge" style={{ width: "9%" }}>Overall</th>
                      <th scope="col" className="n" style={{ width: "9%" }}>Position</th>
                      <th scope="col" className="t hm" style={{ width: "19%" }}>Priced like</th>
                      <th scope="col" className="n key edge" style={{ width: "10%" }}>WAR / 3yr</th>
                    </tr>
                  </thead>
                  <tbody>
                    {market.map((m, i) => (
                      <tr key={m.src} className={i % 2 ? "zebra" : ""}>
                        <td className="t name quiet">{m.src}</td>
                        <td className="n"><span className="head-fig sm">{num(m.value)}</span></td>
                        {WINDOWS.map((d, k) => {
                          const t = m.t?.[d];
                          return (
                            <td key={d} className={`n fig${k === 0 ? " edge" : ""}${d === "14" ? " hm" : ""}`}
                              style={{ color: t == null ? "var(--dim3)" : t > 0 ? "var(--good)" : t < 0 ? "var(--bad)" : "var(--dim)" }}>
                              {t == null ? "—" : t === 0 ? "0" : `${t > 0 ? "▲" : "▼"} ${num(Math.abs(t))}`}
                            </td>
                          );
                        })}
                        <td className="n fig edge">{m.ovr == null ? "—" : `#${m.ovr}`}</td>
                        <td className="n fig">{m.posRank == null ? "—" : `${pos}${m.posRank}`}</td>
                        <td className="t sub hm">{m.pick ? `${m.pick[0]} (${num(m.pick[1])})` : "—"}</td>
                        <td className="n last edge"><span className="head-fig sm" style={{ color: "var(--acc)" }}>{m.imp == null ? "—" : fmtWar(m.imp)}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </TScroll>
                <div className="tnote" style={{ padding: `0 ${gut}px 16px` }}>
                  A dash in a movement column means the daily snapshot history doesn't reach back that far yet.
                  Deltas are raw value, not rank.
                </div>
              </div>
            )}

            {/* RECENT TRADES (Max, 2026-09-08): what the market actually did
                with him this week, across every crawled dynasty league — how
                many times he moved, what he fetched, and the deals themselves.
                The figures are the movers board's own maths (dynasty_movers.py):
                "going for" is what the other side paid for him as his side's
                CENTERPIECE, net of his throw-ins, against his face KTC in that
                league's TE-premium column. A trade he rode along in as a
                throw-in is listed but carries no price — the price belongs to
                the piece the package was built around. Neutral ink on every
                figure: an overpay is a fact about a market, not a verdict. */}
            {recentQ.data && (
              <div ref={refs.trades}>
                <div className="band">
                  <span className="band-label">
                    Recent trades · last {recentQ.data.meta.window_days} days
                  </span>
                  <span className="band-note">
                    Across the crawled dynasty leagues · as of {recentQ.data.meta.as_of.slice(0, 10)} ·
                    going for = what the other side paid when he was the centerpiece, face KTC
                  </span>
                </div>
                {!recent ? (
                  <div className="tnote" style={{ padding: `14px ${gut}px 18px` }}>
                    Not traded in any crawled league in the last {recentQ.data.meta.window_days} days.
                  </div>
                ) : (
                  <>
                    <RecentFigs recent={recent} />
                    <RecentRows pid={pid} trades={recent.trades.slice(0, RECENT_PREVIEW)}
                      file={recentQ.data} players={players} />
                    {/* THE WHOLE LIST IS A PAGE (Max, 2026-09-09), not a
                        toggle: the shard now carries every trade he was in,
                        and 539 rows unfolding under a section is not a
                        section. The count is his real count. */}
                    {recent.n > RECENT_PREVIEW && (
                      <RouteLink to={`/${leagueSeg(league)}/player/${pid}/trades`} className="rtx-more">
                        View all {recent.n} →
                      </RouteLink>
                    )}
                    <div className="tnote" style={{ padding: `10px ${gut}px 16px` }}>{RECENT_NOTE}</div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
