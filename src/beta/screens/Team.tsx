import { useMemo, useState, type ReactNode } from "react";
import { Navigate, useParams } from "react-router-dom";
import type {
  Franchises, PicksOwned, ProjectionsFile, Team as TeamT, Values,
} from "../../lib/types";
import { useJson } from "../../lib/useJson";
import { useLeague } from "../../lib/context";
import { useCvi, useDvi, useProjWar1 } from "../../lib/useIndices";
import { useIdentity } from "../../lib/identity";
import { fmt, ord, sgnWar } from "../../lib/stats";
import { POS_COLOR, SLOT_LABEL, lineupOf, optimalLineup, rosterSeasonOf } from "../../lib/league";
import { ktcOf } from "../../lib/values";
import { ROUND_ORD, rosterShapes, type IndexEntry, type RankRow } from "../../lib/rosterModel";
import { nearestPick, rankMap, useTeamValues } from "../model";
import {
  Band, DataError, IdCell, LensStrip, NUL, Spine, Strip, TapRow, useBetaPath,
  type Figure, type IdTag,
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

type Lens = "dvi" | "cvi";

/** The one toggle on this screen. Declared as data so it rides `LensStrip` —
 *  the same control the leaderboard uses — rather than two hand-rolled buttons
 *  that happen to carry the same classes. */
const LENSES: { id: Lens; label: string }[] = [
  { id: "dvi", label: "DVI · dynasty" },
  { id: "cvi", label: "CVI · win now" },
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
  /** drives the spine's colour, and nothing else. Never the name's. */
  pos: string;
  idx: number | null;
  war: number | null;
  market: number | null;
  /** picks only: the current-year slot this price is worth */
  equiv?: string | null;
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
  const owned = useJson<PicksOwned>("picks_owned.json").data;
  const vals = useJson<Values>("data/values.json", "globalDaily").data;
  // the strengths grids' population: rosterShapes seats every projected player
  // on every roster, so it needs the projection file the classic board's
  // TeamStrengths reads for the same purpose
  const proj = useJson<ProjectionsFile>("projections.json").data;
  const dvi = useDvi();
  const cvi = useCvi();
  // YEAR-ONE composite, matching the League screen and the price board: a
  // lineup card is next season's lineup, and the 3-year stream tripled it
  // (Max, 2026-09-02).
  const war = useProjWar1();
  const tvals = useTeamValues(rosterSeason);

  const [lens, setLens] = useState<Lens>("dvi");

  // the route's franchise, or — on the bare /team address — yours. A bogus
  // segment is neither: it stays null and the screen says so below.
  const rid = bogus ? null : routeRid ?? ident.rid;
  const team = teams?.find(t => t.roster_id === rid) ?? null;

  const roster = useMemo<{ bands: RosterBand[]; lineupWar: number } | null>(() => {
    if (!team || !dvi || !cvi || !war) return null;
    const idxFile = lens === "dvi" ? dvi.players : cvi.players;
    const idxOf = (pid: string) => {
      const r = idxFile[pid] as { dvi?: number; cvi?: number } | undefined;
      return r ? (lens === "dvi" ? r.dvi ?? null : r.cvi ?? null) : null;
    };
    const posRankOf = (pid: string) => idxFile[pid]?.pos_rank ?? null;
    // DVI's position, not the featured lens's — the two files agree, and
    // reading ONE of them is what stops the lineup re-seating itself when the
    // reader flips the lens. The seats are won on projected WAR; the lens
    // changes which figure is featured beside them and nothing else.
    const posOf = (pid: string) => dvi.players[pid]?.pos ?? players[pid]?.[1] ?? "?";

    const taxi = new Set(team.taxi), ir = new Set(team.reserve);

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
        war: o?.taxi ? null : war[pid] ?? null,
        // THIS LEAGUE'S KTC COLUMN (lib/values.ktcOf, off meta.tep), never the
        // base `row.ktc`: this is a TE-premium league and the two ladders are
        // materially apart for a tight end. Reading the base column here priced
        // one roster row in a market the league does not play in while the
        // strip above it, the leaderboard and the trade machine all quoted the
        // premium one.
        market: ktcOf(vals?.players?.[pid], meta.tep),
      };
    };

    /* ---- LINEUP ----------------------------------------------------------
       Seats and their order come from meta.rosterPositions; optimalLineup owns
       which player may fill which, and returns them in that same order with the
       bench slots dropped. Taxi and IR players are not in the pool at all —
       neither can be fielded, so seating one would be describing a lineup the
       league would reject. */
    const lineup = lineupOf(meta);
    const pool = team.players
      .filter(pid => !taxi.has(pid) && !ir.has(pid))
      .map(pid => ({ id: pid, pos: posOf(pid), war: war[pid] ?? 0 }));
    const { slots, starters } = optimalLineup(pool, lineup);

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
    const benchRows = team.players
      .filter(pid => !starters.has(pid) && !taxi.has(pid))
      .map(pid => rowOf(pid, { ir: ir.has(pid) }))
      .sort((a, b) => (b.idx ?? -1) - (a.idx ?? -1));

    /* ---- TAXI ------------------------------------------------------------ */
    const taxiRows = team.players
      .filter(pid => taxi.has(pid))
      .map(pid => rowOf(pid, { taxi: true }))
      .sort((a, b) => (b.idx ?? -1) - (a.idx ?? -1));

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
          sub: held
            ? (p.orig === rid ? "Own" : `via ${teamName(p.orig)}`)
            : `to ${teamName(p.holder)}`,
          tags: held ? [] : ["Traded"],
          // A pick has no index and never will until it converts: DVI and CVI
          // are computed from a projection, and there is no player to project.
          // An em dash says that; a 0 would say the pick is worthless.
          idx: null, war: null,
          // Mid tier for every future pick: the slot depends on a finish nobody
          // knows yet, and a uniform assumption keeps twelve rosters comparable.
          // A pick that is gone carries no price at all — it is not this
          // franchise's to be worth anything.
          market: held
            ? ktcPicks.get(`${p.season} Mid ${roundOrd(p.round)}`) ?? null
            : null,
          equiv: held ? nearestPick(vals, p.season, p.round, "Mid") : null,
          gone: !held,
        };
      });

    const sum = (rows: RosterRow[], k: (r: RosterRow) => number | null) =>
      rows.reduce((a, r) => a + (k(r) ?? 0), 0);
    const lineupWar = sum(startRows, r => r.war);

    const bands: RosterBand[] = [
      {
        key: "lu", label: "Lineup", cls: "mtx-lineup", spLabel: "Seat",
        note: "Seats in league order · best legal lineup by projected WAR, not the lineup as set",
        rows: startRows, total: `${sgnWar(lineupWar)} WAR`,
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
          + " · sums negative because WAR is measured against replacement",
        rows: benchRows, total: `${sgnWar(sum(benchRows, r => r.war))} WAR`,
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
      total: taxiRows.length
        ? `${Math.round(sum(taxiRows, r => r.idx))} ${lens.toUpperCase()}`
        : undefined,
      empty: "Taxi squad empty.",
    });
    if (pickRows.length) bands.push({
      key: "pk", label: "Draft capital", spLabel: "#",
      note: "Held and traded away · future picks priced Mid tier, since the slot depends on a finish nobody knows yet",
      rows: pickRows,
      total: `≈ ${Math.round(sum(pickRows, r => r.market)).toLocaleString()}`,
      empty: "No picks on the books.",
    });
    return { bands, lineupWar };
  }, [team, dvi, cvi, war, vals, owned, players, meta, lens, rid, teams]);

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

  const season = fr?.[String(rid)]?.seasons.slice().reverse()
    .find(s => s.wins + s.losses + s.ties > 0);
  const idxRank = tvals
    ? rankMap(tvals, t => (lens === "dvi" ? t.dvi : t.cvi), t => t.rid).get(rid) ?? null
    : null;
  const mine = tvals?.find(t => t.rid === rid);
  const marketRank = tvals ? rankMap(tvals, t => t.market, t => t.rid).get(rid) ?? null : null;

  const figures: Figure[] = [
    {
      key: "rec", label: "Record",
      value: season ? `${season.wins}-${season.losses}${season.ties ? `-${season.ties}` : ""}` : NUL,
      sub: season ? `${season.season} · ${fmt(season.ppg, 1)} ppg` : "no season played",
    },
    {
      key: "rk", label: `${lens.toUpperCase()} rank`,
      value: idxRank ?? NUL, acc: true,
      sub: mine
        ? `${Math.round(lens === "dvi" ? mine.dvi : mine.cvi)} index pts, starters`
        : undefined,
    },
    {
      // THE BAND'S OWN NUMBER, not the rankings model's. Both are "best legal
      // lineup", but this screen's excludes the taxi squad and IR the way a
      // lineup card does, and a strip figure that disagreed with the total two
      // bands below it would be a bug the reader can see.
      key: "war", label: "Proj WAR",
      value: sgnWar(roster.lineupWar), sub: `best legal lineup, ${rosterSeason}`,
    },
    {
      key: "mkt", label: "Market",
      value: mine ? Math.round(mine.market).toLocaleString() : NUL,
      sub: marketRank ? `${marketRank} of ${tvals?.length} · KTC, picks included` : undefined,
    },
  ];

  const n = teams.length;

  return (
    <>
      <div className="v3-head">
        <h1>{team.team}</h1>
        <span className="sub">{team.manager}{ident.rid === rid ? " · you" : ""}</span>
        {/* The escape hatch, on the screen where picking wrong actually bites.
            Looking at your own team it re-opens the picker; looking at anyone
            else's it is the fastest possible correction — the roster in front
            of you is the one you meant, so claim it in place. */}
        {ident.rid === rid
          ? <RouteLink to={betaPath("/claim")} className="hact">Not you?</RouteLink>
          : <button className="hact" onClick={() => ident.claim(rid)}>This is me</button>}
      </div>
      <Strip figures={figures} />

      {/* The lens toggle sits above the roster, not in the masthead: it scopes
          THIS screen's featured column, the rank figure above it and the tier
          rule down in Strengths — and nothing else on the site. Same control
          object as the leaderboard's lens strip — two segments instead of four,
          but provably one control rather than two lookalikes. */}
      <LensStrip options={LENSES} value={lens} onChange={setLens} label="Index" />

      {roster.bands.map(b => (
        <RosterTable key={b.key} band={b} lens={lens} betaPath={betaPath} />
      ))}

      <div className="tnote screen">
        {lens === "dvi" ? "DVI prices the dynasty horizon" : "CVI prices the coming season"} —
        a 0–100 index, bare by design: it is already normalised, so a bar beside it would
        restate the figure. Market is the KTC dynasty price, shown last because it is the
        cross-check, not the claim. A pick carries a market price but no index — there is no
        player to project until it converts — and a taxi player carries an index but no
        projected WAR, because he cannot be started until he is activated. Both read “—”
        rather than zero.
      </div>

      {/* ---- strengths ----
          The classic board's TeamStrengths, transposed: it draws one row per
          currency across nine seat columns, which is a grid that has to scroll
          sideways on a phone and loses the seat the moment it does. Here the
          SEAT is the row and the currencies are two labelled meters inside it,
          so a thumb reads down the depth chart instead of across a scroll. The
          figures, the ranks and the meter scale are that component's, unchanged. */}
      {shape && (
        <>
          <Band label="Strengths"
            note={`Each seat against the same seat on the other ${n - 1} rosters · rank of ${n}`} />
          <Seats rows={shape.ranks} n={n} lens={lens} />
          <Band label="Second string"
            note="The same seats again, refilled from everyone who missed the first cut" />
          <Seats rows={shape.benchRanks} n={n} lens={lens} />
          <div className="tnote screen">
            Each seat is ranked against the same seat league-wide, and the two currencies are
            optimized separately, so a seat can hold different players in the two lines. The
            rule at the left edge marks the top {TIER_N} and the bottom {TIER_N} at that seat,
            read in whichever index the lens at the top of the screen is set to — it is one
            rule per row and the two currencies disagree. Superflex reads as QB2; the flex
            seat is left out — it
            holds a different position on every roster, so a column of it would not mean the
            same thing twice. A seat no eligible player can fill reads empty and ranks last:
            owning a fourth quarterback is better than owning none.
          </div>
        </>
      )}
    </>
  );
}

