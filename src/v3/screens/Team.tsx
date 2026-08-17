import { useMemo, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import type { Franchises, PicksOwned, Team as TeamT, Values } from "../../lib/types";
import { useJson } from "../../lib/useJson";
import { useLeague } from "../../lib/context";
import { useCvi, useDvi, useProjWar } from "../../lib/useIndices";
import { useIdentity } from "../../lib/identity";
import { fmt, sgnWar } from "../../lib/stats";
import { SLOT_LABEL, lineupOf, optimalLineup, rosterSeasonOf } from "../../lib/league";
import { ROUND_ORD } from "../../lib/rosterModel";
import { nearestPick, rankMap, useTeamValues } from "../model";
import { Band, IdCell, NUL, Strip, TapRow, useV3Path, type Figure } from "../ui";
import { RouteLink } from "../../components/RouteLink";

/**
 * TEAM — how am I doing.
 *
 * THIS SCREEN IS THE FRANCHISE PAGE. The Team tab is it pointed at you; a
 * standings row taps through to it pointed at someone else. There is no second
 * franchise surface, which is what stops the two drifting the way the classic
 * board's Teams row-drawer and franchise page did.
 *
 * The roster is banded, not paginated: Starters / Bench·Taxi·IR / Draft
 * capital, each band row carrying its own total. Picks are ROSTER ROWS — a
 * dynasty franchise's assets do not divide into "players" and "a separate
 * screen about picks", and stacking them in the same table is what makes the
 * draft-capital total comparable to the bench total above it.
 *
 * THE HEADLINE IS OUR INDEX, MARKET TRAILS (decision #12). DVI/CVI is the
 * featured column and the market price sits small and last, because this is our
 * board and the market is the cross-check. The toggle exists because δ says
 * contenders and rebuilders should be reading different indices — a per-team
 * δ-weighted value replaces this proxy when the WAR-stream model lands.
 */

type Lens = "dvi" | "cvi";

interface RosterRow {
  key: string;
  name: string;
  /** the identity sub-line: NFL club · position rank · slot tag */
  sub: string;
  pid: string | null;
  pos: string;
  idx: number | null;
  war: number | null;
  market: number | null;
  /** picks only: the current-year slot this price is worth */
  equiv?: string | null;
}
interface RosterBand { key: string; label: string; note: string; rows: RosterRow[]; total: string }

export default function Team() {
  const { meta, league, players } = useLeague();
  const v3p = useV3Path();
  const ident = useIdentity();
  const routeRid = Number(useParams().rid);
  const rosterSeason = rosterSeasonOf(league);

  const teams = useJson<TeamT[]>(`${rosterSeason}/teams.json`).data;
  const fr = useJson<Franchises>("franchises.json").data;
  const owned = useJson<PicksOwned>("picks_owned.json").data;
  const vals = useJson<Values>("data/values.json", "globalDaily").data;
  const dvi = useDvi();
  const cvi = useCvi();
  const war = useProjWar();
  const tvals = useTeamValues(rosterSeason);

  const [lens, setLens] = useState<Lens>("dvi");

  // the route's franchise, or — on the bare /team address — yours
  const rid = Number.isInteger(routeRid) ? routeRid : ident.rid;
  const team = teams?.find(t => t.roster_id === rid) ?? null;

  const bands = useMemo<RosterBand[] | null>(() => {
    if (!team || !dvi || !cvi || !war) return null;
    const idxFile = lens === "dvi" ? dvi.players : cvi.players;
    const idxOf = (pid: string) => {
      const r = idxFile[pid] as { dvi?: number; cvi?: number } | undefined;
      return r ? (lens === "dvi" ? r.dvi ?? null : r.cvi ?? null) : null;
    };
    const posRankOf = (pid: string) => idxFile[pid]?.pos_rank ?? null;
    const posOf = (pid: string) =>
      idxFile[pid]?.pos ?? players[pid]?.[1] ?? "?";

    // The best LEGAL lineup by projected WAR, not the lineup as set — the same
    // rule the design system's own roster band states. A roster's starters are
    // what it could field, since what it did field is a management question and
    // this screen is about assets.
    const pool = team.players.map(pid => ({
      id: pid, pos: posOf(pid), war: war[pid] ?? 0,
    }));
    const { slots, starters } = optimalLineup(pool, lineupOf(meta));

    const rowOf = (pid: string, tag: string): RosterRow => {
      const info = players[pid];
      const pr = posRankOf(pid);
      const p = posOf(pid);
      return {
        key: pid, pid, name: info?.[0] ?? `#${pid}`, pos: p,
        // A QB in the QB slot needs no slot tag — the position rank beside it
        // already said QB. Only the tags that ADD something survive: FLX, SFLX,
        // and the three roster states.
        sub: [info?.[2] || null, pr ? `${p}${pr}` : p, tag === p ? null : tag]
          .filter(Boolean).join(" · "),
        idx: idxOf(pid), war: war[pid] ?? null,
        market: vals?.players?.[pid]?.ktc ?? null,
      };
    };

    const startRows = slots
      .filter(s => s.player)
      .map(s => rowOf(s.player!.id, SLOT_LABEL[s.slot] ?? s.slot));

    const taxi = new Set(team.taxi), ir = new Set(team.reserve);
    const benchRows = team.players
      .filter(pid => !starters.has(pid))
      .map(pid => rowOf(pid, taxi.has(pid) ? "TAXI" : ir.has(pid) ? "IR" : "BN"))
      .sort((a, b) => (b.idx ?? -1) - (a.idx ?? -1));

    const ktcPicks = new Map(vals?.picks?.ktc ?? []);
    const pickRows: RosterRow[] = (owned?.owned?.[String(rid)] ?? [])
      .map(p => {
        const label = `${p.season} ${ROUND_ORD[p.round - 1]}`;
        // Mid tier for every future pick: the slot depends on a finish nobody
        // knows yet, and a uniform assumption keeps twelve rosters comparable.
        const market = ktcPicks.get(`${p.season} Mid ${ROUND_ORD[p.round - 1]}`) ?? null;
        const origin = teams?.find(t => t.roster_id === p.orig);
        return {
          key: `${p.season}-${p.round}-${p.orig}`, pid: null, name: label, pos: "PICK",
          sub: [
            p.orig === rid ? "Own" : `via ${origin?.manager ?? `roster ${p.orig}`}`,
            "Mid tier assumed",
          ].join(" · "),
          // A pick has no index and never will until it converts: DVI and CVI
          // are computed from a projection, and there is no player to project.
          // An em dash says that; a 0 would say the pick is worthless.
          idx: null, war: null, market,
          equiv: nearestPick(vals, p.season, p.round, "Mid"),
        };
      })
      .sort((a, b) => (b.market ?? 0) - (a.market ?? 0));

    const sum = (rows: RosterRow[], k: (r: RosterRow) => number | null) =>
      rows.reduce((a, r) => a + (k(r) ?? 0), 0);

    const out: RosterBand[] = [
      {
        key: "st", label: "Starters",
        note: "Best legal lineup by projected WAR, not the lineup as set",
        rows: startRows, total: `${sgnWar(sum(startRows, r => r.war))} WAR`,
      },
      {
        key: "bn", label: "Bench · Taxi · IR",
        // The total runs negative on every roster in the league and that is
        // correct, not a bug: WAR is measured against replacement, and a bench
        // is mostly players below it. Said here so the figure is read as depth
        // rather than as damage.
        note: `${benchRows.length} behind the lineup · sums negative because WAR is vs replacement`,
        rows: benchRows, total: `${sgnWar(sum(benchRows, r => r.war))} WAR`,
      },
    ];
    if (pickRows.length) out.push({
      key: "pk", label: "Draft capital",
      note: "Priced by tier — the slot depends on a finish nobody knows yet",
      rows: pickRows,
      total: `≈ ${Math.round(sum(pickRows, r => r.market)).toLocaleString()}`,
    });
    return out;
  }, [team, dvi, cvi, war, vals, owned, players, meta, lens, rid, teams]);

  /* ---- nobody to point at yet ------------------------------------------
     The claim lives on its own address rather than inline here, so that the
     same surface answers both "who are you" and "you picked wrong" — see
     screens/Claim. Wait for the rosters first: deriving from a username needs
     them, and redirecting before they land sends a returning reader to the
     picker for one frame every time they open the app. */
  if (rid == null) {
    if (!teams) return <div className="empty">Loading…</div>;
    return <Navigate to={v3p("/claim")} replace />;
  }
  if (!teams || !bands) return <div className="empty">Loading…</div>;
  if (!team) return (
    <div className="empty">No franchise {rid} in {rosterSeason}.</div>
  );

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
      key: "war", label: "Proj WAR",
      value: mine ? sgnWar(mine.war) : NUL, sub: "best legal lineup, 3 yr",
    },
    {
      key: "mkt", label: "Market",
      value: mine ? Math.round(mine.market).toLocaleString() : NUL,
      sub: marketRank ? `${marketRank} of ${tvals?.length} · KTC, picks included` : undefined,
    },
  ];

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
          ? <RouteLink to={v3p("/claim")} className="hact">Not you?</RouteLink>
          : <button className="hact" onClick={() => ident.claim(rid)}>This is me</button>}
      </div>
      <Strip figures={figures} />

      {/* The lens toggle sits above the roster, not in the masthead: it scopes
          THIS table's featured column and nothing else on the site. */}
      <div className="v3-lens" role="group" aria-label="Index">
        <button className={lens === "dvi" ? "on" : ""} onClick={() => setLens("dvi")}>
          DVI · dynasty
        </button>
        <button className={lens === "cvi" ? "on" : ""} onClick={() => setLens("cvi")}>
          CVI · win now
        </button>
      </div>

      {bands.map(b => (
        <RosterTable key={b.key} band={b} lens={lens} v3p={v3p} />
      ))}

      <div className="tnote screen">
        {lens === "dvi" ? "DVI prices the dynasty horizon" : "CVI prices the coming season"} —
        a 0–100 index, bare by design: it is already normalised, so a bar beside it would
        restate the figure. Market is the KTC dynasty price, shown last because it is the
        cross-check, not the claim. Picks carry a market price and a realized-WAR stream but
        no index — there is no player to project until the pick converts, which is why those
        cells read “—” rather than zero.
      </div>
    </>
  );
}

