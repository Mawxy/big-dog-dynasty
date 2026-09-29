import { useMemo, useRef, useState, type ReactNode } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import type {
  Franchises, Insights, Matchups, PicksOwned, ProjectionsFile, SummaryRow,
  Team as TeamT, Values,
} from "../../lib/types";
import { useMobile } from "../../lib/useWidth";
import QuickJump from "../../components/QuickJump";
import TeamAvatar from "../../components/TeamAvatar";
import { HonorSprite } from "../../components/HonorMarks";
import TeamHonorMarks, { TeamHonorLegend } from "../../components/TeamHonorMarks";
import { franchiseHonors, teamHonorTotals, useTeamHonors } from "../../lib/teamHonors";
import { useJson } from "../../lib/useJson";
import { useLeagueCaps } from "../../lib/caps";
import { useLeague } from "../../lib/context";
import { useCvi, useDvi, useProjWar1 } from "../../lib/useIndices";
import { useIdentity } from "../../lib/identity";
import { fmt, ord, sgn } from "../../lib/stats";
import { ridOf, seasonRowOf } from "../../lib/seasons";
import {
  POS_CHIPS, POS_COLOR, SLOT_LABEL, lineupOf, optimalLineup, rosterSeasonOf,
} from "../../lib/league";
import { ktcOf } from "../../lib/values";
import { ROUND_ORD, rosterShapes, type IndexEntry, type RankRow } from "../../lib/rosterModel";
import { rankMap, tierOf, usePickTiers, useTeamValues } from "../model";
import Moved from "../moved";
import TeamSeasons from "./TeamSeasons";
import TeamRivals from "./TeamRivals";
import TeamRecords from "./TeamRecords";
import {
  Band, DataError, IdCell, LensStrip, NUL, sgnWar, Spine, TapRow, useBetaPath,
  type IdTag,
} from "../ui";
import { RouteLink } from "../../components/RouteLink";
import "./team.css";

/**
 * MY TEAM — how am I doing.
 *
 * THIS SCREEN IS THE FRANCHISE PAGE with the back link removed. The tab is it
 * pointed at you; a standings row taps through to it pointed at someone else.
 * There is no second franchise surface, which is what stops the two drifting
 * the way the classic board's Teams row-drawer and franchise page did.
 *
 * The roster is BANDED IN THE LEAGUE'S OWN VOCABULARY rather than paginated:
 * Lineup / Bench / Taxi squad / Draft capital, each band carrying its own
 * total in its own honest currency. The lineup is rendered FROM
 * meta.rosterPositions, in the order the league lists it — QB · RB · RB · WR ·
 * WR · WR · TE · FLEX · SUPER_FLEX — and league.ts's optimalLineup owns which
 * players may sit in which seat. Neither the order nor the eligibility is
 * re-derived here; a hardcoded lineup is a second copy of a league setting and
 * would be wrong the first time the league changed one.
 *
 * PICKS ARE ROSTER ROWS. A dynasty franchise's assets do not divide into
 * "players" and "a separate screen about picks", and the flat per-pick list
 * carries the ones that have been TRADED AWAY as well: a first-rounder that
 * belongs to someone else is a fact about this roster, and a list that only
 * showed holdings would let it disappear.
 *
 * THE HEADLINE IS OUR INDEX, MARKET TRAILS (decision #12). DVI/CVI is the
 * featured column and the market price sits small and last, because this is our
 * board and the market is the cross-check. The toggle exists because δ says
 * contenders and rebuilders should be reading different indices — a per-team
 * δ-weighted value replaces this proxy when the WAR-stream model lands.
 */

/** the two index currencies — what the rank figure, the band totals and the
 *  strengths tier rule are read in */
type IdxLens = "dvi" | "cvi";
/** THE ROSTER'S LENS (Max, 2026-09-27): the two indices, plus STATS — the
 *  season as played. Stats swaps the three figure columns for accrued WAR,
 *  points and games, and re-sorts the bench and taxi squad by accrued WAR. It
 *  is not a currency, so everything else on the screen that reads an index
 *  keeps the last one the reader picked (`idxLens`). */
type Lens = IdxLens | "stats";

/** The one toggle on this screen. Declared as data so it rides `LensStrip` —
 *  the same control the leaderboard uses — rather than hand-rolled buttons
 *  that happen to carry the same classes. */
const lensesFor = (statsSeason: string): { id: Lens; label: string }[] => [
  { id: "dvi", label: "DVI · dynasty" },
  { id: "cvi", label: "CVI · win now" },
  { id: "stats", label: `Stats · ${statsSeason}` },
];

/** Surnames only in a strengths seat row — the holder gets ~84px and the full
 *  name rides the cell's title. Mirrors TeamStrengths' own helper: that
 *  component's semantics are what this section renders, transposed. */
const surname = (name: string) => {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? parts.slice(1).join(" ") : name;
};

/** How many seats at either end the tier rule marks. A count rather than a
 *  share, because it is the shape the league already has: four seats that win
 *  you the position and four that need help. */
const TIER_N = 4;

/** A route segment as a non-negative integer, or null for a bogus one. The
 *  house pattern, replicated from App.tsx's `intParam` rather than imported —
 *  it is a private helper of the classic router, and a cross-shell import for
 *  four lines buys a coupling neither side wants.
 *
 *  `Number("abc")` is NaN, and the old `Number.isInteger(NaN) ? … : ident.rid`
 *  read a garbage segment as "no segment at all" and quietly showed the reader
 *  his OWN franchise under someone else's address — a wrong answer wearing a
 *  right one's clothes. */
const intParam = (seg: string | undefined): number | null => {
  if (seg == null) return null;
  const n = Number(seg);
  return Number.isInteger(n) && n >= 0 ? n : null;
};

