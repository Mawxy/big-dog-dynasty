import { Fragment, useMemo, useState } from "react";
import type {
  Franchises, ProjectionsFile, Team, Trade as TradeT, TradesPayload,
} from "../../lib/types";
import { useJson } from "../../lib/useJson";
import { useLeague } from "../../lib/context";
import { useLeagueCaps } from "../../lib/caps";
import { useCvi, useDvi } from "../../lib/useIndices";
import { useIdentity } from "../../lib/identity";
import { lineupOf, rosterSeasonOf } from "../../lib/league";
import {
  AGING_FROM, TIER_N, rosterShapes, teamNeeds, type IndexEntry, type NeedSeat, type TeamNeeds,
} from "../../lib/rosterModel";
import { fmt, ord } from "../../lib/stats";
import { readTrades } from "../../lib/trades";
import { RouteLink } from "../../components/RouteLink";
import {
  Band, DataError, fmtWar, NUL, sgnWar, sortBy, TapRow, Th, useBetaPath, useSort,
} from "../ui";
import { hasUnmadePick, sideRealized, usePlayed } from "./tradeGrid";
import "./transactions.css";

/**
 * THE PARTNER ANALYZER (Max, 2026-11-12) — the Trade tab's second pill: each
 * manager's record as a trader, and who they trade with.
 *
 * One row per manager: how many trades they have made, the WAR their side of
 * those trades has returned (in), the WAR the other side's has (out), and the
 * difference. Tapping a row opens that manager's partners under it, each one
 * a link to the deals between the two on the Transactions page.
 *
 * A TRADE BELONGS TO THE MANAGER WHO MADE IT, NOT TO THE ROSTER SLOT (Max,
 * 2026-11-12). A franchise that changed hands carries its old owner's deals
 * in trades.json under the same roster id, and summing by slot credited
 * PicklesPapa's trades to Dchaillier10. So every side is keyed by the manager
 * `franchises.json` names for that slot IN THE SEASON OF THE TRADE. A manager
 * who has left the league keeps a row of his own, marked, because his partners'
 * rows still name him. Rows carry the manager's name only: the franchise name
 * changes most years and says nothing here the manager does not.
 *
 * WHAT THE WAR COLUMNS COVER, and the caption says so: two-team trades where a
 * scored week has passed and EVERY PICK IN THE DEAL HAS BEEN MADE (Max,
 * 2026-11-13). The ledger judges a side as soon as any of it has converted,
 * which here charged a manager for a 2027 1st as if it had returned nothing:
 * 29 of the 129 trades then in the WAR had a pick still to be drafted. So a
 * trade with one undrafted pick on either side waits, whole, until the last
 * pick is used. It still counts in Trades, which is a count of deals made.
 * A three-team deal has no single "other side", so it counts as a trade and
 * stays out of the WAR. `usePlayed` and `sideRealized` are the ledger's own.
 *
 * NEEDS AND SURPLUS (Max, 2026-11-13: "it should also show team needs",
 * shown per manager). Who to call is half a trade question and the record
 * above answers only the other half. So each current manager's row says, by
 * position, where his starting lineup is short and where his bench is deep,
 * and his drawer names the seats: `teamNeeds`, which is the team page's
 * Strengths ranks under the team page's own tier rule, not a second model.
 * Read in CVI, the value of a seat THIS season, because a need is a hole in
 * the lineup a manager sets on Sunday; DVI would call a contender's
 * 31-year-old WR1 a need. Today's rosters, so a manager who has left has
 * none, and a league without the indices shows the record alone.
 *
 * AND AGING, BETWEEN THE TWO (Max, 2026-11-13: "Bijan al-Gaib needs younger
 * receivers and rbs"). His own row read "Needs none" with a 30-year-old RB2
 * and a 29-year-old WR3 in it, because a rank of this season's value cannot
 * see a birthday. So a starting seat that is not a need today and is held by
 * a player past his position's age line is a third list, and every seat in
 * the drawer carries its holder's age, so a partner shopping for youth can
 * tell a surplus 23-year-old from a surplus 33-year-old.
 *
 * NOTHING IS INKED. A signed net is direction, not a grade: the same realized
 * WAR is one manager's in and another's out.
 */

/**
 * ONE PERSON UNDER TWO HANDLES (Max, 2026-11-12). Sleeper keys a manager by
 * display name here, and a renamed account reads as a franchise changing
 * hands. Craftzz and taird are the same person, so Craftzz's trades are
 * taird's. Old handle -> the one he goes by now; add a line for the next one.
 */