/* ---- one banded roster table -------------------------------------------- */

function RosterTable({ band, lens, v3p }: {
  band: RosterBand; lens: Lens; v3p: (p: string) => string;
}) {
  return (
    <>
      <Band label={<>{band.label} <span style={{ color: "var(--acc)" }}>{band.total}</span></>}
        note={band.note} />
      <table className="v3tbl">
        <thead>
          <tr>
            <th className="t">Player</th>
            <th className="n" style={{ width: "16%" }}>{lens.toUpperCase()}</th>
            <th className="n" style={{ width: "18%" }}>WAR</th>
            <th className="n" style={{ width: "20%" }}>Market</th>
          </tr>
        </thead>
        <tbody>
          {band.rows.map((r, i) => {
            const body = (
              <>
                <IdCell name={r.name} sub={r.sub}
                  to={r.pid ? v3p(`/player/${r.pid}`) : undefined} />
                <td className="n">
                  <span className="f hd">{r.idx == null ? NUL : fmt(r.idx, 1)}</span>
                </td>
                <td className="n">
                  <span className="f">{r.war == null ? NUL : sgnWar(r.war)}</span>
                </td>
                <td className="n">
                  <span className="f q">{r.market == null ? NUL : r.market.toLocaleString()}</span>
                  {r.equiv && <div className="idc-s" style={{ textAlign: "right" }}>≈ {r.equiv}</div>}
                </td>
              </>
            );
            const cls = i % 2 ? "zebra" : "";
            return r.pid
              ? <TapRow key={r.key} to={v3p(`/player/${r.pid}`)} className={cls}>{body}</TapRow>
              : <tr key={r.key} className={cls}>{body}</tr>;
          })}
          {!band.rows.length && (
            <tr><td colSpan={4} className="t"><span className="f q">None.</span></td></tr>
          )}
        </tbody>
      </table>
    </>
  );
}