interface RosterRow {
  key: string;
  name: string;
  /** the identity sub-line: NFL club · position rank, or a pick's provenance.
   *  Slot tags are NOT in here — see `tags` */
  sub: string;
  /** IR / TRADED, passed structurally to `IdCell` so they render as tags.
   *  Joined into `sub` they were body text, and an IR body read as identical
   *  to a bench body. */
  tags: IdTag[];
  pid: string | null;
  /** drives the spine's color, and nothing else. Never the name's. */
  pos: string;
  idx: number | null;
  war: number | null;
  market: number | null;
  /** THE STATS LENS: the season as played, off `<season>/summary.json`.
   *  `war` is realized regular-season WAR (the stats page's column, the
   *  outlook's `banked`), `gp` games dressed under the played rule, and `gs`
   *  the weeks THIS franchise put him in its starting lineup, off
   *  matchups.json. Null where he has no line — never a zero he did not post. */
  st?: { war: number | null; pts: number | null; gp: number | null; gs: number | null };
  /** LINEUP ONLY: the seat this row sits in, which takes the spine's ordinal
   *  slot. Straight out of meta.rosterPositions through SLOT_LABEL. */
  seat?: string;
  /** the SUPER_FLEX seat — tinted, because it is the slot that defines the
   *  league */
  sf?: boolean;
  /** not an asset of this franchise: an unfilled seat, or a pick traded away */
  gone?: boolean;
}

interface RosterBand {
  key: string;
  label: ReactNode;
  note: string;
  /** the spine column's header — "Seat" where the spine carries a lineup slot */
  spLabel: string;
  rows: RosterRow[];
  /** the band's own figure, in the accent. Omitted where the band has no
   *  honest one — an empty taxi squad does not total to zero. */
  total?: ReactNode;
  /** extra class on the table: mtx-lineup, mtx-taxi */
  cls?: string;
  /** what the band says when it holds nothing */
  empty: string;
}