/* ---- one banded roster table -------------------------------------------- */

function RosterTable({ band, lens, betaPath }: {
  band: RosterBand; lens: Lens; betaPath: (p: string) => string;
}) {
  return (
    <>
      <Band label={band.label} total={band.total} note={band.note} />
      <table className={`v3tbl roster${band.cls ? ` ${band.cls}` : ""}`}>
        <thead>
          <tr>
            <th className="c sp">{band.spLabel}</th>
            <th className="t">Player</th>
            <th className="n lens">{lens.toUpperCase()}</th>
            <th className="n war">WAR</th>
            <th className="n mkt">Market</th>
          </tr>
        </thead>
        <tbody>
          {band.rows.map((r, i) => {
            const body = (
              <>
                {/* THE POSITION LIVES HERE. This is the one screen where every
                    row has a position and none of them showed it — the spine
                    carries the colour, never the name. What sits beside the bar
                    is the row's place WITHIN ITS BAND: the LINEUP SEAT for a
                    starter, which is a league setting rather than a ranking,
                    and an ordinal everywhere else (index order on the bench and
                    the taxi squad, year-then-round for the picks). Never a
                    league rank it would be lying about. */}
                <Spine color={POS_COLOR[r.pos]} rank={r.seat ?? i + 1} />
                <IdCell name={r.name} sub={r.sub} tags={r.tags}
                  to={r.pid ? betaPath(`/player/${r.pid}`) : undefined} />
                <td className="n">
                  <span className="f hd">{r.idx == null ? NUL : fmt(r.idx, 1)}</span>
                </td>
                <td className="n">
                  <span className="f">{r.war == null ? NUL : sgnWar(r.war)}</span>
                </td>
                <td className="n">
                  <span className="f q">{r.market == null ? NUL : r.market.toLocaleString()}</span>
                  {r.equiv && <div className="idc-s r">≈ {r.equiv}</div>}
                </td>
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
 * a labelled meter per currency and whoever holds that seat in it.
 *
 * The meter is on the seat's LEAGUE RANK, never on the index value: DVI and CVI
 * are already normalised 0-100 and the system forbids metering them. Its scale
 * is rosterShapes' own — first of twelve fills the track, twelfth fills a
 * twelfth of it — so the bar reads as "how much of the league is behind this
 * seat" rather than as a value.
 */
function Seats({ rows, n, lens }: { rows: RankRow[]; n: number; lens: Lens }) {
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