const SAME_PERSON: Record<string, string> = { Craftzz: "taird" };
const person = (manager: string) => SAME_PERSON[manager] ?? manager;
/** the order the caption names the age lines in: the board's own */
const AGING_ORDER = ["QB", "RB", "WR", "TE"];

interface Pair { n: number; judged: number; net: number }
interface Stat {
  /** the manager, as franchises.json spells him */
  name: string;
  /** the roster slot his trades were made from */
  rid: number;
  n: number; judged: number; in: number; out: number;
  partners: Map<string, Pair>;
}
type Key = "n" | "in" | "out" | "net";

function build(
  trades: TradeT[], played: (t: TradeT) => boolean,
  mgrOf: (rid: number, season: string) => string,
): Map<string, Stat> {
  const m = new Map<string, Stat>();
  const stat = (name: string, rid: number) => {
    let s = m.get(name);
    if (!s) { s = { name, rid, n: 0, judged: 0, in: 0, out: 0, partners: new Map() }; m.set(name, s); }
    return s;
  };
  const pair = (s: Stat, other: string) => {
    let p = s.partners.get(other);
    if (!p) { p = { n: 0, judged: 0, net: 0 }; s.partners.set(other, p); }
    return p;
  };
  for (const t of trades) {
    if (t.sides.length < 2) continue;
    const who = t.sides.map(s => stat(mgrOf(s.rid, t.season), s.rid));
    who.forEach((s, i) => {
      s.n++;
      who.forEach((o, j) => { if (j !== i) pair(s, o.name).n++; });
    });
    if (t.sides.length !== 2 || !played(t) || hasUnmadePick(t)) continue;
    const ra = sideRealized(t.sides[0]), rb = sideRealized(t.sides[1]);
    if (ra == null || rb == null) continue;
    const [sa, sb] = who;
    sa.judged++; sa.in += ra; sa.out += rb;
    sb.judged++; sb.in += rb; sb.out += ra;
    const pa = pair(sa, sb.name), pb = pair(sb, sa.name);
    pa.judged++; pa.net += ra - rb;
    pb.judged++; pb.net += rb - ra;
  }
  return m;
}