export default function Team() {
  const { meta, league, players } = useLeague();
  /* WHAT THIS LEAGUE HAS. My Team is the landing screen for a claimed reader,
     and it used to gate its whole body on dvi + cvi + projected WAR — three
     files `index_models.py` and `project_war.py` write for the DEFAULT league
     and no other. In Pineapple Pizza all three 404 and the screen sat on
     "Loading…" for the life of the page: no roster, no seasons, no head to
     head, no way out but the tab bar. The roster is a fact about every league
     on the board, so it renders either way and the figures the pipeline never
     computed read as em dashes. */
  const caps = useLeagueCaps();
  const betaPath = useBetaPath();
  const ident = useIdentity();
  const ridSeg = useParams().rid;
  const routeRid = intParam(ridSeg);
  /** the address named a franchise and it is not one. Distinct from "no
   *  segment": /team falls back to the reader's own roster, /team/abc must not. */
  const bogus = ridSeg != null && routeRid == null;
  const rosterSeason = rosterSeasonOf(league);

  const teamsQ = useJson<TeamT[]>(`${rosterSeason}/teams.json`);
  const teams = teamsQ.data;
  const fr = useJson<Franchises>("franchises.json").data;
  // a redraft league has no rookie picks to hold, so there is no Draft capital
  // band and no file to fetch for one
  const owned = useJson<PicksOwned>(caps.picks ? "picks_owned.json" : null).data;
  const vals = useJson<Values>(caps.market ? "data/values.json" : null, "globalDaily").data;
  // the strengths grids' population: rosterShapes seats every projected player
  // on every roster, so it needs the projection file the classic board's
  // TeamStrengths reads for the same purpose
  const proj = useJson<ProjectionsFile>(
    caps.projections ? "projections.json" : null).data;
  const dvi = useDvi();
  const cvi = useCvi();
  // YEAR-ONE composite, matching the League screen and the price board: a
  // lineup card is next season's lineup, and the 3-year stream tripled it
  // (Max, 2026-09-02).
  const war = useProjWar1();
  const tvals = useTeamValues(rosterSeason);
  // where each franchise's own picks project to land — a pick is tiered by
  // its ORIGINAL owner's projected finish, not its holder's
  const tiers = usePickTiers();

  const [lens, setLensRaw] = useState<Lens>("dvi");
  const [idxLens, setIdxLens] = useState<IdxLens>("dvi");
  const setLens = (v: Lens) => {
    setLensRaw(v);
    if (v !== "stats") setIdxLens(v);
  };

  /* THE STATS LENS'S SEASON: the newest one with games in it. In season that
     is the roster season; between the title game and week 1 it is the season
     just finished, which is the one a reader asking "how did he do" means. */
  const statsSeason = meta.latest ?? rosterSeason;
  const sumQ = useJson<SummaryRow[]>(`${statsSeason}/summary.json`);
  const mwStats = useJson<Matchups>(`${statsSeason}/matchups.json`).data;

  /**
   * THE PLAYER PAGE'S SHELL (Max, 2026-09-08): one subject, so the split rail
   * — identity and the season ladder on the left, the figure strip, the
   * outlook and the banded sections on the right — and on a phone the same
   * compact header, jump strip and ladder band the player page collapses to.
   * The two screens are the two "one subject" surfaces on the site and now
   * share one shape; the roster tables below keep the shell's own type ramp.
   */
  const mobile = useMobile();
  const nav = useNavigate();
  // the written outlook, where the pipeline has one for this league (a 404
  // simply leaves the verdict panel out)
  const insights = useJson<Insights>("insights.json").data;
  // the franchise honor index — titles, points crowns, top seeds, playoff
  // appearances — built once per page load from franchises.json + brackets
  const honorIdx = useTeamHonors(meta.seasons);
  const refs = {
    roster: useRef<HTMLDivElement>(null),
    moved: useRef<HTMLDivElement>(null),
    seasons: useRef<HTMLDivElement>(null),
    rivals: useRef<HTMLDivElement>(null),
    records: useRef<HTMLDivElement>(null),
    strengths: useRef<HTMLDivElement>(null),
  };
  const goto = (k: keyof typeof refs) =>
    refs[k].current?.scrollIntoView({ behavior: "smooth", block: "start" });

  // the route's franchise, or — on the bare /team address — yours. A bogus
  // segment is neither: it stays null and the screen says so below.
  const rid = bogus ? null : routeRid ?? ident.rid;
  const team = teams?.find(t => t.roster_id === rid) ?? null;

  const roster = useMemo<{
    bands: RosterBand[]; lineupWar: number | null; asSet: boolean;
  } | null>(() => {
    if (!team) return null;
    /* The index files are OPTIONAL now, not a precondition. `idxFile`
       undefined means "this league has no such index", which every figure
       below resolves to the em dash — the same answer a player the index does
       not cover already got. */
    const idxFile = idxLens === "dvi" ? dvi?.players : cvi?.players;
    const idxOf = (pid: string) => {
      const r = idxFile?.[pid] as { dvi?: number; cvi?: number } | undefined;
      return r ? (idxLens === "dvi" ? r.dvi ?? null : r.cvi ?? null) : null;
    };

    /* ---- the season as played (the Stats lens) --------------------------
       summary.json: [pid, pos, gp, pts, ppg, WAA, WAR, …]. Starts are this
       franchise's, counted off the lineups it actually set in the regular
       season — the roster slot it held THAT season, which in a redraft league
       is not always today's `rid` (lib/seasons.ridOf). */
    const sumBy = new Map((sumQ.data ?? []).map(r => [r[0], r] as const));
    const fkeyNow = String(team.fkey ?? rid);
    const statsRid = statsSeason === rosterSeason
      ? rid
      : ridOf(fkeyNow, seasonRowOf(fr?.[fkeyNow], statsSeason));
    const starts = new Map<string, number>();
    if (mwStats && statsRid != null) {
      const ps = mwStats.playoff_start || 15;
      for (const e of mwStats.teams[String(statsRid)] ?? []) {
        if (e[0] >= ps) continue;                     // regular season only
        for (const pid of e[4] ?? []) {
          // Sleeper writes "0" into a lineup slot nobody filled
          if (pid && pid !== "0") starts.set(pid, (starts.get(pid) ?? 0) + 1);
        }
      }
    }
    const statOf = (pid: string): RosterRow["st"] => {
      const r = sumBy.get(pid);
      return {
        war: r ? r[6] : null,
        pts: r ? r[3] : null,
        gp: r ? r[2] : null,
        // a start is a fact only once the lineups have loaded
        gs: mwStats ? starts.get(pid) ?? 0 : null,
      };
    };
    /** what a row sorts on within its band: the featured column */
    const sortVal = (r: RosterRow) =>
      (lens === "stats" ? r.st?.war : r.idx) ?? -1e9;
    const posRankOf = (pid: string) => idxFile?.[pid]?.pos_rank ?? null;
    // DVI's position, not the featured lens's — the two files agree, and
    // reading ONE of them is what stops the lineup re-seating itself when the
    // reader flips the lens. The seats are won on projected WAR; the lens
    // changes which figure is featured beside them and nothing else. With no
    // index at all, players_min's position is the fallback: it is what the
    // roster rows need the position FOR, which is the spine's colour.
    const posOf = (pid: string) => dvi?.players[pid]?.pos ?? players[pid]?.[1] ?? "?";

    const taxi = new Set(team.taxi), ir = new Set(team.reserve);

    /* QB, RB, WR, TE — the lineup's own order, off POS_CHIPS so there is one
       list of positions on the site rather than two that could disagree.
       Anything the index has no position for sorts last rather than first,
       which is where an unknown belongs on a board about depth. */
    const posOrder = (p: string) => {
      const i = POS_CHIPS.indexOf(p);
      return i < 0 ? POS_CHIPS.length : i;
    };

    const rowOf = (pid: string, o?: { taxi?: boolean; ir?: boolean }): RosterRow => {
      const info = players[pid];
      const pr = posRankOf(pid);
      const p = posOf(pid);
      return {
        key: pid, pid, name: info?.[0] ?? `#${pid}`, pos: p,
        sub: [info?.[2] || null, pr ? `${p}${pr}` : p].filter(Boolean).join(" · "),
        // Only tags that ADD something survive. A bench body needs no BN tag —
        // the band it is in says that — and a taxi body needs no TAXI tag for
        // the same reason. IR takes --warn, because availability is the one
        // roster state that is a caution rather than a label.
        tags: o?.ir ? [{ label: "IR", tone: "ir" as const }] : [],
        idx: idxOf(pid),
        // A TAXI PLAYER HAS NO PROJECTED WAR TO SHOW. He is indexed like anyone
        // else — DVI and CVI price an asset, and a taxi asset is real — but WAR
        // is wins added by a STARTER, and he cannot be started until he is
        // activated. An em dash says that; the figure he would post if he could
        // play would be a lineup contribution the league does not allow.
        war: o?.taxi ? null : war?.[pid] ?? null,
        // THIS LEAGUE'S KTC COLUMN (lib/values.ktcOf, off meta.tep), never the
        // base `row.ktc`: this is a TE-premium league and the two ladders are
        // materially apart for a tight end. Reading the base column here priced
        // one roster row in a market the league does not play in while the
        // strip above it, the leaderboard and the trade machine all quoted the
        // premium one.
        //
        // AND ONLY WHERE THE MARKET DESCRIBES THIS LEAGUE. KTC and FantasyCalc
        // publish DYNASTY prices; in a redraft league the same numbers price a
        // player nobody there can keep, so the column is the em dash rather
        // than a figure from the wrong format.
        market: caps.market ? ktcOf(vals?.players?.[pid], meta.tep) : null,
        st: statOf(pid),
      };
    };

    /* ---- LINEUP ----------------------------------------------------------
       Seats and their order come from meta.rosterPositions; optimalLineup owns
       which player may fill which, and returns them in that same order with the
       bench slots dropped. Taxi and IR players are not in the pool at all —
       neither can be fielded, so seating one would be describing a lineup the
       league would reject.

       WITH NO PROJECTION THERE IS NOTHING TO OPTIMISE, so the band shows the
       LINEUP AS SET — Sleeper's own `starters`, which is parallel to the
       starting slots of meta.rosterPositions. Running the optimiser over a
       pool where every player scores 0 seats the roster in file order and
       calls it the best legal lineup, which is a claim rather than a
       fallback; the band's note says which of the two is on screen. */
    const lineup = lineupOf(meta);
    const pool = team.players
      .filter(pid => !taxi.has(pid) && !ir.has(pid))
      .map(pid => ({ id: pid, pos: posOf(pid), war: war?.[pid] ?? 0 }));
    // the seat list itself, straight out of league.ts's own filter rather than
    // a second copy of "which slots are not starting slots"
    const seats = optimalLineup<{ id: string; pos: string; war: number }>([], lineup).slots;
    const set = (team.starters ?? []).filter(p => p && p !== "0");
    /** the lineup AS SET is usable only when it lines up with the seats it is
     *  supposed to fill — otherwise the indices are meaningless and the
     *  optimiser's arbitrary-but-legal seating is the better answer */
    const asSet = war == null && team.starters?.length === seats.length;
    const { slots, starters } = asSet
      ? {
        slots: seats.map((s, i) => {
          const pid = team.starters[i];
          return {
            slot: s.slot,
            player: pid && pid !== "0" ? { id: pid, pos: posOf(pid), war: 0 } : null,
          };
        }),
        starters: new Set(set),
      }
      : optimalLineup(pool, lineup);

    const startRows: RosterRow[] = slots.map((s, i) => {
      const seat = SLOT_LABEL[s.slot] ?? s.slot;
      const sf = s.slot === "SUPER_FLEX";
      // An unfilled seat is a row, not a gap: "no eligible player" is a real
      // statement about a roster, and dropping the row would silently shorten
      // the lineup to whatever this franchise happens to be able to field.
      if (!s.player) return {
        key: `${s.slot}-${i}`, pid: null, name: "Empty", pos: "",
        sub: "no eligible player on the roster", tags: [],
        idx: null, war: null, market: null, seat, sf, gone: true,
      };
      return { ...rowOf(s.player.id), key: `${s.slot}-${i}`, seat, sf };
    });

    /* ---- BENCH -----------------------------------------------------------
       Everyone the lineup did not seat, minus the taxi squad, which is its own
       band. An IR body sits here with its tag: it occupies a reserve slot
       rather than a bench slot, so it is named separately in the note and left
       out of the bench count. */
    /* BY POSITION, THEN BY VALUE (Max, 2026-09-03). A flat value order answers
       "who is the best player sitting here", which the lineup above has already
       settled — the interesting question about a bench is DEPTH, and depth is a
       question about one position at a time. Grouped, the four runs read as
       four answers: how many quarterbacks are behind the starter and what the
       drop is, then the same for the backs. Ungrouped, a reader has to
       reconstruct that by scanning the position on every row.

       The value inside a group is the LENS in force, not DVI specifically — the
       column beside it is that lens, and ordering by the other one would put
       the rows in an order the visible figure does not explain. DVI is the
       default, so the default board is exactly the ask. Under Stats it is
       accrued WAR, the first of that lens's columns. */
    const benchRows = team.players
      .filter(pid => !starters.has(pid) && !taxi.has(pid))
      .map(pid => rowOf(pid, { ir: ir.has(pid) }))
      .sort((a, b) =>
        posOrder(a.pos) - posOrder(b.pos) || sortVal(b) - sortVal(a));

    /* ---- TAXI ------------------------------------------------------------ */
    const taxiRows = team.players
      .filter(pid => taxi.has(pid))
      .map(pid => rowOf(pid, { taxi: true }))
      .sort((a, b) => sortVal(b) - sortVal(a));

    // capacities are league settings, read from the league's own files
    const benchSlots = lineup.filter(s => s === "BN").length;
    const taxiSlots = meta.taxiSlots ?? lineup.filter(s => s === "TAXI").length;
    const onIr = team.players.filter(pid => ir.has(pid)).length;

    /* ---- DRAFT CAPITAL ---------------------------------------------------
       A FLAT PER-PICK LIST, by year then round, holdings and departures in one
       sequence. picks_owned.json states who holds every pick in the league, so
       both halves come out of the same file: a pick this franchise holds is an
       entry under its own roster id, and a pick it has traded away is one of
       its own picks (orig === rid) sitting under somebody else's. */
    const ktcPicks = new Map(vals?.picks?.ktc ?? []);
    const teamName = (r: number) => teams?.find(t => t.roster_id === r)?.team ?? `Roster ${r}`;
    const roundOrd = (r: number) => ROUND_ORD[r - 1] ?? `R${r}`;

    // annotated rather than left to `?? {}`, which widens to `{}` and takes
    // Object.entries' untyped overload with it
    const byHolder: PicksOwned["owned"] = owned?.owned ?? {};
    const everyPick: { season: number; round: number; orig: number; holder: number }[] = [];
    for (const [holder, list] of Object.entries(byHolder))
      for (const p of list) everyPick.push({ ...p, holder: Number(holder) });

    const pickRows: RosterRow[] = everyPick
      .filter(p => p.holder === rid || p.orig === rid)
      .sort((a, b) =>
        a.season - b.season
        || a.round - b.round
        // within a round: what you hold, then what you gave up
        || Number(b.holder === rid) - Number(a.holder === rid)
        || a.orig - b.orig)
      .map(p => {
        const held = p.holder === rid;
        return {
          key: `${p.season}-${p.round}-${p.orig}-${p.holder}`,
          pid: null, name: `${p.season} ${roundOrd(p.round)}`, pos: "PICK",
          sub: (held
            ? (p.orig === rid ? "Own" : `via ${teamName(p.orig)}`)
            : `to ${teamName(p.holder)}`) + ` · proj. ${tierOf(tiers, p.orig).toLowerCase()}`,
          tags: held ? [] : ["Traded"],
          // A pick has no index and never will until it converts: DVI and CVI
          // are computed from a projection, and there is no player to project.
          // An em dash says that; a 0 would say the pick is worthless.
          idx: null, war: null,
          // The tier is INFERRED (Max, 2026-09-02): the original owner's
          // projected finish says where the pick lands, so a 1st from the
          // projected worst team prices Early and one from the projected
          // champion prices Late. A pick that is gone carries no price at all
          // — it is not this franchise's to be worth anything.
          market: held && caps.market
            ? ktcPicks.get(`${p.season} ${tierOf(tiers, p.orig)} ${roundOrd(p.round)}`) ?? null
            : null,
          gone: !held,
        };
      });

    const sum = (rows: RosterRow[], k: (r: RosterRow) => number | null) =>
      rows.reduce((a, r) => a + (k(r) ?? 0), 0);
    const lineupWar = war == null ? null : sum(startRows, r => r.war);
    /** A BAND TOTALS IN A CURRENCY IT ACTUALLY CARRIES. WAR where the league
     *  has a projection, the lens index where it has one of those instead, and
     *  no total at all where it has neither — "0.00 WAR" for a roster nobody
     *  ever projected is the zero this board spends its em dashes avoiding. */
    const bandTotal = (rows: RosterRow[]): ReactNode => {
      if (!rows.length) return undefined;
      // under Stats the band totals what its rows BANKED, and says so
      if (lens === "stats")
        return sumQ.data ? `${sgnWar(sum(rows, r => r.st?.war ?? null))} WAR banked` : undefined;
      if (war != null) return `${sgnWar(sum(rows, r => r.war))} WAR`;
      if (idxFile) return `${Math.round(sum(rows, r => r.idx))} ${idxLens.toUpperCase()}`;
      return undefined;
    };

    const bands: RosterBand[] = [
      {
        key: "lu", label: "Lineup", cls: "mtx-lineup", spLabel: "Seat",
        note: asSet
          ? "Seats in league order · the lineup as set — this league has no published projection to optimise one from"
          : "Seats in league order · best legal lineup by projected WAR, not the lineup as set",
        rows: startRows, total: bandTotal(startRows),
        empty: "No lineup.",
      },
      {
        key: "bn", label: "Bench", spLabel: "#",
        // The total runs negative on every roster in the league and that is
        // correct, not a bug: WAR is measured against replacement, and a bench
        // is mostly players below it. Said here so the figure is read as depth
        // rather than as damage.
        note: (benchSlots
          ? `${benchRows.length - onIr} of ${benchSlots} slots`
          : `${benchRows.length - onIr} behind the lineup`)
          + (onIr ? ` · ${onIr} on IR` : "")
          + (war != null ? " · sums negative because WAR is measured against replacement" : ""),
        rows: benchRows, total: bandTotal(benchRows),
        empty: "Nobody behind the lineup.",
      },
    ];
    if (taxiSlots > 0 || taxiRows.length) bands.push({
      key: "tx", label: <span className="mtx-amber">Taxi squad</span>,
      cls: "mtx-taxi", spLabel: "#",
      note: (taxiSlots ? `${taxiRows.length} of ${taxiSlots} slots · ` : "")
        + "indexed like any asset · no projected WAR until a player is activated",
      rows: taxiRows,
      // WAR is unavailable here by construction, so the band totals in the
      // currency its rows actually carry, and names it. An EMPTY taxi squad
      // gets no total at all rather than "0 DVI" — four unused slots are not
      // four worthless players.
      total: lens === "stats"
        ? bandTotal(taxiRows)
        : taxiRows.length && idxFile
          ? `${Math.round(sum(taxiRows, r => r.idx))} ${idxLens.toUpperCase()}`
          : undefined,
      empty: "Taxi squad empty.",
    });
    if (pickRows.length) bands.push({
      key: "pk", label: "Draft capital", spLabel: "#",
      note: "Held and traded away · each pick tiered Early / Mid / Late by its original owner's projected finish this season",
      rows: pickRows,
      // the "≈" is the estimate mark and the figure is a market one — both
      // gone in a league whose format the dynasty market does not price
      total: caps.market
        ? `≈ ${Math.round(sum(pickRows, r => r.market)).toLocaleString()}`
        : undefined,
      empty: "No picks on the books.",
    });
    return { bands, lineupWar, asSet };
  }, [team, dvi, cvi, war, vals, owned, players, meta, lens, idxLens, rid, teams, tiers,
    caps.market, sumQ.data, mwStats, fr, statsSeason, rosterSeason]);

  /* ---- strengths --------------------------------------------------------
     rosterShapes' own output, unchanged: the optimal starting eight and the
     second string behind it, every seat ranked against the same seat on the
     other eleven rosters, in both currencies. Same inputs TeamStrengths hands
     it, including the roster POOL — that function prices every rostered player,
     taxi included, which is why a taxi body can hold a seat here and never
     appears in the Lineup band above. */
  const shape = useMemo(() => {
    if (!proj || !teams || !dvi || !cvi || rid == null) return null;
    // pos_rank comes from the index file itself, so it is the player's rank
    // among ALL QBs/RBs/… in that currency — not his rank among the twelve
    // players sitting in this seat, which is what the meter already shows.
    const flatDvi: Record<string, IndexEntry> = {};
    for (const [pid, r] of Object.entries(dvi.players))
      flatDvi[pid] = { value: r.dvi, posRank: r.pos_rank };
    const flatCvi: Record<string, IndexEntry> = {};
    for (const [pid, r] of Object.entries(cvi.players))
      flatCvi[pid] = { value: r.cvi, posRank: r.pos_rank };
    return rosterShapes(proj.players, teams,
      { cvi: flatCvi, dvi: flatDvi }, lineupOf(meta)).get(rid) ?? null;
  }, [proj, teams, dvi, cvi, meta, rid]);

  /* ---- nobody to point at yet ------------------------------------------
     The claim lives on its own address rather than inline here, so that the
     same surface answers both "who are you" and "you picked wrong" — see
     screens/Claim. Wait for the rosters first: deriving from a username needs
     them, and redirecting before they land sends a returning reader to the
     picker for one frame every time they open the app. */
  /* A GARBAGE SEGMENT GETS THE SAME ANSWER A MISSING FRANCHISE DOES, and it
     gets it BEFORE the claim redirect: /team/abc is a reader following a broken
     link, not one who has never claimed a team, and bouncing him to the picker
     would answer a question he did not ask. */
  if (bogus) return (
    <div className="empty">No franchise {ridSeg} in {rosterSeason}.</div>
  );
  if (rid == null) {
    if (teamsQ.error) return <DataError what="Rosters didn't load" />;
    if (!teams) return <div className="empty">Loading…</div>;
    return <Navigate to={betaPath("/claim")} replace />;
  }
  if (teamsQ.error) return <DataError what="This roster didn't load" />;
  if (!teams) return <div className="empty">Loading…</div>;
  /* BEFORE the roster gate, not after. `roster` is null whenever `team` is,
     so `!teams || !roster` swallowed this case and /team/9999 sat on "Loading…"
     for the life of the page with the line below it unreachable. A franchise
     that is not in this season is an answer; only the indices are still coming. */
  if (!team) return (
    <div className="empty">No franchise {rid} in {rosterSeason}.</div>
  );
  if (!roster) return <div className="empty">Loading…</div>;

  /* THE FRANCHISE KEY, not the roster id. franchises.json is keyed by the
     roster_id in a dynasty league and by the owner's 18-digit Sleeper user_id
     in a redraft one, so `fr[String(rid)]` resolved to nothing at all in
     Pineapple Pizza: the record figure read "—", the rail's season ladder was
     empty, and the honors and the seasons table two sections below — which
     already used the key — disagreed with both. One expression, used
     everywhere on the screen. */
  const fkey = String(team.fkey ?? rid);
  const franchise = fr?.[fkey];
  const season = franchise?.seasons.slice().reverse()
    .find(s => s.wins + s.losses + s.ties > 0);
  const idxRank = tvals
    ? rankMap(tvals, t => (idxLens === "dvi" ? t.dvi : t.cvi), t => t.rid).get(rid) ?? null
    : null;
  const mine = tvals?.find(t => t.rid === rid);
  const marketRank = tvals ? rankMap(tvals, t => t.market, t => t.rid).get(rid) ?? null : null;

  /** the figure strip — the player page's `.figstrip` anatomy: key, figure,
   *  sub-label. Em dashes are plain text here, as they are on that page:
   *  `.nul` is scoped to table cells. */
  const figures: { key: string; label: string; value: ReactNode; sub?: string; acc?: boolean }[] = [
    {
      key: "rec", label: "Record",
      value: season ? `${season.wins}-${season.losses}${season.ties ? `-${season.ties}` : ""}` : "—",
      sub: season ? `${season.season} · ${fmt(season.ppg, 1)} ppg` : "no season played",
    },
    {
      key: "rk", label: `${idxLens.toUpperCase()} rank`,
      value: idxRank ?? "—", acc: true,
      /* THE STRIP FIGURE AND THE BOARD READ ONE NUMBER (2026-09-21). Both are
         `model.starterSum` — each index over its OWN best legal lineup, the
         classic Value board's rule — where the Teams board used to sum DVI
         over the projected-WAR lineup and land 50 points away from this. */
      sub: mine
        ? `${Math.round(idxLens === "dvi" ? mine.dvi : mine.cvi)} index pts, starters`
        : caps.indices ? undefined : "not published for this league",
    },
    {
      // THE BAND'S OWN NUMBER, not the rankings model's. Both are "best legal
      // lineup", but this screen's excludes the taxi squad and IR the way a
      // lineup card does, and a strip figure that disagreed with the total two
      // bands below it would be a bug the reader can see.
      key: "war", label: "Proj WAR",
      value: roster.lineupWar == null ? "—" : sgnWar(roster.lineupWar),
      sub: roster.lineupWar == null
        ? "not published for this league"
        : `best legal lineup, ${rosterSeason}`,
    },
    {
      key: "mkt", label: "Market",
      value: caps.market && mine ? Math.round(mine.market).toLocaleString() : "—",
      sub: !caps.market
        ? "dynasty prices — not this league's format"
        : marketRank ? `${marketRank} of ${tvals?.length} · KTC, picks included` : undefined,
    },
  ];

  const n = teams.length;
  const you = ident.rid === rid;
  const insight = insights?.teams[String(rid)] ?? null;
  /** the franchise's honors: totals for the identity block, per season for
   *  the ladder. Keyed by franchise key — the roster id, in a dynasty league. */
  const honorRows = franchiseHonors(honorIdx, fkey);
  const honorBySeason = new Map(honorRows.map(r => [r.season, r.keys]));
  const honorCareer = teamHonorTotals(honorRows);

  /* ---- the rail's parts, built once and placed by shape ------------------
     The same split the player page makes: desktop puts them in the 232px
     rail, the phone puts identity and the jumps in a header and the ladder in
     a band under the figures. One definition each, so the shapes cannot drift. */

  /** name, manager, and the identity escape hatch. On the screen where
   *  picking wrong actually bites: looking at your own team it re-opens the
   *  picker; looking at anyone else's it is the fastest possible correction —
   *  the roster in front of you is the one you meant, so claim it in place. */
  const identity = (
    <>
      <div className="rail-name">{team.team}</div>
      <div className="rail-sub">{team.manager}{you ? " · you" : ""}</div>
      {you
        ? <RouteLink to={betaPath("/claim")} className="rail-claim">Not you?</RouteLink>
        : <button type="button" className="rail-claim" onClick={() => ident.claim(rid)}>This is me</button>}
    </>
  );

  /** the section jumps — buttons, not anchors: the targets are refs */
  const jumps = (
    <>
      <button onClick={() => goto("roster")}>Roster</button>
      {shape && <button onClick={() => goto("strengths")}>Strengths</button>}
      <button onClick={() => goto("moved")}>Recent activity</button>
      <button onClick={() => goto("seasons")}>Seasons</button>
      <button onClick={() => goto("rivals")}>Head to head</button>
      <button onClick={() => goto("records")}>Record book</button>
    </>
  );

  /** THE SEASON LADDER, newest first — the franchise page's rail rows: year,
   *  finish, record, and the name it played under. Each taps through to that
   *  season on the League screen; the roster season reads "live". The accent
   *  marks a title, the one honour a franchise ladder has to carry. */
  const ladderRows = (() => {
    const seasons = franchise?.seasons ?? [];
    if (!seasons.length) return null;
    return (
      <div className="rail-ladder">
        {seasons.slice().reverse().map(s => {
          const live = s.season === rosterSeason && s.wins + s.losses + s.ties === 0;
          return (
            <RouteLink key={s.season} className="rail-season pick"
              to={betaPath(live ? "/league" : `/league?scope=history&season=${s.season}`)}>
              <div className="l1">
                <span className="yr">{s.season}</span>
                <span className="fin" style={s.finish === 1 ? { color: "var(--acc)" } : undefined}>
                  {s.finish === 1 ? "CHAMP" : s.finish != null ? ord(s.finish) : live ? "live" : "—"}
                </span>
                <span className="rec">{live ? "—" : `${s.wins}-${s.losses}${s.ties ? `-${s.ties}` : ""}`}</span>
              </div>
              {/* the name it played under, and what it won that year */}
              <div className="l2">
                <span className="tname">{s.name}</span>
                {(honorBySeason.get(s.season)?.length ?? 0) > 0 && (
                  <TeamHonorMarks marks={honorBySeason.get(s.season)!} size={14} showCounts={false} />
                )}
              </div>
            </RouteLink>
          );
        })}
      </div>
    );
  })();

  return (
    <>
      <HonorSprite />
      <div className="screen-head">
        <span className="screen-title">Franchise</span>
        {/* the classic shapes rebased into this shell, so a jump stays here */}
        <QuickJump path={p => betaPath(p.replace(/^\/franchise\//, "/team/"))} />
      </div>
      <div className="board" style={{ marginTop: 0 }}>
        <div className={`split${mobile ? " phone" : ""}`}>
          {mobile ? (
            /* THE PHONE HEADER — the player page's, the team's picture where
               the headshot goes */
            <div className="pid-head">
              <span className="rail-back" onClick={() => nav(-1)}>← Back</span>
              <div className="pid-row">
                <TeamAvatar src={team.avatar} size={76} />
                <div className="pid-id">{identity}</div>
              </div>
              {honorCareer.length > 0 && (
                <div className="pid-honors">
                  <span className="k">Honors</span>
                  <TeamHonorMarks marks={honorCareer} />
                </div>
              )}
              <div className="pid-jump" role="navigation" aria-label="On this page">{jumps}</div>
            </div>
          ) : (
            <div className="rail">
              <span className="rail-back" onClick={() => nav(-1)}>← Back</span>
              <TeamAvatar src={team.avatar} />
              {identity}
              {honorCareer.length > 0 && (
                <>
                  <div className="rail-h">Honors</div>
                  <div className="rail-honors">
                    <TeamHonorMarks marks={honorCareer} />
                  </div>
                </>
              )}
              {ladderRows && <>
                <div className="rail-h">Seasons</div>
                {ladderRows}
                <TeamHonorLegend />
              </>}
              <div className="rail-h">On this page</div>
              <div className="rail-nav">{jumps}</div>
            </div>
          )}

          <div className="main">
            <div className="figstrip">
              {figures.map(f => (
                <div className="figcell" key={f.key}>
                  <div className="figkey">{f.label}</div>
                  <div className={`figval${f.acc ? " acc" : ""}`}>{f.value}</div>
                  {f.sub && <div className="figsub">{f.sub}</div>}
                </div>
              ))}
            </div>

            {/* THE PHONE'S LADDER BAND IS GONE (Max, 2026-09-15): the season
                ledger below carries every row it did and opens each into its
                weeks; the desktop rail keeps the ladder as navigation. */}

            {insight && (
              /* the verdict panel: prose that interprets the figures, on
                 --panel behind the accent rule, the same object as the
                 player page's Model read */
              <div className="verdict">
                <div className="k">{insights?.meta.season} outlook</div>
                <div className="meta">{insight.head} · written {insights?.meta.generated}</div>
                <div className="body">{insight.text}</div>
              </div>
            )}

            {/* The lens toggle sits above the roster, not in the masthead: it
                scopes THIS screen's featured column, the rank figure above it
                and the tier rule down in Strengths — and nothing else on the
                site. Same control object as the leaderboard's lens strip — two
                segments instead of four, but provably one control rather than
                two lookalikes. */}
            <div ref={refs.roster}>
              {/* A CONTROL WITH NOTHING TO SWITCH BETWEEN IS NOT A CONTROL.
                  Where the pipeline publishes neither index, the index
                  segments select between empty columns. */}
              {caps.indices && (
                <LensStrip options={lensesFor(statsSeason)} value={lens} onChange={setLens} label="Lens" />
              )}

              {roster.bands.map(b => (
                <RosterTable key={b.key} band={b} lens={lens} betaPath={betaPath} />
              ))}

              {/* SAID ONCE, UNDER THE TABLES THAT SHOW IT. Three columns of em
                  dashes is a question, and the answer is not "the data didn't
                  load" — it is that these figures are computed for one league
                  and this is the other one. */}
              {(!caps.indices || !caps.projections || !caps.market) && (
                <div className="tnote screen">
                  {[
                    caps.indices ? null : "DVI and CVI",
                    caps.projections ? null : "projected WAR",
                    caps.market ? null : "the dynasty market",
                  ].filter(Boolean).join(", ").replace(/, ([^,]*)$/, " and $1")}
                  {" "}
                  {caps.indices && caps.projections ? "is" : "are"} not published for {league.name} —
                  the nightly projection and index runs cover the home league only, and the dynasty
                  market prices a format this league does not play. The roster, the seasons and the
                  head-to-head record below are this league's own.
                </div>
              )}
            </div>

            {/* ---- strengths ----
                RIGHT UNDER THE ROSTER (Max, 2026-09-29): the page reads
                current roster, draft capital, strengths, then the history.
                The classic board's TeamStrengths, transposed: it draws one row
                per currency across nine seat columns, which is a grid that has
                to scroll sideways on a phone and loses the seat the moment it
                does. Here the SEAT is the row and the currencies are two
                labeled meters inside it, so a thumb reads down the depth chart
                instead of across a scroll. The figures, the ranks and the
                meter scale are that component's, unchanged. */}
            {shape && (
              <div ref={refs.strengths}>
                <Band label="Strengths"
                  note={`Each seat against the same seat on the other ${n - 1} rosters · rank of ${n}`} />
                <Seats rows={shape.ranks} n={n} lens={idxLens} />
                <Band label="Second string"
                  note="The same seats again, refilled from everyone who missed the first cut" />
                <Seats rows={shape.benchRanks} n={n} lens={idxLens} />
              </div>
            )}

            {/* ---- what moved ----
                The League screen's module, scoped to this franchise (Max,
                2026-09-08): its trades and roster moves over the last seven
                days, the biggest deal as a card, and the ledger link
                pre-filtered to it. After the strengths and before the
                history, because a roster read yesterday is not the roster on
                screen. */}
            <div ref={refs.moved}>
              <Moved rid={rid} fkey={fkey} teamName={team.team} />
            </div>

            {/* ---- the seasons ----
                "How did my season go" (Max, 2026-09-15): the record, one row
                per season, each opening into its weeks. After the roster, its
                strengths and what moved: the roster is why the reader came,
                the history is what he asks second. */}
            <div ref={refs.seasons}>
              <TeamSeasons fkey={fkey} rid={rid} fr={fr}
                honors={honorBySeason} rosterSeason={rosterSeason} />
            </div>

            {/* ---- head to head ----
                "My record against everyone else" (Max, 2026-09-21), filterable
                by regular season, playoffs, or both. */}
            <div ref={refs.rivals}>
              <TeamRivals fkey={fkey} fr={fr}
                seasons={meta.seasons} rosterSeason={rosterSeason} />
            </div>

            {/* ---- the record book ----
                "A personal record book for each team" (Max, 2026-09-27): the
                franchise's best and worst games, its streaks, and the best
                games and seasons its starters ever gave it. */}
            <div ref={refs.records}>
              <TeamRecords fkey={fkey} fr={fr} seasons={meta.seasons} />
            </div>

          </div>
        </div>
      </div>
    </>
  );
}

/* ---- one banded roster table -------------------------------------------- */

function RosterTable({ band, lens, betaPath }: {
  band: RosterBand; lens: Lens; betaPath: (p: string) => string;
}) {
  const stats = lens === "stats";
  return (
    <>
      <Band label={band.label} total={band.total} note={band.note} />
      <table className={`v3tbl roster${band.cls ? ` ${band.cls}` : ""}`}>
        <thead>
          <tr>
            <th className="c sp">{band.spLabel}</th>
            <th className="t">Player</th>
            {/* the column budget is positional (beta.css), so the Stats
                lens's three columns ride the same three classes */}
            {stats ? <>
              <th className="n lens" title="Realized regular-season WAR, per game under it">WAR</th>
              <th className="n war" title="Fantasy points, per game under it">Pts</th>
              <th className="n mkt" title="Games played, lineup starts for this franchise under it">GP</th>
            </> : <>
              <th className="n lens">{lens.toUpperCase()}</th>
              <th className="n war">WAR</th>
              <th className="n mkt">Market</th>
            </>}
          </tr>
        </thead>
        <tbody>
          {band.rows.map((r, i) => {
            const body = (
              <>
                {/* THE POSITION LIVES HERE. This is the one screen where every
                    row has a position and none of them showed it — the spine
                    carries the color, never the name. What sits beside the bar
                    is the row's place WITHIN ITS BAND: the LINEUP SEAT for a
                    starter, which is a league setting rather than a ranking,
                    and an ordinal everywhere else (index order on the bench and
                    the taxi squad, year-then-round for the picks). Never a
                    league rank it would be lying about. */}
                <Spine color={POS_COLOR[r.pos]} rank={r.seat ?? i + 1} />
                <IdCell name={r.name} sub={r.sub} tags={r.tags}
                  to={r.pid ? betaPath(`/player/${r.pid}`) : undefined} />
                {/* ONE FIGURE RAMP ACROSS THE THREE COLUMNS (Max, 2026-09-02):
                    the same face, size and weight for index, WAR and market,
                    a step under `.f` so the row still fits a phone. The old
                    `.hd` / plain / `.q` ladder made the market column read as
                    a footnote to the index; decision #12's "market trails" now
                    rides the column ORDER and nothing else. Size lives on
                    `.v3tbl.roster td .f` in team.css. */}
                {stats ? (() => {
                  /* THE SEASON AS PLAYED: each figure over its rate. WAR per
                     game at three places — the rate lives in the third digit
                     the way a season total lives in the second. */
                  const st = r.st;
                  const gp = st?.gp ?? null;
                  return <>
                    <td className="n">
                      <span className="f">{st?.war == null ? NUL : sgnWar(st.war)}</span>
                      <div className="idc-s r">{st?.war != null && gp ? `${sgn(st.war / gp, 3)}/g` : ""}</div>
                    </td>
                    <td className="n">
                      <span className="f">{st?.pts == null ? NUL : fmt(st.pts, 1)}</span>
                      <div className="idc-s r">{st?.pts != null && gp ? `${fmt(st.pts / gp, 1)} ppg` : ""}</div>
                    </td>
                    <td className="n">
                      <span className="f">{gp == null ? NUL : gp}</span>
                      <div className="idc-s r">{st?.gs != null ? `${st.gs} GS` : ""}</div>
                    </td>
                  </>;
                })() : <>
                  <td className="n">
                    <span className="f">{r.idx == null ? NUL : fmt(r.idx, 1)}</span>
                  </td>
                  <td className="n">
                    <span className="f">{r.war == null ? NUL : sgnWar(r.war)}</span>
                  </td>
                  <td className="n">
                    <span className="f">{r.market == null ? NUL : r.market.toLocaleString()}</span>
                  </td>
                </>}
              </>
            );
            const cls = [i % 2 ? "zebra" : "", r.sf ? "mtx-sf" : "", r.gone ? "mtx-gone" : ""]
              .filter(Boolean).join(" ");
            return r.pid
              ? <TapRow key={r.key} to={betaPath(`/player/${r.pid}`)} className={cls}>{body}</TapRow>
              : <tr key={r.key} className={cls}>{body}</tr>;
          })}
          {!band.rows.length && (
            <tr><td colSpan={5} className="t"><span className="f q">{band.empty}</span></td></tr>
          )}
        </tbody>
      </table>
    </>
  );
}

/* ---- the strengths seat rows --------------------------------------------- */

/**
 * One row per lineup seat — QB1, QB2, RB1, RB2, WR1, WR2, WR3, TE1 — carrying
 * a labeled meter per currency and whoever holds that seat in it.
 *
 * The meter is on the seat's LEAGUE RANK, never on the index value: DVI and CVI
 * are already normalized 0-100 and the system forbids metering them. Its scale
 * is rosterShapes' own — first of twelve fills the track, twelfth fills a
 * twelfth of it — so the bar reads as "how much of the league is behind this
 * seat" rather than as a value.
 */
function Seats({ rows, n, lens }: { rows: RankRow[]; n: number; lens: IdxLens }) {
  if (!rows.length) return null;
  return (
    <div className="mtx-str">
      {rows[0].cells.map((seat, i) => {
        const cells = rows.map(r => ({ key: r.key, label: r.label, c: r.cells[i] }));
        // The tier rule needs ONE rank, and the reader has already said which
        // currency they are reading in. An empty seat ranks last in both, so it
        // reads red — which is the right answer: the hole is the finding.
        const lead = (cells.find(x => x.key === lens) ?? cells[0]).c;
        const tier = lead.rank <= TIER_N ? "var(--good)"
          : lead.rank > n - TIER_N ? "var(--bad)"
            : "var(--rule-2)";
        return (
          <div key={seat.label} className={`mtx-str-row${i % 2 ? " mtx-zebra" : ""}`}>
            <span className="mtx-tier" style={{ background: tier }} />
            <span className="mtx-seat">{seat.label}</span>
            <div className="mtx-str-cells">
              {cells.map(({ key, label, c }) => (
                <div key={key} className="mtx-str-cell" title={c.pid
                  ? `${c.name} — ${fmt(c.value, 1)}`
                    + (c.posRank ? ` — ${c.pos}${c.posRank}` : "")
                  : "no player for this seat"}>
                  <span className="mtx-k">{label}</span>
                  <span className="mtx-track">
                    <i className={`mtx-fill${c.rank === 1 ? " mtx-top" : ""}`}
                      style={{ width: `${((n - c.rank + 1) / n) * 100}%` }} />
                  </span>
                  <span className={`mtx-fig${c.rank === 1 ? " mtx-top" : ""}`}>{ord(c.rank)}</span>
                  <span className={`mtx-who${c.pid ? "" : " mtx-none"}`}>
                    {c.pid ? surname(c.name) : "empty"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