export default function Partners() {
  const { league, meta } = useLeague();
  const caps = useLeagueCaps();
  const betaPath = useBetaPath();
  const identity = useIdentity();
  const file = useJson<TradesPayload>("trades.json");
  const frQ = useJson<Franchises>("franchises.json");
  const teams = useJson<Team[]>(`${rosterSeasonOf(league)}/teams.json`).data;
  const played = usePlayed();
  const trades = useMemo(() => (file.data ? readTrades(file.data).trades : null), [file.data]);
  const fr = frQ.data;
  // the Strengths population, as the team page loads it
  const proj = useJson<ProjectionsFile>(caps.projections ? "projections.json" : null).data;
  const dvi = useDvi();
  const cvi = useCvi();

  /** each current manager's needs and surplus, off today's rosters. Null
   *  where the league publishes no indices: the record stands without it. */
  const needs = useMemo(() => {
    if (!proj || !teams?.length || !dvi || !cvi) return null;
    const flatDvi: Record<string, IndexEntry> = {};
    for (const [pid, r] of Object.entries(dvi.players))
      flatDvi[pid] = { value: r.dvi, posRank: r.pos_rank };
    const flatCvi: Record<string, IndexEntry> = {};
    for (const [pid, r] of Object.entries(cvi.players))
      flatCvi[pid] = { value: r.cvi, posRank: r.pos_rank };
    const shapes = rosterShapes(proj.players, teams,
      { cvi: flatCvi, dvi: flatDvi }, lineupOf(meta));
    const age = new Map(proj.players.map(p => [p.pid, p.age]));
    const m = new Map<string, TeamNeeds>();
    for (const t of teams) {
      const sh = shapes.get(t.roster_id);
      if (sh) m.set(person(t.manager), teamNeeds(sh, teams.length, "cvi", pid => age.get(pid)));
    }
    return m;
  }, [proj, teams, dvi, cvi, meta]);

  /** who ran a roster slot in a season: that season's row for the slot, else
   *  the slot's latest, else the franchise name the trade itself carries */
  const stats = useMemo(() => {
    if (!trades || !fr) return null;
    const mgrOf = (rid: number, season: string) => {
      const ss = fr[String(rid)]?.seasons ?? [];
      return person((ss.find(s => s.season === season) ?? ss[ss.length - 1])?.manager ?? `Team ${rid}`);
    };
    return build(trades, played, mgrOf);
  }, [trades, fr, played]);
  /** the seasons a manager held his slot, for the links out: a slot's trades
   *  filtered to those seasons are his and nobody else's */
  const seasonsOf = (s: Stat) =>
    (fr?.[String(s.rid)]?.seasons ?? []).filter(x => person(x.manager) === s.name).map(x => x.season);
  const allSeasons = useMemo(
    () => [...new Set((trades ?? []).map(t => t.season))], [trades]);

  const s = useSort<Key>("n");
  /** the manager whose partners are showing. Undefined until the reader
   *  picks: the page opens on the reader's own row where it knows one. */
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const mineRaw = teams?.find(t => t.roster_id === identity.rid)?.manager;
  const mine = mineRaw ? person(mineRaw) : null;
  const openName = picked === undefined ? mine : picked;

  const rows = useMemo(() => {
    if (!stats || !teams) return null;
    const current = new Set(teams.map(t => person(t.manager)));
    // every manager in the league today, traded or not, then anyone who has left
    const names = [...new Set([...current, ...stats.keys()])];
    const list = names.map(name => {
      const st = stats.get(name);
      const judged = st?.judged ?? 0;
      return {
        name, st, former: !current.has(name),
        f: {
          n: st?.n ?? 0,
          // no judged trade is no figure, not zero WAR
          in: judged ? st!.in : null,
          out: judged ? st!.out : null,
          net: judged ? st!.in - st!.out : null,
        } as Record<Key, number | null>,
      };
    });
    return sortBy(list, r => r.f[s.sort], s.dir);
  }, [stats, teams, s.sort, s.dir]);

  if (file.error || frQ.error) return <DataError what="Trades didn't load" />;
  if (!rows || !stats) return <div className="empty">Loading trades…</div>;

  const total = (trades ?? []).filter(t => t.sides.length >= 2).length;
  /** the Transactions page, on the trades these managers made: their slots,
   *  and the seasons each held his (left off when that is every season) */
  const toTrades = (a: Stat, b?: Stat) => {
    let seasons = seasonsOf(a);
    if (b) { const sb = new Set(seasonsOf(b)); seasons = seasons.filter(x => sb.has(x)); }
    const q = new URLSearchParams();
    q.set("team", (b ? [a.rid, b.rid].sort((x, y) => x - y) : [a.rid]).join(","));
    if (b) q.set("match", "all");
    if (allSeasons.some(x => !seasons.includes(x))) q.set("season", seasons.sort().reverse().join(","));
    return betaPath(`/transactions?${q.toString()}`);
  };

  return (
    <div className="pax">
      <Band label={`${total} trade${total === 1 ? "" : "s"} · ${rows.length} managers`}
        note={needs ? "All seasons · tap a manager for needs and partners"
          : "All seasons · tap a manager for their partners"} />
      <table className="v3tbl pax-tbl">
        <thead>
          <tr>
            {/* the name column is what the figures leave it */}
            <th className="t">Manager</th>
            <Th id="n" label="Trades" sort={s.sort} onSort={s.onSort} width="12%" />
            <Th id="in" label="WAR in" sort={s.sort} onSort={s.onSort} width="15%" />
            <Th id="out" label="WAR out" sort={s.sort} onSort={s.onSort} width="16%" />
            <Th id="net" label="Net" sort={s.sort} onSort={s.onSort} width="18%" />
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const isOpen = openName === r.name;
            const partners = [...(r.st?.partners ?? [])]
              .sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]));
            const nd = needs?.get(r.name);
            return (
              <Fragment key={r.name}>
                <TapRow className={isOpen ? "pax-on" : ""} onTap={() => setPicked(isOpen ? null : r.name)}>
                  <td className="t pax-nm">
                    {r.name}
                    {/* under the name, not beside it (Max, 2026-11-12) */}
                    {r.former && <span className="sb">former</span>}
                    {/* three lines on every row once any row has them, so the
                        table keeps one row height; a former manager's last two
                        are empty because he has no roster to read */}
                    {needs && !r.former && <PosLine label="Needs" seats={nd?.needs} />}
                    {needs && (r.former
                      ? <span className="pax-nd">{"\u00a0"}</span>
                      : <PosLine label="Aging" seats={nd?.aging} />)}
                    {needs && (r.former
                      ? <span className="pax-nd">{"\u00a0"}</span>
                      : <PosLine label="Surplus" seats={nd?.surplus} />)}
                  </td>
                  <td className="n">{r.f.n}</td>
                  <td className="n">{r.f.in == null ? NUL : fmtWar(r.f.in)}</td>
                  <td className="n">{r.f.out == null ? NUL : fmtWar(r.f.out)}</td>
                  <td className="n">{r.f.net == null ? NUL : sgnWar(r.f.net)}</td>
                </TapRow>
                {isOpen && (
                  <tr className="pax-drawer">
                    <td colSpan={5}>
                      {nd && (
                        <>
                          <SeatBlock label="Needs · starters" seats={nd.needs}
                            none={`No starting seat in the bottom ${TIER_N}.`} to={betaPath} />
                          <SeatBlock label="Aging · starters" seats={nd.aging}
                            none="No other starter past his position’s age line." to={betaPath} />
                          <SeatBlock label="Surplus · second string" seats={nd.surplus}
                            none={`No second-string seat in the top ${TIER_N}.`} to={betaPath} />
                        </>
                      )}
                      {r.st && partners.length ? (
                        <>
                          <div className="pax-ph">
                            <span>Traded with</span>
                            <span className="n">Trades</span>
                            <span className="n">Net WAR</span>
                          </div>
                          {partners.map(([other, p]) => {
                            const o = stats.get(other);
                            return (
                              <RouteLink key={other} className="pax-p"
                                to={o ? toTrades(r.st!, o) : toTrades(r.st!)}>
                                <span className="nm">{other}</span>
                                <span className="n">{p.n}</span>
                                <span className="n">{p.judged ? sgnWar(p.net) : NUL}</span>
                              </RouteLink>
                            );
                          })}
                          <RouteLink className="lgx-all pax-all" to={toTrades(r.st)}>
                            All of {r.name}’s trades →
                          </RouteLink>
                        </>
                      ) : <div className="pax-none">No trades on record.</div>}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {needs && (
        <div className="tnote screen">
          Needs are the starting seats where a manager ranks in the bottom {TIER_N} of the
          league, seat against the same seat, by CVI (the value this season of whoever wins
          the seat). Aging is every other starting seat held by a player at or past the age
          where his position turns down: {AGING_ORDER.map(p => `${p} ${AGING_FROM[p]}`).join(", ")}.
          The seat is fine today and wants a younger body soon. Surplus is the second-string
          seats in the top {TIER_N}: a player better than the seat he sits in. Rank is of
          the {teams?.length ?? 0} rosters. Today’s rosters, and the same seats and ranks as
          the Strengths section of each team page.
        </div>
      )}
      <div className="tnote screen">
        A trade counts for the manager who made it, so a franchise that changed hands is two
        rows (a manager who only changed handles is one). WAR in is what a manager’s side of their trades has produced while starting for
        them. WAR out is what the other side’s has. Both cover two-team trades where a scored
        week has passed and every pick in the deal has been made, so a trade with a pick
        still to be drafted waits until it is, and a three-team deal counts as a trade only. A
        record, not a verdict: no figure is inked.
      </div>
    </div>
  );
}

/** the positions a list of seats covers, in seat order, once each: the row's
 *  one-line read, with the seats themselves a tap away in the drawer */
function PosLine({ label, seats }: { label: string; seats: NeedSeat[] | undefined }) {
  const pos = [...new Set((seats ?? []).map(s => s.pos))];
  return (
    <span className="pax-nd">
      <b>{label}</b> {pos.length ? pos.join(" ") : <i>none</i>}
    </span>
  );
}

/** one list of seats in the drawer, on the partner list's own grid: the seat
 *  and who holds it, his age, his CVI, and the seat's rank in the league */
function SeatBlock({ label, seats, none, to }: {
  label: string; seats: NeedSeat[]; none: string; to: (p: string) => string;
}) {
  return (
    <>
      <div className="pax-ph pax-seat">
        <span>{label}</span>
        <span className="n">Age</span>
        <span className="n">CVI</span>
        <span className="n">Rank</span>
      </div>
      {seats.length ? seats.map(s => {
        const body = (
          <>
            <span className="nm"><b className="st">{s.label}</b>{s.pid ? s.name : "empty"}</span>
            <span className="n">{s.age == null ? NUL : Math.floor(s.age)}</span>
            <span className="n">{s.pid ? fmt(s.value, 1) : NUL}</span>
            <span className="n">{ord(s.rank)}</span>
          </>
        );
        return s.pid
          ? <RouteLink key={s.label} className="pax-p pax-seat" to={to(`/player/${s.pid}`)}>{body}</RouteLink>
          : <div key={s.label} className="pax-p pax-seat pax-static">{body}</div>;
      }) : <div className="pax-none">{none}</div>}
    </>
  );
}
